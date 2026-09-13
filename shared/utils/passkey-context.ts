/**
 * The `context` string a browser sends with a bootstrap passkey registration.
 *
 * It is written in the browser and read on the server, so it lives in
 * `shared/` — Nuxt auto-imports this directory into both, which is the only way
 * to have one definition of the wire format instead of two that drift.
 *
 * It is NOT a credential in itself. `setup:` carries a name and an address that
 * the server only accepts while no account exists at all; `owner-bootstrap:`
 * carries the operator's token, which the server compares in constant time.
 * `server/utils/passkey-bootstrap.ts` is where that decision is made, and the
 * parser there is authoritative — these two functions only have to agree with
 * it about the prefixes and the encoding.
 */
export const PASSKEY_SETUP_PREFIX = 'setup:'
export const PASSKEY_RECOVER_PREFIX = 'owner-bootstrap:'

/** First run: claim an unclaimed instance and become its owner. */
export function encodeSetupContext(input: { name: string, email: string }): string {
  const json = JSON.stringify({ name: input.name, email: input.email })
  // base64url, not base64: this travels in a JSON body today but a URL-safe
  // alphabet costs nothing and removes a whole class of future surprise.
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return PASSKEY_SETUP_PREFIX + base64
}

/** Break-glass: register a passkey on the owner account with the operator's token. */
export function encodeRecoverContext(token: string): string {
  return PASSKEY_RECOVER_PREFIX + token
}
