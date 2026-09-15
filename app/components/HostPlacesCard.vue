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

/* ---- places ---- */
const newPlace = reactive({ name: '', address: '', lat: '', lng: '', note: '' })
const showCoords = ref(false)
const addingPlace = ref(false)

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
        note: newPlace.note || null
      }
    })
    newPlace.name = ''
    newPlace.address = ''
    newPlace.lat = ''
    newPlace.lng = ''
    newPlace.note = ''
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
