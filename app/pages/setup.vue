<script setup lang="ts">
import { z } from 'zod'

useSeoMeta({ title: 'zäme — Setup' })

// If setup is not required, redirect home
const { data } = await useFetch<{ setupRequired: boolean }>('/api/setup/status')
if (!data.value?.setupRequired) {
  await navigateTo('/')
}

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.email('Please enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  passwordConfirm: z.string()
}).refine(data => data.password === data.passwordConfirm, {
  message: 'Passwords do not match',
  path: ['passwordConfirm']
})

type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({
  name: undefined,
  email: undefined,
  password: undefined,
  passwordConfirm: undefined
})

const loading = ref(false)
const error = ref<string | null>(null)
const toast = useToast()

async function onSubmit() {
  if (!state.name || !state.email || !state.password) return
  loading.value = true
  error.value = null

  const { error: authError } = await authClient.signUp.email({
    name: state.name,
    email: state.email,
    password: state.password
  })

  loading.value = false

  if (authError) {
    error.value = authError.message ?? 'Setup failed. Please try again.'
    return
  }

  toast.add({
    title: 'Welcome to zäme!',
    description: 'Your admin account has been created.',
    color: 'success'
  })
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
        <h1 class="text-xl font-semibold mt-4">
          Welcome! Let's set up your instance.
        </h1>
        <p class="text-muted text-sm mt-2">
          Create the admin account to get started. This page is only shown once.
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
            label="Your name"
            name="name"
          >
            <UInput
              v-model="state.name"
              placeholder="Ada Lovelace"
              autocomplete="name"
              class="w-full"
            />
          </UFormField>

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
              placeholder="Min. 8 characters"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Confirm password"
            name="passwordConfirm"
          >
            <UInput
              v-model="state.passwordConfirm"
              type="password"
              placeholder="Repeat your password"
              autocomplete="new-password"
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
            label="Create admin account"
            :loading="loading"
            block
          />
        </UForm>
      </UCard>
    </div>
  </div>
</template>
