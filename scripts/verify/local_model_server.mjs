// CORS static server for the gitignored local Florence-2 ONNX mirror
// (scripts/verify/local-model, 439 MB). Used by the extension's on-device
// VLM (issue #113): the content script's transformers.js fetches model files
// cross-origin from a page context (e.g. en.wikipedia.org), so this binds
// 127.0.0.1 only + sends ACAO:*.
//
// Two roots, keyed by path prefix:
//   - /node_modules/** -> repo node_modules (the ORT wasm runtime, only
//     fetched when the WASM fallback is active; WebGPU needs none of this)
//   - anything else    -> the model mirror, served under ANY requested path:
//     transformers.js builds <localModelPath>/<repoId>/<file>, so the real
//     URL is /onnx-community/Florence-2-base-ft/onnx/encoder_model_q4.onnx.
//     resolveFile() tail-matches the request against the mirror's real files.
//
// Every request is logged to scripts/verify/local-model-request.log so a
// drive can prove whether the extension actually pulled the model.
//
// Usage: node scripts/verify/local_model_server.mjs   (PORT env, default 8123)
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./local-model/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.PORT ?? 8123);
// Request log to a file so a parent process / CDP drive can read it back.
const logFile = process.env.LOCAL_MODEL_LOG || join(repoRoot, 'scripts', 'verify', 'local-model-request.log');

const MIME = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.model': 'application/octet-stream',
  '.txt': 'text/plain',
  '.html': 'text/html',
};

// Build a set of files that exist in the mirror (relative to root) so we can
// match a requested path against its real tail.
const mirrorFiles = new Set();
(function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rp = rel ? rel + '/' + name : name;
    if (statSync(p).isDirectory()) walk(p, rp);
    else mirrorFiles.add(rp);
  }
})(root, '');

function resolveFile(pathname) {
  // Try the literal path first.
  const literal = normalize(join(root, decodeURIComponent(pathname)));
  if (literal.startsWith(normalize(root)) && existsSync(literal) && statSync(literal).isFile()) {
    return literal;
  }
  // Otherwise walk the last segments: the mirror file is usually at the tail
  // of a longer request (e.g. /onnx-community/.../onnx/encoder_model_q4.onnx).
  const segs = decodeURIComponent(pathname).split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const tail = segs.slice(i).join('/');
    if (mirrorFiles.has(tail)) return join(root, ...segs.slice(i));
  }
  return null;
}

// Reset the request log each start so a run's model fetches are unambiguous.
try { appendFileSync(logFile, `\n=== local-model server start ${new Date().toISOString()} ===\n`); } catch {}

// Two-file resolver: /node_modules/** -> repo node_modules (ORT wasm runtime,
// WASM fallback only); everything else -> the model mirror (tail-matched).
function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith('/node_modules/')) {
    const candidate = normalize(join(repoRoot, decoded));
    if (candidate.startsWith(normalize(join(repoRoot, 'node_modules'))) && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
    return null;
  }
  return resolveFile(pathname);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const file = resolveRequest(url.pathname);
  if (!file) {
    console.log(`[local-model] 404  ${url.pathname}  (no match)`);
    try { appendFileSync(logFile, `404 ${url.pathname}\n`); } catch {}
    res.writeHead(404);
    return res.end('not found');
  }
  console.log(`[local-model] 200  ${url.pathname}  ->  ${extname(file) || 'file'} (${statSync(file).size} B)`);
  try { appendFileSync(logFile, `200 ${url.pathname} (${statSync(file).size}B)\n`); } catch {}
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`[local-model] serving ${root} on http://127.0.0.1:${port} (logging to ${logFile})`);
});
