<script setup lang="ts">
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
const budget = computed(() => page.value?.budget ?? null)
function onBudgetUpdated() {
  refresh()
}
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
  return seen.size ? [...seen.values()] : fromRsvps.filter(p => p.email)
})

function when(iso: string | Date | null | undefined): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleString('en-CH', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

function dateSpan(start: string | Date | null | undefined, end: string | Date | null | undefined): string | null {
  if (!start) return null
  const s = new Date(start)
  if (!end) return when(start)
  const e = new Date(end)
  if (s.toDateString() === e.toDateString()) return when(start)
  const fmt = (d: Date) => d.toLocaleDateString('en-CH', { day: 'numeric', month: 'long' })
  return `${fmt(s)} → ${fmt(e)}`
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
        v-if="page.timeline.length"
        :timeline="page.timeline"
      />

      <BringList
        v-if="(published || page.contributions.length) && !isTrip"
        :token="token"
        :contributions="page.contributions"
        @updated="refresh"
      />

      <!-- Trip budget & splitting -->
      <BudgetCard
        v-if="budget && complete"
        :budget="budget"
        :add-url="`/api/invites/${token}/expenses`"
        :expenses-base="`/api/invites/${token}/expenses`"
        :participants="splitParticipants"
        :viewer="{ name: identity.name, email: identity.email }"
        guest-mode
        @updated="onBudgetUpdated"
      />

      <!-- Shared gallery + papers (tickets matched to your email) -->
      <MediaGallery
        :gallery="media.gallery"
        :documents="media.documents"
        :tickets="media.tickets"
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
