<script setup lang="ts">
import { z } from 'zod'

useSeoMeta({ title: 'zäme — New Event' })

definePageMeta({ middleware: 'auth' })

const schema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  type: z.enum(['hosted', 'concert', 'series']).default('hosted'),
  description: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().optional(),
  venueStation: z.string().optional(),
  ticketUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
  performerNote: z.string().optional(),
  parentId: z.string().optional()
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  title: undefined,
  type: 'hosted',
  description: undefined,
  startsAt: undefined,
  endsAt: undefined,
  location: undefined,
  venueStation: undefined,
  ticketUrl: undefined,
  performerNote: undefined
})

const loading = ref(false)
const error = ref<string | null>(null)
const toast = useToast()
const router = useRouter()

const typeOptions = [
  { label: 'Hosted', value: 'hosted', icon: 'i-lucide-calendar' },
  { label: 'Concert', value: 'concert', icon: 'i-lucide-music' },
  { label: 'Series', value: 'series', icon: 'i-lucide-layers' }
]

async function onSubmit() {
  loading.value = true
  error.value = null

  try {
    const payload: Record<string, unknown> = {
      title: state.title,
      type: state.type
    }
    if (state.description) payload.description = state.description
    if (state.startsAt) payload.startsAt = new Date(state.startsAt).toISOString()
    if (state.endsAt) payload.endsAt = new Date(state.endsAt).toISOString()
    if (state.location) payload.location = state.location
    if (state.venueStation) payload.venueStation = state.venueStation
    if (state.ticketUrl) payload.ticketUrl = state.ticketUrl
    if (state.performerNote) payload.performerNote = state.performerNote
    if (state.parentId) payload.parentId = state.parentId

    const result = await $fetch<{ slug: string }>('/api/events', {
      method: 'POST',
      body: payload
    })

    toast.add({ title: 'Event created', description: 'Your event is ready.', color: 'success' })
    await router.push(`/events/${result.slug}`)
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    error.value = e?.data?.message ?? 'Failed to create event. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 max-w-2xl">
    <div class="flex items-center gap-3 mb-8">
      <UButton
        to="/dashboard"
        icon="i-lucide-arrow-left"
        variant="ghost"
        size="sm"
      />
      <div>
        <h1 class="text-2xl font-bold">
          New Event
        </h1>
        <p class="text-muted text-sm mt-0.5">
          Fill in the details below. You can edit everything later.
        </p>
      </div>
    </div>

    <UCard>
      <UForm
        :schema="schema"
        :state="state"
        class="space-y-6"
        @submit="onSubmit"
      >
        <!-- Event type -->
        <UFormField
          label="Event type"
          name="type"
        >
          <div class="flex gap-2 flex-wrap">
            <UButton
              v-for="opt in typeOptions"
              :key="opt.value"
              :variant="state.type === opt.value ? 'solid' : 'outline'"
              :color="state.type === opt.value ? 'primary' : 'neutral'"
              :icon="opt.icon"
              :label="opt.label"
              size="sm"
              type="button"
              @click="state.type = opt.value as Schema['type']"
            />
          </div>
        </UFormField>

        <!-- Title -->
        <UFormField
          label="Title"
          name="title"
          required
        >
          <UInput
            v-model="state.title"
            placeholder="e.g. Summer hiking trip"
            class="w-full"
          />
        </UFormField>

        <!-- Description -->
        <UFormField
          label="Description"
          name="description"
        >
          <UTextarea
            v-model="state.description"
            placeholder="What's the plan? (optional)"
            :rows="4"
            class="w-full"
          />
        </UFormField>

        <!-- Dates -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UFormField
            label="Start date & time"
            name="startsAt"
          >
            <UInput
              v-model="state.startsAt"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="End date & time"
            name="endsAt"
          >
            <UInput
              v-model="state.endsAt"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>
        </div>

        <!-- Location -->
        <UFormField
          label="Location"
          name="location"
        >
          <UInput
            v-model="state.location"
            placeholder="e.g. Zurich, Switzerland"
            icon="i-lucide-map-pin"
            class="w-full"
          />
        </UFormField>

        <!-- Concert-specific fields -->
        <template v-if="state.type === 'concert'">
          <UFormField
            label="Ticket URL"
            name="ticketUrl"
          >
            <UInput
              v-model="state.ticketUrl"
              placeholder="https://..."
              icon="i-lucide-ticket"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Performer note"
            name="performerNote"
          >
            <UInput
              v-model="state.performerNote"
              placeholder="e.g. Supporting act: ..."
              class="w-full"
            />
          </UFormField>
        </template>

        <!-- Venue station (all types can have this) -->
        <UFormField
          label="Venue station"
          name="venueStation"
          :help="'The nearest train station — used for travel group coordination'"
        >
          <UInput
            v-model="state.venueStation"
            placeholder="e.g. Bern HB"
            icon="i-lucide-train-front"
            class="w-full"
          />
        </UFormField>

        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :description="error"
          icon="i-lucide-alert-circle"
        />

        <div class="flex justify-end gap-3">
          <UButton
            to="/dashboard"
            variant="ghost"
            label="Cancel"
          />
          <UButton
            type="submit"
            label="Create event"
            :loading="loading"
            icon="i-lucide-sparkles"
          />
        </div>
      </UForm>
    </UCard>
  </UContainer>
</template>
