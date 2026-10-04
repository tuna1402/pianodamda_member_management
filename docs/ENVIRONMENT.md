# 환경·실행 설정

2026-10-04 KST · 기준 v0.10.1 · Windows 로컬 검사 기준. 운영 서버의 실제 설정은 아직 없다.

서버는 `process.env`를 읽고 `.env` 파일을 자동 로드하지 않는다. 호스팅의 환경 설정, Linux 서비스의 접근 제한 환경 파일 또는 Node의 `--env-file`을 명시해서 주입한다. 예제를 실제 설정으로 바꿀 때 파일을 Git에 포함하지 않는다.

| 값 | 설정 |
|---|---|
| `APP_MODE` | 로컬 합성은 development. 실제 전환은 production. 개발 모드는 알려진 체험 계정을 만들어 실제 DB 사용 금지 |
| `DB_PATH` | 데이터 DB 절대 영구 경로. 개발 예제만 `./data/academy-demo.sqlite` 사용 |
| `RETENTION_JOURNAL_PATH` | 최신 삭제 목록의 별도 절대 영구 경로. 데이터 백업과 함께 과거로 되돌리지 않음 |
| `PUBLIC_ORIGIN` | 실제 운영 HTTPS origin. 경로·마지막 슬래시 없이 정확히 지정 |
| `PORT` | 내부 실행 포트. 기본 4173. 개발 예제는 4200 |
| 초기/제한/임시 비밀번호 기간 | `INITIAL_PASSWORD_MINUTES`, `RESTRICTED_SESSION_MINUTES`, `TEMP_PASSWORD_MINUTES`. 예제 1440/10/1440은 개발 기준 |
| `HOST` | 기본 `127.0.0.1`. 같은 VM의 프록시 뒤에서는 유지. 관리형 호스팅 요구 시 `0.0.0.0` 지정. localhost 또는 유효 IP만 허용 |
| `SHUTDOWN_GRACE_MS` | HTTP 종료 대기 1000~60000ms. 기본 10000ms. 실제 플랫폼의 강제 종료 상한과 함께 검수 |
| 문자 키/업체 설정 | 실제 어댑터 미지원. 환경값만 추가해서 실제 전송을 활성화할 수 없음 |

Linux 운영 경로 예시는 `/var/lib/piano-academy/academy.sqlite`와 `/var/lib/piano-academy/academy.deletions.sqlite`다. 이는 선택한 실제 서버의 디스크·권한 검수 후 채울 예시다. 데이터 디렉터리를 소스 release/public 경로와 분리하고 앱 사용자만 읽기/쓰기 가능하게 한다. 운영 프로세스는 root 사용자로 실행하지 않는다.

현재 서비스는 Node 24의 `node:sqlite`를 사용한다. 기준 Windows 검사 런타임은 24.12.0이었다. CI는 지원되는 Node 24 계열을 선택하고 실행 버전을 로그에 남긴다. 운영 서버 패치는 별도로 고정하고 변경할 때 검사를 반복한다. CI의 기본 환경에 전역 `NODE_ENV=test`를 넣어 웹 프로세스 기동 검사가 생략되게 하지 않는다.

같은 VM에서 HTTPS 프록시를 사용할 때 원본 출처·Secure 쿠키·HTTP 차단·신뢰 프록시·로그인 실패 제한을 검수한다. 임의 클라이언트가 보낸 forwarding 헤더를 무조건 신뢰하지 않는다.

`/healthz`는 응답 상태, `/readyz`는 DB 읽기·HTTP 수신·알림/보존 작업의 정상/지연 여부를 확인한다. 정상이면 200이고 준비 미완료/종료/작업 실패·지연은 readiness 503이다. 원장 `/api/admin/runtime`은 마지막 시도/성공과 작업 상태를 확인한다. 실제 문자 전달·정책·백업 최신성을 증명하는 상태가 아니다. [서버 실행 상세](SERVER-RUNTIME.md).

최초 운영 DB는 개발 실행으로 만들지 않고 `ops.mjs init-director`에서 시작한다. id/password는 안전한 표준입력으로 제공하며 명령줄·CI·문서에 비밀값을 남기지 않는다. 이후 이관·관계 확인·6개 검수 항목의 증적을 채워 `begin-operation`을 적용하는 흐름은 [기존 전환 준비서](운영전환_준비서.md)를 따른다. 아직 실제 원장/이관/운영 시작 작업은 수행하지 않았다.

