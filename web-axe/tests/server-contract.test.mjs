/**
 * 실서버(vault.axelabs.ai) 계약 검증 — 익명 엔드포인트만 친다. 자격증명 불요.
 *
 * 이 테스트들은 "SDK 를 그대로 쓸 수 있는가"의 경계를 기계로 고정한다.
 * 드리프트가 해소되면(서버 업그레이드 등) 카나리 테스트가 깨지면서 알려 준다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PasswordManagerClient } = require("@bitwarden/sdk-internal");

const BASE = "https://vault.axelabs.ai";
const PROBE_EMAIL = "poc-probe-nonexistent@axelabs.ai";

test("prelogin 실서버 왕복: 구형 평면 KDF 형식을 준다", async () => {
  const res = await fetch(`${BASE}/identity/accounts/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PROBE_EMAIL }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.kdf, 0, "PBKDF2");
  assert.ok(json.kdfIterations >= 600000, `iterations=${json.kdfIterations}`);
  // 앱의 mapPrelogin 이 기대하는 필드가 실제로 있는지
  assert.ok("kdfMemory" in json && "kdfParallelism" in json);
});

test("카나리: SDK 의 get_password_prelogin 은 이 서버에 아직 못 쓴다 (kdf_settings 요구)", async () => {
  const settings = {
    identityUrl: `${BASE}/identity`,
    apiUrl: `${BASE}/api`,
    userAgent: "AXE Vault PoC test",
    deviceType: "SDK",
    deviceIdentifier: "00000000-0000-4000-8000-00000000dead",
  };
  const login = new PasswordManagerClient({ get_access_token: async () => undefined }, settings)
    .auth()
    .login(settings);

  await assert.rejects(
    () => login.get_password_prelogin(PROBE_EMAIL),
    (e) => {
      assert.match(String(e.message), /kdf_settings/);
      return true;
    },
    "이 테스트가 깨졌다면 서버/SDK 계약이 맞춰진 것 — src/vault.ts 의 prelogin 을 SDK 것으로 되돌릴 것",
  );
});
