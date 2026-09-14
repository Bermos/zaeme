<script setup lang="ts">
/**
 * The trip budget: expenses, per-person balances, and the "who pays whom"
 * settlement plan. Amounts travel as integer cents; this component renders
 * CHF-style francs. Adding an expense splits it across the selected
 * participants (evenly, remainder handled server-side).
 *
 * Writing needs an ACCOUNT (#48). The card never decides that itself — it
 * renders the form when it is given a `viewer` and no `lockedReason`, and
 * renders the reason otherwise — so the page that knows about sessions and
 * mail transports stays the one that decides.
 *
 * The payer is pickable and defaults to the viewer, because entering an expense
 * a friend fronted is the convenience that makes the account gate bearable. The
 * list therefore shows BOTH the payer and whoever typed it in.
 */
interface Share { name: string, email: string, amountCents: number }
interface Expense {
  id: string
  title: string
  category: string
  amountCents: number
  currency: string
  paidByName: string
  paidByEmail: string
  note: string | null
  addedByName?: string | null
  addedByEmail?: string | null
  shares: Share[]
}
interface Budget {
  expenses: Expense[]
  balances: Array<{ name: string, email: string, paidCents: number, owedCents: number, netCents: number }>
  settlements: Array<{ fromName: string, fromEmail: string, toName: string, toEmail: string, amountCents: number }>
  totalCents: number
  currency: string
}
interface Participant { name: string, email: string }

const props = defineProps<{
  budget: Budget
  /** POST target for a new expense; DELETE goes to `${expensesBase}/{id}`. */
  addUrl: string
  expensesBase: string
  /** Everyone who can be part of a split — usually the yes/maybe RSVPs. */
  participants: Participant[]
  /** The signed-in account, or null when nobody is signed in. */
  viewer: Participant | null
  /** Why writing is unavailable right now — rendered instead of the form. */
  lockedReason?: string | null
  /** Where to send somebody who needs to sign in first. */
  signInTo?: string | null
  /** Planners may remove any expense, not only their own. */
  canRemoveAny?: boolean
}>()
const emit = defineEmits<{ updated: [budget: Budget] }>()

const toast = useToast()

const CATEGORY_ICONS: Record<string, string> = {
  travel: '🚆', accommodation: '🛏️', food: '🍕', tickets: '🎟️', other: '🧾'
}

function francs(cents: number): string {
  return (cents / 100).toLocaleString('en-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const canWrite = computed(() => !!props.viewer && !props.lockedReason)

/** Everyone offerable as the payer — the split list, plus the viewer. */
const payerOptions = computed(() => {
  const seen = new Map<string, Participant>()
  for (const p of props.participants) if (p.email) seen.set(p.email, p)
  if (props.viewer?.email) seen.set(props.viewer.email, props.viewer)
  return [...seen.values()]
})

function canRemove(x: Expense): boolean {
  if (props.canRemoveAny) return true
  const email = props.viewer?.email
  if (!email) return false
  return x.paidByEmail === email || x.addedByEmail === email
}

/* ---- add expense ---- */
const adding = ref(false)
const title = ref('')
const amount = ref('')
const category = ref('other')
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

async function addExpense() {
  if (!payer.value) return
  if (!title.value || !Number.isFinite(amountCents.value) || amountCents.value <= 0 || !selected.value.length) return
  saving.value = true
  try {
    const participants = props.participants.filter(p => selected.value.includes(p.email))
    const res = await $fetch<{ budget: Budget }>(props.addUrl, {
      method: 'POST',
      body: {
        title: title.value,
        category: category.value,
        amountCents: amountCents.value,
        paidByName: payer.value.name,
        paidByEmail: payer.value.email,
        participants
      }
    })
    title.value = ''
    amount.value = ''
    adding.value = false
    emit('updated', res.budget)
    toast.add({ title: 'Expense recorded', color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not record that', color: 'error' })
  } finally {
    saving.value = false
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

const participantItems = computed(() => props.participants.filter(p => p.email).map(p => ({ label: p.name, value: p.email })))
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
          variant="subtle"
          color="neutral"
        >
          {{ budget.currency }} {{ francs(budget.totalCents) }}
        </UBadge>
      </div>
    </template>

    <div class="flex flex-col gap-4">
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
              {{ CATEGORY_ICONS[x.category] || '🧾' }} {{ x.title }}
            </p>
            <p class="text-muted">
              {{ x.paidByName }} paid {{ x.currency }} {{ francs(x.amountCents) }}
              · split {{ x.shares.length }} way{{ x.shares.length === 1 ? '' : 's' }}
            </p>
            <p
              v-if="x.addedByName && x.addedByEmail !== x.paidByEmail"
              class="text-muted text-xs"
            >
              added by {{ x.addedByName }}
            </p>
          </div>
          <div class="flex items-center gap-1">
            <span class="tabular-nums font-medium">{{ francs(x.amountCents) }}</span>
            <UButton
              v-if="canRemove(x)"
              size="xs"
              color="neutral"
              variant="ghost"
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

      <!-- Balances -->
      <div
        v-if="budget.balances.length"
        class="flex flex-col gap-1"
      >
        <p class="text-sm font-medium">
          Balances
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
          {{ budget.currency }} {{ francs(s.amountCents) }}
        </p>
      </div>

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
        @submit.prevent="addExpense"
      >
        <div class="flex gap-2">
          <USelect
            v-model="category"
            :items="[
              { label: '🚆 Travel', value: 'travel' },
              { label: '🛏️ Stay', value: 'accommodation' },
              { label: '🍕 Food', value: 'food' },
              { label: '🎟️ Tickets', value: 'tickets' },
              { label: '🧾 Other', value: 'other' }
            ]"
            class="w-36"
          />
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
        </div>
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
            v-model="selected"
            :items="participantItems"
            multiple
            class="w-full"
          />
        </UFormField>
        <div class="flex gap-2">
          <UButton
            type="submit"
            size="sm"
            :loading="saving"
            :disabled="!title || !amount || !selected.length || !payerEmail"
          >
            Record it
          </UButton>
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            @click="adding = false"
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
  </UCard>
</template>
