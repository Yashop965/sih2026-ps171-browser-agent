// Fast on-device proof without Playwright: Node + local q4 model (WASM).
// Run: node scripts/verify/florence_node_proof.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const { Florence2ForConditionalGeneration, AutoProcessor, env } =
  await import('@huggingface/transformers');
env.allowLocalModels = true;
const MODEL_DIR = join(root, 'local-model');
console.log('loading local model (q4, wasm)...');
const t0 = Date.now();
const model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_DIR, { dtype: 'q4', device: 'cpu' });
const processor = await AutoProcessor.from_pretrained(MODEL_DIR);
console.log(`model+processor ready in ${((Date.now()-t0)/1000).toFixed(1)}s`);
const { load_image } = await import('@huggingface/transformers');
const img = await load_image(join(root, '..', '..', 'shots', 'pwa.png'));
// (run_florence_verify.mjs writes shots/pwa.png; this proof reuses it)
// grounding: does the "progressive web app" heading exist in-frame?
let t1 = Date.now();
let grounding;
try {
  const prompts = processor.construct_prompts('<OD> "progressive web app"');
  const inputs = await processor(img, prompts);
  const ids = await model.generate({ ...inputs, max_new_tokens: 128 });
  const text = processor.batch_decode(ids, { skip_special_tokens: false })[0];
  grounding = processor.post_process_generation(text, '<OD>', img.size);
  console.log(`grounding ${Date.now()-t1}ms -> ${JSON.stringify(grounding)}`);
} catch (e) { console.log('grounding err:', e.message); }
// OCR
t1 = Date.now();
let ocrText = '';
try {
  const prompts = processor.construct_prompts('<OCR>');
  const inputs = await processor(img, prompts);
  const ids = await model.generate({ ...inputs, max_new_tokens: 200 });
  const text = processor.batch_decode(ids, { skip_special_tokens: false })[0];
  ocrText = (typeof text === 'string' ? text : JSON.stringify(processor.post_process_generation(text, '<OCR>', img.size))) || text;
  console.log(`ocr ${Date.now()-t1}ms -> ${String(ocrText).slice(0, 400)}`);
} catch (e) { console.log('ocr err:', e.message); }
const hit = String(ocrText).toLowerCase().includes('progressive web app');
console.log(hit ? 'VERIFY PASS: on-device Florence-2 read "Progressive web app" off the live screenshot' : 'VERIFY INCONCLUSIVE: OCR text did not contain the target');
process.exit(hit ? 0 : 2);
