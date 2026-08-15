/**
 * 탭 세션 보존의 경계 검증 — "새로고침 = 잠금" 을 지탱하는 저장 계약.
 *
 * 왜 이것들인가 — 전부 **조용히 어긋나는** 종류라서다:
 *  · 저장 페이로드에 평문 키가 한 번 섞이면 화면은 멀쩡히 동작한다. 눈으로는 영원히 안 보이고,
 *    devtools 를 열어 본 사람만 안다. 그래서 스키마를 기계가 대조한다 (이 파일의 핵심).
 *  · localStorage 로 새면 탭을 닫아도 남는다 — "탭을 닫으면 사라집니다" 라는 약속이 거짓이 된다.
 *  · 토큰 만료와 네트워크 장애를 같이 처리하면, 잠깐 끊긴 와이파이가 재로그인을 강요하거나
 *    (반대로) 죽은 세션이 잠금 화면에 영원히 남는다.
 *
 * 브라우저 전역(sessionStorage·localStorage)은 Node 에 없으므로 최소 스텁을 여기서 깐다.
 * localStorage 스텁은 **쓰기를 시도하면 터진다** — 규칙 위반이 테스트 실패로 드러나게.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- 브라우저 전역 스텁 (import 전에 깔아야 모듈 최상단 평가가 통과한다) ---
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => assert.fail("localStorage 에 쓰려 했다 — 이 앱은 localStorage 를 쓰지 않는다"),
  removeItem: () => {},
};
globalThis.location = { origin: "https://vault.axelabs.ai", hash: "", pathname: "/", search: "" };

let persist;
let api;

before(async () => {
  persist = await import("../src/lib/persist.ts");
  api = await import("../src/lib/api.ts");
});

beforeEach(() => store.clear());

/** 합성 값 — 실계정·실볼트와 무관하다 (crypto.test.mjs 의 PoC 벡터와 같은 성격). */
const ENC_USER_KEY =
  "2.Q8rMaxWA3mEh2E2bYkRafg==|Dyy8BlNZnBiuC/0U9PoM1+ysExlH9RqEE4t+RyWmDqPRgCV+szzeHvfTJkVg5xofWLhtbLXWEpcUzSXvtdLAkMXEBI4+waJ6QbMsPjfK1m0=|rZZMQ+ExL8xGWgai3+bOuH4Pq3vII/IbVsxB8Eh3b1Y="; // pragma: allowlist secret

const SEED = () => ({
  email: "poc@axelabs.ai",
  kdf: { pBKDF2: { iterations: 600000 } },
  accessToken: "eyJhbGciOiJSUzI1NiJ9.stub-access-token.sig", // pragma: allowlist secret
  refreshToken: "stub-refresh-token", // pragma: allowlist secret
  encUserKey: ENC_USER_KEY,
});

const stored = () => store.get("axe-vault.session");

// ------------------------------------------------------------ 새로고침 복원

test("새로고침 복원 — 저장된 세션이 있으면 로그인이 아니라 잠금 화면에서 시작한다", () => {
  persist.saveSession(SEED());

  const boot = persist.restoreSession();
  assert.equal(boot.phase, "locked");
  assert.equal(boot.session.email, "poc@axelabs.ai");
  // 잠금 해제에 필요한 재료가 전부 살아 있다 — 이게 없으면 화면만 잠금이고 열 수가 없다.
  assert.equal(boot.session.encUserKey, ENC_USER_KEY);
  assert.deepEqual(boot.session.kdf, { pBKDF2: { iterations: 600000 } });
});

test("저장된 세션이 없으면 로그인 화면에서 시작한다", () => {
  const boot = persist.restoreSession();
  assert.equal(boot.phase, "login");
  assert.equal(boot.session, null);
});

test("낯선 스키마·오염된 저장분은 되살리지 않고 버린다", () => {
  for (const junk of ["not json", "{}", JSON.stringify({ ...SEED(), v: 99 }), JSON.stringify({ v: 1 })]) {
    store.set("axe-vault.session", junk);
    assert.equal(persist.loadSession(), null, `되살아나면 안 된다: ${junk.slice(0, 40)}`);
    assert.equal(stored(), undefined, "쓸 수 없는 저장분은 지워져야 한다");
  }
});

// ------------------------------------------------------- 탭 수명 · 로그아웃

test("탭 계약 — 저장은 sessionStorage 의 axe-vault 이름공간에만 한다", () => {
  persist.saveSession(SEED());
  // localStorage 스텁이 쓰기에서 터지므로, 여기까지 왔다는 것 자체가 절반의 증명이다.
  assert.deepEqual([...store.keys()], ["axe-vault.session"]);
  assert.equal(persist.SESSION_KEY, "axe-vault.session");
});

test("src 어디에도 localStorage 쓰기·읽기가 없다 (레거시 제거만 허용)", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // axe-ui/ 는 @axe/ui Consumer Kit 재-export 물이다 (우리 코드가 아니다).
      if (e.isDirectory()) {
        if (e.name !== "axe-ui") walk(`${dir}${e.name}/`);
      } else if (/\.tsx?$/.test(e.name)) {
        files.push(`${dir}${e.name}`);
      }
    }
  };
  walk(root);
  assert.ok(files.length > 5, "소스를 못 찾았다 — 경로가 바뀌었나");

  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/localStorage\.(\w+)/g)) {
      assert.equal(m[1], "removeItem", `${f.replace(root, "src/")}: localStorage.${m[1]} 은 금지다`);
    }
  }
});

test("로그아웃 — 저장분 잔존 0", () => {
  persist.saveSession(SEED());
  assert.ok(stored());

  persist.clearSession();
  assert.equal(stored(), undefined);
  assert.equal(store.size, 0);
  assert.equal(persist.loadSession(), null);
  assert.equal(persist.restoreSession().phase, "login");
});

// ------------------------------------------ 저장 페이로드 스키마 (핵심 회귀 방어)

test("저장 페이로드는 허용 필드가 전부다", () => {
  persist.saveSession(SEED());
  assert.deepEqual(Object.keys(JSON.parse(stored())), [...persist.SESSION_FIELDS]);
});

test("평문 키·마스터 패스워드는 저장 페이로드에 절대 들어가지 않는다", () => {
  const MASTER_PASSWORD = "poc-master-password-2026"; // pragma: allowlist secret
  const PLAINTEXT_USER_KEY = "9SEU4QnrcNT/b2fDjH3F6H7HFvE9YPviF0dv3A7MMFo="; // pragma: allowlist secret
  const AUTH_HASH = "QyFNkeOez/m7Ix/LykBkZYNLawEG2/hgb+lKQtl97NU="; // pragma: allowlist secret

  // 호출부가 실수로 비밀을 얹은 상황을 그대로 재현한다.
  persist.saveSession({
    ...SEED(),
    masterPassword: MASTER_PASSWORD,
    userKey: new Uint8Array([1, 2, 3, 4]),
    userKeyB64: PLAINTEXT_USER_KEY,
    masterKey: PLAINTEXT_USER_KEY,
    authHash: AUTH_HASH,
    sync: { ciphers: [{ name: "평문 이름" }] },
    orgKeys: { org: PLAINTEXT_USER_KEY },
  });

  const raw = stored();
  assert.deepEqual(Object.keys(JSON.parse(raw)), [...persist.SESSION_FIELDS]);
  for (const forbidden of [MASTER_PASSWORD, PLAINTEXT_USER_KEY, AUTH_HASH, "평문 이름", "masterKey", "authHash", "userKey", "orgKeys", "sync"]) {
    assert.ok(!raw.includes(forbidden), `저장 페이로드에 ${forbidden} 이 새어 나갔다`);
  }
});

test("복호된 키를 encUserKey 자리에 넣으면 저장 단계에서 죽는다", () => {
  const plaintextKeys = [
    "9SEU4QnrcNT/b2fDjH3F6H7HFvE9YPviF0dv3A7MMFo=", // pragma: allowlist secret — EncString 이 아닌 생 base64
    "1,2,3,4", // Uint8Array 를 문자열로 흘린 모양
    new Uint8Array([1, 2, 3, 4]),
    "",
    null,
  ];
  for (const bad of plaintextKeys) {
    assert.throws(
      () => persist.saveSession({ ...SEED(), encUserKey: bad }),
      /EncString|비어 있거나/,
      `저장이 통과하면 안 된다: ${String(bad).slice(0, 20)}`,
    );
  }
  assert.equal(stored(), undefined, "실패한 저장이 흔적을 남기면 안 된다");
});

test("KDF 는 두 변종의 숫자 필드만 옮긴다 (딸려 오는 것 없음)", () => {
  persist.saveSession({ ...SEED(), kdf: { pBKDF2: { iterations: 600000, masterKey: "secret" } } });
  assert.deepEqual(JSON.parse(stored()).kdf, { pBKDF2: { iterations: 600000 } });

  persist.saveSession({
    ...SEED(),
    kdf: { argon2id: { iterations: 3, memory: 64, parallelism: 4, password: "secret" } },
  });
  assert.deepEqual(JSON.parse(stored()).kdf, { argon2id: { iterations: 3, memory: 64, parallelism: 4 } });

  assert.throws(() => persist.saveSession({ ...SEED(), kdf: { scrypt: { n: 1 } } }), /KDF/);
});

test("리프레시 토큰이 없는 세션도 저장·복원된다", () => {
  persist.saveSession({ ...SEED(), refreshToken: null });
  assert.equal(persist.loadSession().refreshToken, null);
});

// ------------------------------------------------- 토큰 만료 → 로그인 복귀

test("서버가 세션을 거부하면(401·invalid_grant) 저장분을 버리고 로그인으로 돌아간다", () => {
  for (const rejection of [
    new api.HttpError(401, "세션이 만료됐다. 다시 로그인해야 한다.", null),
    new api.HttpError(400, "Unable to refresh login credentials", { error: "invalid_grant" }),
  ]) {
    persist.saveSession(SEED());
    assert.ok(api.isAuthRejection(rejection));
    assert.equal(persist.restoreFailurePhase(rejection), "login");
    assert.equal(stored(), undefined, "죽은 세션을 들고 있을 이유가 없다");
  }
});

test("네트워크 실패는 세션을 버리지 않는다 — 잠금 화면에 남아 다시 시도한다", () => {
  for (const transient of [
    new TypeError("Failed to fetch"),
    new api.HttpError(500, "Internal Server Error", null),
    new api.HttpError(400, "twoFactor", { TwoFactorProviders: [0] }),
  ]) {
    persist.saveSession(SEED());
    assert.equal(api.isAuthRejection(transient), false);
    assert.equal(persist.restoreFailurePhase(transient), "locked");
    assert.ok(stored(), "잠깐 끊긴 네트워크가 재로그인을 강요하면 안 된다");
  }
});
