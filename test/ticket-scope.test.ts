/**
 * Mine or everybody's — the two buttons over the ticket list (#37).
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The same hole `test/ticket-detail.test.ts` next door was opened for, one
 * feature later. The ticket list is fetched by the BROWSER — media URLs are
 * short-lived signatures, so `app/pages/i/[token].vue` loads them `onMounted`
 * and no SSR'd HTML carries them. `pnpm smoke:api` can therefore prove the
 * server now answers with EVERY ticket on the event and is structurally
 * incapable of noticing the card render the wrong subset of them, or render an
 * empty box where a sentence belongs. A check that watches the wire while the
 * defect lives in the renderer is a check that would have passed.
 *
 * So the rule lives in `shared/utils/ticket-scope.ts` and the first half of
 * this file executes it.
 *
 * ── AND WHY THE SECOND HALF READS A TEMPLATE ──────────────────────────────
 *
 * Because executing the rule is not the same as the card CALLING it, and #77's
 * review is the proof: it deleted `:timezone="page.event.timezone"` from the
 * guest page and got eslint clean, `nuxt typecheck` clean, 426 vitest passed
 * and 731 smoke checks passed, with every ticket rendered against the reader's
 * clock. `test/ticket-detail.test.ts` was green throughout — it tested the
 * function, and what had broken was the argument.
 *
 * The empty-Mine notice has exactly that shape. `ticketScopeNotice` can be
 * perfect and the `<p>` that renders it can be deleted, and the result is the
 * empty box this issue exists to prevent, with nothing anywhere red. So the
 * bindings are pinned structurally, the way this repository already pins
 * `<NuxtPage />` and the zone props — with the same caveat that taught: only
 * the TEMPLATE counts, since the prose above these bindings names them too.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TICKET_SCOPE, ticketScopeNotice, ticketScopeView, ticketsInScope } from '../shared/utils/ticket-scope'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')

/** Three tickets: one the viewer's, one somebody else's, one nobody's. */
const TICKETS = [
  { id: 'mine', mine: true },
  { id: 'theirs', mine: false },
  { id: 'nobodys', mine: false }
]

describe('which tickets a button shows', () => {
  it('shows the viewer only theirs under Mine', () => {
    expect(ticketsInScope(TICKETS, 'mine').map(t => t.id)).toEqual(['mine'])
  })

  it('shows every ticket on the event under All', () => {
    // THE ACCEPTANCE CRITERION, and the reason the fixture has three rows
    // rather than two: a filter that had simply been inverted would also pass
    // "All is longer than Mine".
    expect(ticketsInScope(TICKETS, 'all').map(t => t.id)).toEqual(['mine', 'theirs', 'nobodys'])
  })

  it('puts a ticket assigned to nobody under All and not under Mine', () => {
    // `assignedRsvpIds` is `[]` for it, so `mine` is false — it is not anybody's
    // and therefore cannot be the viewer's. This is a real state: a planner has
    // uploaded the group booking and has not yet said who is on it.
    expect(ticketsInScope(TICKETS, 'all').some(t => t.id === 'nobodys')).toBe(true)
    expect(ticketsInScope(TICKETS, 'mine').some(t => t.id === 'nobodys')).toBe(false)
  })

  it('does not hand the caller the array it was given', () => {
    // `All` is a copy, so a caller that sorts what it renders does not reorder
    // the prop underneath the component that owns it.
    expect(ticketsInScope(TICKETS, 'all')).not.toBe(TICKETS)
  })
})

describe('which button is pressed before anybody presses one', () => {
  it('opens on Mine', () => {
    // ACCEPTANCE CRITERION 2, AND IT HAD NO CHECK AT ALL. It lived as the
    // literal in `ref<TicketScope>('mine')`, one word from `'all'`, and that
    // word is in a `.vue` file that nothing in this repository executes:
    // changing it left eslint, `nuxt typecheck` and all 446 tests green while
    // the card opened on somebody else's tickets. A value can be executed; a
    // literal in a component cannot.
    expect(DEFAULT_TICKET_SCOPE).toBe('mine')
  })
})

describe('the decision the card actually makes', () => {
  // `ticketScopeView` exists because a rule can be perfect and its ARGUMENTS
  // wrong — the #35 lesson this file's preamble quotes, which was closed for
  // DELETING a binding and left open for WIRING one wrong. These run the whole
  // derivation, `identified` included, so the card is left with one call site
  // to get right instead of three.
  it('shows the viewer theirs and says nothing, under Mine', () => {
    const view = ticketScopeView(TICKETS, 'mine', 'ana@example.com')
    expect(view.shown.map(t => t.id)).toEqual(['mine'])
    expect(view.notice).toBeNull()
  })

  it('shows everything under All', () => {
    expect(ticketScopeView(TICKETS, 'all', null).shown.map(t => t.id))
      .toEqual(['mine', 'theirs', 'nobodys'])
  })

  it('derives `identified` from the email rather than taking it on trust', () => {
    // THE MUTATION THIS CATCHES is `identified: true` hard-coded at the call
    // site, which used to live in the component where nothing could see it. The
    // two sentences are different on purpose, so asserting they DIFFER is the
    // assertion — a fixture-free way of saying the flag is really being read.
    const anonymous = ticketScopeView([TICKETS[1]!], 'mine', null).notice
    const known = ticketScopeView([TICKETS[1]!], 'mine', 'ana@example.com').notice
    expect(anonymous).toBeTruthy()
    expect(known).toBeTruthy()
    expect(anonymous).not.toBe(known)
    expect(anonymous!.toLowerCase()).toContain('who you are')
    expect(known!.toLowerCase()).not.toContain('who you are')
  })

  it('treats an empty address as nobody having said', () => {
    // `identity.email` is `''` before anybody types into the box. A caller that
    // forwards the raw field must still get "you have not told us" — telling
    // somebody we looked and found nothing of theirs, when they have not given
    // us a name, is the empty-Mine screen wearing the other sentence.
    expect(ticketScopeView([TICKETS[1]!], 'mine', '').notice)
      .toBe(ticketScopeView([TICKETS[1]!], 'mine', null).notice)
    expect(ticketScopeView([TICKETS[1]!], 'mine', '   ').notice)
      .toBe(ticketScopeView([TICKETS[1]!], 'mine', null).notice)
  })
})

describe('what an empty list says', () => {
  it('asks an unidentified viewer who they are', () => {
    const notice = ticketScopeNotice('mine', { total: 3, mine: 0, identified: false })
    expect(notice).toBeTruthy()
    // NEEDLED ON THE TWO THINGS THE SENTENCE HAS TO DO, not on its wording: it
    // has to ask for a name, and it has to say where the rest of the tickets
    // are. A test pinning the whole string would fail on a comma and pass on a
    // sentence that did neither.
    expect(notice!.toLowerCase()).toContain('who you are')
    expect(notice).toContain('All')
  })

  it('tells an identified viewer with nothing of their own where the rest are', () => {
    const notice = ticketScopeNotice('mine', { total: 3, mine: 0, identified: true })
    expect(notice).toBeTruthy()
    // AND IT IS A DIFFERENT SENTENCE. Folding the two together would give the
    // person who has already typed their address advice they have followed —
    // which is the reading of "broken" this issue is trying to remove, not add.
    expect(notice).not.toBe(ticketScopeNotice('mine', { total: 3, mine: 0, identified: false }))
    expect(notice!.toLowerCase()).not.toContain('who you are')
    expect(notice).toContain('All')
  })

  it('says nothing when there is a list to render', () => {
    expect(ticketScopeNotice('mine', { total: 3, mine: 1, identified: true })).toBeNull()
    expect(ticketScopeNotice('all', { total: 3, mine: 0, identified: false })).toBeNull()
  })

  it('never lets Mine be empty AND silent', () => {
    // THE WHOLE RULE, SWEPT. Every combination that renders no rows must
    // produce a sentence, and every combination that renders rows must produce
    // none — a `null` in the first group is the empty box, and a notice in the
    // second is a sentence sitting above a list that contradicts it.
    for (const total of [0, 1, 3]) {
      for (const mine of [0, 1]) {
        if (mine > total) continue
        for (const identified of [false, true]) {
          for (const scope of ['mine', 'all'] as const) {
            const shown = scope === 'all' ? total : mine
            const notice = ticketScopeNotice(scope, { total, mine, identified })
            if (shown === 0) expect(notice, `${scope}/${total}/${mine}/${identified}`).toBeTruthy()
            else expect(notice, `${scope}/${total}/${mine}/${identified}`).toBeNull()
          }
        }
      }
    }
  })
})

describe('the card that renders it', () => {
  const sfc = (...parts: string[]) => readFileSync(join(ROOT, 'app', ...parts), 'utf8')
  const template = (src: string) => /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''
  /**
   * The `<script setup>` block WITH ITS COMMENTS REMOVED. Same caveat as
   * reading only `<template>`, one level down: the prose explaining why a line
   * reads `DEFAULT_TICKET_SCOPE` rather than `'mine'` has to quote the wrong
   * version to be worth reading, so an assertion over the raw script matches
   * the explanation and passes on the mutation it describes. Strip the prose
   * and every assertion below is about code.
   */
  const script = (src: string) =>
    (/<script setup[^>]*>([\s\S]*?)<\/script>/.exec(src)?.[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('wires the rule to the card\'s own state, in the script', () => {
    // THE HALF THE TEMPLATE CANNOT SHOW, and it was open. Reading only
    // `<template>` is right for the bindings — the prose above one names it too
    // — but it leaves every expression in `<script setup>` pinned by nothing,
    // and four separate one-word mutations there survived eslint, `nuxt
    // typecheck` and all 446 tests with the card still rendering.
    const body = script(sfc('components', 'MediaGallery.vue'))
    expect(body, 'the script has a <script setup> block to read').not.toBe('')

    // THE DEFAULT IS THE IMPORTED VALUE, not a literal. `ref<TicketScope>('all')`
    // deletes acceptance criterion 2 in one word; `DEFAULT_TICKET_SCOPE` is
    // executed by the test above, so the mutation has to happen somewhere a
    // check is looking.
    expect(body).toMatch(/ref<TicketScope>\(DEFAULT_TICKET_SCOPE\)/)
    expect(body, 'the default scope is typed into the card as a literal').not.toMatch(/ref<TicketScope>\('/)

    // AND THE RULE IS CALLED WITH THE CARD'S OWN STATE — pinned VERBATIM,
    // because every wrong version of this line type-checks. `scope.value`
    // replaced by `'all'` makes both buttons labels while `v-for="t in
    // shownTickets"` still reads correctly; `props.viewerEmail` replaced by
    // `null` tells somebody who typed their address that they have not.
    expect(body).toMatch(/ticketScopeView\(props\.tickets, scope\.value, props\.viewerEmail\)/)
    // …and `identified` is DERIVED inside the rule, never asserted out here,
    // where `identified: true` would be invisible to everything.
    expect(body, 'the card decides `identified` for itself').not.toMatch(/identified:/)
  })

  it('renders the notice and the filtered list, in the template', () => {
    const body = template(sfc('components', 'MediaGallery.vue'))
    // THE BINDING, NOT THE COMPUTED. Deleting the `<p>` leaves `ticketNotice`
    // declared, exported by nothing, read by nobody and flagged by no linter —
    // which is precisely the silence #77's review demonstrated.
    expect(body, 'the empty-Mine notice is not rendered anywhere').toMatch(/\{\{\s*ticketNotice\s*\}\}/)
    // …AND THE LIST IS THE SCOPED ONE. `v-for="t in tickets"` renders every
    // ticket under both buttons, which is the other way to have two buttons
    // that do nothing.
    expect(body).toMatch(/v-for="t in shownTickets"/)
    expect(body, 'the ticket list renders the unfiltered prop').not.toMatch(/v-for="t in tickets"/)
    // BOTH BUTTONS EXIST AND BOTH SET THE SCOPE. One that only ever reads it is
    // a label.
    expect(body).toMatch(/scope = 'mine'/)
    expect(body).toMatch(/scope = 'all'/)
    // AND WHO EACH ONE IS FOR IS ON SCREEN — the half of the acceptance
    // criteria that is about `All` being usable rather than merely full.
    expect(body).toMatch(/assignedLine\(t\)/)
  })

  it('makes the viewer identity a required prop, and binds it everywhere', () => {
    const src = sfc('components', 'MediaGallery.vue')
    // REQUIRED. `viewerEmail?: string | null` is the shape that goes quiet: an
    // omitted prop would be `undefined`, which is falsy, which is "nobody has
    // told us" — so a forgotten binding would render the ask-who-you-are notice
    // to somebody who has already answered, forever.
    expect(src).toMatch(/^ {2}viewerEmail: string \| null$/m)
    expect(src).not.toMatch(/^ {2}viewerEmail\?:/m)

    const missing: string[] = []
    let callSites = 0
    let ticketCallSites = 0
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(full)
          continue
        }
        if (!entry.name.endsWith('.vue')) continue
        const body = template(readFileSync(full, 'utf8'))
        for (const at of [...body.matchAll(/<MediaGallery(?![\w-])/g)].map(m => m.index!)) {
          callSites += 1
          const tag = body.slice(at, body.indexOf('>', at))
          const viewer = /:viewer-email="([^"]*)"/.exec(tag)
          const tickets = /:tickets="([^"]*)"/.exec(tag)
          if (!viewer) {
            missing.push(`${full}: <MediaGallery> with no :viewer-email`)
            continue
          }
          // PRESENT IS NOT THE SAME AS RIGHT. `HostMediaCard.vue` legitimately
          // binds `null` — it hands the gallery `:tickets="[]"` and renders its
          // own — so `null` is a correct answer there and copying that literal
          // onto a call site that DOES pass tickets is the natural regression:
          // every viewer who has typed their address is then told forever to
          // say who they are. The rule is therefore about the pair.
          if (viewer[1]!.trim() === 'null' && tickets?.[1]!.trim() !== '[]') {
            missing.push(`${full}: <MediaGallery> is told nobody is watching while it is given tickets`)
          }
          if (tickets && tickets[1]!.trim() !== '[]') ticketCallSites += 1
        }
      }
    }
    visit(join(ROOT, 'app'))
    expect(missing).toEqual([])
    // THE ANTI-VACUITY GUARD, counting what the WALK found: `missing` is empty
    // both when every call site binds it and when the walk found no call sites
    // at all. Two exist today — the gallery on the guest page, and the gallery
    // nested inside the host card.
    expect(callSites).toBe(2)
    // …AND THE SECOND HALF OF THE SAME GUARD: the `null`-beside-tickets rule
    // above is vacuous if no call site passes tickets at all. Exactly one does
    // today — the gallery on the guest page.
    expect(ticketCallSites).toBe(1)
  })
})

describe('what the server sends', () => {
  it('projects every ticket on the event, not the viewer\'s subset', () => {
    // THE MUTATION THIS CATCHES is the one the issue reverses: re-filtering the
    // list server-side by the viewer's RSVP ids, which is what the code did
    // before #37 and is one `.filter` away at all times. `scripts/api-smoke.sh`
    // executes that against a real database and a real invite token, which is
    // the proof that counts; this is the cheap structural half, red in 300ms.
    //
    // PINNED ON THE PROJECTION, not on the absence of a filter: "this file
    // contains no `.filter`" would fail on the gallery's and the documents'.
    const src = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const start = src.indexOf('export async function listMediaForViewer(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))

    // `ticketRows` is every ready ticket on the event; the list that goes out
    // is built from it and from nothing narrower.
    expect(body).toMatch(/const ticketRows = rows\.filter\(r => r\.type === 'ticket'\)/)
    expect(body).toMatch(/tickets: ticketRows\s*\n\s*\.map\(/)
    // AND THE VIEWER'S OWN IDS ARE USED FOR THE MARKER AND FOR NOTHING ELSE.
    // `mine` is the only thing `myRsvpIds` may decide — the moment it decides
    // membership of the list, the widening is gone and this is #36 again.
    const uses = [...body.matchAll(/myRsvpIds/g)].length
    expect(uses, 'myRsvpIds is read somewhere other than the `mine` marker').toBe(2)
    expect(body).toMatch(/mine: v\.assignedRsvpIds\.some\(id => myRsvpIds\.has\(id\)\)/)

    // …AND NOTHING NARROWS THE LIST AFTERWARDS. Counting `myRsvpIds` catches
    // the filter that reads the viewer's ids again and MISSES the cheaper one
    // that reads the marker this function just computed: `.filter(v => v.mine)`
    // on the end of the chain introduces no new `myRsvpIds`, restores exactly
    // the pre-#37 behaviour, and left all 446 tests green. So the `tickets:`
    // expression is asserted to contain no filter at all — scoped to that
    // expression, because `gallery` and `documents` legitimately filter by type
    // two lines above it.
    const projection = body.slice(body.indexOf('tickets: ticketRows'))
    expect(projection).not.toBe('')
    expect(projection, 'something narrows the ticket list after it is built').not.toMatch(/\.filter\(/)
  })
})
