// Puente — ventana, bandeja, avisos de red de casa (UDP) y el motor (engine.cjs)
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, safeStorage, nativeTheme, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const dgram = require('dgram')
const os = require('os')
const { createEngine } = require('./engine.cjs')
const { createRelay } = require('./relay.cjs')
const crypto = require('crypto')
const V = require('./validate.cjs')

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
nativeTheme.themeSource = 'dark'
app.setAppUserModelId('com.david.puente')

const UDP_PORT = 47831
let win = null, tray = null, engine = null, udp = null, quitting = false, relayHost = null
const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d)

// Las claves se guardan protegidas por Windows (DPAPI: solo tu usuario en este PC puede leerlas)
const protect = (s) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'txt:' + s)
const unprotect = (v) => { v = String(v || ''); if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); return v.replace(/^txt:/, '') }

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 820, minHeight: 600, show: false, backgroundColor: '#0b0b0c', title: 'Puente',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#d8d4cd', height: 56 },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.once('ready-to-show', () => { if (!process.argv.includes('--oculto')) win.show() })
  // nada de abrir webs ni navegar fuera de la app desde la ventana
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })
}
const showWindow = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() }

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Puente')
  tray.on('click', showWindow)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Puente', click: showWindow },
    { label: 'Botón del pánico (cortar todo)', click: () => engine.panic().then(() => notify('Puente', 'Todo cortado y lo privado borrado')) },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit() } },
  ]))
}
const notify = (title, body, onClick) => { if (!Notification.isSupported()) return; const n = new Notification({ title, body }); if (onClick) n.on('click', onClick); n.show() }

// ---------- red de casa: avisos UDP ----------
function startUdp() {
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  udp.on('message', (buf, r) => { if (buf.length > 1024) return; try { engine.onBeacon(JSON.parse(buf.toString()), r.address) } catch {} })
  udp.on('error', () => {})
  udp.bind(UDP_PORT, () => { try { udp.setBroadcast(true) } catch {} })
  const shout = () => {
    if (!engine.settings().visible && !engine.pairing()) return
    const msg = Buffer.from(JSON.stringify(engine.beacon()))
    const targets = new Set(['255.255.255.255'])
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue
      const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number)
      targets.add(ip.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.'))
    }
    for (const t of targets) udp.send(msg, UDP_PORT, t, () => {})
  }
  setInterval(shout, 3000); setTimeout(shout, 500)
  setInterval(() => send('peers', engine.peers()), 5000)
}

app.whenReady().then(async () => {
  const data = process.env.PUENTE_DATA || path.join(app.getPath('userData'), 'datos')
  engine = createEngine({ dataDir: data, name: process.env.PUENTE_NAME || os.hostname(), downloads: path.join(app.getPath('downloads'), 'Puente'), protect, unprotect, log: (m) => console.log(m) })
  const port = await engine.listen(+process.env.PUENTE_PORT || engine.settings().port)
  console.log(`Puente escuchando en el puerto ${port}`)
  // «Este PC hace de relé»: para usar Puente fuera de casa sin servidor (hay que abrir el puerto en el router)
  async function serveRelay() {
    if (relayHost) { await relayHost.close().catch(() => {}); relayHost = null }
    const rs = engine.settings().serve
    if (!rs?.on) return null
    relayHost = createRelay({ key: rs.key, log: (m) => console.log(m) })
    const port = await relayHost.listen(+rs.port || 47840, '0.0.0.0').catch(() => null)
    return port
  }
  await serveRelay()
  engine.refreshRelayListeners()

  // eventos del motor → ventana (y avisos de Windows)
  for (const ch of ['pairing', 'pair-confirm', 'pair-ended', 'pair-failed', 'transfer', 'lan', 'relay', 'wiped']) engine.ev.on(ch, (d) => send(ch, d))
  engine.ev.on('peers', () => send('peers', engine.peers()))
  engine.ev.on('intruder', (d) => send('intruder', d))
  engine.ev.on('ask', (d) => { send('ask', d); if (!win?.isFocused()) notify(`${d.name} quiere enviarte ${d.files} ${d.files === 1 ? 'archivo' : 'archivos'}`, 'Abre Puente para aceptar o rechazar', showWindow) })
  engine.ev.on('received', (d) => { send('received', d); if (!win?.isFocused()) notify('✓ Recibido', `${d.files} ${d.files === 1 ? 'archivo' : 'archivos'} de ${d.name}${d.private ? ' (sesión privada)' : ''}`, () => shell.openPath(d.saved)) })

  const E = engine
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a) } catch (e) { return { error: e.message } } })
  h('state', () => ({ fp: E.myFp, port: E.port(), addrs: E.lanAddrs(), settings: E.settings(), peers: E.peers(), transfers: E.transfers(), history: E.history(), pairing: E.pairing(), relay: E.relayStatus(), lan: E.lanVisible(), version: app.getVersion() }))
  h('pair:start', () => E.startPairing())
  h('pair:stop', () => E.stopPairing())
  h('pair:with', (o) => {
    const [host, port] = [String(o?.host || '').trim(), o?.port === undefined ? undefined : V.int(+o.port, 1, 65535, 'Puerto')]
    if (!V.isHost(host)) throw new Error('Dirección no válida')
    return E.pairWith({ host, port, code: V.code(o?.code) })
  })
  h('pair:confirm', (id, ok) => E.confirmPair(V.id(id), ok === true))
  h('lan', () => E.lanVisible())
  // Enviar: la ventana nunca da rutas. Lo elegido en el diálogo queda aquí con una ficha; lo soltado lo traduce el preload.
  const picks = new Map() // ficha → rutas
  h('pick', async (kind) => {
    const r = await dialog.showOpenDialog(win, { title: kind === 'dir' ? 'Elige carpetas para enviar' : 'Elige archivos para enviar', properties: kind === 'dir' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] })
    if (r.canceled || !r.filePaths.length) return null
    const token = crypto.randomBytes(12).toString('hex')
    picks.set(token, r.filePaths)
    setTimeout(() => picks.delete(token), 10 * 60e3).unref()
    return { token, count: r.filePaths.length }
  })
  h('send', (fp, token, o) => {
    const paths = picks.get(String(token)); picks.delete(String(token))
    if (!paths) throw new Error('Vuelve a elegir los archivos')
    return E.send(V.fp(fp), paths, { private: o?.private === true })
  })
  h('send:dropped', (fp, paths, o) => {
    // solo llega desde el preload, que saca las rutas de archivos soltados de verdad (File)
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Nada que enviar')
    return E.send(V.fp(fp), paths, { private: o?.private === true })
  })
  h('answer', (id, ok) => E.answer(V.id(id), ok === true))
  h('pickDownloads', async () => { const r = await dialog.showOpenDialog(win, { title: 'Dónde guardar lo que recibes', properties: ['openDirectory', 'createDirectory'] }); if (r.canceled) return null; return E.setSettings({ downloads: r.filePaths[0] }) })
  h('settings', (p) => E.setSettingsUi(p))
  h('serve', async (on) => {
    on = on === true
    const cur = E.settings().serve || {}
    const key = cur.key || crypto.randomBytes(18).toString('base64url')
    E.setSettings({ serve: { on: !!on, port: cur.port || 47840, key } })
    const port = await serveRelay()
    // este PC usa su propio relé (dentro de casa, por 127.0.0.1)
    if (on && port) E.setSettings({ relay: { host: '127.0.0.1', port, key } })
    if (on && !port) return { error: 'No puedo abrir el puerto 47840 (¿lo usa otro programa?)' }
    return { on: !!on, port, key, settings: E.settings() }
  })
  h('peer:set', (fp, p) => E.setPeerUi(fp, p))
  h('peer:remove', (fp) => E.removePeer(V.fp(fp)))
  h('history:clear', () => E.clearHistory())
  h('panic', () => E.panic())
  h('private:keep', (id) => E.keepPrivateId(id))
  h('private:wipe', () => E.wipeAllPrivate())
  // abrir: por id de transferencia o la carpeta de recibidos; las rutas las decide el motor
  h('openReceived', (id) => shell.openPath(E.savedOf(id)))
  h('openDownloads', async () => { const d = E.settings().downloads; await fs.promises.mkdir(d, { recursive: true }); return shell.openPath(d) })
  h('copy', (t) => clipboard.writeText(String(t).slice(0, 200)))

  createWindow()
  createTray()
  startUdp()
  app.on('second-instance', showWindow)
})
app.on('before-quit', () => { quitting = true; engine?.wipeAllPrivate?.() })
app.on('window-all-closed', () => {})
