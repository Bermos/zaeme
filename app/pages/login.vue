<script setup lang="ts">
/**
 * Magic-link sign-in — email only, no password ever. Creates a zäme account on
 * first use (multi-user; completely separate from the Enterprise owner login).
 */
const email = ref('')
const sent = ref(false)
const sending = ref(false)
const errorMsg = ref<string | null>(null)

const route = useRoute()

async function send() {
  if (!email.value) return
  sending.value = true
  errorMsg.value = null
  try {
    const { error } = await authClient.signIn.magicLink({
      email: email.value,
      callbackURL: (route.query.redirect as string) || '/me'
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
  <div class="max-w-md mx-auto px-4 py-16">
    <UCard>
      <template #header>
        <div>
          <p class="font-semibold text-lg">
            Sign in to zäme
          </p>
          <p class="text-sm text-muted">
            We'll email you a sign-in link. No password, ever.
          </p>
        </div>
      </template>

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

      <form
        v-else
        class="flex flex-col gap-3"
        @submit.prevent="send"
      >
        <UInput
          v-model="email"
          type="email"
          placeholder="you@example.com"
          size="lg"
          required
          autofocus
        />
        <UAlert
          v-if="errorMsg"
          color="error"
          variant="subtle"
          :description="errorMsg"
        />
        <UButton
          type="submit"
          :loading="sending"
          :disabled="!email"
          block
          size="lg"
        >
          Email me a sign-in link
        </UButton>
      </form>
    </UCard>
  </div>
</template>
