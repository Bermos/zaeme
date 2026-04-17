<script setup lang="ts">
import { z } from 'zod'

useSeoMeta({ title: 'zäme — Welcome' })

const { data: session } = await authClient.useSession(useFetch)

const schema = z.object({
  eventId: z.string().min(1, 'Please enter an event ID')
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  eventId: undefined
})

const router = useRouter()

async function goToEvent() {
  if (!state.eventId?.trim()) return
  await router.push(`/events/${state.eventId.trim()}`)
}
</script>

<template>
  <div>
    <UPageHero
      title="zäme"
      description="Plan events together — invites, RSVPs, travel coordination and more."
    >
      <template #links>
        <UButton
          v-if="!session"
          to="/login"
          label="Log in"
          size="xl"
          icon="i-lucide-log-in"
        />
        <UButton
          v-else
          to="/dashboard"
          label="Go to dashboard"
          size="xl"
          icon="i-lucide-layout-dashboard"
        />
      </template>
    </UPageHero>

    <UPageSection>
      <div class="max-w-md mx-auto">
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold">
              Join an event
            </h2>
            <p class="text-sm text-muted mt-1">
              Enter an event ID to view its details or RSVP.
            </p>
          </template>

          <UForm
            :schema="schema"
            :state="state"
            class="space-y-4"
            @submit="goToEvent"
          >
            <UFormField
              label="Event ID"
              name="eventId"
            >
              <UInput
                v-model="state.eventId"
                placeholder="e.g. abc123xyz"
                size="lg"
                class="w-full"
                @keydown.enter="goToEvent"
              />
            </UFormField>

            <UButton
              type="submit"
              label="Go to event"
              trailing-icon="i-lucide-arrow-right"
              block
            />
          </UForm>
        </UCard>
      </div>
    </UPageSection>
  </div>
</template>
