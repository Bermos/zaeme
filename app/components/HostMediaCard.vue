<script setup lang="ts">
import type { TicketDetailFields } from '#shared/utils/ticket-detail'

/**
 * The host's media manager: the shared gallery plus the papers — documents
 * (reservations, itineraries) everyone sees, and tickets assigned per
 * attendee (each guest only ever sees their own). Wraps MediaGallery with the
 * host endpoints and adds ticket assignment, the ticket's own details (#35)
 * and delete.
 */
interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  mimeType: string
  fileName: string
  caption: string | null
  assignedRsvpId: string | null
  ticket?: TicketDetailFields | null
  url: string
}
interface Rsvp { id: string, guestName: string | null, guestEmail: string | null }

const props = defineProps<{
  slug: string
  rsvps: Rsvp[]
  /** The event's display zone (#31) — the clock a ticket's validity is typed and read in. */
  timezone?: string | null
}>()

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

/* ------------------------ what the ticket says (#35) ----------------------- */

/**
 * THE DETAILS ARE BEHIND A DISCLOSURE, AND THAT IS THE DESIGN, not a way of
 * saving space. The issue says in terms that this must never become a form
 * somebody has to complete before uploading a PDF — so the ticket row looks
 * exactly as it did, the fields are collapsed, nothing is marked required,
 * nothing is validated, and a planner who never opens this loses nothing. What
 * they gain by opening it is a friend at a barrier who can read their seat
 * without waiting for 4 MB of PDF.
 *
 * The draft is per media id and starts from whatever the server last answered,
 * so an edit is a re-open rather than a re-type.
 */
type Draft = {
  bookingRef: string
  carrier: string
  seat: string
  coach: string
  travellerName: string
  validFrom: string
  validUntil: string
  note: string
}
const drafts = ref<Record<string, Draft>>({})
const savingId = ref<string | null>(null)

function toDraft(d: TicketDetailFields | null | undefined): Draft {
  // The two instants become WALL CLOCK in the event's zone (#31): a host in
  // Zürich editing a Lisbon trip types the time the barrier will show, which is
  // the same rule the itinerary editor applies to a departure.
  return {
    bookingRef: d?.bookingRef ?? '',
    carrier: d?.carrier ?? '',
    seat: d?.seat ?? '',
    coach: d?.coach ?? '',
    travellerName: d?.travellerName ?? '',
    validFrom: toZonedInputValue(d?.validFrom ?? null, props.timezone),
    validUntil: toZonedInputValue(d?.validUntil ?? null, props.timezone),
    note: d?.note ?? ''
  }
}

/**
 * Seeded in a WATCHER and never during render. A `draftFor(t)` helper called
 * from `v-model` would write to this ref while Vue is rendering it, which is a
 * self-triggering update — the shape that renders once in development and
 * loops in production.
 *
 * Only tickets with no draft yet are seeded, so typing survives a refresh; a
 * save deletes its own draft, which is what makes the next seed re-read the
 * server's answer.
 */
watch(tickets, (list) => {
  for (const t of list) {
    if (!drafts.value[t.id]) drafts.value[t.id] = toDraft(t.ticket)
  }
}, { immediate: true, deep: true })

async function saveDetail(mediaId: string) {
  const d = drafts.value[mediaId]
  if (!d) return
  savingId.value = mediaId
  try {
    await $fetch(`/api/host/events/${props.slug}/media/${mediaId}/detail`, {
      method: 'PUT',
      body: {
        bookingRef: d.bookingRef,
        carrier: d.carrier,
        seat: d.seat,
        coach: d.coach,
        travellerName: d.travellerName,
        validFrom: isoFromZonedInput(d.validFrom, props.timezone),
        validUntil: isoFromZonedInput(d.validUntil, props.timezone),
        note: d.note
      }
    })
    // Dropped so the next seed re-reads the server's answer rather than the
    // thing that was typed at it — the two differ whenever the server trims,
    // and a draft that outlives its save is how a screen starts lying. Rebuilt
    // rather than `delete`d because the linter refuses a dynamic delete, and
    // the whole record is eight small objects.
    drafts.value = Object.fromEntries(Object.entries(drafts.value).filter(([id]) => id !== mediaId))
    await refresh()
    toast.add({ title: 'Ticket details saved', color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not save that', color: 'error' })
  } finally {
    savingId.value = null
  }
}

const zoneLine = computed(() => zoneNote(props.timezone))
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
          class="py-1.5 border-b border-default last:border-b-0 text-sm"
        >
          <div class="flex items-center justify-between gap-2">
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

          <!-- What it says, as the attendee will read it. Absent when nobody
               has written anything, which is the ordinary case. -->
          <p
            v-for="(line, i) in ticketDetailLines(t.ticket, timezone)"
            :key="i"
            class="text-muted"
          >
            {{ line }}
          </p>

          <!-- OPTIONAL, COLLAPSED, AND NOTHING IN IT IS REQUIRED. See the
               script: a ticket with nothing filled in is still a ticket. -->
          <details class="mt-1">
            <summary class="text-muted cursor-pointer text-xs">
              Booking reference, coach & seat (optional)
            </summary>
            <div
              v-if="drafts[t.id]"
              class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2"
            >
              <UFormField label="Carrier">
                <UInput
                  v-model="drafts[t.id]!.carrier"
                  size="sm"
                  placeholder="SBB"
                />
              </UFormField>
              <UFormField label="Booking reference">
                <UInput
                  v-model="drafts[t.id]!.bookingRef"
                  size="sm"
                  placeholder="XY7Q2M"
                />
              </UFormField>
              <UFormField label="Coach">
                <UInput
                  v-model="drafts[t.id]!.coach"
                  size="sm"
                  placeholder="12"
                />
              </UFormField>
              <UFormField label="Seat">
                <UInput
                  v-model="drafts[t.id]!.seat"
                  size="sm"
                  placeholder="41A"
                />
              </UFormField>
              <UFormField label="Traveller">
                <UInput
                  v-model="drafts[t.id]!.travellerName"
                  size="sm"
                  placeholder="As printed on the ticket"
                />
              </UFormField>
              <UFormField label="Note">
                <UInput
                  v-model="drafts[t.id]!.note"
                  size="sm"
                  placeholder="Window, facing forwards"
                />
              </UFormField>
              <UFormField
                label="Valid from"
                :description="zoneLine ?? undefined"
              >
                <UInput
                  v-model="drafts[t.id]!.validFrom"
                  type="datetime-local"
                  size="sm"
                />
              </UFormField>
              <UFormField
                label="Valid until"
                :description="zoneLine ?? undefined"
              >
                <UInput
                  v-model="drafts[t.id]!.validUntil"
                  type="datetime-local"
                  size="sm"
                />
              </UFormField>
            </div>
            <UButton
              size="xs"
              class="mt-2"
              :loading="savingId === t.id"
              @click="saveDetail(t.id)"
            >
              Save details
            </UButton>
          </details>
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
