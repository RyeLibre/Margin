import * as pdfjsLib from './lib/pdfjs/pdf.mjs';
import { openEpub, htmlToText } from './epub.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdfjs/pdf.worker.mjs';

const $ = (id) => document.getElementById(id);
// Running inside Margin.exe (the Windows app)? It shows this page in WebView2 and adds taskbar
// buttons, an always-on-top mini window and offline storage of its own.
const IN_APP = !!(window.chrome && chrome.webview && chrome.webview.hostObjects);
const HOST = IN_APP ? chrome.webview.hostObjects.margin : null;
// the Android app (android-shim.js stands in for the Windows bridge): no mini window, the phone's voice first
const ANDROID = document.documentElement.classList.contains('android');
// host calls return proxy promises: .catch() would be sent to Margin.exe, so use try/await
const hostCall = async (fn) => { try { await fn(HOST); } catch {} };
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const COLORS = { yellow: 'var(--hl-yellow)', green: 'var(--hl-green)', blue: 'var(--hl-blue)', pink: 'var(--hl-pink)' };
const store = {
  get(k, d) { try { const v = localStorage.getItem('margin.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('margin.' + k, JSON.stringify(v)); } catch {} },
};
function toastAction(msg, label, fn, ms = 12000) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = el('div', 'toast act', msg); const b = el('button', 'btn', label); b.onclick = () => { t.remove(); fn(); };
  const x = el('button', 'btn', '✕'); x.title = 'Dismiss'; x.onclick = () => t.remove();
  t.append(b, x); document.body.append(t); setTimeout(() => t.remove(), ms);
}
function toast(msg, ms = 2600) { document.querySelectorAll('.toast').forEach((x) => x.remove()); const t = el('div', 'toast', msg); document.body.append(t); setTimeout(() => t.remove(), ms); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------- IndexedDB ---------------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('margin-reader', 2);
  r.onupgradeneeded = () => {
    const d = r.result; const has = (n) => d.objectStoreNames.contains(n);
    if (!has('books')) d.createObjectStore('books', { keyPath: 'id' });
    if (!has('files')) d.createObjectStore('files');
    if (!has('highlights')) d.createObjectStore('highlights', { keyPath: 'id' }).createIndex('book', 'bookId');
    if (!has('words')) d.createObjectStore('words', { keyPath: 'id' });
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function idb(storeName, mode, fn) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction(storeName, mode); const s = t.objectStore(storeName);
    const req = fn(s); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  });
}
const DB = {
  books: () => idb('books', 'readonly', (s) => s.getAll()),
  putBook: (b) => idb('books', 'readwrite', (s) => s.put(b)),
  getBook: (id) => idb('books', 'readonly', (s) => s.get(id)),
  putFile: (id, blob) => idb('files', 'readwrite', (s) => s.put(blob, id)),
  getFile: (id) => idb('files', 'readonly', (s) => s.get(id)),
  hls: (bookId) => idb('highlights', 'readonly', (s) => s.index('book').getAll(bookId)),
  putHl: (h) => idb('highlights', 'readwrite', (s) => s.put(h)),
  delHl: (id) => idb('highlights', 'readwrite', (s) => s.delete(id)),
  delBook: (id) => idb('books', 'readwrite', (s) => s.delete(id)),
  delFile: (id) => idb('files', 'readwrite', (s) => s.delete(id)),
  words: () => idb('words', 'readonly', (s) => s.getAll()),
  putWord: (w) => idb('words', 'readwrite', (s) => s.put(w)),
  delWord: (id) => idb('words', 'readwrite', (s) => s.delete(id)),
  allHls: () => idb('highlights', 'readonly', (s) => s.getAll()),
};

/* ---------------- State ---------------- */
const S = { kind: 'pdf', count: 0, fs: store.get('epubFs', 19), epub: null, secTitles: null, doc: null, book: null, pages: [], scale: 1, fit: true, labels: null, hls: [], current: 1, texts: new Map(), renderToken: 0 };
const viewer = $('viewer'), pagesEl = $('pages');
const label = (n) => (S.labels && S.labels[n - 1]) || String(n);
const isEpub = () => S.kind === 'epub';
// how a place in the book is named in notes, words and the status line
const unitLabel = (n) => isEpub() ? (S.secTitles?.[n - 1] || `Section ${n}`) : 'p. ' + label(n);
const hlUnit = (h) => (h.rects ? h.rects[0].page : h.sec);
const hlUnits = (h) => new Set(h.rects ? h.rects.map((r) => r.page) : [h.sec]);
const hasCssHL = () => !!(window.CSS && CSS.highlights && window.Highlight);

/* ---------------- Opening books ---------------- */
async function openFile(file) {
  const kind = /\.epub$/i.test(file?.name || '') || file?.type === 'application/epub+zip' ? 'epub' : /\.pdf$/i.test(file?.name || '') || file?.type === 'application/pdf' ? 'pdf' : null;
  if (!kind) { toast('Margin opens PDF and EPUB files.'); return; }
  const id = `${file.name}-${file.size}`;
  let book = await DB.getBook(id);
  if (!book) { book = { id, name: file.name.replace(/\.(pdf|epub)$/i, ''), size: file.size, added: Date.now(), lastPage: 1, kind }; }
  book.kind = kind;
  await DB.putFile(id, file);
  await DB.putBook(book);
  await loadBook(book, await file.arrayBuffer());
}
const bookUrl = (path) => `${location.origin}/book?p=${encodeURIComponent(path)}`;
async function bookData(b) {
  const blob = await DB.getFile(b.id); if (blob) return blob.arrayBuffer();
  if (b.path && IN_APP) { try { const r = await fetch(bookUrl(b.path)); if (r.ok) return await r.arrayBuffer(); } catch {} }
  return null;
}
async function openStored(id) {
  const book = await DB.getBook(id); const data = book && await bookData(book);
  if (!data) {
    toast(book?.path ? `Margin can't find this book's file any more. It was in ${book.path.split(/[\\/]/).slice(0, -1).join(book.path.includes('\\') ? '\\' : '/')}.` : 'That book is no longer stored here.', 6000);
    if (book?.path) { book.missing = true; DB.putBook(book); }
    return;
  }
  await loadBook(book, data);
}
async function loadBook(book, data) {
  ttsStop(); setView('book');
  if (S.doc) { S.doc.destroy(); S.doc = null; }
  if (S.epub) { S.epub.close(); S.epub = null; }
  if (hasCssHL()) CSS.highlights.clear();
  S.renderToken++; S.texts.clear(); S.pages = []; pagesEl.innerHTML = ''; pagesEl.hidden = false; io?.disconnect();
  const u8 = new Uint8Array(data, 0, 4);
  S.kind = book.kind === 'text' ? 'epub' : book.kind || (u8[0] === 0x50 && u8[1] === 0x4b ? 'epub' : 'pdf');
  pagesEl.classList.toggle('epub', S.kind === 'epub');
  if (book.kind === 'text') { await loadEpub(book, data, textEpub(book, new TextDecoder().decode(data))); return; }
  if (S.kind === 'epub') { await loadEpub(book, data); return; }
  S.secTitles = null; S.fit = true; S.scale = 1; $('bFit').classList.add('on');
  S.doc = await pdfjsLib.getDocument({ data, cMapUrl: './lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './lib/pdfjs/standard_fonts/' }).promise;
  S.book = book; store.set('lastBook', book.id);
  const meta = await S.doc.getMetadata().catch(() => null);
  const t = meta?.info?.Title?.trim();
  if (t && t.length > 3 && book.name === book.id.replace(/-\d+$/, '').replace(/\.pdf$/i, '')) { book.title = t; }
  const au = meta?.info?.Author?.trim(); if (au && !book.author) book.author = au;
  book.count = S.doc.numPages; DB.putBook(book);
  if (!book.cover) pdfCover(S.doc).then((c) => { if (c) { book.cover = c; DB.putBook(book); } });
  if (book.year === undefined) pdfYear(S.doc).then((y) => { book.year = y || null; DB.putBook(book); });
  $('title').textContent = book.title || book.name; document.title = (book.title || book.name) + ' · Margin';
  S.labels = await S.doc.getPageLabels().catch(() => null);
  $('welcome').hidden = true; $('pagebox').hidden = false;
  S.count = S.doc.numPages;
  $('pageOf').textContent = `of ${S.count}`;
  S.hls = (await DB.hls(book.id)).sort(hlOrder);
  await buildPages();
  buildToc(); renderNotes();
  sizeLabel(); restorePosition(book);
}
function restorePosition(book) {
  renderWords();
  book.opened = Date.now(); DB.putBook(book);
  if (T.engine === 'kokoro' && !T.ready && !T.loading) setTimeout(() => { if (!T.ready && !T.loading && T.engine === 'kokoro') ensureKokoro().catch(() => setStatus('Press Listen to read from where you are, or select text and choose “Read from here”.')); }, 2500);
  goTo(book.lastPage || 1, 'auto');
  const p = S.pages[(book.lastPage || 1) - 1];
  if (p && book.lastFrac > 0) viewer.scrollTop = p.div.offsetTop + book.lastFrac * p.div.offsetHeight;
}

/* ---------------- EPUB ---------------- */
async function loadEpub(book, data, given) {
  S.labels = null;
  const ep = given || await openEpub(data); S.epub = ep;
  if (!book.title && ep.title) { book.title = ep.title; }
  book.count = ep.spine.length; if (!book.author && ep.author) book.author = ep.author; DB.putBook(book);
  if (!book.cover) ep.cover().then(imageCover).then((c) => { if (c) { book.cover = c; DB.putBook(book); } }).catch(() => {});
  if (book.year === undefined) epubYear(ep).then((y) => { book.year = y || null; DB.putBook(book); }).catch(() => {});
  if (book.pages === undefined) ep.pages().then((pg) => { book.pages = pg.pages; book.pagesEstimated = pg.estimated; DB.putBook(book); }).catch(() => {});
  S.book = book; store.set('lastBook', book.id);
  $('title').textContent = book.title || book.name; document.title = (book.title || book.name) + ' · Margin';
  $('welcome').hidden = true; $('pagebox').hidden = false;
  applyFont();
  // section titles from the table of contents (sections without one inherit the previous title)
  const titles = new Array(ep.spine.length).fill(null);
  const walk = (items) => { for (const it of items) { const i = ep.spineIndex(it.path); if (i >= 0 && !titles[i] && it.title) titles[i] = it.title; walk(it.items || []); } };
  walk(ep.toc);
  for (let i = 1; i < titles.length; i++) if (!titles[i]) titles[i] = titles[i - 1];
  S.secTitles = titles;
  for (let i = 0; i < ep.spine.length; i++) {
    const sec = el('section', 'section'); sec.dataset.page = i + 1;
    try { sec.append(await ep.chapter(i)); } catch (err) { console.warn('chapter', i, err); sec.append(el('p', '', 'This part of the book could not be read.')); }
    pagesEl.append(sec); S.pages.push({ num: i + 1, div: sec, state: 2 });
  }
  // drop empty sections at the very start/end only if they have no text and no images
  S.count = S.pages.length;
  $('pageOf').textContent = `of ${S.count}`;
  S.hls = (await DB.hls(book.id)).sort(hlOrder);
  paintEpub(); buildToc(); renderNotes();
  sizeLabel(); restorePosition(book);
}
function applyFont() { pagesEl.style.setProperty('--fs', S.fs + 'px'); }
// text of one section as a string, with where each piece lives in the page
const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|H[1-6]|BLOCKQUOTE|LI|UL|OL|DL|DT|DD|FIGURE|FIGCAPTION|TABLE|TR|TD|TH|CAPTION|PRE|HR)$/;
function secModel(p) {
  if (p.model) return p.model;
  const segs = [], byNode = new Map(); let text = '', lastBlock = null;
  const tw = document.createTreeWalker(p.div, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const v = n.nodeValue; if (!v) continue;
    const pe = n.parentElement;
    if (pe.closest('sup, .noteref, rt, rp')) continue; // note numbers and reading aids are not read aloud
    let b = pe; while (b && b !== p.div && !BLOCK.test(b.tagName)) b = b.parentElement;
    if (b !== lastBlock && text && !text.endsWith('\n')) text += '\n';
    lastBlock = b;
    const seg = { node: n, start: text.length }; segs.push(seg); byNode.set(n, seg);
    text += v.replace(/[\n\r\t]/g, ' ');
  }
  return (p.model = { text, segs, byNode });
}
function nodeAt(m, pos) {
  let lo = 0, hi = m.segs.length - 1; if (hi < 0) return null;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m.segs[mid].start <= pos) lo = mid; else hi = mid - 1; }
  const s = m.segs[lo]; return { node: s.node, offset: Math.max(0, Math.min(s.node.length, pos - s.start)) };
}
function rangeFromPos(p, a, b) {
  const m = secModel(p); const x = nodeAt(m, a), y = nodeAt(m, b); if (!x || !y) return null;
  const r = document.createRange(); try { r.setStart(x.node, x.offset); r.setEnd(y.node, y.offset); } catch { return null; } return r;
}
function posOf(p, container, offset) {
  const m = secModel(p);
  if (container.nodeType === 3) { const s = m.byNode.get(container); if (s) return s.start + Math.min(offset, container.length); }
  const r = document.createRange(); try { r.setStart(container, offset); } catch { return 0; }
  for (const s of m.segs) if (r.comparePoint(s.node, 0) >= 0) return s.start;
  return m.text.length;
}
const sectionOf = (node) => { const d = (node.nodeType === 3 ? node.parentElement : node)?.closest?.('.section'); return d ? S.pages[+d.dataset.page - 1] : null; };
function epubSentences(n) {
  const p = S.pages[n - 1]; if (!p) return [];
  const m = secModel(p); const res = splitSentences(m.text, null);
  res.text = m.text; return res;
}
const HL_FILL = { yellow: 'rgb(255 217 74 / .55)', green: 'rgb(134 220 143 / .55)', blue: 'rgb(134 200 255 / .55)', pink: 'rgb(255 159 202 / .55)' };
function paintEpub() {
  if (!hasCssHL() || !isEpub()) return;
  for (const c of Object.keys(COLORS)) {
    const ranges = S.hls.filter((h) => h.sec && h.color === c).map((h) => rangeFromPos(S.pages[h.sec - 1], h.start, h.end)).filter(Boolean);
    CSS.highlights.set('hl-' + c, new Highlight(...ranges));
  }
}
// the place in the text at the top of the reading area (where Listen starts)
function visibleStart() {
  const v = viewer.getBoundingClientRect(); const x = v.left + v.width / 2;
  for (let y = v.top + 30; y < v.top + v.height * 0.5; y += 18) {
    const cr = document.caretRangeFromPoint?.(x, y); if (!cr) continue;
    const p = sectionOf(cr.startContainer); if (p) return { page: p.num, char: posOf(p, cr.startContainer, cr.startOffset) };
  }
  return { page: S.current, char: 0 };
}

/* ---------------- Pages ---------------- */
let io;
async function buildPages() {
  const p1 = await S.doc.getPage(1); const vp = p1.getViewport({ scale: 1 });
  S.baseW = vp.width;
  computeFitScale();
  io?.disconnect();
  io = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: '120% 0px' });
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= S.doc.numPages; n++) {
    const div = el('div', 'page'); div.dataset.page = n;
    const num = el('span', 'num', label(n)); div.append(num);
    const p = { num: n, div, w: vp.width, h: vp.height, state: 0 };
    sizePage(p); S.pages.push(p); frag.append(div); io.observe(div);
  }
  pagesEl.append(frag);
}
function computeFitScale() {
  if (!S.fit || !S.baseW || isEpub()) return;
  const avail = viewer.clientWidth - 40;
  S.scale = Math.max(0.5, Math.min(2.2, avail / S.baseW));
}
function sizePage(p) { p.div.style.width = `${Math.floor(p.w * S.scale)}px`; p.div.style.height = `${Math.floor(p.h * S.scale)}px`; }
const visible = new Set();
function onIntersect(entries) {
  for (const e of entries) { const n = +e.target.dataset.page; if (e.isIntersecting) visible.add(n); else visible.delete(n); }
  pumpRender();
}
let rendering = false;
async function pumpRender() {
  if (rendering) return; rendering = true;
  try {
    while (true) {
      const todo = [...visible].map((n) => S.pages[n - 1]).filter((p) => p && p.state === 0).sort((a, b) => Math.abs(a.num - S.current) - Math.abs(b.num - S.current));
      if (!todo.length) break;
      await renderPage(todo[0]);
    }
    // free far-away pages
    const rendered = S.pages.filter((p) => p.state === 2);
    if (rendered.length > 14) rendered.filter((p) => !visible.has(p.num)).sort((a, b) => Math.abs(b.num - S.current) - Math.abs(a.num - S.current)).slice(0, rendered.length - 14).forEach(unrenderPage);
  } finally { rendering = false; }
}
async function getText(n) {
  if (!S.texts.has(n)) S.texts.set(n, S.doc.getPage(n).then(async (pg) => ({ tc: await pg.getTextContent(), view: pg.view })));
  return S.texts.get(n);
}
async function renderPage(p) {
  const token = S.renderToken; p.state = 1;
  try {
    const page = await S.doc.getPage(p.num);
    const vp1 = page.getViewport({ scale: 1 });
    if (Math.abs(vp1.width - p.w) > 0.5 || Math.abs(vp1.height - p.h) > 0.5) { p.w = vp1.width; p.h = vp1.height; sizePage(p); }
    const vp = page.getViewport({ scale: S.scale }); const dpr = window.devicePixelRatio || 1;
    const canvas = el('canvas'); canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (token !== S.renderToken) return;
    const { tc } = await getText(p.num);
    const tl = el('div', 'textLayer');
    p.div.style.setProperty('--scale-factor', vp.scale);
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: tc, container: tl, viewport: vp });
    await textLayer.render();
    tl.append(el('div', 'endOfContent'));
    if (token !== S.renderToken) return;
    const hl = el('div', 'hlLayer');
    p.div.querySelectorAll('canvas,.textLayer,.hlLayer').forEach((x) => x.remove());
    p.div.prepend(canvas); canvas.after(hl); hl.after(tl);
    Object.assign(p, { canvas, tl, hl, textLayer, state: 2 });
    drawHighlights(p);
    if (T.playing && T.page === p.num) markSpeaking();
  } catch (err) {
    if (token === S.renderToken) { p.state = 0; console.warn('render', p.num, err); }
  }
}
function unrenderPage(p) {
  p.div.querySelectorAll('canvas,.textLayer,.hlLayer,.wordLayer').forEach((x) => { if (x.tagName === 'CANVAS') { x.width = 0; x.height = 0; } x.remove(); });
  Object.assign(p, { canvas: null, tl: null, hl: null, textLayer: null, state: 0 });
}
function relayout() {
  if (isEpub()) return;
  const anchor = S.current; const off = (() => { const p = S.pages[anchor - 1]; return p ? (viewer.scrollTop - p.div.offsetTop) / p.div.offsetHeight : 0; })();
  S.renderToken++;
  S.pages.forEach((p) => { unrenderPage(p); sizePage(p); });
  const p = S.pages[anchor - 1]; if (p) viewer.scrollTop = p.div.offsetTop + off * p.div.offsetHeight;
  pumpRender();
}
function setZoom(fn) {
  if (isEpub()) {
    const p = S.pages[S.current - 1]; const off = p ? (viewer.scrollTop - p.div.offsetTop) / p.div.offsetHeight : 0;
    S.fs = Math.round(Math.max(12, Math.min(40, fn(S.fs)))); store.set('epubFs', S.fs); applyFont();
    if (p) viewer.scrollTop = p.div.offsetTop + off * p.div.offsetHeight; sizeLabel(); return;
  }
  if (!S.doc) return; S.fit = false; S.scale = Math.max(0.4, Math.min(4, fn(S.scale))); relayout(); $('bFit').classList.remove('on'); sizeLabel(); }
// the middle button shows the text size: 100% is the normal size; click it to go back to normal (EPUB) or to page width (PDF)
function sizeLabel() {
  const f = $('bFit');
  if (isEpub()) { f.textContent = Math.round((S.fs / 19) * 100) + '%'; f.classList.toggle('on', S.fs === 19); f.title = 'Text size. Click for the normal size'; return; }
  f.textContent = S.fit || !S.doc ? 'Fit' : Math.round(S.scale * 100) + '%'; f.classList.toggle('on', !!S.fit); f.title = 'Page size. Click to fit the page to the window width';
}
function goTo(n, behavior = 'smooth') {
  n = Math.max(1, Math.min(S.count, n | 0)); const p = S.pages[n - 1]; if (!p) return;
  viewer.scrollTo({ top: p.div.offsetTop - 12, behavior }); S.current = n; updatePageBox();
}
function updatePageBox() { if (document.activeElement !== $('pageIn')) $('pageIn').value = label(S.current); }
const saveLast = debounce(() => {
  if (!S.book) return; const p = S.pages[S.current - 1];
  S.book.lastPage = S.current; S.book.lastFrac = p ? Math.max(0, (viewer.scrollTop - p.div.offsetTop) / p.div.offsetHeight) : 0;
  S.book.opened = Date.now(); DB.putBook(S.book);
}, 800);
const libraryOpen = () => !$('welcome').hidden;
viewer.addEventListener('scroll', () => {
  if (!S.pages.length || pagesEl.hidden) return; // the book is behind the library: its place must not change
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let lo = 0, hi = S.pages.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S.pages[m].div.offsetTop <= mid) lo = m; else hi = m - 1; }
  if (S.current !== lo + 1) { S.current = lo + 1; updatePageBox(); }
  saveLast();
}, { passive: true });
function parsePageInput(v) {
  v = v.trim(); if (!v) return null;
  if (S.labels) { const i = S.labels.findIndex((l) => l && l.toLowerCase() === v.toLowerCase()); if (i >= 0) return i + 1; }
  const n = parseInt(v, 10); return Number.isFinite(n) ? n : null;
}

/* ---------------- Contents ---------------- */
async function buildToc() {
  const pane = $('paneToc'); pane.innerHTML = '';
  if (isEpub()) {
    const ep = S.epub;
    if (!ep.toc.length) { pane.append(el('div', 'empty', 'This book has no table of contents.')); return; }
    const build = (items) => {
      const ul = el('ul');
      for (const it of items) {
        const li = el('li'); const a = el('a'); a.href = '#';
        const n = ep.spineIndex(it.path) + 1;
        a.append(el('span', '', it.title || 'Untitled'), el('span', '', ''));
        if (n > 0) a.onclick = (e) => { e.preventDefault(); goToAnchor(n, it.hash ? `e${n - 1}-${it.hash}` : null); if (innerWidth < 760) toggleSide(false); };
        li.append(a); if (it.items?.length) li.append(build(it.items)); ul.append(li);
      }
      return ul;
    };
    pane.append(build(ep.toc)); return;
  }
  const outline = await S.doc.getOutline().catch(() => null);
  if (!outline || !outline.length) { pane.append(el('div', 'empty', 'This PDF has no table of contents.')); return; }
  const resolve = async (dest) => {
    try { if (typeof dest === 'string') dest = await S.doc.getDestination(dest); if (!dest) return null; const ref = dest[0]; return typeof ref === 'number' ? ref + 1 : (await S.doc.getPageIndex(ref)) + 1; } catch { return null; }
  };
  const build = async (items) => {
    const ul = el('ul');
    for (const it of items) {
      const li = el('li'); const a = el('a'); a.href = '#';
      const n = await resolve(it.dest);
      a.append(el('span', '', it.title), el('span', '', n ? label(n) : ''));
      if (n) a.onclick = (e) => { e.preventDefault(); goTo(n); if (innerWidth < 760) toggleSide(false); };
      li.append(a); if (it.items?.length) li.append(await build(it.items)); ul.append(li);
    }
    return ul;
  };
  pane.append(await build(outline));
}

function goToAnchor(n, id) {
  const t = id && document.getElementById(id);
  if (t) { viewer.scrollTo({ top: viewer.scrollTop + t.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 24, behavior: 'smooth' }); return; }
  goTo(n);
}

/* ---------------- Highlights ---------------- */
const hlOrder = (a, b) => (hlUnit(a) - hlUnit(b)) || (a.rects && b.rects ? (a.rects[0].y - b.rects[0].y) || (a.rects[0].x - b.rects[0].x) : (a.start || 0) - (b.start || 0));
function drawHighlights(p) {
  if (!p.hl) return; p.hl.innerHTML = '';
  for (const h of S.hls) for (const r of h.rects) if (r.page === p.num) {
    const d = el('div', 'hl'); d.dataset.id = h.id; d.style.setProperty('--c', COLORS[h.color]);
    Object.assign(d.style, { left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%' });
    p.hl.append(d);
  }
}
function redraw(pagesSet) { if (isEpub()) { paintEpub(); return; } S.pages.forEach((p) => { if (p.state === 2 && (!pagesSet || pagesSet.has(p.num))) drawHighlights(p); }); }
function rangeRects(range) {
  const raw = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!raw.length) return [];
  const hs = raw.map((r) => r.height).sort((a, b) => a - b); const medH = hs[hs.length >> 1];
  const out = [];
  for (const p of S.pages) {
    if (p.state !== 2) continue; const b = p.div.getBoundingClientRect();
    const mine = raw.filter((r) => r.height < medH * 2.5 && r.left + r.width / 2 > b.left && r.left + r.width / 2 < b.right && r.top + r.height / 2 > b.top && r.top + r.height / 2 < b.bottom)
      .map((r) => ({ page: p.num, x: (r.left - b.left) / b.width, y: (r.top - b.top) / b.height, w: r.width / b.width, h: r.height / b.height }));
    mine.sort((a, c) => a.y - c.y || a.x - c.x);
    const lines = [];
    for (const r of mine) {
      const L = lines.find((l) => Math.abs((l.y + l.h / 2) - (r.y + r.h / 2)) < Math.min(l.h, r.h) * 0.5 && r.x <= l.x + l.w + 0.02);
      if (L) { const x2 = Math.max(L.x + L.w, r.x + r.w), y2 = Math.max(L.y + L.h, r.y + r.h); L.x = Math.min(L.x, r.x); L.y = Math.min(L.y, r.y); L.w = x2 - L.x; L.h = y2 - L.y; } else lines.push({ ...r });
    }
    out.push(...lines);
  }
  return out;
}
async function addHighlight(color, { focus = false } = {}) {
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const text = sel.toString().replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ').trim();
  const h = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), bookId: S.book.id, text, color, note: '', created: Date.now() };
  if (isEpub()) {
    const p = sectionOf(range.startContainer); if (!p || !text) return;
    const end = sectionOf(range.endContainer) === p ? posOf(p, range.endContainer, range.endOffset) : secModel(p).text.length;
    let a = posOf(p, range.startContainer, range.startOffset), b = end; const t = secModel(p).text;
    while (a < b && /\s/.test(t[a])) a++; while (b > a && /\s/.test(t[b - 1])) b--;
    if (b <= a) return; Object.assign(h, { sec: p.num, start: a, end: b });
  } else {
    const rects = rangeRects(range); if (!rects.length || !text) return; h.rects = rects;
  }
  h.where = unitLabel(hlUnit(h));
  S.hls.push(h); S.hls.sort(hlOrder); await DB.putHl(h);
  sel.removeAllRanges(); hideMenu();
  redraw(hlUnits(h)); renderNotes(focus ? h.id : null);
  if (focus) { toggleSide(true); showTab('notes'); }
  store.set('lastColor', color);
}
async function updateHl(h) { await DB.putHl(h); }
async function deleteHl(id) {
  const h = S.hls.find((x) => x.id === id); if (!h) return;
  S.hls = S.hls.filter((x) => x.id !== id); await DB.delHl(id);
  redraw(hlUnits(h)); renderNotes();
}
function renderNotes(focusId) {
  const list = $('noteList'); list.innerHTML = '';
  const n = S.hls.length;
  $('nCount').textContent = n ? `(${n})` : '';
  $('nCount2').textContent = n ? `${n} highlight${n > 1 ? 's' : ''}` : 'No highlights yet';
  if (!n) { list.append(el('div', 'empty', 'Select text on a page, then pick a colour to highlight it. Add a note to any highlight here.')); return; }
  for (const h of S.hls) {
    const item = el('div', 'note'); item.dataset.id = h.id; item.style.setProperty('--c', COLORS[h.color]);
    const meta = el('div', 'meta');
    meta.append(el('span', 'pg', unitLabel(hlUnit(h))), el('span', 'sp'));
    const dots = el('div', 'dots');
    for (const c of Object.keys(COLORS)) {
      const d = el('button', 'dot' + (c === h.color ? ' on' : '')); d.style.setProperty('--c', COLORS[c]); d.title = c;
      d.onclick = () => { h.color = c; updateHl(h); redraw(hlUnits(h)); renderNotes(h.id); };
      dots.append(d);
    }
    const del = el('button', 'linkbtn', 'Delete');
    del.onclick = () => { if (del.dataset.armed) deleteHl(h.id); else { del.dataset.armed = 1; del.textContent = 'Confirm delete'; del.classList.add('danger'); setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 3000); } };
    meta.append(dots, del);
    const q = el('blockquote', '', h.text); q.title = 'Go to this highlight'; q.onclick = () => jumpToHl(h);
    const ta = el('textarea'); ta.placeholder = 'Add a note…'; ta.value = h.note || ''; ta.id = 'note-' + h.id;
    const save = debounce(() => { h.note = ta.value; updateHl(h); }, 400); ta.oninput = save;
    item.append(meta, q, ta); list.append(item);
    if (h.id === focusId) { item.classList.add('focus'); requestAnimationFrame(() => { item.scrollIntoView({ block: 'nearest' }); ta.focus(); }); }
  }
}
function jumpToHl(h) {
  if (!h.rects) {
    const p = S.pages[h.sec - 1]; const r = p && rangeFromPos(p, h.start, h.end); if (!r) return;
    const box = r.getBoundingClientRect(); const v = viewer.getBoundingClientRect();
    viewer.scrollTo({ top: viewer.scrollTop + box.top - v.top - viewer.clientHeight * 0.3, behavior: 'smooth' });
    if (hasCssHL()) { CSS.highlights.set('hl-flash', new Highlight(r)); setTimeout(() => CSS.highlights.delete('hl-flash'), 1600); }
    if (innerWidth < 760) toggleSide(false); return;
  }
  const r = h.rects[0]; const p = S.pages[r.page - 1];
  viewer.scrollTo({ top: p.div.offsetTop + r.y * p.div.offsetHeight - viewer.clientHeight * 0.3, behavior: 'smooth' });
  setTimeout(() => p.hl?.querySelectorAll(`[data-id="${h.id}"]`).forEach((d) => { d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); }), 450);
  if (innerWidth < 760) toggleSide(false);
}
function exportNotes() {
  if (!S.book || !S.hls.length) { toast('No highlights to export yet.'); return; }
  const title = S.book.title || S.book.name;
  let md = `# ${title}\n\nHighlights and notes exported from Margin, ${new Date().toLocaleDateString()}\n`;
  let last = null;
  for (const h of S.hls) {
    const pg = unitLabel(hlUnit(h));
    if (pg !== last) { md += `\n## ${pg}\n`; last = pg; }
    md += `\n> ${h.text}\n`; if (h.note?.trim()) md += `\n${h.note.trim()}\n`;
  }
  const a = el('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80)} - notes.md`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* selection menu */
const menu = $('selmenu');
function hideMenu() { menu.hidden = true; }
function checkSelection() {
  const sel = getSelection();
  if (!S.book || !sel.rangeCount || sel.isCollapsed) { hideMenu(); return; }
  const r = sel.getRangeAt(0); if (!pagesEl.contains(r.commonAncestorContainer)) { hideMenu(); return; }
  if (!sel.toString().trim()) { hideMenu(); return; }
  $('mWord').hidden = sel.toString().trim().split(/\s+/).length > 5;
  const rects = [...r.getClientRects()].filter((x) => x.width > 1); const last = rects[rects.length - 1] || r.getBoundingClientRect();
  const first = rects[0] || last;
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let top = first.top - mh - 8; if (top < 50) top = last.bottom + 8;
  const left = Math.max(8, Math.min(innerWidth - mw - 8, first.left));
  menu.style.top = top + 'px'; menu.style.left = left + 'px';
}
pagesEl.addEventListener('pointerup', () => setTimeout(checkSelection, 0));
document.addEventListener('selectionchange', () => { const s = getSelection(); if (!s || s.isCollapsed) hideMenu(); });
document.addEventListener('keyup', (e) => { if (e.shiftKey) checkSelection(); });
menu.addEventListener('pointerdown', (e) => e.preventDefault());
menu.querySelectorAll('.dot').forEach((d) => (d.onclick = () => addHighlight(d.dataset.c)));
$('mNote').onclick = () => addHighlight(store.get('lastColor', 'yellow'), { focus: true });
$('mCopy').onclick = async () => { const t = getSelection().toString(); try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Press Ctrl+C to copy'); } };
$('mRead').onclick = () => { const pos = selectionPosition(); getSelection().removeAllRanges(); hideMenu(); if (pos) { T.startItem = pos.item ?? null; ttsPlay(pos.page, pos.char || 0); } };
// selection mouse-down in a text layer: let pdf.js-style endOfContent help selection
pagesEl.addEventListener('mousedown', (e) => { const tl = e.target.closest?.('.textLayer'); if (tl) tl.classList.add('selecting'); });
document.addEventListener('mouseup', () => document.querySelectorAll('.textLayer.selecting').forEach((t) => t.classList.remove('selecting')));
// click on a highlight → open its note
pagesEl.addEventListener('click', (e) => {
  const s = getSelection(); if (s && !s.isCollapsed) return;
  if (isEpub()) {
    const a = e.target.closest('a[data-sec]');
    if (a) { e.preventDefault(); goToAnchor(+a.dataset.sec, a.dataset.anchor); return; }
    const cr = document.caretRangeFromPoint?.(e.clientX, e.clientY); const p = cr && sectionOf(cr.startContainer); if (!p) return;
    const pos = posOf(p, cr.startContainer, cr.startOffset);
    const h = S.hls.find((h) => h.sec === p.num && pos >= h.start && pos < h.end);
    if (h) { toggleSide(true); showTab('notes'); renderNotes(h.id); }
    return;
  }
  const pdiv = e.target.closest('.page'); if (!pdiv) return;
  const n = +pdiv.dataset.page; const b = pdiv.getBoundingClientRect();
  const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
  const h = S.hls.find((h) => h.rects.some((r) => r.page === n && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
  if (h) { toggleSide(true); showTab('notes'); renderNotes(h.id); }
});

/* ---------------- Sidebar ---------------- */
function toggleSide(force) { const s = $('side'); const open = force ?? s.classList.contains('closed'); s.classList.toggle('closed', !open); $('bSide').classList.toggle('on', open); store.set('side', open); if (S.fit && innerWidth >= 760) { computeFitScale(); relayout(); } }
function showTab(t) {
  for (const [b, pn, k] of [['tToc', 'paneToc', 'toc'], ['tNotes', 'paneNotes', 'notes'], ['tWords', 'paneWords', 'words']]) { $(b).classList.toggle('on', t === k); $(pn).hidden = t !== k; }
  store.set('tab', t);
}
$('tToc').onclick = () => showTab('toc'); $('tNotes').onclick = () => showTab('notes'); $('tWords').onclick = () => showTab('words');
$('bSide').onclick = () => toggleSide(); $('bExport').onclick = exportNotes;

/* ---------------- Library / open ---------------- */
/* ---------------- Library catalogue ---------------- */
// a small picture of each book's cover, kept with the book (JPEG data, about 20 KB)
const COVER_W = 300;
function canvasToCover(c) { try { return c.toDataURL('image/jpeg', 0.82); } catch { return ''; } }
async function pdfCover(doc) {
  try {
    const page = await doc.getPage(1); const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: COVER_W / v1.width });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvasToCover(c);
  } catch { return ''; }
}
function imageCover(url) {
  return new Promise((res) => {
    if (!url) { res(''); return; }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, COVER_W / img.naturalWidth); const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
      res(canvasToCover(c));
    };
    img.onerror = () => res('');
    img.src = url;
  });
}
// covers for books opened before covers existed (or restored from a backup), one at a time
let coverQueue = Promise.resolve();
const COPY_YEAR = /(?:copyright|©|\(c\)|first published|published in|first edition)[^0-9]{0,40}\b(1[4-9]\d\d|20\d\d)\b/i;
function yearFromText(t) { const m = String(t || '').match(COPY_YEAR); const y = m ? +m[1] : 0; return y && y <= new Date().getFullYear() ? y : 0; }
async function pdfYear(doc) {
  for (let n = 1; n <= Math.min(10, doc.numPages); n++) {
    try { const tc = await (await doc.getPage(n)).getTextContent(); const y = yearFromText(tc.items.map((i) => i.str).join(' ')); if (y) return y; } catch {}
  }
  return 0;
}
async function epubYear(ep) {
  if (ep.year) return ep.year;
  for (let i = 0; i < Math.min(5, ep.spine.length); i++) { try { const y = yearFromText((await ep.chapter(i)).textContent); if (y) return y; } catch {} }
  return 0;
}
const coverPending = new Set();
function makeCoverLater(b, onDone) {
  if (coverPending.has(b.id)) return; coverPending.add(b.id);
  coverQueue = coverQueue.then(async () => {
    try {
      const data = await bookData(b); if (!data) return; let c = '';
      if (b.kind === 'epub' || (new Uint8Array(data, 0, 2)[0] === 0x50)) {
        const ep = await openEpub(data); if (!b.author && ep.author) b.author = ep.author; if (!b.title && ep.title) b.title = ep.title;
        if (b.metaV !== META_V) fillMeta(b, ep);
        b.count = b.count || ep.spine.length;
        if (b.year === undefined) b.year = (await epubYear(ep)) || null;
        if (b.pages === undefined) { const pg = await ep.pages(); b.pages = pg.pages; b.pagesEstimated = pg.estimated; }
        if (!b.cover) c = await imageCover(await ep.cover()); ep.close();
      } else {
        const doc = await pdfjsLib.getDocument({ data, cMapUrl: './lib/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './lib/pdfjs/standard_fonts/' }).promise;
        const meta = await doc.getMetadata().catch(() => null); const au = meta?.info?.Author?.trim(); if (au && !b.author) b.author = au;
        if (b.metaV !== META_V) fillMeta(b, { description: meta?.info?.Subject?.trim() || '', subjects: String(meta?.info?.Keywords || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean) });
        b.count = b.count || doc.numPages;
        if (b.year === undefined) b.year = (await pdfYear(doc)) || null;
        if (!b.cover) c = await pdfCover(doc); doc.destroy();
      }
      if (c) b.cover = c; else if (!b.cover) b.coverFailed = true;
      if (!b.author) guessFromPath(b);
      const cur = await DB.getBook(b.id);
      if (cur) {
        Object.assign(cur, { cover: b.cover, coverFailed: b.coverFailed, count: b.count, year: cur.year ?? b.year, pages: b.pages, pagesEstimated: b.pagesEstimated, title: cur.title || b.title, metaV: META_V });
        for (const k of ['author', 'publisher', 'description', 'language', 'subjects', 'isbn']) if (!cur[k] || (Array.isArray(cur[k]) && !cur[k].length)) cur[k] = b[k];
        await DB.putBook(cur);
      }
      if (S.book?.id === b.id) Object.assign(S.book, { cover: b.cover, year: b.year, pages: b.pages, pagesEstimated: b.pagesEstimated });
      onDone(b);
    } catch (err) { console.warn('cover', b.id, err); }
    finally { coverPending.delete(b.id); }
  });
}
// a cloth-bound cover for books without a picture, coloured by title
const CLOTH = ['#2f4a44', '#6b2f2b', '#2b4566', '#5c4a26', '#3e5a3a', '#4b3a5e', '#7a4f2c', '#22394a', '#5a2f45', '#34515c'];
function generatedCover(b) {
  const g = el('div', 'gen'); let h = 0; for (const ch of b.title || b.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  g.style.setProperty('--cloth', CLOTH[h % CLOTH.length]);
  g.append(el('div', 'rule'), el('div', 't', b.title || b.name), el('div', 'a', authorText(b)), el('div', 'rule'));
  return g;
}
// an author typed in by hand is shown exactly as typed
const authorText = (b) => (b.authorEdited ? b.author || '' : tidyAuthor(b.author));

/* ---------------- Edit details + DOI look-up ----------------
   Journal articles often carry their DOI ("doi:10.1016/j.polgeo.2005.06.004") instead of a title.
   Crossref, the DOI registry, gives the real title, authors and year (needs internet). */
const DOI_RE = /\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"<>]+)/i;
const doiOf = (t) => { const m = String(t || '').match(DOI_RE); return m ? m[1].replace(/[.,;)\]]+$/, '') : ''; };
async function lookupDoi(doi) {
  const r = await fetch('https://api.crossref.org/works/' + encodeURIComponent(doi));
  if (!r.ok) throw new Error(r.status === 404 ? 'That DOI was not found.' : 'The DOI look-up failed.');
  const w = (await r.json()).message || {};
  const authors = (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
  const dp = (w.issued || w['published-print'] || w['published-online'] || {})['date-parts'];
  return {
    title: (w.title || [])[0]?.replace(/\s+/g, ' ').trim() || '',
    author: authors.length > 3 ? authors.slice(0, 3).join(', ') + ' et al.' : authors.join(', '),
    year: dp && dp[0] && dp[0][0] ? +dp[0][0] : null,
    journal: (w['container-title'] || [])[0] || '',
  };
}
async function autoDoi(b) {
  const doi = doiOf(b.title || b.name);
  try {
    const d = await lookupDoi(doi);
    const patch = { doi, doiChecked: true };
    if (d.title) patch.title = d.title;
    if (d.author) { patch.author = d.author; patch.authorEdited = true; }
    if (d.year) patch.year = d.year;
    await updateBook(b.id, patch); Object.assign(b, patch);
    const card = $('catGrid').querySelector(`.bk[data-id="${CSS.escape(b.id)}"]`); if (card) card.replaceWith(bookCard(b));
    if (S.book?.id === b.id && pagesEl.hidden === false) $('title').textContent = b.title;
  } catch (err) {
    if (/not found/.test(err.message)) await updateBook(b.id, { doiChecked: true }); // offline: try again next time
  }
}
let editing = null;
function openEditor(b) {
  editing = b;
  $('edTitle').value = b.title || b.name || ''; $('edAuthor').value = authorText(b); $('edYear').value = b.year || '';
  $('edPublisher').value = b.publisher || ''; $('edIsbn').value = b.isbn || ''; $('edDesc').value = b.description || '';
  $('edResults').innerHTML = ''; $('edResults').hidden = true; editing.found = null;
  $('edDoi').value = b.doi || doiOf(b.title || b.name); $('edMsg').textContent = '';
  $('editDlg').hidden = false; $('edTitle').focus(); $('edTitle').select();
}
function closeEditor() { $('editDlg').hidden = true; editing = null; }
$('edCancel').onclick = closeEditor;
$('editDlg').addEventListener('click', (e) => { if (e.target.id === 'editDlg') closeEditor(); });
$('editDlg').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeEditor(); } });
$('edLookup').onclick = async () => {
  const doi = doiOf($('edDoi').value) || doiOf($('edTitle').value);
  if (!doi) { $('edMsg').textContent = 'Type or paste a DOI first, for example 10.1016/j.polgeo.2005.06.004'; return; }
  $('edMsg').textContent = 'Looking up the DOI…';
  try {
    const d = await lookupDoi(doi);
    if (d.title) $('edTitle').value = d.title; if (d.author) $('edAuthor').value = d.author; if (d.year) $('edYear').value = d.year;
    $('edDoi').value = doi; $('edMsg').textContent = d.journal ? `Found: ${d.journal}${d.year ? ', ' + d.year : ''}. Press Save to keep it.` : 'Found. Press Save to keep it.';
  } catch (err) { $('edMsg').textContent = navigator.onLine === false ? 'The DOI look-up needs internet.' : err.message || 'The DOI look-up failed.'; }
};
$('editForm').onsubmit = async (e) => {
  e.preventDefault(); const b = editing; if (!b) return;
  const y = parseInt($('edYear').value, 10);
  const patch = { title: $('edTitle').value.trim() || b.name, author: $('edAuthor').value.trim(), authorEdited: true, year: y >= 1000 && y <= 2100 ? y : null, doi: doiOf($('edDoi').value) || b.doi || null, doiChecked: true,
    publisher: $('edPublisher').value.trim(), isbn: $('edIsbn').value.replace(/[^\dXx]/g, ''), description: $('edDesc').value.trim() };
  const f = b.found; if (f && f.pageCount && b.kind === 'epub') { patch.pages = f.pageCount; patch.pagesEstimated = false; }
  if (f && f.language && !b.language) patch.language = f.language;
  if (f && f.subjects?.length && !(b.subjects || []).length) patch.subjects = f.subjects;
  await updateBook(b.id, patch); Object.assign(b, patch);
  const card = $('catGrid').querySelector(`.bk[data-id="${CSS.escape(b.id)}"]`); if (card) card.replaceWith(bookCard(b));
  if (S.book?.id === b.id) { S.book.title = patch.title; if (!pagesEl.hidden) { $('title').textContent = patch.title; document.title = patch.title + ' · Margin'; } const bk = $('bBack'); if (!bk.hidden) bk.textContent = `← Back to ${patch.title}`; }
  closeEditor(); toast('Saved.');
  if (!$('bookPage').hidden) { if ($('bookPage').querySelector('.nb-head')) showNewBooks(); else showBookPage(b.id); }
};
// Find details online: Google Books and Open Library are searched together and their matches combined.
// Google limits searches made without a key ("too many requests"), so it is retried once and Open
// Library (no key, no such limit) fills in when Google is busy.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  let last = '';
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { data: await r.json() };
      last = r.status === 429 ? 'busy (too many searches right now)' : r.status === 403 ? 'refused the search (daily limit reached)' : `answered with error ${r.status}`;
      if (r.status === 429 || r.status >= 500) { await sleep(1500); continue; }
      return { error: last };
    } catch { last = 'could not be reached'; await sleep(600); }
  }
  return { error: last };
}
// a title fit for searching: "Genghis Khan_ A Captivating Guide by Captivating History EPUB" -> "Genghis Khan"
function searchTitle(t) {
  return String(t || '').replace(/_/g, ' ').replace(/\s+by\s+[^:]*$/i, '').replace(/\b(e?pub|pdf|mobi|azw3|e-?book)\b.*$/i, '')
    .replace(/\s*[:(\[].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
const ISO3 = { eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', jpn: 'ja', tha: 'th', bur: 'my', mya: 'my', kac: 'kac', hin: 'hi', ara: 'ar', dut: 'nl', nld: 'nl' };
async function googleBooks(title, author, isbn) {
  const run = (q) => getJson('https://www.googleapis.com/books/v1/volumes?maxResults=8&printType=books&q=' + encodeURIComponent(q));
  let res = { data: {} };
  if (isbn) res = await run('isbn:' + isbn);
  if (!res.error && !(res.data.items || []).length && title) res = await run(`intitle:${title}` + (author ? ` inauthor:${author.split(/[ ,]+/).filter((x) => x.length > 2).pop() || ''}` : ''));
  if (!res.error && !(res.data.items || []).length && title) res = await run(title + (author ? ' ' + author : ''));
  if (res.error) return { error: 'Google Books ' + res.error, items: [] };
  return { items: (res.data.items || []).map((it) => it.volumeInfo || {}).map((v) => ({
    source: 'Google Books', title: [v.title, v.subtitle].filter(Boolean).join(': '), author: (v.authors || []).join(', '), year: parseInt(v.publishedDate, 10) || null,
    publisher: v.publisher || '', description: htmlToText(v.description || ''), pageCount: v.pageCount || 0, language: v.language || '',
    subjects: v.categories || [], isbn: ((v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13') || (v.industryIdentifiers || [])[0] || {}).identifier || '',
  })) };
}
async function openLibrary(title, author, isbn) {
  const f = '&fields=key,title,subtitle,author_name,first_publish_year,publisher,isbn,number_of_pages_median,language,subject&limit=8';
  let res = { data: {} };
  if (isbn) res = await getJson('https://openlibrary.org/search.json?isbn=' + encodeURIComponent(isbn) + f);
  if (!res.error && !(res.data.docs || []).length && title) res = await getJson('https://openlibrary.org/search.json?title=' + encodeURIComponent(title) + (author ? '&author=' + encodeURIComponent(author.split(/,/)[0]) : '') + f);
  if (!res.error && !(res.data.docs || []).length && title) res = await getJson('https://openlibrary.org/search.json?q=' + encodeURIComponent(title) + f);
  if (res.error) return { error: 'Open Library ' + res.error, items: [] };
  return { items: (res.data.docs || []).map((d) => ({
    source: 'Open Library', key: d.key, title: [d.title, d.subtitle].filter(Boolean).join(': '), author: (d.author_name || []).slice(0, 3).join(', '),
    year: d.first_publish_year || null, publisher: (d.publisher || [])[0] || '', description: '', pageCount: d.number_of_pages_median || 0,
    language: ISO3[(d.language || [])[0]] || '', subjects: (d.subject || []).slice(0, 6), isbn: (d.isbn || []).find((x) => x.length === 13) || (d.isbn || [])[0] || '',
  })) };
}
// Open Library keeps the description on the work page
async function olDescription(key) {
  if (!key) return '';
  const r = await getJson('https://openlibrary.org' + key + '.json'); const d = r.data?.description;
  return htmlToText(typeof d === 'string' ? d : d?.value || '');
}
async function searchBooks() {
  const title = searchTitle($('edTitle').value), author = $('edAuthor').value.trim(), isbn = $('edIsbn').value.replace(/[^\dXx]/g, '');
  const [g, o] = await Promise.all([googleBooks(title, author, isbn), openLibrary(title, author, isbn)]);
  const seen = new Set(), items = [];
  for (const it of [...o.items.slice(0, 6), ...g.items.slice(0, 4)]) {
    const k = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + (it.year || '');
    if (!it.title || seen.has(k)) continue; seen.add(k); items.push(it);
  }
  return { items, errors: [o.error, g.error].filter(Boolean) };
}
$('edFind').onclick = async () => {
  const box = $('edResults'); box.hidden = false; box.innerHTML = ''; box.append(el('div', 'due', 'Searching Open Library and Google Books…'));
  const { items, errors } = await searchBooks();
  box.innerHTML = '';
  if (!items.length) {
    const why = navigator.onLine === false ? 'Finding details needs internet.'
      : errors.length === 2 ? `The search didn't work: ${errors.join('; ')}. Try again in a minute.`
      : 'Nothing found. Try a shorter title, or add the author or ISBN and search again.' + (errors.length ? ` (${errors[0]}.)` : '');
    box.append(el('div', 'due', why)); return;
  }
  box.append(el('div', 'due', 'Pick the matching book. Its details fill in below; nothing is saved until you press Save.' + (errors.length ? ` (${errors[0]}, so only the other source is shown.)` : '')));
  for (const it of items) {
    const row = el('button', 'res'); row.type = 'button';
    const t = el('div', 'rt'); t.append(el('b', '', it.title || 'Untitled'), el('span', '', [it.author, it.year, it.publisher, it.source].filter(Boolean).join(' · ')));
    row.append(t);
    row.onclick = async () => {
      box.querySelectorAll('.res').forEach((x) => x.classList.remove('on')); row.classList.add('on');
      if (it.title) $('edTitle').value = it.title; if (it.author) $('edAuthor').value = it.author; if (it.year) $('edYear').value = it.year;
      if (it.publisher) $('edPublisher').value = it.publisher; if (it.isbn) $('edIsbn').value = it.isbn; if (it.description) $('edDesc').value = it.description;
      editing.found = it;
      if (!it.description && it.key) { const d = await olDescription(it.key); if (d && editing?.found === it) { it.description = d; if (!$('edDesc').value.trim() || row.classList.contains('on')) $('edDesc').value = d; } }
    };
    box.append(row);
  }
};

/* ---------------- Book page ---------------- */
// open a book to read (or go back to it if it is the open one)
function readBook(b) { if (S.book?.id === b.id && S.pages.length) backToBook(); else openStored(b.id); }
const LANG = (() => { try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; } })();
const langName = (c) => { if (!c) return ''; try { return LANG?.of(c.toLowerCase()) || c; } catch { return c; } };
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
let pageScroll = 0;
async function showBookPage(id) {
  const b = await DB.getBook(id); if (!b) return;
  setView('library');
  const pg = $('bookPage');
  if (pg.hidden) pageScroll = $('welcome').scrollTop;
  pg.innerHTML = ''; pg.hidden = false; $('catalog').hidden = true; $('folders').hidden = true; $('libtools').hidden = true;
  const back = el('button', 'btn back', '← Library'); back.onclick = () => { closeBookPage(); showLibrary(false); };
  const top = el('div', 'bp-top');
  const cv = el('div', 'bp-cover');
  if (b.cover && !b.plainCover) { const img = el('img'); img.src = b.cover; img.alt = ''; cv.append(img); } else cv.append(generatedCover(b));
  const info = el('div', 'bp-info');
  info.append(el('h1', '', b.title || b.name));
  const au = authorText(b); info.append(el('div', 'bp-author', au || 'Author unknown'));
  if (!au) info.querySelector('.bp-author').classList.add('unknown');
  // actions
  const acts = el('div', 'bp-acts');
  const read = el('button', 'btn primary', b.opened ? `Continue reading · ${b.kind === 'epub' ? Math.round(bookProgress(b) * 100) + '%' : 'p. ' + (b.lastPage || 1)}` : 'Start reading');
  read.onclick = () => readBook(b);
  if (b.missing) { read.disabled = true; read.textContent = 'File not found'; }
  const star = el('button', 'btn tog' + (b.star ? ' on star' : '')); star.innerHTML = STAR_SVG + `<span>${b.star ? 'Must read' : 'Mark must read'}</span>`;
  star.onclick = async () => { await updateBook(b.id, { star: !b.star }); showBookPage(b.id); };
  const done = el('button', 'btn tog' + (b.done ? ' on done' : '')); done.innerHTML = EYE_SVG + `<span>${b.done ? 'Read' : 'Mark as read'}</span>`;
  done.onclick = async () => { await updateBook(b.id, { done: !b.done, doneAt: !b.done ? Date.now() : null }); showBookPage(b.id); };
  const edit = el('button', 'btn tog', 'Edit details'); edit.onclick = () => openEditor(b);
  const find = el('button', 'btn tog', 'Find details online'); find.onclick = () => { openEditor(b); $('edFind').click(); };
  acts.append(read, star, done, edit, find);
  info.append(acts);
  // facts
  const dl = el('dl', 'bp-facts');
  const fact = (k, v) => { if (v == null || v === '' || (Array.isArray(v) && !v.length)) return; dl.append(el('dt', '', k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v; dl.append(dd); };
  fact('Published', b.year ? String(b.year) : '');
  fact('Publisher', b.publisher);
  const np = b.kind === 'epub' ? b.pages : b.count;
  fact('Pages', np ? (b.kind === 'epub' && b.pagesEstimated ? `About ${np} (estimated)` : String(np)) : '');
  fact('Format', `${(b.kind || 'pdf').toUpperCase()}${b.size ? ' · ' + (b.size >= 1048576 ? (b.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b.size / 1024)) + ' KB') : ''}`);
  fact('Language', langName(b.language));
  fact('ISBN', b.isbn);
  fact('DOI', b.doi);
  fact('Subjects', (b.subjects || []).join(' · '));
  const secs = sectionsOf(b);
  if (secs.length) { const w = el('span', 'bp-secs'); for (const sname of secs) { const c = el('button', 'shelf', sname); c.onclick = () => { shelf = sname; store.set('shelf', sname); closeBookPage(); renderCatalog(); }; w.append(c); } fact('Sections', w); }
  fact('Added', fmtDate(b.added)); fact('Last read', fmtDate(b.opened));
  if (b.done && b.doneAt) fact('Finished', fmtDate(b.doneAt));
  if (b.path) { const p = el('span', 'bp-path', b.path); fact('File', p); }
  info.append(dl);
  top.append(cv, info);
  // description
  const desc = el('div', 'bp-desc');
  desc.append(el('h2', '', 'About this book'));
  if (b.description) for (const para of b.description.split(/\n{2,}|\n/)) { if (para.trim()) desc.append(el('p', '', para.trim())); }
  else { const p = el('p', 'unknown', 'No description yet. '); const a = el('button', 'linkbtn', 'Find details online'); a.onclick = () => find.click(); p.append(a); desc.append(p); }
  pg.append(back, top, desc);
  $('welcome').scrollTop = 0; back.focus();
}
async function refreshLibBooks() { const all = await DB.books(); libBooks = all.filter((b) => !b.hidden && b.kind !== 'text'); }

/* ---------------- New books: check or add their details ---------------- */
async function showNewBooks() {
  setView('library');
  await refreshLibBooks();
  const fresh = libBooks.filter((b) => b.fresh).sort((a, c) => (c.added || 0) - (a.added || 0));
  $('welcome').hidden = false; pagesEl.hidden = true; $('pagebox').hidden = true; $('title').textContent = '';
  const pg = $('bookPage');
  if (pg.hidden) pageScroll = $('welcome').scrollTop;
  pg.innerHTML = ''; pg.hidden = false; $('catalog').hidden = true; $('folders').hidden = true; $('libtools').hidden = true; $('intro').hidden = true;
  $('welcome').classList.add('has-books');
  const back = el('button', 'btn back', '← Library'); back.onclick = () => { closeBookPage(); showLibrary(false); };
  const head = el('div', 'nb-head');
  head.append(el('h1', '', fresh.length ? `New books (${fresh.length})` : 'New books'));
  head.append(el('p', 'nb-note', fresh.length ? 'Check the details Margin found. Type to correct anything (it saves as you go), or use Find online for books with little information. Press Done when a book looks right.' : 'All new books are checked.'));
  pg.append(back, head);
  if (!fresh.length) return;
  const list = el('div', 'nb-list'); pg.append(list);
  for (const b of fresh) {
    list.append(newRow(b));
    if (((!b.cover && !b.coverFailed) || b.year === undefined || b.metaV !== META_V) && !b.missing) makeCoverLater(b, async (nb) => {
      const row = list.querySelector(`.nb-row[data-id="${CSS.escape(nb.id)}"]`); if (!row) return;
      const fresh2 = await DB.getBook(nb.id); if (fresh2) row.replaceWith(newRow(fresh2, row));
    });
  }
  const all = el('button', 'btn', 'Mark all as checked');
  all.onclick = async () => { for (const b of fresh) if (b.fresh) await updateBook(b.id, { fresh: false }); showNewBooks(); };
  pg.append(el('div', 'nb-foot')); pg.lastChild.append(all);
}
// one new book: cover + editable details; keeps what is being typed when its details arrive
function newRow(b, old) {
  const row = el('div', 'nb-row'); row.dataset.id = b.id;
  const cv = el('button', 'nb-cover'); cv.title = 'Open the book page';
  if (b.cover && !b.plainCover) { const img = el('img'); img.src = b.cover; img.alt = ''; cv.append(img); } else cv.append(generatedCover(b));
  cv.onclick = () => showBookPage(b.id);
  const form = el('div', 'nb-fields');
  const field = (label, key, value, attrs = {}) => {
    const w = el('label', 'nb-f'); w.append(el('span', '', label));
    const inp = el('input'); inp.value = value || ''; Object.assign(inp, attrs); inp.dataset.k = key;
    const prev = old?.querySelector(`input[data-k="${key}"]`); if (prev && (prev === document.activeElement || prev.dataset.dirty)) { inp.value = prev.value; inp.dataset.dirty = prev.dataset.dirty || ''; }
    inp.oninput = () => (inp.dataset.dirty = '1');
    inp.onchange = async () => {
      const v = inp.value.trim(); const patch = {};
      if (key === 'year') { const y = parseInt(v, 10); patch.year = y >= 1000 && y <= 2100 ? y : null; }
      else if (key === 'author') { patch.author = v; patch.authorEdited = true; }
      else patch[key] = key === 'title' ? v || b.name : v;
      await updateBook(b.id, patch); Object.assign(b, patch); delete inp.dataset.dirty;
      if (key === 'title' || key === 'author') { const g = cv.querySelector('.gen'); if (g) g.replaceWith(generatedCover(b)); }
    };
    w.append(inp); form.append(w); return inp;
  };
  field('Title', 'title', b.title || b.name);
  field('Author', 'author', authorText(b), { placeholder: 'Unknown' });
  field('Year', 'year', b.year || '', { inputMode: 'numeric', maxLength: 4, placeholder: '—' });
  field('Publisher', 'publisher', b.publisher || '', { placeholder: '—' });
  const meta = el('div', 'nb-meta');
  const np = b.kind === 'epub' ? b.pages : b.count;
  meta.textContent = [(b.kind || 'pdf').toUpperCase(), np ? `${b.kind === 'epub' && b.pagesEstimated ? '~' : ''}${np}p` : '', sectionsOf(b).join(', '), b.description ? 'has a description' : 'no description yet'].filter(Boolean).join(' · ');
  const acts = el('div', 'nb-acts');
  const find = el('button', 'btn', 'Find online'); find.onclick = () => { openEditor(b); $('edFind').click(); };
  const more = el('button', 'btn', 'More details…'); more.onclick = () => openEditor(b);
  const done = el('button', 'btn primary', 'Done'); done.title = 'These details are right';
  done.onclick = async () => { await updateBook(b.id, { fresh: false }); row.classList.add('gone'); setTimeout(() => { row.remove(); if (!document.querySelector('.nb-row')) showNewBooks(); }, 200); };
  acts.append(find, more, done);
  const right = el('div', 'nb-right'); right.append(form, meta, acts);
  row.append(cv, right);
  return row;
}

function closeBookPage() {
  $('bookPage').hidden = true; $('catalog').hidden = !libBooks.length; $('intro').hidden = !!libBooks.length; $('folders').hidden = !IN_APP; $('libtools').hidden = false;
  $('welcome').scrollTop = pageScroll;
}

// author from the file or folder name: "Homage to Catalonia by George Orwell EPUB", "Homage to Catalonia - George Orwell.epub"
function guessFromPath(b) {
  if (b.author) return;
  const parts = String(b.path || b.name || '').split(/[\\/]/); const file = (parts.pop() || '').replace(/\.(pdf|epub)$/i, ''); const dir = parts.pop() || '';
  const junk = /\s+(?:e?pub|epub|pdf|mobi|azw3|ebook|e-book|rtr|retail|-?zak|\(\d{4}\)|\[.*?\])(?=\s|$).*$/i;
  for (const cand of [dir, file]) {
    const c = cand.replace(/_/g, ' ').replace(junk, '').trim();
    let m = c.match(/^(.{3,}?)\s+by\s+([A-Z][\w.'’\- ]{2,60})$/);
    if (m) { b.author = m[2].trim(); return; }
    // "Title - Author" or "Author - Title": the side that looks like a person's name
    m = c.match(/^(.{3,}?)\s+-\s+(.{3,})$/);
    if (m) {
      const isName = (x) => { const w = x.trim().split(/\s+/); return w.length >= 2 && w.length <= 4 && w.every((v) => /^[A-Z][\w.'’\-]*$/.test(v)) && !w.some((v) => /^(A|An|The|Of|And|In|To|For|On|With|Without|Or|My|Your|How|Why|What)$/.test(v)); };
      const [l, r] = [m[1].trim(), m[2].trim()];
      if (isName(r)) { b.author = r; return; }
      if (isName(l)) { b.author = l; return; }
    }
  }
}
const META_V = 1;
function fillMeta(b, m) {
  for (const k of ['publisher', 'description', 'language', 'isbn']) if (!b[k] && m[k]) b[k] = m[k];
  if (!(b.subjects || []).length && (m.subjects || []).length) b.subjects = m.subjects;
  b.metaV = META_V;
}

function tidyAuthor(a) {
  if (!a) return '';
  a = a.replace(/\s*\((author|editor|ed\.?|eds\.?|translator|trans\.?)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  const m = a.match(/^([^,;&]+),\s*([^,;&]+)$/); // "Last, First" -> "First Last"
  return m ? `${m[2].trim()} ${m[1].trim()}` : a;
}
const bookProgress = (b) => Math.max(0, Math.min(1, ((b.lastPage || 1) - 1 + (b.lastFrac || 0)) / Math.max(1, b.count || 1)));
// change a few fields of a book and save; keeps the open book's copy in step (it saves itself later)
async function updateBook(id, patch) {
  const b = await DB.getBook(id); if (!b) return null; Object.assign(b, patch); await DB.putBook(b);
  if (S.book?.id === id) Object.assign(S.book, patch);
  const i = libBooks.findIndex((x) => x.id === id); if (i >= 0) Object.assign(libBooks[i], patch);
  return b;
}
const EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
function bookCard(b) {
  const card = el('div', 'bk' + (b.missing ? ' missing' : '') + (b.star ? ' starred' : '') + (b.done ? ' done' : '')); card.setAttribute('role', 'listitem'); card.dataset.id = b.id;
  card.draggable = true;
  const open = el('button', 'bk-open'); open.title = `Open ${b.title || b.name}`;
  const cv = el('div', 'bk-cover');
  if (b.cover && !b.plainCover) { const img = el('img'); img.src = b.cover; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; cv.append(img); } else cv.append(generatedCover(b));
  if (b.year) { const yr = el('span', 'bk-year', String(b.year)); yr.title = 'Year published'; cv.append(yr); }
  open.append(cv);
  open.onclick = (e) => { if (e.detail > 1) return; clearTimeout(open._t); open._t = setTimeout(() => showBookPage(b.id), 230); };
  open.ondblclick = () => { clearTimeout(open._t); readBook(b); };
  open.title = `${b.title || b.name} — click for details, double-click to read`;
  const title = el('div', 'bk-title', b.title || b.name); title.title = b.path || b.title || b.name;
  const author = el('div', 'bk-author', authorText(b)); author.title = authorText(b);
  const prog = el('div', 'bk-prog'); const bar = el('i'); bar.style.width = (b.done ? 100 : b.opened ? Math.max(2, bookProgress(b) * 100) : 0) + '%'; prog.append(bar);
  const sub = el('div', 'bk-sub');
  const where = b.missing ? 'File not found' : b.done ? 'Read' : !b.opened ? 'New' : b.kind === 'epub' ? `${Math.round(bookProgress(b) * 100)}%` : `p. ${b.lastPage || 1}`;
  const right = el('span', 'bk-right');
  const np = b.kind === 'epub' ? b.pages : b.count;
  if (np) { const pg = el('span', 'bk-pages', `${b.kind === 'epub' && b.pagesEstimated ? '~' : ''}${np}p`); pg.title = b.kind === 'epub' && b.pagesEstimated ? `About ${np} printed page${np === 1 ? '' : 's'} (estimated from the length of the text)` : `${np} page${np === 1 ? '' : 's'}`; right.append(pg); }
  right.append(el('span', 'bk-kind', (b.kind || 'pdf').toUpperCase()));
  sub.append(el('span', '', where), right);
  const more = el('button', 'bk-more', '⋯'); more.title = 'Cover, shelves, remove'; more.setAttribute('aria-label', `Options for ${b.title || b.name}`);
  more.onclick = (e) => { e.stopPropagation(); openBookMenu(b, card); };
  card.confirmRemove = () => {
    if (card.querySelector('.bk-confirm')) return;
    const box = el('div', 'bk-confirm');
    box.append(el('div', '', b.folder ? 'Hide this book from the library? The file stays in your folder, and your notes are kept.' : 'Remove this book and its highlights and notes? Saved words stay.'));
    const yes = el('button', 'btn danger', b.folder ? 'Hide' : 'Remove'); const no = el('button', 'btn', 'Cancel');
    yes.onclick = () => (b.folder ? hideBook(b.id) : removeBook(b.id)); no.onclick = () => box.remove();
    box.append(yes, no); card.append(box); no.focus();
  };
  const star = el('button', 'bk-star'); star.innerHTML = STAR_SVG;
  const starLabel = () => { star.title = b.star ? 'Must read (click to unstar)' : 'Mark as must read'; star.setAttribute('aria-pressed', String(!!b.star)); };
  starLabel();
  star.onclick = async () => {
    b.star = !b.star; card.classList.toggle('starred', b.star); starLabel(); await updateBook(b.id, { star: b.star });
    updateStarFilter(); if (starOnly && !b.star) renderCatalog();
  };
  const eye = el('button', 'bk-eye'); eye.innerHTML = EYE_SVG;
  const eyeLabel = () => { eye.title = b.done ? 'Read (click to mark as not read)' : 'Mark as read'; eye.setAttribute('aria-pressed', String(!!b.done)); };
  eyeLabel();
  eye.onclick = async () => {
    b.done = !b.done; await updateBook(b.id, { done: b.done, doneAt: b.done ? Date.now() : null });
    updateStarFilter();
    if (readOnly && !b.done) renderCatalog(); else card.replaceWith(bookCard(b));
  };
  card.append(open, title, author, prog, sub, more, star, eye);
  return card;
}
async function hideBook(id) {
  const b = await DB.getBook(id); if (!b) return; b.hidden = true; await DB.putBook(b);
  if (S.book?.id === id) S.book.hidden = true; // the open book saves itself later; keep it hidden
  toast('Hidden. "Show hidden books" under Book folders brings it back.'); showLibrary(false);
}
async function removeBook(id) {
  const hls = await DB.hls(id);
  for (const h of hls) await DB.delHl(h.id);
  await DB.delFile(id); await DB.delBook(id);
  if (S.book?.id === id) { ttsStop(); S.book = null; store.set('lastBook', null); }
  toast('Removed from the library.'); showLibrary(false);
}
let libBooks = [];
let starOnly = store.get('starOnly', false), readOnly = store.get('readOnly', false), starFirst = store.get('starFirst', false);
function updateStarFilter() {
  const n = libBooks.filter((b) => b.star).length; const btn = $('bStarOnly');
  btn.classList.toggle('on', starOnly); btn.setAttribute('aria-pressed', String(starOnly));
  btn.querySelector('span').textContent = n ? `Must read (${n})` : 'Must read';
  const r = libBooks.filter((b) => b.done).length; const rb = $('bReadOnly');
  rb.classList.toggle('on', readOnly); rb.setAttribute('aria-pressed', String(readOnly));
  rb.querySelector('span').textContent = r ? `Read (${r})` : 'Read';
}
function renderCatalog() {
  const q = $('catSearch').value.trim().toLowerCase(); const sort = $('catSort').value;
  const key = (b) => (b.title || b.name || '').toLowerCase();
  if (shelf !== 'all' && shelf !== '__none' && !allSections().includes(shelf)) { shelf = 'all'; store.set('shelf', shelf); }
  renderShelves();
  const inShelf = (b) => shelf === 'all' || (shelf === '__none' ? !sectionsOf(b).length : sectionsOf(b).includes(shelf));
  const list = libBooks.filter((b) => inShelf(b) && (!q || key(b).includes(q) || (b.author || '').toLowerCase().includes(q)) && (!starOnly || b.star) && (!readOnly || b.done));
  updateStarFilter();
  list.sort(sort === 'mine' ? (a, b) => (a.order ?? -1e15 - (a.added || 0)) - (b.order ?? -1e15 - (b.added || 0)) // new books (no place yet) first
    : sort === 'title' ? (a, b) => key(a).localeCompare(key(b))
    : sort === 'author' ? (a, b) => (tidyAuthor(a.author).split(' ').pop() || '~').localeCompare(tidyAuthor(b.author).split(' ').pop() || '~') || key(a).localeCompare(key(b))
    : sort === 'added' ? (a, b) => (b.added || 0) - (a.added || 0)
    : sort === 'year' ? (a, b) => (a.year || 9999) - (b.year || 9999) || key(a).localeCompare(key(b))
    : (a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0));
  // "Starred first": must-read books lead, each group keeping the chosen order
  const shown = starFirst ? list.filter((b) => b.star).concat(list.filter((b) => !b.star)) : list;
  $('bStarFirst').classList.toggle('on', starFirst); $('bStarFirst').setAttribute('aria-pressed', String(starFirst));
  const grid = $('catGrid'); grid.innerHTML = '';
  for (const b of shown) grid.append(bookCard(b));
  $('catNone').hidden = !!list.length || !libBooks.length;
  $('catNone').textContent = q ? 'No books match that search.' : starOnly && readOnly ? 'No books are both starred and read.' : starOnly ? 'No must-read books yet. Click the star on a cover to add one.' : readOnly ? 'No books marked as read yet. Click the eye on a cover to mark one.' : 'No books match that search.';
  $('catCount').textContent = `${libBooks.length} book${libBooks.length === 1 ? '' : 's'}`;
}
async function showLibrary(rescan = true) {
  setView('library');
  const all = await DB.books(); libBooks = all.filter((b) => !b.hidden && b.kind !== 'text');
  const hiddenCount = all.length - libBooks.length; $('bUnhide').hidden = !hiddenCount; $('bUnhide').textContent = `Show hidden books (${hiddenCount})`;
  const has = libBooks.length > 0;
  $('welcome').classList.toggle('has-books', has);
  if (rescan) $('bookPage').hidden = true; // the Library button always returns to the shelves
  $('catalog').hidden = !has || !$('bookPage').hidden; $('intro').hidden = has;
  $('moveHint').hidden = !(IN_APP && !has);
  $('catSort').value = store.get('catSort', 'recent');
  renderCatalog();
  // remember exactly where the open book was; reading aloud carries on while the library is open
  if (S.book && !pagesEl.hidden) { S.readScroll = viewer.scrollTop; S.readPos = isEpub() ? visibleStart() : { page: S.current, char: 0 }; }
  $('welcome').hidden = false; pagesEl.hidden = true; viewer.scrollTop = 0;
  $('title').textContent = ''; document.title = 'Margin'; $('pagebox').hidden = true;
  const back = $('bBack'); back.hidden = !S.book;
  if (S.book) { back.textContent = `← Back to ${S.book.title || S.book.name}`; back.title = 'Return to where you were'; }
  if (rescan) scanFolders();
  for (const b of libBooks) if (!b.doiChecked && DOI_RE.test(b.title || b.name)) autoDoi(b);
  // fill in missing covers in the background
  for (const b of libBooks) if (((!b.cover && !b.coverFailed) || b.year === undefined || b.metaV !== META_V || (b.kind === 'epub' ? b.pages === undefined : !b.count)) && !b.missing) makeCoverLater(b, (nb) => {
    const card = $('catGrid').querySelector(`.bk[data-id="${CSS.escape(nb.id)}"]`);
    const i = libBooks.findIndex((x) => x.id === nb.id); if (i >= 0) libBooks[i] = nb;
    if (card) card.replaceWith(bookCard(nb));
  });
}
$('catSearch').addEventListener('input', debounce(renderCatalog, 120));
$('catSort').onchange = () => { store.set('catSort', $('catSort').value); renderCatalog(); };
$('bStarOnly').onclick = () => { starOnly = !starOnly; store.set('starOnly', starOnly); renderCatalog(); };
$('bStarFirst').onclick = () => { starFirst = !starFirst; store.set('starFirst', starFirst); renderCatalog(); };
$('bReadOnly').onclick = () => { readOnly = !readOnly; store.set('readOnly', readOnly); renderCatalog(); };

/* ---------------- Sections ----------------
   A book can be in several sections. Folders with 3+ books make sections by themselves
   (autoSection); choosing a book's sections by hand replaces that. */
let secPrefs = Object.assign({ list: [], rename: {}, drop: [] }, store.get('sections', {}));
let shelf = store.get('shelf', 'all');
const saveSecPrefs = () => store.set('sections', secPrefs);
// "Kachin books-20261109T100937Z-1-001" (a Google Drive download) -> "Kachin books"
const cleanSection = (n) => String(n).replace(/[-_ ]*\d{8}T\d{6}Z(?:-\d+)*$/i, '').replace(/[-_ ]+$/, '').trim() || String(n);
function sectionsOf(b) {
  const out = new Set(b.sections || []);
  if (b.autoSection && !b.sectionsSet && !secPrefs.drop.includes(b.autoSection)) out.add(secPrefs.rename[b.autoSection] || b.autoSection);
  return [...out];
}
function allSections() {
  const used = new Set(); for (const b of libBooks) for (const x of sectionsOf(b)) used.add(x);
  const extra = [...used].filter((n) => !secPrefs.list.includes(n)).sort((a, c) => a.localeCompare(c));
  if (extra.length) { secPrefs.list.push(...extra); saveSecPrefs(); }
  return secPrefs.list.slice();
}
function askName(question, current = '') {
  let n = null; try { n = prompt(question, current); } catch {}
  n = (n || '').trim(); return n || null;
}
function renderShelves() {
  const bar = $('shelves'); bar.innerHTML = '';
  const names = allSections();
  const count = (fn) => libBooks.filter(fn).length;
  const chip = (id, label, n) => {
    const c = el('button', 'shelf' + (shelf === id ? ' on' : '')); if (shelf === id && id !== 'all') c.title = 'Click again to show all books'; c.setAttribute('role', 'tab'); c.setAttribute('aria-selected', String(shelf === id));
    c.append(el('span', '', label)); if (n != null) c.append(el('span', 'n', String(n)));
    // clicking the shelf that is already chosen goes back to All
    c.onclick = () => { shelf = shelf === id && id !== 'all' ? 'all' : id; store.set('shelf', shelf); renderCatalog(); };
    if (id !== 'all' && id !== '__none') { // drop a cover on a section to add the book to it
      c.ondragover = (e) => { if (dragCard) { e.preventDefault(); c.classList.add('drop'); } };
      c.ondragleave = () => c.classList.remove('drop');
      c.ondrop = async (e) => {
        e.preventDefault(); c.classList.remove('drop'); if (!dragCard) return; droppedOnShelf = true;
        const b = libBooks.find((x) => x.id === dragCard.dataset.id); if (!b) return;
        const list = new Set(sectionsOf(b)); list.add(id); await setSections(b, [...list]);
        toast(`Added to ${id}.`); renderShelves();
      };
    }
    bar.append(c); return c;
  };
  const fresh = count((b) => b.fresh);
  if (fresh) { const c = el('button', 'shelf new'); c.append(el('span', '', 'New'), el('span', 'n', String(fresh))); c.title = 'Check the details of newly added books'; c.onclick = showNewBooks; bar.append(c); }
  chip('all', 'All', libBooks.length);
  for (const n of names) chip(n, n, count((b) => sectionsOf(b).includes(n)));
  const unsorted = count((b) => !sectionsOf(b).length);
  if (names.length && unsorted) chip('__none', 'Not on a shelf', unsorted);
  const add = el('button', 'shelf add', '+ New shelf'); add.onclick = () => { const n = askName('Name of the new shelf'); if (!n) return; if (!secPrefs.list.includes(n)) { secPrefs.list.push(n); saveSecPrefs(); } shelf = n; store.set('shelf', n); renderCatalog(); toast('Drag covers onto the shelf, or use ⋯ on a cover to add books.', 5000); };
  bar.append(add);
  if (shelf !== 'all' && shelf !== '__none') {
    const m = el('button', 'shelf more', '⋯'); m.title = `Options for ${shelf}`; m.onclick = (e) => { e.stopPropagation(); openShelfMenu(shelf, m); }; bar.append(m);
  }
}
async function setSections(b, list) {
  b.sections = [...new Set(list)]; b.sectionsSet = true;
  await updateBook(b.id, { sections: b.sections, sectionsSet: true });
}
function closeMenus() { document.querySelectorAll('.bk-menu, .shelf-menu').forEach((m) => m.remove()); $('bMenu')?.setAttribute('aria-expanded', 'false'); if (menuDirty) { menuDirty = false; renderCatalog(); } }
let menuDirty = false;
document.addEventListener('click', (e) => { if (!e.target.closest?.('.bk-menu, .shelf-menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
function menuItem(m, label, fn, cls = '') { const it = el('button', 'mi ' + cls, label); it.setAttribute('role', 'menuitem'); it.onclick = async (e) => { e.stopPropagation(); await fn(); }; m.append(it); return it; }
function openBookMenu(b, card) {
  closeMenus();
  const m = el('div', 'bk-menu'); m.setAttribute('role', 'menu');
  menuItem(m, 'Edit details…', () => { closeMenus(); openEditor(b); });
  menuItem(m, b.plainCover ? 'Use the book’s own cover' : 'Use a designed cover', async () => {
    b.plainCover = !b.plainCover; await updateBook(b.id, { plainCover: b.plainCover }); closeMenus(); card.replaceWith(bookCard(b));
  });
  m.append(el('div', 'ml', 'Shelves'));
  const mine = sectionsOf(b);
  for (const name of allSections()) {
    const lab = el('label', 'mc'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = mine.includes(name);
    cb.onchange = async () => { const cur = new Set(sectionsOf(b)); if (cb.checked) cur.add(name); else cur.delete(name); await setSections(b, [...cur]); menuDirty = true; renderShelves(); };
    lab.append(cb, el('span', '', name)); m.append(lab);
  }
  menuItem(m, '+ New shelf…', async () => {
    const n = askName('Name of the new shelf'); if (!n) return;
    if (!secPrefs.list.includes(n)) { secPrefs.list.push(n); saveSecPrefs(); }
    await setSections(b, [...sectionsOf(b), n]); menuDirty = true; closeMenus(); toast(`Added to ${n}.`);
  });
  m.append(el('div', 'msep'));
  menuItem(m, b.folder ? 'Hide from library' : 'Remove from library…', () => { closeMenus(); card.confirmRemove(); }, 'danger');
  card.append(m); m.querySelector('button, input')?.focus();
}
function openShelfMenu(name, anchor) {
  closeMenus();
  const m = el('div', 'shelf-menu'); m.setAttribute('role', 'menu');
  const books = () => libBooks.filter((b) => sectionsOf(b).includes(name));
  menuItem(m, 'Rename shelf…', async () => {
    const n = askName('New name for this shelf', name); if (!n || n === name) return;
    for (const b of books()) if (b.sections?.includes(name)) await setSections(b, b.sections.map((x) => (x === name ? n : x)));
    for (const [auto, shown] of Object.entries(secPrefs.rename)) if (shown === name) secPrefs.rename[auto] = n;
    for (const b of libBooks) if (b.autoSection && !b.sectionsSet && (secPrefs.rename[b.autoSection] || b.autoSection) === name) secPrefs.rename[b.autoSection] = n;
    secPrefs.list = secPrefs.list.map((x) => (x === name ? n : x)); saveSecPrefs();
    shelf = n; store.set('shelf', n); closeMenus(); renderCatalog();
  });
  menuItem(m, 'Designed covers for all books here', async () => { for (const b of books()) if (!b.plainCover) { b.plainCover = true; await updateBook(b.id, { plainCover: true }); } closeMenus(); renderCatalog(); });
  menuItem(m, 'Book covers for all books here', async () => { for (const b of books()) if (b.plainCover) { b.plainCover = false; await updateBook(b.id, { plainCover: false }); } closeMenus(); renderCatalog(); });
  m.append(el('div', 'msep'));
  menuItem(m, 'Delete shelf (books stay in the library)', async () => {
    let ok = true; try { ok = confirm(`Delete the shelf "${name}"? Its books stay in the library.`); } catch {}
    if (!ok) return;
    for (const b of books()) if (b.sections?.includes(name)) await setSections(b, b.sections.filter((x) => x !== name));
    for (const b of libBooks) if (b.autoSection && (secPrefs.rename[b.autoSection] || b.autoSection) === name && !secPrefs.drop.includes(b.autoSection)) secPrefs.drop.push(b.autoSection);
    secPrefs.list = secPrefs.list.filter((x) => x !== name); saveSecPrefs();
    shelf = 'all'; store.set('shelf', 'all'); closeMenus(); renderCatalog();
  }, 'danger');
  const r = anchor.getBoundingClientRect(), host = $('catalog').getBoundingClientRect();
  m.style.left = Math.max(0, r.left - host.left - 160) + 'px'; m.style.top = r.bottom - host.top + 6 + 'px';
  $('catalog').append(m);
}

/* drag covers to put the library in your own order ("My order") */
const BOOK_DRAG = 'application/x-margin-book';
let dragCard = null, droppedOnShelf = false;
const grid = $('catGrid');
grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.bk'); if (!card) return;
  dragCard = card; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(BOOK_DRAG, card.dataset.id);
  try { const img = card.querySelector('.bk-cover'); e.dataTransfer.setDragImage(img, img.offsetWidth / 2, img.offsetHeight / 2); } catch {}
  requestAnimationFrame(() => card.classList.add('dragging'));
});
grid.addEventListener('dragover', (e) => {
  if (!dragCard) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.bk');
  if (!over || over === dragCard || over.parentElement !== grid) return;
  const r = over.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2;
  const ref = after ? over.nextElementSibling : over;
  if (ref !== dragCard && dragCard.nextElementSibling !== ref) grid.insertBefore(dragCard, ref);
});
grid.addEventListener('drop', (e) => { if (dragCard) e.preventDefault(); });
grid.addEventListener('dragend', async () => {
  const card = dragCard; dragCard = null; if (!card) return;
  card.classList.remove('dragging');
  if (droppedOnShelf) { droppedOnShelf = false; renderCatalog(); return; } // added to a section: the order stays as it was
  // the order on screen becomes "My order" (books hidden by a search or the star filter keep their places)
  const shown = [...grid.querySelectorAll('.bk')].map((c) => c.dataset.id);
  const sort = $('catSort').value;
  let full;
  if (sort === 'mine') {
    const all = [...libBooks].sort((a, b) => (a.order ?? -1e15 - (a.added || 0)) - (b.order ?? -1e15 - (b.added || 0))).map((b) => b.id);
    const slots = all.map((id, i) => (shown.includes(id) ? i : -1)).filter((i) => i >= 0);
    full = all.slice(); slots.forEach((slot, k) => { full[slot] = shown[k]; });
  } else {
    full = shown.concat(libBooks.map((b) => b.id).filter((id) => !shown.includes(id)));
    $('catSort').value = 'mine'; store.set('catSort', 'mine');
    toast('Sorted by My order. Drag covers to arrange them.');
  }
  for (let i = 0; i < full.length; i++) { const b = libBooks.find((x) => x.id === full[i]); if (b && b.order !== i * 10) await updateBook(b.id, { order: i * 10 }); }
});
$('bOpen3').onclick = () => $('file').click();

/* ---------------- Book folders (the Margin app) ----------------
   Margin.exe lists the PDF and EPUB files in chosen folders (e.g. D:\8 BOOKS). New ones join the
   library without being copied; Margin reads them from the folder each time. */
const hostWaiting = new Map(); let hostSeq = 0;
if (IN_APP) chrome.webview.addEventListener('message', (e) => { const d = e.data; if (d && d.id && hostWaiting.has(d.id)) { hostWaiting.get(d.id)(d); hostWaiting.delete(d.id); } });
const hostScan = (root) => new Promise((res) => {
  const id = 'scan' + (++hostSeq); hostWaiting.set(id, res);
  hostCall((h) => h.ScanBooks(root, id));
  setTimeout(() => { if (hostWaiting.has(id)) { hostWaiting.delete(id); res({ files: [], error: 'Scanning took too long' }); } }, 120000);
});
let folders = [], scanning = null, lastScan = 0;
function setFolderStatus(t) { $('folderStatus').textContent = t; }
function renderFolders() {
  $('folders').hidden = !IN_APP;
  const list = $('folderList'); list.innerHTML = '';
  if (!folders.length) list.append(el('div', 'fnone', 'No folders yet. Add one and Margin brings in every PDF and EPUB inside it, and checks for new ones each time.'));
  for (const f of folders) {
    const row = el('div', 'frow'); const name = el('span', 'fpath', f); name.title = f;
    const x = el('button', 'linkbtn', 'Remove'); x.title = `Stop watching ${f} (its books stay in the library)`;
    x.onclick = async () => { folders = folders.filter((y) => y !== f); await saveFolders(); setFolderStatus(`Stopped watching ${f}.`); };
    row.append(name, x); list.append(row);
  }
}
async function loadFolders() {
  if (!IN_APP) return;
  try { folders = String((await HOST.GetFolders()) || '').split('\n').map((x) => x.trim()).filter(Boolean); } catch { folders = []; }
  renderFolders();
}
async function saveFolders() { await hostCall((h) => h.SetFolders(folders.join('\n'))); renderFolders(); }
async function scanFolders(force = false) {
  if (!IN_APP || !folders.length) return;
  if (scanning) return scanning;
  if (!force && Date.now() - lastScan < 30000) return;
  scanning = (async () => {
    setFolderStatus('Looking for new books…');
    const books = await DB.books(); const byId = new Map(books.map((b) => [b.id, b])); const seen = new Set();
    let added = 0; const errors = [];
    for (const root of folders) {
      const r = await hostScan(root);
      if (r.error) { errors.push(r.error); continue; }
      // a folder inside the book folder holding 3 or more books becomes a section ("Kachin books")
      const base = root.replace(/[\\/]+$/, '').length + 1;
      const topOf = (path) => { const parts = path.slice(base).split(/[\\/]/); return parts.length > 1 ? parts[0] : null; };
      const perTop = {}; for (const [path] of r.files) { const t = topOf(path); if (t) perTop[t] = (perTop[t] || 0) + 1; }
      for (const [path, size] of r.files) {
        const name = path.split(/[\\/]/).pop(); const id = `${name}-${size}`; seen.add(id);
        const top = topOf(path); const auto = top && perTop[top] >= 3 ? cleanSection(top) : null;
        const ex = byId.get(id);
        if (ex) {
          if (ex.folder && (ex.path !== path || ex.missing || (ex.autoSection || null) !== auto)) {
            Object.assign(ex, { path, missing: false, autoSection: auto }); await DB.putBook(ex);
            if (S.book?.id === id) Object.assign(S.book, { path, missing: false, autoSection: auto });
          }
          continue;
        }
        const b = { id, name: name.replace(/\.(pdf|epub)$/i, ''), size, added: Date.now(), lastPage: 1, kind: /\.epub$/i.test(name) ? 'epub' : 'pdf', path, folder: true, autoSection: auto };
        guessFromPath(b); b.fresh = true; // shown on the "New books" page until checked
        await DB.putBook(b); byId.set(id, b); added++;
      }
    }
    // a folder book whose file has gone (only judged when every folder could be read)
    if (!errors.length) for (const b of books) if (b.folder && !seen.has(b.id) && !b.missing) { b.missing = true; await DB.putBook(b); }
    lastScan = Date.now();
    setFolderStatus(errors.length ? `Couldn't read: ${errors.join('; ')}` : added ? `Added ${added} new book${added === 1 ? '' : 's'}.` : 'No new books.');
    if (added) {
      // straight to the new books, unless a book is open for reading: then just offer them
      if (libraryOpen() || !S.book) { await refreshLibBooks(); showNewBooks(); }
      else toastAction(`Found ${added} new book${added === 1 ? '' : 's'} in your book folders.`, 'Check them', () => { showLibrary(false).then(showNewBooks); });
    }
    if (!$('welcome').hidden) showLibrary(false);
  })();
  try { await scanning; } finally { scanning = null; }
}
$('bAddFolder').onclick = async () => {
  let p = ''; try { p = await HOST.PickFolder(); } catch {}
  if (!p) return;
  if (folders.some((f) => f.toLowerCase() === p.toLowerCase())) { setFolderStatus(`${p} is already a book folder.`); return; }
  folders.push(p); await saveFolders(); scanFolders(true);
};
$('bScan').onclick = () => scanFolders(true);
$('bUnhide').onclick = async () => { for (const b of await DB.books()) if (b.hidden) { b.hidden = false; await DB.putBook(b); } if (S.book) S.book.hidden = false; showLibrary(false); };
$('bOpen').onclick = $('bOpen2').onclick = () => $('file').click();

/* ---------------- Back up / restore ----------------
   One file with every book, highlight, note, saved word and setting. Moves a library from the
   browser version to the app (or to another computer). Layout: "MARGINBK1", 12-digit header
   length, JSON header, then the book files one after another. */
function downloadBlob(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function backupLibrary() {
  const books = await DB.books(); const hls = await idb('highlights', 'readonly', (s) => s.getAll()); const words = await DB.words();
  if (!books.length && !words.length) { toast('There is nothing to back up yet.'); return; }
  const settings = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('margin.')) settings[k] = localStorage.getItem(k); } } catch {}
  const parts = [], files = [];
  for (const b of books) { const blob = await DB.getFile(b.id); if (blob) { files.push({ id: b.id, size: blob.size, type: blob.type || '' }); parts.push(blob); } }
  const header = new TextEncoder().encode(JSON.stringify({ app: 'margin', version: 1, created: new Date().toISOString(), books, highlights: hls, words, settings, files }));
  const day = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob(['MARGINBK1', String(header.length).padStart(12, '0'), header, ...parts], { type: 'application/octet-stream' }), `Margin backup ${day}.marginbackup`);
  toast(`Backed up ${books.length} book${books.length === 1 ? '' : 's'}, ${hls.length} highlight${hls.length === 1 ? '' : 's'} and ${words.length} saved word${words.length === 1 ? '' : 's'}. The file is in your Downloads folder.`, 7000);
}
async function restoreLibrary(file) {
  try {
    const head = await file.slice(0, 21).text();
    if (!head.startsWith('MARGINBK1')) { toast('That file is not a Margin backup.'); return; }
    const n = parseInt(head.slice(9, 21), 10);
    const data = JSON.parse(await file.slice(21, 21 + n).text());
    toast('Restoring…');
    let off = 21 + n;
    for (const f of data.files || []) {
      const bytes = await file.slice(off, off + f.size).arrayBuffer(); off += f.size;
      await DB.putFile(f.id, new Blob([bytes], { type: f.type || '' }));
    }
    for (const b of data.books || []) { const ex = await DB.getBook(b.id); await DB.putBook(ex && (ex.opened || 0) > (b.opened || 0) ? ex : b); }
    for (const h of data.highlights || []) await DB.putHl(h);
    W.list = await DB.words();
    for (const w of data.words || []) {
      const ex = W.list.find((x) => x.id === w.id);
      if (!ex) { W.list.push(w); await DB.putWord(w); continue; }
      for (const c of w.contexts || []) if (!ex.contexts.some((x) => x.bookId === c.bookId && x.page === c.page)) ex.contexts.push(c);
      if (!ex.note && w.note) ex.note = w.note;
      if (!ex.def && w.def) { ex.def = w.def; ex.phonetic = w.phonetic; }
      await DB.putWord(ex);
    }
    try { for (const [k, v] of Object.entries(data.settings || {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v); } catch {}
    renderWords();
    toast(`Restored ${(data.books || []).length} books, ${(data.highlights || []).length} highlights and ${(data.words || []).length} saved words.`, 6000);
    showLibrary();
  } catch (err) { console.error(err); toast('That backup could not be read: ' + (err.message || err), 6000); }
}
$('bBackup').onclick = backupLibrary;
$('bRestore').onclick = () => $('restoreFile').click();
$('restoreFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreLibrary(f); };
$('file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f); };
// back to the open book, exactly where it was (no reloading, reading aloud keeps going)
function backToBook() {
  if (!S.book) return;
  setView('book'); if (S.notesStale) { S.notesStale = false; renderNotes(); }
  $('welcome').hidden = true; pagesEl.hidden = false; $('pagebox').hidden = false;
  $('title').textContent = S.book.title || S.book.name; document.title = (S.book.title || S.book.name) + ' · Margin';
  viewer.scrollTop = S.readScroll || 0; pumpRender();
  if (T.playing) markSpeaking();
}
$('bLib').onclick = () => {
  if (S.view !== 'library' && !$('bookPage').hidden) closeBookPage();
  showLibrary();
};
// Reader: back to the open book; with none open, the book read most recently
$('bReader').onclick = async () => {
  if (S.book) { if (libraryOpen()) backToBook(); return; }
  const last = (await DB.books()).filter((b) => b.opened).sort((a, b) => b.opened - a.opened)[0];
  if (last) openStored(last.id); else toast('Open a book from the Library first.');
};
// the Margin menu
$('bMenu').onclick = (e) => {
  e.stopPropagation();
  const open = document.querySelector('.app-menu'); closeMenus(); if (open) return;
  const m = el('div', 'shelf-menu app-menu'); m.setAttribute('role', 'menu');
  const go = (fn) => () => { closeMenus(); fn(); };
  menuItem(m, 'Open a book…', go(() => $('bOpen').click())).append(el('kbd', '', 'PDF, EPUB'));
  if (IN_APP) {
    menuItem(m, 'Add a book folder…', go(() => $('bAddFolder').click()));
    menuItem(m, 'Look for new books now', go(() => { if (!libraryOpen() || S.view !== 'library') $('bLib').click(); $('bScan').click(); }));
  }
  m.append(el('div', 'msep'));
  menuItem(m, 'Back up library…', go(() => $('bBackup').click()));
  menuItem(m, 'Restore from a backup…', go(() => $('bRestore').click()));
  m.append(el('div', 'msep'));
  menuItem(m, document.fullscreenElement ? 'Leave full screen' : 'Full screen', go(() => $('bFull').click())).append(el('kbd', '', 'F11'));
  m.append(el('div', 'msep'), el('div', 'ml', 'Colours'));
  const cur = store.get('theme', 'dark');
  for (const [v, label] of [['onyx', 'Onyx (black)'], ['dark', 'Dark'], ['light', 'Light'], ['auto', 'Same as Windows']]) {
    const it = menuItem(m, label, go(() => { store.set('theme', v); applyTheme(); }));
    it.setAttribute('role', 'menuitemradio'); it.setAttribute('aria-checked', String(cur === v));
    it.append(el('kbd', '', cur === v ? '✓' : ''));
  }
  $('bMenu').after(m); $('bMenu').setAttribute('aria-expanded', 'true');
  m.querySelector('button')?.focus();
};

$('bBack').onclick = backToBook;
const drop = $('drop');
viewer.addEventListener('dragover', (e) => { e.preventDefault(); if (!dragCard) drop.classList.add('over'); });
viewer.addEventListener('dragleave', () => drop.classList.remove('over'));
viewer.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (dragCard) return; const f = e.dataTransfer.files[0]; if (f) openFile(f); });

/* ---------------- Zoom / tone / keys ---------------- */
$('bZoomIn').onclick = () => setZoom((s) => (isEpub() ? s + 2 : s * 1.15));
$('bZoomOut').onclick = () => setZoom((s) => (isEpub() ? s - 2 : s / 1.15));
$('bFit').onclick = () => { if (isEpub()) { setZoom(() => 19); return; } S.fit = true; computeFitScale(); relayout(); sizeLabel(); };
$('bFit').classList.add('on');
addEventListener('resize', debounce(() => { if (S.doc && S.fit) { const old = S.scale; computeFitScale(); if (Math.abs(old - S.scale) > 0.01) relayout(); } }, 200));
// the app's colours: dark (the default), light, or whatever Windows uses
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themeIsDark = () => { const t = store.get('theme', 'dark'); return t === 'dark' || t === 'onyx' || (t === 'auto' && darkQuery.matches); };
function applyTheme() {
  const t = store.get('theme', 'dark');
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = themeIsDark();
  if (IN_APP) hostCall((h) => h.SetDark(dark));
  try { if (mini && !mini.closed) { mini.document.documentElement.classList.toggle('dark', dark); mini.document.documentElement.classList.toggle('onyx', t === 'onyx'); } } catch {}
}
darkQuery.addEventListener('change', applyTheme);
applyTheme();
const tone = $('tone');
const applyTone = () => { document.body.classList.remove('tone-sepia', 'tone-night'); if (tone.value !== 'paper') document.body.classList.add('tone-' + tone.value); store.set('tone', tone.value); };
tone.value = store.get('tone', 'paper'); applyTone(); tone.onchange = applyTone;
// full screen: the whole window (in the app, Margin.exe fills the screen when the page asks)
const FULL_ON = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', FULL_OFF = '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>';
async function toggleFull() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch { toast('Full screen is not available here.'); }
}
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement; const b = $('bFull');
  b.querySelector('svg').innerHTML = on ? FULL_OFF : FULL_ON; b.title = on ? 'Leave full screen (F11 or Esc)' : 'Full screen (F11)'; b.classList.toggle('on', on);
});
$('bFull').onclick = toggleFull;
$('pageIn').addEventListener('change', (e) => { const n = parsePageInput(e.target.value); if (n) goTo(n); e.target.blur(); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select')) return;
  if (e.key === ' ' && S.book) { e.preventDefault(); togglePlay(); }
  else if ((e.key === '+' || e.key === '=') && !e.ctrlKey) $('bZoomIn').click();
  else if (e.key === '-' && !e.ctrlKey) $('bZoomOut').click();
  else if (e.key === 's' || e.key === 'S') toggleSide();
  else if (e.key === 'F11') { e.preventDefault(); toggleFull(); }
  else if (e.key === 'Escape') { hideMenu(); getSelection().removeAllRanges(); }
});

/* ================================================================
   Read aloud
   ================================================================ */
const KOKORO_VOICES = [
  ['af_heart', 'Heart (US, female)'], ['af_bella', 'Bella (US, female)'], ['af_nicole', 'Nicole (US, female)'], ['af_sarah', 'Sarah (US, female)'], ['af_sky', 'Sky (US, female)'],
  ['am_michael', 'Michael (US, male)'], ['am_fenrir', 'Fenrir (US, male)'], ['am_puck', 'Puck (US, male)'],
  ['bf_emma', 'Emma (UK, female)'], ['bf_isabella', 'Isabella (UK, female)'], ['bm_george', 'George (UK, male)'], ['bm_fable', 'Fable (UK, male)'],
];
const T = {
  engine: store.get('engine', ANDROID ? 'system' : 'kokoro'), voice: null, speed: store.get('speed', 1), follow: store.get('follow', true),
  playing: false, paused: false, token: 0, page: 0, idx: 0, sents: [],
  worker: null, ready: false, loading: null, reqId: 0, pending: new Map(), audio: new Map(), ctx: null, src: null, wake: null,
};
const engineSel = $('engine'), voiceSel = $('voice'), speedSel = $('speed');
/* Margin's own volume, separate from the computer's: the neural voice changes at once,
   the system voice from the next sentence. Up to 150% for the neural voice (quiet books). */
T.volume = Math.max(0, Math.min(1.5, +store.get('volume', 1) || 0));
T.muted = false;
function volumeOut() {
  T.ctx ??= new AudioContext();
  if (!T.gain) { T.gain = T.ctx.createGain(); T.gain.connect(T.ctx.destination); }
  T.gain.gain.value = T.muted ? 0 : T.volume;
  return T.gain;
}
function showVolume() {
  const v = T.muted ? 0 : T.volume, pct = Math.round(v * 100);
  const r = $('volume'); if (+r.value !== Math.round(T.volume * 100)) r.value = Math.round(T.volume * 100);
  r.style.setProperty('--fill', (Math.round(T.volume * 100) / 1.5) + '%');
  r.title = `Volume ${pct}%` + (T.engine === 'system' && T.volume > 1 ? ' (the system voice stops at 100%)' : '');
  $('volPct').textContent = pct + '%';
  const b = $('bVol'); b.classList.toggle('muted', v === 0); b.title = v === 0 ? 'Sound off. Click to turn it back on' : 'Click to turn the sound off';
  b.querySelector('.w1').style.opacity = v > 0 ? 1 : 0; b.querySelector('.w2').style.opacity = v > 0.66 ? 1 : 0; b.querySelector('.x').style.opacity = v === 0 ? 1 : 0;
  if (T.gain) T.gain.gain.setTargetAtTime(v, T.ctx.currentTime, 0.03);
}
$('volume').addEventListener('input', (e) => { T.volume = +e.target.value / 100; T.muted = false; store.set('volume', T.volume); showVolume(); });
$('volume').addEventListener('wheel', (e) => { e.preventDefault(); const r = $('volume'); r.value = Math.max(0, Math.min(150, +r.value + (e.deltaY < 0 ? 5 : -5))); r.dispatchEvent(new Event('input')); }, { passive: false });
$('bVol').onclick = () => { if (T.volume === 0) { T.volume = 1; store.set('volume', 1); T.muted = false; } else T.muted = !T.muted; showVolume(); };
showVolume();
engineSel.value = T.engine; speedSel.value = String(T.speed); $('bFollow').classList.toggle('on', T.follow);

function setStatus(html, progress) {
  $('statusText').innerHTML = html; miniSync();
  const pr = $('prog'); if (progress == null) pr.hidden = true; else { pr.hidden = false; $('progBar').style.width = Math.round(progress * 100) + '%'; }
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function fillVoices() {
  voiceSel.innerHTML = '';
  if (T.engine === 'kokoro') {
    for (const [id, name] of KOKORO_VOICES) voiceSel.append(new Option(name, id));
    voiceSel.value = store.get('voice.kokoro', 'af_heart');
  } else {
    const vs = speechSynthesis.getVoices();
    const sorted = vs.slice().sort((a, b) => (b.lang.startsWith('en') - a.lang.startsWith('en')) || a.name.localeCompare(b.name));
    for (const v of sorted) voiceSel.append(new Option(`${v.name.replace(/^Microsoft /, '')} (${v.lang})${v.localService ? '' : ' · online'}`, v.voiceURI));
    if (!vs.length) voiceSel.append(new Option('Default voice', ''));
    const saved = store.get('voice.system', null); if (saved && vs.some((v) => v.voiceURI === saved)) voiceSel.value = saved;
  }
  T.voice = voiceSel.value;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { if (T.engine === 'system') fillVoices(); };
fillVoices();
const restartIfPlaying = () => { T.audio.clear(); if (T.playing) { const s = T.sents[T.idx]; ttsPlay(T.page, s ? s.start : 0); } };
engineSel.onchange = () => { T.engine = engineSel.value; store.set('engine', T.engine); fillVoices(); syncDeviceVis(); restartIfPlaying(); };
voiceSel.onchange = () => { T.voice = voiceSel.value; store.set('voice.' + T.engine, T.voice); restartIfPlaying(); };
speedSel.onchange = () => { T.speed = +speedSel.value; store.set('speed', T.speed); restartIfPlaying(); };
const deviceSel = $('device'); deviceSel.value = store.get('kokoroDevice', 'wasm');
const syncDeviceVis = () => { deviceSel.hidden = T.engine !== 'kokoro'; };
deviceSel.onchange = () => {
  store.set('kokoroDevice', deviceSel.value);
  const was = T.playing ? (T.sents[T.idx]?.start ?? 0) : null, pg = T.page;
  ttsStop(); T.worker?.terminate(); T.worker = null; T.ready = false; T.loading = null; T.audio.clear(); T.waits = 0;
  setStatus(deviceSel.value === 'webgpu' ? 'GPU mode: the first time, this downloads a larger voice file (about 330 MB).' : 'CPU mode selected.');
  if (was != null) ttsPlay(pg, was + 0.5);
};
T.wordMarks = store.get('wordMarks', true);
$('bFollow').onclick = () => { T.follow = !T.follow; store.set('follow', T.follow); $('bFollow').classList.toggle('on', T.follow); };

/* ---- text extraction: page → clean sentences mapped to text-layer spans ---- */
async function pageSentences(n) {
  const { tc, view } = await getText(n);
  const H = view[3] - view[1], y0 = view[1];
  const items = tc.items;
  const heights = items.filter((i) => i.str && i.str.trim()).map((i) => i.height).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1] || 10;
  let text = ''; const ranges = new Array(items.length).fill(null); let prevEOL = false;
  for (let k = 0; k < items.length; k++) {
    const it = items[k]; const s = it.str;
    if (s === undefined) continue;
    const y = it.transform[5] - y0;
    const header = y > H * 0.915 && s.length < 90 && it.height <= medH * 1.3;
    const folio = y < H * 0.075 && /^\s*[\dixvlc]+\s*$/i.test(s);
    const supNum = it.height < medH * 0.75 && /^\s*\d{1,3}\s*$/.test(s);
    if (!s || header || folio || supNum) { if (it.hasEOL) prevEOL = true; continue; }
    if (prevEOL) {
      if (/[a-z][-­‐]$/.test(text) && /^[a-z]/.test(s)) text = text.slice(0, -1);
      else if (text && !/\s$/.test(text)) text += ' ';
    }
    const start = text.length; text += s; ranges[k] = [start, text.length]; prevEOL = !!it.hasEOL;
  }
  const res = splitSentences(text, ranges);
  res.ranges = ranges; res.text = text;
  return res;
}
const unitSentences = (n) => (isEpub() ? epubSentences(n) : pageSentences(n));
function splitSentences(text, ranges) {
  // split into sentences (a line break from the book is always a boundary)
  const sents = []; const re = /[^.!?…\n]+(?:[.!?…]+["'”’)\]]*(?:\d{1,3}(?=\s))?|(?=\n)|$)[^\S\n]*/g; let m;
  while ((m = re.exec(text))) { if (!m[0]) { re.lastIndex++; continue; } if (m[0].trim()) sents.push({ start: m.index, end: m.index + m[0].length }); }
  // merge abbreviations / tiny fragments into the next sentence
  const abbrev = /\b(?:Mr|Mrs|Ms|Dr|St|vol|ed|eds|no|pp|p|cf|vs|ca|etc|i\.e|e\.g|U\.S|Jr|Sr|Prof|Gen|Col|Lt|Capt|Rev|Ch|chap|fig)\.\s*$/i;
  const merged = [];
  for (const s of sents) {
    const prev = merged[merged.length - 1];
    const joinable = prev && !text.slice(prev.start, s.start).includes('\n');
    if (joinable && (abbrev.test(text.slice(prev.start, prev.end)) || /\b[A-Z]\.\s*$/.test(text.slice(prev.start, prev.end)) || prev.end - prev.start < 18)) prev.end = s.end; else merged.push({ ...s });
  }
  // split very long sentences at commas / semicolons
  const out = [];
  for (const s of merged) {
    let a = s.start;
    while (s.end - a > MAX_CHUNK) {
      const chunk = text.slice(a, a + MAX_CHUNK);
      const punct = Math.max(chunk.lastIndexOf('; '), chunk.lastIndexOf(', '), chunk.lastIndexOf(': '), chunk.lastIndexOf('—'), chunk.lastIndexOf(' – '));
      const space = chunk.lastIndexOf(' ');
      const b = a + (punct > 70 ? punct + 1 : space > 70 ? space : MAX_CHUNK);
      out.push({ start: a, end: b }); a = b;
    }
    out.push({ start: a, end: s.end });
  }
  for (const s of out) {
    // drop footnote numbers glued to words ("history.5 The", "a state.6")
    s.text = text.slice(s.start, s.end).replace(/(?<=\p{L}[)\]]?[.,;:!?][”’"')\]]?|\p{L}[”’"])\d{1,3}(?=\s|$)/gu, '').replace(/\s+/g, ' ').trim();
    s.items = []; if (ranges) for (let k = 0; k < ranges.length; k++) { const r = ranges[k]; if (r && r[1] > s.start && r[0] < s.end) s.items.push(k); }
    // word positions on the page (raw) and in the spoken text (clean), matched by order
    s.words = []; const wre = /\S+/g; let w; const raw = text.slice(s.start, s.end);
    while ((w = wre.exec(raw))) s.words.push([s.start + w.index, s.start + w.index + w[0].length]);
    s.spoken = []; const sre = /\S+/g; while ((w = sre.exec(s.text))) s.spoken.push([w.index, w[0]]);
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s.text));
}
const MAX_CHUNK = 230;
function selectionPosition() {
  const sel = getSelection(); if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0); let node = r.startContainer; const offset = node.nodeType === 3 ? r.startOffset : 0;
  if (isEpub()) { const p = sectionOf(node); return p ? { page: p.num, char: posOf(p, r.startContainer, r.startOffset) } : null; }
  const span = (node.nodeType === 3 ? node.parentElement : node).closest('.textLayer span:not(.markedContent)');
  const pdiv = (span || node.parentElement)?.closest('.page'); if (!pdiv) return null;
  const p = S.pages[+pdiv.dataset.page - 1]; if (!p.textLayer || !span) return { page: p.num, char: 0 };
  const k = p.textLayer.textDivs.indexOf(span);
  return { page: p.num, item: k, offset };
}

/* ---- Kokoro worker ---- */
function ensureKokoro() {
  if (T.ready) return Promise.resolve();
  if (T.loading) return T.loading;
  const files = new Map();
  T.loading = new Promise(async (resolve, reject) => {
    try {
      if (IN_APP) { const src = await (await fetch('./tts-worker.js')).text(); T.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' }); }
      else T.worker = new Worker('./tts-worker.js', { type: 'module' });
    } catch (err) { T.loading = null; reject(err); return; }
    T.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'stored') { T.voiceStored = m.stored; }
      else if (m.type === 'progress') {
        const p = m.p; if (p.status === 'progress' && p.total) files.set(p.file, [p.loaded, p.total]);
        let L = 0, Tt = 0; files.forEach(([l, t]) => { L += l; Tt += t; });
        const pct = Math.round((L / Tt) * 100);
        if (Tt > 1e6) setStatus(T.voiceStored ? `Loading the voice from this computer… ${pct}%` : `Downloading the neural voice (one time only, about ${Math.round(Tt / 1e6)} MB)… ${pct}%`, L / Tt);
        else setStatus('Starting the neural voice…');
      } else if (m.type === 'ready') {
        T.ready = true; T.deviceUsed = m.device;
        const where = m.device === 'webgpu' ? 'using the graphics card' : `using ${m.threads > 1 ? m.threads + ' CPU cores' : '1 CPU core'}`;
        setStatus(`Neural voice ready (${where}${m.storedAfter ? ', saved on this computer' : ''}).`);
        if (m.storedAfter === false) toast('The voice could not be saved on this computer, so it will download again next time. Your disk may be nearly full, or the browser is clearing site data when it closes.', 10000);
        if (store.get('kokoroDevice', 'wasm') === 'webgpu' && m.device !== 'webgpu') toast('This computer could not use the graphics card for the voice, so it is using the CPU.', 5000);
        resolve();
      }
      else if (m.type === 'audio') { T.pending.get(m.id)?.resolve(m); T.pending.delete(m.id); }
      else if (m.type === 'error') {
        if (m.id != null) { T.pending.get(m.id)?.reject(new Error(m.message)); T.pending.delete(m.id); }
        else { T.loading = null; T.worker.terminate(); T.worker = null; reject(new Error(m.message)); }
      }
    };
    T.worker.onerror = (e) => { T.loading = null; reject(new Error(e.message || 'The voice worker failed to start.')); };
    setStatus('Starting the neural voice…');
    T.worker.postMessage({ type: 'load', device: store.get('kokoroDevice', 'wasm') });
    T.workerStarted = performance.now();
  });
  return T.loading;
}
function kokoroAudio(key, text) {
  if (!T.audio.has(key)) {
    const id = ++T.reqId;
    const p = new Promise((resolve, reject) => { T.pending.set(id, { resolve, reject }); });
    T.worker.postMessage({ type: 'gen', id, text, voice: T.voice || 'af_heart', speed: T.speed });
    p.catch(() => T.audio.delete(key));
    T.audio.set(key, p);
    if (T.audio.size > 40) T.audio.delete(T.audio.keys().next().value);
  }
  return T.audio.get(key);
}
const akey = (page, i) => `${page}:${i}:${T.voice}:${T.speed}`;

const AHEAD = 8; // keep plenty of ready audio queued so playback never runs dry
async function speakKokoro(sent, page, i, tok) {
  const got = kokoroAudio(akey(page, i), sent.text);
  for (let j = i + 1; j <= i + AHEAD && j < T.sents.length; j++) kokoroAudio(akey(page, j), T.sents[j].text);
  if (i + AHEAD >= T.sents.length && page < S.count) Promise.resolve(unitSentences(page + 1)).then((ns) => { if (tok !== T.token) return; for (let j = 0; j < Math.min(2, i + AHEAD - T.sents.length + 1) && ns[j]; j++) kokoroAudio(akey(page + 1, j), ns[j].text); });
  let underrun = false;
  let waitTimer = setTimeout(() => { underrun = true; if (tok === T.token) setStatus(`<b>${esc(unitLabel(page))}</b> · Getting a few sentences ready…`); T.waits = (T.waits || 0) + 1; if (T.waits === 3 && T.deviceUsed !== 'webgpu') toast('The voice can’t keep up on this computer’s CPU. Try “GPU” in the bottom bar for smooth reading.', 8000); }, 250);
  let clip;
  try { clip = await got; } catch (err) { console.warn('skipping chunk:', err); clearTimeout(waitTimer); return; }
  clearTimeout(waitTimer); if (tok !== T.token) return;
  // if we ran dry, build a small cushion first: one longer pause instead of many short ones
  if (underrun) {
    const next = []; for (let j = i + 1; j <= i + 3 && j < T.sents.length; j++) next.push(kokoroAudio(akey(page, j), T.sents[j].text).catch(() => {}));
    await Promise.race([Promise.all(next), new Promise((r) => setTimeout(r, 15000))]);
    if (tok !== T.token) return;
  }
  setStatus(`<b>${esc(unitLabel(page))}</b> · ${esc(sent.text)}`);
  const { pcm, sr } = clip;
  T.ctx ??= new AudioContext();
  if (T.ctx.state === 'suspended' && !T.paused) await T.ctx.resume();
  const buf = T.ctx.createBuffer(1, pcm.length, sr); buf.copyToChannel(pcm, 0);
  const src = T.ctx.createBufferSource(); src.buffer = buf; src.connect(volumeOut());
  T.src = src;
  const times = wordTimes(sent, pcm, sr); const startAt = T.ctx.currentTime + 0.02;
  let ended = false;
  const tick = () => {
    if (ended || tok !== T.token) return;
    const t = T.ctx.currentTime - startAt; let w = 0; while (w + 1 < times.length && times[w + 1] <= t) w++;
    if (t >= 0) markWord(Math.min(w, sent.words.length - 1));
    nextFrame(tick);
  };
  await new Promise((res) => { src.onended = () => { ended = true; res(); }; src.start(startAt); nextFrame(tick); });
  T.src = null;
}
function speakSystem(sent, tok) {
  return new Promise((res) => {
    const u = new SpeechSynthesisUtterance(sent.text);
    const v = speechSynthesis.getVoices().find((v) => v.voiceURI === T.voice); if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = T.speed; u.volume = Math.min(1, T.volume); u.onend = u.onerror = () => res();
    u.onboundary = (e) => { if (tok === T.token && (e.name === 'word' || e.name === undefined)) markWord(wordAtChar(sent, e.charIndex)); };
    T.utter = u; speechSynthesis.speak(u);
  });
}
function clearSpeaking() { if (hasCssHL()) { CSS.highlights.delete('speak-sent'); CSS.highlights.delete('speak-word'); } document.querySelectorAll('.textLayer span.speaking').forEach((s) => s.classList.remove('speaking')); clearWord(); }
function clearWord() { document.querySelectorAll('.wordmark').forEach((m) => m.remove()); T.wordIdx = -1; }
// put a soft marker under word w of the current sentence
// the word clock. Windows stops drawing the main window when it is minimized or covered, which would stop
// the word following; the mini window stays on top and keeps drawing, so its frames drive the clock too
function nextFrame(fn) {
  let done = false, timer = 0; const run = () => { if (!done) { done = true; clearTimeout(timer); fn(); } };
  if (miniOpen()) { try { mini.requestAnimationFrame(run); } catch {} }
  if (!document.hidden) requestAnimationFrame(run);
  timer = setTimeout(run, 150); // last resort, e.g. the mini window was just closed
}
function markWord(w) {
  if (miniOpen()) { const k = T.page + ':' + T.idx; if (w !== T.miniW || k !== T.miniKey) { T.miniW = w; T.miniKey = k; T.miniWordsOn = true; miniCaption(); } }
  if (!T.wordMarks || w === T.wordIdx) return; T.wordIdx = w;
  if (isEpub()) {
    const s = T.sents[T.idx], p = S.pages[T.page - 1]; if (!s || !p || !s.words[w] || !hasCssHL()) return;
    const r = rangeFromPos(p, s.words[w][0], s.words[w][1]); if (!r) return;
    CSS.highlights.set('speak-word', new Highlight(r)); followRect(r.getClientRects()[0], 30); return;
  }
  const s = T.sents[T.idx]; const p = S.pages[T.page - 1]; const ranges = T.sents.ranges;
  if (!s || !p || !p.textLayer || !s.words[w] || !ranges) return;
  const [ws, we] = s.words[w]; const rects = [];
  for (const k of s.items) {
    const r = ranges[k]; if (!r || r[1] <= ws || r[0] >= we) continue;
    const span = p.textLayer.textDivs[k]; const node = span?.firstChild; if (!node || node.nodeType !== 3) continue;
    const len = node.length; const a = Math.max(0, Math.min(len, ws - r[0])), b = Math.max(a, Math.min(len, we - r[0]));
    if (b <= a) continue;
    const rg = document.createRange(); rg.setStart(node, a); rg.setEnd(node, b);
    rects.push(...rg.getClientRects());
  }
  let layer = p.div.querySelector('.wordLayer');
  if (!layer) { layer = el('div', 'wordLayer'); (p.tl ? p.tl.before(layer) : p.div.append(layer)); }
  const marks = [...layer.children];
  const b = p.div.getBoundingClientRect();
  rects.forEach((r, i) => {
    const m = marks[i] || layer.appendChild(el('div', 'wordmark'));
    Object.assign(m.style, { left: r.left - b.left - 1 + 'px', top: r.top - b.top + 'px', width: r.width + 2 + 'px', height: r.height + 'px' });
  });
  marks.slice(rects.length).forEach((m) => m.remove());
  if (T.follow && rects[0] && !libraryOpen()) { const v = viewer.getBoundingClientRect(); if (rects[0].bottom > v.bottom - 30 || rects[0].top < v.top + 20) viewer.scrollBy({ top: rects[0].top - v.top - viewer.clientHeight * 0.3, behavior: 'smooth' }); }
}
// word index in the sentence from a character position in the spoken text
function wordAtChar(s, c) { let w = 0; for (let i = 0; i < s.spoken.length; i++) { if (s.spoken[i][0] <= c) w = i; else break; } return Math.min(w, s.words.length - 1); }
// estimate when each word starts inside a generated clip: letters + pauses at punctuation
function wordTimes(s, pcm, sr) {
  const thr = 0.012; let a = 0, z = pcm.length - 1;
  while (a < z && Math.abs(pcm[a]) < thr) a++; while (z > a && Math.abs(pcm[z]) < thr) z--;
  const t0 = a / sr, t1 = z / sr;
  const weights = s.spoken.map(([, w]) => { const letters = w.replace(/[^\p{L}\p{N}]/gu, '').length; let x = 1.2 + letters * (/\d/.test(w) ? 2.2 : 1); if (/[,;:—–]$/.test(w)) x += 3.5; if (/[.!?…][”’"')]?$/.test(w)) x += 5; return x; });
  const total = weights.reduce((x, y) => x + y, 0) || 1; const times = []; let acc = 0;
  for (const wgt of weights) { times.push(t0 + (acc / total) * (t1 - t0)); acc += wgt; }
  return times;
}
function followRect(rc, margin) {
  if (!T.follow || !rc || libraryOpen()) return; const v = viewer.getBoundingClientRect();
  if (rc.bottom > v.bottom - margin || rc.top < v.top + margin) viewer.scrollBy({ top: rc.top - v.top - viewer.clientHeight * 0.3, behavior: 'smooth' });
}
function markSpeaking() {
  clearSpeaking();
  const s = T.sents[T.idx]; const p = S.pages[T.page - 1]; if (!s || !p) return;
  if (isEpub()) { const r = rangeFromPos(p, s.start, s.end); if (r && hasCssHL()) { CSS.highlights.set('speak-sent', new Highlight(r)); followRect(r.getClientRects()[0], 40); } return; }
  let firstSpan = null;
  if (p.textLayer) for (const k of s.items) { const d = p.textLayer.textDivs[k]; if (d) { d.classList.add('speaking'); firstSpan ??= d; } }
  if (T.follow && !libraryOpen()) {
    const target = firstSpan || p.div; const r = target.getBoundingClientRect(), v = viewer.getBoundingClientRect();
    if (r.top < v.top + 40 || r.bottom > v.bottom - 40) {
      if (firstSpan) viewer.scrollBy({ top: r.top - v.top - viewer.clientHeight * 0.3, behavior: 'smooth' });
      else viewer.scrollTo({ top: p.div.offsetTop - 12, behavior: 'smooth' });
    }
  }
}
async function ttsPlay(page, char = 0) {
  if (!S.book) { toast('Open a book first.'); return; }
  haltAudio();
  const tok = ++T.token; T.playing = true; T.paused = false; playUI();
  if (typeof char === 'object') char = 0;
  try {
    if (T.engine === 'kokoro') {
      try { await ensureKokoro(); }
      catch (err) {
        if (tok !== T.token) return;
        console.warn(err);
        toast('The neural voice could not load (it needs internet the first time). Using the system voice for now.', 5000);
        T.engine = 'system'; engineSel.value = 'system'; fillVoices();
      }
      if (tok !== T.token) return;
    }
    try { navigator.wakeLock?.request('screen').then((w) => (T.wake = w)).catch(() => {}); } catch {}
    let first = true;
    while (tok === T.token && page <= S.count) {
      const sents = await unitSentences(page); if (tok !== T.token) return;
      T.page = page; T.sents = sents;
      let i = 0;
      if (first && T.startItem != null) { const st = T.startItem; T.startItem = null; i = Math.max(0, sents.findIndex((s) => s.items.some((k) => k >= st))); }
      else if (first && char) { i = sents.findIndex((s) => s.end > char); if (i < 0) i = 0; }
      first = false;
      for (; i < sents.length; i++) {
        if (tok !== T.token) return;
        T.idx = i; T.wordIdx = -1; markSpeaking(); markWord(0); mediaMeta(page, sents[i]);
        setStatus(`<b>${esc(unitLabel(page))}</b> · ${esc(sents[i].text)}`);
        if (T.engine === 'kokoro') await speakKokoro(sents[i], page, i, tok);
        else {
          const t0 = performance.now(); await speakSystem(sents[i], tok);
          T.fast = performance.now() - t0 < 120 && sents[i].text.length > 20 ? (T.fast || 0) + 1 : 0;
          if (T.fast >= 3) { ttsStop(); setStatus('The system voice is not producing speech. Try another voice, or switch to the neural voice.'); return; }
        }
      }
      page++;
    }
    if (tok === T.token) { ttsStop(); setStatus((S.book?.kind === 'text' ? 'Reached the end of the text.' : 'Reached the end of the book.')); }
  } catch (err) {
    if (tok === T.token) { console.error(err); ttsStop(); setStatus('Reading stopped: ' + esc(err.message || String(err))); }
  }
}
function haltAudio() {
  try { T.src?.stop(); } catch {} T.src = null;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (T.ctx?.state === 'suspended') T.ctx.resume();
}
function ttsStop() { T.token++; T.playing = false; T.paused = false; haltAudio(); clearSpeaking(); playUI(); try { T.wake?.release(); } catch {} }
function togglePlay() {
  if (!T.playing) {
    const pos = (() => { const s = getSelection(); return s && !s.isCollapsed ? selectionPosition() : null; })();
    if (libraryOpen() && S.book && S.pages.length) { const r = S.readPos || { page: S.current, char: 0 }; ttsPlay(r.page, r.char); }
    else if (pos?.item != null) { T.startItem = pos.item; ttsPlay(pos.page); }
    else if (isEpub()) { const v = pos || visibleStart(); ttsPlay(v.page, v.char); }
    else ttsPlay(S.current, 0);
    return;
  }
  if (!T.paused) { T.paused = true; if (T.engine === 'kokoro') T.ctx?.suspend(); else speechSynthesis.pause(); }
  else { T.paused = false; if (T.engine === 'kokoro') T.ctx?.resume(); else speechSynthesis.resume(); }
  playUI();
}
function skip(d) {
  if (!T.playing) return; const j = T.idx + d;
  if (j < 0) { if (T.page > 1) ttsPlay(T.page - 1, 0); return; }
  if (j >= T.sents.length) { ttsPlay(T.page + 1, 0); return; }
  T.startItem = null; ttsPlay(T.page, T.sents[j].start + 0.5);
}
function playUI() {
  const b = $('bPlay');
  const playing = T.playing && !T.paused;
  b.querySelector('svg').innerHTML = playing ? '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  b.querySelector('span').textContent = playing ? 'Pause' : T.paused ? 'Resume' : 'Listen';
  if (!T.playing) clearSpeaking();
  miniSync(); mediaSync();
}
$('bPlay').onclick = togglePlay; $('bStop').onclick = () => { ttsStop(); setStatus('Stopped.'); };
$('bPrev').onclick = () => skip(-1); $('bNext').onclick = () => skip(1);

/* ---- keyboard media keys + Windows media controls ----
   Browsers only hand media keys to a page that is playing an audio element, and Margin's
   speech is made live, so a quiet looping track keeps the session open while reading. */
var anchor = null, anchorQuietUntil = 0; // var: playUI can run before this line
function silentTrack() {
  const sr = 8000, n = sr * 10, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true); // inaudible
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function mediaSync() {
  if (!('mediaSession' in navigator)) return;
  const playing = T.playing && !T.paused;
  if (!anchor && T.playing) {
    anchor = new Audio(silentTrack()); anchor.loop = true;
    // another app or tab taking the sound (e.g. a video starting) pauses the reading too
    anchor.addEventListener('pause', () => { if (performance.now() > anchorQuietUntil && T.playing && !T.paused) togglePlay(); });
  }
  if (anchor) {
    anchorQuietUntil = performance.now() + 500;
    if (playing) anchor.play().catch(() => {}); else anchor.pause();
  }
  navigator.mediaSession.playbackState = playing ? 'playing' : T.playing ? 'paused' : 'none';
  if (!T.playing && !T.paused) mediaMeta(null, null);
}
function mediaMeta(page, sent) {
  if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
  const book = S.book ? (S.book.title || S.book.name) : 'Margin';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: sent ? (sent.text.length > 90 ? sent.text.slice(0, 88) + '…' : sent.text) : book,
    artist: page ? `${book} · ${unitLabel(page)}` : 'Margin',
    album: 'Margin',
    artwork: [{ src: new URL('icon.png', location.href).href, sizes: '256x256', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  on('play', () => { if (!T.playing || T.paused) togglePlay(); });
  on('pause', () => { if (T.playing && !T.paused) togglePlay(); });
  on('stop', () => { ttsStop(); setStatus('Stopped.'); });
  on('previoustrack', () => skip(-1)); on('nexttrack', () => skip(1));
  on('seekbackward', () => skip(-1)); on('seekforward', () => skip(1));
}

/* ---- floating mini player: a small window that stays on top of other apps (Chrome / Edge) ---- */
var mini = null; // var: setStatus may run before this line
const MINI_ICONS = {
  play: '<path d="M8 5v14l11-7z"/>', pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
  prev: '<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>', next: '<path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  show: '<path d="M5 5h6v2H7v10h10v-4h2v6H5zm8 0h6v6h-2V8.4l-6.3 6.3-1.4-1.4L15.6 7H13z"/>',
  close: '<path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/>',
};
const MINI_CSS = `
:root{--bg:#f7f8f7;--fg:#1d2321;--muted:#5d6763;--line:#d3d8d5;--accent:#23577a;--accent-fg:#fff;color-scheme:light}
:root.onyx{--bg:#000!important}
:root.dark{--bg:#0b0d0d;--fg:#e4e9e7;--muted:#97a29e;--line:#272d2b;--accent:#7fb6dc;--accent-fg:#0d1a22;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:13px/1.35 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;display:grid;grid-template-rows:auto 1fr;padding:10px 12px;gap:8px;overflow:hidden;user-select:none}
.row{display:flex;align-items:center;gap:6px}
button{border:0;background:transparent;color:var(--fg);border-radius:7px;width:28px;height:28px;display:grid;place-items:center;cursor:pointer;padding:0}
button:hover{background:color-mix(in srgb,var(--fg) 9%,transparent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button svg{width:16px;height:16px;fill:currentColor}
#play{background:var(--accent);color:var(--accent-fg);width:32px;height:32px;border-radius:50%}
#play svg{width:18px;height:18px}
.sp{flex:1}
#show svg{width:14px;height:14px}
#pct{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:6px}
.fs{width:auto;padding:0 5px;display:flex;align-items:baseline;justify-content:center;font:600 13px/1 Georgia,serif;color:var(--muted)}.fs small{font-size:10px}.fs:hover{color:var(--fg)}
#text{color:var(--muted);overflow:hidden;min-height:0;white-space:nowrap;text-overflow:ellipsis;align-self:center;padding:2px 0;font-family:Georgia,"Palatino Linotype",serif;font-size:18px;line-height:1.35}
#text.cap{color:var(--fg)}
#text .w{color:var(--muted);transition:color .08s}
#text .w.on{color:var(--fg);background:color-mix(in srgb,var(--accent) 22%,transparent);border-radius:3px;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 22%,transparent)}
#text b{display:none}
.mode2 #text .w{color:color-mix(in srgb,var(--muted) 70%,var(--bg))}
.mode2 #text .w.on{background:none;box-shadow:none;color:#fff;text-shadow:0 0 12px rgb(255 255 255/.35)}
:root:not(.dark).mode2 #text .w.on{color:#000;text-shadow:none}
#close svg{width:13px;height:13px}#close:hover{background:#c42b1c;color:#fff}
.frameless body{cursor:default;padding:8px 10px}
#mode{min-width:22px;font:600 12px/1 "Segoe UI",system-ui,sans-serif;border:1px solid var(--line);height:22px}`;
function svgBtn(doc, id, icon, title) { const b = doc.createElement('button'); b.id = id; b.title = title; b.innerHTML = `<svg viewBox="0 0 24 24">${MINI_ICONS[icon]}</svg>`; return b; }
var miniAuto = false; // opened by itself when Margin was minimized
const miniOpen = () => !!mini && !mini.closed;
function closeMini() { const w = mini; mini = null; miniAuto = false; try { w && w.close(); } catch {} $('bMini').classList.remove('on'); }
async function openMini(auto = false) {
  if (miniOpen()) { try { mini.focus(); } catch {} return; }
  if (IN_APP) {
    // Margin.exe opens a small window of its own and keeps it on top
    const w = window.open('', 'margin-mini', 'popup,width=360,height=104');
    if (!w) { toast('The floating player could not open.'); return; }
    mini = w; miniAuto = auto; $('bMini').classList.add('on');
    // its page appears once the window exists; fill it in as soon as it's there
    const fill = () => { try { if (mini === w && !w.closed && !w.document.getElementById('play')) setupMini(w); } catch {} };
    fill(); setTimeout(fill, 300); setTimeout(fill, 1000);
    return;
  }
  if (!('documentPictureInPicture' in window)) { toast('The floating player needs Chrome or Edge (version 116 or newer).', 5000); return; }
  let w;
  try { w = await documentPictureInPicture.requestWindow({ width: 360, height: 140 }); }
  catch (err) { console.warn(err); toast('The floating player could not open.'); return; }
  mini = w; miniAuto = auto;
  w.addEventListener('pagehide', () => { if (mini === w) { mini = null; $('bMini').classList.remove('on'); } });
  setupMini(w);
}
function setupMini(w) {
  const d = w.document;
  d.title = 'Margin';
  const st = d.createElement('style'); st.textContent = MINI_CSS; d.head.append(st);
  d.documentElement.classList.toggle('dark', themeIsDark()); d.documentElement.classList.toggle('onyx', store.get('theme', 'dark') === 'onyx');
  const row = d.createElement('div'); row.className = 'row';
  const pct = d.createElement('div'); pct.id = 'pct';
  const sp = d.createElement('div'); sp.className = 'sp';
  const show = svgBtn(d, 'show', 'show', 'Show Margin');
  const fsDown = d.createElement('button'); fsDown.className = 'fs'; fsDown.title = 'Smaller text (−)'; fsDown.innerHTML = '<small>A</small>−';
  const fsUp = d.createElement('button'); fsUp.className = 'fs'; fsUp.title = 'Larger text (+)'; fsUp.innerHTML = 'A+';
  fsDown.onclick = () => miniFs(-2); fsUp.onclick = () => miniFs(2);
  // highlight style: 1 = the spoken word in a box, 2 = the spoken word bright white, no box
  const mode = d.createElement('button'); mode.id = 'mode'; mode.className = 'fs';
  const setMode = (m) => { store.set('miniMode', m); mode.textContent = m; mode.title = m === 1 ? 'Highlight style 1: the spoken word in a box. Click for style 2' : 'Highlight style 2: the spoken word in white, no box. Click for style 1'; d.documentElement.classList.toggle('mode2', m === 2); };
  mode.onclick = () => setMode(store.get('miniMode', 1) === 2 ? 1 : 2); setMode(store.get('miniMode', 1) === 2 ? 2 : 1);
  row.append(svgBtn(d, 'play', 'play', 'Play / pause (Space)'), svgBtn(d, 'prev', 'prev', 'Previous sentence'), svgBtn(d, 'next', 'next', 'Next sentence'), svgBtn(d, 'stop', 'stop', 'Stop'), pct, sp, mode, fsDown, fsUp, show);
  if (IN_APP) {
    // Margin.exe gives this window no title bar: drag it by any empty space, and close it here
    const x = svgBtn(d, 'close', 'close', 'Close the mini player'); x.onclick = () => closeMini(); row.append(x);
    d.addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest('button')) { e.preventDefault(); hostCall((h) => h.StartMiniDrag()); } });
    d.documentElement.classList.add('frameless');
  }
  show.onclick = () => { if (IN_APP) hostCall((h) => h.ShowMain()); else try { window.focus(); } catch {} };
  const text = d.createElement('div'); text.id = 'text';
  d.body.append(row, text);
  d.getElementById('play').onclick = togglePlay;
  d.getElementById('prev').onclick = () => skip(-1);
  d.getElementById('next').onclick = () => skip(1);
  d.getElementById('stop').onclick = () => { ttsStop(); setStatus('Stopped.'); };
  d.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') skip(-1); else if (e.key === 'ArrowRight') skip(1);
    else if (e.key === '+' || e.key === '=') miniFs(2); else if (e.key === '-') miniFs(-2);
  });
  w.addEventListener('resize', () => miniFs(0));
  $('bMini').classList.add('on');
  miniFs(0);
  miniSync();
}
function miniSync() {
  if (IN_APP) hostCall((h) => h.SetPlaying(T.playing && !T.paused, T.playing && T.sents[T.idx] ? `${unitLabel(T.page)} · ${T.sents[T.idx].text}` : (S.book ? (S.book.title || S.book.name) : 'Margin')));
  if (!miniOpen()) return;
  const d = mini.document; const play = d.getElementById('play'); if (!play) return;
  const playing = T.playing && !T.paused;
  play.innerHTML = `<svg viewBox="0 0 24 24">${MINI_ICONS[playing ? 'pause' : 'play']}</svg>`;
  play.title = playing ? 'Pause (Space)' : T.paused ? 'Resume (Space)' : 'Listen (Space)';
  const pc = d.getElementById('pct'), p = readPercent();
  pc.textContent = p == null ? '' : `${p}%`;
  pc.title = [T.playing && T.page ? unitLabel(T.page) : S.book?.title || S.book?.name, p == null ? '' : `${p}% of the book read`].filter(Boolean).join(' · ');
  miniCaption();
}
// the mini player's text size (remembered); as many lines are shown as fit the window
function miniFs(step) {
  const fs = Math.max(12, Math.min(40, (+store.get('miniFs', 18) || 18) + step));
  if (step) store.set('miniFs', fs);
  if (!miniOpen()) return; const box = mini.document.getElementById('text'); if (!box) return;
  box.style.fontSize = fs + 'px';
  miniCaption();
}
// the mini player shows the sentence on one line, up to 8 words at a time (fewer when large text needs it),
// and follows the spoken word
const MINI_WORDS = 8;
let miniMeasure = null;
function miniLines(words, box) {
  const cs = mini.getComputedStyle(box), key = words.join(' ') + '|' + cs.fontSize + '|' + box.clientWidth;
  if (T.miniLines?.key === key) return T.miniLines.lines;
  const c = (miniMeasure ??= document.createElement('canvas').getContext('2d'));
  c.font = `${cs.fontSize} ${cs.fontFamily}`;
  const space = c.measureText(' ').width, avail = box.clientWidth - c.measureText('… …').width - 10;
  const lines = []; let cur = [], width = 0;
  words.forEach((wd, i) => {
    const ww = c.measureText(wd).width, add = (cur.length ? space : 0) + ww;
    if (cur.length && (cur.length >= MINI_WORDS || width + add > avail)) { lines.push(cur); cur = []; width = 0; }
    cur.push(i); width += cur.length > 1 ? space + ww : ww;
  });
  if (cur.length) lines.push(cur);
  T.miniLines = { key, lines }; return lines;
}
function miniCaption() {
  if (!miniOpen()) return; const box = mini.document.getElementById('text'); if (!box) return;
  const s = T.playing ? T.sents[T.idx] : null;
  if (!s) { box.className = ''; box.innerHTML = $('statusText').innerHTML; return; }
  if (!T.miniWordsOn) { box.className = 'cap'; box.textContent = s.text; return; } // no word timing: the whole sentence
  const words = s.spoken?.length ? s.spoken.map((x) => x[1]) : s.text.split(/\s+/).filter(Boolean);
  const w = Math.max(0, Math.min(T.miniKey === T.page + ':' + T.idx ? T.miniW || 0 : 0, words.length - 1));
  box.className = 'cap';
  const lines = miniLines(words, box), line = lines.find((l) => l.includes(w)) || lines[0] || [];
  const from = line[0] || 0, to = line.length ? line[line.length - 1] : 0;
  box.innerHTML = (from ? '… ' : '') + line.map((i) => `<span class="w${i === w ? ' on' : ''}">${esc(words[i])}</span>`).join(' ') + (to < words.length - 1 ? ' …' : '');
  box.title = s.text;
}
// how far through the book: the spoken sentence while reading aloud, otherwise the place on screen
function readPercent() {
  if (!S.book || !S.count) return null;
  let page, frac;
  if (T.playing && T.page) {
    page = T.page; const s = T.sents[T.idx];
    if (isEpub()) { const L = secLens(); const tot = L.reduce((a, b) => a + b, 0) || 1; const before = L.slice(0, page - 1).reduce((a, b) => a + b, 0); return Math.min(100, Math.floor(((before + (s?.start || 0)) / tot) * 100)); }
    frac = T.sents.length ? T.idx / T.sents.length : 0;
  } else if (isEpub()) {
    const v = visibleStart(); if (!v) return null; const L = secLens(); const tot = L.reduce((a, b) => a + b, 0) || 1;
    return Math.min(100, Math.floor(((L.slice(0, v.page - 1).reduce((a, b) => a + b, 0) + (v.char || 0)) / tot) * 100));
  } else { page = S.current || 1; frac = 0; }
  return Math.min(100, Math.floor(((page - 1 + frac) / S.count) * 100));
}
// EPUB chapters differ a lot in length: count characters, not chapters
function secLens() {
  if (S.secLens?.book === S.book && S.secLens.n === S.pages.length) return S.secLens.L;
  const L = S.pages.map((p) => { try { return secModel(p).text.length; } catch { return 0; } });
  S.secLens = { book: S.book, n: S.pages.length, L }; return L;
}
$('bMini').onclick = () => { if (miniOpen()) closeMini(); else openMini(); };
if (ANDROID) $('bMini').hidden = true;
// what Margin.exe calls: taskbar buttons, minimizing the window, the mini window closing
window.marginHost = {
  cmd(c) { if (c === 'prev') skip(-1); else if (c === 'next') skip(1); else if (c === 'stop') ttsStop(); else if (S.book) togglePlay(); },
  openFile(f) { return openFile(f); },
  // the phone's Back button: one step back; false at the top, and Android puts Margin in the background
  back() {
    const dlg = document.querySelector('dialog[open]'); if (dlg) { dlg.close(); return true; }
    if (document.querySelector('.bk-menu, .shelf-menu')) { closeMenus(); return true; }
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    if (libraryOpen()) {
      if (!$('bookPage').hidden && S.view === 'library') { closeBookPage(); showLibrary(false); return true; }
      if (S.book) { backToBook(); return true; }
      if (S.view !== 'library') { $('bLib').click(); return true; }
      return false;
    }
    if (S.book) { showLibrary(false); return true; }
    return false;
  },
  minimized() { if (T.playing && !T.paused && !miniOpen() && store.get('autoMini', true)) openMini(true); },
  restored() { if (miniAuto && miniOpen()) closeMini(); },
  miniClosed() { mini = null; miniAuto = false; $('bMini').classList.remove('on'); },
};

syncDeviceVis();

/* ================================================================
   Saved words
   ================================================================ */
const W = { list: [], review: null };
const DAY = 864e5;
const INTERVALS = [1, 2, 4, 8, 16, 32, 64, 128]; // days, by box
const cleanWord = (t) => t.replace(/[­]/g, '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
async function loadWords() { try { W.list = await DB.words(); } catch { W.list = []; } renderWords(); }
async function contextFor(pos, word) {
  try {
    const sents = await unitSentences(pos.page); const text = sents.text || '';
    let c;
    if (isEpub()) c = pos.char || 0; else { const r = sents.ranges?.[pos.item]; if (!r) return ''; c = r[0] + (pos.offset || 0); }
    // a full stop ends a sentence unless it follows "Mr", "Dr", "e.g", an initial ("J. R. R.") or is inside a number
    const ends = (i) => {
      const ch = text[i]; if (ch === '\n') return true; if (!/[.!?…]/.test(ch)) return false;
      if (i + 1 < text.length && !/[\s"”’')\]]/.test(text[i + 1])) return false;
      if (ch !== '.') return true;
      const before = text.slice(Math.max(0, i - 6), i).match(/([\p{L}.]+)$/u)?.[1] || '';
      return !(/^\p{Lu}$/u.test(before) || /^(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Gen|Col|Capt|Lt|Rev|vs|etc|e\.g|i\.e|cf|No|Vol|pp|p|ch|fig|approx|ca|c)$/i.test(before));
    };
    let a = c; while (a > 0 && !ends(a - 1)) a--;
    let b = c + word.length; while (b < text.length && !ends(b)) b++;
    let ctx = text.slice(a, Math.min(text.length, b + 1)).replace(/(?<=\p{L}[)\]]?[.,;:!?][”’"')\]]?)\d{1,3}(?=\s|$)/gu, '').replace(/\s+/g, ' ').trim();
    if (ctx.length > 320) { const i = ctx.toLowerCase().indexOf(word.toLowerCase()); const st = Math.max(0, i - 150); ctx = (st ? '…' : '') + ctx.slice(st, st + 300).trim() + '…'; }
    return ctx;
  } catch { return ''; }
}
async function saveWord() {
  const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return;
  const word = cleanWord(sel.toString()); if (!word) return;
  const pos = selectionPosition();
  const context = pos && (pos.item != null || isEpub()) ? await contextFor(pos, word) : '';
  sel.removeAllRanges(); hideMenu();
  const id = word.toLowerCase();
  let w = W.list.find((x) => x.id === id);
  const ctx = { bookId: S.book.id, book: S.book.title || S.book.name, page: pos?.page || S.current, label: label(pos?.page || S.current), where: unitLabel(pos?.page || S.current), text: context, at: Date.now() };
  if (w) {
    if (!w.contexts.some((c) => c.bookId === ctx.bookId && c.page === ctx.page)) w.contexts.unshift(ctx);
    toast(`“${w.word}” is already saved. Added this example.`);
  } else {
    w = { id, word, contexts: [ctx], def: '', phonetic: '', note: '', created: Date.now(), box: 0, due: Date.now(), reviews: 0 };
    W.list.push(w); toast(`Saved “${word}”`);
  }
  await DB.putWord(w); renderWords(w.id);
  if (!w.def) lookupDef(w);
}
async function lookupDef(w, manual = false) {
  if (/\s/.test(w.word) && !manual) return; // phrases: no dictionary lookup
  try {
    const res = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w.word.toLowerCase()));
    if (!res.ok) { w.lookup = 'none'; }
    else {
      const data = await res.json(); const e = data[0] || {};
      w.phonetic = e.phonetic || (e.phonetics || []).find((p) => p.text)?.text || '';
      const lines = [];
      for (const m of e.meanings || []) for (const d of (m.definitions || []).slice(0, 2)) { if (lines.length < 3) lines.push(`${m.partOfSpeech}: ${d.definition}`); }
      w.def = lines.join('\n'); w.lookup = w.def ? 'ok' : 'none';
    }
  } catch { w.lookup = 'offline'; }
  await DB.putWord(w); renderWords();
}
const dueText = (w) => { const d = w.due - Date.now(); if (d <= 0) return 'due now'; const days = Math.round(d / DAY); return days < 1 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} days`; };
function boldWord(text, word) {
  const i = text.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<b>' + esc(text.slice(i, i + word.length)) + '</b>' + esc(text.slice(i + word.length));
}
const SPEAKER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>';
function renderWords(focusId) {
  if (S.view === 'words') wordsDraw?.(); // the Words page shows the same words
  const list = $('wordList'); if (!list) return; list.innerHTML = '';
  const n = W.list.length, due = W.list.filter((w) => w.due <= Date.now()).length;
  $('wCount').textContent = n ? `(${n})` : '';
  $('wCount2').textContent = n ? `${n} word${n > 1 ? 's' : ''} · ${due} due` : 'No saved words';
  $('bReview').textContent = due ? `Review ${due}` : 'Review';
  const q = $('wSearch').value.trim().toLowerCase();
  const shown = W.list.filter((w) => !q || w.id.includes(q) || (w.def || '').toLowerCase().includes(q) || (w.note || '').toLowerCase().includes(q)).sort((a, b) => b.created - a.created);
  if (!n) { list.append(el('div', 'empty', 'Select or double-click a word on the page, then choose “Save word”. Saved words collect here with the sentence you found them in, ready to review.')); return; }
  if (!shown.length) { list.append(el('div', 'empty', 'No saved words match that search.')); return; }
  for (const w of shown) {
    const item = wordItem(w);
    list.append(item);
    if (w.id === focusId) { item.classList.add('focus'); requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' })); }
  }
}
// one saved word; used by the sidebar and by the Words page
function wordItem(w, opt = {}) {
    const item = el('div', 'word'); item.dataset.id = w.id;
    const head = el('div', 'whead');
    const say = el('button', 'iconbtn'); say.innerHTML = SPEAKER; say.title = 'Hear it'; say.onclick = () => sayText(w.word);
    const del = el('button', 'linkbtn', 'Delete');
    del.onclick = async () => { if (del.dataset.armed) { W.list = W.list.filter((x) => x.id !== w.id); await DB.delWord(w.id); renderWords(); } else { del.dataset.armed = 1; del.textContent = 'Confirm delete'; del.classList.add('danger'); setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 3000); } };
    head.append(el('span', 'w', w.word), w.phonetic ? el('span', 'due', w.phonetic) : '', say, el('span', 'sp'), el('span', 'due', dueText(w)), del);
    const def = el('div', 'def');
    if (w.def) def.innerHTML = w.def.split('\n').map((l) => { const [pos, ...rest] = l.split(': '); return `<i>${esc(pos)}</i> ${esc(rest.join(': '))}`; }).join('<br>');
    else {
      const msg = w.lookup === 'offline' ? 'Couldn’t look this up offline.' : w.lookup === 'none' ? 'No dictionary entry. Add your own meaning below.' : 'Looking up…';
      def.append(el('span', 'due', msg + ' '));
      if (w.lookup === 'offline' || w.lookup === 'none') { const b = el('button', 'linkbtn', 'Look up'); b.onclick = () => { w.lookup = ''; renderWords(); lookupDef(w, true); }; def.append(b); }
    }
    const ta = el('textarea'); ta.placeholder = 'Your meaning, translation or note…'; ta.value = w.note || ''; ta.id = 'wnote-' + w.id;
    ta.oninput = debounce(() => { w.note = ta.value; DB.putWord(w); }, 400);
    item.append(head, def, ta);
    if (opt.allBooks) {
      // the Vocab page: every sentence the word was found in, under its book and chapter
      const used = w.contexts.filter((c) => c.bookId);
      if (used.length) {
        const box = el('div', 'used');
        box.append(el('div', 'used-h', used.length > 1 ? `Found in ${new Set(used.map((c) => c.bookId)).size > 1 ? new Set(used.map((c) => c.bookId)).size + ' books' : used.length + ' places'}` : 'Found in'));
        for (const c of used) {
          const q = el('button', 'ctx2'); q.title = 'Open the book at this sentence';
          const src = el('div', 'src'); src.append(el('b', '', c.book || 'A book'), document.createTextNode(` · ${c.where || 'p. ' + c.label}${c.at ? ' · ' + fmtDate(c.at) : ''}`));
          const t = el('div', 'sent'); t.innerHTML = c.text ? boldWord(c.text, w.word) : '<i>No sentence was saved with this word.</i>';
          q.append(src, t); q.onclick = async () => { if (await showInBook(c.bookId)) goTo(c.page); };
          box.append(q);
        }
        item.append(box);
      }
    } else for (const c of w.contexts.slice(0, 3)) if (c.text) {
      const q = el('div', 'ctx'); q.innerHTML = boldWord(c.text, w.word) + ` <span class="due">${esc(c.where || 'p. ' + c.label)}${c.bookId !== S.book?.id ? ' · ' + esc(c.book) : ''}</span>`;
      q.title = 'Go to this page'; q.onclick = async () => { if (await showInBook(c.bookId)) goTo(c.page); };
      item.append(q);
    }
  return item;
}
$('wSearch').addEventListener('input', debounce(() => renderWords(), 150));
$('bWExport').onclick = () => {
  if (!W.list.length) { toast('No saved words to export yet.'); return; }
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['Word', 'Pronunciation', 'Meaning', 'My note', 'Example', 'Source'].map(q).join(',')];
  for (const w of W.list.slice().sort((a, b) => a.id.localeCompare(b.id))) { const c = w.contexts[0] || {}; rows.push([w.word, w.phonetic, w.def, w.note, c.text, c.book ? `${c.book}, ${c.where || 'p. ' + c.label}` : ''].map(q).join(',')); }
  const a = el('a'); a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' })); a.download = 'Margin vocab.csv';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
/* ---------------- Notes and Words pages (top bar) ----------------
   Every highlight and saved word from all books, with search. Reading aloud carries on. */
function setView(v) { S.view = v; for (const [id, k] of [['bLib', 'library'], ['bReader', 'book'], ['bNotes', 'notes'], ['bWords', 'words'], ['bText', 'text']]) $(id).classList.toggle('on', v === k); }
// go to a book: back to it if it is the open one (no reload, reading aloud keeps going), otherwise open it
async function showInBook(id) {
  if (S.book?.id === id) { if (libraryOpen()) backToBook(); return true; }
  await openStored(id); return S.book?.id === id;
}
// all words of the search must appear somewhere
const qWords = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matchAll = (hay, words) => { const h = hay.toLowerCase(); return words.every((w) => h.includes(w)); };
function markQ(text, words) {
  if (!words.length) return esc(text);
  const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark class="q">${esc(part)}</mark>` : esc(part))).join('');
}
function openAllPage(kind, title) {
  if (S.book && !pagesEl.hidden) { S.readScroll = viewer.scrollTop; S.readPos = isEpub() ? visibleStart() : { page: S.current, char: 0 }; }
  const pg = $('bookPage');
  if (pg.hidden && !$('catalog').hidden) pageScroll = $('welcome').scrollTop;
  $('welcome').hidden = false; pagesEl.hidden = true; $('pagebox').hidden = true; viewer.scrollTop = 0;
  $('title').textContent = ''; document.title = title + ' · Margin';
  pg.innerHTML = ''; pg.hidden = false;
  for (const id of ['catalog', 'folders', 'libtools', 'intro']) $(id).hidden = true;
  $('welcome').classList.add('has-books'); $('welcome').scrollTop = 0;
  setView(kind);
  const wrap = el('div', 'allpage'); pg.append(wrap);
  const head = el('div', 'cat-head');
  if (S.book) { const back = el('button', 'btn back', `← Back to ${S.book.title || S.book.name}`); back.title = 'Return to where you were'; back.onclick = backToBook; head.append(back); }
  const count = el('span', 'cat-count');
  head.append(el('h1', '', title), count, el('span', 'sp'));
  const tools = el('div', 'ap-tools');
  const search = el('input'); search.type = 'search';
  tools.append(search);
  const list = el('div', 'ap-list');
  wrap.append(head, list);
  return { wrap, head, tools, search, count, list };
}
const bookSelect = (books, value) => {
  const sel = el('select'); sel.title = 'Show one book only';
  sel.append(new Option('All books', 'all'));
  for (const b of books.slice().sort((a, c) => (a.title || a.name).localeCompare(c.title || c.name))) sel.append(new Option((b.title || b.name).slice(0, 60), b.id));
  sel.value = books.some((b) => b.id === value) ? value : 'all'; return sel;
};

/* Notes: highlights and notes from every book */
const NP = { q: '', book: 'all', notesOnly: false };
async function showNotesPage() {
  const P = openAllPage('notes', 'Notes');
  const [all, books] = await Promise.all([DB.allHls(), DB.books()]);
  if (S.view !== 'notes') return;
  const live = new Map(S.hls.map((h) => [h.id, h])); // the open book's highlights are shared with the sidebar
  let hls = all.map((h) => live.get(h.id) || h);
  const byId = new Map(books.map((b) => [b.id, b]));
  const bookName = (id) => { const b = byId.get(id); return b ? b.title || b.name : 'A removed book'; };
  P.search.placeholder = 'Search highlights, notes and book titles'; P.search.setAttribute('aria-label', 'Search notes'); P.search.value = NP.q;
  const withHl = [...new Set(hls.map((h) => h.bookId))].map((id) => byId.get(id)).filter(Boolean);
  const sel = bookSelect(withHl, NP.book); NP.book = sel.value;
  const only = el('button', 'btn starfilter' + (NP.notesOnly ? ' on' : ''), 'With notes only'); only.title = 'Show only highlights you wrote a note on'; only.setAttribute('aria-pressed', String(NP.notesOnly));
  const exp = el('button', 'btn', 'Export'); exp.title = 'Download what is shown as a Markdown file';
  P.tools.append(sel, only, el('span', 'sp'), exp); P.head.append(P.tools);
  let shown = [];
  const draw = () => {
    const words = qWords(NP.q);
    shown = hls.filter((h) => (NP.book === 'all' || h.bookId === NP.book) && (!NP.notesOnly || h.note?.trim())
      && (!words.length || matchAll(`${h.text} ${h.note || ''} ${bookName(h.bookId)} ${authorText(byId.get(h.bookId) || {})}`, words)));
    const nb = new Set(hls.map((h) => h.bookId)).size;
    P.count.textContent = !hls.length ? '' : shown.length === hls.length ? `${hls.length} highlight${hls.length === 1 ? '' : 's'} in ${nb} book${nb === 1 ? '' : 's'}` : `${shown.length} of ${hls.length} highlights`;
    P.list.innerHTML = '';
    if (!hls.length) { P.list.append(el('div', 'empty', 'No highlights yet. Open a book, select some text and pick a colour. Every highlight and note from every book collects here.')); return; }
    if (!shown.length) { P.list.append(el('div', 'empty', words.length ? 'Nothing matches that search.' : 'No highlights with notes yet.')); return; }
    const groups = new Map();
    for (const h of shown) { if (!groups.has(h.bookId)) groups.set(h.bookId, []); groups.get(h.bookId).push(h); }
    const order = [...groups.entries()].sort((a, c) => Math.max(...c[1].map((h) => h.created || 0)) - Math.max(...a[1].map((h) => h.created || 0)));
    for (const [bookId, items] of order) {
      const b = byId.get(bookId);
      const box = el('section', 'ap-book');
      const bh = el('div', 'ap-bhead');
      const th = el('button', 'ap-thumb'); th.title = 'Book details';
      if (b?.cover && !b.plainCover) { const img = el('img'); img.src = b.cover; img.alt = ''; th.append(img); } else th.append(generatedCover(b || { name: '?' }));
      const tt = el('div', 'ap-btitle'); const tb = el('button', '', bookName(bookId)); tt.append(tb, el('div', '', [b && authorText(b), `${items.length} highlight${items.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
      if (b) th.onclick = tb.onclick = () => showBookPage(b.id);
      bh.append(th, tt); box.append(bh);
      for (const h of items.sort(hlOrder)) box.append(noteCard(h, words, () => { hls = hls.filter((x) => x.id !== h.id); draw(); }));
      P.list.append(box);
    }
  };
  P.search.addEventListener('input', debounce(() => { NP.q = P.search.value.trim(); draw(); }, 140));
  sel.onchange = () => { NP.book = sel.value; draw(); };
  only.onclick = () => { NP.notesOnly = !NP.notesOnly; only.classList.toggle('on', NP.notesOnly); only.setAttribute('aria-pressed', String(NP.notesOnly)); draw(); };
  exp.onclick = () => {
    if (!shown.length) { toast('No highlights to export.'); return; }
    let md = `# Notes\n\nHighlights and notes exported from Margin, ${new Date().toLocaleDateString()}\n`;
    const groups = new Map(); for (const h of shown) { if (!groups.has(h.bookId)) groups.set(h.bookId, []); groups.get(h.bookId).push(h); }
    for (const [id, items] of groups) {
      const b = byId.get(id); md += `\n## ${bookName(id)}${b && authorText(b) ? ' — ' + authorText(b) : ''}\n`;
      for (const h of items.sort(hlOrder)) { md += `\n> ${h.text}\n\n*${hlWhere(h)}*\n`; if (h.note?.trim()) md += `\n${h.note.trim()}\n`; }
    }
    const a = el('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = NP.book !== 'all' ? `${bookName(NP.book).replace(/[\\/:*?"<>|]+/g, '').slice(0, 80)} - notes.md` : 'Margin notes.md';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  draw();
  P.search.focus();
}
const hlWhere = (h) => (h.bookId === S.book?.id ? unitLabel(hlUnit(h)) : h.where || (h.rects ? 'p. ' + h.rects[0].page : 'Section ' + h.sec));
function noteCard(h, words, removed) {
  const item = el('div', 'note'); item.dataset.id = h.id; item.style.setProperty('--c', COLORS[h.color] || COLORS.yellow);
  const meta = el('div', 'meta');
  meta.append(el('span', 'pg', hlWhere(h)), el('span', '', fmtDate(h.created)), el('span', 'sp'));
  const go = el('button', 'linkbtn goto', 'Go to it'); go.title = 'Open the book at this highlight'; go.onclick = () => goToHl(h);
  const del = el('button', 'linkbtn', 'Delete');
  del.onclick = async () => {
    if (!del.dataset.armed) { del.dataset.armed = 1; del.textContent = 'Confirm delete'; del.classList.add('danger'); setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 3000); return; }
    if (h.bookId === S.book?.id) await deleteHl(h.id); else await DB.delHl(h.id);
    removed();
  };
  meta.append(go, del);
  const q = el('blockquote'); q.innerHTML = markQ(h.text, words); q.title = 'Go to this highlight'; q.onclick = () => goToHl(h);
  const ta = el('textarea'); ta.placeholder = 'Add a note…'; ta.value = h.note || '';
  ta.oninput = debounce(() => { h.note = ta.value; DB.putHl(h); if (h.bookId === S.book?.id) S.notesStale = true; }, 400);
  item.append(meta, q, ta); return item;
}
async function goToHl(h) {
  if (!(await showInBook(h.bookId))) return;
  const live = S.hls.find((x) => x.id === h.id); if (!live) return;
  goTo(hlUnit(live), 'auto');
  // an EPUB chapter has to be drawn before the highlight can be found in it
  let tries = 0;
  const go = () => {
    if (!live.rects) { const p = S.pages[live.sec - 1]; if (!(p && rangeFromPos(p, live.start, live.end)) && tries++ < 10) { setTimeout(go, 200); return; } }
    jumpToHl(live);
  };
  setTimeout(go, 250);
}

/* Words: every saved word */
const WP = { q: '', book: 'all', sort: store.get('wordsSort', 'new') };
let wordsDraw = null;
function showWordsPage() {
  const P = openAllPage('words', 'Vocab');
  P.search.placeholder = 'Search words, meanings, notes and sentences'; P.search.setAttribute('aria-label', 'Search saved words'); P.search.value = WP.q;
  const booksMap = new Map(); for (const w of W.list) for (const c of w.contexts || []) if (c.bookId && !booksMap.has(c.bookId)) booksMap.set(c.bookId, { id: c.bookId, title: c.book || 'A book' });
  const sel = bookSelect([...booksMap.values()], WP.book); WP.book = sel.value;
  const sort = el('select'); sort.title = 'Order';
  for (const [v, t] of [['new', 'Newest first'], ['az', 'A to Z'], ['due', 'Due for review first']]) sort.append(new Option(t, v));
  sort.value = WP.sort;
  const review = el('button', 'btn primary', 'Review'); review.onclick = startReview;
  const exp = el('button', 'btn', 'Export'); exp.title = 'Download words as a CSV file (opens in Excel; imports into Anki)'; exp.onclick = () => $('bWExport').click();
  P.tools.append(sel, sort, el('span', 'sp'), review, exp); P.head.append(P.tools);
  P.list.classList.add('ap-words');
  wordsDraw = () => {
    if (S.view !== 'words') return;
    const words = qWords(WP.q), now = Date.now();
    const n = W.list.length, due = W.list.filter((w) => w.due <= now).length;
    review.textContent = due ? `Review ${due}` : 'Review';
    const shown = W.list.filter((w) => (WP.book === 'all' || (w.contexts || []).some((c) => c.bookId === WP.book))
      && (!words.length || matchAll(`${w.word} ${w.def || ''} ${w.note || ''} ${(w.contexts || []).map((c) => c.text + ' ' + (c.book || '')).join(' ')}`, words)));
    shown.sort(WP.sort === 'az' ? (a, b) => a.word.localeCompare(b.word) : WP.sort === 'due' ? (a, b) => a.due - b.due : (a, b) => b.created - a.created);
    P.count.textContent = !n ? '' : shown.length === n ? `${n} word${n === 1 ? '' : 's'} · ${due} due` : `${shown.length} of ${n} words`;
    P.list.innerHTML = '';
    P.list.classList.toggle('ap-words', !!shown.length);
    if (!n) { P.list.append(el('div', 'empty', 'Your vocab is empty. In a book, select or double-click a word and choose “Save word”. Words from every book collect here, with the sentence and book you found them in.')); return; }
    if (!shown.length) { P.list.append(el('div', 'empty', 'No saved words match that search.')); return; }
    for (const w of shown) {
      const item = wordItem(w, { allBooks: true });
      if (words.length) { const ww = item.querySelector('.w'); if (ww) ww.innerHTML = markQ(w.word, words); }
      P.list.append(item);
    }
  };
  P.search.addEventListener('input', debounce(() => { WP.q = P.search.value.trim(); wordsDraw(); }, 140));
  sel.onchange = () => { WP.book = sel.value; wordsDraw(); };
  sort.onchange = () => { WP.sort = sort.value; store.set('wordsSort', WP.sort); wordsDraw(); };
  wordsDraw();
  P.search.focus();
}
/* ---------------- Text: paste anything and listen ----------------
   Pasted text is kept as a small "book" (kind 'text') that is not shown in the Library.
   It opens in the reader like a one-chapter EPUB, so the voice, word highlighting,
   highlights, notes and Save word all work on it. */
function textEpub(book, text) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n|\n(?=\s*[-•*]\s)/).map((t) => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  // very long texts are split into parts so the page stays quick
  const parts = []; let cur = [], n = 0;
  for (const t of paras) { cur.push(t); n += t.length; if (n > 30000) { parts.push(cur); cur = []; n = 0; } }
  if (cur.length || !parts.length) parts.push(cur);
  const title = book.title || 'Text';
  return {
    title, author: '', spine: parts.map((_, i) => ({ path: 'part' + i })),
    toc: parts.map((_, i) => ({ title: parts.length > 1 ? `Part ${i + 1}` : title, path: 'part' + i, items: [] })),
    spineIndex: (p) => +String(p).replace('part', ''),
    chapter: async (i) => { const f = document.createDocumentFragment(); for (const t of parts[i]) f.append(el('p', '', t)); if (!parts[i].length) f.append(el('p', '', ' ')); return f; },
    cover: async () => null, pages: async () => ({ pages: Math.max(1, Math.round(text.length / 2000)), estimated: true }),
    close() {},
  };
}
const textTitle = (t) => { const line = t.trim().split(/\n/)[0].replace(/\s+/g, ' ').trim(); return line.length > 60 ? line.slice(0, 57).replace(/\s+\S*$/, '') + '…' : line || 'Text'; };
const wordCount = (t) => (t.match(/\S+/g) || []).length;
let textEditing = null; // the saved text being changed, if any
async function saveText(text, title, id) {
  const now = Date.now();
  let book = id ? await DB.getBook(id) : null;
  if (book) {
    const old = await DB.getFile(id); const before = old ? await old.text() : '';
    if (before !== text) { for (const h of await DB.hls(id)) await DB.delHl(h.id); book.lastPage = 1; book.lastFrac = 0; book.model = null; }
  } else book = { id: 'text-' + now, name: 'Text', kind: 'text', added: now, year: null, cover: null };
  book.title = title || textTitle(text); book.words = wordCount(text); book.pages = Math.max(1, Math.round(text.length / 2000)); book.pagesEstimated = true;
  await DB.putFile(book.id, new Blob([text], { type: 'text/plain' }));
  await DB.putBook(book);
  return book;
}
async function showTextPage(prefill) {
  const P = openAllPage('text', 'Text');
  P.search.remove();
  P.count.textContent = 'Paste or type anything, then listen';
  const box = el('div', 'tx-box');
  const title = el('input'); title.type = 'text'; title.placeholder = 'Title (optional)'; title.className = 'tx-title'; title.setAttribute('aria-label', 'Title');
  const ta = el('textarea', 'tx-text'); ta.placeholder = 'Paste text here: an article, a message, notes, a chapter…'; ta.setAttribute('aria-label', 'Text to read aloud'); ta.spellcheck = false;
  const info = el('span', 'tx-info');
  const paste = el('button', 'btn', 'Paste'); paste.title = 'Paste what you copied';
  const clear = el('button', 'btn', 'Clear');
  const open = el('button', 'btn', 'Open'); open.title = 'Open it in the reader without starting the voice';
  const go = el('button', 'btn primary tx-go'); go.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5v14l12-7z"/></svg> Read aloud';
  const row = el('div', 'tx-row'); row.append(paste, clear, info, el('span', 'sp'), open, go);
  box.append(title, ta, row);
  const listHead = el('h2', 'tx-h', 'Saved texts');
  const list = el('div', 'tx-list');
  P.list.replaceWith(box); box.after(listHead, list);
  textEditing = null;
  if (prefill) { textEditing = prefill.id; ta.value = prefill.text || ''; title.value = prefill.title && prefill.title !== textTitle(ta.value) ? prefill.title : ''; }
  const upd = () => { const w = wordCount(ta.value); info.textContent = w ? `${w} word${w === 1 ? '' : 's'} · about ${Math.max(1, Math.round(w / 160))} min` : ''; go.disabled = open.disabled = !w; clear.hidden = !ta.value; };
  ta.addEventListener('input', upd); upd();
  paste.onclick = async () => {
    try { const t = await navigator.clipboard.readText(); if (!t) { toast('Nothing copied yet.'); return; } ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end'); upd(); ta.focus(); }
    catch { ta.focus(); toast('Press and hold in the box and choose Paste (or Ctrl+V).'); }
  };
  clear.onclick = () => { ta.value = ''; title.value = ''; textEditing = null; upd(); ta.focus(); };
  const start = async (play) => {
    const t = ta.value.trim(); if (!t) return;
    const book = await saveText(t, title.value.trim(), textEditing);
    await openStored(book.id);
    if (play && S.book?.id === book.id) setTimeout(() => { if (!T.playing) togglePlay(); }, 150);
  };
  go.onclick = () => start(true); open.onclick = () => start(false);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(true); } });
  const drawList = async () => {
    const texts = (await DB.books()).filter((b) => b.kind === 'text').sort((a, b) => (b.opened || b.added || 0) - (a.opened || a.added || 0));
    listHead.hidden = !texts.length; list.innerHTML = '';
    for (const b of texts) {
      const r = el('div', 'tx-item');
      const main = el('button', 'tx-open'); main.title = 'Open in the reader';
      main.append(el('b', '', b.title || 'Text'), el('span', '', [b.words ? `${b.words} words` : '', fmtDate(b.opened || b.added)].filter(Boolean).join(' · ')));
      main.onclick = () => openStored(b.id);
      const edit = el('button', 'linkbtn', 'Edit'); edit.title = 'Change the text';
      edit.onclick = async () => { const f = await DB.getFile(b.id); showTextPage({ id: b.id, title: b.title, text: f ? await f.text() : '' }); };
      const del = el('button', 'linkbtn', 'Delete');
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = 1; del.textContent = 'Confirm delete'; del.classList.add('danger'); setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; del.classList.remove('danger'); } }, 3000); return; }
        if (S.book?.id === b.id) { ttsStop(); }
        for (const h of await DB.hls(b.id)) await DB.delHl(h.id);
        await DB.delFile(b.id); await DB.delBook(b.id);
        if (S.book?.id === b.id) { S.book = null; setView('text'); }
        drawList();
      };
      r.append(main, edit, del); list.append(r);
    }
  };
  drawList();
  setTimeout(() => ta.focus(), 50);
}
$('bText').onclick = () => showTextPage();
$('bNotes').onclick = () => showNotesPage();
$('bWords').onclick = () => showWordsPage();

// hear a word: neural voice if it is loaded, otherwise the system voice
async function sayText(text) {
  if (T.engine === 'kokoro' && T.ready) {
    try {
      const { pcm, sr } = await kokoroAudio(`say:${text}:${T.voice}`, text);
      T.ctx ??= new AudioContext(); if (T.ctx.state === 'suspended') await T.ctx.resume();
      const b = T.ctx.createBuffer(1, pcm.length, sr); b.copyToChannel(pcm, 0); const src = T.ctx.createBufferSource(); src.buffer = b; src.connect(volumeOut()); src.start(); return;
    } catch {}
  }
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.volume = Math.min(1, T.volume); const v = speechSynthesis.getVoices().find((v) => v.voiceURI === store.get('voice.system', '')) || speechSynthesis.getVoices().find((v) => v.lang.startsWith('en')); if (v) u.voice = v; speechSynthesis.speak(u); }
}

/* review: show word + its sentence, reveal meaning, grade */
function startReview() {
  const now = Date.now();
  let queue = W.list.filter((w) => w.due <= now).sort((a, b) => a.due - b.due);
  if (!queue.length) { if (!W.list.length) { toast('Save some words first.'); return; } queue = W.list.slice().sort(() => Math.random() - 0.5).slice(0, 20); toast('Nothing is due. Practising a few words anyway.'); }
  W.review = { queue, done: 0 }; $('review').hidden = false; showCard();
}
function showCard() {
  const R = W.review; const w = R.queue[0];
  if (!w) { closeReview(); toast(`Review finished: ${R.done} card${R.done === 1 ? '' : 's'}.`); return; }
  $('rLeft').textContent = `${R.queue.length} left`;
  $('rWord').textContent = w.word;
  const c = w.contexts.find((c) => c.text);
  $('rCtx').innerHTML = c ? boldWord(c.text, w.word) : '';
  $('rDef').innerHTML = [w.phonetic ? `<span class="due">${esc(w.phonetic)}</span>` : '', w.def ? w.def.split('\n').map((l) => { const [pos, ...rest] = l.split(': '); return `<i>${esc(pos)}</i> ${esc(rest.join(': '))}`; }).join('<br>') : '', w.note ? `<div style="margin-top:6px">${esc(w.note).replace(/\n/g, '<br>')}</div>` : '', !w.def && !w.note ? '<span class="due">No meaning saved yet. Add one in the Words tab.</span>' : '', c ? `<div class="due" style="margin-top:6px">${esc(c.book)}, ${esc(c.where || 'p. ' + c.label)}</div>` : ''].join('');
  $('rAns').hidden = true; $('rGrade').hidden = true; $('rShowRow').hidden = false; $('rShow').focus();
}
function reveal() { $('rAns').hidden = false; $('rGrade').hidden = false; $('rShowRow').hidden = true; }
async function grade(g) {
  const R = W.review; const w = R.queue.shift(); if (!w) return;
  const now = Date.now(); w.reviews = (w.reviews || 0) + 1; R.done++;
  if (g === 0) { w.box = 0; w.due = now; R.queue.splice(Math.min(3, R.queue.length), 0, w); }
  else if (g === 1) { w.due = now + Math.max(1, INTERVALS[w.box] / 2) * DAY; }
  else { w.box = Math.min(INTERVALS.length - 1, w.box + (g === 3 ? 2 : 1)); w.due = now + INTERVALS[w.box - (g === 3 ? 1 : 0)] * DAY; }
  await DB.putWord(w); showCard(); renderWords();
}
function closeReview() { $('review').hidden = true; W.review = null; renderWords(); }
$('bReview').onclick = startReview; $('rShow').onclick = reveal; $('rClose').onclick = closeReview;
$('rSay').onclick = () => { const w = W.review?.queue[0]; if (w) sayText(w.word); };
$('rGrade').querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => grade(+b.dataset.g)));
$('review').addEventListener('click', (e) => { if (e.target.id === 'review') closeReview(); });
document.addEventListener('keydown', (e) => {
  if (!W.review) return;
  if (e.key === 'Escape') { e.preventDefault(); closeReview(); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if ($('rAns').hidden) reveal(); else grade(2); }
  else if (!$('rGrade').hidden && '1234'.includes(e.key)) grade(+e.key - 1);
}, true);
$('mWord').onclick = saveWord;
loadWords();

/* ---------------- Boot ---------------- */
try { navigator.storage?.persist?.(); } catch {}
toggleSide(store.get('side', innerWidth >= 900)); showTab(store.get('tab', 'toc'));
(async () => {
  if (IN_APP) { await loadFolders(); setTimeout(() => scanFolders(true), 1500); }
  const last = store.get('lastBook', null);
  if (last && (await DB.getBook(last).catch(() => null))) openStored(last).catch((e) => { console.error(e); showLibrary(); });
  else showLibrary();
})();
if (!IN_APP && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
window.__margin = { S, T, pageSentences, unitSentences };
