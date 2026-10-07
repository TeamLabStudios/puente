// Un Puente de PC de verdad (el motor de electron/) manejado por líneas JSON, para probar el móvil contra él.
const path = require('path')
const readline = require('readline')
const { createEngine } = require('../../electron/engine.cjs')
const { createRelay } = require('../../electron/relay.cjs')
const { fingerprint, sas } = require('../../electron/noise.cjs')
let E = null, relay = null, auto = true
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const c = JSON.parse(line)
  try {
    let r = null
    if (c.cmd === 'init') {
      E = createEngine({ dataDir: c.dir, name: c.name, downloads: path.join(c.dir, 'descargas') })
      for (const ch of ['pair-confirm', 'pair-ended', 'pair-failed', 'received', 'intruder', 'wiped']) E.ev.on(ch, (d) => out({ ev: ch, d }))
      E.ev.on('ask', (d) => { out({ ev: 'ask', d }); if (auto) setImmediate(() => E.answer(d.id, true)) })
      E.ev.on('transfer', (d) => { if (['hecho', 'error', 'rechazado', 'cortado'].includes(d.status)) out({ ev: 'transfer', d }) })
      r = { port: await E.listen(0), fp: E.myFp }
    } else if (c.cmd === 'relay') { relay = createRelay({ key: c.key }); r = { port: await relay.listen(0, '127.0.0.1') } }
    else if (c.cmd === 'auto') { auto = c.on; r = true }
    else if (c.cmd === 'answer') r = E.answer(c.id, c.ok)
    else if (c.cmd === 'startPairing') r = E.startPairing()
    else if (c.cmd === 'pairWith') r = await E.pairWith(c)
    else if (c.cmd === 'confirm') r = E.confirmPair(c.id, c.ok)
    else if (c.cmd === 'send') r = await E.send(c.fp, c.paths, { private: !!c.private })
    else if (c.cmd === 'setPeer') r = E.setPeer(c.fp, c.patch)
    else if (c.cmd === 'settings') r = E.setSettings(c.patch)
    else if (c.cmd === 'peers') r = E.peers()
    else if (c.cmd === 'beacon') r = E.beacon()
    else if (c.cmd === 'onBeacon') { E.onBeacon(c.msg, c.host); r = E.peers() }
    else if (c.cmd === 'calc') r = { fp: fingerprint(Buffer.from(c.pub, 'base64')), sas: sas(Buffer.from(c.hash, 'hex')) }
    else if (c.cmd === 'quit') { await E?.stop(); await relay?.close(); process.exit(0) }
    out({ re: c.n, r })
  } catch (e) { out({ re: c.n, error: e.message }) }
})
