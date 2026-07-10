# XBRL 웹 스프레드시트

DART에서 내려받은 XBRL/XML/iXBRL 파일을 브라우저 내부에서 분석하고 스프레드시트 형태로 확인하는 정적 웹 앱입니다.

## 주요 기능

- XBRL/XML/iXBRL 및 라벨 파일 불러오기
- 재무표, Facts, Contexts, 계산 시트 자동 생성
- 셀 편집, 수식, 서식, 복사/붙여넣기, 실행 취소/다시 실행
- 수식 편집 중 셀 클릭·범위 드래그로 A1 참조 입력, `F4`로 상대/절대 참조 전환
- 채우기 핸들을 상하좌우로 드래그해 값 반복, 숫자·날짜·문자+숫자 계열 확장
- 채우기 시 수식 참조 자동 이동과 셀 서식 복사
- 작업 JSON 저장/불러오기
- CSV 및 Excel 호환 XML 내보내기
- 업로드한 데이터는 외부 서버로 전송하지 않고 브라우저에서만 처리

## 엑셀형 입력

### 셀을 선택해 수식 만들기

1. 셀 또는 수식 입력줄에서 `=`로 수식 편집을 시작합니다.
2. 그리드의 셀을 클릭하거나 범위를 드래그하면 현재 커서 위치에 A1 참조가 입력됩니다.
3. 참조에 커서를 둔 채 `F4`를 누르면 `A1` → `$A$1` → `A$1` → `$A1` 순서로 고정 방식이 바뀝니다.
4. `Enter`로 확정하거나 `Esc`로 편집을 취소합니다.

### 채우기 핸들

- 셀 또는 범위를 선택하고 오른쪽 아래 파란 핸들을 위·아래·왼쪽·오른쪽으로 드래그합니다.
- 한 개 값이나 일정하지 않은 패턴은 반복합니다. 두 개 이상의 일정 간격 숫자, ISO 날짜(`YYYY-MM-DD`), 문자+숫자 값은 계열을 이어갑니다.
- 수식은 목적지에 맞춰 상대 참조를 이동하고 `$`가 붙은 행·열은 고정합니다. 원본 셀 서식도 함께 복사합니다.
- 드래그 중 `Esc`를 누르면 적용하지 않습니다. 적용 후 `Ctrl+Z`/`Cmd+Z`를 누르면 채우기 전체를 한 번에 취소합니다.

## 데이터 처리와 개인정보

선택한 XBRL 파일, 편집 내용, 수식 계산, 내보내기는 모두 브라우저에서 처리됩니다. 앱에는 사용자 파일이나 통합 문서 데이터를 서버로 업로드하는 경로가 없습니다. 호스팅 서버는 앱의 정적 파일만 제공합니다.

## 로컬 실행

`index.html`은 `./src/spreadsheet-core.mjs`를 상대 경로의 브라우저 ESM으로 불러옵니다. 따라서 저장소 루트에서 HTTP 정적 서버를 실행해야 하며, `file://`로 `index.html`을 직접 여는 방식은 지원하지 않습니다.

```bash
python3 -m http.server 8080
```

브라우저에서 <http://localhost:8080>을 엽니다.

## 배포

빌드나 번들링 없이 `index.html`, `src/spreadsheet-core.mjs`, 정적 설정 파일을 함께 호스팅하는 구조입니다. 상대 ESM 경로를 보존해 Vercel, GitHub Pages, Firebase Hosting 등에 배포할 수 있으며, 현재 프로덕션 배포는 `vercel.json`을 사용합니다.

## 검증

### 전체 명령

```bash
npm run check
npm test
npm run test:browser
npm run test:webkit
npm run test:safari
git diff --check
```

- `npm run check`: JavaScript 문법과 macOS WebKit Swift 하네스 타입을 검사합니다.
- `npm test`: 수식 참조, 오류 전파, 채우기 계열·수식 이동·희소 실행 기록, 포인터 상태 전이를 검증합니다.
- `npm run test:browser`: 실제 Chrome에서 셀/범위 참조 선택과 F4, 수직·역방향·수평 채우기, 수식 이동, 취소·자동 스크롤·실행 취소/다시 실행, XBRL 가져오기, JSON 왕복, CSV/Excel XML 내보내기, 콘솔·네트워크 오류를 검사합니다. 기본 Chrome 경로가 다르면 `CHROME_BIN=/path/to/chrome`을 지정합니다.
- `npm run test:webkit`: 시스템 `WKWebView`에서 핵심 수식·채우기 상호작용을 검사합니다. 이 결과는 **WebKit 엔진 증거일 뿐 Safari 브라우저 승인 증거가 아닙니다**.
- `npm run test:safari`: 실제 SafariDriver 세션을 요구하는 엄격한 검사입니다. 세션을 만들 수 없으면 의도적으로 0이 아닌 종료 코드로 실패합니다.

배포 URL도 같은 하네스로 검사할 수 있습니다.

```bash
BROWSER_TEST_URL=https://<배포-URL>/ npm run test:browser
WEBKIT_TEST_URL=https://<배포-URL>/ npm run test:webkit
SAFARI_TEST_URL=https://<배포-URL>/ npm run test:safari
```

### Safari 차단 보고와 출시 승인

현재 로컬 증거에서 Chrome 매트릭스와 시스템 WKWebView 검사는 통과했습니다. SafariDriver 자체는 준비됐지만 Safari의 **Settings → Developer → Allow remote automation**이 꺼져 있어 세션 생성이 차단됐습니다. 따라서 현재 상태는 `Safari BLOCKED`이며 `Safari PASS`가 아닙니다.

차단 원인을 JSON으로 기록하되 증거 수집 작업 자체는 성공으로 끝내려면 다음 명령을 사용합니다.

```bash
npm run test:safari:report
```

이 보고 명령의 0 종료 코드는 Safari 통과를 의미하지 않습니다. Safari 출시 검증에는 다음이 모두 필요합니다.

1. Safari Settings → Developer에서 **Allow remote automation**을 켭니다.
2. `npm run test:safari` 또는 배포 URL을 지정한 엄격 실행이 통과해야 합니다.
3. 실제 데스크톱 Safari에서 [`tests/safari-manual-smoke.md`](tests/safari-manual-smoke.md)의 S1–S16을 수행하고 Safari 버전, URL, 커밋 SHA, 결과를 기록합니다.

위 조건이 충족되기 전에는 WKWebView 통과나 `test:safari:report` 차단 기록만으로 Safari 출시를 승인하지 않습니다.
