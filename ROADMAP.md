# Roadmap

Development is roughly ordered by dependency — each phase builds on the last. Items within a phase can be parallelised.

-----

## Phase 0 — Foundation

- [x] Initialise Nuxt 4 app with `pnpm` workspaces monorepo structure
- [x] Configure `packages/db` with Drizzle + `postgres.js` + Neon
- [x] Write full database schema (all tables, enums, relations)
- [x] Configure `drizzle-kit` for migrations
- [x] Auto-migrate on server startup (`server/plugins/migrate.ts`)
- [x] Set up Better Auth (email/password + magic link strategies)
- [x] First-run `/setup` page for admin account creation
- [x] Configure Nuxt UI + Tailwind CSS
- [x] `.env.example` with all variables documented
- [x] `docker/compose.yml` for local development (Postgres sidecar)
- [x] `docker/compose.prod.yml` for production deployment
- [x] Seed script for development (`pnpm db:seed`)

-----

## Phase 1 — Event Core

- [ ] Event creation form (title, type, description, dates, location)
- [ ] Draft / brainstorm mode — private, planners only
- [ ] Event detail page (planner view)
- [ ] Event status transitions (draft → published → completed → cancelled)
- [ ] Co-planner invite — add user as co-planner with role
- [ ] Planner permission checks on all API routes
- [ ] Event list / dashboard for admin
- [ ] Event slug generation + collision handling
- [ ] Series support — parent event + episode creation
- [ ] Concert event type — `ticketUrl`, `performerNote`, public visibility default

-----

## Phase 2 — Invites & RSVP

- [ ] Invite token generation per event
- [ ] Public invite page (`/invite/[token]`) — SSR, OG meta tags
- [ ] RSVP flow — yes / maybe / no / cheering (concert)
- [ ] Guest RSVP (no account required) — name + email + token
- [ ] Registered user RSVP
- [ ] `+1` support on RSVP
- [ ] Dietary / accessibility / note field on RSVP
- [ ] RSVP management page for planners (list, edit, remove)
- [ ] Magic link RSVP (guest clicks link in email, lands pre-authenticated)

-----

## Phase 3 — Calendar & Email

- [ ] Set up Resend + React Email in `packages/email`
- [ ] Invite email template
- [ ] RSVP confirmation email template
- [ ] Event reminder email template (48h before)
- [ ] Event cancelled email template
- [ ] Magic link email template
- [ ] Set up Inngest + define all job types
- [ ] `rsvp.confirmed` job — send confirmation email
- [ ] `event.published` job — send invite emails
- [ ] `event.reminder` job — scheduled 48h reminder
- [ ] `event.cancelled` job — cancellation notification
- [ ] `packages/ics` — iCal generation library wrapper
- [ ] `.ics` attachment on RSVP confirmation email
- [ ] Per-attendee iCal feed (`GET /calendar/[token].ics`)
- [ ] Per-event iCal feed (`GET /events/[slug]/calendar.ics`)
- [ ] iCal token generation + storage

-----

## Phase 4 — Date Finder

- [ ] Date poll creation (slots, deadline, question)
- [ ] Poll invite page — accessible to guests via event invite token
- [ ] Three-way response: yes / if need be / no
- [ ] Poll results view — weighted scoring (yes=1, if_need_be=0.5, no=0)
- [ ] Close poll + decide winning slot
- [ ] Promote decided slot to `event.startsAt` / `event.endsAt`
- [ ] Transition event status `polling → published` on decision
- [ ] `datepoll.closed` Inngest job — auto-close at deadline
- [ ] Date poll invite email template
- [ ] Date poll decided email template (with `.ics` attachment)

-----

## Phase 5 — Fahrgemeinschaft

- [ ] Origin location input on RSVP form (autocomplete via SBB locations API)
- [ ] `packages/sbb` — transport.opendata.ch client (connections, stationboard, locations)
- [ ] Travel group clustering algorithm (group by hub station)
- [ ] `travel.recluster` Inngest job — runs on each RSVP with location
- [ ] `sbb.refresh` Inngest job — daily refresh of cached connections
- [ ] Travel groups display on event page (planner + attendee view)
- [ ] “I’m taking this train” commitment toggle
- [ ] Carpooling mode — driver seats, request to join
- [ ] `ENABLE_SBB=false` fallback — show Google Maps directions link only
- [ ] Travel group chat thread (sub-thread of main event chat)

-----

## Phase 6 — Chat

- [ ] Chat message schema + API routes (create, list, delete)
- [ ] SSE endpoint for real-time message delivery (`/api/events/[id]/chat/stream`)
- [ ] Chat UI component (Nuxt UI based)
- [ ] Guest chat (authenticated via RSVP token)
- [ ] Reply threading (`replyToId`)
- [ ] Soft delete (planner can remove messages)
- [ ] Announcement mode — planner-only broadcast, no replies
- [ ] Unread message indicator

-----

## Phase 7 — Media & Documents

- [ ] R2 configuration + presigned upload API (`POST /api/media/presign`)
- [ ] Upload confirmation API (`POST /api/media/confirm`)
- [ ] Photo / video gallery per event
- [ ] Document upload (PDFs, booking confirmations)
- [ ] Ticket upload + assignment to specific attendee
- [ ] Guest upload (via RSVP token)
- [ ] Media timeline view (sorted by `takenAt`)
- [ ] Caption editing
- [ ] Planner media moderation (delete any item)

-----

## Phase 8 — To-Do Lists

- [ ] Organizer to-do list — create, assign, complete, reorder
- [ ] Assignee filter + progress view for planners
- [ ] Due date on to-do items
- [ ] Pack list template — planner creates items per event
- [ ] `packList.seed` Inngest job — copy template to attendee on RSVP yes
- [ ] Attendee personal pack list — check off items, add custom items
- [ ] Pack list accessible via RSVP token (no account needed)

-----

## Phase 9 — AI Assistant

- [ ] Anthropic SDK setup in Nuxt server
- [ ] `POST /api/ai/chat` — streamed response with event context injection
- [ ] AI chat UI component (floating panel on event pages)
- [ ] Read-only context: event details, attendees, todos, poll, travel
- [ ] Write tools: `add_todo`, `add_pack_item`, `suggest_slots`, `draft_description`
- [ ] `ENABLE_AI=false` graceful degradation (UI hidden, routes 404)
- [ ] Token usage logging (for self-hosters to monitor cost)

-----

## Phase 10 — MCP Server

- [ ] `@modelcontextprotocol/sdk` setup
- [ ] MCP endpoint (`POST /mcp`) with admin auth
- [ ] Resources: `zaeme://events`, `zaeme://events/{slug}`, `zaeme://events/{slug}/attendees`, `zaeme://events/{slug}/travel`
- [ ] Tools: `list_events`, `get_event`, `update_description`, `add_todo`, `set_poll_slots`, `assign_ticket`
- [ ] MCP server documented in self-hosting guide
- [ ] Local stdio transport option for Claude Desktop

-----

## Phase 11 — Polish & Self-hosting

- [ ] `/setup` first-run wizard (admin account + instance name)
- [ ] Admin settings page (instance name, base URL, feature flags)
- [ ] User management page (invite users, revoke access)
- [ ] Production `Dockerfile` (multi-stage, minimal image)
- [ ] `compose.prod.yml` with Traefik / Caddy reverse proxy example
- [ ] Self-hosting documentation (VitePress in `docs/`)
- [ ] `ENABLE_*` feature flag documentation
- [ ] Health check endpoint (`GET /api/health`)
- [ ] Database backup guidance in docs
- [ ] OG image generation for event invite pages
- [ ] PWA manifest + mobile-optimised RSVP flow
- [ ] Dark mode (Nuxt UI built-in)
- [ ] i18n foundation (DE / EN / FR — Swiss multilingual)

-----

## Icebox (Nice to have, not yet scheduled)

- [ ] WebSocket upgrade for chat (currently SSE)
- [ ] Push notifications (Web Push API)
- [ ] Photo EXIF extraction for automatic `takenAt`
- [ ] Event templates (reuse a past event structure)
- [ ] Recurring events (weekly cinema series auto-generation)
- [ ] Public event discovery page (opt-in, for concerts)
- [ ] Attendee profiles (bio, instrument, how you know the host)
- [ ] Budget tracking per event
- [ ] Poll embeds (link a date poll without a full event)
- [ ] OpenTripPlanner / Transitous fallback for non-CH deployments
- [ ] Native mobile app (Capacitor or Expo wrapper)
