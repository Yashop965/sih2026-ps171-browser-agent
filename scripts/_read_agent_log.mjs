// Read the persisted agent task log + state from the extension popup page over CDP.
// Usage: node scripts/_read_agent_log.mjs [filter-regex]
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';

const FILTER = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const cdp = JSON.parse(execSync('curl -s -m 3 http://127.0.0.1:9222/json', { shell: true }).toString());

async function evalIn(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  const msg = await new Promise(r => ws.on('message', d => { const m = JSON.parse(d); if (m.id === 1) r(m); }));
  ws.close();
  return msg.result?.result?.value;
}

// Prefer a live extension page; else the service worker.
const popup = cdp.find(t => t.type === 'page' && t.url.startsWith('chrome-extension://'));
const sw = cdp.find(t => t.type === 'service_worker');
const target = (popup && sw) ? sw : (popup || sw);
if (!target) { console.log('NO TARGET'); process.exit(0); }

const raw = await evalIn(target, `(async () => { const s = await chrome.storage.local.get(['sih_agent_logs','sih_agent_task_state']); return JSON.stringify({ logs: s.sih_agent_logs ?? null, state: s.sih_agent_task_state ?? null }); })()`);
if (!raw || raw === 'null') { console.log('EMPTY (extension page not hydrated yet or wrong target)'); process.exit(0); }
const data = JSON.parse(raw);
const logs = JSON.parse(data.logs || '[]');
const state = data.state;
console.log('STATUS:', state?.status ?? 'n/a', '| FINAL STEP:', state?.finalStep ?? 'n/a', '| LOG LINES:', logs.length);
console.log('--- state.checklist ---');
for (const c of state?.checklist ?? []) console.log(`  [${c.done ? 'x' : ' '}] ${c.desc}`);
const want = FILTER ? logs.filter(l => FILTER.test(l)) : logs.slice(-8);
console.log(FILTER ? `--- matching ${FILTER} ---` : '--- last 8 ---');
for (const l of want) console.log(l.slice(0, 200));
