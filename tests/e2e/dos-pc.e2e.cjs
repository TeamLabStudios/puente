// Dos Puente de verdad (Electron) en este equipo: emparejar por la ventana, enviar, aceptar, recibir.
//   npx vite build && xvfb-run -a node tests/e2e/dos-pc.e2e.cjs
const { _electron } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const ROOT = path.join(__dirname, '..', '..')
// La ventana ya no puede mandar rutas: se elige con el diálogo (aquí se simula su respuesta) y se envía con su ficha
async function pickAndSend(X, fp, files) {
  await X.app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f }) }, files)
  return X.win.evaluate(async (fp) => { const k = await window.puente.pick('file'); return window.puente.send(fp, k.token, {}) }, fp)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'puente-shots-'))
async function launch(name, port) {
  const H = fs.mkdtempSync(path.join(os.tmpdir(), `puente-${name}-`))
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [ROOT, '--no-sandbox'], env: { ...process.env, HOME: H, PUENTE_DATA: path.join(H, 'datos'), PUENTE_NAME: name === 'a' ? 'PC-ESTUDIO' : 'PORTATIL', PUENTE_PORT: String(port), XDG_CONFIG_HOME: path.join(H, '.config') } })
  const logf = path.join(H, 'registro.txt')
  app.process().stdout.on('data', (d) => fs.appendFileSync(logf, `[${name} ${new Date().toISOString().slice(17, 23)}] ` + d))
  app.process().stderr.on('data', (d) => fs.appendFileSync(logf, d))
  const win = await app.firstWindow()
  const errors = []; win.on('pageerror', (e) => errors.push(e.message)); win.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) errors.push('CSP: ' + m.text()) })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 780))
  await win.waitForSelector('.wordmark')
  return { app, win, H, errors }
}
;(async () => {
  const A = await launch('a', 47950), B = await launch('b', 47960)
  try {
    await A.win.screenshot({ path: path.join(SHOTS, '01-vacio.png') })
    // B muestra el código
    await B.win.click('.nums button[aria-label="Emparejar"]')
    await B.win.click('button:has-text("Mostrar código")')
    const code = (await B.win.textContent('.code')).trim()
    // QR para el móvil con la dirección y el código
    await B.win.waitForSelector('.qr img')
    if (!(await B.win.getAttribute('.qr img', 'src')).startsWith('data:image/png')) throw new Error('falta el QR para el móvil')
    console.log('✓ QR para emparejar el móvil')
    await B.win.screenshot({ path: path.join(SHOTS, '02-codigo.png') })
    // A lo escribe
    await A.win.click('.nums button[aria-label="Emparejar"]')
    await A.win.fill('input[placeholder="192.168.1.20:47830"]', '127.0.0.1:47960')
    await A.win.fill('input[placeholder="K7QM-4R2X"]', code)
    await A.win.click('.pcard button:has-text("Emparejar")')
    await A.win.waitForSelector('.sas'); await B.win.waitForSelector('.sas')
    const sa = await A.win.textContent('.sas'), sb = await B.win.textContent('.sas')
    assert.equal(sa, sb, 'las mismas 6 cifras')
    await A.win.screenshot({ path: path.join(SHOTS, '03-cifras.png') })
    await A.win.click('.modal button.primary'); await B.win.click('.modal button.primary')
    await A.win.waitForSelector('.peer >> text=' + (await B.win.evaluate(() => window.puente.state().then((s) => s.settings.name))), { timeout: 10000 })
    await A.win.screenshot({ path: path.join(SHOTS, '04-emparejado.png') })
    // A envía (el diálogo de archivos se salta: se llama igual que el botón)
    const src = path.join(A.H, 'para-b'); fs.mkdirSync(src); fs.writeFileSync(path.join(src, 'hola.txt'), 'hola desde A'); fs.writeFileSync(path.join(src, 'foto.jpg'), Buffer.alloc(3 * 1024 * 1024, 7))
    for (let i = 0; i < 30; i++) { const ps = await A.win.evaluate(() => window.puente.state().then((s) => s.peers)); if (ps[0]?.home) break; await sleep(500) }
    const fp = (await A.win.evaluate(() => window.puente.state())).peers[0].fp
    // la ventana no puede pedir rutas ni ajustes raros
    const frontier = await A.win.evaluate(async () => [typeof window.puente.open, typeof window.puente.show, typeof window.puente.pathOf,
      (await window.puente.settings({ downloads: 'C:\\Windows' })).error, (await window.puente.settings({ port: 80 })).error, (await window.puente.settings({ privateMinutes: 'x' })).error,
      (await window.puente.send('XXXX-XXXX-XXXX', 'no-existe', {})).error, (await window.puente.privateKeep('../../x')).error, (await window.puente.peerSet('ABCD', { name: 'x' })).error])
    assert.deepEqual(frontier.slice(0, 3), ['undefined', 'undefined', 'undefined'])
    for (const e of frontier.slice(3)) assert.ok(e, 'tenía que rechazarse: ' + JSON.stringify(frontier))
    console.log('✓ la ventana no puede pedir rutas ni ajustes no válidos')
    const sending = pickAndSend(A, fp, [path.join(src, 'hola.txt'), path.join(src, 'foto.jpg')])
    await B.win.waitForSelector('.modal >> text=quiere enviarte 2 archivos', { timeout: 15000 })
    await B.win.screenshot({ path: path.join(SHOTS, '05-pregunta.png') })
    await B.win.click('.modal button:has-text("Aceptar")')
    const r = await sending
    assert.equal(r.status, 'hecho', JSON.stringify(r))
    const dl = (await B.win.evaluate(() => window.puente.state())).settings.downloads
    assert.equal(fs.readFileSync(path.join(dl, 'hola.txt'), 'utf8'), 'hola desde A')
    assert.equal(fs.statSync(path.join(dl, 'foto.jpg')).size, 3 * 1024 * 1024)
    await B.win.waitForSelector('.nubo-bubble >> text=Ha llegado todo')
    await B.win.click('.nums button[aria-label="Recibido"]')
    await B.win.waitForSelector('.tlist li')
    await B.win.screenshot({ path: path.join(SHOTS, '06-recibido.png') })
    // ayuda de Nubo
    await B.win.click('.nubo-pet'); await B.win.fill('.nubo-q input', 'fuera de casa')
    await B.win.click('.nubo-panel li button >> nth=0')
    await B.win.waitForSelector('.nubo-ans >> text=relé')
    await B.win.screenshot({ path: path.join(SHOTS, '07-nubo.png') })
    // ajustes
    await A.win.click('.nums button[aria-label="Ajustes"]'); await sleep(400)
    await A.win.screenshot({ path: path.join(SHOTS, '08-ajustes.png'), fullPage: true })
    // FUERA DE CASA: A hace de relé, nadie se anuncia en casa → B le manda algo por el relé
    await A.win.click('.nums button[aria-label="Ajustes"]')
    await A.win.click('.switch:has-text("Este PC hace de relé")')
    await A.win.waitForSelector('.serve-info')
    const sv = (await A.win.evaluate(() => window.puente.state())).settings.serve
    assert.ok(sv.on && sv.port && sv.key, JSON.stringify(sv))
    await A.win.evaluate(() => window.puente.settings({ visible: false }))
    await B.win.evaluate(([port, key]) => window.puente.settings({ visible: false, relay: { host: '127.0.0.1', port, key } }), [sv.port, sv.key])
    await sleep(16500) // lo visto en casa caduca
    fs.writeFileSync(path.join(B.H, 'lejos.txt'), 'desde fuera de casa')
    const fpA = (await B.win.evaluate(() => window.puente.state())).peers[0].fp
    const s2 = pickAndSend(B, fpA, [path.join(B.H, 'lejos.txt')])
    await A.win.waitForSelector('.modal >> text=por el relé', { timeout: 20000 }).catch(async (e) => { console.log('B:', JSON.stringify(await s2.catch((x) => x.message)), 'A relay:', await A.win.evaluate(() => window.puente.state().then((st) => [st.relay, JSON.stringify(st.settings.relay), JSON.stringify(st.settings.serve)]))); for (const X of [A, B]) try { console.log(fs.readFileSync(path.join(X.H, 'registro.txt'), 'utf8').split('\n').filter((l) => /relé|entrada|sala|Puente/.test(l)).slice(-25).join('\n')) } catch {} throw e })
    await A.win.screenshot({ path: path.join(SHOTS, '09-rele.png') })
    await A.win.click('.modal button.primary')
    const r2 = await s2
    assert.equal(r2.status, 'hecho', JSON.stringify(r2)); assert.equal(r2.via, 'relé')
    assert.deepEqual([...A.errors, ...B.errors], [])
    console.log('OK · capturas en', SHOTS)
  } finally { await A.app.close(); await B.app.close() }
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1) })
