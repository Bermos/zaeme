<script setup lang="ts">
/** Who's coming — names visible to everyone with the link. */
interface Attendee {
  name: string
  status: 'yes' | 'maybe' | 'no' | 'cheering'
  plusOne: boolean
  plusOneName: string | null
}
interface Summary { yes: number, maybe: number, no: number, cheering: number, total: number, headcount: number }

defineProps<{ attendees: Attendee[], summary: Summary }>()

const STATUS_BADGE: Record<string, { label: string, color: 'success' | 'warning' | 'info' }> = {
  yes: { label: 'in', color: 'success' },
  maybe: { label: 'maybe', color: 'warning' },
  cheering: { label: 'cheering', color: 'info' }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          Who's coming
        </p>
        <UBadge
          variant="subtle"
          color="success"
        >
          {{ summary.headcount }} going
        </UBadge>
      </div>
    </template>

    <div
      v-if="attendees.length"
      class="flex flex-wrap gap-2"
    >
      <UBadge
        v-for="(a, i) in attendees"
        :key="i"
        :color="STATUS_BADGE[a.status]?.color ?? 'neutral'"
        variant="soft"
        size="lg"
      >
        {{ a.name }}<template v-if="a.plusOne">
          +1<template v-if="a.plusOneName">
            ({{ a.plusOneName }})
          </template>
        </template>
        <span class="opacity-60 ml-1 text-xs">{{ STATUS_BADGE[a.status]?.label }}</span>
      </UBadge>
    </div>
    <p
      v-else
      class="text-sm text-muted"
    >
      No RSVPs yet — be the first!
    </p>
  </UCard>
</template>
