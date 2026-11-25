/* Guess My Fridge — v1 de test (PWA locale, sans compte, sans serveur)
   Spécifications : claude/systeme-qr-v1.md + claude/ecrans-parcours-v1.md */
'use strict';

const APP_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Référentiels                                                         */
/* ------------------------------------------------------------------ */
const CATEGORIES = [
  { id: 'viande',   label: 'Viande',           emoji: '🥩' },
  { id: 'poisson',  label: 'Poisson',          emoji: '🐟' },
  { id: 'legumes',  label: 'Légumes & fruits', emoji: '🥦' },
  { id: 'plats',    label: 'Plats cuisinés',   emoji: '🍲' },
  { id: 'autres',   label: 'Autres',           emoji: '📦' },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const UNITS = [
  { id: 'piece',   one: 'pièce',   many: 'pièces',   weight: false },
  { id: 'portion', one: 'portion', many: 'portions', weight: false },
  { id: 'sachet',  one: 'sachet',  many: 'sachets',  weight: false },
  { id: 'g',       one: 'g',       many: 'g',        weight: true  },
  { id: 'kg',      one: 'kg',      many: 'kg',       weight: true  },
];
const UNIT = Object.fromEntries(UNITS.map(u => [u.id, u]));

/* ------------------------------------------------------------------ */
/* Codes d'étiquette GMF1:XXXXXXC (Crockford base32 + Luhn mod 32)     */
/* ------------------------------------------------------------------ */
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function checkChar(p) {
  let f = 2, t = 0;
  for (const ch of [...p].reverse()) {
    const a = f * ALPHA.indexOf(ch);
    f = f === 2 ? 1 : 2;
    t += Math.floor(a / 32) + (a % 32);
  }
  return ALPHA[(32 - (t % 32)) % 32];
}
function parseCode(raw, manual = false) {
  let s = String(raw || '').trim().toUpperCase();
  if (manual && !/^GMF\d+:/.test(s)) s = 'GMF1:' + s;   // saisie manuelle : préfixe implicite
  const m = s.match(/^GMF(\d+):(.+)$/);
  if (!m) return { kind: 'foreign' };
  if (m[1] !== '1') return { kind: 'newer' };
  const c = m[2].replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{7}$/.test(c) || checkChar(c.slice(0, 6)) !== c[6]) return { kind: 'invalid' };
  return { kind: 'ok', code: c };
}
const prettyCode = c => c.slice(0, 4) + '-' + c.slice(4);

/* ------------------------------------------------------------------ */
/* Stockage local : IndexedDB                                           */
/* ------------------------------------------------------------------ */
const DB_NAME = 'gmf';
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('etiquettes', { keyPath: 'code' });
      d.createObjectStore('articles', { keyPath: 'id' });
      d.createObjectStore('photos', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
function getAll(store) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function getOne(store, key) {
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const put = (store, obj) => tx([store], 'readwrite', t => t.objectStore(store).put(obj));

/* État en mémoire (petit volume : quelques centaines d'articles au plus) */
const S = { etiquettes: new Map(), articles: new Map(), meta: {} };
async function loadAll() {
  for (const e of await getAll('etiquettes')) S.etiquettes.set(e.code, e);
  for (const a of await getAll('articles')) S.articles.set(a.id, a);
  for (const m of await getAll('meta')) S.meta[m.k] = m.v;
}
async function setMeta(k, v) { S.meta[k] = v; await put('meta', { k, v }); }
async function saveEtiquette(e) { S.etiquettes.set(e.code, e); await put('etiquettes', e); }
async function saveArticle(a) { S.articles.set(a.id, a); await put('articles', a); }
async function saveBoth(e, a) {
  S.etiquettes.set(e.code, e); S.articles.set(a.id, a);
  await tx(['etiquettes', 'articles'], 'readwrite', t => {
    t.objectStore('etiquettes').put(e); t.objectStore('articles').put(a);
  });
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const enStock = () => [...S.articles.values()].filter(a => a.statut === 'en_stock');
const articleActif = code => enStock().find(a => a.code_etiquette === code);
const dernierSorti = code => [...S.articles.values()]
  .filter(a => a.code_etiquette === code && a.statut !== 'en_stock')
  .sort((x, y) => (y.sorti_le || '').localeCompare(x.sorti_le || ''))[0];

/* Photos : ArrayBuffer + type (robuste sur Safari iOS) */
async function savePhoto(blob) {
  const id = uid();
  const buf = await blob.arrayBuffer();
  await put('photos', { id, type: blob.type || 'image/jpeg', buf });
  return id;
}
const photoURLs = new Map();
async function photoURL(id) {
  if (!id) return null;
  if (photoURLs.has(id)) return photoURLs.get(id);
  const p = await getOne('photos', id);
  if (!p) return null;
  const url = URL.createObjectURL(new Blob([p.buf], { type: p.type }));
  photoURLs.set(id, url);
  return url;
}
function compressImage(file, maxSide = 1080, quality = 0.72) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(new Error('compression')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image illisible')); };
    img.src = url;
  });
}
function pickPhoto() {           // ouvre directement l'appareil photo arrière
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment');
    i.onchange = async () => {
      const f = i.files && i.files[0];
      if (!f) return res(null);
      try { res(await savePhoto(await compressImage(f))); }
      catch { toast('Impossible de lire la photo'); res(null); }
    };
    i.click();
  });
}

/* ------------------------------------------------------------------ */
/* Utilitaires d'affichage                                              */
/* ------------------------------------------------------------------ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const nowISO = () => new Date().toISOString();
function daysSince(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const a = Date.UTC(y, m - 1, d);
  const n = new Date(); const b = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((b - a) / 86400000);
}
function ageShort(iso) {
  const n = daysSince(iso);
  if (n <= 0) return "auj.";
  if (n < 14) return n + ' j';
  if (n < 60) return Math.floor(n / 7) + ' sem.';
  return Math.floor(n / 30.44) + ' mois';
}
function ageLong(iso) {
  const n = daysSince(iso);
  if (n <= 0) return "congelé aujourd'hui";
  if (n === 1) return 'congelé hier';
  if (n < 60) return `congelé il y a ${n} jours`;
  const mo = Math.floor(n / 30.44);
  return `congelé il y a ${mo} mois (${n} jours)`;
}
const fmtDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtDateShort = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: '2-digit' }); };
const fmtNum = n => (Math.round(n * 1000) / 1000).toLocaleString('fr-BE');
function fmtQty(q, unite) {
  const u = UNIT[unite] || UNIT.piece;
  if (q === null || q === undefined || q === '') return '';
  return `${fmtNum(q)} ${u.weight ? u.one : (Number(q) <= 1 ? u.one : u.many)}`;
}
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------ */
/* Navigation en pile (avec bouton retour Android / geste iOS)          */
/* ------------------------------------------------------------------ */
const stack = [];
let cleanup = null;
function go(name, params = {}) {
  stack.push({ name, params });
  history.pushState({ i: stack.length - 1 }, '');
  render();
}
function replace(name, params = {}) {
  stack[stack.length - 1] = { name, params };
  history.replaceState({ i: stack.length - 1 }, '');
  render();
}
function home() {                      // revient à la liste
  const n = stack.length - 1;
  if (n > 0) { stack.length = 1; history.go(-n); } else render();
}
const back = () => history.back();
window.addEventListener('popstate', e => {
  closeSheet();
  const i = e.state && typeof e.state.i === 'number' ? e.state.i : 0;
  if (i < stack.length - 1) stack.length = Math.max(1, i + 1);
  render();
});
function render() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const top = stack[stack.length - 1];
  const root = $('#app');
  root.innerHTML = '';
  window.scrollTo(0, 0);
  SCREENS[top.name](root, top.params);
}

/* ------------------------------------------------------------------ */
/* Feuille du bas et toast                                              */
/* ------------------------------------------------------------------ */
function openSheet(build) {
  closeSheet();
  clearTimeout(toastTimer); $('#toast-root').innerHTML = '';   // pas de toast par-dessus une feuille
  const bd = h(`<div class="sheet-backdrop"><div class="sheet"><div class="grab"></div><div class="sheet-body"></div></div></div>`).firstElementChild;
  bd.addEventListener('click', e => { if (e.target === bd) closeSheet(); });
  $('#sheet-root').appendChild(bd);
  build($('.sheet-body', bd));
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }
let toastTimer;
function toast(text, actionLabel, action, ms = 5000) {
  clearTimeout(toastTimer);
  const root = $('#toast-root');
  root.innerHTML = '';
  const el = h(`<div class="toast"><span class="t-text">${esc(text)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}</div>`).firstElementChild;
  if (actionLabel) el.querySelector('button').onclick = () => { root.innerHTML = ''; action(); };
  root.appendChild(el);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, ms);
}

/* ------------------------------------------------------------------ */
/* Écran 1 — Liste du congélateur                                       */
/* ------------------------------------------------------------------ */
let currentFilter = 'tout';
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

function screenList(root) {
  const items = enStock().sort((a, b) => a.congele_le.localeCompare(b.congele_le) || a.cree_le.localeCompare(b.cree_le));
  const counts = { tout: items.length };
  CATEGORIES.forEach(c => counts[c.id] = items.filter(a => a.categorie === c.id).length);
  const shown = currentFilter === 'tout' ? items : items.filter(a => a.categorie === currentFilter);

  const filterBtn = (id, label) => `<button class="filter ${currentFilter === id ? 'active' : ''}" data-f="${id}">
      <span class="f-name">${esc(label)}</span><span class="f-count">${counts[id]}</span></button>`;

  let banners = '';
  if (!isStandalone() && !S.meta.hideInstall) {
    banners += `<div class="banner" data-b="install"><span class="b-text">${isIOS()
      ? '<b>Installe l\'app pour ne pas perdre tes données :</b> bouton Partager <b>⬆︎</b> puis « Sur l\'écran d\'accueil ».'
      : `<b>Installe l'app</b> pour l'ouvrir comme une vraie application. ${deferredInstall ? '<button class="btn-ghost" data-act="install"><b>Installer</b></button>' : 'Menu ⋮ puis « Installer l\'application ».'}`}
      </span><button class="b-close" data-close="hideInstall">✕</button></div>`;
  }
  const lastBackup = S.meta.lastBackup;
  const stale = !lastBackup || (Date.now() - new Date(lastBackup).getTime()) > 14 * 86400000;
  if (items.length >= 5 && stale && S.meta.snoozeBackup !== today()) {
    banners += `<div class="banner info"><span class="b-text">Pas de synchro dans cette version : pense à <button class="btn-ghost" data-act="backup"><b>faire une sauvegarde</b></button>.</span><button class="b-close" data-close="snoozeBackup">✕</button></div>`;
  }

  root.appendChild(h(`<div class="screen">
    <div class="topbar"><h1>Mon congélateur</h1><button class="icon-btn" data-act="settings" aria-label="Réglages">⚙︎</button></div>
    ${banners}
    <div class="filters">
      ${filterBtn('tout', 'Tout')}${filterBtn('viande', 'Viande')}${filterBtn('poisson', 'Poisson')}
      ${filterBtn('legumes', 'Légumes & fruits')}${filterBtn('plats', 'Plats cuisinés')}${filterBtn('autres', 'Autres')}
    </div>
    <div class="list">${shown.length ? shown.map(a => `
      <button class="row" data-id="${esc(a.id)}">
        <div class="r-main"><div class="r-name">${esc(a.nom)}</div>
          <div class="r-sub">${esc(CAT[a.categorie]?.label || 'Autres')}${a.quantite !== null && a.quantite !== '' ? ' · ' + esc(fmtQty(a.quantite, a.unite)) : ''}</div></div>
        <div class="r-side"><div class="r-age">${esc(ageShort(a.congele_le))}</div><div>${esc(fmtDateShort(a.congele_le))}</div></div>
      </button>`).join('') : `<div class="empty"><div class="big">🧊</div>${items.length
        ? 'Rien dans cette catégorie.'
        : 'Ton congélateur est vide.<br>Scanne une étiquette pour enregistrer ton premier aliment.'}</div>`}
    </div>
  </div>
  <div class="bottom-bar"><div class="inner"><button class="btn btn-primary btn-scan" data-act="scan">▣&nbsp; Scanner</button></div></div>`));

  $$('.filter', root).forEach(b => b.onclick = () => { currentFilter = b.dataset.f; render(); });
  $$('.row', root).forEach(b => b.onclick = () => go('fiche', { id: b.dataset.id }));
  $$('[data-close]', root).forEach(b => b.onclick = async () => { await setMeta(b.dataset.close, b.dataset.close === 'snoozeBackup' ? today() : true); render(); });
  $('[data-act="scan"]', root).onclick = () => go('scan', {});
  $('[data-act="settings"]', root).onclick = () => go('settings', {});
  const ins = $('[data-act="install"]', root);
  if (ins) ins.onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); };
  const bk = $('[data-act="backup"]', root);
  if (bk) bk.onclick = () => exportBackup();
}

/* ------------------------------------------------------------------ */
/* Écran 2 — Scanner                                                    */
/* ------------------------------------------------------------------ */
function screenScan(root, params) {
  const chain = params.chain || null;           // pré-remplissage « scanner le suivant »
  root.appendChild(h(`<div class="scanner">
    <video playsinline muted autoplay></video>
    <div class="s-top">
      <button class="icon-btn" data-act="close" aria-label="Fermer">✕</button>
      ${chain ? `<span class="chain-pill">Suivant : ${esc(chain.nom)}</span>` : '<span></span>'}
      <button class="icon-btn" data-act="torch" aria-label="Lampe" style="visibility:hidden">🔦</button>
    </div>
    <div class="s-frame"><div class="box"></div></div>
    <div class="s-hint">Vise le QR de l'étiquette</div>
    <div class="s-msgs"></div>
    <div class="s-bottom">
      <form class="manual" autocomplete="off">
        <input name="code" placeholder="Code : T2KQ-41T" inputmode="text" autocapitalize="characters" spellcheck="false">
        <button type="submit">OK</button>
      </form>
    </div>
  </div>`));
  const video = $('video', root), msgs = $('.s-msgs', root), torchBtn = $('[data-act="torch"]', root);
  let stream = null, track = null, alive = true, raf = 0, lastCode = '', lastAt = 0, busy = false, torchOn = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const showMsg = (html, err = true) => { msgs.innerHTML = `<div class="s-msg ${err ? 'err' : ''}">${html}</div>`; };
  $('[data-act="close"]', root).onclick = () => back();

  async function handle(raw, manual) {
    if (busy) return;
    const now = Date.now();
    if (!manual && raw === lastCode && now - lastAt < 2000) return;   // anti double scan
    lastCode = raw; lastAt = now;
    const r = parseCode(raw, manual);
    if (!manual && chain && r.kind === 'ok' && r.code === chain.skip) return;   // étiquette qu'on vient d'enregistrer
    if (r.kind === 'foreign') return showMsg(`<b>Ce QR n'est pas une étiquette Guess My Fridge.</b><br><code>${esc(raw.slice(0, 120))}</code>`);
    if (r.kind === 'newer') return showMsg(`<b>Format d'étiquette plus récent.</b> Mets l'app à jour pour lire cette étiquette.`);
    if (r.kind === 'invalid') return showMsg(`<b>Code invalide.</b> ${manual ? 'Vérifie les 7 caractères imprimés sous le QR.' : 'Rapproche-toi ou essuie le givre.'}`);
    busy = true;
    if (navigator.vibrate) navigator.vibrate(40);
    routeCode(r.code, chain);
  }
  $('.manual', root).onsubmit = e => { e.preventDefault(); const v = e.target.code.value; if (v.trim()) handle(v, true); };

  torchBtn.onclick = async () => {
    try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.classList.toggle('on', torchOn); }
    catch { torchBtn.style.visibility = 'hidden'; }
  };

  let lastScan = 0;
  function loop(t) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (t - lastScan < 120 || video.readyState < 2 || busy) return;
    lastScan = t;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const side = Math.min(vw, vh) * 0.8;              // on analyse le carré central
    const sx = (vw - side) / 2, sy = (vh - side) / 2, size = 480;
    canvas.width = size; canvas.height = size;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const res = jsQR(img.data, size, size, { inversionAttempts: 'dontInvert' });
    if (res && res.data) handle(res.data, false);
  }

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMsg('Caméra indisponible ici (l\'app doit être ouverte en <b>https</b>). Tu peux saisir le code à la main.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) torchBtn.style.visibility = 'visible';
      raf = requestAnimationFrame(loop);
    } catch (e) {
      showMsg('Accès à la caméra refusé. Autorise-le dans les réglages du téléphone, ou saisis le code à la main.');
    }
  })();

  cleanup = () => { alive = false; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach(t => t.stop()); };
}

/* Arbre de décision d'un code valide */
function routeCode(code, chain) {
  const e = S.etiquettes.get(code);
  if (e && e.statut === 'hs') {
    toast('Étiquette retirée du service.');
    return replace('scan', { chain });
  }
  if (e && e.statut === 'active') {
    const a = articleActif(code);
    if (a) return replace('fiche', { id: a.id });
  }
  // vierge (absente) ou libre (réutilisable)
  const ancien = e ? dernierSorti(code) : null;
  replace('photo', { code, ancien: ancien ? ancien.id : null, chain });
}

/* ------------------------------------------------------------------ */
/* Écran 3 — Photo du contenant                                         */
/* ------------------------------------------------------------------ */
async function screenPhoto(root, params) {
  const ancien = params.ancien ? S.articles.get(params.ancien) : null;
  const oldPhotoId = ancien?.photo || null;
  const oldURL = await photoURL(oldPhotoId);
  const next = photo => replace('form', { mode: 'create', code: params.code, ancien: params.ancien, chain: params.chain, photo });

  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>Photo du contenant</h2></div>
    <p class="small">Étiquette <span class="code-tag">${esc(prettyCode(params.code))}</span> · ${ancien
      ? `réutilisée — ancien contenu : <b>${esc(ancien.nom)}</b> (sorti le ${esc(fmtDate(ancien.sorti_le.slice(0, 10)))})`
      : 'nouvelle étiquette'}</p>
    ${oldURL ? `<img class="photo-big" src="${oldURL}" alt="Ancienne photo">` : `<div class="photo-placeholder">📷</div>`}
    <p class="small">La photo aide à reconnaître le contenant (sac, boîte, couleur…). Elle ne s'affiche que sur la fiche.</p>
    <div class="stack">
      ${oldURL ? `<button class="btn btn-primary" data-act="keep">Garder l'ancienne</button>
                  <button class="btn btn-secondary" data-act="take">Nouvelle photo</button>`
               : `<button class="btn btn-primary" data-act="take">📷 Prendre la photo</button>`}
      <button class="btn btn-ghost" data-act="skip">Passer</button>
    </div>
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  $('[data-act="skip"]', root).onclick = () => next(null);
  const keep = $('[data-act="keep"]', root);
  if (keep) keep.onclick = () => next(oldPhotoId);
  $('[data-act="take"]', root).onclick = async () => { const id = await pickPhoto(); if (id) next(id); };
}

/* ------------------------------------------------------------------ */
/* Écran 4 — Formulaire (création et modification)                      */
/* ------------------------------------------------------------------ */
async function screenForm(root, params) {
  const editing = params.mode === 'edit';
  const art = editing ? S.articles.get(params.id) : null;
  const ancien = params.ancien ? S.articles.get(params.ancien) : null;
  const pre = editing ? art : (params.chain || {});
  const st = {
    nom: pre.nom || '',
    congele_le: pre.congele_le || today(),
    categorie: pre.categorie || null,
    quantite: pre.quantite ?? 1,
    unite: pre.unite || 'piece',
    notes: editing ? (art.notes || '') : '',
    photo: editing ? art.photo : params.photo,
  };
  const code = editing ? art.code_etiquette : params.code;

  async function draw() {
    const url = await photoURL(st.photo);
    root.innerHTML = '';
    root.appendChild(h(`<div class="screen">
      <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>${editing ? 'Modifier' : 'Nouvel aliment'}</h2></div>
      ${ancien && !editing ? `<div class="banner info"><span class="b-text">Contenant réutilisé — avant : <b>${esc(ancien.nom)}</b></span></div>` : ''}
      ${params.chain && !editing ? `<div class="banner info"><span class="b-text">Pré-rempli d'après l'aliment précédent : vérifie puis enregistre.</span></div>` : ''}
      <div class="card">
        <label class="fl" for="f-nom">Nom *</label>
        <input id="f-nom" class="input" name="nom" value="${esc(st.nom)}" placeholder="ex. Soupe potiron" autocomplete="off" enterkeyhint="done">
        <div class="err-text" id="err-nom" hidden>Donne un nom à l'aliment.</div>

        <label class="fl" for="f-date">Date de congélation</label>
        <input id="f-date" class="input" type="date" name="congele_le" value="${esc(st.congele_le)}" max="${today()}">

        <label class="fl">Catégorie</label>
        <div class="chips">${CATEGORIES.map(c => `<button type="button" class="chip ${st.categorie === c.id ? 'active' : ''}" data-cat="${c.id}">${c.emoji} ${esc(c.label)}</button>`).join('')}</div>

        <label class="fl" for="f-q">Quantité</label>
        <div class="qty-row">
          <input id="f-q" class="input" type="number" inputmode="decimal" min="0" step="any" name="quantite" value="${esc(st.quantite)}">
          <select class="input" name="unite">${UNITS.map(u => `<option value="${u.id}" ${st.unite === u.id ? 'selected' : ''}>${esc(u.weight ? u.one : u.many)}</option>`).join('')}</select>
        </div>

        <label class="fl" for="f-notes">Description</label>
        <textarea id="f-notes" class="input" name="notes" placeholder="Ingrédients, recette, origine… (facultatif)">${esc(st.notes)}</textarea>
      </div>
      <div class="card">
        <div class="photo-line">
          ${url ? `<img class="photo-thumb" src="${url}" alt="">` : `<div class="photo-thumb" style="display:grid;place-items:center;font-size:32px">📷</div>`}
          <div class="stack">
            <button type="button" class="btn btn-secondary" data-act="photo">${url ? 'Nouvelle photo' : 'Ajouter une photo'}</button>
            ${url ? `<button type="button" class="btn btn-ghost" data-act="nophoto">Retirer la photo</button>` : ''}
          </div>
        </div>
      </div>
      <p class="small">Étiquette <span class="code-tag">${esc(prettyCode(code))}</span></p>
      <div class="stack">
        <button class="btn btn-primary" data-act="save">Enregistrer</button>
        ${editing ? '' : `<button class="btn btn-secondary" data-act="save-next">Enregistrer et scanner le suivant</button>`}
      </div>
    </div>`));

    const f = name => $(`[name="${name}"]`, root);
    const sync = () => {
      st.nom = f('nom').value; st.congele_le = f('congele_le').value || today();
      st.quantite = f('quantite').value === '' ? null : Number(f('quantite').value);
      st.unite = f('unite').value; st.notes = f('notes').value;
    };
    $('[data-act="back"]', root).onclick = () => back();
    $$('.chip', root).forEach(b => b.onclick = () => {
      st.categorie = st.categorie === b.dataset.cat ? null : b.dataset.cat;
      $$('.chip', root).forEach(x => x.classList.toggle('active', x.dataset.cat === st.categorie));
    });
    $('[data-act="photo"]', root).onclick = async () => { sync(); const id = await pickPhoto(); if (id) { st.photo = id; draw(); } };
    const np = $('[data-act="nophoto"]', root);
    if (np) np.onclick = () => { sync(); st.photo = null; draw(); };
    if (!editing && !st.nom) setTimeout(() => f('nom').focus({ preventScroll: true }), 50);

    const save = async (andNext) => {
      sync();
      if (!st.nom.trim()) { $('#err-nom', root).hidden = false; f('nom').focus(); return; }
      const data = {
        nom: st.nom.trim(), congele_le: st.congele_le, categorie: st.categorie || 'autres',
        quantite: st.quantite, unite: st.unite, notes: st.notes.trim(), photo: st.photo || null,
      };
      if (editing) {
        await saveArticle({ ...art, ...data, modifie_le: nowISO() });
        toast('Modifications enregistrées');
        return back();
      }
      const prev = S.etiquettes.get(code);
      if (prev && prev.statut === 'active' && articleActif(code)) { toast('Cette étiquette est déjà utilisée.'); return home(); }
      const e = prev ? { ...prev, statut: 'active' } : { code, statut: 'active', lot: null, premiere_vue_le: nowISO() };
      const a = { id: uid(), code_etiquette: code, ...data, statut: 'en_stock', sorti_le: null, cree_le: nowISO() };
      await saveBoth(e, a);
      requestPersist();
      if (andNext) {
        toast(`« ${a.nom} » enregistré`);
        replace('scan', { chain: { skip: code, nom: a.nom, categorie: a.categorie, congele_le: a.congele_le, quantite: a.quantite, unite: a.unite } });
      } else {
        toast(`« ${a.nom} » ajouté au congélateur`);
        home();
      }
    };
    $('[data-act="save"]', root).onclick = () => save(false);
    const sn = $('[data-act="save-next"]', root);
    if (sn) sn.onclick = () => save(true);
  }
  await draw();
}

/* ------------------------------------------------------------------ */
/* Écran 5 — Fiche aliment                                              */
/* ------------------------------------------------------------------ */
async function screenFiche(root, params) {
  const a = S.articles.get(params.id);
  if (!a) return home();
  const url = await photoURL(a.photo);
  const cat = CAT[a.categorie] || CAT.autres;
  const isStock = a.statut === 'en_stock';
  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2></h2>
      ${isStock ? '<button class="icon-btn" data-act="edit" aria-label="Modifier">✎</button>' : ''}</div>
    ${url ? `<img class="photo-big" src="${url}" alt="Photo du contenant">` : ''}
    <div class="f-title">${esc(a.nom)}</div>
    <div class="f-meta">${cat.emoji} ${esc(cat.label)}</div>
    <div class="f-age mt">${esc(ageLong(a.congele_le))}</div>
    <div class="f-meta">le ${esc(fmtDate(a.congele_le))}</div>
    ${isStock ? `<div class="card mt"><div class="small" style="margin-bottom:6px">Quantité</div>
      <div class="qty-box"><button class="round" data-adj="remove" aria-label="Retirer">−</button>
        <div class="q-val">${a.quantite !== null && a.quantite !== '' ? esc(fmtQty(a.quantite, a.unite)) : '—'}</div>
        <button class="round" data-adj="add" aria-label="Ajouter">+</button></div></div>`
      : `<div class="banner mt"><span class="b-text">Sorti le ${esc(fmtDate(a.sorti_le.slice(0, 10)))}.</span></div>`}
    ${a.notes ? `<div class="card"><div class="small" style="margin-bottom:6px">Description</div><div class="notes">${esc(a.notes)}</div></div>` : ''}
    <div class="card"><div class="kv"><span>Étiquette</span><span class="code-tag">${esc(prettyCode(a.code_etiquette))}</span></div>
      <div class="kv"><span>Enregistré le</span><span>${esc(fmtDate(a.cree_le.slice(0, 10)))}</span></div></div>
    ${isStock ? `<div class="stack">
      <button class="btn btn-primary" data-act="consume">Marquer consommé</button>
      <button class="btn btn-secondary" data-act="edit2">Modifier</button></div>` : ''}
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  if (!isStock) return;
  const edit = () => go('form', { mode: 'edit', id: a.id });
  $('[data-act="edit"]', root).onclick = edit;
  $('[data-act="edit2"]', root).onclick = edit;
  $('[data-act="consume"]', root).onclick = () => confirmConsume(a);
  $$('[data-adj]', root).forEach(b => b.onclick = () => adjustSheet(a, b.dataset.adj));
}

/* ------------------------------------------------------------------ */
/* Écran 6 — Confirmation « consommé » + Annuler                        */
/* ------------------------------------------------------------------ */
function confirmConsume(a, emptied = false) {
  openSheet(body => {
    body.appendChild(h(`<h3>${emptied ? 'Plus rien en stock' : 'Marquer comme consommé ?'}</h3>
      <p>« ${esc(a.nom)} » sera retiré de la liste et l'étiquette <span class="code-tag">${esc(prettyCode(a.code_etiquette))}</span> sera libérée pour un nouveau contenu.</p>
      <div class="stack"><button class="btn btn-primary" data-act="yes">Oui, consommé</button>
      <button class="btn btn-secondary" data-act="no">${emptied ? 'Non, garder la fiche' : 'Annuler'}</button></div>`));
    $('[data-act="no"]', body).onclick = closeSheet;
    $('[data-act="yes"]', body).onclick = async () => {
      closeSheet();
      const before = { ...a };
      const etBefore = { ...S.etiquettes.get(a.code_etiquette) };
      const updated = { ...a, statut: 'consomme', sorti_le: nowISO() };
      await saveBoth({ ...etBefore, statut: 'libre' }, updated);
      home();
      setTimeout(() => toast(`« ${a.nom} » consommé`, 'Annuler', async () => {
        await saveBoth(etBefore, before);
        render();
        toast('Remis en stock');
      }, 6000), 30);
    };
  });
}

/* ------------------------------------------------------------------ */
/* Écran 7 — Ajuster la quantité                                        */
/* ------------------------------------------------------------------ */
function adjustSheet(a, initialMode) {
  const unit = UNIT[a.unite] || UNIT.piece;
  const stock = Number(a.quantite) || 0;
  let mode = initialMode === 'add' ? 'add' : 'remove';
  let n = 1;                                   // nombre à retirer / ajouter (unités comptables)
  let val = null;                              // poids : reste (retirer) ou ajout

  openSheet(body => {
    function draw() {
      let input, result;
      if (unit.weight) {
        if (val === null) val = mode === 'remove' ? stock : 0;
        result = mode === 'remove' ? val : stock + (val || 0);
        input = mode === 'remove'
          ? `<label class="fl">Il reste environ</label><div class="qty-row"><input class="input" type="number" inputmode="decimal" min="0" step="any" value="${esc(val)}"><div class="input" style="display:flex;align-items:center">${esc(unit.one)}</div></div>`
          : `<label class="fl">Ajouter</label><div class="qty-row"><input class="input" type="number" inputmode="decimal" min="0" step="any" value="${val || ''}" placeholder="0"><div class="input" style="display:flex;align-items:center">${esc(unit.one)}</div></div>`;
      } else {
        if (mode === 'remove') n = Math.min(Math.max(1, n), Math.max(1, stock));
        const max = mode === 'remove' ? Math.min(stock, 12) : 6;
        const sc = [];
        for (let i = 1; i <= max; i++) sc.push(`<button class="${i === n ? 'active' : ''}" data-n="${i}">${i}</button>`);
        result = mode === 'remove' ? stock - n : stock + n;
        input = `${sc.length ? `<div class="shortcuts">${sc.join('')}</div>` : ''}
          <div class="stepper"><button class="round" data-step="-1">−</button><div class="s-val">${n}</div><button class="round" data-step="1">+</button></div>`;
      }
      result = Math.max(0, Math.round(result * 1000) / 1000);
      const preview = mode === 'remove'
        ? `${esc(fmtQty(stock, a.unite))} en stock → il en restera <b>${esc(fmtQty(result, a.unite))}</b>`
        : `${esc(fmtQty(stock, a.unite))} en stock → il y en aura <b>${esc(fmtQty(result, a.unite))}</b>`;
      body.innerHTML = '';
      body.appendChild(h(`<h3>${esc(a.nom)}</h3>
        <div class="seg"><button class="${mode === 'remove' ? 'active' : ''}" data-mode="remove">Retirer</button><button class="${mode === 'add' ? 'active' : ''}" data-mode="add">Ajouter</button></div>
        ${input}
        <div class="preview">${preview}</div>
        <button class="btn btn-primary" data-act="ok" ${mode === 'remove' && !unit.weight && stock <= 0 ? 'disabled' : ''}>Valider</button>`));
      $$('[data-mode]', body).forEach(b => b.onclick = () => { mode = b.dataset.mode; n = 1; val = null; draw(); });
      $$('[data-n]', body).forEach(b => b.onclick = () => { n = Number(b.dataset.n); draw(); });
      $$('[data-step]', body).forEach(b => b.onclick = () => {
        n = Math.max(1, n + Number(b.dataset.step));
        if (mode === 'remove') n = Math.min(n, Math.max(1, stock));
        draw();
      });
      const inp = $('input', body);
      if (inp) inp.oninput = () => {
        val = inp.value === '' ? (mode === 'remove' ? 0 : 0) : Math.max(0, Number(inp.value));
        const r = mode === 'remove' ? val : stock + val;
        $('.preview b', body).textContent = fmtQty(Math.max(0, Math.round(r * 1000) / 1000), a.unite);
      };
      $('[data-act="ok"]', body).onclick = async () => {
        if (inp) val = inp.value === '' ? 0 : Math.max(0, Number(inp.value));
        const r = unit.weight ? (mode === 'remove' ? val : stock + val) : (mode === 'remove' ? stock - n : stock + n);
        const q = Math.max(0, Math.round(r * 1000) / 1000);
        closeSheet();
        if (q === 0) {
          const updated = { ...a, quantite: 0, modifie_le: nowISO() };
          await saveArticle(updated);
          render();
          return confirmConsume(updated, true);
        }
        await saveArticle({ ...a, quantite: q, modifie_le: nowISO() });
        render();
        toast(`Quantité : ${fmtQty(q, a.unite)}`);
      };
    }
    draw();
  });
}

/* ------------------------------------------------------------------ */
/* Réglages, sauvegarde, restauration                                   */
/* ------------------------------------------------------------------ */
async function requestPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }

async function exportBackup() {
  const photos = (await getAll('photos')).map(p => ({ id: p.id, type: p.type, data: bufToB64(p.buf) }));
  const data = { app: 'guess-my-fridge', format: 1, version: APP_VERSION, exporte_le: nowISO(),
    etiquettes: [...S.etiquettes.values()], articles: [...S.articles.values()], photos };
  const name = `gmf-sauvegarde-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Sauvegarde Guess My Fridge' });
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    await setMeta('lastBackup', nowISO());
    toast('Sauvegarde créée');
    render();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    toast('Sauvegarde impossible : ' + (e.message || e));
  }
}
function importBackup() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'application/json,.json';
  i.onchange = async () => {
    const f = i.files && i.files[0]; if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('Fichier illisible'); }
    if (data.app !== 'guess-my-fridge' || !Array.isArray(data.articles)) return toast("Ce fichier n'est pas une sauvegarde Guess My Fridge");
    openSheet(body => {
      body.appendChild(h(`<h3>Restaurer cette sauvegarde ?</h3>
        <p>Elle contient ${data.articles.filter(a => a.statut === 'en_stock').length} aliment(s) en stock (sauvegarde du ${esc(fmtDate(data.exporte_le.slice(0, 10)))}). <b>Les données actuelles du téléphone seront remplacées.</b></p>
        <div class="stack"><button class="btn btn-danger" data-act="yes">Remplacer mes données</button><button class="btn btn-secondary" data-act="no">Annuler</button></div>`));
      $('[data-act="no"]', body).onclick = closeSheet;
      $('[data-act="yes"]', body).onclick = async () => {
        closeSheet();
        await tx(['etiquettes', 'articles', 'photos'], 'readwrite', t => {
          ['etiquettes', 'articles', 'photos'].forEach(s => t.objectStore(s).clear());
          data.etiquettes.forEach(e => t.objectStore('etiquettes').put(e));
          data.articles.forEach(a => t.objectStore('articles').put(a));
          (data.photos || []).forEach(p => t.objectStore('photos').put({ id: p.id, type: p.type, buf: b64ToBuf(p.data) }));
        });
        S.etiquettes.clear(); S.articles.clear(); photoURLs.forEach(u => URL.revokeObjectURL(u)); photoURLs.clear();
        await loadAll();
        toast('Sauvegarde restaurée');
        home();
      };
    });
  };
  i.click();
}

async function screenSettings(root) {
  const nStock = enStock().length, nTot = S.articles.size, nEt = S.etiquettes.size;
  let persisted = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch {}
  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>Réglages</h2></div>
    <div class="card">
      <div class="kv"><span>Aliments en stock</span><span>${nStock}</span></div>
      <div class="kv"><span>Fiches au total (avec historique)</span><span>${nTot}</span></div>
      <div class="kv"><span>Étiquettes connues</span><span>${nEt}</span></div>
      <div class="kv"><span>Dernière sauvegarde</span><span>${S.meta.lastBackup ? esc(fmtDate(S.meta.lastBackup.slice(0, 10))) : 'jamais'}</span></div>
      <div class="kv"><span>App installée</span><span>${isStandalone() ? 'oui' : 'non'}</span></div>
      ${persisted !== null ? `<div class="kv"><span>Stockage protégé</span><span>${persisted ? 'oui' : 'non'}</span></div>` : ''}
    </div>
    <p class="small">Toutes les données restent sur ce téléphone : pas de compte, pas de serveur. La sauvegarde est le seul moyen de les retrouver si tu changes de téléphone ou désinstalles l'app.</p>
    <div class="stack">
      <button class="btn btn-primary" data-act="export">Exporter une sauvegarde</button>
      <button class="btn btn-secondary" data-act="import">Restaurer une sauvegarde</button>
    </div>
    <p class="small mt">Guess My Fridge · version de test ${APP_VERSION}</p>
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  $('[data-act="export"]', root).onclick = exportBackup;
  $('[data-act="import"]', root).onclick = importBackup;
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                            */
/* ------------------------------------------------------------------ */
const SCREENS = { list: screenList, scan: screenScan, photo: screenPhoto, form: screenForm, fiche: screenFiche, settings: screenSettings };

async function start() {
  try { db = await openDB(); await loadAll(); }
  catch (e) { $('#app').innerHTML = `<div class="screen"><h1>Erreur</h1><p>Stockage local indisponible (${esc(e.message || e)}). En navigation privée, l'app ne peut pas enregistrer de données.</p></div>`; return; }
  stack.push({ name: 'list', params: {} });
  history.replaceState({ i: 0 }, '');
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.GMF = { parseCode, checkChar };   // pour les tests
start();
