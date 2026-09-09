# apps/site — zäme (the public social app)

This is **zäme**, the collaborative event planner for friends
(ADR-0019, `docs/design/PUBLIC-SITE-PLAN.md`), served at
its own public origin (`BASE_URL`). It is a **different product** from the Enterprise
shell, with the opposite design discipline:

- **Use stock Nuxt UI components with their DEFAULT look.** Friendly, light,
  approachable. Do NOT import or imitate the Enterprise design system — no
  instrument-panel tokens, no LCARS, no `RoomShell`/`MonoLabel`/`StatusDot`,
  no reserve-amber rule, no forced dark mode, no IBM Plex Mono labels. The
  `ui-components` and `navigation` skills do **not** apply here.
- **SSR stays on** — invite links must render real HTML + OG meta.
- **No global auth guard.** Guest access is the invite capability URL; the
  zäme better-auth instance (magic-link, `zaeme_*` tables — NOT the owner's
  single-account instance) gates only `/me` and `/host`.
- **Domain logic lives in `server/domain/`** — add operations there, keep route
  handlers thin. (This was `@enterprise/events-core` while zäme lived inside the
  Enterprise monorepo; it came home with the 2026-09 transplant. zäme is a single
  flat package now: no workspace, no `packages/*`, no layers, no Dockerfile —
  Kitchen builds it with buildpacks.)
- **`engines.node` in `package.json` is load-bearing — do not drop it.** Kitchen
  reads that field into `BP_NODE_VERSION` and hands it to the buildpack verbatim.
  Without it the node-engine buildpack reports no version source at all and the
  app silently gets whatever Node is newest that day, which is a runtime upgrade
  nobody asked for and nothing recorded. It looks like tidy-uppable boilerplate
  and is not.
- **Enterprise reaches zäme only over HTTP** (ADR-0036). The contract is
  `docs/zaeme-api.openapi.yaml` — **this repo's copy is the source of truth**,
  served at `GET /api/openapi.yaml`; Enterprise's committed copy is a vendored
  snapshot it generates its MCP tools from. Touching `/api/v1` or the spec means
  running `pnpm test` (the contract test asserts a bijection between them, in
  both directions) and ideally `pnpm smoke:api` against a running server.
- **Three credentials, never interchangeable**: the invite capability URL
  (`/api/invites/**`), the magic-link host session (`/api/host/**`, `/api/me/**`)
  and the Enterprise service token (`/api/v1/**`). No `/api/v1` handler may read
  a cookie, and no guest/host handler may read the service token —
  `test/api-boundary.test.ts` enforces both.
- **`/admin` and `/api/admin/**` are the INSTANCE OWNER's**, and add no fourth
  credential: the host session plus `requireOwner` (`server/utils/admin.ts`),
  where the owner is the first account registered. Every admin route calls that
  gate; a service token must never reach one, and the gate must not be imported
  anywhere but `server/api/admin/**` — the boundary test asserts all of it.
  Cross-event reads go in `server/domain/admin.ts` (instance-scoped; watch the
  N+1 note at the top of that file), never in a route handler.
- **Mutations are audited.** `server/middleware/audit.ts` records the human
  surfaces at the edge and `defineServiceHandler` records the machine one; a new
  route needs no audit code of its own, and the middleware must keep returning
  early for `/api/v1` (no cookie near that surface) and `/api/auth`.
- **Never put this deployment's private data in another repo.** Bug reports go
  upstream — usually to `Bermos/Kitchen`, which is public — and the instance's
  own identifiers must not travel with them: hostnames and URLs (application,
  platform, registry, database), IP addresses, environment and claim names,
  account ids, email addresses. Reproduce with placeholders (`app.example.com`)
  and keep everything else concrete — exact status codes, headers, conditions
  and code references are what make a report actionable and identify nothing.
  Get it right the first time: GitHub keeps an issue's edit history and its REST
  API cannot delete an issue, so redacting afterwards is damage control, not a
  scrub.
