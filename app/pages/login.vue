<script setup lang="ts">
/**
 * Sign in. Two ways, and the page leads with the one that always works.
 *
 * A passkey needs nothing of this instance but a browser: no mail transport, no
 * inbox, no waiting. A magic link needs an instance that can actually deliver
 * mail — so the form asks the server whether this one can, and says plainly
 * when it cannot instead of accepting an address and promising an email that
 * will never arrive.
 */
useSeoMeta({ title: 'Sign in' })

const route = useRoute()
const redirect = computed(() => (route.query.redirect as string) || '/me')

const { data: status } = await useFetch<{
  setupRequired: boolean
  emailConfigured: boolean
  recoveryAvailable: boolean
}>('/api/setup/status')

const email = ref('')
const sent = ref(false)
const sending = ref(false)
const signingIn = ref(false)
const errorMsg = ref<string | null>(null)

const hasWebAuthn = ref(false)
onMounted(() => {
  hasWebAuthn.value = passkeysSupported()
})

async function withPasskey() {
  signingIn.value = true
  errorMsg.value = null
  try {
    const result = await authClient.signIn.passkey()
    if (result?.error) {
      errorMsg.value = result.error.message ?? 'That passkey was not accepted.'
      return
    }
    await navigateTo(redirect.value)
  } catch {
    // An abandoned or dismissed WebAuthn prompt rejects. That is a person
    // changing their mind, not a failure worth a red box.
    errorMsg.value = null
  } finally {
    signingIn.value = false
  }
}

async function sendLink() {
  if (!email.value) return
  sending.value = true
  errorMsg.value = null
  try {
    const { error } = await authClient.signIn.magicLink({
      email: email.value,
      callbackURL: redirect.value
    })
    if (error) {
      errorMsg.value = error.message ?? 'Could not send the link — try again.'
    } else {
      sent.value = true
    }
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="max-w-md mx-auto px-4 py-16 flex flex-col gap-4">
    <UCard>
      <template #header>
        <div>
          <p class="font-semibold text-lg">
            Sign in to zäme
          </p>
          <p class="text-sm text-muted">
            No password, ever.
          </p>
        </div>
      </template>

      <div class="flex flex-col gap-4">
        <div
          v-if="hasWebAuthn"
          class="flex flex-col gap-2"
        >
          <UButton
            block
            size="lg"
            icon="i-lucide-key-round"
            :loading="signingIn"
            @click="withPasskey"
          >
            Sign in with a passkey
          </UButton>
          <p class="text-xs text-muted text-center">
            Touch ID, Windows Hello, a security key — whatever this device has.
          </p>
        </div>

        <USeparator
          v-if="hasWebAuthn"
          label="or"
        />

        <div
          v-if="sent"
          class="flex flex-col gap-2"
        >
          <p class="font-medium">
            📬 Check your inbox
          </p>
          <p class="text-sm text-muted">
            We sent a sign-in link to <span class="font-medium">{{ email }}</span>.
            It's valid for a few minutes.
          </p>
        </div>

        <UAlert
          v-else-if="status && !status.emailConfigured"
          color="warning"
          variant="subtle"
          icon="i-lucide-mail-x"
          title="This instance can't send email yet"
          description="No mail transport is configured, so a sign-in link would go nowhere. Use a passkey."
        />

        <form
          v-else
          class="flex flex-col gap-3"
          @submit.prevent="sendLink"
        >
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            size="lg"
            autocomplete="email webauthn"
            required
          />
          <UButton
            type="submit"
            variant="soft"
            color="neutral"
            :loading="sending"
            :disabled="!email"
            block
            size="lg"
          >
            Email me a sign-in link
          </UButton>
        </form>

        <UAlert
          v-if="errorMsg"
          color="error"
          variant="subtle"
          :description="errorMsg"
        />
      </div>
    </UCard>

    <p
      v-if="status?.recoveryAvailable"
      class="text-xs text-muted text-center"
    >
      Locked out of the owner account?
      <NuxtLink
        to="/setup/recover"
        class="underline"
      >
        Use the recovery token
      </NuxtLink>.
    </p>
  </div>
</template>
