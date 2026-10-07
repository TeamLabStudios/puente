// Canal seguro sobre cualquier conexión TCP (red de casa, conexión directa o a través del relé):
// saludo Noise XX y luego mensajes cifrados con AES-256-GCM. Cada mensaje lleva delante su tamaño (2 bytes).
// Dentro del canal: 0 = mensaje de control (JSON) · 1 = trozo de archivo (id 4 bytes + datos)
const { EventEmitter } = require('events')
const { Handshake } = require('./noise.cjs')

const MAX = 65535
const TAG = 16
const CHUNK = MAX - TAG - 5 // lo que cabe de archivo en un mensaje
const EMPTY = Buffer.alloc(0)
const HELLO_TIMEOUT = 15000

class SecureConn extends EventEmitter {
  constructor(sock, hs) {
    super()
    this.sock = sock; this.hs = hs
    this.peer = hs.rs; this.hash = hs.hash
    this.closed = false
    this.paused = true; this.queue = [] // hasta que quien lo usa ponga sus oídos (start)
  }
  start() { this.paused = false; for (const m of this.queue.splice(0)) this._in(m); return this }
  _frame(pt) {
    const ct = this.hs.send.enc(EMPTY, pt)
    const len = Buffer.alloc(2); len.writeUInt16BE(ct.length)
    return this.sock.write(Buffer.concat([len, ct]))
  }
  json(obj) { if (!this.closed) this._frame(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(obj))])) }
  // datos de un archivo; espera si la conexión va llena (no se acumula todo en memoria)
  async data(fid, buf) {
    for (let p = 0; p < buf.length; p += CHUNK) {
      if (this.closed) throw new Error('Conexión cerrada')
      const head = Buffer.alloc(5); head[0] = 1; head.writeUInt32BE(fid, 1)
      const ok = this._frame(Buffer.concat([head, buf.subarray(p, p + CHUNK)]))
      if (!ok) await new Promise((r) => { const done = () => { this.sock.off('drain', done); this.off('close', done); r() }; this.sock.once('drain', done); this.once('close', done) })
    }
  }
  _in(ct) {
    if (this.paused) { this.queue.push(Buffer.from(ct)); return }
    let pt
    try { pt = this.hs.recv.dec(EMPTY, ct) } catch { return this.close('Mensaje alterado: se corta la conexión') }
    if (pt[0] === 0) { let m; try { m = JSON.parse(pt.subarray(1).toString()) } catch { return this.close('Mensaje no válido') } this.emit('json', m) }
    else if (pt[0] === 1 && pt.length >= 5) this.emit('data', pt.readUInt32BE(1), pt.subarray(5))
    else this.close('Mensaje desconocido')
  }
  close(reason) {
    if (this.closed) return
    this.closed = true
    try { this.sock.destroy() } catch {}
    // las claves de la sesión fuera de la memoria
    for (const c of [this.hs.send, this.hs.recv]) if (c?.k) c.k.fill(0)
    this.emit('close', reason || null)
  }
}

// Lee mensajes con su tamaño delante, por trozos de lo que va llegando
function framer(sock, onMsg) {
  let buf = EMPTY
  const on = (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    while (buf.length >= 2) {
      const n = buf.readUInt16BE(0)
      if (buf.length < 2 + n) break
      const m = buf.subarray(2, 2 + n)
      buf = buf.subarray(2 + n)
      if (onMsg(m) === false) { sock.off('data', on); return }
    }
  }
  sock.on('data', on)
  return () => sock.off('data', on)
}

// Hace el saludo y devuelve el canal listo. «identity» = clave fija de este aparato.
// En el saludo solo se dice el nombre visible y para qué se conecta (cifrado; desde fuera no se ve nada).
function connect(sock, { initiator, identity, hello = {} }) {
  return new Promise((resolve, reject) => {
    const hs = new Handshake({ initiator, s: identity })
    let peerHello = null, conn = null, step = 0
    const fail = (e) => { clearTimeout(t); stop?.(); try { sock.destroy() } catch {}; reject(e instanceof Error ? e : new Error(String(e))) }
    const t = setTimeout(() => fail(new Error('El otro aparato no responde')), HELLO_TIMEOUT)
    const send = (b) => { const len = Buffer.alloc(2); len.writeUInt16BE(b.length); sock.write(Buffer.concat([len, b])) }
    sock.once('error', fail)
    sock.once('close', () => { if (!conn) fail(new Error('Conexión cerrada durante el saludo')) })
    const stop = framer(sock, (m) => {
      if (conn) { conn._in(m); return }
      try {
        if (initiator) {
          if (step === 1) { peerHello = JSON.parse(hs.read(m).toString() || '{}'); send(hs.write(Buffer.from(JSON.stringify(hello)))); step = 2 }
        } else {
          if (step === 0) { hs.read(m); send(hs.write(Buffer.from(JSON.stringify(hello)))); step = 1 }
          else if (step === 1) { peerHello = JSON.parse(hs.read(m).toString() || '{}'); step = 2 }
        }
      } catch (e) { fail(new Error('Saludo no válido: ' + e.message)); return false }
      if (hs.done) {
        clearTimeout(t)
        sock.removeListener('error', fail)
        conn = new SecureConn(sock, hs)
        conn.hello = peerHello || {}
        sock.on('error', (e) => conn.close(e.message))
        sock.on('close', () => conn.close())
        resolve(conn)
      }
    })
    sock.resume() // por si llega en pausa (relé): ya hay quien escuche
    if (initiator) { send(hs.write()); step = 1 }
  })
}

module.exports = { connect, SecureConn, CHUNK }
