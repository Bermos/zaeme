<script setup lang="ts">
/**
 * The itinerary of one event, inline on `/admin/events` — the owner-side editor
 * asked for in issue #8.
 *
 * It exists because the owner is not necessarily a planner of every event on
 * their instance: "Manage" goes to `/host/<slug>`, which answers 403 to an
 * owner who does not plan that one, so a typo in somebody else's itinerary was
 * unreachable from the surface that could see it. Reads and writes go to
 * `/api/admin/events/:slug/timeline`, behind the owner gate.
 *
 * Correcting and re-ordering only. Adding and removing items belong to the
 * people planning the event, on `/host`.
 */
interface TimelineItem {
  id: string
  title: string
  description: string | null
  startsAt: string | null
  location: string | null
  type: string
  sortOrder: number | null
}

const props = withDefaults(
  defineProps<{
    slug: string
    /**
     * The event's display zone (#31), from the row this editor is nested in.
     *
     * IT IS NOT OPTIONAL POLISH HERE. This component edits the SAME column
     * `HostTimelineCard` edits, so if one of them reads `09:14` against Lisbon
     * and the other against the owner's own clock, a correction made from
     * `/admin` moves the item by the difference — and `/admin` exists precisely
     * for the events the owner does not plan and cannot check on `/host`.
     */
    timezone?: string | null
  }>(),
  { timezone: null }
)

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

const items = ref<TimelineItem[]>([])
const pending = ref(true)

async function load() {
  pending.value = true
  try {
    const res = await $fetch(`/api/admin/events/${props.slug}/timeline`)
    items.value = res.timeline as unknown as TimelineItem[]
  } catch (e) {
    toast.add({ title: message(e, 'Could not load that itinerary'), color: 'error' })
  } finally {
    pending.value = false
  }
}
onMounted(load)

function message(e: unknown, fallback: string): string {
  return (e as { data?: { message?: string } }).data?.message ?? fallback
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm`, on the EVENT's clock (#31). */
function toLocalInput(value: string | null): string {
  return toZonedInputValue(value, props.timezone)
}

function when(iso: string | null): string | null {
  return formatInZone(iso, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, props.timezone)
}

const zoneLine = computed(() => zoneNote(props.timezone))

const editingId = ref<string | null>(null)
const saving = ref(false)
const draft = reactive({ title: '', type: 'other', when: '', location: '', description: '' })

function startEdit(item: TimelineItem) {
  editingId.value = item.id
  draft.title = item.title
  draft.type = item.type
  draft.when = toLocalInput(item.startsAt)
  draft.location = item.location ?? ''
  draft.description = item.description ?? ''
}

async function saveEdit(id: string) {
  if (!draft.title) return
  saving.value = true
  try {
    await $fetch(`/api/admin/events/${props.slug}/timeline/${id}`, {
      method: 'PATCH',
      body: {
        title: draft.title,
        type: draft.type,
        startsAt: draft.when ? isoFromZonedInput(draft.when, props.timezone) : null,
        location: draft.location || null,
        description: draft.description || null
      }
    })
    editingId.value = null
    await load()
    toast.add({ title: 'Updated', color: 'success' })
  } catch (e) {
    toast.add({ title: message(e, 'Could not save that'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/**
 * Moving is ONE request, and the server renumbers the itinerary.
 *
 * It used to be two `sortOrder` PATCHes from here — swap the item's number with
 * its neighbour's. When the second one did not land the pair was left sharing a
 * number, and every attempt after that wrote the same number to both, answered
 * 200 twice and moved nothing: the arrows died for that pair without a word.
 * With no add and no delete on this surface, and `/host` 403ing the very owner
 * who needs it, there was nothing to recover with.
 */
const moving = ref<string | null>(null)
async function move(id: string, direction: 'up' | 'down') {
  moving.value = id
  try {
    const res = await $fetch(`/api/admin/events/${props.slug}/timeline/${id}/move`, {
      method: 'POST',
      body: { direction }
    })
    items.value = res.timeline as unknown as TimelineItem[]
  } catch (e) {
    toast.add({ title: message(e, 'Could not reorder'), color: 'error' })
  } finally {
    moving.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-1 py-2">
    <p
      v-if="zoneLine && !pending"
      class="text-xs text-muted"
    >
      🕓 {{ zoneLine }} — type them as they are there.
    </p>
    <p
      v-if="pending"
      class="text-muted text-sm"
    >
      Loading the itinerary…
    </p>
    <p
      v-else-if="!items.length"
      class="text-muted text-sm"
    >
      No itinerary on this one yet. Items are added from
      <ULink :to="`/host/${slug}`">
        the host page
      </ULink>.
    </p>

    <div
      v-for="(item, index) in items"
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
            v-if="item.location"
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
            :disabled="index === items.length - 1 || moving === item.id"
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
        </div>
      </div>
    </div>
  </div>
</template>
