// End-to-end Bug C test: drive the REAL popup UI to start the two-search
// task, then watch the GROUND-TRUTH persisted log (sih_agent_task_state in
// browser.storage.local) until the run ends.
//
// Why storage, not DOM: the agent is SW-owned, and its navigate channel
// targets the ACTIVE tab. The kick-off opens the popup as a tab and the agent
// immediately navigates it to the start URL, clobbering the popup UI. The
// driver's DOM poll therefore sees a wiki page, not the log. The persisted
// state is the reliable source of truth.
import { execSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const ID = 'npflaobdhllbgleohljinimffoolfpng';
const TASK =
  "Read-only task. Using the Wikipedia search box, look up 'Web browser' and open that article. " +
  "Then, from that article, use the search box to look up 'Progressive web app' and open it. " +
  "The task is COMPLETE only when the 'Progressive web app' article is on screen. " +
  "Do not log in, create an account, or edit anything.";
const START_URL = 'https://en.wikipedia.org/wiki/Main_Page';
const WAIT_MS = 220000; // ~3.5 min budget for the multi-page task

const json = () => JSON.parse(execSync(`curl -s ${CDP}/json`, { shell: true }).toString());

// ── kick-off: open the popup UI, fill task + start URL, click Start ─────────
const FALLBACK_IDS = [ID];
function discoverIds() {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  for (const t of json()) {
    if (t.url?.startsWith('chrome-extension://')) push(t.url.match(/chrome-extension:\/\/([^/]+)/)?.[1]);
  }
  for (const id of FALLBACK_IDS) push(id);
  return ids;
}
function openPopupTab(id) {
  const url = 'chrome-extension://' + id + '/popup.html';
  return (async () => {
    const existing = json().find((t) => t.url === url && t.webSocketDebuggerUrl);
    if (existing) return existing;
    try {
      const put = await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
      if (put.ok) { const p = await put.json(); if (p?.webSocketDebuggerUrl) return p; }
    } catch {}
    try { const g = await fetch(CDP + '/json/new?' + encodeURIComponent(url)); return JSON.parse((await g.text())); }
    catch { return null; }
  })();
}

// Connect to a target and drive it.
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let idc = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++idc; pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send, ready: () => new Promise((r) => ws.addEventListener('open', r, { once: true })) };
}
const evalJs = (client, expr) =>
  client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((r) => {
      if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    });

console.log('=== KICK-OFF ===');
let popup = null;
for (const cand of discoverIds()) {
  const t = await openPopupTab(cand);
  if (!t?.webSocketDebuggerUrl) { console.log('candidate', cand, ': no target'); continue; }
  const c = cdpClient(t.webSocketDebuggerUrl);
  await c.ready();
  await c.send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 2000)); // React mount + storage hydrate
  const mount = await evalJs(c, `
    (async () => {
      for (let i = 0; i < 20; i++) {
        if (document.querySelector('.task-textarea')) return 'MOUNTED';
        await new Promise(r => setTimeout(r, 500));
      }
      return 'NOT_MOUNTED :: ' + (document.body ? document.body.innerText.slice(0,200) : '(no body)');
    })()
  `);
  if (String(mount).startsWith('NOT_MOUNTED')) {
    console.log('candidate', cand, 'did not mount -', mount);
    c.ws.close(); continue;
  }
  console.log('popup mounted on extension id:', cand);
  const taskLen = await evalJs(c, `(() => {
    const ta = document.querySelector('.task-textarea');
    const native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    native.call(ta, ${JSON.stringify(TASK)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()`);
  console.log('task set, length:', taskLen);
  const urlVal = await evalJs(c, `(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const inp = inputs.find((i) => (i.placeholder || '').includes('current tab')) ||
                inputs.find((i) => (i.placeholder || '').includes('blank')) ||
                inputs.find((i) => (i.placeholder || '').includes('https')) ||
                inputs.find((i) => (i.placeholder || '').includes('Start'));
    if (!inp) return 'NO_START_URL_INPUT';
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    native.call(inp, ${JSON.stringify(START_URL)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value || '(empty)';
  })()`);
  console.log('startUrl set:', urlVal);
  const clicked = await evalJs(c, `(() => {
    const b = document.querySelector('.start-button');
    if (!b) return 'NO_START_BUTTON';
    if (b.disabled) return 'DISABLED';
    b.click(); return 'CLICKED';
  })()`);
  console.log('start clicked:', clicked);
  popup = cand;
  c.ws.close();
  break;
}
if (!popup) {
  console.error('No mounting popup found. Reload the extension / ensure Chrome has --load-extension.');
  process.exit(1);
}

console.log('\n=== WATCHING PERSISTED LOG (ground truth) ===');
// Poll storage every 4s until running=false or budget. Prefer the SW target
// (alive while the loop runs); fall back to a fresh popup page.
async function readState() {
  const sw = json().find((t) => t.type === 'service_worker' && t.url?.includes('background.js'));
  const target = sw || json().find((t) => t.url === `chrome-extension://${popup}/popup.html`);
  if (!target?.webSocketDebuggerUrl) return null;
  const c = cdpClient(target.webSocketDebuggerUrl);
  await c.ready();
  await c.send('Runtime.enable');
  const r = await c.send('Runtime.evaluate', {
    expression: `(async () => {
      const ext = (typeof browser !== 'undefined') ? browser : chrome;
      const s = await ext.storage.local.get('sih_agent_task_state');
      const st = s['sih_agent_task_state'];
      if (!st) return { empty: true };
      return { running: st.running, status: st.status, step: st.step,
               logCount: (st.logs||[]).length, lastLogs: (st.logs||[]).slice(-45) };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  c.ws.close();
  return r?.result?.value ?? null;
}

const t0 = Date.now();
let state = null;
while (Date.now() - t0 < WAIT_MS) {
  await new Promise((r) => setTimeout(r, 4000));
  state = await readState();
  if (!state || state.empty) {
    console.log(`[${Math.round((Date.now()-t0)/1000)}s] (no state yet - SW may be initializing)`);
    continue;
  }
  const last = state.lastLogs?.slice(-3).join(' | ');
  console.log(`[${Math.round((Date.now()-t0)/1000)}s] running=${state.running} status=${state.status} step=${state.step} logs=${state.logCount}`);
  if (last) console.log('   tail:', last.slice(0, 300));
  if (state.running === false && state.status && state.status !== 'idle') break;
}

console.log('\n=== FINAL ===');
state = state || await readState();
if (state?.empty) console.log('no persisted state - task likely did not start.');
else {
  console.log('status:', state.status, '| step:', state.step, '| running:', state.running);
  console.log('--- last ' + (state.lastLogs?.length || 0) + ' log lines ---');
  (state.lastLogs || []).forEach((l) => console.log(' ', l));
}
// where did the wiki tab end up?
const wiki = json().filter((t) => t.url?.includes('wikipedia'));
console.log('\nwikipedia tab(s):', wiki.map((t) => t.url).join('  |  ') || '(none)');
const doneOk = state?.status === 'complete';
console.log('\nRESULT:', doneOk ? 'COMPLETE' : (state?.status ?? 'unknown'));
process.exit(0);
