<script setup lang="ts">
import { z } from 'zod'

interface Props {
  slug: string
  /** Show planner controls (add / edit / delete items, pin media). */
  isPlanner?: boolean
  /** Assignable RSVPs — planner only, for timeline-media attachment. */
  attendees?: Array<{ id: string, label: string }>
}

const props = withDefaults(defineProps<Props>(), {
  isPlanner: false,
  attendees: () => []
})

const emit = defineEmits<{
  /** Emitted after any create / update / delete so the parent can refresh derived data. */
  change: []
}>()

const toast = useToast()

type TimelineItemType = 'transport' | 'activity' | 'accommodation' | 'meal' | 'other'

interface AttachedMedia {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  fileName: string
  caption: string | null
  mimeType: string
  sizeBytes: number
  timelineItemId: string | null
  url: string | null
}

interface TimelineItemRow {
  id: string
  eventId: string
  title: string
  description: string | null
  startsAt: string | null
  endsAt: string | null
  location: string | null
  type: TimelineItemType
  icon: string | null
  sortOrder: number
  pollId: string | null
  createdAt: string
  updatedAt: string
  attachedMedia: AttachedMedia[]
}

const { data, refresh, status } = await useFetch<{ timeline: TimelineItemRow[] }>(
  `/api/events/${props.slug}/timeline`,
  { default: () => ({ timeline: [] }) }
)

const items = computed(() => data.value?.timeline ?? [])

// --- Type icon / label helpers ---
const TYPE_ICON: Record<TimelineItemType, string> = {
  transport: 'i-lucide-train-front',
  activity: 'i-lucide-zap',
  accommodation: 'i-lucide-bed-double',
  meal: 'i-lucide-utensils',
  other: 'i-lucide-calendar-check'
}

const TYPE_LABEL: Record<TimelineItemType, string> = {
  transport: 'Transport',
  activity: 'Activity',
  accommodation: 'Accommodation',
  meal: 'Meal',
  other: 'Other'
}

function itemIcon(item: TimelineItemRow): string {
  if (item.icon) return item.icon
  return TYPE_ICON[item.type] ?? 'i-lucide-calendar-check'
}

function formatDate(d: string | null): string | null {
  if (!d) return null
  return new Date(d).toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' })
}

function mediaIcon(m: AttachedMedia): string {
  if (m.type === 'ticket') return 'i-lucide-ticket'
  if (m.type === 'document') return 'i-lucide-file-text'
  if (m.type === 'video') return 'i-lucide-video'
  return 'i-lucide-image'
}

// ---- Add item form ----
const addOpen = ref(false)
const addLoading = ref(false)

const addSchema = z.object({
  title: z.string().min(1, 'Title is required').max(300),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']),
  description: z.string().max(5000).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().max(500).optional()
})
type AddSchema = z.output<typeof addSchema>

const addState = reactive<Partial<AddSchema>>({ type: 'other' })

const typeOptions = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))

async function addItem() {
  addLoading.value = true
  try {
    const payload: Record<string, unknown> = {
      title: addState.title,
      type: addState.type,
      description: addState.description || null,
      location: addState.location || null
    }
    if (addState.startsAt) payload.startsAt = new Date(addState.startsAt).toISOString()
    if (addState.endsAt) payload.endsAt = new Date(addState.endsAt).toISOString()

    await $fetch(`/api/events/${props.slug}/timeline`, { method: 'POST', body: payload })
    await refresh()
    addOpen.value = false
    addState.title = undefined
    addState.type = 'other'
    addState.description = undefined
    addState.startsAt = undefined
    addState.endsAt = undefined
    addState.location = undefined
    emit('change')
    toast.add({ title: 'Item added', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to add item', color: 'error' })
  } finally {
    addLoading.value = false
  }
}

// ---- Edit item form ----
const editOpen = ref(false)
const editTarget = ref<TimelineItemRow | null>(null)
const editLoading = ref(false)

const editSchema = z.object({
  title: z.string().min(1, 'Title is required').max(300),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']),
  description: z.string().max(5000).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().max(500).optional()
})
type EditSchema = z.output<typeof editSchema>

const editState = reactive<Partial<EditSchema>>({})

function openEdit(item: TimelineItemRow) {
  editTarget.value = item
  editState.title = item.title
  editState.type = item.type
  editState.description = item.description ?? ''
  editState.startsAt = item.startsAt
    ? new Date(item.startsAt).toISOString().slice(0, 16)
    : undefined
  editState.endsAt = item.endsAt
    ? new Date(item.endsAt).toISOString().slice(0, 16)
    : undefined
  editState.location = item.location ?? ''
  editOpen.value = true
}

async function saveEdit() {
  if (!editTarget.value) return
  editLoading.value = true
  try {
    const payload: Record<string, unknown> = {
      title: editState.title,
      type: editState.type,
      description: editState.description || null,
      location: editState.location || null,
      startsAt: editState.startsAt ? new Date(editState.startsAt).toISOString() : null,
      endsAt: editState.endsAt ? new Date(editState.endsAt).toISOString() : null
    }

    await $fetch(`/api/events/${props.slug}/timeline/${editTarget.value.id}`, {
      method: 'PATCH',
      body: payload
    })
    await refresh()
    editOpen.value = false
    emit('change')
    toast.add({ title: 'Item updated', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to update item', color: 'error' })
  } finally {
    editLoading.value = false
  }
}

// ---- Delete item ----
async function deleteItem(item: TimelineItemRow) {
  if (!confirm(`Delete "${item.title}"?`)) return
  try {
    await $fetch(`/api/events/${props.slug}/timeline/${item.id}`, { method: 'DELETE' })
    await refresh()
    emit('change')
    toast.add({ title: 'Item deleted', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to delete', color: 'error' })
  }
}

// ---- Move item (reorder) ----
async function moveItem(item: TimelineItemRow, direction: 'up' | 'down') {
  const list = items.value
  const idx = list.findIndex(i => i.id === item.id)
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= list.length) return

  const sibling = list[swapIdx]
  if (!sibling) return
  // Swap sortOrders
  try {
    await Promise.all([
      $fetch(`/api/events/${props.slug}/timeline/${item.id}`, {
        method: 'PATCH',
        body: { sortOrder: sibling.sortOrder }
      }),
      $fetch(`/api/events/${props.slug}/timeline/${sibling.id}`, {
        method: 'PATCH',
        body: { sortOrder: item.sortOrder }
      })
    ])
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to reorder', color: 'error' })
  }
}

// ---- Unpin media from timeline item ----
async function unpinMedia(item: TimelineItemRow, m: AttachedMedia) {
  try {
    await $fetch(`/api/events/${props.slug}/media/${m.id}`, {
      method: 'PATCH',
      body: { timelineItemId: null }
    })
    await refresh()
    toast.add({ title: 'Unpinned', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to unpin', color: 'error' })
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">
          Timeline
        </h2>
        <UButton
          v-if="isPlanner"
          size="sm"
          icon="i-lucide-plus"
          label="Add item"
          variant="ghost"
          @click="addOpen = true"
        />
      </div>
    </template>

    <div
      v-if="status === 'pending'"
      class="text-sm text-muted py-2"
    >
      Loading…
    </div>

    <div
      v-else-if="!items.length"
      class="text-sm text-muted py-2"
    >
      No timeline items yet.
      <template v-if="isPlanner">
        Add the first one above.
      </template>
    </div>

    <div
      v-else
      class="relative"
    >
      <!-- Vertical line -->
      <div class="absolute left-4 top-0 bottom-0 w-px bg-[var(--color-border-default)]" />

      <ul class="space-y-6">
        <li
          v-for="(item, idx) in items"
          :key="item.id"
          class="relative flex gap-4"
          :class="item.pollId ? 'opacity-70' : ''"
        >
          <!-- Icon dot -->
          <div class="shrink-0 z-10 flex items-center justify-center size-8 rounded-full bg-[var(--color-bg-default)] border border-[var(--color-border-default)] ring-2 ring-[var(--color-bg-default)]">
            <UIcon
              :name="itemIcon(item)"
              class="size-4 text-primary"
            />
          </div>

          <!-- Content -->
          <div class="flex-1 min-w-0 pb-2">
            <div class="flex items-start justify-between gap-2 flex-wrap">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-sm">{{ item.title }}</span>
                  <UBadge
                    size="xs"
                    color="neutral"
                    variant="outline"
                  >
                    {{ TYPE_LABEL[item.type] }}
                  </UBadge>
                  <!-- Alternative / poll badge -->
                  <UBadge
                    v-if="item.pollId"
                    size="xs"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-help-circle"
                  >
                    Pending poll decision
                  </UBadge>
                </div>

                <!-- Date / time -->
                <p
                  v-if="item.startsAt"
                  class="text-xs text-muted mt-0.5"
                >
                  <UIcon
                    name="i-lucide-clock"
                    class="size-3 inline-block mr-0.5"
                  />
                  {{ formatDate(item.startsAt) }}
                  <template v-if="item.endsAt">
                    — {{ formatDate(item.endsAt) }}
                  </template>
                </p>

                <!-- Location -->
                <p
                  v-if="item.location"
                  class="text-xs text-muted mt-0.5"
                >
                  <UIcon
                    name="i-lucide-map-pin"
                    class="size-3 inline-block mr-0.5"
                  />
                  {{ item.location }}
                </p>

                <!-- Description -->
                <p
                  v-if="item.description"
                  class="text-sm mt-1 whitespace-pre-wrap text-muted"
                >
                  {{ item.description }}
                </p>

                <!-- Attached media -->
                <div
                  v-if="item.attachedMedia.length"
                  class="mt-2 flex flex-wrap gap-1.5"
                >
                  <template
                    v-for="m in item.attachedMedia"
                    :key="m.id"
                  >
                    <div class="flex items-center gap-1 bg-elevated rounded px-2 py-0.5 text-xs">
                      <UIcon
                        :name="mediaIcon(m)"
                        class="size-3 text-muted shrink-0"
                      />
                      <a
                        v-if="m.url"
                        :href="m.url"
                        target="_blank"
                        rel="noopener"
                        class="hover:text-primary max-w-[160px] truncate"
                      >{{ m.caption || m.fileName }}</a>
                      <span
                        v-else
                        class="max-w-[160px] truncate"
                      >{{ m.caption || m.fileName }}</span>
                      <UButton
                        v-if="isPlanner"
                        icon="i-lucide-x"
                        size="xs"
                        variant="ghost"
                        color="error"
                        class="-mr-1"
                        @click="unpinMedia(item, m)"
                      />
                    </div>
                  </template>
                </div>
              </div>

              <!-- Planner actions -->
              <div
                v-if="isPlanner"
                class="flex items-center gap-0.5 shrink-0"
              >
                <UButton
                  icon="i-lucide-chevron-up"
                  variant="ghost"
                  size="xs"
                  :disabled="idx === 0"
                  @click="moveItem(item, 'up')"
                />
                <UButton
                  icon="i-lucide-chevron-down"
                  variant="ghost"
                  size="xs"
                  :disabled="idx === items.length - 1"
                  @click="moveItem(item, 'down')"
                />
                <UButton
                  icon="i-lucide-pencil"
                  variant="ghost"
                  size="xs"
                  @click="openEdit(item)"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  size="xs"
                  color="error"
                  @click="deleteItem(item)"
                />
              </div>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <!-- Add item modal -->
    <UModal
      v-model:open="addOpen"
      title="Add timeline item"
    >
      <template #body>
        <UForm
          :schema="addSchema"
          :state="addState"
          class="space-y-4 p-1"
          @submit="addItem"
        >
          <UFormField
            label="Title"
            name="title"
            required
          >
            <UInput
              v-model="addState.title"
              class="w-full"
              placeholder="e.g. Train Zürich → Basel"
            />
          </UFormField>

          <UFormField
            label="Type"
            name="type"
          >
            <USelectMenu
              v-model="addState.type"
              :items="typeOptions"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              label="Start"
              name="startsAt"
            >
              <UInput
                v-model="addState.startsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="End"
              name="endsAt"
            >
              <UInput
                v-model="addState.endsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            label="Location"
            name="location"
          >
            <UInput
              v-model="addState.location"
              class="w-full"
              placeholder="e.g. Basel SBB"
            />
          </UFormField>

          <UFormField
            label="Description"
            name="description"
          >
            <UTextarea
              v-model="addState.description"
              :rows="3"
              class="w-full"
            />
          </UFormField>

          <div class="flex justify-end gap-2 pt-2">
            <UButton
              variant="ghost"
              label="Cancel"
              @click="addOpen = false"
            />
            <UButton
              type="submit"
              :loading="addLoading"
              label="Add"
            />
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Edit item modal -->
    <UModal
      v-model:open="editOpen"
      title="Edit timeline item"
    >
      <template #body>
        <UForm
          :schema="editSchema"
          :state="editState"
          class="space-y-4 p-1"
          @submit="saveEdit"
        >
          <UFormField
            label="Title"
            name="title"
            required
          >
            <UInput
              v-model="editState.title"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Type"
            name="type"
          >
            <USelectMenu
              v-model="editState.type"
              :items="typeOptions"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              label="Start"
              name="startsAt"
            >
              <UInput
                v-model="editState.startsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="End"
              name="endsAt"
            >
              <UInput
                v-model="editState.endsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            label="Location"
            name="location"
          >
            <UInput
              v-model="editState.location"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Description"
            name="description"
          >
            <UTextarea
              v-model="editState.description"
              :rows="3"
              class="w-full"
            />
          </UFormField>

          <div class="flex justify-end gap-2 pt-2">
            <UButton
              variant="ghost"
              label="Cancel"
              @click="editOpen = false"
            />
            <UButton
              type="submit"
              :loading="editLoading"
              label="Save"
            />
          </div>
        </UForm>
      </template>
    </UModal>
  </UCard>
</template>
