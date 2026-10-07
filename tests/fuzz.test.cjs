// Entradas hostiles: nombres y rutas, envíos enormes, mensajes rotos o trucados de un aparato emparejado, ajustes
// raros desde la ventana y el relé bajo abuso. Nada debe salirse de su carpeta, colgarse ni tumbar el motor.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), net = require('net')
const { createEngine, safeRel } = require('../electron/engine.cjs')
const { connect } = require('../electron/channel.cjs')
const { keyPair } = require('../electron/noise.cjs')
const { createRelay } = require('../electron/relay.cjs')
const V = require('../electron/validate.cjs')

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const wait = (ev, name, ms = 15000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + name)), ms); ev.once(name, (x) => { clearTimeout(t); res(x) }) })
const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : []

test('fuzz de nombres: ninguna ruta se sale de la carpeta', () => {
  const bits = ['..', '.', '/', '\\', 'C:', '\\\\srv\\c$', 'CON', 'nul.txt', 'a', 'ñ', '\u202e', '\0', ' ', '…', 'x'.repeat(300), '%2e%2e', ':', '*', '?']
  const root = path.resolve('/raiz/recibidos')
  for (let i = 0; i < 20000; i++) {
    let s = ''; const n = 1 + (i % 9)
    for (let k = 0; k < n; k++) s += bits[crypto.randomInt(bits.length)]
    const r = safeRel(s)
    if (r === null) continue
    const full = path.resolve(root, r)
    assert.ok(full.startsWith(root + path.sep), `«${s}» → ${r}`)
    for (const part of r.split(path.sep)) { assert.ok(part !== '..' && part !== '.' && part.length <= 200, r); assert.ok(!/[\x00-\x1f<>:"|?*]/.test(part), r) }
  }
})

// Un PC emparejado que se porta mal: se conecta con la identidad de A y manda lo que quiere
async function hostile() {
  const dA = tmp('fa-'), dB = tmp('fb-')
  const A = createEngine({ dataDir: dA, name: 'A', downloads: tmp('fda-') })
  const B = createEngine({ dataDir: dB, name: 'B', downloads: tmp('fdb-') })
  await A.listen(0); await B.listen(0)
  const p = B.startPairing(), cb = wait(B.ev, 'pair-confirm')
  const a = await A.pairWith({ host: '127.0.0.1', port: B.port(), code: p.code }); const b = await cb
  const ends = [wait(A.ev, 'pair-ended'), wait(B.ev, 'pair-ended')]
  A.confirmPair(a.id, true); B.confirmPair(b.id, true); await Promise.all(ends)
  B.setPeer(B.peers()[0].fp, { autoAccept: true })
  const id = keyPair(Buffer.from(JSON.parse(fs.readFileSync(path.join(dA, 'identidad.json'))).priv, 'base64'))
  const open = async () => { const s = net.connect(B.port(), '127.0.0.1'); await new Promise((r) => s.once('connect', r)); const c = await connect(s, { initiator: true, identity: id, hello: { v: 1, name: 'A' } }); c.start(); return c }
  const next = (c, ms = 5000) => new Promise((res) => { const t = setTimeout(() => res(null), ms); c.once('json', (m) => { clearTimeout(t); res(m) }); c.once('close', () => { clearTimeout(t); res({ t: '__cerrado' }) }) })
  return { A, B, open, next, stop: async () => { await A.stop(); await B.stop() } }
}

test('un aparato emparejado no puede sacar lo privado de su carpeta con un id trucado', async () => {
  const H = await hostile()
  try {
    const c = await H.open()
    const data = Buffer.from('trampa')
    c.json({ t: 'offer', id: '../../../../fuera', files: [{ fid: 1, rel: 'x.txt', size: data.length, key: 'ab' }], total: data.length, private: true, from: 'A' })
    const acc = await H.next(c); assert.equal(acc.t, 'accept')
    c.json({ t: 'file', fid: 1, from: 0 }); await c.data(1, data)
    c.json({ t: 'end', fid: 1, sha: crypto.createHash('sha256').update(data).digest('hex') }); c.json({ t: 'done' })
    assert.equal((await H.next(c)).t, 'received')
    const priv = H.B.privateDir()
    const got = walk(priv)
    assert.equal(got.length, 1); assert.ok(got[0].startsWith(priv + path.sep), got[0])
    assert.ok(!fs.existsSync(path.join(priv, '..', '..', '..', '..', 'fuera')))
    c.close()
  } finally { await H.stop() }
})

test('mensajes trucados: tamaños, rutas, demasiados archivos, desorden, basura cifrada', async () => {
  const H = await hostile()
  try {
    const bad = [
      { t: 'offer', id: 'a', files: 'no' },
      { t: 'offer', id: 'a', files: [{ fid: 1, rel: '..', size: 1 }] },
      { t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a', size: -1 }] },
      { t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a', size: 1.5 }] },
      { t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a'.repeat(5000), size: 1 }] },
      { t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a', size: 1 }, { fid: 1, rel: 'b', size: 1 }] },
      { t: 'offer', id: 'a', files: Array.from({ length: 2000 }, (_, i) => ({ fid: i + 1, rel: 'f' + i, size: 0 })).slice(0, 1500), count: 20000, more: true },
    ]
    for (const m of bad) {
      const c = await H.open()
      if (m.more) { c.json(m); for (let i = 0; i < 8; i++) c.json({ t: 'offer+', files: Array.from({ length: 1500 }, (_, k) => ({ fid: 5000 + i * 1500 + k, rel: 'g' + k, size: 0 })), more: true }) } else c.json(m)
      const r = await H.next(c)
      assert.ok(r && (r.t === 'error' || r.t === '__cerrado'), `tenía que rechazarse: ${JSON.stringify(m).slice(0, 80)} → ${JSON.stringify(r)}`)
      c.close()
    }
    // datos sin «file» antes, y más datos de los anunciados
    let c = await H.open()
    c.json({ t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a', size: 3, key: 'cd' }] }); await H.next(c)
    await c.data(1, Buffer.from('xyz')); assert.ok(['error', '__cerrado'].includes((await H.next(c)).t)); c.close()
    c = await H.open()
    c.json({ t: 'offer', id: 'a', files: [{ fid: 1, rel: 'a', size: 3, key: 'ce' }] }); await H.next(c)
    c.json({ t: 'file', fid: 1, from: 0 }); await c.data(1, Buffer.from('demasiado largo'))
    assert.ok(['error', '__cerrado'].includes((await H.next(c)).t)); c.close()
    // basura dentro del canal: se corta, el motor sigue vivo
    c = await H.open()
    c.sock.write(Buffer.from([0, 40, ...crypto.randomBytes(40)]))
    assert.equal((await H.next(c)).t, '__cerrado')
    // y sigue aceptando envíos normales
    c = await H.open()
    c.json({ t: 'offer', id: 'a', files: [{ fid: 1, rel: 'bien.txt', size: 2, key: 'cf' }] })
    assert.equal((await H.next(c)).t, 'accept'); c.close()
  } finally { await H.stop() }
})

test('envío de 3.000 archivos: la lista va en trozos y llega entera', async () => {
  const H = await hostile()
  try {
    H.A.setPeer(H.A.peers()[0].fp, { direct: '127.0.0.1:' + H.B.port() })
    const d = path.join(tmp('muchos-'), 'Fotos'); fs.mkdirSync(d)
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(d, `foto-de-las-vacaciones-de-verano-${i}.jpg`), String(i))
    const r = await H.A.send(H.A.peers()[0].fp, [d])
    assert.equal(r.status, 'hecho', r.error)
    assert.equal(fs.readdirSync(path.join(H.B.settings().downloads, 'Fotos')).length, 3000)
  } finally { await H.stop() }
})

test('quitar un aparato corta en el acto lo que tenga abierto', async () => {
  const H = await hostile()
  try {
    const c = await H.open()
    const closed = new Promise((r) => c.once('close', r))
    c.json({ t: 'offer', id: 'a', files: [{ fid: 1, rel: 'lento.bin', size: 1e6, key: 'dd' }] })
    await H.next(c)
    H.B.removePeer(H.B.peers()[0].fp)
    await Promise.race([closed, sleep(3000).then(() => assert.fail('no se cortó'))])
  } finally { await H.stop() }
})

test('ajustes desde la ventana: solo lo permitido', () => {
  assert.deepEqual(V.cleanSettings({ name: ' PC ', port: 47830, private: true, privateMinutes: 15, relay: { host: 'casa.duckdns.org', port: 47840 } }), { name: 'PC', port: 47830, private: true, privateMinutes: 15, relay: { host: 'casa.duckdns.org', port: 47840 } })
  for (const p of [{ downloads: 'C:\\' }, { serve: { on: true } }, { port: 80 }, { port: '47830' }, { privateMinutes: 0 }, { name: '' }, { name: 'x'.repeat(65) }, { relay: { host: 'a b' } }, { relay: { host: 'x', port: 0 } }, { relay: { evil: 1 } }, { __proto__: { a: 1 }, x: 1 }, null, []]) {
    assert.throws(() => V.cleanSettings(p), V.Invalid, JSON.stringify(p))
  }
  assert.throws(() => V.cleanPeerPatch({ direct: 'a;b:1' })); assert.throws(() => V.cleanPeerPatch({ secret: 'x' }))
  assert.equal(V.cleanPeerPatch({ direct: '192.168.1.5:47830' }).direct, '192.168.1.5:47830')
  assert.throws(() => V.id('../x')); assert.throws(() => V.fp('ABCD')); assert.equal(V.code('k7qm-4r2x'), 'K7QM4R2X')
})

test('relé: límites por IP y clave obligatoria', async () => {
  const relay = createRelay({ key: 'k', perIpMax: 3 })
  const port = await relay.listen(0, '127.0.0.1')
  try {
    const conns = []
    for (let i = 0; i < 5; i++) { const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); conns.push(s) }
    await sleep(300)
    assert.ok(conns.filter((s) => s.destroyed || s.readyState === 'closed').length >= 2, 'las que pasan del límite se cortan')
    conns.forEach((s) => s.destroy()); await sleep(100)
    const s = net.connect(port, '127.0.0.1')
    const got = await new Promise((r) => { s.on('data', (d) => r(d[0])); s.on('connect', () => s.write(JSON.stringify({ v: 1, room: 'a'.repeat(64), role: 'listen', key: 'mala' }) + '\n')) })
    assert.equal(got, 0, 'clave mala: rechazado')
    s.destroy()
  } finally { await relay.close() }
})
