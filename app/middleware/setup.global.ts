export default defineNuxtRouteMiddleware(async (to) => {
  // Don't redirect on the setup page itself
  if (to.path === '/setup') return

  // Cache result in Nuxt state so we only fetch once per session
  const setupCompleted = useState<boolean | null>('setup:completed', () => null)

  if (setupCompleted.value === null) {
    const { data } = await useFetch<{ completed: boolean }>('/api/setup/status')
    setupCompleted.value = data.value?.completed ?? true
  }

  if (!setupCompleted.value) {
    return navigateTo('/setup')
  }
})
