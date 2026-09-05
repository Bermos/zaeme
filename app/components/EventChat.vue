<script setup lang="ts">
/**
 * The event group chat — one thread per event, for coordinating ("who's
 * driving?", "I'll be 10 late"). Plain polling while the panel is mounted;
 * no websockets on the guest surface, and none needed.
 *
 * Works on every surface via props: the invite page posts with the guest
 * identity (`needsIdentity`), the host page and public pages post with the
 * session (server derives the author).
 */
interface ChatMessage {
  id: string
  authorName: string
  authorEmail: string
  isHost: boolean
  body: string
  createdAt: string | Date
}

const props = defineProps<{
  listUrl: string
  postUrl: string
  /** Attach the guest identity (name+email) to posts — invite-token surface. */
  needsIdentity?: boolean
  /** Highlight this email's messages as "you". */
  viewerEmail?: string | null
  /** A friendly note shown when the viewer cannot post yet. */
  lockedNote?: string | null
}>()

const { identity, complete } = useGuestIdentity()
const toast = useToast()

const messages = ref<ChatMessage[]>([])
const draft = ref('')
const sending = ref(false)
const loaded = ref(false)

const canPost = computed(() => !props.lockedNote && (!props.needsIdentity || complete.value))

async function load() {
  try {
    const res = await $fetch<{ messages: ChatMessage[] }>(props.listUrl)
    messages.value = res.messages
    loaded.value = true
  } catch { /* transient — next poll retries */ }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  load()
  timer = setInterval(load, 7000)
})
onBeforeUnmount(() => clearInterval(timer))

async function send() {
  const body = draft.value.trim()
  if (!body || !canPost.value) return
  sending.value = true
  try {
    await $fetch(props.postUrl, {
      method: 'POST',
      body: props.needsIdentity
        ? { body, guestName: identity.value.name, guestEmail: identity.value.email }
        : { body }
    })
    draft.value = ''
    await load()
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not send that', color: 'error' })
  } finally {
    sending.value = false
  }
}

function mine(m: ChatMessage): boolean {
  const viewer = props.viewerEmail ?? (props.needsIdentity ? identity.value.email : null)
  return !!viewer && m.authorEmail === viewer.toLowerCase()
}

function at(value: string | Date): string {
  return new Date(value).toLocaleString('en-CH', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          💬 Group chat
        </p>
        <p class="text-sm text-muted">
          Coordinate rides, timing, everything else.
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-3">
      <div
        v-if="messages.length"
        class="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1"
      >
        <div
          v-for="m in messages"
          :key="m.id"
          class="rounded-lg px-3 py-2 text-sm max-w-[85%]"
          :class="mine(m) ? 'self-end bg-primary/10' : 'self-start bg-elevated'"
        >
          <p class="text-xs text-muted mb-0.5">
            <span class="font-medium">{{ mine(m) ? 'You' : m.authorName }}</span>
            <UBadge
              v-if="m.isHost"
              size="sm"
              variant="subtle"
              class="ml-1"
            >
              host
            </UBadge>
            <span class="ml-2">{{ at(m.createdAt) }}</span>
          </p>
          <p class="whitespace-pre-line">
            {{ m.body }}
          </p>
        </div>
      </div>
      <p
        v-else-if="loaded"
        class="text-sm text-muted"
      >
        Nothing here yet — say hi!
      </p>

      <UAlert
        v-if="lockedNote"
        color="neutral"
        variant="subtle"
        :description="lockedNote"
      />
      <form
        v-else
        class="flex gap-2"
        @submit.prevent="send"
      >
        <UInput
          v-model="draft"
          placeholder="Write a message…"
          class="flex-1"
          :disabled="!canPost"
        />
        <UButton
          type="submit"
          :loading="sending"
          :disabled="!draft.trim() || !canPost"
        >
          Send
        </UButton>
      </form>
      <p
        v-if="needsIdentity && !complete && !lockedNote"
        class="text-xs text-muted"
      >
        Fill in your name and email above to join the chat.
      </p>
    </div>
  </UCard>
</template>
