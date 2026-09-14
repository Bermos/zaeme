import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Timeline items are EDITABLE, on the two human surfaces and on neither
 * machine one.
 *
 * The PATCH handler existed in zäme before the 2026-07 absorption into the
 * Enterprise monorepo and did not come back out of it (issue #8): for a while
 * an itinerary item could be created and destroyed but not corrected, and
 * delete-and-re-add loses the item's place in the order. Nothing noticed,
 * because a missing route breaks no test — so this file pins the route tree
 * itself, which is the only thing that would have caught the loss.
 *
 * The second half is the line the issue drew and this suite has to keep
 * drawing: editing is deliberately NOT on `/api/v1`. Enterprise generates its
 * MCP tools from `docs/zaeme-api.openapi.yaml`, so a PATCH added there is a
 * verb handed to the model, and that is its own decision rather than a side
 * effect of fixing a regression. `test/api-contract.test.ts` guards the spec;
 * this guards the route tree it is a bijection with.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const API_ROOT = join(ROOT, 'server', 'api')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
const rel = (f: string) => relative(ROOT, f).split(sep).join('/')
const handlers = walk(API_ROOT).filter(f => f.endsWith('.ts'))

const HOST_PATCH = join(API_ROOT, 'host', 'events', '[slug]', 'timeline', '[id].patch.ts')
const ADMIN_PATCH = join(API_ROOT, 'admin', 'events', '[slug]', 'timeline', '[id].patch.ts')

describe('an itinerary item can be corrected, not only created and destroyed', () => {
  it('the host surface has PATCH beside POST and DELETE', () => {
    expect(existsSync(join(API_ROOT, 'host', 'events', '[slug]', 'timeline.post.ts'))).toBe(true)
    expect(existsSync(join(API_ROOT, 'host', 'events', '[slug]', 'timeline', '[id].delete.ts'))).toBe(true)
    expect(existsSync(HOST_PATCH)).toBe(true)
  })

  it('the admin surface has one too, so the owner can fix an event they do not plan', () => {
    // `/host` asks whether you plan this event and 403s an owner who does not,
    // which left a typo on somebody else's itinerary visible from `/admin` and
    // fixable from nowhere.
    expect(existsSync(ADMIN_PATCH)).toBe(true)
    expect(readFileSync(ADMIN_PATCH, 'utf8')).toMatch(/requireOwner\(/)
  })

  it('both accept sortOrder, which is what makes an item movable', () => {
    // Without it the only way to reorder is delete-and-re-add — the loss this
    // issue is about, wearing a different hat.
    for (const f of [HOST_PATCH, ADMIN_PATCH]) {
      expect(readFileSync(f, 'utf8')).toMatch(/sortOrder: z\.number\(\)/)
    }
  })

  it('writes the row in exactly one place, authorised in two', () => {
    const data = readFileSync(join(ROOT, 'server', 'domain', 'events-data.ts'), 'utf8')
    const admin = readFileSync(join(ROOT, 'server', 'domain', 'admin.ts'), 'utf8')
    expect(data).toMatch(/export async function applyTimelineItemUpdate/)
    // The planner-scoped entry point keeps its planner check…
    expect(data).toMatch(/assertPlanner\(ev\.id, userId, \{ roles: \['owner', 'co_planner'\] \}\)\n\s*return applyTimelineItemUpdate/)
    // …and the owner-scoped one reuses the write rather than copying it.
    expect(admin).toMatch(/applyTimelineItemUpdate\(ev\.id, itemId, input\)/)
  })
})

describe('editing an itinerary is not a verb the machine surface has', () => {
  it('no /api/v1 route patches a timeline item', () => {
    const offenders = handlers
      .map(rel)
      .filter(f => f.startsWith('server/api/v1/') && f.includes('/timeline/') && f.includes('.patch.'))
    expect(offenders).toEqual([])
  })

  it('the contract declares no timeline PATCH operation', () => {
    // The NAME is in the file, in a comment reserving it for whoever decides to
    // give the XO the verb. Reserved is the opposite of declared, so this looks
    // for the declaration and not for the string.
    const spec = readFileSync(join(ROOT, 'docs', 'zaeme-api.openapi.yaml'), 'utf8')
    expect(spec).not.toMatch(/^\s*operationId: updateTimelineItem\s*$/m)

    const timelineItemPath = /^ {2}\/events\/\{slug\}\/timeline\/\{itemId\}:$/m.exec(spec)
    if (timelineItemPath) {
      const section = spec.slice(timelineItemPath.index).split(/\n {2}\//)[0]!
      expect(section).not.toMatch(/^ {4}patch:/m)
    }
  })
})
