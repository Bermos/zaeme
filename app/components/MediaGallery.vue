<script setup lang="ts">
import type { TicketDetailFields } from '#shared/utils/ticket-detail'
import type { TicketScope } from '#shared/utils/ticket-scope'

/**
 * Event media, split by handling class (they are different things):
 *  - the GALLERY — photos & videos, the social memory of the event; anyone
 *    on the event can add to it;
 *  - the PAPERS — documents (reservations, itineraries) shown as a file list,
 *    and the event's tickets, kept apart and prominent — each with what it
 *    SAYS rendered as text beside the download (#35), because at a barrier you
 *    need the seat before the PDF finishes.
 * Upload is the two-step presign → PUT → confirm dance.
 *
 * TICKETS ARE EVERYBODY'S SINCE #37, AND `Mine` IS A FILTER RATHER THAN A GATE.
 * The server used to send back only the tickets matched to the viewer's
 * address, which left four friends at a barrier with one working phone able to
 * reach one ticket out of four. The owner's decision (D2, revised) is that this
 * was never a permission boundary between friends, so the list arriving here is
 * every ticket on the event and each row says whether it is the viewer's. The
 * two buttons are a convenience for finding yours quickly; the rule behind them
 * is `shared/utils/ticket-scope.ts`, where `test/ticket-scope.test.ts` executes
 * it, and it is EXACTLY tickets — `documents` and `gallery` are untouched.
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
/**
 * A ticket as the invite link answers it (#37): a media item plus the two
 * things only that surface knows — whether it is the viewer's, and who else it
 * is for BY NAME (the guest page is given names and no RSVP ids, so an id here
 * would render as a cuid2).
 *
 * `mine` IS THE SERVER'S ANSWER AND NOT THIS CARD'S. The browser does not have
 * the viewer's RSVP ids, and a client that matched on a typed name would get a
 * pair fare wrong in both directions.
 */
interface TicketItem extends MediaItem {
  mine: boolean
  assignedTo: Array<{ rsvpId: string, name: string }>
}

const props = defineProps<{
  gallery: MediaItem[]
  documents: MediaItem[]
  /** Every ticket on the event (#37), each marked as the viewer's or not. */
  tickets: TicketItem[]
  /**
   * WHO THE LIST WAS FETCHED FOR — the address the `mine` markers on `tickets`
   * were decided against, or `null` when the read carried none.
   *
   * REQUIRED, AND THAT IS THE WHOLE OF WHETHER THE EMPTY `Mine` EXPLAINS ITSELF.
   * An omitted prop is `undefined`, which is falsy, which reads here as "nobody
   * has told us who they are" — so a forgotten binding would show a person who
   * HAS typed their address the sentence asking them to type it, forever, with
   * nothing red anywhere. `null` is how a caller SAYS "nobody has said", which
   * is a different statement from forgetting to say anything; required is what
   * makes `nuxt typecheck` refuse the omission at the call site.
   *
   * IT IS NOT AN AUTHENTICATION. `?email=` is asserted by whoever holds the
   * invite link and always was; it decides which tickets are LABELLED yours,
   * and since #37 it decides nothing about which of them you can reach.
   */
  viewerEmail: string | null
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

/**
 * MINE OR EVERYBODY'S (#37). `mine` is the default because it is the right
 * answer on the way in — you open the link to find your own ticket — and `all`
 * is the answer at the barrier, when three of the four phones are flat.
 *
 * THE DEFAULT IS IMPORTED, NOT TYPED. `ref<TicketScope>('all')` is one word
 * away from here, deletes the acceptance criterion that `Mine` is the default,
 * and leaves eslint, `nuxt typecheck` and every test green — a card that looks
 * right and opens on somebody else's tickets. `DEFAULT_TICKET_SCOPE` is a value
 * a test can execute, and `test/ticket-scope.test.ts` pins that this line reads
 * it.
 */
const scope = ref<TicketScope>(DEFAULT_TICKET_SCOPE)
/**
 * ONE CALL, THREE ARGUMENTS, AND THAT IS DELIBERATE. This was three separate
 * expressions — the filter, the count, and `identified: !!props.viewerEmail` —
 * and each was a silent mutation waiting to happen: `ticketsInScope(…, 'all')`
 * makes both buttons labels, and a hard-coded `identified: true` tells an
 * anonymous viewer that nothing here is theirs, which is advice they cannot
 * act on. Nothing in this repository executes a `.vue` file, so none of the
 * three had a check. Folded into `ticketScopeView` they are ONE call site the
 * structural test can pin verbatim, with `identified` derived inside the rule
 * rather than asserted out here.
 */
const ticketView = computed(() => ticketScopeView(props.tickets, scope.value, props.viewerEmail))
const shownTickets = computed(() => ticketView.value.shown)
/**
 * The sentence that goes where the list would be, or `null` when there is a
 * list. An empty `Mine` is the ORDINARY first visit — nobody has to say who
 * they are to open an invite link and most people have not — so this is the
 * screen the issue is about, not an edge case, and it must never be a blank
 * box. The wording lives in `shared/utils/ticket-scope.ts` with the filter it
 * belongs to.
 */
const ticketNotice = computed(() => ticketView.value.notice)

/**
 * WHO A TICKET IS FOR, ON SCREEN — the half of this issue that makes `All`
 * usable rather than merely full. A list of four PDFs named `ticket.pdf` with
 * nothing against them is not something you can hand to the right friend.
 *
 * It names everybody (#36): a pair fare reads "Yours — Ana, Ben" on both their
 * screens, so neither has to work out why the same file is on the other's.
 */
function assignedLine(t: TicketItem): string {
  if (t.assignedTo.length === 0) return 'Not assigned to anybody yet'
  const names = t.assignedTo.map(a => a.name).join(', ')
  return t.mine ? `Yours — ${names}` : `For ${names}`
}
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
      <!-- Tickets — front and centre, they get you in the door -->
      <div
        v-if="tickets.length"
        class="flex flex-col gap-3"
      >
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm font-medium">
            🎟️ Tickets
          </p>
          <!--
            TWO BUTTONS, AND BOTH OF THEM SET THE SCOPE (#37). `Mine` is the
            default: you open the link to find your own. `All` is the barrier,
            where one phone still has battery and the other three tickets are
            on it.
          -->
          <div class="flex gap-1">
            <UButton
              size="xs"
              :variant="scope === 'mine' ? 'solid' : 'outline'"
              @click="scope = 'mine'"
            >
              Mine
            </UButton>
            <UButton
              size="xs"
              :variant="scope === 'all' ? 'solid' : 'outline'"
              @click="scope = 'all'"
            >
              All ({{ tickets.length }})
            </UButton>
          </div>
        </div>

        <!--
          AN EMPTY LIST SAYS WHY IT IS EMPTY, never nothing at all. Opening an
          invite link takes no identity, so the first thing most people see is
          `Mine` filtered by an address they have not typed — which without this
          renders as a blank box and reads as broken.
        -->
        <p
          v-if="ticketNotice"
          class="text-sm text-muted"
        >
          {{ ticketNotice }}
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
          v-for="t in shownTickets"
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
          <!-- Whose it is, so `All` is a list you can hand around (#37/#36). -->
          <p class="text-sm text-muted pl-1">
            {{ assignedLine(t) }}
          </p>
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
