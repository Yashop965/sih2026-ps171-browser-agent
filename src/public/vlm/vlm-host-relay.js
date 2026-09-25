/*
 * #142: VLM offscreen-document relay (classic script, no imports).
 *
 * This is the thin bridge between the service worker and the dedicated
 * module worker that hosts the on-device Florence-2 pipeline. It ships as a
 * VERBATIM public asset (src/public -> dist root, never bundled) because the
 * MV3 extension CSP (`script-src 'self'`) forbids inline <script> in an
 * offscreen document - the relay must be an external file.
 *
 * PII boundary (the #100 "screenshot stays local" rule, unchanged): the SW
 * posts a data-URL (the captured tab) in; only OCR TEXT / detection boxes /
 * a pure status object come back. Pixels never enter the page DOM and never
 * reach the LLM.
 */
(() => {
  const ext = globalThis.chrome || globalThis.browser;
  if (!ext || !ext.runtime || !ext.runtime.onMessage) return;

  // Lazy: the heavy worker bundle (transformers.js inlined, ~900KB) is only
  // paid for on first use.
  let worker = null;
  const pending = new Map(); // id -> { resolve, timer }
  let seq = 0;

  const getWorker = () => {
    if (worker) return worker;
    // #141: the ORT runtime loads from the extension's own origin
    // (vlm/ort/, wasmPaths set inside the worker at init). A dedicated
    // module worker - unlike the SW scope and the content-script isolated
    // world - can import() same-origin module URLs AND expose WebGPU, which
    // is exactly the context the on-device VLM needs (probed in #113).
    worker = new Worker(ext.runtime.getURL('vlm-host-worker.js'), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      clearTimeout(slot.timer);
      slot.resolve(msg);
    };
    worker.onerror = (e) => {
      // Fail the whole queue - the next caller respawns a fresh worker.
      for (const [, slot] of pending) {
        clearTimeout(slot.timer);
        slot.resolve({ ok: false, error: 'vlm worker crashed: ' + e.message });
      }
      pending.clear();
      worker = null;
    };
    return worker;
  };

  const callWorker = (payload, timeoutMs) =>
    new Promise((resolve) => {
      const w = getWorker();
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'vlm host timeout' });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      w.postMessage({ id, ...payload });
    });

  // Message protocol (SW -> offscreen doc). Replies are the worker's
  // VlmResponse: {ok, text?, boxes?, status?, error?}.
  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    let p;
    let t;
    switch (msg.type) {
      case 'VLM_HOST_INIT':
        p = { type: 'INIT' };
        t = 300_000; // first run downloads the ~150MB q4 model
        break;
      case 'VLM_HOST_OCR':
        p = { type: 'OCR', dataUrl: msg.dataUrl };
        t = 120_000;
        break;
      case 'VLM_HOST_DETECT':
        p = { type: 'DETECT', dataUrl: msg.dataUrl, query: msg.query };
        t = 120_000;
        break;
      case 'VLM_HOST_CAPTION':
        p = { type: 'CAPTION', dataUrl: msg.dataUrl };
        t = 120_000;
        break;
      case 'VLM_HOST_VQA':
        p = { type: 'VQA', dataUrl: msg.dataUrl, query: msg.query };
        t = 120_000;
        break;
      case 'VLM_HOST_STATUS':
        p = { type: 'STATUS' };
        t = 10_000;
        break;
      default:
        return; // not ours
    }
    callWorker(p, t).then(sendResponse);
    return true; // hold the async sendResponse channel open
  });
})();
