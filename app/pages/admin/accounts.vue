<script setup lang="ts">
/**
 * The accounts on this instance. An account is not how somebody gets INTO an
 * event — that is the invite link — so this page is short on purpose: who can
 * sign in, who owns the instance, and the two operator verbs that matter when
 * a laptop goes missing or a friend asks to be forgotten.
 *
 * Deleting an account keeps their RSVPs and messages: guest identity is the
 * email, and their history is the event's, not the account's.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Accounts' })

const { data, pending, refresh } = await useFetch('/api/admin/accounts')
const toast = useToast()
const busy = ref<string | null>(null)
const confirming = ref<string | null>(null)

async function signOutEverywhere(id: string) {
  busy.value = id
  try {
    const { revoked } = await $fetch<{ revoked: number }>(`/api/admin/accounts/${id}/sessions`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: `${revoked} session${revoked === 1 ? '' : 's'} ended`, color: 'success' })
  } finally {
    busy.value = null
  }
}

async function remove(id: string) {
  busy.value = id
  try {
    const result = await $fetch<{ email: string, plannerRowsRemoved: number }>(`/api/admin/accounts/${id}`, { method: 'DELETE' })
    confirming.value = null
    await refresh()
    toast.add({
      title: `${result.email} can no longer sign in`,
      description: `${result.plannerRowsRemoved} planning role${result.plannerRowsRemoved === 1 ? '' : 's'} removed. Their answers stay.`,
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not delete that account', color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-info"
      title="The first account owns this instance"
      description="It was claimed at /setup, it is the planner the Enterprise service token acts as, and it is the only account that can see this page. It cannot be deleted from here."
    />

    <UCard>
      <template #header>
        <p class="font-semibold">
          {{ data?.accounts.length ?? 0 }} account<span v-if="data?.accounts.length !== 1">s</span>
        </p>
      </template>

      <div class="flex flex-col">
        <div
          v-for="acct in data?.accounts ?? []"
          :key="acct.id"
          class="flex items-center justify-between gap-3 flex-wrap py-2 border-b border-default last:border-b-0"
        >
          <div class="min-w-0">
            <p class="font-medium">
              {{ acct.name }}
              <UBadge
                v-if="acct.isOwner"
                variant="subtle"
                color="primary"
                size="sm"
              >
                instance owner
              </UBadge>
            </p>
            <p class="text-sm text-muted">
              {{ acct.email }} · joined {{ formatWhen(acct.createdAt, { time: false }) }} ·
              plans {{ acct.plannerOf }} event<span v-if="acct.plannerOf !== 1">s</span> ·
              {{ acct.activeSessions }} live session<span v-if="acct.activeSessions !== 1">s</span>
            </p>
          </div>
          <div class="flex gap-1 shrink-0">
            <UButton
              size="xs"
              variant="outline"
              :loading="busy === acct.id"
              :disabled="!acct.activeSessions"
              @click="signOutEverywhere(acct.id)"
            >
              Sign out everywhere
            </UButton>
            <template v-if="!acct.isOwner">
              <UButton
                v-if="confirming !== acct.id"
                size="xs"
                variant="ghost"
                color="error"
                @click="confirming = acct.id"
              >
                Delete
              </UButton>
              <template v-else>
                <UButton
                  size="xs"
                  color="error"
                  :loading="busy === acct.id"
                  @click="remove(acct.id)"
                >
                  Really delete
                </UButton>
                <UButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  @click="confirming = null"
                >
                  Cancel
                </UButton>
              </template>
            </template>
          </div>
        </div>
      </div>
      <p
        v-if="pending && !data"
        class="text-muted"
      >
        Loading…
      </p>
    </UCard>
  </div>
</template>
