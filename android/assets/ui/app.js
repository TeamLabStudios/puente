'use strict';
// Puente para Android: la pantalla. Habla con el motor (Java) por window.PuenteAndroid; los avisos llegan por puente.ev().
(function () {
  const A = window.PuenteAndroid;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const J = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
  const bytes = (n) => { n = +n || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i]; };
  const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
  const ago = (iso) => { if (!iso) return ''; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return 'ahora'; if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min'; if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h'; return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }); };
  const I = {
    img: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  };

  // ---------- estado ----------
  let delAsks = {}, consent = 0, manual = false;
  let S = null, tab = 'enviar', asks = {}, confirm = null, mine = null, picked = { host: '', port: 47830 }, privFiles = {}, panicArm = 0, lanTimer = null;
  const load = () => { S = J(A.state(), S) || S; return S; };
  // lo que el motor no acepta vuelve con { error }
  const tryJ = (s) => { const r = J(s, {}); if (r && r.error) { toast(r.error, 5000); return null; } return r; };
  const setS = (patch) => tryJ(A.settings(JSON.stringify(patch)));
  const peerName = (fp) => (S.peers.find((p) => p.fp === fp) || {}).name || 'aparato';

  function toast(t, ms = 3200) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), ms); }

  // ---------- Nubo ----------
  const ff = $('#ff');
  function say(text, o = {}) {
    const b = $('#nuboBubble'); b.textContent = text; b.classList.add('show');
    try { ff.express && ff.express(o.mood || 'happy'); if (o.action && typeof ff[o.action] === 'function') setTimeout(() => ff[o.action](), 250); } catch (e) {}
    clearTimeout(say.t); say.t = setTimeout(() => b.classList.remove('show'), o.ms || 7000);
  }
  $('#nuboBubble').onclick = () => openHelp();
  $('#nuboPet').onclick = () => openHelp();
  try { customElements.whenDefined('fluffy-friend').then(() => { try { ff.set && ff.set({ character: 'kuma' }); } catch (e) {} }); } catch (e) {}
  // sin el motor de la mascota (no va en el código público): Nubo sale como una burbuja con «?»
  if (!customElements.get('fluffy-friend')) $('#nuboPet').classList.add('plain');

  const HELP = [
    ['¿Cómo empiezo?', 'En el PC abre Puente y ve a «03 Emparejar» → «Mostrar código». En el móvil, en «03 Emparejar», toca tu PC en la lista (o escribe su dirección), escribe el código y pulsa «Emparejar». Saldrán 6 cifras en los dos: si son iguales, pulsa «Coinciden» en los dos. Listo para siempre.'],
    ['¿Para qué son las 6 cifras?', 'Son la prueba de que no hay nadie en medio. Salen de las claves que se acaban de intercambiar: si alguien intentara colarse, cada pantalla mostraría un número distinto.'],
    ['¿Es seguro de verdad?', 'Sí. Cada conexión usa Noise (el marco de WireGuard y WhatsApp) con claves nuevas cada vez y AES-256-GCM. Si alguien cambia un solo bit por el camino, se nota y se corta. Ni la WiFi, ni el relé, ni yo vemos tus archivos. Tus claves se guardan cifradas con el almacén de claves del móvil.'],
    ['¿Cómo envío fotos al PC?', 'En «01 Enviar», toca «Fotos» en la tarjeta de tu PC y elige. También puedes compartir desde la galería o cualquier app: «Compartir» → Puente → elige el PC.'],
    ['¿Cómo recibo del PC?', 'Deja «Recibir» encendido (Ajustes). En el PC arrastra archivos sobre la tarjeta de tu móvil. Aquí te preguntaré si lo aceptas (o sale una notificación con «Aceptar»). Lo recibido va a Descargas › Puente.'],
    ['El móvil no encuentra el PC', 'Los dos tienen que estar en la misma WiFi, con Puente abierto. En Windows, permite Puente en «Redes privadas» del firewall. Si sigue sin salir, escribe la dirección IP que enseña el PC en «03 Emparejar».'],
    ['¿Funciona fuera de casa?', 'Sí, con un relé: pon en «04 Ajustes → Fuera de casa» la misma dirección, puerto y clave que en el PC. El relé solo pasa datos cifrados que no puede abrir.'],
    ['¿Qué es la sesión privada?', 'Lo que recibes no va a Descargas: se guarda dentro de Puente y se borra solo a los minutos que elijas. Tampoco queda en el historial. Pulsa «Guardar» si quieres quedártelo.'],
    ['¿Qué hace el botón del pánico?', 'Corta todas las conexiones y envíos, cancela el emparejado y borra lo privado. Tus aparatos de confianza se quedan. Hay que tocarlo dos veces.'],
    ['¿Puede borrar del móvil lo que envío?', 'Sí, si quieres: «04 Ajustes → Después de enviar». «Conservar» no borra nada, «Preguntar» te pregunta al terminar cada envío y «Borrar» lo hace solo. Solo se borra cuando el PC confirma que TODO llegó idéntico (huella SHA-256 de cada archivo); nunca si falla, se corta o va en sesión privada. Android puede pedirte permiso para las fotos de la galería.'],
    ['¿Gasta batería?', 'Con «Recibir» encendido, Puente espera conexiones con una notificación fija. Gasta poco, pero si no lo usas puedes apagarlo en Ajustes: seguirás pudiendo enviar.'],
    ['¿Cómo quito un aparato?', 'En «04 Ajustes → Mis aparatos», «Quitar». Desde ese momento no puede conectarse ni enviarte nada.'],
  ];
  function openHelp() {
    $('#nuboBubble').classList.remove('show');
    const tips = [];
    if (S && !S.peers.length) tips.push('Aún no tienes aparatos: empieza por «03 Emparejar».');
    if (S && S.relay === false) tips.push('No llego al relé: revisa la dirección y la clave en Ajustes.');
    if (S && !S.receiving) tips.push('«Recibir» está apagado: el PC no podrá enviarte nada.');
    showModal(`<div class="help"><h2>Nubo · ayuda <button class="link" data-close>Cerrar</button></h2>
      ${tips.length ? '<div class="tips">' + tips.map((t) => '<p>💡 ' + esc(t) + '</p>').join('') + '</div>' : ''}
      <ul>${HELP.map((h, i) => `<li><button data-h="${i}"><span>${esc(h[0])}</span><span class="faint">›</span></button></li>`).join('')}</ul></div>`);
    $('#modal').querySelectorAll('[data-h]').forEach((b) => (b.onclick = () => {
      const h = HELP[+b.dataset.h];
      showModal(`<div class="help"><h2>${esc(h[0])}</h2><p>${esc(h[1])}</p><div class="row"><button class="btn" data-back>← Otras preguntas</button><button class="btn primary" data-close>Entendido</button></div></div>`);
      $('[data-back]').onclick = openHelp;
    }));
  }

  // ---------- ventanas ----------
  function showModal(html) {
    $('#modal').innerHTML = `<div class="back"><div class="modal">${html}</div></div>`;
    $('#modal').querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
  }
  function closeModal() { $('#modal').innerHTML = ''; showNext(); }
  function modalOpen() { return !!$('#modal').firstChild; }
  // lo urgente primero: confirmar 6 cifras, luego preguntas de recibir
  function showNext() {
    if (modalOpen()) return;
    if (confirm) return showConfirm();
    const a = Object.values(asks)[0];
    if (a) return showAsk(a);
    const da = Object.values(delAsks)[0];
    if (da) return showDelAsk(da);
    if (consent > 0) return showConsent();
  }
  function showDelAsk(d) {
    showModal(`<h2>Ya está en ${esc(d.name)}</h2><p>${plural(d.files, 'archivo', 'archivos')} · ${bytes(d.size)}, comprobados uno a uno (huella SHA-256).</p><p>¿Lo borro del móvil para liberar espacio?</p>
      <div class="row"><button class="btn" id="no">Conservar</button><button class="btn danger" id="si">Borrar del móvil</button></div>`);
    const done = (yes) => { A.deleteSent(d.id, yes); delete delAsks[d.id]; closeModal(); };
    $('#si').onclick = () => done(true);
    $('#no').onclick = () => done(false);
  }
  function showConsent() {
    const n = consent; consent = 0;
    showModal(`<h2>Falta tu permiso</h2><p>Android quiere que confirmes el borrado de ${plural(n, 'foto o vídeo', 'fotos o vídeos')} ya enviados. Saldrá una ventana del sistema.</p>
      <div class="row"><button class="btn" data-close>Ahora no</button><button class="btn danger" id="si">Continuar</button></div>`);
    $('#si').onclick = () => { A.deleteConsent(); closeModal(); };
  }
  function showConfirm() {
    const c = confirm;
    showModal(`<h2>¿Son las mismas 6 cifras?</h2><p>Compáralas con la pantalla de <b>${esc(c.name)}</b>.</p>
      <div class="sas">${esc(c.sas.slice(0, 3))} ${esc(c.sas.slice(3))}</div>
      <p class="xs faint">Huella de ${esc(c.name)}: <span class="mono">${esc(c.fp)}</span></p>
      <p class="xs">Si no coinciden, alguien podría estar en medio: pulsa «No coinciden».</p>
      <div class="row"><button class="btn danger" id="no">No coinciden</button><button class="btn primary" id="si">Coinciden</button></div>`);
    $('#si').onclick = () => { A.confirm(c.id, true); $('#modal').querySelector('.modal').innerHTML = '<h2>Esperando al otro…</h2><p>Pulsa también «Coinciden» en ' + esc(c.name) + '.</p>'; };
    $('#no').onclick = () => { A.confirm(c.id, false); confirm = null; closeModal(); };
  }
  function showAsk(a) {
    showModal(`<h2>${esc(a.name)} quiere enviarte ${plural(a.files, 'archivo', 'archivos')}</h2>
      <p>${bytes(a.size)}${a.private ? ' · <span class="privtxt">sesión privada</span>' : ''} · por ${esc(a.via || 'casa')}</p>
      <ul class="files">${(a.list || []).map((f) => `<li><span>${esc(f.rel)}</span><em>${bytes(f.size)}</em></li>`).join('')}</ul>
      ${a.files > (a.list || []).length ? '<p class="xs faint">y ' + (a.files - a.list.length) + ' más…</p>' : ''}
      <div class="row"><button class="btn danger" id="no">Rechazar</button><button class="btn primary" id="si">Aceptar</button></div>`);
    const done = (ok) => { A.answer(a.id, ok); delete asks[a.id]; badge(); closeModal(); };
    $('#si').onclick = () => done(true);
    $('#no').onclick = () => done(false);
  }
  function badge() { $('#askBadge').classList.toggle('show', Object.keys(asks).length > 0); }

  // ---------- páginas ----------
  function render() {
    if (!S) return;
    // no se repinta mientras escribes (se perdería lo escrito)
    const f = document.activeElement;
    if (f && f.tagName === 'INPUT' && $('#main').contains(f)) { render.dirty = true; return; }
    render.dirty = false;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#privBtn').classList.toggle('on', !!S.settings.private);
    $('#seal').textContent = '● Cifrado de punta a punta';
    const html = ({ enviar: pEnviar, recibido: pRecibido, emparejar: pEmparejar, ajustes: pAjustes })[tab]();
    if (html === render.last) return; // nada cambió: no se toca (los botones no «se mueven» bajo el dedo)
    render.last = html;
    const y = window.scrollY;
    $('#main').innerHTML = html;
    wire();
    $('#main').querySelectorAll('[data-w]').forEach((i) => { i.style.width = i.dataset.w + '%'; });
    window.scrollTo(0, y);
    tickLeft();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (render.dirty) render(); }, 50));

  const hero = (n, t, p) => `<div class="hero"><div class="sn">— ${n} —</div><h1>${t}</h1>${p ? '<p>' + p + '</p>' : ''}</div>`;
  function where(p) {
    if (p.home) return '<span class="where ok">En casa</span>';
    if (p.direct) return '<span class="where maybe">Dirección</span>';
    if (S.settings.relayHost) return `<span class="where ${S.relay === false ? 'off' : 'maybe'}">Relé</span>`;
    return '<span class="where off">Sin camino</span>';
  }
  function active(fp) { return S.transfers.filter((t) => t.peer === fp && ['conectando', 'esperando', 'enviando', 'recibiendo', 'pregunta'].includes(t.status)); }
  function prog(t) {
    const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : 0;
    const txt = { conectando: 'Conectando…', esperando: 'Esperando a que acepte…', enviando: 'Enviando', recibiendo: 'Recibiendo', pregunta: 'Esperando tu respuesta' }[t.status] || t.status;
    return `<div class="prog" data-t="${esc(t.id)}" data-st="${esc(t.status)}"><div class="bar"><i data-w="${pct}"></i></div><em><span>${txt} ${t.dir === 'out' ? '→' : '←'} ${plural(t.files, 'archivo', 'archivos')}</span><span class="pb">${bytes(t.done)} / ${bytes(t.size)}</span></em>
      ${t.status === 'enviando' || t.status === 'recibiendo' ? `<div class="row end"><button class="link" data-cancel="${esc(t.id)}">Cancelar</button></div>` : ''}</div>`;
  }

  function pEnviar() {
    let h = hero('01', 'ENVIAR', 'Del móvil a tus PC, cifrado de punta a punta');
    if (S.shared > 0) h += `<div class="card banner"><b>${plural(S.shared, 'archivo listo', 'archivos listos')} para enviar</b><p class="muted sm m4">Toca «Enviar aquí» en el PC que quieras.</p><div class="row end"><button class="link" id="dropShared">Descartar</button></div></div>`;
    if (!S.peers.length) return h + `<div class="card empty"><b>Aún no tienes aparatos</b>Empareja tu PC una vez y luego os reconoceréis solos.<div class="row row center mt14"><button class="btn primary" data-go="emparejar">Emparejar un PC</button></div></div>`;
    for (const p of S.peers) {
      const act = active(p.fp);
      h += `<div class="card"><div class="peer-top"><div><div class="peer-name">${esc(p.name)}</div></div>${where(p)}</div>
        ${S.shared > 0 ? `<div class="row mt12"><button class="btn primary block" data-shared="${esc(p.fp)}">${I.send} Enviar aquí</button></div>` : `
        <div class="acts"><button class="btn" data-pick="media" data-fp="${esc(p.fp)}">${I.img}Fotos</button><button class="btn" data-pick="files" data-fp="${esc(p.fp)}">${I.file}Archivos</button><button class="btn" data-pick="folder" data-fp="${esc(p.fp)}">${I.folder}Carpeta</button></div>`}
        ${act.map(prog).join('')}</div>`;
    }
    if (S.settings.private) h += '<p class="xs privtxt center">Sesión privada: lo que envíes no queda en el historial y el otro lo borrará solo.</p>';
    return h;
  }

  function pRecibido() {
    let h = hero('02', 'RECIBIDO', S.receiving ? 'Listo para recibir · se guarda en Descargas › Puente' : '<span class="warn">«Recibir» está apagado</span>');
    const pend = Object.values(asks);
    for (const a of pend) h += `<div class="card banner"><b>${esc(a.name)}</b> quiere enviarte ${plural(a.files, 'archivo', 'archivos')} (${bytes(a.size)})<div class="row mt10"><button class="btn danger grow" data-ans="${esc(a.id)}" data-ok="0">Rechazar</button><button class="btn primary grow" data-ans="${esc(a.id)}" data-ok="1">Aceptar</button></div></div>`;
    const live = S.transfers.filter((t) => !['hecho', 'rechazado', 'error', 'cancelado', 'cortado'].includes(t.status) || (t.private && t.status === 'hecho' && t.dir === 'in'));
    const seen = new Set(live.map((t) => t.id));
    const hist = S.history.filter((t) => !seen.has(t.id));
    const others = S.transfers.filter((t) => !seen.has(t.id) && !hist.some((x) => x.id === t.id) && ['error', 'cortado', 'rechazado', 'cancelado'].includes(t.status));
    const row = (t) => {
      const st = { hecho: t.dir === 'in' ? 'Recibido' : 'Enviado', rechazado: 'Rechazado', error: t.error || 'Error', cortado: t.error || 'Se cortó', cancelado: 'Cancelado' }[t.status];
      const pv = t.private && t.dir === 'in' && t.status === 'hecho' && t.saved;
      return `<li class="${esc(t.status)}"><span class="dir ${t.dir}">${t.dir === 'in' ? '↓' : '↑'}</span><div class="tm"><div>${t.dir === 'in' ? 'De' : 'A'} ${esc(t.name)}${t.private ? '<span class="tag">privado</span>' : ''}</div>
        <small>${[plural(t.files, 'archivo', 'archivos'), bytes(t.size), st, t.via, ago(t.at)].filter(Boolean).map(esc).join(' · ')}</small>
        ${st ? '' : prog(t)}
        ${pv ? `<div class="row mt8"><button class="btn small" data-see="${esc(t.id)}">Ver archivos</button><button class="btn small" data-keep="${esc(t.id)}">Guardar</button></div>${privFiles[t.id] ? '<ul class="files">' + privFiles[t.id].map((f) => `<li><span><button class="link" data-open="${esc(t.id)}" data-i="${+f.i}">${esc(f.name)}</button></span><em>${bytes(f.size)}</em></li>`).join('') + '</ul>' : ''}<small class="faint">Se borrará solo en unos ${esc(S.settings.privateMinutes)} min</small>` : ''}</div></li>`;
    };
    const all = [...live, ...others, ...hist];
    h += `<div class="card">${all.length ? '<ul class="tl">' + all.slice(0, 120).map(row).join('') + '</ul>' : '<div class="empty"><b>Nada todavía</b>Lo que recibas y envíes aparecerá aquí.</div>'}</div>`;
    h += `<div class="row between"><button class="link" id="openDl">Abrir Descargas</button>${S.history.length ? '<button class="link" id="histClear">Borrar historial</button>' : ''}</div>`;
    return h;
  }

  function pEmparejar() {
    let h = hero('03', 'EMPAREJAR', 'Una sola vez por aparato');
    const lan = J(A.lan(), []);
    if (picked.fromLink) h += `<div class="card banner"><b>Emparejar con «${esc(picked.fromLink)}»</b><p class="muted sm m4">Del código QR. Comprueba el código y pulsa «Emparejar»; luego compararás las 6 cifras.</p></div>`;
    h += `<div class="card"><h3>Con un PC</h3>
      <ol class="steps"><li>En el PC: Puente → «03 Emparejar» → «Mostrar código».</li><li>Aquí: toca tu PC (o escribe su dirección) y el código.</li></ol>
      ${lan.length ? lan.map((l) => `<button class="lan-pc ${picked.host === l.host ? 'on' : ''}" data-lan="${esc(l.host)}" data-port="${l.port}"><span><b>${esc(l.name)}</b><small>${esc(l.host)} · ${esc(l.fp)}</small></span><span class="link">Elegir</span></button>`).join('') : '<p class="xs faint">Buscando PC en modo emparejar en tu WiFi…</p>'}
      ${lan.length && !manual && !picked.fromLink ? '<button class="link" id="manual">Escribir la dirección a mano</button>' : `<label class="field">Dirección del PC<input class="input mono" id="host" inputmode="url" autocomplete="off" placeholder="192.168.1.20" value="${esc(picked.host)}"></label>`}
      <label class="field">Código<input class="input code" id="code" autocomplete="off" autocapitalize="characters" maxlength="9" placeholder="XXXX-XXXX" value="${esc(picked.code || '')}"></label>
      <button class="btn primary block" id="pairGo">Emparejar</button></div>`;
    h += `<div class="card"><h3>Que el PC me encuentre</h3>`;
    if (S.pairing && mine) {
      h += `<p class="muted sm">Escribe este código en el PC (03 Emparejar → «Emparejar con otro»):</p><div class="big-code">${esc(S.pairing.code)}</div>
        <div class="kv"><span>Dirección de este móvil</span><span class="mono">${esc((mine.addrs || S.addrs || []).join(', ') || '—')}</span></div>
        <div class="kv"><span>Puerto</span><span class="mono">${esc(mine.port)}</span></div>
        <div class="kv"><span>Caduca en</span><span id="left" data-until="${S.pairing.until}"></span></div>
        <div class="row end"><button class="link" id="pairStop">Cancelar</button></div>`;
    } else h += `<p class="muted sm">Útil si prefieres escribir el código en el PC.</p><button class="btn block" id="pairShow">Mostrar código</button>`;
    h += `</div><p class="xs faint center">Tu huella: <span class="mono">${esc(S.fp)}</span></p>`;
    return h;
  }

  function pAjustes() {
    const st = S.settings;
    const sw = (k, on, t, s) => `<div class="switch"><div><div>${t}</div><small>${s}</small></div><button class="tog ${on ? 'on' : ''}" data-sw="${k}" aria-label="${esc(t)}"></button></div>`;
    let h = hero('04', 'AJUSTES');
    if (S.storageBroken) h += '<div class="card banner"><b class="warn">No puedo guardar de forma segura</b><p class="muted sm m4">El almacén de claves de este móvil no responde. Puente funciona, pero no guarda nada (ni aparatos ni ajustes) hasta que vuelva: nunca lo guarda sin cifrar.</p></div>';
    h += `<div class="card"><h3>Este móvil</h3>
      ${sw('receiving', S.receiving, 'Recibir', 'Tus aparatos pueden enviarte archivos (deja una notificación fija)')}
      ${sw('visible', st.visible, 'Visible en casa', 'Tus PC te encuentran solos en la misma WiFi')}
      ${sw('history', st.history, 'Guardar historial', 'Lista de lo enviado y recibido (nunca lo privado)')}
      <label class="field">Nombre que ven los demás<input class="input" id="name" value="${esc(st.name)}" maxlength="60"></label>
      <label class="field">Sesión privada: borrar lo recibido a los (minutos)<input class="input" id="pmin" type="number" min="1" max="1440" value="${esc(st.privateMinutes)}"></label>
      <button class="btn small" id="saveMe">Guardar</button></div>`;
    const dm = st.deleteAfter || 'no';
    h += `<div class="card"><h3>Después de enviar</h3>
      <p class="muted sm mt0">¿Quieres que Puente borre del móvil lo que ya está en el PC?</p>
      <div class="seg">${[['no', 'Conservar'], ['preguntar', 'Preguntar'], ['si', 'Borrar']].map(([k, t]) => `<button class="${dm === k ? 'on' : ''}" data-del="${k}">${t}</button>`).join('')}</div>
      <p class="xs faint m8">${dm === 'si' ? 'Se borra solo cuando el PC confirma que TODO llegó idéntico (comprobado archivo a archivo).' : dm === 'preguntar' ? 'Al terminar cada envío te pregunto si lo borro del móvil.' : 'Lo enviado se queda en el móvil.'} Nunca se borra si el envío falla, se corta o va en sesión privada. Las fotos de la galería pueden pedir tu permiso (ventana de Android).</p></div>`;
    h += `<div class="card"><h3>Fuera de casa (relé)</h3><p class="muted sm mt0">Lo mismo que en el PC: dirección, puerto y clave del relé. ${S.relay === true ? '<span class="ok">Conectado</span>' : S.relay === false ? '<span class="err">No llego al relé</span>' : ''}</p>
      <label class="field">Dirección<input class="input mono" id="rh" value="${esc(st.relayHost)}" placeholder="micasa.duckdns.org" autocomplete="off"></label>
      <div class="row"><label class="field w110">Puerto<input class="input mono" id="rp" type="number" value="${esc(st.relayPort)}"></label><label class="field grow">Clave<input class="input mono" id="rk" type="password" placeholder="${st.hasRelayKey ? '•••••• (guardada)' : 'la del relé'}" autocomplete="off"></label></div>
      <div class="row"><button class="btn small" id="saveRelay">Guardar relé</button>${st.relayHost ? '<button class="link" id="noRelay">Quitar relé</button>' : ''}</div></div>`;
    h += `<div class="card"><h3>Mis aparatos</h3>${S.peers.length ? S.peers.map((p) => `<div class="peer-row"><div class="peer-top"><div><div>${esc(p.name)}</div><small>${esc(p.fp)} · desde ${ago(p.added)}</small></div>${where(p)}</div>
      <div class="switch"><div><div class="sm">Aceptar siempre</div><small>Sin preguntarte cada vez</small></div><button class="tog ${p.autoAccept ? 'on' : ''}" data-auto="${esc(p.fp)}" aria-label="Aceptar siempre"></button></div>
      <label class="field">Dirección directa (opcional, si tiene un puerto abierto)<input class="input mono" data-direct="${esc(p.fp)}" placeholder="ip:puerto" value="${esc(p.direct)}"></label>
      <div class="row end"><button class="btn small" data-rename="${esc(p.fp)}">Renombrar</button><button class="btn small danger" data-remove="${esc(p.fp)}">Quitar</button></div></div>`).join('') : '<p class="muted sm">Ninguno todavía.</p>'}</div>`;
    h += `<div class="card"><h3>Seguridad</h3><div class="kv"><span>Tu huella</span><span class="mono">${esc(S.fp)}</span></div><div class="kv"><span>Cifrado</span><span>Noise XX · AES-256-GCM</span></div><div class="kv"><span>Claves guardadas</span><span>Almacén de claves de Android</span></div>
      <div class="row mt10"><button class="btn danger block" id="panic2">Botón del pánico</button></div></div>
      <p class="xs faint center">Puente ${esc(S.version)} para Android</p>`;
    return h;
  }

  // ---------- botones ----------
  function wire() {
    const M = $('#main');
    M.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
    M.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => { A.pick(b.dataset.pick, b.dataset.fp, !!S.settings.private); }));
    M.querySelectorAll('[data-shared]').forEach((b) => (b.onclick = () => { A.sendShared(b.dataset.shared, !!S.settings.private); say('Mandando a ' + peerName(b.dataset.shared) + '… Todo va cifrado.', { action: 'hop', ms: 5000 }); }));
    M.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => A.cancel(b.dataset.cancel)));
    M.querySelectorAll('[data-ans]').forEach((b) => (b.onclick = () => { A.answer(b.dataset.ans, b.dataset.ok === '1'); delete asks[b.dataset.ans]; badge(); closeModal(); refresh(); }));
    M.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => { privFiles[b.dataset.see] = privFiles[b.dataset.see] ? null : J(A.listPrivate(b.dataset.see), []); render(); }));
    M.querySelectorAll('[data-keep]').forEach((b) => (b.onclick = () => { A.keep(b.dataset.keep); toast('Guardando…'); }));
    M.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => A.openPrivate(b.dataset.open, +b.dataset.i)));
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('dropShared', () => { A.clearShared(); refresh(); });
    on('openDl', () => A.openDownloads());
    on('histClear', () => { A.historyClear(); refresh(); toast('Historial borrado'); });
    // emparejar
    M.querySelectorAll('[data-lan]').forEach((b) => (b.onclick = () => { picked.host = b.dataset.lan; picked.port = +b.dataset.port; picked.code = ($('#code') || {}).value || ''; render(); const c = $('#code'); if (c) c.focus(); }));
    const code = $('#code');
    if (code) code.oninput = () => { let v = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); code.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v; picked.code = code.value; };
    const host = $('#host');
    if (host) host.oninput = () => { picked.host = host.value.trim(); };
    on('pairGo', () => {
      const h = (picked.host || '').trim(), c = (picked.code || '').replace(/[^A-Z0-9]/gi, '');
      if (!h) return toast('Toca tu PC en la lista o escribe su dirección');
      if (c.length !== 8) return toast('El código tiene 8 letras y números');
      const [hh, pp] = h.split(':');
      if (!tryJ(A.pairWith(picked.hosts && !h.includes(':') && picked.hosts.includes(h) ? picked.hosts.join(',') : hh, +(pp || picked.port || 47830), c))) return;
      const b = $('#pairGo'); b.disabled = true; b.textContent = 'Conectando…';
    });
    on('pairShow', () => { const r = J(A.pairStart(), {}); if (r.error) return toast(r.error); mine = r; refresh(); say('Escribe este código en el PC. Caduca en 3 minutos y solo vale para 5 intentos.', { ms: 9000 }); });
    on('manual', () => { manual = true; render(); const hh = $('#host'); if (hh) hh.focus(); });
    on('pairStop', () => { A.pairStop(); mine = null; refresh(); });
    // ajustes
    M.querySelectorAll('[data-sw]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.sw;
      if (k === 'receiving') { A.receiving(!S.receiving); S.receiving = !S.receiving; toast(S.receiving ? 'Listo para recibir' : 'Ya no recibes (puedes seguir enviando)'); }
      else setS({ [k]: !S.settings[k] });
      refresh();
    }));
    M.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
      if (setS({ deleteAfter: b.dataset.del })) { refresh(); say({ no: 'Lo enviado se queda en el móvil.', preguntar: 'Te preguntaré después de cada envío si quieres borrarlo del móvil.', si: 'Borraré del móvil lo que el PC confirme que tiene idéntico. Nunca lo privado ni lo que falle.' }[b.dataset.del], { ms: 8000 }); }
    }));
    on('saveMe', () => { const n = $('#name').value.trim(); const m = Math.max(1, Math.min(1440, +$('#pmin').value || 30)); if (setS({ name: n || S.settings.name, privateMinutes: m })) toast('Guardado'); refresh(); });
    on('saveRelay', () => {
      const p = { relayHost: $('#rh').value.trim(), relayPort: +$('#rp').value || 47840 };
      const k = $('#rk').value; if (k) p.relayKey = k;
      if (!setS(p)) return; toast('Relé guardado'); say('Si la dirección y la clave son las mismas que en el PC, podréis encontraros fuera de casa.', {}); refresh();
    });
    on('noRelay', () => { setS({ relayHost: '', relayKey: '' }); refresh(); });
    M.querySelectorAll('[data-auto]').forEach((b) => (b.onclick = () => { const p = S.peers.find((x) => x.fp === b.dataset.auto); A.setPeer(p.fp, JSON.stringify({ autoAccept: !p.autoAccept })); refresh(); }));
    M.querySelectorAll('[data-direct]').forEach((i) => (i.onchange = () => { if (tryJ(A.setPeer(i.dataset.direct, JSON.stringify({ direct: i.value.trim() })))) toast('Guardado'); }));
    M.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = () => {
      const p = S.peers.find((x) => x.fp === b.dataset.rename);
      showModal(`<h2>Renombrar</h2><input class="input" id="rn" value="${esc(p.name)}" maxlength="60"><div class="row"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="rnOk">Guardar</button></div>`);
      $('#rnOk').onclick = () => { A.setPeer(p.fp, JSON.stringify({ name: $('#rn').value.trim() || p.name })); closeModal(); refresh(); };
    }));
    M.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => {
      const p = S.peers.find((x) => x.fp === b.dataset.remove);
      showModal(`<h2>¿Quitar «${esc(p.name)}»?</h2><p>No podrá conectarse ni enviarte nada. Para volver a usarlo habrá que emparejar otra vez.</p><div class="row"><button class="btn" data-close>Cancelar</button><button class="btn danger" id="rmOk">Quitar</button></div>`);
      $('#rmOk').onclick = () => { A.removePeer(p.fp); closeModal(); refresh(); };
    }));
    on('panic2', panic);
  }

  function panic() {
    showModal(`<h2>Botón del pánico</h2><p>Corta todas las conexiones y envíos, cancela el emparejado y borra todo lo recibido en sesión privada. Tus aparatos de confianza se quedan.</p><div class="row"><button class="btn" data-close>Cancelar</button><button class="btn danger" id="pOk">Cortar todo</button></div>`);
    $('#pOk').onclick = doPanic;
  }
  function doPanic() { A.panic(); asks = {}; confirm = null; mine = null; badge(); closeModal(); refresh(); toast('Todo cortado y lo privado borrado'); say('He cortado todas las conexiones y borrado lo privado. Tus aparatos siguen emparejados.', { mood: 'surprised' }); }
  $('#panicBtn').onclick = () => {
    const b = $('#panicBtn');
    if (Date.now() - panicArm < 2500) { panicArm = 0; b.classList.remove('armed'); return doPanic(); }
    panicArm = Date.now(); b.classList.add('armed'); toast('Toca otra vez «Pánico» para cortar todo');
    setTimeout(() => b.classList.remove('armed'), 2500);
  };
  $('#privBtn').onclick = () => {
    const v = !S.settings.private;
    setS({ private: v });
    refresh();
    say(v ? `Sesión privada activada: lo que recibas se borrará en ${S.settings.privateMinutes} min y no quedará historial.` : 'Sesión privada desactivada.', {});
  };

  function tickLeft() {
    const el = $('#left'); if (!el) return;
    const left = Math.max(0, Math.round((+el.dataset.until - Date.now()) / 1000));
    el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  }
  setInterval(tickLeft, 1000);
  function go(t) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    tab = t; render.last = null; window.scrollTo(0, 0); render();
    clearInterval(lanTimer);
    if (t === 'emparejar') lanTimer = setInterval(() => { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') refresh(); }, 2000);
  }
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  function refresh() { load(); render(); }
  let rTimer = null;
  const soon = () => { if (!rTimer) rTimer = setTimeout(() => { rTimer = null; refresh(); }, 250); };

  // ---------- avisos del motor ----------
  window.puente = {
    back() {
      if (modalOpen()) { if (confirm) return true; closeModal(); return true; }
      if (tab !== 'enviar') { go('enviar'); return true; }
      return false;
    },
    ev(type, d) {
      switch (type) {
        case 'ask':
          asks[d.id] = d; badge();
          say(`${d.name} quiere enviarte ${plural(d.files, 'archivo', 'archivos')}${d.private ? ' en sesión privada' : ''}. ¿Lo aceptas?`, { mood: 'surprised', action: 'wave', ms: 12000 });
          showNext(); break;
        case 'transfer':
          if (d.status !== 'pregunta' && asks[d.id]) { delete asks[d.id]; badge(); if (modalOpen() && $('#modal').textContent.includes('quiere enviarte')) closeModal(); }
          if (d.dir === 'out' && d.status === 'hecho') toast('✓ Enviado a ' + d.name + ' (' + bytes(d.size) + ')');
          if (d.dir === 'out' && d.status === 'rechazado') toast(d.name + ' lo ha rechazado');
          if (d.dir === 'out' && d.status === 'error') { toast(d.error || 'No se pudo enviar', 6000); say(d.error || 'No se pudo enviar', { mood: 'surprised', ms: 9000 }); }
          // solo cambia el avance: se actualiza la barra sin repintar (los botones no «se mueven» bajo el dedo)
          if (S) { const i = S.transfers.findIndex((t) => t.id === d.id); if (i >= 0) S.transfers[i] = d; else S.transfers.push(d); }
          { const el = document.querySelector('.prog[data-t="' + CSS.escape(d.id) + '"]');
            if (el && el.dataset.st === d.status) { el.querySelector('.bar i').style.width = (d.size ? Math.min(100, Math.round((d.done / d.size) * 100)) : 0) + '%'; el.querySelector('.pb').textContent = bytes(d.done) + ' / ' + bytes(d.size); break; } }
          soon(); break;
        case 'received':
          say(`¡Ha llegado todo de ${d.name}! ${plural(d.files, 'archivo', 'archivos')}, comprobados uno a uno.${d.private ? ' Es privado: se borrará solo.' : ' Está en Descargas › Puente.'}`, { action: 'hop' });
          soon(); break;
        case 'sent-ask-delete':
          delAsks[d.id] = d; showNext(); break;
        case 'deleted':
          if (d.system) { toast(d.ok ? 'Borrados del móvil' : 'No se ha borrado nada'); break; }
          if (d.deleted > 0) toast(`Borrados del móvil: ${plural(d.deleted, 'archivo', 'archivos')}`);
          if (d.failed > 0) say(`${plural(d.failed, 'archivo no se puede borrar', 'archivos no se pueden borrar')} desde Puente (la app de donde venían no lo permite). Bórralos allí si quieres.`, { ms: 10000 });
          if (d.consent > 0) { consent = d.consent; showNext(); }
          break;
        case 'delete-consent': consent = d.count; showNext(); break;
        case 'storage-error': say('Ojo: este móvil no me deja guardar de forma segura. Lo de esta sesión funciona, pero al cerrar Puente tendrás que volver a emparejar.', { mood: 'surprised', ms: 12000 }); soon(); break;
        case 'pair-confirm':
          confirm = d; closeModal();
          say('Mira las 6 cifras: tienen que ser las mismas en las dos pantallas. Si coinciden, no hay nadie en medio.', { mood: 'surprised', ms: 15000 });
          break;
        case 'pair-ended':
          confirm = null; mine = null; closeModal();
          if (d.ok) { say(`¡Emparejado con ${d.name}! A partir de ahora os reconocéis solos.`, { action: 'spin' }); picked = { host: '', port: 47830 }; go('enviar'); }
          else say(d.reason || 'No se ha emparejado.', { mood: 'surprised' });
          refresh(); break;
        case 'pair-result':
          if (!d.ok) { toast(d.error || 'No se pudo emparejar', 6000); say(d.error || 'No se pudo emparejar', { mood: 'surprised', ms: 9000 }); render.last = null; render(); }
          break;
        case 'pair-failed': say('Ojo: ' + d.reason + '.', { mood: 'surprised', action: 'shake' }); break;
        case 'intruder': say('Un aparato que no conozco ha intentado conectarse. Lo he echado: no ha visto nada.', { mood: 'surprised', action: 'shake', ms: 10000 }); break;
        case 'relay': soon(); if (d && d.ok === false) say('No llego al relé. Revisa la dirección, el puerto y la clave en Ajustes.', { mood: 'surprised' }); break;
        case 'wiped': privFiles = {}; soon(); break;
        case 'kept': if (d.ok) { toast('Guardado en ' + d.where); delete privFiles[d.id]; } else toast(d.error || 'No se pudo guardar'); soon(); break;
        case 'picked':
          if (d.error) toast(d.error, 6000);
          else if (d.count > 0) { toast('Enviando ' + plural(d.count, 'archivo', 'archivos') + '…'); say('Mandando… Todo va cifrado; ni la WiFi ni el relé pueden verlo.', { action: 'hop', ms: 5000 }); }
          soon(); break;
        case 'shared': refresh(); go('enviar'); if (d.count) say(`Tengo ${plural(d.count, 'archivo', 'archivos')} para enviar. ¿A qué PC?`, { ms: 8000 }); break;
        case 'deeplink': {
          // ya comprobado en Java; aquí solo se rellena: emparejar exige tocar el botón y comparar las 6 cifras
          picked = { host: d.hosts[0], hosts: d.hosts, port: d.port, code: d.code, fromLink: d.name };
          go('emparejar');
          say(`Listo para emparejar con ${d.name}. Pulsa «Emparejar» y luego compara las 6 cifras.`, { ms: 8000 });
          break;
        }
        case 'peers': case 'lan': case 'pairing': case 'recibir': case 'resume': soon(); break;
      }
    },
  };

  load(); render(); A.ready();
  setTimeout(() => say(S && S.peers.length ? '¡Hola! Si tienes dudas, tócame.' : '¡Hola! Soy Nubo. Empecemos emparejando tu PC: ve a «03 Emparejar».', { ms: 7000 }), 900);
})();
