<script setup lang="ts">
/**
 * Break-glass: an owner who cannot sign in registers a passkey here.
 *
 * The case this exists for is real and this instance lived it — the only way
 * into zäme was a magic link, the deployment had no mail transport, so the link
 * went to a log file and the owner's own account was unreachable. Anything that
 * fixes that has to work from outside every credential the app has.
 *
 * So the credential is the OPERATOR's, not the app's: `ZAEME_OWNER_BOOTSTRAP_TOKEN`
 * in the environment, which only somebody who can set this instance's variables
 * can install. Quoting it buys exactly one thing — a passkey on the account that
 * claimed this instance. It is not a session, it is not a password, and it
 * cannot name a different account.
 *
 * Remove the variable once you are back in. The page says so, twice.
 */
useSeoMeta({ title: 'Recover owner access' })

const { data: status } = await useFetch<{
  setupRequired: boolean
  recoveryAvailable: boolean
}>('/api/setup/status')

if (status.value?.setupRequired) {
  await navigateTo('/setup')
}

const token = ref('')
const working = ref(false)
const done = ref(false)
const errorMsg = ref<string | null>(null)

const hasWebAuthn = ref(false)
onMounted(() => {
  hasWebAuthn.value = passkeysSupported()
})

async function recover() {
  if (!token.value.trim()) return
  working.value = true
  errorMsg.value = null
  try {
    const result = await authClient.passkey.addPasskey({
      name: 'Owner recovery passkey',
      context: encodeRecoverContext(token.value.trim()),
      createSession: true
    })
    if (result?.error) {
      errorMsg.value = result.error.message ?? 'That token was not accepted.'
      return
    }
    done.value = true
  } catch {
    errorMsg.value = null
  } finally {
    working.value = false
  }
}
</script>

<template>
  <div class="max-w-md mx-auto px-4 py-16 flex flex-col gap-4">
    <div class="text-center">
      <h1 class="text-xl font-semibold">
        Recover owner access
      </h1>
      <p class="text-muted text-sm mt-2">
        Register a passkey on the owner account using this instance's recovery token.
      </p>
    </div>

    <UAlert
      v-if="status && !status.recoveryAvailable"
      color="neutral"
      variant="subtle"
      icon="i-lucide-lock"
      title="No recovery token is installed"
      description="Set ZAEME_OWNER_BOOTSTRAP_TOKEN in this instance's environment, redeploy, and come back to this page."
    />

    <UCard v-else-if="done">
      <div class="flex flex-col gap-3">
        <p class="font-medium">
          ✅ You're signed in
        </p>
        <p class="text-sm text-muted">
          The passkey is registered on the owner account. Now remove
          <code class="text-xs">ZAEME_OWNER_BOOTSTRAP_TOKEN</code> from this
          instance's environment — while it is set, anybody who learns it can
          add a passkey to your account.
        </p>
        <UButton
          to="/admin/security"
          block
        >
          Manage passkeys
        </UButton>
      </div>
    </UCard>

    <UCard v-else>
      <form
        class="flex flex-col gap-3"
        @submit.prevent="recover"
      >
        <UFormField
          label="Recovery token"
          name="token"
          help="The value of ZAEME_OWNER_BOOTSTRAP_TOKEN on this instance."
        >
          <UInput
            v-model="token"
            type="password"
            placeholder="•••••••••••••••••"
            autocomplete="off"
            class="w-full"
            required
            autofocus
          />
        </UFormField>

        <UAlert
          v-if="errorMsg"
          color="error"
          variant="subtle"
          :description="errorMsg"
        />

        <UButton
          type="submit"
          icon="i-lucide-key-round"
          :loading="working"
          :disabled="!token.trim() || !hasWebAuthn"
          block
          size="lg"
        >
          Register a passkey
        </UButton>

        <p
          v-if="!hasWebAuthn"
          class="text-xs text-muted"
        >
          This browser has no passkey support. Open this page somewhere with
          Touch ID, Windows Hello or a security key.
        </p>
      </form>
    </UCard>
  </div>
</template>
