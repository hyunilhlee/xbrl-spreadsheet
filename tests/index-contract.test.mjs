import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('G002 loads the pure core through the hosted relative ESM boundary', () => {
  assert.match(html, /<script type="module">/);
  assert.match(html, /from '\.\/src\/spreadsheet-core\.mjs';/);
  assert.match(html, /id="referenceBox" class="reference-box"/);
});

test('G002 evaluator consumes the canonical scanner and ERROR token contract', () => {
  assert.match(html, /this\.canonical=new Map\(scanFormula\(s\)/);
  assert.match(html, /canonical\.type==='ERROR'\?\{t:'ERROR'/);
  assert.match(html, /if\(z\.cur\.t==='REF'\)/);
  assert.match(html, /if\(z\.cur\.t==='ERROR'\)/);
  assert.doesNotMatch(html, /\?\s*'CELL'\s*:\s*'ID'/);
  assert.match(html, /function parseA1\(ref\)\{const parsed=parseA1Reference/);
  assert.match(html, /function formulaToR1C1\(raw\)\{const source=String\(raw\),refs=scanFormula/);
});

test('G002 keeps IF lazy and non-IF functions consumption-strict', () => {
  assert.match(html, /parseIf\(evaluate\)/);
  assert.match(html, /evaluateLazyIf\(condition,whenTrue,whenFalse\)/);
  assert.match(html, /const consumedError=firstConsumedError\(args\);if\(consumedError\)return consumedError/);
});

test('G002 routes pointer and terminal events through the pure reducer', () => {
  for (const event of ['POINTER_DOWN', 'POINTER_MOVE', 'POINTER_UP', 'POINTER_CANCEL', 'LOST_POINTER_CAPTURE', 'ESCAPE', 'ENTER', 'SHEET_ACTIVATE', 'WORKBOOK_REPLACE', 'WINDOW_BLUR']) {
    assert.ok(html.includes(`type:'${event}'`), event);
  }
  assert.match(html, /toggleReferenceAtCaret\(session\.draft/);
  assert.match(html, /trackedReferenceSpan/);
});

test('G003 routes fill preview, autoscroll, atomic preflight, and sparse history through core seams', () => {
  assert.match(html, /id="fillPreview" class="fill-preview"/);
  assert.match(html, /id="fillHandle" class="fill-handle"/);
  assert.match(html, /intent:'fill'/);
  assert.match(html, /type:'AUTOSCROLL_FRAME'/);
  assert.match(html, /planFill\(\{cellMap:sh\.cells,sourceCellMap:effect\.sourceSnapshot/);
  assert.match(html, /prepareHistoryAction\(\{type:'fill'/);
  assert.match(html, /applySparseEntries\(sh\.cells,prepared\.action\.entries,'after'\)/);
  assert.match(html, /if\(action\.type==='fill'\)applySparseEntries\(sh\.cells,action\.entries,redo\?'after':'before'\)/);
  assert.match(html, /historyBytes/);
});

test('G006 routes resize and capture failures through reducer-owned pointer terminals', () => {
  assert.doesNotMatch(html, /app\.resizing/);
  assert.doesNotMatch(html, /document\.addEventListener\('mousemove'/);
  assert.doesNotMatch(html, /document\.addEventListener\('mouseup'/);
  assert.match(html, /intent:'resize'/);
  assert.match(html, /captureOwner:'column-header'/);
  assert.match(html, /case'UPDATE_RESIZE'/);
  assert.match(html, /case'RESTORE_RESIZE'/);
  assert.match(html, /setPointerCapture\(effect\.pointerId\)\}catch\{dispatchInteraction\(\{type:'POINTER_CANCEL'/);
  assert.match(html, /포인터 캡처 실패 · 변경사항 없음/);
});
