export default defineNuxtRouteMiddleware(async (to) => {
  // Don't redirect on the setup page itself
  if (to.path === '/setup') return

  const { data } = await useFetch('/api/setup/status')
  if (data.value && !(data.value as { completed: boolean }).completed) {
    return navigateTo('/setup')
  }
})
