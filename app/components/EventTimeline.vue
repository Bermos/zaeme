<script setup lang="ts">
import type { PinnedMediaItem } from '#shared/utils/pinned-media'

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
 *
 * AND SINCE #38 A STEP CARRIES ITS PAPERS. `events_media.timeline_item_id` has
 * said "this ticket belongs to the 09:14 to Porto" since the transplant and no
 * screen has ever said it back, so the ticket lived four cards further down
 * while the departure time lived here. A pinned ticket now renders ON the step,
 * with #35's booking reference and seat as text beside a download, because at a
 * barrier you read the seat off the page and show the PDF afterwards.
 *
 * THE GUEST RULE IS #37's. Every invite holder reaches every ticket on the
 * event, marked `mine` or not and labelled with who it is for — so a pinned
 * ticket is shown to everybody with the same sentence the Tickets section uses
 * (`ticketAssigneeLine`), never filtered down to the viewer's own. A second,
 * quieter rule on this screen would be the pre-#37 behaviour restored in the
 * one place four friends at a barrier are actually looking.
 *
 * A STEP WITH NOTHING PINNED RENDERS EXACTLY AS IT DID. That is an acceptance
 * criterion and it is a property of `pinnedMediaByTimelineItem`, which has no
 * key for such a step: `pinnedFor` answers `[]` and `v-for` draws nothing.
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
  /**
   * The tickets and papers pinned to these steps (#38), already normalised by
   * `timelinePinnedMedia` — every one of them, pinned or not; this card keeps
   * the ones with a step.
   *
   * REQUIRED, AND NOT OPTIONAL WITH A `[]` DEFAULT. The two are the same value
   * on the way in and opposite statements about the caller: `[]` by default
   * means a page that forgets the binding renders an itinerary with no papers
   * on it and nothing anywhere red — which is exactly the shape of this whole
   * issue, a column carried by the data and dropped before it reached a screen.
   * Required is what makes `nuxt typecheck` refuse the omission at the call
   * site, the lesson #77's review paid for with a deleted `:timezone`.
   */
  media: PinnedMediaItem[]
  /**
   * The event's display zone (#31) — the wall clock every time below is read
   * against. Null, which is the default, is "the reader's own", and this card
   * then renders exactly as it did before the prop existed.
   */
  timezone?: string | null
}>(), { legs: () => [], places: () => [], timezone: null })

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
  return formatInZone(iso, { hour: '2-digit', minute: '2-digit' }, props.timezone)
}

/**
 * THE DAY HEADINGS HAVE TO MOVE WITH THE CLOCK TOO, and this is the line that
 * is easy to leave behind: a 00:30 ferry out of Lisbon is Tuesday there and
 * Tuesday-at-01:30 in Zürich, but a 23:30 one is Tuesday there and WEDNESDAY
 * here. Group on the viewer's calendar while showing the event's times and the
 * itinerary puts a time under the wrong date — which is worse than the bug
 * this feature fixes, because the time on screen is right and the heading
 * above it is not.
 */
function dayKey(iso: string | null | undefined): string {
  return zoneDayKey(iso, props.timezone) ?? 'unscheduled'
}

/** Named once above the list rather than stamped on every row. */
const zoneLine = computed(() => zoneNote(props.timezone))

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
      : formatInZone(entryTime(items[0]!), { weekday: 'long', day: 'numeric', month: 'long' }, props.timezone),
    items
  }))
})

/**
 * WHAT IS PINNED WHERE — one grouping for the whole itinerary rather than a
 * scan per step, and the grouping itself is
 * `shared/utils/pinned-media.ts`, where `test/pinned-media.test.ts` executes
 * it. A step with nothing pinned has no key, so `pinnedFor` answers `[]` and
 * the step renders as it always did.
 */
const pinnedMedia = computed(() => pinnedMediaByTimelineItem(props.media))

function pinnedFor(itemId: string): PinnedMediaItem[] {
  return pinnedMedia.value.get(itemId) ?? []
}

function pinnedIcon(item: PinnedMediaItem): string {
  return item.type === 'ticket' ? '🎟️' : '📄'
}

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
      <p
        v-if="zoneLine"
        class="text-xs text-muted mt-0.5"
      >
        🕓 {{ zoneLine }}
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
              <div class="min-w-0 flex-1">
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

                <!--
                  THE PAPERS FOR THIS STEP (#38) — the ticket that gets you
                  through the barrier and the reservation you show at the desk,
                  on the step they belong to rather than four cards down.

                  The seat and the booking reference are TEXT beside the
                  download and not inside it (#35): at a barrier you read
                  "coach 12, seat 41A" off the page, and the PDF is what you
                  show afterwards if it has finished rendering.

                  WHOSE IT IS, ON EVERY PINNED TICKET, because since #37 every
                  invite holder reaches every ticket — so this list is the whole
                  step's, and the line says which one is yours rather than the
                  card hiding the other three.

                  Nothing renders at all when nothing is pinned, which is the
                  acceptance criterion about an unchanged itinerary.
                -->
                <div
                  v-if="pinnedFor(entry.item.id).length"
                  class="flex flex-col gap-2 mt-1.5"
                >
                  <div
                    v-for="m in pinnedFor(entry.item.id)"
                    :key="m.id"
                    class="flex flex-col gap-0.5 min-w-0"
                  >
                    <UButton
                      :to="m.url"
                      external
                      target="_blank"
                      variant="soft"
                      color="primary"
                      size="xs"
                      class="justify-start max-w-full"
                    >
                      <span class="truncate">{{ pinnedIcon(m) }} {{ m.caption || m.fileName }}</span>
                    </UButton>
                    <p
                      v-if="m.type === 'ticket'"
                      class="text-xs text-muted pl-1"
                    >
                      {{ ticketAssigneeLine(m) }}
                    </p>
                    <p
                      v-for="(line, i) in ticketDetailLines(m.ticket, timezone)"
                      :key="i"
                      class="text-xs text-muted pl-1"
                    >
                      {{ line }}
                    </p>
                  </div>
                </div>
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
