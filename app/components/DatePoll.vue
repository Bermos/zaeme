<script setup lang="ts">
/**
 * The date-finding availability poll (guest side): one row per proposed date,
 * the guest answers yes / if need be / no on each, everyone's answers are
 * visible so friends can converge ("find a date that works").
 */
interface PollVote { name: string, answer: 'yes' | 'ifneedbe' | 'no' }
interface PollOption {
  id: string
  startsAt: string
  endsAt: string | null
  note: string | null
  votes: PollVote[]
  tally: { yes: number, ifneedbe: number, no: number }
}

const props = withDefaults(
  defineProps<{
    token: string
    poll: PollOption[]
    /**
     * The event's display zone (#31), or null for the reader's own.
     *
     * THIS CARD WAS THE ONE THAT WAS MISSED, and it is the surface that matters
     * most: the host page reads its candidates against the event's clock and
     * writes them there too, so a host in Zürich planning a Lisbon party types
     * 20:00, `isoFromZonedInput` correctly stores 19:00Z, and the host page
     * says 20:00 — while this card, on the link that goes in the group chat,
     * said 19:00 with no zone named anywhere on it. One event, two clocks, and
     * the one the guests read was the wrong one. The winner also becomes the
     * event's own `startsAt` when the host locks it.
     */
    timezone?: string | null
  }>(),
  { timezone: null }
)
const emit = defineEmits<{ updated: [] }>()

const { identity, complete } = useGuestIdentity()

const ANSWERS = [
  { value: 'yes', label: 'Works', color: 'success' },
  { value: 'ifneedbe', label: 'If need be', color: 'warning' },
  { value: 'no', label: 'Can\'t', color: 'error' }
] as const

/** My current answer per option (seeded from the poll by my email→name match). */
const mine = ref<Record<string, 'yes' | 'ifneedbe' | 'no'>>({})
watch(() => props.poll, seed, { immediate: true })
function seed() {
  // Votes are name-keyed in the public view; seed from my own previous answers
  // by matching my display name (server enforces one vote per email anyway).
  for (const opt of props.poll) {
    const v = opt.votes.find(v => v.name === identity.value.name)
    if (v && !mine.value[opt.id]) mine.value[opt.id] = v.answer
  }
}

const saving = ref(false)
const toast = useToast()

async function submit() {
  if (!complete.value) return
  const votes = Object.entries(mine.value).map(([optionId, answer]) => ({ optionId, answer }))
  if (!votes.length) return
  saving.value = true
  try {
    await $fetch(`/api/invites/${props.token}/votes`, {
      method: 'POST',
      body: { guestName: identity.value.name, guestEmail: identity.value.email, votes }
    })
    toast.add({ title: 'Availability saved', color: 'success' })
    emit('updated')
  } catch {
    toast.add({ title: 'Could not save your availability', color: 'error' })
  } finally {
    saving.value = false
  }
}

function when(iso: string): string {
  return formatInZone(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, props.timezone) ?? '—'
}

const zoneLine = computed(() => zoneNote(props.timezone))
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          When works for you?
        </p>
        <p class="text-sm text-muted">
          The host locks the date once everyone has answered.
        </p>
        <p
          v-if="zoneLine"
          class="text-xs text-muted mt-0.5"
        >
          🕓 {{ zoneLine }}
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <div
        v-for="opt in poll"
        :key="opt.id"
        class="flex flex-col gap-2 pb-4 border-b border-default last:border-b-0 last:pb-0"
      >
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <p class="font-medium">
              {{ when(opt.startsAt) }}
            </p>
            <p
              v-if="opt.note"
              class="text-sm text-muted"
            >
              {{ opt.note }}
            </p>
          </div>
          <div class="flex gap-1">
            <UButton
              v-for="a in ANSWERS"
              :key="a.value"
              :label="a.label"
              :color="mine[opt.id] === a.value ? a.color : 'neutral'"
              :variant="mine[opt.id] === a.value ? 'solid' : 'outline'"
              size="xs"
              @click="mine[opt.id] = a.value"
            />
          </div>
        </div>
        <div class="flex items-center gap-3 text-sm text-muted flex-wrap">
          <span>✅ {{ opt.tally.yes }}</span>
          <span>🤔 {{ opt.tally.ifneedbe }}</span>
          <span>❌ {{ opt.tally.no }}</span>
          <span
            v-if="opt.votes.length"
            class="text-xs"
          >
            {{ opt.votes.filter(v => v.answer !== 'no').map(v => v.name).join(', ') || '—' }}
          </span>
        </div>
      </div>

      <div class="flex justify-end">
        <UButton
          :loading="saving"
          :disabled="!complete || !Object.keys(mine).length"
          @click="submit"
        >
          Save my availability
        </UButton>
      </div>
    </div>
  </UCard>
</template>
