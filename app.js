/* Guess My Fridge — v1 de test (PWA locale, sans compte, sans serveur)
   Spécifications : claude/systeme-qr-v1.md + claude/ecrans-parcours-v1.md + claude/codes-barres-v1.md */
'use strict';

const APP_VERSION = '1.1.0';

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
  { id: 'paquet',  one: 'paquet',  many: 'paquets',  weight: false },
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
/* Codes-barres produits (EAN-13, EAN-8, UPC-A, UPC-E)                  */
/* ------------------------------------------------------------------ */
function eanValid(d) {                       // clé de contrôle mod 10 (GTIN)
  if (!/^\d{8}$|^\d{13}$/.test(d)) return false;
  let t = 0;
  for (let i = 0; i < d.length - 1; i++) t += Number(d[d.length - 2 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (t % 10)) % 10 === Number(d[d.length - 1]);
}
function upcEtoA(e) {                        // UPC-E (8 chiffres) → UPC-A (12 chiffres)
  const [ns, d, ck] = [e[0], e.slice(1, 7), e[7]];
  const last = d[5];
  let m;
  if ('012'.includes(last)) m = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') m = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') m = d.slice(0, 4) + '00000' + d[4];
  else m = d.slice(0, 5) + '0000' + last;
  return ns + m + ck;
}
/* Interprète un code-barres linéaire. Renvoie { kind: 'ean', ean, magasin } ou { kind: 'badean' } */
function parseEAN(raw, format) {
  let d = String(raw || '').replace(/\s/g, '');
  if (!/^\d+$/.test(d)) return { kind: 'badean' };
  if (format === 'upc_e' && d.length === 8) d = upcEtoA(d);
  if (d.length === 12) d = '0' + d;          // UPC-A → EAN-13
  if (!eanValid(d)) return { kind: 'badean' };
  // Préfixe 2 (20-29) : code interne au magasin (produit pesé / à la coupe)
  // En UPC-A, le système 2 (« 02… » une fois converti) joue le même rôle.
  const magasin = d.length === 13 && (d[0] === '2' || d.startsWith('02'));
  return { kind: 'ean', ean: d, magasin };
}
const LINEAR = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e']);
/* Point d'entrée unique du scanner : QR GMF, QR étranger ou code-barres */
function parseScan(raw, format, manual) {
  const s = String(raw || '').trim();
  if (LINEAR.has(format)) return parseEAN(s, format);
  if (manual && /^\d[\d\s]*$/.test(s)) {
    const n = s.replace(/\s/g, '');
    if ([8, 12, 13].includes(n.length)) return parseEAN(n, n.length === 8 ? 'ean_8' : 'ean_13');
  }
  return parseCode(s, manual);
}

/* ------------------------------------------------------------------ */
/* Base produits : Open Food Facts + cache local                        */
/* ------------------------------------------------------------------ */
const OFF_FIELDS = 'product_name,product_name_fr,generic_name_fr,brands,quantity,categories_tags,image_front_url';
const PRODUCT_TTL = 90 * 86400000;           // on rafraîchit un produit vu il y a plus de 90 jours
function mapCategory(tags) {
  const t = (tags || []).join(' ');
  const has = words => words.some(w => t.includes(w));
  if (has(['meals', 'pizza', 'prepared', 'soups', 'lasagna', 'quiche', 'ready-to'])) return 'plats';
  if (has(['fish', 'seafood', 'salmon', 'shrimp', 'prawn', 'tuna', 'cod', 'mussel'])) return 'poisson';
  if (has(['meat', 'poultry', 'sausage', 'beef', 'pork', 'chicken', 'turkey', 'lamb', 'veal'])) return 'viande';
  if (has(['vegetable', 'fruit', 'potato', 'fries', 'berries', 'spinach', 'peas', 'beans', 'mushroom', 'herbs'])) return 'legumes';
  return 'autres';
}
function parseContenance(q) {                // « 1 kg », « 450 g », « 4 x 125 g », « 1,5kg »
  const s = String(q || '').toLowerCase().replace(',', '.');
  const m = s.match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|g)\b/);
  if (!m) return null;
  let val = Number(m[2]) * (m[1] ? Number(m[1]) : 1);
  let unite = m[3];
  if (unite === 'g' && val >= 1000) { val = val / 1000; unite = 'kg'; }
  return { val: Math.round(val * 1000) / 1000, unite };
}
async function fetchOFF(ean) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=${OFF_FIELDS}&lc=fr&app_name=GuessMyFridge&app_version=${APP_VERSION}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 404) return { found: false };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.status !== 1 || !j.product) return { found: false };
    const p = j.product;
    const nom = (p.product_name_fr || p.product_name || p.generic_name_fr || '').trim();
    if (!nom) return { found: false };
    return {
      found: true,
      produit: {
        ean, nom, marque: (p.brands || '').split(',')[0].trim(),
        contenance_txt: (p.quantity || '').trim(), contenance: parseContenance(p.quantity),
        categorie: mapCategory(p.categories_tags), image_url: p.image_front_url || null,
        source: 'off', maj_le: nowISO(),
      },
    };
  } finally { clearTimeout(timer); }
}
/* Renvoie { produit, offline } ; produit = null si inconnu */
async function lookupProduct(ean) {
  const cached = S.produits.get(ean);
  const fresh = cached && (cached.source === 'manuel' || Date.now() - new Date(cached.maj_le).getTime() < PRODUCT_TTL);
  if (fresh) return { produit: cached };
  if (navigator.onLine === false) return { produit: cached || null, offline: true };
  try {
    const r = await fetchOFF(ean);
    if (!r.found) return { produit: cached || null };
    const p = { ...r.produit };
    if (cached) Object.assign(p, { nom_perso: cached.nom_perso, categorie_perso: cached.categorie_perso, photo: cached.photo });
    await saveProduit(p);
    return { produit: p };
  } catch {
    return { produit: cached || null, offline: true };
  }
}
/* Mémorise ce que l'utilisateur a saisi pour ce code-barres (réutilisé au prochain scan, même hors ligne) */
async function rememberProduct(data, asIs) {
  if (!data.ean || parseEAN(data.ean).magasin) return;    // les codes magasin ne sont jamais mis en cache
  const p = S.produits.get(data.ean);
  if (!p) {
    return saveProduit({ ean: data.ean, nom: data.nom, marque: '', contenance_txt: '', contenance: null,
      categorie: data.categorie, image_url: null, photo: asIs ? data.photo : null, source: 'manuel', maj_le: nowISO() });
  }
  if (!asIs) return;                                      // contenant étiqueté : on ne touche pas à la fiche produit
  const q = { ...p };
  if (p.source === 'manuel') { q.nom = data.nom; q.categorie = data.categorie; q.maj_le = nowISO(); }
  else {
    q.nom_perso = data.nom !== p.nom ? data.nom : undefined;
    q.categorie_perso = data.categorie !== p.categorie ? data.categorie : undefined;
  }
  if (asIs && data.photo && !p.photo) q.photo = data.photo;
  await saveProduit(q);
}
const prodNom = p => (p && (p.nom_perso || p.nom)) || '';
const prodCat = p => (p && (p.categorie_perso || p.categorie)) || null;
/* Télécharge la photo Open Food Facts une seule fois, la compresse et la garde en local */
async function productPhotoId(p) {
  if (!p) return null;
  if (p.photo && await getOne('photos', p.photo)) return p.photo;
  if (!p.image_url) return null;
  try {
    const r = await fetch(p.image_url);
    if (!r.ok) throw new Error();
    const id = await savePhoto(await compressImage(await r.blob()));
    await saveProduit({ ...p, photo: id });
    return id;
  } catch { return null; }
}
const BARCODE_SVG = '<svg width="16" height="12" viewBox="0 0 16 12" aria-label="code-barres" style="vertical-align:-1px;opacity:.6"><path fill="currentColor" d="M0 0h1.5v12H0zM2.5 0h1v12h-1zM4.5 0h2v12h-2zM7.5 0h1v12h-1zM9.5 0h1.5v12H9.5zM12 0h1v12h-1zM14 0h2v12h-2z"/></svg>';
const articleLabel = a => a.code_etiquette
  ? `Étiquette <span class="code-tag">${esc(prettyCode(a.code_etiquette))}</span>`
  : a.ean ? (parseEAN(a.ean).magasin ? `Produit à la coupe ${BARCODE_SVG} <span class="code-tag">${esc(a.ean)}</span>`
                                     : `Code-barres ${BARCODE_SVG} <span class="code-tag">${esc(a.ean)}</span>`)
  : '';

/* ------------------------------------------------------------------ */
/* Stockage local : IndexedDB                                           */
/* ------------------------------------------------------------------ */
const DB_NAME = 'gmf';
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('etiquettes', { keyPath: 'code' });
        d.createObjectStore('articles', { keyPath: 'id' });
        d.createObjectStore('photos', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'k' });
      }
      if (e.oldVersion < 2) d.createObjectStore('produits', { keyPath: 'ean' });   // v1.1 : codes-barres
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
const S = { etiquettes: new Map(), articles: new Map(), produits: new Map(), meta: {} };
async function loadAll() {
  for (const e of await getAll('etiquettes')) S.etiquettes.set(e.code, e);
  for (const a of await getAll('articles')) S.articles.set(a.id, a);
  for (const p of await getAll('produits')) S.produits.set(p.ean, p);
  for (const m of await getAll('meta')) S.meta[m.k] = m.v;
}
async function saveProduit(p) { S.produits.set(p.ean, p); await put('produits', p); }
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
/* Articles en stock identifiés par leur seul code-barres (sans étiquette GMF) */
const articlesEAN = ean => enStock().filter(a => !a.code_etiquette && a.ean === ean)
  .sort((x, y) => x.congele_le.localeCompare(y.congele_le));
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
    const isDesktop = !isIOS() && !/android/i.test(navigator.userAgent) && !(navigator.maxTouchPoints > 0);
    banners += `<div class="banner" data-b="install"><span class="b-text">${isIOS()
      ? '<b>Installe l\'app pour ne pas perdre tes données :</b> dans Safari, touche <b>⋯</b> (en bas à droite), puis <b>Partager ⬆︎</b>, puis « Sur l\'écran d\'accueil ». Sur les iOS plus anciens, le bouton Partager ⬆︎ est directement visible.'
      : isDesktop ? '<b>Cette app est faite pour le téléphone :</b> ouvre ce lien sur ton iPhone ou ton Android pour scanner tes étiquettes.'
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
        <div class="r-main"><div class="r-name">${esc(a.nom)}${!a.code_etiquette && a.ean ? ' ' + BARCODE_SVG : ''}</div>
          <div class="r-sub">${esc(CAT[a.categorie]?.label || 'Autres')}${a.quantite !== null && a.quantite !== '' ? ' · ' + esc(fmtQty(a.quantite, a.unite)) : ''}</div></div>
        <div class="r-side"><div class="r-age">${esc(ageShort(a.congele_le))}</div><div>${esc(fmtDateShort(a.congele_le))}</div></div>
      </button>`).join('') : `<div class="empty"><div class="big">🧊</div>${items.length
        ? 'Rien dans cette catégorie.'
        : 'Ton congélateur est vide.<br>Scanne une étiquette ou le code-barres d\'un produit pour enregistrer ton premier aliment.'}</div>`}
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
/* Écran 2 — Scanner (QR GMF + codes-barres produits)                   */
/* ------------------------------------------------------------------ */
const FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e'];
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('chargement ' + src));
    document.head.appendChild(s);
  });
}
/* Lecteur : API native BarcodeDetector si elle lit QR + EAN (Chrome Android),
   sinon ZXing en WebAssembly (iPhone, Firefox…). Fichiers servis par l'app, donc hors ligne. */
let detectorP = null;
function getDetector() {
  if (!detectorP) detectorP = (async () => {
    if ('BarcodeDetector' in window) {
      try {
        const f = await window.BarcodeDetector.getSupportedFormats();
        if (f.includes('qr_code') && f.includes('ean_13')) return new window.BarcodeDetector({ formats: FORMATS.filter(x => f.includes(x)) });
      } catch {}
    }
    await loadScript('barcode-detector.js');
    const api = window.BarcodeDetectionAPI;
    await api.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => path.endsWith('.wasm') ? new URL('zxing_reader.wasm', location.href).href : prefix + path },
      fireImmediately: true,
    });
    return new api.BarcodeDetector({ formats: FORMATS });
  })().catch(e => { detectorP = null; throw e; });
  return detectorP;
}
let prefillResult = null;                     // résultat rapporté au formulaire par le scan « pré-remplir »

function screenScan(root, params) {
  const chain = params.chain || null;           // pré-remplissage « scanner le suivant »
  const purpose = params.purpose || 'any';      // any | tag (cas B : étiquette du contenant) | prefill (formulaire)
  const hint = purpose === 'tag' ? "Scanne l'étiquette Guess My Fridge du contenant"
    : purpose === 'prefill' ? 'Vise le code-barres du produit'
    : "Vise le QR de l'étiquette ou le code-barres du produit";
  root.appendChild(h(`<div class="scanner">
    <video playsinline muted autoplay></video>
    <div class="s-top">
      <button class="icon-btn" data-act="close" aria-label="Fermer">✕</button>
      ${chain ? `<span class="chain-pill">Suivant : ${esc(chain.nom)}</span>` : '<span></span>'}
      <button class="icon-btn" data-act="torch" aria-label="Lampe" style="visibility:hidden">🔦</button>
    </div>
    <div class="s-frame"><div class="box"></div></div>
    <div class="s-hint">${esc(hint)}</div>
    <div class="s-msgs"></div>
    <div class="s-bottom">
      <form class="manual" autocomplete="off">
        <input name="code" placeholder="${purpose === 'prefill' ? 'Code-barres : 13 chiffres' : purpose === 'tag' ? 'Code : T2KQ-41T' : 'T2KQ-41T ou code-barres'}" inputmode="${purpose === 'prefill' ? 'numeric' : 'text'}" autocapitalize="characters" spellcheck="false">
        <button type="submit">OK</button>
      </form>
    </div>
  </div>`));
  const video = $('video', root), msgs = $('.s-msgs', root), torchBtn = $('[data-act="torch"]', root);
  let stream = null, track = null, alive = true, raf = 0, lastCode = '', lastAt = 0, busy = false, torchOn = false;
  let detector = null, detecting = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const showMsg = (html, err = true) => { msgs.innerHTML = `<div class="s-msg ${err ? 'err' : ''}">${html}</div>`; };
  $('[data-act="close"]', root).onclick = () => back();

  async function handle(raw, format, manual) {
    if (busy) return;
    const now = Date.now();
    if (!manual && raw === lastCode && now - lastAt < 2000) return;   // anti double scan
    lastCode = raw; lastAt = now;
    const r = parseScan(raw, format, manual);
    // étiquette / barquette qu'on vient d'enregistrer
    if (!manual && chain && chain.skip && ((r.kind === 'ok' && r.code === chain.skip) || (r.kind === 'ean' && r.ean === chain.skip))) return;
    if (r.kind === 'badean') return manual ? showMsg('<b>Code-barres invalide.</b> Vérifie les chiffres sous les barres.') : undefined;
    if (r.kind === 'foreign') return showMsg(`<b>Ce QR n'est pas une étiquette Guess My Fridge.</b><br><code>${esc(raw.slice(0, 120))}</code>`);
    if (r.kind === 'newer') return showMsg(`<b>Format d'étiquette plus récent.</b> Mets l'app à jour pour lire cette étiquette.`);
    if (r.kind === 'invalid') return showMsg(`<b>Code invalide.</b> ${manual ? 'Vérifie les 7 caractères imprimés sous le QR.' : 'Rapproche-toi ou essuie le givre.'}`);

    if (purpose === 'tag') {
      if (r.kind === 'ean') return showMsg("C'est le code-barres du produit. <b>Scanne maintenant l'étiquette Guess My Fridge</b> collée sur le contenant.", false);
      const e = S.etiquettes.get(r.code);
      if (e && e.statut === 'hs') return showMsg('<b>Étiquette retirée du service.</b> Prends-en une autre.');
      const occ = e && e.statut === 'active' ? articleActif(r.code) : null;
      if (occ) return showMsg(`<b>Étiquette déjà utilisée</b> par « ${esc(occ.nom)} ». Prends une étiquette vierge ou libre.`);
      busy = true; if (navigator.vibrate) navigator.vibrate(40);
      const ancien = e ? dernierSorti(r.code) : null;
      return replace('photo', { code: r.code, ean: params.ean, ancien: ancien ? ancien.id : null, chain });
    }
    if (purpose === 'prefill') {
      if (r.kind !== 'ean') return showMsg("C'est une étiquette Guess My Fridge. <b>Vise le code-barres du produit.</b>", false);
      if (r.magasin) return showMsg("<b>Code magasin (produit à la coupe)</b> : il n'y a pas de fiche produit à reprendre. Remplis le formulaire à la main.", false);
      busy = true; if (navigator.vibrate) navigator.vibrate(40);
      showMsg('Recherche du produit…', false);
      const { produit, offline } = await lookupProduct(r.ean);
      prefillResult = { ean: r.ean, produit, offline };
      return back();
    }
    busy = true;
    if (navigator.vibrate) navigator.vibrate(40);
    if (r.kind === 'ean') return routeEAN(r, chain);
    routeCode(r.code, chain);
  }
  $('.manual', root).onsubmit = e => { e.preventDefault(); const v = e.target.code.value; if (v.trim()) handle(v, null, true); };

  torchBtn.onclick = async () => {
    try { torchOn = !torchOn; await track.applyConstraints({ advanced: [{ torch: torchOn }] }); torchBtn.classList.toggle('on', torchOn); }
    catch { torchBtn.style.visibility = 'hidden'; }
  };

  let lastScan = 0;
  async function analyse() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    // Bande centrale large : convient au QR (carré) comme au code-barres (allongé)
    const cw = vw * 0.9, ch = Math.min(vh * 0.7, cw * 0.8);
    const sx = (vw - cw) / 2, sy = (vh - ch) / 2;
    const k = Math.min(1, 960 / cw);
    canvas.width = Math.round(cw * k); canvas.height = Math.round(ch * k);
    ctx.drawImage(video, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
    if (detector) {
      const found = await detector.detect(canvas);
      if (!alive || busy || !found.length) return;
      const best = found.find(b => b.format === 'qr_code') || found[0];
      return handle(best.rawValue, best.format, false);
    }
    if (window.jsQR) {                                    // secours : QR seulement
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = window.jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (res && res.data) handle(res.data, 'qr_code', false);
    }
  }
  function loop(t) {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    if (t - lastScan < 150 || video.readyState < 2 || busy || detecting) return;
    lastScan = t;
    detecting = true;
    analyse().catch(() => {}).finally(() => { detecting = false; });
  }

  getDetector().then(d => { detector = d; }).catch(() => {
    if (alive) showMsg(window.jsQR
      ? 'Lecteur de codes-barres indisponible : seuls les QR sont lus. Tu peux saisir le code-barres à la main.'
      : 'Lecteur indisponible. Tu peux saisir le code à la main.');
  });

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

/* Arbre de décision d'un code-barres (voir codes-barres-v1.md) */
function routeEAN(r, chain) {
  const enCours = articlesEAN(r.ean);
  if (r.magasin) {                                   // cas C : la barquette elle-même
    if (enCours.length) return replace('fiche', { id: enCours[0].id, autre: true });
    return replace('photo', { ean: r.ean, magasin: true, chain });
  }
  if (enCours.length) return replace('fiche', { id: enCours[0].id });   // cas A : un article par produit
  replace('produit', { ean: r.ean, chain });
}

/* ------------------------------------------------------------------ */
/* Écran 2 bis — Produit reconnu                                        */
/* ------------------------------------------------------------------ */
async function screenProduit(root, params) {
  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>Produit</h2></div>
    <div class="empty"><div class="big">🔎</div>Recherche du produit…</div></div>`));
  $('[data-act="back"]', root).onclick = () => back();
  if (!params.__res) params.__res = await lookupProduct(params.ean);
  if (stack[stack.length - 1].params !== params) return;          // l'utilisateur est parti entre-temps
  const { produit: p, offline } = params.__res;
  const localURL = p && p.photo ? await photoURL(p.photo) : null;
  const img = localURL || (p && p.image_url) || null;
  root.innerHTML = '';
  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>${p ? 'Produit reconnu' : 'Produit inconnu'}</h2></div>
    ${p ? `
      ${img ? `<img class="photo-big" src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="f-title">${esc(prodNom(p))}</div>
      <div class="f-meta">${esc([p.marque, p.contenance_txt].filter(Boolean).join(' · '))}</div>
      <div class="f-meta">${esc((CAT[prodCat(p)] || CAT.autres).emoji + ' ' + (CAT[prodCat(p)] || CAT.autres).label)}</div>
      <p class="small">Code-barres <span class="code-tag">${esc(params.ean)}</span>${p.source === 'off' ? ' · Données Open Food Facts' : ' · d\'après ta saisie précédente'}</p>`
    : `<div class="banner info"><span class="b-text">${offline
        ? 'Pas de connexion : impossible de reconnaître ce produit pour le moment.'
        : "Ce produit n'est pas dans la base Open Food Facts."} Tu pourras saisir son nom : l'app s'en souviendra au prochain scan.</span></div>
      <p class="small">Code-barres <span class="code-tag">${esc(params.ean)}</span></p>`}
    <div class="stack mt">
      <button class="btn btn-primary" data-act="asis">Ranger tel quel</button>
      <button class="btn btn-secondary" data-act="box">Mettre dans un contenant étiqueté</button>
    </div>
    <p class="small">« Tel quel » : dans son emballage d'origine, sans étiquette. Les paquets identiques sont regroupés sur une seule fiche.</p>
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  $('[data-act="asis"]', root).onclick = () => replace('photo', { ean: params.ean, chain: params.chain });
  $('[data-act="box"]', root).onclick = () => replace('scan', { purpose: 'tag', ean: params.ean, chain: params.chain });
}

/* ------------------------------------------------------------------ */
/* Écran 3 — Photo du contenant                                         */
/* ------------------------------------------------------------------ */
async function screenPhoto(root, params) {
  const ancien = params.ancien ? S.articles.get(params.ancien) : null;
  const casA = !params.code && params.ean && !params.magasin;      // produit rangé tel quel
  const prod = params.ean && !params.magasin ? S.produits.get(params.ean) : null;
  const oldPhotoId = ancien?.photo || null;
  const oldURL = await photoURL(oldPhotoId);
  const prodURL = casA && prod ? ((prod.photo && await photoURL(prod.photo)) || prod.image_url || null) : null;
  const next = photo => replace('form', { mode: 'create', code: params.code, ean: params.ean, magasin: params.magasin,
    ancien: params.ancien, chain: params.chain, photo });

  let intro;
  if (params.code) intro = `Étiquette <span class="code-tag">${esc(prettyCode(params.code))}</span> · ${ancien
      ? `réutilisée — ancien contenu : <b>${esc(ancien.nom)}</b> (sorti le ${esc(fmtDate(ancien.sorti_le.slice(0, 10)))})`
      : 'nouvelle étiquette'}${prod ? ` · pour <b>${esc(prodNom(prod))}</b>` : ''}`;
  else if (params.magasin) intro = `Produit à la coupe ${BARCODE_SVG} <span class="code-tag">${esc(params.ean)}</span>`;
  else intro = `${BARCODE_SVG} <b>${esc(prodNom(prod) || 'Produit')}</b> · rangé dans son emballage`;

  const main = oldURL || prodURL;
  root.appendChild(h(`<div class="screen">
    <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>${casA ? 'Photo du produit' : params.magasin ? 'Photo de la barquette' : 'Photo du contenant'}</h2></div>
    <p class="small">${intro}</p>
    ${main ? `<img class="photo-big" src="${esc(main)}" alt="" referrerpolicy="no-referrer">` : `<div class="photo-placeholder">📷</div>`}
    <p class="small">La photo aide à reconnaître ${casA ? 'le paquet' : 'le contenant (sac, boîte, couleur…)'}. Elle ne s'affiche que sur la fiche.</p>
    <div class="stack">
      ${oldURL ? `<button class="btn btn-primary" data-act="keep">Garder l'ancienne</button>
                  <button class="btn btn-secondary" data-act="take">Nouvelle photo</button>`
       : prodURL ? `<button class="btn btn-primary" data-act="prod">Utiliser la photo du produit</button>
                  <button class="btn btn-secondary" data-act="take">Nouvelle photo</button>`
       : `<button class="btn btn-primary" data-act="take">📷 Prendre la photo</button>`}
      <button class="btn btn-ghost" data-act="skip">Passer</button>
    </div>
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  $('[data-act="skip"]', root).onclick = () => next(null);
  const keep = $('[data-act="keep"]', root);
  if (keep) keep.onclick = () => next(oldPhotoId);
  const pb = $('[data-act="prod"]', root);
  if (pb) pb.onclick = async () => {
    pb.disabled = true; pb.textContent = 'Téléchargement…';
    const id = await productPhotoId(S.produits.get(params.ean));
    if (id) return next(id);
    toast('Photo du produit indisponible (connexion ?). Prends-en une ou passe.');
    pb.remove();
  };
  $('[data-act="take"]', root).onclick = async () => { const id = await pickPhoto(); if (id) next(id); };
}

/* ------------------------------------------------------------------ */
/* Écran 4 — Formulaire (création et modification)                      */
/* ------------------------------------------------------------------ */
async function screenForm(root, params) {
  const editing = params.mode === 'edit';
  const art = editing ? S.articles.get(params.id) : null;
  const ancien = params.ancien ? S.articles.get(params.ancien) : null;
  const code = editing ? art.code_etiquette : params.code;
  const magasin = editing ? !!(art.ean && parseEAN(art.ean).magasin) : !!params.magasin;
  const prod = !editing && params.ean && !magasin ? S.produits.get(params.ean) : null;
  const fromProduct = (p, withTag) => {        // pré-remplissage depuis une fiche produit
    const c = p.contenance;
    return {
      nom: prodNom(p), categorie: prodCat(p),
      quantite: withTag ? (c ? c.val : 1) : 1,
      unite: withTag ? (c ? c.unite : 'piece') : 'paquet',
      notes: [p.marque, withTag ? '' : p.contenance_txt].filter(Boolean).join(' · '),
    };
  };
  let st = params.__st;                        // état conservé si on revient d'un scan « pré-remplir »
  if (!st) {
    const pre = editing ? art : prod ? { ...fromProduct(prod, !!code), congele_le: params.chain?.congele_le } : (params.chain || {});
    st = {
      nom: pre.nom || '',
      congele_le: pre.congele_le || today(),
      categorie: pre.categorie || null,
      quantite: pre.quantite ?? 1,
      unite: pre.unite || 'piece',
      notes: editing ? (art.notes || '') : (pre.notes || ''),
      a_consommer_avant: editing ? (art.a_consommer_avant || '') : '',
      photo: editing ? art.photo : params.photo,
      ean: editing ? (art.ean || null) : (params.ean || null),
      prefilled: !!prod,
    };
    params.__st = st;
  }
  if (prefillResult) {                         // retour du scan « pré-remplir avec le code-barres »
    const { ean, produit, offline } = prefillResult;
    prefillResult = null;
    st.ean = ean;
    if (produit) {
      const keepNotes = st.notes.trim();
      Object.assign(st, fromProduct(produit, true)); st.prefilled = true;
      if (keepNotes) st.notes = keepNotes;                // ne pas écraser une description déjà tapée
    }
    else setTimeout(() => toast(offline ? 'Pas de connexion : saisis le nom, le code-barres est gardé.' : "Produit inconnu : saisis son nom, l'app le retiendra."), 50);
  }

  async function draw() {
    const url = await photoURL(st.photo);
    root.innerHTML = '';
    root.appendChild(h(`<div class="screen">
      <div class="topbar"><button class="icon-btn" data-act="back">←</button><h2>${editing ? 'Modifier' : 'Nouvel aliment'}</h2></div>
      ${ancien && !editing ? `<div class="banner info"><span class="b-text">Contenant réutilisé — avant : <b>${esc(ancien.nom)}</b></span></div>` : ''}
      ${st.prefilled && !editing ? `<div class="banner info"><span class="b-text">Pré-rempli d'après le produit${S.produits.get(st.ean)?.source === 'off' ? ' (Open Food Facts)' : ''} : vérifie puis enregistre.</span></div>`
        : params.chain && !editing ? `<div class="banner info"><span class="b-text">Pré-rempli d'après l'aliment précédent : vérifie puis enregistre.</span></div>` : ''}
      ${code && !st.ean ? `<button type="button" class="btn btn-secondary" data-act="scan-ean">${BARCODE_SVG}&nbsp; Pré-remplir avec le code-barres du produit</button>` : ''}
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

        <label class="fl" for="f-dlc">À consommer avant <span class="small">(facultatif)</span></label>
        <input id="f-dlc" class="input" type="date" name="a_consommer_avant" value="${esc(st.a_consommer_avant)}">

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
      <p class="small">${articleLabel({ code_etiquette: code, ean: st.ean })}${code && st.ean ? ` · code-barres <span class="code-tag">${esc(st.ean)}</span>` : ''}</p>
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
      st.a_consommer_avant = f('a_consommer_avant').value || '';
    };
    $('[data-act="back"]', root).onclick = () => back();
    const se = $('[data-act="scan-ean"]', root);
    if (se) se.onclick = () => { sync(); go('scan', { purpose: 'prefill' }); };
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
        a_consommer_avant: st.a_consommer_avant || null, ean: st.ean || null,
      };
      await rememberProduct(data, !code);
      if (editing) {
        await saveArticle({ ...art, ...data, modifie_le: nowISO() });
        toast('Modifications enregistrées');
        return back();
      }
      let a;
      if (code) {                                 // étiquette GMF (cas normal et cas B)
        const prev = S.etiquettes.get(code);
        if (prev && prev.statut === 'active' && articleActif(code)) { toast('Cette étiquette est déjà utilisée.'); return home(); }
        const e = prev ? { ...prev, statut: 'active' } : { code, statut: 'active', lot: null, premiere_vue_le: nowISO() };
        a = { id: uid(), code_etiquette: code, ...data, statut: 'en_stock', sorti_le: null, cree_le: nowISO() };
        await saveBoth(e, a);
      } else {                                    // code-barres seul : cas A (produit) ou C (à la coupe)
        const deja = !magasin && articlesEAN(data.ean)[0];
        if (deja) { toast('Ce produit est déjà en stock : ajoute un paquet avec [+].'); return replace('fiche', { id: deja.id }); }
        a = { id: uid(), code_etiquette: null, ...data, statut: 'en_stock', sorti_le: null, cree_le: nowISO() };
        await saveArticle(a);
      }
      requestPersist();
      if (andNext) {
        toast(`« ${a.nom} » enregistré`);
        const skip = code || (magasin ? data.ean : null);   // un produit industriel rescanné ouvre sa fiche
        replace('scan', { chain: { skip, nom: a.nom, categorie: a.categorie, congele_le: a.congele_le, quantite: a.quantite, unite: a.unite } });
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
    <div class="card">
      ${a.code_etiquette ? `<div class="kv"><span>Étiquette</span><span class="code-tag">${esc(prettyCode(a.code_etiquette))}</span></div>` : ''}
      ${a.ean ? `<div class="kv"><span>${a.code_etiquette ? 'Code-barres' : parseEAN(a.ean).magasin ? 'Produit à la coupe' : 'Emballage d\'origine'}</span><span class="code-tag">${esc(a.ean)}</span></div>` : ''}
      ${a.a_consommer_avant ? `<div class="kv"><span>À consommer avant</span><span>${esc(fmtDate(a.a_consommer_avant))}${daysSince(a.a_consommer_avant) > 0 ? ' ⚠︎' : ''}</span></div>` : ''}
      <div class="kv"><span>Enregistré le</span><span>${esc(fmtDate(a.cree_le.slice(0, 10)))}</span></div></div>
    ${isStock ? `<div class="stack">
      <button class="btn btn-primary" data-act="consume">Marquer consommé</button>
      <button class="btn btn-secondary" data-act="edit2">Modifier</button>
      ${params.autre ? '<button class="btn btn-ghost" data-act="autre">C\'est une autre barquette</button>' : ''}</div>` : ''}
  </div>`));
  $('[data-act="back"]', root).onclick = () => back();
  if (!isStock) return;
  const ab = $('[data-act="autre"]', root);
  if (ab) ab.onclick = () => replace('photo', { ean: a.ean, magasin: true });
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
      <p>« ${esc(a.nom)} » sera retiré de la liste${a.code_etiquette ? ` et l'étiquette <span class="code-tag">${esc(prettyCode(a.code_etiquette))}</span> sera libérée pour un nouveau contenu` : ''}.</p>
      <div class="stack"><button class="btn btn-primary" data-act="yes">Oui, consommé</button>
      <button class="btn btn-secondary" data-act="no">${emptied ? 'Non, garder la fiche' : 'Annuler'}</button></div>`));
    $('[data-act="no"]', body).onclick = closeSheet;
    $('[data-act="yes"]', body).onclick = async () => {
      closeSheet();
      const before = { ...a };
      const etBefore = a.code_etiquette ? { ...S.etiquettes.get(a.code_etiquette) } : null;
      const updated = { ...a, statut: 'consomme', sorti_le: nowISO() };
      if (etBefore) await saveBoth({ ...etBefore, statut: 'libre' }, updated);
      else await saveArticle(updated);
      home();
      setTimeout(() => toast(`« ${a.nom} » consommé`, 'Annuler', async () => {
        if (etBefore) await saveBoth(etBefore, before); else await saveArticle(before);
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
  const data = { app: 'guess-my-fridge', format: 2, version: APP_VERSION, exporte_le: nowISO(),
    etiquettes: [...S.etiquettes.values()], articles: [...S.articles.values()], produits: [...S.produits.values()], photos };
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
        await tx(['etiquettes', 'articles', 'photos', 'produits'], 'readwrite', t => {
          ['etiquettes', 'articles', 'photos', 'produits'].forEach(s => t.objectStore(s).clear());
          (data.produits || []).forEach(p => t.objectStore('produits').put(p));   // absent des sauvegardes v1.0
          data.etiquettes.forEach(e => t.objectStore('etiquettes').put(e));
          data.articles.forEach(a => t.objectStore('articles').put(a));
          (data.photos || []).forEach(p => t.objectStore('photos').put({ id: p.id, type: p.type, buf: b64ToBuf(p.data) }));
        });
        S.etiquettes.clear(); S.articles.clear(); S.produits.clear(); photoURLs.forEach(u => URL.revokeObjectURL(u)); photoURLs.clear();
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
      <div class="kv"><span>Produits mémorisés (codes-barres)</span><span>${S.produits.size}</span></div>
      <div class="kv"><span>Dernière sauvegarde</span><span>${S.meta.lastBackup ? esc(fmtDate(S.meta.lastBackup.slice(0, 10))) : 'jamais'}</span></div>
      <div class="kv"><span>App installée</span><span>${isStandalone() ? 'oui' : 'non'}</span></div>
      ${persisted !== null ? `<div class="kv"><span>Stockage protégé</span><span>${persisted ? 'oui' : 'non'}</span></div>` : ''}
    </div>
    <p class="small">Toutes les données restent sur ce téléphone : pas de compte, pas de serveur. Seul le numéro d'un code-barres produit est envoyé à Open Food Facts (base ouverte, licence ODbL) pour reconnaître le produit. La sauvegarde est le seul moyen de les retrouver si tu changes de téléphone ou désinstalles l'app.</p>
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
const SCREENS = { list: screenList, scan: screenScan, produit: screenProduit, photo: screenPhoto, form: screenForm, fiche: screenFiche, settings: screenSettings };

async function start() {
  try { db = await openDB(); await loadAll(); }
  catch (e) { $('#app').innerHTML = `<div class="screen"><h1>Erreur</h1><p>Stockage local indisponible (${esc(e.message || e)}). En navigation privée, l'app ne peut pas enregistrer de données.</p></div>`; return; }
  stack.push({ name: 'list', params: {} });
  history.replaceState({ i: 0 }, '');
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.GMF = { parseCode, checkChar, parseEAN, parseScan, mapCategory, parseContenance };   // pour les tests
start();
