<script setup lang="ts">
interface Props {
  token: string
  /** Voter's identity defaults — used to pre-fill the guest fields. */
  defaultName?: string | null
  defaultEmail?: string | null
  /** When true, hide the guest identity fields (caller is signed in). */
  hideIdentity?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ submitted: [] }>()

type Response = 'yes' | 'if_need_be' | 'no'

interface SlotPayload {
  id: string
  startsAt: string
  endsAt: string | null
  counts: { yes: number, ifNeedBe: number, no: number }
}

interface PollPayload {
  poll: {
    id: string
    question: string | null
    deadline: string | null
    decidedSlotId: string | null
    closedAt: string | null
    slots: SlotPayload[]
    myResponses: { slotId: string, response: Response }[]
  } | null
}

const toast = useToast()

const { data, refresh, status } = await useFetch<PollPayload>(
  `/api/invites/${props.token}/poll`,
  { default: () => ({ poll: null }) }
)

const poll = computed(() => data.value?.poll ?? null)
const isClosed = computed(() => !!poll.value?.closedAt)
const deadlinePassed = computed(() => {
  if (!poll.value?.deadline) return false
  return new Date(poll.value.deadline).getTime() < Date.now()
})
const isReadOnly = computed(() => isClosed.value || deadlinePassed.value)

const myAnswers = reactive<Record<string, Response | undefined>>({})

watchEffect(() => {
  if (!poll.value) return
  for (const r of poll.value.myResponses) {
    myAnswers[r.slotId] = r.response
  }
})

const guestName = ref<string>(props.defaultName ?? '')
const guestEmail = ref<string>(props.defaultEmail ?? '')

watchEffect(() => {
  if (props.defaultName !== undefined && props.defaultName !== null) guestName.value = props.defaultName
  if (props.defaultEmail !== undefined && props.defaultEmail !== null) guestEmail.value = props.defaultEmail
})

function pick(slotId: string, value: Response) {
  myAnswers[slotId] = myAnswers[slotId] === value ? undefined : value
}

function rangeLabel(slot: SlotPayload): string {
  const start = new Date(slot.startsAt)
  const startStr = start.toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' })
  if (!slot.endsAt) return startStr
  const end = new Date(slot.endsAt)
  const sameDay = start.toDateString() === end.toDateString()
  if (sameDay) {
    return `${startStr} – ${end.toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${startStr} → ${end.toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' })}`
}

const submitting = ref(false)
const submitError = ref<string | null>(null)

const hasChanges = computed(() => {
  if (!poll.value) return false
  const original = new Map(poll.value.myResponses.map(r => [r.slotId, r.response]))
  for (const slotId of Object.keys(myAnswers)) {
    const v = myAnswers[slotId]
    if (v === undefined && original.has(slotId)) return true
    if (v !== undefined && original.get(slotId) !== v) return true
  }
  for (const [slotId] of original) {
    if (myAnswers[slotId] === undefined) return true
  }
  return false
})

async function submit() {
  if (!poll.value || isReadOnly.value) return
  submitError.value = null

  // Build the responses map skipping undefined entries (= not voted).
  const responses: Record<string, Response> = {}
  for (const slot of poll.value.slots) {
    const v = myAnswers[slot.id]
    if (v) responses[slot.id] = v
  }
  if (Object.keys(responses).length === 0) {
    submitError.value = 'Pick yes / if need be / no for at least one option.'
    return
  }
  if (!props.hideIdentity) {
    if (!guestName.value || !guestEmail.value) {
      submitError.value = 'Please add your name and email to vote.'
      return
    }
  }

  submitting.value = true
  try {
    const body: Record<string, unknown> = { responses }
    if (!props.hideIdentity) {
      body.guestName = guestName.value
      body.guestEmail = guestEmail.value
    }
    await $fetch(`/api/invites/${props.token}/poll/respond`, { method: 'POST', body })
    await refresh()
    emit('submitted')
    toast.add({ title: 'Thanks for voting!', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    submitError.value = e?.data?.message ?? 'Failed to submit your votes'
  } finally {
    submitting.value = false
  }
}

function score(slot: SlotPayload): number {
  return slot.counts.yes + slot.counts.ifNeedBe * 0.5
}
</script>

<template>
  <UCard v-if="status !== 'pending' && poll">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-calendar-check-2"
            class="size-4 text-muted"
          />
          <h2 class="font-semibold">
            Help pick a date
          </h2>
        </div>
        <UBadge
          v-if="isClosed && poll.decidedSlotId"
          color="success"
          variant="subtle"
          size="sm"
        >
          Date set
        </UBadge>
        <UBadge
          v-else-if="isClosed || deadlinePassed"
          color="neutral"
          variant="subtle"
          size="sm"
        >
          Voting closed
        </UBadge>
      </div>
    </template>

    <p
      v-if="poll.question"
      class="text-sm font-medium mb-3"
    >
      {{ poll.question }}
    </p>
    <p
      v-if="poll.deadline && !isClosed"
      class="text-xs text-muted mb-4 flex items-center gap-1.5"
    >
      <UIcon
        name="i-lucide-clock"
        class="size-3.5"
      />
      Closes {{ new Date(poll.deadline).toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' }) }}
    </p>

    <ul class="space-y-3">
      <li
        v-for="slot in poll.slots"
        :key="slot.id"
        class="border border-default rounded-md p-3"
        :class="poll.decidedSlotId === slot.id ? 'border-success-500 bg-success-50 dark:bg-success-950' : ''"
      >
        <div class="flex items-start justify-between gap-3 mb-2">
          <p class="text-sm font-medium">
            {{ rangeLabel(slot) }}
          </p>
          <span class="text-xs text-muted shrink-0">
            {{ slot.counts.yes }} · {{ slot.counts.ifNeedBe }} · {{ slot.counts.no }}
            <span class="ml-1 hidden sm:inline">(score {{ score(slot) }})</span>
          </span>
        </div>
        <div
          v-if="!isReadOnly"
          class="flex flex-wrap gap-2"
        >
          <UButton
            size="xs"
            :variant="myAnswers[slot.id] === 'yes' ? 'solid' : 'outline'"
            :color="myAnswers[slot.id] === 'yes' ? 'success' : 'neutral'"
            label="Yes"
            icon="i-lucide-check"
            type="button"
            @click="pick(slot.id, 'yes')"
          />
          <UButton
            size="xs"
            :variant="myAnswers[slot.id] === 'if_need_be' ? 'solid' : 'outline'"
            :color="myAnswers[slot.id] === 'if_need_be' ? 'warning' : 'neutral'"
            label="If need be"
            icon="i-lucide-alert-triangle"
            type="button"
            @click="pick(slot.id, 'if_need_be')"
          />
          <UButton
            size="xs"
            :variant="myAnswers[slot.id] === 'no' ? 'solid' : 'outline'"
            :color="myAnswers[slot.id] === 'no' ? 'error' : 'neutral'"
            label="No"
            icon="i-lucide-x"
            type="button"
            @click="pick(slot.id, 'no')"
          />
        </div>
      </li>
    </ul>

    <template v-if="!isReadOnly">
      <div
        v-if="!hideIdentity"
        class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5"
      >
        <UFormField label="Your name">
          <UInput
            v-model="guestName"
            class="w-full"
            placeholder="Jane Doe"
          />
        </UFormField>
        <UFormField label="Email">
          <UInput
            v-model="guestEmail"
            type="email"
            class="w-full"
            placeholder="jane@example.com"
          />
        </UFormField>
      </div>

      <UAlert
        v-if="submitError"
        color="error"
        variant="subtle"
        icon="i-lucide-alert-circle"
        :description="submitError"
        class="mt-3"
      />

      <div class="flex justify-end mt-4">
        <UButton
          icon="i-lucide-send"
          label="Save votes"
          :loading="submitting"
          :disabled="!hasChanges"
          @click="submit"
        />
      </div>
    </template>
  </UCard>
</template>
