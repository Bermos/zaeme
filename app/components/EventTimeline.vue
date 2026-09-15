<script setup lang="ts">
/**
 * The plan — arrive, food, the film, … For a multi-day event (a trip) the
 * entries group under day headings so the itinerary reads like an itinerary.
 *
 * Since #30 an itinerary can also carry LEGS — how you get from one place to
 * the next — and they are shown in the same list rather than in a box of their
 * own, because "the 09:14" only means anything between the two things it joins.
 * `mergeItinerary` (`app/utils/itinerary-order.ts`) decides where each one
 * lands: the items keep the host's order exactly, and a leg slots in ahead of
 * the first item that starts after it. An event with no legs renders exactly as
 * it did before that function existed, which is the point.
 */
interface TimelineItem {
  id: string
  title: string
  description: string | null
  startsAt: string | null
  location: string | null
  /** Pinned to a place, when the group has one (#30). */
  placeId?: string | null
  type: string
  icon: string | null
}
/** What the invite link carries of a place (`guestPlaceView`): no note, no address. */
interface Place { id: string, name: string, lat: number | null, lng: number | null }
interface Leg {
  id: string
  fromPlaceName: string | null
  toPlaceName: string | null
  mode: string
  departsAt: string | null
  arrivesAt: string | null
  durationMinutes: number | null
  note: string | null
  isPlanned: boolean
  sortOrder?: number
  createdAt?: string
}

const props = withDefaults(defineProps<{
  timeline: TimelineItem[]
  legs?: Leg[]
  places?: Place[]
}>(), { legs: () => [], places: () => [] })

const TYPE_ICONS: Record<string, string> = {
  transport: '🚆',
  activity: '🎬',
  accommodation: '🛏️',
  meal: '🍕',
  other: '📍'
}

const MODE_ICONS: Record<string, string> = {
  walk: '🚶', bike: '🚲', car: '🚗', train: '🚆', bus: '🚌', ferry: '⛴️', plane: '✈️', other: '➡️'
}

const placeNames = computed(() => new Map(props.places.map(p => [p.id, p.name])))

function at(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' }) : null
}

function dayKey(iso: string | null | undefined): string {
  return iso ? new Date(iso).toDateString() : 'unscheduled'
}

/** Where an item or a leg sits on the calendar — the only thing days need. */
function entryTime(entry: { kind: 'item' | 'leg', item?: TimelineItem, leg?: Leg }): string | null {
  return entry.kind === 'item' ? entry.item!.startsAt : entry.leg!.departsAt
}

const entries = computed(() => mergeItinerary(props.timeline, props.legs))

/** Group under day headings only when the entries actually span multiple days. */
const groups = computed(() => {
  const days = new Set(entries.value.map(entryTime).filter(Boolean).map(t => dayKey(t)))
  if (days.size <= 1) {
    return [{ label: null as string | null, items: entries.value }]
  }
  const byDay = new Map<string, typeof entries.value>()
  for (const entry of entries.value) {
    const key = dayKey(entryTime(entry))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(entry)
  }
  return [...byDay.entries()].map(([key, items]) => ({
    label: key === 'unscheduled'
      ? 'Sometime'
      : new Date(entryTime(items[0]!)!).toLocaleDateString('en-CH', { weekday: 'long', day: 'numeric', month: 'long' }),
    items
  }))
})

function legLine(leg: Leg): string {
  const from = leg.fromPlaceName ?? 'somewhere'
  const to = leg.toPlaceName ?? 'somewhere'
  return `${from} → ${to}`
}

function legDetail(leg: Leg): string | null {
  const bits = [
    leg.durationMinutes ? `${leg.durationMinutes} min` : null,
    at(leg.arrivesAt) ? `arrives ${at(leg.arrivesAt)}` : null,
    leg.note
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : null
}
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
            v-for="entry in group.items"
            :key="`${entry.kind}-${entry.id}`"
            class="flex gap-3"
          >
            <template v-if="entry.kind === 'item'">
              <span class="text-lg leading-6">{{ entry.item.icon || TYPE_ICONS[entry.item.type] || '📍' }}</span>
              <div>
                <p class="font-medium">
                  <span
                    v-if="at(entry.item.startsAt)"
                    class="text-muted tabular-nums mr-2"
                  >{{ at(entry.item.startsAt) }}</span>
                  {{ entry.item.title }}
                </p>
                <p
                  v-if="entry.item.description"
                  class="text-sm text-muted"
                >
                  {{ entry.item.description }}
                </p>
                <!-- The pinned place if there is one, and the free text if
                     there is not: an item that never had a place reads exactly
                     as it did before places existed. -->
                <p
                  v-if="entry.item.placeId && placeNames.get(entry.item.placeId)"
                  class="text-sm text-muted"
                >
                  📍 {{ placeNames.get(entry.item.placeId) }}
                </p>
                <p
                  v-else-if="entry.item.location"
                  class="text-sm text-muted"
                >
                  📍 {{ entry.item.location }}
                </p>
              </div>
            </template>

            <template v-else>
              <span class="text-lg leading-6">{{ MODE_ICONS[entry.leg.mode] || '➡️' }}</span>
              <div>
                <p class="font-medium">
                  <span
                    v-if="at(entry.leg.departsAt)"
                    class="text-muted tabular-nums mr-2"
                  >{{ at(entry.leg.departsAt) }}</span>
                  {{ legLine(entry.leg) }}
                  <UBadge
                    v-if="!entry.leg.isPlanned"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    class="ml-1"
                  >
                    what happened
                  </UBadge>
                </p>
                <p
                  v-if="legDetail(entry.leg)"
                  class="text-sm text-muted"
                >
                  {{ legDetail(entry.leg) }}
                </p>
              </div>
            </template>
          </li>
        </ol>
      </div>
    </div>
  </UCard>
</template>
