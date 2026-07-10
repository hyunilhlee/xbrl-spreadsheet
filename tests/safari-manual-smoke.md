# Safari release smoke

Safari automation is mandatory for release. Run this checklist in the current desktop Safari after enabling **Safari Settings → Developer → Allow remote automation**. `npm run test:safari` deliberately exits non-zero when that setting blocks WebDriver; `npm run test:safari:report` records the same evidence without making an evidence-only job fail.

When SafariDriver is available, `npm run test:safari` executes the named S1–S16 matrix through the real Safari WebDriver session and prints exact passed/failed/blocked counts. When the OS setting is disabled it runs no interaction claims, reports `0 passed / 0 failed / 16 blocked`, and exits 2. S14 automation proves both export hooks execute without a JavaScript failure; downloaded-file content remains a required manual assertion below.

## Preflight

```bash
python3 -m http.server 8080 --bind 127.0.0.1
curl -fsSI http://127.0.0.1:8080/
curl -fsSI http://127.0.0.1:8080/src/spreadsheet-core.mjs
npm run test:safari
```

For the deployed alias, run `SAFARI_TEST_URL=https://<alias>/ npm run test:safari` and repeat S1–S16 on that exact URL.

Required evidence:

- Root and `src/spreadsheet-core.mjs` return HTTP 200.
- Module content type is `text/javascript` or `application/javascript`.
- Safari loads the grid with no red console entry and no failed module request.
- The browser URL is HTTP(S), not `file://`.

## Deterministic interaction checklist

Use `tests/fixtures/minimal-instance.xbrl` for the import step. Record Safari version, URL, commit SHA, pass/fail, and a screenshot or console excerpt for each failed row.

| ID | Action | Pass condition |
|---|---|---|
| S1 | Select B2, type `=`, click C3, press Enter | B2 stores `=C3`; the origin stays B2 until Enter; one Undo clears it. |
| S2 | In B2 enter `=SUM()`, put the caret inside `()`, drag C3:D5 | Draft is exactly `=SUM(C3:D5)` and edit focus is retained. |
| S3 | Press F4 four times on C3 and C3:D5 | Cell and range cycle relative → absolute → row-absolute → column-absolute → relative. |
| S4 | Start a reference pick, press Escape twice | First cancellation restores the draft; repeated Escape is a no-op with no history entry. |
| S5 | Seed A1:A2 with 1,2; bold A1; drag the fill handle to A4 | A3:A4 are 3,4 and styles alternate bold/plain. One Undo removes A3:A4; one Redo recreates them. |
| S6 | Seed A3:A4 with 1,2; drag upward to A1 | A1:A2 are -1,0. |
| S7 | Seed C1:D1 with 1,2; drag right to F1 | E1:F1 are 3,4. |
| S8 | Put `=B1` in A1; drag to A3 | A2:A3 store `=B2`,`=B3`. |
| S9 | Start a fill, move to a destination, press Escape, release | No destination cell or Undo entry is created; preview/cursor/status reset. |
| S10 | Start a fill and move once to within 2 px of the viewport bottom; hold still 0.5 s | Scroll and preview keep advancing without another pointer move; Escape stops immediately. |
| S11 | Repeat S1/S5 at 80% and 125%, including one resized column | Picked cells and fill destination match the pointer. |
| S12 | Load `minimal-instance.xbrl` | Tabs are 재무표/Facts/Contexts/계산 시트; Facts contains `dart:Assets`, `12345000`, and `dart:EntityRegistrantName`; Network shows no upload. |
| S13 | Save JSON, reload the page, load that JSON | Sheet names and imported facts round-trip unchanged. |
| S14 | Export CSV and Excel XML | Both downloads complete; CSV contains Assets/12345000; XML contains four Worksheet elements and 12345000. |
| S15 | Switch editor ↔ formula bar, blur to a toolbar control, switch sheet, then load/import | Focus transfer preserves one edit; true blur/sheet switch commits once; workbook replacement does not write into the outgoing workbook. |
| S16 | Inspect Develop → Show JavaScript Console after all steps | No uncaught exception, console error, failed ESM import, or MIME refusal. |

Automated mapping: S1–S11 and S14–S16 run through SafariDriver async JavaScript in isolated reloads; S12 and S13 use WebDriver file-input upload against the checked-in XBRL and JSON fixtures. Chrome B1–B20 remains the deeper exact sparse/history/download-content oracle.

## Sign-off

```text
Safari version:
URL:
Commit SHA:
S1–S16:
Console errors: 0 / details
Tester/date:
```
