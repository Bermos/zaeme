<script setup lang="ts">
/**
 * A public event page (concerts mostly): open to the world with real OG meta;
 * signed-in zäme users get the "I go" and — once going — the coordination
 * chat, so people who know each other can find each other.
 */
const route = useRoute()
const slug = route.params.slug as string

const { data: page, error, refresh } = await useFetch(`/api/public/events/${slug}`)
const session = useSession()
const toast = useToast()

useSeoMeta({
  title: () => page.value?.event.title ?? 'Event',
  description: () => page.value?.event.description?.slice(0, 200) ?? 'A public event on zäme.',
  ogTitle: () => page.value ? `${page.value.event.title} · zäme` : 'zäme',
  ogDescription: () => page.value?.event.description?.slice(0, 200) ?? undefined,
  ogImage: () => page.value?.event.posterUrl ?? undefined
})

const signedIn = computed(() => !!session.value.data?.user)
const myEmail = computed(() => session.value.data?.user?.email?.toLowerCase() ?? null)
const myStatus = computed(() => {
  // The public payload exposes names+status only; "am I going" is tracked
  // client-side from my own actions this session, or shown after refresh via
  // the going list containing my display name. Keep it simple: track locally.
  return marked.value
})
const marked = ref<string | null>(null)

const isConcert = computed(() => page.value?.event.type === 'concert')
const going = computed(() => (page.value?.attendees ?? []).filter(a => a.status === 'yes'))
const cheering = computed(() => (page.value?.attendees ?? []).filter(a => a.status === 'cheering'))

const saving = ref<string | null>(null)
async function iGo(status: 'yes' | 'cheering' | 'no') {
  saving.value = status
  try {
    await $fetch(`/api/public/events/${slug}/rsvp`, { method: 'POST', body: { status } })
    marked.value = status
    await refresh()
    toast.add({
      title: status === 'no' ? 'Noted.' : status === 'cheering' ? 'Cheering counts! 📣' : 'See you there! 🎉',
      color: 'success'
    })
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not save that', color: 'error' })
  } finally {
    saving.value = null
  }
}

function when(iso: string | Date | null | undefined): string | null {
  return iso
    ? new Date(iso).toLocaleString('en-CH', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null
}
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-8 flex flex-col gap-6">
    <UAlert
      v-if="error"
      color="warning"
      variant="subtle"
      title="Hmm."
      description="This event doesn't exist or isn't public."
    />

    <template v-else-if="page">
      <div class="flex flex-col gap-4">
        <img
          v-if="page.event.posterUrl"
          :src="page.event.posterUrl"
          :alt="`Poster for ${page.event.title}`"
          class="w-full max-h-96 object-cover rounded-lg"
        >
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <h1 class="text-3xl font-bold">
              {{ page.event.title }}
            </h1>
            <UBadge
              v-if="isConcert"
              color="info"
              variant="subtle"
            >
              concert
            </UBadge>
            <UBadge
              v-if="page.event.status === 'completed'"
              color="neutral"
              variant="subtle"
            >
              happened
            </UBadge>
          </div>
          <p
            v-if="page.event.performerNote"
            class="text-muted mt-1"
          >
            {{ page.event.performerNote }}
          </p>
        </div>

        <div class="flex flex-col gap-1 text-sm">
          <p
            v-if="when(page.event.startsAt)"
            class="font-medium"
          >
            🗓️ {{ when(page.event.startsAt) }}
          </p>
          <p v-if="page.event.location">
            📍 {{ page.event.location }}
          </p>
          <p
            v-if="page.event.venueStation"
            class="text-muted"
          >
            🚉 {{ page.event.venueStation }}
          </p>
        </div>

        <p
          v-if="page.event.description"
          class="whitespace-pre-line text-muted"
        >
          {{ page.event.description }}
        </p>

        <div v-if="page.event.ticketUrl">
          <UButton
            :to="page.event.ticketUrl"
            external
            target="_blank"
            variant="outline"
            size="sm"
          >
            🎟️ Get tickets
          </UButton>
        </div>
      </div>

      <!-- I go -->
      <UCard v-if="page.event.status === 'published'">
        <template #header>
          <p class="font-semibold">
            Are you coming?
          </p>
        </template>
        <div
          v-if="signedIn"
          class="flex flex-col gap-2"
        >
          <div class="flex gap-2 flex-wrap">
            <UButton
              :loading="saving === 'yes'"
              :variant="myStatus === 'yes' ? 'solid' : 'outline'"
              color="success"
              @click="iGo('yes')"
            >
              I go 🙌
            </UButton>
            <UButton
              v-if="isConcert"
              :loading="saving === 'cheering'"
              :variant="myStatus === 'cheering' ? 'solid' : 'outline'"
              color="info"
              @click="iGo('cheering')"
            >
              Cheering from afar 📣
            </UButton>
          </div>
          <p class="text-xs text-muted">
            Your name shows in the "going" list so friends can find you.
          </p>
        </div>
        <UAlert
          v-else
          color="neutral"
          variant="subtle"
          description="Sign in to say you're going and see who else will be there."
        >
          <template #actions>
            <UButton
              :to="`/login?redirect=/e/${slug}`"
              size="xs"
              variant="outline"
            >
              Sign in
            </UButton>
          </template>
        </UAlert>
      </UCard>

      <!-- Who's going -->
      <UCard v-if="going.length || cheering.length">
        <template #header>
          <div class="flex items-center justify-between">
            <p class="font-semibold">
              Who's there
            </p>
            <UBadge
              variant="subtle"
              color="success"
            >
              {{ page.summary.headcount }} going
            </UBadge>
          </div>
        </template>
        <div class="flex flex-col gap-2 text-sm">
          <p
            v-if="going.length"
            class="flex flex-wrap gap-1 items-center"
          >
            🙌
            <UBadge
              v-for="(a, i) in going"
              :key="`g${i}`"
              variant="subtle"
              color="neutral"
            >
              {{ a.name }}
            </UBadge>
          </p>
          <p
            v-if="cheering.length"
            class="flex flex-wrap gap-1 items-center"
          >
            📣
            <UBadge
              v-for="(a, i) in cheering"
              :key="`c${i}`"
              variant="subtle"
              color="neutral"
            >
              {{ a.name }}
            </UBadge>
          </p>
        </div>
      </UCard>

      <!-- Coordination chat: attendees only -->
      <EventChat
        v-if="signedIn"
        :list-url="`/api/public/events/${slug}/messages`"
        :post-url="`/api/public/events/${slug}/messages`"
        :viewer-email="myEmail"
        :locked-note="myStatus || page.event.status !== 'published' ? null : 'Say \'I go\' first — then coordinate here with the others.'"
      />
    </template>
  </div>
</template>
