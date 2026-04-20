<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ middleware: 'auth' })

type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

interface RsvpRow {
  id: string
  status: RsvpStatus
  plusOne: boolean
  plusOneName: string | null
  dietary: string | null
  accessibility: string | null
  notes: string | null
  guestName: string | null
  guestEmail: string | null
  userId: string | null
  userName: string | null
  userEmail: string | null
  inviteId: string | null
  inviteLabel: string | null
  createdAt: string
  updatedAt: string
}

interface RsvpSummary {
  yes: number
  maybe: number
  no: number
  cheering: number
  total: number
  headcount: number
}

const route = useRoute()
const slug = route.params.slug as string

useSeoMeta({ title: 'zäme — RSVPs' })

const { data, refresh, status: fetchStatus } = await useFetch<{ rsvps: RsvpRow[], summary: RsvpSummary }>(
  `/api/events/${slug}/rsvps`
)

const { STATUS_LABELS, STATUS_COLORS } = useRsvpLabels()
const toast = useToast()

const displayName = (r: RsvpRow) => r.userName ?? r.guestName ?? r.guestEmail ?? 'Unknown'
const displayEmail = (r: RsvpRow) => r.userEmail ?? r.guestEmail ?? ''

// --- Edit modal ---
const editOpen = ref(false)
const editing = ref<RsvpRow | null>(null)

const editSchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  plusOne: z.boolean(),
  plusOneName: z.string().max(200).optional(),
  dietary: z.string().max(500).optional(),
  accessibility: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  guestName: z.string().max(200).optional(),
  guestEmail: z.email().optional().or(z.literal(''))
})
type EditSchema = z.output<typeof editSchema>
const editState = reactive<Partial<EditSchema>>({})
const editLoading = ref(false)

function openEdit(row: RsvpRow) {
  editing.value = row
  editState.status = row.status
  editState.plusOne = row.plusOne
  editState.plusOneName = row.plusOneName ?? undefined
  editState.dietary = row.dietary ?? undefined
  editState.accessibility = row.accessibility ?? undefined
  editState.notes = row.notes ?? undefined
  editState.guestName = row.guestName ?? undefined
  editState.guestEmail = row.guestEmail ?? undefined
  editOpen.value = true
}

async function saveEdit() {
  if (!editing.value) return
  editLoading.value = true
  try {
    const payload: Record<string, unknown> = {
      status: editState.status,
      plusOne: !!editState.plusOne,
      plusOneName: editState.plusOne ? (editState.plusOneName ?? null) : null,
      dietary: editState.dietary || null,
      accessibility: editState.accessibility || null,
      notes: editState.notes || null
    }
    if (!editing.value.userId) {
      payload.guestName = editState.guestName || null
      payload.guestEmail = editState.guestEmail || null
    }
    await $fetch(`/api/events/${slug}/rsvps/${editing.value.id}`, {
      method: 'PATCH',
      body: payload
    })
    editOpen.value = false
    toast.add({ title: 'RSVP updated', color: 'success' })
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to update', color: 'error' })
  } finally {
    editLoading.value = false
  }
}

async function removeRsvp(row: RsvpRow) {
  if (!confirm(`Remove RSVP for ${displayName(row)}?`)) return
  try {
    await $fetch(`/api/events/${slug}/rsvps/${row.id}`, { method: 'DELETE' })
    toast.add({ title: 'RSVP removed', color: 'success' })
    await refresh()
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to remove', color: 'error' })
  }
}

const summaryCards: { key: RsvpStatus, label: string }[] = [
  { key: 'yes', label: 'Going' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'no', label: 'No' },
  { key: 'cheering', label: 'Cheering' }
]
</script>

<template>
  <UContainer class="py-8 max-w-5xl">
    <!-- Header -->
    <div class="flex items-center gap-3 mb-6">
      <UButton
        :to="`/events/${slug}`"
        icon="i-lucide-arrow-left"
        variant="ghost"
        size="sm"
      />
      <div>
        <h1 class="text-2xl font-bold">
          Guests & RSVPs
        </h1>
        <p class="text-muted text-sm mt-0.5">
          Manage who's coming.
        </p>
      </div>
    </div>

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

    <template v-else-if="data">
      <!-- Summary -->
      <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
        <UCard
          v-for="s in summaryCards"
          :key="s.key"
        >
          <p class="text-xs text-muted uppercase tracking-wide">
            {{ s.label }}
          </p>
          <p class="text-2xl font-semibold mt-1">
            {{ data.summary[s.key] }}
          </p>
        </UCard>
        <UCard class="col-span-2 sm:col-span-4 lg:col-span-1">
          <p class="text-xs text-muted uppercase tracking-wide">
            Headcount
          </p>
          <p class="text-2xl font-semibold mt-1">
            {{ data.summary.headcount }}
          </p>
          <p class="text-xs text-muted mt-0.5">
            incl. +1s
          </p>
        </UCard>
      </div>

      <!-- Empty state -->
      <div
        v-if="!data.rsvps.length"
        class="py-16"
      >
        <UPageHero
          title="No RSVPs yet"
          description="Once guests respond via their invite link, they'll show up here."
        />
      </div>

      <!-- List -->
      <UCard
        v-else
        class="overflow-hidden"
      >
        <ul class="divide-y divide-default">
          <li
            v-for="r in data.rsvps"
            :key="r.id"
            class="py-3 flex items-start gap-3"
          >
            <UBadge
              :color="STATUS_COLORS[r.status]"
              variant="subtle"
              size="sm"
              class="shrink-0 mt-0.5"
            >
              {{ STATUS_LABELS[r.status] }}
            </UBadge>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="font-medium truncate">
                  {{ displayName(r) }}
                </p>
                <UBadge
                  v-if="r.plusOne"
                  size="sm"
                  variant="outline"
                  color="neutral"
                  icon="i-lucide-user-plus"
                >
                  +1{{ r.plusOneName ? ` · ${r.plusOneName}` : '' }}
                </UBadge>
                <UBadge
                  v-if="!r.userId"
                  size="sm"
                  variant="outline"
                  color="neutral"
                >
                  Guest
                </UBadge>
                <UBadge
                  v-if="r.inviteLabel"
                  size="sm"
                  variant="outline"
                  color="neutral"
                >
                  {{ r.inviteLabel }}
                </UBadge>
              </div>
              <p
                v-if="displayEmail(r)"
                class="text-xs text-muted truncate"
              >
                {{ displayEmail(r) }}
              </p>
              <div
                v-if="r.dietary || r.accessibility || r.notes"
                class="mt-1.5 text-xs text-muted space-y-0.5"
              >
                <p v-if="r.dietary">
                  <span class="font-medium text-default">Dietary:</span> {{ r.dietary }}
                </p>
                <p v-if="r.accessibility">
                  <span class="font-medium text-default">Accessibility:</span> {{ r.accessibility }}
                </p>
                <p v-if="r.notes">
                  <span class="font-medium text-default">Note:</span> {{ r.notes }}
                </p>
              </div>
            </div>

            <div class="shrink-0 flex items-center gap-1">
              <UButton
                icon="i-lucide-pencil"
                size="xs"
                variant="ghost"
                @click="openEdit(r)"
              />
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                variant="ghost"
                color="error"
                @click="removeRsvp(r)"
              />
            </div>
          </li>
        </ul>
      </UCard>
    </template>

    <!-- Edit modal -->
    <UModal
      v-model:open="editOpen"
      title="Edit RSVP"
    >
      <template #body>
        <UForm
          :schema="editSchema"
          :state="editState"
          class="space-y-4 p-1"
          @submit="saveEdit"
        >
          <UFormField
            label="Status"
            name="status"
          >
            <USelect
              v-model="editState.status"
              :items="[
                { label: 'Going', value: 'yes' },
                { label: 'Maybe', value: 'maybe' },
                { label: 'No', value: 'no' },
                { label: 'Cheering', value: 'cheering' }
              ]"
              class="w-full"
            />
          </UFormField>

          <template v-if="editing && !editing.userId">
            <div class="grid grid-cols-2 gap-4">
              <UFormField
                label="Guest name"
                name="guestName"
              >
                <UInput
                  v-model="editState.guestName"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Guest email"
                name="guestEmail"
              >
                <UInput
                  v-model="editState.guestEmail"
                  type="email"
                  class="w-full"
                />
              </UFormField>
            </div>
          </template>

          <UFormField
            label="Plus-one"
            name="plusOne"
          >
            <UCheckbox
              v-model="editState.plusOne"
              label="Bringing a +1"
            />
          </UFormField>

          <UFormField
            v-if="editState.plusOne"
            label="Plus-one name"
            name="plusOneName"
          >
            <UInput
              v-model="editState.plusOneName"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Dietary"
            name="dietary"
          >
            <UInput
              v-model="editState.dietary"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Accessibility"
            name="accessibility"
          >
            <UInput
              v-model="editState.accessibility"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Notes"
            name="notes"
          >
            <UTextarea
              v-model="editState.notes"
              :rows="3"
              class="w-full"
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
              label="Save"
              :loading="editLoading"
            />
          </div>
        </UForm>
      </template>
    </UModal>
  </UContainer>
</template>
