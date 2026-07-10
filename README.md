# XBRL 오프라인 스프레드시트

DART에서 내려받은 XBRL/XML/iXBRL 파일을 브라우저 내부에서 분석하고 스프레드시트 형태로 확인하는 단일 페이지 웹 앱입니다.

## 주요 기능

- XBRL/XML/iXBRL 및 라벨 파일 불러오기
- 재무표, Facts, Contexts, 계산 시트 자동 생성
- 셀 편집, 수식, 서식, 복사/붙여넣기, 실행 취소/다시 실행
- 작업 JSON 저장/불러오기
- CSV 및 Excel 호환 XML 내보내기
- 업로드한 데이터는 외부 서버로 전송하지 않고 브라우저에서만 처리

## 로컬 실행

```bash
python3 -m http.server 8080
```

브라우저에서 <http://localhost:8080>을 엽니다.

## 배포

정적 사이트이므로 Vercel, GitHub Pages, Firebase Hosting 등에 그대로 배포할 수 있습니다. 현재 프로덕션 배포는 Vercel 설정(`vercel.json`)을 사용합니다.
