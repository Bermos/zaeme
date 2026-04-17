# AGENT.md

Purpose: quick operating rules for future agents touching this codebase.

## Follow these conventions

- Use NuxtUI components instead of custom components.
  - Prefer `<NuxtUIButton>` over `<Button>` and `<NuxtUIInput>` over `<Input>`.

- Use Nuxt server aliases instead of deep relative imports in server code.
  - Prefer `#server/utils/db`, `#server/utils/session`, and `#server/database/schema`.
  - Avoid paths like `../../../utils/db` unless there is a specific reason.

- In server handlers, branch on `e.method` directly.
  - Prefer `if (e.method === 'GET')` over `const method = getMethod(e)`.

- Return straightforward DB queries directly when no extra transformation is needed.
  - Prefer `return db.select(...).from(...)` over temporary `const rows = ...; return rows`.

- Keep Zod usage modern and concise in app forms.
  - Prefer `z.email(...)` over `z.string().email(...)`
  - Prefer `z.url(...)` over `z.string().url(...)`
  - Prefer `z.iso.datetime({ offset: true })` over `z.string().datetime({ offset: true })`

## Scope where these rules matter most

- `server/api/**`
- `server/middleware/**`
- `server/utils/**`
- `app/pages/**` (form schemas)

## Before finishing a change

- Check imports for accidental relative path regressions in server files.
- Check method branching style (`e.method`) in edited handlers.
- Check for unnecessary temporary variables in simple return paths.
- Keep edits small and style-consistent with nearby code.
- Make sure eslint is happy.


