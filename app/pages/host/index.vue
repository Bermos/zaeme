<script setup lang="ts">
/** The gatherings you're planning. */
definePageMeta({ middleware: 'guest-auth' })

const { data, error } = await useFetch('/api/host/events')

function when(iso: string | Date | null): string {
  return iso ? new Date(iso).toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date TBD'
}

const STATUS_COLOR: Record<string, 'neutral' | 'warning' | 'success' | 'error'> = {
  draft: 'neutral',
  polling: 'warning',
  published: 'success',
  completed: 'neutral',
  cancelled: 'error'
}
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">
        Hosting
      </h1>
      <UButton to="/host/new">
        Plan a gathering
      </UButton>
    </div>

    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      description="Sign in to plan gatherings."
    >
      <template #actions>
        <UButton
          to="/login?redirect=/host"
          size="xs"
        >
          Sign in
        </UButton>
      </template>
    </UAlert>

    <template v-else-if="data">
      <UCard
        v-for="ev in data.events"
        :key="ev.id"
      >
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <p class="font-medium">
              {{ ev.title }}
            </p>
            <p class="text-sm text-muted">
              {{ when(ev.startsAt) }}<span v-if="ev.location"> · {{ ev.location }}</span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UBadge
              :color="STATUS_COLOR[ev.status] ?? 'neutral'"
              variant="subtle"
            >
              {{ ev.status }}
            </UBadge>
            <UButton
              :to="`/host/${ev.slug}`"
              size="xs"
              variant="outline"
            >
              Manage
            </UButton>
          </div>
        </div>
      </UCard>

      <p
        v-if="!data.events.length"
        class="text-muted"
      >
        No gatherings yet — plan your first movie night!
      </p>
    </template>
  </div>
</template>
