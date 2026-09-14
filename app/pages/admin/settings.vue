<script setup lang="ts">
/**
 * The instance's own settings (#25, D6). One question today: what currency does
 * this group settle up in?
 *
 * Everything about the budget hangs off this answer. Every expense is converted
 * into it once, at the moment it is recorded, and frozen there; every balance
 * and every "A pays B" is stated in it. Which is also why it can only be
 * changed while no expense is recorded against a different one — the page says
 * so rather than letting the save fail and explaining afterwards.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Settings' })

interface Settings { baseCurrency: string, configured: boolean, updatedAt: string | null }

const { data, pending, refresh } = await useFetch<{ settings: Settings, expensesRecorded: number }>('/api/admin/settings')

const draft = ref('')
const saving = ref(false)
const toast = useToast()

watch(data, (d) => {
  if (d) draft.value = d.settings.baseCurrency
}, { immediate: true })

const code = computed(() => draft.value.trim().toUpperCase())
const valid = computed(() => /^[A-Z]{3}$/.test(code.value))
const changed = computed(() => !!data.value && code.value !== data.value.settings.baseCurrency)
/** Expenses already recorded are what freezes the answer; say how many. */
const locked = computed(() => !!data.value && data.value.expensesRecorded > 0)

async function save() {
  if (!valid.value || !changed.value) return
  saving.value = true
  try {
    await $fetch('/api/admin/settings', { method: 'PATCH', body: { baseCurrency: code.value } })
    await refresh()
    toast.add({ title: `This instance now settles up in ${code.value}`, color: 'success' })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not save that', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p
      v-if="pending && !data"
      class="text-muted"
    >
      Loading…
    </p>

    <UCard v-else-if="data">
      <template #header>
        <div>
          <p class="font-semibold">
            Base currency
          </p>
          <p class="text-sm text-muted">
            What this instance settles up in. Expenses in anything else are converted
            once, at the rate on the day they were recorded, and never re-converted.
          </p>
        </div>
      </template>

      <div class="flex flex-col gap-3">
        <UFormField
          label="Three-letter code"
          :help="data.settings.configured
            ? 'Set by you.'
            : 'Still on the default. Saving records your choice.'"
        >
          <UInput
            v-model="draft"
            maxlength="3"
            placeholder="CHF"
            class="w-28 uppercase"
          />
        </UFormField>

        <UAlert
          v-if="locked"
          color="neutral"
          variant="subtle"
          icon="i-lucide-lock"
          title="Changing this is limited now"
          :description="`${data.expensesRecorded} expense${data.expensesRecorded === 1 ? ' is' : 's are'} already recorded against ${data.settings.baseCurrency}. Changing the base would re-label balances that were converted at the old one, so the save is refused until those expenses are gone.`"
        />

        <div>
          <UButton
            :loading="saving"
            :disabled="!valid || !changed"
            @click="save"
          >
            Save
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
