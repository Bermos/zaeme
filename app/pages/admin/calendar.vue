<script setup lang="ts">
/**
 * The calendar across every event — a month grid, because "what does that week
 * look like" is a shape question and a list cannot answer it.
 *
 * The window asked for is the whole grid, including the days spilling in from
 * the neighbouring months, so nothing appears in a cell without its data.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Calendar' })

const cursor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

/** Monday-first, six rows — the grid every European calendar draws. */
const gridStart = computed(() => {
  const first = new Date(cursor.value)
  const weekday = (first.getDay() + 6) % 7
  return new Date(first.getFullYear(), first.getMonth(), 1 - weekday)
})
const days = computed(() =>
  Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart.value)
    d.setDate(d.getDate() + i)
    return d
  })
)

const query = computed(() => ({
  from: days.value[0]!.toISOString(),
  to: new Date(days.value[41]!.getTime() + 86_399_000).toISOString()
}))
const { data } = await useFetch('/api/admin/calendar', { query })

const byDay = computed(() => {
  const map = new Map<string, typeof events.value>()
  for (const ev of data.value?.events ?? []) {
    if (!ev.startsAt) continue
    const key = new Date(ev.startsAt).toDateString()
    const list = map.get(key) ?? []
    list.push(ev)
    map.set(key, list)
  }
  return map
})
const events = computed(() => data.value?.events ?? [])

const monthLabel = computed(() => cursor.value.toLocaleDateString('en-CH', { month: 'long', year: 'numeric' }))
const today = new Date().toDateString()

function shift(months: number) {
  cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + months, 1)
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1">
        <UButton
          icon="i-lucide-chevron-left"
          variant="ghost"
          color="neutral"
          aria-label="Previous month"
          @click="shift(-1)"
        />
        <p class="font-semibold w-44 text-center">
          {{ monthLabel }}
        </p>
        <UButton
          icon="i-lucide-chevron-right"
          variant="ghost"
          color="neutral"
          aria-label="Next month"
          @click="shift(1)"
        />
      </div>
      <UButton
        size="xs"
        variant="outline"
        @click="cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1)"
      >
        Today
      </UButton>
    </div>

    <div class="overflow-x-auto">
      <div class="min-w-3xl grid grid-cols-7 gap-px bg-accented rounded overflow-hidden">
        <div
          v-for="label in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']"
          :key="label"
          class="bg-default px-2 py-1 text-xs text-muted font-medium"
        >
          {{ label }}
        </div>
        <div
          v-for="day in days"
          :key="day.toISOString()"
          class="bg-default min-h-24 p-1.5 flex flex-col gap-1"
          :class="day.getMonth() !== cursor.getMonth() ? 'opacity-45' : ''"
        >
          <span
            class="text-xs tabular-nums"
            :class="day.toDateString() === today ? 'font-bold text-primary' : 'text-muted'"
          >
            {{ day.getDate() }}
          </span>
          <NuxtLink
            v-for="ev in byDay.get(day.toDateString()) ?? []"
            :key="ev.id"
            :to="`/host/${ev.slug}`"
            class="text-xs rounded px-1 py-0.5 truncate"
            :class="ev.status === 'cancelled' ? 'line-through text-muted bg-elevated' : 'bg-elevated hover:text-primary'"
            :title="`${ev.title} · ${ev.status} · ${ev.yesCount} going`"
          >
            {{ new Date(ev.startsAt!).toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' }) }}
            {{ ev.title }}
          </NuxtLink>
        </div>
      </div>
    </div>

    <p class="text-sm text-muted">
      {{ events.length }} dated event<span v-if="events.length !== 1">s</span> in view. Undated ones live in
      <NuxtLink
        to="/admin/events?when=undated"
        class="text-primary hover:underline"
      >
        the events list
      </NuxtLink>.
    </p>
  </div>
</template>
