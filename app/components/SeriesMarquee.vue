<script setup lang="ts">
/**
 * The cinema feel for a recurring series' showing (movie night): a dark
 * marquee header over the poster — "now showing", the house name, the cadence,
 * and the programme strip of upcoming showings. Deliberately the one dark
 * corner of an otherwise light, stock-Nuxt-UI app: a cinema is dark.
 */
defineProps<{
  series: {
    title: string
    cadence: string | null
    upcoming: Array<{ title: string, startsAt: string | Date | null }>
    pastCount: number
  }
  eventTitle: string
  posterUrl: string | null
  startsAt: string | Date | null
}>()

function showtime(value: string | Date | null): string | null {
  if (!value) return null
  return new Date(value).toLocaleString('en-CH', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

function short(value: string | Date | null): string {
  return value ? new Date(value).toLocaleDateString('en-CH', { day: 'numeric', month: 'short' }) : 'TBD'
}
</script>

<template>
  <div class="rounded-xl overflow-hidden bg-gray-950 text-gray-50">
    <div class="relative">
      <img
        v-if="posterUrl"
        :src="posterUrl"
        :alt="`Poster for ${eventTitle}`"
        class="w-full max-h-96 object-cover opacity-60"
      >
      <div
        class="p-6"
        :class="posterUrl ? 'absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-gray-950 via-gray-950/40 to-transparent' : ''"
      >
        <p class="text-xs tracking-[0.3em] uppercase text-amber-300">
          ★ {{ series.title }} · now showing ★
        </p>
        <h1 class="text-3xl font-bold mt-1">
          {{ eventTitle }}
        </h1>
        <p
          v-if="showtime(startsAt)"
          class="mt-1 text-gray-300"
        >
          🎬 {{ showtime(startsAt) }}
        </p>
      </div>
    </div>
    <div class="px-6 py-3 border-t border-gray-800 flex items-center justify-between gap-3 flex-wrap text-sm text-gray-400">
      <p>
        <span v-if="series.cadence">{{ series.cadence }} · </span>
        <span v-if="series.pastCount">screening #{{ series.pastCount + 1 }}</span>
        <span v-else>first screening</span>
      </p>
      <p
        v-if="series.upcoming.length"
        class="truncate"
      >
        Coming up:
        <span
          v-for="(u, i) in series.upcoming"
          :key="i"
        >
          {{ i > 0 ? ' · ' : '' }}{{ u.title }} ({{ short(u.startsAt) }})
        </span>
      </p>
    </div>
  </div>
</template>
