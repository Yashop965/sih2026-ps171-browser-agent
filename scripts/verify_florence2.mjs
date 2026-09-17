// One-off verification for issue #100: can Florence-2-base-ft do the two
// tasks the task loop needs, on-device?
//   1. OCR of a rendered page screenshot (<OCR>)
//   2. Grounding "is the heading 'progressive web app' visible" (<OD> "progressive web app")
// Run: node scripts/verify_florence2.mjs   (first run downloads the ONNX q4 ~100MB)
import { chromium } from 'playwright';
import { pipeline } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';

const MODEL_ID = 'onnx-community/Florence-2-base-ft';
const PAGE_URL = 'https://en.wikipedia.org/wiki/Progressive_web_app';
const SHOT = process.cwd() + '/scripts/.florence-verify.png';

// ── 1. capture a real screenshot of the PWA article ──
console.log('capturing', PAGE_URL, '...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: SHOT, clip: { x: 0, y: 0, width: 1280, height: 800 } });
console.log('screenshot:', SHOT);
await browser.close();

// ── 2. load Florence-2 q4 (WASM; Node has no WebGPU) ──
console.log('loading', MODEL_ID, 'q4 ...');
const t0 = Date.now();
const Florence = await pipeline('image-to-text', MODEL_ID, { dtype: 'q4' });
console.log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const image = readFileSync(SHOT);

// ── 3. grounding: does the page show the "Progressive web app" heading? ──
console.log('\n[grounding] <OD> "progressive web app"');
let g0 = Date.now();
const grounding = await Florence({ image, task: '<OD>', query: '"progressive web app"' });
const gt = ((Date.now() - g0) / 1000).toFixed(1);
console.log('raw:', JSON.stringify(grounding));
console.log('grounding ms:', gt);

// ── 4. OCR proof the content actually rendered ──
console.log('\n[ocr] <OCR>');
g0 = Date.now();
const ocr = await Florence({ image, task: '<OCR>' });
const ort = ((Date.now() - g0) / 1000).toFixed(1);
const ocrText = Array.isArray(ocr) ? ocr.map((o) => o.generated_text).join(' | ') : JSON.stringify(ocr);
console.log('text:', ocrText);
console.log('ocr ms:', ort);

// ── verdict ──
const hasHeading = ocrText.toLowerCase().includes('progressive web app');
console.log('\nVERDICT: heading present in OCR =>', hasHeading, '| grounding boxes =>', grounding?.length ?? 0);
