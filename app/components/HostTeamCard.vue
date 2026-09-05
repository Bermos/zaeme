<script setup lang="ts">
/**
 * The organizer team (host side): who plans this event with you, plus minting
 * co-organizer links — a friend opens the link, signs in, and gets planning
 * access (the organizer view on zäme itself).
 */
interface Team {
  planners: Array<{ userId: string, role: string }>
  pending: Array<{ id: string, token: string, email: string | null, role: string, revokedAt: string | null }>
  me: string
}

const props = defineProps<{ slug: string }>()

const { data: team, refresh } = await useFetch<Team>(`/api/host/events/${props.slug}/team`)
const toast = useToast()

const inviteEmail = ref('')
const minting = ref(false)
async function mintInvite() {
  minting.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/team/invites`, {
      method: 'POST',
      body: { email: inviteEmail.value || null }
    })
    inviteEmail.value = ''
    await refresh()
  } finally {
    minting.value = false
  }
}

function joinUrl(token: string): string {
  return `${window.location.origin}/host/join/${token}`
}
async function copyJoin(token: string) {
  await navigator.clipboard.writeText(joinUrl(token))
  toast.add({ title: 'Link copied — send it to your co-organizer', color: 'success' })
}
async function revoke(id: string) {
  await $fetch(`/api/host/events/${props.slug}/team/invites/${id}/revoke`, { method: 'POST' })
  await refresh()
}
async function removePlanner(userId: string) {
  try {
    await $fetch(`/api/host/events/${props.slug}/team/${userId}`, { method: 'DELETE' })
    await refresh()
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not remove them', color: 'error' })
  }
}

const iAmOwner = computed(() => team.value?.planners.some(p => p.userId === team.value?.me && p.role === 'owner'))

const ROLE_LABEL: Record<string, string> = { owner: 'host', co_planner: 'co-organizer', logistics: 'logistics' }
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          🤝 Organizer team
        </p>
        <p class="text-sm text-muted">
          Plan this together — mint a link, a friend accepts, done.
        </p>
      </div>
    </template>

    <div
      v-if="team"
      class="flex flex-col gap-3"
    >
      <div class="flex flex-col gap-1">
        <div
          v-for="p in team.planners"
          :key="p.userId"
          class="flex items-center justify-between gap-2 py-1 text-sm"
        >
          <p>
            {{ p.userId === team.me ? 'You' : `Planner ${p.userId.slice(0, 6)}…` }}
            <UBadge
              variant="subtle"
              size="sm"
              :color="p.role === 'owner' ? 'primary' : 'neutral'"
            >
              {{ ROLE_LABEL[p.role] ?? p.role }}
            </UBadge>
          </p>
          <UButton
            v-if="iAmOwner && p.role !== 'owner' && p.userId !== team.me"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="removePlanner(p.userId)"
          >
            ✕
          </UButton>
        </div>
      </div>

      <div
        v-if="team.pending.filter(i => !i.revokedAt).length"
        class="flex flex-col gap-1 pt-1 border-t border-default"
      >
        <p class="text-sm font-medium">
          Outstanding links
        </p>
        <div
          v-for="inv in team.pending.filter(i => !i.revokedAt)"
          :key="inv.id"
          class="flex items-center justify-between gap-2 py-1 text-sm"
        >
          <p class="text-muted truncate">
            {{ inv.email || 'Anyone with the link' }}
          </p>
          <div class="flex gap-1 shrink-0">
            <UButton
              size="xs"
              variant="outline"
              @click="copyJoin(inv.token)"
            >
              Copy link
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="revoke(inv.id)"
            >
              Revoke
            </UButton>
          </div>
        </div>
      </div>

      <form
        class="flex gap-2 pt-1"
        @submit.prevent="mintInvite"
      >
        <UInput
          v-model="inviteEmail"
          type="email"
          placeholder="Lock to an email (optional)"
          class="flex-1"
        />
        <UButton
          type="submit"
          :loading="minting"
          variant="outline"
          size="sm"
        >
          New co-organizer link
        </UButton>
      </form>
    </div>
  </UCard>
</template>
