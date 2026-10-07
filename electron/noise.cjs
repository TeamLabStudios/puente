// Noise_XX_25519_AESGCM_SHA256 (https://noiseprotocol.org/noise.html), el mismo marco que usan WireGuard o WhatsApp.
//   · XX: los dos aparatos se presentan con su clave fija (identidad) cifrada; nadie de fuera ve quién habla con quién.
//   · Claves de sesión nuevas en cada conexión (X25519 efímero) → «secreto hacia adelante».
//   · Todo lo que viaja después va con AES-256-GCM (nonce = contador, nunca se repite).
// Comprobado con los vectores oficiales de prueba (tests/noise.test.cjs).
const crypto = require('crypto')
const { x25519 } = require('@noble/curves/ed25519.js')

const NAME = 'Noise_XX_25519_AESGCM_SHA256'
const DHLEN = 32, HASHLEN = 32, TAGLEN = 16
const MAX_NONCE = 2n ** 64n - 1n

const sha256 = (...b) => { const h = crypto.createHash('sha256'); for (const x of b) h.update(x); return h.digest() }
const hmac = (k, ...b) => { const h = crypto.createHmac('sha256', k); for (const x of b) h.update(x); return h.digest() }
function hkdf(ck, ikm, n) {
  const tk = hmac(ck, ikm)
  const o1 = hmac(tk, Buffer.from([1]))
  const o2 = hmac(tk, o1, Buffer.from([2]))
  if (n === 2) return [o1, o2]
  return [o1, o2, hmac(tk, o2, Buffer.from([3]))]
}
const nonce = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64BE(n, 4); return b }

function encrypt(k, n, ad, pt) {
  const c = crypto.createCipheriv('aes-256-gcm', k, nonce(n))
  c.setAAD(ad)
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])
}
function decrypt(k, n, ad, ct) {
  if (ct.length < TAGLEN) throw new Error('Mensaje demasiado corto')
  const d = crypto.createDecipheriv('aes-256-gcm', k, nonce(n))
  d.setAAD(ad)
  d.setAuthTag(ct.subarray(ct.length - TAGLEN))
  return Buffer.concat([d.update(ct.subarray(0, ct.length - TAGLEN)), d.final()]) // si alguien tocó un solo bit, aquí falla
}

class CipherState {
  constructor(k = null) { this.k = k; this.n = 0n }
  has() { return !!this.k }
  enc(ad, pt) { if (!this.k) return Buffer.from(pt); if (this.n >= MAX_NONCE) throw new Error('Nonce agotado'); return encrypt(this.k, this.n++, ad, pt) }
  dec(ad, ct) { if (!this.k) return Buffer.from(ct); if (this.n >= MAX_NONCE) throw new Error('Nonce agotado'); const p = decrypt(this.k, this.n, ad, ct); this.n++; return p }
}

class SymmetricState {
  constructor(name = NAME) {
    const nb = Buffer.from(name)
    this.h = nb.length <= HASHLEN ? Buffer.concat([nb, Buffer.alloc(HASHLEN - nb.length)]) : sha256(nb)
    this.ck = Buffer.from(this.h)
    this.cs = new CipherState()
  }
  mixKey(ikm) { const [ck, k] = hkdf(this.ck, ikm, 2); this.ck = ck; this.cs = new CipherState(k) }
  mixHash(d) { this.h = sha256(this.h, d) }
  encryptAndHash(pt) { const c = this.cs.enc(this.h, pt); this.mixHash(c); return c }
  decryptAndHash(c) { const p = this.cs.dec(this.h, c); this.mixHash(c); return p }
  split() { const [a, b] = hkdf(this.ck, Buffer.alloc(0), 2); return [new CipherState(a), new CipherState(b)] }
}

const keyPair = (priv = crypto.randomBytes(32)) => ({ priv: Buffer.from(priv), pub: Buffer.from(x25519.getPublicKey(priv)) })
const dh = (kp, pub) => {
  const out = Buffer.from(x25519.getSharedSecret(kp.priv, pub))
  if (out.every((b) => b === 0)) throw new Error('Clave pública no válida') // punto de orden pequeño: se rechaza
  return out
}

// Handshake XX:  -> e   ·   <- e, ee, s, es   ·   -> s, se
class Handshake {
  constructor({ initiator, s, e = null, prologue = Buffer.from('Puente/1') }) {
    this.init = !!initiator
    this.s = s
    this.e = e
    this.re = null; this.rs = null
    this.ss = new SymmetricState()
    this.ss.mixHash(prologue)
    this.step = 0
    this.done = false
  }
  // devuelve el mensaje que hay que mandar
  write(payload = Buffer.alloc(0)) {
    const ss = this.ss, out = []
    if (this.init && this.step === 0) {
      this.e ||= keyPair(); out.push(this.e.pub); ss.mixHash(this.e.pub)
    } else if (!this.init && this.step === 1) {
      this.e ||= keyPair(); out.push(this.e.pub); ss.mixHash(this.e.pub)
      ss.mixKey(dh(this.e, this.re))
      out.push(ss.encryptAndHash(this.s.pub))
      ss.mixKey(dh(this.s, this.re))
    } else if (this.init && this.step === 2) {
      out.push(ss.encryptAndHash(this.s.pub))
      ss.mixKey(dh(this.s, this.re))
    } else throw new Error('No me toca escribir')
    out.push(ss.encryptAndHash(Buffer.from(payload)))
    this.step++
    if (this.step === 3) this.finish()
    return Buffer.concat(out)
  }
  // lee el mensaje del otro y devuelve su contenido
  read(msg) {
    const ss = this.ss
    let p = 0
    const take = (n) => { if (p + n > msg.length) throw new Error('Mensaje de saludo incompleto'); const b = msg.subarray(p, p + n); p += n; return b }
    const sLen = () => DHLEN + (ss.cs.has() ? TAGLEN : 0)
    if (!this.init && this.step === 0) {
      this.re = Buffer.from(take(DHLEN)); ss.mixHash(this.re)
    } else if (this.init && this.step === 1) {
      this.re = Buffer.from(take(DHLEN)); ss.mixHash(this.re)
      ss.mixKey(dh(this.e, this.re))
      this.rs = ss.decryptAndHash(take(sLen()))
      ss.mixKey(dh(this.e, this.rs))
    } else if (!this.init && this.step === 2) {
      this.rs = ss.decryptAndHash(take(sLen()))
      ss.mixKey(dh(this.e, this.rs))
    } else throw new Error('No me toca leer')
    const payload = ss.decryptAndHash(msg.subarray(p))
    this.step++
    if (this.step === 3) this.finish()
    return payload
  }
  finish() {
    const [c1, c2] = this.ss.split()
    this.send = this.init ? c1 : c2
    this.recv = this.init ? c2 : c1
    this.hash = Buffer.from(this.ss.h) // huella de la conversación: sirve para el código de comprobación
    this.done = true
    // fuera claves efímeras de la memoria
    if (this.e) this.e.priv.fill(0)
  }
}

// Código de 6 cifras para comparar en las dos pantallas (si coinciden, no hay nadie en medio)
const sas = (hash) => String(hmac(hash, Buffer.from('puente-sas')).readUInt32BE(0) % 1_000_000).padStart(6, '0')
// Huella corta de una clave fija, para enseñar al usuario (p. ej. «K7QM-4R2X-…»)
const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function fingerprint(pub) {
  const h = sha256(Buffer.from('puente-id'), pub)
  let s = ''
  for (let i = 0; i < 12; i++) s += B32[h[i] % B32.length]
  return s.match(/.{4}/g).join('-')
}

module.exports = { Handshake, CipherState, keyPair, sas, fingerprint, hkdf, hmac, sha256, NAME }
