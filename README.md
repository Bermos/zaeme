# zäme

> *Swiss German. Together.*

**zäme** is a personal event platform built around the people that matter — not the logistics. Plan your birthday party, coordinate a day trip, share your concert dates, and make sure everyone gets there together.

Self-hostable. Open source. Built with love in Bern.

-----

## What it does

- **Events** — hosted gatherings, concerts, day trips, recurring cinema series. Draft privately, publish when ready.
- **Invites** — shareable links with beautiful event pages. RSVP in seconds, no account required.
- **Date finder** — built-in Doodle-style poll to find when everyone can make it, before you commit to a date.
- **Fahrgemeinschaft** — automatic travel group detection. zäme finds who’s coming from the same place and surfaces the best SBB connection so you arrive together.
- **Calendar sync** — `.ics` export and live iCal feed so confirmed events land in your calendar automatically.
- **To-do lists** — shared organizer checklist and personal pack lists for attendees, seeded from a template you define.
- **Chat** — per-event group chat for everyone attending.
- **Media & documents** — share photos, tickets, booking confirmations. Assign tickets to specific people.
- **Timeline / Itinerary** — structured event schedule with typed steps (transport, activity, accommodation, meal). Drag-to-reorder, media pinning per step.
- **AI assistant** — Claude helps you brainstorm, plan itineraries, and draft pack list templates, with full event context.
- **MCP server** — expose your events as an MCP resource so you can plan directly from Claude.ai.

-----

## Stack

|               |                                                                                |
|---------------|--------------------------------------------------------------------------------|
| **Framework** | [Nuxt 4](https://nuxt.com) — full-stack, SSR for invite pages                  |
| **UI**        | [Nuxt UI](https://ui.nuxt.com) + [Tailwind CSS](https://tailwindcss.com)       |
| **Database**  | [Neon PostgreSQL](https://neon.tech) + [Drizzle ORM](https://orm.drizzle.team) |
| **Auth**      | [Better Auth](https://better-auth.com) — email/password + magic link           |
| **Files**     | [Cloudflare R2](https://developers.cloudflare.com/r2/) — presigned uploads     |
| **Email**     | [Resend](https://resend.com) + [React Email](https://react.email)              |
| **Jobs**      | [Inngest](https://inngest.com) — background jobs, reminders, travel clustering |
| **Transit**   | [transport.opendata.ch](https://transport.opendata.ch) — SBB timetables        |
| **AI**        | [Anthropic SDK](https://docs.anthropic.com) — Claude for assistant + MCP       |
| **IDs**       | [cuid2](https://github.com/paralleldrive/cuid2)                                |

-----

## Self-hosting

zäme is designed to be self-hosted with minimal friction. One `compose.yml`, a handful of environment variables, automatic migrations on startup.

### Prerequisites

- Docker + Docker Compose
- A PostgreSQL database (Neon free tier works great)
- Cloudflare R2 bucket (or any S3-compatible storage)
- Resend account (free tier is plenty for personal use)

### Quick start

```bash
git clone https://github.com/yourusername/zaeme
cd zaeme
cp .env.example .env
# fill in your .env
docker compose up -d
```

Visit `http://localhost:3000`. On first run, zäme will prompt you to create the admin account.

### Environment variables

```env
# Database
DATABASE_URL=postgresql://...

# Auth
BETTER_AUTH_SECRET=your-secret-here
BETTER_AUTH_URL=https://your-domain.com

# Storage
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=

# Email
RESEND_API_KEY=

# AI (optional — degrades gracefully if unset)
ANTHROPIC_API_KEY=

# App
BASE_URL=https://your-domain.com
ADMIN_EMAIL=you@example.com
```

### Feature flags

```env
ENABLE_AI=true          # LLM assistant + MCP server
ENABLE_SBB=true         # Fahrgemeinschaft / transit lookup
ENABLE_MAGIC_LINK=true  # magic link auth (email/pw always available)
```

-----

## Development

```bash
# install
pnpm install

# dev server
pnpm dev

# database
pnpm db:generate   # generate migrations
pnpm db:migrate    # run migrations
pnpm db:studio     # Drizzle Studio
pnpm db:seed       # seed dev data

# build
pnpm build
```

### Project structure

```
zaeme/
  app/                      Nuxt 4 application
    pages/
    components/
    layouts/
    server/
      api/                  API routes
      routes/               Non-API server routes (.ics feeds, etc.)
      mcp/                  MCP server endpoint
  packages/
    db/                     Drizzle schema + migrations
    email/                  React Email templates
    ics/                    iCal generation
    sbb/                    transport.opendata.ch client
  docker/
    compose.yml
    compose.prod.yml
  docs/                     VitePress self-hosting docs
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
