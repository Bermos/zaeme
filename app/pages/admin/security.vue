<script setup lang="ts">
/**
 * The owner's own ways in. Add a passkey, name it, remove one — and see, in
 * plain words, what would happen if the others stopped working.
 *
 * The warnings are the point of the page. An owner with no passkey depends
 * entirely on this instance being able to deliver mail; an owner whose instance
 * cannot deliver mail depends entirely on their passkeys. Either alone is a
 * single point of failure, and the page says which one you are standing on.
 */
definePageMeta({ layout: 'admin' })
useSeoMeta({ title: 'Security' })

interface Passkey {
  id: string
  name: string | null
  deviceType: string
  backedUp: boolean
  createdAt: string
}

const { data, refresh, status } = await useFetch<{
  passkeys: Passkey[]
  emailConfigured: boolean
  mailTransport: string
  bootstrapInstalled: boolean
}>('/api/admin/security')

const adding = ref(false)
const errorMsg = ref<string | null>(null)
const newName = ref('')

const hasWebAuthn = ref(false)
onMounted(() => {
  hasWebAuthn.value = passkeysSupported()
})

const toast = useToast()

async function addPasskey() {
  adding.value = true
  errorMsg.value = null
  try {
    // A session exists here by construction — this page is behind the owner
    // gate — so no bootstrap context: the plugin attaches the key to the
    // signed-in account.
    const result = await authClient.passkey.addPasskey({
      name: newName.value.trim() || defaultName()
    })
    if (result?.error) {
      errorMsg.value = result.error.message ?? 'Could not register that passkey.'
      return
    }
    newName.value = ''
    await refresh()
    toast.add({ title: 'Passkey registered', color: 'success' })
  } catch {
    // Dismissed prompt. Not an error.
  } finally {
    adding.value = false
  }
}

async function remove(passkey: Passkey) {
  const label = passkey.name || 'this passkey'
  if (!confirm(`Remove ${label}? You'll no longer be able to sign in with it.`)) return
  const { error } = await authClient.passkey.deletePasskey({ id: passkey.id })
  if (error) {
    toast.add({ title: error.message ?? 'Could not remove it', color: 'error' })
    return
  }
  await refresh()
  toast.add({ title: 'Passkey removed', color: 'success' })
}

/** "MacBook · 13 Sep" — enough to tell two keys apart a year from now. */
function defaultName(): string {
  const when = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `This device · ${when}`
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const noPasskeys = computed(() => (data.value?.passkeys.length ?? 0) === 0)
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="text-lg font-semibold">
        Signing in
      </h2>
      <p class="text-sm text-muted">
        zäme has no passwords. You get in with a passkey, or with a link emailed to you.
      </p>
    </div>

    <UAlert
      v-if="noPasskeys && data && !data.emailConfigured"
      color="error"
      variant="subtle"
      icon="i-lucide-shield-alert"
      title="You have no working way back in"
      description="No passkey is registered and this instance cannot send email. Register a passkey now — if this session ends you will be locked out."
    />
    <UAlert
      v-else-if="noPasskeys"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="No passkey registered"
      description="Your only way in is an emailed link. Register a passkey so a mail outage can't lock you out."
    />
    <UAlert
      v-else-if="data && !data.emailConfigured"
      color="warning"
      variant="subtle"
      icon="i-lucide-mail-x"
      title="This instance can't send email"
      description="Your passkeys are the only way in — for you and for every guest who wanted a sign-in link. Wire up a mail transport."
    />

    <UAlert
      v-if="data?.bootstrapInstalled"
      color="warning"
      variant="subtle"
      icon="i-lucide-door-open"
      title="A recovery token is still installed"
      description="ZAEME_OWNER_BOOTSTRAP_TOKEN is set on this instance, so anybody holding it can add a passkey to your account. Remove it now that you are in."
    />

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="font-medium">
            Passkeys
          </p>
          <UBadge
            variant="subtle"
            color="neutral"
          >
            {{ data?.passkeys.length ?? 0 }}
          </UBadge>
        </div>
      </template>

      <div class="flex flex-col gap-4">
        <div
          v-if="status === 'pending'"
          class="text-sm text-muted"
        >
          Loading…
        </div>

        <p
          v-else-if="noPasskeys"
          class="text-sm text-muted"
        >
          None yet.
        </p>

        <ul
          v-else
          class="divide-y divide-default"
        >
          <li
            v-for="key in data?.passkeys"
            :key="key.id"
            class="py-3 flex items-center justify-between gap-3"
          >
            <div class="min-w-0">
              <p class="font-medium truncate">
                {{ key.name || 'Unnamed passkey' }}
              </p>
              <p class="text-xs text-muted">
                Added {{ formatDate(key.createdAt) }}
                · {{ key.deviceType === 'multiDevice' ? 'synced' : 'this device only' }}
                <span v-if="key.backedUp">· backed up</span>
              </p>
            </div>
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="sm"
              :aria-label="`Remove ${key.name || 'passkey'}`"
              @click="remove(key)"
            />
          </li>
        </ul>

        <UAlert
          v-if="errorMsg"
          color="error"
          variant="subtle"
          :description="errorMsg"
        />

        <div class="flex gap-2 flex-wrap">
          <UInput
            v-model="newName"
            :placeholder="defaultName()"
            class="flex-1 min-w-48"
          />
          <UButton
            icon="i-lucide-plus"
            :loading="adding"
            :disabled="!hasWebAuthn"
            @click="addPasskey"
          >
            Register a passkey
          </UButton>
        </div>
        <p
          v-if="!hasWebAuthn"
          class="text-xs text-muted"
        >
          This browser has no passkey support.
        </p>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <p class="font-medium">
          Email delivery
        </p>
      </template>
      <p class="text-sm">
        Transport: <span class="font-medium">{{ data?.mailTransport }}</span>
      </p>
      <p class="text-sm text-muted mt-1">
        <template v-if="data?.mailTransport === 'relay'">
          Through this platform's mail relay (Proton Bridge).
        </template>
        <template v-else-if="data?.mailTransport === 'resend'">
          Through Resend.
        </template>
        <template v-else>
          Nothing is configured — outgoing mail is written to the log and sent nowhere.
        </template>
      </p>
    </UCard>
  </div>
</template>
