<script setup lang="ts">
/**
 * Every event on the instance, filterable — the view that was only possible in
 * Enterprise because it could query the whole table, and had no home in zäme
 * (the host list shows what YOU plan, which is a different question).
 *
 * Filters live in the URL so a filtered list is a link the owner can keep.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'All events' })

const route = useRoute()
const router = useRouter()

const status = ref((route.query.status as string) ?? '')
const type = ref((route.query.type as string) ?? '')
const when = ref((route.query.when as string) ?? '')
const q = ref((route.query.q as string) ?? '')
const offset = ref(Number(route.query.offset ?? 0))
const LIMIT = 50

const query = computed(() => ({
  ...(status.value ? { status: status.value } : {}),
  ...(type.value ? { type: type.value } : {}),
  ...(when.value ? { when: when.value } : {}),
  ...(q.value ? { q: q.value } : {}),
  limit: LIMIT,
  offset: offset.value
}))

const { data, pending } = await useFetch('/api/admin/events', { query })

// Keep the address bar honest — minus the paging default.
watch(query, (next) => {
  const { limit: _limit, ...rest } = next
  router.replace({ query: rest })
})
watch([status, type, when, q], () => {
  offset.value = 0
})

const STATUS_ITEMS = [
  { label: 'Any status', value: '' },
  { label: 'Draft', value: 'draft' },
  { label: 'Polling', value: 'polling' },
  { label: 'Published', value: 'published' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' }
]
const TYPE_ITEMS = [
  { label: 'Any kind', value: '' },
  { label: '🎬 Gathering', value: 'hosted' },
  { label: '🥳 Party', value: 'party' },
  { label: '🧳 Trip', value: 'trip' },
  { label: '🍿 Series', value: 'series' },
  { label: '🎤 Concert', value: 'concert' }
]
const WHEN_ITEMS = [
  { label: 'Any date', value: '' },
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Past', value: 'past' },
  { label: 'No date yet', value: 'undated' }
]
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex gap-2 flex-wrap items-center">
      <UInput
        v-model="q"
        placeholder="Search title, slug or place"
        icon="i-lucide-search"
        class="flex-1 min-w-56"
      />
      <USelect
        v-model="status"
        :items="STATUS_ITEMS"
        class="w-40"
      />
      <USelect
        v-model="type"
        :items="TYPE_ITEMS"
        class="w-40"
      />
      <USelect
        v-model="when"
        :items="WHEN_ITEMS"
        class="w-36"
      />
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <p class="font-semibold">
            {{ data?.total ?? 0 }} event<span v-if="data?.total !== 1">s</span>
          </p>
          <UButton
            to="/host/new"
            size="xs"
          >
            Plan something
          </UButton>
        </div>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-muted text-left">
            <tr class="border-b border-default">
              <th class="py-2 pr-3 font-medium">
                Event
              </th>
              <th class="py-2 px-3 font-medium">
                When
              </th>
              <th class="py-2 px-3 font-medium">
                Status
              </th>
              <th class="py-2 px-3 font-medium text-right">
                In
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Links
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Media
              </th>
              <th class="py-2 pl-3" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ev in data?.events ?? []"
              :key="ev.id"
              class="border-b border-default last:border-b-0"
            >
              <td class="py-2 pr-3">
                <p class="font-medium">
                  {{ ev.title }}
                  <UBadge
                    v-if="ev.externalRef"
                    variant="subtle"
                    color="info"
                    size="sm"
                    title="Projected from Enterprise"
                  >
                    ↔ Enterprise
                  </UBadge>
                  <UBadge
                    v-if="ev.isPublic"
                    variant="subtle"
                    color="neutral"
                    size="sm"
                  >
                    public
                  </UBadge>
                </p>
                <p class="text-muted">
                  {{ EVENT_TYPE_LABEL[ev.type] ?? ev.type }}
                  <span v-if="ev.parentTitle"> · in {{ ev.parentTitle }}</span>
                  <span v-if="ev.location"> · {{ ev.location }}</span>
                </p>
              </td>
              <td class="py-2 px-3 whitespace-nowrap">
                {{ formatWhen(ev.startsAt) }}
              </td>
              <td class="py-2 px-3">
                <UBadge
                  variant="subtle"
                  :color="eventStatusColor(ev.status)"
                >
                  {{ ev.status }}
                </UBadge>
              </td>
              <td class="py-2 px-3 text-right tabular-nums">
                {{ ev.yesCount }}<span class="text-muted">/{{ ev.rsvpCount }}</span>
              </td>
              <td class="py-2 px-3 text-right tabular-nums">
                {{ ev.inviteCount }}
              </td>
              <td class="py-2 px-3 text-right tabular-nums">
                {{ ev.mediaCount }}
              </td>
              <td class="py-2 pl-3 text-right whitespace-nowrap">
                <UButton
                  :to="`/host/${ev.slug}`"
                  size="xs"
                  variant="outline"
                >
                  Manage
                </UButton>
                <UButton
                  v-if="ev.isPublic"
                  :to="`/e/${ev.slug}`"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                >
                  Public
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="!pending && !data?.events.length"
          class="text-muted py-3"
        >
          Nothing matches that.
        </p>
      </div>

      <template
        v-if="(data?.total ?? 0) > LIMIT"
        #footer
      >
        <div class="flex items-center justify-between">
          <UButton
            size="xs"
            variant="ghost"
            :disabled="offset === 0"
            @click="offset = Math.max(0, offset - LIMIT)"
          >
            ← Newer
          </UButton>
          <span class="text-sm text-muted">
            {{ offset + 1 }}–{{ Math.min(offset + LIMIT, data?.total ?? 0) }} of {{ data?.total }}
          </span>
          <UButton
            size="xs"
            variant="ghost"
            :disabled="offset + LIMIT >= (data?.total ?? 0)"
            @click="offset = offset + LIMIT"
          >
            Older →
          </UButton>
        </div>
      </template>
    </UCard>
  </div>
</template>
