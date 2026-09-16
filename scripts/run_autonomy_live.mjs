// Drive the REAL extension popup UI (chrome-extension://<id>/popup.html) via CDP:
//  - open the popup as a tab
//  - set the task textarea + start-URL input via native setters (React-safe)
//  - click the Start button
//  - poll for task completion, capturing logs
// The extension's background worker does all the agent work; this script only
// operates the visible product UI and reports what happened.
import { execSync } from 'node:child_process';

const CDP = 'http://127.0.0.1:9222';
const TASK =
  "Read-only task. Using the Wikipedia search box, look up 'Web browser' and open that article. " +
  "Then, from that article, use the search box to look up 'Progressive web app' and open it. " +
  "The task is COMPLETE only when the 'Progressive web app' article is on screen. " +
  "Do not log in, create an account, or edit anything.";
const START_URL = 'https://en.wikipedia.org/wiki/Main_Page';

const json = () => JSON.parse(execSync(`curl -s ${CDP}/json`, { shell: true }).toString());

// ─── Robust extension-id discovery ─────────────────────────────────────────
// A keyless unpacked extension's id is PATH-derived and changes across
// builds/profiles, and the MV3 service worker SPINS DOWN when idle so it is
// frequently absent from /json. The old code only looked at the service_worker
// target then fell back to a hardcoded id that went stale -> blank popup / 404.
//
// Fix: collect every chrome-extension:// target (service_worker, page, iframe)
// as candidates, then OPEN each candidate's popup and use the first one that
// actually mounts our React UI (.task-textarea). A last-resort hardcoded id
// covers the "SW fully down, no extension targets" case.
const FALLBACK_IDS = ['npflaobdhllbgleohljinimffoolfpng'];

function discoverIds() {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  try {
    const targets = json();
    // service_worker-derived ids first (most authoritative when present).
    for (const t of targets) {
      if (t.type === 'service_worker') push(t.url?.match(/chrome-extension:\/\/([^/]+)/)?.[1]);
    }
    for (const t of targets) {
      if (t.url?.startsWith('chrome-extension://')) push(t.url.match(/chrome-extension:\/\/([^/]+)/)?.[1]);
    }
  } catch { /* CDP down */ }
  for (const id of FALLBACK_IDS) push(id);
  return ids;
}

function openPopupTab(id) {
  const url = 'chrome-extension://' + id + '/popup.html';
  return (async () => {
    try {
      const put = await fetch(CDP + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
      if (put.ok) {
        const p = await put.json();
        if (p?.webSocketDebuggerUrl) return p;
      }
    } catch {}
    const get = await fetch(CDP + '/json/new?' + encodeURIComponent(url));
    try { return JSON.parse((await get.text())); } catch { return null; }
  })();
}

async function popupMounts(wsUrl, selector = '.task-textarea', tries = 16) {
  const ws = new WebSocket(wsUrl);
  let idc = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++idc; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  try {
    await new Promise((r) => (ws.onopen = r));
    await send('Runtime.enable');
    const out = await send('Runtime.evaluate', {
      expression: `(async()=>{for(let i=0;i<${tries};i++){if(document.querySelector(${JSON.stringify(selector)}))return true;await new Promise(r=>setTimeout(r,500));}return false;})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return out?.result?.value === true;
  } catch {
    return false;
  } finally {
    ws.close();
  }
}

// Open the popup, trying each discovered id, and keep the first that mounts.
let popup = null;
let extId = null;
for (const cand of discoverIds()) {
  const target = await openPopupTab(cand);
  if (!target?.webSocketDebuggerUrl) { console.log('candidate', cand, ': no target'); continue; }
  const ok = await popupMounts(target.webSocketDebuggerUrl);
  if (ok) {
    popup = target;
    extId = cand;
    console.log('popup mounted on extension id:', extId);
    break;
  }
  console.log('candidate', cand, 'did not mount - trying next');
}
if (!popup || !extId) {
  console.error('No extension id produced a mounting popup. Check: CDP Chrome up with --load-extension, extension reloaded?');
  process.exit(1);
}
console.log('extension id:', extId);
const wsUrl = popup.webSocketDebuggerUrl;

// minimal CDP client over WebSocket (Node 22 has global WebSocket)
const ws = new WebSocket(wsUrl);
let idc = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
};
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const i = ++idc;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2500)); // let React mount + read storage

// Wait for the task textarea to exist (React mount). Dump body if absent.
const waitMount = await (
  send('Runtime.evaluate', {
    expression: `
      (async () => {
        for (let i = 0; i < 20; i++) {
          if (document.querySelector('.task-textarea')) return 'MOUNTED';
          await new Promise(r => setTimeout(r, 500));
        }
        return 'NOT_MOUNTED :: ' + document.body.innerText.slice(0, 400);
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
  })
).then((r) => r.result.value);
console.log('popup mount:', waitMount);
if (String(waitMount).startsWith('NOT_MOUNTED')) {
  const doc = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML.slice(0, 2000)', returnByValue: true });
  console.log('POPUP HTML DUMP:', doc.result.value);
  process.exit(1);
}

// set React-controlled inputs using the native value setter + input event
const evalJs = (expr) =>
  send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  }).then((r) => {
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  });

const setTask = `
  (() => {
    const ta = document.querySelector('.task-textarea');
    const native = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    native.call(ta, ${JSON.stringify(TASK)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()
`;
const taskLen = await evalJs(setTask);
console.log('task set, length:', taskLen);

const setUrl = `
  (() => {
    const inputs = Array.from(document.querySelectorAll('input.api-key-input, input'));
    // the start-URL input is the one whose placeholder mentions 'signup' or 'current tab'
    const inp = inputs.find((i) => (i.placeholder || '').includes('current tab')) ||
                inputs.find((i) => (i.placeholder || '').includes('blank'));
    if (!inp) return 'NO_START_URL_INPUT';
    const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    native.call(inp, ${JSON.stringify(START_URL)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return inp.value;
  })()
`;
const urlVal = await evalJs(setUrl);
console.log('startUrl set:', urlVal);

// take a screenshot of the configured popup BEFORE start
await send('Page.enable').catch(() => {});
const pre = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (pre) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('screenshots/autonomy_popup_before.png', Buffer.from(pre.data, 'base64'));
  console.log('screenshot: screenshots/autonomy_popup_before.png');
}

// click Start
const clickRes = await evalJs(`
  (() => {
    const b = document.querySelector('.start-button');
    if (!b) return 'NO_START_BUTTON';
    if (b.disabled) return 'DISABLED';
    b.click();
    return 'CLICKED';
  })()
`);
console.log('start clicked:', clickRes);

// poll logs until task ends or times out (multi-page: give it plenty of room)
const poll = async () =>
  evalJs(`
    (() => {
      const logsEl = Array.from(document.querySelectorAll('*')).find((n) =>
        n.className && String(n.className).includes('log') && n.children.length > 0) ||
        document.querySelector('.log-area, .logs, [class*=log]');
      const bodyText = document.body.innerText;
      const started = /Starting task/.test(bodyText);
      const done = /Task complete|DONE|complete/i.test(bodyText) && /latency|seconds/i.test(bodyText);
      return {
        started,
        done,
        running: !!document.querySelector('.start-button.running'),
        lastLogs: bodyText.split('\\n').filter(l => l.trim()).slice(-12).join(' | '),
      };
    })()
  `);

const t0 = Date.now();
let state = null;
for (let i = 0; i < 40; i++) {
  state = await poll();
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[${secs}s] running=${state.running} started=${state.started} done=${state.done}\\n   ${state.lastLogs.slice(-300)}`
  );
  if (state.running === false && state.started && i > 2) break;
  if (secs > 240) break;
  await new Promise((r) => setTimeout(r, 6000));
}

// final screenshots
const post = await send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (post) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync('screenshots/autonomy_popup_after.png', Buffer.from(post.data, 'base64'));
  console.log('screenshot: screenshots/autonomy_popup_after.png');
}
console.log('FINAL STATE:', JSON.stringify(state, null, 2));

// where did the tab end up?
const targetsF = json();
console.log(
  'wikipedia tab now at:',
  targetsF.filter((t) => t.url?.includes('wikipedia')).map((t) => t.url).join(', ')
);
ws.close();
