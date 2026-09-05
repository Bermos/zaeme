/**
 * The guest's lightweight identity — the name+email pair every guest action
 * (RSVP, date vote, bring-list claim) is keyed by. Persisted in localStorage so
 * a friend enters it once per browser; prefilled from a personalised invite or
 * a signed-in session by the pages. NOT auth — just convenience (the invite
 * token in the URL is the credential; ADR-0019 §3).
 */
const STORAGE_KEY = 'zaeme:guest-identity'

interface GuestIdentity {
  name: string
  email: string
}

export function useGuestIdentity() {
  const identity = useState<GuestIdentity>('guest-identity', () => ({ name: '', email: '' }))

  if (import.meta.client && !identity.value.email) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as GuestIdentity
        if (parsed?.email) identity.value = { name: parsed.name ?? '', email: parsed.email }
      }
    } catch { /* ignore corrupt storage */ }
  }

  function remember(next: GuestIdentity) {
    identity.value = { ...next, email: next.email.toLowerCase() }
    if (import.meta.client) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(identity.value))
      } catch { /* storage full/blocked — fine, it's convenience only */ }
    }
  }

  /** Prefill (without overwriting something the guest already entered). */
  function suggest(next: Partial<GuestIdentity>) {
    if (identity.value.email) return
    identity.value = {
      name: next.name ?? identity.value.name,
      email: (next.email ?? identity.value.email).toLowerCase()
    }
  }

  const complete = computed(() => !!identity.value.name && /.+@.+\..+/.test(identity.value.email))

  return { identity, remember, suggest, complete }
}
