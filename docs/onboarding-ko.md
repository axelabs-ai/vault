# 가족용 vault 사용 가이드

부트스트랩 §6 구조 따름. 스크린샷은 Phase 1 본인 셋업 완료 후 추가.

---

## 1. 시작하기 전에 (5분)

### 왜 vault?

지금 우리 집·회사 비밀번호는 Google Sheet에 평문으로 저장되어 있습니다.
- 누가 시트 열람권 가지면 모든 비밀번호 보임
- Google 계정 털리면 같이 털림
- 백업 안 됨

vault는 이 비밀번호들을 macmini 안 금고에 옮깁니다.
- 본인 master password 한 번만 외우면 됨
- 폰·노트북 모두 자동으로 채워줌
- 잃어버려도 복구 가능 (Recovery Code 종이)

### 준비물

- 폰 (iOS/Android)
- 노트북 (Mac/Windows)
- 종이·펜 (Recovery Code 적기)
- Tailscale 설치 (운영자가 초대장 보냄)

---

## 2. 첫 가입 (10분)

1. 카톡으로 초대 링크 받음 ← 운영자가 보냄
2. 링크 클릭 → 브라우저 열림 (이미 서버 URL이 들어가 있음)
3. **Master Password 만들기** — 한국어 4단어 패스프레이즈 권장
   - 예: `푸른-감자-책상-여덟`
   - 12자 이상, 본인만 아는 조합
   - **절대 메모 앱·이메일에 저장 금지**
4. **Recovery Code 인쇄** — 종이에 적고 거실 금고에 보관
   - 이걸 잃어버리면 Master Password 잊었을 때 복구 불가

---

## 3. Mac에 설치 (5분)

운영자가 보낸 `vault-onboard.sh` 더블클릭. 자동으로:
- Bitwarden 앱 설치
- 서버 URL 자동 입력
- Safari/Chrome 확장 페이지 열림

본인 이메일로 로그인 → Master Password 입력 → 끝.

---

## 4. 폰에 설치 (10분)

### iOS

1. App Store에서 "Bitwarden" 설치
2. 앱 열기 → 좌상단 톱니바퀴 → **Self-hosted** → 서버 URL 입력
3. 이메일 + Master Password 로그인
4. 설정 → 일반 → 암호 → 자동완성 → Bitwarden ON

### Android

1. Play Store에서 "Bitwarden" 설치
2. 앱 열기 → 자체 호스팅 서버 → URL 입력
3. 로그인
4. 설정 → 자동 채우기 → Bitwarden 활성화

---

## 5. 첫 사용 (5분)

### 네이버 자동입력 체험

1. Safari/Chrome에서 naver.com 접속
2. 로그인 칸 클릭 → Bitwarden 자물쇠 아이콘 → 항목 선택 → 자동 입력

### 새 사이트 가입할 때

1. 가입 폼 비밀번호 칸 클릭
2. Bitwarden 아이콘 → "비밀번호 생성" → 20자 자동 생성
3. 가입 완료 → "vault에 저장하시겠습니까?" → 예

### 공유 비밀번호 (예: Netflix)

운영자가 만든 "가족 공유" 컬렉션에서 자동으로 보임. 본인이 항목 추가 시 컬렉션 선택하면 가족도 봄.

---

## 6. FAQ

### Master Password 잊었어요

→ Recovery Code 종이로 복구. Recovery Code도 잊으면 데이터 영구 손실 (운영자도 복구 불가).

### vault 접속 안 됨

→ Tailscale 켜져 있는지 확인. 운영자에게 연락.

### 폰 잃어버렸어요

→ 운영자에게 즉시 연락. 본인 모든 세션 invalidate 처리.

### TOTP (2단계 인증)도 vault에서 보고 싶어요

→ 항목 편집 → 인증기 키 추가 → 사이트가 보여주는 QR 스캔. vault가 6자리 코드 자동 생성.

### 비밀번호를 공유하고 싶어요

→ 항목 편집 → "Organization 으로 이동" → 가족 컬렉션 선택. 절대 카톡·문자로 보내지 마세요.
