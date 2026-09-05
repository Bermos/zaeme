<script setup lang="ts">
/**
 * The admin overview — what Enterprise's Events department used to answer from
 * the whole table (upcoming / total / drafts), plus what it never could: the
 * instance's people, links and storage, and the gatherings that are quietly
 * failing to happen.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Instance admin' })

const { data, pending } = await useFetch('/api/admin/overview')

const tiles = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    { label: 'Upcoming', value: d.events.upcoming, hint: 'scheduled ahead', to: '/admin/events?when=upcoming' },
    { label: 'Events', value: d.events.total, hint: 'on the books', to: '/admin/events' },
    { label: 'Drafts', value: d.events.draft, hint: 'not published', to: '/admin/events?status=draft' },
    { label: 'People', value: d.people.guests, hint: 'have answered something', to: '/admin/people' },
    { label: 'Live links', value: d.invites.active, hint: `${d.invites.revoked} revoked`, to: '/admin/invites' },
    { label: 'Media', value: d.media.items, hint: formatBytes(d.media.bytes), to: '/admin/media' }
  ]
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <div
      v-if="pending && !data"
      class="text-muted"
    >
      Loading…
    </div>

    <template v-else-if="data">
      <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <UCard
          v-for="tile in tiles"
          :key="tile.label"
          class="hover:ring-primary/40 transition"
        >
          <NuxtLink
            :to="tile.to"
            class="block"
          >
            <p class="text-3xl font-bold tabular-nums">
              {{ tile.value }}
            </p>
            <p class="font-medium">
              {{ tile.label }}
            </p>
            <p class="text-sm text-muted">
              {{ tile.hint }}
            </p>
          </NuxtLink>
        </UCard>
      </div>

      <UCard>
        <template #header>
          <p class="font-semibold">
            Next up
          </p>
        </template>
        <div class="flex flex-col">
          <NuxtLink
            v-for="ev in data.next"
            :key="ev.slug"
            :to="`/host/${ev.slug}`"
            class="flex items-center justify-between gap-2 py-2 border-b border-default last:border-b-0 hover:text-primary"
          >
            <span class="min-w-0">
              <span class="font-medium">{{ ev.title }}</span>
              <span class="text-sm text-muted"> · {{ formatWhen(ev.startsAt) }}</span>
            </span>
            <span class="flex items-center gap-2 shrink-0">
              <UBadge
                variant="subtle"
                color="success"
              >{{ ev.yesCount }} in</UBadge>
              <UBadge
                variant="subtle"
                :color="eventStatusColor(ev.status)"
              >{{ ev.status }}</UBadge>
            </span>
          </NuxtLink>
          <p
            v-if="!data.next.length"
            class="text-muted text-sm py-2"
          >
            Nothing on the calendar. Suspiciously quiet.
          </p>
        </div>
      </UCard>

      <UCard v-if="data.needsAttention.length">
        <template #header>
          <div>
            <p class="font-semibold">
              Wants a nudge
            </p>
            <p class="text-sm text-muted">
              The three ways a gathering quietly fails to happen.
            </p>
          </div>
        </template>
        <div class="flex flex-col">
          <NuxtLink
            v-for="(item, i) in data.needsAttention"
            :key="`${item.slug}-${i}`"
            :to="`/host/${item.slug}`"
            class="flex items-center justify-between gap-2 py-2 border-b border-default last:border-b-0 hover:text-primary"
          >
            <span class="font-medium">{{ item.title }}</span>
            <span class="text-sm text-muted text-right">
              {{ item.reason }}<span v-if="item.startsAt"> · {{ formatWhen(item.startsAt, { time: false }) }}</span>
            </span>
          </NuxtLink>
        </div>
      </UCard>

      <div class="grid sm:grid-cols-2 gap-3">
        <UCard>
          <template #header>
            <p class="font-semibold">
              By status
            </p>
          </template>
          <dl class="text-sm flex flex-col gap-1">
            <div
              v-for="row in [
                ['Draft', data.events.draft],
                ['Polling', data.events.polling],
                ['Published', data.events.published],
                ['Completed', data.events.completed],
                ['Cancelled', data.events.cancelled]
              ]"
              :key="String(row[0])"
              class="flex justify-between"
            >
              <dt class="text-muted">
                {{ row[0] }}
              </dt>
              <dd class="tabular-nums font-medium">
                {{ row[1] }}
              </dd>
            </div>
          </dl>
        </UCard>
        <UCard>
          <template #header>
            <p class="font-semibold">
              Who's here
            </p>
          </template>
          <dl class="text-sm flex flex-col gap-1">
            <div class="flex justify-between">
              <dt class="text-muted">
                Accounts
              </dt>
              <dd class="tabular-nums font-medium">
                {{ data.people.accounts }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">
                Guests who answered
              </dt>
              <dd class="tabular-nums font-medium">
                {{ data.people.guests }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">
                Series regulars
              </dt>
              <dd class="tabular-nums font-medium">
                {{ data.people.seriesMembers }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">
                Unfinished uploads
              </dt>
              <dd class="tabular-nums font-medium">
                {{ data.media.pending }}
              </dd>
            </div>
          </dl>
        </UCard>
      </div>
    </template>
  </div>
</template>
