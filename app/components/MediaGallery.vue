<script setup lang="ts">
/**
 * Event media gallery.
 *
 * - Planner mode (`rsvpToken === undefined`): shows every media item,
 *   including all tickets. Planner can assign tickets to attendees,
 *   edit any caption, and delete any item.
 * - Guest mode (`rsvpToken` provided): shows the public timeline plus
 *   the single ticket assigned to the viewer's RSVP. The guest can
 *   edit/delete their own uploads.
 */
interface Props {
  slug: string
  /** Pass to render in guest mode. */
  rsvpToken?: string
  /** Assignable RSVPs — planner only, for ticket assignment dropdown. */
  attendees?: Array<{ id: string, label: string }>
  /** Timeline items — planner only, for pinning media to a timeline point. */
  timelineItems?: Array<{ id: string, title: string }>
  /** Hide the upload button (e.g., when event is cancelled/draft for guests). */
  canUpload?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  rsvpToken: undefined,
  attendees: () => [],
  timelineItems: () => [],
  canUpload: true
})

const toast = useToast()
const { upload, detectType } = useMediaUpload()

const isPlanner = computed(() => !props.rsvpToken)

interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  status: 'pending' | 'ready'
  storageKey: string
  mimeType: string
  sizeBytes: number
  fileName: string
  caption: string | null
  takenAt: string | null
  uploadedByUserId: string | null
  uploadedByRsvpId: string | null
  assignedRsvpId: string | null
  timelineItemId: string | null
  createdAt: string
  uploadedByUserName: string | null
  uploadedByUserEmail: string | null
  url: string | null
}

const listUrl = computed(() => {
  const base = `/api/events/${props.slug}/media`
  return props.rsvpToken ? `${base}?rsvpToken=${encodeURIComponent(props.rsvpToken)}` : base
})

const { data, refresh, status } = await useFetch<{ media: MediaItem[] }>(
  () => listUrl.value,
  { default: () => ({ media: [] }) }
)

const photosAndVideos = computed(() => data.value?.media.filter(m => m.type === 'photo' || m.type === 'video') ?? [])
const documents = computed(() => data.value?.media.filter(m => m.type === 'document') ?? [])
const tickets = computed(() => data.value?.media.filter(m => m.type === 'ticket') ?? [])

// ---------- Upload ----------
const uploadingCount = ref(0)
const photoInput = ref<HTMLInputElement | null>(null)
const documentInput = ref<HTMLInputElement | null>(null)
const ticketInput = ref<HTMLInputElement | null>(null)

async function handleFiles(files: FileList | null, forcedType?: 'document' | 'ticket') {
  if (!files || files.length === 0) return
  const arr = Array.from(files)
  uploadingCount.value += arr.length
  try {
    await Promise.all(arr.map(async (file) => {
      try {
        const type = forcedType ?? detectType(file)
        let takenAt: string | null = null
        if (type === 'photo' || type === 'video') {
          // Use lastModified as a heuristic for takenAt — better than nothing
          // for timeline sort; real EXIF extraction is icebox material.
          takenAt = new Date(file.lastModified).toISOString()
        }
        await upload({
          file,
          type,
          eventSlug: props.rsvpToken ? undefined : props.slug,
          rsvpToken: props.rsvpToken,
          takenAt
        })
      } catch (err: unknown) {
        const e = err as { data?: { message?: string }, message?: string }
        toast.add({
          title: `Upload failed: ${file.name}`,
          description: e?.data?.message ?? e?.message ?? 'Unknown error',
          color: 'error'
        })
      }
    }))
    await refresh()
  } finally {
    uploadingCount.value -= arr.length
  }
}

function onPhotoChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  handleFiles(input.files)
  input.value = ''
}
function onDocumentChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  handleFiles(input.files, 'document')
  input.value = ''
}
function onTicketChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  handleFiles(input.files, 'ticket')
  input.value = ''
}

// ---------- Edit caption ----------
const editOpen = ref(false)
const editTarget = ref<MediaItem | null>(null)
const editCaption = ref('')
const editAssignedRsvpId = ref<string | null>(null)
const editTimelineItemId = ref<string | null>(null)
const editLoading = ref(false)

function openEdit(m: MediaItem) {
  editTarget.value = m
  editCaption.value = m.caption ?? ''
  editAssignedRsvpId.value = m.assignedRsvpId ?? null
  editTimelineItemId.value = m.timelineItemId ?? null
  editOpen.value = true
}

async function saveEdit() {
  if (!editTarget.value) return
  editLoading.value = true
  try {
    const body: Record<string, unknown> = { caption: editCaption.value || null }
    if (isPlanner.value && editTarget.value.type === 'ticket') {
      body.assignedRsvpId = editAssignedRsvpId.value
    }
    if (isPlanner.value) {
      body.timelineItemId = editTimelineItemId.value
    }
    if (props.rsvpToken) body.rsvpToken = props.rsvpToken
    await $fetch(`/api/events/${props.slug}/media/${editTarget.value.id}`, {
      method: 'PATCH',
      body
    })
    await refresh()
    editOpen.value = false
    toast.add({ title: 'Saved', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to save', color: 'error' })
  } finally {
    editLoading.value = false
  }
}

async function removeItem(m: MediaItem) {
  if (!confirm(`Delete "${m.caption || m.fileName}"?`)) return
  try {
    const url = props.rsvpToken
      ? `/api/events/${props.slug}/media/${m.id}?rsvpToken=${encodeURIComponent(props.rsvpToken)}`
      : `/api/events/${props.slug}/media/${m.id}`
    await $fetch(url, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Deleted', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to delete', color: 'error' })
  }
}

function canEdit(m: MediaItem): boolean {
  if (isPlanner.value) return true
  // Guest can edit own uploads only. In guest mode we don't have their rsvpId
  // directly, but the server filters deletions/edits via the same token, so
  // showing the button liberally on items without an uploader user is fine —
  // the API enforces the true rule.
  return !!m.uploadedByRsvpId
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function attendeeLabel(rsvpId: string | null): string {
  if (!rsvpId) return 'Unassigned'
  return props.attendees.find(a => a.id === rsvpId)?.label ?? 'Unknown'
}

const ticketAttendeeOptions = computed(() => [
  { label: 'Unassigned', value: null as string | null },
  ...props.attendees.map(a => ({ label: a.label, value: a.id as string | null }))
])

const timelineItemOptions = computed(() => [
  { label: 'Not pinned', value: null as string | null },
  ...props.timelineItems.map(t => ({ label: t.title, value: t.id as string | null }))
])
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between flex-wrap gap-2">
        <h2 class="font-semibold">
          Media
        </h2>
        <div
          v-if="canUpload"
          class="flex items-center gap-1"
        >
          <UButton
            size="sm"
            icon="i-lucide-image-plus"
            variant="ghost"
            label="Photo / video"
            :loading="uploadingCount > 0"
            @click="photoInput?.click()"
          />
          <UButton
            size="sm"
            icon="i-lucide-file-plus"
            variant="ghost"
            label="Document"
            :loading="uploadingCount > 0"
            @click="documentInput?.click()"
          />
          <UButton
            v-if="isPlanner"
            size="sm"
            icon="i-lucide-ticket"
            variant="ghost"
            label="Ticket"
            :loading="uploadingCount > 0"
            @click="ticketInput?.click()"
          />
        </div>
      </div>
      <input
        ref="photoInput"
        type="file"
        accept="image/*,video/*"
        multiple
        class="hidden"
        @change="onPhotoChange"
      >
      <input
        ref="documentInput"
        type="file"
        accept="application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,text/*"
        multiple
        class="hidden"
        @change="onDocumentChange"
      >
      <input
        ref="ticketInput"
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        multiple
        class="hidden"
        @change="onTicketChange"
      >
    </template>

    <div
      v-if="status === 'pending'"
      class="text-sm text-muted py-2"
    >
      Loading…
    </div>

    <div
      v-else-if="!data?.media.length"
      class="text-sm text-muted py-2"
    >
      No media yet. Upload photos, videos, or documents above.
    </div>

    <div
      v-else
      class="space-y-6"
    >
      <!-- Photos / videos timeline -->
      <section v-if="photosAndVideos.length">
        <h3 class="text-xs uppercase tracking-wide text-muted mb-2">
          Timeline
        </h3>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          <div
            v-for="m in photosAndVideos"
            :key="m.id"
            class="group relative aspect-square bg-elevated rounded overflow-hidden"
          >
            <a
              v-if="m.url"
              :href="m.url"
              target="_blank"
              rel="noopener"
              class="block w-full h-full"
            >
              <img
                v-if="m.type === 'photo'"
                :src="m.url"
                :alt="m.caption ?? m.fileName"
                loading="lazy"
                class="w-full h-full object-cover"
              >
              <video
                v-else
                :src="m.url"
                class="w-full h-full object-cover"
                preload="metadata"
              />
            </a>
            <div class="absolute inset-x-0 bottom-0 p-1.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <p
                v-if="m.caption"
                class="text-xs text-white truncate"
              >
                {{ m.caption }}
              </p>
            </div>
            <div class="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <UButton
                v-if="canEdit(m)"
                icon="i-lucide-pencil"
                size="xs"
                variant="solid"
                color="neutral"
                @click.prevent="openEdit(m)"
              />
              <UButton
                v-if="canEdit(m)"
                icon="i-lucide-trash-2"
                size="xs"
                variant="solid"
                color="error"
                @click.prevent="removeItem(m)"
              />
            </div>
          </div>
        </div>
      </section>

      <!-- Documents -->
      <section v-if="documents.length">
        <h3 class="text-xs uppercase tracking-wide text-muted mb-2">
          Documents
        </h3>
        <ul class="divide-y divide-default">
          <li
            v-for="m in documents"
            :key="m.id"
            class="py-2 flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-file-text"
              class="size-4 text-muted shrink-0"
            />
            <div class="min-w-0 flex-1">
              <a
                v-if="m.url"
                :href="m.url"
                target="_blank"
                rel="noopener"
                class="text-sm font-medium hover:text-primary truncate block"
              >
                {{ m.caption || m.fileName }}
              </a>
              <p class="text-xs text-muted">
                {{ formatSize(m.sizeBytes) }} ·
                {{ new Date(m.createdAt).toLocaleDateString('en-CH') }}
              </p>
            </div>
            <UButton
              v-if="canEdit(m)"
              icon="i-lucide-pencil"
              variant="ghost"
              size="xs"
              @click="openEdit(m)"
            />
            <UButton
              v-if="canEdit(m)"
              icon="i-lucide-trash-2"
              variant="ghost"
              size="xs"
              color="error"
              @click="removeItem(m)"
            />
          </li>
        </ul>
      </section>

      <!-- Tickets -->
      <section v-if="tickets.length">
        <h3 class="text-xs uppercase tracking-wide text-muted mb-2">
          Tickets
        </h3>
        <ul class="divide-y divide-default">
          <li
            v-for="m in tickets"
            :key="m.id"
            class="py-2 flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-ticket"
              class="size-4 text-muted shrink-0"
            />
            <div class="min-w-0 flex-1">
              <a
                v-if="m.url"
                :href="m.url"
                target="_blank"
                rel="noopener"
                class="text-sm font-medium hover:text-primary truncate block"
              >
                {{ m.caption || m.fileName }}
              </a>
              <p class="text-xs text-muted">
                {{ formatSize(m.sizeBytes) }} ·
                <span v-if="isPlanner">→ {{ attendeeLabel(m.assignedRsvpId) }}</span>
                <span v-else-if="m.assignedRsvpId">assigned to you</span>
              </p>
            </div>
            <UButton
              v-if="isPlanner"
              icon="i-lucide-pencil"
              variant="ghost"
              size="xs"
              @click="openEdit(m)"
            />
            <UButton
              v-if="isPlanner"
              icon="i-lucide-trash-2"
              variant="ghost"
              size="xs"
              color="error"
              @click="removeItem(m)"
            />
          </li>
        </ul>
      </section>
    </div>

    <UModal
      v-model:open="editOpen"
      title="Edit media"
    >
      <template #body>
        <div class="space-y-4 p-1">
          <UFormField label="Caption">
            <UTextarea
              v-model="editCaption"
              :rows="2"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="isPlanner && editTarget?.type === 'ticket'"
            label="Assigned to"
            help="Ticket is visible only to this attendee."
          >
            <USelectMenu
              v-model="editAssignedRsvpId"
              :items="ticketAttendeeOptions"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="isPlanner && timelineItemOptions.length > 1"
            label="Pin to timeline item"
            help="Makes this file appear on the itinerary."
          >
            <USelectMenu
              v-model="editTimelineItemId"
              :items="timelineItemOptions"
              value-key="value"
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
              :loading="editLoading"
              label="Save"
              @click="saveEdit"
            />
          </div>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
