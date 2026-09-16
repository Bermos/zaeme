<script setup lang="ts">
import type { TicketDetailFields } from '#shared/utils/ticket-detail'

/**
 * The host's media manager: the shared gallery plus the papers — documents
 * (reservations, itineraries) everyone sees, and tickets assigned per attendee.
 * Wraps MediaGallery with the host endpoints and adds ticket assignment, the
 * ticket's own details (#35) and delete.
 *
 * ASSIGNMENT IS A LABEL, NOT A LOCK, SINCE #37. It used to be both: a guest saw
 * the tickets matched to their address and no others, which left four friends
 * at a barrier with one working phone unable to reach three of their own
 * tickets. Everyone on the event now sees every ticket and the assignment says
 * whose it is, so what a planner does here is tell the group who is on what —
 * still worth getting right, and no longer the thing keeping anybody out.
 */
interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  mimeType: string
  fileName: string
  caption: string | null
  /**
   * EVERY attendee this ticket is for (#36) — a pair fare has two names on it
   * here. Empty for a photo, a video and a shared document, and empty for a
   * ticket nobody has been given yet.
   */
  assignedRsvpIds: string[]
  ticket?: TicketDetailFields | null
  url: string
}
interface Rsvp { id: string, guestName: string | null, guestEmail: string | null }

const props = defineProps<{
  slug: string
  rsvps: Rsvp[]
  /**
   * The event's display zone (#31) — the clock a ticket's validity is typed in
   * and read back in. `null` is "the reader's own".
   *
   * REQUIRED, for the reason spelled out on `MediaGallery`'s copy of this prop:
   * an omitted one is indistinguishable from `null` to `formatInZone`, which
   * falls back to the ambient zone by design, so forgetting it is silent in
   * every check this repository has. Required makes `nuxt typecheck` the thing
   * that notices.
   */
  timezone: string | null
}>()

const { data, refresh } = await useFetch<{ media: MediaItem[] }>(
  `/api/host/events/${props.slug}/media`,
  { server: false, default: () => ({ media: [] }) }
)
const toast = useToast()

const gallery = computed(() => (data.value?.media ?? []).filter(m => m.type === 'photo' || m.type === 'video'))
const documents = computed(() => (data.value?.media ?? []).filter(m => m.type === 'document'))
const tickets = computed(() => (data.value?.media ?? []).filter(m => m.type === 'ticket'))

/**
 * A MULTI-SELECT, because one ticket can cover two people (#36).
 *
 * The old control was a single `USelect` whose first entry was "Unassigned" —
 * which made "nobody" a THIRD kind of value beside the attendees and made
 * giving a pair fare to both halves of a couple impossible: picking the second
 * name took it away from the first. A `USelectMenu` in `multiple` mode has no
 * such entry, because an empty selection already says it: nothing is chosen,
 * nobody has the ticket.
 */
const rsvpItems = computed(() =>
  props.rsvps.map(r => ({ label: r.guestName || r.guestEmail || r.id, value: r.id }))
)

function nameFor(rsvpId: string): string {
  const r = props.rsvps.find(x => x.id === rsvpId)
  // An id rather than a blank: an assignee whose RSVP has gone from this list
  // is a state worth seeing on the screen that can fix it.
  return r ? (r.guestName || r.guestEmail || r.id) : rsvpId
}

/**
 * THE SELECTION IS TURNED INTO ADDS AND REMOVES, one call each, and never into
 * a "set these people" call.
 *
 * The server has two verbs and no third one on purpose: a set would need the
 * whole list to be authoritative, so two planners opening this card at the same
 * time would silently undo each other's additions — the second save carries a
 * list assembled before the first one happened. Add and remove compose; a set
 * does not.
 *
 * Both verbs are idempotent, so a request that is already true is a 200 and
 * costs a round trip, which is why only the DIFFERENCE is sent.
 */
async function setAssignees(t: MediaItem, next: string[]) {
  const was = t.assignedRsvpIds
  const added = next.filter(id => !was.includes(id))
  const removed = was.filter(id => !next.includes(id))
  try {
    const base = `/api/host/events/${props.slug}/media/${t.id}/assignees`
    for (const rsvpId of added) await $fetch(base, { method: 'POST', body: { rsvpId } })
    for (const rsvpId of removed) await $fetch(`${base}/${rsvpId}`, { method: 'DELETE' })
    // THE ANSWERS ARE DISCARDED ON PURPOSE. Both routes reply with the whole
    // media item, but this card renders a DOWNLOAD and its items need a signed
    // `url` — which a domain view does not carry, and which a mutation is not
    // the place to mint. So the state comes from the list read that does sign.
    await refresh()
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not assign that', color: 'error' })
    // The control is bound to the server's answer, so a failed call must not
    // leave the screen showing the selection that did not take.
    await refresh()
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
 *
 * AND IT WATCHES THE ZONE, which is the half #77's review found missing. The
 * drafts are seeded EAGERLY for every ticket the moment this card loads, and
 * they hold a WALL CLOCK — so when the host edits the trip's zone further up
 * the page, `data.event.timezone` moves reactively while this card's own
 * `useFetch` does not re-run, and every open draft is left saying the old
 * zone's reading while `saveDetail` resolves it against the new one. Measured:
 * 22:59Z seeded as `23:59` in `Europe/Lisbon`, saved after a switch to
 * `America/New_York` as 03:59Z the next morning — five hours, on a field
 * nobody touched, for the whole lifetime of the page.
 *
 * `rezoneInputValue` re-reads each field against the zone it was written in and
 * re-renders that same instant in the new one, so an unsaved edit survives the
 * change carrying the moment it meant. Re-seeding from the server would fix the
 * stored value and silently drop that edit.
 *
 * `seededZone` is the zone THE DRAFTS HOLD, which is not `props.timezone` — it
 * is whatever `props.timezone` was when they were last written. `undefined` is
 * "nothing seeded yet" and is unambiguous, because the prop is required and is
 * `string | null`.
 */
let seededZone: string | null | undefined
watch([tickets, () => props.timezone], ([list, zone]) => {
  if (seededZone !== undefined && seededZone !== zone) {
    for (const draft of Object.values(drafts.value)) {
      draft.validFrom = rezoneInputValue(draft.validFrom, seededZone, zone)
      draft.validUntil = rezoneInputValue(draft.validUntil, seededZone, zone)
    }
  }
  seededZone = zone
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

/**
 * TWO CLOCK LABELS IN ONE CARD, AND THEY LABEL TWO DIFFERENT THINGS.
 *
 * This one — "Times are in Europe/Lisbon" — captions the `datetime-local`
 * INPUTS. An empty field holds no instant, so there is no offset to abbreviate
 * and nothing that could say `WEST`; what the host needs to know is which wall
 * clock they are typing against, which is the zone's name.
 *
 * The rendered line a couple of elements above (`ticketDetailLines`) stamps
 * each validity with `WEST`/`WET` instead, because by then it IS an instant and
 * `shared/utils/timezone.ts` says in terms why the abbreviation is right for
 * one and wrong for the other: `WEST` is true of a moment, not of a week. The
 * two registers reading differently in one card is deliberate rather than an
 * oversight, and the alternative — one label for both — is wrong in whichever
 * half it is borrowed from.
 */
const zoneLine = computed(() => zoneNote(props.timezone))
</script>

<template>
  <div class="flex flex-col gap-4">
    <!--
      No tickets are handed to the gallery here — this card renders its own,
      with the assignment controls — so there is nobody for it to mark them for
      and `:viewer-email` is null (#37).
    -->
    <MediaGallery
      :gallery="gallery"
      :documents="documents"
      :tickets="[]"
      :viewer-email="null"
      :timezone="timezone"
      :presign-url="`/api/host/events/${slug}/media/presign`"
      :confirm-url="`/api/host/events/${slug}/media/confirm`"
      :upload-types="['photo', 'video', 'document', 'ticket']"
      @updated="refresh"
    />

    <!-- Tickets: assigned per attendee; everyone on the event sees them (#37) -->
    <UCard v-if="tickets.length">
      <template #header>
        <div>
          <p class="font-semibold">
            🎟️ Tickets
          </p>
          <p class="text-sm text-muted">
            Say who each ticket is for — everyone on the trip can see them all,
            so a friend with a working phone can hand one over at the barrier.
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
              <USelectMenu
                :model-value="t.assignedRsvpIds"
                :items="rsvpItems"
                value-key="value"
                multiple
                class="w-44"
                size="sm"
                placeholder="Nobody yet"
                @update:model-value="(v: string[]) => setAssignees(t, v)"
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

          <!-- WHO IT IS FOR, spelled out (#36). The select above holds the same
               names, but it is 11rem wide and a family entry has four of them:
               a pair fare that reads "Ana, Ben" here is the one place a planner
               can see at a glance that the second name really did stick. -->
          <p
            v-if="t.assignedRsvpIds.length"
            class="text-muted"
          >
            For {{ t.assignedRsvpIds.map(nameFor).join(', ') }}
          </p>

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
