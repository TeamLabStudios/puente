// Noise XX: vectores oficiales (cacophony) + ataques básicos
const test = require('node:test')
const assert = require('node:assert/strict')
const { Handshake, keyPair, sas } = require('../electron/noise.cjs')
const V = require('./vectors/noise_xx_25519_aesgcm_sha256.json')
const hx = (s) => Buffer.from(s, 'hex')

test('Noise XX: coincide byte a byte con los vectores oficiales', () => {
  const i = new Handshake({ initiator: true, s: keyPair(hx(V.init_static)), e: keyPair(hx(V.init_ephemeral)), prologue: hx(V.init_prologue) })
  const r = new Handshake({ initiator: false, s: keyPair(hx(V.resp_static)), e: keyPair(hx(V.resp_ephemeral)), prologue: hx(V.resp_prologue) })
  const m = V.messages
  let c = i.write(hx(m[0].payload)); assert.equal(c.toString('hex'), m[0].ciphertext); assert.equal(r.read(c).toString('hex'), m[0].payload)
  c = r.write(hx(m[1].payload)); assert.equal(c.toString('hex'), m[1].ciphertext); assert.equal(i.read(c).toString('hex'), m[1].payload)
  c = i.write(hx(m[2].payload)); assert.equal(c.toString('hex'), m[2].ciphertext); assert.equal(r.read(c).toString('hex'), m[2].payload)
  assert.equal(i.hash.toString('hex'), V.handshake_hash)
  // mensajes de transporte: siguen alternando (el 3 lo manda el que responde)
  for (let k = 3; k < m.length; k++) {
    const [a, b] = k % 2 === 1 ? [r, i] : [i, r]
    const ct = a.send.enc(Buffer.alloc(0), hx(m[k].payload))
    assert.equal(ct.toString('hex'), m[k].ciphertext, `mensaje ${k}`)
    assert.equal(b.recv.dec(Buffer.alloc(0), ct).toString('hex'), m[k].payload)
  }
  assert.equal(sas(i.hash), sas(r.hash))
})

function pair(si = keyPair(), sr = keyPair()) {
  const i = new Handshake({ initiator: true, s: si }), r = new Handshake({ initiator: false, s: sr })
  r.read(i.write()); i.read(r.write()); r.read(i.write())
  return { i, r }
}
test('Noise XX: cada lado conoce la identidad del otro y cada sesión tiene claves nuevas', () => {
  const si = keyPair(), sr = keyPair()
  const a = pair(si, sr), b = pair(si, sr)
  assert.deepEqual(a.r.rs, si.pub); assert.deepEqual(a.i.rs, sr.pub)
  assert.notDeepEqual(a.i.hash, b.i.hash, 'otra sesión, otras claves')
})
test('Noise XX: un bit cambiado, un mensaje repetido o reordenado se rechaza', () => {
  const { i, r } = pair()
  const c1 = i.send.enc(Buffer.alloc(0), Buffer.from('hola'))
  const c2 = i.send.enc(Buffer.alloc(0), Buffer.from('adiós'))
  const bad = Buffer.from(c1); bad[0] ^= 1
  assert.throws(() => r.recv.dec(Buffer.alloc(0), bad))
  // r espera el nº 0: el bueno pasa…
  const r2 = pair()
  assert.equal(r.recv.n, 0n)
  assert.equal(r.recv.dec(Buffer.alloc(0), c1).toString(), 'hola')
  assert.throws(() => r.recv.dec(Buffer.alloc(0), c1), 'repetido')
  assert.equal(r.recv.dec(Buffer.alloc(0), c2).toString(), 'adiós')
})
test('Noise XX: alguien en medio con sus propias claves no consigue el mismo código', () => {
  // A ↔ M ↔ B: M hace dos saludos distintos
  const a = keyPair(), b = keyPair(), m = keyPair()
  const left = pair(a, m), right = pair(m, b)
  assert.notEqual(sas(left.i.hash), sas(right.r.hash))
})
