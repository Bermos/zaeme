<script setup lang="ts">
/**
 * The instance's own settings (#25, D6). One question today: what currency does
 * this group settle up in?
 *
 * The page's real job is the warning, not the input. Every expense converts
 * into this currency once and freezes there, so the moment the first expense is
 * recorded the answer stops being changeable — and zäme has no admin-side way
 * to remove an expense, which makes "frozen" mean frozen. A lock that announces
 * itself only once engaged is the worst of both, so the warning is loudest
 * while the setting is still free, and once it is not the page names the exact
 * trips holding it rather than handing over a count.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Settings' })

interface Settings { baseCurrency: string, configured: boolean, updatedAt: string | null }
interface Hold {
  bases: Array<{ baseCurrency: string, expenses: number }>
  events: Array<{ slug: string, title: string, baseCurrency: string, expenses: number }>
  total: number
}

const { data, pending, refresh } = await useFetch<{
  settings: Settings
  expensesRecorded: number
  hold: Hold
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
/** Expenses already recorded are what freezes the answer. */
const locked = computed(() => !!data.value && data.value.expensesRecorded > 0)

async function save() {
  if (!valid.value || !changed.value) return
  if (!confirm(`Settle this instance up in ${code.value}?\n\nEvery expense recorded from now on converts into ${code.value} and freezes there. Once the first one exists, this can no longer be changed from here.`)) return
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

    <template v-else-if="data">
      <!-- The whole point of the page, and it is deliberately FIRST and loud
           while the setting is still free to change. -->
      <UAlert
        v-if="!locked"
        color="warning"
        variant="subtle"
        icon="i-lucide-alert-triangle"
        title="Set this before anyone records an expense"
        description="Every expense converts into the base currency once, at the rate on the day it was recorded, and keeps that conversion forever. From the first expense onwards this setting is frozen: zäme will not re-denominate money people may already have settled, and there is no admin screen that deletes an expense — undoing it would mean opening each trip as one of its planners and removing them by hand. Right now it costs nothing to change. Later it costs that."
      />

      <UCard>
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
              : 'Still on the default — nobody has chosen this yet.'"
          >
            <UInput
              v-model="draft"
              maxlength="3"
              placeholder="CHF"
              class="w-28 uppercase"
              :disabled="locked"
            />
          </UFormField>

          <UAlert
            v-if="locked"
            color="neutral"
            variant="subtle"
            icon="i-lucide-lock"
            :title="`Frozen at ${data.settings.baseCurrency}`"
            :description="`${data.expensesRecorded} expense${data.expensesRecorded === 1 ? '' : 's'} have already been converted into it. Changing the base now would re-label balances that were converted at the old one, so it is refused. To change it anyway, every expense below has to go first — each from its own trip, as one of that trip's planners.`"
          />

          <div
            v-if="locked && data.hold.events.length"
            class="flex flex-col gap-1 text-sm"
          >
            <p class="font-medium">
              Where the expenses are
            </p>
            <div
              v-for="ev in data.hold.events"
              :key="`${ev.slug}-${ev.baseCurrency}`"
              class="flex items-center justify-between gap-2 py-1 border-b border-default last:border-b-0"
            >
              <ULink
                :to="`/host/${ev.slug}`"
                class="truncate"
              >
                {{ ev.title }}
              </ULink>
              <span class="text-muted tabular-nums whitespace-nowrap">
                {{ ev.expenses }} × {{ ev.baseCurrency }}
              </span>
            </div>
          </div>

          <div>
            <UButton
              :loading="saving"
              :disabled="!valid || !changed || locked"
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
