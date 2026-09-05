<script setup lang="ts">
/**
 * zäme — app shell. Stock Nuxt UI, default look (apps/site/CLAUDE.md): a plain
 * header with the wordmark and account actions, content below. No global auth
 * guard — most visitors arrive on an invite link and never sign in.
 */
// A page's own title gets the suffix; the bare app title does not.
useHead({
  titleTemplate: (title?: string) =>
    title && title !== 'zäme' ? `${title} · zäme` : 'zäme'
})

const session = useSession()

/**
 * Is the viewer the instance owner? Only they see the admin link. Asked of the
 * server (`/api/admin/me`) rather than guessed in the browser, and only once a
 * session exists — a signed-out visitor never makes the call.
 */
const isOwner = ref(false)
watch(() => session.value.data?.user?.id, async (userId) => {
  if (!userId) {
    isOwner.value = false
    return
  }
  isOwner.value = await $fetch('/api/admin/me').then(() => true).catch(() => false)
}, { immediate: true })

async function handleSignOut() {
  await signOut()
  await navigateTo('/')
}
</script>

<template>
  <UApp>
    <div class="min-h-screen flex flex-col">
      <header class="border-b border-default">
        <div class="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <NuxtLink
            to="/"
            class="text-xl font-bold tracking-tight"
          >
            zäme
          </NuxtLink>
          <nav class="flex items-center gap-2">
            <UButton
              to="/concerts"
              variant="ghost"
              size="sm"
            >
              Concerts
            </UButton>
            <template v-if="session.data?.user">
              <UButton
                to="/me"
                variant="ghost"
                size="sm"
              >
                My invites
              </UButton>
              <UButton
                to="/host"
                variant="ghost"
                size="sm"
              >
                Hosting
              </UButton>
              <UButton
                v-if="isOwner"
                to="/admin"
                variant="ghost"
                size="sm"
              >
                Admin
              </UButton>
              <UButton
                variant="ghost"
                size="sm"
                color="neutral"
                @click="handleSignOut"
              >
                Sign out
              </UButton>
            </template>
            <template v-else>
              <UButton
                to="/login"
                variant="ghost"
                size="sm"
              >
                Sign in
              </UButton>
            </template>
          </nav>
        </div>
      </header>
      <main class="flex-1">
        <!-- Most pages have no layout at all; /admin/** opts into `admin`. -->
        <NuxtLayout>
          <NuxtPage />
        </NuxtLayout>
      </main>
      <footer class="border-t border-default">
        <div class="max-w-3xl mx-auto px-4 py-4 text-sm text-muted">
          zäme — <em>together</em>. Plan it with your people.
        </div>
      </footer>
    </div>
  </UApp>
</template>
