import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tokensMatch } from '../server/utils/service-auth'
import { serviceCredentialStatus } from '../server/utils/enterprise-link'
import { ApiError, apiError, toErrorBody } from '../server/utils/api-v1'
import { eventSlugFromPath } from '../server/domain/audit'
import { bootstrapConfigured, bootstrapTokenMatches } from '../server/utils/passkey-bootstrap'

/**
 * The two surfaces must not be able to reach each other.
 *
 * zäme has three ways in and they are deliberately unrelated credentials:
 *
 *   1. the GUEST capability URL — `/api/invites/<token>/**`, where the link IS
 *      the credential and there is no account;
 *   2. the HOST magic-link session — `/api/host/**` and `/api/me/**`, gated by
 *      a better-auth cookie;
 *   3. the MACHINE service token — `/api/v1/**`, one caller (Enterprise), one
 *      shared secret, no cookies anywhere.
 *
 * A service token that worked on the guest surface would hand Enterprise the
 * whole guest population; a guest cookie that reached `/api/v1` would hand any
 * signed-in friend the owner's machine API. Neither can happen if the two never
 * share an authenticator — so this file asserts the SEPARATION STRUCTURALLY,
 * over the source, rather than trusting that nobody wires them together later.
 *
 * The runtime half of this proof — an actual magic-link session answered 401 on
 * `/api/v1`, an actual service token answered 401 on `/api/host` — is executed
 * by `scripts/api-smoke.sh` against a booted server with a real database.
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

const allHandlers = walk(API_ROOT).filter(f => f.endsWith('.ts'))
const rel = (f: string) => relative(ROOT, f).split(sep).join('/')

const machineHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/v1/'))
const guestHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/invites/'))
const hostHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/host/'))
const adminHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/admin/'))
const accountHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/me/'))

describe('the machine surface never touches the guest or host authenticator', () => {
  it('found the surfaces it is meant to be checking', () => {
    expect(machineHandlers.length).toBeGreaterThan(30)
    expect(guestHandlers.length).toBeGreaterThan(5)
    expect(hostHandlers.length).toBeGreaterThan(5)
  })

  it('no /api/v1 handler imports the better-auth session', () => {
    const offenders = machineHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /requireGuestUser|getGuestSession|utils\/auth/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/v1 handler reads a cookie', () => {
    const offenders = machineHandlers.filter(f => /getCookie|parseCookies|\bcookie\b/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('every /api/v1 handler checks the service token', () => {
    const offenders = machineHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      // `getHealth` is the ONE operation the contract marks `security: []`.
      if (rel(f) === 'server/api/v1/health.get.ts') return !/defineV1Handler/.test(src)
      // `getEventsSnapshot` cannot use the wrapper: that resolves the planner
      // from the database as part of authenticating, and the contract forbids
      // this operation to 5xx on a cold one. It checks the CREDENTIAL — which
      // needs no database — and degrades only the data.
      if (rel(f) === 'server/api/v1/snapshot.get.ts') return !/authenticateService\(event\)/.test(src)
      return !/defineServiceHandler/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])
  })

  it('the snapshot still answers 401/403 when the database is down', () => {
    // The credential half must be decidable without a database, or an outage
    // would turn every unauthenticated probe into a 200.
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    const credentialHalf = src.slice(src.indexOf('export function authenticateService'), src.indexOf('export async function requireServiceCaller'))
    expect(credentialHalf).toMatch(/tokensMatch/)
    expect(credentialHalf).not.toMatch(/resolveInstancePlanner|useDb|await/)
  })

  it('no guest, host or account handler imports the service token', () => {
    const offenders = [...guestHandlers, ...hostHandlers, ...accountHandlers].filter(f =>
      /service-auth|requireServiceCaller|ZAEME_SERVICE_TOKEN/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the service-token module itself never reaches for a session or a cookie', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    expect(src).not.toMatch(/getCookie|parseCookies|auth\.api|getGuestSession/)
  })

  it('exempts /api/v1 from the first-run setup redirect', () => {
    // Otherwise an un-set-up instance answers the machine API with a 302 to a
    // browser bootstrap page, which no HTTP client can act on.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).toContain('\'/api/v1/\'')
  })
})

/**
 * The ADMIN surface is the fourth thing that can be reached over HTTP, and it
 * deliberately introduces no fourth credential: it is the host session plus one
 * question — is this account the one that claimed the instance
 * (`server/utils/admin.ts`). Which makes two directions worth asserting.
 *
 * INWARD: nothing but the owner gets in. Not a guest holding a capability URL,
 * not a co-planner's session, and above all not Enterprise's service token —
 * the machine API is a PEER of this surface, not a way into it. A service token
 * that reached `/api/admin` would hand the XO the instance's accounts, every
 * live invite link and the audit of its own behaviour.
 *
 * OUTWARD: the owner gate stays out of everything else. If `/api/v1` could
 * import it, the machine surface would acquire an owner-scoped mode nobody
 * declared in the contract; if the host surface used it, planning would quietly
 * become owner-only.
 *
 * The runtime half of this is executed in `scripts/api-smoke.sh`, which signs
 * in as two real accounts and checks the owner is let in and the other is not.
 */
describe('the admin surface is the owner\'s, and only the owner\'s', () => {
  it('found the admin routes it is meant to be checking', () => {
    expect(adminHandlers.length).toBeGreaterThan(10)
  })

  it('every /api/admin handler goes through the owner gate', () => {
    const offenders = adminHandlers.filter(f => !/requireOwner\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/admin handler accepts the service token', () => {
    const offenders = adminHandlers.filter(f =>
      /service-auth|requireServiceCaller|authenticateService|ZAEME_SERVICE_TOKEN|authorization/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/admin handler accepts a capability token', () => {
    // A guest's invite URL is a bearer credential for ONE event. It is not an
    // identity, and nothing on this surface may treat it as one.
    const offenders = adminHandlers.filter(f => /getRouterParam\(\s*e[^)]*,\s*'token'\s*\)/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/v1 handler imports the owner gate', () => {
    const offenders = machineHandlers.filter(f => /utils\/admin|requireOwner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the owner gate is used by the admin surface and nowhere else', () => {
    const offenders = allHandlers
      .filter(f => !rel(f).startsWith('server/api/admin/'))
      .filter(f => /requireOwner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('does NOT exempt /api/admin from the first-run setup redirect', () => {
    // The inverse of the /api/v1 rule above, and for the opposite reason: an
    // instance nobody has claimed has no owner, so its admin surface must not
    // be reachable at all — it bounces to /setup like every other page.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).not.toMatch(/'\/api\/admin/)
  })

  it('never puts the Enterprise service token on an admin page', () => {
    // The integration page reports whether the credential is configured and a
    // fingerprint of it. Not the credential.
    process.env.ZAEME_SERVICE_TOKEN = 'hunter2-the-actual-secret'
    process.env.ZAEME_ENTERPRISE_OWNER_ID = 'ent_owner'
    const status = serviceCredentialStatus()
    expect(status.configured).toBe(true)
    expect(status.enterpriseOwnerId).toBe('ent_owner')
    expect(JSON.stringify(status)).not.toContain('hunter2')
    expect(status.fingerprint).toMatch(/^[0-9a-f]{12}$/)

    delete process.env.ZAEME_SERVICE_TOKEN
    expect(serviceCredentialStatus()).toMatchObject({ configured: false, fingerprint: null })
  })
})

/**
 * `/api/me/**` is the ACCOUNT surface: the host session, with no planner row
 * required. It has always held the cross-event aggregation; #48 moved expense
 * WRITES onto it, because the owner decided money is recorded against a person
 * rather than against whoever holds a link.
 *
 * That move is the reason this block exists, and it cuts in two directions.
 *
 * INWARD: everything here is a session, every time. A route that forgot
 * `requireGuestUser` would be an unauthenticated write to the budget, and a
 * route that accepted a capability token instead would put the link back in
 * charge of the money by the back door.
 *
 * OUTWARD — and this is the one the move could have broken — `/api/invites/**`
 * must stay exactly what it was: the link IS the credential, and no handler
 * there may read a session. Writing the expense gate INTO an invite handler is
 * the shortcut this file exists to refuse; the surfaces are separate on
 * purpose, so the guest page can still READ the budget over the link while the
 * write needs an account.
 *
 * The runtime half — an anonymous POST answered 401, a signed-in non-participant
 * answered 403 — is executed by `scripts/api-smoke.sh` against a real server.
 */
describe('the account surface is a session, and the invite link never becomes one', () => {
  const inviteExpenseWrites = guestHandlers.filter(f => /\/expenses\//.test(rel(f)))

  it('found the account routes it is meant to be checking', () => {
    expect(accountHandlers.length).toBeGreaterThan(1)
  })

  it('every /api/me handler requires a signed-in account', () => {
    const offenders = accountHandlers.filter(f => !/requireGuestUser\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/me handler accepts a capability token instead', () => {
    // `[slug]` on this surface names an EVENT; a `token` router param would be
    // an invite link being read as an identity, which it is not.
    const offenders = accountHandlers.filter(f => /getRouterParam\(\s*e[^)]*,\s*'token'\s*\)/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/invites handler reads a session', () => {
    // The whole point of the capability URL is that there is no account behind
    // it. A session check here would mean the link had quietly stopped being
    // sufficient for something it still appears to offer.
    const offenders = guestHandlers.filter(f =>
      /requireGuestUser|getGuestSession|utils\/auth|assertParticipant|assertPlanner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the invite link no longer writes an expense, and still reads the budget', () => {
    // #48: writes moved to /api/me/events/<slug>/expenses. Reading was NOT
    // narrowed — the guest page renders the budget for anybody holding the link.
    expect(inviteExpenseWrites.map(rel)).toEqual([])
    expect(existsSync(join(API_ROOT, 'invites', '[token]', 'budget.get.ts'))).toBe(true)

    const expensePost = join(API_ROOT, 'me', 'events', '[slug]', 'expenses', 'index.post.ts')
    const expenseDelete = join(API_ROOT, 'me', 'events', '[slug]', 'expenses', '[id].delete.ts')
    // #27 added a third verb to this surface, and it belongs in the same list:
    // an edit is a money write, so the reason it may not live under
    // `/api/invites/**` is the reason the other two may not.
    const expensePatch = join(API_ROOT, 'me', 'events', '[slug]', 'expenses', '[id].patch.ts')
    expect(existsSync(expensePost)).toBe(true)
    expect(existsSync(expenseDelete)).toBe(true)
    expect(existsSync(expensePatch)).toBe(true)
    for (const f of [expensePost, expenseDelete, expensePatch]) {
      expect(readFileSync(f, 'utf8')).toMatch(/AsParticipant/)
    }
  })

  it('the participant gate is decided in the domain, never in a handler', () => {
    // `assertParticipant` reads the database to answer "is this account on this
    // event". Like `assertPlanner`, it belongs beside the operation it guards,
    // so a route cannot accidentally call the write without it. Importing or
    // CALLING it is the offence — naming it in a comment, as the two expense
    // handlers do to say where their gate lives, is not.
    //
    // `assertMayWriteExpenses` is in the list because #28 EXPORTED it, so that
    // `server/domain/settlements.ts` could use the expense gate rather than a
    // second one shaped like it. Exported is reachable from a handler through
    // `#server/domain/index`, and a handler that called the gate and then a raw
    // domain function would have moved the decision back out of the domain by
    // the same door this rule closes for `assertParticipant`.
    const offenders = allHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /import[^\n]*\b(assertParticipant|assertMayWriteExpenses)\b/.test(src)
        || /\b(assertParticipant|assertMayWriteExpenses)\s*\(/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])

    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export async function assertParticipant/)
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/assertParticipant\(ev\.id, actor\.id\)/)
  })

  it('an expense write records the account that made it, not a typed-in email', () => {
    // The accountability the account gate buys is `created_by_user_id`. If a
    // write could still name its own author, the gate would have bought nothing.
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/createdByUserId: by\.userId\b/)
    expect(expenses).toMatch(/createdByGuestEmail: null/)
    expect(expenses).not.toMatch(/guestEmail\?:/)
  })

  it('the participant write path re-checks the event lifecycle', () => {
    // The `draft`/`cancelled` refusal used to come free with
    // `resolveInviteToken`. Moving the write off the token dropped it, and an
    // expense recorded happily against a CANCELLED trip. The rule is about the
    // event, not the link, so both paths call one guard.
    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export function assertEventOpenToGuests/)
    expect(permissions).toMatch(/'draft'.*'cancelled'/s)

    const invite = readFileSync(join(ROOT, 'server', 'domain', 'invite.ts'), 'utf8')
    expect(invite).toMatch(/assertEventOpenToGuests\(ev\)/)
    // …and the check exists in exactly one place, not two that can drift.
    expect(invite).not.toMatch(/status === 'draft'/)

    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/assertEventOpenToGuests\(ev\)/)
  })

  it('the two expense write gates agree about `logistics`', () => {
    // `addExpenseAsPlanner` refuses a logistics planner on the host surface. If
    // the participant surface accepted one, the same account would be 403'd on
    // /api/host and 200'd on /api/me for the same verb.
    //
    // This pins the ROLE SETS and nothing else. The two surfaces still differ on
    // the event LIFECYCLE on purpose — `assertEventOpenToGuests` is a guest-side
    // rule, so a co-planner may budget a draft trip on /api/host and /api/v1
    // while a participant may not on /api/me. That asymmetry is deliberate and
    // is named in #52; do not read this test as asserting the two gates agree
    // about everything.
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    const writers = /const EXPENSE_WRITERS[^=]*=\s*\[([^\]]*)\]/.exec(expenses)?.[1] ?? ''
    expect(writers).toMatch(/'participant'/)
    expect(writers).toMatch(/'owner'/)
    expect(writers).toMatch(/'co_planner'/)
    expect(writers).not.toMatch(/'logistics'/)

    const plannerGate = /assertPlanner\(ev\.id, userId, \{ roles: \[([^\]]*)\] \}\)/.exec(expenses)?.[1] ?? ''
    expect(plannerGate).toBe('\'owner\', \'co_planner\'')
  })

  it('the invite link can say a budget EXISTS without saying what is in it', () => {
    // Two different questions, and this line has already moved twice. Who may
    // WRITE is `viewer` + `lockedReason`; who may READ THE FIGURES is
    // `showAmounts`. Collapsing them renders the expense list, the balances and
    // the settlement plan to anybody a link was forwarded to — no new
    // capability (the budget was always in the payload and `GET
    // /api/invites/[token]/budget` was always open) but a change in what the
    // page says by default to somebody who has typed nothing.
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/showAmounts: boolean/)
    // Required, not optional: a new caller has to decide rather than inherit.
    expect(card).not.toMatch(/showAmounts\?:/)

    const template = /<template>([\s\S]*)<\/template>\s*$/.exec(card)?.[1] ?? ''
    expect(template).toMatch(/<template v-if="showAmounts">/)
    // The running total is a figure too, and it lives outside that block.
    expect(template).toMatch(/v-if="showAmounts"[\s\S]{0,200}budget\.totalCents/)

    // …and the guest page keeps the figures exactly where they were before #48:
    // behind an identified visitor, never behind the mere presence of a link.
    const invitePage = readFileSync(join(ROOT, 'app', 'pages', 'i', '[token].vue'), 'utf8')
    expect(invitePage).toMatch(/:show-amounts="complete \|\| !!account"/)
  })

  it('the expense form sends the split and the rate ONLY when somebody touched them', () => {
    // #27 review, and this is the one thing no smoke check in this repository
    // can see. `scripts/api-smoke.sh` composes its own bodies, so it pins what
    // the SERVER does with the shape the form currently sends; nothing there
    // notices if the form goes back to sending a different one. It did exactly
    // that twice:
    //
    //  - `splitMode` + `participants` on EVERY correction took the "replace the
    //    split" path, so correcting the TITLE of an `even` expense with amounts
    //    pinned by hand re-split it evenly and moved money between people —
    //    40.00/30.00/30.00 became 33.34/33.33/33.33 with a success toast, and
    //    this ledger keeps no history to recover it from.
    //  - the prefilled `fxRate` on every correction relabelled a `fetched` row
    //    `manual`, which is the claim that a person checked the figure against a
    //    bank statement (#71), and on an amount correction resent the OLD stated
    //    total beside the NEW receipt.
    //
    // Pinned on the CALL SITE rather than by grepping the file for a word: the
    // word appears in the comments that explain it.
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/\.\.\.\(!editing \|\| splitTouched\.value\s*\n?\s*\? \{ splitMode: splitMode\.value, participants: splitParticipantsBody\(\) \}/)
    expect(card).toMatch(/&& \(!editing \|\| fxRateTouched\.value \|\| currencyChanged\.value\)/)
    expect(card).toMatch(/&& \(!editing \|\| paidAmountTouched\.value \|\| currencyChanged\.value\)/)

    // And the two predicates are about what the FORM put there, not about
    // whether the field is empty: a prefill is not a statement.
    expect(card).toMatch(/const fxRateTouched = computed\(\(\) => fxRate\.value\.trim\(\) !== fxRatePrefilled\.value\.trim\(\)\)/)
    expect(card).toMatch(/fxRatePrefilled\.value = q\.rate/)
  })

  it('the form and the server ask ONE function whether an even split was pinned', () => {
    // The rule that decides whether a recorded `even` split can be re-split at a
    // new total. The server refuses when it cannot; the form has to reach the
    // same answer one step earlier to hand the amounts back. Two copies agreeing
    // today and drifting tomorrow would mean one side re-splitting an expense
    // the other says cannot be re-split, which moves money — so it lives in
    // `shared/`, which Nuxt auto-imports into both.
    const shared = readFileSync(join(ROOT, 'shared', 'utils', 'even-split.ts'), 'utf8')
    expect(shared).toMatch(/export function isPlainEvenSplit/)

    const domain = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(domain).toMatch(/import \{ isPlainEvenSplit, splitEvenlyCents \} from '\.\.\/\.\.\/shared\/utils\/even-split'/)
    expect(domain).toMatch(/isPlainEvenSplit\(shares\.map\(s => s\.amountCents\), previousAmountCents\)/)
    // Neither side may keep its own copy of the arithmetic.
    expect(domain).not.toMatch(/function splitEvenlyCents/)
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/isPlainEvenSplit\(was\.shares\.map\(s => s\.amountCents\), was\.amountCents\)/)
    expect(card).not.toMatch(/function splitEvenlyCents/)
  })

  it('attaching a receipt is an expense write, on both expense surfaces (#29)', () => {
    // #29 draws its credential line through the middle of one action:
    // UPLOADING a photo stays the invite link's (anyone on the event may add to
    // the gallery, unchanged), PINNING one to an expense is money and needs the
    // account. So the pin lives beside the other three expense verbs, on both
    // surfaces that carry them, and nowhere near `/api/invites/**`.
    for (const surface of [['me', 'AsParticipant'], ['host', 'AsPlanner']] as const) {
      const put = join(API_ROOT, surface[0], 'events', '[slug]', 'expenses', '[id]', 'receipt.put.ts')
      const del = join(API_ROOT, surface[0], 'events', '[slug]', 'expenses', '[id]', 'receipt.delete.ts')
      expect(existsSync(put), put).toBe(true)
      expect(existsSync(del), del).toBe(true)
      for (const f of [put, del]) {
        const src = readFileSync(f, 'utf8')
        expect(src, f).toMatch(/requireGuestUser\(/)
        expect(src, f).toMatch(new RegExp(`ReceiptAs${surface[1].slice(2)}`))
      }
    }
    // …and the invite surface gained no receipt route at all, which the generic
    // "no /api/invites handler reads a session" rule above cannot say: a pin
    // route there would be a session check inside the capability URL.
    expect(guestHandlers.filter(f => /receipt/i.test(rel(f))).map(rel)).toEqual([])
  })

  it('the pin carries ONE field and never rides in the edit form\'s body (#29)', () => {
    // The rule #27 and #71 were both broken by, applied one issue later. The
    // body `saveExpense` composes carries exactly the fields somebody TOUCHED,
    // and a receipt is the strongest evidence there is — so if it travelled in
    // that body, every correction of an expense would restate it, and the next
    // person to add a field beside it would have a precedent for doing the
    // same. It is a separate request on a separate endpoint, fired from its own
    // click, and it sends `mediaId` and nothing else.
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')

    //
    // PINNED ON THE ENDPOINT AND THE STATE, never on the word: `receipt` means
    // two different things in this file — the paper somebody photographed, and
    // the foreign-currency amount an expense was recorded FROM — and the second
    // is discussed at length inside `saveExpense`. A grep for the word would
    // fail on a comment and pass on a body field called `photo`.
    const save = card.slice(card.indexOf('async function saveExpense()'), card.indexOf('/* ---- changing what this trip settles in'))
    expect(save).not.toBe('')
    expect(save).not.toMatch(/mediaId/)
    expect(save).not.toMatch(/\/receipt`/)
    expect(save).not.toMatch(/receiptUploadBase|receiptBusy|receiptFor/)

    // The pin's own call site: PUT to the expense's receipt, body `{ mediaId }`.
    expect(card).toMatch(/\$fetch<\{ budget: Budget \}>\(`\$\{props\.expensesBase\}\/\$\{expenseId\}\/receipt`, \{\s*\n?\s*method: 'PUT',\s*\n?\s*body: \{ mediaId \}/)
    expect(card).toMatch(/`\$\{props\.expensesBase\}\/\$\{x\.id\}\/receipt`, \{ method: 'DELETE' \}/)

    // The upload CONFIRMS before it pins. A `pending` row is an upload that may
    // never land and the server refuses to pin one; the other order would point
    // an expense at bytes that are not there.
    const attach = card.slice(card.indexOf('async function onReceiptFile'), card.indexOf('async function detachReceipt'))
    expect(attach.indexOf('/confirm')).toBeGreaterThan(-1)
    expect(attach.indexOf('/receipt`')).toBeGreaterThan(attach.indexOf('/confirm'))
  })

  it('pinning a receipt relabels nothing about the money (#29, #71)', () => {
    // `fxRateSource: 'manual'` and the stated pair mean a PERSON stated a
    // figure and checked it against a statement. A photograph is evidence a
    // reader can look at; the instance may not upgrade one into the other on
    // the uploader's behalf. So the pin writes to `events_media` and to nothing
    // else — not even `events_expense.updated_at`.
    const media = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const pin = media.slice(media.indexOf('export async function pinReceipt'), media.indexOf('export async function unpinReceipt'))
    expect(pin).not.toBe('')
    expect(pin).not.toMatch(/fxRate|statedAmountCents|statedCurrency/)
    // Every UPDATE in it is against the media table.
    const updates = pin.match(/\.update\(tables\.(\w+)\)/g) ?? []
    expect(updates.length).toBeGreaterThan(0)
    expect([...new Set(updates)]).toEqual(['.update(tables.media)'])

    // …and a ticket may not be one. A ticket is visible to the attendee it
    // belongs to and to planners; a receipt travels in a budget the whole event
    // can read, so pinning one would publish it through a side door.
    expect(media).toMatch(/export const RECEIPT_TYPES: readonly MediaType\[\] = \['photo', 'document'\]/)
  })

  it('two people pinning to one expense queue on a row that EXISTS (#29 review)', () => {
    // A TRANSACTION IS NOT A LOCK. Under READ COMMITTED the clear —
    // `update events_media set expense_id = null where expense_id = <this one>`
    // — matches no rows in the rival transaction's snapshot, because its row is
    // still NULL as committed, so it takes no lock and both claimants go on to
    // set their own. One expense, two receipts: the thumbnail flips between
    // reads and `/api/v1` listMedia reports two items with the same
    // `expenseId`. Reproduced on Postgres 16 with two sessions.
    //
    // WHAT THIS TEST IS AND IS NOT. It pins the MECHANISM — the lock is taken,
    // inside the transaction, on the expense, before the clear — and it would
    // go red if somebody removed it. It does not execute the interleaving:
    // that needs two connections to a real database, and `pnpm test` has none.
    // The interleaving was run by hand, both ways, and is reported in the PR.
    const media = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const pin = media.slice(media.indexOf('export async function pinReceipt'), media.indexOf('export async function unpinReceipt'))

    const lock = pin.indexOf('.for(\'update\')')
    const txn = pin.indexOf('db.transaction(')
    const clear = pin.indexOf('set({ expenseId: null })')
    expect(lock).toBeGreaterThan(-1)
    // Inside the transaction — a lock taken before `BEGIN` is released at once.
    expect(lock).toBeGreaterThan(txn)
    // …and before the clear it exists to serialise.
    expect(clear).toBeGreaterThan(lock)
    // On the row both claimants can see. `events_media` is the row that is NOT
    // in the rival's snapshot, which is the whole reason locking it fails.
    const locked = /\.from\(tables\.(\w+)\)[\s\S]{0,240}?\.for\('update'\)/.exec(pin)?.[1]
    expect(locked).toBe('expense')
  })

  it('every human handler that answers with a budget signs its receipts (#29)', () => {
    // `loadBudget` hands back a storage KEY; a media URL in this app is signed
    // and expires, always. A thumbnail missing from one budget handler is a bug
    // nobody notices for a release — so the rule is asserted over the route
    // tree rather than remembered.
    //
    // THE SET IS WORKED OUT FROM THE DOMAIN, TRANSITIVELY, and that is not
    // fussiness. The first version of this test read each handler's own source
    // for the word `budget`, and it passed while `GET /api/invites/{token}`
    // served every receipt on the guest page unsigned: that handler is one line
    // (`return getInvitePage(token)`) and the budget is nested three levels down
    // inside what it returns. A rule a handler can satisfy by not mentioning the
    // thing it returns is not a rule. So: start at `loadBudget`, close over
    // every exported domain function that calls something already in the set,
    // and require any human-surface handler that calls one to sign.
    //
    // BOTH SPELLINGS OF AN EXPORTED FUNCTION. `export function f` was the only
    // one this matched at first, which left `export const f = async () => …`
    // invisible — and a `/api/me` handler returning an unsigned budget through
    // one passed all 61 tests in this file. Every domain function is written the
    // first way today; the rule must not depend on that staying true.
    //
    // `readdirSync` is not recursive. `server/domain` is FLAT — no
    // subdirectories — so this reads all of it; a domain that grows a folder
    // needs this made recursive, or the closure silently stops at its edge.
    const DOMAIN = join(ROOT, 'server', 'domain')
    expect(readdirSync(DOMAIN, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)).toEqual([])
    const bodies = new Map<string, string>()
    for (const file of readdirSync(DOMAIN).filter(f => f.endsWith('.ts'))) {
      const src = readFileSync(join(DOMAIN, file), 'utf8')
      const marks: Array<[string, number]> = []
      const re = /^export (?:async )?function (\w+)|^export const (\w+)\s*=/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) marks.push([(m[1] ?? m[2])!, m.index])
      marks.forEach(([name, at], i) => {
        bodies.set(name, src.slice(at, i + 1 < marks.length ? marks[i + 1]![1] : src.length))
      })
    }
    const producers = new Set(['loadBudget'])
    for (let pass = 0; pass < 8; pass++) {
      for (const [name, body] of bodies) {
        if (producers.has(name)) continue
        const reaches = [...producers].some(p => new RegExp(`\\b${p}\\(`).test(body))
        if (reaches) producers.add(name)
      }
    }
    // The closure found the indirect ones, which is the whole point of it.
    expect([...producers]).toContain('getInvitePage')
    expect([...producers]).toContain('guestLoadBudget')
    expect([...producers]).toContain('attachReceiptAsParticipant')
    // …and did not swallow the whole domain: a delete answers `{removed:true}`.
    expect([...producers]).not.toContain('removeExpenseAsPlanner')

    // EVERY HUMAN SURFACE, and `adminHandlers` is one of them. It was left out
    // of this list on the grounds that no admin route answers with a budget —
    // which is true today and is not a rule. `server/domain/admin.ts` is where
    // cross-event reads are supposed to go, so an owner-facing money view is a
    // plausible next issue, and it would have shipped unsigned.
    const answersWithABudget = [...guestHandlers, ...hostHandlers, ...accountHandlers, ...adminHandlers].filter((f) => {
      const src = readFileSync(f, 'utf8')
      return [...producers].some(p => new RegExp(`\\b${p}\\s*\\(`).test(src))
    })
    // The floor is what exists now: a fourteenth is welcome, one going quietly
    // unsigned is not.
    expect(answersWithABudget.length).toBeGreaterThanOrEqual(13)
    const unsigned = answersWithABudget.filter(f => !/signBudgetReceipts\(/.test(readFileSync(f, 'utf8')))
    expect(unsigned.map(rel)).toEqual([])
  })

  it('no signed receipt URL crosses the machine boundary (#29)', () => {
    // `server/api/v1/events/[slug]/media.get.ts` already says it: metadata
    // only, the bytes live in zäme and are served to guests there. A budget is
    // not an exception to that, so the /api/v1 projection drops the field
    // whole rather than handing Enterprise a signed URL it has no use for and
    // could log.
    const shapes = readFileSync(join(ROOT, 'server', 'utils', 'v1-shapes.ts'), 'utf8')
    const expenseStart = shapes.indexOf('export function expense(row: object)')
    const expenseShape = shapes.slice(expenseStart, shapes.indexOf('\n}\n', expenseStart))
    expect(expenseShape).not.toBe('')
    expect(expenseShape).toMatch(/fxRateSource: r\.fxRateSource/)
    expect(expenseShape).not.toMatch(/receipt/)
    // The additive half that DOES cross: the media item says which expense it
    // is the receipt for — an id, not a URL.
    expect(shapes).toMatch(/expenseId: r\.expenseId \?\? null/)

    const offenders = machineHandlers.filter(f => /media-sign|signBudgetReceipts|signMediaItems/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('records the account surface in the audit, like every other human one', () => {
    const middleware = readFileSync(join(ROOT, 'server', 'middleware', 'audit.ts'), 'utf8')
    expect(middleware).toMatch(/'\/api\/me\/'/)
    expect(eventSlugFromPath('/api/me/events/lugano-weekend/expenses')).toBe('lugano-weekend')
  })
})

/**
 * SETTLING UP (#28) is a money write, and it is written as an ENTRY.
 *
 * Two things can go wrong here that nothing else in this file would catch, and
 * both of them move money quietly:
 *
 *   1. the write lands on the wrong credential. Recording "Ana paid Matthew
 *      300" is a claim about a person's money, so it needs an account exactly
 *      as an expense does (#48) — not the invite link, and not a fourth gate
 *      shaped like the expense gate but subtly wider;
 *   2. a transfer acquires a category. The trip total is the sum of debits into
 *      category accounts, so a settlement is excluded from it BY ITS SHAPE. Give
 *      one a category line and CHF 300 handed over to clear a debt is counted as
 *      CHF 300 spent on something, with no error anywhere.
 */
describe('a settlement is an entry, on the same credential and with no category', () => {
  it('lives on both money surfaces and nowhere near the invite link', () => {
    for (const surface of [['me', 'AsParticipant'], ['host', 'AsPlanner']] as const) {
      const post = join(API_ROOT, surface[0], 'events', '[slug]', 'settlements', 'index.post.ts')
      const del = join(API_ROOT, surface[0], 'events', '[slug]', 'settlements', '[id].delete.ts')
      expect(existsSync(post), post).toBe(true)
      expect(existsSync(del), del).toBe(true)
      // PER VERB, and that is not pedantry (#74 review): `toMatch(/SettlementAsPlanner/)`
      // over both files is satisfied by `recordSettlementAsPlanner` in the
      // DELETE handler just as well as by `removeSettlementAsPlanner`, so it
      // cannot tell the two apart — and `removeSettlementAsPlanner(userId, slug,
      // settlementId)` is three interchangeable strings, which no type can.
      // What proves the host DELETE is wired to the right function is the smoke
      // block executing it; this stops the pair from being swapped silently.
      expect(readFileSync(post, 'utf8'), post).toMatch(new RegExp(`recordSettlementAs${surface[1].slice(2)}\\(`))
      expect(readFileSync(del, 'utf8'), del).toMatch(new RegExp(`removeSettlementAs${surface[1].slice(2)}\\(`))
      for (const f of [post, del]) {
        expect(readFileSync(f, 'utf8'), f).toMatch(/requireGuestUser\(/)
      }
    }
    // The capability URL gained nothing: a settlement written over a forwarded
    // link would be money moved by whoever has the link, which is the whole of
    // what #48 took away.
    expect(guestHandlers.filter(f => /settlement/i.test(rel(f))).map(rel)).toEqual([])
    // …and so did the machine surface. Adding a verb to /api/v1 is the owner's
    // decision (#8) and this issue asked for the participant gate; Enterprise
    // can read settlements in the budget it already fetches.
    expect(machineHandlers.filter(f => /settlement/i.test(rel(f))).map(rel)).toEqual([])
  })

  it('reuses the expense gate rather than growing a second one', () => {
    // Two gates answering one verb is how a role restriction stops meaning
    // anything — #48 shipped exactly that, with `logistics` 403'd on one
    // surface and 200'd on the other. Recording a payment is a write on the
    // same ledger, so it asks the SAME function, imported, and the role set
    // above (`EXPENSE_WRITERS`) is the only one there is.
    const settlements = readFileSync(join(ROOT, 'server', 'domain', 'settlements.ts'), 'utf8')
    expect(settlements).toMatch(/import \{[\s\S]*assertMayWriteExpenses[\s\S]*\} from '\.\/expenses'/)
    expect(settlements).toMatch(/await assertMayWriteExpenses\(slug, actor\)/)
    // No second role list, and no second call to the participant gate that
    // could answer a different question from the one the expense writes ask.
    expect(settlements).not.toMatch(/assertParticipant/)
    expect(settlements).not.toMatch(/WRITERS\s*[:=]/)
    // The host half matches `addExpenseAsPlanner` exactly, `logistics` included.
    const plannerGate = /assertPlanner\(ev\.id, userId, \{ roles: \[([^\]]*)\] \}\)/.exec(settlements)?.[1] ?? ''
    expect(plannerGate).toBe('\'owner\', \'co_planner\'')
  })

  it('is written through the expense write path, not a second one', () => {
    // The issue's own words: "It fills one share; do not build a second write
    // path." One transaction writes every entry on this ledger, so the event
    // lock, the conversion, `buildEntryLines` and `assertEntryBalances` cannot
    // be true of an expense and false of a settlement.
    const settlements = readFileSync(join(ROOT, 'server', 'domain', 'settlements.ts'), 'utf8')
    expect(settlements).toMatch(/\}, by, 'transfer'\)/)
    for (const forbidden of [/db\.transaction\(/, /buildEntryLines\(/, /assertEntryBalances\(/, /apportionCents\(/, /convertCents\(/]) {
      expect(settlements).not.toMatch(forbidden)
    }
    // …and the destination is a PARAMETER, never a column: a stored `kind`
    // could disagree with the lines beside it, and the shape cannot.
    const schema = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
    expect(schema).not.toMatch(/'settlement'/)
    const table = schema.slice(schema.indexOf('export const expense = pgTable'))
    const expenseTable = table.slice(0, table.indexOf('pgTable', 40))
    expect(expenseTable).toMatch(/'events_expense'/)
    expect(expenseTable).not.toMatch(/\bkind:/)
  })

  it('never lets a transfer become a cost, or anything else it is not', () => {
    // On the server: an edit may correct a mistyped settlement like any other
    // entry, but every field that would change what it IS is refused (#74
    // review). A transfer is a SHAPE — one credit, one debit, no category — and
    // each of these breaks a different part of it: a category makes a payment a
    // cost, a second participant debits three people for a payment one person
    // made (and takes the base column out of reach of `assertEntryBalances`,
    // which cannot see a header disagreeing with the lines when there is no
    // category line), a split mode records an intention nobody had, and a typed
    // title would be discarded silently because the title is derived.
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    const guard = expenses.slice(
      expenses.indexOf('if (recordedCategory === null) {'),
      expenses.indexOf('const splitMode = input.splitMode ?? row.splitMode')
    )
    expect(guard).not.toBe('')
    expect(guard).toMatch(/input\.accountId !== undefined \|\| input\.category !== undefined/)
    expect(guard).toMatch(/input\.participants !== undefined && input\.participants\.length !== 1/)
    expect(guard).toMatch(/input\.splitMode !== undefined/)
    expect(guard).toMatch(/input\.title !== undefined/)
    // …and the shape it protects is ASSERTED before the write, not assumed.
    expect(expenses).toMatch(/recordedCategory === null && resolved\.length !== 1/)
    // The title is derived on the edit path as well as the write path, from the
    // one rule, so it cannot go on naming a pair that has been corrected.
    expect(expenses).toMatch(/settlementTitle\(paidByName, resolved\[0\]!\.name\)/)
    expect(expenses).not.toMatch(/title: input\.title \?\? row\.title/)
    // The weaker invariant is written down where somebody widening the guard
    // would read it, rather than left to be rediscovered.
    const build = expenses.slice(expenses.indexOf('export function buildEntryLines'), expenses.indexOf('export function assertEntryBalances'))
    expect(build).toMatch(/ZERO-SUM CHECK IS WEAKER ON A TRANSFER/)
    // On the screen: the ✎ that composes that PATCH iterates `costs`, which is
    // the list settlements are not in, and the payment form sends no category,
    // no account and no split at all — four fields and a note.
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/const costs = computed\(\(\) => props\.budget\.expenses\.filter\(x => !isSettlement\(x\)\)\)/)
    expect(card).toMatch(/v-for="x in costs"/)
    const save = card.slice(card.indexOf('async function saveSettlement()'), card.indexOf('async function removeSettlement('))
    expect(save).not.toBe('')
    expect(save).toMatch(/fromName: from\.name/)
    expect(save).toMatch(/amountCents: settleCents\.value/)
    for (const forbidden of [/accountId/, /category/, /splitMode/, /participants/, /fxRate/]) {
      expect(save).not.toMatch(forbidden)
    }
  })

  it('the form and the server tell the two apart by ONE rule', () => {
    // Same shape as `isPlainEvenSplit` above. The screen has to decide which
    // entries are payments to render them apart and to keep them out of the
    // edit form; the server decides it by writing no category line. A second
    // copy of the predicate in the card would agree until somebody changed one
    // of them, after which a settlement renders as an expense and the ✎ beside
    // it moves CHF 300 into the trip total.
    const shared = readFileSync(join(ROOT, 'shared', 'utils', 'settlement.ts'), 'utf8')
    expect(shared).toMatch(/export function isSettlement/)
    // The name a transfer carries is part of the same rule, and BOTH writes ask
    // for it here — the record and the correction — so the one place it is made
    // is the one place it can be got wrong.
    expect(shared).toMatch(/export function settlementTitle/)
    for (const f of ['settlements.ts', 'expenses.ts']) {
      const src = readFileSync(join(ROOT, 'server', 'domain', f), 'utf8')
      expect(src, f).toMatch(/import \{ settlementTitle \} from '\.\.\/\.\.\/shared\/utils\/settlement'/)
      expect(src, f).not.toMatch(/function settlementTitle/)
    }
    // ABSENT IS NOT NULL: a payload without the field reads as a cost, or a
    // budget from a client that dropped it renders as nothing but payments.
    expect(shared).toMatch(/entry\.categoryAccountId === null/)

    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/isSettlement\(x\)/)
    expect(card).not.toMatch(/categoryAccountId === null/)
  })
})

describe('the audit records every surface, and reads no cookie near /api/v1', () => {
  const middleware = readFileSync(join(ROOT, 'server', 'middleware', 'audit.ts'), 'utf8')

  it('bails out of the machine surface before it resolves a session', () => {
    // The edge recorder is the ONE place that may resolve a session for a
    // mutating request; if it did so for /api/v1 it would put a cookie read on
    // the machine surface's path, which is exactly what the boundary forbids.
    const guard = middleware.indexOf('path.startsWith(\'/api/v1\')')
    const session = middleware.indexOf('getGuestSession(event)')
    expect(guard).toBeGreaterThan(-1)
    expect(session).toBeGreaterThan(guard)
  })

  it('never records the auth routes, where magic-link tokens travel', () => {
    expect(middleware).toMatch(/\/api\/auth/)
  })

  /**
   * Every value `actor_kind` can hold, read out of the schema rather than
   * retyped — the point of the check is that three other places agree with it.
   */
  const ACTOR_KINDS = (() => {
    const schema = readFileSync(join(ROOT, 'server', 'database', 'schema', 'audit.ts'), 'utf8')
    const list = /actorKind: text\('actor_kind', \{ enum: \[([^\]]*)\]/.exec(schema)?.[1] ?? ''
    return list.split(',').map(v => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
  })()

  it('tells a planner from a participant on the account surface', () => {
    // #51: every non-owner session used to be filed as `planner`, which was
    // true only while every session-bearing surface was /api/host. Expense
    // writes moved to /api/me (#48) and a friend on a trip is not a planner.
    expect(ACTOR_KINDS).toContain('participant')
    expect(middleware).toMatch(/findPlannerRoleBySlug/)
    // …and it is the EVENT IN THE PATH that is asked about, not the surface.
    expect(middleware).toMatch(/eventSlugFromPath\(path\)/)
  })

  it('asks that question on /api/me only, and never on the machine surface', () => {
    // /api/host and /api/admin have already asserted a planner row by the time
    // a handler runs, so paying for the lookup there would buy nothing.
    expect(middleware).toMatch(/surface !== 'me'/)
    // The per-request lookup must stay behind the /api/v1 bail-out like
    // everything else here: it reaches the database on a session's behalf, so
    // its CALL SITE (the helper is declared above the handler) comes after the
    // guard and after the session it is resolving for.
    const call = middleware.indexOf('resolveSessionActorKind(match.surface')
    expect(call).toBeGreaterThan(middleware.indexOf('path.startsWith(\'/api/v1\')'))
    expect(call).toBeGreaterThan(middleware.indexOf('getGuestSession(event)'))
  })

  it('does not let a logistics planner row outrank the handler that refused it', () => {
    // `assertParticipant` deliberately does not count `logistics` as planner
    // standing, and the host surface refuses it an expense write. If the audit
    // counted it, the log would call the caller a planner for the very request
    // the handler answered as a participant — or refused outright.
    expect(middleware).toMatch(/role !== 'logistics'/)
    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export async function findPlannerRoleBySlug/)
    // …and the lookup must hand the ROLE back rather than a boolean, or the
    // exclusion above has nothing to test.
    expect(permissions).toMatch(/findPlannerRoleBySlug\([^)]*\): Promise<PlannerRole \| null>/)
  })

  it('never calls a session a participant of an event the path does not name', () => {
    // There is no mutating /api/me route without a slug today. The day one
    // arrives (`PATCH /api/me/profile`), `participant` would be a claim about
    // an event that is not in the request.
    expect(ACTOR_KINDS).toContain('account')
    expect(middleware).toMatch(/if \(!slug\) return 'account'/)
  })

  it('the admin filter and the audit page know every kind there is', () => {
    // A kind missing from any of the three is a category the owner silently
    // cannot see, or one that silently wears somebody else's badge.
    const route = readFileSync(join(ROOT, 'server', 'api', 'admin', 'audit', 'index.get.ts'), 'utf8')
    for (const kind of ACTOR_KINDS) expect(route).toContain(`'${kind}'`)

    const page = readFileSync(join(ROOT, 'app', 'pages', 'admin', 'audit.vue'), 'utf8')
    const items = /const ACTOR_ITEMS = \[([\s\S]*?)\n\]/.exec(page)?.[1] ?? ''
    for (const kind of ACTOR_KINDS) expect(items).toContain(`value: '${kind}'`)

    // The badge map falls back to `primary`, which is the PLANNER's colour — so
    // a kind missing here reads as a planner at a glance, which is the exact
    // failure this whole change exists to fix.
    const colors = /const ACTOR_COLORS[^=]*= \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ''
    expect(colors).not.toBe('')
    for (const kind of ACTOR_KINDS) expect(colors).toContain(`${kind}:`)
  })

  it('the machine surface audits itself, from its own credential', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    expect(src).toMatch(/recordAudit/)
    // …and still without ever looking at a session or a cookie.
    expect(src).not.toMatch(/getCookie|parseCookies|auth\.api|getGuestSession/)
  })

  it('pins an action to the event it touched', () => {
    expect(eventSlugFromPath('/api/host/events/movie-night/status')).toBe('movie-night')
    expect(eventSlugFromPath('/api/v1/events/lugano-weekend/invites')).toBe('lugano-weekend')
    expect(eventSlugFromPath('/api/admin/invites/abc/revoke')).toBeNull()
    expect(eventSlugFromPath('/api/me/invites')).toBeNull()
  })
})

describe('the service token is compared in constant time', () => {
  it('accepts only the exact token', () => {
    expect(tokensMatch('correct-horse', 'correct-horse')).toBe(true)
    expect(tokensMatch('correct-hors', 'correct-horse')).toBe(false)
    expect(tokensMatch('correct-horsf', 'correct-horse')).toBe(false)
    expect(tokensMatch('Correct-Horse', 'correct-horse')).toBe(false)
  })

  it('rejects a missing token exactly as it rejects a wrong one', () => {
    expect(tokensMatch(null, 'correct-horse')).toBe(false)
    expect(tokensMatch('', 'correct-horse')).toBe(false)
  })

  it('rejects everything when no token is configured — including the empty one', () => {
    expect(tokensMatch(null, undefined)).toBe(false)
    expect(tokensMatch('', undefined)).toBe(false)
    expect(tokensMatch('anything', undefined)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
    expect(tokensMatch('anything', '')).toBe(false)
  })

  it('never throws on a length mismatch (which would itself be a length oracle)', () => {
    expect(() => tokensMatch('a', 'a-very-much-longer-secret-indeed')).not.toThrow()
    expect(tokensMatch('a', 'a-very-much-longer-secret-indeed')).toBe(false)
  })
})

describe('every failure leaves as the contract\'s error envelope', () => {
  it('carries the machine code, the message and a request id', () => {
    const { status, body } = toErrorBody(apiError(403, 'forbidden', 'Nope.'), 'req_1')
    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'forbidden', message: 'Nope.' }, requestId: 'req_1' })
  })

  it('carries details when there are any', () => {
    const err = new ApiError(409, 'invalid_transition', 'No.', { from: 'published', to: 'polling' })
    const { body } = toErrorBody(err, 'req_2')
    expect(body.error.details).toEqual({ from: 'published', to: 'polling' })
  })

  it('never leaks an unexpected exception\'s text to the caller', () => {
    const { status, body } = toErrorBody(new Error('DATABASE_URL=postgres://user:hunter2@db/x'), 'req_3')
    expect(status).toBe(500)
    expect(body.error.code).toBe('internal')
    expect(body.error.message).not.toMatch(/hunter2/)
  })
})

/**
 * PASSKEYS add a second SIGN-IN METHOD, and deliberately not a fourth
 * credential. What comes out of `signIn.passkey` is the same better-auth
 * session cookie a magic link produces, on the same account — so `requireOwner`,
 * `requireGuestUser` and the audit never learn a second shape, and none of the
 * separations above move.
 *
 * The one genuinely new thing is registration WITHOUT a session
 * (`server/utils/passkey-bootstrap.ts`), which exists because an instance whose
 * mail transport is not configured cannot be signed in to at all. That is a
 * door, so this block asserts where it is and where it is not.
 */
describe('passkeys are a second way in, not a second credential', () => {
  const bootstrap = readFileSync(join(ROOT, 'server', 'utils', 'passkey-bootstrap.ts'), 'utf8')

  it('nothing but the auth instance can GRANT a bootstrap registration', () => {
    // `resolveBootstrapUser` is the function that turns an opaque context into
    // an account. It belongs to better-auth's registration path and to nothing
    // else — a route handler calling it would be a second, unreviewed door.
    //
    // Two routes DO import `bootstrapConfigured`, and that is a different
    // thing: a boolean saying a token is installed, which is what points a
    // locked-out owner at /setup/recover. It grants nothing and reveals no
    // value.
    const offenders = allHandlers.filter(f => /resolveBootstrapUser|bootstrapTokenMatches/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])

    expect(readFileSync(join(ROOT, 'server', 'utils', 'auth.ts'), 'utf8')).toMatch(/resolveBootstrapUser/)
  })

  it('no /api/v1 handler mentions passkeys at all', () => {
    // The machine surface is a shared secret in a header. A WebAuthn ceremony
    // needs a browser, so anything of it near /api/v1 is a mistake.
    const offenders = machineHandlers.filter(f => /passkey|webauthn/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the break-glass compares in constant time and is off by default', () => {
    expect(bootstrap).toMatch(/timingSafeEqual/)
    // Both sides hashed to a fixed length first, so the comparison never throws
    // on a length mismatch — a throw is itself a length oracle.
    expect(bootstrap).toMatch(/createHash\('sha256'\)/)
    expect(bootstrapTokenMatches('anything')).toBe(false)
  })

  it('the break-glass resolves the owner, never an arbitrary account', () => {
    // The token buys a passkey on the account that claimed this instance. If it
    // could name an account, it would be a login as anybody — so the recovery
    // path reads its identity from the database and the browser's `name` and
    // `email` reach exactly one place: creating the FIRST account on an
    // instance that has none. `test/passkey-bootstrap.test.ts` executes both.
    expect(bootstrap).toMatch(/resolveInstanceOwnerId/)
    expect(bootstrap).toMatch(/const owner = await loadOwner\(\)/)

    const usesBrowserIdentity = bootstrap.split('\n').filter(l => /parsed\.(name|email)!/.test(l))
    expect(usesBrowserIdentity).toHaveLength(2)
    for (const line of usesBrowserIdentity) {
      expect(line).toMatch(/claimInstance|displayName: parsed\.name!/)
    }
  })

  it('records every use of the break-glass, granted or refused', () => {
    const uses = bootstrap.match(/recordAudit\(/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(3)
    expect(bootstrap).toMatch(/outcome: 'refused'/)
    expect(bootstrap).toMatch(/outcome: 'granted'/)
  })

  it('never puts the break-glass token in a row, a log line or a response', () => {
    // `parsed.token` is read once, by the comparison, and must not travel.
    const afterCompare = bootstrap.slice(bootstrap.indexOf('const ownerId'))
    expect(afterCompare).not.toMatch(/parsed\.token|token/)

    const statusRoute = readFileSync(join(ROOT, 'server', 'api', 'setup', 'status.get.ts'), 'utf8')
    // /api/setup/status says a token IS installed, which is what points a
    // locked-out owner at the recovery page. It must never say what it is.
    expect(statusRoute).toMatch(/bootstrapConfigured/)
    expect(statusRoute).not.toMatch(/ZAEME_OWNER_BOOTSTRAP_TOKEN|bootstrapTokenMatches/)

    process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = 'hunter2-the-actual-secret'
    expect(JSON.stringify({ recoveryAvailable: bootstrapConfigured() })).not.toContain('hunter2')
    delete process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN
  })

  it('keeps the recovery page inside the /setup exemption', () => {
    // An owner who cannot sign in must be able to REACH the page that fixes it.
    // `/setup` is already exempt from the first-run redirect and `/setup/recover`
    // rides on that prefix — this pins the prefix rather than the exact path.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).toContain('\'/setup\'')
  })

  it('the admin security page is on the admin surface, behind the owner gate', () => {
    const route = readFileSync(join(API_ROOT, 'admin', 'security', 'index.get.ts'), 'utf8')
    expect(route).toMatch(/requireOwner\(/)
  })
})

/**
 * A TICKET STAYS HOST-MANAGED, AND WHAT IS PRINTED ON IT IS PART OF THE TICKET
 * (#35).
 *
 * `server/domain/guest.ts` refuses a guest the UPLOAD of a ticket or a
 * document, and the detail is the same thing said in rows: a seat number is not
 * a fact anybody holding the forwarded link gets to write. Two ways for that to
 * go wrong quietly — a write route on the invite token or the account surface,
 * or the domain function reaching for a weaker gate than the one that governs
 * assignment and deletion — and neither is visible in the shape of a handler.
 */
describe('what a ticket says is written by a planner, on the host surface only', () => {
  const DETAIL = join(API_ROOT, 'host', 'events', '[slug]', 'media', '[id]', 'detail.put.ts')

  it('lives beside assignment, and on no other credential', () => {
    expect(existsSync(DETAIL), DETAIL).toBe(true)
    expect(readFileSync(DETAIL, 'utf8')).toMatch(/requireGuestUser\(/)
    // THE VERB, NOT A WORD IN A PATH. The first version of this filtered the
    // other surfaces' handlers on `/detail/i` over their filenames, which is
    // the shape #74's review threw out: `server/api/me/events/[slug]/media/
    // [id]/seat.put.ts` calling `setTicketDetail` passes a filename rule
    // whole. What may not appear outside `server/api/host/**` is the DOMAIN
    // FUNCTION, whatever the route around it is called.
    const elsewhere = [...guestHandlers, ...accountHandlers, ...machineHandlers, ...adminHandlers]
      .filter(f => /\bsetTicketDetail\b/.test(readFileSync(f, 'utf8')))
    expect(elsewhere.map(rel)).toEqual([])
    // …and the host surface really does call it, or the line above is a rule
    // about a function nothing uses.
    expect(hostHandlers.filter(f => /\bsetTicketDetail\b/.test(readFileSync(f, 'utf8'))).map(rel))
      .toEqual([rel(DETAIL)])
  })

  /**
   * THE ARGUMENT, NOT THE FUNCTION — the half #77's review found unproved.
   *
   * Moving the formatting into `shared/utils/ticket-detail.ts` made the RULE
   * testable, and `test/ticket-detail.test.ts` executes it. What no test
   * touched was the value that function is HANDED. The reviewer deleted
   * `:timezone="page.event.timezone"` from the guest page and got eslint
   * clean, `nuxt typecheck` clean, 426 vitest passed and 731 smoke checks
   * passed — while every attendee's ticket rendered against the reader's clock
   * on the SSR'd page.
   *
   * It is silent because `formatInZone` falls back to the ambient zone for
   * `undefined` BY DESIGN (a stored zone ICU stops resolving must not take a
   * page down), so a missing prop and "the reader's own" are the same value.
   * The props are REQUIRED now, which makes `nuxt typecheck` refuse an omitted
   * binding at the call site; this asserts the requirement itself, because
   * turning one back into `timezone?:` is a one-character change that restores
   * the silence.
   *
   * A STRUCTURAL RULE OVER A TEMPLATE, which this file already does for
   * `<NuxtPage />` — and with the same caveat that taught: only the template
   * counts, since the prose above these bindings mentions them.
   */
  it('hands the event zone to both cards that render a ticket', () => {
    const PAGES = join(ROOT, 'app')
    const sfc = (...parts: string[]) => readFileSync(join(PAGES, ...parts), 'utf8')
    const template = (src: string) => /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''

    for (const parts of [['components', 'MediaGallery.vue'], ['components', 'HostMediaCard.vue']]) {
      const src = sfc(...parts)
      // REQUIRED. `timezone?: string | null` is the shape that goes quiet.
      expect(src, parts.join('/')).toMatch(/^ {2}timezone: string \| null$/m)
      expect(src, parts.join('/')).not.toMatch(/^ {2}timezone\?:/m)
      // …and it is the zone that reaches the renderer, not some other value.
      expect(template(src), parts.join('/')).toMatch(/ticketDetailLines\([^)]*,\s*timezone\)/)
    }

    // EVERY CALL SITE BINDS IT. This is the assertion the deleted line breaks.
    const bindings: string[] = []
    let callSites = 0
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(full)
          continue
        }
        if (!entry.name.endsWith('.vue')) continue
        const body = template(readFileSync(full, 'utf8'))
        for (const tag of ['MediaGallery', 'HostMediaCard']) {
          for (const at of [...body.matchAll(new RegExp(`<${tag}(?![\\w-])`, 'g'))].map(m => m.index!)) {
            callSites += 1
            const open = body.slice(at, body.indexOf('>', at))
            if (!/:timezone=/.test(open)) bindings.push(`${rel(full)}: <${tag}> with no :timezone`)
          }
        }
      }
    }
    visit(PAGES)
    expect(bindings).toEqual([])
    // THE ANTI-VACUITY GUARD, and it counts what the WALK found rather than
    // what a hand-written list says. `bindings` is empty both when every call
    // site binds the zone and when the walk found no call sites at all — a
    // renamed component, a moved directory, a `<template>` regex that stopped
    // matching. Three exist today: the gallery on the guest page, the host card
    // on the host page, and the gallery nested inside the host card.
    //
    // Counting `:timezone=` in those three files instead would prove nothing:
    // both pages bind a zone on `DatePoll` and `EventTimeline` too, so the
    // count stays at three with this feature's binding deleted.
    expect(callSites).toBe(3)

    // AND THE HOST CARD WATCHES THE ZONE, not only its own fetch. Its ticket
    // drafts hold a WALL CLOCK, seeded eagerly at mount, so a zone edited
    // further up the page moves `props.timezone` while the card's `useFetch`
    // does not re-run — and `saveDetail` then resolves a stale reading against
    // the new zone. Measured at five hours on an untouched field. The call site
    // is pinned rather than the symbol, because extracting the source into a
    // helper would satisfy a `/rezoneInputValue/` over the file while the
    // watcher went on watching only `tickets`.
    const hostCard = sfc('components', 'HostMediaCard.vue')
    expect(hostCard).toMatch(/watch\(\[tickets, \(\) => props\.timezone\]/)
    expect(hostCard).toMatch(/draft\.validFrom = rezoneInputValue\(draft\.validFrom, seededZone, zone\)/)
    expect(hostCard).toMatch(/draft\.validUntil = rezoneInputValue\(draft\.validUntil, seededZone, zone\)/)
  })

  it('asks the same gate assignment and deletion ask', () => {
    // ASK WHAT A GUARD PERMITS, NOT WHAT IT FORBIDS (#74). `logistics` is a
    // planner row and is deliberately not one of these two: a ticket is
    // somebody's seat, and the role set that may re-assign it is the role set
    // that may say what is on it. Pinned per function, because a regex over
    // the whole file passes on any one of the three matching.
    //
    // `assertMayAssign` is the shared gate #36 split out when assignment became
    // two verbs (add an attendee, remove one). It is read the same way, and the
    // two verbs are then read for CALLING it — otherwise a verb that answered
    // the question itself, with a wider role set, would satisfy a regex over
    // the file while nothing asserted the role set it used.
    const src = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const bodyOf = (decl: string) => {
      const start = src.indexOf(decl)
      expect(start, decl).toBeGreaterThan(-1)
      return src.slice(start, src.indexOf('\n}\n', start))
    }
    for (const fn of ['assertMayAssign', 'deleteMedia', 'setTicketDetail']) {
      const decl = fn === 'assertMayAssign'
        ? `async function ${fn}(`
        : `export async function ${fn}(`
      expect(bodyOf(decl), fn).toMatch(/assertPlanner\([^)]*roles: \['owner', 'co_planner'\]/s)
    }
    for (const fn of ['addTicketAssignee', 'removeTicketAssignee']) {
      expect(bodyOf(`export async function ${fn}(`), fn).toMatch(/await assertMayAssign\(userId, slug, mediaId\)/)
    }
  })

  it('every media read answers who the ticket is for (#36, and #78 is why)', () => {
    // THE TRAP THAT HAS BITTEN TWICE IN THIS EXACT FUNCTION. `asRow` in
    // `server/utils/v1-shapes.ts` casts an unchecked `object`
    // (Bermos/zaeme#78), so a shape reading a field its feeder never selected
    // answers null — or here, `[]` — on the wire with `nuxt typecheck` green.
    // `expenseId` (#29) and `ticket` (#35) each shipped that way for a release.
    //
    // THIS IS A WALK, NOT A LIST OF FILENAMES. It reads what `mediaItem`
    // actually projects and what its one feeder actually produces, and compares
    // the two — so a field added to the shape and forgotten in the feeder is
    // red here rather than null in Enterprise. A list of expected field names
    // would be a closure wearing a test's clothes: it would agree with itself
    // whatever either file said.
    //
    // IT CHECKS TWO THINGS, BECAUSE DELETING A LINE IS THE EASY MUTATION AND
    // NEUTERING IT IS THE ONE THAT SHIPS. The first pass below asks whether the
    // NAME is produced at all; on its own that passed while
    // `assignedRsvpIds: assignments.get(media.id) ?? []` was replaced with
    // `assignedRsvpIds: [] as string[]` — the #78 shape one level deeper, and
    // the exact wrong answer ("this ticket is nobody's") the field exists to
    // prevent. So the second pass refuses a field ANSWERED AS A BARE LITERAL:
    // a feeder handing the shape a constant is not feeding it, whatever the
    // typecheck says. A cast is stripped first, because `[] as string[]` is the
    // spelling the compiler pushes you towards.
    const shapes = readFileSync(join(ROOT, 'server', 'utils', 'v1-shapes.ts'), 'utf8')
    const shape = shapes.slice(shapes.indexOf('export function mediaItem('), shapes.indexOf('function ticketDetail('))
    expect(shape).not.toBe('')
    // Every `<name>: r.<something>` the shape reads off its row.
    const projected = [...shape.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]!)
    expect(projected).toContain('assignedRsvpIds')
    expect(projected.length).toBeGreaterThan(5)

    // Its ONE feeder, found by reading the route rather than by naming the
    // domain function here: `/api/v1` media is the only caller of `mediaItem`.
    const route = readFileSync(join(ROOT, 'server', 'api', 'v1', 'events', '[slug]', 'media.get.ts'), 'utf8')
    const feeder = /await (\w+)\(caller\.planner\.id, slug\)/.exec(route)?.[1]
    expect(feeder, 'the /api/v1 media route no longer calls one domain function').toBeDefined()

    const data = readFileSync(join(ROOT, 'server', 'domain', 'events-data.ts'), 'utf8')
    const fn = data.slice(data.indexOf(`export async function ${feeder}(`))
    const produced = fn.slice(0, fn.indexOf('\n}\n'))
    for (const field of projected) {
      // `id` and the detail's own fields are rebuilt below the select, so the
      // whole function body is searched rather than the projection alone —
      // what matters is that the NAME appears in the function that answers it.
      expect(produced, `${feeder} never produces \`${field}\`, which mediaItem reads`).toMatch(
        new RegExp(`\\b${field}\\b`)
      )
    }

    // …AND NONE OF THEM IS A CONSTANT. `<field>: <expr>` up to the end of its
    // line; a multi-line expression (the `ticket:` ternary) keeps its first
    // line, which is never a bare literal and so is never flagged.
    const LITERAL = /^(\[\s*\]|\{\s*\}|null|undefined|0|''|""|`` |false|true)$/
    const constants: string[] = []
    for (const field of projected) {
      for (const m of produced.matchAll(new RegExp(`^\\s*${field}:\\s*(.+?),?\\s*$`, 'gm'))) {
        // `x as T` is stripped: the cast is how a neutered field gets past
        // `nuxt typecheck`, so it must not be how it gets past this.
        const expr = m[1]!.replace(/\s+as\s+[\w[\]<>|,\s]+$/, '').trim()
        if (LITERAL.test(expr)) constants.push(`${field}: ${m[1]}`)
      }
    }
    expect(
      constants,
      `${feeder} answers a constant for a field mediaItem reads — a feeder handing the shape a literal is not feeding it`
    ).toEqual([])

    // AND THE SAME RULE ON THE OTHER TWO READS, which do not go through
    // `mediaItem` at all: the host card's and the invite link's both build
    // their views with `toView`, whose third argument is the assignee list.
    // Deleting that argument is a type error and needs no test; passing `[]`
    // is not, and is the same wrong answer as above on the two surfaces a
    // PERSON reads.
    //
    // The rule is DERIVED, not listed: `toView`'s second argument is the ticket
    // detail, and it is the literal `null` exactly where the caller knows the
    // item is not a ticket (a gallery photo, a shared document, a pinned
    // receipt). So every call that passes anything else is producing a TICKET
    // view, and that one must take its assignees from the loader.
    const domain = readFileSync(join(ROOT, 'server', 'domain', 'media.ts'), 'utf8')
    const args = (from: number) => {
      // Balanced-paren split, because one of these call sites is
      // `(await loadTicketAssignments([item.id])).get(item.id) ?? []`.
      let depth = 0
      const out: string[] = []
      let cur = ''
      for (let i = from; i < domain.length; i++) {
        const c = domain[i]!
        if (c === '(' || c === '[' || c === '{') depth++
        if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) {
            out.push(cur.trim())
            return out
          }
          depth--
        }
        if (c === ',' && depth === 0) {
          out.push(cur.trim())
          cur = ''
          continue
        }
        cur += c
      }
      return out
    }
    const ticketViews: string[][] = []
    for (const m of domain.matchAll(/(?<!function )\btoView\(/g)) {
      const a = args(m.index! + m[0].length)
      expect(a.length, `a toView call takes three arguments: ${a.join(' | ')}`).toBe(3)
      if (a[1] !== 'null') ticketViews.push(a)
    }
    // COUNT WHAT THE WALK FOUND. Four call sites produce a ticket view today;
    // a regex that stopped matching would find none and agree with itself.
    expect(ticketViews.length, 'no toView call produces a ticket view any more').toBeGreaterThan(3)
    for (const a of ticketViews) {
      expect(
        a[2],
        `toView(${a[0]}, ${a[1]}, …) builds a TICKET view from a constant instead of its assignees`
      ).toMatch(/assignments|loadTicketAssignments/)
    }
  })

  it('has no reader of the column #36 dropped', () => {
    // THE ACCEPTANCE CRITERION, EXECUTED: "`assignedRsvpId` is gone from the
    // schema and from every reader — grep proves it." A missed reader is not a
    // compile error, because of the cast above; it is a feature that silently
    // answers nothing. So this walks the tree instead of trusting that a grep
    // was run once, by hand, on the day.
    //
    // IT LOOKS FOR READERS, NOT FOR MENTIONS, and that distinction is the
    // difference between a test and a nuisance: this repository's comments
    // explain what a change replaced, so several files legitimately carry the
    // old name in prose — the same trap `updateTimelineItem` set in the OpenAPI
    // spec, where "does not mention" failed on a reserved operationId in a
    // comment. So the three CODE forms are pinned instead. A backticked
    // `assignedRsvpId` in a sentence matches none of them; a property read, a
    // declared member, an object key and the column named in SQL match.
    //
    // `assignedRsvpIds` is the replacement, so every pattern is anchored such
    // that a trailing `s` breaks it.
    //
    // THREE THINGS ARE EXEMPT AND NOTHING ELSE IS.
    //
    // The migration chain: `0000_baseline.sql` creates the column and `0013`
    // drops it, and a committed migration is history — rewriting one to remove
    // a name would change what a database that has already applied it believes.
    //
    // This file, which is where the rule is written down and cannot be an
    // instance of itself.
    //
    // And `scripts/ci-upgrade-check.mjs`, whose whole job is to speak TWO
    // releases at once: it reads what the PREVIOUS release answered, which is
    // the single `assignedRsvpId`, and compares it to what this one answers. It
    // is the reader that has to survive the removal, and it is named here so
    // that the day it stops needing the old spelling somebody deletes the line
    // rather than wondering why the exemption is there.
    const exempt = ['test/api-boundary.test.ts', 'scripts/ci-upgrade-check.mjs']
    const readers = [
      /\.assignedRsvpId\b/, // a property read
      /\bassignedRsvpId\s*[:?]/, // an object key, a type member, a YAML property
      /['"(]assigned_rsvp_id['")]/ // the column, named in code or in raw SQL
    ]
    const searched = ['server', 'app', 'shared', 'test', 'scripts', 'docs']
      .flatMap(top => walk(join(ROOT, top)))
      .filter(f => /\.(ts|vue|mjs|js|yaml|yml|sql|md|sh)$/.test(f))
      .filter(f => !rel(f).startsWith('server/database/migrations/'))
      .filter(f => !exempt.includes(rel(f)))
    // COUNT WHAT THE WALK FOUND, because an empty offender list is also what a
    // walk over nothing returns — a mistyped directory, a filter that stopped
    // matching, and the assertion below passes while reading no files at all.
    expect(searched.length).toBeGreaterThan(100)

    const offenders = searched.filter((f) => {
      const text = readFileSync(f, 'utf8')
      return readers.some(re => re.test(text))
    }).map(rel)
    expect(offenders).toEqual([])
  })

  it('keeps tickets and documents off the guest upload list', () => {
    // The rule this issue must not move. Read as a VALUE rather than as "does
    // not contain 'ticket'": the refusal message beside it names both words,
    // so a substring test passes on a list that has gained them.
    const guest = readFileSync(join(ROOT, 'server', 'domain', 'guest.ts'), 'utf8')
    const list = /const GUEST_UPLOAD_TYPES: MediaType\[\] = \[([^\]]*)\]/.exec(guest)?.[1]
    expect(list).toBeDefined()
    const types = list!.split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean)
    expect(types).toEqual(['photo', 'video'])
  })

  it('never makes a field required, on the wire or in the database', () => {
    // THE RULE THE ISSUE STATES IN TERMS: this must never become a form
    // somebody has to complete before uploading a PDF. Two places can break it
    // independently — a `.min(1)` in the route's zod schema, or a `.notNull()`
    // on one of the eight columns — so both are read.
    const route = readFileSync(DETAIL, 'utf8')
    const schema = route.slice(route.indexOf('const bodySchema'), route.indexOf('export default'))
    expect(schema).not.toMatch(/\.min\(/)
    // Every declared field is `.nullish()`: optional AND nullable, which is
    // what makes `{}` a legal body that clears the lot.
    const fields = [...schema.matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
    expect(fields).toEqual([
      'bookingRef', 'carrier', 'seat', 'coach', 'travellerName', 'validFrom', 'validUntil', 'note'
    ])
    expect([...schema.matchAll(/\.nullish\(\)/g)]).toHaveLength(fields.length)

    const events = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
    const table = events.slice(
      events.indexOf('export const ticketDetail = pgTable('),
      events.indexOf('export const icalToken = pgTable(')
    )
    expect(table).not.toBe('')
    for (const column of fields) {
      const line = new RegExp(`^  ${column}: .*$`, 'm').exec(table)?.[0]
      expect(line, column).toBeDefined()
      expect(line, column).not.toMatch(/notNull\(\)/)
    }
    // …and the two that ARE not-null are the bookkeeping, not the content.
    expect(table).toMatch(/eventId: text\('event_id'\)\.notNull\(\)/)
    expect(table).toMatch(/mediaId: text\('media_id'\)\.notNull\(\)/)
  })

  it('cannot point at a ticket on another event', () => {
    // A plain `media_id` reference would let a detail row on one trip name a
    // ticket on another, with only the handler's `eventId` filter between a
    // seat number and the wrong event. The composite key makes Postgres refuse
    // it, and it needs the unique index on `events_media (event_id, id)` as
    // its target — which is why the generated migration had to be re-ordered.
    const events = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
    expect(events).toMatch(/foreignColumns: \[media\.eventId, media\.id\]/)
    expect(events).toMatch(/uniqueIndex\('events_media_event_id_unique'\)\.on\(table\.eventId, table\.id\)/)

    // THE `42830` TRAP, asserted on the file that would abort the deploy. A
    // foreign key naming `events_media (event_id, id)` must come AFTER the
    // unique index backing it, and drizzle-kit emits every constraint before
    // every index — so this ordering is hand-edited and nothing but this reads
    // it. `pnpm test` runs no SQL; without this the first sign is the Kitchen
    // `migrate` task failing, with production left on the previous release.
    const sql = readFileSync(
      join(ROOT, 'server', 'database', 'migrations', '0012_worried_silver_centurion.sql'),
      'utf8'
    )
    const index = sql.indexOf('CREATE UNIQUE INDEX "events_media_event_id_unique"')
    const fk = sql.indexOf('ADD CONSTRAINT "events_ticket_detail_event_media_fk"')
    expect(index).toBeGreaterThan(-1)
    expect(fk).toBeGreaterThan(-1)
    expect(index).toBeLessThan(fk)
  })

  it('never lets a composite foreign key precede the index it needs, in ANY migration', () => {
    // THE SAME TRAP, GENERALISED, because it has now fired three times — 0007,
    // 0012 and 0013 — and each time the assertion left behind named the one
    // pair of strings that had just been fixed. A list of filenames agrees with
    // itself whatever the next migration does, so this WALKS the chain and
    // derives the rule from the SQL: every composite foreign key must have its
    // target's unique index already created, either earlier in its own file or
    // in a migration that ran before it.
    //
    // It is the only thing in `pnpm test` that reads this. Nothing here runs
    // SQL, so without it the first sign of `42830 there is no unique constraint
    // matching given keys` is the Kitchen `migrate` task failing, with
    // production left on the previous release.
    const dir = join(ROOT, 'server', 'database', 'migrations')
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    expect(files.length).toBeGreaterThan(10)

    const FK = /ADD CONSTRAINT "([^"]+)" FOREIGN KEY \("([^"]+)","([^"]+)"\) REFERENCES "public"\."([^"]+)"\("([^"]+)","([^"]+)"\)/g
    const offenders: string[] = []
    let composites = 0
    // What every migration BEFORE the one being read has already created.
    const earlier: Array<{ table: string, cols: string }> = []

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8')
      const indexesHere = [...sql.matchAll(
        /CREATE UNIQUE INDEX "[^"]+" ON "([^"]+)" USING btree \("([^"]+)","([^"]+)"\)/g
      )].map(m => ({ table: m[1]!, cols: `${m[2]},${m[3]}`, at: m.index! }))

      for (const m of sql.matchAll(FK)) {
        composites++
        const want = { table: m[4]!, cols: `${m[5]},${m[6]}` }
        const before = indexesHere.some(i => i.table === want.table && i.cols === want.cols && i.at < m.index!)
        const already = earlier.some(i => i.table === want.table && i.cols === want.cols)
        if (!before && !already) {
          offenders.push(`${file}: ${m[1]} references ${want.table}(${want.cols}) with no unique index created first`)
        }
      }
      earlier.push(...indexesHere.map(({ table, cols }) => ({ table, cols })))
    }

    // COUNT WHAT THE WALK FOUND. An empty offender list is also what a walk
    // over a regex that stopped matching returns, and that is the shape this
    // whole test exists to refuse.
    expect(composites).toBeGreaterThan(3)
    expect(offenders).toEqual([])
  })
})

/**
 * Nuxt's file-based router has one trap this app has already fallen into, and
 * it is invisible to every test that talks to the API instead of the pages.
 *
 * A `foo.vue` sitting BESIDE a `foo/` directory is not a sibling of what is in
 * that directory — it is their PARENT route, and a child renders only where the
 * parent puts a `<NuxtPage />`. `app/pages/setup.vue` had none, so shipping
 * `app/pages/setup/recover.vue` next to it made `/setup/recover` render the
 * parent instead: it ran `setup.vue`'s own "already claimed, go home" redirect
 * and bounced a locked-out owner to `/`. In production, with every API check
 * passing.
 */
describe('a page directory never has a same-named page beside it', () => {
  const PAGES = join(ROOT, 'app', 'pages')

  /**
   * Only the TEMPLATE counts. The first version of this searched the whole
   * file, and the comment on `setup/index.vue` explaining this very trap
   * contains the string `<NuxtPage />` — so the guard read the prose, decided
   * the parent rendered its children, and passed on the broken layout it was
   * written to catch. A rule that a comment can satisfy is not a rule.
   */
  const rendersChildren = (file: string) => {
    const src = readFileSync(file, 'utf8')
    const template = /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''
    return /<NuxtPage/.test(template)
  }

  it('has no `<name>.vue` beside a `<name>/` directory that fails to render it', () => {
    const offenders: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const sibling = `${full}.vue`
          if (existsSync(sibling) && !rendersChildren(sibling)) {
            offenders.push(rel(sibling))
          }
          visit(full)
        }
      }
    }
    visit(PAGES)
    expect(offenders).toEqual([])
  })

  it('still has both setup routes, as siblings', () => {
    // The fix was `setup.vue` → `setup/index.vue`, and losing either of these
    // would lock an owner out in a different way.
    expect(existsSync(join(PAGES, 'setup', 'index.vue'))).toBe(true)
    expect(existsSync(join(PAGES, 'setup', 'recover.vue'))).toBe(true)
    expect(existsSync(join(PAGES, 'setup.vue'))).toBe(false)
  })
})

/**
 * A refusal must not read as a broken server. `resolveUser` threw a plain
 * `Error`, which better-auth renders as a 500 — and `/setup/recover` puts that
 * message in front of somebody who has just mistyped a token.
 */
describe('the bootstrap refuses with a status that means refused', () => {
  it('throws better-auth\'s APIError rather than a bare Error', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'auth.ts'), 'utf8')
    const passkeyBlock = src.slice(src.indexOf('passkey({'))
    expect(passkeyBlock).toMatch(/new APIError\('UNAUTHORIZED'/)
    expect(passkeyBlock).not.toMatch(/throw new Error\(/)
  })
})
