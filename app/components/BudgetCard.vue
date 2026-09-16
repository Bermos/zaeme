<script setup lang="ts">
/**
 * The trip budget: expenses, per-person balances, and the "who pays whom"
 * settlement plan. Amounts travel as integer cents; this component renders
 * CHF-style francs. Adding an expense splits it across the selected
 * participants — evenly, by exact amounts, by percentage or by weight (#26),
 * with the remainder always handed out server-side so the shares sum to the
 * total exactly. The form shows the running total against the expense amount,
 * so a percentage split that adds up to 99 is visible before saving and not
 * after.
 *
 * Writing needs an ACCOUNT (#48). The card never decides that itself — it
 * renders the form when it is given a `viewer` and no `lockedReason`, and
 * renders the reason otherwise — so the page that knows about sessions and
 * mail transports stays the one that decides.
 *
 * The payer is pickable and defaults to the viewer, because entering an expense
 * a friend fronted is the convenience that makes the account gate bearable. The
 * list therefore shows BOTH the payer and whoever typed it in.
 *
 * CORRECTING ONE (#27) REUSES THE SAME FORM. An edit is the add form prefilled
 * from the entry and PATCHed to `${expensesBase}/{id}` instead of POSTed, which
 * is the only shape in which the two can be guaranteed to offer the same
 * controls — a second form would drift, and the control it would be missing is
 * always the one somebody needs.
 *
 * ANY WRITER MAY EDIT ANY EXPENSE, which is wider than removing one (the
 * recorder, the payer, or a planner) and is the issue's own decision: a friend
 * who was there can fix a figure, and a wrong figure fixed by the wrong person
 * is still fixed, while a wrong deletion cannot be undone by anybody.
 */
interface Share { name: string, email: string, amountCents: number, amountBaseCents: number, weight: string | null }
interface Line {
  accountId: string
  accountName: string
  accountKind: 'member' | 'category' | 'rounding'
  accountEmail: string | null
  amountCents: number
  amountBaseCents: number
}
interface Account {
  id: string
  kind: 'member' | 'category' | 'rounding'
  name: string
  email: string | null
  isSystem: boolean
  /** What was posted INTO this account — on a category, what it cost. */
  debitCents: number
  creditCents: number
  netCents: number
  lineCount: number
}
interface Expense {
  id: string
  title: string
  /** The NAME of the category account this cost was debited to. */
  category: string
  categoryAccountId?: string | null
  /** As spent, in `currency`. */
  amountCents: number
  currency: string
  /** As settled, in `baseCurrency` — the only figure the balances are built from. */
  amountBaseCents: number
  baseCurrency: string
  fxRate: string
  /** Where that rate came from: `manual` is a figure a person checked. */
  fxRateSource?: 'fetched' | 'manual'
  /** What the payer said they were out of pocket, as they said it. */
  statedAmountCents?: number | null
  statedCurrency?: string | null
  /** How the total was divided: even, exact, percentage or weight. */
  splitMode: string
  paidByName: string
  paidByEmail: string
  note: string | null
  addedByName?: string | null
  addedByEmail?: string | null
  shares: Share[]
  /** Every posting of this entry, credits included. Sums to zero. */
  lines?: Line[]
  /**
   * The photo or paper pinned to this entry as its receipt (#29), or null.
   *
   * `url` is SIGNED AND EXPIRES — it is minted per response by
   * `signBudgetReceipts` and is never stored — so the card keys on it rather
   * than caching it, and an instance with no object storage answers a receipt
   * without one and gets no thumbnail instead of a broken image.
   */
  receipt?: { id: string, fileName: string, mimeType: string, url?: string } | null
}
interface Budget {
  expenses: Expense[]
  balances: Array<{ name: string, email: string, paidCents: number, owedCents: number, netCents: number }>
  settlements: Array<{ fromName: string, fromEmail: string, toName: string, toEmail: string, amountCents: number }>
  /** The event's chart of accounts, with what has been posted to each (#61). */
  accounts?: Account[]
  /** The sum of DEBITS into category accounts, in the trip's currency. */
  totalCents: number
  /** THE TRIP'S CURRENCY (#59): what every figure outside `expenses` is in. */
  currency: string
  /** Whether anything here went through a conversion, so the totals are close. */
  approximate?: boolean
}
interface Participant { name: string, email: string }

const props = defineProps<{
  budget: Budget
  /** POST target for a new expense; DELETE goes to `${expensesBase}/{id}`. */
  addUrl: string
  expensesBase: string
  /**
   * Where categories are listed, added and removed: GET/POST here, DELETE to
   * `${accountsBase}/{id}`. Optional, because a surface that cannot offer the
   * chart of accounts should not render a picker that 404s.
   */
  accountsBase?: string | null
  /** Everyone who can be part of a split — usually the yes/maybe RSVPs. */
  participants: Participant[]
  /** The signed-in account, or null when nobody is signed in. */
  viewer: Participant | null
  /**
   * Whether to render the NUMBERS — the expense list, the balances, the
   * settlement plan and the running total.
   *
   * Separate from `viewer` and from `lockedReason` on purpose, and required
   * rather than defaulted so a new caller has to decide. Who may WRITE and who
   * may READ the figures are different questions: an invite link forwarded into
   * a group chat should be able to say "there is a budget here, sign in" without
   * also saying "Ana owes Matthew CHF 300" to somebody who has typed nothing.
   */
  showAmounts: boolean
  /** Why writing is unavailable right now — rendered instead of the form. */
  lockedReason?: string | null
  /** Where to send somebody who needs to sign in first. */
  signInTo?: string | null
  /** Planners may remove any expense, not only their own. */
  canRemoveAny?: boolean
  /**
   * PATCH target for changing what this trip settles in (#59). Omitted on every
   * surface that may not — the invite page and the participant page — so the
   * control is absent rather than present and 403ing.
   */
  currencyUrl?: string | null
  /**
   * Where a receipt photo is uploaded from (#29): POST
   * `${receiptUploadBase}/presign`, PUT the bytes at the URL that comes back,
   * then POST `${receiptUploadBase}/confirm`. The PIN is a different request
   * on a different base (`${expensesBase}/{id}/receipt`), because uploading a
   * photo and saying it is the receipt for that 84 francs are two different
   * permissions — the first is a guest capability, the second is an expense
   * write.
   *
   * Absent means the shortcut is not offered and an already-pinned receipt is
   * still shown, which is the read-only surface's shape.
   */
  receiptUploadBase?: string | null
}>()
const emit = defineEmits<{ updated: [budget: Budget] }>()

const toast = useToast()

/**
 * A friendly glyph for the categories every event is seeded with, keyed on the
 * account's name in lower case. A category somebody added themselves gets the
 * fallback, which is the point of a fallback.
 */
const CATEGORY_ICONS: Record<string, string> = {
  travel: '🚆', accommodation: '🛏️', food: '🍕', tickets: '🎟️', uncategorised: '🧾'
}

function categoryIcon(name: string | undefined): string {
  return CATEGORY_ICONS[(name ?? '').toLowerCase()] ?? '🧾'
}

function francs(cents: number): string {
  return (cents / 100).toLocaleString('en-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * "€120.00" — the amount with its own currency's symbol. An unknown or
 * half-typed code makes `Intl` throw, so it falls back to the bare code, which
 * is also what a three-letter currency with no symbol renders as anyway.
 */
function money(cents: number, code: string): string {
  try {
    return new Intl.NumberFormat('en-CH', { style: 'currency', currency: code }).format(cents / 100)
  } catch {
    return `${code} ${francs(cents)}`
  }
}

/**
 * Whether this expense went through a conversion — which is what decides
 * whether the card shows the settled figure beside the receipt and the rate
 * line under it.
 *
 * THE RATE, NOT THE TWO CURRENCY CODES. `x.currency !== x.baseCurrency` is what
 * this was, and it is false on exactly the rows where the two figures differ
 * most: a payer's stated out-of-pocket total survives a change of the trip's
 * currency, so a EUR receipt on a trip that has moved to EUR reads
 * `currency: EUR, baseCurrency: EUR, amountCents: 24525, amountBaseCents:
 * 25425`. Under the old rule this printed "Ana paid €245.25", hid the €254.25
 * every balance on the trip is built from, and hid the rate line that would
 * have explained it — leaving a reader with numbers that do not add up and
 * nothing to click (#59 review). `shared/utils/conversion.ts` is the one rule,
 * shared with `loadBudget`'s `approximate`.
 */
function isForeign(x: Expense): boolean {
  return wasConverted(x)
}

const canWrite = computed(() => !!props.viewer && !props.lockedReason)

/**
 * Everybody the form may offer: the trip's participants, plus anyone already on
 * the expense being corrected.
 *
 * THE SECOND HALF IS NOT A NICETY. An expense recorded in June can be split
 * across somebody who has since changed their RSVP, and a form that offered only
 * today's participant list would drop them from the rows without saying so —
 * their share would vanish into everybody else's on save. Their name comes from
 * the participant list where there is one, because that is the current spelling.
 */
const editingShares = ref<Participant[]>([])
const roster = computed(() => {
  const seen = new Map<string, Participant>()
  for (const p of props.participants) if (p.email) seen.set(p.email, p)
  for (const p of editingShares.value) if (p.email && !seen.has(p.email)) seen.set(p.email, p)
  return [...seen.values()]
})

/** Everyone offerable as the payer — the split list, plus the viewer. */
const payerOptions = computed(() => {
  const seen = new Map<string, Participant>()
  for (const p of roster.value) if (p.email) seen.set(p.email, p)
  if (props.viewer?.email) seen.set(props.viewer.email, props.viewer)
  return [...seen.values()]
})

function canRemove(x: Expense): boolean {
  if (props.canRemoveAny) return true
  const email = props.viewer?.email
  if (!email) return false
  return x.paidByEmail === email || x.addedByEmail === email
}

/* ---- add an expense, or correct one (#27) ---- */
const adding = ref(false)
/** The entry being corrected, or null when the form is recording a new one. */
const editingId = ref<string | null>(null)
const editingTitle = ref('')
const title = ref('')
const amount = ref('')
const selected = ref<string[]>([])
const payerEmail = ref('')
const saving = ref(false)

watch(() => props.participants, (list) => {
  if (!selected.value.length) selected.value = list.map(p => p.email).filter(Boolean)
}, { immediate: true })

watch(() => props.viewer?.email, (email) => {
  if (email && !payerEmail.value) payerEmail.value = email
}, { immediate: true })

const amountCents = computed(() => Math.round(Number.parseFloat(amount.value || '0') * 100))
const payer = computed(() => payerOptions.value.find(p => p.email === payerEmail.value) ?? props.viewer)

/* ---- where the cost lands (#61) ---- */

/**
 * A group that does not care about categories never meets the concept. Every
 * expense posts to `Uncategorised` unless somebody asks for the picker, so the
 * form has one fewer control than it did and nothing is ever nullable behind
 * it — the destination is always a real account.
 *
 * The picker opens by itself once the trip HAS used a category, because at that
 * point hiding it would be hiding a decision the group has already made.
 */
const accounts = ref<Account[]>(props.budget.accounts ?? [])
watch(() => props.budget.accounts, (list) => {
  if (list) accounts.value = list
})

const categoryAccounts = computed(() => accounts.value.filter(a => a.kind === 'category'))
const uncategorised = computed(() => categoryAccounts.value.find(a => a.name.toLowerCase() === 'uncategorised'))
/** Categories with something actually posted to them — what the group uses. */
const usedCategories = computed(() => categoryAccounts.value.filter(a => a.debitCents > 0 && a.id !== uncategorised.value?.id))

const showCategory = ref(false)
watch(usedCategories, (used) => {
  if (used.length) showCategory.value = true
}, { immediate: true })

const categoryId = ref<string>('')
watch([uncategorised, () => adding.value], () => {
  if (!categoryId.value && uncategorised.value) categoryId.value = uncategorised.value.id
}, { immediate: true })

const categoryItems = computed(() => categoryAccounts.value.map(a => ({
  label: `${categoryIcon(a.name)} ${a.name}`,
  value: a.id
})))

const newCategory = ref('')
const savingCategory = ref(false)

/** The one account a category can be removed from the picker for: an unused one. */
function canRemoveCategory(a: Account): boolean {
  return !!props.accountsBase && !a.isSystem && a.lineCount === 0
}

async function addCategory() {
  const name = newCategory.value.trim()
  if (!name || !props.accountsBase) return
  savingCategory.value = true
  try {
    const res = await $fetch<{ accounts: Account[] }>(props.accountsBase, { method: 'POST', body: { name } })
    accounts.value = res.accounts
    categoryId.value = res.accounts.find(a => a.name.toLowerCase() === name.toLowerCase())?.id ?? categoryId.value
    newCategory.value = ''
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not add that', color: 'error' })
  } finally {
    savingCategory.value = false
  }
}

async function removeCategory(a: Account) {
  if (!props.accountsBase) return
  try {
    const res = await $fetch<{ accounts: Account[] }>(`${props.accountsBase}/${a.id}`, { method: 'DELETE' })
    accounts.value = res.accounts
    if (categoryId.value === a.id) categoryId.value = uncategorised.value?.id ?? ''
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not remove that', color: 'error' })
  }
}

/**
 * The conversion residual the ledger is carrying, if any — the rounding
 * account's DEBIT balance, which is negative when the shares converted to less
 * than the total rather than more.
 */
const roundingCents = computed(() => {
  const a = accounts.value.find(x => x.kind === 'rounding')
  return a ? a.debitCents - a.creditCents : 0
})

/* ---- the currency this one was spent in ---- */

/**
 * Money spent abroad. The currency defaults to what the instance settles in, in
 * which case none of this is on screen; pick something else and the form asks
 * for a rate, prefilled with today's if one can be fetched and EDITABLE either
 * way. The rate is frozen onto the expense server-side, so what is shown here
 * is what the balance will be built from forever.
 */
const spentCurrency = ref('')
const fxRate = ref('')
const fxAsOf = ref<string | null>(null)
const fxPending = ref(false)
const fxUnavailable = ref(false)

/**
 * WHICH FIGURE THIS EXPENSE IS RECORDED FROM (#59).
 *
 * `rate` multiplies the receipt by a rate — today's, prefilled, or one typed
 * over it. `paid` takes what the bank actually took off the payer, which is a
 * different number: `price × rate × fee` is what left their account and
 * therefore what the group owes them. You would not tell a friend the VAT on
 * dinner was a them problem.
 *
 * Both are on screen, side by side, because the second is the NORMAL path for
 * anyone who reads their card statement — not an advanced option behind a
 * disclosure. Only one is ever sent; the server refuses both together.
 */
const fxMode = ref<'rate' | 'paid'>('rate')
const paidAmount = ref('')

/**
 * WHAT THE FORM PUT IN THOSE TWO FIELDS, so the submit can tell a suggestion
 * from a statement (#71).
 *
 * `fxRateSource: 'manual'` means a PERSON stated what this cost — and a
 * recomputation carries a manual figure across a currency change untouched, on
 * the strength of that claim. This form fetches today's mid-market rate INTO the
 * rate field as a convenience and used to send it back verbatim, so every
 * foreign expense recorded here was written down as verified whether anybody had
 * verified anything or not. An edit made it worse: correcting the title of a
 * fetched row resent the prefilled rate and flipped it to `manual`, and
 * correcting the amount of a manual row resent the OLD stated total beside the
 * NEW receipt — recording "EUR 200.00 cost me CHF 234.00" as something somebody
 * checked.
 *
 * So the rule is: send either field only when it differs from what was put
 * there, or when the currency itself changed. An untouched prefill is the
 * server's own answer handed back to it, and omitting it lets the server say so
 * honestly — `fetched` on a write, and on an edit the frozen rate carrying the
 * new amount with the stated pair cleared.
 */
const fxRatePrefilled = ref('')
const paidAmountPrefilled = ref('')
const fxRateTouched = computed(() => fxRate.value.trim() !== fxRatePrefilled.value.trim())
const paidAmountTouched = computed(() => paidAmount.value.trim() !== paidAmountPrefilled.value.trim())
/** The receipt's currency as the expense being corrected was recorded with. */
const recordedCurrency = ref('')
/** On an edit, whether the receipt's own currency moved — which re-settles it. */
const currencyChanged = computed(() =>
  !!recordedCurrency.value && spentCurrency.value.trim().toUpperCase() !== recordedCurrency.value)
const paidCents = computed(() => {
  const n = Number.parseFloat(paidAmount.value.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
})

watch(() => props.budget.currency, (base) => {
  if (!spentCurrency.value) spentCurrency.value = base
}, { immediate: true })

/** The effective rate behind a stated total, for the line under the field. */
const impliedRate = computed(() => {
  if (!paidCents.value || !amountCents.value) return null
  return (paidCents.value / amountCents.value).toFixed(4)
})

const foreign = computed(() => {
  const code = spentCurrency.value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) && code !== props.budget.currency
})

const convertedCents = computed(() => {
  if (!foreign.value) return amountCents.value
  if (fxMode.value === 'paid') return paidCents.value
  const rate = Number.parseFloat(fxRate.value)
  if (!Number.isFinite(rate) || rate <= 0) return null
  return Math.round(amountCents.value * rate)
})

/**
 * Ask for today's rate. A failure is not an error state to recover from — the
 * field simply stays empty and the person types the rate in, which is also the
 * whole story on an instance with no outbound network.
 */
async function quoteRate() {
  const code = spentCurrency.value.trim().toUpperCase()
  fxAsOf.value = null
  fxUnavailable.value = false
  if (!foreign.value) {
    fxRate.value = ''
    fxRatePrefilled.value = ''
    return
  }
  fxPending.value = true
  try {
    // `to` is the TRIP's currency, which is what this expense will be converted
    // into (#59). Without it the quote would be into the instance default and
    // the prefill would be wrong on every trip that settles in anything else.
    const q = await $fetch<{ rate: string | null, asOf: string | null }>('/api/me/fx/rate', {
      query: { from: code, to: props.budget.currency }
    })
    if (q.rate) {
      fxRate.value = q.rate
      // What the FORM put there, so the submit can tell a suggestion it fetched
      // from a figure a person actually chose (#71).
      fxRatePrefilled.value = q.rate
      fxAsOf.value = q.asOf
    } else {
      fxUnavailable.value = true
    }
  } catch {
    fxUnavailable.value = true
  } finally {
    fxPending.value = false
  }
}

// A complete code is the trigger; nothing is fetched while somebody is still
// typing one, and nothing is fetched at all for the trip’s own currency.
//
// ...EXCEPT WHEN AN EDIT IS PREFILLING IT (#27). Today's rate is a suggestion
// for an expense that does not exist yet; for one that does, the rate that
// matters is the one FROZEN onto it, and letting the quote land would overwrite
// the prefilled figure a moment after the form opened. `startEdit` suppresses
// exactly one quote, so changing the currency while editing still fetches.
let skipNextQuote = false
watch(spentCurrency, (code) => {
  if (skipNextQuote) {
    skipNextQuote = false
    return
  }
  if (/^[A-Za-z]{3}$/.test(code.trim())) quoteRate()
})

/* ---- how the total is divided (#26) ---- */

/**
 * The mode, and one entered value per person — a percentage, a weight, or an
 * amount in whole currency units, depending which mode is on. Keyed by email so
 * changing who is in the split does not shuffle what was typed.
 *
 * Nothing here works out anybody's share: the server resolves the mode to cents
 * and hands out the remainder, and it is the only thing that does. What this
 * side owes the person is the RUNNING TOTAL — telling them their percentages
 * come to 99 while they can still fix it, rather than after a refused save.
 */
const splitMode = ref<'even' | 'exact' | 'percentage' | 'weight'>('even')
const splitValues = ref<Record<string, string>>({})

const SPLIT_ITEMS = [
  { label: 'Evenly', value: 'even' },
  { label: 'Exact amounts', value: 'exact' },
  { label: 'By percentage', value: 'percentage' },
  { label: 'By weight', value: 'weight' }
]

/** How an already-recorded expense says it was split. `even` says nothing. */
const SPLIT_LABELS: Record<string, string> = {
  exact: 'by exact amounts', percentage: 'by percentage', weight: 'by weight'
}

// A percentage is not a weight is not an amount: carrying numbers across a mode
// change would leave a plausible-looking total nobody typed.
//
// An EDIT sets the mode and the numbers together, though, and they are the
// numbers that belong to it — so `setSplit` below suppresses exactly one reset
// rather than having the prefill race the watcher it would otherwise trip.
let keepSplitValues = false
watch(splitMode, () => {
  if (keepSplitValues) {
    keepSplitValues = false
    return
  }
  // A mode picked from the control is somebody saying something about the
  // split. A mode set by a prefill is not, and `setSplit` suppresses this.
  splitTouched.value = true
  splitValues.value = {}
})

/**
 * WHETHER THE PERSON HAS SAID ANYTHING ABOUT THE SPLIT since the form opened —
 * which on an edit is the difference between two very different requests (#27).
 *
 * An edit that sends `splitMode` and `participants` REPLACES the split. An edit
 * that sends neither lets the server re-derive it from what was recorded, and
 * that is the only path on which `resplitFromRecord` runs at all — including its
 * refusal to re-split an `even` expense whose amounts were pinned by hand.
 *
 * This form used to send both unconditionally, so correcting the TITLE of such
 * an expense re-split it evenly and moved money between people: 40.00 / 30.00 /
 * 30.00 became 33.34 / 33.33 / 33.33, the toast said "Expense updated", and this
 * ledger keeps no history to recover it from. Sending the split only when
 * somebody touched it is what makes "I did not change the split" mean the same
 * thing here as it means in the API.
 */
const splitTouched = ref(false)

/** One person's number, typed. A prefill is not a change and does not call this. */
function setSplitValue(email: string, raw: string) {
  splitValues.value[email] = raw
  splitTouched.value = true
}

/** Who the cost is split between, changed from the control rather than prefilled. */
function setSelected(emails: string[]) {
  selected.value = emails
  splitTouched.value = true
}

/** Set the mode and its per-person numbers as ONE change, for a prefill. */
function setSplit(mode: typeof splitMode.value, values: Record<string, string>) {
  if (splitMode.value !== mode) {
    keepSplitValues = true
    splitMode.value = mode
  }
  splitValues.value = values
}

/**
 * The split the expense being corrected was RECORDED with, kept so the form can
 * ask `isPlainEvenSplit` the same question the server asks (#27).
 */
const recorded = ref<{ splitMode: string, amountCents: number, shares: Share[] } | null>(null)

/**
 * Whether this correction needs the split typed in again, because the record
 * cannot answer it.
 *
 * Two shapes, both from #26: an `exact` split's amounts were chosen against a
 * total that no longer exists, and an `even` split with amounts pinned by hand
 * records nothing about WHICH people were pinned. The server refuses both with a
 * message saying to send the split; this is the same question asked one step
 * earlier, so the rows can be handed back prefilled instead of somebody hitting
 * save and having to decode a refusal.
 *
 * It only fires once the TOTAL has actually moved — an unchanged total needs no
 * re-split at all, which is what lets the unrecoverable case still have its
 * title, category, note or payer corrected.
 */
const splitAskedBack = ref(false)
const needsTheSplitBack = computed(() => {
  const was = recorded.value
  if (!was || splitTouched.value) return false
  if (!Number.isFinite(amountCents.value) || amountCents.value === was.amountCents) return false
  if (was.splitMode === 'exact') return true
  if (was.splitMode !== 'even') return false
  return !isPlainEvenSplit(was.shares.map(s => s.amountCents), was.amountCents)
})

// Hand the recorded amounts back as `exact` the moment the total moves on a
// split that cannot be re-derived. They are the only numbers anybody has, the
// running total under the rows then says how far off the new total they are, and
// the submit button stays disabled until they add up.
watch(needsTheSplitBack, (needed) => {
  const was = recorded.value
  if (!needed || !was) return
  const values: Record<string, string> = {}
  for (const s of was.shares) values[s.email] = (s.amountCents / 100).toFixed(2)
  setSplit('exact', values)
  splitTouched.value = true
  splitAskedBack.value = true
})

/** Everybody currently in the split, in the order the rows render. */
const splitPeople = computed(() => roster.value.filter(p => selected.value.includes(p.email)))

/**
 * A percentage or weight as an integer at the scale the server stores it at.
 *
 * `scaleWeight` and `unscaleWeight` are the SERVER'S functions, auto-imported
 * from `shared/utils/split-weight.ts`: the running total under the rows has to
 * agree with the refusal the write would produce, and a second copy of the rule
 * here would agree until somebody changed one of them — after which the form
 * reads `100% of 100%` beside a server that refuses the save.
 */

/** A `exact` row, which is typed in whole currency units, as cents. */
function enteredCents(raw: string | undefined): number | null {
  const trimmed = (raw ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  return Math.round(Number.parseFloat(trimmed) * 100)
}

/** Whether a row has SOMETHING in it, as opposed to something unusable. */
function isBlank(raw: string | undefined): boolean {
  return (raw ?? '').trim() === ''
}

const splitEntries = computed(() => splitPeople.value.map(p => ({
  name: p.name,
  email: p.email,
  raw: (splitValues.value[p.email] ?? '').trim(),
  blank: isBlank(splitValues.value[p.email]),
  scaled: scaleWeight(splitValues.value[p.email] ?? ''),
  cents: enteredCents(splitValues.value[p.email])
})))

const allEntered = computed(() => splitEntries.value.every(
  e => (splitMode.value === 'exact' ? e.cents !== null : e.scaled !== null)
))

/** Entered so far: cents under `exact`, hundredths of a percent otherwise. */
const splitTotal = computed(() => splitEntries.value.reduce(
  (sum, e) => sum + (splitMode.value === 'exact' ? (e.cents ?? 0) : (e.scaled ?? 0)), 0
))

/**
 * What the form says under the rows, and whether that is a complaint. `weight`
 * has no target to miss — 2/1/1 is a complete answer — so it states the total
 * and never objects.
 */
const splitStatus = computed<{ text: string, off: boolean } | null>(() => {
  if (splitMode.value === 'even' || !splitEntries.value.length) return null
  if (!allEntered.value) {
    // "Give everybody a number" is the WRONG complaint about `33.33333`, which
    // is a number — it is one the column cannot store. Say which it is, because
    // the server's own message ("at most 4 decimal places") can never be seen
    // from here: the button is disabled before a request goes out.
    const unusable = splitEntries.value.some(e => !e.blank && (splitMode.value === 'exact' ? e.cents === null : e.scaled === null))
    if (unusable) {
      return {
        text: splitMode.value === 'exact'
          ? 'An amount is a number with at most 2 decimal places, like 40.00.'
          : 'A number with at most 4 decimal places, like 33.33.',
        off: true
      }
    }
    return {
      text: splitMode.value === 'exact'
        ? 'Give everybody an amount.'
        : 'Give everybody a number — 0 leaves them out of this one.',
      off: true
    }
  }
  if (splitMode.value === 'weight') {
    return splitTotal.value > 0
      ? { text: `Total weight ${unscaleWeight(splitTotal.value)} — shares are worked out from it.`, off: false }
      : { text: 'At least one person needs a weight above zero.', off: true }
  }
  if (splitMode.value === 'percentage') {
    return { text: `${unscaleWeight(splitTotal.value)}% of 100%`, off: splitTotal.value !== FULL_PERCENT }
  }
  const code = spentCurrency.value.trim().toUpperCase() || props.budget.currency
  return {
    text: `${money(splitTotal.value, code)} of ${money(Math.max(amountCents.value || 0, 0), code)}`,
    off: splitTotal.value !== amountCents.value
  }
})

const splitReady = computed(() => splitMode.value === 'even'
  || (!!splitEntries.value.length && !splitStatus.value?.off))

/** The `participants` array the write expects, which is mode-shaped. */
function splitParticipantsBody() {
  if (splitMode.value === 'even') return splitPeople.value.map(p => ({ name: p.name, email: p.email }))
  if (splitMode.value === 'exact') {
    return splitEntries.value.map(e => ({ name: e.name, email: e.email, amountCents: e.cents ?? 0 }))
  }
  return splitEntries.value.map(e => ({ name: e.name, email: e.email, weight: e.raw }))
}

/** Back to an empty form, whichever verb was on it. */
function resetForm() {
  editingId.value = null
  editingTitle.value = ''
  editingShares.value = []
  title.value = ''
  amount.value = ''
  categoryId.value = uncategorised.value?.id ?? ''
  splitMode.value = 'even'
  splitValues.value = {}
  selected.value = props.participants.map(p => p.email).filter(Boolean)
  payerEmail.value = props.viewer?.email ?? ''
  spentCurrency.value = props.budget.currency
  fxRate.value = ''
  fxAsOf.value = null
  fxUnavailable.value = false
  fxMode.value = 'rate'
  paidAmount.value = ''
  fxRatePrefilled.value = ''
  paidAmountPrefilled.value = ''
  recordedCurrency.value = ''
  recorded.value = null
  splitTouched.value = false
  splitAskedBack.value = false
  adding.value = false
}

/**
 * Open the form on an expense that already exists (#27), filled in with what it
 * says now — including the split, which is the part somebody would otherwise
 * have to reconstruct from the list to change one number in.
 *
 * `even` fills in no per-person values on purpose: there are none to fill in,
 * and typing amounts into an even split is how a person says "actually, pin
 * these". The other three modes hand back exactly what was entered, which is
 * what #26 stored the mode and the weights for.
 */
function startEdit(x: Expense) {
  editingId.value = x.id
  editingTitle.value = x.title
  editingShares.value = x.shares.map(s => ({ name: s.name, email: s.email }))
  title.value = x.title
  amount.value = (x.amountCents / 100).toFixed(2)
  categoryId.value = x.categoryAccountId ?? uncategorised.value?.id ?? ''
  if (x.categoryAccountId && x.categoryAccountId !== uncategorised.value?.id) showCategory.value = true
  payerEmail.value = x.paidByEmail
  selected.value = x.shares.map(s => s.email)

  if (spentCurrency.value !== x.currency) skipNextQuote = true
  spentCurrency.value = x.currency
  fxAsOf.value = null
  fxUnavailable.value = false
  // The frozen rate, and the figure behind it where there is one. A row that
  // says `manual` was recorded from something a person stated, so the form
  // opens on the field they stated it in.
  //
  // Both are recorded as PREFILLS (#71): what the form put there is not a
  // statement anybody made, so the submit sends either one only if it was
  // changed. Leaving them alone and correcting the title keeps a `fetched` row
  // fetched; leaving them alone and correcting the AMOUNT re-derives at this
  // frozen rate rather than resending a stated total that was about the old
  // receipt.
  recordedCurrency.value = x.currency
  fxRate.value = x.fxRate
  fxRatePrefilled.value = x.fxRate
  if (x.fxRateSource === 'manual' && x.statedAmountCents) {
    fxMode.value = 'paid'
    paidAmount.value = (x.statedAmountCents / 100).toFixed(2)
    paidAmountPrefilled.value = paidAmount.value
  } else {
    fxMode.value = 'rate'
    paidAmount.value = ''
    paidAmountPrefilled.value = ''
  }

  const mode = (['even', 'exact', 'percentage', 'weight'].includes(x.splitMode)
    ? x.splitMode
    : 'even') as typeof splitMode.value
  const values: Record<string, string> = {}
  if (mode === 'exact') for (const s of x.shares) values[s.email] = (s.amountCents / 100).toFixed(2)
  if (mode === 'percentage' || mode === 'weight') for (const s of x.shares) values[s.email] = s.weight ?? ''
  setSplit(mode, values)
  // The split as recorded, so `needsTheSplitBack` can ask `isPlainEvenSplit` the
  // same question the server asks — and so nothing below counts a prefill as
  // somebody having said something about the split.
  recorded.value = { splitMode: mode, amountCents: x.amountCents, shares: x.shares }
  splitTouched.value = false
  splitAskedBack.value = false

  adding.value = true
}

/**
 * One submit for both verbs: POST a new entry, PATCH an existing one.
 *
 * The bodies differ in ONE place, and it is the one an edit would get wrong by
 * copying. On a POST an omitted `accountId` means "the server's default,
 * Uncategorised"; on a PATCH it means "leave it where it is", so moving an
 * expense BACK to Uncategorised has to say so explicitly or nothing happens.
 */
async function saveExpense() {
  if (!payer.value) return
  if (!title.value || !Number.isFinite(amountCents.value) || amountCents.value <= 0 || !selected.value.length) return
  if (!splitReady.value) return
  const editing = editingId.value
  saving.value = true
  try {
    const res = await $fetch<{ budget: Budget }>(
      editing ? `${props.expensesBase}/${editing}` : props.addUrl,
      {
        method: editing ? 'PATCH' : 'POST',
        body: {
          title: title.value,
          // Omitted entirely on a new expense unless somebody picked one: the
          // server's default is `Uncategorised`, and sending it explicitly would
          // make the picker look load-bearing when it is not.
          //
          // On an EDIT it is always sent, because there absent means "leave it
          // where it is" and moving a cost BACK to Uncategorised has to say so.
          // NOTE for whoever writes the first member-to-member transfer (#28):
          // such an entry has `categoryAccountId: null` and no category line at
          // all, and this would give it one on the first edit — putting a
          // transfer into `totalCents`, which is the sum of category debits.
          // Nothing writes one today; when something does, this needs to send
          // `null` for it rather than `uncategorised`.
          ...(editing
            ? { accountId: categoryId.value || null }
            : showCategory.value && categoryId.value && categoryId.value !== uncategorised.value?.id
              ? { accountId: categoryId.value }
              : {}),
          amountCents: amountCents.value,
          currency: spentCurrency.value.trim().toUpperCase() || props.budget.currency,
          // Only when there is something to convert, and exactly ONE of the two:
          // an empty rate field means "fetch one", not "use 0", and the server
          // refuses a rate and a stated total together because they can disagree.
          //
          // AND ONLY WHEN SOMEBODY ACTUALLY PUT IT THERE (#71). Both fields are
          // prefilled — with today's quote on a write, with the frozen rate and
          // the stated total on an edit — and sending a prefill back is how a
          // mid-market rate nobody checked got recorded as `manual`, "a figure
          // checked against a statement". Untouched, they are omitted, and the
          // server derives honestly. A changed currency is a statement about
          // this receipt either way, so the field goes with it.
          ...(foreign.value && fxMode.value === 'rate' && fxRate.value.trim()
            && (!editing || fxRateTouched.value || currencyChanged.value)
            ? { fxRate: fxRate.value.trim() }
            : {}),
          ...(foreign.value && fxMode.value === 'paid' && paidCents.value
            && (!editing || paidAmountTouched.value || currencyChanged.value)
            ? { targetAmountCents: paidCents.value }
            : {}),
          paidByName: payer.value.name,
          paidByEmail: payer.value.email,
          // THE SPLIT, ONLY WHEN SOMEBODY TOUCHED IT (#27). Sending it replaces
          // the split; omitting it lets the server re-derive from what was
          // recorded, which is the only path `resplitFromRecord` — and its
          // refusal to re-split a hand-pinned `even` expense — is ever on. A
          // write always sends it: there is nothing to re-derive from.
          ...(!editing || splitTouched.value
            ? { splitMode: splitMode.value, participants: splitParticipantsBody() }
            : {})
        }
      }
    )
    resetForm()
    emit('updated', res.budget)
    toast.add({ title: editing ? 'Expense updated' : 'Expense recorded', color: 'success' })
  } catch (e) {
    toast.add({
      title: (e as { data?: { message?: string } }).data?.message
        ?? (editing ? 'Could not save that change' : 'Could not record that'),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

/* ---- changing what this trip settles in (#59) ---- */

/**
 * LOUD, and deliberately so. Every amount on the trip is re-expressed at
 * today's rate, which is not something to do by accident, so the panel is
 * opened on purpose, states plainly what will happen, and reports what it did
 * afterwards rather than leaving somebody to diff the numbers.
 *
 * There is NO LOCK-OUT once people have started settling up. A settlement is an
 * entry like any other and re-derives with the rest; doing this halfway through
 * is annoying and gets fixed by peer pressure, not by a refusal.
 */
const changingCurrency = ref(false)
const newCurrency = ref('')
const changeRate = ref('')
const changingSaving = ref(false)

/** What the last change did, so the card can say it rather than imply it. */
const lastChange = ref<{
  from: string
  to: string
  fxRate: string
  entriesRecomputed: number
  manualRatesKept: number
  roundingCents: number
} | null>(null)

const changeReady = computed(() => {
  const code = newCurrency.value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) && code !== props.budget.currency
})

async function changeCurrency() {
  if (!props.currencyUrl || !changeReady.value) return
  changingSaving.value = true
  try {
    const res = await $fetch<{ change: NonNullable<typeof lastChange.value>, budget: Budget }>(props.currencyUrl, {
      method: 'PATCH',
      body: {
        currency: newCurrency.value.trim().toUpperCase(),
        ...(changeRate.value.trim() ? { fxRate: changeRate.value.trim() } : {})
      }
    })
    lastChange.value = res.change
    changingCurrency.value = false
    newCurrency.value = ''
    changeRate.value = ''
    spentCurrency.value = res.budget.currency
    emit('updated', res.budget)
    toast.add({ title: `This trip now settles in ${res.change.to}`, color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not change the currency', color: 'error' })
  } finally {
    changingSaving.value = false
  }
}

/* ---- the receipt (#29) ---- */

/**
 * "What was that 84 francs?" — and the answer is a photo somebody already took.
 *
 * THIS IS NOT PART OF THE FORM, and that is the whole design. Attaching a
 * receipt is its own request, fired on its own click, against its own endpoint;
 * it never joins the body `saveExpense` composes and it never opens the edit
 * form. Two reasons, and the second is the one that cost money:
 *
 *  - a receipt is available on an expense nobody is correcting, which is most
 *    of them;
 *  - the body that form sends carries exactly the fields somebody TOUCHED
 *    (#27, #71), and folding a file picker into it would put a field in there
 *    that nobody typed. `fxRateSource: 'manual'` means a person stated a figure
 *    and checked it; a photograph is evidence a reader can look at. Pinning one
 *    relabels nothing, restates nothing, and the request below carries one
 *    field.
 */
const receiptBusy = ref<string | null>(null)
const receiptInput = ref<HTMLInputElement>()
/** Which expense the file picker was opened for. */
const receiptFor = ref<string | null>(null)

/** The shortcut needs somewhere to upload TO as well as the write standing. */
const canAttachReceipt = computed(() => canWrite.value && !!props.receiptUploadBase)

function pickReceipt(x: Expense) {
  if (!canAttachReceipt.value) return
  receiptFor.value = x.id
  receiptInput.value?.click()
}

/**
 * Upload the photo, then pin it — in that order, and the pin only if the
 * confirm succeeded. A `pending` row is an upload that may never land, and the
 * server refuses to pin one; doing it this way round means a browser that dies
 * halfway leaves a gallery row nobody points at rather than an expense pointing
 * at bytes that are not there.
 *
 * The size and type limits are the server's and are not restated here: an
 * `image/*` up to 25 MB, refused 422 and 413 respectively, and the message
 * comes back to the toast. A second copy of the numbers in this file would be
 * a second rule to keep in step.
 */
async function onReceiptFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const expenseId = receiptFor.value
  const base = props.receiptUploadBase
  if (!file || !expenseId || !base) return
  receiptBusy.value = expenseId
  try {
    const { mediaId, upload } = await $fetch<{
      mediaId: string
      upload: { url: string, headers?: Record<string, string> }
    }>(`${base}/presign`, {
      method: 'POST',
      body: {
        type: 'photo',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size
      }
    })
    const putRes = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream', ...(upload.headers ?? {}) },
      body: file
    })
    if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`)
    await $fetch(`${base}/confirm`, { method: 'POST', body: { mediaId } })

    // The pin, on the EXPENSE surface, carrying one field and no opinion about
    // the money.
    const res = await $fetch<{ budget: Budget }>(`${props.expensesBase}/${expenseId}/receipt`, {
      method: 'PUT',
      body: { mediaId }
    })
    emit('updated', res.budget)
    toast.add({ title: 'Receipt attached', color: 'success' })
  } catch (e) {
    toast.add({
      title: (e as { data?: { message?: string } }).data?.message ?? 'Could not attach that receipt',
      color: 'error'
    })
  } finally {
    receiptBusy.value = null
    receiptFor.value = null
    input.value = ''
  }
}

/**
 * Take the receipt off. THE PHOTO STAYS IN THE GALLERY — this un-pins and
 * nothing more, which is why the label says "remove" of the receipt and not of
 * the photo. Deleting the bytes is the planner's, from the gallery.
 */
async function detachReceipt(x: Expense) {
  if (!canWrite.value) return
  receiptBusy.value = x.id
  try {
    const res = await $fetch<{ budget: Budget }>(`${props.expensesBase}/${x.id}/receipt`, { method: 'DELETE' })
    emit('updated', res.budget)
    toast.add({ title: 'Receipt removed — the photo stays in the gallery', color: 'success' })
  } catch (e) {
    toast.add({
      title: (e as { data?: { message?: string } }).data?.message ?? 'Could not remove that receipt',
      color: 'error'
    })
  } finally {
    receiptBusy.value = null
  }
}

async function removeExpense(id: string) {
  try {
    const res = await $fetch<{ budget?: Budget }>(`${props.expensesBase}/${id}`, { method: 'DELETE' })
    if (res?.budget) emit('updated', res.budget)
    else emit('updated', { ...props.budget, expenses: props.budget.expenses.filter(x => x.id !== id) })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not remove that', color: 'error' })
  }
}

const participantItems = computed(() => roster.value.filter(p => p.email).map(p => ({ label: p.name, value: p.email })))
const payerItems = computed(() => payerOptions.value.map(p => ({ label: p.name, value: p.email })))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <div>
          <p class="font-semibold">
            💸 Budget & splitting
          </p>
          <p class="text-sm text-muted">
            Who paid what — and who squares up with whom.
          </p>
        </div>
        <UBadge
          v-if="showAmounts"
          variant="subtle"
          color="neutral"
        >
          {{ money(budget.totalCents, budget.currency) }}
        </UBadge>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <!-- The figures. `<template>` rather than a wrapper element: these are
           direct children of a `flex flex-col gap-4`, and a real div would
           collapse them into one gapless item. -->
      <template v-if="showAmounts">
        <!-- Expenses -->
        <div
          v-if="budget.expenses.length"
          class="flex flex-col gap-1"
        >
          <div
            v-for="x in budget.expenses"
            :key="x.id"
            class="flex items-start justify-between gap-2 py-2 border-b border-default last:border-b-0 text-sm"
          >
            <div>
              <p class="font-medium">
                {{ categoryIcon(x.category) }} {{ x.title }}
              </p>
              <p class="text-muted">
                {{ x.paidByName }} paid {{ money(x.amountCents, x.currency) }}{{ isForeign(x) ? ` (${money(x.amountBaseCents, x.baseCurrency)})` : '' }}
                · split {{ x.shares.length }} way{{ x.shares.length === 1 ? '' : 's' }}{{ SPLIT_LABELS[x.splitMode] ? `, ${SPLIT_LABELS[x.splitMode]}` : '' }}
              </p>
              <p
                v-if="isForeign(x)"
                class="text-muted text-xs"
              >
                converted at {{ x.fxRate }} when it was recorded{{ x.fxRateSource === 'manual' ? ' · checked against a statement' : '' }}<template
                  v-if="x.statedAmountCents && x.statedCurrency
                    && (x.statedAmountCents !== x.amountBaseCents || x.statedCurrency !== x.baseCurrency)"
                >
                  · stated as {{ money(x.statedAmountCents, x.statedCurrency) }}, re-expressed since
                </template>
              </p>
              <p
                v-if="x.addedByName && x.addedByEmail !== x.paidByEmail"
                class="text-muted text-xs"
              >
                added by {{ x.addedByName }}
              </p>
              <!-- The receipt (#29). A thumbnail when the URL is there — it is
                   signed and expires, so a response without one (an instance
                   with no object storage) simply has no picture rather than a
                   broken image. The photo lives in the gallery; removing the
                   receipt takes the pin off and leaves it there. -->
              <div
                v-if="x.receipt"
                class="flex items-center gap-2 mt-1"
              >
                <a
                  v-if="x.receipt.url"
                  :href="x.receipt.url"
                  target="_blank"
                  rel="noopener"
                  :title="x.receipt.fileName"
                >
                  <img
                    :src="x.receipt.url"
                    :alt="`Receipt for ${x.title}`"
                    class="h-12 w-12 rounded object-cover border border-default"
                  >
                </a>
                <span class="text-muted text-xs">🧾 receipt</span>
                <UButton
                  v-if="canWrite"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :loading="receiptBusy === x.id"
                  :aria-label="`Remove the receipt from ${x.title}`"
                  @click="detachReceipt(x)"
                >
                  remove
                </UButton>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <!-- The base figure, because it is the one the balances below are
                   built from; the as-spent amount is on the line above. -->
              <span class="tabular-nums font-medium">{{ francs(x.amountBaseCents) }}</span>
              <!-- ANY writer may correct ANY expense (#27), which is wider than
                   removing one on purpose: a wrong figure fixed by the wrong
                   person is still fixed, and a wrong deletion is not undoable
                   by anybody. Who made the change is in the audit log. -->
              <UButton
                v-if="canWrite"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="`Correct ${x.title}`"
                @click="startEdit(x)"
              >
                ✎
              </UButton>
              <!-- Photograph it and pin it, in one action. Only where there
                   is somewhere to upload to, and only for somebody who may
                   write this trip's money — the upload is a guest capability
                   but the PIN is an expense write (#29, #48). -->
              <UButton
                v-if="canAttachReceipt && !x.receipt"
                size="xs"
                color="neutral"
                variant="ghost"
                :loading="receiptBusy === x.id"
                :aria-label="`Attach a receipt to ${x.title}`"
                @click="pickReceipt(x)"
              >
                🧾
              </UButton>
              <UButton
                v-if="canRemove(x)"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="`Remove ${x.title}`"
                @click="removeExpense(x.id)"
              >
                ✕
              </UButton>
            </div>
          </div>
        </div>
        <p
          v-else
          class="text-sm text-muted"
        >
          No expenses yet.
        </p>

        <!-- What it went on, once the group uses categories. One line per
             account, and the figure is the sum of DEBITS into it — which is
             what "what did accommodation cost" means now. -->
        <div
          v-if="usedCategories.length"
          class="flex flex-col gap-1"
        >
          <p class="text-sm font-medium">
            What it went on
          </p>
          <div
            v-for="a in categoryAccounts.filter(c => c.debitCents > 0)"
            :key="a.id"
            class="flex items-center justify-between text-sm py-0.5"
          >
            <span>{{ categoryIcon(a.name) }} {{ a.name }}</span>
            <span class="tabular-nums text-muted">{{ francs(a.debitCents) }}</span>
          </div>
        </div>

        <!-- What this trip settles in, and the way to change it (#59). It sits
             beside the totals because that is what it denominates, and it is a
             panel somebody opens rather than a field they tab into. -->
        <div
          v-if="currencyUrl"
          class="flex flex-col gap-2"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-muted">
              This trip settles in <span class="font-medium text-default">{{ budget.currency }}</span>.
            </p>
            <UButton
              size="xs"
              variant="ghost"
              @click="changingCurrency = !changingCurrency"
            >
              {{ changingCurrency ? 'Never mind' : 'Change currency' }}
            </UButton>
          </div>

          <div
            v-if="changingCurrency"
            class="flex flex-col gap-3 rounded-lg border border-default p-3"
          >
            <UAlert
              color="warning"
              variant="subtle"
              title="Every amount on this trip will be recomputed"
              :description="`All ${budget.expenses.length} entr${budget.expenses.length === 1 ? 'y' : 'ies'}, every balance and the whole settlement plan will be re-expressed at today's rate. Rates somebody typed off a bank statement are carried across rather than looked up again. What was actually spent, and in what currency, is never touched.`"
            />
            <div class="flex flex-wrap items-end gap-2">
              <UFormField
                label="Settle in"
                size="sm"
              >
                <UInput
                  v-model="newCurrency"
                  placeholder="EUR"
                  maxlength="3"
                  class="w-20 uppercase"
                />
              </UFormField>
              <UFormField
                :label="`Rate ${budget.currency} → ${newCurrency.trim().toUpperCase() || '…'}`"
                size="sm"
                help="Optional — today's is fetched if you leave it empty."
              >
                <UInput
                  v-model="changeRate"
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="1.0730"
                  class="w-32"
                />
              </UFormField>
              <UButton
                color="warning"
                size="sm"
                :loading="changingSaving"
                :disabled="!changeReady"
                @click="changeCurrency"
              >
                Recompute everything
              </UButton>
            </div>
          </div>

          <p
            v-if="lastChange"
            class="text-xs text-muted"
          >
            Moved from {{ lastChange.from }} to {{ lastChange.to }} at {{ lastChange.fxRate }}:
            {{ lastChange.entriesRecomputed }} entr{{ lastChange.entriesRecomputed === 1 ? 'y' : 'ies' }} recomputed,
            {{ lastChange.manualRatesKept }} with a rate somebody had checked, carried across unchanged.
          </p>
        </div>

        <!-- Said once, as a statement of fact rather than a warning: the way a
             card receipt says "rate at time of purchase" (#59). It shows only
             when something here was actually converted. -->
        <p
          v-if="budget.approximate"
          class="text-xs text-muted"
        >
          Converted at the rate recorded with each entry, so these totals are close rather than exact.
        </p>

        <!-- The conversion residual, where it can be seen and explained rather
             than quietly landing on somebody's balance. -->
        <p
          v-if="roundingCents !== 0"
          class="text-xs text-muted"
        >
          ⚖️ {{ money(roundingCents, budget.currency) }} of rounding sits apart from the totals: converting a
          split at one rate does not always come out to the cent, and that difference is kept here rather
          than added to anybody's share.
        </p>

        <!-- Balances -->
        <div
          v-if="budget.balances.length"
          class="flex flex-col gap-1"
        >
          <p class="text-sm font-medium">
            Balances <span class="text-muted font-normal">· in {{ budget.currency }}</span>
          </p>
          <div
            v-for="b in budget.balances"
            :key="b.email"
            class="flex items-center justify-between text-sm py-1"
          >
            <span>{{ b.name }}<span
              v-if="viewer && b.email === viewer.email"
              class="text-muted"
            > (you)</span></span>
            <span
              class="tabular-nums font-medium"
              :class="b.netCents > 0 ? 'text-success' : b.netCents < 0 ? 'text-error' : 'text-muted'"
            >
              {{ b.netCents > 0 ? '+' : '' }}{{ francs(b.netCents) }}
            </span>
          </div>
        </div>

        <!-- Settle up -->
        <div
          v-if="budget.settlements.length"
          class="flex flex-col gap-1"
        >
          <p class="text-sm font-medium">
            To settle up
          </p>
          <p
            v-for="(s, i) in budget.settlements"
            :key="i"
            class="text-sm text-muted"
          >
            👉 <span class="font-medium text-default">{{ s.fromName }}</span> pays
            <span class="font-medium text-default">{{ s.toName }}</span>
            {{ money(s.amountCents, budget.currency) }}
          </p>
        </div>
      </template>

      <!-- Money needs an account: say so, and never offer a sign-in that cannot complete -->
      <UAlert
        v-if="lockedReason"
        color="neutral"
        variant="subtle"
        icon="i-lucide-lock"
        title="Adding an expense needs an account"
        :description="lockedReason"
      >
        <template
          v-if="signInTo"
          #actions
        >
          <UButton
            :to="signInTo"
            size="xs"
          >
            Sign in
          </UButton>
        </template>
      </UAlert>

      <!-- Add -->
      <form
        v-else-if="canWrite && adding"
        class="flex flex-col gap-2 pt-1"
        @submit.prevent="saveExpense"
      >
        <p
          v-if="editingId"
          class="text-sm text-muted"
        >
          Correcting <span class="font-medium text-default">{{ editingTitle }}</span>. Anyone on the
          trip can fix any expense — the change is recorded against you.
        </p>
        <div class="flex gap-2">
          <UInput
            v-model="title"
            placeholder="Airbnb, night 1"
            class="flex-1"
          />
          <UInput
            v-model="amount"
            type="number"
            step="0.05"
            min="0"
            placeholder="120.00"
            class="w-28"
          />
          <UInput
            v-model="spentCurrency"
            placeholder="CHF"
            maxlength="3"
            class="w-20 uppercase"
          />
        </div>

        <!-- Spent abroad. TWO ways to say what it cost, both on screen (#59):
             a rate (today's, prefilled and editable) or the amount the bank
             actually took, which is what the group splits when the bank added a
             fee. The form never blocks on the fetch — an unavailable rate just
             means typing one in, or saying what was paid. -->
        <div
          v-if="foreign"
          class="flex flex-col gap-2"
        >
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              size="xs"
              :variant="fxMode === 'rate' ? 'solid' : 'outline'"
              @click="fxMode = 'rate'"
            >
              Convert at a rate
            </UButton>
            <UButton
              size="xs"
              :variant="fxMode === 'paid' ? 'solid' : 'outline'"
              @click="fxMode = 'paid'"
            >
              I know what I was charged
            </UButton>
          </div>

          <UFormField
            v-if="fxMode === 'rate'"
            :label="`Rate ${spentCurrency.toUpperCase()} → ${budget.currency}`"
            size="sm"
            :help="fxUnavailable
              ? 'No rate could be fetched just now — enter one and it will be recorded with it.'
              : fxAsOf ? `ECB reference rate, ${fxAsOf}. A suggestion — your statement wins.` : 'Frozen onto this expense.'"
          >
            <div class="flex items-center gap-2">
              <UInput
                v-model="fxRate"
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.9412"
                class="w-32"
                :loading="fxPending"
              />
              <span
                v-if="convertedCents !== null && amountCents > 0"
                class="text-sm text-muted tabular-nums"
              >= {{ money(convertedCents, budget.currency) }}</span>
            </div>
          </UFormField>

          <UFormField
            v-else
            :label="`What left your account, in ${budget.currency}`"
            size="sm"
            :help="editingId && !paidAmountTouched
              ? 'What was recorded. Leave it and the amount is re-derived at this expense\'s own rate; change it and the new figure is recorded as yours.'
              : impliedRate
                ? `That works out at ${impliedRate} — the rate plus whatever your bank took. It is what the group splits.`
                : 'The total your bank actually took, fee and all. That is what the group owes you.'"
          >
            <UInput
              v-model="paidAmount"
              type="number"
              step="0.01"
              min="0"
              placeholder="113.47"
              class="w-32"
            />
          </UFormField>
        </div>
        <!-- Categories are opt-in (#61). Without one an expense still posts
             somewhere real — the event's Uncategorised account — so a group
             that does not care is never asked. -->
        <UButton
          v-if="!showCategory"
          size="xs"
          variant="link"
          color="neutral"
          class="self-start -my-1"
          @click="showCategory = true"
        >
          Put it in a category
        </UButton>
        <UFormField
          v-else
          label="Category"
          size="sm"
          help="Everything without one lands in Uncategorised."
        >
          <div class="flex flex-col gap-2">
            <USelect
              v-model="categoryId"
              :items="categoryItems"
              class="w-full"
            />
            <div
              v-if="accountsBase"
              class="flex gap-2"
            >
              <UInput
                v-model="newCategory"
                placeholder="Ski pass"
                size="sm"
                class="flex-1"
                @keydown.enter.prevent="addCategory"
              />
              <UButton
                size="sm"
                variant="outline"
                color="neutral"
                :loading="savingCategory"
                :disabled="!newCategory.trim()"
                @click="addCategory"
              >
                Add category
              </UButton>
            </div>
            <div
              v-if="categoryAccounts.some(canRemoveCategory)"
              class="flex flex-wrap gap-1"
            >
              <UButton
                v-for="a in categoryAccounts.filter(canRemoveCategory)"
                :key="a.id"
                size="xs"
                variant="ghost"
                color="neutral"
                @click="removeCategory(a)"
              >
                ✕ {{ a.name }}
              </UButton>
            </div>
          </div>
        </UFormField>
        <UFormField
          label="Paid by"
          size="sm"
          help="Entering one for a friend? Pick them — it still records that you added it."
        >
          <USelect
            v-model="payerEmail"
            :items="payerItems"
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="Split between"
          size="sm"
        >
          <USelect
            :model-value="selected"
            :items="participantItems"
            multiple
            class="w-full"
            @update:model-value="setSelected($event as string[])"
          />
        </UFormField>
        <UFormField
          label="How"
          size="sm"
          help="Evenly is the usual one. Weight is for “Ana counts double” — 2, 1, 1."
        >
          <USelect
            v-model="splitMode"
            :items="SPLIT_ITEMS"
            class="w-full"
          />
        </UFormField>

        <!-- One row per person, and the running total under them, so a split
             that comes to 99% is visible here rather than in a refusal. -->
        <div
          v-if="splitMode !== 'even' && splitEntries.length"
          class="flex flex-col gap-1"
        >
          <!-- The one case the record cannot answer, handed back rather than
               refused after the save (#26, #27). -->
          <p
            v-if="splitAskedBack"
            class="text-sm text-muted"
          >
            This one was split with amounts set by hand, and which people were pinned was never recorded —
            so the amounts are back here to be corrected against the new total.
          </p>
          <div
            v-for="p in splitEntries"
            :key="p.email"
            class="flex items-center justify-between gap-2 text-sm"
          >
            <span class="truncate">{{ p.name }}</span>
            <div class="flex items-center gap-1">
              <UInput
                :model-value="splitValues[p.email] ?? ''"
                type="number"
                :step="splitMode === 'exact' ? '0.05' : splitMode === 'percentage' ? '0.01' : '1'"
                min="0"
                :placeholder="splitMode === 'exact' ? '40.00' : splitMode === 'percentage' ? '33.33' : '1'"
                size="sm"
                class="w-28"
                @update:model-value="setSplitValue(p.email, String($event))"
              />
              <span class="text-muted w-4">{{ splitMode === 'percentage' ? '%' : splitMode === 'weight' ? '×' : '' }}</span>
            </div>
          </div>
          <p
            v-if="splitStatus"
            class="text-sm tabular-nums"
            :class="splitStatus.off ? 'text-error' : 'text-muted'"
          >
            {{ splitStatus.text }}
          </p>
        </div>

        <div class="flex gap-2">
          <UButton
            type="submit"
            size="sm"
            :loading="saving"
            :disabled="!title || !amount || !selected.length || !payerEmail
              || (foreign && fxMode === 'rate' && !fxRate)
              || (foreign && fxMode === 'paid' && !paidCents)
              || !splitReady"
          >
            {{ editingId ? 'Save changes' : 'Record it' }}
          </UButton>
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            @click="resetForm"
          >
            Cancel
          </UButton>
        </div>
      </form>
      <UButton
        v-else-if="canWrite"
        size="sm"
        variant="outline"
        class="self-start"
        @click="adding = true"
      >
        Add an expense
      </UButton>
    </div>

    <!-- One picker for every row; `receiptFor` says which expense opened it. -->
    <input
      ref="receiptInput"
      type="file"
      class="hidden"
      accept="image/*"
      @change="onReceiptFile"
    >
  </UCard>
</template>
