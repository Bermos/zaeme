<script setup lang="ts">
/**
 * The series control room (host side): the standing crew who get invited to
 * every showing, and the programme — schedule the next showing, see how past
 * ones filled up. No date poll here by design: the showtime IS the showtime.
 */
interface Member { id: string, name: string, email: string }
interface Occurrence {
  id: string
  slug: string
  title: string
  status: string
  startsAt: string | Date | null
  yesCount: number
}

const props = defineProps<{
  slug: string
  cadence: string | null
  members: Member[]
  occurrences: Occurrence[]
}>()
const emit = defineEmits<{ updated: [] }>()

const toast = useToast()

/* ---- members ---- */
const memberName = ref('')
const memberEmail = ref('')
const addingMember = ref(false)
async function addMember() {
  if (!memberName.value || !memberEmail.value) return
  addingMember.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/members`, {
      method: 'POST',
      body: { name: memberName.value, email: memberEmail.value }
    })
    memberName.value = ''
    memberEmail.value = ''
    emit('updated')
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not add them', color: 'error' })
  } finally {
    addingMember.value = false
  }
}
async function removeMember(id: string) {
  await $fetch(`/api/host/events/${props.slug}/members/${id}`, { method: 'DELETE' })
  emit('updated')
}

/* ---- schedule a showing ---- */
const showTitle = ref('')
const showDate = ref('')
const showPoster = ref('')
const showDescription = ref('')
const scheduling = ref(false)
async function schedule() {
  if (!showTitle.value || !showDate.value) return
  scheduling.value = true
  try {
    await $fetch(`/api/host/events/${props.slug}/occurrences`, {
      method: 'POST',
      body: {
        title: showTitle.value,
        startsAt: new Date(showDate.value).toISOString(),
        posterUrl: showPoster.value || null,
        description: showDescription.value || null
      }
    })
    toast.add({ title: `Showing scheduled — ${props.members.length} invite${props.members.length === 1 ? '' : 's'} on the way 🍿`, color: 'success' })
    showTitle.value = ''
    showDate.value = ''
    showPoster.value = ''
    showDescription.value = ''
    emit('updated')
  } catch (e) {
    toast.add({ title: (e as { data?: { message?: string } }).data?.message ?? 'Could not schedule it', color: 'error' })
  } finally {
    scheduling.value = false
  }
}

function when(iso: string | Date | null): string {
  return iso ? new Date(iso).toLocaleString('en-CH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
}
</script>

<template>
  <UCard>
    <template #header>
      <div>
        <p class="font-semibold">
          🍿 The cinema
        </p>
        <p class="text-sm text-muted">
          {{ cadence || 'Your recurring series' }} — the crew below gets a personal invite to every showing.
        </p>
      </div>
    </template>

    <div class="flex flex-col gap-4">
      <!-- The crew -->
      <div class="flex flex-col gap-2">
        <p class="text-sm font-medium">
          The crew ({{ members.length }})
        </p>
        <div
          v-for="m in members"
          :key="m.id"
          class="flex items-center justify-between gap-2 py-1 text-sm"
        >
          <p>{{ m.name }} <span class="text-muted">{{ m.email }}</span></p>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            @click="removeMember(m.id)"
          >
            ✕
          </UButton>
        </div>
        <form
          class="flex gap-2"
          @submit.prevent="addMember"
        >
          <UInput
            v-model="memberName"
            placeholder="Name"
            class="flex-1"
          />
          <UInput
            v-model="memberEmail"
            type="email"
            placeholder="Email"
            class="flex-1"
          />
          <UButton
            type="submit"
            :loading="addingMember"
            :disabled="!memberName || !memberEmail"
            size="sm"
          >
            Add
          </UButton>
        </form>
      </div>

      <!-- Schedule the next showing -->
      <div class="flex flex-col gap-2 pt-2 border-t border-default">
        <p class="text-sm font-medium">
          Schedule the next showing
        </p>
        <form
          class="flex flex-col gap-2"
          @submit.prevent="schedule"
        >
          <div class="flex gap-2">
            <UInput
              v-model="showTitle"
              placeholder="Heat (1995)"
              class="flex-1"
            />
            <UInput
              v-model="showDate"
              type="datetime-local"
              class="w-52"
            />
          </div>
          <UInput
            v-model="showPoster"
            type="url"
            placeholder="Poster URL (optional)"
          />
          <UTextarea
            v-model="showDescription"
            :rows="2"
            placeholder="Why this one? (optional — the series pitch is used otherwise)"
          />
          <UButton
            type="submit"
            :loading="scheduling"
            :disabled="!showTitle || !showDate"
            class="self-start"
          >
            🎬 Schedule & invite the crew
          </UButton>
        </form>
      </div>

      <!-- The programme -->
      <div
        v-if="occurrences.length"
        class="flex flex-col gap-1 pt-2 border-t border-default"
      >
        <p class="text-sm font-medium">
          Programme
        </p>
        <NuxtLink
          v-for="o in occurrences"
          :key="o.id"
          :to="`/host/${o.slug}`"
          class="flex items-center justify-between gap-2 py-1.5 text-sm hover:bg-elevated rounded px-1 -mx-1"
        >
          <p class="font-medium truncate">{{ o.title }}</p>
          <p class="text-muted shrink-0">
            {{ when(o.startsAt) }} · 🙌 {{ o.yesCount }}
            <UBadge
              v-if="o.status === 'cancelled'"
              size="sm"
              color="error"
              variant="subtle"
            >cancelled</UBadge>
          </p>
        </NuxtLink>
      </div>
    </div>
  </UCard>
</template>
