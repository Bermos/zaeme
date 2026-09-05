<script setup lang="ts">
/**
 * The plan — arrive, food, the film, … For a multi-day event (a trip) the
 * items group under day headings so the itinerary reads like an itinerary.
 */
interface TimelineItem {
  id: string
  title: string
  description: string | null
  startsAt: string | null
  location: string | null
  type: string
  icon: string | null
}

const props = defineProps<{ timeline: TimelineItem[] }>()

const TYPE_ICONS: Record<string, string> = {
  transport: '🚆',
  activity: '🎬',
  accommodation: '🛏️',
  meal: '🍕',
  other: '📍'
}

function at(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' }) : null
}

function dayKey(iso: string | null): string {
  return iso ? new Date(iso).toDateString() : 'unscheduled'
}

/** Group under day headings only when the items actually span multiple days. */
const groups = computed(() => {
  const days = new Set(props.timeline.filter(t => t.startsAt).map(t => dayKey(t.startsAt)))
  if (days.size <= 1) {
    return [{ label: null as string | null, items: props.timeline }]
  }
  const byDay = new Map<string, TimelineItem[]>()
  for (const item of props.timeline) {
    const key = dayKey(item.startsAt)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(item)
  }
  return [...byDay.entries()].map(([key, items]) => ({
    label: key === 'unscheduled'
      ? 'Sometime'
      : new Date(items[0]!.startsAt!).toLocaleDateString('en-CH', { weekday: 'long', day: 'numeric', month: 'long' }),
    items
  }))
})
</script>

<template>
  <UCard>
    <template #header>
      <p class="font-semibold">
        {{ groups.length > 1 ? '🧳 The itinerary' : 'The plan' }}
      </p>
    </template>
    <div class="flex flex-col gap-4">
      <div
        v-for="(group, gi) in groups"
        :key="gi"
        class="flex flex-col gap-2"
      >
        <p
          v-if="group.label"
          class="text-sm font-semibold text-muted uppercase tracking-wide"
        >
          {{ group.label }}
        </p>
        <ol class="flex flex-col gap-3">
          <li
            v-for="item in group.items"
            :key="item.id"
            class="flex gap-3"
          >
            <span class="text-lg leading-6">{{ item.icon || TYPE_ICONS[item.type] || '📍' }}</span>
            <div>
              <p class="font-medium">
                <span
                  v-if="at(item.startsAt)"
                  class="text-muted tabular-nums mr-2"
                >{{ at(item.startsAt) }}</span>
                {{ item.title }}
              </p>
              <p
                v-if="item.description"
                class="text-sm text-muted"
              >
                {{ item.description }}
              </p>
              <p
                v-if="item.location"
                class="text-sm text-muted"
              >
                📍 {{ item.location }}
              </p>
            </div>
          </li>
        </ol>
      </div>
    </div>
  </UCard>
</template>
