// Runs the Kokoro neural voice off the main thread.
// First run downloads the library (from jsDelivr) and the voice model (from Hugging Face);
// after that both come from the browser's cache, so it works offline.
const SOURCES = [
  'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.0/dist/kokoro.web.js',
  'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.0/+esm',
];
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;
let chain = Promise.resolve();

async function importKokoro() {
  let lastErr;
  for (const src of SOURCES) {
    try { const mod = await import(src); if (mod.KokoroTTS) return mod.KokoroTTS; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not load the voice library.');
}

// is the voice file already saved in this browser? (the voice library keeps it in "transformers-cache")
async function voiceStored(file) {
  try {
    const keys = await (await caches.open('transformers-cache')).keys();
    return keys.some((r) => r.url.includes('Kokoro-82M-v1.0-ONNX') && r.url.includes('/onnx/' + file));
  } catch { return null; }
}

async function load(device) {
  const gpu = device === 'webgpu' && !!self.navigator?.gpu;
  postMessage({ type: 'stored', stored: await voiceStored(gpu ? 'model.onnx' : 'model_quantized.onnx') });
  const KokoroTTS = await importKokoro();
  const progress_callback = (p) => postMessage({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } });
  if (device === 'webgpu' && self.navigator?.gpu) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback });
      postMessage({ type: 'ready', device: 'webgpu', storedAfter: await voiceStored('model.onnx') }); return;
    } catch (e) { /* fall back to CPU */ }
  }
  tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback });
  // multi-core works only when the page is served with isolation headers (Start Margin.bat does this)
  const threads = self.crossOriginIsolated ? Math.min(4, Math.ceil((self.navigator?.hardwareConcurrency || 2) / 2)) : 1;
  postMessage({ type: 'ready', device: 'wasm', threads, storedAfter: await voiceStored('model_quantized.onnx') });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    load(m.device).catch((err) => postMessage({ type: 'error', id: null, message: String(err?.message || err) }));
    return;
  }
  if (m.type === 'gen') {
    // one generation at a time; the page queues a few sentences ahead
    chain = chain.then(async () => {
      try {
        const audio = await tts.generate(m.text, { voice: m.voice, speed: m.speed });
        const pcm = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        postMessage({ type: 'audio', id: m.id, pcm, sr: audio.sampling_rate }, [pcm.buffer]);
      } catch (err) {
        postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
      }
    });
  }
};
