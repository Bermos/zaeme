<script setup lang="ts">
/** zäme's front door — most guests arrive on /i/[token]; this is for everyone else. */
const session = useSession()

useSeoMeta({
  title: 'zäme',
  description: 'Plan it together — movie nights, dinners, concerts. Find a date, see who\'s coming, split who brings what.'
})
</script>

<template>
  <div class="max-w-3xl mx-auto px-4 py-16 flex flex-col gap-8 items-start">
    <div>
      <h1 class="text-4xl font-bold tracking-tight">
        zäme
      </h1>
      <p class="text-lg text-muted mt-2">
        <em>Swiss German for "together".</em> Plan movie nights, dinners and
        gatherings with your people — find a date that works, see who's coming,
        and sort out who brings what.
      </p>
    </div>

    <ul class="text-muted flex flex-col gap-2">
      <li>🗓️ <span class="font-medium text-highlighted">Find a date</span> — everyone marks what works, the host locks it.</li>
      <li>🎬 <span class="font-medium text-highlighted">Post the plan</span> — the film, the poster, the schedule.</li>
      <li>🙋 <span class="font-medium text-highlighted">See who's in</span> — RSVPs visible to all invited friends.</li>
      <li>🍲 <span class="font-medium text-highlighted">Bring list</span> — claim the snacks, drinks and dips.</li>
      <li>🧳 <span class="font-medium text-highlighted">Trips</span> — itinerary day by day, budget split fairly.</li>
      <li>🍿 <span class="font-medium text-highlighted">Movie-night series</span> — your crew, a real little cinema.</li>
      <li>💬 <span class="font-medium text-highlighted">Group chat</span> — coordinate rides, timing, everything.</li>
    </ul>

    <div class="flex gap-2">
      <template v-if="session.data?.user">
        <UButton
          to="/host/new"
          size="lg"
        >
          Plan something
        </UButton>
        <UButton
          to="/me"
          size="lg"
          variant="outline"
        >
          My invites
        </UButton>
      </template>
      <template v-else>
        <UButton
          to="/login"
          size="lg"
        >
          Sign in to host
        </UButton>
      </template>
      <UButton
        to="/concerts"
        size="lg"
        variant="ghost"
      >
        🎤 Concerts
      </UButton>
    </div>

    <p class="text-sm text-muted">
      Got an invite link? Just open it — no account needed.
    </p>
  </div>
</template>
