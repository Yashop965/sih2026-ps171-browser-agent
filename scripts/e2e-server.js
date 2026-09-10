#!/usr/bin/env node
/**
 * Simple HTTP server for E2E tests
 * Serves mock pages and extension build files
 */

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname } from 'path';

const PORT = 3000;
const ROOT = process.cwd();

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

async function handleRequest(req, res) {
  try {
    // Parse URL
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let filePath = url.pathname;

    // Default to index.html
    if (filePath === '/' || filePath === '') {
      filePath = '/public/pii-test-page.html';
    }

    // Resolve file path - look in public directory first
    let fullPath = `${ROOT}/public${filePath}`;
    if (filePath.startsWith('/public/')) {
      fullPath = `${ROOT}${filePath}`;
    }

    // Read file
    const content = await readFile(fullPath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    // Send response
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
  } catch (error) {
    // File not found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`E2E Test Server running at http://localhost:${PORT}`);
  console.log(`Serving files from: ${ROOT}`);
  console.log('');
  console.log('Available test pages:');
  console.log(`  - http://localhost:${PORT}/mock/government-portal.html`);
  console.log(`  - http://localhost:${PORT}/e2e-test-page.html`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error('Server error:', error);
});