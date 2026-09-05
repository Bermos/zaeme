<script setup lang="ts">
/**
 * Who did what. One row per mutating request on a credentialled surface —
 * including the ones that were REFUSED, which is most of what an audit is for.
 *
 * The honest limits, stated on the page rather than buried here: this records
 * the act, not the diff, and reads are not recorded at all.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Audit' })

const route = useRoute()
const surface = ref((route.query.surface as string) ?? '')
const actorKind = ref('')
const failuresOnly = ref(false)

const { data, pending, refresh } = await useFetch('/api/admin/audit', {
  query: computed(() => ({
    surface: surface.value || undefined,
    actorKind: actorKind.value || undefined,
    failuresOnly: failuresOnly.value ? 'true' : undefined,
    limit: 200
  }))
})

const toast = useToast()
const pruning = ref(false)
async function prune(days: number) {
  pruning.value = true
  try {
    const { removed } = await $fetch<{ removed: number }>('/api/admin/audit/prune', {
      method: 'POST',
      body: { olderThanDays: days }
    })
    await refresh()
    toast.add({ title: `${removed} entr${removed === 1 ? 'y' : 'ies'} removed`, color: 'success' })
  } finally {
    pruning.value = false
  }
}

const SURFACE_ITEMS = [
  { label: 'Every surface', value: '' },
  { label: 'Admin', value: 'admin' },
  { label: 'Host', value: 'host' },
  { label: 'Invite links', value: 'invite' },
  { label: 'My invites', value: 'me' },
  { label: 'Enterprise', value: 'machine' }
]
const ACTOR_ITEMS = [
  { label: 'Anyone', value: '' },
  { label: 'Owner', value: 'owner' },
  { label: 'Planner', value: 'planner' },
  { label: 'Guest', value: 'guest' },
  { label: 'Enterprise', value: 'service' },
  { label: 'Unauthenticated', value: 'anonymous' }
]

function statusColor(status: number | null): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === null) return 'neutral'
  if (status >= 500) return 'error'
  if (status >= 400) return 'warning'
  return 'success'
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid sm:grid-cols-3 gap-3">
      <UCard>
        <p class="text-2xl font-bold tabular-nums">
          {{ data?.summary.totals.total ?? 0 }}
        </p>
        <p class="text-sm text-muted">
          recorded actions, all time
        </p>
      </UCard>
      <UCard>
        <p
          class="text-2xl font-bold tabular-nums"
          :class="data?.summary.totals.failures ? 'text-warning' : ''"
        >
          {{ data?.summary.totals.failures ?? 0 }}
        </p>
        <p class="text-sm text-muted">
          refused or failed
        </p>
      </UCard>
      <UCard>
        <p class="font-medium mb-1">
          Last 7 days
        </p>
        <p
          v-for="row in data?.summary.bySurface ?? []"
          :key="row.surface"
          class="text-sm text-muted flex justify-between"
        >
          <span>{{ row.surface }}</span>
          <span class="tabular-nums">{{ row.count }}</span>
        </p>
        <p
          v-if="!data?.summary.bySurface.length"
          class="text-sm text-muted"
        >
          Nothing yet.
        </p>
      </UCard>
    </div>

    <div class="flex gap-2 flex-wrap items-center">
      <USelect
        v-model="surface"
        :items="SURFACE_ITEMS"
        class="w-44"
      />
      <USelect
        v-model="actorKind"
        :items="ACTOR_ITEMS"
        class="w-44"
      />
      <USwitch
        v-model="failuresOnly"
        label="Only what was refused"
      />
      <div class="flex-1" />
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        :loading="pruning"
        @click="prune(90)"
      >
        Drop entries older than 90 days
      </UButton>
    </div>

    <UCard>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-muted text-left">
            <tr class="border-b border-default">
              <th class="py-2 pr-3 font-medium">
                When
              </th>
              <th class="py-2 px-3 font-medium">
                Who
              </th>
              <th class="py-2 px-3 font-medium">
                Did
              </th>
              <th class="py-2 px-3 font-medium">
                Event
              </th>
              <th class="py-2 pl-3 font-medium text-right">
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in data?.entries ?? []"
              :key="entry.id"
              class="border-b border-default last:border-b-0"
            >
              <td
                class="py-2 pr-3 whitespace-nowrap text-muted"
                :title="formatWhen(entry.at)"
              >
                {{ formatAgo(entry.at) }}
              </td>
              <td class="py-2 px-3">
                <UBadge
                  size="sm"
                  variant="subtle"
                  :color="entry.actorKind === 'service' ? 'info' : entry.actorKind === 'anonymous' ? 'neutral' : 'primary'"
                >
                  {{ entry.actorKind }}
                </UBadge>
                <span class="text-muted ml-1">{{ entry.actorLabel ?? '—' }}</span>
              </td>
              <td class="py-2 px-3 font-mono text-xs">
                {{ entry.method }} {{ entry.path }}
                <span
                  v-if="entry.meta && (entry.meta as Record<string, unknown>).thread"
                  class="text-muted"
                  :title="`XO thread ${(entry.meta as Record<string, string>).thread}, model ${(entry.meta as Record<string, string>).model}`"
                >
                  · thread {{ String((entry.meta as Record<string, string>).thread).slice(0, 10) }}
                </span>
              </td>
              <td class="py-2 px-3">
                <NuxtLink
                  v-if="entry.eventSlug"
                  :to="`/host/${entry.eventSlug}`"
                  class="hover:text-primary"
                >
                  {{ entry.eventSlug }}
                </NuxtLink>
                <span
                  v-else
                  class="text-muted"
                >—</span>
              </td>
              <td class="py-2 pl-3 text-right">
                <UBadge
                  size="sm"
                  variant="subtle"
                  :color="statusColor(entry.status)"
                >
                  {{ entry.status ?? '—' }}
                </UBadge>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="!pending && !data?.entries.length"
          class="text-muted py-3"
        >
          Nothing recorded for that filter.
        </p>
      </div>
    </UCard>

    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      title="What this log is, and is not"
      description="It records the ACT — who, on which surface, against which event, and what the response was. It does not record what changed, and it does not record reads. Enterprise's writes carry the XO thread that reasoned them; linking a specific row back to the sentence that caused it is issue #12."
    />
  </div>
</template>
