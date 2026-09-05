<script setup lang="ts">
/**
 * First run. A fresh self-hosted zäme has an empty database and no way in, so
 * this page claims the instance: the first account created becomes the owner
 * (`server/utils/instance.ts`). Sign-in is magic-link like everywhere else —
 * there is no password anywhere in this app — so "setup" is really just the
 * first sign-in, done deliberately and once.
 */
useSeoMeta({ title: 'Set up zäme' })

const { data } = await useFetch<{ setupRequired: boolean }>('/api/setup/status')
if (!data.value?.setupRequired) {
  await navigateTo('/')
}

const name = ref('')
const email = ref('')
const sent = ref(false)
const sending = ref(false)
const errorMsg = ref<string | null>(null)

async function claim() {
  if (!name.value || !email.value) return
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
        @submit.prevent="claim"
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
          type="submit"
          :loading="sending"
          :disabled="!name || !email"
          block
          size="lg"
        >
          Claim this instance
        </UButton>
      </form>
    </UCard>
  </div>
</template>
