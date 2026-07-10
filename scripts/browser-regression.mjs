import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = join(ROOT, 'tests/fixtures/minimal-instance.xbrl');
const failures = [];
const pageErrors = [];
const networkFailures = [];
const networkRequests = [];
let staticServer;
let chrome;
let client;
let workDir;
let downloadDir;
let baseUrl;
let passedCount = 0;
let attemptedCount = 0;

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, 15_000);
      this.pending.set(id, {
        method,
        resolve: result => { clearTimeout(timeout); resolveSend(result); },
        reject: error => { clearTimeout(timeout); reject(error); }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(expression, timeout = 5_000, message = expression) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${message}`);
}

async function reload() {
  await client.send('Page.navigate', { url: baseUrl });
  await client.send('Page.bringToFront');
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor(`document.readyState === 'complete' && document.querySelectorAll('.cell').length > 0`, 8_000, 'spreadsheet bootstrap');
  await delay(80);
}

async function rect(selector) {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, 3_000, selector);
  return evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, left:r.left, right:r.right, top:r.top, bottom:r.bottom }; })()`);
}

function cellSelector(row, col) {
  return `.cell[data-r="${row}"][data-c="${col}"]`;
}

async function pointForCell(row, col) {
  const cellRect = await rect(cellSelector(row, col));
  return { x: cellRect.left + cellRect.width / 2, y: cellRect.top + cellRect.height / 2 };
}

async function mouse(type, point, extra = {}) {
  await client.send('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button: extra.button || 'left',
    buttons: extra.buttons ?? (type === 'mouseReleased' ? 0 : 1),
    clickCount: extra.clickCount || 1,
    modifiers: extra.modifiers || 0
  });
}

async function clickPoint(point) {
  await mouse('mousePressed', point);
  await mouse('mouseReleased', point);
}

async function click(selector) {
  const target = await rect(selector);
  await clickPoint({ x: target.left + target.width / 2, y: target.top + target.height / 2 });
}

async function clickCell(row, col) {
  await clickPoint(await pointForCell(row, col));
  await delay(30);
}

const KEY_CODES = { Enter: 13, Escape: 27, F2: 113, F4: 115, Tab: 9, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

async function keypress(key, modifiers = 0) {
  const code = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, modifiers, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await delay(20);
}

async function editCell(row, col, value, { commit = true } = {}) {
  await clickCell(row, col);
  await keypress('F2');
  await waitFor(`getComputedStyle(document.getElementById('cellEditor')).display !== 'none'`, 2_000, 'cell editor');
  await evaluate(`(() => { const input=document.getElementById('cellEditor'); input.value=${JSON.stringify(value)}; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null})); return input.value; })()`);
  if (commit) await keypress('Enter');
}

async function setDraft(value, caret = value.length, owner = 'editor') {
  const id = owner === 'formula' ? 'formulaInput' : 'cellEditor';
  await evaluate(`(() => { const input=document.getElementById(${JSON.stringify(id)}); input.value=${JSON.stringify(value)}; input.setSelectionRange(${caret},${caret}); input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null})); return input.value; })()`);
}

async function dragCells(fromRow, fromCol, toRow, toCol) {
  const start = await pointForCell(fromRow, fromCol);
  const end = await pointForCell(toRow, toCol);
  await mouse('mousePressed', start);
  await mouse('mouseMoved', end);
  await mouse('mouseReleased', end);
  await delay(60);
}

async function dragFillTo(row, col, { release = true } = {}) {
  const handle = await rect('#fillHandle');
  const start = { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
  const end = await pointForCell(row, col);
  await mouse('mousePressed', start);
  await mouse('mouseMoved', end);
  if (release) await mouse('mouseReleased', end);
  await delay(100);
  return { start, end };
}

async function rawCell(row, col) {
  await clickCell(row, col);
  return evaluate(`document.getElementById('formulaInput').value`);
}

async function displayedCell(row, col) {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(cellSelector(row, col))}))`, 2_000, `rendered cell ${row},${col}`);
  return evaluate(`document.querySelector(${JSON.stringify(cellSelector(row, col))}).textContent`);
}

async function changeZoom(value) {
  await evaluate(`(() => { const select=document.getElementById('zoomSelect'); select.value=${JSON.stringify(String(value))}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await delay(80);
}

async function resizeColumn(col, delta) {
  const selector = `.col-resizer[data-c="${col}"]`;
  const before = await rect(`.col-header[data-c="${col}"]`);
  const resizer = await rect(selector);
  const start = { x: resizer.left + resizer.width / 2, y: resizer.top + resizer.height / 2 };
  const end = { x: start.x + delta, y: start.y };
  await mouse('mousePressed', start);
  await mouse('mouseMoved', end);
  await mouse('mouseReleased', end);
  await delay(80);
  const after = await rect(`.col-header[data-c="${col}"]`);
  assert.ok(after.width > before.width, `column ${col} did not grow: ${before.width} -> ${after.width}`);
}

async function goTo(address) {
  await click('#nameBox');
  await evaluate(`(() => { const input=document.getElementById('nameBox'); input.value=${JSON.stringify(address)}; input.setSelectionRange(input.value.length,input.value.length); })()`);
  await keypress('Enter');
  await delay(80);
}

async function syntheticPointer(type, selector, point, pointerId = 71, buttons = type === 'pointerup' || type === 'pointercancel' ? 0 : 1) {
  return evaluate(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); if(!target)throw new Error('missing pointer target'); return target.dispatchEvent(new PointerEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,composed:true,clientX:${point.x},clientY:${point.y},pointerId:${pointerId},pointerType:'mouse',isPrimary:true,button:0,buttons:${buttons}})); })()`);
}

async function installSyntheticCapture(ownerSelector = '#gridCanvas') {
  await evaluate(`(() => { const owner=document.querySelector(${JSON.stringify(ownerSelector)}); window.__syntheticCaptureOriginal={owner,set:owner.setPointerCapture,has:owner.hasPointerCapture,release:owner.releasePointerCapture}; const ids=new Set(); owner.setPointerCapture=id=>ids.add(id); owner.hasPointerCapture=id=>ids.has(id); owner.releasePointerCapture=id=>ids.delete(id); })()`);
}

async function restoreSyntheticCapture() {
  await evaluate(`(() => { const saved=window.__syntheticCaptureOriginal;if(!saved)return;saved.owner.setPointerCapture=saved.set;saved.owner.hasPointerCapture=saved.has;saved.owner.releasePointerCapture=saved.release;delete window.__syntheticCaptureOriginal; })()`);
}

async function inputFiles(selector, files) {
  const { root } = await client.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, `file input exists: ${selector}`);
  await client.send('DOM.setFileInputFiles', { nodeId, files });
}

async function newDownload(trigger, timeout = 6_000) {
  const before = new Map();
  for (const name of await readdir(downloadDir)) {
    const info = await stat(join(downloadDir, name));
    before.set(name, { size: info.size, mtimeMs: info.mtimeMs });
  }
  await trigger();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const name of await readdir(downloadDir)) {
      if (name.endsWith('.crdownload')) continue;
      const path = join(downloadDir, name);
      const info = await stat(path);
      const previous = before.get(name);
      if (info.size > 0 && (!previous || info.size !== previous.size || info.mtimeMs > previous.mtimeMs)) return path;
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for browser download');
}

async function workbookSnapshot() {
  const path = await newDownload(() => evaluate(`document.getElementById('saveJsonBtn').click()`));
  const workbook = JSON.parse(await readFile(path, 'utf8'));
  await rm(path, { force: true });
  return workbook;
}

function firstSheet(workbook) {
  assert.ok(workbook.sheets?.length, 'workbook contains a sheet');
  return workbook.sheets[0];
}

async function run(name, test) {
  if (process.env.BROWSER_TEST_FILTER && !name.includes(process.env.BROWSER_TEST_FILTER)) return;
  attemptedCount += 1;
  try {
    await reload();
    await test();
    passedCount += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`FAIL ${name}\n${error.stack || error}\n`);
  }
}

async function start() {
  workDir = await mkdtemp(join(tmpdir(), 'xbrl-browser-'));
  downloadDir = join(workDir, 'downloads');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(downloadDir));
  const debugPort = await freePort();
  if (process.env.BROWSER_TEST_URL) {
    baseUrl = new URL('/', process.env.BROWSER_TEST_URL).href;
  } else {
    const serverPort = await freePort();
    baseUrl = `http://127.0.0.1:${serverPort}/`;
    staticServer = spawn('python3', ['-m', 'http.server', String(serverPort), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  await waitForHttp(baseUrl);
  const rootResponse = await fetch(baseUrl);
  const moduleResponse = await fetch(`${baseUrl}src/spreadsheet-core.mjs`);
  assert.equal(rootResponse.status, 200);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type') || '', /(?:text|application)\/javascript/);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(workDir, 'profile')}`, '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find(entry => entry.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chrome exposes a debuggable page');
  client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([
    client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable'), client.send('Network.enable')
  ]);
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  client.on('Runtime.exceptionThrown', event => pageErrors.push(`exception: ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text}`));
  client.on('Runtime.consoleAPICalled', event => {
    if (event.type === 'error' || event.type === 'assert') pageErrors.push(`console.${event.type}: ${event.args?.map(arg => arg.value || arg.description).join(' ')}`);
  });
  client.on('Log.entryAdded', ({ entry }) => {
    if (entry?.level === 'error' && !String(entry.url || '').endsWith('/favicon.ico')) pageErrors.push(`log: ${entry.text}`);
  });
  client.on('Network.loadingFailed', event => {
    if (!event.canceled) networkFailures.push(`${event.errorText} ${event.type || ''}`.trim());
  });
  client.on('Network.requestWillBeSent', ({ request }) => networkRequests.push({ method: request.method, url: request.url, hasPostData: Boolean(request.hasPostData) }));
}

async function stop() {
  client?.close();
  for (const process of [chrome, staticServer]) {
    if (!process || process.exitCode !== null) continue;
    process.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => process.once('exit', resolveExit)),
      delay(2_000).then(() => { if (process.exitCode === null) process.kill('SIGKILL'); })
    ]);
  }
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

try {
  await start();

  await run('B1 formula cell picking preserves origin and creates one commit action', async () => {
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('=');
    await clickCell(2, 2);
    assert.equal(await evaluate(`document.getElementById('cellEditor').value`), '=C3');
    assert.equal(await evaluate(`document.getElementById('nameBox').value`), 'B2');
    await keypress('Enter');
    assert.equal(await rawCell(1, 1), '=C3');
    await evaluate(`document.getElementById('undoBtn').click()`);
    assert.equal(await rawCell(1, 1), '');
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
  });

  await run('B2 range picking inserts at the caret without blur commit', async () => {
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('=SUM()', 5);
    await dragCells(2, 2, 4, 3);
    assert.equal(await evaluate(`document.getElementById('cellEditor').value`), '=SUM(C3:D5)');
    assert.equal(await evaluate(`document.getElementById('nameBox').value`), 'B2');
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('referenceBox')).display`), 'block');
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
  });

  await run('B3 formula bar picking synchronizes both draft controls', async () => {
    await clickCell(1, 1);
    await click('#formulaInput');
    await setDraft('=', 1, 'formula');
    await clickCell(2, 2);
    assert.equal(await evaluate(`document.getElementById('formulaInput').value`), '=C3');
    assert.equal(await evaluate(`document.getElementById('cellEditor').value`), '=C3');
    assert.equal(await evaluate(`document.getElementById('nameBox').value`), 'B2');
    await keypress('Enter');
    assert.equal(await rawCell(1, 1), '=C3');
  });

  await run('B4 F4 cycles exact cell and range references and ignores a no-token caret', async () => {
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('=');
    await clickCell(2, 2);
    const editor = '#cellEditor';
    for (const expected of ['=$C$3', '=C$3', '=$C3', '=C3']) {
      await keypress('F4');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).value`), expected);
    }
    await setDraft('=SUM()', 5);
    await dragCells(2, 2, 4, 3);
    for (const expected of ['=SUM($C$3:$D$5)', '=SUM(C$3:D$5)', '=SUM($C3:$D5)', '=SUM(C3:D5)']) {
      await keypress('F4');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(editor)}).value`), expected);
    }
    await setDraft('=C3 + 1', 4);
    await keypress('F4');
    assert.equal(await evaluate(`document.getElementById('cellEditor').value`), '=C3 + 1');
  });

  await run('B5 Escape restores the original value and leaves reference history empty', async () => {
    await editCell(1, 1, 'old');
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('=');
    await clickCell(2, 2);
    await keypress('Escape');
    await keypress('Escape');
    assert.equal(await rawCell(1, 1), 'old');
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('referenceBox')).display`), 'none');
    await evaluate(`document.getElementById('undoBtn').click()`);
    assert.equal(await rawCell(1, 1), '');
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
  });

  await run('B6 mixed absolute formula fill translates axes and recalculates results', async () => {
    for (const [row, col, value] of [[0,0,'1'],[0,1,'10'],[0,2,'100'],[0,3,'1000'],[1,0,'2'],[1,1,'20'],[2,0,'3'],[2,1,'30']]) {
      await editCell(row, col, value);
    }
    await editCell(0, 4, '=A1+$B1+C$1+$D$1');
    await clickCell(0, 4);
    await dragFillTo(2, 4);
    const sheet = firstSheet(await workbookSnapshot());
    assert.equal(sheet.cells['1,4'].v, '=A2+$B2+C$1+$D$1');
    assert.equal(sheet.cells['2,4'].v, '=A3+$B3+C$1+$D$1');
    assert.equal(await displayedCell(1, 4), '1,122');
    assert.equal(await displayedCell(2, 4), '1,133');
  });

  await run('B6x cross-sheet qualified references fill correctly beyond column Z', async () => {
    await click('#newSheetBtn');
    await goTo('AA1');
    await editCell(0, 26, "='계산 시트'!AA1");
    await clickCell(0, 26);
    const wideHandle = await rect('#fillHandle');
    const wideTarget = await pointForCell(0, 28);
    await installSyntheticCapture();
    await syntheticPointer('pointerdown', '#fillHandle', { x: wideHandle.left + 2, y: wideHandle.top + 2 }, 66);
    await syntheticPointer('pointermove', cellSelector(0, 28), wideTarget, 66);
    await syntheticPointer('pointerup', cellSelector(0, 28), wideTarget, 66, 0);
    await restoreSyntheticCapture();
    await delay(80);
    const workbook = await workbookSnapshot();
    const sheet = workbook.sheets.find(candidate => candidate.name === '시트');
    assert.ok(sheet);
    assert.equal(sheet.cells['0,26'].v, "='계산 시트'!AA1");
    assert.ok(sheet.cells['0,27'], `wide fill missing AB1; keys=${Object.keys(sheet.cells).join(',')}; status=${await evaluate(`document.getElementById('appStatus').textContent`)}`);
    assert.ok(sheet.cells['0,28'], `wide fill missing AC1; keys=${Object.keys(sheet.cells).join(',')}`);
    assert.equal(sheet.cells['0,27'].v, "='계산 시트'!AB1");
    assert.equal(sheet.cells['0,28'].v, "='계산 시트'!AC1");
  });

  await run('B7 numeric date invalid-date and text-number lanes fill forward and reverse', async () => {
    await editCell(2, 0, '1');
    await editCell(3, 0, '2');
    await dragCells(2, 0, 3, 0);
    await dragFillTo(0, 0);
    await editCell(0, 5, '2024-02-28');
    await editCell(1, 5, '2024-02-29');
    await dragCells(0, 5, 1, 5);
    await dragFillTo(3, 5);
    await editCell(0, 6, '2026-02-30');
    await editCell(1, 6, '2026-03-01');
    await dragCells(0, 6, 1, 6);
    await dragFillTo(3, 6);
    await editCell(0, 7, 'Q01');
    await editCell(1, 7, 'Q02');
    await dragCells(0, 7, 1, 7);
    await dragFillTo(3, 7);
    const sheet = firstSheet(await workbookSnapshot());
    assert.deepEqual([sheet.cells['0,0'].v, sheet.cells['1,0'].v], ['-1', '0']);
    assert.deepEqual([sheet.cells['2,5'].v, sheet.cells['3,5'].v], ['2024-03-01', '2024-03-02']);
    assert.deepEqual([sheet.cells['2,6'].v, sheet.cells['3,6'].v], ['2026-02-30', '2026-03-01']);
    assert.deepEqual([sheet.cells['2,7'].v, sheet.cells['3,7'].v], ['Q03', 'Q04']);
  });

  await run('B8 horizontal mixed formula blank scalar and style fill maps cyclic sources', async () => {
    await editCell(4, 2, '=A1');
    await clickCell(4, 2);
    await click('#boldBtn');
    await clickCell(4, 3);
    await click('#boldBtn');
    await editCell(4, 4, 'x');
    await dragCells(4, 2, 4, 4);
    await dragFillTo(4, 7);
    const sheet = firstSheet(await workbookSnapshot());
    assert.equal(sheet.cells['4,5'].v, '=D1');
    assert.deepEqual(sheet.cells['4,5'].style, { bold: true });
    assert.equal(sheet.cells['4,6'].v, '');
    assert.deepEqual(sheet.cells['4,6'].style, { bold: true });
    assert.equal(sheet.cells['4,7'].v, 'x');
    assert.equal(await evaluate(`document.getElementById('selectionStats').textContent.startsWith('선택 1×6')`), true);
  });

  await run('B9 sparse fill Undo and Redo restore absent explicit styled and populated destinations', async () => {
    for (let col = 2; col <= 5; col += 1) await editCell(0, col, String(col - 1));
    await clickCell(0, 2);
    await click('#boldBtn');
    await clickCell(0, 7);
    await click('#boldBtn');
    await click('#clearFormatBtn');
    await clickCell(0, 8);
    await click('#boldBtn');
    await editCell(0, 9, 'old');
    await dragCells(0, 2, 0, 5);
    await dragFillTo(0, 9);
    let sheet = firstSheet(await workbookSnapshot());
    assert.deepEqual([sheet.cells['0,6'].v, sheet.cells['0,7'].v, sheet.cells['0,8'].v, sheet.cells['0,9'].v], ['5','6','7','8']);
    assert.deepEqual(sheet.cells['0,6'].style, { bold: true });
    await evaluate(`document.getElementById('undoBtn').click()`);
    sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.hasOwn(sheet.cells, '0,6'), false);
    assert.deepEqual(sheet.cells['0,7'], { v: '', style: {} });
    assert.deepEqual(sheet.cells['0,8'], { v: '', style: { bold: true } });
    assert.deepEqual(sheet.cells['0,9'], { v: 'old', style: {} });
    await evaluate(`document.getElementById('redoBtn').click()`);
    sheet = firstSheet(await workbookSnapshot());
    assert.deepEqual([sheet.cells['0,6'].v, sheet.cells['0,7'].v, sheet.cells['0,8'].v, sheet.cells['0,9'].v], ['5','6','7','8']);
  });

  await run('B10 zoom 80 and 125 percent with resized columns preserves fill geometry', async () => {
    const exercise = async zoom => {
      await changeZoom(zoom);
      await resizeColumn(2, 64);
      await editCell(0, 2, '1');
      await editCell(1, 2, '2');
      await dragCells(0, 2, 1, 2);
      await dragFillTo(3, 2);
      assert.equal(await rawCell(2, 2), '3');
      assert.equal(await rawCell(3, 2), '4');
    };
    await exercise(0.8);
    await reload();
    await exercise(1.25);
  });

  await run('B11 stationary edge pointer advances preview on repeated native animation frames', async () => {
    await editCell(0, 0, '1');
    await clickCell(0, 0);
    const handle = await rect('#fillHandle');
    const viewport = await rect('#gridViewport');
    const start = { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
    const stationary = { x: viewport.left + viewport.width / 2, y: viewport.bottom - 2 };
    await mouse('mousePressed', start);
    await mouse('mouseMoved', stationary);
    const samples = [];
    for (let index = 0; index < 4; index += 1) {
      await delay(90);
      samples.push(await evaluate(`({scrollTop:document.getElementById('gridViewport').scrollTop,previewHeight:parseFloat(document.getElementById('fillPreview').style.height)||0})`));
    }
    assert.ok(samples[1].scrollTop > samples[0].scrollTop, JSON.stringify(samples));
    assert.ok(samples[2].scrollTop > samples[1].scrollTop, JSON.stringify(samples));
    assert.ok(samples.at(-1).previewHeight > samples[0].previewHeight, JSON.stringify(samples));
    await keypress('Escape');
    await mouse('mouseReleased', stationary);
    assert.equal(await evaluate(`document.getElementById('fillPreview').style.display`), 'none');
  });

  await run('B12 pointer cancellation lost capture window blur and capture failure are idempotent', async () => {
    await editCell(0, 2, '1');
    await editCell(1, 2, '2');
    await dragCells(0, 2, 1, 2);
    await evaluate(`(() => { const canvas=document.getElementById('gridCanvas'); window.__captureCalls=[]; window.__originalCapture=canvas.setPointerCapture; canvas.setPointerCapture=id=>{window.__captureCalls.push(id);throw new Error('injected capture failure')}; })()`);
    const handle = await rect('#fillHandle');
    const target = await pointForCell(3, 2);
    await syntheticPointer('pointerdown', '#fillHandle', { x: handle.left + 2, y: handle.top + 2 }, 77);
    assert.deepEqual(await evaluate(`window.__captureCalls`), [77]);
    assert.match(await evaluate(`document.getElementById('appStatus').textContent`), /포인터 캡처에 실패/);
    await evaluate(`document.getElementById('gridCanvas').setPointerCapture=window.__originalCapture`);
    let sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.hasOwn(sheet.cells, '2,2'), false);
    assert.equal(Object.hasOwn(sheet.cells, '3,2'), false);
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('=');
    const c3 = await pointForCell(2, 2);
    await installSyntheticCapture();
    await syntheticPointer('pointerdown', cellSelector(2, 2), c3, 78);
    await syntheticPointer('lostpointercapture', '#gridCanvas', c3, 78, 0);
    await restoreSyntheticCapture();
    assert.equal(await evaluate(`document.getElementById('cellEditor').value`), '=');
    await keypress('Escape');
    await dragCells(0, 2, 1, 2);
    const handleAgain = await rect('#fillHandle');
    await installSyntheticCapture();
    await syntheticPointer('pointerdown', '#fillHandle', { x: handleAgain.left + 2, y: handleAgain.top + 2 }, 79);
    await syntheticPointer('pointermove', '#gridCanvas', target, 79);
    await evaluate(`window.dispatchEvent(new Event('blur'))`);
    await syntheticPointer('pointerup', '#gridCanvas', target, 79, 0);
    await restoreSyntheticCapture();
    sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.hasOwn(sheet.cells, '2,2'), false);
    assert.equal(await evaluate(`document.getElementById('fillPreview').style.display`), 'none');
  });

  await run('B13 destination and 32MiB action limits reject before mutation or history changes', async () => {
    await evaluate(`{for(let i=0;i<18;i++)document.getElementById('addRowsBtn').click();}`);
    await click('.row-header[data-r="0"]');
    const handle = await rect('#fillHandle');
    const viewport = await rect('#gridViewport');
    await installSyntheticCapture();
    await syntheticPointer('pointerdown', '#fillHandle', { x: handle.left + 2, y: handle.top + 2 }, 81);
    const far = { x: viewport.left + 10, y: viewport.top + 1800 * 28 + 4 };
    await syntheticPointer('pointermove', '#gridCanvas', far, 81);
    await syntheticPointer('pointerup', '#gridCanvas', far, 81, 0);
    await restoreSyntheticCapture();
    assert.match(await evaluate(`document.getElementById('toast').textContent`), /50,000/);
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
    let sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.keys(sheet.cells).length, 3);

    await reload();
    await evaluate(`{for(let i=0;i<498;i++)document.getElementById('addRowsBtn').click();}`);
    const large = 'x'.repeat(720);
    await editCell(0, 2, large);
    await clickCell(0, 2);
    const longHandle = await rect('#fillHandle');
    const longViewport = await rect('#gridViewport');
    await installSyntheticCapture();
    await syntheticPointer('pointerdown', '#fillHandle', { x: longHandle.left + 2, y: longHandle.top + 2 }, 82);
    const huge = { x: longViewport.left + 2 * 112 + 10, y: longViewport.top + 50000 * 28 + 4 };
    await syntheticPointer('pointermove', '#gridCanvas', huge, 82);
    await syntheticPointer('pointerup', '#gridCanvas', huge, 82, 0);
    await restoreSyntheticCapture();
    assert.match(await evaluate(`document.getElementById('toast').textContent`), /32MiB/);
    sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.hasOwn(sheet.cells, '50000,2'), false);
    await evaluate(`document.getElementById('undoBtn').click()`);
    assert.equal(await rawCell(0, 2), '');
    assert.equal(await evaluate(`document.getElementById('redoBtn').disabled`), false);
  });

  await run('B14 standard selection edit navigation delete resize copy and paste paths remain operational', async () => {
    await editCell(0, 2, 'one');
    await clickCell(0, 2);
    assert.equal(await evaluate(`(() => { const data=new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data})); return data.getData('text/plain'); })()`), 'one');
    await clickCell(0, 2);
    await evaluate(`(() => { const data=new DataTransfer(); data.setData('text/plain','a\\tb\\nc\\td'); document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data})); })()`);
    assert.equal(await rawCell(0, 2), 'a');
    assert.equal(await rawCell(1, 3), 'd');
    const start = await pointForCell(0, 2);
    const end = await pointForCell(1, 3);
    await mouse('mousePressed', start);
    await mouse('mouseMoved', end, { modifiers: 8 });
    await mouse('mouseReleased', end, { modifiers: 8 });
    assert.match(await evaluate(`document.getElementById('selectionStats').textContent`), /선택 2×2/);
    await resizeColumn(2, 48);
    await clickCell(0, 2);
    await keypress('ArrowRight');
    assert.equal(await evaluate(`document.getElementById('nameBox').value`), 'D1');
    await clickCell(0, 2);
    await keypress('F2');
    await setDraft('tabbed');
    await keypress('Tab');
    assert.equal(await evaluate(`document.getElementById('nameBox').value`), 'D1');
    await clickCell(0, 2);
    await keypress('Delete');
    assert.equal(await rawCell(0, 2), '');
  });

  let importedWorkbookPath;
  await run('B15 minimal XBRL import creates expected sheets and performs no upload', async () => {
    const requestIndex = networkRequests.length;
    await inputFiles('#xbrlInput', [FIXTURE]);
    await waitFor(`document.getElementById('appStatus').textContent.includes('2개 Fact')`, 6_000, 'XBRL import');
    const workbook = await workbookSnapshot();
    assert.deepEqual(workbook.sheets.map(sheet => sheet.name), ['재무표', 'Facts', 'Contexts', '계산 시트']);
    const facts = workbook.sheets.find(sheet => sheet.name === 'Facts');
    assert.equal(facts.cells['1,0'].v, 'dart:Assets');
    assert.equal(facts.cells['1,2'].v, '12345000');
    assert.equal(facts.cells['2,0'].v, 'dart:EntityRegistrantName');
    const importRequests = networkRequests.slice(requestIndex);
    assert.equal(importRequests.some(request => request.hasPostData || !['GET', 'OPTIONS'].includes(request.method)), false);
    importedWorkbookPath = await newDownload(() => evaluate(`document.getElementById('saveJsonBtn').click()`));
  });

  await run('B16 JSON roundtrip and CSV Excel exports preserve imported facts and formulas', async () => {
    assert.ok(importedWorkbookPath, 'B15 produced a JSON file');
    await inputFiles('#jsonInput', [importedWorkbookPath]);
    await waitFor(`document.getElementById('appStatus').textContent.includes('불러왔습니다')`, 4_000, 'JSON load');
    const csvPath = await newDownload(() => evaluate(`document.getElementById('exportCsvBtn').click()`));
    const csv = await readFile(csvPath, 'utf8');
    assert.match(csv, /dart:Assets/);
    assert.match(csv, /12345000/);
    const xmlPath = await newDownload(() => evaluate(`document.getElementById('exportExcelBtn').click()`));
    const xml = await readFile(xmlPath, 'utf8');
    assert.match(xml, /<Worksheet ss:Name="재무표">/);
    assert.match(xml, /<Worksheet ss:Name="Facts">/);
    assert.match(xml, /ss:Formula=/);
    assert.match(xml, /12345000/);
    await evaluate(`(() => { const input=document.getElementById('workbookTitle'); input.value='Roundtrip verification'; input.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`);
    const workbook = await workbookSnapshot();
    assert.equal(workbook.sheets.find(sheet => sheet.name === 'Facts').cells['1,2'].v, '12345000');
  });

  await run('B17 canonical errors and lazy IF evaluate correctly including out-of-bounds fill', async () => {
    const formulas = ['=#REF!','=#REF!+1','=SUM(#REF!,1)','=IF(FALSE,#REF!,1)','=IF(TRUE,1,#REF!)','=IF(#REF!,1,2)'];
    for (let index = 0; index < formulas.length; index += 1) await editCell(0, index + 2, formulas[index]);
    const expected = ['#REF!','#REF!','#REF!','1','1','#REF!'];
    for (let index = 0; index < expected.length; index += 1) assert.equal(await displayedCell(0, index + 2), expected[index]);
    await editCell(2, 2, '=A1');
    await clickCell(2, 2);
    await dragFillTo(0, 2);
    assert.equal(await rawCell(0, 2), '=#REF!');
    assert.equal(await displayedCell(0, 2), '#REF!');
  });

  await run('B18 redo truncation and 100-action retention remain deterministic', async () => {
    await editCell(0, 2, '1');
    await editCell(0, 2, '2');
    await evaluate(`document.getElementById('undoBtn').click()`);
    assert.equal(await rawCell(0, 2), '1');
    await editCell(0, 3, 'new branch');
    assert.equal(await evaluate(`document.getElementById('redoBtn').disabled`), true);
    await reload();
    for (let value = 1; value <= 101; value += 1) await editCell(0, 2, String(value));
    await evaluate(`{for(let i=0;i<100;i++)document.getElementById('undoBtn').click();}`);
    assert.equal(await rawCell(0, 2), '1');
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
  });

  await run('B19 focus transfer real blur sheet switch and workbook replacement obey terminal policy', async () => {
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('transfer');
    await click('#formulaInput');
    assert.equal(await evaluate(`document.getElementById('formulaInput').value`), 'transfer');
    await setDraft('transfer2', 9, 'formula');
    await click('#helpBtn');
    await click('#helpClose');
    assert.equal(await rawCell(1, 1), 'transfer2');
    await evaluate(`document.getElementById('undoBtn').click()`);
    assert.equal(await rawCell(1, 1), '');

    await reload();
    await click('#newSheetBtn');
    await click('.sheet-tab:nth-child(1)');
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('sheetCommit');
    await click('.sheet-tab:nth-child(2)');
    await click('.sheet-tab:nth-child(1)');
    assert.equal(await rawCell(1, 1), 'sheetCommit');
    const saved = await newDownload(() => evaluate(`document.getElementById('saveJsonBtn').click()`));
    await clickCell(1, 1);
    await keypress('F2');
    await setDraft('stale-write');
    await inputFiles('#jsonInput', [saved]);
    await waitFor(`document.getElementById('appStatus').textContent.includes('불러왔습니다')`, 4_000, 'replacement load');
    assert.equal(await rawCell(1, 1), 'sheetCommit');
    await rm(saved, { force: true });
  });

  await run('B20 empty fill is an all-no-op with no sparse key selection or history side effect', async () => {
    await clickCell(0, 2);
    const beforeSelection = await evaluate(`document.getElementById('selectionStats').textContent`);
    await dragFillTo(2, 2);
    const sheet = firstSheet(await workbookSnapshot());
    assert.equal(Object.hasOwn(sheet.cells, '0,2'), false);
    assert.equal(Object.hasOwn(sheet.cells, '1,2'), false);
    assert.equal(Object.hasOwn(sheet.cells, '2,2'), false);
    assert.equal(await evaluate(`document.getElementById('selectionStats').textContent`), beforeSelection);
    assert.equal(await evaluate(`document.getElementById('undoBtn').disabled`), true);
    assert.equal(await evaluate(`document.getElementById('redoBtn').disabled`), true);
  });

  if (pageErrors.length) failures.push({ name: 'runtime console remains error-free', error: new Error(pageErrors.join('\n')) });
  else process.stdout.write('PASS runtime console remains error-free\n');
  if (networkFailures.length) failures.push({ name: 'browser network has no failed requests', error: new Error(networkFailures.join('\n')) });
  else process.stdout.write('PASS browser network has no failed requests\n');
} finally {
  await stop();
}

if (failures.length) {
  process.stderr.write(`\nChrome matrix: ${passedCount}/${attemptedCount} passed, ${failures.length} failed, 0 blocked.\n`);
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.error.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nChrome matrix: ${passedCount}/${attemptedCount} passed, 0 failed, 0 blocked.\n`);
}
