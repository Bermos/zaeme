<script setup lang="ts">
import { z } from 'zod'

const route = useRoute()
const rsvpToken = route.params.token as string

type EventStatus = 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
type EventType = 'hosted' | 'concert' | 'series'
type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

interface Payload {
  attendee: {
    id: string
    name: string
    email: string
    rsvpStatus: RsvpStatus
    plusOne: number
    dietary: string | null
    accessibility: string | null
    note: string | null
  }
  event: {
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
  }
}

const { data, error, refresh } = await useFetch<Payload>(`/api/rsvp/${rsvpToken}`)

watchEffect(() => {
  if (data.value) {
    useSeoMeta({ title: `${data.value.event.title} — Your RSVP` })
  }
})

const isConcert = computed(() => data.value?.event.type === 'concert')
const acceptsRsvp = computed(() =>
  data.value?.event.status === 'polling' || data.value?.event.status === 'published'
)

const schema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  plusOne: z.boolean(),
  dietary: z.string().max(500).optional(),
  accessibility: z.string().max(500).optional(),
  note: z.string().max(2000).optional()
})
type Schema = z.output<typeof schema>
const state = reactive<Partial<Schema>>({})

watchEffect(() => {
  if (!data.value) return
  const a = data.value.attendee
  state.name = a.name
  state.status = a.rsvpStatus
  state.plusOne = a.plusOne > 0
  state.dietary = a.dietary ?? ''
  state.accessibility = a.accessibility ?? ''
  state.note = a.note ?? ''
})

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

const toast = useToast()
const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await $fetch(`/api/rsvp/${rsvpToken}`, {
      method: 'PATCH',
      body: {
        name: state.name,
        status: state.status,
        plusOne: state.plusOne ? 1 : 0,
        dietary: state.dietary || null,
        accessibility: state.accessibility || null,
        note: state.note || null
      }
    })
    await refresh()
    toast.add({ title: 'RSVP updated', color: 'success' })
  } catch (err: unknown) {
    const errObj = err as { data?: { message?: string } }
    toast.add({
      title: 'Error',
      description: errObj?.data?.message ?? 'Failed to update RSVP',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 max-w-2xl">
    <div
      v-if="error"
      class="py-16"
    >
      <UPageHero
        title="RSVP not found"
        description="This link may be invalid or the RSVP has been removed."
      />
    </div>

    <template v-else-if="data">
      <UCard class="mb-6">
        <template #header>
          <h1 class="text-xl font-bold">
            {{ data.event.title }}
          </h1>
          <p class="text-muted text-sm mt-1">
            Manage your RSVP
          </p>
        </template>

        <dl class="space-y-2 text-sm">
          <div
            v-if="data.event.startsAt"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-clock"
              class="size-4 text-muted"
            />
            <span>{{ new Date(data.event.startsAt).toLocaleString('en-CH', { dateStyle: 'full', timeStyle: 'short' }) }}</span>
          </div>
          <div
            v-if="data.event.location"
            class="flex items-center gap-2"
          >
            <UIcon
              name="i-lucide-map-pin"
              class="size-4 text-muted"
            />
            <span>{{ data.event.location }}</span>
          </div>
        </dl>
      </UCard>

      <UAlert
        v-if="!acceptsRsvp"
        color="warning"
        variant="subtle"
        title="This event is no longer accepting RSVPs"
        :description="`Current status: ${data.event.status}`"
        class="mb-4"
      />

      <UCard>
        <template #header>
          <h2 class="font-semibold">
            Your response
          </h2>
        </template>

        <UForm
          :schema="schema"
          :state="state"
          class="space-y-4"
          :disabled="!acceptsRsvp"
          @submit="save"
        >
          <UFormField
            label="Name"
            name="name"
            required
          >
            <UInput
              v-model="state.name"
              class="w-full"
              :disabled="!acceptsRsvp"
            />
          </UFormField>

          <UFormField
            label="Email"
            name="email"
          >
            <UInput
              :model-value="data.attendee.email"
              class="w-full"
              disabled
            />
          </UFormField>

          <UFormField
            label="Response"
            name="status"
            required
          >
            <USelect
              v-model="state.status"
              :options="statusOptions"
              class="w-full"
              :disabled="!acceptsRsvp"
            />
          </UFormField>

          <UFormField
            v-if="!isConcert && state.status === 'yes'"
            label="Plus-one"
            name="plusOne"
          >
            <UCheckbox
              v-model="state.plusOne"
              label="Bringing a +1"
              :disabled="!acceptsRsvp"
            />
          </UFormField>

          <template v-if="!isConcert && state.status !== 'no'">
            <UFormField
              label="Dietary requirements"
              name="dietary"
            >
              <UInput
                v-model="state.dietary"
                class="w-full"
                :disabled="!acceptsRsvp"
              />
            </UFormField>
            <UFormField
              label="Accessibility needs"
              name="accessibility"
            >
              <UInput
                v-model="state.accessibility"
                class="w-full"
                :disabled="!acceptsRsvp"
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
              :disabled="!acceptsRsvp"
            />
          </UFormField>

          <UButton
            type="submit"
            label="Save changes"
            :loading="saving"
            :disabled="!acceptsRsvp"
            block
          />
        </UForm>
      </UCard>
    </template>
  </UContainer>
</template>
