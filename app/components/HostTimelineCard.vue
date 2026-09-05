<script setup lang="ts">
/**
 * The itinerary editor (host side) — the trip planner's core: transport,
 * accommodation, activities and meals, day by day. Also handy for the
 * single-evening "doors → food → film" plan.
 */
interface TimelineItem {
  id: string
  title: string
  description: string | null
  startsAt: string | Date | null
  location: string | null
  type: string
}

const props = defineProps<{ slug: string, timeline: TimelineItem[], trip?: boolean }>()
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

const TYPE_ITEMS = [
  { label: '🚆 Transport', value: 'transport' },
  { label: '🛏️ Accommodation', value: 'accommodation' },
  { label: '🎬 Activity', value: 'activity' },
  { label: '🍕 Meal', value: 'meal' },
  { label: '📍 Other', value: 'other' }
]
const TYPE_ICONS: Record<string, string> = {
  transport: '🚆', accommodation: '🛏️', activity: '🎬', meal: '🍕', other: '📍'
}

const itemType = ref('activity')
const itemTitle = ref('')
const itemWhen = ref('')
const itemLocation = ref('')
const adding = ref(false)

async function addItem() {
  if (!itemTitle.value) return
  adding.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/timeline`, {
      method: 'POST',
      body: {
        title: itemTitle.value,
        type: itemType.value,
        startsAt: itemWhen.value ? new Date(itemWhen.value).toISOString() : null,
        location: itemLocation.value || null
      }
    })
    itemTitle.value = ''
    itemWhen.value = ''
    itemLocation.value = ''
    emit('updated')
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not add that', color: 'error' })
  } finally {
    adding.value = false
  }
}

async function removeItem(id: string) {
  await $fetch(`/api/host/events/${props.slug}/timeline/${id}`, { method: 'DELETE' })
  emit('updated')
}

function when(iso: string | Date | null): string | null {
  return iso
    ? new Date(iso).toLocaleString('en-CH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          {{ trip ? '🧳 Itinerary' : 'The plan' }}
        </p>
        <p class="text-sm text-muted">
          {{ trip ? 'Travel, accommodation, activities — grouped by day on the guest page.' : 'Doors, food, the main thing.' }}
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-2">
      <div
        v-for="item in timeline"
        :key="item.id"
        class="flex items-center justify-between gap-2 py-1.5 border-b border-default last:border-b-0 text-sm"
      >
        <p class="min-w-0 truncate">
          {{ TYPE_ICONS[item.type] || '📍' }}
          <span
            v-if="when(item.startsAt)"
            class="text-muted tabular-nums mr-1"
          >{{ when(item.startsAt) }}</span>
          <span class="font-medium">{{ item.title }}</span>
          <span
            v-if="item.location"
            class="text-muted"
          > · {{ item.location }}</span>
        </p>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          @click="removeItem(item.id)"
        >
          ✕
        </UButton>
      </div>

      <form
        class="flex flex-col sm:flex-row gap-2 pt-2"
        @submit.prevent="addItem"
      >
        <USelect
          v-model="itemType"
          :items="TYPE_ITEMS"
          class="sm:w-44"
        />
        <UInput
          v-model="itemTitle"
          placeholder="Zug → Lugano, IR 2313"
          class="flex-1"
        />
        <UInput
          v-model="itemWhen"
          type="datetime-local"
          class="sm:w-52"
        />
        <UButton
          type="submit"
          :loading="adding"
          :disabled="!itemTitle"
        >
          Add
        </UButton>
      </form>
    </div>
  </UCard>
</template>
