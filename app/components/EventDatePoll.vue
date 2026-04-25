<script setup lang="ts">
import { z } from 'zod'

interface Props {
  slug: string
  /** Owner / co_planner can mutate; logistics can view only. */
  canEdit?: boolean
  /** Current event status — limits what we render. */
  eventStatus: 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
}

const props = withDefaults(defineProps<Props>(), { canEdit: false })
const emit = defineEmits<{
  /** Fire after decide so the parent can refresh derived event data (startsAt etc). */
  decided: []
  /** Fire when the underlying event status was changed by the API (e.g. draft → polling on poll create). */
  statusChanged: []
}>()

interface SlotResult {
  id: string
  startsAt: string
  endsAt: string | null
  sortOrder: number
  yes: number
  ifNeedBe: number
  no: number
  score: number
}

interface PollDto {
  id: string
  eventId: string
  question: string | null
  deadline: string | null
  decidedSlotId: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
  slots: SlotResult[]
  respondents: { id: string, name: string | null, email: string | null }[]
}

const toast = useToast()

const { data, refresh, status } = await useFetch<{ poll: PollDto | null }>(
  `/api/events/${props.slug}/poll`,
  { default: () => ({ poll: null }) }
)

const poll = computed(() => data.value?.poll ?? null)
const isClosed = computed(() => !!poll.value?.closedAt)

function formatDateTime(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' })
}

function rangeLabel(slot: { startsAt: string, endsAt: string | null }): string {
  if (!slot.endsAt) return formatDateTime(slot.startsAt)
  const start = new Date(slot.startsAt)
  const end = new Date(slot.endsAt)
  const sameDay = start.toDateString() === end.toDateString()
  if (sameDay) {
    return `${formatDateTime(slot.startsAt)} – ${end.toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${formatDateTime(slot.startsAt)} → ${formatDateTime(slot.endsAt)}`
}

const sortedSlots = computed(() => {
  if (!poll.value) return []
  // Display order from server is by sortOrder asc; here we show sorted by score desc.
  return [...poll.value.slots].sort((a, b) => b.score - a.score)
})

const totalRespondents = computed(() => poll.value?.respondents.length ?? 0)

// ---- Create / edit form ----
const editorOpen = ref(false)
const editorLoading = ref(false)
const editorError = ref<string | null>(null)

interface SlotInput { id?: string, startsAt: string, endsAt?: string }

const formSchema = z.object({
  question: z.string().max(500).optional(),
  deadline: z.string().optional(),
  slots: z.array(z.object({
    id: z.string().optional(),
    startsAt: z.string().min(1, 'Start required'),
    endsAt: z.string().optional()
  })).min(1, 'Add at least one option')
})

const form = reactive<{ question: string, deadline: string, slots: SlotInput[] }>({
  question: '',
  deadline: '',
  slots: [{ startsAt: '' }]
})

function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  // datetime-local needs `YYYY-MM-DDTHH:mm`. Use the local timezone.
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openCreate() {
  editorError.value = null
  form.question = ''
  form.deadline = ''
  form.slots = [{ startsAt: '' }]
  editorOpen.value = true
}

function openEdit() {
  if (!poll.value) return openCreate()
  editorError.value = null
  form.question = poll.value.question ?? ''
  form.deadline = toLocalInput(poll.value.deadline)
  form.slots = poll.value.slots
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(s => ({ id: s.id, startsAt: toLocalInput(s.startsAt), endsAt: toLocalInput(s.endsAt) }))
  if (form.slots.length === 0) form.slots.push({ startsAt: '' })
  editorOpen.value = true
}

function addSlot() {
  // Default the new slot to the same date/time as the last entry as a
  // small convenience for typical "same day, different times" patterns.
  const last = form.slots[form.slots.length - 1]
  form.slots.push({ startsAt: last?.startsAt ?? '' })
}

function removeSlot(idx: number) {
  if (form.slots.length === 1) return
  form.slots.splice(idx, 1)
}

async function submitEditor() {
  editorError.value = null

  // Local validation up front for nicer error messages than the API can give.
  for (const s of form.slots) {
    if (!s.startsAt) {
      editorError.value = 'Each option needs a start time.'
      return
    }
  }

  editorLoading.value = true
  try {
    const body = {
      question: form.question || null,
      deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
      slots: form.slots.map(s => ({
        id: s.id,
        startsAt: new Date(s.startsAt).toISOString(),
        endsAt: s.endsAt ? new Date(s.endsAt).toISOString() : null
      }))
    }
    const method = poll.value ? 'PATCH' : 'POST'
    await $fetch(`/api/events/${props.slug}/poll`, { method, body })
    await refresh()
    editorOpen.value = false
    toast.add({ title: poll.value ? 'Poll updated' : 'Poll created', color: 'success' })
    if (!poll.value && props.eventStatus === 'draft') {
      // Server auto-transitions draft → polling.
      emit('statusChanged')
    }
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    editorError.value = e?.data?.message ?? 'Failed to save'
  } finally {
    editorLoading.value = false
  }
}

// ---- Delete ----
async function deletePoll() {
  if (!poll.value) return
  if (!confirm('Delete this poll? All votes will be lost.')) return
  try {
    await $fetch(`/api/events/${props.slug}/poll`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Poll deleted', color: 'success' })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to delete', color: 'error' })
  }
}

// ---- Decide ----
const decideLoading = ref(false)

async function decide(slotId: string, slotLabel: string) {
  if (!confirm(`Pick "${slotLabel}" as the date and publish the event?`)) return
  decideLoading.value = true
  try {
    await $fetch(`/api/events/${props.slug}/poll/decide`, {
      method: 'POST',
      body: { slotId, publish: true }
    })
    await refresh()
    emit('decided')
    toast.add({
      title: 'Date set',
      description: 'Event has been published. Invite emails are on their way.',
      color: 'success'
    })
  } catch (err: unknown) {
    const e = err as { data?: { message?: string } }
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to decide', color: 'error' })
  } finally {
    decideLoading.value = false
  }
}

const deadlinePassed = computed(() => {
  if (!poll.value?.deadline) return false
  return new Date(poll.value.deadline).getTime() < Date.now()
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <UIcon
            name="i-lucide-calendar-check-2"
            class="size-4 text-muted"
          />
          <h2 class="font-semibold">
            Date poll
          </h2>
          <UBadge
            v-if="poll && isClosed && poll.decidedSlotId"
            color="success"
            variant="subtle"
            size="sm"
          >
            Decided
          </UBadge>
          <UBadge
            v-else-if="poll && isClosed"
            color="neutral"
            variant="subtle"
            size="sm"
          >
            Closed
          </UBadge>
          <UBadge
            v-else-if="poll"
            color="warning"
            variant="subtle"
            size="sm"
          >
            Open
          </UBadge>
        </div>
        <div
          v-if="canEdit"
          class="flex items-center gap-1"
        >
          <UButton
            v-if="!poll"
            size="sm"
            icon="i-lucide-plus"
            label="Create poll"
            variant="ghost"
            @click="openCreate"
          />
          <template v-else-if="!isClosed">
            <UButton
              size="sm"
              icon="i-lucide-pencil"
              variant="ghost"
              @click="openEdit"
            />
            <UButton
              size="sm"
              icon="i-lucide-trash-2"
              variant="ghost"
              color="error"
              @click="deletePoll"
            />
          </template>
        </div>
      </div>
    </template>

    <!-- Empty / loading -->
    <div
      v-if="status === 'pending'"
      class="text-sm text-muted py-2"
    >
      Loading…
    </div>
    <div
      v-else-if="!poll"
      class="text-sm text-muted py-2"
    >
      <template v-if="canEdit">
        No poll yet. Create one to gather availability from your guests before publishing the event.
      </template>
      <template v-else>
        No poll has been created.
      </template>
    </div>

    <template v-else>
      <p
        v-if="poll.question"
        class="text-sm font-medium mb-3"
      >
        {{ poll.question }}
      </p>
      <p
        v-if="poll.deadline"
        class="text-xs text-muted mb-4 flex items-center gap-1.5"
      >
        <UIcon
          name="i-lucide-clock"
          class="size-3.5"
        />
        {{ deadlinePassed ? 'Deadline passed' : 'Closes' }} {{ formatDateTime(poll.deadline) }}
      </p>

      <p class="text-xs text-muted mb-3">
        {{ totalRespondents }} respondent{{ totalRespondents === 1 ? '' : 's' }}
      </p>

      <ul class="divide-y divide-default">
        <li
          v-for="slot in sortedSlots"
          :key="slot.id"
          class="py-3 flex items-center gap-3"
          :class="poll.decidedSlotId === slot.id ? 'bg-success-50 dark:bg-success-950 -mx-4 px-4 rounded' : ''"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">
              {{ rangeLabel(slot) }}
              <UBadge
                v-if="poll.decidedSlotId === slot.id"
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-check"
                class="ml-2"
              >
                Picked
              </UBadge>
            </p>
            <div class="flex items-center gap-2 mt-1 text-xs">
              <span class="text-success-600 dark:text-success-400 font-medium">{{ slot.yes }} yes</span>
              <span class="text-warning-600 dark:text-warning-400">{{ slot.ifNeedBe }} maybe</span>
              <span class="text-muted">{{ slot.no }} no</span>
              <span class="text-muted ml-auto sm:ml-0">· score {{ slot.score }}</span>
            </div>
          </div>
          <UButton
            v-if="canEdit && !isClosed"
            size="xs"
            label="Pick"
            icon="i-lucide-check"
            :loading="decideLoading"
            @click="decide(slot.id, rangeLabel(slot))"
          />
        </li>
      </ul>
    </template>

    <!-- Editor modal -->
    <UModal
      v-model:open="editorOpen"
      :title="poll ? 'Edit date poll' : 'Create date poll'"
      :description="poll ? 'Adjust the question, deadline or candidate slots.' : 'Add the slots you want guests to vote on.'"
    >
      <template #body>
        <UForm
          :schema="formSchema"
          :state="form"
          class="space-y-4 p-1"
          @submit="submitEditor"
        >
          <UFormField
            label="Question"
            name="question"
            help="Optional prompt shown to voters."
          >
            <UInput
              v-model="form.question"
              class="w-full"
              placeholder="Which weekend works for you?"
            />
          </UFormField>

          <UFormField
            label="Deadline"
            name="deadline"
            help="Poll auto-closes at this time. Leave empty to close manually."
          >
            <UInput
              v-model="form.deadline"
              type="datetime-local"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Candidate slots"
            name="slots"
            required
          >
            <ul class="space-y-2">
              <li
                v-for="(slot, idx) in form.slots"
                :key="idx"
                class="flex items-end gap-2"
              >
                <UFormField
                  :label="idx === 0 ? 'Start' : ''"
                  :name="`slots.${idx}.startsAt`"
                  class="flex-1 min-w-0"
                >
                  <UInput
                    v-model="slot.startsAt"
                    type="datetime-local"
                    class="w-full"
                  />
                </UFormField>
                <UFormField
                  :label="idx === 0 ? 'End (optional)' : ''"
                  :name="`slots.${idx}.endsAt`"
                  class="flex-1 min-w-0"
                >
                  <UInput
                    v-model="slot.endsAt"
                    type="datetime-local"
                    class="w-full"
                  />
                </UFormField>
                <UButton
                  type="button"
                  icon="i-lucide-x"
                  variant="ghost"
                  color="error"
                  size="sm"
                  :disabled="form.slots.length === 1"
                  @click="removeSlot(idx)"
                />
              </li>
            </ul>
            <UButton
              type="button"
              size="sm"
              icon="i-lucide-plus"
              variant="ghost"
              label="Add option"
              class="mt-2"
              @click="addSlot"
            />
          </UFormField>

          <UAlert
            v-if="editorError"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-circle"
            :description="editorError"
          />

          <div class="flex justify-end gap-2 pt-2">
            <UButton
              type="button"
              variant="ghost"
              label="Cancel"
              @click="editorOpen = false"
            />
            <UButton
              type="submit"
              :label="poll ? 'Save changes' : 'Create poll'"
              :loading="editorLoading"
              icon="i-lucide-check"
            />
          </div>
        </UForm>
      </template>
    </UModal>
  </UCard>
</template>
