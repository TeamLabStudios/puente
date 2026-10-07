#!/usr/bin/env node
// Relé de Puente para usar fuera de casa. En un VPS o en un PC con el puerto abierto:
//   node relay-server.cjs --port 47840 --key "una-clave-larga"
// (la clave evita que otros usen tu relé; ponla igual en Puente → Ajustes → Fuera de casa)
const { createRelay } = require('./relay.cjs')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const port = +arg('--port', process.env.PUENTE_RELAY_PORT || 47840)
const key = arg('--key', process.env.PUENTE_RELAY_KEY || '')
if (!key) console.warn('Aviso: sin --key, cualquiera podría usar tu relé (no podría leer nada, pero gastaría tu conexión).')
// límites (opcionales): --max-conns 4000 --por-ip 64
const relay = createRelay({ key, maxConns: +arg('--max-conns', 4000), perIpMax: +arg('--por-ip', 64), log: (m) => console.log(new Date().toISOString(), m) })
relay.listen(port, '0.0.0.0').then((p) => console.log(`Relé de Puente escuchando en el puerto ${p}`))
