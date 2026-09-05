<script setup lang="ts">
/**
 * The host's media manager: the shared gallery plus the papers — documents
 * (reservations, itineraries) everyone sees, and tickets assigned per
 * attendee (each guest only ever sees their own). Wraps MediaGallery with the
 * host endpoints and adds ticket assignment + delete.
 */
interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  mimeType: string
  fileName: string
  caption: string | null
  assignedRsvpId: string | null
  url: string
}
interface Rsvp { id: string, guestName: string | null, guestEmail: string | null }

const props = defineProps<{ slug: string, rsvps: Rsvp[] }>()

const { data, refresh } = await useFetch<{ media: MediaItem[] }>(
  `/api/host/events/${props.slug}/media`,
  { server: false, default: () => ({ media: [] }) }
)
const toast = useToast()

const gallery = computed(() => (data.value?.media ?? []).filter(m => m.type === 'photo' || m.type === 'video'))
const documents = computed(() => (data.value?.media ?? []).filter(m => m.type === 'document'))
const tickets = computed(() => (data.value?.media ?? []).filter(m => m.type === 'ticket'))

const rsvpItems = computed(() => [
  { label: 'Unassigned', value: null as string | null },
  ...props.rsvps.map(r => ({ label: r.guestName || r.guestEmail || r.id, value: r.id as string | null }))
])

async function assign(mediaId: string, rsvpId: string | null) {
  try {
    await $fetch(`/api/host/events/${props.slug}/media/${mediaId}/assign`, {
      method: 'POST',
      body: { rsvpId }
    })
    await refresh()
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not assign that', color: 'error' })
  }
}

async function remove(mediaId: string) {
  await $fetch(`/api/host/events/${props.slug}/media/${mediaId}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <MediaGallery
      :gallery="gallery"
      :documents="documents"
      :tickets="[]"
      :presign-url="`/api/host/events/${slug}/media/presign`"
      :confirm-url="`/api/host/events/${slug}/media/confirm`"
      :upload-types="['photo', 'video', 'document', 'ticket']"
      @updated="refresh"
    />

    <!-- Tickets: assigned per attendee, guests only see their own -->
    <UCard v-if="tickets.length">
      <template #header>
        <div>
          <p class="font-semibold">
            🎟️ Tickets
          </p>
          <p class="text-sm text-muted">
            Assign each ticket to its attendee — they'll see only theirs.
          </p>
        </div>
      </template>
      <div class="flex flex-col gap-2">
        <div
          v-for="t in tickets"
          :key="t.id"
          class="flex items-center justify-between gap-2 py-1.5 border-b border-default last:border-b-0 text-sm"
        >
          <a
            :href="t.url"
            target="_blank"
            rel="noopener"
            class="text-primary hover:underline truncate"
          >
            {{ t.caption || t.fileName }}
          </a>
          <div class="flex items-center gap-1 shrink-0">
            <USelect
              :model-value="t.assignedRsvpId"
              :items="rsvpItems"
              class="w-44"
              size="sm"
              @update:model-value="(v: string | null) => assign(t.id, v)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="remove(t.id)"
            >
              ✕
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Housekeeping for the shared items -->
    <details
      v-if="gallery.length || documents.length"
      class="text-sm"
    >
      <summary class="text-muted cursor-pointer">
        Manage uploads ({{ gallery.length + documents.length }})
      </summary>
      <div class="flex flex-col gap-1 mt-2">
        <div
          v-for="m in [...gallery, ...documents]"
          :key="m.id"
          class="flex items-center justify-between gap-2 py-1"
        >
          <p class="truncate text-muted">
            {{ m.type }} · {{ m.caption || m.fileName }}
          </p>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            @click="remove(m.id)"
          >
            Delete
          </UButton>
        </div>
      </div>
    </details>
  </div>
</template>
