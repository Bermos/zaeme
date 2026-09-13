/**
 * A software WebAuthn authenticator — enough of one to run a real registration
 * and a real assertion against a running zäme.
 *
 * It exists because the passkey sign-in path cannot be proved by a unit test:
 * the interesting part is a ceremony between a browser, an authenticator and
 * the server, and stubbing it out proves only that the stubs agree. There is no
 * browser here and no Touch ID, but the bytes on the wire are the bytes a real
 * authenticator sends — a P-256 key, CBOR attestation with `fmt: "none"`,
 * authenticator data with the flags set, and a genuine ECDSA signature over the
 * assertion. The server verifies all of it with `@simplewebauthn/server`, which
 * is why a passing run means something.
 *
 * Test scaffolding, never shipped: `scripts/` is not in the runtime image.
 */
import { createHash, createSign, generateKeyPairSync, createPrivateKey } from 'node:crypto'

const b64u = buf => Buffer.from(buf).toString('base64url')

/* --- a CBOR encoder for exactly the shapes an authenticator emits --- */
function cborUint(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
function cbor(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([cborUint(2, value.length), value])
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8')
    return Buffer.concat([cborUint(3, text.length), text])
  }
  if (typeof value === 'number') {
    return value >= 0 ? cborUint(0, value) : cborUint(1, -value - 1)
  }
  if (value instanceof Map) {
    return Buffer.concat([cborUint(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  }
  throw new Error('unsupported cbor value: ' + typeof value)
}

/** One authenticator holding one credential, bound to an origin and an rpId. */
export function newAuthenticator({ origin, rpId }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // Uncompressed point: 0x04 || x(32) || y(32)
  const raw = publicKey.export({ format: 'der', type: 'spki' })
  const point = raw.subarray(raw.length - 65)
  const x = point.subarray(1, 33)
  const y = point.subarray(33, 65)

  const credentialId = createHash('sha256').update(point).digest().subarray(0, 20)
  const rpIdHash = createHash('sha256').update(rpId).digest()
  let counter = 0

  const cosePublicKey = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]))

  function clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')
  }

  return {
    credentialId: b64u(credentialId),

    register(challenge) {
      const aaguid = Buffer.alloc(16)
      const credIdLen = Buffer.alloc(2)
      credIdLen.writeUInt16BE(credentialId.length)
      const counterBuf = Buffer.alloc(4)
      counterBuf.writeUInt32BE(counter)
      // UP | UV | AT
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([0x45]), counterBuf,
        aaguid, credIdLen, credentialId, cosePublicKey
      ])
      const attestationObject = cbor(new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData]
      ]))
      const cd = clientData('webauthn.create', challenge)
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64u(cd),
          attestationObject: b64u(attestationObject),
          transports: ['internal']
        }
      }
    },

    authenticate(challenge) {
      counter += 1
      const counterBuf = Buffer.alloc(4)
      counterBuf.writeUInt32BE(counter)
      // UP | UV
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counterBuf])
      const cd = clientData('webauthn.get', challenge)
      const signed = Buffer.concat([authData, createHash('sha256').update(cd).digest()])
      const signature = createSign('SHA256').update(signed).sign(createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })))
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          userHandle: null
        }
      }
    }
  }
}
