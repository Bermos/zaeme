<script setup lang="ts">
/**
 * The Enterprise link (ADR-0036). Enterprise reaches this instance over HTTP
 * with a service token and drives `/api/v1`; nothing about that is visible
 * anywhere else in the app, which makes "is it even wired up?" an unanswerable
 * question — until here.
 *
 * The token is NEVER shown. What is shown is a fingerprint: the first 12 hex of
 * its SHA-256, which the owner can recompute from their own copy
 * (`printf %s "$TOKEN" | sha256sum`) to confirm the two halves match. There is
 * no rotate button either — the secret is an environment variable on two
 * systems, so rotation is a deploy, not a click.
 */
definePageMeta({ layout: 'admin', middleware: 'owner-only' })
useSeoMeta({ title: 'Enterprise link' })

const { data, pending } = await useFetch('/api/admin/integration')

/**
 * A candidate secret, generated in the browser and never sent anywhere. It is
 * a convenience for "I need a new one to paste into both env files", not an
 * action on this instance — which is why nothing here saves it.
 */
const suggestion = ref('')
function suggest() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  suggestion.value = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p
      v-if="pending && !data"
      class="text-muted"
    >
      Loading…
    </p>

    <template v-else-if="data">
      <UAlert
        :color="data.credential.configured && data.credential.ownerIdConfigured ? 'success' : 'warning'"
        variant="subtle"
        :icon="data.credential.configured && data.credential.ownerIdConfigured ? 'i-lucide-plug-zap' : 'i-lucide-unplug'"
        :title="data.credential.configured && data.credential.ownerIdConfigured
          ? 'The machine API is configured'
          : 'The machine API is closed'"
        :description="data.credential.configured && data.credential.ownerIdConfigured
          ? 'Enterprise can drive this instance with its service token.'
          : 'Without both ZAEME_SERVICE_TOKEN and ZAEME_ENTERPRISE_OWNER_ID set, every /api/v1 call answers 401 or 403 — an unconfigured instance is closed, not open.'"
      />

      <div class="grid sm:grid-cols-2 gap-3">
        <UCard>
          <template #header>
            <p class="font-semibold">
              The credential
            </p>
          </template>
          <dl class="text-sm flex flex-col gap-2">
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Service token
              </dt>
              <dd>
                <UBadge
                  :color="data.credential.configured ? 'success' : 'error'"
                  variant="subtle"
                >
                  {{ data.credential.configured ? 'set' : 'missing' }}
                </UBadge>
              </dd>
            </div>
            <div
              v-if="data.credential.fingerprint"
              class="flex justify-between gap-2"
            >
              <dt class="text-muted">
                Fingerprint (sha256)
              </dt>
              <dd class="font-mono">
                {{ data.credential.fingerprint }}…
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Acts for Enterprise owner
              </dt>
              <dd class="font-mono truncate">
                {{ data.credential.enterpriseOwnerId ?? '— not mapped —' }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Resolves to planner
              </dt>
              <dd class="text-right">
                {{ data.planner ? `${data.planner.name} (${data.planner.email})` : 'no owner account yet' }}
              </dd>
            </div>
          </dl>
          <template #footer>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <UButton
                  size="xs"
                  variant="outline"
                  icon="i-lucide-dice-5"
                  @click="suggest"
                >
                  Generate a candidate token
                </UButton>
                <span class="text-xs text-muted">generated here, sent nowhere</span>
              </div>
              <UInput
                v-if="suggestion"
                :model-value="suggestion"
                readonly
                class="font-mono"
                @focus="(e: FocusEvent) => (e.target as HTMLInputElement).select()"
              />
              <p
                v-if="suggestion"
                class="text-xs text-muted"
              >
                Put it in <span class="font-mono">ZAEME_SERVICE_TOKEN</span> on BOTH systems and redeploy — the
                fingerprint above is how you confirm it landed.
              </p>
            </div>
          </template>
        </UCard>

        <UCard>
          <template #header>
            <p class="font-semibold">
              Has Enterprise been calling?
            </p>
          </template>
          <dl class="text-sm flex flex-col gap-2">
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Last write
              </dt>
              <dd>{{ formatAgo(data.activity.lastAt) }}</dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Writes (30 days)
              </dt>
              <dd class="tabular-nums">
                {{ data.activity.writes }}
              </dd>
            </div>
            <div class="flex justify-between gap-2">
              <dt class="text-muted">
                Refused (30 days)
              </dt>
              <dd
                class="tabular-nums"
                :class="data.activity.failures ? 'text-warning font-medium' : ''"
              >
                {{ data.activity.failures }}
              </dd>
            </div>
          </dl>
          <p class="text-xs text-muted mt-3">
            Reads are not counted: Enterprise fetches the snapshot on every XO turn, and logging that would
            bury everything else. See the
            <NuxtLink
              to="/admin/audit?surface=machine"
              class="text-primary hover:underline"
            >
              machine entries in the audit
            </NuxtLink>.
          </p>
        </UCard>
      </div>

      <UCard>
        <template #header>
          <p class="font-semibold">
            The contract
          </p>
        </template>
        <p class="text-sm text-muted">
          <span class="font-mono">docs/zaeme-api.openapi.yaml</span> in this repository is the source of truth for
          <span class="font-mono">/api/v1</span>; Enterprise generates its MCP tool surface from a vendored copy.
          This instance serves the live document, unauthenticated, so the two can be compared.
        </p>
        <template #footer>
          <UButton
            :to="data.contractUrl"
            external
            target="_blank"
            size="xs"
            variant="outline"
            icon="i-lucide-file-code-2"
          >
            Open the served contract
          </UButton>
        </template>
      </UCard>
    </template>
  </div>
</template>
