# zäme

> *Swiss German. Together.*

**zäme** is a personal event platform built around the people that matter — not the logistics. Plan your birthday party, coordinate a day trip, share your concert dates, and make sure everyone gets there together.

Self-hostable. Open source. Built with love in Bern.

-----

## What it does

- **Events** — hosted gatherings, concerts, day trips, recurring cinema series, two-stage parties. Draft privately, publish when ready.
- **Invites** — shareable capability links with beautiful event pages. RSVP in seconds, no account required.
- **Date finder** — built-in Doodle-style poll (yes / if need be / no) to find when everyone can make it, before you commit to a date. Lock the winning slot and the event publishes itself.
- **Bring list** — who brings what. The host seeds it, guests claim items, nobody brings three bowls of hummus.
- **Budget** — shared expenses per trip, in integer cents, with who-owes-whom worked out.
- **Chat** — per-event group chat for everyone attending, guests included.
- **Media & documents** — share photos, tickets, booking confirmations. Assign tickets to specific people.
- **Timeline / Itinerary** — structured event schedule with typed steps (transport, activity, accommodation, meal). Reorder, pin media per step.
- **Series** — a standing group for a recurring thing (the cinema night). Each new occurrence auto-invites every member.
- **Calendar sync** — per-event `.ics` download and a live per-person iCal feed so confirmed events land in your calendar automatically.
- **Admin** — the instance owner's cross-event view: every event, person, invite link, account and an audit of who did what.

Not built yet — see [ROADMAP.md](./ROADMAP.md): Fahrgemeinschaft (travel groups + SBB connections), to-do and pack lists, an in-app AI assistant.

-----

## Stack

|               |                                                                                          |
|---------------|------------------------------------------------------------------------------------------|
| **Framework** | [Nuxt 4](https://nuxt.com) — full-stack, SSR for invite pages                             |
| **UI**        | [Nuxt UI](https://ui.nuxt.com) + [Tailwind CSS](https://tailwindcss.com), stock theme     |
| **Database**  | PostgreSQL via [node-postgres](https://node-postgres.com) + [Drizzle ORM](https://orm.drizzle.team) |
| **Auth**      | [Better Auth](https://better-auth.com) — magic link + passkey, no passwords               |
| **Files**     | Any S3-compatible object store — presigned uploads via [aws4fetch](https://github.com/mhart/aws4fetch) |
| **Email**     | Proton Bridge via the mail relay, or [Resend](https://resend.com); [React Email](https://react.email) templates |
| **Jobs**      | [Inngest](https://inngest.com) — invite, confirmation, reminder and cancellation mail     |
| **IDs**       | [cuid2](https://github.com/paralleldrive/cuid2)                                           |
| **Runtime**   | Node 22 (`engines.node`), built with buildpacks — no Dockerfile                           |

zäme also publishes a versioned machine API (`/api/v1`) described by
[`docs/zaeme-api.openapi.yaml`](docs/zaeme-api.openapi.yaml), served at
`GET /api/openapi.yaml`. See [ARCHITECTURE.md](./ARCHITECTURE.md).

-----

## Self-hosting

zäme is a single Nuxt package with no build-time services of its own. It needs a
PostgreSQL database and very little else: object storage and a mail transport are
both optional, and the app degrades honestly without them rather than failing.

### Prerequisites

- Node 22 and pnpm (or a buildpack platform that provides them)
- A PostgreSQL database — anything that speaks the wire protocol on :5432
- Optional: an S3-compatible bucket (Cloudflare R2, MinIO, Garage) for photos, tickets and documents
- Optional: a way to send mail — the Proton Bridge mail relay, or a Resend account. You
  can set this up **after** the first deploy: sign-in no longer depends on it.

### Getting in

zäme has no passwords. Two ways in, and they fail independently:

- **A passkey** — Touch ID, Windows Hello, a security key. Needs nothing of the
  instance but a browser, so it works before mail does.
- **A magic link** — needs a working mail transport.

On first run `/setup` claims the instance with a passkey: the first account
created owns it. Manage keys afterwards at `/admin/security`.

**If you are locked out** — the account exists but the instance cannot send you
a link — set `ZAEME_OWNER_BOOTSTRAP_TOKEN` to a random secret
(`openssl rand -hex 32`), redeploy, and open `/setup/recover`. Quoting it
registers a passkey on the owner account and nothing else: it is not a session,
it cannot name a different account, and every use is written to the audit log.
**Remove the variable once you are back in** — `/admin/security` nags until you
do.

### Running it

```bash
git clone https://github.com/Bermos/zaeme
cd zaeme
pnpm install

# .env.example documents every variable and why it exists.
# DATABASE_URL and BETTER_AUTH_SECRET are the only required ones.
cp .env.example .env

# apply the schema (reads DATABASE_URL)
pnpm db:migrate

pnpm build
node .output/server/index.mjs
```

The server listens on `$PORT` (3000 by default). Visit it and zäme will send you
to `/setup` to claim the instance.

There is deliberately **no Dockerfile and no compose file**. The upstream
deployment runs on [Kitchen](https://github.com/Bermos/Kitchen) with buildpacks,
configured by [`kitchen.json`](./kitchen.json); migrations run there as a
pre-release `migrate` task (`scripts/migrate.mjs`), so a failed migration stops
the deploy instead of half-applying it. Any platform that can run
`pnpm build` and then `node .output/server/index.mjs` works the same way — run
the migration step before the new release takes traffic.

### Environment variables

Only `DATABASE_URL` and `BETTER_AUTH_SECRET` are required.

```env
# Database (required)
DATABASE_URL=postgresql://...

# Auth (required)
BETTER_AUTH_SECRET=your-secret-here
BETTER_AUTH_URL=https://your-domain.com

# Public origin — used for invite links, iCal feeds and the WebAuthn relying
# party. BASE_URL wins, then BETTER_AUTH_URL, then KITCHEN_URL.
BASE_URL=https://your-domain.com

# Object storage (optional; R2_* names are accepted as legacy aliases)
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_ENDPOINT=          # or S3_ACCOUNT_ID for Cloudflare R2
S3_REGION=auto

# Mail (optional). The relay is tried first, then Resend, then a dry run to stdout.
MAIL_RELAY_URL=       # or KITCHEN_SERVICE_MAIL, bound by the platform
MAIL_RELAY_TOKEN=
RESEND_API_KEY=
EMAIL_FROM=

# Background jobs (optional; without a key Inngest runs in dev mode)
INNGEST_EVENT_KEY=

# Break-glass passkey registration for a locked-out owner. Unset by default,
# and it should be unset again as soon as you are back in.
ZAEME_OWNER_BOOTSTRAP_TOKEN=

# The machine API (optional). Unset means /api/v1 answers 401 to everyone.
ZAEME_SERVICE_TOKEN=
ZAEME_ENTERPRISE_OWNER_ID=
```

There are no `ENABLE_*` feature flags. A capability is on when it is configured:
no storage config means uploads are unavailable, no mail transport means `/login`
stops offering a magic link and says so, no service token means `/api/v1`
authenticates nobody.

-----

## Development

```bash
# install
pnpm install

# dev server
pnpm dev

# database
pnpm db:generate   # generate migrations from server/database/schema/
pnpm db:migrate    # apply them

# checks
pnpm lint
pnpm typecheck
pnpm test

# smoke tests (need a running server; neither runs in CI)
pnpm smoke:api     # the whole /api/v1 surface, both sides of the credential wall
pnpm smoke:passkey # the real WebAuthn ceremony with a software authenticator

# build
pnpm build
```

### Project structure

One flat package — no pnpm workspace, no `packages/*`, no Nuxt layers.

```
zaeme/
  app/                      Nuxt 4 application (pages, components, layouts)
  shared/                   code used by both the app and the server
  server/
    api/
      admin/                owner-only, instance-wide
      host/                 the planner's own events (session)
      me/                   cross-event view for a signed-in account
      invites/              the guest capability surface (the link is the credential)
      public/               published events, no credential at all
      v1/                   the machine API (service token)
      auth/                 better-auth handler
    routes/                 non-API routes (.ics feeds, /healthz)
    domain/                 all domain logic — handlers stay thin
    database/
      schema/               auth.ts, events.ts, audit.ts, index.ts
      migrations/           generated by drizzle-kit
    emails/                 transports + templates
    inngest/                background job definitions
    middleware/             audit recorder, first-run setup redirect
    utils/                  db, auth, admin gate, storage, mail status, …
  docs/
    zaeme-api.openapi.yaml  the machine API contract (source of truth)
  scripts/                  migrate, API smoke, passkey smoke
  test/                     vitest — contract and boundary tests live here
  kitchen.json              build + runtime configuration
```

-----

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full task list.

-----

## Philosophy

zäme is not a startup. It’s a tool built for a specific kind of person — someone who organizes real things with real friends and wants something that feels personal, not like a SaaS product.

It is open source because others might find it useful. 

-----

## License

MIT
