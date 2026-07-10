export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
export const MAX_FILL_DESTINATIONS = 50_000;
export const DEFAULT_HISTORY_MAX_ACTIONS = 100;
export const DEFAULT_HISTORY_MAX_BYTES = 32 * 1024 * 1024;

export const ERROR_LITERALS = Object.freeze([
  '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#CYCLE!'
]);

const ERROR_SET = new Set(ERROR_LITERALS);
const IDENTIFIER_CHAR = /[A-Za-z0-9_.$\u0080-\uFFFF]/;
const TEXT_ENCODER = new TextEncoder();

export function columnName(index) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('invalid-column');
  let value = index + 1;
  let result = '';
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function columnIndex(name) {
  if (!/^[A-Za-z]+$/.test(String(name))) return -1;
  let value = 0;
  for (const character of String(name).toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function cloneStyle(style) {
  const result = {};
  for (const name of Object.keys(style || {}).sort()) result[name] = cloneValue(style[name]);
  return result;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const name of Object.keys(value)) result[name] = cloneValue(value[name]);
    return result;
  }
  return value;
}

function parseCellAt(source, start, { maxRows = EXCEL_MAX_ROWS, maxCols = EXCEL_MAX_COLS } = {}) {
  let position = start;
  let colAbsolute = false;
  let rowAbsolute = false;
  if (source[position] === '$') {
    colAbsolute = true;
    position += 1;
  }
  const columnStart = position;
  while (/[A-Za-z]/.test(source[position] || '') && position - columnStart < 4) position += 1;
  if (position === columnStart || /[A-Za-z]/.test(source[position] || '')) return null;
  if (source[position] === '$') {
    rowAbsolute = true;
    position += 1;
  }
  const rowStart = position;
  while (/\d/.test(source[position] || '')) position += 1;
  if (position === rowStart) return null;
  // The column ends before an optional row '$'; derive it directly to avoid ambiguity.
  const rawColumn = source.slice(columnStart, rowAbsolute ? rowStart - 1 : rowStart);
  const resolvedCol = columnIndex(rawColumn);
  const row = Number(source.slice(rowStart, position)) - 1;
  if (resolvedCol < 0 || resolvedCol >= maxCols || row < 0 || row >= maxRows) return null;
  return {
    start,
    end: position,
    row,
    col: resolvedCol,
    rowAbsolute,
    colAbsolute
  };
}

function parseSheetQualifierAt(source, start) {
  if (source[start] === "'") {
    let position = start + 1;
    let name = '';
    while (position < source.length) {
      if (source[position] === "'") {
        if (source[position + 1] === "'") {
          name += "'";
          position += 2;
          continue;
        }
        if (source[position + 1] !== '!') return null;
        return {
          raw: source.slice(start, position + 2),
          name,
          quoted: true,
          end: position + 2
        };
      }
      name += source[position];
      position += 1;
    }
    return null;
  }
  const match = source.slice(start).match(/^([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_.\u0080-\uFFFF]*)!/u);
  if (!match) return null;
  return { raw: match[0], name: match[1], quoted: false, end: start + match[0].length };
}

export function parseA1Reference(source, options = {}) {
  const text = String(source);
  let position = 0;
  const sheet = parseSheetQualifierAt(text, position);
  if (sheet) position = sheet.end;
  const first = parseCellAt(text, position, options);
  if (!first) return null;
  position = first.end;
  let second = null;
  if (text[position] === ':') {
    second = parseCellAt(text, position + 1, options);
    if (!second) return null;
    position = second.end;
  }
  if (position !== text.length) return null;
  return {
    type: 'REFERENCE',
    kind: second ? 'range' : 'cell',
    start: 0,
    end: text.length,
    text,
    sheet: sheet ? { raw: sheet.raw, name: sheet.name, quoted: sheet.quoted } : null,
    first: stripCellSpan(first),
    second: second ? stripCellSpan(second) : null
  };
}

function stripCellSpan(cell) {
  return {
    row: cell.row,
    col: cell.col,
    rowAbsolute: cell.rowAbsolute,
    colAbsolute: cell.colAbsolute
  };
}

export function formatA1Cell(cell) {
  if (!cell || !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 0 || cell.col < 0) {
    throw new RangeError('invalid-cell');
  }
  return `${cell.colAbsolute ? '$' : ''}${columnName(cell.col)}${cell.rowAbsolute ? '$' : ''}${cell.row + 1}`;
}

export function formatA1Reference(reference) {
  if (!reference || reference.type !== 'REFERENCE') throw new TypeError('invalid-reference');
  const qualifier = reference.sheet?.raw || '';
  const first = formatA1Cell(reference.first);
  return qualifier + first + (reference.second ? `:${formatA1Cell(reference.second)}` : '');
}

function canStartReference(source, index) {
  if (index === 0) return true;
  return !IDENTIFIER_CHAR.test(source[index - 1]);
}

function hasReferenceBoundary(source, end) {
  const next = source[end] || '';
  return !next || !IDENTIFIER_CHAR.test(next);
}

function parseReferenceAt(source, start, options) {
  if (!canStartReference(source, start)) return null;
  let position = start;
  const sheet = parseSheetQualifierAt(source, start);
  if (sheet) position = sheet.end;
  const first = parseCellAt(source, position, options);
  if (!first) return null;
  position = first.end;
  let second = null;
  if (source[position] === ':') {
    second = parseCellAt(source, position + 1, options);
    if (!second) return null;
    position = second.end;
  }
  if (!hasReferenceBoundary(source, position) || source[position] === '(') return null;
  const text = source.slice(start, position);
  return {
    type: 'REFERENCE',
    kind: second ? 'range' : 'cell',
    start,
    end: position,
    text,
    sheet: sheet ? { raw: sheet.raw, name: sheet.name, quoted: sheet.quoted } : null,
    first: stripCellSpan(first),
    second: second ? stripCellSpan(second) : null
  };
}

export function scanFormula(source, options = {}) {
  const text = String(source);
  const tokens = [];
  let position = 0;
  while (position < text.length) {
    if (text[position] === '"') {
      const start = position++;
      while (position < text.length) {
        if (text[position] === '"') {
          if (text[position + 1] === '"') {
            position += 2;
            continue;
          }
          position += 1;
          break;
        }
        position += 1;
      }
      tokens.push({ type: 'STRING', start, end: position, text: text.slice(start, position) });
      continue;
    }
    const error = ERROR_LITERALS.find(literal => text.startsWith(literal, position));
    if (error && canStartReference(text, position)) {
      tokens.push({ type: 'ERROR', value: error, start: position, end: position + error.length, text: error });
      position += error.length;
      continue;
    }
    const reference = parseReferenceAt(text, position, options);
    if (reference) {
      tokens.push(reference);
      position = reference.end;
      continue;
    }
    position += 1;
  }
  return tokens;
}

export function buildReferenceText(anchor, focus = anchor, insertionStart = 0) {
  const first = {
    row: Math.min(anchor.row, focus.row),
    col: Math.min(anchor.col, focus.col),
    rowAbsolute: false,
    colAbsolute: false
  };
  const second = {
    row: Math.max(anchor.row, focus.row),
    col: Math.max(anchor.col, focus.col),
    rowAbsolute: false,
    colAbsolute: false
  };
  const text = formatA1Cell(first) + (first.row === second.row && first.col === second.col ? '' : `:${formatA1Cell(second)}`);
  return { text, span: [insertionStart, insertionStart + text.length] };
}

export function insertReferenceDraft(draft, replaceSpan, anchor, focus = anchor) {
  const source = String(draft);
  const start = Math.max(0, Math.min(source.length, replaceSpan?.[0] ?? source.length));
  const end = Math.max(start, Math.min(source.length, replaceSpan?.[1] ?? start));
  const built = buildReferenceText(anchor, focus, start);
  return {
    draft: source.slice(0, start) + built.text + source.slice(end),
    span: built.span,
    caret: built.span[1]
  };
}

function absoluteMode(cell) {
  if (cell.colAbsolute && cell.rowAbsolute) return 1;
  if (!cell.colAbsolute && cell.rowAbsolute) return 2;
  if (cell.colAbsolute && !cell.rowAbsolute) return 3;
  return 0;
}

function withAbsoluteMode(cell, mode) {
  return {
    ...cell,
    colAbsolute: mode === 1 || mode === 3,
    rowAbsolute: mode === 1 || mode === 2
  };
}

export function cycleAbsoluteReference(reference) {
  const nextMode = (absoluteMode(reference.first) + 1) % 4;
  return {
    ...reference,
    first: withAbsoluteMode(reference.first, nextMode),
    second: reference.second ? withAbsoluteMode(reference.second, nextMode) : null
  };
}

function tokenForCaret(tokens, caret) {
  return tokens.find(token => token.type === 'REFERENCE' && (
    (token.start <= caret && caret < token.end) || caret === token.end
  ));
}

export function toggleReferenceAtCaret(draft, caret, trackedSpan = null, options = {}) {
  const source = String(draft);
  let token = null;
  if (trackedSpan && trackedSpan.length === 2) {
    const start = trackedSpan[0];
    const end = trackedSpan[1];
    const parsed = parseA1Reference(source.slice(start, end), options);
    if (parsed) token = { ...parsed, start, end, text: source.slice(start, end) };
  }
  if (!token) token = tokenForCaret(scanFormula(source, options), caret);
  if (!token) return { draft: source, caret, span: trackedSpan, changed: false, token: null };
  const replacement = formatA1Reference(cycleAbsoluteReference(token));
  const nextDraft = source.slice(0, token.start) + replacement + source.slice(token.end);
  const span = [token.start, token.start + replacement.length];
  return { draft: nextDraft, caret: span[1], span, changed: true, token };
}

function translatedCell(cell, rowDelta, colDelta, maxRows, maxCols) {
  const row = cell.row + (cell.rowAbsolute ? 0 : rowDelta);
  const col = cell.col + (cell.colAbsolute ? 0 : colDelta);
  if (row < 0 || col < 0 || row >= maxRows || col >= maxCols) return null;
  return { ...cell, row, col };
}

export function translateFormulaReferences(source, rowDelta, colDelta, options = {}) {
  const text = String(source);
  const maxRows = options.maxRows ?? EXCEL_MAX_ROWS;
  const maxCols = options.maxCols ?? EXCEL_MAX_COLS;
  // Qualified references are validated against Excel's language bounds because
  // the referenced sheet may be wider/taller than the fill source sheet.
  const references = scanFormula(text).filter(token => token.type === 'REFERENCE');
  let result = '';
  let position = 0;
  for (const reference of references) {
    result += text.slice(position, reference.start);
    const referenceMaxRows = reference.sheet ? EXCEL_MAX_ROWS : maxRows;
    const referenceMaxCols = reference.sheet ? EXCEL_MAX_COLS : maxCols;
    const first = translatedCell(reference.first, rowDelta, colDelta, referenceMaxRows, referenceMaxCols);
    const second = reference.second ? translatedCell(reference.second, rowDelta, colDelta, referenceMaxRows, referenceMaxCols) : null;
    result += !first || (reference.second && !second)
      ? '#REF!'
      : formatA1Reference({ ...reference, first, second });
    position = reference.end;
  }
  return result + text.slice(position);
}

export function isSpreadsheetError(value) {
  return typeof value === 'string' && ERROR_SET.has(value);
}

export function firstConsumedError(values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstConsumedError(value);
      if (nested) return nested;
    } else if (isSpreadsheetError(value)) return value;
  }
  return null;
}

export function evaluateStrictArguments(values, evaluator) {
  const resolved = values.map(value => typeof value === 'function' ? value() : value);
  const error = firstConsumedError(resolved);
  return error || evaluator(resolved);
}

export function evaluateStrictUnary(value, evaluator) {
  const resolved = typeof value === 'function' ? value() : value;
  return isSpreadsheetError(resolved) ? resolved : evaluator(resolved);
}

export function evaluateStrictBinary(left, right, evaluator) {
  const resolvedLeft = typeof left === 'function' ? left() : left;
  if (isSpreadsheetError(resolvedLeft)) return resolvedLeft;
  const resolvedRight = typeof right === 'function' ? right() : right;
  if (isSpreadsheetError(resolvedRight)) return resolvedRight;
  return evaluator(resolvedLeft, resolvedRight);
}

export function spreadsheetTruthy(value) {
  if (isSpreadsheetError(value)) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    if (/^FALSE$/i.test(value)) return false;
    if (/^TRUE$/i.test(value)) return true;
    const number = value.trim() === '' ? NaN : Number(value.replace(/,/g, ''));
    return Number.isNaN(number) ? value.length > 0 : number !== 0;
  }
  return Boolean(value);
}

export function evaluateLazyIf(condition, whenTrue, whenFalse = false) {
  const resolvedCondition = typeof condition === 'function' ? condition() : condition;
  if (isSpreadsheetError(resolvedCondition)) return resolvedCondition;
  const branch = spreadsheetTruthy(resolvedCondition) ? whenTrue : whenFalse;
  return typeof branch === 'function' ? branch() : branch;
}

function mapHas(cellMap, key) {
  return cellMap instanceof Map ? cellMap.has(key) : Object.prototype.hasOwnProperty.call(cellMap, key);
}

function mapGet(cellMap, key) {
  return cellMap instanceof Map ? cellMap.get(key) : cellMap[key];
}

function mapSet(cellMap, key, value) {
  if (cellMap instanceof Map) cellMap.set(key, value);
  else cellMap[key] = value;
}

function mapDelete(cellMap, key) {
  if (cellMap instanceof Map) cellMap.delete(key);
  else delete cellMap[key];
}

export function snapshotSparseCell(cellMap, key) {
  if (!mapHas(cellMap, key)) return { existed: false, v: '', style: {} };
  const cell = mapGet(cellMap, key) || {};
  return { existed: true, v: cell.v ?? '', style: cloneStyle(cell.style) };
}

export function applySparseSnapshot(cellMap, key, snapshot) {
  if (!snapshot?.existed) {
    mapDelete(cellMap, key);
    return;
  }
  mapSet(cellMap, key, { v: snapshot.v ?? '', style: cloneStyle(snapshot.style) });
}

export function rollbackSparseEntries(cellMap, appliedEntries, side) {
  const rollbackSide = side === 'after' ? 'before' : 'after';
  for (let index = appliedEntries.length - 1; index >= 0; index -= 1) {
    const entry = appliedEntries[index];
    applySparseSnapshot(cellMap, entry.key ?? `${entry.r},${entry.c}`, entry[rollbackSide]);
  }
}

export function applySparseEntries(cellMap, entries, side) {
  if (side !== 'before' && side !== 'after') throw new TypeError('invalid-snapshot-side');
  const applied = [];
  let currentEntry = null;
  try {
    for (const entry of entries) {
      currentEntry = entry;
      applySparseSnapshot(cellMap, entry.key ?? `${entry.r},${entry.c}`, entry[side]);
      applied.push(entry);
      currentEntry = null;
    }
    return applied;
  } catch (error) {
    if (currentEntry) {
      applySparseSnapshot(
        cellMap,
        currentEntry.key ?? `${currentEntry.r},${currentEntry.c}`,
        currentEntry[side === 'after' ? 'before' : 'after']
      );
    }
    rollbackSparseEntries(cellMap, applied, side);
    throw error;
  }
}

function equalValue(left, right) {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

function canonicalSnapshot(snapshot) {
  return {
    existed: Boolean(snapshot?.existed),
    v: snapshot?.v ?? '',
    style: cloneStyle(snapshot?.style)
  };
}

function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const name of Object.keys(value).sort()) result[name] = canonicalizeValue(value[name]);
    return result;
  }
  return value;
}

export function canonicalizeHistoryAction(action) {
  if (!action || typeof action !== 'object') throw new TypeError('invalid-history-action');
  if (action.type === 'fill') {
    const entries = (action.entries || [])
      .map(entry => ({
        r: Number(entry.r),
        c: Number(entry.c),
        before: canonicalSnapshot(entry.before),
        after: canonicalSnapshot(entry.after)
      }))
      .filter(entry => !equalValue(entry.before, entry.after))
      .sort((left, right) => left.r - right.r || left.c - right.c);
    const result = { type: 'fill' };
    if (action.sheetId !== undefined) result.sheetId = action.sheetId;
    result.entries = entries;
    return result;
  }
  return canonicalizeValue(action);
}

export function encodedHistoryBytes(action) {
  return TEXT_ENCODER.encode(JSON.stringify(canonicalizeHistoryAction(action))).byteLength;
}

export function preflightHistoryCommit({
  history,
  historyIndex,
  totalBytes: _totalBytes,
  action,
  maxActions = DEFAULT_HISTORY_MAX_ACTIONS,
  maxBytes = DEFAULT_HISTORY_MAX_BYTES
}) {
  const originalHistory = Array.isArray(history) ? history : [];
  const originalIndex = Number.isInteger(historyIndex) ? historyIndex : originalHistory.length - 1;
  if (!action) return {
    accepted: false,
    reason: 'no-op',
    nextHistory: originalHistory,
    nextIndex: originalIndex,
    nextBytes: originalHistory.reduce((sum, item) => sum + encodedHistoryBytes(item), 0)
  };
  const canonicalAction = canonicalizeHistoryAction(action);
  if (canonicalAction.type === 'fill' && canonicalAction.entries.length === 0) return {
    accepted: false,
    reason: 'no-op',
    nextHistory: originalHistory,
    nextIndex: originalIndex,
    nextBytes: originalHistory.reduce((sum, item) => sum + encodedHistoryBytes(item), 0)
  };
  const actionBytes = encodedHistoryBytes(canonicalAction);
  const currentBytes = originalHistory.reduce((sum, item) => sum + encodedHistoryBytes(item), 0);
  if (actionBytes > maxBytes) return {
    accepted: false,
    reason: 'action-too-large',
    nextHistory: originalHistory,
    nextIndex: originalIndex,
    nextBytes: currentBytes
  };
  const nextHistory = originalHistory.slice(0, Math.max(-1, originalIndex) + 1).map(canonicalizeHistoryAction);
  nextHistory.push(canonicalAction);
  let nextBytes = nextHistory.reduce((sum, item) => sum + encodedHistoryBytes(item), 0);
  while (nextHistory.length > maxActions || nextBytes > maxBytes) {
    nextBytes -= encodedHistoryBytes(nextHistory.shift());
  }
  return {
    accepted: true,
    reason: null,
    action: canonicalAction,
    actionBytes,
    nextHistory,
    nextIndex: nextHistory.length - 1,
    nextBytes
  };
}

function normalizeRect(rect) {
  return {
    r1: Math.min(rect.r1, rect.r2),
    c1: Math.min(rect.c1, rect.c2),
    r2: Math.max(rect.r1, rect.r2),
    c2: Math.max(rect.c1, rect.c2)
  };
}

function modulo(value, length) {
  return ((value % length) + length) % length;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniformStep(values) {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  for (let index = 2; index < values.length; index += 1) {
    const candidate = values[index] - values[index - 1];
    if (Math.abs(candidate - step) > 1e-12 * Math.max(1, Math.abs(candidate), Math.abs(step))) return null;
  }
  return step;
}

function parseIsoDay(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return timestamp / 86_400_000;
}

function formatIsoDay(epochDay) {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

function parseTextNumber(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(.*?)(-?\d+)$/);
  if (!match) return null;
  const signed = match[2];
  const digits = signed.startsWith('-') ? signed.slice(1) : signed;
  return { prefix: match[1], value: BigInt(signed), width: digits.length };
}

export function classifyFillLane(sourceSnapshots) {
  const values = sourceSnapshots.map(snapshot => snapshot.v ?? '');
  if (values.length < 2 || values.some(value => typeof value === 'string' && value.startsWith('='))) return { type: 'repeat' };
  const numbers = values.map(finiteNumber);
  if (numbers.every(value => value !== null)) {
    const step = uniformStep(numbers);
    if (step !== null) return { type: 'number', first: numbers[0], step };
  }
  const days = values.map(parseIsoDay);
  const hasIsoShape = values.some(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (days.every(value => value !== null)) {
    const step = uniformStep(days);
    if (step !== null) return { type: 'date', first: days[0], step };
  }
  if (hasIsoShape) return { type: 'repeat' };
  const textNumbers = values.map(parseTextNumber);
  if (textNumbers.every(value => value !== null) && textNumbers.every(value => value.prefix === textNumbers[0].prefix)) {
    const numericValues = textNumbers.map(value => value.value);
    const step = numericValues[1] - numericValues[0];
    if (numericValues.slice(2).every((value, index) => value - numericValues[index + 1] === step)) {
      return {
        type: 'text-number',
        prefix: textNumbers[0].prefix,
        first: textNumbers[0].value,
        step,
        width: Math.max(...textNumbers.map(value => value.width))
      };
    }
  }
  return { type: 'repeat' };
}

export function generateFillLaneValue(classification, logicalIndex) {
  if (classification.type === 'number') return String(classification.first + classification.step * logicalIndex);
  if (classification.type === 'date') return formatIsoDay(classification.first + classification.step * logicalIndex);
  if (classification.type === 'text-number') {
    const value = classification.first + classification.step * BigInt(logicalIndex);
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(classification.width, '0');
    return `${classification.prefix}${negative ? '-' : ''}${digits}`;
  }
  throw new TypeError('repeat-lanes-have-no-generated-value');
}

function fillDirection(source, destination) {
  if (destination.r2 < source.r1) return 'up';
  if (destination.r1 > source.r2) return 'down';
  if (destination.c2 < source.c1) return 'left';
  if (destination.c1 > source.c2) return 'right';
  const vertical = Math.max(source.r1 - destination.r1, destination.r2 - source.r2, 0);
  const horizontal = Math.max(source.c1 - destination.c1, destination.c2 - source.c2, 0);
  return vertical >= horizontal
    ? (destination.r1 < source.r1 ? 'up' : 'down')
    : (destination.c1 < source.c1 ? 'left' : 'right');
}

function sourceCellForDestination(source, destinationCell, direction) {
  const vertical = direction === 'up' || direction === 'down';
  const laneLength = vertical ? source.r2 - source.r1 + 1 : source.c2 - source.c1 + 1;
  const logicalIndex = vertical
    ? destinationCell.r - source.r1
    : destinationCell.c - source.c1;
  const sourceIndex = modulo(logicalIndex, laneLength);
  const sourceRow = vertical ? source.r1 + sourceIndex : source.r1 + modulo(destinationCell.r - source.r1, source.r2 - source.r1 + 1);
  const sourceCol = vertical ? source.c1 + modulo(destinationCell.c - source.c1, source.c2 - source.c1 + 1) : source.c1 + sourceIndex;
  return { row: sourceRow, col: sourceCol, logicalIndex, sourceIndex };
}

function laneSnapshots(cellMap, source, destinationCell, direction) {
  const vertical = direction === 'up' || direction === 'down';
  const snapshots = [];
  if (vertical) {
    const col = source.c1 + modulo(destinationCell.c - source.c1, source.c2 - source.c1 + 1);
    for (let row = source.r1; row <= source.r2; row += 1) snapshots.push(snapshotSparseCell(cellMap, `${row},${col}`));
  } else {
    const row = source.r1 + modulo(destinationCell.r - source.r1, source.r2 - source.r1 + 1);
    for (let col = source.c1; col <= source.c2; col += 1) snapshots.push(snapshotSparseCell(cellMap, `${row},${col}`));
  }
  return snapshots;
}

export function planFill({
  cellMap,
  sourceCellMap = cellMap,
  sourceRect,
  destinationRect,
  maxDestinations = MAX_FILL_DESTINATIONS,
  maxRows = EXCEL_MAX_ROWS,
  maxCols = EXCEL_MAX_COLS
}) {
  const source = normalizeRect(sourceRect);
  const destination = normalizeRect(destinationRect);
  const targets = [];
  for (let row = destination.r1; row <= destination.r2; row += 1) {
    for (let col = destination.c1; col <= destination.c2; col += 1) {
      if (row < 0 || col < 0 || row >= maxRows || col >= maxCols) continue;
      if (row >= source.r1 && row <= source.r2 && col >= source.c1 && col <= source.c2) continue;
      targets.push({ r: row, c: col });
      if (targets.length > maxDestinations) return { accepted: false, reason: 'destination-limit', entries: [] };
    }
  }
  if (!targets.length) return { accepted: true, reason: 'no-op', entries: [], direction: null };
  const direction = fillDirection(source, destination);
  const laneCache = new Map();
  const entries = [];
  for (const target of targets) {
    const mapped = sourceCellForDestination(source, target, direction);
    const vertical = direction === 'up' || direction === 'down';
    const laneKey = vertical ? `c:${mapped.col}` : `r:${mapped.row}`;
    if (!laneCache.has(laneKey)) {
      const snapshots = laneSnapshots(sourceCellMap, source, target, direction);
      laneCache.set(laneKey, { snapshots, classification: classifyFillLane(snapshots) });
    }
    const lane = laneCache.get(laneKey);
    const sourceSnapshot = lane.snapshots[mapped.sourceIndex];
    let after;
    if (lane.classification.type !== 'repeat') {
      after = {
        existed: true,
        v: generateFillLaneValue(lane.classification, mapped.logicalIndex),
        style: cloneStyle(sourceSnapshot.style)
      };
    } else if (typeof sourceSnapshot.v === 'string' && sourceSnapshot.v.startsWith('=')) {
      after = {
        existed: sourceSnapshot.existed,
        v: translateFormulaReferences(sourceSnapshot.v, target.r - mapped.row, target.c - mapped.col, { maxRows, maxCols }),
        style: cloneStyle(sourceSnapshot.style)
      };
    } else {
      after = canonicalSnapshot(sourceSnapshot);
    }
    const before = snapshotSparseCell(cellMap, `${target.r},${target.c}`);
    if (!equalValue(before, after)) entries.push({ r: target.r, c: target.c, before, after });
  }
  entries.sort((left, right) => left.r - right.r || left.c - right.c);
  return {
    accepted: true,
    reason: entries.length ? null : 'no-op',
    direction,
    sourceRect: source,
    destinationRect: destination,
    entries
  };
}

function binaryColumn(offsets, value) {
  let low = 0;
  let high = offsets.length - 2;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (value < offsets[middle]) high = middle - 1;
    else if (value >= offsets[middle + 1]) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}

export function pointerToCell({
  clientX,
  clientY,
  viewportRect,
  scrollLeft = 0,
  scrollTop = 0,
  rowHeight = 28,
  zoom = 1,
  columnOffsets,
  rows,
  cols
}) {
  const offsets = columnOffsets;
  if (!Array.isArray(offsets) || offsets.length < 2) throw new TypeError('columnOffsets-required');
  const x = clientX - viewportRect.left + scrollLeft;
  const y = clientY - viewportRect.top + scrollTop;
  const row = Math.max(0, Math.min(rows - 1, Math.floor(y / (rowHeight * zoom))));
  const col = Math.max(0, Math.min(cols - 1, binaryColumn(offsets, x)));
  return { row, col };
}

export function resolveDominantAxis(anchor, current, threshold = 0) {
  const deltaRow = current.row - anchor.row;
  const deltaCol = current.col - anchor.col;
  if (Math.max(Math.abs(deltaRow), Math.abs(deltaCol)) <= threshold) return null;
  if (Math.abs(deltaCol) > Math.abs(deltaRow)) return deltaCol < 0 ? 'left' : 'right';
  return deltaRow < 0 ? 'up' : 'down';
}

export function edgeAutoscroll({
  clientX,
  clientY,
  viewportRect,
  zone = 36,
  maxSpeed = 24,
  scrollLeft = 0,
  scrollTop = 0,
  maxScrollLeft = Infinity,
  maxScrollTop = Infinity
}) {
  const speed = (distance, sign) => sign * Math.ceil(maxSpeed * Math.min(1, Math.max(0, distance) / zone));
  let dx = 0;
  let dy = 0;
  if (clientX < viewportRect.left + zone) dx = speed(viewportRect.left + zone - clientX, -1);
  else if (clientX > viewportRect.right - zone) dx = speed(clientX - (viewportRect.right - zone), 1);
  if (clientY < viewportRect.top + zone) dy = speed(viewportRect.top + zone - clientY, -1);
  else if (clientY > viewportRect.bottom - zone) dy = speed(clientY - (viewportRect.bottom - zone), 1);
  if ((dx < 0 && scrollLeft <= 0) || (dx > 0 && scrollLeft >= maxScrollLeft)) dx = 0;
  if ((dy < 0 && scrollTop <= 0) || (dy > 0 && scrollTop >= maxScrollTop)) dy = 0;
  return { dx, dy, active: dx !== 0 || dy !== 0 };
}

function idleGesture() {
  return { mode: 'idle' };
}

function currentGesture(state) {
  return state.gesture || idleGesture();
}

function formulaEdit(state) {
  return state.editSession && String(state.editSession.draft || '').startsWith('=');
}

function withGestureCancelled(state, reason) {
  const gesture = currentGesture(state);
  if (gesture.mode === 'idle') return { state, effects: [] };
  const effects = [];
  if (gesture.pointerId !== undefined) effects.push({ type: 'RELEASE_POINTER', pointerId: gesture.pointerId, owner: gesture.captureOwner });
  if (gesture.mode === 'fill') effects.push({ type: 'CANCEL_AUTOSCROLL' }, { type: 'CLEAR_FILL_PREVIEW' });
  if (gesture.mode === 'reference') effects.push({ type: 'RESTORE_REFERENCE_DRAFT', draft: gesture.beforeDraft, span: gesture.beforeSpan ?? null });
  if (gesture.mode === 'resize') effects.push({ type: 'RESTORE_RESIZE', sheetId: gesture.sheetId, column: gesture.column, width: gesture.startWidth });
  const editSession = gesture.mode === 'reference' && state.editSession
    ? { ...state.editSession, draft: gesture.beforeDraft, trackedReferenceSpan: gesture.beforeSpan ?? null }
    : state.editSession;
  return {
    state: { ...state, editSession, gesture: idleGesture() },
    effects: effects.map(effect => ({ ...effect, reason }))
  };
}

function remapFill(state, event) {
  const gesture = currentGesture(state);
  const clientX = event.clientX ?? gesture.lastClientX;
  const clientY = event.clientY ?? gesture.lastClientY;
  let cell = event.cell;
  if (!cell && event.metrics) cell = pointerToCell({ clientX, clientY, ...event.metrics });
  if (!cell) return { state, effects: [] };
  const direction = resolveDominantAxis(gesture.anchor, cell, event.threshold ?? gesture.threshold ?? 0);
  const nextGesture = { ...gesture, current: cell, direction, lastClientX: clientX, lastClientY: clientY };
  const effects = [{ type: 'UPDATE_FILL_PREVIEW', anchor: gesture.anchor, target: cell, direction }];
  if (event.metrics) {
    const scroll = edgeAutoscroll({ clientX, clientY, ...event.metrics });
    if (scroll.active) effects.push({ type: 'SCROLL_BY', dx: scroll.dx, dy: scroll.dy }, { type: 'REQUEST_AUTOSCROLL_FRAME' });
    else effects.push({ type: 'CANCEL_AUTOSCROLL' });
  }
  return { state: { ...state, gesture: nextGesture }, effects };
}

export function reduceInteraction(inputState, event) {
  const state = { ...inputState, gesture: currentGesture(inputState) };
  const gesture = state.gesture;
  const type = event.type;

  if (type === 'POINTER_DOWN') {
    if (gesture.mode !== 'idle') return { state: inputState, effects: [] };
    const intent = event.intent || 'select';
    if (!['select', 'reference', 'fill', 'resize'].includes(intent)) return { state: inputState, effects: [] };
    if (intent === 'reference' && !formulaEdit(state)) return { state: inputState, effects: [] };
    if (intent !== 'reference' && state.editSession) return { state: inputState, effects: [] };
    const nextGesture = {
      mode: intent,
      pointerId: event.pointerId,
      anchor: event.cell,
      current: event.cell,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      extend: Boolean(event.extend),
      captureOwner: event.captureOwner || 'grid'
    };
    const effects = [{ type: 'CAPTURE_POINTER', pointerId: event.pointerId, owner: nextGesture.captureOwner }];
    if (intent === 'select') effects.push(
      { type: 'FOCUS_VIEWPORT' },
      { type: 'UPDATE_SELECTION', anchor: event.anchor || event.cell, target: event.cell, active: event.cell, extend: Boolean(event.extend) }
    );
    if (intent === 'reference') {
      const caret = event.caret ?? state.editSession.caret ?? state.editSession.draft.length;
      const replaceSpan = state.editSession.trackedReferenceSpan || [caret, caret];
      const insertion = insertReferenceDraft(state.editSession.draft, replaceSpan, event.cell);
      nextGesture.beforeDraft = state.editSession.draft;
      nextGesture.beforeSpan = state.editSession.trackedReferenceSpan ?? null;
      nextGesture.replaceStart = insertion.span[0];
      effects.push({ type: 'UPDATE_DRAFT', ...insertion });
      return {
        state: {
          ...state,
          editSession: { ...state.editSession, draft: insertion.draft, caret: insertion.caret, trackedReferenceSpan: insertion.span },
          gesture: nextGesture
        },
        effects
      };
    }
    if (intent === 'fill') effects.push(
      { type: 'SNAPSHOT_FILL_SOURCE', sourceRect: event.sourceRect, snapshot: event.sourceSnapshot },
      { type: 'UPDATE_FILL_PREVIEW', anchor: event.cell, target: event.cell, direction: null }
    );
    if (intent === 'fill') {
      nextGesture.sourceRect = event.sourceRect;
      nextGesture.sourceSnapshot = cloneValue(event.sourceSnapshot);
      nextGesture.sheetId = event.sheetId;
    }
    if (intent === 'resize') {
      nextGesture.column = event.column;
      nextGesture.startWidth = event.startWidth;
      nextGesture.startClientX = event.clientX;
      nextGesture.sheetId = event.sheetId;
    }
    return { state: { ...state, gesture: nextGesture }, effects };
  }

  if (type === 'POINTER_MOVE') {
    if (gesture.mode === 'idle' || event.pointerId !== gesture.pointerId) return { state: inputState, effects: [] };
    if (gesture.mode === 'select') return {
      state: { ...state, gesture: { ...gesture, current: event.cell } },
      effects: [{ type: 'UPDATE_SELECTION', anchor: gesture.anchor, target: event.cell, extend: gesture.extend }]
    };
    if (gesture.mode === 'reference') {
      const insertion = insertReferenceDraft(
        state.editSession.draft,
        state.editSession.trackedReferenceSpan,
        gesture.anchor,
        event.cell
      );
      return {
        state: {
          ...state,
          editSession: { ...state.editSession, draft: insertion.draft, caret: insertion.caret, trackedReferenceSpan: insertion.span },
          gesture: { ...gesture, current: event.cell, lastClientX: event.clientX, lastClientY: event.clientY }
        },
        effects: [{ type: 'UPDATE_DRAFT', ...insertion }, { type: 'FOCUS_CARET', caret: insertion.caret }]
      };
    }
    if (gesture.mode === 'fill') return remapFill(state, event);
    if (gesture.mode === 'resize') return {
      state,
      effects: [{ type: 'UPDATE_RESIZE', sheetId: gesture.sheetId, column: gesture.column, width: event.width }]
    };
  }

  if (type === 'AUTOSCROLL_FRAME') {
    if (gesture.mode !== 'fill' || gesture.lastClientX === undefined || gesture.lastClientY === undefined) return { state: inputState, effects: [] };
    return remapFill(state, event);
  }

  if (type === 'POINTER_UP') {
    if (gesture.mode === 'idle' || event.pointerId !== gesture.pointerId) return { state: inputState, effects: [] };
    const effects = [{ type: 'RELEASE_POINTER', pointerId: gesture.pointerId, owner: gesture.captureOwner }];
    if (gesture.mode === 'reference') effects.push({ type: 'FOCUS_CARET', caret: state.editSession?.caret });
    if (gesture.mode === 'fill') {
      effects.push({ type: 'CANCEL_AUTOSCROLL' }, { type: 'CLEAR_FILL_PREVIEW' });
      if (gesture.direction) effects.push({
        type: 'PREFLIGHT_COMMIT_FILL',
        anchor: gesture.anchor,
        target: gesture.current,
        direction: gesture.direction,
        sheetId: gesture.sheetId,
        sourceRect: gesture.sourceRect,
        sourceSnapshot: cloneValue(gesture.sourceSnapshot)
      });
    }
    return { state: { ...state, gesture: idleGesture() }, effects };
  }

  if (type === 'POINTER_CANCEL' || type === 'LOST_POINTER_CAPTURE') {
    if (gesture.mode === 'idle' || (event.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return { state: inputState, effects: [] };
    const cancelled = withGestureCancelled(state, type);
    if (gesture.mode === 'reference' && state.editSession) {
      cancelled.state = {
        ...cancelled.state,
        editSession: { ...state.editSession, draft: gesture.beforeDraft, trackedReferenceSpan: gesture.beforeSpan ?? null }
      };
    }
    return cancelled;
  }

  if (type === 'ESCAPE') {
    let result = withGestureCancelled(state, 'escape');
    const nextEdit = result.state.editSession;
    if (!nextEdit) return result;
    return {
      state: { ...result.state, editSession: null },
      effects: [...result.effects, { type: 'CANCEL_EDIT', reason: 'escape', origin: nextEdit.origin }]
    };
  }

  if (type === 'ENTER') {
    if (gesture.mode !== 'idle' || !state.editSession) return { state: inputState, effects: [] };
    return {
      state: { ...state, editSession: null },
      effects: [{ type: 'COMMIT_EDIT', reason: 'enter', editSession: state.editSession }, ...(event.navigate ? [{ type: 'NAVIGATE', ...event.navigate }] : [])]
    };
  }

  if (type === 'REFERENCE_BLUR' || type === 'FOCUS_TRANSFER') return { state: inputState, effects: [] };

  if (type === 'CONTROL_BLUR') {
    if (gesture.mode !== 'idle' || !state.editSession || state.blurGuard === 'window') return { state: inputState, effects: [] };
    return { state: { ...state, editSession: null }, effects: [{ type: 'COMMIT_EDIT', reason: 'control-blur', editSession: state.editSession }] };
  }

  if (type === 'WINDOW_BLUR') {
    const result = withGestureCancelled(state, 'window-blur');
    return { state: { ...result.state, blurGuard: 'window' }, effects: result.effects };
  }

  if (type === 'WINDOW_FOCUS') return { state: { ...state, blurGuard: null }, effects: [] };

  if (type === 'SHEET_ACTIVATE') {
    const result = withGestureCancelled(state, 'sheet-activate');
    const effects = [...result.effects];
    if (result.state.editSession) effects.push({ type: 'COMMIT_EDIT', reason: 'sheet-activate', editSession: result.state.editSession });
    effects.push({ type: 'ACTIVATE_SHEET', sheetId: event.sheetId });
    return { state: { ...result.state, editSession: null }, effects };
  }

  if (type === 'WORKBOOK_REPLACE') {
    const result = withGestureCancelled(state, 'workbook-replace');
    const effects = [...result.effects];
    if (result.state.editSession) effects.push({ type: 'CANCEL_EDIT', reason: 'workbook-replace', origin: result.state.editSession.origin });
    effects.push({ type: 'REPLACE_WORKBOOK', workbook: event.workbook });
    return { state: { ...result.state, editSession: null }, effects };
  }

  return { state: inputState, effects: [] };
}
