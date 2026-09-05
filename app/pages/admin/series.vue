<script setup lang="ts">
/**
 * Series and their occurrences. The host page manages ONE series' crew and
 * showings; this is the shape across all of them — which cinema is still
 * running, which has nothing scheduled, how the turnout is trending.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Series' })

const { data, pending } = await useFetch('/api/admin/series')
</script>

<template>
  <div class="flex flex-col gap-4">
    <p
      v-if="pending && !data"
      class="text-muted"
    >
      Loading…
    </p>

    <UCard
      v-for="s in data?.series ?? []"
      :key="s.id"
    >
      <template #header>
        <div class="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <p class="font-semibold">
              🍿 {{ s.title }}
              <UBadge
                variant="subtle"
                :color="eventStatusColor(s.status)"
              >
                {{ s.status }}
              </UBadge>
            </p>
            <p class="text-sm text-muted">
              {{ s.memberCount }} regular<span v-if="s.memberCount !== 1">s</span> ·
              {{ s.occurrenceCount }} showing<span v-if="s.occurrenceCount !== 1">s</span>
              <span v-if="s.cadence"> · 🔁 {{ s.cadence }}</span>
            </p>
          </div>
          <UButton
            :to="`/host/${s.slug}`"
            size="xs"
            variant="outline"
          >
            Manage the crew
          </UButton>
        </div>
      </template>

      <div class="flex flex-col text-sm">
        <p
          v-if="s.next"
          class="pb-2 mb-1 border-b border-default"
        >
          <span class="text-muted">Next: </span>
          <NuxtLink
            :to="`/host/${s.next.slug}`"
            class="font-medium hover:text-primary"
          >{{ s.next.title }}</NuxtLink>
          <span class="text-muted"> · {{ formatWhen(s.next.startsAt) }} · {{ s.next.yesCount }} signed up</span>
        </p>
        <p
          v-else
          class="pb-2 mb-1 border-b border-default text-muted"
        >
          Nothing scheduled — the cinema is dark.
        </p>

        <NuxtLink
          v-for="occ in s.occurrences.slice(0, 8)"
          :key="occ.id"
          :to="`/host/${occ.slug}`"
          class="flex items-center justify-between gap-2 py-1.5 hover:text-primary"
        >
          <span class="truncate">{{ occ.title }}</span>
          <span class="text-muted whitespace-nowrap">
            {{ formatWhen(occ.startsAt, { time: false }) }} · {{ occ.yesCount }} in · {{ occ.status }}
          </span>
        </NuxtLink>
        <p
          v-if="s.occurrenceCount > 8"
          class="text-muted pt-1"
        >
          + {{ s.occurrenceCount - 8 }} older showing<span v-if="s.occurrenceCount - 8 !== 1">s</span>
        </p>
      </div>
    </UCard>

    <UCard v-if="!pending && !data?.series.length">
      <p class="text-muted">
        No series yet. A movie-night series is the one event type that never runs a date poll —
        the crew simply signs up per showing.
      </p>
      <template #footer>
        <UButton
          to="/host/new"
          size="sm"
        >
          Start one
        </UButton>
      </template>
    </UCard>
  </div>
</template>
