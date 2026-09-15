// Capture the REAL built extension popup (dist/chrome-mv3/popup.html) in a
// realistic "alive, mid-task" state so the ad can show actual product UI
// (TaskPanel + live PII Detections + Privacy Ledger) with zero manual recording.
//
// Approach: serve dist/chrome-mv3 over HTTP (the popup is an ES module, which
// won't load from file://), stub the chrome.* APIs wxt/browser resolves to,
// pre-load a task, feed sample PII detections + ledger entries (matching the
// project's own pii-test-page sample data), and turn the status dot green by
// answering the local /health check.
//
// Deterministic: no real PII, no live network. Output: screenshots/ext_popup.png
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');        // repo root (scripts/..)
const DIST = path.join(ROOT, 'dist', 'chrome-mv3');
const OUT = path.join(ROOT, 'screenshots');
const PORT = 4891;

fs.mkdirSync(OUT, { recursive: true });

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

// --- sample data (mirrors public/pii-test-page.html values, no real PII) ----
const DETECTIONS = [
  { type: 'Aadhaar', selector: '#aadhaar-number', confidence: 0.97, isVerified: true, redacted: true },
  { type: 'PAN', selector: '#pan-number', confidence: 0.94, isVerified: true, redacted: true },
  { type: 'Bank', selector: '#account-number', confidence: 0.9, isVerified: false, redacted: true },
  { type: 'Phone', selector: '#mobile-number', confidence: 0.88, isVerified: false, redacted: true },
  { type: 'Card', selector: '#card-number', confidence: 0.92, isVerified: false, redacted: true },
  { type: 'Email', selector: '#email-address', confidence: 0.81, isVerified: false, redacted: false },
];
const now = Date.now();
const LEDGER = [
  { timestamp: now - 12000, tabId: 1, url: 'https://gov.in/apply/subsidy', type: 'Aadhaar', selector: '#aadhaar-number', confidence: 0.97, verified: true, action: 'REDACTED' },
  { timestamp: now - 11000, tabId: 1, url: 'https://gov.in/apply/subsidy', type: 'PAN', selector: '#pan-number', confidence: 0.94, verified: true, action: 'REDACTED' },
  { timestamp: now - 9000, tabId: 1, url: 'https://gov.in/apply/subsidy', type: 'metadata', selector: '', confidence: 1, verified: false, action: 'SENT_TO_SERVER', payloadSize: 1840 },
  { timestamp: now - 6000, tabId: 1, url: 'https://gov.in/apply/subsidy', type: 'plan', selector: '', confidence: 1, verified: false, action: 'SUCCESS', actionType: 'TYPE' },
];
const TASK = 'Fill the subsidy application form with the applicant details and submit it.';

// NOTE: in headless Chromium `window.chrome` is a READ-ONLY own property, so a
// plain `window.chrome = {...}` silently no-ops and the bundle keeps the native
// (extension-less) chrome object. We must override via defineProperty, and also
// set `globalThis.browser` because WXT resolves `globalThis.browser ?? chrome`.
const CHROME_STUB = `
(() => {
  const stub = {
    runtime: {
      id: 'stub-sih2026',
      getURL: p => 'http://127.0.0.1:${PORT}/' + p,
      onMessage: { addListener: () => {} },
      onConnect: { addListener: () => {} },
      connect: () => ({ postMessage: () => {}, onMessage: { addListener: () => {} }, close: () => {} }),
      // wxt/browser resolves runtime.sendMessage here
      sendMessage: async (msg) => {
        if (!msg) return { ok: true };
        if (msg.type === 'GET_PRIVACY_LEDGER') return ${JSON.stringify(LEDGER)};
        return { ok: true, elements: [] };
      },
    },
    tabs: {
      create: async () => ({ id: 1 }),
      query: async () => [{ id: 1, url: 'https://gov.in/apply/subsidy', active: true, title: 'Government Service Portal' }],
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      // capturePage returns the live PII detections for the "current" tab
      sendMessage: async (_id, msg) => {
        if (msg && msg.type === 'capturePage')
          return { ok: true, detectedPII: ${JSON.stringify(DETECTIONS)} };
        if (msg && msg.type === 'HIGHLIGHT') return { ok: true };
        return { ok: true };
      },
    },
    storage: { local: {
      get: async () => ({ task: ${JSON.stringify(TASK)}, providerKey: 'custom' }),
      set: async () => {},
    } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  // chrome is read-only in headless Chromium -> defineProperty, not assignment.
  Object.defineProperty(window, 'chrome', { value: stub, configurable: true, writable: false });
  window.browser = stub;   // WXT reads globalThis.browser first
})();
`;

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 660 }, deviceScaleFactor: 2 });
  // Answer the local planner /health check fast -> status dot turns green "Live".
  await ctx.route('http://localhost:8000/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }),
  );
  await ctx.addInitScript(CHROME_STUB);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/popup.html`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2500); // let the 1s ledger poll populate

  const head = await page.evaluate(() => document.body.innerText.slice(0, 120));
  console.log('popup head:', JSON.stringify(head));
  await page.screenshot({ path: path.join(OUT, 'ext_popup.png'), fullPage: true });
  console.log('OK -> screenshots/ext_popup.png');
} catch (e) {
  console.log('CAPTURE FAIL:', e.message.split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.close();
}
