# 배포 단계와 무료 서버 선택

2026-10-04 KST · 현재 반입본은 외부 배포 전이다. 저장소·계정·서버를 임의로 생성하지 않았다.

## 선택 경로

| 목표 | 우선 경로 | 조건 |
|---|---|---|
| 디자인만 공유 | 별도 정적 시안 + Render Static Site | `design-proposals`에서 HTML/CSS/JS/합성 데이터/생성 에셋만 반입. 이 동적 앱의 `public/`를 올리는 것만으로 실제 앱이 되지는 않음 |
| 기능 체험 | Render Free Web Service | HOST/PORT·health 경로 보완됨. 플랫폼 설정과 첫 Linux 실행은 검수 필요. 합성 데이터만, 재시작 초기화·휴면 안내 |
| 무료 운영 적합성 검사 | Oracle Always Free Linux VM 조건부 검토 | 자원 확보·회수 조건, 단일 로컬 영구 SQLite, HTTPS 프록시, 재기동·감시·독립 백업 직접 관리 |
| 실제 운영 | 위 검증 결과 또는 별도 지속 실행·영속 저장 환경 | 실제 업체·보관·복구 검수 완료 뒤 제한 전환 |

PythonAnywhere는 현 Node 웹 서버 공개를 지원하지 않아 기본 경로에서 제외했다. 신규 무료 계정은 미국 2026-01-15/EU 2026-01-08 이후 예약 작업이 없고 상시 작업은 유료다. SQLite는 사용할 수 있지만 업체는 운영 DB로 권장하지 않는다. [Node 지원 답변](https://www.pythonanywhere.com/forums/topic/33573/), [무료 기능](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/), [상시 작업](https://help.pythonanywhere.com/pages/AlwaysOnTasks/), [DB 안내](https://help.pythonanywhere.com/pages/KindsOfDatabases).

Render 무료 웹 서비스는 15분 유휴 후 정지하고 SQLite 등 로컬 파일은 휴면·재시작·재배포 때 소실한다. 무료 영속 디스크가 없고 무료 Postgres도 30일 만료이며, 현 SQLite 코드는 연결 주소만 바꿔 Postgres로 전환되지 않는다. [무료 제한](https://render.com/docs/free), [영속 디스크](https://render.com/docs/disks).

Oracle 무료 VM은 회수 가능성과 자원 부족을 포함한다. 무료 volume의 범위·홈 리전 조건 및 실제 복구를 확인해야 한다. 운영 가용성 보장이라고 해석하지 않는다. [Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## 실행 준비 순서

1. GitHub 소유자·저장소 이름/URL·기존 이력·공개 범위·배포 브랜치를 확정하고 이 반입본의 파일 확인 결과를 제출한다.
2. 저장소 업로드 후 CI를 실행한다. 현재 Windows 78+1 검사 기록을 Linux 검증 완료로 환산하지 않는다.
3. 서버 계정·리전·무료 자원·영구 경로·HTTPS 도메인·운영 담당자를 정한다. 실제 서버의 Node 24와 디스크/권한을 검수한다.
4. 추가한 HOST/PORT·`/healthz`·`/readyz`·SIGTERM/SIGINT 종료·원장 worker 감시를 실제 프록시/플랫폼에서 검수한다. 신뢰 프록시와 로그인 제한, 외부 감시/알림 연결은 아직 후속 항목이다.
5. 합성 데이터로 재시작 보존, 무결성·권한·통계·에셋·TLS·출처/쿠키·알림의 지연/중복을 확인한다. 10초 tick은 서버가 살아 있을 때만 실행된다.
6. 암호화 백업과 최신 삭제 목록을 서버 외부에도 관리하고 격리 복원·롤백을 실제로 시험한다.
7. 실제 이관/원장/보관/업체·발신번호/지정 수신자 검수를 완료한 뒤 운영 게이트를 통과하고 제한 전환한다.

HOST 선택·건강 확인·정상 종료·원장 작업 상태 API는 v0.10.1에 구현했다. 실제 문자 어댑터, 프록시의 이용자 주소, 외부 감시 연결, 24시간 실행·Linux/TLS/실제 호스팅 복구 검수는 남아 있다. 현재 worker는 동기 SQLite/모의 처리이며 향후 비동기 업체 호출에는 독립 timeout/불명 결과 보존과 종료 상한을 추가로 설계해야 한다. 무료 서비스에 접속이 된다는 결과만으로 출시하지 않는다. 같은 SQLite 파일을 여러 호스트/네트워크 공유 디스크에서 동시 사용하지 않는다. [서버 실행 상세](SERVER-RUNTIME.md).

## 배포 전에 필요한 사용자 정보

- GitHub 계정/조직 소유자, 저장소 이름 또는 URL, 기존 저장소 유무, 공개/비공개 범위, 배포 브랜치
- 호스팅 계정과 후보, 사용할 리전, 무료 자원 확보 상태, 예상 예산과 운영 담당자
- 실제 서비스 도메인 또는 호스트 기본 HTTPS 주소, 백업 보관 위치·담당·복구 목표
- 실제 데이터 전환 시점과 검수 담당자, 방문자/대장 보관 정책
- 문자 업체, 확인된 발신번호와 지정 테스트 수신 대상, 비용 상한/지연 보류 기준

비밀번호/API 키의 원문을 채팅·문서로 전달하지 않는다. 필요한 시점에 선택 서비스의 비밀 설정으로 주입한다. 정보가 미정이어도 로컬 구현과 파일 정리는 계속할 수 있으며, 외부 생성/업로드/배포에는 실제 대상 값이 필요하다.

