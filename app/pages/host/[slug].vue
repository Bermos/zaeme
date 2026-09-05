<script setup lang="ts">
/**
 * Manage an event (host side): edit the post, run the date poll and lock the
 * winner, create invite links, curate the bring list, watch RSVPs — plus the
 * type-aware surfaces: the series cinema (crew + showings), the trip itinerary
 * + budget, the party's two-stage open-up, the media manager, the organizer
 * team and the group chat. Thin UI over /api/host/** (events-core underneath).
 */
definePageMeta({ middleware: 'guest-auth' })

const route = useRoute()
const slug = route.params.slug as string

const { data, error, refresh } = await useFetch(`/api/host/events/${slug}`)
const session = useSession()
const toast = useToast()

const isSeries = computed(() => data.value?.event.type === 'series')
const isTrip = computed(() => data.value?.event.type === 'trip')
const isParty = computed(() => data.value?.event.type === 'party')
const isConcert = computed(() => data.value?.event.type === 'concert')

const me = computed(() => ({
  name: session.value.data?.user?.name ?? 'Host',
  email: session.value.data?.user?.email ?? ''
}))

/* ---- details ---- */
const editing = ref(false)
const form = reactive({ title: '', description: '', posterUrl: '', location: '', cadence: '', ticketUrl: '', performerNote: '' })
watch(data, (d) => {
  if (d && !editing.value) {
    form.title = d.event.title
    form.description = d.event.description ?? ''
    form.posterUrl = d.event.posterUrl ?? ''
    form.location = d.event.location ?? ''
    form.cadence = d.event.cadence ?? ''
    form.ticketUrl = d.event.ticketUrl ?? ''
    form.performerNote = d.event.performerNote ?? ''
  }
}, { immediate: true })

const savingDetails = ref(false)
async function saveDetails() {
  savingDetails.value = true
  try {
    await $fetch(`/api/host/events/${slug}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        description: form.description || null,
        posterUrl: form.posterUrl || null,
        location: form.location || null,
        cadence: isSeries.value ? (form.cadence || null) : undefined,
        ticketUrl: isConcert.value ? (form.ticketUrl || null) : undefined,
        performerNote: isConcert.value ? (form.performerNote || null) : undefined
      }
    })
    editing.value = false
    await refresh()
    toast.add({ title: 'Saved', color: 'success' })
  } catch {
    toast.add({ title: 'Could not save', color: 'error' })
  } finally {
    savingDetails.value = false
  }
}

/* ---- lifecycle ---- */
const transitioning = ref(false)
async function setStatus(status: string) {
  transitioning.value = true
  try {
    await $fetch(`/api/host/events/${slug}/status`, { method: 'POST', body: { status } })
    await refresh()
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Transition failed', color: 'error' })
  } finally {
    transitioning.value = false
  }
}

/* ---- date poll ---- */
const newOptionDate = ref('')
const addingOption = ref(false)
async function addOption() {
  if (!newOptionDate.value) return
  addingOption.value = true
  try {
    await $fetch(`/api/host/events/${slug}/date-options`, {
      method: 'POST',
      body: { startsAt: new Date(newOptionDate.value).toISOString() }
    })
    newOptionDate.value = ''
    await refresh()
  } finally {
    addingOption.value = false
  }
}
async function removeOption(id: string) {
  await $fetch(`/api/host/events/${slug}/date-options/${id}`, { method: 'DELETE' })
  await refresh()
}
const locking = ref<string | null>(null)
async function lock(optionId: string) {
  locking.value = optionId
  try {
    await $fetch(`/api/host/events/${slug}/lock`, { method: 'POST', body: { optionId } })
    await refresh()
    toast.add({
      title: isParty.value ? 'Date locked — now open the party up! 🎉' : 'Date locked — the gathering is on! 🎉',
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not lock', color: 'error' })
  } finally {
    locking.value = null
  }
}

/* ---- party stage 2 ---- */
const openingUp = ref(false)
async function openUp() {
  openingUp.value = true
  try {
    const { invite } = await $fetch<{ invite: { token: string } }>(`/api/host/events/${slug}/open-up`, {
      method: 'POST',
      body: {}
    })
    await refresh()
    await navigator.clipboard.writeText(`${window.location.origin}/i/${invite.token}`).catch(() => {})
    toast.add({ title: 'The party is open — link copied, send it wide! 🥳', color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not open up', color: 'error' })
  } finally {
    openingUp.value = false
  }
}
const hasOpenWave = computed(() => (data.value?.invites ?? []).some(i => i.tier === 'general' && !i.email && !i.revokedAt))

/* ---- invites ---- */
const inviteLabel = ref('')
const inviteName = ref('')
const inviteEmail = ref('')
const creatingInvite = ref(false)
async function createInvite(kind: 'shared' | 'personal') {
  creatingInvite.value = true
  try {
    await $fetch(`/api/host/events/${slug}/invites`, {
      method: 'POST',
      body: kind === 'shared'
        ? { label: inviteLabel.value || 'Shared link' }
        : { name: inviteName.value || null, email: inviteEmail.value || null, label: inviteName.value || null, maxUses: 1 }
    })
    inviteLabel.value = ''
    inviteName.value = ''
    inviteEmail.value = ''
    await refresh()
  } finally {
    creatingInvite.value = false
  }
}
function inviteUrl(token: string): string {
  return `${window.location.origin}/i/${token}`
}
async function copyInvite(token: string) {
  await navigator.clipboard.writeText(inviteUrl(token))
  toast.add({ title: 'Link copied — send it to your people', color: 'success' })
}
async function revokeInvite(id: string) {
  await $fetch(`/api/host/events/${slug}/invites/${id}/revoke`, { method: 'POST' })
  await refresh()
}

/* ---- bring list ---- */
const itemTitle = ref('')
const itemCategory = ref<'food' | 'drink' | 'other'>('food')
const addingItem = ref(false)
async function addItem() {
  if (!itemTitle.value) return
  addingItem.value = true
  try {
    await $fetch(`/api/host/events/${slug}/contributions`, {
      method: 'POST',
      body: { title: itemTitle.value, category: itemCategory.value }
    })
    itemTitle.value = ''
    await refresh()
  } finally {
    addingItem.value = false
  }
}
async function removeItem(id: string) {
  await $fetch(`/api/host/events/${slug}/contributions/${id}`, { method: 'DELETE' })
  await refresh()
}

/* ---- budget ---- */
const splitParticipants = computed(() => {
  const seen = new Map<string, { name: string, email: string }>()
  for (const r of data.value?.rsvps ?? []) {
    if (r.guestEmail && r.status !== 'no') seen.set(r.guestEmail, { name: r.guestName ?? r.guestEmail, email: r.guestEmail })
  }
  if (me.value.email) seen.set(me.value.email, me.value)
  return [...seen.values()]
})

function when(iso: string | Date | null): string {
  return iso ? new Date(iso).toLocaleString('en-CH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
}

const CATEGORY_ICONS: Record<string, string> = { food: '🍲', drink: '🍹', other: '📦' }
const TYPE_BADGES: Record<string, string> = { party: '🥳 party', trip: '🧳 trip', series: '🍿 series', concert: '🎤 concert' }
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      description="You don't plan this event (or you're signed out)."
    />

    <template v-else-if="data">
      <!-- Header + lifecycle -->
      <div class="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 class="text-2xl font-bold">
            {{ data.event.title }}
          </h1>
          <p class="text-sm text-muted flex items-center gap-2 flex-wrap mt-1">
            <UBadge
              variant="subtle"
              :color="data.event.status === 'published' ? 'success' : data.event.status === 'polling' ? 'warning' : 'neutral'"
            >
              {{ data.event.status }}
            </UBadge>
            <UBadge
              v-if="TYPE_BADGES[data.event.type]"
              variant="subtle"
              color="info"
            >
              {{ TYPE_BADGES[data.event.type] }}
            </UBadge>
            <span v-if="data.event.startsAt">🗓️ {{ when(data.event.startsAt) }}</span>
            <NuxtLink
              v-if="data.event.isPublic"
              :to="`/e/${data.event.slug}`"
              class="text-primary hover:underline"
            >
              public page ↗
            </NuxtLink>
          </p>
        </div>
        <div class="flex gap-2 flex-wrap">
          <UButton
            v-if="data.event.status === 'draft' && data.poll.length"
            :loading="transitioning"
            color="warning"
            variant="soft"
            @click="setStatus('polling')"
          >
            Start the date poll
          </UButton>
          <UButton
            v-if="data.event.status === 'draft' && (data.event.startsAt || isSeries)"
            :loading="transitioning"
            color="success"
            variant="soft"
            @click="setStatus('published')"
          >
            Publish
          </UButton>
          <UButton
            v-if="isParty && data.event.status === 'published' && !hasOpenWave"
            :loading="openingUp"
            color="success"
            @click="openUp"
          >
            🥳 Open up the party
          </UButton>
          <UButton
            v-if="data.event.status === 'published' && !isSeries"
            :loading="transitioning"
            variant="soft"
            color="neutral"
            @click="setStatus('completed')"
          >
            Mark as happened
          </UButton>
          <UButton
            v-if="data.event.status !== 'cancelled' && data.event.status !== 'completed'"
            :loading="transitioning"
            color="error"
            variant="ghost"
            @click="setStatus('cancelled')"
          >
            Cancel
          </UButton>
        </div>
      </div>

      <UAlert
        v-if="isParty && data.event.status === 'polling'"
        color="info"
        variant="subtle"
        title="Stage 1 — the core group fixes the date"
        description="Only your core people have links right now. Lock the winning date below, then open the party up to everyone who has time."
      />

      <!-- The post -->
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <p class="font-semibold">
              The post
            </p>
            <UButton
              size="xs"
              variant="ghost"
              @click="editing = !editing"
            >
              {{ editing ? 'Close' : 'Edit' }}
            </UButton>
          </div>
        </template>
        <form
          v-if="editing"
          class="flex flex-col gap-3"
          @submit.prevent="saveDetails"
        >
          <UFormField label="Title">
            <UInput
              v-model="form.title"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Description">
            <UTextarea
              v-model="form.description"
              :rows="3"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Poster URL">
            <UInput
              v-model="form.posterUrl"
              type="url"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Location">
            <UInput
              v-model="form.location"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="isSeries"
            label="Cadence"
            hint="e.g. every second Friday"
          >
            <UInput
              v-model="form.cadence"
              class="w-full"
            />
          </UFormField>
          <template v-if="isConcert">
            <UFormField label="Ticket link">
              <UInput
                v-model="form.ticketUrl"
                type="url"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Performer note">
              <UInput
                v-model="form.performerNote"
                class="w-full"
              />
            </UFormField>
          </template>
          <UButton
            type="submit"
            :loading="savingDetails"
          >
            Save
          </UButton>
        </form>
        <div
          v-else
          class="flex gap-4"
        >
          <img
            v-if="data.event.posterUrl"
            :src="data.event.posterUrl"
            alt=""
            class="w-24 rounded object-cover"
          >
          <div class="text-sm text-muted whitespace-pre-line">
            {{ data.event.description || 'No description yet — your friends will want the pitch!' }}
            <p
              v-if="data.event.location"
              class="mt-2"
            >
              📍 {{ data.event.location }}
            </p>
            <p
              v-if="isSeries && data.event.cadence"
              class="mt-1"
            >
              🔁 {{ data.event.cadence }}
            </p>
          </div>
        </div>
      </UCard>

      <!-- The cinema: crew + showings (series only) -->
      <HostSeriesCard
        v-if="isSeries"
        :slug="slug"
        :cadence="data.event.cadence"
        :members="data.members"
        :occurrences="data.occurrences"
        @updated="refresh"
      />

      <!-- Date poll (not for series — the showtime IS the showtime) -->
      <UCard v-if="!isSeries && (data.poll.length || data.event.status === 'draft' || data.event.status === 'polling')">
        <template #header>
          <div>
            <p class="font-semibold">
              Find a date
            </p>
            <p class="text-sm text-muted">
              {{ isParty ? 'The core group votes; lock the winner, then open up.' : 'Propose options, start the poll, lock the winner.' }}
            </p>
          </div>
        </template>
        <div class="flex flex-col gap-3">
          <div
            v-for="opt in data.poll"
            :key="opt.id"
            class="flex items-center justify-between gap-2 flex-wrap py-2 border-b border-default last:border-b-0"
          >
            <div>
              <p class="font-medium">
                {{ when(opt.startsAt) }}
              </p>
              <p class="text-sm text-muted">
                ✅ {{ opt.tally.yes }} · 🤔 {{ opt.tally.ifneedbe }} · ❌ {{ opt.tally.no }}
                <span
                  v-if="opt.votes.length"
                  class="ml-1"
                >
                  — {{ opt.votes.map(v => `${v.name}: ${v.answer === 'ifneedbe' ? 'if need be' : v.answer}`).join(', ') }}
                </span>
              </p>
            </div>
            <div class="flex gap-1">
              <UButton
                v-if="data.event.status === 'polling' || data.event.status === 'draft'"
                size="xs"
                color="success"
                variant="soft"
                :loading="locking === opt.id"
                @click="lock(opt.id)"
              >
                Lock this date
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                @click="removeOption(opt.id)"
              >
                ✕
              </UButton>
            </div>
          </div>

          <form
            v-if="data.event.status === 'draft' || data.event.status === 'polling'"
            class="flex gap-2 items-end"
            @submit.prevent="addOption"
          >
            <UFormField
              label="Add an option"
              class="flex-1"
            >
              <UInput
                v-model="newOptionDate"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
            <UButton
              type="submit"
              :loading="addingOption"
              :disabled="!newOptionDate"
            >
              Add
            </UButton>
          </form>
        </div>
      </UCard>

      <!-- Invites (per-showing for series, so hidden on the container) -->
      <UCard v-if="!isSeries">
        <template #header>
          <div>
            <p class="font-semibold">
              Invites
            </p>
            <p class="text-sm text-muted">
              A shareable link for the group chat, or personal links per friend.
            </p>
          </div>
        </template>
        <div class="flex flex-col gap-3">
          <div
            v-for="inv in data.invites"
            :key="inv.id"
            class="flex items-center justify-between gap-2 flex-wrap py-2 border-b border-default last:border-b-0"
          >
            <div class="min-w-0">
              <p class="font-medium truncate">
                {{ inv.label || inv.name || 'Invite' }}
                <UBadge
                  v-if="isParty && inv.tier === 'core'"
                  color="info"
                  variant="subtle"
                  size="sm"
                >
                  core group
                </UBadge>
                <UBadge
                  v-if="inv.revokedAt"
                  color="error"
                  variant="subtle"
                  size="sm"
                >
                  revoked
                </UBadge>
              </p>
              <p class="text-sm text-muted">
                {{ inv.email || (inv.maxUses ? `personal · ${inv.usedCount}/${inv.maxUses} used` : `shareable · ${inv.usedCount} responses`) }}
              </p>
            </div>
            <div class="flex gap-1 shrink-0">
              <UButton
                size="xs"
                variant="outline"
                @click="copyInvite(inv.token)"
              >
                Copy link
              </UButton>
              <UButton
                v-if="!inv.revokedAt"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="revokeInvite(inv.id)"
              >
                Revoke
              </UButton>
            </div>
          </div>

          <div class="grid sm:grid-cols-2 gap-3 pt-2">
            <form
              class="flex flex-col gap-2"
              @submit.prevent="createInvite('shared')"
            >
              <p class="text-sm font-medium">
                Shareable link
              </p>
              <UInput
                v-model="inviteLabel"
                placeholder="Label (e.g. WhatsApp group)"
              />
              <UButton
                type="submit"
                :loading="creatingInvite"
                variant="outline"
                size="sm"
              >
                Create shareable link
              </UButton>
            </form>
            <form
              class="flex flex-col gap-2"
              @submit.prevent="createInvite('personal')"
            >
              <p class="text-sm font-medium">
                Personal invite
              </p>
              <UInput
                v-model="inviteName"
                placeholder="Friend's name"
              />
              <UInput
                v-model="inviteEmail"
                type="email"
                placeholder="Their email (optional)"
              />
              <UButton
                type="submit"
                :loading="creatingInvite"
                :disabled="!inviteName && !inviteEmail"
                variant="outline"
                size="sm"
              >
                Create personal link
              </UButton>
            </form>
          </div>
        </div>
      </UCard>

      <!-- Itinerary / the plan -->
      <HostTimelineCard
        v-if="!isSeries"
        :slug="slug"
        :timeline="data.timeline"
        :trip="isTrip"
        @updated="refresh"
      />

      <!-- Budget & splitting -->
      <BudgetCard
        v-if="(isTrip || data.budget.expenses.length) && me.email"
        :budget="data.budget"
        :add-url="`/api/host/events/${slug}/expenses`"
        :expenses-base="`/api/host/events/${slug}/expenses`"
        :participants="splitParticipants"
        :viewer="me"
        @updated="() => refresh()"
      />

      <!-- Bring list -->
      <UCard v-if="!isSeries && !isConcert">
        <template #header>
          <div>
            <p class="font-semibold">
              Bring list
            </p>
            <p class="text-sm text-muted">
              Seed what's needed; friends claim items on their invite page.
            </p>
          </div>
        </template>
        <div class="flex flex-col gap-2">
          <div
            v-for="c in data.contributions"
            :key="c.id"
            class="flex items-center justify-between gap-2 py-2 border-b border-default last:border-b-0"
          >
            <p class="font-medium">
              {{ CATEGORY_ICONS[c.category] }} {{ c.title }}
              <span
                v-if="c.claimed"
                class="text-sm text-muted font-normal"
              >— {{ c.claimedByName }}</span>
              <UBadge
                v-else
                color="neutral"
                variant="subtle"
                size="sm"
              >
                unclaimed
              </UBadge>
            </p>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="removeItem(c.id)"
            >
              ✕
            </UButton>
          </div>
          <form
            class="flex gap-2 pt-2"
            @submit.prevent="addItem"
          >
            <USelect
              v-model="itemCategory"
              :items="[
                { label: '🍲 Food', value: 'food' },
                { label: '🍹 Drink', value: 'drink' },
                { label: '📦 Other', value: 'other' }
              ]"
              class="w-32"
            />
            <UInput
              v-model="itemTitle"
              placeholder="Needed: big bowl of popcorn"
              class="flex-1"
            />
            <UButton
              type="submit"
              :loading="addingItem"
              :disabled="!itemTitle"
            >
              Add
            </UButton>
          </form>
        </div>
      </UCard>

      <!-- Media: gallery, documents, tickets -->
      <HostMediaCard
        :slug="slug"
        :rsvps="data.rsvps"
      />

      <!-- RSVPs -->
      <UCard v-if="!isSeries">
        <template #header>
          <div class="flex items-center justify-between">
            <p class="font-semibold">
              RSVPs
            </p>
            <UBadge
              variant="subtle"
              color="success"
            >
              {{ data.summary.headcount }} going
            </UBadge>
          </div>
        </template>
        <div class="flex flex-col gap-1">
          <div
            v-for="r in data.rsvps"
            :key="r.id"
            class="flex items-center justify-between gap-2 py-2 border-b border-default last:border-b-0 text-sm"
          >
            <div>
              <p class="font-medium">
                {{ r.guestName }}<span v-if="r.plusOne"> +1</span>
                <span class="text-muted font-normal ml-1">{{ r.guestEmail }}</span>
              </p>
              <p
                v-if="r.dietary || r.notes"
                class="text-muted"
              >
                <span v-if="r.dietary">🥗 {{ r.dietary }}</span>
                <span
                  v-if="r.notes"
                  class="ml-2"
                >💬 {{ r.notes }}</span>
              </p>
            </div>
            <UBadge
              :color="r.status === 'yes' ? 'success' : r.status === 'no' ? 'error' : 'warning'"
              variant="subtle"
            >
              {{ r.status }}
            </UBadge>
          </div>
          <p
            v-if="!data.rsvps.length"
            class="text-muted text-sm py-2"
          >
            No responses yet.
          </p>
        </div>
      </UCard>

      <!-- Organizer team -->
      <HostTeamCard :slug="slug" />

      <!-- Group chat -->
      <EventChat
        :list-url="`/api/host/events/${slug}/messages`"
        :post-url="`/api/host/events/${slug}/messages`"
        :viewer-email="me.email"
      />
    </template>
  </div>
</template>
