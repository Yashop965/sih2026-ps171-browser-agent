// Wipe persisted agent state via the extension SW over CDP so a fresh run
// starts clean (a stale running:false terminal state would make the driver
// think the task already finished). One-shot.
import { execSync } from 'node:child_process';

const cdp = JSON.parse(execSync('curl -s -m 5 http://127.0.0.1:9222/json', { shell: true }).toString());
const sws = cdp.filter((t) => t.type === 'service_worker' && t.url.includes('extension'));
if (!sws.length) {
  console.log('no SW target - activate the extension first (open its popup), then rerun');
  process.exit(1);
}

// Use the SW whose id we know, else the first.
const target = sws[0];
// Node >= 22 has a global WebSocket client - no 'ws' dependency.
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
await new Promise((r) => setTimeout(r, 300));

// Activate the SW's extension API context and clear the two agent keys.
ws.send(JSON.stringify({
  id: 2,
  method: 'Runtime.evaluate',
  params: {
    expression: `(async () => {
      const ext = (typeof browser !== 'undefined') ? browser : chrome;
      await ext.storage.local.remove(['sih_agent_task_state', 'sih_agent_logs']);
      const after = await ext.storage.local.get(['sih_agent_task_state','sih_agent_logs']);
      return 'cleared=' + JSON.stringify({
        state: after['sih_agent_task_state'] == null,
        logs: after['sih_agent_logs'] == null,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  },
}));
const msg = await new Promise((r) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
    if (m.id === 2) r(m);
  };
  setTimeout(() => r({ id: 2, result: { result: { value: 'timeout waiting for eval result' } } }), 5000);
});
ws.close();
console.log('SW id:', target.url.split('/')[2]);
console.log(msg.result?.result?.value ?? 'eval failed: ' + JSON.stringify(msg));
