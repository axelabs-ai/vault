# Backblaze B2 백업 설정 가이드 (한국어)

vault의 GPG 암호화된 일일 백업을 Backblaze B2로 보내는 단계별 안내입니다. 비개발자도 따라할 수 있게 썼습니다.

---

## 왜 Backblaze B2?

- **10 GB 무료 저장 + 매일 1 GB 무료 다운로드** — vault 백업(하루 수 MB 수준)에는 사실상 무료.
- **S3 호환 API** — rclone, restic 등 거의 모든 도구가 바로 붙음. 나중에 다른 곳으로 옮기기도 쉽습니다.
- **리전: 미국 us-west** (캘리포니아/애리조나). 한국에서 접속 안정적.
- vault 백업 용량 기준 예상 비용 **월 $0.01 미만**. 신용카드 등록 없이 무료 한도에서 운영 가능.

> 백업 본체는 vault가 GPG로 암호화한 뒤 업로드합니다. B2 측은 암호문만 보관하므로, 미국 사업자라 해도 평문 노출이 없습니다.

---

## 사전 준비

- 이메일 주소 1개 (개인/회사 어느 쪽이든)
- 인증 앱 (Google Authenticator, 1Password, Authy 등) — 2FA TOTP에 사용

---

## 단계별 설정

### 1. Backblaze 가입

![](screenshots/b2-01.png)

1. https://www.backblaze.com/sign-up/cloud-storage 접속
2. 이메일 + 비밀번호 입력 → 이메일 인증 링크 클릭
3. 로그인 후 **My Settings → Security → Two-Factor Authentication** 에서 **TOTP(인증 앱) 방식 활성화** (SMS 아님 — TOTP 강력 권장)
4. 복구 코드(recovery code)는 1Password 같은 곳에 따로 보관

> 신용카드 등록은 무료 한도 내에서는 불필요합니다.

### 2. 버킷(Bucket) 생성

![](screenshots/b2-02.png)

좌측 메뉴 **Buckets → Create a Bucket**:

| 항목 | 값 |
|---|---|
| Bucket Unique Name | `realchoice-vault-backups` |
| Files in Bucket are | **Private** |
| Default Encryption | **Enable (SSE-B2)** |
| Object Lock | Off (지금은 비활성. 나중에 랜섬 방어 강화하려면 켤 수 있음) |

`Create a Bucket` 클릭. 이름은 B2 전역에서 유니크해야 하므로 이미 쓰는 사람이 있으면 `realchoice-vault-backups-2` 같이 살짝 변형하세요. 변형했다면 `b2-setup.sh`의 `BUCKET_NAME` 변수도 같이 수정.

### 3. Application Key 생성 (버킷 스코프)

![](screenshots/b2-03.png)

좌측 **App Keys → Add a New Application Key**:

| 항목 | 값 |
|---|---|
| Name of Key | `vault-backup` |
| Allow access to Bucket(s) | **`realchoice-vault-backups`** (단일 버킷만!) |
| Type of Access | **Read and Write** |
| File name prefix | (비워둠) |
| Duration (in seconds) | (비워둠 = 무기한) |

`Create New Key` 클릭하면 한 화면에:

- **keyID** (계속 표시됨)
- **applicationKey** (이 화면을 떠나면 다시 못 봅니다. 반드시 1Password 등에 저장)

두 값 모두 1Password의 vault 항목에 저장. 절대로 git/Slack/이메일에 붙여넣지 마세요.

> **Master Application Key를 쓰면 안 됩니다.** 위에서 만든 버킷 스코프 키만 사용하세요. 키가 유출돼도 이 버킷 외에는 손해 없음.

### 4. rclone 설정

터미널에서:

```bash
rclone config
```

대화형 메뉴가 뜹니다. 출력 예시:

```
No remotes found, make a new one?
n) New remote
q) Quit config
n/q> n

name> b2

Storage>
 1 / 1Fichier ...
   ...
 6 / Backblaze B2
   \ (b2)
   ...
Storage> 6                # (번호는 버전마다 다를 수 있음 — "Backblaze B2" 골라서)

option account.
Account ID or Application Key ID.
Enter a value.
account> <여기에 keyID 붙여넣기>

option key.
Application Key.
Enter a value.
key> <여기에 applicationKey 붙여넣기>

option hard_delete.
Permanently delete files on remote removal, otherwise hide files.
Enter a boolean value (true or false). Press Enter for the default (false).
hard_delete>              # (그냥 Enter — false 유지)

Edit advanced config?
y) Yes
n) No (default)
y/n> n

Configuration complete.
Keep this "b2" remote?
y) Yes this is OK (default)
e) Edit this remote
d) Delete this remote
y/e/d> y

Current remotes:
Name                 Type
====                 ====
b2                   b2

e) Edit existing remote
...
q) Quit config
e/n/d/r/c/s/q> q
```

`hard_delete=false`로 두면 B2 측에서 삭제된 파일도 잠시 보관됩니다 (실수 복구용).

### 5. 자동 검증 probe

```bash
~/vault/scripts/b2-setup.sh
```

출력 예시:

```
[b2-setup] remote already configured
[b2-setup] probe: writing marker
[b2-setup] probe: listing marker
[b2-setup] probe: deleting marker
[b2-setup] probe OK
[b2-setup] appended VAULT_B2_REMOTE to /Users/realchoice/.config/vault/.env
[b2-setup] done.
```

이게 떴으면 끝. 다음 `backup.sh` 실행부터 자동으로 B2에 업로드됩니다.

---

## 트러블슈팅

### 한국 IP에서 B2가 차단되나요?

아니요. B2는 한국에서 직접 접근 가능합니다 (Cloudflare 같은 별도 프록시 불필요). 단, 회사망/공공 와이파이에서 막혀 있을 수 있으니 첫 설정은 집 네트워크에서 하세요.

### 비용이 얼마나 나오나요?

- vault 백업은 일일 수 MB ~ 수십 MB 수준. 무료 한도(10 GB 저장 + 1 GB/day 다운로드) 안에서 충분.
- 복구 드릴 때 잠깐 1 GB 넘어도 GB당 $0.01 수준. **연간 $0.10 이하** 예상.
- 카드 미등록 상태로도 무료 한도까지는 정지되지 않음.

### 미국 회사라 데이터가 안전한가요? 정부 압수영장 같은 거?

B2가 미국 사업자라 미국 법 적용을 받습니다. 다만 vault는 업로드 **전에** GPG로 암호화 — B2가 보는 것은 의미 없는 암호문. GPG 개인키는 본인 Mac에만 있고 B2 어디에도 없으므로, 영장이 발부돼 B2가 데이터를 넘기더라도 평문 노출은 발생하지 않습니다.

---

**분기 복구 드릴** — `~/vault/scripts/restore-test.sh`로 매 분기 1회 실제 복원 가능 여부 확인할 것. 백업이 도는 것보다 복원이 되는 것이 중요.
