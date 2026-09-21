// #113 live diagnosis: why does the extension's VLM stay "unavailable"?
// Capture is GATED before model-init in ocrVisibleScreen, so we first isolate
// whether captureVisibleTab itself works in the live extension. Connects to
// the SW and reports the exact captureVisibleTab outcome on the focused web
// tab, so we know if the blocker is (a) the capture permission/focus or
// (b) the model load.
// Usage: node scripts/verify/local_vlm_drive.mjs   (CDP :9222)
import { execSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const getTargets = () => JSON.parse(execSync(`curl -s -m 5 ${CDP}/json`, { shell: true }).toString());
const sw = getTargets().find((t) => t.type === 'service_worker' && t.url.includes('extension'));
if (!sw) { console.log('SW not awake - open the popup once, then re-run'); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const send = (method, params, timeout = 30000) => new Promise((res) => {
  const id = ++seq;
  const onMsg = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', onMsg); res(m); } };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ error: 'timeout' }), timeout);
});
await send('Runtime.enable');

// Focus the web tab + its window, then capture it directly in the SW.
const cap = await send('Runtime.evaluate', {
  expression: `(async () => {
    const all = await chrome.tabs.query({});
    const web = all.find((t) => /^https?:/.test(t.url));
    if (!web) return JSON.stringify({ step: 'no web tab' });
    await chrome.tabs.update(web.id, { active: true });
    let winErr = null;
    try { await chrome.windows.update(web.windowId, { focused: true }); } catch (e) { winErr = String(e); }
    await new Promise((r) => setTimeout(r, 600));
    let dataUrl = null, capErr = null;
    try { dataUrl = await chrome.tabs.captureVisibleTab(web.windowId); }
    catch (e) { capErr = e?.message ?? String(e); }
    return JSON.stringify({
      tab: web.url, windowId: web.windowId, winErr,
      captureOk: !!dataUrl,
      bytes: dataUrl ? dataUrl.length : 0,
      capErr: capErr || (dataUrl ? 'ok' : 'dataUrl was undefined (no error thrown)'),
    });
  })()`,
  awaitPromise: true, returnByValue: true,
});
const out = cap.result?.result?.value;
console.log('captureVisibleTab (SW, focused web tab): ' + (out ?? JSON.stringify(cap).slice(0, 300)));
ws.close();
