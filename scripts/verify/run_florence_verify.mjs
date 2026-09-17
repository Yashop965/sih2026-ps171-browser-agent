// Florence-2 on-device verification driver (issue #100, verify-first)
// 1. Real Chromium captures https://en.wikipedia.org/wiki/Progressive_web_app
// 2. Same browser loads the repo's transformers.js and runs <OD> grounding +
//    <OCR> against that screenshot, entirely on-device.
// Prereq: a static server rooted at the repo on port 8123
//   (python -m http.server 8123) so the page can import node_modules + /shots.
// Run: node scripts/verify/run_florence_verify.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = 'http://127.0.0.1:8123';
const SHOT = 'pwa.png';
const QUERY = 'progressive web app';

mkdirSync(new URL('../../shots/', import.meta.url), { recursive: true });

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

// ── 1. capture the live PWA article (top of page = H1 heading zone) ──
const shotPage = await ctx.newPage();
await shotPage.goto('https://en.wikipedia.org/wiki/Progressive_web_app', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await shotPage.waitForTimeout(2000);
const png = await shotPage.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 800 } });
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('../../shots/' + SHOT, import.meta.url), png);
console.log('[1] screenshot saved:', SHOT, png.length, 'bytes');

// ── 2. run Florence-2 on-device in the second tab ──
const modelPage = await ctx.newPage();
modelPage.on('console', (m) => console.log('  [page]', m.text()));
await modelPage.goto(
  `${ROOT}/scripts/verify/florence-page.html?img=${SHOT}&query=${encodeURIComponent(QUERY)}&local=1`,
);
console.log('[2] waiting for on-device inference (first run downloads the q4 model)...');
const result = await modelPage.waitForFunction(
  () => window.__result !== undefined,
  undefined,
  { timeout: 600000, polling: 1000 },
).then((h) => h.jsonValue());

console.log('\n=== RESULT ===');
console.log('device:', result.device);
console.log('grounding:', result.grounding);
console.log('ocr has query text:', result.hit);
await browser.close();

if (result.ok && result.hit) {
  console.log('\nVERIFY PASS: Florence-2 ran on-device and confirmed the goal text.');
  process.exit(0);
} else {
  console.log('\nVERIFY FAIL:', JSON.stringify(result, null, 2));
  process.exit(1);
}
