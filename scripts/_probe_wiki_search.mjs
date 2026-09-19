// Inspect the Wikipedia header search box DOM state on a live tab.
// Usage: node scripts/_probe_wiki_search.mjs
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';

const cdp = JSON.parse(execSync('curl -s -m 3 http://127.0.0.1:9222/json', { shell: true }).toString());
// A real wiki tab (not the extension popup).
let page = cdp.find(t => t.type === 'page' && t.url.includes('wikipedia.org'));
if (!page) {
  console.log('NO WIKI TAB - opening one via the existing tab');
  page = cdp.find(t => t.type === 'page');
  await ev(page, `(location.href='https://en.wikipedia.org/wiki/Tim_Berners-Lee')`);
  await new Promise(r => setTimeout(r, 4000));
}
async function ev(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  const m = await new Promise(r => ws.on('message', d => { const x = JSON.parse(d); if (x.id === 1) r(x); }));
  ws.close();
  return m.result?.result?.value;
}
const probe = `(async () => {
  const out = { url: location.href, scrollY: window.scrollY };
  // The two candidate search inputs Wikipedia ships
  const candidates = [
    { sel: '#searchInput', el: document.querySelector('#searchInput') },
    { sel: '#searchInput .sitedearch input, input#searchInput', el: null },
    { sel: '#search-toggle, [id*=search]', els: Array.from(document.querySelectorAll('[id*=earch]')).slice(0,8).map(e=>e.id) },
  ];
  const s = document.querySelector('#searchInput');
  const st = s ? getComputedStyle(s) : null;
  out.searchInput = s ? {
    rect: (() => { const r = s.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    display: st?.display, visibility: st?.visibility, widthPx: st?.width,
    parentWidth: s.parentElement ? Math.round(s.parentElement.getBoundingClientRect().width) : null,
  } : 'NOT FOUND';
  // Is the collapsed state?
  out.collapsedToggle = !!document.querySelector('#p-search, .vector-header__layout');
  // What our extractor would see: inputs currently passing visibility
  out.visibleInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(e => {
    const r = e.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }).map(e => ({ id: e.id, name: e.name, w: Math.round(e.getBoundingClientRect().width) }));
  return JSON.stringify(out, null, 1);
})()`;
console.log(await ev(page, probe));
