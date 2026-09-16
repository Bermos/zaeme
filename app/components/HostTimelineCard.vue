<script setup lang="ts">
/**
 * The itinerary editor (host side) — the trip planner's core: transport,
 * accommodation, activities and meals, day by day. Also handy for the
 * single-evening "doors → food → film" plan.
 *
 * Items are editable in place (PATCH, restored in #8) and can be moved up and
 * down: a typo used to mean deleting the row and re-adding it at the end.
 */
interface TimelineItem {
  id: string
  title: string
  description: string | null
  startsAt: string | Date | null
  location: string | null
  /** The pinned place, when the trip has places to pin to (#30). */
  placeId?: string | null
  type: string
  sortOrder?: number
}
interface Place { id: string, name: string }

const props = withDefaults(
  defineProps<{ slug: string, timeline: TimelineItem[], places?: Place[], trip?: boolean, timezone?: string | null }>(),
  { places: () => [], timezone: null }
)
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

const TYPE_ITEMS = [
  { label: '🚆 Transport', value: 'transport' },
  { label: '🛏️ Accommodation', value: 'accommodation' },
  { label: '🎬 Activity', value: 'activity' },
  { label: '🍕 Meal', value: 'meal' },
  { label: '📍 Other', value: 'other' }
]
const TYPE_ICONS: Record<string, string> = {
  transport: '🚆', accommodation: '🛏️', activity: '🎬', meal: '🍕', other: '📍'
}

/**
 * The places this event has, as a picker — plus "no place", which is not a
 * cosmetic entry: `location` is the free-text fallback and unpinning an item
 * back to it has to be possible from the same control that pinned it.
 */
const PLACE_NONE = ''
const placeItems = computed(() => [
  { label: 'No place', value: PLACE_NONE },
  ...props.places.map(p => ({ label: `📍 ${p.name}`, value: p.id }))
])

const itemType = ref('activity')
const itemTitle = ref('')
const itemWhen = ref('')
const itemLocation = ref('')
const itemPlaceId = ref(PLACE_NONE)
const adding = ref(false)

/**
 * `datetime-local` wants `YYYY-MM-DDTHH:mm`, and since #31 that wall clock is
 * THE EVENT'S, not the host's browser's.
 *
 * Both directions move together or neither is right. A planner in Zürich
 * editing a Lisbon trip reads "Times are in Europe/Lisbon" above this form: if
 * the field is filled from their own clock they see 10:14 for the 09:14 train,
 * and if it is read back against their own clock every save of an untouched
 * form moves the item an hour. `toZonedInputValue` and `isoFromZonedInput`
 * (`shared/utils/timezone.ts`) are the pair, and with no zone they are exactly
 * what this file did before.
 *
 * What is sent is still an ISO INSTANT. Nothing about storage changes here.
 */
function toLocalInput(value: string | Date | null): string {
  return toZonedInputValue(value, props.timezone)
}

function fromLocalInput(value: string): string | null {
  return value ? isoFromZonedInput(value, props.timezone) : null
}

async function addItem() {
  if (!itemTitle.value) return
  adding.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/timeline`, {
      method: 'POST',
      body: {
        title: itemTitle.value,
        type: itemType.value,
        startsAt: fromLocalInput(itemWhen.value),
        location: itemLocation.value || null,
        placeId: itemPlaceId.value || null
      }
    })
    itemTitle.value = ''
    itemWhen.value = ''
    itemLocation.value = ''
    itemPlaceId.value = PLACE_NONE
    emit('updated')
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not add that', color: 'error' })
  } finally {
    adding.value = false
  }
}

async function removeItem(id: string) {
  await $fetch(`/api/host/events/${props.slug}/timeline/${id}`, { method: 'DELETE' })
  emit('updated')
}

/* ---- edit in place ---- */
const editingId = ref<string | null>(null)
const saving = ref(false)
const draft = reactive({ title: '', type: 'other', when: '', location: '', description: '', placeId: PLACE_NONE })

function startEdit(item: TimelineItem) {
  editingId.value = item.id
  draft.title = item.title
  draft.type = item.type
  draft.when = toLocalInput(item.startsAt)
  draft.location = item.location ?? ''
  draft.description = item.description ?? ''
  draft.placeId = item.placeId ?? PLACE_NONE
}

async function saveEdit(id: string) {
  if (!draft.title) return
  saving.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/timeline/${id}`, {
      method: 'PATCH',
      body: {
        title: draft.title,
        type: draft.type,
        startsAt: fromLocalInput(draft.when),
        location: draft.location || null,
        description: draft.description || null,
        placeId: draft.placeId || null
      }
    })
    editingId.value = null
    emit('updated')
    toast.add({ title: 'Updated', color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not save that', color: 'error' })
  } finally {
    saving.value = false
  }
}

/**
 * Moving is ONE request, and the server renumbers the itinerary.
 *
 * It used to be two `sortOrder` PATCHes from here. If the second one did not
 * land, the item and its neighbour were left sharing a number — and every
 * attempt after that computed the same number for both, answered 200 twice and
 * moved nothing, so the arrows went dead for that pair with no error to show
 * for it. `applyTimelineItemMove` renumbers in one statement, which cannot
 * half-apply and clears any tie already there.
 */
const moving = ref<string | null>(null)
async function move(id: string, direction: 'up' | 'down') {
  moving.value = id
  try {
    await $fetch(`/api/host/events/${props.slug}/timeline/${id}/move`, { method: 'POST', body: { direction } })
    emit('updated')
  } catch {
    toast.add({ title: 'Could not reorder', color: 'error' })
  } finally {
    moving.value = null
  }
}

function placeName(id: string): string | undefined {
  return props.places.find(p => p.id === id)?.name
}

function when(iso: string | Date | null): string | null {
  return formatInZone(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, props.timezone)
}

/** Named once above the list, for the same reason it is on the guest card. */
const zoneLine = computed(() => zoneNote(props.timezone))
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          {{ trip ? '🧳 Itinerary' : 'The plan' }}
        </p>
        <p class="text-sm text-muted">
          {{ trip ? 'Travel, accommodation, activities — grouped by day on the guest page.' : 'Doors, food, the main thing.' }}
        </p>
        <p
          v-if="zoneLine"
          class="text-xs text-muted mt-0.5"
        >
          🕓 {{ zoneLine }} — type them as they are there.
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-2">
      <div
        v-for="(item, index) in timeline"
        :key="item.id"
        class="py-1.5 border-b border-default last:border-b-0 text-sm"
      >
        <form
          v-if="editingId === item.id"
          class="flex flex-col gap-2 py-1"
          @submit.prevent="saveEdit(item.id)"
        >
          <div class="flex flex-col sm:flex-row gap-2">
            <USelect
              v-model="draft.type"
              :items="TYPE_ITEMS"
              class="sm:w-44"
            />
            <UInput
              v-model="draft.title"
              placeholder="Title"
              class="flex-1"
            />
            <UInput
              v-model="draft.when"
              type="datetime-local"
              class="sm:w-52"
            />
          </div>
          <UInput
            v-model="draft.location"
            placeholder="Where (optional)"
          />
          <USelect
            v-if="places.length"
            v-model="draft.placeId"
            :items="placeItems"
          />
          <UTextarea
            v-model="draft.description"
            :rows="2"
            placeholder="Details (optional)"
          />
          <div class="flex gap-2">
            <UButton
              type="submit"
              size="xs"
              :loading="saving"
              :disabled="!draft.title"
            >
              Save
            </UButton>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              @click="editingId = null"
            >
              Cancel
            </UButton>
          </div>
        </form>

        <div
          v-else
          class="flex items-center justify-between gap-2"
        >
          <p class="min-w-0 truncate">
            {{ TYPE_ICONS[item.type] || '📍' }}
            <span
              v-if="when(item.startsAt)"
              class="text-muted tabular-nums mr-1"
            >{{ when(item.startsAt) }}</span>
            <span class="font-medium">{{ item.title }}</span>
            <span
              v-if="item.placeId && placeName(item.placeId)"
              class="text-muted"
            > · 📍 {{ placeName(item.placeId) }}</span>
            <span
              v-else-if="item.location"
              class="text-muted"
            > · {{ item.location }}</span>
          </p>
          <div class="flex items-center gap-0.5 shrink-0">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :disabled="index === 0 || moving === item.id"
              aria-label="Move up"
              @click="move(item.id, 'up')"
            >
              ↑
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :disabled="index === timeline.length - 1 || moving === item.id"
              aria-label="Move down"
              @click="move(item.id, 'down')"
            >
              ↓
            </UButton>
            <UButton
              size="xs"
              variant="ghost"
              @click="startEdit(item)"
            >
              Edit
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Remove"
              @click="removeItem(item.id)"
            >
              ✕
            </UButton>
          </div>
        </div>
      </div>

      <form
        class="flex flex-col sm:flex-row gap-2 pt-2"
        @submit.prevent="addItem"
      >
        <USelect
          v-model="itemType"
          :items="TYPE_ITEMS"
          class="sm:w-44"
        />
        <UInput
          v-model="itemTitle"
          placeholder="Zug → Lugano, IR 2313"
          class="flex-1"
        />
        <UInput
          v-model="itemWhen"
          type="datetime-local"
          class="sm:w-52"
        />
        <USelect
          v-if="places.length"
          v-model="itemPlaceId"
          :items="placeItems"
          class="sm:w-44"
        />
        <UButton
          type="submit"
          :loading="adding"
          :disabled="!itemTitle"
        >
          Add
        </UButton>
      </form>
    </div>
  </UCard>
</template>
