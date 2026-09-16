# Roadmap

Development is roughly ordered by dependency — each phase builds on the last. Items within a phase can be parallelised.

Phases 0–4 and 6–8 are done. Phase 5 (Fahrgemeinschaft) and phase 9 (to-do and
pack lists) are the two big unbuilt features; phases 10–11 changed shape and
phase 12 is partly done.

> **Status note.** zäme spent 2026-07 to 2026-09 inside the Enterprise monorepo
> and came home as a single flat package. Several phases shipped during that
> time, and several things shipped that no phase anticipated — those are listed
> under [Shipped outside the phases](#shipped-outside-the-phases). The current
> batch of work is tracked in [issue #24](https://github.com/Bermos/zaeme/issues/24),
> not here; this file stays a roadmap.

-----

## Phase 0 — Foundation

- [x] Initialise the Nuxt 4 app — a single flat package (no pnpm workspace, no `packages/*`, no layers)
- [x] Configure `server/database/` with Drizzle + `node-postgres` against a plain `DATABASE_URL`
- [x] Set up Better Auth (magic link + passkey, no passwords)
- [x] First-run `/setup` page — the first account claims the instance, with a passkey
- [x] Configure Nuxt UI + Tailwind CSS
- [x] `.env.example` with all variables documented

-----

## Phase 1 — Event Core

- [x] Event schema + Drizzle migrations
- [x] Event creation form (title, type, description, dates, location)
- [x] Draft / brainstorm mode — private, planners only
- [x] Event detail page (planner view)
- [x] Event status transitions (draft → published → completed → cancelled)
- [x] Co-planner invite — add user as co-planner with role
- [x] Planner permission checks on all API routes
- [x] Event list / dashboard for the host
- [x] Event slug generation + collision handling
- [x] Series support — parent event + occurrence creation
- [x] Concert event type — `ticketUrl`, `performerNote`, public visibility default

-----

## Phase 2 — Invites & RSVP

- [x] Invite token generation per event
- [x] Public invite page (`/i/[token]`) — SSR, OG meta tags
- [x] RSVP flow — yes / maybe / no / cheering (concert)
- [x] Guest RSVP (no account required) — name + email + token
- [x] Registered user RSVP
- [x] `+1` support on RSVP
- [x] Dietary / accessibility / note field on RSVP
- [x] RSVP management for planners (list, edit, remove)
- [x] The invite email links straight into the RSVP page — the capability URL *is* the credential, so there is nothing to sign in to

-----

## Phase 3 — Calendar & Email

- [x] Set up outgoing mail in `server/emails/` + React Email templates
- [x] Three transports with a documented fallback order: mail relay → Resend → dry run to stdout
- [x] Invite email template
- [x] RSVP confirmation email template
- [x] Event reminder email template (48h before)
- [x] Event cancelled email template
- [x] Magic link email template
- [x] Set up Inngest + define the event vocabulary
- [x] `rsvp.confirmed` job — send confirmation email
- [x] `event.published` job — send invite emails, schedule the reminder
- [x] `event.reminder` job — 48h reminder
- [x] `event.cancelled` job — cancellation notification
- [x] `server/utils/ics.ts` — iCal generation
- [x] `.ics` attachment on RSVP confirmation email
- [x] Per-person iCal feed (`GET /calendar/[token].ics`)
- [x] Per-event `.ics` behind the invite link (`GET /i/[token]/calendar.ics`)
- [x] iCal token generation + storage

-----

## Phase 4 — Date Finder *(shipped)*

- [x] Date poll creation (options, note, ordering)
- [x] Poll page — accessible to guests via the event invite link
- [x] Three-way response: yes / if need be / no
- [x] Poll results view — a per-option tally of yes / if need be / no
- [x] Lock the poll on an option the host picks + decide the date
- [x] Promote the decided option to `event.startsAt` / `event.endsAt`
- [x] Transition event status `polling → published` on lock
- [x] Open the event up to the wider invite wave after the lock (`open-up`)
- [ ] Weighted scoring and an automatic recommendation (the tally is shown; the host reads it)
- [ ] Auto-close the poll at a deadline (there is no deadline column and no scheduled job)
- [ ] Date poll invite email template
- [ ] Date poll decided email template (with `.ics` attachment)

-----

## Phase 5 — Fahrgemeinschaft

Nothing here is built. There is no origin-station column, no transit client and
no clustering job.

- [ ] Origin location input on RSVP form (autocomplete via SBB locations API)
- [ ] transport.opendata.ch client (connections, stationboard, locations)
- [ ] Travel group clustering algorithm (group by hub station)
- [ ] `travel.recluster` job — runs on each RSVP with a location
- [ ] `sbb.refresh` job — daily refresh of cached connections
- [ ] Travel groups display on event page (planner + attendee view)
- [ ] “I’m taking this train” commitment toggle
- [ ] Carpooling mode — driver seats, request to join
- [ ] Fallback for deployments outside Switzerland — show a maps directions link only
- [ ] Travel group chat thread (sub-thread of main event chat)

-----

## Phase 6 — Chat *(shipped, minus the extras)*

- [x] Chat message schema + API routes on all three human surfaces (host, invite, public)
- [x] Chat UI component (`EventChat.vue`, stock Nuxt UI)
- [x] Guest chat, authenticated by the invite capability link
- [x] Host messages badged as the host (`authorUserId`)
- [ ] Real-time delivery — messages are fetched, not streamed; there is no SSE endpoint and no WebSocket
- [ ] Reply threading (`replyToId`)
- [ ] Soft delete (planner can remove messages)
- [ ] Announcement mode — planner-only broadcast, no replies
- [ ] Unread message indicator

-----

## Phase 7 — Media & Documents

- [x] Object storage configuration + presigned upload API
- [x] Upload confirmation API
- [x] Photo / video gallery per event
- [x] Document upload (PDFs, booking confirmations)
- [x] Ticket upload + assignment to attendees — one ticket may cover several (#36)
- [x] Guest upload via the invite link
- [x] `takenAt` recorded on upload for chronological display
- [x] Caption set at upload time
- [x] Planner media moderation (delete any item)
- [ ] Edit a caption after upload

-----

## Phase 8 — Timeline / Itinerary

- [x] `events_timeline_item` schema + Drizzle migrations
- [x] Timeline CRUD on the host surface, including `PATCH` — edit in place without losing the item's id or its pinned media
- [x] Planner-scoped write access; read access for all event participants
- [x] Item types: transport, activity, accommodation, meal, other
- [x] `sortOrder` field — move up / move down in the host UI
- [x] Optional icon override
- [x] `EventTimeline.vue` — timeline UI with type icons
- [x] Media pinning — attach a media item to a timeline step via `timelineItemId`
- [ ] Drag-to-reorder (reordering is up/down controls today)
- [ ] `pollId` poll-conditional items — the column exists; nothing renders a "pending" state from it

-----

## Phase 9 — To-Do Lists

Nothing here is built. The bring list (`events_contribution`) is a different,
shipped feature — it coordinates what guests bring, not what the host must do.

- [ ] Organizer to-do list — create, assign, complete, reorder
- [ ] Assignee filter + progress view for planners
- [ ] Due date on to-do items
- [ ] Pack list template — planner creates items per event
- [ ] Seed the template to an attendee's list on RSVP yes
- [ ] Attendee personal pack list — check off items, add custom items
- [ ] Pack list accessible via the invite link (no account needed)

-----

## Phase 10 — AI Assistant

Nothing here is built, and there is no LLM anywhere in the request path.

- [ ] Anthropic SDK setup in Nuxt server
- [ ] `POST /api/ai/chat` — streamed response with event context injection
- [ ] AI chat UI component (floating panel on event pages)
- [ ] Read-only context: event details, attendees, poll, bring list, budget
- [ ] Write tools: `add_bring_item`, `suggest_slots`, `draft_description`
- [ ] Graceful degradation when unconfigured (UI hidden, routes 404)
- [ ] Token usage logging (for self-hosters to monitor cost)

-----

## Phase 11 — Machine access *(shipped in a different shape)*

The roadmap expected zäme to host an MCP server at `/mcp`. What was built
instead: zäme publishes a versioned REST API and an OpenAPI contract, and
**Enterprise generates its MCP tool surface from that contract** (ADR-0036). The
model never talks to zäme directly, which keeps the tool names, the auth and the
provenance headers in one reviewable document.

- [x] `/api/v1` — 30 paths, 40 operations, service-token authenticated, no cookies
- [x] `docs/zaeme-api.openapi.yaml` — the contract, and the source of truth; served at `GET /api/openapi.yaml`
- [x] `x-mcp-expose` marks the 33 operations that become tools; 7 are plumbing
- [x] `test/api-contract.test.ts` — a bijection between the spec and the route tree, both ways
- [x] Provenance headers (`x-mcp-user`, `x-mcp-thread`, `x-mcp-model`, `x-mcp-basis`) recorded on every machine write
- [x] `pnpm smoke:api` — the whole surface against a running server
- [ ] A zäme-hosted MCP endpoint or a local stdio transport — **not planned**; if it is ever wanted it is a new decision, not a leftover
- [ ] `updateTimelineItem` — the operationId is reserved, but minting an edit tool for the model is its own decision, not yet taken

-----

## Phase 12 — Polish & Self-hosting

- [x] `/setup` first-run flow — the first account claims the instance with a passkey
- [x] `/setup/recover` — break-glass passkey registration for a locked-out owner
- [x] Instance administration at `/admin` (see [Shipped outside the phases](#shipped-outside-the-phases))
- [x] Account management — who can sign in, sign-out-everywhere, deletion that keeps their answers
- [x] Health check endpoint (`GET /healthz`, plus `GET /api/v1/health` on the machine surface)
- [x] Open Graph meta on invite and public event pages
- [x] Dark mode (Nuxt UI, by system preference)
- [ ] Self-hosting documentation beyond `README.md` / `ARCHITECTURE.md`
- [ ] Database backup guidance
- [ ] Generated OG images (today the event's own poster is used)
- [ ] PWA manifest + a mobile-optimised RSVP flow
- [ ] i18n foundation (DE / EN / FR — Swiss multilingual)

**Dropped.** A production `Dockerfile` and a `compose.prod.yml` with a reverse-proxy
example are **not coming**. zäme is built with buildpacks and configured by
`kitchen.json`; a self-hoster runs `pnpm build` and `node .output/server/index.mjs`
with the migration applied first. Nothing in the app assumes a container.

**Dropped.** `ENABLE_*` feature flags. Configuration is the flag: no storage
config means no uploads, no mail transport means no magic link (and the login
page says so), no service token means `/api/v1` authenticates nobody.

-----

## Shipped outside the phases

Built during the Enterprise period, anticipated by no phase above, and load-bearing
now:

- **Bring list** (`events_contribution`) — who brings what; guests claim and release items.
- **Trip budget** (`events_expense` + `events_expense_share`) — shared expenses in integer cents, with balances. *(Was an icebox item.)*
- **Public event discovery** — `/concerts` and `/e/[slug]` for events marked public. *(Was an icebox item.)*
- **Two more event types** — `trip` (multi-day, itinerary + budget) and `party` (two-stage: a `core` invite wave fixes the date, then `general` goes out).
- **Series membership** (`events_series_member`) — a standing group that every new occurrence auto-invites.
- **Co-organizer invites** (`events_planner_invite`) — a capability link that makes another account a co-planner.
- **The admin surface** — `/admin` for the instance owner: events, calendar, series, people, invites, media, accounts, security, the Enterprise integration, and the audit.
- **The audit log** (`zaeme_audit_log`) — one row per mutating request on a credentialled surface, refusals included, written at the edge.
- **Passkeys**, including the two circular bootstrap cases (`/setup`, `/setup/recover`) that make an instance with no working mail openable at all.
- **The machine API** — see phase 11.

-----

## Icebox (Nice to have, not yet scheduled)

- [ ] Real-time chat transport (SSE or WebSocket)
- [ ] Push notifications (Web Push API)
- [ ] Photo EXIF extraction for automatic `takenAt`
- [ ] Event templates (reuse a past event structure)
- [ ] Recurring events (auto-generate the next occurrence of a series)
- [ ] Attendee profiles (bio, instrument, how you know the host)
- [ ] Poll embeds (link a date poll without a full event)
- [ ] OpenTripPlanner / Transitous fallback for non-CH deployments
- [ ] Native mobile app (Capacitor or Expo wrapper)
