/**
 * The contract, served from the system that implements it.
 *
 * `docs/zaeme-api.openapi.yaml` in THIS repository is the source of truth for
 * the `/api/v1` surface. Enterprise keeps a vendored snapshot so its build can
 * generate the MCP tool surface offline, but this route is what makes that
 * snapshot checkable: Enterprise can fetch the live contract and diff, rather
 * than guess whether its copy has drifted.
 *
 * Served OUTSIDE `/api/v1` on purpose. The contract test asserts a bijection
 * between the `/api/v1` route tree and the operations in this document; a route
 * serving the document would be a route the document does not describe, and
 * therefore a failure. The spec is about the API, not part of it.
 *
 * Unauthenticated, like `getHealth`: it is a public description of a private
 * API, and there is nothing in it that is not already committed to two public
 * repositories.
 *
 * The bytes travel as a Nitro server asset (see `nitro.serverAssets` in
 * `nuxt.config.ts`), which is what bundles the file into `.output` — reading it
 * off the filesystem at runtime would work in dev and 404 in the built image.
 */
export default defineEventHandler(async (event) => {
  const spec = await useStorage('assets:contract').getItem('zaeme-api.openapi.yaml')
  if (typeof spec !== 'string') {
    throw createError({ statusCode: 500, message: 'The API contract is missing from this build' })
  }
  setHeader(event, 'content-type', 'application/yaml; charset=utf-8')
  setHeader(event, 'cache-control', 'public, max-age=300')
  return spec
})
