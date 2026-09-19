// Navigate a CDP tab to Wikipedia Main_Page and enumerate the search form's
// inputs + buttons so we know whether the Go/submit control is even in the
// element table, and what its id is.
import { execSync } from 'node:child_process';
const cdp = JSON.parse(execSync('curl -s -m 5 http://127.0.0.1:9222/json', { shell: true }).toString());
// reuse the open wikipedia tab if present, else the popup won't help - find a page target
let page = cdp.find(t => t.type === 'page' && t.url.includes('wikipedia.org'));
if (!page) {
  // create one via the browser endpoint
  const created = JSON.parse(execSync('curl -s -m 5 "http://127.0.0.1:9222/json/new?https://en.wikipedia.org/wiki/Main_Page"', { shell: true }).toString());
  page = created;
}
console.log('navigating tab:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
function send(method, params) {
  return new Promise((res) => {
    const id = ++seq;
    const onMsg = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', onMsg); res(m); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ error: 'timeout' }), 15000);
  });
}
await send('Page.enable');
// ensure we're on Main_Page
await send('Page.navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
await new Promise((r) => setTimeout(r, 4000));

const expr = `(() => {
  const out = { title: document.title, url: location.href, buttons: [], searchInputs: [] };
  document.querySelectorAll('button, input[type=submit], input[type=button]').forEach((el) => {
    const r = el.getBoundingClientRect();
    out.buttons.push({
      tag: el.tagName, type: el.type || null,
      label: (el.textContent || el.value || '').trim().slice(0, 40),
      aria: el.getAttribute('aria-label'),
      inForm: !!el.closest('form'),
      formAction: el.closest('form')?.getAttribute('action') || null,
      visible: r.width > 2 && r.height > 2,
      id: el.id || null
    });
  });
  document.querySelectorAll('#searchInput, input[name=search], input[name=fulltextSearch]').forEach((el) => {
    out.searchInputs.push({
      id: el.id, name: el.name, placeholder: el.placeholder,
      inForm: !!el.closest('form'),
      formId: el.closest('form')?.id || null,
      formAction: el.closest('form')?.getAttribute('action') || null,
      formMethod: el.closest('form')?.getAttribute('method') || null,
      hasGoButtonInForm: !!el.closest('form')?.querySelector('button, input[type=submit]')
    });
  });
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const val = r.result?.result?.value;
console.log('=== search form structure on Main_Page ===');
console.log(val ? val : JSON.stringify(r).slice(0, 400));
ws.close();
