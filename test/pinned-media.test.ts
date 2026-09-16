/**
 * A ticket pinned to an itinerary step, shown there (#38).
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The hole `test/ticket-detail.test.ts` and `test/ticket-scope.test.ts` next
 * door were opened for, one feature later, and this issue lands squarely in it.
 * The media list is fetched by the BROWSER — media URLs are short-lived
 * signatures, so `app/pages/i/[token].vue` loads them `onMounted` and no SSR'd
 * HTML carries one. `pnpm smoke:api` can therefore prove that both media reads
 * now answer `timelineItemId`, that the pin writes and the un-pin clears, and
 * that a photo is refused — and is structurally incapable of seeing the
 * itinerary render the wrong subset of them, or none at all.
 *
 * WHICH IS THE DEFECT THIS ISSUE IS ABOUT. The column has been correct in the
 * database since the transplant and correct on `/api/v1` for as long as that
 * surface has existed; what was missing was a renderer. A pipeline that watches
 * the wire would have been green for the entire life of the bug, and was.
 *
 * ── AND WHY IT READS `<script setup>` AND NOT ONLY `<template>` ────────────
 *
 * Because a structural test that reads only the template leaves every
 * expression in `<script setup>` pinned by nothing, and the mutations that
 * matter here live there: `pinnedMediaByTimelineItem([])` renders an itinerary
 * with no papers on it, `timelinePinnedMedia({tickets: [], documents: media})`
 * loses every ticket, and `mine: true` written by hand where a document is
 * normalised labels every reservation on the trip as the viewer's own. All
 * three type-check, none of them touches the template, and nothing in this
 * repository executes a `.vue` file. `test/ticket-scope.test.ts` closed this
 * hole for `MediaGallery.vue`; the same discipline applies here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  TIMELINE_PINNABLE_TYPES,
  isPinnableToTimeline,
  pinnableToTimeline,
  pinnedMediaByTimelineItem,
  timelinePinnedMedia
} from '../shared/utils/pinned-media'
import { ticketAssigneeLine } from '../shared/utils/ticket-scope'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

/**
 * ONE STEP WITH TWO THINGS ON IT, ONE STEP WITH NOTHING, AND ONE FILE PINNED
 * NOWHERE — the three cases the acceptance criteria turn on. The document is
 * listed BEFORE the ticket so "tickets first" is a claim the fixture can
 * falsify rather than a coincidence of input order.
 */
const MEDIA = [
  { id: 'doc', type: 'document', timelineItemId: 'step-1' },
  { id: 'tkt', type: 'ticket', timelineItemId: 'step-1' },
  { id: 'loose', type: 'ticket', timelineItemId: null },
  { id: 'photo', type: 'photo', timelineItemId: 'step-1' },
  { id: 'elsewhere', type: 'ticket', timelineItemId: 'step-2' }
]

describe('what may go on a step', () => {
  it('is a ticket or a shared paper, and nothing else', () => {
    // The list is a VALUE both sides read: `setMediaTimelineItem` refuses
    // against it and the host picker offers against it. A picker that offered a
    // photo the server then refused would be two rules disagreeing in one
    // click.
    expect([...TIMELINE_PINNABLE_TYPES]).toEqual(['ticket', 'document'])
    expect(isPinnableToTimeline('ticket')).toBe(true)
    expect(isPinnableToTimeline('document')).toBe(true)
    expect(isPinnableToTimeline('photo')).toBe(false)
    expect(isPinnableToTimeline('video')).toBe(false)
  })

  it('offers every pinnable file, including ones already pinned somewhere', () => {
    // Moving a ticket from the 09:14 to the 11:40 is ONE choice in the picker,
    // not an un-pin followed by a pin — so an item with a step is still on
    // offer. The photo is not.
    expect(pinnableToTimeline(MEDIA).map(m => m.id)).toEqual(['doc', 'tkt', 'loose', 'elsewhere'])
  })
})

describe('what is pinned where', () => {
  it('puts a step\'s papers on that step', () => {
    const byStep = pinnedMediaByTimelineItem(MEDIA)
    expect(byStep.get('step-1')!.map(m => m.id)).toEqual(['tkt', 'doc'])
    expect(byStep.get('step-2')!.map(m => m.id)).toEqual(['elsewhere'])
  })

  it('puts the ticket before the paper whatever order the read gave', () => {
    // The fixture lists the document FIRST, so this fails if the ordering is
    // dropped rather than passing by luck. At the step you are standing at, the
    // thing that gets you through the barrier is the thing you need first.
    expect(pinnedMediaByTimelineItem(MEDIA).get('step-1')!.map(m => m.type))
      .toEqual(['ticket', 'document'])
  })

  it('leaves a step with nothing pinned with no key at all', () => {
    // THE ACCEPTANCE CRITERION most likely to break silently: "an itinerary
    // with no pinned media renders exactly as it does today". It is a property
    // of this function — no key, so the card's `pinnedFor` answers `[]` and the
    // `v-if` above the block is false — rather than of a `v-if` somebody adds.
    const byStep = pinnedMediaByTimelineItem(MEDIA)
    expect(byStep.has('step-3')).toBe(false)
    expect(byStep.get('step-3') ?? []).toEqual([])
  })

  it('drops a file pinned to nothing', () => {
    const ids = [...pinnedMediaByTimelineItem(MEDIA).values()].flat().map(m => m.id)
    expect(ids).not.toContain('loose')
  })

  it('drops a photo somebody pinned before this rule existed', () => {
    // NOT REDUNDANT WITH THE SERVER'S REFUSAL. The column has accepted any
    // media row since the transplant, so rows the renderer has no lines for can
    // already exist — by a `/api/v1` client, by hand, by a later widening. The
    // fixture has one, on a step that also has real papers, so dropping it
    // cannot be confused with dropping the step.
    expect(pinnedMediaByTimelineItem(MEDIA).get('step-1')!.map(m => m.id)).not.toContain('photo')
  })

  it('finds nothing in an empty itinerary', () => {
    expect(pinnedMediaByTimelineItem([]).size).toBe(0)
  })
})

describe('what the invite link hands the itinerary', () => {
  const BUCKETS = {
    tickets: [
      {
        id: 'tkt',
        type: 'ticket',
        timelineItemId: 'step-1',
        fileName: 'pair.pdf',
        caption: null,
        url: 'https://signed/pair',
        mine: true,
        assignedTo: [{ rsvpId: 'r1', name: 'Ana' }, { rsvpId: 'r2', name: 'Ben' }],
        ticket: { seat: '41A', coach: '12' }
      }
    ],
    documents: [
      {
        id: 'doc',
        type: 'document',
        timelineItemId: 'step-1',
        fileName: 'hotel.pdf',
        caption: null,
        url: 'https://signed/hotel'
      }
    ]
  }

  it('carries both buckets through', () => {
    // THE MUTATION THIS CATCHES is the natural typo in a `.map` on the page —
    // handing the itinerary the documents twice, or the tickets not at all. A
    // step then renders its reservation and loses the thing that gets you
    // through the barrier, which is the half of the issue that matters.
    expect(timelinePinnedMedia(BUCKETS).map(m => m.id)).toEqual(['tkt', 'doc'])
  })

  it('keeps what the server decided about a ticket', () => {
    const [ticket] = timelinePinnedMedia(BUCKETS)
    expect(ticket!.mine).toBe(true)
    expect(ticket!.assignedTo.map(a => a.name)).toEqual(['Ana', 'Ben'])
    expect(ticket!.ticket).toEqual({ seat: '41A', coach: '12' })
    // The signed URL, never a stored key: this is what "the file a tap away"
    // means, and a view carrying a `storageKey` would render a dead link.
    expect(ticket!.url).toBe('https://signed/pair')
  })

  it('says a document is nobody\'s rather than everybody\'s', () => {
    // `mine: true` here is ONE WORD, type-checks, and labels every reservation
    // on the trip as the viewer's own. It is the reason the normalisation is a
    // function rather than a `.map` on a page nothing executes.
    const doc = timelinePinnedMedia(BUCKETS).find(m => m.id === 'doc')!
    expect(doc.mine).toBe(false)
    expect(doc.assignedTo).toEqual([])
    expect(doc.type).toBe('document')
  })
})

describe('whose ticket a step is showing', () => {
  // The sentence moved out of `MediaGallery.vue` in #38 so that the itinerary
  // and the Tickets section cannot disagree about one row. These execute it —
  // it was four lines in a `.vue` file and had no check where it stood.
  it('names everybody, even when it is yours', () => {
    expect(ticketAssigneeLine({ mine: true, assignedTo: [{ rsvpId: 'r1', name: 'Ana' }, { rsvpId: 'r2', name: 'Ben' }] }))
      .toBe('Yours — Ana, Ben')
  })

  it('says whose it is when it is somebody else\'s', () => {
    expect(ticketAssigneeLine({ mine: false, assignedTo: [{ rsvpId: 'r3', name: 'Cleo' }] }))
      .toBe('For Cleo')
  })

  it('says a ticket nobody has been given is nobody\'s', () => {
    expect(ticketAssigneeLine({ mine: false, assignedTo: [] })).toBe('Not assigned to anybody yet')
  })
})

/* -------------------------- the screens that render it --------------------- */

const sfc = (...parts: string[]) => readFileSync(join(ROOT, 'app', ...parts), 'utf8')
const template = (src: string) => /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''
/**
 * The `<script setup>` block WITH ITS COMMENTS REMOVED — the same caveat
 * `test/ticket-scope.test.ts` spells out, one level down: the prose explaining
 * why a line reads one way has to quote the wrong version to be worth reading,
 * so an assertion over the raw script matches the explanation and passes on the
 * mutation it describes.
 */
const script = (src: string) =>
  (/<script setup[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the guest itinerary', () => {
  it('groups the real prop, in the script', () => {
    const body = script(sfc('components', 'EventTimeline.vue'))
    expect(body, 'EventTimeline has a <script setup> block to read').not.toBe('')

    // PINNED VERBATIM, because every wrong version of this line type-checks.
    // `pinnedMediaByTimelineItem([])` renders an itinerary with no papers on
    // it and leaves eslint, `nuxt typecheck` and the whole suite green — which
    // is the state this issue exists to end, reached by a one-word edit.
    expect(body).toMatch(/pinnedMediaByTimelineItem\(props\.media\)/)
    // …and the step's list comes out of that map rather than out of the prop.
    expect(body).toMatch(/pinnedMedia\.value\.get\(itemId\) \?\? \[\]/)
  })

  it('makes the pinned media a required prop', () => {
    const src = sfc('components', 'EventTimeline.vue')
    // REQUIRED, never optional with a `[]` default. The two are the same value
    // on the way in and opposite statements about the caller: a page that
    // forgot the binding would render an itinerary with no papers and nothing
    // anywhere red, which is this issue's own shape. #77's review deleted a
    // `:timezone` through a green pipeline for want of exactly this.
    expect(src).toMatch(/^ {2}media: PinnedMediaItem\[\]$/m)
    expect(src).not.toMatch(/^ {2}media\?:/m)
    // …and it is NOT in the `withDefaults` map, which would give it one back.
    expect(script(src)).not.toMatch(/media: \(\) => \[\]/)
  })

  it('renders the file, the seat and whose it is, in the template', () => {
    const body = template(sfc('components', 'EventTimeline.vue'))
    // THE LIST IS THE STEP'S. `v-for="m in media"` renders every pinned file
    // under every step, which is the other way to have a pin that means
    // nothing.
    expect(body).toMatch(/v-for="m in pinnedFor\(entry\.item\.id\)"/)
    expect(body, 'the itinerary renders the whole media list on every step').not.toMatch(/v-for="m in media"/)
    // THE BLOCK IS CONDITIONAL ON THAT SAME LIST, which is the acceptance
    // criterion about an unchanged itinerary rendered as a binding.
    expect(body).toMatch(/v-if="pinnedFor\(entry\.item\.id\)\.length"/)
    // THE FILE IS A TAP AWAY, at the signed URL the read minted.
    expect(body).toMatch(/:to="m\.url"/)
    // WHAT IT SAYS (#35) AND WHOSE IT IS (#37), both beside the download.
    // Deleting either `<p>` leaves its computed declared, read by nobody and
    // flagged by no linter.
    expect(body).toMatch(/ticketDetailLines\(m\.ticket, timezone\)/)
    expect(body).toMatch(/ticketAssigneeLine\(m\)/)
  })

  it('is given every pinned ticket on the event, not the viewer\'s own', () => {
    // #37 DECIDES THIS AND #38 MUST NOT RE-DECIDE IT. Every invite holder
    // reaches every ticket, marked `mine` or not — so the itinerary shows the
    // step's whole list and the line says which one is yours. A
    // `.filter(m => m.mine)` anywhere between the read and the render restores
    // the pre-#37 behaviour in the one place four friends at a barrier are
    // actually looking, and it is one expression long.
    const card = script(sfc('components', 'EventTimeline.vue'))
    expect(card, 'the itinerary filters its pinned media down to the viewer\'s').not.toMatch(/\.mine\b/)
    const page = script(sfc('pages', 'i', '[token].vue'))
    const line = /const timelineMedia = computed\(\(\) => (.+)\)\n/.exec(page)?.[1]
    expect(line, 'the guest page no longer derives the itinerary\'s media').toBeDefined()
    expect(line).toBe('timelinePinnedMedia(media.value)')
  })

  it('binds it on the guest page', () => {
    // THE BINDING, NOT THE COMPUTED. `timelineMedia` can be perfect and the
    // attribute deleted, and the result is `nuxt typecheck` refusing the
    // omission — which is what makes the required prop worth having — unless
    // somebody re-adds a default. Pinned anyway, because the pair is what the
    // criterion needs.
    const body = template(sfc('pages', 'i', '[token].vue'))
    const at = body.indexOf('<EventTimeline')
    expect(at, 'the guest page no longer renders the itinerary').toBeGreaterThan(-1)
    const tag = body.slice(at, body.indexOf('/>', at))
    expect(tag).toMatch(/:media="timelineMedia"/)
    // The zone travels with it, for the reason #77's review paid for: a ticket
    // valid "until 23:59" means 23:59 where the barrier is.
    expect(tag).toMatch(/:timezone="page\.event\.timezone"/)
  })
})

describe('the host itinerary', () => {
  it('pins and un-pins through the one verb, in the script', () => {
    const body = script(sfc('components', 'HostTimelineCard.vue'))
    expect(body, 'HostTimelineCard has a <script setup> block to read').not.toBe('')

    // ONE ROUTE, BOTH DIRECTIONS, and the un-pin is `null` rather than a second
    // endpoint that could disagree with this one about what re-pinning means.
    expect(body).toMatch(/media\/\$\{mediaId\}\/timeline-item`/)
    expect(body).toMatch(/method: 'PUT'/)
    expect(body).toMatch(/body: \{ timelineItemId \}/)
    // …AND THE WRITE IS FOLLOWED BY A RE-READ. The reply is a domain view with
    // a storage key and no signed URL, so a card that rendered it would show a
    // dead link — `HostMediaCard` discards the same answer for the same reason.
    expect(body).toMatch(/await loadMedia\(\)/)

    // THE GROUPING IS OVER THE CARD'S OWN LIST, pinned verbatim: `([])` here
    // renders an itinerary that never shows what is already attached, so a
    // planner pins the same ticket twice and sees nothing either time.
    expect(body).toMatch(/pinnedMediaByTimelineItem\(media\.value\)/)
    expect(body).toMatch(/pinnableToTimeline\(media\.value\)/)
  })

  it('offers the pin and the un-pin on the step, in the template', () => {
    const body = template(sfc('components', 'HostTimelineCard.vue'))
    // WHAT IS ALREADY ON THE STEP, and a way to take it off.
    expect(body).toMatch(/v-for="m in pinnedFor\(item\.id\)"/)
    expect(body).toMatch(/setPin\(m\.id, null\)/)
    // …AND A WAY TO PUT SOMETHING ON IT, pinned to THIS step rather than to a
    // literal: `setPin(v, item.id)` with a hard-coded id would pin everything
    // to one step, which type-checks and reads correctly in the diff.
    expect(body).toMatch(/setPin\(v, item\.id\)/)
    expect(body).toMatch(/:items="pinChoices\(item\.id\)"/)
    // AN EVENT WITH NOTHING PINNABLE RENDERS AS IT DID — the host half of the
    // unchanged-itinerary criterion, as a binding rather than as a promise.
    expect(body).toMatch(/pinnable\.length/)
  })
})

describe('what the server sends', () => {
  it('carries the step on the view both human reads are built from', () => {
    // THE FIELD WAS ON THE ROW, ON `/api/v1` AND ON NOTHING A PERSON LOOKS AT,
    // which is the whole defect: `MediaItemView` is what `listMediaForViewer`
    // and `listMediaForPlanner` project, and it dropped the column before it
    // reached a screen. Pinned on `toView`, which is the one place all four
    // view-producing call sites go through.
    const src = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    expect(src).toMatch(/^ {2}timelineItemId: string \| null$/m)
    expect(src).toMatch(/^ {4}timelineItemId: r\.timelineItemId,$/m)
    // …AND NOT AS A CONSTANT. `timelineItemId: null` in `toView` answers "this
    // is pinned to nothing" for every file on every event, with `nuxt
    // typecheck` green — the #78 shape `test/api-boundary.test.ts` refuses on
    // the machine surface, refused here on the human one.
    expect(src).not.toMatch(/^ {4}timelineItemId: (null|undefined),$/m)
  })

  it('refuses a photo on a step, and refuses a step from another trip', () => {
    const src = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const start = src.indexOf('export async function setMediaTimelineItem(')
    expect(start, 'setMediaTimelineItem is gone').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    // The type rule is the SHARED one, so the host's picker and this refusal
    // cannot drift apart about what a step may carry.
    expect(body).toMatch(/isPinnableToTimeline\(item\.type\)/)
    // THE STEP IS CHECKED ON THE EVENT. `timeline_item_id` is a plain foreign
    // key with no composite behind it, so Postgres would accept a step id from
    // another trip — which pins somebody's ticket where nobody can see it.
    expect(body).toMatch(/eq\(tables\.timelineItem\.eventId, ev\.id\)/)
  })
})
