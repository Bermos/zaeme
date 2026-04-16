<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'zäme'
const description = 'Plan events together — invites, RSVPs, travel coordination and more.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description
})

const { data: session } = authClient.useSession(useFetch)

async function signOut() {
  await authClient.signOut()
  await navigateTo('/')
}
</script>

<template>
  <UApp>
    <UHeader>
      <template #left>
        <NuxtLink
          to="/"
          class="font-bold text-xl tracking-tight text-primary"
        >
          zäme
        </NuxtLink>
      </template>

      <template #right>
        <UColorModeButton />
        <template v-if="session">
          <UButton
            to="/events/new"
            icon="i-lucide-plus"
            label="New event"
            size="sm"
            variant="ghost"
          />
          <UDropdownMenu
            :items="[[
              { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/dashboard' },
              { label: 'Log out', icon: 'i-lucide-log-out', color: 'error', onSelect: signOut }
            ]]"
            :content="{ align: 'end' }"
          >
            <UButton
              variant="ghost"
              size="sm"
              :label="session.user.name"
              icon="i-lucide-user"
              trailing-icon="i-lucide-chevron-down"
            />
          </UDropdownMenu>
        </template>
        <UButton
          v-else
          to="/login"
          label="Log in"
          size="sm"
          variant="ghost"
        />
      </template>
    </UHeader>

    <UMain>
      <NuxtPage />
    </UMain>

    <UFooter>
      <template #left>
        <p class="text-sm text-muted">
          zäme &bull; {{ new Date().getFullYear() }}
        </p>
      </template>
    </UFooter>
  </UApp>
</template>
