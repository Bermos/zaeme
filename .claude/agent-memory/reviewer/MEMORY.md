# Reviewer memory

Defects that reached `main` in Bermos/zaeme, and the blind spots that let them
through. Each is a question to ask of every diff. Dated, one line each.

The entries dated 2026-09-14 are the seed: they are read out of `CLAUDE.md`, the
commit history and the open issues at the moment this file was created, not out of a
review. Everything after them is earned.

## Defects that shipped

- 2026-09-14: A correlated sub-select in the domain was silently counting nothing (`3e6df6f`), and no test in CI touches a database (#14). Ask: does this query's correctness depend on a real Postgres, and did anything run it against one?
- 2026-09-14: A deploy-time guard keyed on the sha256 of the dump it guarded had to download the artifact in order to decide whether it needed the artifact — the artifact was deleted, the task failed, and the deploy stopped (Enterprise `30c429c`, same platform, same shape). Ask: can this guard short-circuit without fetching the thing it guards, and does it fail safe?
- 2026-09-14: A dry-run log cut the magic link in half (`95c3642`), so the only way into an instance with no mail transport was broken by a logging detail. Ask: is the credential this path emits intact and usable, and is there a test that reads it back?
- 2026-09-14: Timeline `PATCH` was lost in the Enterprise transplant (#8) — a route that existed and then quietly did not. Ask: does the screen that calls this route still have a route to call?

## Blind spots

- 2026-09-14: CI runs lint, typecheck and vitest and nothing else — no database, no server, no browser. `pnpm smoke:api` and `pnpm smoke:passkey` are the only things that execute the API and the passkey ceremony, and a human has to run them. Ask: which of the two does this PR need, and did it run?
- 2026-09-14: The contract test is a bijection over paths and methods only. Ask: is a field removed, a type narrowed, a status code changed — anything breaking for Enterprise's generated tools — while every test stays green?
- 2026-09-14: `test/api-boundary.test.ts` asserts where code lives and what it imports. Ask: is the gate this handler calls the right gate for its credential, which the test cannot see?
- 2026-09-14: Nothing notices when Enterprise's vendored copy of the spec drifts from this one (#11). Ask: does this PR oblige a follow-up in the other repository, and is it raised?
- 2026-09-14: The events domain has almost no coverage (#9). Ask: what would fail if this change were reverted in place, and is it a test?
- 2026-09-14: Merging deploys. Ask of every diff: what happens on the way up — a migration that cannot run twice, a startup that now needs an unset variable, a task that fails on the state the instance is really in?
