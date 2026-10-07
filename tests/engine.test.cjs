// Motor de Puente de punta a punta con dos «PC» en este mismo equipo (puertos distintos)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { createEngine, safeRel } = require('../electron/engine.cjs')
const { createRelay } = require('../electron/relay.cjs')

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const wait = (ev, name, pred = () => true, ms = 15000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + name)), ms); const f = (x) => { if (pred(x)) { clearTimeout(t); ev.off(name, f); res(x) } }; ev.on(name, f) })

async function twoPCs({ relay } = {}) {
  const A = createEngine({ dataDir: tmp('pa-'), name: 'PC-A', downloads: tmp('da-') })
  const B = createEngine({ dataDir: tmp('pb-'), name: 'PC-B', downloads: tmp('db-') })
  await A.listen(0); await B.listen(0)
  if (relay) for (const E of [A, B]) E.setSettings({ relay })
  return { A, B }
}
async function pairUp(A, B) {
  const p = B.startPairing()
  const confB = wait(B.ev, 'pair-confirm')
  const a = await A.pairWith({ host: '127.0.0.1', port: B.port(), code: p.code.toLowerCase() })
  const b = await confB
  assert.equal(a.sas, b.sas, 'el mismo código de 6 cifras en las dos pantallas')
  const endA = wait(A.ev, 'pair-ended'), endB = wait(B.ev, 'pair-ended')
  A.confirmPair(a.id, true); B.confirmPair(b.id, true)
  assert.equal((await endA).ok, true); assert.equal((await endB).ok, true)
}
// en las pruebas no hay UDP: se le dice a A dónde está B «en casa»
const seeAtHome = (A, B) => { A.onBeacon({ app: 'puente', port: B.port(), tag: undefined, fp: B.myFp }, '127.0.0.1') }

test('nombres seguros: nada de «..», rutas absolutas ni nombres reservados', () => {
  assert.equal(safeRel('../../Windows/System32/x.dll'), path.join('Windows', 'System32', 'x.dll'))
  assert.equal(safeRel('C:\\evil\\a.txt'), path.join('C_', 'evil', 'a.txt'))
  assert.equal(safeRel('\\\\servidor\\c$\\a'), path.join('servidor', 'c$', 'a'))
  assert.equal(safeRel('con.txt'), '_con.txt')
  assert.equal(safeRel('..'), null)
})

test('emparejar con código + 6 cifras, enviar archivos y carpetas, y llega exactamente igual', async () => {
  const { A, B } = await twoPCs()
  try {
    await pairUp(A, B)
    assert.equal(A.peers()[0].name, 'PC-B'); assert.equal(B.peers()[0].name, 'PC-A')
    seeAtHome(A, B)
    const src = tmp('src-')
    fs.writeFileSync(path.join(src, 'hola.txt'), 'hola mundo')
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123); fs.writeFileSync(path.join(src, 'grande.bin'), big)
    fs.mkdirSync(path.join(src, 'fotos', 'verano'), { recursive: true }); fs.writeFileSync(path.join(src, 'fotos', 'verano', 'p.jpg'), 'JPEG')
    const ask = wait(B.ev, 'ask')
    const sending = A.send(B.myFp ? A.peers()[0].fp : null, [path.join(src, 'hola.txt'), path.join(src, 'grande.bin'), path.join(src, 'fotos')])
    const q = await ask
    assert.equal(q.files, 3); assert.equal(q.name, 'PC-A')
    B.answer(q.id, true)
    const r = await sending
    assert.equal(r.status, 'hecho', r.error)
    const dl = B.settings().downloads
    assert.equal(fs.readFileSync(path.join(dl, 'hola.txt'), 'utf8'), 'hola mundo')
    assert.ok(fs.readFileSync(path.join(dl, 'grande.bin')).equals(big))
    assert.equal(fs.readFileSync(path.join(dl, 'fotos', 'verano', 'p.jpg'), 'utf8'), 'JPEG')
    assert.ok(!fs.existsSync(path.join(dl, '.puente')), 'sin restos')
    // otra vez el mismo nombre → no pisa
    const ask2 = wait(B.ev, 'ask'); const s2 = A.send(A.peers()[0].fp, [path.join(src, 'hola.txt')]); B.answer((await ask2).id, true); await s2
    assert.ok(fs.existsSync(path.join(dl, 'hola (2).txt')))
    // rechazar
    const ask3 = wait(B.ev, 'ask'); const s3 = A.send(A.peers()[0].fp, [path.join(src, 'hola.txt')]); B.answer((await ask3).id, false)
    assert.equal((await s3).status, 'rechazado')
  } finally { await A.stop(); await B.stop() }
})

test('código incorrecto, aparato desconocido y «no coincide» → no se empareja nada', async () => {
  const { A, B } = await twoPCs()
  try {
    B.startPairing()
    await assert.rejects(A.pairWith({ host: '127.0.0.1', port: B.port(), code: 'AAAA-AAAA' }))
    assert.equal(B.peers().length, 0)
    // un desconocido intentando mandar algo
    const C = createEngine({ dataDir: tmp('pc-'), name: 'Intruso', downloads: tmp('dc-') })
    await C.listen(0)
    const intr = wait(B.ev, 'intruder')
    const sock = require('net').connect(B.port(), '127.0.0.1')
    await require('../electron/channel.cjs').connect(sock, { initiator: true, identity: require('../electron/noise.cjs').keyPair(), hello: {} }).catch(() => {})
    await intr
    await C.stop()
    // el usuario dice que el código NO coincide
    const p = B.startPairing()
    const confB = wait(B.ev, 'pair-confirm')
    const a = await A.pairWith({ host: '127.0.0.1', port: B.port(), code: p.code })
    const b = await confB
    const endA = wait(A.ev, 'pair-ended')
    B.confirmPair(b.id, false)
    assert.equal((await endA).ok, false)
    assert.equal(A.peers().length + B.peers().length, 0)
  } finally { await A.stop(); await B.stop() }
})

test('fuera de casa por el relé (sin red de casa) y sesión privada que se borra sola', async () => {
  const relay = createRelay({ key: 'clave-relé' })
  const rport = await relay.listen(0, '127.0.0.1')
  const { A, B } = await twoPCs({ relay: { host: '127.0.0.1', port: rport, key: 'clave-relé' } })
  try {
    await pairUp(A, B)
    await wait(B.ev, 'relay', (v) => v === true, 10000).catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    const src = tmp('src-'); fs.writeFileSync(path.join(src, 'secreto.txt'), 'solo para ti')
    B.setSettings({ privateMinutes: 0.01 })
    const ask = wait(B.ev, 'ask')
    const sending = A.send(A.peers()[0].fp, [path.join(src, 'secreto.txt')], { private: true })
    const q = await ask
    assert.equal(q.via, 'relé'); assert.equal(q.private, true)
    const got = wait(B.ev, 'received')
    B.answer(q.id, true)
    assert.equal((await sending).status, 'hecho')
    const rec = await got
    assert.ok(rec.saved.startsWith(B.privateDir()), 'lo privado no va a Descargas')
    assert.equal(fs.readFileSync(path.join(rec.saved, 'secreto.txt'), 'utf8'), 'solo para ti')
    assert.equal(B.history().length, 0, 'sin historial')
    await wait(B.ev, 'wiped', () => true, 5000)
    assert.ok(!fs.existsSync(rec.saved), 'borrado solo')
    // con otra clave de relé no se entra
    const { relayConnect } = require('../electron/relay.cjs')
    await assert.rejects(relayConnect({ host: '127.0.0.1', port: rport, key: 'mala', role: 'dial', room: 'a'.repeat(64) }))
  } finally { await A.stop(); await B.stop(); await relay.close() }
})

test('si se corta a medias, al volver a enviarlo sigue donde lo dejó', async () => {
  const { A, B } = await twoPCs()
  try {
    await pairUp(A, B); seeAtHome(A, B)
    const src = tmp('src-'); const data = crypto.randomBytes(64 * 1024 * 1024); fs.writeFileSync(path.join(src, 'v.bin'), data)
    const ask = wait(B.ev, 'ask')
    const s1 = A.send(A.peers()[0].fp, [path.join(src, 'v.bin')])
    B.answer((await ask).id, true)
    await wait(B.ev, 'transfer', (t) => t.dir === 'in' && t.done > 1024 * 1024)
    A.panic() // corta todo
    const r1 = await s1
    assert.notEqual(r1.status, 'hecho')
    seeAtHome(A, B)
    const ask2 = wait(B.ev, 'ask')
    const s2 = A.send(A.peers()[0].fp, [path.join(src, 'v.bin')])
    B.answer((await ask2).id, true)
    const r2 = await s2
    assert.equal(r2.status, 'hecho', r2.error)
    assert.ok(r2.resumed > 0, 'siguió donde lo dejó (no empezó de cero)')
    assert.ok(fs.readFileSync(path.join(B.settings().downloads, 'v.bin')).equals(data))
  } finally { await A.stop(); await B.stop() }
})

// El relé une y lo primero del otro llega pegado al «unidos» (0x01): no se puede perder
test('relé: lo que llega junto al aviso de «unidos» no se pierde', async () => {
  const net = require('net')
  const { relayConnect } = require('../electron/relay.cjs')
  const srv = net.createServer((s) => { s.once('data', () => s.write(Buffer.concat([Buffer.from([2, 2, 1]), Buffer.from('hola')]))) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const sock = await relayConnect({ host: '127.0.0.1', port: srv.address().port, room: 'a'.repeat(64), role: 'listen' })
  await new Promise((r) => setTimeout(r, 50)) // como si el saludo empezara un poco después
  const got = await new Promise((r) => { sock.on('data', (d) => r(d.toString())); sock.resume() })
  assert.equal(got, 'hola')
  sock.destroy(); srv.close()
})
