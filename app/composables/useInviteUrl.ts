/**
 * SSR-safe builder for the public invite URL.
 */
export function useInviteUrl() {
  const url = useRequestURL()
  return (token: string) => `${url.origin}/invite/${token}`
}
