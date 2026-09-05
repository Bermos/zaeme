<script setup lang="ts">
/**
 * Every capability link on the instance, and the power to close one.
 *
 * A zäme invite URL IS a credential (ADR-0019 §3) — whoever holds it is the
 * guest. So the one question an operator must always be able to answer is
 * "what links exist, and can I kill that one now", without first working out
 * which event it belongs to and whether they plan it.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Invite links' })

const state = ref<'active' | 'revoked' | 'expired' | ''>('active')
const q = ref('')
const { data, pending, refresh } = await useFetch('/api/admin/invites', {
  query: computed(() => ({ state: state.value || undefined, q: q.value || undefined }))
})

const toast = useToast()
const busy = ref<string | null>(null)

async function revoke(id: string) {
  busy.value = id
  try {
    await $fetch(`/api/admin/invites/${id}/revoke`, { method: 'POST' })
    await refresh()
    toast.add({ title: 'Link closed — it answers 410 from now on', color: 'success' })
  } catch {
    toast.add({ title: 'Could not revoke that', color: 'error' })
  } finally {
    busy.value = null
  }
}

async function restore(id: string) {
  busy.value = id
  try {
    await $fetch(`/api/admin/invites/${id}/restore`, { method: 'POST' })
    await refresh()
    toast.add({ title: 'Link is live again', color: 'success' })
  } finally {
    busy.value = null
  }
}

async function copy(token: string) {
  await navigator.clipboard.writeText(`${window.location.origin}/i/${token}`)
  toast.add({ title: 'Link copied', color: 'success' })
}

const STATE_ITEMS = [
  { label: 'Live', value: 'active' },
  { label: 'Revoked', value: 'revoked' },
  { label: 'Expired', value: 'expired' },
  { label: 'All', value: '' }
]
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex gap-2 flex-wrap">
      <UInput
        v-model="q"
        placeholder="Search a label, a name, an email or an event"
        icon="i-lucide-search"
        class="flex-1 min-w-56"
      />
      <USelect
        v-model="state"
        :items="STATE_ITEMS"
        class="w-36"
      />
    </div>

    <UCard>
      <template #header>
        <p class="font-semibold">
          {{ data?.invites.length ?? 0 }} link<span v-if="data?.invites.length !== 1">s</span>
        </p>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-muted text-left">
            <tr class="border-b border-default">
              <th class="py-2 pr-3 font-medium">
                Link
              </th>
              <th class="py-2 px-3 font-medium">
                Event
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Uses
              </th>
              <th class="py-2 px-3 font-medium">
                State
              </th>
              <th class="py-2 pl-3" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="inv in data?.invites ?? []"
              :key="inv.id"
              class="border-b border-default last:border-b-0"
            >
              <td class="py-2 pr-3">
                <p class="font-medium">
                  {{ inv.label || inv.name || 'Shareable link' }}
                  <UBadge
                    v-if="inv.tier === 'core'"
                    variant="subtle"
                    color="info"
                    size="sm"
                  >
                    core
                  </UBadge>
                </p>
                <p class="text-muted">
                  {{ inv.email || 'no email' }} · made {{ formatWhen(inv.createdAt, { time: false }) }}
                </p>
              </td>
              <td class="py-2 px-3">
                <NuxtLink
                  :to="`/host/${inv.eventSlug}`"
                  class="hover:text-primary"
                >
                  {{ inv.eventTitle }}
                </NuxtLink>
              </td>
              <td class="py-2 px-3 text-right tabular-nums">
                {{ inv.usedCount }}<span
                  v-if="inv.maxUses"
                  class="text-muted"
                >/{{ inv.maxUses }}</span>
                <span class="text-muted"> · {{ inv.rsvpCount }} RSVP</span>
              </td>
              <td class="py-2 px-3">
                <UBadge
                  v-if="inv.revokedAt"
                  color="error"
                  variant="subtle"
                >
                  revoked
                </UBadge>
                <UBadge
                  v-else-if="inv.expiresAt && new Date(inv.expiresAt) <= new Date()"
                  color="warning"
                  variant="subtle"
                >
                  expired
                </UBadge>
                <UBadge
                  v-else
                  color="success"
                  variant="subtle"
                >
                  live
                </UBadge>
              </td>
              <td class="py-2 pl-3 text-right whitespace-nowrap">
                <UButton
                  size="xs"
                  variant="ghost"
                  @click="copy(inv.token)"
                >
                  Copy
                </UButton>
                <UButton
                  v-if="!inv.revokedAt"
                  size="xs"
                  color="error"
                  variant="ghost"
                  :loading="busy === inv.id"
                  @click="revoke(inv.id)"
                >
                  Revoke
                </UButton>
                <UButton
                  v-else
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :loading="busy === inv.id"
                  @click="restore(inv.id)"
                >
                  Restore
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="!pending && !data?.invites.length"
          class="text-muted py-3"
        >
          No links in that state.
        </p>
      </div>
    </UCard>
  </div>
</template>
