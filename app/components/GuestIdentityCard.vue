<script setup lang="ts">
/**
 * "Who are you?" — the one-time name+email entry every guest action is keyed
 * by (kept in localStorage; NOT auth — the invite link is the credential).
 */
const { identity, remember, complete } = useGuestIdentity()

const name = ref(identity.value.name)
const email = ref(identity.value.email)

watch(identity, (v) => {
  if (!name.value) name.value = v.name
  if (!email.value) email.value = v.email
})

function save() {
  if (!name.value || !email.value) return
  remember({ name: name.value, email: email.value })
}
</script>

<template>
  <UCard v-if="!complete">
    <template #header>
      <div>
        <p class="font-semibold">
          Tell us who you are
        </p>
        <p class="text-sm text-muted">
          So your friends see your name — no account needed.
        </p>
      </div>
    </template>
    <form
      class="flex flex-col sm:flex-row gap-2"
      @submit.prevent="save"
    >
      <UInput
        v-model="name"
        placeholder="Your name"
        class="flex-1"
        required
      />
      <UInput
        v-model="email"
        type="email"
        placeholder="you@example.com"
        class="flex-1"
        required
      />
      <UButton
        type="submit"
        :disabled="!name || !email"
      >
        That's me
      </UButton>
    </form>
  </UCard>
  <div
    v-else
    class="flex items-center gap-2 text-sm text-muted"
  >
    <span>You're answering as <span class="font-medium text-highlighted">{{ identity.name }}</span> ({{ identity.email }})</span>
    <UButton
      variant="link"
      size="xs"
      color="neutral"
      @click="remember({ name: '', email: '' })"
    >
      change
    </UButton>
  </div>
</template>
