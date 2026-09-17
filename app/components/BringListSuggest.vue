<script setup lang="ts">
/**
 * ONE TAP ON AN EMPTY BRING LIST (#45).
 *
 * A host opening an empty list has to invent the whole thing. This offers a
 * list — the checked-in set for the event's type scaled to the yes-RSVPs, or a
 * copy of a past event of the same type — SHOWS IT, lets the host untick and
 * re-count every line, and only then writes it. Nothing is written until the
 * button at the bottom, which is the "editable before it is applied" criterion
 * and the reason this is a panel rather than a single button.
 *
 * WHAT IS NOT IN THIS FILE, and deliberately: the numbers, the duplicate rule
 * and the summary sentence. They all live in
 * `shared/utils/bring-list-suggestions.ts` because nothing in this repository
 * executes a `.vue` file — a rule written here would be guarded by a string
 * match and by nothing that could run it. `test/bring-list-suggestions.test.ts`
 * runs them, and pins the call sites below.
 *
 * AND NO EVENT TYPE GETS A DEAD CONTROL. A type with nothing to suggest (a gig,
 * a series container) answers with a `reason`, and this renders the sentence
 * INSTEAD of the list and the button — never an empty box with a live-looking
 * "Add 0 items" on it.
 */
interface SuggestedRow {
  key: string
  title: string
  category: 'food' | 'drink' | 'other'
  unit: string | null
  quantityNeeded: number | null
  /** The free-text amount — "two big bowls". Null on a static suggestion. */
  quantity: string | null
  note: string | null
}

interface Suggestion {
  source: 'static' | 'event'
  fromSlug: string | null
  eventType: string
  headcount: number
  reason: string | null
  items: SuggestedRow[]
}

interface Source {
  slug: string
  title: string
  startsAt: string | null
  itemCount: number
}

const props = defineProps<{ slug: string, itemCount: number }>()
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

const CATEGORY_ICONS: Record<string, string> = { food: '🍲', drink: '🍹', other: '📦' }

/**
 * OPEN ON AN EMPTY OR THIN LIST, behind a button on a full one — the issue's
 * own framing. The threshold is `shared/utils/bring-list-suggestions.ts`, so
 * "thin" is one number in one place rather than a literal here.
 */
const open = ref(isThinBringList(props.itemCount))
const loaded = ref(false)
const loading = ref(false)
const applying = ref(false)

const reason = ref<string | null>(null)
const source = ref<'static' | 'event'>('static')
const headcount = ref(0)
const sources = ref<Source[]>([])
/** `''` is the static set; any other value is a past event's slug. */
const from = ref('')
const rows = ref<Array<SuggestedRow & { include: boolean }>>([])

const sourceItems = computed(() => [
  { label: 'A starter list for this kind of evening', value: '' },
  ...sources.value.map(s => ({ label: `${s.title} (${s.itemCount} items)`, value: s.slug }))
])

async function load() {
  loading.value = true
  try {
    const query = from.value ? `?from=${encodeURIComponent(from.value)}` : ''
    const data = await $fetch<{ suggestion: Suggestion, sources: Source[] }>(
      `/api/host/events/${props.slug}/contributions/suggestions${query}`
    )
    reason.value = data.suggestion.reason
    source.value = data.suggestion.source
    headcount.value = data.suggestion.headcount
    sources.value = data.sources
    // Everything starts ticked: the point is not typing, and unticking one line
    // is cheaper than ticking six.
    rows.value = data.suggestion.items.map(i => ({ ...i, include: true }))
    loaded.value = true
  } catch {
    toast.add({ title: 'Could not put a list together just now', color: 'warning' })
  } finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen && !loaded.value) load()
}, { immediate: true })
watch(from, () => {
  if (open.value) load()
})

const chosen = computed(() => rows.value.filter(r => r.include))

/**
 * THE EDITED LIST IS WHAT IS SENT — the ticked rows, with the counts as they
 * stand in the fields. Sending `data.suggestion.items` instead would make every
 * tick and every number on this panel decorative, which is the mutation
 * `test/bring-list-suggestions.test.ts` pins this call site against.
 */
async function apply() {
  if (!chosen.value.length) return
  applying.value = true
  try {
    const result = await $fetch<{ added: number, skipped: string[] }>(
      `/api/host/events/${props.slug}/contributions/suggestions`,
      {
        method: 'POST',
        body: {
          items: chosen.value.map(r => ({
            title: r.title,
            category: r.category,
            unit: r.unit,
            // An emptied field means "no stated count", not `''` — which is
            // what `v-model.number` actually hands back and what the route's
            // schema would refuse for the whole list at once.
            quantityNeeded: countFieldValue(r.quantityNeeded),
            // THE FREE-TEXT AMOUNT RIDES ALONG on a copy. Leaving it out here
            // would undo the fix one layer up: the preview would carry "two big
            // bowls" and the applied item would not.
            quantity: r.quantity,
            note: r.note
          }))
        }
      }
    )
    toast.add({ title: applySummary(result.added, result.skipped.length), color: 'success' })
    // Closed, and back to the starter list next time: reopening on the past
    // event somebody copied ten minutes ago is a surprising place to land.
    // `from` is reset while `open` is already false, so its watcher does not
    // fire a load into a closed panel.
    open.value = false
    loaded.value = false
    from.value = ''
    emit('updated')
  } catch {
    toast.add({ title: 'Could not add those just now', color: 'warning' })
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <div class="pt-2">
    <UButton
      v-if="!open"
      size="xs"
      variant="outline"
      icon="i-lucide-sparkles"
      @click="open = true"
    >
      Suggest a list
    </UButton>

    <div
      v-else
      class="flex flex-col gap-3 rounded-lg border border-default p-3"
    >
      <div class="flex items-start justify-between gap-2">
        <div>
          <p class="font-medium">
            Suggest a list
          </p>
          <p
            v-if="source === 'static'"
            class="text-sm text-muted"
          >
            {{ headcountLine(headcount) }}
          </p>
          <p
            v-else
            class="text-sm text-muted"
          >
            The items from that evening — the counts came with them, the claims did not.
          </p>
        </div>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          @click="open = false"
        >
          Close
        </UButton>
      </div>

      <USelect
        v-if="sources.length"
        v-model="from"
        :items="sourceItems"
        :disabled="loading"
        aria-label="Where to take the list from"
      />

      <p
        v-if="loading"
        class="text-sm text-muted"
      >
        Putting a list together…
      </p>

      <!-- A type with nothing to suggest says so, and offers no button. -->
      <p
        v-else-if="reason"
        class="text-sm text-muted"
      >
        {{ reason }}
      </p>

      <p
        v-else-if="!rows.length"
        class="text-sm text-muted"
      >
        Nothing to suggest here yet — add the first thing by hand.
      </p>

      <template v-else>
        <div
          v-for="r in rows"
          :key="r.key"
          class="flex items-center gap-2"
        >
          <UCheckbox
            v-model="r.include"
            :aria-label="`Include ${r.title}`"
          />
          <span class="shrink-0">{{ CATEGORY_ICONS[r.category] }}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">
              {{ r.title }}
              <!--
                THE FREE-TEXT AMOUNT, SHOWN, exactly as `BringList.vue` shows it
                to a guest. A copy carries it, and the host choosing the copy is
                the one person who was previously unable to see it: the host
                page's own bring list does not render this column, so a copy
                that dropped it looked complete here and lossy on every invite
                page.
              -->
              <span
                v-if="r.quantity"
                class="text-xs text-muted"
              >({{ r.quantity }})</span>
            </p>
            <p
              v-if="r.note"
              class="truncate text-xs text-muted"
            >
              {{ r.note }}
            </p>
          </div>
          <UInput
            v-model.number="r.quantityNeeded"
            type="number"
            :min="1"
            size="xs"
            class="w-20"
            placeholder="—"
            :aria-label="`How many ${r.title}`"
          />
          <span class="w-16 shrink-0 text-xs text-muted">{{ r.unit }}</span>
        </div>

        <div class="flex items-center gap-2">
          <UButton
            :loading="applying"
            :disabled="!chosen.length"
            @click="apply"
          >
            Add {{ chosen.length }} {{ chosen.length === 1 ? 'item' : 'items' }}
          </UButton>
          <p class="text-sm text-muted">
            Anything already on the list is left alone.
          </p>
        </div>
      </template>
    </div>
  </div>
</template>
