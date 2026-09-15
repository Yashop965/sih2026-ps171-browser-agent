// Capture real UI screenshots + PII field coordinates for the ad video pipeline
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const PII_PATTERNS = /aadhaar|pan|phone|email|name|password|account|ifsc|card/i;
const pages = [
  { file: 'pii-test-page.html', name: 'pii_heatmap', h: 900 },
  { file: 'mock-form.html', name: 'form_demo', h: 900 },
  { file: 'mock/government-portal.html', name: 'gov_portal', h: 1000 },
];

const urlFor = (rel) => 'file:///' + path.join(__dirname, '..', 'public', rel).split(path.sep).join('/');

(async () => {
  const browser = await chromium.launch();
  const fieldMap = {};
  for (const p of pages) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: p.h },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await ctx.newPage();
    await page.goto(urlFor(p.file));
    await page.waitForTimeout(800);
    // fill PII-looking fields with sample values so the demo looks alive
    const inputs = page.locator('input:visible');
    const n = await inputs.count();
    const fields = [];
    for (let i = 0; i < n; i++) {
      const inp = inputs.nth(i);
      const box = await inp.boundingBox();
      if (!box) continue;
      const type = (await inp.getAttribute('type')) || 'text';
      let label = (await inp.getAttribute('placeholder')) || '';
      const id = (await inp.getAttribute('id')) || '';
      if (!label) {
        const labelText = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return '';
          const lab = el.closest('div,section,label')?.previousElementSibling;
          return lab ? lab.textContent.trim().slice(0, 40) : '';
        }, '#' + id).catch(() => '');
        label = labelText || id || type;
      }
      const isPii = PII_PATTERNS.test(label + ' ' + type);
      const sample =
        /aadhaar/i.test(label) ? '4821 5678 9012'
        : /pan/i.test(label) ? 'ABCPK1234F'
        : /phone/i.test(label) ? '+91 98765 43210'
        : /email/i.test(label) ? 'arjun.sharma@mail.com'
        : /first\s*name/i.test(label) ? 'Arjun'
        : /last\s*name/i.test(label) ? 'Sharma'
        : /name/i.test(label) ? 'Arjun Sharma'
        : /ifsc/i.test(label) ? 'SBI0001234'
        : /account/i.test(label) ? '50100211345'
        : /card/i.test(label) ? '4521 8836 0012'
        : /password/i.test(label) ? '••••••••'
        : '';
      fields.push({ label: label.replace(/\n/g, ' ').slice(0, 40), type, isPii, value: sample, box: { x: box.x, y: box.y, w: box.width, h: box.height } });
      if (sample && type !== 'password') await inp.fill(sample).catch(() => {});
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, p.name + '.png'), fullPage: false });
    // also capture a blank version (for the autofill scene)
    await page.evaluate(() => { document.querySelectorAll('input').forEach((el) => el.value = ''); });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, p.name + '_blank.png'), fullPage: false });
    fieldMap[p.name] = fields;
    console.log(JSON.stringify({ page: p.name, fields: fields.length, pii: fields.filter((f) => f.isPii).length }));
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'fields.json'), JSON.stringify(fieldMap, null, 2));
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
