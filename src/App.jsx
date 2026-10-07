import { useEffect, useMemo, useRef, useState } from 'react'
import { Lock, ShieldAlert, Monitor, Wifi, Globe, WifiOff, FileUp, FolderUp, Check, X, Copy, FolderOpen, Trash2, Loader2, KeyRound, EyeOff, Save, ChevronRight } from 'lucide-react'
import Nubo, { useNubo } from './Nubo.jsx'
import QRCode from 'qrcode'

const P = window.puente
const NAV = [['enviar', 'Enviar'], ['recibido', 'Recibido'], ['emparejar', 'Emparejar'], ['ajustes', 'Ajustes']]
const num = (i) => String(i + 1).padStart(2, '0')
const bytes = (b) => { b = +b || 0; if (b < 1024) return `${b} B`; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++ } while (b >= 1024 && i < 3); return `${b.toFixed(b < 10 ? 1 : 0).replace('.', ',')} ${u[i]}` }
const ago = (iso) => { if (!iso) return 'nunca'; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'ahora'; if (s < 3600) return `hace ${Math.round(s / 60)} min`; if (s < 86400) return `hace ${Math.round(s / 3600)} h`; return new Date(iso).toLocaleDateString('es-ES') }
const STATUS = { conectando: 'Conectando…', esperando: 'Esperando a que acepte…', enviando: 'Enviando', recibiendo: 'Recibiendo', pregunta: 'Esperando tu respuesta', hecho: 'Hecho', rechazado: 'Rechazado', error: 'Error', cortado: 'Cortado', cancelado: 'Cancelado' }
const VIA = { casa: 'en casa', directo: 'directo', 'relé': 'por el relé' }

export default function App() {
  const [st, setSt] = useState(null)
  const [tab, setTab] = useState('enviar')
  const [transfers, setTransfers] = useState({})
  const [ask, setAsk] = useState(null)
  const [confirm, setConfirm] = useState(null) // emparejar: { id, sas, name, fp }
  const [toast, setToast] = useState(null)
  const nubo = useNubo()
  const toastT = useRef()
  const say = (t) => { setToast(t); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(null), 3500) }

  const load = () => P.state().then((s) => { setSt(s); setTransfers((o) => { const n = { ...o }; for (const t of s.transfers) n[t.id] = t; return n }) })
  useEffect(() => {
    load().then(() => {})
    const offs = [
      P.on.transfer((t) => setTransfers((o) => ({ ...o, [t.id]: t }))),
      P.on.peers((peers) => setSt((s) => s && { ...s, peers: Array.isArray(peers) ? peers : s.peers })),
      P.on.ask((a) => { setAsk(a); nubo.say(`${a.name} quiere enviarte ${a.files} ${a.files === 1 ? 'archivo' : 'archivos'}${a.private ? ' en sesión privada' : ''}. ¿Lo aceptas?`, { mood: 'surprised', action: 'wave', ms: 12000 }) }),
      P.on.received((r) => nubo.say(`¡Ha llegado todo de ${r.name}! ${r.files} ${r.files === 1 ? 'archivo' : 'archivos'}, comprobados uno a uno.${r.private ? ' Es privado: se borrará solo.' : ''}`, { action: 'hop' })),
      P.on.pairConfirm((c) => { setConfirm(c); nubo.say('Mira las 6 cifras: tienen que ser las mismas en los dos PC. Si coinciden, no hay nadie en medio.', { mood: 'surprised', ms: 15000 }) }),
      P.on.pairEnded((e) => { setConfirm(null); if (e.ok) { nubo.say(`¡Emparejado con ${e.name}! A partir de ahora os reconocéis solos, en casa y fuera.`, { action: 'spin' }); setTab('enviar') } else nubo.say(e.reason || 'No se ha emparejado.', { mood: 'surprised' }); load() }),
      P.on.pairFailed((e) => nubo.say(`Ojo: ${e.reason}.`, { mood: 'surprised', action: 'shake' })),
      P.on.intruder(() => nubo.say('Un aparato que no conozco ha intentado conectarse. Lo he echado: no ha visto nada.', { mood: 'surprised', action: 'shake', ms: 10000 })),
      P.on.relay((ok) => { setSt((s) => s && { ...s, relay: ok }); if (ok === false) nubo.say('No llego al relé. Revisa la dirección, el puerto y la clave en Ajustes → Fuera de casa.', { mood: 'surprised' }) }),
      P.on.pairing((p) => setSt((s) => s && { ...s, pairing: p })),
      P.on.wiped(() => nubo.say('He borrado lo de la sesión privada, como pediste.', {})),
    ]
    setTimeout(() => nubo.say('¡Hola! Soy Nubo. Si tienes dudas, pulsa sobre mí.', { ms: 6000 }), 900)
    return () => offs.forEach((f) => f())
  }, [])

  if (!st) return null
  const S = st.settings
  const set = async (patch) => { const r = await P.settings(patch); setSt((s) => ({ ...s, settings: r })) }
  const tips = []
  if (!st.peers.length) tips.push('Aún no tienes aparatos de confianza: empieza en «03 Emparejar».')
  if (!S.relay?.host) tips.push('Para usarlo fuera de casa, configura un relé en «04 Ajustes».')
  if (S.private) tips.push('Sesión privada activa: lo que recibas se borrará solo.')
  const active = Object.values(transfers).filter((t) => ['conectando', 'esperando', 'enviando', 'recibiendo'].includes(t.status))

  return (
    <div className={`app ${S.private ? 'is-private' : ''}`}>
      <div className="bg" aria-hidden="true" />
      <header className="topbar">
        <span className="wordmark">PUENTE</span>
        <nav className="nums">{NAV.map(([k, l], i) => <button key={k} className={tab === k ? 'on' : ''} aria-label={l} title={l} onClick={() => setTab(k)}>{num(i)}<span>{l}</span>{k === 'recibido' && active.length > 0 && <i className="working" />}</button>)}</nav>
        <div className="tools">
          <span className="seal" title="Todo va cifrado de punta a punta (Noise + AES-256-GCM)"><Lock size={13} /> Cifrado de punta a punta</span>
          <button className={`priv ${S.private ? 'on' : ''}`} title="Sesión privada: sin historial y lo recibido se borra solo" onClick={() => { set({ private: !S.private }); nubo.say(!S.private ? `Sesión privada activada: lo que recibas se borrará en ${S.privateMinutes} min y no quedará historial.` : 'Sesión privada desactivada.', { mood: 'happy' }) }}><EyeOff size={14} /> Privada</button>
          <PanicButton onPanic={async () => { await P.panic(); say('Todo cortado y lo privado borrado'); nubo.say('He cortado todas las conexiones y borrado lo privado. Tus aparatos siguen emparejados.', { mood: 'surprised' }); load() }} />
        </div>
      </header>

      <main className="stage">
        {tab === 'enviar' && <Enviar st={st} say={say} nubo={nubo} goPair={() => setTab('emparejar')} transfers={transfers} />}
        {tab === 'recibido' && <Recibido st={st} transfers={transfers} reload={load} say={say} />}
        {tab === 'emparejar' && <Emparejar st={st} say={say} nubo={nubo} />}
        {tab === 'ajustes' && <Ajustes st={st} set={set} reload={load} say={say} nubo={nubo} />}
      </main>

      {ask && <AskModal a={ask} onClose={() => setAsk(null)} />}
      {confirm && <ConfirmModal c={confirm} />}
      {toast && <div className="toast">{toast}</div>}
      {S.pet !== false && <Nubo msg={nubo.msg} onClear={nubo.clear} tips={tips} />}
    </div>
  )
}

function PanicButton({ onPanic }) {
  const [sure, setSure] = useState(false)
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t) }, [sure])
  return <button className={`panic ${sure ? 'sure' : ''}`} title="Botón del pánico: corta todo y borra lo privado" onClick={() => (sure ? (setSure(false), onPanic()) : setSure(true))}><ShieldAlert size={14} /> {sure ? '¿Seguro? Pulsa otra vez' : 'Pánico'}</button>
}

// ---------------- 01 Enviar ----------------
function Enviar({ st, say, nubo, goPair, transfers }) {
  const [over, setOver] = useState(null)
  // what: { token } (elegido en el diálogo) o { files } (soltado encima)
  const go = async (fp, what) => {
    if (!what || (what.files && !what.files.length)) return
    const p = st.peers.find((x) => x.fp === fp)
    nubo.say(`Mandando a ${p?.name}… Todo va cifrado; ni el router ni el relé pueden verlo.`, { action: 'hop', ms: 5000 })
    const r = what.files ? await P.sendDropped(fp, what.files, {}) : await P.send(fp, what.token, {})
    if (r?.error) { say(r.error); nubo.say(r.error, { mood: 'surprised' }) }
    else if (r.status === 'hecho') say(`✓ Enviado a ${r.name} (${bytes(r.size)})`)
    else if (r.status === 'rechazado') say(`${r.name} lo ha rechazado`)
    else if (r.error) say(r.error)
  }
  if (!st.peers.length) return (
    <section className="page center">
      <div className="hero"><span className="sn">— 01 —</span><h1>ENVIAR</h1><p className="ss">Pasa archivos entre tus PC</p></div>
      <div className="empty glass">
        <Monitor size={28} />
        <h3>Aún no hay ningún PC de confianza</h3>
        <p className="muted">Empareja una sola vez y después se reconocen solos, en casa o fuera.</p>
        <button className="primary" onClick={goPair}>Emparejar mi primer PC <ChevronRight size={15} /></button>
      </div>
    </section>
  )
  return (
    <section className="page">
      <div className="hero"><span className="sn">— 01 —</span><h1>ENVIAR</h1><p className="ss">Arrastra archivos encima de un PC</p></div>
      <div className="peers">
        {st.peers.map((p) => {
          const busy = Object.values(transfers).find((t) => t.peer === p.fp && ['conectando', 'esperando', 'enviando'].includes(t.status))
          const where = p.home ? ['en casa', Wifi, 'ok'] : p.relay && st.relay ? ['fuera · relé', Globe, 'ok'] : p.direct ? ['directo', Globe, 'maybe'] : ['sin conexión', WifiOff, 'off']
          const [label, Ico, cls] = where
          return (
            <article key={p.fp} className={`peer glass ${over === p.fp ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(p.fp) }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); go(p.fp, { files: [...e.dataTransfer.files] }) }}>
              <div className="peer-top"><Monitor size={22} /><div><b>{p.name}</b><small className="mono">{p.fp}</small></div><span className={`where ${cls}`}><Ico size={12} /> {label}</span></div>
              {busy ? (
                <div className="peer-prog"><span>{STATUS[busy.status]}{busy.via ? ` · ${VIA[busy.via] || busy.via}` : ''}</span><div className="bar"><i style={{ width: `${busy.size ? (busy.done / busy.size) * 100 : 3}%` }} /></div><em>{bytes(busy.done)} de {bytes(busy.size)}</em></div>
              ) : (
                <div className="drop"><FileUp size={18} /> Suelta aquí para enviar</div>
              )}
              <div className="peer-acts">
                <button className="ghost sm" onClick={async () => go(p.fp, await P.pick('file'))}><FileUp size={14} /> Archivos…</button>
                <button className="ghost sm" onClick={async () => go(p.fp, await P.pick('dir'))}><FolderUp size={14} /> Carpeta…</button>
                <span className="muted xs">visto {ago(p.lastSeen)}</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

// ---------------- 02 Recibido ----------------
function Recibido({ st, transfers, reload, say }) {
  const list = useMemo(() => {
    const map = new Map()
    for (const h of st.history) map.set(h.id, h)
    for (const t of Object.values(transfers)) map.set(t.id, t)
    return [...map.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }, [st.history, transfers])
  return (
    <section className="page">
      <div className="hero"><span className="sn">— 02 —</span><h1>RECIBIDO</h1><p className="ss">Lo que entra y sale</p></div>
      <div className="row end"><button className="link xs" onClick={() => P.openDownloads()}><FolderOpen size={13} /> Abrir la carpeta de recibidos</button>{st.history.length > 0 && <button className="link xs" onClick={async () => { await P.historyClear(); reload(); say('Historial borrado') }}><Trash2 size={13} /> Borrar historial</button>}</div>
      {!list.length && <p className="muted center-text">Aún no ha pasado nada por el puente.</p>}
      <ul className="tlist">
        {list.map((t) => (
          <li key={t.id} className={`glass ${t.status}`}>
            <span className={`dir ${t.dir}`}>{t.dir === 'in' ? '↓' : '↑'}</span>
            <div className="tmain">
              <b>{t.dir === 'in' ? `De ${t.name}` : `A ${t.name}`} · {t.files} {t.files === 1 ? 'archivo' : 'archivos'} · {bytes(t.size)}{t.private && <span className="pbadge"><EyeOff size={11} /> privado</span>}</b>
              <small>{STATUS[t.status] || t.status}{t.via ? ` · ${VIA[t.via] || t.via}` : ''} · {ago(t.at)}{t.error ? ` · ${t.error}` : ''}{t.resumed ? ` · siguió donde lo dejó (${bytes(t.resumed)})` : ''}</small>
              {['enviando', 'recibiendo'].includes(t.status) && <div className="bar"><i style={{ width: `${t.size ? (t.done / t.size) * 100 : 3}%` }} /></div>}
            </div>
            {t.saved && t.status === 'hecho' && <div className="row">
              <button className="ghost sm" onClick={() => P.openReceived(t.id)}><FolderOpen size={13} /> Abrir</button>
              {t.private && <button className="ghost sm" title="Sacarlo de la sesión privada para que no se borre" onClick={async () => { const r = await P.privateKeep(t.id); if (r?.error) say(r.error); else say(`Guardado en ${r}`) }}><Save size={13} /> Guardar</button>}
            </div>}
          </li>
        ))}
      </ul>
    </section>
  )
}

// QR para el móvil: la cámara abre Puente con la dirección y el código ya puestos (solo sirve 3 minutos)
function PairQR({ mine, st }) {
  const [src, setSrc] = useState(null)
  const link = useMemo(() => {
    const q = new URLSearchParams({ h: (mine.addrs || st.addrs || []).join(','), p: String(mine.port || st.port), c: mine.code, n: st.settings?.name || '' })
    return 'puente://emparejar?' + q.toString()
  }, [mine.code, mine.port])
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#0b0b0c', light: '#ece9e4' } }).then(setSrc).catch(() => setSrc(null)) }, [link])
  if (!src) return null
  return <div className="qr"><img src={src} alt="Código QR para emparejar el móvil" /><span className="muted xs">¿Es un móvil? Escanéalo con la cámara, o en Puente para Android toca este PC en «03 Emparejar».</span></div>
}

// ---------------- 03 Emparejar ----------------
function Emparejar({ st, say, nubo }) {
  const [mine, setMine] = useState(st.pairing ? { ...st.pairing, addrs: st.addrs, port: st.port } : null)
  const [left, setLeft] = useState(0)
  const [host, setHost] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [near, setNear] = useState(st.lan || [])
  useEffect(() => { const t = setInterval(() => P.lan().then((l) => Array.isArray(l) && setNear(l)), 2000); return () => clearInterval(t) }, [])
  useEffect(() => { if (!mine) return; const t = setInterval(() => { const s = Math.max(0, Math.round((mine.until - Date.now()) / 1000)); setLeft(s); if (!s) setMine(null) }, 500); return () => clearInterval(t) }, [mine])
  const show = async () => { const r = await P.pairStart(); setMine(r); nubo.say('Escribe este código en el otro PC. Caduca en 3 minutos y solo vale para 5 intentos.', { ms: 9000 }) }
  const pair = async () => {
    setBusy(true)
    const [h, pt] = host.trim().split(':')
    const r = await P.pairWith({ host: h, port: +pt || undefined, code })
    setBusy(false)
    if (r?.error) { say(r.error); nubo.say(r.error, { mood: 'surprised' }) }
  }
  return (
    <section className="page">
      <div className="hero"><span className="sn">— 03 —</span><h1>EMPAREJAR</h1><p className="ss">Una vez y para siempre</p></div>
      <div className="pair-grid">
        <div className="glass pcard">
          <h3>Este PC recibe el código</h3>
          <p className="muted sm">Pulsa y escribe el código en el otro PC.</p>
          {mine ? (
            <>
              <div className="code mono">{mine.code}</div>
              <PairQR mine={mine} st={st} />
              <p className="muted xs">Caduca en {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · dirección de este PC: <b className="mono">{(mine.addrs || st.addrs)[0] || '—'}:{mine.port || st.port}</b></p>
              <div className="row"><button className="ghost sm" onClick={() => P.copy(mine.code)}><Copy size={13} /> Copiar código</button><button className="link xs" onClick={async () => { await P.pairStop(); setMine(null) }}>Cancelar</button></div>
            </>
          ) : <button className="primary" onClick={show}><KeyRound size={15} /> Mostrar código</button>}
          <p className="muted xs mono">Huella de este PC: {st.fp}</p>
        </div>
        <div className="glass pcard">
          <h3>Este PC escribe el código</h3>
          {near.length > 0 && <div className="near"><span className="muted xs">PC cerca en modo emparejar:</span>{near.map((n) => <button key={n.fp} className="chip" onClick={() => setHost(`${n.host}:${n.port}`)}><Monitor size={13} /> {n.name}</button>)}</div>}
          <label className="field"><span>Dirección del otro PC</span><input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.20:47830" /></label>
          <label className="field"><span>Código</span><input className="input mono big" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7QM-4R2X" maxLength={9} /></label>
          <button className="primary" disabled={busy || !host.trim() || code.replace(/[^A-Z0-9]/gi, '').length < 8} onClick={pair}>{busy ? <Loader2 size={15} className="spin" /> : <Lock size={15} />} Emparejar</button>
        </div>
      </div>
      <p className="muted xs center-text">Después, los dos PC enseñan las mismas 6 cifras. Así sabes que nadie se ha metido en medio.</p>
    </section>
  )
}

function ConfirmModal({ c }) {
  const [sent, setSent] = useState(null)
  const answer = (ok) => { setSent(ok); P.pairConfirm(c.id, ok) }
  return (
    <div className="modal-back">
      <div className="modal glass narrow center">
        <h2>¿Coinciden las cifras?</h2>
        <p className="muted">En «{c.name}» tiene que salir exactamente esto:</p>
        <div className="sas mono">{c.sas.slice(0, 3)} {c.sas.slice(3)}</div>
        <p className="muted xs mono">Huella de {c.name}: {c.fp}</p>
        {sent === true ? <p className="muted"><Loader2 size={14} className="spin" /> Esperando al otro PC…</p> : (
          <div className="row center"><button className="ghost" onClick={() => answer(false)}><X size={15} /> No coinciden</button><button className="primary" onClick={() => answer(true)}><Check size={15} /> Coinciden</button></div>
        )}
      </div>
    </div>
  )
}

function AskModal({ a, onClose }) {
  const [always, setAlways] = useState(false)
  const reply = async (ok) => { if (ok && always) await P.peerSet(a.peer, { autoAccept: true }); await P.answer(a.id, ok); onClose() }
  return (
    <div className="modal-back">
      <div className="modal glass narrow">
        <h2>{a.name} quiere enviarte {a.files} {a.files === 1 ? 'archivo' : 'archivos'}</h2>
        <p className="muted">{bytes(a.size)} · {VIA[a.via] || a.via}{a.private && <span className="pbadge"><EyeOff size={11} /> sesión privada: se borrará solo</span>}</p>
        <ul className="flist">{(a.list || []).map((f, i) => <li key={i}><span>{f.rel}</span><em>{bytes(f.size)}</em></li>)}{a.files > (a.list || []).length && <li className="muted">y {a.files - a.list.length} más…</li>}</ul>
        <label className="check"><input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> Aceptar siempre lo que mande este PC</label>
        <div className="row end"><button className="ghost" onClick={() => reply(false)}>Rechazar</button><button className="primary" onClick={() => reply(true)}><Check size={15} /> Aceptar</button></div>
      </div>
    </div>
  )
}

// ---------------- 04 Ajustes ----------------
function Ajustes({ st, set, reload, say, nubo }) {
  const S = st.settings
  const [relay, setRelay] = useState({ host: S.relay?.host || '', port: S.relay?.port || 47840, key: '' })
  const [name, setName] = useState(S.name)
  const saveRelay = async () => { await set({ relay: { host: relay.host.trim(), port: +relay.port || 47840, key: relay.key || (S.hasRelayKey ? undefined : '') } }); reload(); say('Relé guardado'); nubo.say(relay.host ? 'Conectando con tu relé… si sale bien, verás «fuera · relé» en tus PC.' : 'Sin relé: solo funcionará en casa o con dirección directa.', {}) }
  return (
    <section className="page">
      <div className="hero"><span className="sn">— 04 —</span><h1>AJUSTES</h1><p className="ss">A tu manera, siempre seguro</p></div>
      <div className="glass card">
        <h3>Este PC</h3>
        <label className="field inline"><span>Nombre que ven tus otros PC</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && set({ name: name.trim() })} /></label>
        <div className="field inline"><span>Lo recibido se guarda en</span><div className="row"><code className="mono xs">{S.downloads}</code><button className="ghost sm" onClick={async () => { const r = await P.pickDownloads(); if (r) reload() }}>Cambiar</button></div></div>
        <Toggle on={S.visible} set={(v) => set({ visible: v })} label="Que mis PC me encuentren en casa" hint="Solo tus aparatos de confianza te reconocen; para los demás eres invisible." />
        <Toggle on={S.pet !== false} set={(v) => set({ pet: v })} label="Nubo, la mascota que ayuda" />
      </div>

      <div className="glass card">
        <h3>Privacidad</h3>
        <Toggle on={S.private} set={(v) => set({ private: v })} label="Sesión privada" hint="Sin historial; lo que recibes no va a Descargas y se borra solo." />
        <div className="field inline"><span>Borrar lo privado a los</span><select className="input mini" value={S.privateMinutes} onChange={(e) => set({ privateMinutes: +e.target.value })}>{[5, 15, 30, 60, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</select></div>
        <Toggle on={S.history} set={(v) => set({ history: v })} label="Guardar historial" hint="Solo en este PC. Nunca de la sesión privada." />
        <div className="row"><button className="ghost sm" onClick={async () => { await P.privateWipe(); say('Lo privado, borrado') }}><Trash2 size={13} /> Borrar ya lo privado</button></div>
      </div>

      <div className="glass card">
        <h3>Fuera de casa <span className={`dot ${st.relay === true ? 'ok' : st.relay === false ? 'bad' : ''}`} /></h3>
        <p className="muted sm">Un relé solo pasa bytes cifrados de un PC a otro: no puede leer nada. Pon lo mismo en los dos PC.</p>
        <div className="relay-grid">
          <label className="field"><span>Dirección del relé</span><input className="input mono" value={relay.host} onChange={(e) => setRelay({ ...relay, host: e.target.value })} placeholder="mirele.duckdns.org" /></label>
          <label className="field"><span>Puerto</span><input className="input mono" value={relay.port} onChange={(e) => setRelay({ ...relay, port: e.target.value })} /></label>
          <label className="field"><span>Clave del relé</span><input className="input mono" type="password" value={relay.key} onChange={(e) => setRelay({ ...relay, key: e.target.value })} placeholder={S.hasRelayKey ? '•••••• (guardada)' : 'la que pusiste al montarlo'} /></label>
        </div>
        <Toggle on={S.serve?.on} set={async (v) => { const r = await P.serve(v); if (r?.error) { say(r.error); nubo.say(r.error, { mood: 'surprised' }) } else { reload(); if (v) nubo.say('Este PC ya hace de relé. Abre el puerto 47840 (TCP) en tu router hacia este PC y, en el otro PC, pon tu IP pública (o tu nombre DuckDNS), el puerto y la clave que te enseño.', { ms: 14000 }) } }} label="Este PC hace de relé (sin servidor)" hint="Para tu PC de casa encendido. Hay que abrir el puerto en el router." />
        {S.serve?.on && <div className="serve-info"><span className="muted xs">En el otro PC pon: dirección = tu IP pública o DuckDNS · puerto <b className="mono">{S.serve.port}</b> · clave</span><code className="mono">{S.serve.key}</code><button className="ghost sm" onClick={() => { P.copy(S.serve.key); say('Clave copiada') }}><Copy size={13} /> Copiar clave</button></div>}
        <div className="row"><button className="primary sm" onClick={saveRelay}>Guardar relé</button><span className="muted xs">{st.relay === true ? 'Conectado al relé' : st.relay === false ? 'No llego al relé' : 'Sin relé'}</span></div>
      </div>

      <div className="glass card">
        <h3>Mis aparatos de confianza</h3>
        {!st.peers.length && <p className="muted sm">Ninguno todavía.</p>}
        {st.peers.map((p) => <PeerRow key={p.fp} p={p} reload={reload} say={say} />)}
      </div>
      <p className="muted xs center-text mono">Puente {st.version} · huella {st.fp} · puerto {st.port}</p>
    </section>
  )
}
function PeerRow({ p, reload, say }) {
  const [direct, setDirect] = useState(p.direct || '')
  const [rm, setRm] = useState(false)
  return (
    <div className="peer-row">
      <div><b>{p.name}</b><small className="mono"> {p.fp} · emparejado {ago(p.added)}</small></div>
      <label className="check xs"><input type="checkbox" checked={p.autoAccept} onChange={async (e) => { await P.peerSet(p.fp, { autoAccept: e.target.checked }); reload() }} /> Aceptar siempre</label>
      <input className="input mini mono" value={direct} onChange={(e) => setDirect(e.target.value)} onBlur={async () => { await P.peerSet(p.fp, { direct }); reload() }} placeholder="dirección directa (opcional)" title="Si ese PC tiene un puerto abierto: ip-o-nombre:47830" />
      {rm ? <><button className="ghost sm danger" onClick={async () => { await P.peerRemove(p.fp); reload(); say(`${p.name} ya no es de confianza`) }}>Sí, quitar</button><button className="link xs" onClick={() => setRm(false)}>No</button></> : <button className="ghost sm" onClick={() => setRm(true)}><Trash2 size={13} /> Quitar</button>}
    </div>
  )
}
function Toggle({ on, set, label, hint }) {
  return <label className="switch"><input type="checkbox" checked={!!on} onChange={(e) => set(e.target.checked)} /><span className="track"><span className="thumb" /></span><span className="switch-text"><span>{label}</span>{hint && <small>{hint}</small>}</span></label>
}
