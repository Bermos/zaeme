<script setup lang="ts">
/**
 * Plan something — the host's front door, with a shape per occasion:
 *  - gathering: title + post; propose dates next (the poll).
 *  - party: two-stage — name the core group + candidate dates here; the poll
 *    opens immediately, and after locking you "open up" to everyone.
 *  - trip: multi-day — set the date span; itinerary + budget live on the
 *    manage page.
 *  - movie night (series): the standing crew signs up per showing; set the
 *    cadence, add members + schedule showings on the manage page.
 *  - concert: public page with "I go" for signed-in friends.
 */
definePageMeta({ middleware: 'guest-auth' })

type EventKind = 'hosted' | 'party' | 'trip' | 'series' | 'concert'

const kind = ref<EventKind>('hosted')
const KINDS: Array<{ value: EventKind, label: string, hint: string }> = [
  { value: 'hosted', label: '🎬 Gathering', hint: 'Movie night, dinner, anything — date poll included' },
  { value: 'party', label: '🥳 Party', hint: 'Core group fixes the date, then everyone signs up' },
  { value: 'trip', label: '🧳 Trip', hint: 'Multi-day, with itinerary and budget splitting' },
  { value: 'series', label: '🍿 Movie-night series', hint: 'A recurring cinema for your crew' },
  { value: 'concert', label: '🎤 Concert', hint: 'Public page — fans say "I go"' }
]

const title = ref('')
const description = ref('')
const posterUrl = ref('')
const location = ref('')
// trip
const startsAt = ref('')
const endsAt = ref('')

/**
 * WHICH CLOCK THIS EVENT'S TIMES ARE READ AGAINST (#31).
 *
 * Defaulted from the browser, because for a gathering that is the answer and
 * nobody should have to think about it: the host is where the party is. It is
 * still stored, not assumed — an event created here and read in another country
 * then says which clock it meant rather than moving with the reader.
 *
 * `''` is "the reader's own", which is what an event had before this field and
 * what somebody clearing it is asking for. The default is only applied in the
 * BROWSER (`browserTimezone` answers null on the server), so SSR renders the
 * empty option and the client fills it in — a container's `TZ` is the hosting
 * provider's clock and has nothing to do with anybody's party.
 *
 * A trip is where the picker earns its place. It is offered for every kind
 * because "a gathering abroad" is a real thing, and hiding the control behind
 * the type would mean a host who needs it cannot reach it until after the
 * event exists.
 */
const timezone = ref('')
const NO_ZONE = ''
const zoneItems = computed(() => [
  { label: 'The reader\'s own time zone', value: NO_ZONE },
  ...timezoneChoices().map(z => ({ label: z, value: z }))
])
onMounted(() => {
  timezone.value = browserTimezone() ?? NO_ZONE
})
// series
const cadence = ref('')
// concert
const ticketUrl = ref('')
const performerNote = ref('')
// party: the core group + candidate dates
const coreInvites = ref<Array<{ name: string, email: string }>>([{ name: '', email: '' }])
const dateOptions = ref<string[]>([''])

function addCoreRow() {
  coreInvites.value.push({ name: '', email: '' })
}
function addDateRow() {
  dateOptions.value.push('')
}

const partyReady = computed(() =>
  kind.value !== 'party'
  || (coreInvites.value.some(f => f.name.trim()) && dateOptions.value.some(d => d))
)

const creating = ref(false)
const toast = useToast()

async function create() {
  if (!title.value || !partyReady.value) return
  creating.value = true
  try {
    const body: Record<string, unknown> = {
      title: title.value,
      type: kind.value,
      description: description.value || null,
      posterUrl: posterUrl.value || null,
      location: location.value || null,
      timezone: timezone.value || null
    }
    if (kind.value === 'trip') {
      // Read against the zone chosen above, not the browser's: a host in
      // Zürich typing a Lisbon trip's "from 09:00" means 09:00 THERE.
      if (startsAt.value) body.startsAt = isoFromZonedInput(startsAt.value, timezone.value)
      if (endsAt.value) body.endsAt = isoFromZonedInput(endsAt.value, timezone.value)
    }
    if (kind.value === 'series') body.cadence = cadence.value || null
    if (kind.value === 'concert') {
      body.ticketUrl = ticketUrl.value || null
      body.performerNote = performerNote.value || null
      if (startsAt.value) body.startsAt = isoFromZonedInput(startsAt.value, timezone.value)
    }
    if (kind.value === 'party') {
      body.coreInvites = coreInvites.value
        .filter(f => f.name.trim())
        .map(f => ({ name: f.name.trim(), email: f.email.trim() || null }))
      body.dateOptions = dateOptions.value
        .filter(Boolean)
        .map(d => ({ startsAt: isoFromZonedInput(d, timezone.value) }))
    }

    const { slug } = await $fetch('/api/host/events', { method: 'POST', body })
    await navigateTo(`/host/${slug}`)
  } catch {
    toast.add({ title: 'Could not create it', color: 'error' })
  } finally {
    creating.value = false
  }
}

const active = computed(() => KINDS.find(k => k.value === kind.value)!)
</script>

<template>
  <div class="max-w-xl mx-auto px-4 py-8">
    <UCard>
      <template #header>
        <div>
          <p class="font-semibold text-lg">
            Plan something
          </p>
          <p class="text-sm text-muted">
            {{ active.hint }}
          </p>
        </div>
      </template>

      <form
        class="flex flex-col gap-4"
        @submit.prevent="create"
      >
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <UButton
            v-for="k in KINDS"
            :key="k.value"
            :variant="kind === k.value ? 'solid' : 'outline'"
            :color="kind === k.value ? 'primary' : 'neutral'"
            size="sm"
            @click.prevent="kind = k.value"
          >
            {{ k.label }}
          </UButton>
        </div>

        <UFormField
          label="What are we doing?"
          required
        >
          <UInput
            v-model="title"
            :placeholder="kind === 'trip' ? 'Ticino weekend' : kind === 'series' ? 'Freitagskino' : kind === 'concert' ? 'Jazz night at Moods' : 'Movie night: Dune Part Two'"
            size="lg"
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="The pitch"
          hint="Shown to your friends"
        >
          <UTextarea
            v-model="description"
            placeholder="Popcorn, sandworms, my place. Doors at 19:00."
            :rows="3"
            class="w-full"
          />
        </UFormField>
        <UFormField
          label="Poster URL"
          hint="A film poster or photo (optional)"
        >
          <UInput
            v-model="posterUrl"
            type="url"
            placeholder="https://…"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Where?">
          <UInput
            v-model="location"
            placeholder="My place / Kino Rex / …"
            class="w-full"
          />
        </UFormField>

        <!-- Trip: the date span -->
        <div
          v-if="kind === 'trip'"
          class="grid grid-cols-2 gap-3"
        >
          <UFormField label="From">
            <UInput
              v-model="startsAt"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Until">
            <UInput
              v-model="endsAt"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          label="Time zone"
          hint="Defaults to yours — change it for something happening abroad"
        >
          <USelectMenu
            v-model="timezone"
            :items="zoneItems"
            value-key="value"
            class="w-full"
          />
        </UFormField>

        <!-- Series: the cadence -->
        <UFormField
          v-if="kind === 'series'"
          label="How often?"
          hint="Just a note for the crew — you schedule each showing yourself"
        >
          <UInput
            v-model="cadence"
            placeholder="Every second Friday"
            class="w-full"
          />
        </UFormField>

        <!-- Concert -->
        <template v-if="kind === 'concert'">
          <UFormField label="When?">
            <UInput
              v-model="startsAt"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Ticket link">
            <UInput
              v-model="ticketUrl"
              type="url"
              placeholder="https://…"
              class="w-full"
            />
          </UFormField>
          <UFormField
            label="Performer note"
            hint="Who's playing / which set"
          >
            <UInput
              v-model="performerNote"
              placeholder="Playing bass with the quartet, 2nd set"
              class="w-full"
            />
          </UFormField>
        </template>

        <!-- Party: core group + candidate dates -->
        <template v-if="kind === 'party'">
          <UFormField
            label="The core group"
            hint="They fix the date with you — everyone else joins after"
          >
            <div class="flex flex-col gap-2">
              <div
                v-for="(friend, i) in coreInvites"
                :key="i"
                class="flex gap-2"
              >
                <UInput
                  v-model="friend.name"
                  placeholder="Name"
                  class="flex-1"
                />
                <UInput
                  v-model="friend.email"
                  type="email"
                  placeholder="Email (optional)"
                  class="flex-1"
                />
              </div>
              <UButton
                size="xs"
                variant="ghost"
                class="self-start"
                @click.prevent="addCoreRow"
              >
                + another friend
              </UButton>
            </div>
          </UFormField>
          <UFormField
            label="Candidate dates"
            hint="The core group votes on these"
          >
            <div class="flex flex-col gap-2">
              <UInput
                v-for="(_, i) in dateOptions"
                :key="i"
                v-model="dateOptions[i]"
                type="datetime-local"
                class="w-full"
              />
              <UButton
                size="xs"
                variant="ghost"
                class="self-start"
                @click.prevent="addDateRow"
              >
                + another date
              </UButton>
            </div>
          </UFormField>
        </template>

        <UButton
          type="submit"
          :loading="creating"
          :disabled="!title || !partyReady"
          size="lg"
          block
        >
          {{ kind === 'party' ? 'Create & start the date poll' : 'Create it' }}
        </UButton>
      </form>
    </UCard>
  </div>
</template>
