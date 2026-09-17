/**
 * Nobody knows what a potluck for twelve needs (#45).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `scripts/api-smoke.sh` proves the two routes: that a party with twelve yes
 * -RSVPs gets six bottles of wine, that applying twice adds nothing the second
 * time, and that a copy of a past event brings its items and none of its
 * claims. It is curl and it never loads a Vue page, so everything the HOST
 * actually touches — the ticks, the number fields, the sentence a gig gets
 * instead of a button — is structurally invisible to it. That is how #82
 * shipped a broken headline past 879 green checks and #85 a claim-destroying
 * pre-fill past 909.
 *
 * So the arithmetic and the sentences live in
 * `shared/utils/bring-list-suggestions.ts` and are EXECUTED below, and the call
 * sites in `BringListSuggest.vue`, the host page and the domain are pinned as
 * source text — which is a weaker thing, said plainly where it happens.
 *
 * ── AND WHY THE TYPE TABLE IS READ OUT OF THE SCHEMA ──────────────────────
 *
 * The issue names three event types. The schema has five, and the two it omits
 * include `hosted`, WHICH IS THE DEFAULT — every event created without an
 * explicit type, and every showing of a series, is one. Under the issue as
 * written the most common event on any instance would get a one-tap button that
 * does nothing. So the enum is parsed out of `server/database/schema/events.ts`
 * and every value in it must answer with items OR a reason: a sixth type added
 * later fails this file rather than shipping an empty box.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SUGGESTIONS,
  applySummary,
  attendingHeadcount,
  bringListKey,
  headcountLine,
  isThinBringList,
  partitionNewItems,
  suggestBringListItems,
  suggestedQuantity,
  suggestionsFor
} from '../shared/utils/bring-list-suggestions'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')

/** Comments stripped, so a paragraph explaining a wrong version is not a hit. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const scriptOf = (src: string) => code(/<script setup[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '')
const templateOf = (src: string) => /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''

/* ------------------------ every type answers something --------------------- */

describe('every event type the schema can hold', () => {
  /** The enum, read where it is declared rather than copied here. */
  const schemaTypes = (): string[] => {
    const src = read('server', 'database', 'schema', 'events.ts')
    const list = /type: text\('type', \{ enum: \[([^\]]*)\] \}\)/.exec(src)?.[1]
    return (list ?? '').split(',').map(v => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
  }

  it('found the enum it is meant to be checking', () => {
    // An empty list is also what a regex that stopped matching returns, and it
    // would make every assertion below vacuous.
    expect(schemaTypes()).toEqual(['hosted', 'concert', 'series', 'trip', 'party'])
  })

  it('has a set, so no type falls through to somebody else\'s list', () => {
    expect(Object.keys(SUGGESTIONS).sort()).toEqual(schemaTypes().sort())
  })

  it('answers with items OR a reason, never with neither', () => {
    // THE RULE THE WHOLE FEATURE RESTS ON. A type with an empty list and no
    // reason is a button that looks live and does nothing — which is precisely
    // what `hosted` and `concert` would have had under the issue as written.
    for (const type of schemaTypes()) {
      const set = suggestionsFor(type)
      expect(set.items.length > 0, `${type} suggests nothing and says why not`).toBe(set.reason === null)
    }
  })

  it('gives the DEFAULT type a real list, because it is the commonest event', () => {
    // `hosted` is what an event created without a type is, and what
    // `scheduleOccurrence` makes every showing of a series. If anything gets a
    // list, this does.
    expect(SUGGESTIONS.hosted.items.length).toBeGreaterThan(0)
    expect(SUGGESTIONS.hosted.reason).toBeNull()
  })

  it('gives a gig and a series container a SENTENCE rather than an empty box', () => {
    for (const type of ['concert', 'series'] as const) {
      expect(SUGGESTIONS[type].items).toHaveLength(0)
      expect(SUGGESTIONS[type].reason).toMatch(/\w/)
    }
  })

  it('falls back to the default set for a type nothing knows about', () => {
    // A row written before an enum value was removed, or a typo in a fixture:
    // the answer is the generic list, never a crash and never an empty panel.
    expect(suggestionsFor('nonsense')).toBe(SUGGESTIONS.hosted)
  })

  it('keys every line, so a translation has something to look up', () => {
    const keys = Object.values(SUGGESTIONS).flatMap(s => s.items.map(i => i.key))
    expect(keys.length).toBeGreaterThan(10)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

/* ----------------------------- the scaling rule ---------------------------- */

describe('scaling a list to the headcount', () => {
  it('produces plausible quantities for a party of twelve', () => {
    // THE FIRST ACCEPTANCE CRITERION, as numbers rather than as an adjective.
    const items = suggestBringListItems('party', 12)
    const by = (title: string) => items.find(i => i.title === title)?.quantityNeeded
    expect(by('Wine')).toBe(6)
    expect(by('Beer')).toBe(24)
    expect(by('Ice')).toBe(3)
    expect(by('Cups')).toBe(18)
  })

  it('is a different list for four than for twelve', () => {
    // THE MUTATION THIS EXISTS FOR — "ignore the headcount and hand back the
    // minimums" produces a perfectly plausible-looking list and passes every
    // structural check there is. Four people and twelve must not agree.
    const four = suggestBringListItems('party', 4).map(i => i.quantityNeeded)
    const twelve = suggestBringListItems('party', 12).map(i => i.quantityNeeded)
    expect(four).not.toEqual(twelve)
    expect(suggestedQuantity({ perPerson: 0.5, minimum: 2 }, 12)).toBe(6)
    expect(suggestedQuantity({ perPerson: 0.5, minimum: 2 }, 4)).toBe(2)
  })

  it('rounds UP, because running out is worse than a leftover', () => {
    expect(suggestedQuantity({ perPerson: 0.5, minimum: 1 }, 7)).toBe(4)
    expect(suggestedQuantity({ perPerson: 0.25, minimum: 1 }, 9)).toBe(3)
  })

  it('never goes below the line\'s own minimum', () => {
    expect(suggestedQuantity({ perPerson: 2, minimum: 6 }, 1)).toBe(6)
  })

  it('leaves a flat item alone however many people come', () => {
    // A corkscrew is not 1/12 of a corkscrew per person: `perPerson: null` is
    // the difference between "one is plenty" and a second one appearing when a
    // thirteenth friend says yes.
    const corkscrew = SUGGESTIONS.trip.items.find(i => i.key === 'trip.corkscrew')!
    expect(corkscrew.perPerson).toBeNull()
    expect(suggestedQuantity(corkscrew, 4)).toBe(1)
    expect(suggestedQuantity(corkscrew, 40)).toBe(1)
  })

  it('floors an empty guest list at one head rather than at zero', () => {
    // THE CASE A HOST MEETS FIRST: an event published this morning has no
    // yes-RSVPs, and `0 * anything` is a list saying nobody should bring
    // anything — a one-tap button whose result is useless.
    const none = suggestBringListItems('party', 0)
    expect(none.every(i => (i.quantityNeeded ?? 0) >= 1)).toBe(true)
    expect(none).toEqual(suggestBringListItems('party', 1))
  })

  it('survives a headcount that is not a number', () => {
    expect(suggestedQuantity({ perPerson: 0.5, minimum: 2 }, Number.NaN)).toBe(2)
  })

  it('suggests nothing at all for a type that has a reason instead', () => {
    expect(suggestBringListItems('concert', 12)).toEqual([])
  })
})

/* --------------------------- who is actually eating ------------------------ */

describe('the headcount a list is scaled to', () => {
  it('counts the people who said yes, and their plus-ones', () => {
    expect(attendingHeadcount([
      { status: 'yes' },
      { status: 'yes', plusOne: true },
      { status: 'yes', plusOne: false }
    ])).toBe(4)
  })

  it('counts nobody who is not coming', () => {
    expect(attendingHeadcount([
      { status: 'maybe', plusOne: true },
      { status: 'no' },
      { status: 'cheering', plusOne: true }
    ])).toBe(0)
  })

  it('excludes `cheering`, which means "from afar"', () => {
    // `summariseRsvps().headcount` in `server/domain/events-data.ts` counts
    // `cheering` and is deliberately NOT reused: that status is offered on
    // concerts alone and means somebody is not coming. They eat nothing.
    expect(attendingHeadcount([{ status: 'yes' }, { status: 'cheering' }])).toBe(1)
  })

  it('is zero for an event nobody has answered', () => {
    expect(attendingHeadcount([])).toBe(0)
  })
})

/* -------------------------- applying twice, safely ------------------------- */

describe('applying a suggestion twice', () => {
  it('adds nothing the second time', () => {
    // THE THIRD ACCEPTANCE CRITERION. There is no marker column and no
    // migration in this issue, so an item's identity is its title on its event.
    const items = suggestBringListItems('party', 12)
    const first = partitionNewItems(items, [])
    expect(first.fresh).toHaveLength(items.length)
    const second = partitionNewItems(items, first.fresh.map(i => i.title))
    expect(second.fresh).toEqual([])
    expect(second.duplicates).toHaveLength(items.length)
  })

  it('treats a title the host typed differently as the same thing', () => {
    expect(bringListKey('  Ice ')).toBe('ice')
    expect(bringListKey('Crisps  and   nuts')).toBe(bringListKey('crisps and nuts'))
    const { fresh } = partitionNewItems([{ title: 'ICE' }], ['  Ice '])
    expect(fresh).toEqual([])
  })

  it('de-duplicates within one suggestion, not only against the list', () => {
    // A copied past event can legitimately carry "Ice" and "ice " on it; one
    // apply must not put both on this one.
    const { fresh, duplicates } = partitionNewItems([{ title: 'Ice' }, { title: 'ice' }], [])
    expect(fresh).toHaveLength(1)
    expect(duplicates).toHaveLength(1)
  })

  it('leaves an existing item alone rather than re-stating its count', () => {
    // A host who lowered Wine from 6 to 4 and tapped again must keep their 4.
    // The suggestion is SKIPPED and reported, never written over the top.
    const { fresh, duplicates } = partitionNewItems(
      [{ title: 'Wine', quantityNeeded: 6 }],
      ['Wine']
    )
    expect(fresh).toEqual([])
    expect(duplicates).toEqual([{ title: 'Wine', quantityNeeded: 6 }])
  })

  it('still adds the lines that are genuinely new', () => {
    const { fresh, duplicates } = partitionNewItems(
      [{ title: 'Wine' }, { title: 'Ice' }],
      ['wine']
    )
    expect(fresh.map(i => i.title)).toEqual(['Ice'])
    expect(duplicates.map(i => i.title)).toEqual(['Wine'])
  })
})

/* --------------------------- the sentences it says ------------------------- */

describe('what the panel says', () => {
  it('says what the counts were scaled to', () => {
    expect(headcountLine(12)).toBe('Scaled to the 12 people who have said yes.')
    expect(headcountLine(1)).toBe('Scaled to the 1 person who has said yes.')
  })

  it('does not claim a party of one when nobody has answered', () => {
    expect(headcountLine(0)).toMatch(/Nobody has said yes yet/)
  })

  it('reads a second apply as a guarantee rather than as a failure', () => {
    // `Added 0 items` is what an honest counter says and what a host reads as
    // "it did not work" — which is exactly when it DID work.
    expect(applySummary(0, 6)).toMatch(/^Already on the list/)
    expect(applySummary(0, 6)).not.toMatch(/Added 0/)
    expect(applySummary(6, 0)).toBe('Added 6 items.')
    expect(applySummary(4, 2)).toBe('Added 4 items — 2 items were already on the list.')
    expect(applySummary(1, 0)).toBe('Added 1 item.')
  })

  it('opens by itself on an empty or thin list and hides on a full one', () => {
    expect(isThinBringList(0)).toBe(true)
    expect(isThinBringList(2)).toBe(true)
    expect(isThinBringList(3)).toBe(false)
    expect(isThinBringList(9)).toBe(false)
  })
})

/* ------------------------ the screens and the handler ---------------------- */

/**
 * WHAT EVERY ASSERTION BELOW IS, SAID PLAINLY: a string match over source text,
 * with comments stripped first. Nothing in this repository executes a `.vue`
 * file and nothing here runs a query, so these prove a line is WRITTEN. What
 * executes the component is a person's browser; what executes the handler and
 * the domain is `scripts/api-smoke.sh`, which posts to both routes with the
 * host's cookie and re-reads the list afterwards.
 *
 * A grep is also blind to `if (false && …)`, so each one below is paired with
 * the smoke check that walks it, named in its comment.
 */
describe('the suggestion panel', () => {
  const sfc = () => read('app', 'components', 'BringListSuggest.vue')

  it('has a script and a template to read', () => {
    expect(scriptOf(sfc())).not.toBe('')
    expect(templateOf(sfc())).not.toBe('')
  })

  it('sends the EDITED rows, not the suggestion it was handed', () => {
    const body = scriptOf(sfc())
    // THE MUTATION THAT MAKES EVERY TICK AND EVERY NUMBER DECORATIVE: post
    // `rows.value` (or the response) instead of `chosen.value` and the panel
    // still looks and feels identical while ignoring the host completely.
    // Executed by "the host unticks one line and re-counts another" in the
    // smoke suite, which applies a body the GET never proposed.
    expect(body).toMatch(/^const chosen = computed\(\(\) => rows\.value\.filter\(r => r\.include\)\)$/m)
    expect(body).toMatch(/items: chosen\.value\.map\(r => \(\{/)
    expect(body).not.toMatch(/items: rows\.value/)
  })

  it('takes the numbers and the threshold from the shared rule', () => {
    const body = scriptOf(sfc())
    expect(body).toMatch(/^const open = ref\(isThinBringList\(props\.itemCount\)\)$/m)
    expect(body).toMatch(/applySummary\(result\.added, result\.skipped\.length\)/)
    // …and does no arithmetic of its own beside it. Two copies of the scaling
    // rule is a screen able to disagree with the server about one list.
    expect(body).not.toMatch(/headcount\.value\s*\*/)
  })

  it('shows a reason INSTEAD of the list when there is nothing to suggest', () => {
    const body = templateOf(sfc())
    // A gig and a series container get a sentence. The `v-else-if` chain is
    // what makes it exclusive: a reason and a live "Add 0 items" button on one
    // panel is the failure this feature must not have.
    expect(body).toMatch(/v-else-if="reason"/)
    expect(body).toMatch(/\{\{ reason \}\}/)
    expect(body).toMatch(/\{\{ headcountLine\(headcount\) \}\}/)
    // The button is inside the branch that only renders when there are rows…
    expect(body).toMatch(/v-else-if="!rows\.length"/)
    // …and it refuses to fire with nothing ticked.
    expect(body).toMatch(/:disabled="!chosen\.length"/)
  })

  it('offers the count and the tick on every row', () => {
    const body = templateOf(sfc())
    expect(body).toMatch(/v-model="r\.include"/)
    expect(body).toMatch(/v-model\.number="r\.quantityNeeded"/)
  })
})

describe('the host page', () => {
  it('mounts the panel on the bring list with the count it needs', () => {
    const body = templateOf(read('app', 'pages', 'host', '[slug].vue'))
    // `:item-count` and not a boolean computed on the page: "thin" is one
    // number in `shared/utils/bring-list-suggestions.ts`, and a second opinion
    // about it here is a second place to get it wrong.
    expect(body).toMatch(/<BringListSuggest/)
    expect(body).toMatch(/:item-count="data\.contributions\.length"/)
    expect(body).toMatch(/@updated="\(\) => refresh\(\)"/)
  })
})

describe('the copy of a past event', () => {
  const domain = () => code(read('server', 'domain', 'contributions.ts'))

  it('never names the claim table on the way through', () => {
    // THE FOURTH ACCEPTANCE CRITERION, as the strongest thing a grep can say:
    // `copyableItems` selects six columns of `events_contribution` and the word
    // `contributionClaim` does not occur between its signature and its close.
    // That is a statement about the TEXT — what proves the claims do not
    // arrive is the smoke check that claims an item on the source event and
    // then asserts the copy's items are unclaimed.
    const fn = /async function copyableItems\([\s\S]*?\n\}/.exec(domain())?.[0] ?? ''
    expect(fn, 'copyableItems is no longer declared this way').not.toBe('')
    expect(fn).not.toMatch(/contributionClaim/)
    expect(fn).toMatch(/\.from\(tables\.contribution\)/)
  })

  it('writes items and nothing else when the host applies one', () => {
    const fn = /export async function applyBringListSuggestion\([\s\S]*?\n\}/.exec(domain())?.[0] ?? ''
    expect(fn, 'applyBringListSuggestion is no longer declared this way').not.toBe('')
    expect(fn).not.toMatch(/contributionClaim/)
    // The duplicate rule is the shared one, executed above, and not a second
    // expression here.
    expect(fn).toMatch(/partitionNewItems\(items, existing\.map\(r => r\.title\)\)/)
    // AND THE TWO STATEMENTS ARE SERIALISED. Reading the titles and then
    // inserting lets two simultaneous taps both read "no Wine"; the event row
    // is locked for the duration, the same lock `changeEventCurrency` takes.
    expect(fn).toMatch(/\.for\('update'\)/)
  })

  it('checks the planner on the SOURCE event too', () => {
    const fn = /async function copyableItems\([\s\S]*?\n\}/.exec(domain())?.[0] ?? ''
    // Without this, any slug on the instance hands its bring list to anybody
    // who can name it. The smoke suite walks the refusal from a second account.
    expect(fn).toMatch(/await assertPlanner\(source\.id, userId\)/)
    // …and refuses a source of a different type, and this event itself.
    expect(fn).toMatch(/source\.type !== target\.type/)
    expect(fn).toMatch(/source\.id === target\.id/)
  })
})
