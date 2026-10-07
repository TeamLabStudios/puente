// Puente: lo único que la ventana puede pedir al motor
const { contextBridge, ipcRenderer, webUtils } = require('electron')
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a)
const on = (ch) => (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h) }
contextBridge.exposeInMainWorld('puente', {
  state: call('state'), pairStart: call('pair:start'), pairStop: call('pair:stop'), pairWith: call('pair:with'), pairConfirm: call('pair:confirm'), lan: call('lan'),
  send: call('send'),
  // archivos soltados encima: solo objetos File de verdad; la ruta la saca el preload, no la página
  sendDropped: (fp, files, o) => {
    const paths = [...(files || [])].filter((f) => f instanceof File).map((f) => webUtils.getPathForFile(f)).filter(Boolean)
    return ipcRenderer.invoke('send:dropped', fp, paths, o)
  },
  answer: call('answer'), pick: call('pick'), pickDownloads: call('pickDownloads'), settings: call('settings'), serve: call('serve'),
  peerSet: call('peer:set'), peerRemove: call('peer:remove'), historyClear: call('history:clear'), panic: call('panic'),
  privateKeep: call('private:keep'), privateWipe: call('private:wipe'), openReceived: call('openReceived'), openDownloads: call('openDownloads'), copy: call('copy'),
  on: { pairing: on('pairing'), pairConfirm: on('pair-confirm'), pairEnded: on('pair-ended'), pairFailed: on('pair-failed'), transfer: on('transfer'), ask: on('ask'), received: on('received'), peers: on('peers'), lan: on('lan'), relay: on('relay'), intruder: on('intruder'), wiped: on('wiped') },
})
