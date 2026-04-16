<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const slug = route.params.slug as string

useSeoMeta({ title: 'zäme — Event' })

type EventStatus = 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
type EventType = 'hosted' | 'concert' | 'series'
type PlannerRole = 'owner' | 'co_planner' | 'logistics'

interface EventPlanner {
  userId: string
  role: PlannerRole
  name: string
  email: string
}

interface EventDetail {
  id: string
  slug: string
  title: string
  type: EventType
  status: EventStatus
  description: string | null
  startsAt: string | null
  endsAt: string | null
  location: string | null
  venueStation: string | null
  ticketUrl: string | null
  performerNote: string | null
  isPublic: boolean
  parentId: string | null
  createdAt: string
  updatedAt: string
  planners: EventPlanner[]
}

interface EpisodeRow {
  id: string
  slug: string
  title: string
  status: EventStatus
  startsAt: string | null
}

const { data: ev, refresh, status: fetchStatus } = await useFetch<EventDetail>(`/api/events/${slug}`)

// Update page title when data loads
watchEffect(() => {
  if (ev.value?.title) {
    useSeoMeta({ title: `zäme — ${ev.value.title}` })
  }
})

const toast = useToast()
const statusLoading = ref(false)
const editOpen = ref(false)
const addPlannerOpen = ref(false)

// --- Status transition ---
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  polling: 'Polling',
  published: 'Published',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const STATUS_COLORS: Record<string, 'neutral' | 'warning' | 'success' | 'primary' | 'error'> = {
  draft: 'neutral',
  polling: 'warning',
  published: 'success',
  completed: 'primary',
  cancelled: 'error'
}

const TRANSITIONS: Record<string, string[]> = {
  draft: ['polling', 'published', 'cancelled'],
  polling: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
}

const nextStatuses = computed(() => TRANSITIONS[ev.value?.status ?? 'draft'] ?? [])

const { data: session } = authClient.useSession(useFetch)

const currentPlanner = computed(() =>
  ev.value?.planners?.find(p => p.userId === session.value?.user?.id)
)
const isOwner = computed(() => currentPlanner.value?.role === 'owner')

async function transitionStatus(newStatus: string) {
  statusLoading.value = true
  try {
    await $fetch(`/api/events/${slug}/status`, {
      method: 'POST',
      body: { status: newStatus }
    })
    await refresh()
    toast.add({ title: 'Status updated', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to update status', color: 'error' })
  } finally {
    statusLoading.value = false
  }
}

// --- Edit form ---
const editSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().optional(),
  venueStation: z.string().optional(),
  ticketUrl: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  performerNote: z.string().optional(),
  isPublic: z.boolean()
})

type EditSchema = z.output<typeof editSchema>

const editState = reactive<Partial<EditSchema>>({})
const editLoading = ref(false)

function openEdit() {
  if (!ev.value) return
  editState.title = ev.value.title
  editState.description = ev.value.description ?? ''
  editState.startsAt = ev.value.startsAt
    ? new Date(ev.value.startsAt).toISOString().slice(0, 16)
    : undefined
  editState.endsAt = ev.value.endsAt
    ? new Date(ev.value.endsAt).toISOString().slice(0, 16)
    : undefined
  editState.location = ev.value.location ?? ''
  editState.venueStation = ev.value.venueStation ?? ''
  editState.ticketUrl = ev.value.ticketUrl ?? ''
  editState.performerNote = ev.value.performerNote ?? ''
  editState.isPublic = ev.value.isPublic
  editOpen.value = true
}

async function saveEdit() {
  editLoading.value = true
  try {
    const payload: Record<string, unknown> = {
      title: editState.title,
      description: editState.description || null,
      location: editState.location || null,
      venueStation: editState.venueStation || null,
      ticketUrl: editState.ticketUrl || null,
      performerNote: editState.performerNote || null,
      isPublic: editState.isPublic
    }
    if (editState.startsAt) payload.startsAt = new Date(editState.startsAt).toISOString()
    else payload.startsAt = null
    if (editState.endsAt) payload.endsAt = new Date(editState.endsAt).toISOString()
    else payload.endsAt = null

    await $fetch(`/api/events/${slug}`, { method: 'PATCH', body: payload })
    await refresh()
    editOpen.value = false
    toast.add({ title: 'Event updated', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to update', color: 'error' })
  } finally {
    editLoading.value = false
  }
}

// --- Co-planner management ---
const { data: allUsers } = await useFetch<{ id: string, name: string, email: string }[]>('/api/users')

const addPlannerSchema = z.object({
  userId: z.string().min(1, 'Select a user'),
  role: z.enum(['co_planner', 'logistics']).default('co_planner')
})
type AddPlannerSchema = z.output<typeof addPlannerSchema>
const addPlannerState = reactive<Partial<AddPlannerSchema>>({ role: 'co_planner' })
const addPlannerLoading = ref(false)
const addPlannerError = ref<string | null>(null)

const availableUsers = computed(() => {
  const existingIds = new Set(ev.value?.planners?.map(p => p.userId) ?? [])
  return (allUsers.value ?? []).filter(u => !existingIds.has(u.id))
})

async function addPlanner() {
  addPlannerLoading.value = true
  addPlannerError.value = null
  try {
    await $fetch(`/api/events/${slug}/planners`, {
      method: 'POST',
      body: { userId: addPlannerState.userId, role: addPlannerState.role }
    })
    await refresh()
    addPlannerOpen.value = false
    addPlannerState.userId = undefined
    addPlannerState.role = 'co_planner'
    toast.add({ title: 'Co-planner added', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    addPlannerError.value = e?.data?.message ?? 'Failed to add co-planner'
  } finally {
    addPlannerLoading.value = false
  }
}

async function removePlanner(userId: string) {
  try {
    await $fetch(`/api/events/${slug}/planners/${userId}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Planner removed', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to remove', color: 'error' })
  }
}

// Episodes for series — only fetched when event type is series
const isSeries = computed(() => ev.value?.type === 'series')
const { data: episodes, refresh: refreshEpisodes } = useFetch<EpisodeRow[]>(
  `/api/events/${slug}/episodes`,
  {
    immediate: isSeries.value,
    watch: false
  }
)

watch(isSeries, async (nowSeries) => {
  if (nowSeries) await refreshEpisodes()
})

const newEpisodeOpen = ref(false)
const newEpisodeSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().optional()
})
type NewEpisodeSchema = z.output<typeof newEpisodeSchema>
const newEpisodeState = reactive<Partial<NewEpisodeSchema>>({})
const newEpisodeLoading = ref(false)
const newEpisodeError = ref<string | null>(null)

async function createEpisode() {
  newEpisodeLoading.value = true
  newEpisodeError.value = null
  try {
    const payload: Record<string, unknown> = { title: newEpisodeState.title }
    if (newEpisodeState.startsAt) payload.startsAt = new Date(newEpisodeState.startsAt).toISOString()
    if (newEpisodeState.endsAt) payload.endsAt = new Date(newEpisodeState.endsAt).toISOString()
    if (newEpisodeState.location) payload.location = newEpisodeState.location

    await $fetch(`/api/events/${slug}/episodes`, { method: 'POST', body: payload })
    await refreshEpisodes()
    newEpisodeOpen.value = false
    newEpisodeState.title = undefined
    newEpisodeState.startsAt = undefined
    newEpisodeState.endsAt = undefined
    newEpisodeState.location = undefined
    toast.add({ title: 'Episode created', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    newEpisodeError.value = e?.data?.message ?? 'Failed to create episode'
  } finally {
    newEpisodeLoading.value = false
  }
}
</script>

<template>
  <UContainer class="py-8 max-w-4xl">
    <!-- Loading -->
    <div
      v-if="fetchStatus === 'pending'"
      class="flex justify-center py-12"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="size-8 animate-spin text-muted"
      />
    </div>

    <template v-else-if="ev">
      <!-- Header -->
      <div class="flex items-start justify-between gap-4 mb-6">
        <div class="flex items-center gap-3 min-w-0">
          <UButton
            to="/dashboard"
            icon="i-lucide-arrow-left"
            variant="ghost"
            size="sm"
            class="shrink-0"
          />
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h1 class="text-2xl font-bold truncate">
                {{ ev.title }}
              </h1>
              <UBadge
                :color="STATUS_COLORS[ev.status] ?? 'neutral'"
                variant="subtle"
              >
                {{ STATUS_LABELS[ev.status] ?? ev.status }}
              </UBadge>
              <UBadge
                v-if="ev.isPublic"
                color="primary"
                variant="outline"
                icon="i-lucide-globe"
              >
                Public
              </UBadge>
            </div>
            <p class="text-muted text-sm mt-0.5">
              {{ ev.slug }}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <UButton
            v-if="nextStatuses.length > 0"
            icon="i-lucide-refresh-cw"
            variant="outline"
            size="sm"
            :loading="statusLoading"
            label="Transition"
          >
            <UDropdownMenu
              :items="nextStatuses.map(s => ({ label: STATUS_LABELS[s], onSelect: () => transitionStatus(s) }))"
              :content="{ align: 'end' }"
            >
              <template #default="{ open }">
                <UButton
                  variant="outline"
                  size="sm"
                  :loading="statusLoading"
                  label="Status"
                  trailing-icon="i-lucide-chevron-down"
                  :class="open ? 'ring-1 ring-primary' : ''"
                />
              </template>
            </UDropdownMenu>
          </UButton>
          <UButton
            icon="i-lucide-pencil"
            variant="ghost"
            size="sm"
            label="Edit"
            @click="openEdit"
          />
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-3">
        <!-- Main content -->
        <div class="lg:col-span-2 space-y-6">
          <!-- Details card -->
          <UCard>
            <template #header>
              <h2 class="font-semibold">
                Details
              </h2>
            </template>

            <dl class="space-y-3 text-sm">
              <div
                v-if="ev.type"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Type
                </dt>
                <dd class="capitalize flex items-center gap-1.5">
                  <UIcon
                    :name="ev.type === 'concert' ? 'i-lucide-music' : ev.type === 'series' ? 'i-lucide-layers' : 'i-lucide-calendar'"
                    class="size-3.5 text-muted"
                  />
                  {{ ev.type }}
                </dd>
              </div>

              <div
                v-if="ev.startsAt"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Starts
                </dt>
                <dd>{{ new Date(ev.startsAt).toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' }) }}</dd>
              </div>

              <div
                v-if="ev.endsAt"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Ends
                </dt>
                <dd>{{ new Date(ev.endsAt).toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' }) }}</dd>
              </div>

              <div
                v-if="ev.location"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Location
                </dt>
                <dd class="flex items-center gap-1.5">
                  <UIcon
                    name="i-lucide-map-pin"
                    class="size-3.5 text-muted"
                  />
                  {{ ev.location }}
                </dd>
              </div>

              <div
                v-if="ev.venueStation"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Station
                </dt>
                <dd class="flex items-center gap-1.5">
                  <UIcon
                    name="i-lucide-train-front"
                    class="size-3.5 text-muted"
                  />
                  {{ ev.venueStation }}
                </dd>
              </div>

              <!-- Concert-specific -->
              <div
                v-if="ev.ticketUrl"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Tickets
                </dt>
                <dd>
                  <UButton
                    :to="ev.ticketUrl"
                    external
                    variant="link"
                    size="xs"
                    icon="i-lucide-ticket"
                    label="Buy tickets"
                    class="p-0"
                  />
                </dd>
              </div>

              <div
                v-if="ev.performerNote"
                class="flex gap-2"
              >
                <dt class="text-muted w-28 shrink-0">
                  Performers
                </dt>
                <dd>{{ ev.performerNote }}</dd>
              </div>
            </dl>

            <div
              v-if="ev.description"
              class="mt-4 pt-4 border-t border-default"
            >
              <p class="text-sm whitespace-pre-wrap">
                {{ ev.description }}
              </p>
            </div>
          </UCard>

          <!-- Episodes (series only) -->
          <UCard v-if="ev.type === 'series'">
            <template #header>
              <div class="flex items-center justify-between">
                <h2 class="font-semibold">
                  Episodes
                </h2>
                <UButton
                  size="sm"
                  icon="i-lucide-plus"
                  label="Add episode"
                  variant="ghost"
                  @click="newEpisodeOpen = true"
                />
              </div>
            </template>

            <div
              v-if="!episodes?.length"
              class="text-sm text-muted py-2"
            >
              No episodes yet. Add the first one above.
            </div>

            <ul
              v-else
              class="divide-y divide-default"
            >
              <li
                v-for="ep in episodes"
                :key="ep.id"
                class="py-3 flex items-center justify-between gap-3"
              >
                <div>
                  <NuxtLink
                    :to="`/events/${ep.slug}`"
                    class="text-sm font-medium hover:text-primary transition-colors"
                  >
                    {{ ep.title }}
                  </NuxtLink>
                  <p
                    v-if="ep.startsAt"
                    class="text-xs text-muted mt-0.5"
                  >
                    {{ new Date(ep.startsAt).toLocaleDateString('en-CH', { dateStyle: 'medium' }) }}
                  </p>
                </div>
                <UBadge
                  :color="STATUS_COLORS[ep.status] ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ STATUS_LABELS[ep.status] ?? ep.status }}
                </UBadge>
              </li>
            </ul>
          </UCard>
        </div>

        <!-- Sidebar -->
        <div class="space-y-6">
          <!-- Planners card -->
          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h2 class="font-semibold">
                  Planners
                </h2>
                <UButton
                  v-if="isOwner"
                  size="sm"
                  icon="i-lucide-user-plus"
                  variant="ghost"
                  @click="addPlannerOpen = true"
                />
              </div>
            </template>

            <ul class="space-y-2">
              <li
                v-for="planner in ev.planners"
                :key="planner.userId"
                class="flex items-center justify-between gap-2"
              >
                <div class="min-w-0">
                  <p class="text-sm font-medium truncate">
                    {{ planner.name }}
                  </p>
                  <p class="text-xs text-muted truncate">
                    {{ planner.email }}
                  </p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <UBadge
                    variant="outline"
                    color="neutral"
                    size="sm"
                  >
                    {{ planner.role === 'co_planner' ? 'Co-planner' : planner.role === 'owner' ? 'Owner' : 'Logistics' }}
                  </UBadge>
                  <UButton
                    v-if="isOwner && planner.role !== 'owner'"
                    icon="i-lucide-x"
                    variant="ghost"
                    size="xs"
                    color="error"
                    @click="removePlanner(planner.userId)"
                  />
                </div>
              </li>
            </ul>
          </UCard>

          <!-- Status history / info card -->
          <UCard>
            <template #header>
              <h2 class="font-semibold">
                Lifecycle
              </h2>
            </template>

            <div class="space-y-2">
              <div
                v-for="s in ['draft', 'polling', 'published', 'completed']"
                :key="s"
                class="flex items-center gap-2 text-sm"
              >
                <UIcon
                  :name="ev.status === s ? 'i-lucide-circle-dot' : 'i-lucide-circle'"
                  :class="ev.status === s ? 'text-primary' : 'text-muted'"
                  class="size-3.5 shrink-0"
                />
                <span :class="ev.status === s ? 'font-medium' : 'text-muted'">
                  {{ STATUS_LABELS[s] }}
                </span>
              </div>
              <div
                v-if="ev.status === 'cancelled'"
                class="flex items-center gap-2 text-sm"
              >
                <UIcon
                  name="i-lucide-circle-dot"
                  class="size-3.5 shrink-0 text-error"
                />
                <span class="font-medium text-error">Cancelled</span>
              </div>
            </div>
          </UCard>
        </div>
      </div>
    </template>

    <!-- Edit modal -->
    <UModal
      v-model:open="editOpen"
      title="Edit event"
    >
      <template #body>
        <UForm
          :schema="editSchema"
          :state="editState"
          class="space-y-4 p-1"
          @submit="saveEdit"
        >
          <UFormField
            label="Title"
            name="title"
            required
          >
            <UInput
              v-model="editState.title"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Description"
            name="description"
          >
            <UTextarea
              v-model="editState.description"
              :rows="3"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              label="Start"
              name="startsAt"
            >
              <UInput
                v-model="editState.startsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="End"
              name="endsAt"
            >
              <UInput
                v-model="editState.endsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            label="Location"
            name="location"
          >
            <UInput
              v-model="editState.location"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Venue station"
            name="venueStation"
          >
            <UInput
              v-model="editState.venueStation"
              class="w-full"
            />
          </UFormField>

          <template v-if="ev?.type === 'concert'">
            <UFormField
              label="Ticket URL"
              name="ticketUrl"
            >
              <UInput
                v-model="editState.ticketUrl"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="Performer note"
              name="performerNote"
            >
              <UInput
                v-model="editState.performerNote"
                class="w-full"
              />
            </UFormField>
          </template>

          <UFormField
            label="Visibility"
            name="isPublic"
          >
            <UCheckbox
              v-model="editState.isPublic"
              label="Make this event public"
            />
          </UFormField>

          <div class="flex justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              label="Cancel"
              @click="editOpen = false"
            />
            <UButton
              type="submit"
              label="Save changes"
              :loading="editLoading"
            />
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Add planner modal -->
    <UModal
      v-model:open="addPlannerOpen"
      title="Add co-planner"
    >
      <template #body>
        <UForm
          :schema="addPlannerSchema"
          :state="addPlannerState"
          class="space-y-4 p-1"
          @submit="addPlanner"
        >
          <UFormField
            label="User"
            name="userId"
          >
            <USelect
              v-model="addPlannerState.userId"
              :options="availableUsers.map(u => ({ label: `${u.name} (${u.email})`, value: u.id }))"
              placeholder="Select a user..."
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Role"
            name="role"
          >
            <USelect
              v-model="addPlannerState.role"
              :options="[
                { label: 'Co-planner', value: 'co_planner' },
                { label: 'Logistics', value: 'logistics' }
              ]"
              class="w-full"
            />
          </UFormField>

          <UAlert
            v-if="addPlannerError"
            color="error"
            variant="subtle"
            :description="addPlannerError"
          />

          <div class="flex justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              label="Cancel"
              @click="addPlannerOpen = false"
            />
            <UButton
              type="submit"
              label="Add co-planner"
              :loading="addPlannerLoading"
              icon="i-lucide-user-plus"
            />
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- New episode modal -->
    <UModal
      v-model:open="newEpisodeOpen"
      title="Add episode"
    >
      <template #body>
        <UForm
          :schema="newEpisodeSchema"
          :state="newEpisodeState"
          class="space-y-4 p-1"
          @submit="createEpisode"
        >
          <UFormField
            label="Title"
            name="title"
            required
          >
            <UInput
              v-model="newEpisodeState.title"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              label="Start"
              name="startsAt"
            >
              <UInput
                v-model="newEpisodeState.startsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="End"
              name="endsAt"
            >
              <UInput
                v-model="newEpisodeState.endsAt"
                type="datetime-local"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            label="Location"
            name="location"
          >
            <UInput
              v-model="newEpisodeState.location"
              class="w-full"
            />
          </UFormField>

          <UAlert
            v-if="newEpisodeError"
            color="error"
            variant="subtle"
            :description="newEpisodeError"
          />

          <div class="flex justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              label="Cancel"
              @click="newEpisodeOpen = false"
            />
            <UButton
              type="submit"
              label="Create episode"
              :loading="newEpisodeLoading"
              icon="i-lucide-plus"
            />
          </div>
        </UForm>
      </template>
    </UModal>
  </UContainer>
</template>
