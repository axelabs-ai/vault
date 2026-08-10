# patches.v2026.7 — 베이스 `Timshel/OIDCWarden` `v2026.7.0-1` (`9214b378f072`)

구 `patches/` (베이스 `80439605`, 2026-05)는 **은퇴**했다. 2026-08-10 재검증 결과 4종 중 3종을 상류가 흡수했다:

| 구 패치 | v2026.7.0-1 | 처리 |
|---|---|---|
| 0001 `prelogin/password` 라우트 별칭 | 상류에 존재 | 폐기 |
| 0002 AccountKeys / MasterPasswordUnlock | `identity.rs`·`accounts.rs`·신규 `user_decryption.rs` 에 존재 | 폐기 |
| 0004 cipher `permissions` | 상류에 존재 | 폐기 |
| 0003 `access_all` 스킵 제거 | 3곳 잔존 | **재작성 → 0001** |

⚠️ `git apply --check` 실패를 "흡수됨" 으로 읽지 말 것. 컨텍스트 드리프트와 흡수는 다르다 — 반드시 **목적 기준 grep** 으로 확인한다. 위 표가 그 방식으로 만들어졌다.

## 현재 시리즈

- `0001-axe-collection-access_all-3.patch` — Owner/Admin 의 `users_collections` 행 누락 수정
- `0003-axe-SSO_ALLOWED_TENANT_IDS-issuer.patch` — 멀티테넌트 SSO (D-ops-89 선결①)

번호가 0002 를 건너뛴다. 그 자리는 **TDE 만료**(`SSO_TRUSTED_DEVICE_EXPIRY_DAYS`, D-ops-74 후속) 몫이고 아직 비어 있다.

## 0002(TDE 만료)가 비어 있는 이유

현행 운영 이미지 `vault:tde-expiry-r1` 에는 그 기능이 있는데 **상류에도 구 시리즈에도 없다.** 재유도하려면 "언제 신뢰됐는가" 를 알아야 하는데:

- 상류 `sso_trusted_device_encryption` 은 bool 하나뿐, 시각을 안 남긴다
- `device.updated_at` 은 사용할 때마다 갱신돼 신뢰 시점이 아니다
- `device.created_at` 은 기기 등록 시점이지 신뢰 시점이 아니다

즉 `devices` 에 `trusted_at` 류 컬럼을 더하는 **스키마 마이그레이션**이 선결이다. fork 안의 마이그레이션은 상류 rebase 때마다 충돌 지점이 되므로 별도 작업으로 뗀다. 그때까지 새 이미지는 TDE 만료 없이 동작한다(신뢰 기기가 무기한 유지 — 종전 `-r1` 대비 **보안 후퇴**이므로 배포 전 판단 필요).
