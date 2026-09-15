// Probe: render the real built popup UI (dist/chrome-mv3/popup.html) in
// headless Chromium with a chrome.* stub, so we can screenshot the actual
// product UI for the ad video without needing the extension to register.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist/chrome-mv3');
const PORT = 4891;
const srv = http.createServer((req, res) => {
  let p = req.url === '/' ? '/popup.html' : req.url;
  const file = path.join(DIST, p.replace(/^\/+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(file);
  const ct = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html';
  res.writeHead(200, { 'Content-Type': ct });
  res.end(fs.readFileSync(file));
});
await new Promise(r => srv.listen(PORT, r));
console.log('serving dist/chrome-mv3 on', PORT);

const CHROME_STUB = `
window.chrome = {
  runtime: {
    id: 'stub-sih2026',
    getURL: p => 'http://127.0.0.1:${PORT}/' + p,
    sendMessage: async () => ({ ok: true, state: 'idle' }),
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    connect: () => ({ postMessage: () => {}, onMessage: { addListener: () => {} }, close: () => {} }),
  },
  tabs: {
    create: async () => ({ id: 1 }),
    query: async () => [{ id: 1, url: 'https://gov.in/apply/subsidy', active: true }],
    sendMessage: async () => ({ ok: true }),
    onUpdated: { addListener: () => {} },
    onActivated: { addListener: () => {} },
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
};
`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 640 } });
  await ctx.addInitScript(CHROME_STUB);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/popup.html`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
  const title = await page.title();
  console.log('popup title:', title);
  console.log('body text:', JSON.stringify(body));
  await page.screenshot({ path: 'screenshots/_probe_popup.png', fullPage: true });
  console.log('PROBE OK -> screenshots/_probe_popup.png');
} catch (e) {
  console.log('PROBE FAIL:', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
