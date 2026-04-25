<script setup lang="ts">
import { z } from 'zod'

type EventType = 'hosted' | 'concert' | 'series'
type EventStatus = 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

interface InvitePayload {
  event: {
    id: string
    slug: string
    title: string
    type: EventType
    status: EventStatus
    description: string | null
    startsAt: string | null
    endsAt: string | null
    location: string | null
    venueStation: string | null
    ticketUrl: string | null
    performerNote: string | null
    isPublic: boolean
  }
  invite: {
    token: string
    label: string | null
    name: string | null
    email: string | null
    expiresAt: string | null
  }
  session: { id: string, name: string, email: string } | null
  existingRsvp: {
    id: string
    status: RsvpStatus
    plusOne: boolean
    plusOneName: string | null
    dietary: string | null
    accessibility: string | null
    notes: string | null
    guestName: string | null
    guestEmail: string | null
  } | null
}

const route = useRoute()
const token = route.params.token as string

const { data, error, refresh } = await useFetch<InvitePayload>(`/api/invites/${token}`, {
  key: `invite-${token}`
})

const { STATUS_LABELS } = useRsvpLabels()

// --- OG / SEO meta (runs on SSR) ---
const pageUrl = useRequestURL().href
watchEffect(() => {
  if (!data.value) return
  const ev = data.value.event
  const when = ev.startsAt
    ? new Date(ev.startsAt).toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' })
    : null
  const descParts = [when, ev.location, ev.description?.slice(0, 160)].filter(Boolean)
  const description = descParts.join(' · ') || 'You are invited.'
  useSeoMeta({
    title: `${ev.title} — zäme`,
    description,
    ogTitle: ev.title,
    ogDescription: description,
    ogType: 'website',
    ogUrl: pageUrl,
    twitterCard: 'summary_large_image'
  })
})

// --- Form state ---
const statusOptions = computed(() => {
  const base: { value: RsvpStatus, label: string }[] = [
    { value: 'yes', label: STATUS_LABELS.yes },
    { value: 'maybe', label: STATUS_LABELS.maybe },
    { value: 'no', label: STATUS_LABELS.no }
  ]
  if (data.value?.event.type === 'concert') {
    base.unshift({ value: 'cheering', label: STATUS_LABELS.cheering })
  }
  return base
})

const rsvpSchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  guestName: z.string().min(1, 'Required').max(200).optional(),
  guestEmail: z.email('Enter a valid email').optional(),
  plusOne: z.boolean().optional(),
  plusOneName: z.string().max(200).optional(),
  dietary: z.string().max(500).optional(),
  accessibility: z.string().max(500).optional(),
  notes: z.string().max(2000).optional()
})

type RsvpForm = z.infer<typeof rsvpSchema>

const state = reactive<Partial<RsvpForm>>({
  status: undefined,
  plusOne: false
})

// Pre-fill from session or existing rsvp
watchEffect(() => {
  if (!data.value) return
  const { session, existingRsvp, invite: inv } = data.value
  if (existingRsvp) {
    state.status = existingRsvp.status
    state.plusOne = existingRsvp.plusOne
    state.plusOneName = existingRsvp.plusOneName ?? undefined
    state.dietary = existingRsvp.dietary ?? undefined
    state.accessibility = existingRsvp.accessibility ?? undefined
    state.notes = existingRsvp.notes ?? undefined
    state.guestName = existingRsvp.guestName ?? session?.name
    state.guestEmail = existingRsvp.guestEmail ?? session?.email
  } else {
    state.guestName = session?.name ?? inv.name ?? undefined
    state.guestEmail = session?.email ?? inv.email ?? undefined
  }
})

const submitting = ref(false)
const submitError = ref<string | null>(null)
const magicLinkUrl = ref<string | null>(null)
const toast = useToast()

async function onSubmit() {
  submitting.value = true
  submitError.value = null
  try {
    const payload: Record<string, unknown> = {
      status: state.status,
      plusOne: !!state.plusOne,
      plusOneName: state.plusOne ? (state.plusOneName ?? null) : null,
      dietary: state.dietary || null,
      accessibility: state.accessibility || null,
      notes: state.notes || null
    }
    if (!data.value?.session) {
      payload.guestName = state.guestName
      payload.guestEmail = state.guestEmail
    }

    const res = await $fetch<{ rsvp: unknown, magicLinkUrl: string | null }>(
      `/api/invites/${token}/rsvp`,
      { method: 'POST', body: payload }
    )
    magicLinkUrl.value = res.magicLinkUrl
    toast.add({ title: 'RSVP saved', color: 'success' })
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    submitError.value = e?.data?.message ?? 'Failed to submit RSVP. Please try again.'
  } finally {
    submitting.value = false
  }
}

const formattedStart = computed(() =>
  data.value?.event.startsAt
    ? new Date(data.value.event.startsAt).toLocaleString('en-CH', { dateStyle: 'full', timeStyle: 'short' })
    : null
)
const formattedEnd = computed(() =>
  data.value?.event.endsAt
    ? new Date(data.value.event.endsAt).toLocaleString('en-CH', { dateStyle: 'full', timeStyle: 'short' })
    : null
)
</script>

<template>
  <UContainer class="py-8 max-w-2xl">
    <!-- Error (revoked / expired / missing) -->
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      title="This invite isn't available"
      :description="(error as unknown as { data?: { message?: string } })?.data?.message ?? 'The link may have expired or been revoked.'"
    />

    <template v-else-if="data">
      <div class="mb-6">
        <UBadge
          v-if="data.event.type === 'concert'"
          color="primary"
          variant="subtle"
          icon="i-lucide-music"
          class="mb-3"
        >
          Concert
        </UBadge>
        <h1 class="text-3xl font-bold tracking-tight">
          {{ data.event.title }}
        </h1>
        <p
          v-if="data.invite.name"
          class="text-muted mt-2"
        >
          Hi {{ data.invite.name }} — you're invited.
        </p>
        <p
          v-else
          class="text-muted mt-2"
        >
          You're invited. Let the hosts know if you can make it.
        </p>
      </div>

      <!-- Event details -->
      <UCard class="mb-6">
        <dl class="space-y-3 text-sm">
          <div
            v-if="formattedStart"
            class="flex gap-3"
          >
            <dt class="text-muted w-24 shrink-0 flex items-center gap-1.5">
              <UIcon
                name="i-lucide-calendar"
                class="size-3.5"
              />
              When
            </dt>
            <dd>
              {{ formattedStart }}
              <span
                v-if="formattedEnd"
                class="text-muted"
              >
                → {{ formattedEnd }}
              </span>
            </dd>
          </div>
          <div
            v-if="data.event.location"
            class="flex gap-3"
          >
            <dt class="text-muted w-24 shrink-0 flex items-center gap-1.5">
              <UIcon
                name="i-lucide-map-pin"
                class="size-3.5"
              />
              Where
            </dt>
            <dd>{{ data.event.location }}</dd>
          </div>
          <div
            v-if="data.event.ticketUrl"
            class="flex gap-3"
          >
            <dt class="text-muted w-24 shrink-0 flex items-center gap-1.5">
              <UIcon
                name="i-lucide-ticket"
                class="size-3.5"
              />
              Tickets
            </dt>
            <dd>
              <UButton
                :to="data.event.ticketUrl"
                external
                target="_blank"
                variant="link"
                size="xs"
                class="p-0"
                label="Buy tickets"
                trailing-icon="i-lucide-external-link"
              />
            </dd>
          </div>
          <div
            v-if="data.event.performerNote"
            class="flex gap-3"
          >
            <dt class="text-muted w-24 shrink-0">
              Lineup
            </dt>
            <dd>{{ data.event.performerNote }}</dd>
          </div>
        </dl>
        <div
          v-if="data.event.description"
          class="mt-4 pt-4 border-t border-default whitespace-pre-wrap text-sm"
        >
          {{ data.event.description }}
        </div>
      </UCard>

      <!-- Date poll: shown when the event is still being scheduled.
           The component fetches its own data and renders nothing if there
           is no poll for this event. -->
      <InviteDatePoll
        v-if="data.event.status === 'polling' || data.event.status === 'draft'"
        :token="token"
        :default-name="data.session?.name ?? data.invite.name ?? null"
        :default-email="data.session?.email ?? data.invite.email ?? null"
        :hide-identity="!!data.session"
        class="mb-6"
      />

      <!-- RSVP form -->
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-semibold">
              {{ data.existingRsvp ? 'Update your RSVP' : 'RSVP' }}
            </h2>
            <UBadge
              v-if="data.session"
              variant="subtle"
              color="primary"
              icon="i-lucide-user-check"
            >
              Signed in as {{ data.session.name }}
            </UBadge>
          </div>
        </template>

        <UForm
          :schema="rsvpSchema"
          :state="state"
          class="space-y-5"
          @submit="onSubmit"
        >
          <UFormField
            label="Your answer"
            name="status"
            required
          >
            <div class="flex flex-wrap gap-2">
              <UButton
                v-for="opt in statusOptions"
                :key="opt.value"
                :variant="state.status === opt.value ? 'solid' : 'outline'"
                :color="state.status === opt.value ? 'primary' : 'neutral'"
                :label="opt.label"
                size="sm"
                type="button"
                @click="state.status = opt.value"
              />
            </div>
          </UFormField>

          <!-- Guest identity (only when not signed in) -->
          <template v-if="!data.session">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <UFormField
                label="Your name"
                name="guestName"
                required
              >
                <UInput
                  v-model="state.guestName"
                  class="w-full"
                  placeholder="Jane Doe"
                />
              </UFormField>
              <UFormField
                label="Email"
                name="guestEmail"
                required
                help="We'll send confirmations here."
              >
                <UInput
                  v-model="state.guestEmail"
                  type="email"
                  class="w-full"
                  placeholder="jane@example.com"
                  :disabled="!!data.invite.email"
                />
              </UFormField>
            </div>
          </template>

          <!-- Extras only when going / maybe / cheering -->
          <template v-if="state.status && state.status !== 'no'">
            <UFormField
              label="Bringing someone?"
              name="plusOne"
            >
              <UCheckbox
                v-model="state.plusOne"
                label="I'm bringing a +1"
              />
            </UFormField>

            <UFormField
              v-if="state.plusOne"
              label="Their name"
              name="plusOneName"
            >
              <UInput
                v-model="state.plusOneName"
                class="w-full"
                placeholder="Plus-one name"
              />
            </UFormField>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <UFormField
                label="Dietary needs"
                name="dietary"
                help="Allergies, vegan, etc."
              >
                <UInput
                  v-model="state.dietary"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Accessibility"
                name="accessibility"
                help="Anything the host should know."
              >
                <UInput
                  v-model="state.accessibility"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UFormField
              label="Note for the host"
              name="notes"
            >
              <UTextarea
                v-model="state.notes"
                :rows="3"
                class="w-full"
                placeholder="Optional message"
              />
            </UFormField>
          </template>

          <UAlert
            v-if="submitError"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-circle"
            :description="submitError"
          />

          <UAlert
            v-if="magicLinkUrl"
            color="primary"
            variant="subtle"
            icon="i-lucide-mail"
            title="Magic link generated"
            description="We'll email you a link to update your RSVP later. While the email system is being built, you can use the link below."
          >
            <template #actions>
              <UButton
                :to="magicLinkUrl"
                external
                label="Open magic link"
                size="xs"
                variant="outline"
              />
            </template>
          </UAlert>

          <div class="flex justify-end pt-2">
            <UButton
              type="submit"
              :label="data.existingRsvp ? 'Update RSVP' : 'Submit RSVP'"
              :loading="submitting"
              :disabled="!state.status"
              icon="i-lucide-send"
            />
          </div>
        </UForm>
      </UCard>

      <!-- Media gallery: visible after RSVP on published/completed events -->
      <MediaGallery
        v-if="data.existingRsvp
          && data.existingRsvp.status !== 'no'
          && (data.event.status === 'published' || data.event.status === 'completed')"
        :slug="data.event.slug"
        :rsvp-token="data.invite.token"
        class="mt-6"
      />
    </template>
  </UContainer>
</template>
