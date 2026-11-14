// Keeps the app and the voice library available offline.
const SHELL = 'margin-shell-v3';
const LIBS = 'margin-libs-v1';
const SHELL_FILES = ['./', './index.html', './app.js', './epub.js', './tts-worker.js', './manifest.webmanifest', './icon.svg', './lib/pdfjs/pdf.mjs', './lib/pdfjs/pdf.worker.mjs'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, LIBS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // local files: fresh copy when the server answers, cached copy otherwise
    e.respondWith(fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then((s) => s.put(req, c)); } return res; }).catch(() => caches.match(req)));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    // voice library + speech engine files: cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const c = res.clone(); caches.open(LIBS).then((s) => s.put(req, c)); } return res; })));
  }
  // the voice model (huggingface.co) is cached by the voice library itself
});
