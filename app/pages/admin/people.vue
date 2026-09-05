<script setup lang="ts">
/**
 * The person directory. Guest identity in this app is the lowercased EMAIL —
 * an account is optional and only unlocks /me and hosting — so that is what
 * this is keyed by, assembled from everything a person leaves behind: answers,
 * links, series memberships, chat.
 *
 * Clicking a row opens their whole history without leaving the page.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'People' })

const q = ref('')
const { data, pending } = await useFetch('/api/admin/people', { query: computed(() => ({ q: q.value || undefined })) })

const selected = ref<string | null>(null)
const { data: person, pending: personPending } = await useFetch(
  () => `/api/admin/people/${encodeURIComponent(selected.value ?? '')}`,
  { immediate: false, watch: [selected] }
)

function open(email: string) {
  selected.value = selected.value === email ? null : email
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <UInput
      v-model="q"
      placeholder="Search a name or an email"
      icon="i-lucide-search"
      class="max-w-sm"
    />

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <p class="font-semibold">
            {{ data?.people.length ?? 0 }} {{ (data?.people.length ?? 0) === 1 ? 'person' : 'people' }}
          </p>
          <p class="text-sm text-muted">
            Identity is the email; an account is optional.
          </p>
        </div>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-muted text-left">
            <tr class="border-b border-default">
              <th class="py-2 pr-3 font-medium">
                Person
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Yes / RSVPs
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Links
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Series
              </th>
              <th class="py-2 px-3 font-medium text-right">
                Messages
              </th>
              <th class="py-2 pl-3 font-medium">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="p in data?.people ?? []"
              :key="p.email"
            >
              <tr
                class="border-b border-default cursor-pointer hover:bg-elevated/50"
                @click="open(p.email)"
              >
                <td class="py-2 pr-3">
                  <p class="font-medium">
                    {{ p.name || p.email }}
                    <UBadge
                      v-if="p.isOwner"
                      variant="subtle"
                      color="primary"
                      size="sm"
                    >
                      owner
                    </UBadge>
                    <UBadge
                      v-else-if="p.hasAccount"
                      variant="subtle"
                      color="neutral"
                      size="sm"
                    >
                      account
                    </UBadge>
                  </p>
                  <p class="text-muted">
                    {{ p.email }}
                  </p>
                </td>
                <td class="py-2 px-3 text-right tabular-nums">
                  {{ p.yesCount }}<span class="text-muted">/{{ p.rsvpCount }}</span>
                </td>
                <td class="py-2 px-3 text-right tabular-nums">
                  {{ p.activeInvites }}<span class="text-muted">/{{ p.inviteCount }}</span>
                </td>
                <td class="py-2 px-3 text-right tabular-nums">
                  {{ p.seriesCount }}
                </td>
                <td class="py-2 px-3 text-right tabular-nums">
                  {{ p.messageCount }}
                </td>
                <td class="py-2 pl-3 whitespace-nowrap text-muted">
                  {{ formatAgo(p.lastSeen) }}
                </td>
              </tr>
              <tr v-if="selected === p.email">
                <td
                  colspan="6"
                  class="bg-elevated/40 px-3 py-3"
                >
                  <p
                    v-if="personPending"
                    class="text-muted"
                  >
                    Loading…
                  </p>
                  <div
                    v-else-if="person"
                    class="grid sm:grid-cols-3 gap-4"
                  >
                    <div>
                      <p class="font-medium mb-1">
                        Answers
                      </p>
                      <p
                        v-for="r in person.rsvps"
                        :key="r.id"
                        class="text-muted"
                      >
                        <NuxtLink
                          :to="`/host/${r.eventSlug}`"
                          class="hover:text-primary"
                        >{{ r.eventTitle }}</NuxtLink>
                        — {{ r.status }}<span v-if="r.plusOne"> +1</span>
                      </p>
                      <p
                        v-if="!person.rsvps.length"
                        class="text-muted"
                      >
                        None yet.
                      </p>
                    </div>
                    <div>
                      <p class="font-medium mb-1">
                        Their links
                      </p>
                      <p
                        v-for="i in person.invites"
                        :key="i.id"
                        class="text-muted"
                      >
                        {{ i.eventTitle }} — {{ i.revokedAt ? 'revoked' : 'live' }} · {{ i.usedCount }} use<span v-if="i.usedCount !== 1">s</span>
                      </p>
                      <p
                        v-if="!person.invites.length"
                        class="text-muted"
                      >
                        None.
                      </p>
                    </div>
                    <div>
                      <p class="font-medium mb-1">
                        Standing crews
                      </p>
                      <p
                        v-for="m in person.memberships"
                        :key="m.id"
                        class="text-muted"
                      >
                        {{ m.seriesTitle }}
                      </p>
                      <p
                        v-if="!person.memberships.length"
                        class="text-muted"
                      >
                        None.
                      </p>
                      <p
                        v-if="person.account"
                        class="text-muted mt-2"
                      >
                        Account since {{ formatWhen(person.account.createdAt, { time: false }) }}
                      </p>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <p
          v-if="!pending && !data?.people.length"
          class="text-muted py-3"
        >
          Nobody yet — invite somebody.
        </p>
      </div>
    </UCard>
  </div>
</template>
