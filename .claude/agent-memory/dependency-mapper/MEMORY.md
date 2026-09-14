# Dependency-mapper memory

Collision hotspots and hidden dependencies in Bermos/zaeme. Dated, one line each.
Merge duplicates; do not drop.

The entries dated 2026-09-14 are the seed: they are read out of the repository's
layout and the open issues, not out of a mapping run.

## Files that collide between concurrent branches

- 2026-09-14: `server/database/schema.ts` plus the generated Drizzle migration. Two issues that both change the schema in one wave is the expensive collision in this repo: the migration is regenerated rather than merged, so the second branch re-runs `pnpm db:generate` after the rebase and re-verifies. Never two in a wave.
- 2026-09-14: `docs/zaeme-api.openapi.yaml` — one document for the whole machine surface, so any two `/api/v1` issues append to it. Cheap rebase, but note it, and remember the contract test fails until the route tree and the document agree again.
- 2026-09-14: `test/api-boundary.test.ts` — both sides add cases; resolution is "keep both", so it is cheap.
- 2026-09-14: `server/domain/admin.ts` is the single cross-event read module for the whole admin surface; any two admin issues land in it.
- 2026-09-14: `server/utils/auth.ts` and `server/utils/passkey-bootstrap.ts` move as a pair, and `pnpm smoke:passkey` is the only proof either works. Never two auth issues in a wave.

## Hidden dependencies

- 2026-09-14: A `/api/v1` issue is not finished in this repository: Enterprise vendors the spec and generates its MCP tools from it (#11). Every spec-touching issue carries a follow-up in `Bermos/Enterprise`.
- 2026-09-14: Anything that deploys — a migration, a startup change, a new environment variable — serialises the wave, because merging ships and a failed `migrate` task strands production on the previous release. Mark it and let the orchestrator land it alone.
- 2026-09-14: An issue about a screen is usually an issue about a route and a domain function too; zäme has no UI-only layer above the domain to absorb it.
- 2026-09-14: `ROADMAP.md` and `ARCHITECTURE.md` are stale in BOTH directions (#10) — they describe `packages/db`, Neon, a Dockerfile and an MCP endpoint that do not exist, and they mark the date poll undone when `events_date_option`/`events_date_vote` shipped. Map from `server/database/schema/`, `server/domain/` and the route tree; never from the docs.
- 2026-09-14: #8 set a precedent that binds new issues: a new domain surface is NOT added to `/api/v1` by default, because minting an MCP verb as a side effect of a feature hands the model something nobody decided to give it. A spec-touching issue is therefore a choice, not a consequence — check before you predict an OpenAPI collision.
