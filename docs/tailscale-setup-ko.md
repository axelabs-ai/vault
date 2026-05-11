# Tailscale 설정 가이드 (한국어)

이 문서는 Vaultwarden(`vault`)을 가족·본인만 접속 가능한 사설망(Tailscale)으로 노출하는 방법을 비전문가가 따라할 수 있게 설명합니다. 공개 인터넷에는 전혀 노출되지 않아요.

---

## 1. Tailscale이 뭐예요?

Tailscale은 **"내 디바이스들끼리만 통하는 사설 LAN"** 을 인터넷 위에 깔아주는 서비스예요.

- 집에 있는 Mac mini, 출장 중인 노트북, 가족 폰 — 같은 Tailscale 계정으로 묶으면 마치 같은 와이파이에 있는 것처럼 서로 보입니다.
- **공개 인터넷에는 0%** 노출돼요. 우리집 Mac mini에서 돌아가는 비밀번호 보관함(Vaultwarden)은 오직 우리 가족 디바이스만 접근할 수 있어요.
- 무료 플랜으로 디바이스 100대까지 가능합니다 (가족용으로 충분).

![](screenshots/tailscale-01-overview.png)

---

## 2. Tailscale 가입

브라우저로 https://login.tailscale.com 에 접속합니다.

![](screenshots/tailscale-02-signup.png)

- "Sign up" 누르면 Google / Microsoft / Apple / GitHub 중 하나로 SSO 로그인을 시킵니다.
- 별도 비밀번호를 만들 필요가 없어요. 평소 쓰는 Google 계정을 권장합니다.
- 가입이 끝나면 admin console(관리 화면)이 열려요. URL은 https://login.tailscale.com/admin/machines.

> 팁: 가족 모두 **같은 SSO 계정 도메인**을 쓰면 한 tailnet으로 묶입니다. 다른 도메인이면 "Invite" 절차를 거쳐야 해요 (6번 참고).

---

## 3. Mac mini 등록

Mac에 Tailscale 앱을 설치합니다. (이미 병행 설치 중이면 건너뜀)

```bash
brew install --cask tailscale-app
```

설치가 끝나면 메뉴바 상단에 작은 Tailscale 아이콘이 나타나요.

![](screenshots/tailscale-03-menubar.png)

1. 아이콘 클릭 → "Log in..." 선택.
2. 브라우저가 열리고 2번에서 만든 SSO 계정으로 로그인.
3. "Connect" 버튼을 누르면 디바이스가 자동 등록돼요.

등록되면 admin console의 Machines 탭에 `macmini`(또는 본인이 정한 호스트명)가 보입니다.

![](screenshots/tailscale-04-machines.png)

---

## 4. tailscale-setup.sh 실행

이제 Vaultwarden을 tailnet에 노출합니다. 한 줄이면 끝나요.

```bash
bash ~/vault/scripts/tailscale-setup.sh
```

이 스크립트(`scripts/tailscale-setup.sh`)가 하는 일:

1. Tailscale CLI가 깔려있는지 확인
2. 로그인이 되어 있는지 확인 (안 되어 있으면 안내 메시지를 출력하고 종료)
3. 내 Mac mini의 tailnet 주소(예: `macmini.tail-xxxx.ts.net`)를 알아냄
4. `tailscale serve`로 https://macmini.tail-xxxx.ts.net → http://127.0.0.1:8222 매핑
5. `~/.config/vault/.env`의 `DOMAIN=` 값을 자동 업데이트
6. Vaultwarden이 살아있는지 health check

성공하면 마지막 줄에 다음과 같은 메시지가 나옵니다.

```
[tailscale-setup] Done. Open https://macmini.tail-xxxx.ts.net from any device on your tailnet.
```

이제 같은 tailnet에 있는 디바이스라면 어느 브라우저에서든 그 주소로 Vaultwarden에 접근할 수 있어요.

---

## 5. 폰 등록

iOS 또는 Android에서 App Store / Play Store에서 **"Tailscale"** 앱을 설치합니다.

![](screenshots/tailscale-05-phone-app.png)

1. 앱 열기 → "Sign in"
2. 2번에서 쓴 **같은 SSO 계정**으로 로그인 (이게 핵심)
3. "Connect" 토글을 켜기
4. iOS에서는 VPN 권한을 한 번 허용해줘야 해요. "VPN 구성 추가" 안내가 나오면 "허용".

이제 폰에서도 https://macmini.tail-xxxx.ts.net 으로 Vaultwarden에 들어갈 수 있어요.

> 팁: Bitwarden 모바일 앱을 설치하고, 서버 주소를 `https://macmini.tail-xxxx.ts.net`으로 설정하면 자동 채우기까지 같이 됩니다.

---

## 6. 가족 초대

가족이 다른 Google 계정을 쓴다면 같은 tailnet에 초대해야 해요.

1. https://login.tailscale.com/admin/users 접속
2. 우측 상단 "Invite users" 클릭
3. 가족 이메일 주소 입력 → "Send invites"

![](screenshots/tailscale-06-invite.png)

4. 가족은 받은 메일의 링크를 눌러 SSO로 가입 → 우리 tailnet에 합류.
5. 가족 폰에서 Tailscale 앱 설치 → 같은 계정으로 로그인 (5번과 동일).

> 보안 팁: admin console의 ACL(Access Control)에서 가족 계정은 "Vaultwarden 한 곳만" 접근 가능하게 제한할 수도 있어요. 필요할 때 추가로 안내드릴게요.

---

## 7. 트러블슈팅

### 7-1. `https://macmini.tail-xxxx.ts.net` 주소가 안 열려요 (MagicDNS 문제)

증상: 브라우저에서 "이 사이트에 연결할 수 없음" 또는 DNS 오류.

원인: Tailscale의 **MagicDNS** 기능이 꺼져 있을 가능성이 큽니다.

해결:
1. https://login.tailscale.com/admin/dns 접속
2. "MagicDNS" 토글이 켜져있는지 확인 → 꺼져있으면 켜기.
3. 디바이스의 Tailscale 앱을 한 번 끄고 켜기 (재연결).

### 7-2. admin console에 디바이스가 "Awaiting approval" 상태

증상: Mac mini 또는 폰이 추가됐지만 회색 상태이고 IP가 없음.

원인: tailnet에 **"Device approval"** 정책이 켜져 있으면 관리자가 승인해야 해요.

해결:
1. https://login.tailscale.com/admin/machines 접속
2. 해당 디바이스 우측 "..." → "Approve" 클릭.

### 7-3. 회사·학교 와이파이에서 Tailscale이 안 붙어요

증상: 회사·학교 네트워크에서 Tailscale 앱이 "Connecting..." 무한 로딩.

원인: 회사 방화벽이 Tailscale 트래픽(UDP 41641)을 막는 경우가 있어요.

해결:
- 가능하면 **모바일 핫스팟**으로 전환해서 테스트 (제일 빠른 진단).
- Tailscale은 자동으로 DERP relay(HTTPS 443 fallback)를 쓰므로 대부분의 환경에서는 결국 붙어요. 1~2분 기다려보세요.
- 그래도 안 되면 IT 담당자에게 "Tailscale UDP 41641 outbound" 허용을 요청.

### 7-4. `tailscale-setup.sh` 실행 시 "Logged out" 메시지가 나와요

증상: 스크립트를 실행했더니 "Tailscale is not authenticated yet" 안내가 나오고 종료됨.

해결:
- 3번으로 돌아가서 Tailscale 앱에서 로그인을 먼저 끝내세요.
- 또는 터미널에서 `sudo tailscale up` 실행 (브라우저가 자동으로 열리며 SSO 진행).
- 로그인 끝나면 `bash ~/vault/scripts/tailscale-setup.sh` 다시 실행.

---

문제가 계속되면 `~/vault/README.md`나 `~/realchoice-ssot/docs/vault-bootstrap-2026-05-11.md` 문서를 참고하세요.
