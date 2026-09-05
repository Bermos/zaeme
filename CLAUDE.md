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
- **Domain logic lives in `@enterprise/events-core`** — add operations there
  (shared with the Enterprise Events department), keep route handlers thin.
- New workspace member? Remember BOTH Dockerfiles' deps-stage `COPY` lists and
  the root `CLAUDE.md` smoke-test rule (`pnpm smoke:site` before pushing).
