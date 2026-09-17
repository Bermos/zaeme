<script setup lang="ts">
/**
 * The bring list — food & drink coordination: see what's needed, claim some of
 * an item, add your own ("I'll bring hummus").
 *
 * SINCE #44 A CLAIM IS A NUMBER. An item can say how many are wanted, several
 * people can be on it, and the line under the title reads "6 bottles needed,
 * 4 claimed, 2 to go". An item with NO stated count renders and behaves exactly
 * as it did before: one claimer, "You bring this", release.
 *
 * The arithmetic is `shared/utils/bring-list.ts` and not four expressions in
 * this template, because the server decides the same thing with the same
 * function and nothing in this repository executes a `.vue` file.
 */
interface ContributionClaim {
  name: string
  email: string
  quantityClaimed: number
}

interface Contribution {
  id: string
  title: string
  category: 'food' | 'drink' | 'other'
  quantity: string | null
  quantityNeeded: number | null
  unit: string | null
  note: string | null
  quantityClaimed: number
  quantityRemaining: number | null
  claimed: boolean
  claims: ContributionClaim[]
}

const props = defineProps<{ token: string, contributions: Contribution[] }>()
const emit = defineEmits<{ updated: [] }>()

const { identity, complete } = useGuestIdentity()
const toast = useToast()

const CATEGORY_ICONS: Record<string, string> = { food: '🍲', drink: '🍹', other: '📦' }

/** The viewer's own claim on an item, if they have one. */
const myClaim = (c: Contribution) => c.claims.find(x => x.email === identity.value.email)

/** "6 bottles needed, 4 claimed, 2 to go", or nothing at all for an item with no count. */
const countLine = (c: Contribution) => remainderLine(c.quantityNeeded, c.unit, c.claims)

/** Who is bringing it — everybody, not just the first. */
const claimantLine = (c: Contribution) => c.claims
  .map(x => x.email === identity.value.email
    ? (c.quantityNeeded == null ? 'You' : `You (${x.quantityClaimed})`)
    : (c.quantityNeeded == null ? x.name : `${x.name} (${x.quantityClaimed})`))
  .join(', ')

/**
 * WHO MAY DO WHAT TO AN ITEM, as two predicates rather than as `!c.claimed`
 * twice — because those are different questions and one control answered both.
 *
 * `canAdjust` is the viewer changing a number they already said, and it is TRUE
 * ON A FINISHED ITEM: lowering 6 to 3 is the only way to re-open one without
 * releasing it entirely, which would tell the party nobody is bringing the
 * thing. It is false where there is no count, because a claim on such an item
 * is one by definition and there is nothing to adjust — that item keeps exactly
 * the controls it had before this issue.
 */
const canClaim = (c: Contribution) => !c.claimed && !myClaim(c)
const canAdjust = (c: Contribution) => c.quantityRemaining !== null && !!myClaim(c)
/** A number field is worth showing only where there is a count to pick. */
const canPickNumber = (c: Contribution) => c.quantityRemaining !== null && (canClaim(c) || canAdjust(c))

/**
 * How many the button will take, and how high the field goes. Both are
 * `shared/utils/bring-list.ts`, where `test/bring-list.test.ts` EXECUTES them —
 * seeding this field with the remainder for somebody who already holds a claim
 * silently destroys part of it, and a string match over this file is not enough
 * to hold a rule with that failure mode.
 */
const amount = reactive<Record<string, number>>({})
const wanted = (c: Contribution) => amount[c.id] || claimFieldDefault(c.quantityRemaining, myClaim(c)?.quantityClaimed)
const maxFor = (c: Contribution) => claimFieldMax(c.quantityRemaining, myClaim(c)?.quantityClaimed)

const busy = ref<string | null>(null)

async function claim(c: Contribution) {
  if (!complete.value) return
  busy.value = c.id
  try {
    await $fetch(`/api/invites/${props.token}/contributions/${c.id}/claim`, {
      method: 'POST',
      body: {
        guestName: identity.value.name,
        guestEmail: identity.value.email,
        quantity: wanted(c)
      }
    })
    // Back to "the remainder", whatever the remainder is after this claim.
    amount[c.id] = 0
    emit('updated')
  } catch {
    toast.add({ title: 'Someone just claimed that one', color: 'warning' })
    emit('updated')
  } finally {
    busy.value = null
  }
}

async function release(c: Contribution) {
  busy.value = c.id
  try {
    await $fetch(`/api/invites/${props.token}/contributions/${c.id}/release`, {
      method: 'POST',
      body: { guestEmail: identity.value.email }
    })
    emit('updated')
  } finally {
    busy.value = null
  }
}

const adding = ref(false)
const newTitle = ref('')
const newCategory = ref<'food' | 'drink' | 'other'>('food')
const newCount = ref<number | null>(null)
const newUnit = ref('')

/**
 * Adding here is "I'll bring it", as it always has been — `claim: true`. So the
 * count typed in this form is BOTH the need and what this person is bringing,
 * and the server claims the whole need when no `claimQuantity` is sent. A
 * planner seeding "6 bottles" for others to claim does it on the host page,
 * which adds without claiming.
 */
async function add() {
  if (!complete.value || !newTitle.value) return
  adding.value = true
  try {
    await $fetch(`/api/invites/${props.token}/contributions`, {
      method: 'POST',
      body: {
        title: newTitle.value,
        category: newCategory.value,
        quantityNeeded: newCount.value || null,
        unit: newUnit.value || null,
        claim: true,
        guestName: identity.value.name,
        guestEmail: identity.value.email
      }
    })
    newTitle.value = ''
    newCount.value = null
    newUnit.value = ''
    toast.add({ title: 'Added — thanks for bringing it!', color: 'success' })
    emit('updated')
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          Who brings what
        </p>
        <p class="text-sm text-muted">
          Claim something, or add what you'll bring.
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-2">
      <div
        v-for="c in contributions"
        :key="c.id"
        class="flex items-center justify-between gap-2 py-2 border-b border-default last:border-b-0"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span>{{ CATEGORY_ICONS[c.category] }}</span>
          <div class="min-w-0">
            <p class="font-medium truncate">
              {{ c.title }}
              <span
                v-if="c.quantity"
                class="text-sm text-muted"
              >({{ c.quantity }})</span>
            </p>
            <p
              v-if="countLine(c)"
              class="text-sm text-muted"
            >
              {{ countLine(c) }}
            </p>
            <p
              v-if="c.note"
              class="text-sm text-muted truncate"
            >
              {{ c.note }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <UBadge
            v-if="c.claims.length"
            :color="myClaim(c) ? 'primary' : 'neutral'"
            variant="subtle"
          >
            {{ claimantLine(c) }}
          </UBadge>
          <UInput
            v-if="canPickNumber(c)"
            :model-value="wanted(c)"
            type="number"
            :min="1"
            :max="maxFor(c)"
            size="xs"
            class="w-16"
            aria-label="How many will you bring?"
            @update:model-value="amount[c.id] = Number($event) || 1"
          />
          <UButton
            v-if="canClaim(c) || canAdjust(c)"
            size="xs"
            variant="outline"
            :loading="busy === c.id"
            :disabled="!complete"
            @click="claim(c)"
          >
            {{ myClaim(c) ? 'Change' : "I'll bring it" }}
          </UButton>
          <UButton
            v-if="myClaim(c)"
            size="xs"
            variant="ghost"
            color="neutral"
            :loading="busy === c.id"
            @click="release(c)"
          >
            Release
          </UButton>
        </div>
      </div>

      <p
        v-if="!contributions.length"
        class="text-sm text-muted py-2"
      >
        Nothing on the list yet — add the first thing!
      </p>

      <form
        class="flex flex-col sm:flex-row gap-2 pt-2"
        @submit.prevent="add"
      >
        <USelect
          v-model="newCategory"
          :items="[
            { label: '🍲 Food', value: 'food' },
            { label: '🍹 Drink', value: 'drink' },
            { label: '📦 Other', value: 'other' }
          ]"
          class="sm:w-36"
        />
        <UInput
          v-model="newTitle"
          placeholder="I'll bring…"
          class="flex-1"
        />
        <UInput
          v-model.number="newCount"
          type="number"
          :min="1"
          placeholder="How many?"
          class="sm:w-28"
        />
        <UInput
          v-model="newUnit"
          placeholder="bottles"
          class="sm:w-28"
        />
        <UButton
          type="submit"
          :loading="adding"
          :disabled="!complete || !newTitle"
        >
          Add
        </UButton>
      </form>
    </div>
  </UCard>
</template>
