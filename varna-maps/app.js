'use strict';
/* Варна Адрес — бързо офлайн търсене на адреси във Варна (данни: OpenStreetMap) */

const CFG = {
  bbox: [43.08, 27.66, 43.34, 28.12],           // юг, запад, север, изток — цялата община + околност
  center: [43.2141, 27.9147],
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  maxAgeDays: 10,
  dataVersion: 1,
};

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ───────────── нормализиране (кирилица + латиница → общ скелет) ───────────── */
const CYR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'j',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'i',ю:'iu',я:'ia',э:'e',ы:'i',і:'i' };
function skel(s) {
  s = String(s || '').toLowerCase();
  s = s.replace(/zh/g, 'j').replace(/tz|ts/g, 'c').replace(/y/g, 'i').replace(/w/g, 'v').replace(/x/g, 'ks').replace(/q/g, 'ia');
  let o = '';
  for (const ch of s) o += CYR[ch] ?? ch;
  return o.replace(/[^a-z0-9]+/g, ' ').trim();
}
const STOP = new Set(['ulica','ul','bul','bulevard','ploshtad','pl','jk','j','k','kv','kvartal','kompleks','jilishten','vz','vilna','zona','mestnost','m','st','selo','s','grad','gr','varna','obl','oblast','obshtina','no','nomer','str','street','blvd','bulgaria','balgaria']);
const toks = s => skel(s).split(' ').filter(t => t && !STOP.has(t));

function pretty(name) {
  return String(name || '').replace(/[„“”"«»]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^улица\s+/i, 'ул. ').replace(/^булевард\s+/i, 'бул. ').replace(/^площад\s+/i, 'пл. ')
    .replace(/^жилищен комплекс\s+/i, 'ж.к. ').replace(/^квартал\s+/i, 'кв. ');
}
function hnKeys(hn) {
  const keys = [];
  for (let p of String(hn || '').split(/[;,]/)) {
    p = p.trim(); if (!p) continue;
    const r = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (r) { keys.push(r[1], r[2]); continue; }
    const k = skel(p).replace(/ /g, '').replace(/^no/, '');
    if (k) keys.push(k);
  }
  return keys;
}
const intOf = k => { const m = String(k).match(/^(\d+)/); return m ? +m[1] : NaN; };

/* разбор на заявка: текст + номер / блок; маха вх., ет., ап., п.к. */
function parseQuery(raw) {
  let s = ' ' + String(raw).toLowerCase().replace(/[„“"”'`«»]/g, ' ') + ' ';
  s = s.replace(/(^|[\s,.])(?:ап|апарт|апартамент|ет|етаж|вх|вход|ap|et|vh|vhod)\.?\s*[№#]?\s*[0-9a-zа-я]{1,3}(?=[\s,.]|$)/g, '$1 ');
  s = s.replace(/(?:п\.?\s*к\.?|pk)\s*\d{4}/g, ' ').replace(/(^|[\s,])9[01]\d\d(?=[\s,]|$)/g, '$1 ');
  let block = null;
  const bm = s.match(/(^|[\s,.])(?:бл|блок|bl|blok)\.?\s*[№#]?\s*(\d+[a-zа-я]?)(?=[\s,.]|$)/);
  if (bm) { block = bm[2]; s = s.replace(bm[0], bm[1] + ' '); }
  const segs = s.split(',').map(x => x.trim()).filter(Boolean);
  let num = null;
  // номер = последното число, пред което има дума
  const all = s.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = all.length - 1; i > 0 && !num; i--) {
    let t = all[i].replace(/^[№#]/, '');
    let m = t.match(/^(\d{1,4})(?:-?([a-zа-я]))?$/);
    let letter = null, j = i;
    if (!m && /^[a-zа-я]$/.test(t) && i > 1 && /^[№#]?\d{1,4}$/.test(all[i - 1])) { letter = t; j = i - 1; m = all[j].replace(/^[№#]/, '').match(/^(\d{1,4})$/); }
    if (!m) continue;
    if (!all.slice(0, j).some(x => /[a-zа-я]{2,}/.test(x))) break;
    num = m[1] + (m[2] || letter || '');
    all.splice(j, i - j + 1);
  }
  const text = (block || num ? all : s.replace(/,/g, ' ').split(/\s+/)).join(' ');
  const keys = [];
  if (block) { const b = skel(block).replace(/ /g, ''); keys.push('bl' + b, b); }
  if (num) { const n = skel(num).replace(/ /g, ''); keys.push(n, 'bl' + n); }
  return { raw, text, qt: toks(text), num: block || num, isBlock: !!block, keys, segs };
}

/* ───────────── база данни ───────────── */
const DB = { streets: new Map(), pois: [], addrs: [], ts: 0, ready: false };

function buildIndex(data) {
  const streets = new Map(), pois = [], addrs = [];
  const getStreet = (name) => {
    const t = toks(name); if (!t.length) return null;
    const key = t.join(' ');
    let s = streets.get(key);
    if (!s) { s = { key, name: pretty(name), toks: t, addrs: [], geoms: [] }; streets.set(key, s); }
    return s;
  };
  for (const [name, flat] of data.streets) {
    const s = getStreet(name); if (!s) continue;
    const g = []; for (let i = 0; i < flat.length; i += 2) g.push([flat[i], flat[i + 1]]);
    s.geoms.push(g);
  }
  for (const r of data.points) {
    // r = [lat, lon, street, place, hn, block, city, postcode, name, kind]
    const [lat, lon, street, place, hn0, block, city, pc, name, kind] = r;
    const hn = hn0 || (block ? 'бл. ' + block : '');
    const stName = street || place;
    if (stName && hn) {
      const s = getStreet(stName);
      if (s) {
        const keys = hnKeys(hn); if (block) keys.push('bl' + skel(block).replace(/ /g, ''));
        const a = { lat, lon, s, hn: hn.replace(/\s+/g, ' '), keys, city, pc, name, place: street && place ? place : '' };
        s.addrs.push(a); addrs.push(a);
      }
    }
    if (name && kind) {
      pois.push({ lat, lon, name, toks: toks(name), kind, addr: stName ? pretty(stName) + (hn ? ' ' + hn : '') : '' });
    }
  }
  for (const s of streets.values()) {
    if (s.addrs.length) { let la = 0, lo = 0; for (const a of s.addrs) { la += a.lat; lo += a.lon; } s.c = [la / s.addrs.length, lo / s.addrs.length]; }
    else if (s.geoms.length) { const g = s.geoms[Math.floor(s.geoms.length / 2)]; s.c = g[Math.floor(g.length / 2)]; }
    s.cities = new Set(s.addrs.map(a => a.city).filter(Boolean));
  }
  Object.assign(DB, { streets, pois, addrs, ts: data.ts, ready: true });
}

/* IndexedDB */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('varna-adres', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbSet(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

/* Overpass изтегляне */
const BB = CFG.bbox.join(',');
const Q_POINTS = `[out:csv(::lat,::lon,"addr:street","addr:place","addr:housenumber","addr:block","addr:city","addr:postcode","name","shop","amenity","office","tourism","place","craft","healthcare","leisure";false;"\t")][timeout:300][bbox:${BB}];
(nwr["addr:housenumber"];nwr["addr:block"];nwr["name"]["shop"];nwr["name"]["amenity"];nwr["name"]["office"];nwr["name"]["tourism"];nwr["name"]["place"];nwr["name"]["craft"];nwr["name"]["healthcare"];nwr["name"]["leisure"];);
out center qt;`;
const Q_STREETS = `[out:json][timeout:300][bbox:${BB}];
way["highway"]["name"]["highway"!~"^(platform|bus_stop|proposed|construction|elevator)$"];
out tags geom qt;`;

async function overpass(query, onBytes) {
  let lastErr;
  for (const url of CFG.overpass) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!res.body || !res.body.getReader) return await res.text();
        const reader = res.body.getReader(), dec = new TextDecoder(); let out = '', n = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; out += dec.decode(value, { stream: true }); onBytes && onBytes(n); }
        out += dec.decode();
        if (/runtime error|rate_limited|Too Many Requests/i.test(out.slice(0, 2000)) && out.length < 5000) throw new Error('Overpass зает');
        return out;
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500)); }
    }
  }
  throw lastErr || new Error('Няма връзка');
}

const KIND_KEYS = ['shop','amenity','office','tourism','place','craft','healthcare','leisure'];
function parsePoints(csv) {
  const out = [];
  for (const line of csv.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    const lat = +f[0], lon = +f[1]; if (!lat || !lon) continue;
    let kind = '';
    for (let i = 0; i < KIND_KEYS.length; i++) if (f[9 + i]) { kind = KIND_KEYS[i] + ':' + f[9 + i]; break; }
    out.push([Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6, f[2] || '', f[3] || '', f[4] || '', f[5] || '', f[6] || '', f[7] || '', f[8] || '', kind]);
  }
  return out;
}
function parseStreets(json) {
  const j = JSON.parse(json), out = [];
  for (const el of j.elements || []) {
    if (!el.geometry || !el.tags || !el.tags.name) continue;
    const flat = [];
    for (const p of el.geometry) flat.push(Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5);
    out.push([el.tags.name, flat]);
  }
  return out;
}

async function downloadData(ui) {
  let a = 0, b = 0;
  const upd = () => ui && ui.progress((a + b) / 1048576);
  const [pcsv, sjson] = await Promise.all([
    overpass(Q_POINTS, n => { a = n; upd(); }),
    overpass(Q_STREETS, n => { b = n; upd(); }),
  ]);
  const points = parsePoints(pcsv), streets = parseStreets(sjson);
  const withHn = points.filter(p => p[4] || p[5]).length;
  if (withHn < 1000) throw new Error('Непълни данни (' + withHn + ' адреса) — опитайте пак');
  const data = { v: CFG.dataVersion, ts: Date.now(), points, streets };
  await idbSet('data', data);
  return data;
}

/* ───────────── търсене ───────────── */
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); rowMin = Math.min(rowMin, cur[j]); }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function tokScore(qt, tk, fuzzy) {
  let score = 0;
  for (const q of qt) {
    let best = -1;
    for (const t of tk) {
      if (t === q) { best = 3; break; }
      if (t.startsWith(q)) best = Math.max(best, 2);
      else if (fuzzy && q.length >= 4) {
        const max = q.length >= 7 ? 2 : 1;
        if (lev(q, t.slice(0, q.length), max) <= max || lev(q, t, max) <= max) best = Math.max(best, 1);
      }
    }
    if (best < 0) return -1;
    score += best;
  }
  if (qt.length && tk.length && tk[0].startsWith(qt[0])) score += 1;
  if (qt.length === tk.length) score += 1;
  return score;
}
function matchStreets(qt) {
  if (!qt.length) return [];
  for (const fuzzy of [false, true]) {
    const out = [];
    for (const s of DB.streets.values()) { const sc = tokScore(qt, s.toks, fuzzy); if (sc >= 0) out.push({ s, sc }); }
    if (out.length) {
      out.sort((x, y) => y.sc - x.sc || y.s.addrs.length - x.s.addrs.length || x.s.name.length - y.s.name.length);
      return out;
    }
  }
  return [];
}
function matchPois(qt, limit) {
  if (!qt.length) return [];
  for (const fuzzy of [false, true]) {
    const out = [];
    for (const p of DB.pois) { const sc = tokScore(qt, p.toks, fuzzy); if (sc >= 0) out.push({ p, sc: sc + (p.kind.startsWith('place:') ? 2 : 0) }); }
    if (out.length) { out.sort((x, y) => y.sc - x.sc || x.p.name.length - y.p.name.length); return out.slice(0, limit); }
  }
  return [];
}
function streetLabel(s) {
  const c = [...s.cities].filter(c => !/^варна$/i.test(c));
  return c.length ? c.join(', ') : '';
}
function approxFor(s, num) {
  const q = intOf(num); if (isNaN(q)) return null;
  const list = [];
  for (const a of s.addrs) for (const k of a.keys) { const n = intOf(k); if (!isNaN(n) && /^\d/.test(k)) list.push({ a, n }); }
  if (!list.length) return null;
  const same = list.filter(x => x.n % 2 === q % 2), L = same.length ? same : list;
  let lo = null, hi = null;
  for (const x of L) { if (x.n < q && (!lo || x.n > lo.n)) lo = x; if (x.n > q && (!hi || x.n < hi.n)) hi = x; }
  if (lo && hi && hi.n - lo.n <= 40) {
    const t = (q - lo.n) / (hi.n - lo.n);
    return { lat: lo.a.lat + t * (hi.a.lat - lo.a.lat), lon: lo.a.lon + t * (hi.a.lon - lo.a.lon), note: `между № ${lo.n} и № ${hi.n}` };
  }
  const near = [lo, hi].filter(Boolean).sort((x, y) => Math.abs(x.n - q) - Math.abs(y.n - q))[0];
  return near && Math.abs(near.n - q) <= 10 ? { lat: near.a.lat, lon: near.a.lon, note: `най-близкият № в базата е ${near.a.hn}` } : null;
}

function searchMine(P) {
  const out = [];
  if (!P.qt.length && !P.num) return out;
  for (const m of store.get('vk_my', [])) {
    const M = parseQuery(m.title);
    if (P.qt.length && tokScore(P.qt, M.qt, false) < 0) continue;
    if (P.num && !M.keys.some(k => P.keys.includes(k))) continue;
    if (!P.qt.length && !P.num) continue;
    out.push({ type: 'mine', title: m.title, sub: '📌 мой запазен адрес', lat: m.lat, lon: m.lon });
  }
  return out;
}
function searchLocal(raw) {
  const P = parseQuery(raw), res = searchMine(P);
  if (!DB.ready || (!P.qt.length && !P.num)) return { P, res };
  let streets = matchStreets(P.qt);
  // поставен цял адрес „ж.к. X, ул. Y 5“ → опитай всеки сегмент поотделно
  if (!streets.length && P.segs.length > 1) {
    for (const seg of P.segs.slice().reverse()) {
      const t = toks(seg.replace(/[№#]?\d+[a-zа-я]?\s*$/, '')); if (!t.length) continue;
      streets = matchStreets(t); if (streets.length) break;
    }
  }
  if (P.num) {
    const seen = new Set();
    for (const { s } of streets.slice(0, 12)) {
      const hits = s.addrs.filter(a => a.keys.some(k => P.keys.includes(k)));
      hits.sort((x, y) => P.keys.indexOf(x.keys.find(k => P.keys.includes(k))) - P.keys.indexOf(y.keys.find(k => P.keys.includes(k))));
      for (const a of hits) {
        const id = a.lat.toFixed(5) + a.lon.toFixed(5) + a.hn; if (seen.has(id)) continue; seen.add(id);
        res.push({ type: 'addr', title: `${s.name} ${a.hn}`, sub: [a.name, a.place && pretty(a.place), a.city && !/^варна$/i.test(a.city) ? a.city : '', a.pc].filter(Boolean).join(' · '), lat: a.lat, lon: a.lon });
      }
    }
    if (!res.length) {
      for (const { s } of streets.slice(0, 3)) {
        const ap = P.isBlock ? null : approxFor(s, P.num);
        if (ap) res.push({ type: 'approx', title: `${s.name} ${P.num}`, sub: `≈ приблизително — ${ap.note}`, lat: ap.lat, lon: ap.lon, warn: `№ ${P.num} го няма като точна точка в базата. Позицията е изчислена ${ap.note}. Проверете на място или с „Google“.` });
        else if (s.c) res.push({ type: 'street', title: s.name, sub: `№ ${P.num} не е в базата — показана е улицата`, s, lat: s.c[0], lon: s.c[1], warn: `№ ${P.num} го няма в базата за ${s.name}.` });
      }
    }
  } else {
    for (const { s } of streets.slice(0, 12)) {
      if (!s.c) continue;
      const n = s.addrs.length;
      res.push({ type: 'street', title: s.name, sub: [streetLabel(s), n ? n + ' адреса' : 'улица'].filter(Boolean).join(' · '), s, lat: s.c[0], lon: s.c[1] });
    }
  }
  const pq = P.num && !res.length ? toks(raw) : P.qt;
  for (const { p } of matchPois(pq, P.num ? 5 : 10)) {
    res.push({ type: 'poi', title: p.name, sub: [kindLabel(p.kind), p.addr].filter(Boolean).join(' · '), lat: p.lat, lon: p.lon });
  }
  return { P, res };
}

const KIND = {
  'place:suburb':'Квартал','place:neighbourhood':'Квартал','place:quarter':'Квартал','place:village':'Село','place:hamlet':'Махала','place:town':'Град','place:city':'Град','place:locality':'Местност','place:square':'Площад',
  'amenity:pharmacy':'Аптека','amenity:hospital':'Болница','amenity:clinic':'Клиника','amenity:doctors':'Лекар','amenity:dentist':'Зъболекар','amenity:school':'Училище','amenity:kindergarten':'Детска градина',
  'amenity:university':'Университет','amenity:college':'Колеж','amenity:restaurant':'Ресторант','amenity:cafe':'Кафе','amenity:fast_food':'Бързо хранене','amenity:bar':'Бар','amenity:pub':'Пъб','amenity:bank':'Банка','amenity:atm':'Банкомат',
  'amenity:fuel':'Бензиностанция','amenity:parking':'Паркинг','amenity:post_office':'Поща','amenity:police':'Полиция','amenity:townhall':'Община','amenity:place_of_worship':'Храм','amenity:theatre':'Театър','amenity:cinema':'Кино',
  'shop:supermarket':'Супермаркет','shop:convenience':'Магазин','shop:bakery':'Пекарна','shop:mall':'Мол','tourism:hotel':'Хотел','tourism:museum':'Музей','tourism:guest_house':'Къща за гости','leisure:park':'Парк','leisure:sports_centre':'Спортен център',
};
function kindLabel(k) { if (KIND[k]) return KIND[k]; const g = k.split(':')[0]; return { shop: 'Магазин', amenity: 'Обект', office: 'Офис', tourism: 'Туризъм', place: 'Място', craft: 'Сервиз', healthcare: 'Здраве', leisure: 'Отдих' }[g] || ''; }

/* Google резервно търсене (с ключ на потребителя) */
let gLoad = null;
function loadGoogle(key) {
  if (window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
  if (gLoad) return gLoad;
  window.gm_authFailure = () => { store.set('vk_gerr', 'Ключът е отказан от Google (проверете ключа, Geocoding API и ограниченията за сайта).'); toast('Google ключът не работи — вижте менюто'); };
  gLoad = new Promise((res, rej) => {
    window.__gcb = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=bg&region=BG&loading=async&callback=__gcb`;
    s.onerror = () => { gLoad = null; rej(new Error('Google не се зареди')); };
    document.head.appendChild(s);
  });
  return gLoad;
}
async function searchGoogle(raw, P) {
  const key = store.get('vk_gkey', '');
  if (!key || !navigator.onLine) return [];
  const ck = skel(raw), cache = store.get('vk_gcache', {});
  if (cache[ck]) return cache[ck];
  await loadGoogle(key);
  const { Geocoder } = await google.maps.importLibrary('geocoding');
  const [s, w, n, e] = CFG.bbox;
  const q = /варна|varna/i.test(raw) ? raw : raw + ', Варна';
  const r = await new Geocoder().geocode({ address: q, bounds: { south: s, west: w, north: n, east: e }, region: 'bg', language: 'bg' });
  const want = P && P.num ? skel(P.num).replace(/ /g, '') : null;
  const out = [];
  for (const x of (r.results || []).slice(0, 5)) {
    const lat = x.geometry.location.lat(), lon = x.geometry.location.lng();
    if (lat < s || lat > n || lon < w || lon > e) continue;
    const comp = t => (x.address_components.find(c => c.types.includes(t)) || {}).long_name;
    const sn = comp('street_number'), route = comp('route') || comp('premise') || comp('sublocality');
    const numOk = !want || (sn && skel(sn).replace(/ /g, '') === want);
    const exact = x.geometry.location_type === 'ROOFTOP' && !!sn && numOk;
    out.push({
      type: exact ? 'google' : 'approx', src: 'google',
      title: route ? pretty(route) + (sn ? ' ' + sn : '') : x.formatted_address.split(',')[0],
      sub: 'Google · ' + x.formatted_address, lat, lon,
      warn: exact ? '' : (sn && !numOk ? `Google намери № ${sn}, не № ${P.num}. ` : '') + 'Google няма точна точка за този номер — позицията е приблизителна. Преместете пина и натиснете 📌, когато намерите адреса.',
    });
  }
  const keys = Object.keys(cache); if (keys.length > 400) delete cache[keys[0]];
  cache[ck] = out; store.set('vk_gcache', cache); store.set('vk_gerr', '');
  return out;
}

/* онлайн търсене (резервно) */
async function searchOnline(raw) {
  const [s, w, n, e] = CFG.bbox, out = [];
  const nom = fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=bg&accept-language=bg&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(raw)}`)
    .then(r => r.json()).then(j => j.forEach(x => out.push({ type: 'online', title: x.name || x.display_name.split(',').slice(0, 2).join(','), sub: 'онлайн · ' + x.display_name.split(',').slice(1, 4).join(','), lat: +x.lat, lon: +x.lon, warn: 'Резултат от онлайн търсене (Nominatim) — проверете номера.' }))).catch(() => {});
  const pho = fetch(`https://photon.komoot.io/api/?limit=8&lat=${CFG.center[0]}&lon=${CFG.center[1]}&bbox=${w},${s},${e},${n}&q=${encodeURIComponent(raw)}`)
    .then(r => r.json()).then(j => (j.features || []).forEach(f => { const p = f.properties; out.push({ type: 'online', title: [p.street || p.name, p.housenumber].filter(Boolean).join(' ') || p.name, sub: 'онлайн · ' + [p.name !== p.street ? p.name : '', p.district, p.city].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], warn: 'Резултат от онлайн търсене (Photon) — проверете номера.' }); })).catch(() => {});
  await Promise.all([nom, pho]);
  const ded = [];
  for (const r of out) if (!ded.some(d => dist(d, r) < 25)) ded.push(r);
  return ded;
}

/* ───────────── карта ───────────── */
const map = L.map('map', { zoomControl: false, attributionControl: true, tap: false }).setView(store.get('vk_view', { c: CFG.center }).c, store.get('vk_view', { z: 13 }).z || 13);
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: 'anonymous', attribution: '© OpenStreetMap' });
const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, crossOrigin: 'anonymous', attribution: 'Esri' });
let satOn = store.get('vk_sat', false), night = store.get('vk_night', false);
function applyLayers() {
  if (satOn) { map.removeLayer(osm); sat.addTo(map); } else { map.removeLayer(sat); osm.addTo(map); }
  document.body.classList.toggle('osm', !satOn);
  document.body.classList.toggle('night', night);
  $('#layerBtn').classList.toggle('on', satOn); $('#nightBtn').classList.toggle('on', night);
  document.querySelector('meta[name=theme-color]').content = night ? '#111827' : '#ffffff';
}
applyLayers();
map.attributionControl.setPrefix(false);
map.on('moveend', () => store.set('vk_view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }));

const pinIcon = color => L.divIcon({ className: 'pin', iconSize: [30, 42], iconAnchor: [15, 41], html: `<svg viewBox="0 0 30 42"><path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" fill="${color}"/><circle cx="15" cy="15" r="6" fill="#fff"/></svg>` });
let selLayer = L.layerGroup().addTo(map), current = null;

/* ───────────── моето местоположение ───────────── */
let me = null, meMarker = null, meCircle = null, watchId = null, follow = false;
function startLoc(center) {
  if (!navigator.geolocation) return toast('Няма GPS в този браузър');
  follow = center;
  if (watchId != null) { if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 17)); return; }
  $('#locBtn').classList.add('on');
  watchId = navigator.geolocation.watchPosition(p => {
    me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    if (!meMarker) {
      meMarker = L.marker([me.lat, me.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle([me.lat, me.lon], { radius: me.acc, color: '#2563eb', weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng([me.lat, me.lon]); meCircle.setLatLng([me.lat, me.lon]).setRadius(me.acc); }
    if (follow) { map.setView([me.lat, me.lon], Math.max(map.getZoom(), 17)); follow = false; }
  }, err => { toast(err.code === 1 ? 'Разрешете достъп до местоположението' : 'GPS не е наличен'); $('#locBtn').classList.remove('on'); watchId = null; }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function dist(a, b) {
  const R = 6371000, toR = Math.PI / 180, dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtD = m => m < 1000 ? Math.round(m / 10) * 10 + ' м' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' км';

/* ───────────── UI: резултати ───────────── */
const ICON = { addr: '№', approx: '≈', street: 'ул', poi: '●', online: '🌐', google: 'G', mine: '📌' };
let lastResults = [];
function rowHtml(r, i) {
  const d = me ? `<div class="d">${fmtD(dist(me, r))}</div>` : '';
  return `<div class="r" data-i="${i}"><div class="ic ${r.type}">${ICON[r.type] || '●'}</div><div class="tx"><div class="t1">${esc(r.title)}</div><div class="t2">${esc(r.sub || '')}</div></div>${d}</div>`;
}
function gmapsSearch(q) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q + ', Варна')}`; }
function renderResults(list, raw, opts = {}) {
  lastResults = list;
  const box = $('#results');
  let h = '';
  if (opts.note) h += `<div class="rnote">${opts.note}</div>`;
  h += list.map(rowHtml).join('');
  if (raw) {
    h += `<div class="rbtns">${opts.noOnline ? '' : `<button class="btn sm" id="onlineBtn">🌐 Търси онлайн</button>`}<a class="btn sm" target="_blank" rel="noopener" href="${gmapsSearch(raw)}">Провери в Google</a></div>`;
  }
  box.innerHTML = h; box.hidden = !h; box.scrollTop = 0;
  const ob = $('#onlineBtn'); if (ob) ob.onclick = () => doOnline(raw);
}
function renderHome() {
  const favs = store.get('vk_favs', []), hist = store.get('vk_hist', []);
  const list = [...favs.map(f => ({ ...f, type: f.type || 'addr', fav: 1 })), ...hist.filter(h => !favs.some(f => f.title === h.title))];
  if (!list.length) { $('#results').hidden = true; return; }
  lastResults = list;
  let h = '';
  if (favs.length) h += `<div class="rh">★ Любими</div>` + list.slice(0, favs.length).map((r, i) => rowHtml(r, i)).join('');
  if (list.length > favs.length) h += `<div class="rh">Последни</div>` + list.slice(favs.length).map((r, i) => rowHtml(r, i + favs.length)).join('');
  $('#results').innerHTML = h; $('#results').hidden = false;
}
let tmr;
function onInput() {
  const raw = $('#q').value.trim();
  $('#clearBtn').hidden = !raw;
  clearTimeout(tmr);
  if (!raw) return renderHome();
  tmr = setTimeout(() => runSearch(raw), 60);
}
let gTmr, gSeq = 0;
function runSearch(raw, now) {
  const t0 = performance.now();
  const { P, res } = searchLocal(raw);
  window.__lastSearchMs = performance.now() - t0;
  const exact = res.some(r => r.type === 'addr' || r.type === 'mine');
  const useG = !exact && store.get('vk_gkey', '') && navigator.onLine && (P.num || (!res.length && P.qt.length));
  let note = '';
  if (!DB.ready) note = 'Локалната база не е заредена.';
  else if (!res.length && (P.qt.length || P.num)) note = `Няма резултат в локалната база за „<b>${esc(raw)}</b>“.`;
  if (useG) note = (note ? note + ' ' : '') + 'Търся в Google…';
  renderResults(res.slice(0, 40), raw, { note });
  clearTimeout(gTmr);
  if (!useG) return;
  const seq = ++gSeq;
  gTmr = setTimeout(async () => {
    let g = [];
    try { g = await searchGoogle(raw, P); } catch (e) { if (seq === gSeq) toast('Google: ' + (e.message || 'грешка')); }
    if (seq !== gSeq || $('#q').value.trim() !== raw) return;
    if (!now && $('#results').hidden) return;
    renderResults([...g, ...res].slice(0, 40), raw, { note: g.length ? '' : (note.replace('Търся в Google…', '') + ' Google също не намери адреса.').trim() });
    if (now && g[0] && g[0].type === 'google') select(g[0]);
  }, now ? 0 : 700);
}
async function doOnline(raw) {
  if (!navigator.onLine) return toast('Няма интернет');
  $('#results').insertAdjacentHTML('afterbegin', '<div class="rnote" id="onl">Търся онлайн…</div>');
  const on = await searchOnline(raw);
  const local = lastResults.filter(r => r.type !== 'online');
  renderResults([...on, ...local], raw, { note: on.length ? '' : 'Онлайн също няма резултат. Пробвайте „Провери в Google“.', noOnline: true });
}
$('#results').addEventListener('click', e => {
  const row = e.target.closest('.r'); if (!row) return;
  select(lastResults[+row.dataset.i]);
});

/* ───────────── UI: избран адрес ───────────── */
function select(r, opt = {}) {
  if (!r) return;
  current = r;
  selLayer.clearLayers();
  $('#results').hidden = true; $('#q').blur();
  const color = r.type === 'approx' ? '#d97706' : r.type === 'online' ? '#a21caf' : r.type === 'mine' ? '#ea580c' : '#dc2626';
  const movable = !['addr', 'google', 'mine'].includes(r.type);
  if (r.type === 'street' && r.s && r.s.geoms.length) {
    const pl = L.polyline(r.s.geoms, { color: '#2563eb', weight: 7, opacity: .75 }).addTo(selLayer);
    map.fitBounds(pl.getBounds(), { padding: [40, 40], maxZoom: 17 });
  } else if (r.type === 'street' && r.s) {
    const b = L.latLngBounds(r.s.addrs.map(a => [a.lat, a.lon]));
    r.s.addrs.forEach(a => L.circleMarker([a.lat, a.lon], { radius: 4, color: '#2563eb' }).addTo(selLayer));
    map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
  } else {
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 18), { animate: !opt.noAnim });
  }
  const mk = L.marker([r.lat, r.lon], { icon: pinIcon(color), draggable: movable, autoPan: true }).addTo(selLayer);
  mk.on('dragend', () => { const ll = mk.getLatLng(); current = { ...current, lat: ll.lat, lon: ll.lng, moved: true }; setNav(current); const c = $('#coords'); if (c) c.textContent = ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + ' (преместен)'; });
  if (r.type === 'approx') L.circle([r.lat, r.lon], { radius: 35, color: '#d97706', weight: 1, fillOpacity: .12 }).addTo(selLayer);

  const badge = r.type === 'addr' ? '<span class="badge b-ok">точен адрес</span>' : r.type === 'google' ? '<span class="badge b-g">Google · точен</span>' : r.type === 'mine' ? '<span class="badge b-mine">мой адрес</span>' : r.type === 'approx' ? '<span class="badge b-warn">приблизително</span>' : r.type === 'online' ? '<span class="badge b-on">онлайн</span>' : '';
  const dd = me ? ' · ' + fmtD(dist(me, r)) + ' от вас' : '';
  $('#cardBody').innerHTML = `<div class="ct">${esc(r.title)} ${badge}</div><div class="cs">${esc(r.sub || '')}${dd}</div>` +
    `<div class="cs" id="coords">${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}</div>` + (r.warn ? `<div class="cw">${esc(r.warn)}</div>` : '') +
    (movable ? `<div class="hint">Задръжте и плъзнете пина до точното място → 📌 запазва адреса завинаги. <a href="${gmapsSearch(r.title)}" target="_blank" rel="noopener">Виж в Google Maps</a></div>` : '');
  setNav(r);
  const favs = store.get('vk_favs', []);
  $('#favBtn').classList.toggle('on', favs.some(f => f.title === r.title));
  $('#favBtn').textContent = favs.some(f => f.title === r.title) ? '★' : '☆';
  $('#card').hidden = false; document.body.classList.add('card-open');
  document.body.style.setProperty('--cardh', $('#card').offsetHeight + 'px');
  if (!opt.noHist && r.type !== 'online') {
    const h = store.get('vk_hist', []).filter(x => x.title !== r.title);
    h.unshift(slim(r)); store.set('vk_hist', h.slice(0, 12));
  }
}
function setNav(r) {
  $('#navG').href = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}&travelmode=driving`;
  $('#navW').href = `https://waze.com/ul?ll=${r.lat},${r.lon}&navigate=yes`;
}
const slim = r => ({ type: r.type === 'street' ? 'approx' : r.type, title: r.title, sub: r.sub, lat: r.lat, lon: r.lon, warn: r.warn });
function closeCard() { $('#card').hidden = true; document.body.classList.remove('card-open'); selLayer.clearLayers(); current = null; }
$('#closeCard').onclick = closeCard;
$('#copyBtn').onclick = async () => {
  if (!current) return;
  const txt = `${current.title}, Варна\nhttps://www.google.com/maps/search/?api=1&query=${current.lat},${current.lon}`;
  try { await navigator.clipboard.writeText(txt); toast('Копирано'); }
  catch { if (navigator.share) navigator.share({ text: txt }).catch(() => {}); }
};
$('#saveBtn').onclick = () => {
  if (!current) return;
  let pos = { lat: current.lat, lon: current.lon };
  if (me && dist(me, current) > 25 && me.acc < 40 && confirm('На адреса ли сте в момента?\n\nOK = запази текущата ви GPS позиция\nОтказ = запази позицията на пина')) pos = { lat: me.lat, lon: me.lon };
  const def = current.type === 'street' && $('#q').value.trim() ? $('#q').value.trim() : current.title;
  const title = (prompt('Как да се казва адресът? (както ще го търсите, напр. „ул. Цар Симеон I 12“ или „Младост бл. 112“)', def) || '').trim();
  if (!title) return;
  const my = store.get('vk_my', []).filter(m => m.title !== title);
  my.unshift({ title, lat: pos.lat, lon: pos.lon, ts: Date.now() });
  store.set('vk_my', my);
  toast('📌 Запазен: ' + title);
  select({ type: 'mine', title, sub: '📌 мой запазен адрес', lat: pos.lat, lon: pos.lon }, { noAnim: true });
};
$('#favBtn').onclick = () => {
  if (!current) return;
  let favs = store.get('vk_favs', []);
  if (favs.some(f => f.title === current.title)) { favs = favs.filter(f => f.title !== current.title); toast('Премахнат от любими'); }
  else { favs.unshift(slim(current)); toast('Добавен в любими'); }
  store.set('vk_favs', favs); select(current, { noHist: true, noAnim: true });
};

/* ───────────── задържане върху картата → най-близък адрес ───────────── */
function nearestAddr(ll) {
  let best = null, bd = Infinity;
  const p = { lat: ll.lat, lon: ll.lng };
  for (const a of DB.addrs) {
    if (Math.abs(a.lat - p.lat) > .002 || Math.abs(a.lon - p.lon) > .003) continue;
    const d = dist(p, a); if (d < bd) { bd = d; best = a; }
  }
  return best ? { a: best, d: bd } : null;
}
function reverseAt(ll) {
  const n = DB.ready ? nearestAddr(ll) : null;
  if (n && n.d < 80) {
    select({ type: 'addr', title: `${n.a.s.name} ${n.a.hn}`, sub: `най-близък адрес · ${Math.round(n.d)} м от точката`, lat: n.a.lat, lon: n.a.lon });
  } else {
    select({ type: 'approx', title: 'Избрана точка', sub: 'няма адрес в базата до 80 м', lat: ll.lat, lon: ll.lng });
  }
}
(() => {
  const el = map.getContainer(); let t = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return cancel();
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    t = setTimeout(() => { t = null; const r = el.getBoundingClientRect(); reverseAt(map.containerPointToLatLng([sx - r.left, sy - r.top])); if (navigator.vibrate) navigator.vibrate(20); }, 550);
  }, { passive: true });
  el.addEventListener('touchmove', e => { if (t && Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10) cancel(); }, { passive: true });
  el.addEventListener('touchend', cancel); el.addEventListener('touchcancel', cancel);
  map.on('contextmenu', e => { if (!('ontouchstart' in window)) reverseAt(e.latlng); });
})();

/* ───────────── панел, бутони ───────────── */
function renderMy() {
  const my = store.get('vk_my', []);
  $('#myList').innerHTML = my.length ? my.map((m, i) => `<div class="r" data-m="${i}"><div class="ic mine">📌</div><div class="tx"><div class="t1">${esc(m.title)}</div><div class="t2">${new Date(m.ts || 0).toLocaleDateString('bg')}</div></div><button class="del" data-del="${i}" aria-label="Изтрий">×</button></div>`).join('') : '<p class="small">Още няма.</p>';
  const k = store.get('vk_gkey', ''), err = store.get('vk_gerr', '');
  $('#gkey').value = k;
  $('#gstat').textContent = !k ? 'Не е настроено.' : err ? '⚠ ' + err : '✓ Включено.';
}
$('#myList').addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if (d) { const my = store.get('vk_my', []); const m = my[+d.dataset.del]; if (m && confirm('Изтрий „' + m.title + '“?')) { my.splice(+d.dataset.del, 1); store.set('vk_my', my); renderMy(); } return; }
  const r = e.target.closest('[data-m]'); if (!r) return;
  const m = store.get('vk_my', [])[+r.dataset.m]; $('#panel').hidden = true;
  select({ type: 'mine', title: m.title, sub: '📌 мой запазен адрес', lat: m.lat, lon: m.lon }, { noHist: true });
});
$('#gsave').onclick = () => { store.set('vk_gkey', $('#gkey').value.trim()); store.set('vk_gerr', ''); store.set('vk_gcache', {}); gLoad = null; renderMy(); toast($('#gkey').value.trim() ? 'Google ключът е запазен' : 'Google е изключен'); };
function dbInfo() {
  renderMy();
  if (!DB.ready) return $('#dbInfo').innerHTML = 'Локалната база <b>не е изтеглена</b>.';
  const d = new Date(DB.ts), age = Math.floor((Date.now() - DB.ts) / 864e5);
  $('#dbInfo').innerHTML = `<b>${DB.addrs.length.toLocaleString('bg')}</b> адреса · <b>${DB.streets.size.toLocaleString('bg')}</b> улици/комплекси · <b>${DB.pois.length.toLocaleString('bg')}</b> обекта<br>Обновено: ${d.toLocaleDateString('bg')} ${d.toLocaleTimeString('bg', { hour: '2-digit', minute: '2-digit' })} (${age ? 'преди ' + age + ' дни' : 'днес'})`;
  const favs = store.get('vk_favs', []);
  $('#favList').innerHTML = favs.length ? favs.map((f, i) => `<div class="r" data-f="${i}"><div class="ic addr">★</div><div class="tx"><div class="t1">${esc(f.title)}</div><div class="t2">${esc(f.sub || '')}</div></div></div>`).join('') : '<p class="small">Няма. Натиснете ☆ на адрес.</p>';
}
$('#favList').addEventListener('click', e => { const r = e.target.closest('.r'); if (!r) return; $('#panel').hidden = true; select(store.get('vk_favs', [])[+r.dataset.f], { noHist: true }); });
$('#menuBtn').onclick = () => { dbInfo(); $('#panel').hidden = false; };
$('#closePanel').onclick = () => $('#panel').hidden = true;
$('#panel').addEventListener('click', e => { if (e.target.id === 'panel') $('#panel').hidden = true; });
$('#updateBtn').onclick = () => { $('#panel').hidden = true; load(true); };
$('#layerBtn').onclick = () => { satOn = !satOn; store.set('vk_sat', satOn); applyLayers(); };
$('#nightBtn').onclick = () => { night = !night; store.set('vk_night', night); applyLayers(); };
$('#locBtn').onclick = () => startLoc(true);
$('#q').addEventListener('input', onInput);
$('#q').addEventListener('focus', () => { if (!$('#q').value.trim()) renderHome(); else onInput(); });
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const raw = $('#q').value.trim(); if (!raw) return;
    clearTimeout(tmr); runSearch(raw, true);
    if (lastResults.length && ['addr', 'approx'].includes(lastResults[0].type) && lastResults.filter(r => r.type === 'addr').length <= 1) select(lastResults[0]);
    else if (!lastResults.length && navigator.onLine) doOnline(raw);
  }
});
$('#clearBtn').onclick = () => { $('#q').value = ''; $('#clearBtn').hidden = true; closeCard(); $('#q').focus(); renderHome(); };
map.on('click', () => { $('#results').hidden = true; $('#q').blur(); });

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2200); }

/* ───────────── зареждане ───────────── */
async function load(force) {
  let data = null;
  if (!force) { try { data = await idbGet('data'); } catch {} }
  if (data && data.v === CFG.dataVersion) {
    buildIndex(data);
    if (Date.now() - data.ts > CFG.maxAgeDays * 864e5 && navigator.onLine) {
      downloadData(null).then(d => { buildIndex(d); toast('Адресите са обновени ✓'); }).catch(() => {});
    }
    return;
  }
  const L$ = $('#loader'); L$.hidden = false;
  $('#lretry').hidden = $('#lskip').hidden = true;
  $('#lmsg').textContent = 'Еднократно, ~5–10 MB. След това търсенето работи и без интернет.';
  $('.bar').classList.add('ind'); $('#lbar').style.width = '';
  try {
    const d = await downloadData({ progress: mb => $('#lsub').textContent = `Изтеглени ${mb.toFixed(1)} MB…` });
    $('#lsub').textContent = 'Индексиране…';
    buildIndex(d);
    L$.hidden = true;
    toast(`Готово: ${DB.addrs.length.toLocaleString('bg')} адреса`);
  } catch (e) {
    $('.bar').classList.remove('ind');
    $('#lmsg').textContent = 'Изтеглянето не успя: ' + (e.message || e);
    $('#lsub').textContent = DB.ready ? 'Старата база остава активна.' : 'Сървърът за данни може да е претоварен — опитайте след минута.';
    $('#lretry').hidden = false; $('#lskip').hidden = false;
  }
}
$('#lretry').onclick = () => load(true);
$('#lskip').onclick = () => $('#loader').hidden = true;

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
load(false);
window.__va = { DB, searchLocal, searchGoogle, parseQuery, buildIndex, parsePoints, parseStreets, select };
