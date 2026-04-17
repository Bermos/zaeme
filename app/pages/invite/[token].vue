<script setup lang="ts">
import { z } from 'zod'

const route = useRoute()
const token = route.params.token as string

type EventStatus = 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
type EventType = 'hosted' | 'concert' | 'series'
type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

interface InviteEvent {
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

interface InvitePayload {
  token: string
  event: InviteEvent
}

interface AttendeeRow {
  id: string
  name: string
  email: string
  rsvpStatus: RsvpStatus
  plusOne: number
  dietary: string | null
  accessibility: string | null
  note: string | null
  rsvpToken: string
}

// SSR-safe fetch so OG crawlers see the full page.
const { data, error } = await useFetch<InvitePayload>(`/api/invite/${token}`)

const { data: session } = await authClient.useSession(useFetch)

const ev = computed(() => data.value?.event ?? null)
const isConcert = computed(() => ev.value?.type === 'concert')

// SEO + OG — built off the server-rendered data so crawlers pick it up.
watchEffect(() => {
  if (!ev.value) return
  const title = `${ev.value.title} — zäme`
  const description = ev.value.description?.slice(0, 200)
    ?? (ev.value.location ? `Join us at ${ev.value.location}` : 'You are invited.')
  useSeoMeta({
    title,
    description,
    ogTitle: ev.value.title,
    ogDescription: description,
    ogType: 'website',
    twitterCard: 'summary_large_image',
    twitterTitle: ev.value.title,
    twitterDescription: description
  })
})

// If the visitor is not signed in, we collect name + email. If they are,
// those fields come from their session and are hidden.
const schema = z.object({
  name: z.string().min(1, 'Name is required').max(200).optional(),
  email: z.email('Enter a valid email').optional(),
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  plusOne: z.boolean().optional(),
  dietary: z.string().max(500).optional(),
  accessibility: z.string().max(500).optional(),
  note: z.string().max(2000).optional()
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  status: undefined,
  plusOne: false,
  dietary: '',
  accessibility: '',
  note: ''
})

const toast = useToast()
const submitting = ref(false)
const submitted = ref<AttendeeRow | null>(null)

async function submit() {
  if (!ev.value) return
  submitting.value = true
  try {
    const payload: Record<string, unknown> = {
      status: state.status,
      plusOne: state.plusOne ? 1 : 0,
      dietary: state.dietary || null,
      accessibility: state.accessibility || null,
      note: state.note || null
    }
    if (!session.value?.user) {
      payload.name = state.name
      payload.email = state.email
    }
    const res = await $fetch<AttendeeRow>(`/api/invite/${token}/rsvp`, {
      method: 'POST',
      body: payload
    })
    submitted.value = res
    toast.add({ title: 'RSVP recorded', color: 'success' })
  } catch (err: unknown) {
    const errObj = err as { data?: { message?: string } }
    toast.add({
      title: 'Error',
      description: errObj?.data?.message ?? 'Failed to submit RSVP',
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

const manageUrl = computed(() =>
  submitted.value ? `/rsvp/${submitted.value.rsvpToken}` : null
)

const statusOptions = computed(() => {
  if (isConcert.value) {
    return [{ label: 'I\'m cheering', value: 'cheering' as const }]
  }
  return [
    { label: 'Yes — I\'ll be there', value: 'yes' as const },
    { label: 'Maybe', value: 'maybe' as const },
    { label: 'No — can\'t make it', value: 'no' as const }
  ]
})

// Pre-select the only possible status for concerts.
watchEffect(() => {
  if (isConcert.value && !state.status) state.status = 'cheering'
})
</script>

<template>
  <UContainer class="py-8 max-w-2xl">
    <div
      v-if="error"
      class="py-16"
    >
      <UPageHero
        title="Invite not found"
        description="This invite link may have been rotated or the event is no longer open."
      />
    </div>

    <template v-else-if="ev">
      <!-- Event header -->
      <UCard class="mb-6">
        <template #header>
          <div class="flex items-center gap-2 text-muted text-xs uppercase tracking-wide mb-1">
            <UIcon
              :name="ev.type === 'concert' ? 'i-lucide-music' : ev.type === 'series' ? 'i-lucide-layers' : 'i-lucide-calendar'"
              class="size-3.5"
            />
            <span>You're invited</span>
          </div>
          <h1 class="text-2xl font-bold">
            {{ ev.title }}
          </h1>
        </template>

        <dl class="space-y-2 text-sm">
          <div
            v-if="ev.startsAt"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-clock"
              class="size-4 text-muted"
            />
            <span>{{ new Date(ev.startsAt).toLocaleString('en-CH', { dateStyle: 'full', timeStyle: 'short' }) }}</span>
          </div>
          <div
            v-if="ev.location"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-map-pin"
              class="size-4 text-muted"
            />
            <span>{{ ev.location }}</span>
          </div>
          <div
            v-if="ev.ticketUrl"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-ticket"
              class="size-4 text-muted"
            />
            <UButton
              :to="ev.ticketUrl"
              external
              variant="link"
              size="xs"
              label="Tickets"
              class="p-0"
            />
          </div>
          <div
            v-if="ev.performerNote"
            class="flex items-start gap-2"
          >
            <UIcon
              name="i-lucide-mic"
              class="size-4 text-muted mt-0.5"
            />
            <span>{{ ev.performerNote }}</span>
          </div>
        </dl>

        <p
          v-if="ev.description"
          class="mt-4 pt-4 border-t border-default text-sm whitespace-pre-wrap"
        >
          {{ ev.description }}
        </p>
      </UCard>

      <!-- RSVP form or confirmation -->
      <UCard v-if="!submitted">
        <template #header>
          <h2 class="font-semibold">
            {{ isConcert ? 'Let them know you\'re coming' : 'Your RSVP' }}
          </h2>
        </template>

        <UForm
          :schema="schema"
          :state="state"
          class="space-y-4"
          @submit="submit"
        >
          <template v-if="!session?.user">
            <UFormField
              label="Your name"
              name="name"
              required
            >
              <UInput
                v-model="state.name"
                class="w-full"
                autocomplete="name"
              />
            </UFormField>
            <UFormField
              label="Email"
              name="email"
              required
              help="So we can send you the confirmation and updates."
            >
              <UInput
                v-model="state.email"
                type="email"
                class="w-full"
                autocomplete="email"
              />
            </UFormField>
          </template>
          <div
            v-else
            class="text-sm text-muted"
          >
            Signed in as <span class="font-medium text-default">{{ session.user.email }}</span>
          </div>

          <UFormField
            label="Response"
            name="status"
            required
          >
            <USelect
              v-model="state.status"
              :options="statusOptions"
              class="w-full"
              placeholder="Select..."
            />
          </UFormField>

          <UFormField
            v-if="!isConcert && state.status === 'yes'"
            label="Bringing a plus-one?"
            name="plusOne"
          >
            <UCheckbox
              v-model="state.plusOne"
              label="Yes, I'm bringing a +1"
            />
          </UFormField>

          <template v-if="!isConcert && state.status !== 'no'">
            <UFormField
              label="Dietary requirements"
              name="dietary"
            >
              <UInput
                v-model="state.dietary"
                placeholder="e.g. vegetarian, nut allergy"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Accessibility needs"
              name="accessibility"
            >
              <UInput
                v-model="state.accessibility"
                placeholder="e.g. step-free access"
                class="w-full"
              />
            </UFormField>
          </template>

          <UFormField
            label="Note for the host"
            name="note"
          >
            <UTextarea
              v-model="state.note"
              :rows="2"
              class="w-full"
            />
          </UFormField>

          <UButton
            type="submit"
            :label="isConcert ? 'Count me in' : 'Send RSVP'"
            :loading="submitting"
            :disabled="!state.status"
            block
          />
        </UForm>
      </UCard>

      <UCard v-else>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-check-circle-2"
              class="size-5 text-success"
            />
            <h2 class="font-semibold">
              Thanks — your RSVP is in
            </h2>
          </div>
        </template>

        <p class="text-sm mb-3">
          You responded <span class="font-medium">{{ submitted.rsvpStatus }}</span>
          <template v-if="submitted.plusOne">
            (+1)
          </template>.
        </p>
        <p
          v-if="manageUrl"
          class="text-sm text-muted"
        >
          Bookmark this link to change your response later:
        </p>
        <UButton
          v-if="manageUrl"
          :to="manageUrl"
          variant="soft"
          icon="i-lucide-link"
          :label="manageUrl"
          class="mt-2"
        />
      </UCard>
    </template>
  </UContainer>
</template>
