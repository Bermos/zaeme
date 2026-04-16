<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
    <UCard class="w-full max-w-md">
      <template #header>
        <div class="text-center space-y-2">
          <h1 class="text-2xl font-bold">
            Welcome to zäme
          </h1>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Create your admin account to get started
          </p>
        </div>
      </template>

      <UForm :schema="schema" :state="state" class="space-y-4" @submit="onSubmit">
        <UFormField label="Name" name="name">
          <UInput v-model="state.name" placeholder="Your name" class="w-full" />
        </UFormField>

        <UFormField label="Email" name="email">
          <UInput v-model="state.email" type="email" placeholder="admin@example.com" class="w-full" />
        </UFormField>

        <UFormField label="Password" name="password">
          <UInput v-model="state.password" type="password" placeholder="Choose a strong password" class="w-full" />
        </UFormField>

        <UFormField label="Confirm password" name="passwordConfirm">
          <UInput v-model="state.passwordConfirm" type="password" placeholder="Repeat your password" class="w-full" />
        </UFormField>

        <UButton type="submit" block :loading="loading">
          Create admin account
        </UButton>
      </UForm>

      <template v-if="errorMessage" #footer>
        <UAlert color="error" :description="errorMessage" />
      </template>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { z } from 'zod'

definePageMeta({ layout: false })

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  passwordConfirm: z.string()
}).refine(data => data.password === data.passwordConfirm, {
  message: 'Passwords do not match',
  path: ['passwordConfirm']
})

const state = reactive({
  name: '',
  email: '',
  password: '',
  passwordConfirm: ''
})

const loading = ref(false)
const errorMessage = ref('')

async function onSubmit() {
  loading.value = true
  errorMessage.value = ''

  try {
    await $fetch('/api/setup', {
      method: 'POST',
      body: {
        name: state.name,
        email: state.email,
        password: state.password
      }
    })
    await navigateTo('/')
  } catch (err: unknown) {
    const error = err as { data?: { statusMessage?: string }, message?: string }
    errorMessage.value = error.data?.statusMessage ?? error.message ?? 'Something went wrong. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>
