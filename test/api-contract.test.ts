import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

/**
 * The contract test, in BOTH directions.
 *
 * `docs/zaeme-api.openapi.yaml` is not documentation of this implementation; it
 * is the brief two systems are built from. zäme implements it and Enterprise
 * GENERATES its MCP tool surface from it, so a disagreement between the document
 * and the route tree is a bug on both sides at once:
 *
 *   • an operation with no route → Enterprise mints a tool that 404s at runtime,
 *     and the XO discovers it mid-conversation;
 *   • a route the document does not describe → an undeclared surface, invisible
 *     to the generator, unversioned, and unnoticed until it breaks.
 *
 * So this asserts a BIJECTION, not a subset in either direction.
 *
 * ⚠️ THE YAML 1.1 TRAP. RSVP statuses and poll answers include the literals
 * `yes` and `no`. Under YAML 1.1 — PyYAML, and anything built on it — an
 * unquoted `yes`/`no` parses as a BOOLEAN, silently turning the enum into
 * `[True, 'maybe', False, 'cheering']`. Every such literal in the spec is quoted
 * for that reason, and the quotes must not be "tidied" away. The tests at the
 * bottom of this file assert the parser hands back STRINGS, so a future parser
 * swap that reintroduces the trap fails here rather than in Enterprise's
 * generated tool schema.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const SPEC_PATH = join(ROOT, 'docs', 'zaeme-api.openapi.yaml')
const ROUTES_ROOT = join(ROOT, 'server', 'api', 'v1')

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
type HttpMethod = typeof HTTP_METHODS[number]

interface Operation {
  method: HttpMethod
  path: string
  operationId: string
  exposed: boolean
}

/* --------------------------------- the spec -------------------------------- */

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  paths: Record<string, Record<string, { 'operationId'?: string, 'x-mcp-expose'?: boolean }>>
  components: Record<string, Record<string, unknown>>
  info: Record<string, unknown>
}

const operations: Operation[] = []
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const op = item[method]
    if (!op?.operationId) continue
    operations.push({
      method,
      path,
      operationId: op.operationId,
      // `x-mcp-expose` is opt-OUT: an operation without it becomes a tool.
      exposed: op['x-mcp-expose'] !== false
    })
  }
}

const specKeys = new Set(operations.map(o => `${o.method.toUpperCase()} ${o.path}`))

/* -------------------------------- the routes ------------------------------- */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/**
 * Turn a Nitro route file into the `METHOD /path` it serves.
 *
 * `server/api/v1/events/[slug]/rsvps/[rsvpId].patch.ts`
 *   → `PATCH /events/{slug}/rsvps/{rsvpId}`
 *
 * The paths are relative to the `/api/v1` base, which is what the contract's
 * `servers[].url` already includes.
 */
function routeKeyFor(file: string): { method: string, path: string } {
  const rel = relative(ROUTES_ROOT, file).split(sep).join('/').replace(/\.ts$/, '')
  const lastDot = rel.lastIndexOf('.')
  const method = rel.slice(lastDot + 1).toUpperCase()
  let path = rel.slice(0, lastDot)
  path = path.replace(/(^|\/)index$/, '')
  path = path.replace(/\[([^\]]+)\]/g, '{$1}')
  return { method, path: `/${path}`.replace(/\/$/, '') || '/' }
}

const routeFiles = walk(ROUTES_ROOT).filter(f => f.endsWith('.ts'))
const routes = routeFiles.map(f => ({ file: f, ...routeKeyFor(f) }))
const routeKeys = new Set(routes.map(r => `${r.method} ${r.path}`))

/* --------------------------------- the tests -------------------------------- */

describe('the /api/v1 route tree and the contract describe the same surface', () => {
  it('every operation in the spec has a route that exists', () => {
    const missing = [...specKeys].filter(k => !routeKeys.has(k)).sort()
    expect(missing, 'operations the spec declares but zäme does not serve').toEqual([])
  })

  it('every /api/v1 route appears in the spec', () => {
    const undeclared = [...routeKeys].filter(k => !specKeys.has(k)).sort()
    expect(undeclared, 'routes zäme serves that the spec does not describe').toEqual([])
  })

  it('serves exactly one file per operation, and no route file is unreachable', () => {
    expect(routes).toHaveLength(operations.length)
    expect(routeKeys.size).toBe(routes.length)
  })

  it('every method suffix on disk is one Nitro actually routes', () => {
    for (const route of routes) {
      expect(HTTP_METHODS as readonly string[], route.file).toContain(route.method.toLowerCase())
    }
  })
})

describe('the operation ids are Enterprise\'s tool names and must not drift', () => {
  /**
   * `operationId` IS the MCP tool name: the XO addresses today's tools as
   * `mcp__events__<operationId>`. Renaming one silently changes the model's
   * vocabulary, so the full set is frozen here. Adding an operation means adding
   * it to this list deliberately.
   */
  const EXPOSED_TOOLS = [
    'addPotluckItem', 'addSeriesMember', 'addTimelineItem', 'addTripExpense',
    'createEvent', 'createInvite', 'createPartyPlan', 'getEvent', 'getTripBudget',
    'inviteCoOrganizer', 'listDatePoll', 'listEvents', 'listInvites', 'listMedia',
    'listPotluck', 'listRsvps', 'listSeriesMembers', 'listSeriesShowings',
    'listTimeline', 'lockEventDate', 'openUpParty', 'postEventChatMessage',
    'proposeDateOption', 'readEventChat', 'removeRsvp', 'removeSeriesMember',
    'removeTimelineItem', 'removeTripExpense', 'revokeInvite',
    'scheduleSeriesShowing', 'setEventStatus', 'updateEvent', 'updateRsvp'
  ]

  const PLUMBING = [
    'getEventsAttention', 'getEventsSnapshot', 'getHealth', 'headPoster',
    'publishConcert', 'unpublishConcert', 'uploadPoster'
  ]

  it('exposes exactly the 33 tools the events department had', () => {
    const exposed = operations.filter(o => o.exposed).map(o => o.operationId).sort()
    expect(exposed).toEqual([...EXPOSED_TOOLS].sort())
    expect(exposed).toHaveLength(33)
  })

  it('keeps the 7 plumbing operations out of the tool surface', () => {
    const hidden = operations.filter(o => !o.exposed).map(o => o.operationId).sort()
    expect(hidden).toEqual([...PLUMBING].sort())
  })

  it('never reuses an operationId', () => {
    const ids = operations.map(o => o.operationId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reserves updateTimelineItem for the timeline PATCH gap (Bermos/zaeme#8)', () => {
    // The spec reserves this name so whoever closes the gap mints the tool under
    // the obvious name instead of inventing a second one.
    expect(operations.map(o => o.operationId)).not.toContain('updateTimelineItem')
  })
})

describe('the YAML 1.1 boolean trap stays disarmed', () => {
  const rsvpStatus = (spec.components.schemas as Record<string, { properties: Record<string, { enum?: unknown[] }> }>)
    .Rsvp.properties.status

  it('parses the RSVP enum as strings, not booleans', () => {
    expect(rsvpStatus.enum).toEqual(['yes', 'maybe', 'no', 'cheering'])
    for (const value of rsvpStatus.enum!) {
      expect(typeof value, `RSVP status ${String(value)} parsed as ${typeof value}`).toBe('string')
    }
  })

  it('parses the poll answer enum as strings, not booleans', () => {
    const pollOption = (spec.components.schemas as Record<string, {
      properties: { votes: { items: { properties: { answer: { enum?: unknown[] } } } } }
    }>).PollOption
    const answers = pollOption.properties.votes.items.properties.answer.enum!
    expect(answers).toEqual(['yes', 'ifneedbe', 'no'])
    for (const value of answers) expect(typeof value).toBe('string')
  })

  it('keeps "yes"/"no" as OBJECT KEYS in RsvpSummary, not as true/false', () => {
    const summary = (spec.components.schemas as Record<string, {
      required: unknown[]
      properties: Record<string, unknown>
    }>).RsvpSummary
    // A YAML 1.1 parser turns these keys into the strings "true"/"false".
    expect(Object.keys(summary.properties)).toContain('yes')
    expect(Object.keys(summary.properties)).toContain('no')
    expect(Object.keys(summary.properties)).not.toContain('true')
    expect(Object.keys(summary.properties)).not.toContain('false')
    expect(summary.required).toEqual(['yes', 'maybe', 'no', 'cheering', 'total', 'headcount'])
  })

  it('leaves no boolean anywhere an enum value or a schema key should be', () => {
    const offenders: string[] = []
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((v, i) => visit(v, `${path}[${i}]`))
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (typeof key === 'boolean') offenders.push(`${path}.<boolean key>`)
          visit(value, `${path}.${key}`)
        }
        return
      }
      // `additionalProperties: false`, `x-mcp-expose: false` and friends are
      // legitimately boolean; enum members and required names never are.
      if (typeof node === 'boolean' && /\.(enum|required)\[/.test(path)) {
        offenders.push(path)
      }
    }
    visit(spec, '$')
    expect(offenders).toEqual([])
  })
})

describe('the contract is served, and labelled as the source of truth', () => {
  it('has a route that publishes it', () => {
    const routeFile = join(ROOT, 'server', 'api', 'openapi.yaml.get.ts')
    expect(statSync(routeFile).isFile()).toBe(true)
  })

  it('is served from OUTSIDE /api/v1, so it is not itself an undeclared route', () => {
    expect([...routeKeys].some(k => k.includes('openapi'))).toBe(false)
  })

  it('says in its own text that Enterprise\'s copy is a vendored snapshot', () => {
    const raw = readFileSync(SPEC_PATH, 'utf8')
    expect(raw).toContain('SOURCE OF TRUTH')
    expect(raw).toMatch(/vendored snapshot/i)
    expect(String(spec.info.description)).toMatch(/vendored snapshot/i)
  })

  it('declares the four provenance headers once, in components.parameters', () => {
    const params = spec.components.parameters as Record<string, { name: string, required?: boolean }>
    expect(params.McpUser.name).toBe('x-mcp-user')
    expect(params.McpUser.required).toBe(true)
    expect(params.McpThread.name).toBe('x-mcp-thread')
    expect(params.McpModel.name).toBe('x-mcp-model')
    expect(params.McpBasis.name).toBe('x-mcp-basis')
  })
})
