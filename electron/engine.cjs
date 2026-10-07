// Motor de Puente (sin ventanas: se puede probar con Node). Emparejar, aparatos de confianza, enviar y recibir.
// Caminos para llegar al otro PC, por orden: 1) red de casa · 2) dirección directa (puerto abierto) · 3) relé.
// En los tres, el contenido va cifrado de punta a punta con Noise (channel.cjs): ni el router ni el relé ven nada.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const net = require('net')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { connect, CHUNK } = require('./channel.cjs')
const { keyPair, sas, fingerprint, hkdf, hmac } = require('./noise.cjs')
const { relayConnect } = require('./relay.cjs')
const V = require('./validate.cjs')

const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const randCode = (n) => { const b = crypto.randomBytes(n); let s = ''; for (const x of b) s += B32[x % B32.length]; return s }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const PAIR_TTL = 3 * 60e3, PAIR_TRIES = 5
const MAX_FILES = 10000 // por envío (los dos lados lo comprueban)
const MAX_REL = 1024 // largo máximo de una ruta dentro del envío
const OFFER_CHUNK = 48000 // la lista de archivos va en trozos: cada mensaje cifrado cabe en 64 KB

// Nombre seguro para guardar: sin rutas trucadas («..», «C:\», «\\servidor»), sin caracteres raros ni nombres reservados de Windows
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
function safePart(p) {
  let s = String(p || '').normalize('NFC').replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '').trim()
  if (!s || s === '.' || s === '..') s = '_'
  if (RESERVED.test(s)) s = '_' + s
  return s.slice(0, 200)
}
function safeRel(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..')
  if (!parts.length) return null
  return parts.slice(0, 32).map(safePart).join(path.sep)
}
const inside = (root, p) => { const r = path.resolve(root) + path.sep; return path.resolve(p).startsWith(r) }

async function uniquePath(p) {
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext)
  let q = p
  for (let i = 2; fs.existsSync(q); i++) q = path.join(dir, `${base} (${i})${ext}`)
  return q
}

// Lista de archivos de lo que mandas (carpetas enteras incluidas)
async function collect(paths) {
  const out = []
  for (const p of paths) {
    const st = await fsp.stat(p)
    if (st.isFile()) out.push({ abs: p, rel: path.basename(p), size: st.size, mtime: st.mtimeMs })
    else if (st.isDirectory()) {
      const root = path.dirname(p)
      const stack = [p]
      while (stack.length) {
        const d = stack.pop()
        for (const e of await fsp.readdir(d, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue
          const f = path.join(d, e.name)
          if (e.isDirectory()) stack.push(f)
          else if (e.isFile()) { const s = await fsp.stat(f); out.push({ abs: f, rel: path.relative(root, f), size: s.size, mtime: s.mtimeMs }) }
          if (out.length > MAX_FILES) throw new Error('Demasiados archivos de una vez (máximo 10.000): envíalo en varias tandas')
        }
      }
    }
  }
  return out
}

function createEngine({ dataDir, name = os.hostname(), downloads, protect = (b) => b, unprotect = (b) => b, now = () => Date.now(), log = () => {} }) {
  const ev = new EventEmitter()
  fs.mkdirSync(dataDir, { recursive: true })
  const F = (n) => path.join(dataDir, n)
  const readJSON = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')) } catch { return d } }
  const writeJSON = (n, v) => { const t = F(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, F(n)) }

  // ---------- identidad de este PC (clave fija, protegida con la del usuario de Windows) ----------
  let identity
  {
    const raw = readJSON('identidad.json', null)
    if (raw?.priv) identity = keyPair(Buffer.from(unprotect(raw.priv), 'base64'))
    else { identity = keyPair(); writeJSON('identidad.json', { priv: protect(identity.priv.toString('base64')), creada: new Date().toISOString() }) }
  }
  const myFp = fingerprint(identity.pub)

  // ---------- ajustes y aparatos de confianza ----------
  let settings = { serve: { on: false, port: 47840, key: '' }, name, downloads: downloads || path.join(os.homedir(), 'Downloads', 'Puente'), port: 47830, visible: true, relay: { host: '', port: 47840, key: '' }, private: false, privateMinutes: 30, history: true, ...readJSON('ajustes.json', {}) }
  const saveSettings = () => writeJSON('ajustes.json', settings)
  // peers: { fp, pub, name, secret, added, lastSeen, autoAccept, direct } — «secret» sirve para la sala del relé
  let peers = readJSON('confianza.json', []).map((p) => ({ ...p, secret: p.secret ? unprotect(p.secret) : null }))
  const savePeers = () => writeJSON('confianza.json', peers.map((p) => ({ ...p, secret: p.secret ? protect(p.secret) : null })))
  const peerByPub = (pub) => peers.find((p) => p.pub === Buffer.from(pub).toString('base64'))
  const peerByFp = (fp) => peers.find((p) => p.fp === fp)
  let history = readJSON('historial.json', [])
  const addHistory = (h) => { if (!settings.history || h.private) return; history = [h, ...history].slice(0, 500); writeJSON('historial.json', history) }

  // ---------- emparejar ----------
  let pairing = null // { code, until, tries }
  const pending = new Map() // id → { conn, sas, peer, mine, theirs, secret }
  function startPairing() {
    pairing = { code: randCode(8), until: now() + PAIR_TTL, tries: 0 }
    ev.emit('pairing', { code: fmtCode(pairing.code), until: pairing.until })
    return { code: fmtCode(pairing.code), until: pairing.until, fp: myFp, name: settings.name, port: server?.address()?.port || settings.port, addrs: lanAddrs() }
  }
  const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4)
  const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  function stopPairing() { pairing = null; ev.emit('pairing', null) }
  const proof = (code, hash, who) => hmac(Buffer.from(code), hash, Buffer.from(who)).toString('base64')
  const roomSecret = (hash) => hkdf(Buffer.from('puente-sala'), hash, 2)[0].toString('base64')

  function pairPending(conn, info) {
    const id = crypto.randomBytes(6).toString('hex')
    const p = { id, conn, sas: sas(conn.hash), name: safePart(info.name || 'PC'), fp: fingerprint(conn.peer), pub: conn.peer.toString('base64'), mine: null, theirs: null, secret: roomSecret(conn.hash) }
    pending.set(id, p)
    conn.on('close', () => { if (pending.has(id)) { pending.delete(id); ev.emit('pair-ended', { id, ok: false, reason: 'Se cortó la conexión' }) } })
    ev.emit('pair-confirm', { id, sas: p.sas, name: p.name, fp: p.fp })
    return p
  }
  function finishPair(p) {
    if (p.mine !== true || p.theirs !== true) return
    pending.delete(p.id)
    peers = peers.filter((x) => x.fp !== p.fp)
    peers.push({ fp: p.fp, pub: p.pub, name: p.name, secret: p.secret, added: new Date(now()).toISOString(), lastSeen: null, autoAccept: false, direct: '' })
    savePeers()
    stopPairing()
    ev.emit('pair-ended', { id: p.id, ok: true, name: p.name, fp: p.fp })
    ev.emit('peers')
    setTimeout(() => p.conn.close(), 200)
    refreshRelayListeners()
  }
  function confirmPair(id, ok) {
    const p = pending.get(id)
    if (!p) return false
    p.mine = !!ok
    p.conn.json({ t: 'pair-confirm', ok: !!ok })
    if (!ok) { pending.delete(id); p.conn.close(); ev.emit('pair-ended', { id, ok: false, reason: 'No coincidía: no se ha emparejado' }) }
    finishPair(p)
    return true
  }
  function watchPairConn(p) {
    p.conn.on('json', (m) => {
      if (m.t !== 'pair-confirm') return
      p.theirs = !!m.ok
      if (!m.ok) { pending.delete(p.id); p.conn.close(); ev.emit('pair-ended', { id: p.id, ok: false, reason: 'El otro PC dijo que el código no coincidía' }) } else finishPair(p)
    })
  }

  // Este PC inicia: «emparejar con 192.168.1.20 usando el código K7QM-4R2X»
  async function pairWith({ host, port, code }) {
    const sock = await tcp(host, port || settings.port)
    const conn = await connect(sock, { initiator: true, identity, hello: { mode: 'pair', v: 1 } })
    conn.start()
    const c = cleanCode(code)
    conn.json({ t: 'pair', name: settings.name, proof: proof(c, conn.hash, 'I') })
    const reply = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('El otro PC no contesta')), 15000)
      // en pausa al llegar la respuesta: si el otro confirma muy rápido, su «coinciden» no se pierde antes de escucharlo
      conn.once('json', (m) => { clearTimeout(t); conn.paused = true; res(m) })
      conn.once('close', (r) => { clearTimeout(t); rej(new Error(r || 'El otro PC cortó: ¿el código es correcto y sigue activo?')) })
    })
    if (reply.t !== 'pair-ok' || reply.proof !== proof(c, conn.hash, 'R')) { conn.close(); throw new Error('El otro PC no ha demostrado conocer el código: no es quien dice ser') }
    const p = pairPending(conn, reply)
    watchPairConn(p)
    conn.start()
    return { id: p.id, sas: p.sas, name: p.name, fp: p.fp }
  }
  // El otro PC inicia: lo atiende el servidor
  function onPairRequest(conn) {
    conn.once('json', (m) => {
      if (m.t !== 'pair' || !pairing || now() > pairing.until) { conn.close('Este PC no está en modo emparejar'); return }
      if (++pairing.tries > PAIR_TRIES) { stopPairing(); conn.close('Demasiados intentos: código anulado'); return }
      const expected = proof(pairing.code, conn.hash, 'I')
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(m.proof || '').padEnd(expected.length).slice(0, expected.length)))) { conn.close('Código incorrecto'); ev.emit('pair-failed', { reason: 'Alguien probó un código incorrecto' }); return }
      conn.json({ t: 'pair-ok', name: settings.name, proof: proof(pairing.code, conn.hash, 'R') })
      watchPairConn(pairPending(conn, m))
    })
  }

  // ---------- conexiones ----------
  const tcp = (host, port) => new Promise((res, rej) => {
    const s = net.connect({ host, port })
    s.setNoDelay(true)
    const t = setTimeout(() => { s.destroy(); rej(new Error('Sin respuesta')) }, 6000)
    s.once('connect', () => { clearTimeout(t); res(s) })
    s.once('error', (e) => { clearTimeout(t); rej(new Error(e.code === 'ECONNREFUSED' ? 'Puente no está abierto allí' : e.code || e.message)) })
  })

  function lanAddrs() {
    const out = []
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    return out
  }

  // conexiones abiertas con cada aparato: si lo quitas, se cortan en el acto
  const live = new Map() // fp → Set(conn)
  function track(fp, conn) {
    if (!live.has(fp)) live.set(fp, new Set())
    live.get(fp).add(conn)
    conn.on('close', () => { live.get(fp)?.delete(conn); if (!live.get(fp)?.size) live.delete(fp) })
  }
  let server = null
  function handleIncoming(sock, via) {
    sock.setNoDelay(true)
    connect(sock, { initiator: false, identity, hello: { v: 1, name: settings.name } }).then((conn) => {
      conn.via = via
      if (conn.hello.mode === 'pair') { onPairRequest(conn); conn.start(); return }
      const peer = peerByPub(conn.peer)
      if (!peer) { conn.close('Aparato desconocido'); ev.emit('intruder', { fp: fingerprint(conn.peer), via }); return }
      peer.lastSeen = new Date(now()).toISOString(); savePeers()
      track(peer.fp, conn)
      receive(conn, peer)
      conn.start()
    }).catch((e) => log(`entrada rechazada: ${e.message}`))
  }
  async function listen(port = settings.port) {
    server = net.createServer((s) => handleIncoming(s, 'casa'))
    await new Promise((res) => {
      server.once('error', () => { server.listen(0, '0.0.0.0', res) }) // puerto ocupado → otro cualquiera
      server.listen(port, '0.0.0.0', res)
    })
    return server.address().port
  }

  // Abrir canal con un aparato de confianza: casa → directo → relé
  async function open(peer) {
    const tries = []
    const lan = discovered.get(peer.fp)
    if (lan && now() - lan.at < 15000) tries.push(['casa', () => tcp(lan.host, lan.port)])
    if (peer.direct) { const [h, pt] = peer.direct.split(':'); tries.push(['directo', () => tcp(h, +pt || 47830)]) }
    // por el relé: si el otro está justo reconectando su espera, se reintenta un par de veces
    if (settings.relay?.host && peer.secret) tries.push(['relé', async () => {
      for (let i = 0; ; i++) {
        try { return await relayConnect({ host: settings.relay.host, port: +settings.relay.port || 47840, key: settings.relay.key, role: 'dial', room: room(peer, peer.fp) }) } catch (e) { if (i >= 3 || !/no está conectado/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 1500)) }
      }
    }])
    if (!tries.length) throw new Error(`No sé cómo llegar a «${peer.name}»: no está en tu red y no hay relé configurado`)
    const errs = []
    for (const [via, mk] of tries) {
      try {
        const sock = await mk()
        const conn = await connect(sock, { initiator: true, identity, hello: { v: 1, name: settings.name } })
        if (Buffer.compare(conn.peer, Buffer.from(peer.pub, 'base64')) !== 0) { conn.close(); throw new Error('Contestó otro aparato (no es el emparejado)') }
        conn.via = via
        return conn.start()
      } catch (e) { errs.push(`${via}: ${e.message}`) }
    }
    throw new Error(`No llego a «${peer.name}» (${errs.join(' · ')})`)
  }

  // ---------- enviar ----------
  const transfers = new Map() // id → estado para la ventana
  const pub = (t) => ({ id: t.id, dir: t.dir, peer: t.peer, name: t.name, files: t.files, size: t.size, done: t.done, status: t.status, via: t.via, error: t.error, private: t.private, at: t.at, saved: t.saved, resumed: t.resumed || 0 })
  const upd = (t, patch) => { Object.assign(t, patch); ev.emit('transfer', pub(t)) }

  async function send(fp, paths, { private: priv = false } = {}) {
    const peer = peerByFp(fp)
    if (!peer) throw new Error('Ese aparato no es de confianza')
    const list = await collect(paths)
    if (!list.length) throw new Error('No hay nada que enviar')
    const id = crypto.randomBytes(8).toString('hex')
    const t = { id, dir: 'out', peer: peer.fp, name: peer.name, files: list.length, size: list.reduce((a, f) => a + f.size, 0), done: 0, status: 'conectando', private: priv || settings.private, at: new Date(now()).toISOString() }
    transfers.set(id, t); upd(t, {})
    let conn
    try {
      conn = await open(peer)
      track(peer.fp, conn)
      upd(t, { status: 'esperando', via: conn.via })
      const files = list.map((f, i) => ({ fid: i + 1, rel: f.rel.split(path.sep).join('/'), size: f.size, key: sha256(Buffer.from(`${f.rel}|${f.size}|${Math.round(f.mtime)}`)).toString('hex').slice(0, 24) }))
      if (files.some((f) => f.rel.length > MAX_REL)) throw new Error('Hay una ruta demasiado larga para enviarla')
      // la lista va en trozos (antes, con muchos archivos, no cabía en un mensaje y el envío fallaba)
      const parts = []; let cur = [], len = 0
      for (const f of files) { const n = JSON.stringify(f).length + 1; if (cur.length && len + n > OFFER_CHUNK) { parts.push(cur); cur = []; len = 0 } cur.push(f); len += n }
      parts.push(cur)
      conn.json({ t: 'offer', id, files: parts[0], count: files.length, total: t.size, private: t.private, from: settings.name, more: parts.length > 1 })
      for (let i = 1; i < parts.length; i++) conn.json({ t: 'offer+', files: parts[i], more: i < parts.length - 1 })
      const ans = await reply(conn, ['accept', 'reject'], 10 * 60e3)
      if (ans.t === 'reject') { upd(t, { status: 'rechazado' }); conn.close(); return pub(t) }
      upd(t, { status: 'enviando' })
      const start = ans.start || {}
      for (const f of files) {
        const src = list[f.fid - 1]
        const from = Math.max(0, Math.min(+start[f.fid] || 0, f.size))
        const h = crypto.createHash('sha256')
        if (from > 0) await new Promise((res, rej) => fs.createReadStream(src.abs, { end: from - 1 }).on('data', (d) => h.update(d)).on('end', res).on('error', rej))
        t.done += from; if (from) t.resumed = (t.resumed || 0) + from
        conn.json({ t: 'file', fid: f.fid, from })
        if (f.size > from) {
          for await (const chunk of fs.createReadStream(src.abs, { start: from, highWaterMark: CHUNK * 8 })) {
            h.update(chunk)
            await conn.data(f.fid, chunk)
            t.done += chunk.length
            if (!t._last || now() - t._last > 250) { t._last = now(); upd(t, {}) }
            if (t.cancel) throw new Error('Cancelado')
          }
        }
        conn.json({ t: 'end', fid: f.fid, sha: h.digest('hex') })
      }
      conn.json({ t: 'done' })
      const fin = await reply(conn, ['received', 'error'], 120e3)
      if (fin.t === 'error') throw new Error(fin.reason || 'El otro PC no pudo guardarlo')
      upd(t, { status: 'hecho', done: t.size })
      addHistory({ ...pub(t), files: t.files })
      conn.close()
    } catch (e) {
      upd(t, { status: 'error', error: e.message })
      conn?.json({ t: 'cancel' }); conn?.close()
    }
    return pub(t)
  }
  function reply(conn, types, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { off(); rej(new Error('El otro PC no contesta')) }, ms)
      const on = (m) => { if (types.includes(m.t)) { off(); res(m) } else if (m.t === 'cancel') { off(); rej(new Error('El otro PC lo canceló')) } }
      const close = (r) => { off(); rej(new Error(r || 'Se cortó la conexión')) }
      const off = () => { clearTimeout(t); conn.off('json', on); conn.off('close', close) }
      conn.on('json', on); conn.once('close', close)
    })
  }

  // ---------- recibir ----------
  const asks = new Map() // id → resolver (aceptar / rechazar desde la ventana)
  function answer(id, ok) { const r = asks.get(id); if (!r) return false; asks.delete(id); r(!!ok); return true }

  function privateDir() { return path.join(dataDir, 'privado') }
  function receive(conn, peer) {
    let t = null, root = null, files = null, cur = null, writes = [], partial = null
    const fail = async (reason) => { if (t) upd(t, { status: 'error', error: reason }); try { conn.json({ t: 'error', reason }) } catch {}; conn.close() }
    // todo lo que llega se procesa EN ORDEN (abrir archivo, escribir, cerrar…); si el disco va lento, se frena la conexión
    let chain = Promise.resolve(), queued = 0
    const q = (fn) => {
      queued++
      if (queued > 64 && !conn.sock.isPaused()) conn.sock.pause()
      chain = chain.then(fn).catch((e) => fail(e.message)).finally(() => { queued--; if (queued < 16 && conn.sock.isPaused()) conn.sock.resume() })
    }
    conn.on('json', (m) => q(() => onJson(m)))
    conn.on('data', (fid, buf) => q(() => onData(fid, buf)))
    async function onJson(m) {
      {
        // la lista de archivos puede llegar en varios trozos
        if ((m.t === 'offer' && !t && !partial) || (m.t === 'offer+' && partial)) {
          if (!Array.isArray(m.files)) return fail('Oferta no válida')
          if (m.t === 'offer') partial = { ...m, files: [] }
          partial.files.push(...m.files)
          if (partial.files.length > MAX_FILES || (Number.isInteger(partial.count) && partial.files.length > partial.count)) return fail('Demasiados archivos de una vez')
          if (m.more) return
          m = partial; partial = null
          if (Number.isInteger(m.count) && m.files.length !== m.count) return fail('Oferta incompleta')
        }
        if (m.t === 'offer' && !t) {
          if (!Array.isArray(m.files) || m.files.length > MAX_FILES) return fail('Oferta no válida')
          files = new Map()
          for (const f of m.files) {
            const rel = safeRel(f.rel)
            if (!rel || String(f.rel).length > MAX_REL || !Number.isSafeInteger(f.size) || f.size < 0 || !Number.isInteger(f.fid) || files.has(f.fid)) return fail('Nombre o tamaño no válido')
            files.set(f.fid, { ...f, rel })
          }
          const priv = !!m.private || settings.private
          t = { id: crypto.randomBytes(8).toString('hex'), dir: 'in', peer: peer.fp, name: peer.name, files: files.size, size: [...files.values()].reduce((a, f) => a + f.size, 0), done: 0, status: 'pregunta', private: priv, via: conn.via, at: new Date(now()).toISOString(), list: [...files.values()].slice(0, 50).map((f) => ({ rel: f.rel, size: f.size })) }
          transfers.set(t.id, t)
          let ok = peer.autoAccept
          if (!ok) {
            upd(t, {})
            ev.emit('ask', { ...pub(t), list: t.list })
            ok = await new Promise((res) => { asks.set(t.id, res); conn.once('close', () => res(false)) })
          }
          if (!ok) { upd(t, { status: 'rechazado' }); conn.json({ t: 'reject' }); setTimeout(() => conn.close(), 200); return }
          root = priv ? path.join(privateDir(), t.id) : settings.downloads
          await fsp.mkdir(root, { recursive: true })
          // reanudar: si ya hay un trozo de antes del mismo archivo, se sigue desde ahí
          const start = {}
          for (const f of files.values()) {
            f.part = path.join(root, '.puente', `${f.key.replace(/[^0-9a-f]/g, '').slice(0, 24)}.part`)
            const st = await fsp.stat(f.part).catch(() => null)
            if (st && st.size <= f.size) start[f.fid] = st.size
          }
          await fsp.mkdir(path.join(root, '.puente'), { recursive: true })
          upd(t, { status: 'recibiendo' })
          conn.json({ t: 'accept', start })
        } else if (m.t === 'file' && files?.has(m.fid)) {
          const f = files.get(m.fid)
          const from = Math.max(0, Math.min(+m.from || 0, f.size))
          const h = crypto.createHash('sha256')
          if (from > 0) { await new Promise((res, rej) => fs.createReadStream(f.part, { end: from - 1 }).on('data', (d) => h.update(d)).on('end', res).on('error', rej)) } else await fsp.writeFile(f.part, '')
          if (from > 0) await fsp.truncate(f.part, from)
          t.done += from
          cur = { f, h, n: from, out: fs.createWriteStream(f.part, { flags: 'a' }) }
        } else if (m.t === 'end' && cur && cur.f.fid === m.fid) {
          const c = cur; cur = null
          await new Promise((res, rej) => c.out.end((e) => (e ? rej(e) : res())))
          if (c.n !== c.f.size || c.h.digest('hex') !== m.sha) { await fsp.rm(c.f.part, { force: true }); return fail(`«${c.f.rel}» llegó dañado: se ha descartado`) }
          const dest = path.join(root, c.f.rel)
          if (!inside(root, dest)) return fail('Ruta no permitida')
          await fsp.mkdir(path.dirname(dest), { recursive: true })
          const final = await uniquePath(dest)
          await fsp.rename(c.f.part, final)
          writes.push(final)
        } else if (m.t === 'done' && t) {
          await fsp.rm(path.join(root, '.puente'), { recursive: true, force: true }).catch(() => {})
          upd(t, { status: 'hecho', done: t.size, saved: root })
          conn.json({ t: 'received', n: writes.length })
          addHistory({ ...pub(t) })
          ev.emit('received', { ...pub(t), paths: writes.slice(0, 200) })
          if (t.private) schedulePrivateWipe(root)
          setTimeout(() => conn.close(), 300)
        } else if (m.t === 'cancel') {
          if (t) upd(t, { status: 'cancelado' })
          conn.close()
        }
      }
    }
    async function onData(fid, buf) {
      if (!cur || cur.f.fid !== fid) return fail('Datos fuera de orden')
      cur.n += buf.length
      if (cur.n > cur.f.size) return fail('Llega más de lo anunciado')
      cur.h.update(buf)
      if (!cur.out.write(buf)) await new Promise((r) => cur.out.once('drain', r))
      t.done += buf.length
      if (!t._last || now() - t._last > 250) { t._last = now(); upd(t, {}) }
    }
    conn.on('close', () => { if (t && !['hecho', 'rechazado', 'error', 'cancelado'].includes(t.status)) upd(t, { status: 'cortado', error: 'Se cortó: al volver a enviarlo seguirá donde lo dejó' }) })
  }

  // ---------- sesión privada: lo recibido se borra solo ----------
  const wipeTimers = new Map()
  function schedulePrivateWipe(dir) {
    const ms = Math.max(0.001, +settings.privateMinutes || 30) * 60e3
    clearTimeout(wipeTimers.get(dir))
    wipeTimers.set(dir, setTimeout(() => wipe(dir), ms).unref?.() || null)
  }
  async function wipe(dir) {
    if (!inside(privateDir(), dir) && path.resolve(dir) !== path.resolve(privateDir())) return
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    ev.emit('wiped', { dir })
  }
  const wipeAllPrivate = () => wipe(privateDir())
  // «Guardar» algo de la sesión privada en Descargas antes de que se borre
  // por id de la transferencia (la ventana no da rutas)
  const keepPrivateId = (id) => keepPrivate(path.join(privateDir(), V.id(id)))
  // dónde quedó lo recibido en una transferencia (lo resuelve el motor)
  function savedOf(id) {
    V.id(id)
    const t = transfers.get(id) || history.find((h) => h.id === id)
    if (!t?.saved) throw new Error('Ya no está')
    return t.saved
  }
  async function keepPrivate(dir) {
    if (!inside(privateDir(), dir)) throw new Error('No es de la sesión privada')
    if (!fs.existsSync(dir)) throw new Error('Ya se borró')
    const dest = await uniquePath(path.join(settings.downloads, 'Puente privado ' + new Date(now()).toISOString().slice(0, 10)))
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.rename(dir, dest).catch(async () => { await fsp.cp(dir, dest, { recursive: true }); await fsp.rm(dir, { recursive: true, force: true }) })
    return dest
  }

  // ---------- red de casa: avisos por UDP ----------
  // Sin emparejar solo se anuncia el nombre si estás en «modo emparejar». Si no, una marca que cambia cada 5 min
  // y que solo reconocen tus aparatos de confianza (nadie más sabe quién eres).
  const discovered = new Map() // fp → { host, port, at }
  const visibleOnLan = new Map() // para emparejar: id temporal → { name, host, port, fp, at }
  const window5 = (t = now()) => Math.floor(t / 300e3)
  const tag = (pubB64, w) => sha256(Buffer.concat([Buffer.from('puente-marca'), Buffer.from(pubB64, 'base64'), Buffer.from(String(w))])).toString('hex').slice(0, 16)
  function beacon() {
    const port = server?.address()?.port || settings.port
    if (pairing) return { app: 'puente', v: 1, port, name: settings.name, fp: myFp }
    return { app: 'puente', v: 1, port, tag: tag(identity.pub.toString('base64'), window5()) }
  }
  function onBeacon(msg, host) {
    if (msg?.app !== 'puente' || !Number.isInteger(msg.port)) return
    if (msg.fp && msg.fp === myFp) return
    if (msg.name && msg.fp) { visibleOnLan.set(msg.fp, { name: safePart(msg.name), host, port: msg.port, fp: msg.fp, at: now() }); ev.emit('lan') }
    if (msg.tag) {
      const w = window5()
      for (const p of peers) if ([tag(p.pub, w), tag(p.pub, w - 1)].includes(msg.tag)) { const was = discovered.get(p.fp); discovered.set(p.fp, { host, port: msg.port, at: now() }); if (!was) ev.emit('peers') }
    }
    if (msg.fp && peerByFp(msg.fp)) discovered.set(msg.fp, { host, port: msg.port, at: now() })
  }

  // ---------- relé: esperar a los míos ----------
  // Sala de entrada para cada aparato de confianza: HMAC(secreto compartido, «a:» + mi huella). El relé no puede saber quién es quién.
  const room = (peer, toFp) => hmac(Buffer.from(peer.secret, 'base64'), Buffer.from('sala:' + toFp)).toString('hex')
  const relayWaits = new Map() // fp → { sock, stop }
  let relayOk = null
  function refreshRelayListeners() {
    for (const [fp, w] of relayWaits) { w.stop = true; w.sock?.destroy(); relayWaits.delete(fp) }
    if (!settings.relay?.host) { relayOk = null; ev.emit('relay', relayOk); return }
    for (const p of peers) if (p.secret) waitOnRelay(p)
  }
  function waitOnRelay(p) {
    const w = { stop: false, sock: null, delay: 2000 }
    relayWaits.set(p.fp, w)
    const loop = async () => {
      while (!w.stop) {
        try {
          const sock = await relayConnect({ host: settings.relay.host, port: +settings.relay.port || 47840, key: settings.relay.key, role: 'listen', room: room(p, myFp), onWaiting: (s) => { w.sock = s; if (relayOk !== true) { relayOk = true; ev.emit('relay', relayOk) } } })
          w.delay = 2000
          log(`relé: alguien llega a la sala de ${p.name}`)
          handleIncoming(sock, 'relé')
        } catch (e) {
          if (w.stop) return
          log(`relé: espera de ${p.name} cortada (${e.message})`)
          if (relayOk !== false && !/cerró la espera/.test(e.message)) { relayOk = false; ev.emit('relay', relayOk) }
          await new Promise((r) => setTimeout(r, w.delay)); w.delay = Math.min(60000, w.delay * 2)
        }
      }
    }
    loop()
  }

  // ---------- varios ----------
  function setSettings(patch) {
    if (patch.relay && patch.relay.key === undefined) patch = { ...patch, relay: { ...patch.relay, key: settings.relay?.key || '' } } // la clave guardada no viaja a la ventana
    const relayChanged = patch.relay && JSON.stringify(patch.relay) !== JSON.stringify(settings.relay)
    settings = { ...settings, ...patch }
    saveSettings()
    if (relayChanged) refreshRelayListeners()
    return getSettings()
  }
  // desde la ventana: solo lo permitido y comprobado (la carpeta de recibidos y el relé propio van por otras acciones)
  const setSettingsUi = (patch) => setSettings(V.cleanSettings(patch))
  const setPeerUi = (fp, patch) => setPeer(V.fp(fp), V.cleanPeerPatch(patch))
  const getSettings = () => ({ ...settings, relay: { ...settings.relay, key: settings.relay?.key ? '••••••' : '' }, hasRelayKey: !!settings.relay?.key })
  function setPeer(fp, patch) {
    const p = peerByFp(fp)
    if (!p) return null
    for (const k of ['name', 'autoAccept', 'direct']) if (k in patch) p[k] = k === 'name' ? safePart(patch[k]) : k === 'direct' ? String(patch[k] || '').trim().slice(0, 100) : !!patch[k]
    savePeers(); ev.emit('peers'); return listPeers().find((x) => x.fp === fp) // sin el secreto de la sala
  }
  function removePeer(fp) {
    peers = peers.filter((p) => p.fp !== fp); savePeers()
    for (const c of live.get(fp) || []) c.close('Aparato quitado') // revocación inmediata
    discovered.delete(fp)
    refreshRelayListeners(); ev.emit('peers')
  }
  function panic() {
    // botón del pánico: corta todo, olvida claves de sesión y borra lo privado
    for (const p of pending.values()) p.conn.close()
    pending.clear(); stopPairing()
    for (const [, w] of relayWaits) { w.stop = true; w.sock?.destroy() }
    relayWaits.clear()
    for (const t of transfers.values()) t.cancel = true
    for (const set of live.values()) for (const c of set) c.close('Pánico')
    return wipeAllPrivate()
  }
  const listPeers = () => peers.map((p) => ({ fp: p.fp, name: p.name, added: p.added, lastSeen: p.lastSeen, autoAccept: p.autoAccept, direct: p.direct, home: !!(discovered.get(p.fp) && now() - discovered.get(p.fp).at < 15000), relay: !!(settings.relay?.host && relayWaits.has(p.fp)) }))

  async function stop() {
    for (const [, w] of relayWaits) { w.stop = true; w.sock?.destroy() }
    await new Promise((r) => (server ? server.close(() => r()) : r()))
  }

  return {
    ev, myFp, identityPub: identity.pub.toString('base64'), listen, stop, port: () => server?.address()?.port,
    startPairing, stopPairing, pairWith, confirmPair, pairing: () => (pairing ? { code: fmtCode(pairing.code), until: pairing.until } : null),
    send, answer, transfers: () => [...transfers.values()].map(pub), history: () => history, clearHistory: () => { history = []; writeJSON('historial.json', history) },
    peers: listPeers, setPeer, removePeer, settings: getSettings, setSettings, beacon, onBeacon, lanVisible: () => [...visibleOnLan.values()].filter((v) => now() - v.at < 10000),
    refreshRelayListeners, relayStatus: () => relayOk, panic, wipeAllPrivate, keepPrivate, keepPrivateId, savedOf, privateDir, lanAddrs, setSettingsUi, setPeerUi,
  }
}

module.exports = { createEngine, safeRel, safePart, collect, MAX_FILES }
