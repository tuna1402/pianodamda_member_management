# 피아노를 담다 — 회원·운영 관리 v0.10.1

원장 운영 대시보드·상담/체험/수업 일정·반복 일정·모의 자동 알림·원장 통계·회원 공개 수업 화면의 검수 소스다. Node.js 24와 SQLite를 사용한다. **2026-10-04 GitHub main 브랜치 업로드와 첫 Linux 자동 검사를 완료했다. 외부 서버 배포와 실제 문자 업체 연결은 미완료다.** [검사 실행 기록](https://github.com/tuna1402/pianodamda_member_management/actions/runs/37165254610).

검수 소스는 명시한 파일만 복사했다. DB·삭제 목록·백업·개인정보·실제 환경값·서버 키·검사 임시 파일은 반입하지 않는다. 포함 파일/해시와 검수 범위는 [반입 기록](docs/UPLOAD-READINESS.md) 및 [SOURCE-MANIFEST.json](SOURCE-MANIFEST.json)을 참고한다.

## 로컬 합성 체험

Node 24를 준비하고 이 폴더에서 실행한다. 현재 외부 패키지가 없으므로 설치 명령은 필요 없다. 환경 예제 파일은 자동으로 읽히지 않는다. 아래와 같이 명시해서 사용한다.

```powershell
New-Item -ItemType Directory -Path data -Force | Out-Null
node --env-file=.env.development.example server.mjs
```

Linux에서도 새 개발 폴더에 `data`를 만든 뒤 같은 Node 명령을 사용할 수 있다. 브라우저에서 `http://127.0.0.1:4200/`을 연다. 개발 원장은 `director-demo` / `Demo-Director-2026!`, 학생은 `MBR-000742` / `1234`이며 첫 변경이 필요하다. 모두 합성 검사 전용이다. 이 계정이 있는 개발 환경을 실제 개인정보용 공개 서비스로 사용하지 않는다.

개발 서버 기본 HOST는 `127.0.0.1`이다. 같은 VM의 HTTPS 프록시 뒤에서는 유지하고, 관리형 호스팅이 요구할 때 담당자가 `HOST=0.0.0.0`을 명시한다. `/healthz`, `/readyz`, 원장 전용 작업 감시와 SIGTERM/SIGINT 종료 처리까지 추가했지만 실제 Linux·HTTPS 호스팅 검수는 남아 있다. [서버 실행 안내](docs/SERVER-RUNTIME.md) · [배포 안내](docs/DEPLOYMENT.md).

## 검사

```text
node scripts/verify-repository.mjs
npm test
npm run test:live
```

회귀 검사는 메모리 또는 새 합성 DB에서 실행하고 실제 문자 API를 호출하지 않는다. `test:live`는 실제 시계에서 예약 시각과 자동 모의 접수를 확인하므로 약 1분이 걸릴 수 있다. v0.10의 통계·디자인 기준 Windows 검사는 빠른 78/78, 실시간 1/1이었다. v0.10.1의 서버 실행 보완 후 **이 반입본에서도 빠른 85/85, 실시간 1/1 재검수를 통과했다.** [반입 기록](docs/UPLOAD-READINESS.md)에 준비 시점의 증적과 범위를 정리했다. 첫 GitHub Linux CI에서도 파일 검증·회귀 검사·실제 시계 모의 알림 검사가 모두 성공했으며 Node v24.21.0을 사용했다. 준비 시점 문서와 SOURCE-MANIFEST.json의 업로드 상태는 이전 단계의 기록이다.

CI는 Ubuntu·Node 24에서 파일 반입 확인과 위 검사를 실행하도록 준비했다. 저장소 업로드 후 첫 Linux 결과를 확인해야 한다. 현재 CI에는 배포 권한·실제 데이터·문자 키가 없다. 새로운 의존성을 추가할 때 검수한 lockfile과 재현 설치 단계를 함께 추가한다.

## 운영 전환

정확한 HTTPS `PUBLIC_ORIGIN`, 실제 원장 최초 설정, 데이터 무결성, 운영 전환 검수 및 복원 검수 상태가 필요하다. `.env.production.example`의 경로/출처는 운영 담당자가 채울 자리이며 기동용 실제 설정이 아니다. 운영 게이트를 우회하지 않는다.

현재 `sms-provider.mjs`는 모의 어댑터다. 운영 모드에서는 업체 미연결 알림이 보류된다. 실제 문자 API 키를 환경에 추가해도 발송 기능이 생기지 않는다.

- [환경·실행 설정](docs/ENVIRONMENT.md)
- [HOST·건강 확인·작업 감시·정상 종료](docs/SERVER-RUNTIME.md)
- [무료 서버·배포 단계](docs/DEPLOYMENT.md)
- [백업·격리 복원·롤백](docs/BACKUP-RESTORE.md)
- [운영 확장 사용 안내](docs/OPERATIONS-README.md)
- [실제 통계·디자인 정의](docs/DESIGN-STATISTICS.md)
- [기존 운영 전환 기준](docs/운영전환_준비서.md)
- [문자 연결 준비](docs/문자업체_연결준비서.md)

이미지는 생성된 연출 이미지이며 실제 학원 촬영 사진이 아니다. [제작 기록](public/assets/asset-prompts.md)을 보존한다. 외부의 참고 화면을 서비스 에셋으로 반입하지 않았다.

