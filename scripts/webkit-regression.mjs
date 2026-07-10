import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'scripts/webkit-regression.swift');
const workDir = await mkdtemp(join(tmpdir(), 'xbrl-webkit-'));
let staticServer = null;

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: options.stdio || 'inherit' });
    const timer = options.timeout ? setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${options.timeout}ms`));
    }, options.timeout) : null;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}

try {
  let baseUrl;
  if (process.env.WEBKIT_TEST_URL) {
    baseUrl = new URL('/', process.env.WEBKIT_TEST_URL).href;
  } else {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}/`;
    staticServer = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  }
  const root = await waitForHttp(baseUrl);
  const html = await root.text();
  const module = await waitForHttp(`${baseUrl}src/spreadsheet-core.mjs`);
  assert.equal(root.status, 200);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type') || '', /(?:text|application)\/javascript/);
  assert.match(html, /from '\.\/src\/spreadsheet-core\.mjs'/);
  const executable = join(workDir, 'webkit-regression');
  await run('xcrun', ['swiftc', '-parse-as-library', SOURCE, '-o', executable, '-framework', 'AppKit', '-framework', 'WebKit'], { timeout: 60_000 });
  process.stdout.write(`WKWebView target: ${baseUrl}\nModule MIME: ${module.headers.get('content-type')}\n`);
  await run(executable, [baseUrl], { timeout: 90_000 });
} finally {
  staticServer?.kill('SIGTERM');
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
