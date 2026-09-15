<script setup lang="ts">
/**
 * The trip's map, host side (#30): the PLACES the itinerary happens at, and the
 * LEGS between them.
 *
 * A place can be added with nothing but a name — "Ana's flat" is a place — and
 * given coordinates later, which is why the two coordinate fields sit behind a
 * disclosure rather than in front of every add. The server is what refuses one
 * of the pair without the other; this form does not second-guess it, so there
 * is one rule and not two that drift.
 *
 * SEARCHING FOR A PLACE (#32) fills that form in; it does not replace it. The
 * search box sits above the name field and every result is a click that writes
 * a name, an address and a pair of coordinates into the same inputs somebody
 * could have typed — so a geocoder that is down costs the feature nothing but
 * the typing. Three things this half has to get right:
 *
 *  - IT DEBOUNCES AND ASKS FOR AT LEAST THREE CHARACTERS, because every
 *    keystroke is somebody else's server. The debounce is a courtesy though,
 *    not the promise: `server/domain/geocode.ts` holds the instance to one
 *    request a second whatever any browser does;
 *  - "SEARCH IS UNAVAILABLE" AND "NO MATCHES" ARE DIFFERENT SENTENCES. The
 *    route answers 200 in both cases with a `status`, and rendering them the
 *    same way would tell somebody their café does not exist when the truth is
 *    that this instance could not ask;
 *  - a stale answer never wins. Each request carries a sequence number and a
 *    reply that is not the newest is dropped, or a slow lookup for "zu" lands
 *    on top of the results for "zug hb".
 *
 * Legs are reordered with the same up/down arrows the itinerary uses, and for
 * the same reason they are ONE request each: two `sortOrder` PATCHes that swap
 * a pair leave them sharing a number if the second does not land, after which
 * the arrows answer 200 and move nothing.
 */
interface Place {
  id: string
  name: string
  address: string | null
  lat: number | null
  lng: number | null
  note: string | null
}
interface Leg {
  id: string
  fromPlaceId: string | null
  toPlaceId: string | null
  fromPlaceName: string | null
  toPlaceName: string | null
  mode: string
  departsAt: string | Date | null
  arrivesAt: string | Date | null
  durationMinutes: number | null
  note: string | null
  isPlanned: boolean
}
interface Geography { places: Place[], legs: Leg[] }

const props = defineProps<{ slug: string, geography: Geography }>()
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

const MODE_ITEMS = [
  { label: '🚶 Walk', value: 'walk' },
  { label: '🚲 Bike', value: 'bike' },
  { label: '🚗 Car', value: 'car' },
  { label: '🚆 Train', value: 'train' },
  { label: '🚌 Bus', value: 'bus' },
  { label: '⛴️ Ferry', value: 'ferry' },
  { label: '✈️ Plane', value: 'plane' },
  { label: '➡️ Other', value: 'other' }
]

const placeItems = computed(() => props.geography.places.map(p => ({ label: p.name, value: p.id })))
const canAddLeg = computed(() => props.geography.places.length >= 2)

/**
 * THE ARROWS ACT ON THE UNTIMED LEGS AND NOTHING ELSE.
 *
 * A leg that says when it leaves is placed by its clock, here and on the guest
 * page (`app/utils/itinerary-order.ts`), so an arrow on one would renumber a
 * column no screen reads and the leg would not move — a 200 and a dead control,
 * which is the failure the one-statement reorder exists to prevent. The server
 * refuses it too (422); this is what stops anybody meeting that refusal.
 */
const untimed = computed(() => props.geography.legs.filter(l => !l.departsAt))
const canMove = (leg: Leg) => !leg.departsAt
const isFirstUntimed = (leg: Leg) => untimed.value[0]?.id === leg.id
const isLastUntimed = (leg: Leg) => untimed.value[untimed.value.length - 1]?.id === leg.id

function message(e: unknown, fallback: string): string {
  return (e as { data?: { message?: string } }).data?.message ?? fallback
}

/* ---- searching for a place (#32) ---- */
interface Suggestion {
  name: string
  address: string | null
  lat: number
  lng: number
  osmType: string | null
  osmId: string | null
  category: string | null
}
interface GeocodeAnswer {
  status: 'ok' | 'unavailable'
  results: Suggestion[]
  attribution: string
}

/** Fewer than this is not a place name, and every request is somebody's server. */
const MIN_SEARCH = 3
const DEBOUNCE_MS = 500

const search = ref('')
const searchState = ref<'idle' | 'searching' | 'ok' | 'unavailable'>('idle')
const suggestions = ref<Suggestion[]>([])
const attribution = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined
/** The newest request wins; anything older is dropped on arrival. */
let searchSeq = 0

function clearSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchSeq++
  search.value = ''
  suggestions.value = []
  searchState.value = 'idle'
}

async function runSearch() {
  const q = search.value.trim()
  if (q.length < MIN_SEARCH) {
    suggestions.value = []
    searchState.value = 'idle'
    return
  }
  const seq = ++searchSeq
  searchState.value = 'searching'
  try {
    const answer = await $fetch<GeocodeAnswer>(`/api/host/events/${props.slug}/places/search`, { query: { q } })
    if (seq !== searchSeq) return
    attribution.value = answer.attribution
    suggestions.value = answer.results
    searchState.value = answer.status === 'ok' ? 'ok' : 'unavailable'
  } catch {
    // The route answers 200 for an unreachable geocoder, so landing here means
    // something else went wrong — a session that expired, the server restarting
    // mid-request. It is the same thing to say: search cannot be used, type it.
    if (seq !== searchSeq) return
    suggestions.value = []
    searchState.value = 'unavailable'
  }
}

watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  if (search.value.trim().length < MIN_SEARCH) {
    // Not "searching" and not "no matches": nothing has been asked yet.
    suggestions.value = []
    searchState.value = 'idle'
    return
  }
  searchTimer = setTimeout(runSearch, DEBOUNCE_MS)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

/* ---- places ---- */
const newPlace = reactive({ name: '', address: '', lat: '', lng: '', note: '', osmType: '', osmId: '' })
const showCoords = ref(false)
const addingPlace = ref(false)

/**
 * A chosen result fills the form rather than saving anything. The coordinates
 * are shown at the same moment (`showCoords`) so nobody adds a pin without
 * seeing where it is, and the OSM reference travels with it — it is what lets
 * the server say "that café is already on this trip" instead of dropping a
 * second pin on the first.
 */
function useSuggestion(s: Suggestion) {
  newPlace.name = s.name
  newPlace.address = s.address ?? ''
  newPlace.lat = String(s.lat)
  newPlace.lng = String(s.lng)
  newPlace.osmType = s.osmType ?? ''
  newPlace.osmId = s.osmId ?? ''
  showCoords.value = true
  clearSearch()
}

/** Dropping a pin should name a place: the same search, the other way round. */
const naming = ref(false)
async function nameThisPin() {
  if (!newPlace.lat || !newPlace.lng) return
  naming.value = true
  try {
    const answer = await $fetch<GeocodeAnswer>(`/api/host/events/${props.slug}/places/reverse`, {
      query: { lat: newPlace.lat, lng: newPlace.lng }
    })
    const found = answer.results[0]
    if (answer.status !== 'ok') {
      toast.add({ title: 'Search is unavailable right now — type the name instead', color: 'warning' })
    } else if (!found) {
      toast.add({ title: 'Nothing is mapped at those coordinates', color: 'neutral' })
    } else {
      attribution.value = answer.attribution
      newPlace.name = found.name
      newPlace.address = found.address ?? ''
      newPlace.osmType = found.osmType ?? ''
      newPlace.osmId = found.osmId ?? ''
    }
  } catch (e) {
    toast.add({ title: message(e, 'Could not look that pin up'), color: 'error' })
  } finally {
    naming.value = false
  }
}

async function addPlace() {
  if (!newPlace.name) return
  addingPlace.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/places`, {
      method: 'POST',
      body: {
        name: newPlace.name,
        address: newPlace.address || null,
        // Sent as the strings they were typed as: the server does the range
        // check, the rounding to the column's six decimals, and the refusal
        // when only one of the two arrives.
        lat: newPlace.lat || null,
        lng: newPlace.lng || null,
        // Both or neither here too, which is why they are cleared together
        // below: a place whose coordinates were typed over has no OSM feature.
        osmType: newPlace.osmType || null,
        osmId: newPlace.osmId || null,
        note: newPlace.note || null
      }
    })
    newPlace.name = ''
    newPlace.address = ''
    newPlace.lat = ''
    newPlace.lng = ''
    newPlace.note = ''
    newPlace.osmType = ''
    newPlace.osmId = ''
    emit('updated')
  } catch (e) {
    toast.add({ title: message(e, 'Could not add that place'), color: 'error' })
  } finally {
    addingPlace.value = false
  }
}

const editingPlace = ref<string | null>(null)
const savingPlace = ref(false)
const placeDraft = reactive({ name: '', address: '', lat: '', lng: '', note: '' })

function startEditPlace(place: Place) {
  editingPlace.value = place.id
  placeDraft.name = place.name
  placeDraft.address = place.address ?? ''
  placeDraft.lat = place.lat === null ? '' : String(place.lat)
  placeDraft.lng = place.lng === null ? '' : String(place.lng)
  placeDraft.note = place.note ?? ''
}

async function savePlace(id: string) {
  if (!placeDraft.name) return
  savingPlace.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/places/${id}`, {
      method: 'PATCH',
      body: {
        name: placeDraft.name,
        address: placeDraft.address || null,
        lat: placeDraft.lat || null,
        lng: placeDraft.lng || null,
        note: placeDraft.note || null
      }
    })
    editingPlace.value = null
    emit('updated')
    toast.add({ title: 'Updated', color: 'success' })
  } catch (e) {
    toast.add({ title: message(e, 'Could not save that'), color: 'error' })
  } finally {
    savingPlace.value = false
  }
}

/**
 * Deleting a place is not only about the place, so the answer says what else it
 * touched: legs that lost one end keep everything somebody wrote and show as
 * incomplete, legs that were entirely about this place go with it, and pinned
 * itinerary items fall back to their own text.
 */
async function removePlace(place: Place) {
  try {
    const after = await $fetch<{ detachedLegs: number, removedLegs: number, detachedItems: number }>(
      `/api/host/events/${props.slug}/places/${place.id}`,
      { method: 'DELETE' }
    )
    const touched = [
      after.removedLegs ? `${after.removedLegs} leg${after.removedLegs === 1 ? '' : 's'} removed` : null,
      after.detachedLegs ? `${after.detachedLegs} leg${after.detachedLegs === 1 ? '' : 's'} left half-joined` : null,
      after.detachedItems ? `${after.detachedItems} itinerary item${after.detachedItems === 1 ? '' : 's'} unpinned` : null
    ].filter(Boolean).join(' · ')
    emit('updated')
    toast.add({ title: `Removed ${place.name}`, description: touched || undefined, color: 'success' })
  } catch (e) {
    toast.add({ title: message(e, 'Could not remove that place'), color: 'error' })
  }
}

/* ---- legs ---- */
const newLeg = reactive({ fromPlaceId: '', toPlaceId: '', mode: 'train', departsAt: '', durationMinutes: '', note: '', isPlanned: true })
const addingLeg = ref(false)

async function addLeg() {
  if (!newLeg.fromPlaceId || !newLeg.toPlaceId) return
  addingLeg.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/legs`, {
      method: 'POST',
      body: {
        fromPlaceId: newLeg.fromPlaceId,
        toPlaceId: newLeg.toPlaceId,
        mode: newLeg.mode,
        departsAt: newLeg.departsAt ? new Date(newLeg.departsAt).toISOString() : null,
        durationMinutes: newLeg.durationMinutes ? Number(newLeg.durationMinutes) : null,
        note: newLeg.note || null,
        isPlanned: newLeg.isPlanned
      }
    })
    newLeg.departsAt = ''
    newLeg.durationMinutes = ''
    newLeg.note = ''
    emit('updated')
  } catch (e) {
    toast.add({ title: message(e, 'Could not add that leg'), color: 'error' })
  } finally {
    addingLeg.value = false
  }
}

const movingLeg = ref<string | null>(null)
async function moveLeg(id: string, direction: 'up' | 'down') {
  movingLeg.value = id
  try {
    await $fetch(`/api/host/events/${props.slug}/legs/${id}/move`, { method: 'POST', body: { direction } })
    emit('updated')
  } catch {
    toast.add({ title: 'Could not reorder', color: 'error' })
  } finally {
    movingLeg.value = null
  }
}

async function removeLeg(id: string) {
  try {
    await $fetch(`/api/host/events/${props.slug}/legs/${id}`, { method: 'DELETE' })
    emit('updated')
  } catch (e) {
    toast.add({ title: message(e, 'Could not remove that leg'), color: 'error' })
  }
}

async function togglePlanned(leg: Leg) {
  try {
    await $fetch(`/api/host/events/${props.slug}/legs/${leg.id}`, {
      method: 'PATCH',
      body: { isPlanned: !leg.isPlanned }
    })
    emit('updated')
  } catch (e) {
    toast.add({ title: message(e, 'Could not change that'), color: 'error' })
  }
}

function when(value: string | Date | null): string | null {
  return value
    ? new Date(value).toLocaleString('en-CH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null
}

function coordinates(place: Place): string | null {
  return place.lat === null || place.lng === null ? null : `${place.lat}, ${place.lng}`
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          🗺️ Places & how you get between them
        </p>
        <p class="text-sm text-muted">
          Pin the hotel, the trailhead, the restaurant — coordinates optional — then say how you travel between them.
          Guests see a place's name and its position; notes and addresses stay with the planning team.
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-6">
      <!-- Places -->
      <div class="flex flex-col gap-2">
        <div
          v-for="place in geography.places"
          :key="place.id"
          class="py-1.5 border-b border-default last:border-b-0 text-sm"
        >
          <form
            v-if="editingPlace === place.id"
            class="flex flex-col gap-2 py-1"
            @submit.prevent="savePlace(place.id)"
          >
            <UInput
              v-model="placeDraft.name"
              placeholder="Name"
            />
            <UInput
              v-model="placeDraft.address"
              placeholder="Address (optional)"
            />
            <div class="flex flex-col sm:flex-row gap-2">
              <UInput
                v-model="placeDraft.lat"
                placeholder="Latitude (optional)"
                class="flex-1"
              />
              <UInput
                v-model="placeDraft.lng"
                placeholder="Longitude (optional)"
                class="flex-1"
              />
            </div>
            <UTextarea
              v-model="placeDraft.note"
              :rows="2"
              placeholder="Note (optional) — only the planning team sees this"
            />
            <div class="flex gap-2">
              <UButton
                type="submit"
                size="xs"
                :loading="savingPlace"
                :disabled="!placeDraft.name"
              >
                Save
              </UButton>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="editingPlace = null"
              >
                Cancel
              </UButton>
            </div>
          </form>

          <div
            v-else
            class="flex items-center justify-between gap-2"
          >
            <p class="min-w-0 truncate">
              📍 <span class="font-medium">{{ place.name }}</span>
              <span
                v-if="place.address"
                class="text-muted"
              > · {{ place.address }}</span>
              <span
                v-if="coordinates(place)"
                class="text-muted tabular-nums"
              > · {{ coordinates(place) }}</span>
              <span
                v-else
                class="text-muted"
              > · no coordinates yet</span>
            </p>
            <div class="flex items-center gap-0.5 shrink-0">
              <UButton
                size="xs"
                variant="ghost"
                @click="startEditPlace(place)"
              >
                Edit
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="Remove place"
                @click="removePlace(place)"
              >
                ✕
              </UButton>
            </div>
          </div>
        </div>

        <!-- Search (#32): it fills the form below, it does not replace it. -->
        <div class="flex flex-col gap-2 pt-2">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            placeholder="Search for a place — Ponte 25 de Abril"
            :loading="searchState === 'searching'"
          />
          <div
            v-if="suggestions.length"
            class="flex flex-col gap-1"
          >
            <button
              v-for="s in suggestions"
              :key="`${s.osmType}-${s.osmId}-${s.lat}-${s.lng}`"
              type="button"
              class="text-left text-sm rounded-md px-2 py-1.5 hover:bg-elevated"
              @click="useSuggestion(s)"
            >
              <span class="font-medium">{{ s.name }}</span>
              <span
                v-if="s.category"
                class="text-muted"
              > · {{ s.category }}</span>
              <span
                v-if="s.address"
                class="block text-xs text-muted truncate"
              >{{ s.address }}</span>
            </button>
            <p class="text-xs text-muted">
              {{ attribution }}
            </p>
          </div>
          <!-- The two states that must never read as each other. -->
          <p
            v-else-if="searchState === 'unavailable'"
            class="text-sm text-warning"
          >
            Search is unavailable right now — type the name, and the coordinates if you have them.
          </p>
          <p
            v-else-if="searchState === 'ok'"
            class="text-sm text-muted"
          >
            No matches. Type the name yourself — a place is fine without coordinates.
          </p>
        </div>

        <form
          class="flex flex-col gap-2 pt-2"
          @submit.prevent="addPlace"
        >
          <div class="flex flex-col sm:flex-row gap-2">
            <UInput
              v-model="newPlace.name"
              placeholder="Hotel Bellevue"
              class="flex-1"
            />
            <UInput
              v-model="newPlace.address"
              placeholder="Address (optional)"
              class="flex-1"
            />
            <UButton
              type="submit"
              :loading="addingPlace"
              :disabled="!newPlace.name"
            >
              Add place
            </UButton>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              @click="showCoords = !showCoords"
            >
              {{ showCoords ? 'Hide coordinates' : 'Add coordinates' }}
            </UButton>
            <p class="text-xs text-muted">
              Optional — a place is fine without them, and they can be filled in later.
            </p>
          </div>
          <div
            v-if="showCoords"
            class="flex flex-col sm:flex-row gap-2"
          >
            <UInput
              v-model="newPlace.lat"
              placeholder="Latitude, e.g. 46.004512"
              class="flex-1"
            />
            <UInput
              v-model="newPlace.lng"
              placeholder="Longitude, e.g. 8.951050"
              class="flex-1"
            />
            <UButton
              variant="subtle"
              color="neutral"
              :loading="naming"
              :disabled="!newPlace.lat || !newPlace.lng"
              @click="nameThisPin"
            >
              Name this pin
            </UButton>
          </div>
        </form>
      </div>

      <!-- Legs -->
      <div class="flex flex-col gap-2">
        <p class="text-sm font-semibold">
          Legs
        </p>
        <p class="text-xs text-muted">
          A leg with a departure time sits at its time; the arrows order the ones without.
        </p>
        <p
          v-if="!geography.legs.length"
          class="text-sm text-muted"
        >
          No connections yet. Friends holding the invite link can add one too — "we ended up walking" counts.
        </p>

        <div
          v-for="leg in geography.legs"
          :key="leg.id"
          class="py-1.5 border-b border-default last:border-b-0 text-sm flex items-center justify-between gap-2"
        >
          <p class="min-w-0 truncate">
            {{ MODE_ITEMS.find(m => m.value === leg.mode)?.label.split(' ')[0] || '➡️' }}
            <span class="font-medium">{{ leg.fromPlaceName ?? '(place removed)' }} → {{ leg.toPlaceName ?? '(place removed)' }}</span>
            <span
              v-if="when(leg.departsAt)"
              class="text-muted tabular-nums"
            > · {{ when(leg.departsAt) }}</span>
            <span
              v-if="leg.durationMinutes"
              class="text-muted"
            > · {{ leg.durationMinutes }} min</span>
            <span
              v-if="leg.note"
              class="text-muted"
            > · {{ leg.note }}</span>
          </p>
          <div class="flex items-center gap-0.5 shrink-0">
            <UBadge
              :color="leg.isPlanned ? 'info' : 'neutral'"
              variant="subtle"
              class="cursor-pointer"
              @click="togglePlanned(leg)"
            >
              {{ leg.isPlanned ? 'planned' : 'what happened' }}
            </UBadge>
            <span
              v-if="!canMove(leg)"
              class="text-xs text-muted"
            >ordered by its departure time</span>
            <template v-else>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="isFirstUntimed(leg) || movingLeg === leg.id"
                aria-label="Move leg up"
                @click="moveLeg(leg.id, 'up')"
              >
                ↑
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="isLastUntimed(leg) || movingLeg === leg.id"
                aria-label="Move leg down"
                @click="moveLeg(leg.id, 'down')"
              >
                ↓
              </UButton>
            </template>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Remove leg"
              @click="removeLeg(leg.id)"
            >
              ✕
            </UButton>
          </div>
        </div>

        <form
          v-if="canAddLeg"
          class="flex flex-col gap-2 pt-2"
          @submit.prevent="addLeg"
        >
          <div class="flex flex-col sm:flex-row gap-2">
            <USelect
              v-model="newLeg.fromPlaceId"
              :items="placeItems"
              placeholder="From"
              class="flex-1"
            />
            <USelect
              v-model="newLeg.toPlaceId"
              :items="placeItems"
              placeholder="To"
              class="flex-1"
            />
            <USelect
              v-model="newLeg.mode"
              :items="MODE_ITEMS"
              class="sm:w-40"
            />
          </div>
          <div class="flex flex-col sm:flex-row gap-2">
            <UInput
              v-model="newLeg.departsAt"
              type="datetime-local"
              class="sm:w-52"
            />
            <UInput
              v-model="newLeg.durationMinutes"
              type="number"
              placeholder="Minutes"
              class="sm:w-32"
            />
            <UInput
              v-model="newLeg.note"
              placeholder="IR 2313, platform 4 (optional)"
              class="flex-1"
            />
            <UButton
              type="submit"
              :loading="addingLeg"
              :disabled="!newLeg.fromPlaceId || !newLeg.toPlaceId"
            >
              Add leg
            </UButton>
          </div>
          <UCheckbox
            v-model="newLeg.isPlanned"
            label="This is the plan (uncheck if it is what actually happened)"
          />
        </form>
        <p
          v-else
          class="text-sm text-muted"
        >
          Add two places and you can join them up.
        </p>
      </div>
    </div>
  </UCard>
</template>
