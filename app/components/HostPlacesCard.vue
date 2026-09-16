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
  /**
   * What this place matched in OpenStreetMap, when it came from the search.
   *
   * Carried through the EDIT form as well as the add, which is not decoration:
   * one feature is one place per event, so a reference the form could set and
   * never show is a rule a planner can hit and cannot get out of.
   */
  osmType: string | null
  osmId: string | null
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

const props = withDefaults(
  defineProps<{
    slug: string
    geography: Geography
    /** The trip's display zone (#31): what the leg times below are read against. */
    timezone?: string | null
  }>(),
  { timezone: null }
)
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
  /** The zones the country this landed in has (#31). See `offerZones` below. */
  timeZones?: string[]
  /** Only so the offer can say "Portugal" rather than "pt". */
  countryCode?: string | null
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
  offerZones(s)
  newPlace.name = s.name
  newPlace.address = s.address ?? ''
  newPlace.lat = String(s.lat)
  newPlace.lng = String(s.lng)
  newPlace.osmType = s.osmType ?? ''
  newPlace.osmId = s.osmId ?? ''
  matched.name = newPlace.name
  matched.lat = newPlace.lat
  matched.lng = newPlace.lng
  showCoords.value = true
  clearSearch()
}

/**
 * WHAT THE SUGGESTION SAID, so the form can tell when it is no longer true.
 *
 * A reference is a claim: "this place IS OpenStreetMap way 4306103". Edit the
 * name or drag the latitude and the claim stops being one — the place saved
 * would assert a feature at coordinates that are not it, and it would hold that
 * feature's slot in the one-per-event rule against the place that really is it.
 * So the claim is dropped the moment the thing it was about is edited away,
 * which the watcher below does and the ✕ beside the badge does explicitly.
 *
 * THE EXPLICIT CONTROL IS NOT A NICETY. "A group that wants two pins on one
 * building names the second by hand" is the whole escape from the uniqueness
 * rule, and without a way to drop the reference a second attempt is refused
 * whatever it is renamed to — the only way out being a page reload.
 */
const matched = reactive({ name: '', lat: '', lng: '' })

function forgetMatch() {
  newPlace.osmType = ''
  newPlace.osmId = ''
  matched.name = ''
  matched.lat = ''
  matched.lng = ''
}

watch(
  () => [newPlace.name, newPlace.lat, newPlace.lng].join('|'),
  () => {
    if (!newPlace.osmId) return
    if (newPlace.name !== matched.name || newPlace.lat !== matched.lat || newPlace.lng !== matched.lng) {
      forgetMatch()
    }
  }
)

/** The same claim on the edit form, and the same way out of it. */
function forgetDraftMatch() {
  placeDraft.osmType = ''
  placeDraft.osmId = ''
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
      // The pin the planner typed is what was asked about, so it — not the
      // result's own position — is what the claim is anchored to.
      matched.name = newPlace.name
      matched.lat = newPlace.lat
      matched.lng = newPlace.lng
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
        // Both or neither here too. They are dropped the moment the name or
        // the coordinates are edited away from what the suggestion said — see
        // `matched` — so what is sent here is only ever a claim still true.
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
    forgetMatch()
    emit('updated')
  } catch (e) {
    toast.add({ title: message(e, 'Could not add that place'), color: 'error' })
  } finally {
    addingPlace.value = false
  }
}

const editingPlace = ref<string | null>(null)
const savingPlace = ref(false)
const placeDraft = reactive({ name: '', address: '', lat: '', lng: '', note: '', osmType: '', osmId: '' })

function startEditPlace(place: Place) {
  editingPlace.value = place.id
  placeDraft.name = place.name
  placeDraft.address = place.address ?? ''
  placeDraft.lat = place.lat === null ? '' : String(place.lat)
  placeDraft.lng = place.lng === null ? '' : String(place.lng)
  placeDraft.note = place.note ?? ''
  // Read back and sent again below, so a rename does not silently drop the
  // reference — and so the ✕ beside it is the way to give the feature up.
  placeDraft.osmType = place.osmType ?? ''
  placeDraft.osmId = place.osmId ?? ''
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
        osmType: placeDraft.osmType || null,
        osmId: placeDraft.osmId || null,
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
        departsAt: newLeg.departsAt ? isoFromZonedInput(newLeg.departsAt, props.timezone) : null,
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
  return formatInZone(value, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, props.timezone)
}

const zoneLine = computed(() => zoneNote(props.timezone))

/* ---- the zone a geocoded place suggests (#31 over #32) ---- */

/**
 * WHAT A GEOCODED PLACE OFFERS, AND WHAT IT NEVER DOES.
 *
 * The zone is the one field of this feature a host is unlikely to know by name
 * — `Europe/Lisbon` is not how anybody says "Lisbon" — and a place that has
 * just been looked up on a map already knows which country it is in. So
 * choosing a search result offers the zones of that country, from ICU's own
 * data (`shared/utils/timezone.ts`), and a click sets it.
 *
 * IT IS AN OFFER AND NEVER A WRITE. Picking a search result fills a form; it
 * must not also relabel the whole trip's clock behind the planner's back —
 * especially not on the third place of a trip that crosses a border, where the
 * silent version would leave the itinerary reading against wherever the last
 * pin happened to be.
 *
 * AND IT IS NEVER A GUESS. Every zone the country has is shown — one button
 * when there is one, and all of them in a searchable list when there are more,
 * with nothing preselected. This shipped as `.slice(0, 4)` of an ALPHABETICAL
 * list, which is four confident buttons that are wrong for most of the world:
 * the United States has twenty-nine zones and the first four are Adak,
 * Anchorage, Boise and Chicago, so a pin in New York was offered none of them
 * and Adak is five hours out; Australia led with `Antarctica/Macquarie`; Brazil
 * offered four, none of them São Paulo. Portugal has exactly three and fits,
 * which is why the geocoder stub and both fixtures — all Portuguese — saw
 * nothing wrong.
 *
 * RANKING THEM WAS TRIED AND REJECTED. The obvious heuristic is the only one
 * available without a table: compare each zone's UTC offset to the one the
 * pin's longitude implies. Measured, it picks `America/Chicago` for a New York
 * pin, `America/Anchorage` for Los Angeles and — the case this whole feature is
 * written around — `Atlantic/Azores` for LISBON, because summer time pushes a
 * civil clock an hour east of its own sun. A ranking that is wrong about the
 * worked example is worse than no ranking: it moves the mistake from "the host
 * has to choose" to "the host was told, confidently".
 *
 * The offer is skipped when the trip is already in one of that country's zones,
 * which is the usual case from the second place onwards. `sameZone` and not
 * `includes`: the stored value may be the spelling the host typed
 * (`Europe/Kyiv`) while ICU lists the alias (`Europe/Kiev`), and comparing the
 * strings re-offers the trip its own zone under the name it was spared.
 */
const zoneOffer = ref<{ place: string, country: string, zones: string[] } | null>(null)
const settingZone = ref<string | null>(null)
/**
 * Nothing is preselected; the host picks, or the offer does nothing.
 * `undefined` rather than `null` because that is what `USelectMenu` means by
 * "no selection" — bound to null it renders the placeholder and then refuses
 * the model type.
 */
const chosenZone = ref<string | undefined>(undefined)

function offerZones(s: Suggestion) {
  chosenZone.value = undefined
  // The decision itself is `zonesToOffer` in `shared/utils/timezone.ts`, where
  // a unit test can execute it: this card is client-side, so the smoke suite
  // watches the wire and cannot see a renderer that drops most of the answer —
  // which is precisely what `.slice(0, 4)` did here.
  const zones = zonesToOffer(s.timeZones, props.timezone)
  zoneOffer.value = zones ? { place: s.name, country: countryName(s.countryCode), zones } : null
}

/**
 * The country as a person says it, for the sentence above the list —
 * "Portugal, which has 3 time zones" rather than "pt". `Intl.DisplayNames` is
 * ICU's own, so there is no table here either; the code itself is the fallback
 * for a runtime that does not know it.
 */
function countryName(code: string | null | undefined): string {
  const cc = (code ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return 'this country'
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc
  } catch {
    return cc
  }
}

async function useZone(zone: string) {
  settingZone.value = zone
  try {
    await $fetch(`/api/host/events/${props.slug}`, { method: 'PATCH', body: { timezone: zone } })
    zoneOffer.value = null
    chosenZone.value = undefined
    emit('updated')
    toast.add({ title: `Times now shown in ${zone}`, color: 'success' })
  } catch (e) {
    toast.add({ title: message(e, 'Could not set the time zone'), color: 'error' })
  } finally {
    settingZone.value = null
  }
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
        <p
          v-if="zoneLine"
          class="text-xs text-muted mt-0.5"
        >
          🕓 {{ zoneLine }} — type departure times as they are there.
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
            <div
              v-if="placeDraft.osmId"
              class="flex items-center gap-2 text-xs text-muted"
            >
              <span>Matched OpenStreetMap {{ placeDraft.osmType }}/{{ placeDraft.osmId }}</span>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="forgetDraftMatch"
              >
                Not this one
              </UButton>
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
          <!-- The two states that must never read as each other.

               THESE TWO BELONG TO THE `v-if` ABOVE AND NOTHING MAY COME BETWEEN
               THEM. #31's zone offer was inserted here and broke the chain: the
               `suggestions.length` branch then terminated in a comment node and
               both `v-else-if`s hung off `zoneOffer` instead, so a search that
               returned three results rendered them and said "No matches"
               directly underneath. Lint, typecheck and every test stayed green.
               Anything new goes AFTER the chain, as the offer now does. -->
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

          <!-- The zone that place suggests (#31): an offer, never a write, and
               never a guess either — see `offerZones`. -->
          <div
            v-if="zoneOffer"
            class="flex flex-col gap-1.5 rounded-md bg-elevated px-3 py-2"
          >
            <p class="text-sm">
              🕓 {{ zoneOffer.place }} is in
              <template v-if="zoneOffer.zones.length === 1">
                {{ zoneOffer.zones[0] }}
              </template>
              <template v-else>
                {{ zoneOffer.country }}, which has {{ zoneOffer.zones.length }} time zones
              </template>.
              Show this trip's times in it?
            </p>
            <!-- One zone: one click, and it cannot be the wrong one. -->
            <div
              v-if="zoneOffer.zones.length === 1"
              class="flex flex-wrap gap-1.5"
            >
              <UButton
                size="xs"
                variant="soft"
                :loading="settingZone !== null"
                @click="useZone(zoneOffer.zones[0]!)"
              >
                {{ zoneOffer.zones[0] }}
              </UButton>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="zoneOffer = null"
              >
                Not now
              </UButton>
            </div>
            <!-- More than one: ALL of them, searchable, and nothing preselected. -->
            <div
              v-else
              class="flex flex-wrap items-center gap-1.5"
            >
              <USelectMenu
                v-model="chosenZone"
                :items="zoneOffer.zones"
                placeholder="Which one?"
                size="xs"
                class="w-56"
              />
              <UButton
                size="xs"
                variant="soft"
                :disabled="!chosenZone"
                :loading="settingZone !== null"
                @click="chosenZone && useZone(chosenZone)"
              >
                Use it
              </UButton>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="zoneOffer = null"
              >
                Not now
              </UButton>
            </div>
          </div>
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
          <!--
            The claim, and the way out of it. One OpenStreetMap feature is one
            place per trip, so without this a second pin on the same building is
            refused whatever it is renamed to.
          -->
          <div
            v-if="newPlace.osmId"
            class="flex items-center gap-2 text-xs text-muted"
          >
            <span>Matched OpenStreetMap {{ newPlace.osmType }}/{{ newPlace.osmId }}</span>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              @click="forgetMatch"
            >
              Not this one
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
