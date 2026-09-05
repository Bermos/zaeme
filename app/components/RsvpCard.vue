<script setup lang="ts">
/** The RSVP form: are you in, plus-one, dietary/accessibility notes. */
interface ExistingRsvp {
  status: 'yes' | 'maybe' | 'no' | 'cheering'
  plusOne: boolean
  plusOneName: string | null
  dietary: string | null
  accessibility: string | null
  notes: string | null
}

const props = defineProps<{
  token: string
  eventType: string
  existingRsvp: ExistingRsvp | null
}>()
const emit = defineEmits<{ updated: [] }>()

const { identity, complete } = useGuestIdentity()

const STATUSES = computed(() => [
  { value: 'yes', label: 'I\'m in', color: 'success' as const },
  { value: 'maybe', label: 'Maybe', color: 'warning' as const },
  ...(props.eventType === 'concert' ? [{ value: 'cheering', label: 'Cheering from afar', color: 'info' as const }] : []),
  { value: 'no', label: 'Can\'t make it', color: 'error' as const }
])

const status = ref<string | null>(props.existingRsvp?.status ?? null)
const plusOne = ref(props.existingRsvp?.plusOne ?? false)
const plusOneName = ref(props.existingRsvp?.plusOneName ?? '')
const dietary = ref(props.existingRsvp?.dietary ?? '')
const notes = ref(props.existingRsvp?.notes ?? '')

const saving = ref(false)
const saved = ref(false)
const toast = useToast()

async function submit() {
  if (!complete.value || !status.value) return
  saving.value = true
  try {
    await $fetch(`/api/invites/${props.token}/rsvp`, {
      method: 'POST',
      body: {
        status: status.value,
        plusOne: plusOne.value,
        plusOneName: plusOne.value ? (plusOneName.value || null) : null,
        dietary: dietary.value || null,
        notes: notes.value || null,
        guestName: identity.value.name,
        guestEmail: identity.value.email
      }
    })
    saved.value = true
    toast.add({ title: 'RSVP saved — see you there!', color: 'success' })
    emit('updated')
  } catch {
    toast.add({ title: 'Could not save your RSVP', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <p class="font-semibold">
        Are you coming?
      </p>
    </template>

    <div class="flex flex-col gap-4">
      <div class="flex gap-2 flex-wrap">
        <UButton
          v-for="s in STATUSES"
          :key="s.value"
          :label="s.label"
          :color="status === s.value ? s.color : 'neutral'"
          :variant="status === s.value ? 'solid' : 'outline'"
          @click="status = s.value"
        />
      </div>

      <template v-if="status === 'yes' || status === 'cheering'">
        <USwitch
          v-model="plusOne"
          label="I'm bringing a +1"
        />
        <UInput
          v-if="plusOne"
          v-model="plusOneName"
          placeholder="Their name (optional)"
        />
        <UInput
          v-model="dietary"
          placeholder="Dietary needs? (optional)"
        />
      </template>
      <UTextarea
        v-if="status"
        v-model="notes"
        placeholder="A note for the host (optional)"
        :rows="2"
      />

      <div class="flex justify-end">
        <UButton
          :loading="saving"
          :disabled="!complete || !status"
          @click="submit"
        >
          {{ existingRsvp || saved ? 'Update my RSVP' : 'Send my RSVP' }}
        </UButton>
      </div>
    </div>
  </UCard>
</template>
