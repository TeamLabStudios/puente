// Relé para «fuera de casa»: une dos conexiones que piden la misma «sala» y pasa los bytes tal cual.
// El relé NUNCA ve nada útil: el contenido va cifrado de punta a punta (Noise) y la sala es un número aleatorio
// que solo conocen los dos aparatos emparejados. Puede montarse en un VPS o en un PC con un puerto abierto.
//
// Protocolo (una línea al conectar): {"v":1,"room":"<64 hex>","role":"listen"|"dial","key":"<clave del relé>"}\n
// Respuesta: 0x01 = ya estáis unidos (a partir de aquí, bytes en bruto) · 0x00 = no (y se cierra)
const net = require('net')
const crypto = require('crypto')

const ROOM = /^[0-9a-f]{64}$/

// Límites (para que nadie lo tumbe a base de conexiones): total, por IP, conexiones nuevas por minuto y por IP,
// espera máxima sin pareja y conexión unida sin tráfico.
function createRelay({ key = '', maxRooms = 2000, waitMs = 30000, maxConns = 4000, perIpMax = 64, perIpPerMin = 120, maxWaitMs = 30 * 60e3, idleMs = 10 * 60e3, log = () => {} } = {}) {
  let conns = 0
  const rate = new Map() // ip → { n, since }
  const listeners = new Map() // sala → socket que espera
  const perIp = new Map()
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }

  const server = net.createServer((sock) => {
    const ip = sock.remoteAddress || '?'
    const r = rate.get(ip) || { n: 0, since: Date.now() }
    if (Date.now() - r.since > 60e3) { r.n = 0; r.since = Date.now() }
    r.n++; rate.set(ip, r)
    if (rate.size > 10000) rate.clear()
    const n = (perIp.get(ip) || 0) + 1
    if (conns >= maxConns || n > perIpMax || r.n > perIpPerMin) { sock.destroy(); return } // límites
    perIp.set(ip, n); conns++
    sock.on('close', () => { conns--; const m = (perIp.get(ip) || 1) - 1; if (m <= 0) perIp.delete(ip); else perIp.set(ip, m) })
    sock.on('error', () => {})
    sock.setNoDelay(true)
    let head = Buffer.alloc(0)
    const t = setTimeout(() => sock.destroy(), 10000)
    const onData = (d) => {
      head = Buffer.concat([head, d])
      const nl = head.indexOf(10)
      if (nl < 0) { if (head.length > 512) sock.destroy(); return }
      sock.off('data', onData); clearTimeout(t)
      const rest = head.subarray(nl + 1)
      let h
      try { h = JSON.parse(head.subarray(0, nl).toString()) } catch { return sock.destroy() }
      if (h.v !== 1 || !ROOM.test(h.room) || !['listen', 'dial'].includes(h.role) || (key && !safeEq(h.key || '', key))) { sock.end(Buffer.from([0])); return }
      if (h.role === 'listen') {
        const old = listeners.get(h.room)
        if (old) old.destroy()
        if (listeners.size >= maxRooms) { sock.end(Buffer.from([0])); return }
        listeners.set(h.room, sock)
        sock.pending = rest
        sock.on('close', () => { if (listeners.get(h.room) === sock) listeners.delete(h.room) })
        // latido para que el router no corte la espera
        const ka = setInterval(() => { if (!sock.paired) sock.write(Buffer.from([2])) }, 25000)
        const giveUp = setTimeout(() => { if (!sock.paired) sock.destroy() }, maxWaitMs) // el cliente vuelve a esperar solo
        sock.on('close', () => { clearInterval(ka); clearTimeout(giveUp) })
      } else {
        const peer = listeners.get(h.room)
        if (!peer) { sock.end(Buffer.from([0])); return }
        listeners.delete(h.room)
        peer.paired = sock.paired = true
        peer.write(Buffer.from([1])); sock.write(Buffer.from([1]))
        if (peer.pending?.length) sock.write(peer.pending)
        if (rest.length) peer.write(rest)
        sock.pipe(peer); peer.pipe(sock)
        // sin tráfico durante mucho rato: se cierra (los envíos de verdad no paran)
        sock.setTimeout(idleMs, () => sock.destroy()); peer.setTimeout(idleMs, () => peer.destroy())
        const end = () => { sock.destroy(); peer.destroy() }
        sock.on('close', end); peer.on('close', end)
        log(`relé: sala unida (${listeners.size} esperando)`)
      }
    }
    sock.on('data', onData)
  })
  server.maxConnections = maxConns + 50
  return { server, listen: (port, host) => new Promise((r) => server.listen(port, host, () => r(server.address().port))), close: () => new Promise((r) => { for (const s of listeners.values()) s.destroy(); server.close(() => r()) }), stats: () => ({ waiting: listeners.size }) }
}

// Cliente: abre una conexión al relé y devuelve el socket ya unido al otro (o falla)
function relayConnect({ host, port, room, role, key = '', timeout = 30000, onWaiting }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    sock.setNoDelay(true)
    let done = false
    const fail = (e) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); reject(e) }
    const t = role === 'dial' ? setTimeout(() => fail(new Error('El relé no responde')), timeout) : null
    sock.once('error', (e) => fail(new Error(`No llego al relé (${e.code || e.message})`)))
    sock.once('close', () => fail(new Error(role === 'listen' ? 'El relé cerró la espera' : 'El otro aparato no está conectado al relé')))
    sock.on('connect', () => { sock.write(JSON.stringify({ v: 1, room, role, key }) + '\n'); onWaiting?.(sock) })
    const onData = (d) => {
      let i = 0
      while (i < d.length && d[i] === 2) i++ // latidos
      if (i >= d.length) return
      sock.off('data', onData)
      if (d[i] !== 1) return fail(new Error('El relé no ha unido la conexión'))
      done = true; clearTimeout(t)
      sock.removeAllListeners('close'); sock.removeAllListeners('error')
      // Pausado hasta que el canal ponga sus oídos: si lo que llegó junto al 0x01 se devolviera al flujo
      // sin nadie escuchando, Node lo tiraría antes de que el saludo empiece (y el saludo se quedaría colgado).
      sock.pause()
      const rest = d.subarray(i + 1)
      if (rest.length) sock.unshift(rest)
      resolve(sock)
    }
    sock.on('data', onData)
  })
}

module.exports = { createRelay, relayConnect }
