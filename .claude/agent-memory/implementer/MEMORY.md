# Implementer memory

What implementers of Bermos/zaeme learn the hard way. One line per lesson, dated,
under the heading it belongs to. Merge duplicates; do not drop.

The entries dated 2026-09-14 are the seed: they are read out of `CLAUDE.md`, the test
suite and the open issues at the moment this file was created, not out of a run.
Everything after them is earned.

## Checks that prove less than they look

- 2026-09-14: `pnpm test` is vitest, and **vitest does not typecheck**. A type error in a Vue file or a server handler passes the tests and fails `pnpm typecheck` (`nuxt typecheck`, vue-tsc) — which CI runs as its own step. Run both.
- 2026-09-14: `pnpm smoke:passkey` runs nowhere but a terminal — it drives the real WebAuthn ceremony with a software authenticator (`scripts/webauthn-authenticator.mjs`), and a green pipeline still says nothing about that surface. `pnpm smoke:api` used to be in the same sentence; since #14 the `api` job runs it on every push.
- 2026-09-14: CI runs **no database** (#14), so anything whose behaviour depends on a real query — an ordering, a correlated sub-select, a cascade, a unique constraint — is proved by nothing in the pipeline. Stand up a scratch Postgres and run it. **Superseded 2026-09-14 by the `api` job** (#14): CI now boots `.output/server/index.mjs` against Postgres and runs all 106 `smoke:api` checks, poster round trip and both session halves of the boundary included. `smoke:passkey` still runs nowhere but a terminal.
- 2026-09-14: `pnpm smoke:api` needs no dev server and no `pnpm dev`: the BUILT output boots with `DATABASE_URL`, `PORT`, `BASE_URL`, `BETTER_AUTH_SECRET`, `ZAEME_SERVICE_TOKEN` and `ZAEME_ENTERPRISE_OWNER_ID` and nothing else. Booting the build is the only check that catches a module that resolves at build time and not at boot — `pnpm build` exiting 0 does not.
- 2026-09-14: `scripts/api-smoke.sh` SKIPS rather than fails, and still exits 0. **16** checks need the session cookies (5 guest-session + 7 owner-admin + 4 non-owner) and **12** need `S3_BUCKET`, so the full suite is 106 and a bare run is **78** — "passed 78, failed 0" and "passed 106, failed 0" are the same shade of green. The `api` job therefore greps for `skip` lines and asserts the trailing count against `MIN_SMOKE_CHECKS`; keep that assertion when you touch the job, and raise the floor rather than lowering it.
- 2026-09-14: The events domain (~3,400 LOC) has almost no coverage (#9). A change there is as good as the test you write for it.

## Boundaries the tests hold, and what they actually assert

- 2026-09-14: `test/api-boundary.test.ts` enforces the three credentials and the admin gate's import boundary in both directions. When it fails, the route is in the wrong place or reads the wrong credential — it is not the test being fussy. It checks *where* code lives and what it imports; it cannot check that the gate you called is the right one for the route.
- 2026-09-14: `test/api-contract.test.ts` asserts a bijection between the `/api/v1` route tree and `docs/zaeme-api.openapi.yaml`. A route without a spec entry fails it, and so does a spec entry without a route. The bijection is over paths and methods — it says nothing about field names, optionality or status codes, which is exactly where a break for Enterprise hides.
- 2026-09-14: `server/utils/passkey-bootstrap.ts` is imported by `server/utils/auth.ts` and by no route handler; the boundary test asserts that. The two circular cases (an unclaimed instance, a locked-out owner with `ZAEME_OWNER_BOOTSTRAP_TOKEN`) are decided against the database and the environment, never against anything the browser asserts.
- 2026-09-14: the instance owner is the first `zaeme_user` by `created_at` (`server/utils/instance.ts`), so a database with ONE account cannot express the 403 half of the admin gate — every session in it is the owner's. Seed two, with explicitly different `created_at` values: rows inserted in one statement can share a timestamp to the microsecond and make the owner whichever one the planner returns that day.
- 2026-09-14: driving the magic-link sign-in from a script needs an `Origin` header on `POST /api/auth/sign-in/magic-link` — better-auth's CSRF middleware answers `403 MISSING_OR_NULL_ORIGIN` without one, and `fetch` does not send it. The token is `zaeme_verification.identifier` (stored plain) and its `value` carries the email, so match on that rather than on "the newest row".
- 2026-09-14: the mail dry run's `[email:dry-run]` log prints the magic link twice — the `preview` field truncates the token, the `links` array does NOT. Read `zaeme_verification` anyway, and match the row on the email inside `value`: "newest row wins" picks the wrong token exactly when you are signing in two accounts in a row.
- 2026-09-14: `server/middleware/audit.ts` records mutations at the edge; a new route needs no audit code. It must keep returning early for `/api/v1` and `/api/auth` — a change that drops those early returns puts a cookie read next to the machine surface.

## Deploys, builds and the platform

- 2026-09-14: Merging to `main` ships. Kitchen builds the commit with buildpacks per `kitchen.json` and the `migrate` task runs on the way in; **a failed task stops the deploy**, leaving production on the previous release. The symptom is "my change is not there", not an error page.
- 2026-09-14: `engines.node` in `package.json` is read into `BP_NODE_VERSION` by Kitchen and handed to the node-engine buildpack verbatim. Dropping it as boilerplate silently upgrades Node on the next build.
- 2026-09-14: There is no Dockerfile and no workspace — zäme is a single flat package. A change that assumes `packages/*` or a build stage is thinking of the pre-transplant layout or of Enterprise.
- 2026-09-14: `actions/setup-node` with `node-version-file: package.json` reads `engines.node` — the same field Kitchen turns into `BP_NODE_VERSION`. Use it in any new job rather than hard-coding a major, so CI and the buildpack cannot drift apart silently.
- 2026-09-14: writing a secret to `$GITHUB_ENV` does NOT keep it out of the build log — the runner reprints a step's whole `env` block in the next step's group header. It needs `::add-mask::` on stdout BEFORE the value is first printed, which means a script whose stdout is redirected into `$GITHUB_ENV` can never mask anything: have it append to the `$GITHUB_ENV` file itself and keep stdout for the workflow command. Escape `%` as `%25` in the mask payload first, or a percent-encoded value (every better-auth cookie) masks a string that never appears.
- 2026-09-14: MinIO is gone as a CI dependency — the open-source server was archived, `dl.min.io` answers `410 Gone` and the `minio/minio` Docker Hub repo is unauthorized. The `api` job uses `adobe/s3mock` instead: path-style, in-memory, signature-blind, and it takes its bucket from `COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS` with no command arguments, which is what lets it be a plain `services:` entry.

## Style and shape

- 2026-09-14: Stock Nuxt UI with its default look. The Enterprise design system, the `ui-components` and `navigation` skills, and every instrument-panel idiom are for the other repo and are a review finding here.
- 2026-09-14: `AGENT.md` is the style contract for server code: `#server/...` aliases over deep relative imports, `e.method` over `getMethod(e)`, return the query directly, modern Zod (`z.email`, `z.url`, `z.iso.datetime`).
- 2026-09-14: Domain logic goes in `server/domain/`; handlers stay thin. Cross-event admin reads go in `server/domain/admin.ts` — read the N+1 note at the top of that file before adding one.
- 2026-09-14: Ask `server/utils/mail-status.ts` whether this instance can send mail. Reading `RESEND_API_KEY` directly misses the mail relay in front of Proton Bridge (`KITCHEN_SERVICE_MAIL`) and the dry run.

## Rebase and generated files

- 2026-09-14: Drizzle migrations are generated (`pnpm db:generate`) and are not mergeable text. After a rebase that brought in another migration, regenerate and re-verify rather than resolving by hand.
