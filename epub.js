// Margin - minimal offline EPUB reader.
// An EPUB is a zip of XHTML chapters. This reads the zip with the browser's own
// DecompressionStream (no libraries), finds the reading order and table of contents,
// and turns each chapter into clean HTML that Margin styles itself.

const td = new TextDecoder();

async function unzip(buf) {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a valid EPUB.');
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const entries = new Map(), lower = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, lho }); lower.set(name.toLowerCase(), name);
    p += 46 + nlen + xlen + clen;
  }
  const find = (name) => entries.get(name) || entries.get(lower.get(String(name).toLowerCase()));
  async function read(name) {
    const e = find(name); if (!e) return null;
    const ln = dv.getUint16(e.lho + 26, true), lx = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + ln + lx; const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('This EPUB uses a compression Margin can’t read.');
  }
  return { read, has: (n) => !!find(n) };
}

// resolve "href" relative to the file "base" (both zip paths), dropping any #fragment
function resolve(base, href) {
  try {
    const u = new URL(href, 'http://x/' + base.split('/').map(encodeURIComponent).join('/'));
    return { path: decodeURIComponent(u.pathname.slice(1)), hash: decodeURIComponent(u.hash.slice(1)) };
  } catch { return { path: href, hash: '' }; }
}
function parseXml(text, type = 'application/xml') {
  let doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}
const byTag = (root, tag) => [...root.getElementsByTagNameNS('*', tag)].concat(root.getElementsByTagNameNS ? [] : []);
const first = (root, tag) => root.getElementsByTagNameNS('*', tag)[0] || root.getElementsByTagName(tag)[0];
const attr = (e, name) => e?.getAttribute(name) ?? e?.getAttributeNS?.('http://www.idpf.org/2007/ops', name.split(':').pop()) ?? null;

// descriptions are often HTML, sometimes escaped twice ("&lt;p&gt;Tem&amp;uuml;jin") - make plain text with paragraphs
export function htmlToText(h) {
  let t = String(h || '');
  for (let i = 0; i < 3 && /<[a-z!\/]|&[#a-z0-9]+;/i.test(t); i++) {
    const d = new DOMParser().parseFromString(t.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n\n'), 'text/html');
    t = d.body.textContent || '';
  }
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function openEpub(buf) {
  const z = await unzip(buf);
  const readText = async (n) => { const d = await z.read(n); return d ? td.decode(d) : null; };
  const container = await readText('META-INF/container.xml');
  if (!container) throw new Error('This EPUB is missing its table of contents file.');
  const opfPath = first(parseXml(container), 'rootfile')?.getAttribute('full-path');
  const opf = parseXml(await readText(opfPath));

  const manifest = new Map(), byPath = new Map();
  for (const it of byTag(opf, 'item')) {
    const m = { id: it.getAttribute('id'), path: resolve(opfPath, it.getAttribute('href') || '').path, type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
    manifest.set(m.id, m); byPath.set(m.path, m);
  }
  const spineEl = first(opf, 'spine');
  const spine = byTag(spineEl, 'itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter((m) => m && /html|xml/.test(m.type) && !/ncx/.test(m.type));
  const title = first(opf, 'title')?.textContent?.trim() || '';
  const author = first(opf, 'creator')?.textContent?.trim() || '';
  // year of publication: <dc:date> (the publication one if marked) or a dcterms:issued meta
  const thisYear = new Date().getFullYear();
  const yearOf = (t) => { const m = String(t || '').match(/\b(1[4-9]\d\d|20\d\d)\b/); const y = m ? +m[1] : 0; return y && y <= thisYear ? y : 0; };
  let year = 0;
  const dates = byTag(opf, 'date');
  const pub = dates.find((d) => /publication|original/i.test(d.getAttribute('opf:event') || d.getAttributeNS('http://www.idpf.org/2007/opf', 'event') || ''));
  year = yearOf(pub?.textContent);
  if (!year) { const m = byTag(opf, 'meta').find((x) => /dcterms:(issued|date)/.test(x.getAttribute('property') || '')); year = yearOf(m?.textContent); }
  if (!year) for (const d of dates) { const ev = d.getAttribute('opf:event') || ''; if (/modification|creation/i.test(ev)) continue; year = yearOf(d.textContent); if (year) break; }

  // table of contents: EPUB 3 nav document, else EPUB 2 NCX
  let toc = [];
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) {
    const nav = parseXml(await readText(navItem.path), 'application/xhtml+xml');
    const navs = byTag(nav, 'nav');
    const tocNav = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
    const walk = (ol) => [...(ol?.children || [])].filter((li) => li.localName === 'li').map((li) => {
      const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
      const sub = [...li.children].find((c) => c.localName === 'ol');
      const href = a?.getAttribute('href');
      return { title: (a?.textContent || '').replace(/\s+/g, ' ').trim(), ...(href ? resolve(navItem.path, href) : {}), items: walk(sub) };
    });
    if (tocNav) toc = walk([...tocNav.children].find((c) => c.localName === 'ol'));
  }
  if (!toc.length) {
    const ncxItem = manifest.get(spineEl?.getAttribute('toc')) || [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncxItem) {
      const ncx = parseXml(await readText(ncxItem.path));
      const walk = (parent) => [...parent.children].filter((c) => c.localName === 'navPoint').map((np) => ({
        title: (first(np, 'text')?.textContent || '').replace(/\s+/g, ' ').trim(),
        ...resolve(ncxItem.path, first(np, 'content')?.getAttribute('src') || ''),
        items: walk(np),
      }));
      const map = first(ncx, 'navMap'); if (map) toc = walk(map);
    }
  }
  const spineIndex = (path) => spine.findIndex((m) => m.path === path);

  const urls = new Map();
  async function urlFor(path) {
    if (!urls.has(path)) urls.set(path, (async () => { const d = await z.read(path); if (!d) return ''; return URL.createObjectURL(new Blob([d], { type: byPath.get(path)?.type || '' })); })());
    return urls.get(path);
  }
  function close() { for (const p of urls.values()) p.then((u) => u && URL.revokeObjectURL(u)); urls.clear(); }

  async function chapter(i) {
    const item = spine[i];
    const src = await readText(item.path) || '';
    const doc = parseXml(src, 'application/xhtml+xml');
    const body = first(doc, 'body') || doc.documentElement;
    const out = document.createElement('div'); out.className = 'chap';
    await clean(body, out, { i, base: item.path, urlFor, spineIndex });
    // books often use empty tables just for spacing
    out.querySelectorAll('table').forEach((t) => { if (!t.textContent.trim() && !t.querySelector('img')) t.remove(); });
    return out;
  }
  // the book's cover picture: EPUB 3 "cover-image", EPUB 2 <meta name="cover">, an image called cover,
  // or else the first picture in the book
  let coverPath = ([...manifest.values()].find((m) => /\bcover-image\b/.test(m.props)) || {}).path;
  if (!coverPath) {
    const meta = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const it = meta && (manifest.get(meta.getAttribute('content')) || byPath.get(resolve(opfPath, meta.getAttribute('content') || '').path));
    if (it && /^image\//.test(it.type)) coverPath = it.path;
  }
  if (!coverPath) coverPath = ([...manifest.values()].find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + ' ' + m.path)) || {}).path;
  async function cover() {
    if (coverPath) return urlFor(coverPath);
    for (let i = 0; i < Math.min(3, spine.length); i++) { try { const img = (await chapter(i)).querySelector('img'); if (img) return img.src; } catch {} }
    return '';
  }
  // page count: the printed page list when the book has one, otherwise an estimate from the text
  // length (about 2,000 characters on a printed page)
  async function pages() {
    try {
      if (navItem) {
        const nav = parseXml(await readText(navItem.path), 'application/xhtml+xml');
        const pl = byTag(nav, 'nav').find((n) => /page-list/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || ''));
        const n = pl ? byTag(pl, 'li').length : 0; if (n > 5) return { pages: n, estimated: false };
      }
      const ncxItem = manifest.get(spineEl?.getAttribute('toc')) || [...manifest.values()].find((m) => /ncx/.test(m.type));
      if (ncxItem) { const n = byTag(parseXml(await readText(ncxItem.path)), 'pageTarget').length; if (n > 5) return { pages: n, estimated: false }; }
    } catch {}
    let chars = 0;
    for (const it of spine) {
      const t = await readText(it.path) || '';
      chars += t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, 'x').replace(/\s+/g, ' ').length;
    }
    return { pages: Math.max(1, Math.round(chars / 2000)), estimated: true };
  }
  // more about the book, from its package file
  const dc = (tag) => (first(opf, tag)?.textContent || '').trim();
  const publisher = dc('publisher');
  const language = dc('language');
  const description = htmlToText(dc('description'));
  const subjects = [...new Set(byTag(opf, 'subject').map((x) => x.textContent.trim()).filter(Boolean))];
  const isbn = byTag(opf, 'identifier').map((x) => (x.textContent.match(/\b97[89][\d-]{10,14}\b|\b\d{9}[\dXx]\b/) || [])[0]).find(Boolean)?.replace(/-/g, '') || '';
  return { title, author, year, publisher, language, description, subjects, isbn, toc, spine, spineIndex, chapter, cover, pages, close };
}

const KEEP = new Set('p div section article header footer main aside nav h1 h2 h3 h4 h5 h6 blockquote ul ol li dl dt dd em i strong b u s strike del ins sup sub small big cite q code pre kbd var samp abbr dfn mark span a br hr figure figcaption table thead tbody tfoot tr td th caption col colgroup center ruby rt rp rb'.split(' '));
const DROP = new Set('script style link meta iframe object embed form input button select textarea noscript title head audio video canvas math template'.split(' '));
const XLINK = 'http://www.w3.org/1999/xlink';

async function clean(src, out, ctx) {
  for (const n of [...src.childNodes]) {
    if (n.nodeType === 3) { out.append(document.createTextNode(n.nodeValue)); continue; }
    if (n.nodeType !== 1) continue;
    const tag = (n.localName || '').toLowerCase();
    if (DROP.has(tag)) continue;
    if (tag === 'img' || tag === 'image') {
      const href = n.getAttribute('src') || n.getAttributeNS(XLINK, 'href') || n.getAttribute('xlink:href') || n.getAttribute('href');
      if (href) { const img = document.createElement('img'); img.alt = n.getAttribute('alt') || ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = await ctx.urlFor(resolve(ctx.base, href).path); out.append(img); }
      continue;
    }
    if (tag === 'svg') { // cover pages often wrap an <image> in svg
      for (const im of n.getElementsByTagNameNS('*', 'image')) await clean({ childNodes: [im] }, out, ctx);
      continue;
    }
    if (!KEEP.has(tag)) { await clean(n, out, ctx); continue; }
    const e = document.createElement(tag === 'center' ? 'div' : tag === 'big' ? 'span' : tag);
    const id = n.getAttribute('id'); if (id) e.id = `e${ctx.i}-${id}`;
    if (tag === 'td' || tag === 'th') for (const a of ['colspan', 'rowspan']) if (n.getAttribute(a)) e.setAttribute(a, n.getAttribute(a));
    const type = (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '') + ' ' + (n.getAttribute('role') || '');
    if (/noteref/.test(type)) e.classList.add('noteref');
    if (/footnote|endnote|rearnote/.test(type)) e.classList.add('footnote');
    if (tag === 'a') {
      const href = n.getAttribute('href') || n.getAttributeNS(XLINK, 'href');
      if (href && /^(https?:|mailto:)/i.test(href)) { e.href = href; e.target = '_blank'; e.rel = 'noopener'; }
      else if (href) {
        const r = href.startsWith('#') ? { path: ctx.base, hash: href.slice(1) } : resolve(ctx.base, href);
        const s = ctx.spineIndex(r.path);
        if (s >= 0) { e.href = '#'; e.dataset.sec = s + 1; if (r.hash) e.dataset.anchor = `e${s}-${r.hash}`; }
      }
    }
    if (tag === 'p' || tag === 'div') { const al = (n.getAttribute('style') || '').match(/text-align:\s*(center|right)/i); if (al) e.style.textAlign = al[1]; }
    out.append(e);
    await clean(n, e, ctx);
  }
}
