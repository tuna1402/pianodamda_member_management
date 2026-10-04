# GitHub 반입 기록

2026-10-04 KST · 최종 검수 소스 v0.10.1의 GitHub 반입 준비 기록. 원격 업로드·외부 배포 전이다.

## 파일 준비 방식

`SOURCE-ALLOWLIST.json`의 source→target 매핑만 복사한다. 앱 전체 폴더의 재귀 복사는 하지 않는다. `scripts/prepare-source.mjs`는 소스·목적지 경계를 확인하고 복사 전/후 및 전체 종료 시 소스 해시를 대조한다. 완료 소스가 변경 중이면 반입을 실패 처리한다. 최종 SHA-256은 `SOURCE-MANIFEST.json`에 기록한다.

```text
node scripts/prepare-source.mjs ../academy-operations
node scripts/verify-repository.mjs --verify-snapshot
```

`node scripts/package-source.mjs <새 ZIP 절대 경로>`는 위 source target과 `BUNDLE-EXTRAS.json`에 적은 준비 파일만 묶는다. 기존 ZIP은 덮어쓰지 않으며 ZIP 자체는 소스 폴더 밖에 둔다. `.gitignore`·CI 같은 숨김 파일도 명시적으로 포함한다. 생성 데이터·로그를 검사 후 재귀 압축해서 다시 섞지 않는다. Node만 사용하므로 OS의 PowerShell 파일 실행 정책을 변경할 필요가 없다.

복사 도구는 개발 완료 후 소스 폴더를 전달받았을 때만 실행한다. 실제 저장소에서 이후 코드를 수정할 때 기존 snapshot은 최초 반입 증적으로 유지할 수 있다. CI 기본 파일 검사는 snapshot 해시 비교를 강제하지 않으며, 새 반입 패키지는 검수한 소스로 snapshot을 다시 생성한다.

반입 검사는 디스크의 소스 후보와 이 폴더가 저장소 루트일 때 Git 추적 파일을 확인한다. 무시한 로컬 데이터 폴더의 파일도 Git에 잘못 추적되면 제외 위반으로 발견한다. SQLite 내용 헤더·선정한 비밀키/PAT 패턴을 검사하고 원문 비밀값은 출력하지 않는다. 이 검사는 모든 개인정보/업체 키 유형을 발견하는 완전한 감사가 아니므로 반입 목록과 예제/문서의 수동 검수를 함께 한다.

## CI action 확인 근거

2026-10-04에 GitHub 공식 Node CI 문서의 checkout v6 / setup-node v7 예시와 공식 저장소의 실제 release/commit을 확인했다. CI는 이동 가능한 major tag 대신 다음 commit을 고정한다.

| Action | 검증 버전/commit | 공식 근거 |
|---|---|---|
| checkout | v6.1.0 / `d23441a48e516b6c34aea4fa41551a30e30af803` | [release](https://github.com/actions/checkout/releases/tag/v6.1.0) · [commit](https://github.com/actions/checkout/commit/d23441a48e516b6c34aea4fa41551a30e30af803) |
| setup-node | v7.0.0 / `820762786026740c76f36085b0efc47a31fe5020` | [release](https://github.com/actions/setup-node/releases/tag/v7.0.0) · [commit](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020) |

[GitHub 공식 Node CI 안내](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs). checkout 최신 major와 별개로 공식 예시의 v6 계열에서 확인한 패치를 사용했다. Node 실행 버전은 24 계열을 선택하고 실제 버전을 로그로 남긴다. actions 자체의 Linux 실행은 GitHub 계정/저장소가 없는 현재 환경에서 수행하지 않았다.

## 검수 결과

| 검수 | 실제 결과 |
|---|---|
| 최종 소스 복사 | 구현 완료 신호 후 v0.10.1 파일 35개를 명시적 목록으로 복사. 복사 전/후와 전체 종료 시 원본·반입본 SHA-256 일치 |
| 반입 파일 정책 | 준비 파일 포함 49개, 누락/미검토 파일/DB 헤더/선정 credential 패턴 0건. 예제는 합성, 운영 설정은 placeholder |
| Windows 빠른 검사 | 반입 폴더에서 `npm test`: 85개 통과, 실패/취소/skip 0. Node 24.12.0 |
| Windows 실시간 검사 | 반입 폴더에서 `npm run test:live`: 실제 시계 모의 알림 1개 통과, 실제 업체 호출 없음 |
| CI | Ubuntu + Node24, 읽기 전용 권한, 확인된 action commit 고정. 실제 GitHub 실행 미완료 |
| Linux/호스팅 | Linux OS 신호, TLS/프록시, 디스크/감시/복구의 실제 서버 검수 미완료 |
| 외부 작업 | 저장소 생성/업로드·계정 생성·외부 배포·실제 데이터·실제 문자 미실행 |

테스트 중 생성한 `work/` 로그·합성 DB·백업은 `.gitignore`와 명시적 압축 목록으로 제외한다. 증적 원문은 로컬 `work/fast-test.txt`, `work/live-test.txt`에 있으며 원격 반입 대상이 아니다. 검사 총 개수를 전체 요구사항 수용·접근성/장시간 운영 검증 완료로 계산하지 않는다.

개발이력은 구분한다. v0.10에서 통계·디자인 검사 78+1을 통과했고, 이번 v0.10.1은 서버 HOST·health/readiness·worker 감시·종료·재시작 검사까지 포함해 85+1을 통과했다. 기존 4193 시각 검수 미리보기는 v0.10 실행 구조였으며 v0.10.1 서버 실행은 별도 격리 프로세스로 검사했다. 실제 Linux 신호 검수는 여전히 남아 있다.

원격 저장소 URL·공개 범위·배포 브랜치·호스팅 계정/리전/도메인을 확정한 뒤 해당 대상으로 업로드와 첫 CI 검수를 진행한다. GitHub를 데이터베이스 백업 저장소로 사용하지 않는다.

