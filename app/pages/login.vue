<script setup lang="ts">
import { z } from 'zod'

useSeoMeta({ title: 'zäme — Log in' })

// Redirect if already logged in
const { data: session } = await authClient.useSession(useFetch)
if (session.value) {
  await navigateTo('/dashboard')
}

const schema = z.object({
  email: z.email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required')
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  email: undefined,
  password: undefined
})

const loading = ref(false)
const error = ref<string | null>(null)
const toast = useToast()

async function onSubmit() {
  if (!state.email || !state.password) return
  loading.value = true
  error.value = null

  const { error: authError } = await authClient.signIn.email({
    email: state.email,
    password: state.password
  })

  loading.value = false

  if (authError) {
    error.value = authError.message ?? 'Login failed. Please check your credentials.'
    return
  }

  toast.add({ title: 'Logged in', description: 'Welcome back!', color: 'success' })
  await navigateTo('/dashboard')
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <NuxtLink
          to="/"
          class="text-3xl font-bold text-primary"
        >
          zäme
        </NuxtLink>
        <p class="text-muted mt-2">
          Log in to your account
        </p>
      </div>

      <UCard>
        <UForm
          :schema="schema"
          :state="state"
          class="space-y-4"
          @submit="onSubmit"
        >
          <UFormField
            label="Email"
            name="email"
          >
            <UInput
              v-model="state.email"
              type="email"
              placeholder="you@example.com"
              autocomplete="email"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Password"
            name="password"
          >
            <UInput
              v-model="state.password"
              type="password"
              placeholder="••••••••"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>

          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            :description="error"
            icon="i-lucide-alert-circle"
          />

          <UButton
            type="submit"
            label="Log in"
            :loading="loading"
            block
          />
        </UForm>
      </UCard>

      <p class="text-center text-sm text-muted mt-4">
        <NuxtLink
          to="/"
          class="hover:underline"
        >
          ← Back to home
        </NuxtLink>
      </p>
    </div>
  </div>
</template>
