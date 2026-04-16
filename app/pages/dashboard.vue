<script setup lang="ts">
useSeoMeta({ title: 'zäme — Dashboard' })

definePageMeta({ middleware: 'auth' })

const { data: session } = authClient.useSession(useFetch)

type EventStatus = 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
type EventType = 'hosted' | 'concert' | 'series'
type PlannerRole = 'owner' | 'co_planner' | 'logistics'

interface EventRow {
  id: string
  slug: string
  title: string
  type: EventType
  status: EventStatus
  startsAt: string | null
  endsAt: string | null
  location: string | null
  isPublic: boolean
  parentId: string | null
  createdAt: string
  updatedAt: string
  plannerRole: PlannerRole
}

const { data: events, status } = await useFetch<EventRow[]>('/api/events')

const statusBadge: Record<string, { color: 'neutral' | 'warning' | 'success' | 'primary' | 'error', label: string }> = {
  draft: { color: 'neutral', label: 'Draft' },
  polling: { color: 'warning', label: 'Polling' },
  published: { color: 'success', label: 'Published' },
  completed: { color: 'primary', label: 'Completed' },
  cancelled: { color: 'error', label: 'Cancelled' }
}

const typeBadge: Record<string, string> = {
  hosted: 'i-lucide-calendar',
  concert: 'i-lucide-music',
  series: 'i-lucide-layers'
}

async function signOut() {
  await authClient.signOut()
  await navigateTo('/')
}
</script>

<template>
  <UContainer class="py-8">
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold">
          Dashboard
        </h1>
        <p class="text-muted text-sm mt-1">
          Welcome back, {{ session?.user?.name }}
        </p>
      </div>

      <div class="flex items-center gap-3">
        <UButton
          to="/events/new"
          label="New event"
          icon="i-lucide-plus"
        />
        <UDropdownMenu
          :items="[[{ label: 'Log out', icon: 'i-lucide-log-out', color: 'error', onSelect: signOut }]]"
          :content="{ align: 'end' }"
        >
          <UButton
            variant="ghost"
            :label="session?.user?.name ?? 'Account'"
            icon="i-lucide-user"
            trailing-icon="i-lucide-chevron-down"
          />
        </UDropdownMenu>
      </div>
    </div>

    <div
      v-if="status === 'pending'"
      class="flex justify-center py-12"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="size-8 animate-spin text-muted"
      />
    </div>

    <div
      v-else-if="!events?.length"
      class="py-16"
    >
      <UPageHero
        title="No events yet"
        description="Create your first event to get started."
      >
        <template #links>
          <UButton
            to="/events/new"
            label="Create event"
            icon="i-lucide-plus"
            size="lg"
          />
        </template>
      </UPageHero>
    </div>

    <div
      v-else
      class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <UCard
        v-for="ev in events"
        :key="ev.id"
        class="hover:ring-primary/50 transition-shadow"
      >
        <template #header>
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <UIcon
                :name="typeBadge[ev.type] ?? 'i-lucide-calendar'"
                class="size-4 shrink-0 text-muted"
              />
              <NuxtLink
                :to="`/events/${ev.slug}`"
                class="font-semibold truncate hover:text-primary transition-colors"
              >
                {{ ev.title }}
              </NuxtLink>
            </div>
            <UBadge
              :color="statusBadge[ev.status]?.color ?? 'neutral'"
              variant="subtle"
              size="sm"
              class="shrink-0"
            >
              {{ statusBadge[ev.status]?.label ?? ev.status }}
            </UBadge>
          </div>
        </template>

        <div class="space-y-1 text-sm text-muted">
          <div
            v-if="ev.startsAt"
            class="flex items-center gap-1.5"
          >
            <UIcon
              name="i-lucide-clock"
              class="size-3.5"
            />
            {{ new Date(ev.startsAt).toLocaleDateString('en-CH', { dateStyle: 'medium' }) }}
          </div>
          <div
            v-if="ev.location"
            class="flex items-center gap-1.5"
          >
            <UIcon
              name="i-lucide-map-pin"
              class="size-3.5"
            />
            {{ ev.location }}
          </div>
        </div>

        <template #footer>
          <div class="flex items-center justify-between">
            <UBadge
              variant="outline"
              color="neutral"
              size="sm"
            >
              {{ ev.plannerRole === 'owner' ? 'Owner' : ev.plannerRole === 'co_planner' ? 'Co-planner' : 'Logistics' }}
            </UBadge>
            <UButton
              :to="`/events/${ev.slug}`"
              label="View"
              variant="ghost"
              trailing-icon="i-lucide-arrow-right"
              size="sm"
            />
          </div>
        </template>
      </UCard>
    </div>
  </UContainer>
</template>
