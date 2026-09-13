<script setup lang="ts">
/**
 * First run. A fresh self-hosted zäme has an empty database and no way in, so
 * this page claims the instance: the first account created becomes the owner
 * (`server/utils/instance.ts`).
 *
 * It claims it with a PASSKEY. The old flow posted a magic link, which asked a
 * brand-new deployment to have working outbound mail before anybody could open
 * it — and an instance that does not is not merely inconvenienced, it is
 * unopenable. A passkey needs nothing but the browser that is already here.
 *
 * The magic link is still offered underneath, for an instance that does have
 * mail and a browser that has no authenticator.
 */
useSeoMeta({ title: 'Set up zäme' })

const { data: status } = await useFetch<{
  setupRequired: boolean
  emailConfigured: boolean
}>('/api/setup/status')

if (!status.value?.setupRequired) {
  await navigateTo('/')
}

const name = ref('')
const email = ref('')
const sent = ref(false)
const sending = ref(false)
const claiming = ref(false)
const errorMsg = ref<string | null>(null)

const hasWebAuthn = ref(false)
onMounted(() => {
  hasWebAuthn.value = passkeysSupported()
})

const ready = computed(() => Boolean(name.value.trim() && email.value.includes('@')))

/**
 * Claim with a passkey.
 *
 * The `context` carries the name and the address, but it is NOT what authorises
 * this: the server re-checks that no account exists before it creates one
 * (`server/utils/passkey-bootstrap.ts`). `createSession` means the same call
 * that registers the key also signs in, so setup finishes in one gesture.
 */
async function claimWithPasskey() {
  if (!ready.value) return
  claiming.value = true
  errorMsg.value = null
  try {
    const result = await authClient.passkey.addPasskey({
      name: 'Owner passkey',
      context: encodeSetupContext({ name: name.value.trim(), email: email.value.trim() }),
      createSession: true
    })
    if (result?.error) {
      errorMsg.value = result.error.message ?? 'Could not register that passkey.'
      return
    }
    await navigateTo('/admin')
  } catch {
    errorMsg.value = null
  } finally {
    claiming.value = false
  }
}

async function claimWithLink() {
  if (!ready.value) return
  sending.value = true
  errorMsg.value = null
  try {
    const { error } = await authClient.signIn.magicLink({
      email: email.value,
      name: name.value,
      callbackURL: '/host'
    })
    if (error) {
      errorMsg.value = error.message ?? 'Setup failed — try again.'
    } else {
      sent.value = true
    }
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="max-w-md mx-auto px-4 py-16">
    <div class="text-center mb-8">
      <p class="text-3xl font-bold tracking-tight">
        zäme
      </p>
      <h1 class="text-xl font-semibold mt-4">
        Let's set up your instance.
      </h1>
      <p class="text-muted text-sm mt-2">
        Create the first account — it owns this instance. You'll only see this page once.
      </p>
    </div>

    <UCard>
      <div
        v-if="sent"
        class="flex flex-col gap-2"
      >
        <p class="font-medium">
          📬 Check your inbox
        </p>
        <p class="text-sm text-muted">
          We sent a sign-in link to <span class="font-medium">{{ email }}</span>.
          Open it to finish setting up.
        </p>
      </div>

      <form
        v-else
        class="flex flex-col gap-3"
        @submit.prevent="claimWithPasskey"
      >
        <UFormField
          label="Your name"
          name="name"
        >
          <UInput
            v-model="name"
            placeholder="Ada Lovelace"
            autocomplete="name"
            class="w-full"
            required
          />
        </UFormField>
        <UFormField
          label="Email"
          name="email"
          help="Used to address you and to match your invites. Sign-in is the passkey."
        >
          <UInput
            v-model="email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            class="w-full"
            required
          />
        </UFormField>

        <UAlert
          v-if="errorMsg"
          color="error"
          variant="subtle"
          :description="errorMsg"
        />

        <UButton
          v-if="hasWebAuthn"
          type="submit"
          icon="i-lucide-key-round"
          :loading="claiming"
          :disabled="!ready"
          block
          size="lg"
        >
          Claim with a passkey
        </UButton>

        <template v-if="status?.emailConfigured">
          <USeparator label="or" />
          <UButton
            variant="soft"
            color="neutral"
            :loading="sending"
            :disabled="!ready"
            block
            size="lg"
            @click="claimWithLink"
          >
            Email me a sign-in link
          </UButton>
        </template>

        <UAlert
          v-else-if="!hasWebAuthn"
          color="warning"
          variant="subtle"
          icon="i-lucide-shield-alert"
          title="No way in from this browser"
          description="This browser has no passkey support and the instance has no mail transport. Open this page in a browser with Touch ID, Windows Hello or a security key."
        />
      </form>
    </UCard>
  </div>
</template>
