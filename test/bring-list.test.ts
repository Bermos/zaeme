/**
 * The bring list can count (#44).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `scripts/api-smoke.sh` proves the routes: that claiming three of six leaves
 * three to go, that two claims close the item and that releasing one reopens
 * it. It is curl and it never loads a Vue page, so a defect that lives in the
 * RENDERER is structurally invisible to it — which is exactly how #38 shipped a
 * broken round trip past 879 green checks. `BringList.vue` is where a person
 * meets this feature, so what it says and what it sends are pinned here.
 *
 * And the arithmetic itself is a pure function with three branches, one of
 * which — an item with NO stated count — is an acceptance criterion in its own
 * right and the one most likely to break silently: the obvious wrong version
 * treats a missing need as a need of zero, which makes every free-text item on
 * every bring list read as DONE the moment it is created, with nobody bringing
 * anything. Nothing in a smoke run distinguishes that from a claimed item.
 *
 * ── AND WHY THE SCREEN ASSERTIONS READ `<script setup>` TOO ────────────────
 *
 * Because a structural test that reads only the template leaves every
 * expression in the script pinned by nothing, and the mutations that matter
 * here live there: `quantity: 1` in place of `quantity: wanted(c)` makes the
 * number field decorative, and `remainderLine` called with the wrong arguments
 * type-checks. `test/pinned-media.test.ts` next door spells out the same
 * discipline; the comment-stripping is its, for its reason — prose explaining
 * why a line reads one way has to quote the wrong version to be worth reading.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contributionTally, remainderLine } from '../shared/utils/bring-list'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

describe('an item with no stated count', () => {
  /**
   * THE FIRST ACCEPTANCE CRITERION, and the reason `remaining` is `null` rather
   * than a number: "some crisps" has no remainder, and `0` would be rendered as
   * "nothing left to bring" by anybody who forgot.
   */
  it('is unclaimed when nobody has claimed it', () => {
    expect(contributionTally(null, [])).toEqual({ claimedTotal: 0, remaining: null, done: false })
  })

  it('is claimed the moment somebody has, exactly as before this issue', () => {
    expect(contributionTally(null, [{ quantityClaimed: 1 }]))
      .toEqual({ claimedTotal: 1, remaining: null, done: true })
  })

  it('is not treated as a need of zero', () => {
    // THE MUTATION THIS EXISTS FOR. `quantityNeeded ?? 0` type-checks, passes
    // every route test that claims something, and makes every free-text item on
    // every list read as done with nobody bringing anything — because 0 claimed
    // is >= 0 needed. An unclaimed item is the one place the two answers differ.
    expect(contributionTally(null, []).done).toBe(false)
    expect(contributionTally(0, []).done).toBe(true)
  })

  it('reads the same for undefined as for null', () => {
    // A caller that did not select the column and a database that holds no
    // value are the same statement: nobody said how much.
    expect(contributionTally(undefined, [{ quantityClaimed: 3 }]).remaining).toBeNull()
  })

  it('has no remainder sentence at all', () => {
    expect(remainderLine(null, 'bottles', [{ quantityClaimed: 1 }])).toBeNull()
  })
})

describe('an item that says how many are wanted', () => {
  it('counts what is still missing', () => {
    expect(contributionTally(6, [{ quantityClaimed: 4 }]))
      .toEqual({ claimedTotal: 4, remaining: 2, done: false })
  })

  it('closes when two people claim three each', () => {
    // THE SECOND ACCEPTANCE CRITERION. Two rows, not one — the shape the three
    // dropped columns could not hold at all.
    expect(contributionTally(6, [{ quantityClaimed: 3 }, { quantityClaimed: 3 }]))
      .toEqual({ claimedTotal: 6, remaining: 0, done: true })
  })

  it('reopens with the right remainder when one of them releases', () => {
    // THE THIRD. Releasing is deleting a row, so this is the same call with one
    // fewer claim — and the remainder that comes back is 3, not 0 and not 6.
    expect(contributionTally(6, [{ quantityClaimed: 3 }]))
      .toEqual({ claimedTotal: 3, remaining: 3, done: false })
  })

  it('is not closed by a single claim that does not meet the need', () => {
    // The mutation that ignores a claim's `quantityClaimed` and counts ROWS
    // instead — `claims.length` — makes this item done on one claim of one. It
    // is the difference between six bottles arriving and one.
    expect(contributionTally(6, [{ quantityClaimed: 1 }]).done).toBe(false)
    expect(contributionTally(6, [{ quantityClaimed: 6 }]).done).toBe(true)
  })

  it('lets somebody bring more than was asked for, and floors the remainder', () => {
    // Ten of six bottles is a party, not an error state. Nothing refuses it and
    // the remainder never goes negative.
    expect(contributionTally(6, [{ quantityClaimed: 10 }]))
      .toEqual({ claimedTotal: 10, remaining: 0, done: true })
  })
})

describe('the sentence a screen puts under the title', () => {
  it('says what is needed, what is claimed and what is left', () => {
    expect(remainderLine(6, 'bottles', [{ quantityClaimed: 4 }]))
      .toBe('6 bottles needed, 4 claimed, 2 to go')
  })

  it('reads without a unit, because most things are counted in nothing', () => {
    expect(remainderLine(3, null, [])).toBe('3 needed, 0 claimed, 3 to go')
  })

  it('stops asking once the need is met', () => {
    expect(remainderLine(6, 'bottles', [{ quantityClaimed: 3 }, { quantityClaimed: 3 }]))
      .toBe('6 bottles needed, all claimed')
    expect(remainderLine(6, 'bottles', [{ quantityClaimed: 10 }]))
      .toBe('6 bottles needed, all claimed')
  })
})

/* ------------------------ the screens that render it ---------------------- */

const sfc = (...parts: string[]) => readFileSync(join(ROOT, 'app', ...parts), 'utf8')
const template = (src: string) => /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''
const script = (src: string) =>
  (/<script setup[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the guest bring list', () => {
  it('derives the remainder from the shared rule, in the script', () => {
    const body = script(sfc('components', 'BringList.vue'))
    expect(body, 'BringList has a <script setup> block to read').not.toBe('')

    // PINNED VERBATIM, because every wrong version of this line type-checks.
    // `remainderLine(c.quantityNeeded, c.unit, [])` renders "0 claimed, 6 to
    // go" over an item four people are already bringing, and leaves eslint,
    // `nuxt typecheck` and the whole suite green.
    expect(body).toMatch(/remainderLine\(c\.quantityNeeded, c\.unit, c\.claims\)/)
    // …and the screen does NOT do the arithmetic a second time beside it. Two
    // copies of this rule is two screens able to disagree about one row.
    expect(body).not.toMatch(/quantityNeeded\s*-\s*/)
  })

  it('sends the NUMBER the person chose, not the whole item', () => {
    const body = script(sfc('components', 'BringList.vue'))
    // THE POINT OF THE ISSUE on this surface. `quantity: 1` here makes the
    // number field decorative: every claim is for one whatever it says, so six
    // bottles needs six taps and the field lies about what it did.
    expect(body).toMatch(/quantity: wanted\(c\)/)
    // The default is the remainder — one tap finishes an item off — and it
    // falls back to 1 for an item with no count, which is what a claim there
    // has always been.
    expect(body).toMatch(/amount\[c\.id\] \|\| c\.quantityRemaining \|\| 1/)
    // AND THE ADD FORM CARRIES THE COUNT. Dropping this one property leaves the
    // field on screen writing nothing to the database.
    expect(body).toMatch(/quantityNeeded: newCount\.value \|\| null/)
  })

  it('knows which claim is the viewer\'s own by email, among several', () => {
    const body = script(sfc('components', 'BringList.vue'))
    // `.find` over the LIST. `c.claims[0]` would offer Release to whoever
    // claimed first regardless of who is looking, and hide it from everybody
    // else on an item they are genuinely bringing half of.
    expect(body).toMatch(/c\.claims\.find\(x => x\.email === identity\.value\.email\)/)
  })

  it('shows the count and everybody who is bringing some, in the template', () => {
    const body = template(sfc('components', 'BringList.vue'))
    // The remainder sentence is rendered, not merely computed: deleting this
    // line leaves `countLine` declared, read by nobody and flagged by nothing.
    expect(body).toMatch(/\{\{ countLine\(c\) \}\}/)
    expect(body).toMatch(/v-if="countLine\(c\)"/)
    // EVERY claimant, not the first. `claims[0].name` renders "Ada brings this"
    // over an item Ada and Bo are splitting.
    expect(body).toMatch(/\{\{ claimantLine\(c\) \}\}/)
    // The number field exists, is capped by what is left, and appears only for
    // an item that HAS a count — an item with none must render as it always did.
    expect(body).toMatch(/v-if="!c\.claimed && c\.quantityRemaining !== null"/)
    expect(body).toMatch(/:max="c\.quantityRemaining"/)
    // Release is offered on the viewer's OWN claim, not on "the item is
    // claimed" — which on a shared item would offer everybody the same button.
    expect(body).toMatch(/v-if="myClaim\(c\)"/)
  })
})

describe('the host bring list', () => {
  it('seeds a count without claiming it, in the script', () => {
    const body = script(sfc('pages', 'host', '[slug].vue'))
    expect(body, 'the host page has a <script setup> block to read').not.toBe('')
    expect(body).toMatch(/quantityNeeded: itemCount\.value \|\| null/)
    expect(body).toMatch(/unit: itemUnit\.value \|\| null/)
    // THE SAME RULE AS THE GUEST LIST, from the same function. A second
    // expression here is a host page that can disagree with the invite page
    // about how many bottles are left.
    expect(body).toMatch(/remainderLine\(c\.quantityNeeded, c\.unit, c\.claims\)/)
  })

  it('renders the count and the claimants it now has, in the template', () => {
    const body = template(sfc('pages', 'host', '[slug].vue'))
    expect(body).toMatch(/\{\{ itemCountLine\(c\) \}\}/)
    // Every claimant. The old page said `c.claimedByName`, which is one person
    // by construction and no longer exists.
    expect(body).toMatch(/c\.claims\.map\(x => x\.name\)\.join\(', '\)/)
    expect(body).toMatch(/v-if="c\.claims\.length"/)
  })
})

/* ------------------------ the columns that are gone ----------------------- */

describe('the claim columns this issue dropped', () => {
  /**
   * The acceptance criterion is "gone from the schema and from every reader —
   * grep proves it", so this is that grep, executed.
   *
   * IT IS A GREP OVER CODE AND NOT OVER PROSE, and the distinction is the whole
   * reason this reads. A comment saying WHY `claimedByEmail` no longer exists is
   * the most useful sentence in several of these files — the schema's, the
   * domain's, this one's — and a rule that forbade the name outright would be a
   * rule against explaining the change. What must not exist is a READER. So
   * every file is stripped of its comments first, exactly as the screen
   * assertions above strip `<script setup>`, and what is left is code.
   *
   * THE NEEDLES ARE BUILT FROM PIECES so that this file is not itself a hit in
   * the one position stripping cannot reach — a string literal — which lets the
   * walk cover `test/` rather than carving out an exemption nobody would notice
   * growing.
   *
   * `claimed_at` IS NOT ON THE LIST, deliberately, and saying why is the
   * difference between a rule and a coincidence: that column did not go away,
   * it MOVED. `events_contribution_claim.claimed_at` is when a person said they
   * would bring something, and it is in the schema, the domain view and the
   * contract on purpose. What must not exist is `claimed_at` on
   * `events_contribution`, which is a fact about one table and is asserted
   * below rather than by searching for a string that is legitimately everywhere.
   */
  const GONE = ['claimedBy' + 'Name', 'claimedBy' + 'Email', 'claimed_by_' + 'name', 'claimed_by_' + 'email']
  const DIRS = ['app', 'server', 'shared', 'scripts', 'test']

  const code = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  /**
   * The upgrade job's check, which is the one file that legitimately reads a
   * column this release does not have — see the test below, which is what it
   * pays for the exemption with.
   */
  const STRADDLER = join(ROOT, 'scripts', 'ci-upgrade-check.mjs')

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      // HISTORY RATHER THAN CODE: every migration and every meta snapshot
      // records the schema as it was, `0000_baseline` included. Rewriting those
      // would be rewriting what already ran.
      if (full.includes(join('server', 'database', 'migrations'))) continue
      if (full === STRADDLER) continue
      if (entry.isDirectory()) walk(full, out)
      else if (/\.(ts|vue|mjs|js)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('is read by no live file outside the migration history', () => {
    const files = DIRS.flatMap(d => walk(join(ROOT, d)))
    // COUNT WHAT THE WALK LOOKED AT. An empty offender list is also what a walk
    // over a directory that has been renamed returns.
    expect(files.length).toBeGreaterThan(200)
    const offenders = files
      .map(f => [f, code(readFileSync(f, 'utf8'))] as const)
      .filter(([, src]) => GONE.some(n => src.includes(n)))
      .map(([f]) => f.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it('is read by the upgrade check ONLY where it normalises the two releases', () => {
    /*
     * THE EXEMPTION, PAID FOR. `scripts/ci-upgrade-check.mjs` speaks two
     * releases' `/api/v1` at once by design — its own header says so — because
     * it runs against the PREVIOUS release before the migration and against
     * this one after it. Reading `claimedByEmail` is the whole point: without
     * it there is nothing to compare the backfilled claims against, and the one
     * statement in `0014` that can lose somebody's data would be verified by an
     * empty set while the job reported a pass.
     *
     * So the rule is not "this file may say anything", it is "this file may say
     * it in the normaliser and nowhere else" — a second read anywhere in it
     * would be a genuine reader of a column that does not exist, and would
     * throw rather than compare.
     */
    const src = code(readFileSync(STRADDLER, 'utf8'))
    const [name, scalar] = GONE
    // THE NORMALISER: three occurrences on one line — the `hasOwn`, the guard
    // and the value.
    expect(src).toMatch(new RegExp(`if \\(Object\\.hasOwn\\(c, '${scalar}'\\)\\) return c\\.${scalar}`))
    // AND THE FAILURE DETAIL of the assertion that says the field moved, which
    // prints what the old scalar held so that a failure is diagnosable rather
    // than a bare "not a list" — two more occurrences, evaluated only when that
    // assertion has already failed.
    expect(src).toMatch(new RegExp(`${scalar} is \\$\\{JSON\\.stringify\\(item\\.${scalar}\\)\\}`))
    // Five in total, which is those two sites and nothing else.
    expect([...src.matchAll(new RegExp(scalar!, 'g'))]).toHaveLength(5)
    // …and the other two columns are not read there at all. A single claimer's
    // NAME has no part in the comparison: the identity is the address, as it is
    // everywhere else in this domain.
    expect(src).not.toContain(name)
  })

  it('is declared by no property of the contract Enterprise generates from', () => {
    // THE SPEC IS THE OTHER HALF, and it needs a sharper rule than "the string
    // does not appear": `components.schemas.Contribution.description` NAMES all
    // three, on purpose, because a client author reading that document is
    // exactly the person who has to know which fields went away. What must not
    // survive is a declared PROPERTY, which in this file is a key at a known
    // indent under `properties:`.
    const spec = readFileSync(join(ROOT, 'docs', 'zaeme-api.openapi.yaml'), 'utf8')
    for (const name of GONE) {
      expect(spec, `${name} is still a declared property`).not.toMatch(new RegExp(`^\\s+${name}:`, 'm'))
    }
    // …and the shape that replaced them IS declared, or this assertion would
    // pass on a release that simply deleted the claim from the contract.
    expect(spec).toMatch(/^\s+claims:$/m)
    expect(spec).toMatch(/^ {4}ContributionClaim:$/m)
  })

  it('and `claimed_at` is on the claim, never on the item', () => {
    const events = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
    const item = /export const contribution = pgTable\([\s\S]*?\n\]\)/.exec(events)?.[0] ?? ''
    expect(item, 'the contribution table is no longer declared this way').not.toBe('')
    expect(item).not.toMatch(/claimed_at/)
    // …and the new column IS there, one table down, or this assertion would
    // pass just as happily on a release that dropped the instant entirely.
    const claim = /export const contributionClaim = pgTable\([\s\S]*?\n\]\)/.exec(events)?.[0] ?? ''
    expect(claim).toMatch(/claimedAt: timestamp\('claimed_at'/)
  })

  it('and the item carries the count that replaced them', () => {
    const events = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
    const item = /export const contribution = pgTable\([\s\S]*?\n\]\)/.exec(events)?.[0] ?? ''
    expect(item).toMatch(/quantityNeeded: integer\('quantity_needed'\)/)
    expect(item).toMatch(/unit: text\('unit'\)/)
    // NULLABLE, both of them: an item that says nothing about how many is the
    // common case and the one that must keep behaving as it always has.
    expect(item).not.toMatch(/quantityNeeded: integer\('quantity_needed'\)\.notNull\(\)/)
  })
})
