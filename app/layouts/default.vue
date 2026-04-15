<template>
  <div>
    <header class="border-b border-gray-200 dark:border-gray-800 px-6 py-4">
      <div class="max-w-7xl mx-auto flex items-center justify-between">
        <NuxtLink to="/" class="text-xl font-bold">
          zäme
        </NuxtLink>
      </div>
    </header>
    <main>
      <slot />
    </main>
  </div>
</template>
