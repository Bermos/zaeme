<script setup lang="ts">
/**
 * The instance's own settings (#25 D6, narrowed by #59). One question today:
 * what currency does a NEW trip start in?
 *
 * The page used to be mostly a warning, and then mostly a lock: every balance
 * on the instance hung off this one value, so the first recorded expense froze
 * it — permanently, since zäme has no admin-side way to remove an expense. That
 * whole apparatus is gone. Currency belongs to the event now, so this setting
 * labels nothing that already exists, changing it moves no money, and a trip
 * that wants to settle in something else says so on its own page, where the
 * confirmation and the recompute live.
 *
 * What is left is a default and a sentence saying it is only a default, which
 * is the honest size of the thing.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Settings' })

interface Settings { baseCurrency: string, configured: boolean, updatedAt: string | null }

const { data, pending, refresh } = await useFetch<{
  settings: Settings
  expensesRecorded: number
}>('/api/admin/settings')

const draft = ref('')
const saving = ref(false)
const toast = useToast()

watch(data, (d) => {
  if (d) draft.value = d.settings.baseCurrency
}, { immediate: true })

const code = computed(() => draft.value.trim().toUpperCase())
const valid = computed(() => /^[A-Z]{3}$/.test(code.value))
const changed = computed(() => !!data.value && code.value !== data.value.settings.baseCurrency)

async function save() {
  if (!valid.value || !changed.value) return
  saving.value = true
  try {
    await $fetch('/api/admin/settings', { method: 'PATCH', body: { baseCurrency: code.value } })
    await refresh()
    toast.add({ title: `New trips will start in ${code.value}`, color: 'success' })
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

    <template v-else-if="data">
      <UCard>
        <template #header>
          <div>
            <p class="font-semibold">
              Default currency for new trips
            </p>
            <p class="text-sm text-muted">
              What a trip starts out settling in. Each trip carries its own from then on,
              and can be changed on its own page.
            </p>
          </div>
        </template>

        <div class="flex flex-col gap-3">
          <UFormField
            label="Three-letter code"
            :help="data.settings.configured
              ? 'Set by you.'
              : 'Still on the default — nobody has chosen this yet.'"
          >
            <UInput
              v-model="draft"
              maxlength="3"
              placeholder="CHF"
              class="w-28 uppercase"
            />
          </UFormField>

          <!-- Not a lock and not a warning: the one thing somebody changing
               this needs to know is that it does not reach backwards. -->
          <p class="text-sm text-muted">
            Changing this moves no money. Trips already under way keep the currency they
            were created with — including the
            {{ data.expensesRecorded }} expense{{ data.expensesRecorded === 1 ? '' : 's' }}
            recorded on this instance so far. To move one, open that trip and change its
            currency there: every amount on it is recomputed at today's rate, and the
            trip says so before it does it.
          </p>

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
    </template>
  </div>
</template>
