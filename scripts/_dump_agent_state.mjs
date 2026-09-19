// Read persisted agent state/logs through the OPEN POPUP tab (SW may be asleep).
import { execSync } from 'node:child_process';
const cdp = JSON.parse(execSync('curl -s -m 5 http://127.0.0.1:9222/json', { shell: true }).toString());
// prefer the popup page; fall back to the service worker if awake
const pop = cdp.find(t => t.type === 'page' && t.url.includes('popup.html'));
const sw = cdp.find(t => t.type === 'service_worker' && t.url.includes('extension'));
const target = pop || sw;
if (!target) { console.log('neither popup nor SW available'); process.exit(1); }
console.log('using target:', target.url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
function send(method, params) {
  return new Promise((res) => {
    const id = ++seq;
    const onMsg = (e) => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
      if (m.id === id) { ws.removeEventListener('message', onMsg); res(m); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ error: 'timeout' }), 8000);
  });
}
await send('Runtime.enable');

const expr = `(async () => {
  const s = await chrome.storage.local.get(['sih_agent_task_state','sih_agent_logs']);
  const state = s['sih_agent_task_state'];
  const logs = s['sih_agent_logs'] || [];
  return JSON.stringify({
    state,
    logCount: logs.length,
    logTail: logs.slice(-40).map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\\n').slice(-6000),
  });
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const val = r.result?.result?.value;
if (!val) { console.log('eval failed:', JSON.stringify(r).slice(0, 500)); process.exit(0); }
const d = JSON.parse(val);
console.log('=== task_state ===');
console.log(JSON.stringify(d.state, null, 1).slice(0, 3000));
console.log('=== log count:', d.logCount, '=== last 40 entries (tail 6000 chars) ===');
console.log(d.logTail);
ws.close();
