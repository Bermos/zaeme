<script setup lang="ts">
/**
 * The media library across every event, and what it costs to keep.
 *
 * Photos and videos show as thumbnails; documents and tickets as rows, because
 * a PDF has no useful thumbnail. Download URLs are presigned per item and
 * short-lived — this page is a way to FIND a file, not a permanent link to one.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Media library' })

const type = ref<'' | 'photo' | 'video' | 'document' | 'ticket'>('')
const offset = ref(0)
const LIMIT = 48

const { data, pending } = await useFetch('/api/admin/media', {
  query: computed(() => ({ type: type.value || undefined, limit: LIMIT, offset: offset.value }))
})
const { data: storage } = await useFetch('/api/admin/storage')

watch(type, () => {
  offset.value = 0
})

const TYPE_ITEMS = [
  { label: 'Everything', value: '' },
  { label: '📷 Photos', value: 'photo' },
  { label: '🎞️ Videos', value: 'video' },
  { label: '📄 Documents', value: 'document' },
  { label: '🎟️ Tickets', value: 'ticket' }
]
const visual = (t: string) => t === 'photo' || t === 'video'
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid sm:grid-cols-3 gap-3">
      <UCard>
        <p class="text-2xl font-bold tabular-nums">
          {{ formatBytes(storage?.usage.total) }}
        </p>
        <p class="text-sm text-muted">
          stored across {{ data?.total ?? 0 }} file<span v-if="data?.total !== 1">s</span>
        </p>
      </UCard>
      <UCard>
        <p class="font-medium mb-1">
          By kind
        </p>
        <p
          v-for="row in storage?.usage.byType ?? []"
          :key="row.type"
          class="text-sm text-muted flex justify-between"
        >
          <span>{{ row.type }}</span>
          <span class="tabular-nums">{{ row.items }} · {{ formatBytes(row.bytes) }}</span>
        </p>
        <p
          v-if="storage?.usage.pending.items"
          class="text-sm text-warning mt-1"
        >
          {{ storage.usage.pending.items }} upload<span v-if="storage.usage.pending.items !== 1">s</span> never finished
          ({{ formatBytes(storage.usage.pending.bytes) }} claimed)
        </p>
      </UCard>
      <UCard>
        <p class="font-medium mb-1">
          Heaviest events
        </p>
        <p
          v-for="row in (storage?.usage.topEvents ?? []).slice(0, 4)"
          :key="row.slug"
          class="text-sm text-muted flex justify-between gap-2"
        >
          <NuxtLink
            :to="`/host/${row.slug}`"
            class="truncate hover:text-primary"
          >{{ row.title }}</NuxtLink>
          <span class="tabular-nums whitespace-nowrap">{{ formatBytes(row.bytes) }}</span>
        </p>
        <p
          v-if="storage && !storage.configured"
          class="text-sm text-warning"
        >
          No object store configured — metadata only.
        </p>
        <p
          v-else-if="storage?.bucket"
          class="text-xs text-muted mt-1"
        >
          bucket <span class="font-medium">{{ storage.bucket }}</span>
        </p>
      </UCard>
    </div>

    <USelect
      v-model="type"
      :items="TYPE_ITEMS"
      class="w-44"
    />

    <div
      v-if="data?.items.some(i => visual(i.type))"
      class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2"
    >
      <a
        v-for="item in data.items.filter(i => visual(i.type))"
        :key="item.id"
        :href="item.url ?? undefined"
        target="_blank"
        rel="noopener"
        class="group relative aspect-square rounded overflow-hidden bg-elevated"
        :title="`${item.fileName} · ${item.eventTitle} · ${formatBytes(item.sizeBytes)}`"
      >
        <img
          v-if="item.type === 'photo' && item.url"
          :src="item.url"
          :alt="item.caption ?? item.fileName"
          loading="lazy"
          class="w-full h-full object-cover"
        >
        <span
          v-else
          class="w-full h-full flex items-center justify-center text-2xl"
        >🎞️</span>
        <span class="absolute inset-x-0 bottom-0 bg-inverted/60 text-inverted text-[11px] px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition">
          {{ item.eventTitle }}
        </span>
      </a>
    </div>

    <UCard v-if="data?.items.some(i => !visual(i.type))">
      <template #header>
        <p class="font-semibold">
          Documents & tickets
        </p>
      </template>
      <div class="flex flex-col text-sm">
        <div
          v-for="item in data.items.filter(i => !visual(i.type))"
          :key="item.id"
          class="flex items-center justify-between gap-2 py-1.5 border-b border-default last:border-b-0"
        >
          <span class="min-w-0 truncate">
            {{ item.type === 'ticket' ? '🎟️' : '📄' }}
            <a
              v-if="item.url"
              :href="item.url"
              target="_blank"
              rel="noopener"
              class="font-medium hover:text-primary"
            >{{ item.fileName }}</a>
            <span
              v-else
              class="font-medium"
            >{{ item.fileName }}</span>
            <span class="text-muted"> · {{ item.eventTitle }}</span>
            <UBadge
              v-if="item.type === 'ticket' && !item.assignedRsvpId"
              size="sm"
              color="warning"
              variant="subtle"
            >
              unassigned
            </UBadge>
          </span>
          <span class="text-muted whitespace-nowrap">{{ formatBytes(item.sizeBytes) }}</span>
        </div>
      </div>
    </UCard>

    <p
      v-if="!pending && !data?.items.length"
      class="text-muted"
    >
      Nothing uploaded yet.
    </p>

    <div
      v-if="(data?.total ?? 0) > LIMIT"
      class="flex items-center justify-between"
    >
      <UButton
        size="xs"
        variant="ghost"
        :disabled="offset === 0"
        @click="offset = Math.max(0, offset - LIMIT)"
      >
        ← Newer
      </UButton>
      <span class="text-sm text-muted">{{ offset + 1 }}–{{ Math.min(offset + LIMIT, data?.total ?? 0) }} of {{ data?.total }}</span>
      <UButton
        size="xs"
        variant="ghost"
        :disabled="offset + LIMIT >= (data?.total ?? 0)"
        @click="offset = offset + LIMIT"
      >
        Older →
      </UButton>
    </div>
  </div>
</template>
