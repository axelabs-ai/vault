/**
 * 실서버(vault.axelabs.ai) 계약 검증 — 익명 엔드포인트만 친다. 자격증명 불요.
 *
 * 이 테스트들은 "SDK 를 그대로 쓸 수 있는가"의 경계를 기계로 고정한다.
 * 드리프트가 해소되면(서버 업그레이드 등) 카나리 테스트가 깨지면서 알려 준다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CLIENT_NAME, CLIENT_VERSION } from "../src/lib/api.ts";

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
    "이 테스트가 깨졌다면 서버/SDK 계약이 맞춰진 것 — src/lib/auth.ts 의 prelogin 을 SDK 것으로 되돌릴 것",
  );
});

test("클라이언트 헤더가 이 서버의 스톡 web-vault 와 같은 값인지", async () => {
  // 서버는 Bitwarden-Client-Version 이 없거나 semver 가 아니면 ERROR 를 로깅하고 버전 게이팅을
  // 못 한다. 우리는 같은 서버의 같은 계약을 소비하는 웹 클라이언트이므로 스톡 web-vault 와 같은
  // 값을 보낸다. 서버의 web-vault 를 올리면 이 테스트가 깨지며 src/lib/api.ts 갱신을 요구한다.
  assert.match(CLIENT_VERSION, /^\d+\.\d+\.\d+$/, "semver 여야 서버가 파싱한다");
  assert.equal(CLIENT_NAME, "web");

  const index = await (await fetch(`${BASE}/`)).text();
  const main = index.match(/src="(app\/main\.[a-f0-9]+\.js)"/)?.[1];
  assert.ok(main, "index.html 에서 web-vault 메인 번들을 못 찾았다");

  // 번들이 5MB 남짓이라 테스트가 몇 초 걸린다 — 드리프트를 실제로 잡는 값이라 유지한다.
  const bundle = await (await fetch(`${BASE}/${main}`)).text();
  const declared = bundle.match(/getApplicationVersion\(\)\{return Promise\.resolve\("([^"]+)"\)\}/)?.[1];
  assert.ok(declared, "web-vault 번들에서 getApplicationVersion() 을 못 찾았다 (번들 구조 변경?)");

  // 클라이언트는 getApplicationVersionNumber() = split(/[+|-]/)[0] 를 보낸다.
  assert.equal(CLIENT_VERSION, declared.split(/[+|-]/)[0].trim());
});
