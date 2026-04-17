<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const slug = route.params.slug as string

type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

interface Attendee {
  id: string
  userId: string | null
  name: string
  email: string
  rsvpStatus: RsvpStatus
  plusOne: number
  dietary: string | null
  accessibility: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

const { data: attendees, refresh, status } = await useFetch<Attendee[]>(
  `/api/events/${slug}/attendees`
)

// Also fetch the event so we can respect concert vs. non-concert rules when
// editing an attendee's status.
interface EventInfo { type: 'hosted' | 'concert' | 'series' }
const { data: eventInfo } = await useFetch<EventInfo>(`/api/events/${slug}`)
const isConcert = computed(() => eventInfo.value?.type === 'concert')

const statusOptions = computed(() => {
  if (isConcert.value) {
    return [{ label: 'Cheering', value: 'cheering' as const }]
  }
  return [
    { label: 'Yes', value: 'yes' as const },
    { label: 'Maybe', value: 'maybe' as const },
    { label: 'No', value: 'no' as const }
  ]
})

useSeoMeta({ title: `zäme — ${slug} attendees` })

const STATUS_COLORS: Record<RsvpStatus, 'success' | 'warning' | 'error' | 'primary'> = {
  yes: 'success',
  maybe: 'warning',
  no: 'error',
  cheering: 'primary'
}

const STATUS_LABELS: Record<RsvpStatus, string> = {
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  cheering: 'Cheering'
}

const counts = computed(() => {
  const list = attendees.value ?? []
  const by = (s: RsvpStatus) => list.filter(a => a.rsvpStatus === s).length
  const yes = by('yes')
  const plusOnes = list.filter(a => a.rsvpStatus === 'yes')
    .reduce((sum, a) => sum + a.plusOne, 0)
  return {
    total: list.length,
    yes,
    maybe: by('maybe'),
    no: by('no'),
    cheering: by('cheering'),
    headcount: yes + plusOnes
  }
})

const toast = useToast()

const editing = ref<Attendee | null>(null)
const editOpen = ref(false)

const editSchema = z.object({
  name: z.string().min(1).max(200),
  rsvpStatus: z.enum(['yes', 'maybe', 'no', 'cheering']),
  plusOne: z.boolean(),
  dietary: z.string().optional(),
  accessibility: z.string().optional(),
  note: z.string().optional()
})
type EditSchema = z.output<typeof editSchema>
const editState = reactive<Partial<EditSchema>>({})
const editLoading = ref(false)

function openEdit(a: Attendee) {
  editing.value = a
  editState.name = a.name
  editState.rsvpStatus = a.rsvpStatus
  editState.plusOne = a.plusOne > 0
  editState.dietary = a.dietary ?? ''
  editState.accessibility = a.accessibility ?? ''
  editState.note = a.note ?? ''
  editOpen.value = true
}

async function saveEdit() {
  if (!editing.value) return
  editLoading.value = true
  try {
    await $fetch(`/api/events/${slug}/attendees/${editing.value.id}`, {
      method: 'PATCH',
      body: {
        name: editState.name,
        rsvpStatus: editState.rsvpStatus,
        plusOne: editState.plusOne ? 1 : 0,
        dietary: editState.dietary || null,
        accessibility: editState.accessibility || null,
        note: editState.note || null
      }
    })
    await refresh()
    editOpen.value = false
    toast.add({ title: 'Attendee updated', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to save', color: 'error' })
  } finally {
    editLoading.value = false
  }
}

async function removeAttendee(a: Attendee) {
  if (!confirm(`Remove ${a.name} from this event?`)) return
  try {
    await $fetch(`/api/events/${slug}/attendees/${a.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Attendee removed', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to remove', color: 'error' })
  }
}
</script>

<template>
  <UContainer class="py-8 max-w-5xl">
    <div class="flex items-center gap-3 mb-6">
      <UButton
        :to="`/events/${slug}`"
        icon="i-lucide-arrow-left"
        variant="ghost"
        size="sm"
      />
      <h1 class="text-2xl font-bold">
        RSVPs
      </h1>
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

    <template v-else>
      <!-- Summary -->
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <UCard class="text-center">
          <p class="text-xs text-muted">
            Total
          </p>
          <p class="text-2xl font-bold">
            {{ counts.total }}
          </p>
        </UCard>
        <UCard class="text-center">
          <p class="text-xs text-muted">
            Yes
          </p>
          <p class="text-2xl font-bold text-success">
            {{ counts.yes }}
          </p>
        </UCard>
        <UCard class="text-center">
          <p class="text-xs text-muted">
            Maybe
          </p>
          <p class="text-2xl font-bold text-warning">
            {{ counts.maybe }}
          </p>
        </UCard>
        <UCard class="text-center">
          <p class="text-xs text-muted">
            No
          </p>
          <p class="text-2xl font-bold text-error">
            {{ counts.no }}
          </p>
        </UCard>
        <UCard class="text-center">
          <p class="text-xs text-muted">
            Headcount (incl. +1)
          </p>
          <p class="text-2xl font-bold">
            {{ counts.headcount }}
          </p>
        </UCard>
      </div>

      <UCard v-if="!attendees?.length">
        <div class="py-12 text-center text-muted">
          No RSVPs yet. Share the invite link to get started.
        </div>
      </UCard>

      <UCard v-else>
        <ul class="divide-y divide-default">
          <li
            v-for="a in attendees"
            :key="a.id"
            class="py-3 flex items-start justify-between gap-3"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-medium truncate">{{ a.name }}</span>
                <UBadge
                  :color="STATUS_COLORS[a.rsvpStatus]"
                  variant="subtle"
                  size="sm"
                >
                  {{ STATUS_LABELS[a.rsvpStatus] }}
                </UBadge>
                <UBadge
                  v-if="a.plusOne > 0"
                  variant="outline"
                  color="neutral"
                  size="sm"
                >
                  +1
                </UBadge>
                <UBadge
                  v-if="!a.userId"
                  variant="outline"
                  color="neutral"
                  size="sm"
                  icon="i-lucide-user"
                >
                  Guest
                </UBadge>
              </div>
              <p class="text-xs text-muted truncate mt-0.5">
                {{ a.email }}
              </p>
              <div
                v-if="a.dietary || a.accessibility || a.note"
                class="mt-1 text-xs space-y-0.5"
              >
                <p v-if="a.dietary">
                  <span class="text-muted">Dietary:</span> {{ a.dietary }}
                </p>
                <p v-if="a.accessibility">
                  <span class="text-muted">Accessibility:</span> {{ a.accessibility }}
                </p>
                <p v-if="a.note">
                  <span class="text-muted">Note:</span> {{ a.note }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                size="xs"
                @click="openEdit(a)"
              />
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                size="xs"
                color="error"
                @click="removeAttendee(a)"
              />
            </div>
          </li>
        </ul>
      </UCard>
    </template>

    <UModal
      v-model:open="editOpen"
      :title="editing ? `Edit ${editing.name}` : 'Edit RSVP'"
    >
      <template #body>
        <UForm
          :schema="editSchema"
          :state="editState"
          class="space-y-4 p-1"
          @submit="saveEdit"
        >
          <UFormField
            label="Name"
            name="name"
            required
          >
            <UInput
              v-model="editState.name"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Response"
            name="rsvpStatus"
            required
          >
            <USelect
              v-model="editState.rsvpStatus"
              :options="statusOptions"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Plus-one"
            name="plusOne"
          >
            <UCheckbox
              v-model="editState.plusOne"
              label="Has a +1"
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
            label="Note"
            name="note"
          >
            <UTextarea
              v-model="editState.note"
              :rows="2"
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
