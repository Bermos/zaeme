<script setup lang="ts">
/**
 * "We ended up walking" (#30) — the guest half of the trip's map.
 *
 * This is the one WRITE on the geography that the invite link buys, and that is
 * deliberate rather than an oversight: the thing this exists for happens on the
 * afternoon, on somebody's phone, while the host is asleep. It is a note about
 * how the group travelled, not a claim on anybody's money — the judgement money
 * got in #48 (an account, always) is a different one for a different reason.
 *
 * It records what HAPPENED: the server files every leg written through the
 * invite link as `isPlanned: false` and this form has no switch for it. Saying
 * what the group INTENDS to do is planning, and planning is the host's screen.
 *
 * Adding PLACES is the host's too, so the card says so plainly when there are
 * fewer than two to join up, rather than offering a form that cannot work.
 */
interface Place { id: string, name: string }

const props = withDefaults(
  defineProps<{
    token: string
    places: Place[]
    /**
     * The trip's display zone (#31). The rest of this page reads its times
     * against it, so the departure typed here is read against it too — usually
     * the same clock the phone is on, and not the same one for the friend who
     * is writing up the afternoon from home.
     */
    timezone?: string | null
  }>(),
  { timezone: null }
)
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

const MODE_ITEMS = [
  { label: '🚶 Walked', value: 'walk' },
  { label: '🚲 Cycled', value: 'bike' },
  { label: '🚗 Drove', value: 'car' },
  { label: '🚆 Train', value: 'train' },
  { label: '🚌 Bus', value: 'bus' },
  { label: '⛴️ Ferry', value: 'ferry' },
  { label: '✈️ Flew', value: 'plane' },
  { label: '➡️ Other', value: 'other' }
]

const placeItems = computed(() => props.places.map(p => ({ label: p.name, value: p.id })))
const enough = computed(() => props.places.length >= 2)
const zoneLine = computed(() => zoneNote(props.timezone))

const form = reactive({ fromPlaceId: '', toPlaceId: '', mode: 'walk', departsAt: '', durationMinutes: '', note: '' })
const saving = ref(false)

async function add() {
  if (!form.fromPlaceId || !form.toPlaceId) return
  saving.value = true
  try {
    await $fetch(`/api/invites/${props.token}/legs`, {
      method: 'POST',
      body: {
        fromPlaceId: form.fromPlaceId,
        toPlaceId: form.toPlaceId,
        mode: form.mode,
        departsAt: form.departsAt ? isoFromZonedInput(form.departsAt, props.timezone) : null,
        durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
        note: form.note || null
      }
    })
    form.departsAt = ''
    form.durationMinutes = ''
    form.note = ''
    emit('updated')
    toast.add({ title: 'Added to the itinerary', color: 'success' })
  } catch (e) {
    toast.add({
      title: (e as { data?: { message?: string } }).data?.message ?? 'Could not add that',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          🚶 How did you get there?
        </p>
        <p class="text-sm text-muted">
          Plans change. Add how the group actually travelled between two places — no account needed.
        </p>
        <p
          v-if="zoneLine"
          class="text-xs text-muted mt-0.5"
        >
          🕓 {{ zoneLine }} — type the time as it is there.
        </p>
      </div>
    </template>

    <form
      v-if="enough"
      class="flex flex-col gap-2"
      @submit.prevent="add"
    >
      <div class="flex flex-col sm:flex-row gap-2">
        <USelect
          v-model="form.fromPlaceId"
          :items="placeItems"
          placeholder="From"
          class="flex-1"
        />
        <USelect
          v-model="form.toPlaceId"
          :items="placeItems"
          placeholder="To"
          class="flex-1"
        />
        <USelect
          v-model="form.mode"
          :items="MODE_ITEMS"
          class="sm:w-40"
        />
      </div>
      <div class="flex flex-col sm:flex-row gap-2">
        <UInput
          v-model="form.departsAt"
          type="datetime-local"
          class="sm:w-52"
        />
        <UInput
          v-model="form.durationMinutes"
          type="number"
          placeholder="Minutes"
          class="sm:w-32"
        />
        <UInput
          v-model="form.note"
          placeholder="Missed the bus, walked it (optional)"
          class="flex-1"
        />
        <UButton
          type="submit"
          :loading="saving"
          :disabled="!form.fromPlaceId || !form.toPlaceId"
        >
          Add
        </UButton>
      </div>
    </form>
    <p
      v-else
      class="text-sm text-muted"
    >
      Your host has not pinned two places yet — once they have, you can say how you got between them.
    </p>
  </UCard>
</template>
