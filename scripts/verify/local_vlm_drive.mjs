// #113 ground-truth drive: clear the mirror request log, then send the EXACT
// message the agent's confirmGoal sends ({type:'VISION_OCR'}) to a focused web
// tab and dump the FULL response. The sub-error string ("no screenshot" /
// "vision init failed: ..." / "empty ocr") + the mirror fetch log together
// pinpoint why confirmGoal returns null -> "on-device model unavailable".
// Long timeout: a cold profile's first WebGPU load+inference is 20-44s.
// Usage: node scripts/verify/local_vlm_drive.mjs   (CDP :9222, mirror :8123)
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9222';
const MIRROR = 'http://127.0.0.1:8123';
const MIRROR_LOG = new URL('../local-model-request.log', import.meta.url).pathname;
const getTargets = () => JSON.parse(execSync(`curl -s -m 5 ${CDP}/json`, { shell: true }).toString());

// Fresh mirror log so its contents are purely from THIS extension run.
try { appendFileSync(MIRROR_LOG, `\n=== vlm-drive ${new Date().toISOString()} ===\n`); } catch {}

const sw = getTargets().find((t) => t.type === 'service_worker' && t.url.includes('extension'));
if (!sw) { console.log('SW not awake - open the popup once, then re-run'); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const send = (method, params, timeout = 180000) => new Promise((res) => {
  const id = ++seq;
  const onMsg = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', onMsg); res(m); } };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ error: 'timeout' }), timeout);
});
await send('Runtime.enable');

// 1. point the content script at the local mirror + confirm it's set.
const keyState = await send('Runtime.evaluate', {
  expression: `(async () => {
    await chrome.storage.local.set({ sih_vlm_local_model_url: ${JSON.stringify(MIRROR)}});
    const g = await chrome.storage.local.get('sih_vlm_local_model_url');
    return 'key=' + g.sih_vlm_local_model_url;
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log('[1] ' + (keyState.result?.result?.value ?? JSON.stringify(keyState).slice(0, 120)));

// 2+3. ONE expression: focus a web tab, then send the exact agent message.
const ocr = await send('Runtime.evaluate', {
  expression: `(async () => {
    const tabs = await chrome.tabs.query({});
    let web = tabs.find((t) => /^https?:/.test(t.url));
    if (!web) { web = await chrome.tabs.create({ url: 'https://en.wikipedia.org/wiki/Hypertext', active: true }); }
    else { await chrome.tabs.navigate(web.id, { url: 'https://en.wikipedia.org/wiki/Hypertext' }); }
    await chrome.tabs.update(web.id, { active: true });
    try { await chrome.windows.update(web.windowId, { focused: true }); } catch (e) {}
    await new Promise((r) => setTimeout(r, 4000)); // let the content script inject on the fresh page
    const t0 = Date.now();
    let res;
    try { res = await chrome.tabs.sendMessage(web.id, { type: 'VISION_OCR' }); }
    catch (e) { return JSON.stringify({ ok: false, error: 'sendMessage: ' + (e?.message ?? String(e)), ms: Date.now() - t0 }); }
    return JSON.stringify({
      ok: res?.ok, ms: Date.now() - t0,
      textLen: res?.text?.length ?? 0,
      textHead: (res?.text ?? '').slice(0, 200),
      error: res?.error || null,
    });
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log('[2] VISION_OCR:', ocr.result?.result?.value ?? JSON.stringify(ocr).slice(0, 400));

// 4. read back the mirror log - did the extension pull the ONNX files?
ws.close();
const { readFileSync } = await import('node:fs');
let log = '';
try { log = readFileSync(MIRROR_LOG, 'utf8'); } catch {}
const after = log.split('=== vlm-drive').pop() || log;
const onnx = after.split('\n').filter((l) => l.includes('.onnx'));
console.log('[3] mirror fetches this run:');
console.log(after.trim().split('\n').filter((l) => l.trim() && !l.startsWith('===')).join('\n').slice(0, 800) || '(none)');
console.log('[3] .onnx files fetched: ' + onnx.length);
