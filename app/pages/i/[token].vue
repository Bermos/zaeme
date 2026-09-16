<script setup lang="ts">
import type { TicketDetailFields } from '#shared/utils/ticket-detail'

/**
 * The guest event page — the heart of zäme (PUBLIC-SITE-PLAN "movie night",
 * since grown into the full planner). Reached via the invite capability URL;
 * SSR-rendered so shared links carry real OG meta. Shows the post (poster/
 * description/plan — or the cinema marquee for a series showing), the date
 * poll while the host is finding a date, RSVP + who's-coming once published,
 * the bring list, the trip budget, the shared gallery + papers, and the
 * group chat.
 */
const route = useRoute()
const token = route.params.token as string

const { data: page, error, refresh } = await useFetch(`/api/invites/${token}`)

const { identity, suggest, complete } = useGuestIdentity()
watch(page, (p) => {
  if (p?.invite?.email || p?.invite?.name) {
    suggest({ name: p.invite.name ?? '', email: p.invite.email ?? '' })
  }
}, { immediate: true })

// OG meta for the shared link (SSR).
useSeoMeta({
  title: () => page.value?.event.title ?? 'You are invited',
  description: () => page.value?.event.description?.slice(0, 200) ?? 'A friend invited you — see the plan and RSVP on zäme.',
  ogTitle: () => page.value ? `${page.value.event.title} · zäme` : 'zäme',
  ogDescription: () => page.value?.event.description?.slice(0, 200) ?? 'See the plan and RSVP.',
  ogImage: () => page.value?.event.posterUrl ?? undefined
})

const polling = computed(() => page.value?.event.status === 'polling')
const published = computed(() => page.value?.event.status === 'published')
const completed = computed(() => page.value?.event.status === 'completed')
const isTrip = computed(() => page.value?.event.type === 'trip')
const isShowing = computed(() => !!page.value?.series)

/* ---- media (client fetch: URLs are short-lived signatures) ---- */
interface MediaItem {
  id: string
  type: 'photo' | 'video' | 'document' | 'ticket'
  mimeType: string
  fileName: string
  caption: string | null
  /** What the ticket says (#35) — null for every other type and for a bare PDF. */
  ticket?: TicketDetailFields | null
  url: string
}
interface MediaBuckets { gallery: MediaItem[], documents: MediaItem[], tickets: MediaItem[] }
const media = ref<MediaBuckets>({ gallery: [], documents: [], tickets: [] })
async function loadMedia() {
  try {
    const email = identity.value.email ? `?email=${encodeURIComponent(identity.value.email)}` : ''
    media.value = await $fetch<MediaBuckets>(`/api/invites/${token}/media${email}`)
  } catch { /* storage unconfigured (501) or transient — the card just stays empty */ }
}
onMounted(loadMedia)
watch(() => identity.value.email, loadMedia)

/* ---- budget ---- */
/**
 * READING the budget is still the invite link's — it renders for anybody
 * holding it. WRITING moved onto an account (#48): the POST goes to
 * `/api/me/events/<slug>/expenses`, which needs a session AND an RSVP (or a
 * planner row) on this event.
 */
const budget = computed(() => page.value?.budget ?? null)
function onBudgetUpdated() {
  refresh()
}

const session = useSession()
const account = computed(() => {
  const u = session.value.data?.user
  return u?.email ? { name: u.name || u.email, email: u.email.toLowerCase() } : null
})

/**
 * An instance on the mail dry run cannot deliver a magic link, so pointing a
 * signed-out friend at /login would be pointing them at a form that goes
 * nowhere. Asked only when it matters — a signed-out viewer looking at a
 * budget — and only in the browser, so the SSR'd invite page stays one query.
 */
const mailReady = ref<boolean | null>(null)
let mailProbed = false
watch([budget, account], async ([b, acct]) => {
  if (!import.meta.client || !b || acct || mailProbed) return
  mailProbed = true
  const status = await $fetch<{ emailConfigured: boolean }>('/api/setup/status').catch(() => null)
  // `?? null` on purpose: a failed probe leaves this UNKNOWN, and the unknown
  // copy promises nothing. Defaulting to `true` here would tell a signed-out
  // friend on a dry-run instance that a link is coming, which is the one thing
  // CLAUDE.md and #48 forbid this screen to do.
  mailReady.value = status?.emailConfigured ?? null
}, { immediate: true })

const budgetLockedReason = computed(() => {
  // While the session is still resolving, claim nothing: the card renders
  // read-only for a moment rather than telling a signed-in friend they need an
  // account and then taking it back.
  if (account.value || session.value.isPending) return null
  if (mailReady.value === false) {
    // The trap named in #48: gating money behind an account makes the budget
    // unreachable on an instance that cannot deliver a magic link. Say that,
    // rather than offering a form that accepts an address and sends nothing.
    return 'Money is recorded against a person, not a link. This instance cannot send email yet, so a sign-in link '
      + 'would never arrive — only a passkey will get you in. Ask your host to set up mail if you have not got one.'
  }
  if (mailReady.value === true) {
    return 'Money is recorded against a person, not a link. Sign in — a link by email, or a passkey — and you can add '
      + 'expenses, including ones a friend paid.'
  }
  return 'Money is recorded against a person, not a link, so adding an expense needs a sign-in.'
})
const budgetSignInTo = computed(() => `/login?redirect=${encodeURIComponent(route.fullPath)}`)

const splitParticipants = computed(() => {
  const fromRsvps = (page.value?.attendees ?? [])
    .filter(a => a.status === 'yes' || a.status === 'maybe')
    .map(a => ({ name: a.name, email: '' }))
  // Emails aren't public on the guest page; splitting picks from the budget's
  // own participant history + the viewer. The host side offers the full list.
  const seen = new Map<string, { name: string, email: string }>()
  for (const b of budget.value?.balances ?? []) seen.set(b.email, { name: b.name, email: b.email })
  for (const x of budget.value?.expenses ?? []) {
    for (const s of x.shares) seen.set(s.email, { name: s.name, email: s.email })
  }
  if (complete.value) seen.set(identity.value.email, { name: identity.value.name, email: identity.value.email })
  if (account.value) seen.set(account.value.email, account.value)
  return seen.size ? [...seen.values()] : fromRsvps.filter(p => p.email)
})

/**
 * THE TRIP'S OWN CLOCK (#31), when it has one — this is the page the departure
 * time is actually read on, in a hotel lobby, by somebody who is not at home.
 */
const zone = computed(() => page.value?.event.timezone ?? null)

/**
 * A single moment, STAMPED WITH ITS OWN ZONE ABBREVIATION rather than the
 * trip's. `WEST` is a fact about an instant and not about a week: a trip across
 * the last Sunday in October is half `WEST` and half `WET`, so the abbreviation
 * is computed here, per time, and the card headings name the zone instead.
 */
function when(iso: string | Date | null | undefined): string | null {
  return formatInZone(
    iso,
    { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZoneName: zone.value ? 'short' : undefined },
    zone.value
  )
}

function dateSpan(start: string | Date | null | undefined, end: string | Date | null | undefined): string | null {
  if (!start) return null
  if (!end) return when(start)
  // Same day IN THE EVENT'S ZONE: a span that starts and ends on one Lisbon day
  // must not split into two headings because the reader is in Auckland.
  if (zoneDayKey(start, zone.value) === zoneDayKey(end, zone.value)) return when(start)
  const fmt = (d: string | Date) => formatInZone(d, { day: 'numeric', month: 'long' }, zone.value)
  return `${fmt(start)} → ${fmt(end)}`
}

const errorMessage = computed(() => {
  const status = (error.value as { statusCode?: number } | null)?.statusCode
  if (status === 404) return 'This invite link does not exist. Double-check the link you received.'
  if (status === 410) return 'This invite is no longer active — ask your host for a fresh link.'
  if (status === 403) return 'This event is not accepting RSVPs right now.'
  return error.value ? 'Something went wrong loading this invite.' : null
})
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <UAlert
      v-if="errorMessage"
      color="warning"
      variant="subtle"
      title="Hmm."
      :description="errorMessage"
    />

    <template v-else-if="page">
      <!-- A series showing gets the cinema treatment -->
      <SeriesMarquee
        v-if="isShowing && page.series"
        :series="page.series"
        :event-title="page.event.title"
        :poster-url="page.event.posterUrl"
        :starts-at="page.event.startsAt"
        :timezone="page.event.timezone"
      />

      <!-- The post: poster, title, when/where -->
      <div class="flex flex-col gap-4">
        <img
          v-if="page.event.posterUrl && !isShowing"
          :src="page.event.posterUrl"
          :alt="`Poster for ${page.event.title}`"
          class="w-full max-h-96 object-cover rounded-lg"
        >
        <div v-if="!isShowing">
          <div class="flex items-center gap-2 flex-wrap">
            <h1 class="text-3xl font-bold">
              {{ page.event.title }}
            </h1>
            <UBadge
              v-if="isTrip"
              color="info"
              variant="subtle"
            >
              trip
            </UBadge>
            <UBadge
              v-if="page.event.type === 'party'"
              color="info"
              variant="subtle"
            >
              party
            </UBadge>
            <UBadge
              v-if="polling"
              color="warning"
              variant="subtle"
            >
              finding a date
            </UBadge>
            <UBadge
              v-else-if="completed"
              color="neutral"
              variant="subtle"
            >
              happened
            </UBadge>
            <UBadge
              v-else-if="page.event.status === 'cancelled'"
              color="error"
              variant="subtle"
            >
              cancelled
            </UBadge>
          </div>
          <p
            v-if="page.invite.name"
            class="text-muted mt-1"
          >
            Hi {{ page.invite.name }} — you're invited!
          </p>
          <p
            v-if="page.event.type === 'party' && polling && page.invite.tier === 'core'"
            class="text-sm text-muted mt-1"
          >
            You're in the core group — help fix the date, then the party opens up to everyone.
          </p>
        </div>
        <p
          v-else-if="page.invite.name"
          class="text-muted -mt-2"
        >
          Hi {{ page.invite.name }} — your seat is waiting. Can you make this one?
        </p>

        <div class="flex flex-col gap-1 text-sm">
          <p
            v-if="isTrip && dateSpan(page.event.startsAt, page.event.endsAt)"
            class="font-medium"
          >
            🗓️ {{ dateSpan(page.event.startsAt, page.event.endsAt) }}
          </p>
          <p
            v-else-if="!isShowing && when(page.event.startsAt)"
            class="font-medium"
          >
            🗓️ {{ when(page.event.startsAt) }}
          </p>
          <p
            v-else-if="polling"
            class="text-muted"
          >
            🗓️ Date being decided — vote below!
          </p>
          <p v-if="page.event.location">
            📍 {{ page.event.location }}
          </p>
        </div>

        <p
          v-if="page.event.description"
          class="whitespace-pre-line text-muted"
        >
          {{ page.event.description }}
        </p>
      </div>

      <GuestIdentityCard />

      <!-- Finding a date -->
      <DatePoll
        v-if="polling && page.poll.length"
        :token="token"
        :poll="page.poll"
        :timezone="page.event.timezone"
        @updated="refresh"
      />

      <!-- RSVP once the date is locked -->
      <RsvpCard
        v-if="published"
        :token="token"
        :event-type="page.event.type"
        :existing-rsvp="page.existingRsvp"
        @updated="refresh"
      />

      <AttendeeList
        :attendees="page.attendees"
        :summary="page.summary"
      />

      <EventTimeline
        v-if="page.timeline.length || page.legs.length"
        :timeline="page.timeline"
        :legs="page.legs"
        :places="page.places"
        :timezone="page.event.timezone"
      />

      <!-- "We ended up walking" (#30). The invite link is the credential: this
           is a note about the afternoon, not money, and it is written while the
           host is asleep. Shown on a live trip that has places to join up. -->
      <GuestLegCard
        v-if="(published || completed) && page.places.length"
        :token="token"
        :places="page.places"
        :timezone="page.event.timezone"
        @updated="refresh"
      />

      <BringList
        v-if="(published || page.contributions.length) && !isTrip"
        :token="token"
        :contributions="page.contributions"
        @updated="refresh"
      />

      <!-- Trip budget & splitting. Two gates, not one: the card appears for an
           unidentified visitor so it can say "there is a budget here, sign in",
           and `show-amounts` decides separately whether it says any NUMBERS —
           which stays exactly where it was before #48, behind `complete`. -->
      <BudgetCard
        v-if="budget && (complete || account || !!budgetLockedReason)"
        :budget="budget"
        :add-url="`/api/me/events/${page.event.slug}/expenses`"
        :expenses-base="`/api/me/events/${page.event.slug}/expenses`"
        :accounts-base="account ? `/api/me/events/${page.event.slug}/accounts` : null"
        :participants="splitParticipants"
        :viewer="account"
        :show-amounts="complete || !!account"
        :locked-reason="budgetLockedReason"
        :sign-in-to="budgetSignInTo"
        :receipt-upload-base="account ? `/api/me/events/${page.event.slug}/media` : null"
        :settlements-base="account ? `/api/me/events/${page.event.slug}/settlements` : null"
        @updated="onBudgetUpdated"
      />

      <!-- Shared gallery + papers (tickets matched to your email) -->
      <MediaGallery
        :gallery="media.gallery"
        :documents="media.documents"
        :tickets="media.tickets"
        :timezone="page.event.timezone"
        :presign-url="`/api/invites/${token}/media/presign`"
        :confirm-url="`/api/invites/${token}/media/confirm`"
        :upload-types="complete ? ['photo', 'video'] : []"
        :identity="complete ? { name: identity.name, email: identity.email } : null"
        @updated="loadMedia"
      />

      <!-- Group chat -->
      <EventChat
        v-if="published || completed || polling"
        :list-url="`/api/invites/${token}/messages`"
        :post-url="`/api/invites/${token}/messages`"
        needs-identity
      />

      <!-- Utilities -->
      <div
        v-if="published && page.event.startsAt"
        class="flex gap-2"
      >
        <UButton
          :to="`/i/${token}/calendar.ics`"
          external
          variant="outline"
          size="sm"
        >
          Add to calendar
        </UButton>
        <UButton
          v-if="page.event.ticketUrl"
          :to="page.event.ticketUrl"
          external
          target="_blank"
          variant="outline"
          size="sm"
        >
          Tickets
        </UButton>
      </div>

      <UAlert
        color="neutral"
        variant="subtle"
        description="Want all your invites in one place? Sign in with your email — no password needed."
      >
        <template #actions>
          <UButton
            to="/login"
            size="xs"
            variant="outline"
          >
            Sign in
          </UButton>
        </template>
      </UAlert>
    </template>
  </div>
</template>
