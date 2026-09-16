<script setup lang="ts">
import type { TicketDetailFields } from '#shared/utils/ticket-detail'

/**
 * Event media, split by handling class (they are different things):
 *  - the GALLERY — photos & videos, the social memory of the event; anyone
 *    on the event can add to it;
 *  - the PAPERS — documents (reservations, itineraries) shown as a file list,
 *    and the viewer's own tickets, kept apart and prominent — each with what
 *    it SAYS rendered as text beside the download (#35), because at a barrier
 *    you need the seat before the PDF finishes.
 * Upload is the two-step presign → PUT → confirm dance.
 */
interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  mimeType: string
  fileName: string
  caption: string | null
  /** What the ticket says (#35) — null for everything else, and for a bare PDF. */
  ticket?: TicketDetailFields | null
  url: string
}

const props = defineProps<{
  gallery: MediaItem[]
  documents: MediaItem[]
  tickets: MediaItem[]
  /**
   * The event's display zone (#31), for the validity of a ticket. `null` means
   * the reader's own clock, which is what every screen does without one.
   *
   * REQUIRED, AND NOT OPTIONAL WITH A DEFAULT — the difference is the whole of
   * whether the clock half of #35 works. `formatInZone` falls back to the
   * ambient zone for `undefined` BY DESIGN (a stored zone ICU stops resolving
   * must not take an SSR'd page down), so an omitted prop renders every
   * attendee's ticket against the reader's clock and says nothing at all: the
   * #77 review deleted the one binding on the guest page and got eslint clean,
   * typecheck clean, 426 vitest passed and 731 smoke checks passed, with a
   * Lisbon ticket reading 00:59 the next morning in Zürich. Required means
   * `nuxt typecheck` refuses the omission at the call site; `null` is how a
   * caller SAYS "the reader's own", which is a different statement from
   * forgetting.
   */
  timezone: string | null
  /** Presign/confirm endpoints; absent = read-only. */
  presignUrl?: string
  confirmUrl?: string
  /** Types the viewer may upload (guests: photo/video; hosts: all four). */
  uploadTypes?: Array<MediaItem['type']>
  /** Guest identity fields appended to upload calls (invite-token surface). */
  identity?: { name: string, email: string } | null
}>()
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()
const uploading = ref(false)
const fileInput = ref<HTMLInputElement>()
const pendingType = ref<MediaItem['type']>('photo')

const canUpload = computed(() => !!props.presignUrl && !!props.confirmUrl && (props.uploadTypes?.length ?? 0) > 0)

function pick(type: MediaItem['type']) {
  pendingType.value = type
  fileInput.value?.click()
}

const ACCEPT: Record<MediaItem['type'], string> = {
  photo: 'image/*',
  video: 'video/*',
  document: '.pdf,.doc,.docx,.txt',
  ticket: '.pdf,.png,.jpg,.jpeg'
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !props.presignUrl || !props.confirmUrl) return
  uploading.value = true
  try {
    const identityFields = props.identity
      ? { guestName: props.identity.name, guestEmail: props.identity.email }
      : {}
    const { mediaId, upload } = await $fetch<{ mediaId: string, upload: { url: string, headers?: Record<string, string> } }>(
      props.presignUrl,
      {
        method: 'POST',
        body: {
          type: pendingType.value,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          ...identityFields
        }
      }
    )
    const putRes = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream', ...(upload.headers ?? {}) },
      body: file
    })
    if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`)
    await $fetch(props.confirmUrl, { method: 'POST', body: { mediaId, ...identityFields } })
    toast.add({ title: 'Uploaded 🎉', color: 'success' })
    emit('updated')
  } catch (e) {
    toast.add({
      title: (e as { data?: { message?: string } }).data?.message ?? 'Upload failed',
      color: 'error'
    })
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

const hasAnything = computed(() =>
  props.gallery.length > 0 || props.documents.length > 0 || props.tickets.length > 0
)
</script>

<template>
  <UCard v-if="hasAnything || canUpload">
    <template #header>
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          📸 Photos & files
        </p>
        <div
          v-if="canUpload"
          class="flex gap-1"
        >
          <UButton
            v-for="t in uploadTypes"
            :key="t"
            size="xs"
            variant="outline"
            :loading="uploading && pendingType === t"
            @click="pick(t)"
          >
            + {{ t }}
          </UButton>
        </div>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <!-- Your tickets — front and centre, they get you in the door -->
      <div
        v-if="tickets.length"
        class="flex flex-col gap-3"
      >
        <p class="text-sm font-medium">
          🎟️ Your tickets
        </p>
        <!--
          THE DETAILS ARE TEXT NEXT TO THE DOWNLOAD (#35), not inside it. At a
          barrier you read "coach 12, seat 41A" off the page; the PDF is what
          you show afterwards, if it has finished rendering. A ticket with
          nothing written on it renders exactly as it did before this existed —
          the button and nothing else — which is what keeps the upload from
          feeling like a form.
        -->
        <div
          v-for="t in tickets"
          :key="t.id"
          class="flex flex-col gap-1"
        >
          <UButton
            :to="t.url"
            external
            target="_blank"
            variant="soft"
            color="primary"
            class="justify-start"
          >
            {{ t.caption || t.fileName }}
          </UButton>
          <p
            v-for="(line, i) in ticketDetailLines(t.ticket, timezone)"
            :key="i"
            class="text-sm text-muted pl-1"
          >
            {{ line }}
          </p>
        </div>
      </div>

      <!-- The gallery -->
      <div
        v-if="gallery.length"
        class="grid grid-cols-2 sm:grid-cols-3 gap-2"
      >
        <a
          v-for="m in gallery"
          :key="m.id"
          :href="m.url"
          target="_blank"
          rel="noopener"
          class="block aspect-square rounded-lg overflow-hidden bg-elevated"
        >
          <img
            v-if="m.type === 'photo'"
            :src="m.url"
            :alt="m.caption || m.fileName"
            loading="lazy"
            class="w-full h-full object-cover"
          >
          <video
            v-else
            :src="m.url"
            class="w-full h-full object-cover"
            muted
            playsinline
          />
        </a>
      </div>

      <!-- Shared papers -->
      <div
        v-if="documents.length"
        class="flex flex-col gap-1"
      >
        <p class="text-sm font-medium">
          📄 Documents
        </p>
        <a
          v-for="d in documents"
          :key="d.id"
          :href="d.url"
          target="_blank"
          rel="noopener"
          class="text-sm text-primary hover:underline"
        >
          {{ d.caption || d.fileName }}
        </a>
      </div>

      <p
        v-if="!hasAnything"
        class="text-sm text-muted"
      >
        Nothing here yet{{ canUpload ? ' — add the first photo!' : '.' }}
      </p>
    </div>

    <input
      ref="fileInput"
      type="file"
      class="hidden"
      :accept="ACCEPT[pendingType]"
      @change="onFile"
    >
  </UCard>
</template>
