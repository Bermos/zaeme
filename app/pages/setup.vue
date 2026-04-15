<script setup lang="ts">
definePageMeta({ layout: 'minimal' })

useSeoMeta({ title: 'Setup — zäme' })

const form = reactive({ name: '', password: '', confirmPassword: '' })
const error = ref<string | null>(null)
const loading = ref(false)

async function submit() {
  error.value = null

  if (form.password !== form.confirmPassword) {
    error.value = 'Passwords do not match.'
    return
  }

  loading.value = true

  try {
    await $fetch('/api/setup', {
      method: 'POST',
      body: { name: form.name, password: form.password },
    })
    await navigateTo('/')
  }
  catch (err: unknown) {
    const e = err as { data?: { message?: string }; message?: string }
    error.value = e?.data?.message ?? e?.message ?? 'Something went wrong.'
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="text-center">
          <h1 class="text-2xl font-bold">
            Welcome to zäme
          </h1>
          <p class="text-sm text-gray-500 mt-1">
            Create your admin account to get started.
          </p>
        </div>
      </template>

      <UForm :state="form" class="space-y-4" @submit="submit">
        <UFormField label="Name" name="name" required>
          <UInput v-model="form.name" placeholder="Your name" autocomplete="name" />
        </UFormField>

        <UFormField label="Password" name="password" required>
          <UInput
            v-model="form.password"
            type="password"
            placeholder="Min. 8 characters"
            autocomplete="new-password"
          />
        </UFormField>

        <UFormField label="Confirm password" name="confirmPassword" required>
          <UInput
            v-model="form.confirmPassword"
            type="password"
            placeholder="Repeat password"
            autocomplete="new-password"
          />
        </UFormField>

        <UAlert v-if="error" color="error" :description="error" />

        <UButton type="submit" block :loading="loading">
          Create account
        </UButton>
      </UForm>
    </UCard>
  </div>
</template>
