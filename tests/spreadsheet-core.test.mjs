import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HISTORY_MAX_BYTES,
  applySparseEntries,
  applySparseSnapshot,
  buildReferenceText,
  canonicalizeHistoryAction,
  classifyFillLane,
  edgeAutoscroll,
  encodedHistoryBytes,
  evaluateLazyIf,
  evaluateStrictArguments,
  evaluateStrictBinary,
  evaluateStrictUnary,
  firstConsumedError,
  formatA1Reference,
  generateFillLaneValue,
  insertReferenceDraft,
  isSpreadsheetError,
  parseA1Reference,
  planFill,
  pointerToCell,
  preflightHistoryCommit,
  reduceInteraction,
  resolveDominantAxis,
  rollbackSparseEntries,
  scanFormula,
  snapshotSparseCell,
  toggleReferenceAtCaret,
  translateFormulaReferences
} from '../src/spreadsheet-core.mjs';

const cell = (v = '', style = {}) => ({ v, style });

test('U1 canonical A1 parser formats cells, ranges, and sheet qualifiers', () => {
  for (const text of ['A1', '$A$1', '$A1', 'A$1', 'AA10', 'C3:D5', 'Sheet1!A1', "'재무''표'!$C3:D$5"]) {
    const parsed = parseA1Reference(text);
    assert.ok(parsed, text);
    assert.equal(formatA1Reference(parsed), text);
    assert.equal(parsed.start, 0);
    assert.equal(parsed.end, text.length);
  }
  assert.equal(parseA1Reference('A0'), null);
  assert.equal(parseA1Reference('XFE1'), null);
  assert.equal(parseA1Reference('A1:'), null);
  assert.equal(parseA1Reference('A-1'), null);
});

test('U1 scanner is quote-aware and emits exact reference/error spans', () => {
  const formula = `=SUM('재무''표'!$A1:B$2,Sheet1!C3,"A1 and ""B2""")+#REF!+#DIV/0!+#VALUE!+#NAME?+#NUM!+#CYCLE!`;
  const tokens = scanFormula(formula);
  const references = tokens.filter(token => token.type === 'REFERENCE');
  assert.deepEqual(references.map(token => token.text), ["'재무''표'!$A1:B$2", 'Sheet1!C3']);
  assert.deepEqual(tokens.filter(token => token.type === 'ERROR').map(token => token.value), [
    '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#CYCLE!'
  ]);
  for (const token of tokens) assert.equal(formula.slice(token.start, token.end), token.text);
  assert.equal(scanFormula('=LOG10(A1)+RATE1_NAME+"C3"').filter(token => token.type === 'REFERENCE').map(token => token.text).join(','), 'A1');
});

test('U1 reference building orders reverse drags and tracks a half-open span', () => {
  assert.deepEqual(buildReferenceText({ row: 4, col: 3 }, { row: 2, col: 2 }, 5), {
    text: 'C3:D5',
    span: [5, 10]
  });
  assert.deepEqual(insertReferenceDraft('=SUM()', [5, 5], { row: 4, col: 3 }, { row: 2, col: 2 }), {
    draft: '=SUM(C3:D5)',
    span: [5, 10],
    caret: 10
  });
});

test('U2 F4 cycles exact cell and range modes', () => {
  const cellCycle = ['C3', '$C$3', 'C$3', '$C3', 'C3'];
  const rangeCycle = ['C3:D5', '$C$3:$D$5', 'C$3:D$5', '$C3:$D5', 'C3:D5'];
  for (const cycle of [cellCycle, rangeCycle]) {
    let draft = cycle[0];
    let span = [0, draft.length];
    for (const expected of cycle.slice(1)) {
      const result = toggleReferenceAtCaret(draft, draft.length, span);
      assert.equal(result.draft, expected);
      assert.deepEqual(result.span, [0, expected.length]);
      draft = result.draft;
      span = result.span;
    }
  }
});

test('U2 tracked F4 span wins and no-token caret is byte-for-byte no-op', () => {
  const draft = '=A1 + SUM(C3:D5) + "E6"';
  const start = draft.indexOf('C3');
  const tracked = toggleReferenceAtCaret(draft, draft.indexOf('A1') + 1, [start, start + 'C3:D5'.length]);
  assert.equal(tracked.draft, '=A1 + SUM($C$3:$D$5) + "E6"');
  assert.equal(tracked.draft.slice(0, start), draft.slice(0, start));
  const whitespaceCaret = draft.indexOf(' + SUM') + 1;
  const whitespace = toggleReferenceAtCaret(draft, whitespaceCaret, null);
  assert.deepEqual(whitespace, { draft, caret: whitespaceCaret, span: null, changed: false, token: null });
  const insideString = toggleReferenceAtCaret(draft, draft.indexOf('E6') + 1, null);
  assert.equal(insideString.changed, false);
  const immediatelyRight = toggleReferenceAtCaret('=A1+1', 3, null);
  assert.equal(immediatelyRight.draft, '=$A$1+1');
});

test('U3 formula translation preserves absolute axes, strings, sheets, and errors', () => {
  assert.equal(
    translateFormulaReferences('=A1+$B1+C$1+$D$1+SUM(E1:F2)', 2, 0),
    '=A3+$B3+C$1+$D$1+SUM(E3:F4)'
  );
  assert.equal(translateFormulaReferences('="A1"&A1', 2, 0), '="A1"&A3');
  assert.equal(translateFormulaReferences('="A1 ""B2"""&\'재무표\'!C3+Sheet1!D4', -1, 2), '="A1 ""B2"""&\'재무표\'!E2+Sheet1!F3');
  assert.equal(translateFormulaReferences('=#REF!+#DIV/0!', 2, 2), '=#REF!+#DIV/0!');
});

test('U3 qualified references translate against Excel bounds, not the source sheet dimensions', () => {
  assert.equal(
    translateFormulaReferences("='Wide'!AE1+A1", 1, 0, { maxRows: 300, maxCols: 30 }),
    "='Wide'!AE2+A2"
  );
  assert.equal(
    translateFormulaReferences("='Wide'!AE1:AF2", 2, 0, { maxRows: 300, maxCols: 30 }),
    "='Wide'!AE3:AF4"
  );
  assert.equal(translateFormulaReferences('=AE1', 1, 0, { maxRows: 300, maxCols: 30 }), '=#REF!');
});

test('U3 out-of-grid endpoints replace the whole reference token with #REF!', () => {
  assert.equal(translateFormulaReferences('=A1+B2', -1, 0), '=#REF!+B1');
  assert.equal(translateFormulaReferences('=SUM(A1:B2)', -1, 0), '=SUM(#REF!)');
  assert.equal(translateFormulaReferences('=A1:B2', 0, -1), '=#REF!');
  assert.equal(translateFormulaReferences('=$A1+A$1+$A$1', -1, -1), '=#REF!+#REF!+$A$1');
});

test('U3b canonical errors are strict while IF consumes only the selected branch', () => {
  assert.equal(isSpreadsheetError('#REF!'), true);
  assert.equal(firstConsumedError([1, '#REF!', '#DIV/0!']), '#REF!');
  assert.equal(firstConsumedError([[1, '#NUM!'], '#REF!']), '#NUM!');
  assert.equal(evaluateStrictArguments(['#REF!', 1], () => 99), '#REF!');
  assert.equal(evaluateStrictArguments([[1, '#REF!'], 2], () => 99), '#REF!');
  assert.equal(evaluateStrictArguments([1, 2], values => values.reduce((a, b) => a + b)), 3);
  assert.equal(evaluateStrictUnary('#REF!', value => -value), '#REF!');
  assert.equal(evaluateStrictUnary(2, value => -value), -2);
  let rightCalls = 0;
  assert.equal(evaluateStrictBinary('#REF!', () => { rightCalls += 1; return '#DIV/0!'; }, () => 99), '#REF!');
  assert.equal(rightCalls, 0, 'a left operator error prevents semantic evaluation of the right operand');
  assert.equal(evaluateStrictBinary(1, () => { rightCalls += 1; return '#DIV/0!'; }, () => 99), '#DIV/0!');
  assert.equal(rightCalls, 1);
  let strictCalls = 0;
  assert.equal(evaluateStrictArguments([() => { strictCalls += 1; return '#REF!'; }, () => { strictCalls += 1; return 2; }], () => 99), '#REF!');
  assert.equal(strictCalls, 2, 'strict functions consume every argument');
  let trueCalls = 0;
  let falseCalls = 0;
  assert.equal(evaluateLazyIf(false, () => { trueCalls += 1; return '#REF!'; }, () => { falseCalls += 1; return 1; }), 1);
  assert.deepEqual([trueCalls, falseCalls], [0, 1]);
  assert.equal(evaluateLazyIf(true, () => 1, () => '#REF!'), 1);
  assert.equal(evaluateLazyIf('#REF!', () => 1, () => 2), '#REF!');
  assert.equal(evaluateLazyIf(true, () => '#NUM!', () => 1), '#NUM!');
  assert.equal(evaluateLazyIf(false, () => 1, () => '#VALUE!'), '#VALUE!');
});

test('U4 lane classifiers generate numeric forward/reverse constant-step series', () => {
  const classification = classifyFillLane([{ v: '1' }, { v: '2' }]);
  assert.deepEqual(classification, { type: 'number', first: 1, step: 1 });
  assert.deepEqual([2, 3, -1, -2].map(index => generateFillLaneValue(classification, index)), ['3', '4', '0', '-1']);
  assert.equal(classifyFillLane([{ v: '1' }]).type, 'repeat');
  assert.equal(classifyFillLane([{ v: '1' }, { v: '3' }, { v: '6' }]).type, 'repeat');
  assert.deepEqual(classifyFillLane([{ v: '-1.5' }, { v: '-0.5' }]), { type: 'number', first: -1.5, step: 1 });
});

test('U4 ISO dates use validated UTC days across leap/month/year boundaries', () => {
  const leap = classifyFillLane([{ v: '2024-02-28' }, { v: '2024-02-29' }]);
  assert.equal(leap.type, 'date');
  assert.equal(generateFillLaneValue(leap, 2), '2024-03-01');
  assert.equal(generateFillLaneValue(leap, -1), '2024-02-27');
  const year = classifyFillLane([{ v: '2025-12-30' }, { v: '2025-12-31' }]);
  assert.equal(generateFillLaneValue(year, 2), '2026-01-01');
  assert.equal(classifyFillLane([{ v: '2026-02-30' }, { v: '2026-03-01' }]).type, 'repeat');
  assert.equal(classifyFillLane([{ v: '2026-02-30' }, { v: '2026-02-31' }]).type, 'repeat');
  assert.equal(classifyFillLane([{ v: '7/10/2026' }, { v: '7/11/2026' }]).type, 'repeat');
});

test('U4 text-number lanes preserve padding, sign, and expanding width', () => {
  const padded = classifyFillLane([{ v: 'Q01' }, { v: 'Q02' }]);
  assert.equal(generateFillLaneValue(padded, 2), 'Q03');
  assert.equal(generateFillLaneValue(padded, 100), 'Q101');
  const reverse = classifyFillLane([{ v: 'Q00' }, { v: 'Q01' }]);
  assert.equal(generateFillLaneValue(reverse, -1), 'Q-01');
  assert.equal(classifyFillLane([{ v: 'Q01' }, { v: 'R02' }]).type, 'repeat');
});

test('U4/U5 vertical fill creates independent lanes with mapped styles', () => {
  const cells = {
    '0,0': cell('1', { bold: true }),
    '1,0': cell('2', { align: 'right' }),
    '0,1': cell('10', { format: 'number' }),
    '1,1': cell('20', { decimals: 2 })
  };
  const plan = planFill({ cellMap: cells, sourceRect: { r1: 0, c1: 0, r2: 1, c2: 1 }, destinationRect: { r1: 2, c1: 0, r2: 3, c2: 1 } });
  assert.equal(plan.direction, 'down');
  assert.deepEqual(plan.entries.map(entry => [entry.r, entry.c, entry.after.v]), [
    [2, 0, '3'], [2, 1, '30'], [3, 0, '4'], [3, 1, '40']
  ]);
  assert.deepEqual(plan.entries[0].after.style, { bold: true });
  assert.deepEqual(plan.entries[2].after.style, { align: 'right' });
  assert.notEqual(plan.entries[0].after.style, cells['0,0'].style);
});

test('U5 fill planning reads immutable source snapshots separately from live destinations', () => {
  const live = {
    '0,0': cell('100', { bold: false }),
    '1,0': cell('200', { bold: false })
  };
  const sourceSnapshot = {
    '0,0': cell('1', { bold: true }),
    '1,0': cell('2', { align: 'right' })
  };
  const plan = planFill({
    cellMap: live,
    sourceCellMap: sourceSnapshot,
    sourceRect: { r1: 0, c1: 0, r2: 1, c2: 0 },
    destinationRect: { r1: 2, c1: 0, r2: 3, c2: 0 }
  });
  assert.deepEqual(plan.entries.map(entry => [entry.after.v, entry.after.style]), [
    ['3', { bold: true }],
    ['4', { align: 'right' }]
  ]);
});

test('U4/U5 reverse fill uses negative logical indices and cyclic source styles', () => {
  const cells = {
    '2,0': cell('1', { bold: true }),
    '3,0': cell('2', { align: 'center' })
  };
  const plan = planFill({ cellMap: cells, sourceRect: { r1: 2, c1: 0, r2: 3, c2: 0 }, destinationRect: { r1: 0, c1: 0, r2: 1, c2: 0 } });
  assert.deepEqual(plan.entries.map(entry => [entry.r, entry.after.v, entry.after.style]), [
    [0, '-1', { bold: true }],
    [1, '0', { align: 'center' }]
  ]);
});

test('U4/U5 horizontal fill keeps row lanes independent in both directions', () => {
  const cells = {
    '0,2': cell('1'), '0,3': cell('2'),
    '1,2': cell('10'), '1,3': cell('20')
  };
  const right = planFill({ cellMap: cells, sourceRect: { r1: 0, c1: 2, r2: 1, c2: 3 }, destinationRect: { r1: 0, c1: 4, r2: 1, c2: 5 } });
  assert.deepEqual(right.entries.map(entry => [entry.r, entry.c, entry.after.v]), [
    [0, 4, '3'], [0, 5, '4'], [1, 4, '30'], [1, 5, '40']
  ]);
  const left = planFill({ cellMap: cells, sourceRect: { r1: 0, c1: 2, r2: 1, c2: 3 }, destinationRect: { r1: 0, c1: 0, r2: 1, c2: 1 } });
  assert.deepEqual(left.entries.map(entry => [entry.r, entry.c, entry.after.v]), [
    [0, 0, '-1'], [0, 1, '0'], [1, 0, '-10'], [1, 1, '0']
  ]);
});

test('U4/U5 repeat lanes retain blanks and translate each mapped formula from its own source', () => {
  const cells = {
    '0,0': cell('=A1', { bold: true }),
    '0,1': cell('', { align: 'center' }),
    '0,2': cell('x', { format: 'text' }),
    '0,3': cell('old')
  };
  const plan = planFill({ cellMap: cells, sourceRect: { r1: 0, c1: 0, r2: 0, c2: 2 }, destinationRect: { r1: 0, c1: 3, r2: 0, c2: 5 } });
  assert.deepEqual(plan.entries.map(entry => entry.after), [
    { existed: true, v: '=D1', style: { bold: true } },
    { existed: true, v: '', style: { align: 'center' } },
    { existed: true, v: 'x', style: { format: 'text' } }
  ]);
  cells['0,0'].style.bold = false;
  assert.equal(plan.entries[0].after.style.bold, true);
});

test('U5 fill snapshots only changed cells, excludes source, and enforces destination cap', () => {
  const cells = { '0,0': cell('x'), '0,1': cell('x') };
  const noOp = planFill({ cellMap: cells, sourceRect: { r1: 0, c1: 0, r2: 0, c2: 0 }, destinationRect: { r1: 0, c1: 0, r2: 0, c2: 1 } });
  assert.equal(noOp.reason, 'no-op');
  assert.deepEqual(noOp.entries, []);
  const limited = planFill({
    cellMap: {},
    sourceRect: { r1: 0, c1: 0, r2: 0, c2: 0 },
    destinationRect: { r1: 1, c1: 0, r2: 50_001, c2: 0 }
  });
  assert.deepEqual(limited, { accepted: false, reason: 'destination-limit', entries: [] });
});

test('U3b/U5 fill-generated out-of-bounds reference is canonical #REF!', () => {
  const cells = { '1,0': cell('=A1') };
  const plan = planFill({ cellMap: cells, sourceRect: { r1: 1, c1: 0, r2: 1, c2: 0 }, destinationRect: { r1: 0, c1: 0, r2: 0, c2: 0 } });
  assert.equal(plan.entries[0].after.v, '=#REF!');
  assert.equal(scanFormula(plan.entries[0].after.v)[0].value, '#REF!');
});

test('U3/U5 fill translates a qualified wide-sheet reference from a 30-column source sheet', () => {
  const cells = { '0,0': cell("='Wide'!AE1") };
  const plan = planFill({
    cellMap: cells,
    sourceRect: { r1: 0, c1: 0, r2: 0, c2: 0 },
    destinationRect: { r1: 1, c1: 0, r2: 1, c2: 0 },
    maxRows: 300,
    maxCols: 30
  });
  assert.equal(plan.entries[0].after.v, "='Wide'!AE2");
});

test('U5b sparse snapshots distinguish absent, explicit empty, styled empty, and populated cells', () => {
  const cells = {
    empty: cell(''),
    styled: cell('', { bold: true }),
    value: cell('7', { decimals: 2 })
  };
  assert.deepEqual(snapshotSparseCell(cells, 'missing'), { existed: false, v: '', style: {} });
  assert.deepEqual(snapshotSparseCell(cells, 'empty'), { existed: true, v: '', style: {} });
  assert.deepEqual(snapshotSparseCell(cells, 'styled'), { existed: true, v: '', style: { bold: true } });
  const snap = snapshotSparseCell(cells, 'value');
  cells.value.style.decimals = 9;
  assert.deepEqual(snap, { existed: true, v: '7', style: { decimals: 2 } });
});

test('U5b sparse apply, undo, and redo restore exact key existence without style aliasing', () => {
  const cells = {};
  const entries = [{
    r: 1,
    c: 2,
    before: { existed: false, v: '', style: {} },
    after: { existed: true, v: '9', style: { bold: true } }
  }];
  const applied = applySparseEntries(cells, entries, 'after');
  assert.deepEqual(cells['1,2'], { v: '9', style: { bold: true } });
  entries[0].after.style.bold = false;
  assert.equal(cells['1,2'].style.bold, true);
  rollbackSparseEntries(cells, applied, 'after');
  assert.equal(Object.hasOwn(cells, '1,2'), false);
  applySparseEntries(cells, entries, 'after');
  applySparseEntries(cells, entries, 'before');
  assert.equal(Object.hasOwn(cells, '1,2'), false);
  applySparseSnapshot(cells, 'empty', { existed: true, v: '', style: {} });
  assert.equal(Object.hasOwn(cells, 'empty'), true);
});

test('U5b sparse batch rolls back earlier entries when a later application throws', () => {
  const target = {};
  const cells = new Proxy(target, {
    set(object, property, value) {
      if (property === '1,1') throw new Error('injected');
      object[property] = value;
      return true;
    }
  });
  const entries = [
    { r: 0, c: 0, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'a', style: {} } },
    { r: 1, c: 1, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'b', style: {} } }
  ];
  assert.throws(() => applySparseEntries(cells, entries, 'after'), /injected/);
  assert.deepEqual(target, {});
});

test('U5b sparse batch also restores a failing entry that mutated before throwing', () => {
  const target = {};
  const cells = new Proxy(target, {
    set(object, property, value) {
      object[property] = value;
      if (property === '1,1') throw new Error('mutated-then-failed');
      return true;
    }
  });
  const entries = [
    { r: 0, c: 0, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'a', style: {} } },
    { r: 1, c: 1, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'b', style: {} } }
  ];
  assert.throws(() => applySparseEntries(cells, entries, 'after'), /mutated-then-failed/);
  assert.deepEqual(target, {});
});

test('U5b sparse helpers operate on an explicitly passed Map as well as an object', () => {
  const cells = new Map([['0,0', cell('a', { bold: true })]]);
  const before = snapshotSparseCell(cells, '0,0');
  applySparseSnapshot(cells, '0,0', { existed: true, v: 'b', style: { align: 'right' } });
  assert.deepEqual(cells.get('0,0'), { v: 'b', style: { align: 'right' } });
  applySparseSnapshot(cells, '0,0', before);
  assert.deepEqual(cells.get('0,0'), { v: 'a', style: { bold: true } });
  applySparseSnapshot(cells, '0,0', { existed: false, v: '', style: {} });
  assert.equal(cells.has('0,0'), false);
});

test('U5b history canonicalization is row-major and style-key deterministic', () => {
  const one = {
    type: 'fill',
    sheetId: 's',
    entries: [
      { r: 2, c: 0, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'x', style: { bold: true, align: 'left' } } },
      { r: 1, c: 3, before: { existed: false, v: '', style: {} }, after: { existed: true, v: 'y', style: {} } }
    ]
  };
  const two = structuredClone(one);
  two.entries.reverse();
  two.entries[1].after.style = { align: 'left', bold: true };
  const canonical = canonicalizeHistoryAction(one);
  assert.deepEqual(canonical.entries.map(entry => [entry.r, entry.c]), [[1, 3], [2, 0]]);
  assert.equal(encodedHistoryBytes(one), encodedHistoryBytes(two));
});

test('U5b history preflight truncates redo only after acceptance and retains newest 100', () => {
  const action = index => ({ type: 'cells', sheetId: 's', changes: [{ r: index, c: 0, old: '', new: String(index) }] });
  const history = [action(1), action(2), action(3)];
  const rejected = preflightHistoryCommit({ history, historyIndex: 0, totalBytes: 0, action: null });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.nextHistory, history);
  const accepted = preflightHistoryCommit({ history, historyIndex: 0, totalBytes: 0, action: action(4) });
  assert.deepEqual(accepted.nextHistory, [canonicalizeHistoryAction(action(1)), canonicalizeHistoryAction(action(4))]);
  let state = { history: [], historyIndex: -1, totalBytes: 0 };
  for (let index = 0; index < 101; index += 1) {
    const next = preflightHistoryCommit({ ...state, action: action(index) });
    state = { history: next.nextHistory, historyIndex: next.nextIndex, totalBytes: next.nextBytes };
  }
  assert.equal(state.history.length, 100);
  assert.equal(state.history[0].changes[0].new, '1');
  assert.equal(state.history.at(-1).changes[0].new, '100');
});

test('U5b history preflight enforces aggregate bytes and rejects an oversized action without changing inputs', () => {
  const a = { type: 'note', value: 'a'.repeat(700) };
  const b = { type: 'note', value: 'b'.repeat(700) };
  const history = [a, b];
  const maxBytes = encodedHistoryBytes(b) + 20;
  const next = preflightHistoryCommit({ history, historyIndex: 1, totalBytes: 1, action: { type: 'note', value: 'c'.repeat(10) }, maxBytes });
  assert.equal(next.accepted, true);
  assert.ok(next.nextBytes <= maxBytes);
  assert.equal(next.nextHistory[0].value.startsWith('b') || next.nextHistory[0].value.startsWith('c'), true);
  const oversized = { type: 'note', value: 'x'.repeat(DEFAULT_HISTORY_MAX_BYTES + 1) };
  const rejected = preflightHistoryCommit({ history, historyIndex: 0, totalBytes: 9, action: oversized });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'action-too-large');
  assert.equal(rejected.nextHistory, history);
  assert.equal(rejected.nextIndex, 0);
  assert.deepEqual(history, [a, b]);
});

test('U6 pointer mapping honors zoom, variable columns, scrolling, and clamping', () => {
  const base = {
    viewportRect: { left: 100, top: 50 },
    rowHeight: 28,
    columnOffsets: [0, 80, 200, 260],
    rows: 10,
    cols: 3
  };
  assert.deepEqual(pointerToCell({ ...base, clientX: 181, clientY: 79, zoom: 1 }), { row: 1, col: 1 });
  assert.deepEqual(pointerToCell({ ...base, clientX: 181, clientY: 79, zoom: 0.8 }), { row: 1, col: 1 });
  assert.deepEqual(pointerToCell({ ...base, clientX: 101, clientY: 51, scrollLeft: 210, scrollTop: 100, zoom: 1.25 }), { row: 2, col: 2 });
  assert.deepEqual(pointerToCell({ ...base, clientX: -999, clientY: 9999, zoom: 1 }), { row: 9, col: 0 });
});

test('U6 dominant-axis tie chooses vertical and edge autoscroll stops at boundaries', () => {
  assert.equal(resolveDominantAxis({ row: 1, col: 1 }, { row: 4, col: 4 }), 'down');
  assert.equal(resolveDominantAxis({ row: 1, col: 1 }, { row: 2, col: 5 }), 'right');
  assert.equal(resolveDominantAxis({ row: 1, col: 1 }, { row: 1, col: 1 }, 0), null);
  const rectangle = { left: 0, top: 0, right: 300, bottom: 200 };
  assert.deepEqual(edgeAutoscroll({ clientX: 299, clientY: 199, viewportRect: rectangle, scrollLeft: 0, scrollTop: 0, maxScrollLeft: 100, maxScrollTop: 100 }).active, true);
  assert.deepEqual(edgeAutoscroll({ clientX: 299, clientY: 199, viewportRect: rectangle, scrollLeft: 100, scrollTop: 100, maxScrollLeft: 100, maxScrollTop: 100 }), { dx: 0, dy: 0, active: false });
});

test('U7 reducer starts only eligible modes and stale pointer terminals are no-ops', () => {
  const idle = { gesture: { mode: 'idle' }, editSession: null };
  const selected = reduceInteraction(idle, { type: 'POINTER_DOWN', intent: 'select', pointerId: 1, cell: { row: 1, col: 1 } });
  assert.equal(selected.state.gesture.mode, 'select');
  assert.deepEqual(selected.effects.map(effect => effect.type), ['CAPTURE_POINTER', 'FOCUS_VIEWPORT', 'UPDATE_SELECTION']);
  assert.equal(reduceInteraction(selected.state, { type: 'POINTER_DOWN', intent: 'fill', pointerId: 2 }).effects.length, 0);
  assert.equal(reduceInteraction(selected.state, { type: 'POINTER_UP', pointerId: 99 }).effects.length, 0);
  const finished = reduceInteraction(selected.state, { type: 'POINTER_UP', pointerId: 1 });
  assert.equal(finished.state.gesture.mode, 'idle');
  assert.equal(reduceInteraction(finished.state, { type: 'POINTER_UP', pointerId: 1 }).effects.length, 0);
  const illegalReference = reduceInteraction(idle, { type: 'POINTER_DOWN', intent: 'reference', pointerId: 1, cell: { row: 0, col: 0 } });
  assert.equal(illegalReference.effects.length, 0);
});

test('U7 reference pointer lifecycle preserves origin and restores draft on cancellation', () => {
  const state = {
    gesture: { mode: 'idle' },
    editSession: { origin: { row: 1, col: 1 }, draft: '=SUM()', caret: 5, trackedReferenceSpan: null }
  };
  const started = reduceInteraction(state, { type: 'POINTER_DOWN', intent: 'reference', pointerId: 7, cell: { row: 2, col: 2 }, caret: 5 });
  assert.equal(started.state.editSession.draft, '=SUM(C3)');
  assert.deepEqual(started.state.editSession.origin, state.editSession.origin);
  const moved = reduceInteraction(started.state, { type: 'POINTER_MOVE', pointerId: 7, cell: { row: 4, col: 3 } });
  assert.equal(moved.state.editSession.draft, '=SUM(C3:D5)');
  const cancelled = reduceInteraction(moved.state, { type: 'POINTER_CANCEL', pointerId: 7 });
  assert.equal(cancelled.state.gesture.mode, 'idle');
  assert.equal(cancelled.state.editSession.draft, '=SUM()');
  assert.deepEqual(cancelled.effects.map(effect => effect.type), ['RELEASE_POINTER', 'RESTORE_REFERENCE_DRAFT']);
  const committedGesture = reduceInteraction(moved.state, { type: 'POINTER_UP', pointerId: 7 });
  assert.equal(committedGesture.state.editSession.draft, '=SUM(C3:D5)');
  assert.equal(committedGesture.effects.some(effect => effect.type === 'COMMIT_EDIT'), false);
});

test('U7 resize previews only for its pointer and cancellation restores the starting width', () => {
  const idle = { gesture: { mode: 'idle' }, editSession: null };
  const started = reduceInteraction(idle, { type: 'POINTER_DOWN', intent: 'resize', pointerId: 4, column: 2, startWidth: 112, clientX: 50, sheetId: 's', captureOwner: 'column-header' });
  assert.equal(started.state.gesture.mode, 'resize');
  assert.equal(started.state.gesture.startClientX, 50);
  assert.deepEqual(started.effects[0], { type: 'CAPTURE_POINTER', pointerId: 4, owner: 'column-header' });
  const stale = reduceInteraction(started.state, { type: 'POINTER_MOVE', pointerId: 9, width: 200 });
  assert.equal(stale.effects.length, 0);
  const moved = reduceInteraction(started.state, { type: 'POINTER_MOVE', pointerId: 4, width: 180 });
  assert.deepEqual(moved.effects, [{ type: 'UPDATE_RESIZE', sheetId: 's', column: 2, width: 180 }]);
  const cancelled = reduceInteraction(moved.state, { type: 'LOST_POINTER_CAPTURE', pointerId: 4 });
  assert.deepEqual(cancelled.effects.map(effect => effect.type), ['RELEASE_POINTER', 'RESTORE_RESIZE']);
  assert.equal(cancelled.effects[1].width, 112);
  assert.equal(cancelled.effects[1].sheetId, 's');
  const blurred = reduceInteraction(moved.state, { type: 'WINDOW_BLUR' });
  assert.deepEqual(blurred.effects.map(effect => effect.type), ['RELEASE_POINTER', 'RESTORE_RESIZE']);
  assert.equal(blurred.effects[0].owner, 'column-header');
  const finished = reduceInteraction(moved.state, { type: 'POINTER_UP', pointerId: 4 });
  assert.deepEqual(finished.effects, [{ type: 'RELEASE_POINTER', pointerId: 4, owner: 'column-header' }]);
  assert.equal(reduceInteraction(finished.state, { type: 'POINTER_UP', pointerId: 4 }).effects.length, 0);
});

test('U7 fill start snapshots immutably and all cancel terminals avoid commit effects', () => {
  const sourceSnapshot = [{ r: 0, c: 0, v: '1', style: { bold: true } }];
  const sourceRect = { r1: 0, c1: 0, r2: 0, c2: 0 };
  const started = reduceInteraction(
    { gesture: { mode: 'idle' }, editSession: null },
    { type: 'POINTER_DOWN', intent: 'fill', pointerId: 2, cell: { row: 0, col: 0 }, sourceRect, sourceSnapshot, clientX: 1, clientY: 1 }
  );
  assert.deepEqual(started.effects.map(effect => effect.type), ['CAPTURE_POINTER', 'SNAPSHOT_FILL_SOURCE', 'UPDATE_FILL_PREVIEW']);
  sourceSnapshot[0].style.bold = false;
  assert.equal(started.state.gesture.sourceSnapshot[0].style.bold, true);
  for (const type of ['POINTER_CANCEL', 'LOST_POINTER_CAPTURE', 'WINDOW_BLUR']) {
    const event = type === 'WINDOW_BLUR' ? { type } : { type, pointerId: 2 };
    const cancelled = reduceInteraction(started.state, event);
    assert.equal(cancelled.state.gesture.mode, 'idle');
    assert.equal(cancelled.effects.some(effect => effect.type === 'PREFLIGHT_COMMIT_FILL'), false);
    assert.equal(cancelled.effects.filter(effect => effect.type === 'CLEAR_FILL_PREVIEW').length, 1);
  }
});

test('U7 focus transfer/reference blur are non-terminal while genuine control blur commits once', () => {
  const edit = { gesture: { mode: 'idle' }, editSession: { origin: { row: 0, col: 0 }, draft: '=A1', caret: 3 } };
  assert.equal(reduceInteraction(edit, { type: 'FOCUS_TRANSFER', to: 'formula' }).state.editSession, edit.editSession);
  assert.equal(reduceInteraction(edit, { type: 'REFERENCE_BLUR' }).effects.length, 0);
  const blurred = reduceInteraction(edit, { type: 'CONTROL_BLUR' });
  assert.deepEqual(blurred.effects.map(effect => effect.type), ['COMMIT_EDIT']);
  assert.equal(reduceInteraction(blurred.state, { type: 'CONTROL_BLUR' }).effects.length, 0);
});

test('U7 sheet and workbook terminals cancel gestures before edit/switch effects', () => {
  const reference = {
    gesture: {
      mode: 'reference', pointerId: 8, beforeDraft: '=1', beforeSpan: null,
      anchor: { row: 1, col: 1 }, current: { row: 2, col: 2 }
    },
    editSession: { origin: { row: 0, col: 0 }, draft: '=1+B2:C3', trackedReferenceSpan: [3, 8] }
  };
  const sheet = reduceInteraction(reference, { type: 'SHEET_ACTIVATE', sheetId: 's2' });
  assert.deepEqual(sheet.effects.map(effect => effect.type), ['RELEASE_POINTER', 'RESTORE_REFERENCE_DRAFT', 'COMMIT_EDIT', 'ACTIVATE_SHEET']);
  assert.equal(sheet.effects[2].editSession.draft, '=1');
  const fill = {
    gesture: { mode: 'fill', pointerId: 2, anchor: { row: 0, col: 0 }, current: { row: 2, col: 0 }, direction: 'down' },
    editSession: { origin: { row: 0, col: 0 }, draft: '=A1' }
  };
  const workbook = reduceInteraction(fill, { type: 'WORKBOOK_REPLACE', workbook: { version: 4, sheets: [] } });
  assert.deepEqual(workbook.effects.map(effect => effect.type), [
    'RELEASE_POINTER', 'CANCEL_AUTOSCROLL', 'CLEAR_FILL_PREVIEW', 'CANCEL_EDIT', 'REPLACE_WORKBOOK'
  ]);
  assert.equal(workbook.effects.some(effect => effect.type === 'PREFLIGHT_COMMIT_FILL'), false);
});

test('U7 Escape cancels gesture then edit exactly once; Enter commits exactly once', () => {
  const state = {
    gesture: { mode: 'fill', pointerId: 3, anchor: { row: 0, col: 0 }, current: { row: 3, col: 0 }, direction: 'down' },
    editSession: { origin: { row: 0, col: 0 }, draft: '=A1' }
  };
  const escaped = reduceInteraction(state, { type: 'ESCAPE' });
  assert.equal(escaped.state.gesture.mode, 'idle');
  assert.equal(escaped.state.editSession, null);
  assert.deepEqual(escaped.effects.map(effect => effect.type), ['RELEASE_POINTER', 'CANCEL_AUTOSCROLL', 'CLEAR_FILL_PREVIEW', 'CANCEL_EDIT']);
  assert.equal(reduceInteraction(escaped.state, { type: 'ESCAPE' }).effects.length, 0);
  const edit = { gesture: { mode: 'idle' }, editSession: { origin: { row: 0, col: 0 }, draft: '=1' } };
  const entered = reduceInteraction(edit, { type: 'ENTER', navigate: { row: 1, col: 0 } });
  assert.deepEqual(entered.effects.map(effect => effect.type), ['COMMIT_EDIT', 'NAVIGATE']);
  assert.equal(reduceInteraction(entered.state, { type: 'ENTER' }).effects.length, 0);
});

test('U7 terminal precedence commits sheet once, cancels workbook, and suppresses post-window blur', () => {
  const edit = { gesture: { mode: 'idle' }, editSession: { origin: { row: 0, col: 0 }, draft: '=1' } };
  const sheet = reduceInteraction(edit, { type: 'SHEET_ACTIVATE', sheetId: 'next' });
  assert.deepEqual(sheet.effects.map(effect => effect.type), ['COMMIT_EDIT', 'ACTIVATE_SHEET']);
  assert.equal(reduceInteraction(sheet.state, { type: 'CONTROL_BLUR' }).effects.length, 0);
  const workbook = reduceInteraction(edit, { type: 'WORKBOOK_REPLACE', workbook: { sheets: [] } });
  assert.deepEqual(workbook.effects.map(effect => effect.type), ['CANCEL_EDIT', 'REPLACE_WORKBOOK']);
  const blurred = reduceInteraction(edit, { type: 'WINDOW_BLUR' });
  assert.ok(blurred.state.editSession);
  assert.equal(reduceInteraction(blurred.state, { type: 'CONTROL_BLUR' }).effects.length, 0);
  const focused = reduceInteraction(blurred.state, { type: 'WINDOW_FOCUS' });
  assert.equal(reduceInteraction(focused.state, { type: 'CONTROL_BLUR' }).effects[0].type, 'COMMIT_EDIT');
});

test('U7 fill keeps last client coordinate and remaps stationary-edge rAF frames', () => {
  let result = reduceInteraction(
    { gesture: { mode: 'idle' }, editSession: null },
    { type: 'POINTER_DOWN', intent: 'fill', pointerId: 5, cell: { row: 0, col: 0 }, clientX: 99, clientY: 99 }
  );
  const metrics = scrollTop => ({
    viewportRect: { left: 0, top: 0, right: 100, bottom: 100 },
    scrollLeft: 0,
    scrollTop,
    maxScrollLeft: 0,
    maxScrollTop: 500,
    rowHeight: 20,
    zoom: 1,
    columnOffsets: [0, 100],
    rows: 100,
    cols: 1
  });
  const rows = [];
  for (const scrollTop of [0, 20, 40]) {
    result = reduceInteraction(result.state, { type: 'AUTOSCROLL_FRAME', metrics: metrics(scrollTop) });
    rows.push(result.state.gesture.current.row);
    assert.equal(result.state.gesture.lastClientY, 99);
    assert.deepEqual(result.effects.slice(-2).map(effect => effect.type), ['SCROLL_BY', 'REQUEST_AUTOSCROLL_FRAME']);
  }
  assert.deepEqual(rows, [4, 5, 6]);
  result = reduceInteraction(result.state, { type: 'AUTOSCROLL_FRAME', metrics: metrics(500) });
  assert.equal(result.effects.at(-1).type, 'CANCEL_AUTOSCROLL');
});

test('U7 fill pointerup emits one preflight effect and cancel emits none', () => {
  const fill = {
    gesture: {
      mode: 'fill', pointerId: 1, anchor: { row: 0, col: 0 }, current: { row: 3, col: 0 }, direction: 'down', lastClientX: 0, lastClientY: 0
    },
    editSession: null
  };
  const complete = reduceInteraction(fill, { type: 'POINTER_UP', pointerId: 1 });
  assert.equal(complete.effects.filter(effect => effect.type === 'PREFLIGHT_COMMIT_FILL').length, 1);
  assert.equal(reduceInteraction(complete.state, { type: 'POINTER_UP', pointerId: 1 }).effects.length, 0);
  const cancel = reduceInteraction(fill, { type: 'LOST_POINTER_CAPTURE', pointerId: 1 });
  assert.equal(cancel.effects.some(effect => effect.type === 'PREFLIGHT_COMMIT_FILL'), false);
});
