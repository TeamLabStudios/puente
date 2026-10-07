import { useEffect, useRef, useState } from 'react'
import { X, Search, ChevronRight } from 'lucide-react'

// Nubo: la mascota que te acompaña en Puente. Te avisa de lo que pasa y te explica todo sin tecnicismos.
let loading = null
function loadEngine() {
  if (customElements.get('fluffy-friend')) return Promise.resolve()
  loading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = './vendor/fluffy-friends.js'; s.onload = res; s.onerror = rej; document.head.append(s) })
  return loading
}

// Lo que sabe explicar (se busca por palabras)
export const HELP = [
  { q: '¿Cómo empiezo?', k: 'empezar primero emparejar como', a: 'En los dos PC abre Puente. En el que va a recibir, ve a «03 Emparejar» y pulsa «Mostrar código». En el otro, escribe ese código y pulsa «Emparejar». Saldrán 6 cifras en las dos pantallas: si son iguales, pulsa «Coinciden» en los dos. Listo: ya os conocéis para siempre.' },
  { q: '¿Para qué son las 6 cifras?', k: 'cifras codigo coinciden seis sas', a: 'Son la prueba de que no hay nadie en medio. Salen de las claves que se acaban de intercambiar: si alguien intentara colarse, en cada pantalla saldría un número distinto. Si no coinciden, pulsa «No coinciden» y no se empareja nada.' },
  { q: '¿Es seguro de verdad?', k: 'seguro seguridad cifrado aes noise privado', a: 'Sí. Cada conexión usa el protocolo Noise (el de WireGuard o WhatsApp): claves nuevas cada vez y AES-256-GCM para todo lo que viaja. Si alguien toca un solo bit por el camino, se nota y se corta. Ni el router, ni el relé, ni yo podemos ver tus archivos.' },
  { q: '¿Cómo envío archivos?', k: 'enviar mandar archivos carpeta arrastrar', a: 'En «01 Enviar», arrastra archivos o carpetas encima del PC al que quieras mandarlos, o pulsa «Archivos…» en su tarjeta. El otro PC te pide permiso (salvo que le hayas puesto «Aceptar siempre»).' },
  { q: '¿Funciona fuera de casa?', k: 'fuera casa internet rele relé lejos distinta red', a: 'Sí, con un «relé»: un pequeño programa en un servidor (o en un PC con un puerto abierto) que solo pasa bytes cifrados de un lado a otro. Configúralo en «04 Ajustes → Fuera de casa» con su dirección, puerto y clave, igual en los dos PC. El relé no puede leer nada: ni archivos, ni nombres, ni quién eres.' },
  { q: '¿Cómo monto mi relé?', k: 'montar relé vps servidor puerto abrir router', a: 'En un servidor (VPS) o en un PC encendido siempre: «node relay-server.cjs --port 47840 --key una-clave-larga». Si es un PC de casa, abre el puerto 47840 (TCP) en el router hacia ese PC. Luego pon esa dirección, puerto y clave en los dos Puente.' },
  { q: '¿Y sin servidor?', k: 'sin servidor casa rele propio puerto router duckdns ip publica', a: 'Tu PC de casa puede hacer de relé: Ajustes → Fuera de casa → «Este PC hace de relé». Abre el puerto 47840 (TCP) en el router hacia ese PC. En el otro PC pon tu IP pública (búscala en «cuál es mi IP») o, mejor, un nombre gratis de DuckDNS, el puerto 47840 y la clave que enseña Puente.' },
  { q: '¿Qué es la sesión privada?', k: 'sesion privada privado borrar historial', a: 'Mientras está activa, lo que recibes no va a Descargas: se guarda aparte y se borra solo a los minutos que elijas (y al cerrar Puente). Tampoco queda en el historial. Si quieres quedarte algo, pulsa «Guardar» antes de que se borre.' },
  { q: '¿Qué hace el botón del pánico?', k: 'panico cortar todo emergencia', a: 'Corta todas las conexiones y transferencias al instante, cancela el emparejado en curso y borra todo lo recibido en sesión privada. Tus aparatos de confianza se quedan (no hay que volver a emparejar).' },
  { q: 'Windows me pregunta por el firewall', k: 'firewall cortafuegos windows permitir red', a: 'Es normal la primera vez. Permite Puente en «Redes privadas» para que tus PC de casa se encuentren. En redes públicas (cafeterías) mejor no: ahí usa el relé.' },
  { q: 'No encuentra el otro PC en casa', k: 'no encuentra aparece casa red buscar', a: 'Comprueba que los dos están en la misma WiFi/red, con Puente abierto, y que el firewall de Windows lo permite en «Redes privadas». También puedes escribir la dirección IP que sale en «03 Emparejar» del otro PC.' },
  { q: 'Se cortó a mitad', k: 'corto cortado mitad reanudar seguir', a: 'Vuelve a enviar lo mismo: Puente sigue donde lo dejó y comprueba al final que el archivo llega idéntico (con su huella SHA-256).' },
  { q: '¿Cómo quito un PC?', k: 'quitar borrar olvidar aparato revocar', a: 'En «04 Ajustes → Mis aparatos», pulsa «Quitar». Desde ese momento ese PC no puede conectarse ni enviarte nada.' },
  { q: '¿Y el móvil?', k: 'movil móvil android telefono teléfono app qr', a: 'Instala «Puente para Android» (el APK). En el PC pulsa «Mostrar código»: escanea el QR con la cámara del móvil, o en el móvil ve a «03 Emparejar», toca este PC y escribe el código. Luego el móvil sale en «01 Enviar» como un aparato más: arrastra archivos encima. Desde el móvil, «Compartir → Puente» en cualquier foto.' },
  { q: '¿Se guarda algo en internet?', k: 'nube internet guarda servidor', a: 'No. Puente no tiene nube. En casa va directo de PC a PC; fuera de casa, el relé solo reenvía datos cifrados que no puede abrir.' },
]

export function useNubo() {
  const [msg, setMsg] = useState(null) // { text, mood, action, until }
  const say = (text, { mood = 'happy', action = null, ms = 7000 } = {}) => setMsg({ text, mood, action, at: Date.now(), ms })
  return { msg, say, clear: () => setMsg(null) }
}

export default function Nubo({ msg, onClear, character = 'kuma', tips = [] }) {
  const ref = useRef()
  const [ok, setOk] = useState(true)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [ans, setAns] = useState(null)

  useEffect(() => {
    let alive = true
    loadEngine().then(() => customElements.whenDefined('fluffy-friend')).then(() => {
      const el = ref.current
      if (!alive || !el) return
      const go = () => { try { el.set?.({ character }) } catch {} }
      el.set ? go() : el.addEventListener('ready', go, { once: true })
    }).catch(() => setOk(false))
    return () => { alive = false }
  }, [character])

  // gestos al hablar
  useEffect(() => {
    if (!msg) return
    const el = ref.current
    try { el?.express?.(msg.mood || 'happy'); if (msg.action && typeof el?.[msg.action] === 'function') setTimeout(() => el[msg.action](), 250) } catch {}
    const t = setTimeout(() => onClear?.(), msg.ms || 7000)
    return () => clearTimeout(t)
  }, [msg?.at])

  const nq = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const list = nq ? HELP.filter((h) => (h.q + ' ' + h.k).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).some((w) => nq.split(/\s+/).some((x) => x.length > 2 && w.startsWith(x.slice(0, 5))))) : HELP

  return (
    <div className={`nubo ${open ? 'open' : ''}`}>
      {open && (
        <section className="nubo-panel" role="dialog" aria-label="Ayuda de Nubo">
          <header><b>Nubo · ayuda</b><button className="icon" aria-label="Cerrar ayuda" onClick={() => { setOpen(false); setAns(null) }}><X size={15} /></button></header>
          {ans ? (
            <div className="nubo-ans"><button className="link xs" onClick={() => setAns(null)}>← Otras preguntas</button><h4>{ans.q}</h4><p>{ans.a}</p></div>
          ) : (
            <>
              {tips.length > 0 && <div className="nubo-tips">{tips.map((t, i) => <p key={i}>💡 {t}</p>)}</div>}
              <label className="nubo-q"><Search size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pregúntame: «fuera de casa», «es seguro»…" /></label>
              <ul>{list.map((h) => <li key={h.q}><button onClick={() => setAns(h)}><span>{h.q}</span><ChevronRight size={14} /></button></li>)}</ul>
              {!list.length && <p className="muted xs">No sé eso todavía. Prueba con otras palabras.</p>}
            </>
          )}
        </section>
      )}
      {msg && !open && <div className="nubo-bubble" onClick={() => setOpen(true)}>{msg.text}</div>}
      <button className="nubo-pet" title="Nubo · pulsa para pedir ayuda" aria-label="Ayuda" onClick={() => setOpen(!open)}>
        {ok ? <fluffy-friend ref={ref} character={character} theme="transparent" class="nubo-ff"></fluffy-friend> : <span className="nubo-fallback">?</span>}
      </button>
    </div>
  )
}
