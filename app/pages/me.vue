<script setup lang="ts">
/**
 * "All my invites in one place" — the cross-event view, account-gated
 * (ADR-0019 §3). The API 401s without a session; we nudge to /login.
 */
definePageMeta({ middleware: 'guest-auth' })

const { data, error } = await useFetch('/api/me/invites')

function when(iso: string | Date | null): string {
  return iso ? new Date(iso).toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date TBD'
}

const STATUS_LABEL: Record<string, string> = {
  yes: 'you\'re in',
  maybe: 'maybe',
  no: 'declined',
  cheering: 'cheering'
}
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <h1 class="text-2xl font-bold">
      My invites
    </h1>

    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      description="Sign in to see your invites across all events."
    >
      <template #actions>
        <UButton
          to="/login?redirect=/me"
          size="xs"
        >
          Sign in
        </UButton>
      </template>
    </UAlert>

    <template v-else-if="data">
      <div
        v-if="data.rsvps.length"
        class="flex flex-col gap-2"
      >
        <h2 class="font-semibold text-muted text-sm uppercase tracking-wide">
          Responded
        </h2>
        <UCard
          v-for="(r, i) in data.rsvps"
          :key="i"
        >
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p class="font-medium">
                {{ r.eventTitle }}
              </p>
              <p class="text-sm text-muted">
                {{ when(r.startsAt) }}<span v-if="r.location"> · {{ r.location }}</span>
              </p>
            </div>
            <div class="flex items-center gap-2">
              <UBadge
                :color="r.status === 'yes' ? 'success' : r.status === 'no' ? 'error' : 'warning'"
                variant="subtle"
              >
                {{ STATUS_LABEL[r.status] ?? r.status }}
              </UBadge>
              <UButton
                v-if="r.inviteToken"
                :to="`/i/${r.inviteToken}`"
                size="xs"
                variant="outline"
              >
                Open
              </UButton>
            </div>
          </div>
        </UCard>
      </div>

      <div
        v-if="data.invites.length"
        class="flex flex-col gap-2"
      >
        <h2 class="font-semibold text-muted text-sm uppercase tracking-wide">
          Invited
        </h2>
        <UCard
          v-for="(inv, i) in data.invites"
          :key="i"
        >
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p class="font-medium">
                {{ inv.eventTitle }}
              </p>
              <p class="text-sm text-muted">
                {{ when(inv.startsAt) }}<span v-if="inv.location"> · {{ inv.location }}</span>
              </p>
            </div>
            <UButton
              :to="`/i/${inv.token}`"
              size="xs"
            >
              Respond
            </UButton>
          </div>
        </UCard>
      </div>

      <p
        v-if="!data.invites.length && !data.rsvps.length"
        class="text-muted"
      >
        Nothing here yet — invites sent to <span class="font-medium">your email</span> will show up automatically.
      </p>
    </template>
  </div>
</template>
