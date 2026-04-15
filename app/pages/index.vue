<script setup lang="ts">
useSeoMeta({ title: 'zäme — together' })
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-8">
    <div class="text-center max-w-lg">
      <h1 class="text-5xl font-bold tracking-tight mb-4">
        zäme
      </h1>
      <p class="text-xl text-gray-500 mb-8">
        Your personal event platform. <em>Together.</em>
      </p>
      <UButton to="/setup" size="xl">
        Get started
      </UButton>
    </div>
  </div>
</template>
