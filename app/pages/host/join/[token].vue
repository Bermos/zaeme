<script setup lang="ts">
/**
 * Accept a co-organizer invite: the link a host shares with a friend who is
 * helping plan. Public preview (what event, which role); accepting requires a
 * signed-in zäme account, which the planner role then attaches to.
 */
const route = useRoute()
const token = route.params.token as string

const { data: preview, error } = await useFetch(`/api/host/join/${token}`)
const session = useSession()
const toast = useToast()

useSeoMeta({ title: () => preview.value ? `Help plan ${preview.value.eventTitle}` : 'Co-organizer invite' })

const signedIn = computed(() => !!session.value.data?.user)
const accepting = ref(false)

async function accept() {
  accepting.value = true
  try {
    const res = await $fetch<{ eventSlug: string }>(`/api/host/join/${token}/accept`, { method: 'POST' })
    toast.add({ title: 'You\'re on the team! 🙌', color: 'success' })
    await navigateTo(`/host/${res.eventSlug}`)
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not accept the invite', color: 'error' })
  } finally {
    accepting.value = false
  }
}

const errorMessage = computed(() => {
  const status = (error.value as { statusCode?: number } | null)?.statusCode
  if (status === 404) return 'This co-organizer link does not exist.'
  if (status === 410) return 'This co-organizer link was already used or revoked — ask for a fresh one.'
  return error.value ? 'Something went wrong loading this invite.' : null
})

const ROLE_LABEL: Record<string, string> = {
  co_planner: 'co-organizer (full planning access)',
  logistics: 'logistics helper'
}
</script>

<template>
  <div class="max-w-xl mx-auto px-4 py-8">
    <UAlert
      v-if="errorMessage"
      color="warning"
      variant="subtle"
      title="Hmm."
      :description="errorMessage"
    />

    <UCard v-else-if="preview">
      <template #header>
        <div>
          <p class="font-semibold text-lg">
            Help plan "{{ preview.eventTitle }}"
          </p>
          <p class="text-sm text-muted">
            You've been invited as {{ ROLE_LABEL[preview.role] ?? preview.role }}.
          </p>
        </div>
      </template>

      <div class="flex flex-col gap-3">
        <p class="text-sm text-muted">
          Accepting adds this event to your hosting dashboard — you can edit the
          post, run the date poll, manage invites and watch RSVPs together with
          the host.
        </p>
        <p
          v-if="preview.emailRestricted"
          class="text-sm text-muted"
        >
          ✉️ This invite is locked to a specific email address — sign in with
          the address the host used for you.
        </p>

        <UButton
          v-if="signedIn"
          :loading="accepting"
          size="lg"
          block
          @click="accept"
        >
          Count me in — join the team
        </UButton>
        <template v-else>
          <UAlert
            color="neutral"
            variant="subtle"
            description="Sign in first (magic link, no password) — the invite attaches to your account."
          />
          <UButton
            :to="`/login?redirect=/host/join/${token}`"
            size="lg"
            block
            variant="outline"
          >
            Sign in to accept
          </UButton>
        </template>
      </div>
    </UCard>
  </div>
</template>
