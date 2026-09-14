# Implementer memory

What implementers of Bermos/zaeme learn the hard way. One line per lesson, dated,
under the heading it belongs to. Merge duplicates; do not drop.

The entries dated 2026-09-14 are the seed: they are read out of `CLAUDE.md`, the test
suite and the open issues at the moment this file was created, not out of a run.
Everything after them is earned.

## Checks that prove less than they look

- 2026-09-14: `pnpm test` is vitest, and **vitest does not typecheck**. A type error in a Vue file or a server handler passes the tests and fails `pnpm typecheck` (`nuxt typecheck`, vue-tsc) — which CI runs as its own step. Run both.
- 2026-09-14: Neither smoke script runs in CI. `pnpm smoke:api` needs a running server and `pnpm smoke:passkey` runs the real WebAuthn ceremony with a software authenticator (`scripts/webauthn-authenticator.mjs`). A green pipeline says nothing about either surface.
- 2026-09-14: CI runs **no database** (#14), so anything whose behaviour depends on a real query — an ordering, a correlated sub-select, a cascade, a unique constraint — is proved by nothing in the pipeline. Stand up a scratch Postgres and run it.
- 2026-09-14: The events domain (~3,400 LOC) has almost no coverage (#9). A change there is as good as the test you write for it.

## Boundaries the tests hold, and what they actually assert

- 2026-09-14: `test/api-boundary.test.ts` enforces the three credentials and the admin gate's import boundary in both directions. When it fails, the route is in the wrong place or reads the wrong credential — it is not the test being fussy. It checks *where* code lives and what it imports; it cannot check that the gate you called is the right one for the route.
- 2026-09-14: `test/api-contract.test.ts` asserts a bijection between the `/api/v1` route tree and `docs/zaeme-api.openapi.yaml`. A route without a spec entry fails it, and so does a spec entry without a route. The bijection is over paths and methods — it says nothing about field names, optionality or status codes, which is exactly where a break for Enterprise hides.
- 2026-09-14: `server/utils/passkey-bootstrap.ts` is imported by `server/utils/auth.ts` and by no route handler; the boundary test asserts that. The two circular cases (an unclaimed instance, a locked-out owner with `ZAEME_OWNER_BOOTSTRAP_TOKEN`) are decided against the database and the environment, never against anything the browser asserts.
- 2026-09-14: `server/middleware/audit.ts` records mutations at the edge; a new route needs no audit code. It must keep returning early for `/api/v1` and `/api/auth` — a change that drops those early returns puts a cookie read next to the machine surface.

## Deploys, builds and the platform

- 2026-09-14: Merging to `main` ships. Kitchen builds the commit with buildpacks per `kitchen.json` and the `migrate` task runs on the way in; **a failed task stops the deploy**, leaving production on the previous release. The symptom is "my change is not there", not an error page.
- 2026-09-14: `engines.node` in `package.json` is read into `BP_NODE_VERSION` by Kitchen and handed to the node-engine buildpack verbatim. Dropping it as boilerplate silently upgrades Node on the next build.
- 2026-09-14: There is no Dockerfile and no workspace — zäme is a single flat package. A change that assumes `packages/*` or a build stage is thinking of the pre-transplant layout or of Enterprise.

## Style and shape

- 2026-09-14: Stock Nuxt UI with its default look. The Enterprise design system, the `ui-components` and `navigation` skills, and every instrument-panel idiom are for the other repo and are a review finding here.
- 2026-09-14: `AGENT.md` is the style contract for server code: `#server/...` aliases over deep relative imports, `e.method` over `getMethod(e)`, return the query directly, modern Zod (`z.email`, `z.url`, `z.iso.datetime`).
- 2026-09-14: Domain logic goes in `server/domain/`; handlers stay thin. Cross-event admin reads go in `server/domain/admin.ts` — read the N+1 note at the top of that file before adding one.
- 2026-09-14: Ask `server/utils/mail-status.ts` whether this instance can send mail. Reading `RESEND_API_KEY` directly misses the mail relay in front of Proton Bridge (`KITCHEN_SERVICE_MAIL`) and the dry run.

## Rebase and generated files

- 2026-09-14: Drizzle migrations are generated (`pnpm db:generate`) and are not mergeable text. After a rebase that brought in another migration, regenerate and re-verify rather than resolving by hand.
