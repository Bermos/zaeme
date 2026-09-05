<script setup lang="ts">
/**
 * The admin shell: one nav across the instance-wide surfaces, and the page
 * below it. Stock Nuxt UI, same friendly look as the rest of zäme — this is
 * still the same app, not a console bolted onto it.
 *
 * Wider than the 3xl the guest pages use: these are tables of everything, and
 * squeezing a cross-event list into a reading column helps nobody.
 */
const links = [
  { label: 'Overview', to: '/admin', icon: 'i-lucide-gauge' },
  { label: 'Events', to: '/admin/events', icon: 'i-lucide-calendar-days' },
  { label: 'Calendar', to: '/admin/calendar', icon: 'i-lucide-calendar-range' },
  { label: 'Series', to: '/admin/series', icon: 'i-lucide-repeat' },
  { label: 'People', to: '/admin/people', icon: 'i-lucide-users' },
  { label: 'Invites', to: '/admin/invites', icon: 'i-lucide-link' },
  { label: 'Media', to: '/admin/media', icon: 'i-lucide-image' },
  { label: 'Accounts', to: '/admin/accounts', icon: 'i-lucide-user-cog' },
  { label: 'Enterprise', to: '/admin/integration', icon: 'i-lucide-plug' },
  { label: 'Audit', to: '/admin/audit', icon: 'i-lucide-scroll-text' }
]

const route = useRoute()
</script>

<template>
  <div class="max-w-6xl mx-auto px-4 py-6 flex flex-col gap-6">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 class="text-2xl font-bold">
          Instance admin
        </h1>
        <p class="text-sm text-muted">
          Everything on this zäme, across every event.
        </p>
      </div>
      <UButton
        to="/host"
        variant="outline"
        size="sm"
        icon="i-lucide-arrow-left"
      >
        Back to hosting
      </UButton>
    </div>

    <nav class="flex gap-1 flex-wrap border-b border-default pb-2">
      <UButton
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :icon="link.icon"
        size="sm"
        :variant="route.path === link.to ? 'soft' : 'ghost'"
        :color="route.path === link.to ? 'primary' : 'neutral'"
      >
        {{ link.label }}
      </UButton>
    </nav>

    <slot />
  </div>
</template>
