/* Margin on Android: connects the page to the Android app (MarginAndroid, added by MainActivity).
   It stands in for the Windows app's WebView2 bridge, so app.js runs unchanged, and adds what
   Android's WebView lacks: the phone's own voices (speechSynthesis) and saving files to Downloads. */
(() => {
  const A = window.MarginAndroid; if (!A) return;
  document.documentElement.classList.add('android');

  /* ---- the Windows-app bridge: chrome.webview.hostObjects.margin.X(...) returns a promise ---- */
  const waiting = new Map(); let seq = 0;
  window.__marginReply = (id, json) => { const f = waiting.get(id); if (f) { waiting.delete(id); f(json == null ? undefined : JSON.parse(json)); } };
  const margin = new Proxy({}, {
    get: (_, name) => typeof name !== 'string' || name === 'then' ? undefined : (...args) => new Promise((res, rej) => {
      const id = 'r' + (++seq);
      let r; try { r = A.call(name, JSON.stringify(args), id); } catch (e) { rej(e); return; }
      if (r === '"__async"') waiting.set(id, res); else res(r == null || r === '' ? undefined : JSON.parse(r));
    }),
  });
  const listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    hostObjects: { margin },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: () => {},
  };
  window.__marginPost = (json) => { const data = JSON.parse(json); for (const fn of listeners) try { fn({ data }); } catch (e) { console.error(e); } };

  /* ---- the phone's voices, through Android's TextToSpeech ---- */
  let voices = [];
  const utts = new Map(); let useq = 0, current = null;
  class Utterance {
    constructor(text) { this.text = String(text || ''); this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null; this.lang = ''; this.onstart = this.onend = this.onerror = this.onboundary = this.onpause = this.onresume = null; }
  }
  const fire = (u, type, extra) => { const f = u['on' + type]; if (f) try { f(Object.assign({ type, utterance: u, charIndex: 0, name: type === 'boundary' ? 'word' : undefined }, extra)); } catch (e) { console.error(e); } };
  function speakFrom(u, offset) {
    const id = 'u' + (++useq);
    utts.set(id, { u, offset }); current = { id, u, offset, last: offset };
    A.ttsSpeak(id, u.text.slice(offset), u.voice ? u.voice.voiceURI : '', +u.rate || 1, +u.pitch || 1, u.volume == null ? 1 : Math.max(0, Math.min(1, +u.volume)));
  }
  window.__tts = (id, type, ch) => {
    const rec = utts.get(id); if (!rec) return;
    const { u, offset } = rec;
    if (type === 'start') { if (!offset) fire(u, 'start'); }
    else if (type === 'word') { const at = offset + ch; if (current && current.id === id) current.last = at; fire(u, 'boundary', { charIndex: at }); }
    else if (type === 'end') { utts.delete(id); if (current && current.id === id) current = null; synth.speaking = false; fire(u, 'end'); }
    else if (type === 'error') { utts.delete(id); if (current && current.id === id) current = null; synth.speaking = false; fire(u, 'error', { error: 'synthesis-failed' }); }
  };
  window.__ttsVoices = () => {
    try { voices = JSON.parse(A.ttsVoices() || '[]'); } catch { voices = []; }
    if (synth.onvoiceschanged) try { synth.onvoiceschanged(); } catch {}
  };
  const synth = {
    speaking: false, paused: false, pending: false, onvoiceschanged: null,
    getVoices: () => voices,
    speak(u) { this.speaking = true; this.paused = false; speakFrom(u, 0); },
    cancel() { utts.clear(); current = null; this.speaking = false; this.paused = false; A.ttsStop(); },
    // Android cannot pause a voice: stop, and on resume start again from the last word spoken
    pause() { if (!current || this.paused) return; this.paused = true; const c = current; utts.delete(c.id); A.ttsStop(); this.held = c; },
    resume() { if (!this.paused) return; this.paused = false; const c = this.held; this.held = null; if (c) speakFrom(c.u, c.last); },
    addEventListener() {}, removeEventListener() {},
  };
  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true }); } catch { window.speechSynthesis = synth; }
  window.SpeechSynthesisUtterance = Utterance;
  A.ttsInit();

  /* ---- downloads (Export, Back up library): a.click() on a blob link saves into Downloads/Margin ---- */
  const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
  async function save(href, name) {
    try {
      const blob = await (await fetch(href)).blob();
      const id = A.saveBegin(name || 'Margin file', blob.type || 'application/octet-stream');
      if (!id) throw new Error('no file');
      const CH = 3 * 512 * 1024;
      for (let o = 0; o < blob.size; o += CH) A.saveChunk(id, await toB64(blob.slice(o, o + CH)));
      A.saveEnd(id);
    } catch (e) { A.toast('Could not save the file: ' + (e && e.message || e)); }
  }
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && /^(blob|data):/.test(this.href)) { save(this.href, this.getAttribute('download')); return; }
    return click.call(this);
  };

  /* ---- a PDF or EPUB opened with Margin from another app ---- */
  window.__marginOpenShared = async () => {
    const name = A.sharedName(); if (!name) return;
    for (let i = 0; i < 100 && !(window.marginHost && window.marginHost.openFile); i++) await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch('/shared?t=' + Date.now()); if (!r.ok) throw new Error('could not read it');
      const blob = await r.blob();
      window.marginHost.openFile(new File([blob], name, { type: blob.type }));
    } catch (e) { A.toast('Could not open ' + name + ': ' + (e && e.message || e)); }
  };
  addEventListener('load', () => window.__marginOpenShared());
})();
