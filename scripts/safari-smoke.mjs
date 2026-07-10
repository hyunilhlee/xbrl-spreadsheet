import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFARIDRIVER = '/System/Cryptexes/App/usr/bin/safaridriver';
const XBRL_FIXTURE = join(ROOT, 'tests/fixtures/minimal-instance.xbrl');
const JSON_FIXTURE = join(ROOT, 'tests/fixtures/minimal-workbook.json');
const allowBlocked = process.argv.includes('--allow-blocked');
const SAFARI_MATRIX_TOTAL = 16;

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

const driverPort = await freePort();
const serverPort = process.env.SAFARI_TEST_URL ? null : await freePort();
const baseUrl = process.env.SAFARI_TEST_URL ? new URL('/', process.env.SAFARI_TEST_URL).href : `http://127.0.0.1:${serverPort}/`;
const staticServer = serverPort ? spawn('python3', ['-m', 'http.server', String(serverPort), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' }) : null;
const driver = spawn(SAFARIDRIVER, ['-p', String(driverPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
let sessionId = null;

async function webdriver(path, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({ value: null }));
  if (!response.ok || payload.value?.error) {
    throw new Error(`${method} ${path}: ${payload.value?.message || payload.value?.error || response.status}`);
  }
  return payload.value;
}

async function navigateSafari() {
  await webdriver(`/session/${sessionId}/url`, { method: 'POST', body: { url: baseUrl } });
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const ready = await executeSync(`return document.readyState==='complete' && document.querySelectorAll('.cell').length>0;`).catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw new Error('Safari app bootstrap timed out');
}

async function executeSync(script, args = []) {
  return webdriver(`/session/${sessionId}/execute/sync`, { method: 'POST', body: { script, args } });
}

async function executeAsync(script, args = []) {
  return webdriver(`/session/${sessionId}/execute/async`, { method: 'POST', body: { script, args } });
}

async function uploadFile(selector, path) {
  const element = await webdriver(`/session/${sessionId}/element`, { method: 'POST', body: { using: 'css selector', value: selector } });
  const id = element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT;
  assert.ok(id, `Safari found ${selector}`);
  await webdriver(`/session/${sessionId}/element/${encodeURIComponent(id)}/value`, { method: 'POST', body: { text: path, value: [path] } });
}

async function waitSafari(expression, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await executeSync(`return Boolean(${expression});`).catch(() => false)) return;
    await delay(100);
  }
  throw new Error(`Safari wait timed out: ${expression}`);
}

const safariHarness = String.raw`
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
window.__safariRegressionErrors=[];
window.addEventListener('error',event=>window.__safariRegressionErrors.push(String(event.error?.stack||event.message||'window error')),{once:false});
window.addEventListener('unhandledrejection',event=>window.__safariRegressionErrors.push(String(event.reason?.stack||event.reason||'unhandled rejection')),{once:false});
const originalConsoleError=console.error.bind(console);
console.error=(...args)=>{window.__safariRegressionErrors.push('console.error: '+args.map(String).join(' '));originalConsoleError(...args)};
const cell=(row,col)=>{const element=document.querySelector('.cell[data-r="'+row+'"][data-c="'+col+'"]');if(!element)throw new Error('missing rendered cell '+row+','+col);return element};
const center=element=>{const rect=element.getBoundingClientRect();return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
const installCapture=selector=>{const owner=document.querySelector(selector);if(owner.__safariCaptureStub)return;const ids=new Set();owner.__safariCaptureStub=true;owner.setPointerCapture=id=>ids.add(id);owner.hasPointerCapture=id=>ids.has(id);owner.releasePointerCapture=id=>ids.delete(id)};
const pointer=(type,element,point,id=71,buttons=(type==='pointerup'||type==='pointercancel'?0:1))=>element.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:point.x,clientY:point.y,pointerId:id,pointerType:'mouse',isPrimary:true,button:0,buttons}));
const press=(element,key)=>{element.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,code:key}));element.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,cancelable:true,key,code:key}))};
const clickCell=async(row,col)=>{const target=cell(row,col),point=center(target);installCapture('#gridCanvas');pointer('pointerdown',target,point);pointer('pointerup',target,point,71,0);await wait(35)};
const setDraft=async(value,caret=value.length,owner='cellEditor')=>{const input=document.getElementById(owner);input.value=value;input.setSelectionRange(caret,caret);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));await wait(20)};
const editCell=async(row,col,value)=>{await clickCell(row,col);press(document,'F2');await wait(25);await setDraft(value);press(document.getElementById('cellEditor'),'Enter');await wait(55)};
const dragCells=async(r1,c1,r2,c2)=>{const source=cell(r1,c1),target=cell(r2,c2);installCapture('#gridCanvas');pointer('pointerdown',source,center(source),72);pointer('pointermove',target,center(target),72);pointer('pointerup',target,center(target),72,0);await wait(55)};
const dragFill=async(row,col,release=true)=>{const handle=document.getElementById('fillHandle'),target=cell(row,col);installCapture('#gridCanvas');pointer('pointerdown',handle,center(handle),73);pointer('pointermove',target,center(target),73);if(release)pointer('pointerup',target,center(target),73,0);await wait(90);return target};
const raw=async(row,col)=>{await clickCell(row,col);return document.getElementById('formulaInput').value};
`;

const safariScenarios = [
  ['S1', 'cell formula pick and one-action commit', `await clickCell(1,1);press(document,'F2');await setDraft('=');await clickCell(2,2);assert(document.getElementById('cellEditor').value==='=C3','pick failed');assert(document.getElementById('nameBox').value==='B2','origin moved');press(document.getElementById('cellEditor'),'Enter');await wait(50);assert(await raw(1,1)==='=C3','commit failed');document.getElementById('undoBtn').click();await wait(30);assert(await raw(1,1)==='','undo failed');`],
  ['S2', 'range formula pick at caret', `await clickCell(1,1);press(document,'F2');await setDraft('=SUM()',5);await dragCells(2,2,4,3);assert(document.getElementById('cellEditor').value==='=SUM(C3:D5)','range pick failed');assert(getComputedStyle(document.getElementById('referenceBox')).display==='block','outline missing');`],
  ['S3', 'exact cell and range F4 cycles', `await clickCell(1,1);press(document,'F2');await setDraft('=');await clickCell(2,2);const editor=document.getElementById('cellEditor');for(const expected of ['=$C$3','=C$3','=$C3','=C3']){press(editor,'F4');await wait(20);assert(editor.value===expected,'cell F4 '+editor.value)}await setDraft('=SUM()',5);await dragCells(2,2,4,3);for(const expected of ['=SUM($C$3:$D$5)','=SUM(C$3:D$5)','=SUM($C3:$D5)','=SUM(C3:D5)']){press(editor,'F4');await wait(20);assert(editor.value===expected,'range F4 '+editor.value)}`],
  ['S4', 'Escape restores draft without history', `await clickCell(1,1);press(document,'F2');await setDraft('=');await clickCell(2,2);press(document.getElementById('cellEditor'),'Escape');await wait(40);assert(document.getElementById('formulaInput').value==='','escape failed');assert(document.getElementById('undoBtn').disabled,'escape created history');`],
  ['S5', 'numeric styled fill exact Undo and Redo', `await editCell(0,2,'1');await editCell(1,2,'2');await clickCell(0,2);document.getElementById('boldBtn').click();await dragCells(0,2,1,2);await dragFill(3,2);assert(await raw(2,2)==='3'&&await raw(3,2)==='4','numeric fill failed');document.getElementById('undoBtn').click();await wait(35);assert(await raw(2,2)===''&&await raw(3,2)==='','fill undo failed');document.getElementById('redoBtn').click();await wait(35);assert(await raw(2,2)==='3'&&await raw(3,2)==='4','fill redo failed');`],
  ['S6', 'reverse numeric fill', `await editCell(2,2,'1');await editCell(3,2,'2');await dragCells(2,2,3,2);await dragFill(0,2);assert(await raw(0,2)==='-1'&&await raw(1,2)==='0','reverse fill failed');`],
  ['S7', 'horizontal numeric fill', `await editCell(0,2,'1');await editCell(0,3,'2');await dragCells(0,2,0,3);await dragFill(0,5);assert(await raw(0,4)==='3'&&await raw(0,5)==='4','horizontal fill failed');`],
  ['S8', 'relative formula fill', `await editCell(0,1,'5');await editCell(0,0,'=B1');await clickCell(0,0);await dragFill(2,0);assert(await raw(1,0)==='=B2'&&await raw(2,0)==='=B3','formula fill failed');`],
  ['S9', 'cancelled fill is a no-op', `await editCell(0,2,'1');await editCell(1,2,'2');await dragCells(0,2,1,2);const target=await dragFill(3,2,false);press(document,'Escape');await wait(30);pointer('pointerup',target,center(target),73,0);assert(await raw(2,2)===''&&await raw(3,2)==='','cancel mutated cells');document.getElementById('undoBtn').click();await wait(30);assert(await raw(0,2)==='1'&&await raw(1,2)==='','cancel created history');`],
  ['S10', 'stationary pointer native rAF autoscroll', `await editCell(0,0,'1');await clickCell(0,0);const handle=document.getElementById('fillHandle'),viewport=document.getElementById('gridViewport'),vr=viewport.getBoundingClientRect(),stationary={x:vr.left+vr.width/2,y:vr.bottom-2};installCapture('#gridCanvas');pointer('pointerdown',handle,center(handle),74);pointer('pointermove',document.getElementById('gridCanvas'),stationary,74);const samples=[];for(let i=0;i<4;i++){await wait(90);samples.push(viewport.scrollTop)}assert(samples[1]>samples[0]&&samples[2]>samples[1],'stationary autoscroll failed '+samples);press(document,'Escape');pointer('pointerup',document.getElementById('gridCanvas'),stationary,74,0);`],
  ['S11', 'zoom and pointer resize geometry', `const zoom=document.getElementById('zoomSelect');zoom.value='0.8';zoom.dispatchEvent(new Event('change',{bubbles:true}));await wait(50);const header=document.querySelector('.col-header[data-c="2"]'),before=header.getBoundingClientRect().width,resizer=header.querySelector('.col-resizer'),start=center(resizer),end={x:start.x+50,y:start.y};installCapture('#colHeaderCanvas');pointer('pointerdown',resizer,start,75);pointer('pointermove',document.getElementById('colHeaderCanvas'),end,75);pointer('pointerup',document.getElementById('colHeaderCanvas'),end,75,0);await wait(50);assert(header.getBoundingClientRect().width>before,'resize failed');await editCell(0,2,'1');await editCell(1,2,'2');await dragCells(0,2,1,2);await dragFill(3,2);assert(await raw(3,2)==='4','zoom fill failed');`],
  ['S14', 'CSV and Excel export hooks execute', `document.getElementById('exportCsvBtn').click();await wait(40);assert(document.getElementById('toast').textContent.includes('CSV'),'CSV hook failed');document.getElementById('exportExcelBtn').click();await wait(40);assert(document.getElementById('toast').textContent.includes('Excel'),'Excel hook failed');`],
  ['S15', 'focus transfer and sheet switch commit once', `await clickCell(1,1);press(document,'F2');await setDraft('transfer');document.getElementById('formulaInput').focus();await wait(25);assert(document.getElementById('formulaInput').value==='transfer','focus transfer lost draft');document.getElementById('newSheetBtn').click();await wait(40);document.querySelector('.sheet-tab').click();await wait(30);assert(await raw(1,1)==='transfer','sheet switch did not commit');`],
  ['S16', 'canonical errors and lazy IF stay error-free', `for(const [col,formula] of [[2,'=#REF!'],[3,'=SUM(#REF!,1)'],[4,'=IF(FALSE,#REF!,1)'],[5,'=IF(TRUE,1,#REF!)'],[6,'=IF(#REF!,1,2)']])await editCell(0,col,formula);const values=[cell(0,2).textContent,cell(0,3).textContent,cell(0,4).textContent,cell(0,5).textContent,cell(0,6).textContent];assert(JSON.stringify(values)===JSON.stringify(['#REF!','#REF!','1','1','#REF!']),'error semantics '+JSON.stringify(values));`]
];

assert.equal(safariScenarios.length, 14, 'Safari JavaScript matrix plus two file-input cases totals S1-S16');
for (const [id, , body] of safariScenarios) {
  assert.doesNotThrow(() => new Function(`return async function(){${safariHarness}${body}}`), `${id} JavaScript compiles`);
}

async function runSafariJsScenario(id, name, body) {
  await navigateSafari();
  const script = `const done=arguments[arguments.length-1];(async()=>{try{${safariHarness}${body}if(window.__safariRegressionErrors.length)throw new Error(window.__safariRegressionErrors.join(' | '));done({ok:true,id:${JSON.stringify(id)},name:${JSON.stringify(name)}})}catch(error){done({ok:false,id:${JSON.stringify(id)},name:${JSON.stringify(name)},error:String(error?.stack||error)})}})();`;
  const result = await executeAsync(script);
  if (!result?.ok) throw new Error(result?.error || `${id} returned no result`);
}

try {
  await waitForHttp(baseUrl);
  const root = await fetch(baseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Version/18.5 Safari/605.1.15' } });
  const html = await root.text();
  const module = await fetch(`${baseUrl}src/spreadsheet-core.mjs`, { headers: { 'User-Agent': 'Mozilla/5.0 Version/18.5 Safari/605.1.15' } });
  assert.equal(root.status, 200);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type') || '', /(?:text|application)\/javascript/);
  assert.match(html, /type="module"/);
  assert.match(html, /from '\.\/src\/spreadsheet-core\.mjs'/);
  await waitForHttp(`http://127.0.0.1:${driverPort}/status`);
  const status = await (await fetch(`http://127.0.0.1:${driverPort}/status`)).json();
  const response = await fetch(`http://127.0.0.1:${driverPort}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: 'safari', 'safari:automaticInspection': true } } })
  });
  const result = await response.json();
  if (!response.ok) {
    const evidence = {
      safariDriverReady: status.value?.ready === true,
      webdriverHttpStatus: response.status,
      automation: 'blocked',
      error: result.value?.error,
      message: result.value?.message,
      localRootStatus: root.status,
      moduleStatus: module.status,
      moduleContentType: module.headers.get('content-type'),
      interactionMatrix: { passed: 0, failed: 0, blocked: SAFARI_MATRIX_TOTAL, total: SAFARI_MATRIX_TOTAL },
      manualChecklist: 'tests/safari-manual-smoke.md'
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (!allowBlocked) process.exitCode = 2;
  } else {
    sessionId = result.value?.sessionId;
    assert.ok(sessionId, 'Safari returned a WebDriver session id');
    await webdriver(`/session/${sessionId}/timeouts`, { method: 'POST', body: { script: 30_000, pageLoad: 20_000, implicit: 0 } });
    const outcomes = [];
    for (const [id, name, body] of safariScenarios) {
      try {
        await runSafariJsScenario(id, name, body);
        outcomes.push({ id, name, status: 'passed' });
        process.stdout.write(`PASS ${id} ${name}\n`);
      } catch (error) {
        outcomes.push({ id, name, status: 'failed', error: error.message });
        process.stdout.write(`FAIL ${id} ${name}: ${error.message}\n`);
      }
    }
    for (const [id, name, selector, path, assertion] of [
      ['S12', 'XBRL file import', '#xbrlInput', XBRL_FIXTURE, `return document.querySelectorAll('.sheet-tab').length===4 && document.body.textContent.includes('Facts') && document.getElementById('appStatus').textContent.includes('2개 Fact');`],
      ['S13', 'JSON file roundtrip input', '#jsonInput', JSON_FIXTURE, `return document.getElementById('workbookTitle').value==='Safari JSON fixture' && document.querySelector('.sheet-tab').textContent==='Fixture' && document.querySelector('.cell[data-r="0"][data-c="0"]').textContent==='42';`]
    ]) {
      try {
        await navigateSafari();
        await uploadFile(selector, path);
        if (id === 'S12') await waitSafari(`document.getElementById('appStatus').textContent.includes('2개 Fact')`);
        else await waitSafari(`document.getElementById('workbookTitle').value==='Safari JSON fixture'`);
        assert.equal(await executeSync(assertion), true);
        outcomes.push({ id, name, status: 'passed' });
        process.stdout.write(`PASS ${id} ${name}\n`);
      } catch (error) {
        outcomes.push({ id, name, status: 'failed', error: error.message });
        process.stdout.write(`FAIL ${id} ${name}: ${error.message}\n`);
      }
    }
    outcomes.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
    const passed = outcomes.filter(item => item.status === 'passed').length;
    const failed = outcomes.filter(item => item.status === 'failed').length;
    const evidence = {
      automation: 'available',
      interactionMatrix: { passed, failed, blocked: 0, total: outcomes.length },
      outcomes,
      manualChecklist: 'tests/safari-manual-smoke.md'
    };
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (failed) process.exitCode = 1;
  }
} finally {
  if (sessionId) await fetch(`http://127.0.0.1:${driverPort}/session/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  driver.kill('SIGTERM');
  staticServer?.kill('SIGTERM');
}
