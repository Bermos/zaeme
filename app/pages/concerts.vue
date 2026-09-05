<script setup lang="ts">
/**
 * The public listing — upcoming concerts (and any other public events).
 * Open to the world; the "I go" lives on each event's page.
 */
const { data } = await useFetch('/api/public/events')

useSeoMeta({
  title: 'Concerts',
  description: 'Upcoming concerts — see who else is going and coordinate.'
})

function when(iso: string | Date | null): string {
  return iso
    ? new Date(iso).toLocaleString('en-CH', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : 'date TBD'
}
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <div>
      <h1 class="text-3xl font-bold">
        🎤 Concerts
      </h1>
      <p class="text-muted mt-1">
        Where I'll be on stage next. Say "I go" and find who else is coming.
      </p>
    </div>

    <div
      v-if="data?.events?.length"
      class="flex flex-col gap-4"
    >
      <NuxtLink
        v-for="ev in data.events"
        :key="ev.slug"
        :to="`/e/${ev.slug}`"
      >
        <UCard class="hover:ring-2 hover:ring-primary/40 transition">
          <div class="flex gap-4">
            <img
              v-if="ev.posterUrl"
              :src="ev.posterUrl"
              alt=""
              class="w-20 h-20 rounded object-cover shrink-0"
            >
            <div class="min-w-0">
              <p class="font-semibold text-lg truncate">{{ ev.title }}</p>
              <p class="text-sm text-muted">🗓️ {{ when(ev.startsAt) }}</p>
              <p
                v-if="ev.location"
                class="text-sm text-muted"
              >📍 {{ ev.location }}</p>
              <p
                v-if="ev.performerNote"
                class="text-sm text-muted truncate"
              >{{ ev.performerNote }}</p>
            </div>
            <UBadge
              v-if="ev.goingCount"
              variant="subtle"
              color="success"
              class="ml-auto self-start shrink-0"
            >
              {{ ev.goingCount }} going
            </UBadge>
          </div>
        </UCard>
      </NuxtLink>
    </div>
    <UAlert
      v-else
      color="neutral"
      variant="subtle"
      description="Nothing announced right now — check back soon."
    />
  </div>
</template>
