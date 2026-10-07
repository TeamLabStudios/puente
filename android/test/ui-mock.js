// Simula el motor Java para probar la pantalla en un navegador
(function () {
  const now = Date.now()
  const st = {
    fp: 'K7QM-4R2X-PZ9A', port: 47830, addrs: ['192.168.1.34'], receiving: true, listening: true, shared: 0, version: '0.2.0', android: 34, relay: null,
    settings: { deleteAfter: 'no', name: 'Pixel 8', port: 47830, visible: true, relayHost: '', relayPort: 47840, relayKey: '', hasRelayKey: false, private: false, privateMinutes: 30, history: true },
    peers: [{ fp: 'ABCD-EFGH-JKMN', name: 'PC-ESTUDIO', added: new Date(now - 86400e3).toISOString(), autoAccept: false, direct: '', home: true, relay: false }],
    transfers: [{ id: 't1', dir: 'out', peer: 'ABCD-EFGH-JKMN', name: 'PC-ESTUDIO', files: 12, size: 48e6, done: 21e6, status: 'enviando', via: 'casa', private: false, at: new Date().toISOString() }],
    history: [{ id: 'h1', dir: 'in', peer: 'ABCD-EFGH-JKMN', name: 'PC-ESTUDIO', files: 3, size: 5.2e6, done: 5.2e6, status: 'hecho', via: 'casa', at: new Date(now - 3600e3).toISOString() }],
    pairing: null, lan: [{ name: 'PC-SALON', host: '192.168.1.20', port: 47830, fp: 'QWER-TYUP-ASDF' }],
  }
  window.__calls = []
  const rec = (n) => (...a) => { window.__calls.push([n, ...a]); }
  window.PuenteAndroid = {
    state: () => JSON.stringify(st), lan: () => JSON.stringify(st.lan), ready: rec('ready'),
    pairStart: () => { st.pairing = { code: 'K7QM-4R2X', until: Date.now() + 180e3 }; return JSON.stringify({ ...st.pairing, port: 47830, addrs: st.addrs }) },
    pairStop: () => { st.pairing = null }, pairWith: (...a) => { window.__calls.push(['pairWith', ...a]); return '{}' }, confirm: rec('confirm'), answer: rec('answer'), cancel: rec('cancel'), pick: rec('pick'),
    sendShared: rec('sendShared'), clearShared: () => { st.shared = 0 }, settings: (j) => { const p = JSON.parse(j); if ('downloads' in p) return JSON.stringify({ error: 'Ajuste desconocido: downloads' }); Object.assign(st.settings, p); window.__calls.push(['settings', p]); return JSON.stringify(st.settings) },
    setPeer: rec('setPeer'), removePeer: rec('removePeer'), receiving: (on) => { st.receiving = on }, panic: rec('panic'), wipePrivate: rec('wipePrivate'), keep: rec('keep'),
    listPrivate: () => '[]', openPrivate: rec('openPrivate'), openReceived: rec('openReceived'), deleteSent: rec('deleteSent'), deleteConsent: rec('deleteConsent'), openDownloads: rec('openDownloads'), historyClear: rec('historyClear'), copy: rec('copy'), toast: rec('toast'),
  }
})()
