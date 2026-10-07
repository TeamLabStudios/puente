// Lo que llega de la ventana se comprueba aquí: solo claves conocidas, del tipo y en el rango correctos.
// La ventana pide acciones; el motor decide qué rutas y recursos usa.
const HOST = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/
const isHost = (h) => typeof h === 'string' && (HOST.test(h) || IPV6.test(h))
const FP = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/
const ID = /^[0-9a-f]{8,32}$/

class Invalid extends Error {}
const bad = (m) => { throw new Invalid(m) }
const int = (v, lo, hi, what) => (Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${what}: tiene que ser un número entre ${lo} y ${hi}`))
const bool = (v, what) => (typeof v === 'boolean' ? v : bad(`${what}: tiene que ser sí o no`))
const text = (v, lo, hi, what) => (typeof v === 'string' && v.trim().length >= lo && v.length <= hi ? v.trim() : bad(`${what}: entre ${lo} y ${hi} caracteres`))

// Ajustes que la ventana puede cambiar (la carpeta de recibidos y el relé propio van por sus propias acciones)
function cleanSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('Ajustes no válidos')
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') out.name = text(v, 1, 64, 'Nombre').replace(/[\x00-\x1f]/g, '')
    else if (k === 'port') out.port = int(v, 1024, 65535, 'Puerto')
    else if (['visible', 'private', 'history', 'pet'].includes(k)) out[k] = bool(v, k)
    else if (k === 'privateMinutes') out.privateMinutes = int(v, 1, 1440, 'Minutos')
    else if (k === 'relay') {
      if (!v || typeof v !== 'object') bad('Relé no válido')
      const r = {}
      for (const [rk, rv] of Object.entries(v)) {
        if (rk === 'host') r.host = rv === '' ? '' : isHost(rv) ? rv : bad('Dirección del relé no válida')
        else if (rk === 'port') r.port = int(rv, 1, 65535, 'Puerto del relé')
        else if (rk === 'key') { if (rv !== undefined) r.key = typeof rv === 'string' && rv.length <= 200 ? rv : bad('Clave del relé demasiado larga') }
        else bad(`Ajuste desconocido: relay.${rk}`)
      }
      out.relay = r
    } else bad(`Ajuste desconocido: ${k}`)
  }
  return out
}

function cleanPeerPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('Cambio no válido')
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') out.name = text(v, 1, 64, 'Nombre')
    else if (k === 'autoAccept') out.autoAccept = bool(v, 'Aceptar siempre')
    else if (k === 'direct') {
      const d = String(v ?? '').trim()
      if (d) { const m = d.match(/^(.+?)(?::(\d{1,5}))?$/); if (!m || !isHost(m[1]) || (m[2] && (+m[2] < 1 || +m[2] > 65535))) bad('Dirección directa no válida (ip-o-nombre:puerto)') }
      out.direct = d
    } else bad(`Cambio desconocido: ${k}`)
  }
  return out
}

const fp = (v) => (typeof v === 'string' && FP.test(v) ? v : bad('Aparato no válido'))
const id = (v) => (typeof v === 'string' && ID.test(v) ? v : bad('Identificador no válido'))
const code = (v) => { const c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z2-9]{8}$/.test(c) ? c : bad('El código son 8 letras y números') }

module.exports = { cleanSettings, cleanPeerPatch, isHost, fp, id, code, int, Invalid }
