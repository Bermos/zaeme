<script setup lang="ts">
/**
 * The bring list — food & drink coordination: see what's needed, claim an
 * item, add your own ("I'll bring hummus").
 */
interface Contribution {
  id: string
  title: string
  category: 'food' | 'drink' | 'other'
  quantity: string | null
  note: string | null
  claimed: boolean
  claimedByName: string | null
  claimedByEmail: string | null
}

const props = defineProps<{ token: string, contributions: Contribution[] }>()
const emit = defineEmits<{ updated: [] }>()

const { identity, complete } = useGuestIdentity()
const toast = useToast()

const CATEGORY_ICONS: Record<string, string> = { food: '🍲', drink: '🍹', other: '📦' }

const mine = (c: Contribution) => c.claimedByEmail === identity.value.email

const busy = ref<string | null>(null)

async function claim(c: Contribution) {
  if (!complete.value) return
  busy.value = c.id
  try {
    await $fetch(`/api/invites/${props.token}/contributions/${c.id}/claim`, {
      method: 'POST',
      body: { guestName: identity.value.name, guestEmail: identity.value.email }
    })
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

async function add() {
  if (!complete.value || !newTitle.value) return
  adding.value = true
  try {
    await $fetch(`/api/invites/${props.token}/contributions`, {
      method: 'POST',
      body: {
        title: newTitle.value,
        category: newCategory.value,
        claim: true,
        guestName: identity.value.name,
        guestEmail: identity.value.email
      }
    })
    newTitle.value = ''
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
              v-if="c.note"
              class="text-sm text-muted truncate"
            >
              {{ c.note }}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <UBadge
            v-if="c.claimed"
            :color="mine(c) ? 'primary' : 'neutral'"
            variant="subtle"
          >
            {{ mine(c) ? 'You bring this' : `${c.claimedByName} brings this` }}
          </UBadge>
          <UButton
            v-if="!c.claimed"
            size="xs"
            variant="outline"
            :loading="busy === c.id"
            :disabled="!complete"
            @click="claim(c)"
          >
            I'll bring it
          </UButton>
          <UButton
            v-else-if="mine(c)"
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
