export default defineNuxtRouteMiddleware(async () => {
  const { data: session } = authClient.useSession(useFetch)
  if (!session.value) {
    return navigateTo('/login')
  }
})
