/**
 * 탭 세션 보존의 경계 검증 — "새로고침 = 잠금" 을 지탱하는 저장 계약.
 *
 * 왜 이것들인가 — 전부 **조용히 어긋나는** 종류라서다:
 *  · 저장 페이로드에 평문이 한 번 섞이면 화면은 멀쩡히 동작한다. 눈으로는 영원히 안 보이고,
 *    devtools 를 열어 본 사람만 안다. 특히 **세션 토큰**은 "서버도 가진 값" 이 아니라 권한
 *    그 자체다 — refresh 토큰은 마스터 패스워드 없이 계정 권한을 행사한다. 그래서 토큰이
 *    유저키 봉인 밖으로 새지 않는지를 스키마와 덤프 양쪽으로 못박는다 (이 파일의 핵심).
 *  · localStorage 로 새면 탭을 닫아도 남는다 — "탭을 닫으면 사라집니다" 라는 약속이 거짓이 된다.
 *  · 채택이 원자적이지 않으면, 저장에 실패한 순간 화면은 로그인인데 메모리에는 복호된 키가
 *    살아 있는 상태가 만들어진다. 그건 어떤 화면에도 나타나지 않는다.
 *  · 토큰 만료와 네트워크 장애를 같이 처리하면, 잠깐 끊긴 와이파이가 재로그인을 강요하거나
 *    (반대로) 죽은 세션이 잠금 화면에 영원히 남는다.
 *
 * 브라우저 전역(sessionStorage·localStorage)은 Node 에 없으므로 최소 스텁을 여기서 깐다.
 * localStorage 스텁은 **쓰기를 시도하면 터진다** — 규칙 위반이 테스트 실패로 드러나게.
 * 크립토는 앱과 **같은 SDK 인스턴스**를 쓴다 (봉인을 우리가 흉내내면 검증의 의미가 없다).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- 브라우저 전역 스텁 (import 전에 깔아야 모듈 최상단 평가가 통과한다) ---
const store = new Map();
const sessionStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.sessionStorage = sessionStub;
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => assert.fail("localStorage 에 쓰려 했다 — 이 앱은 localStorage 를 쓰지 않는다"),
  removeItem: () => {},
};
globalThis.location = { origin: "https://vault.axelabs.ai", hash: "", pathname: "/", search: "" };

let persist;
let api;
let session;
let vault;
let PureCrypto;

before(async () => {
  persist = await import("../src/lib/persist.ts");
  api = await import("../src/lib/api.ts");
  session = await import("../src/lib/session.ts");
  vault = await import("../src/lib/vault.ts");
  ({ PureCrypto } = await import("../src/sdk.ts"));
});

beforeEach(() => {
  store.clear();
  sessionStub.setItem = (k, v) => store.set(k, String(v));
});

/** 합성 값 — 실계정·실볼트와 무관하다 (crypto.test.mjs 의 PoC 벡터와 같은 성격). */
const ENC_USER_KEY =
  "2.Q8rMaxWA3mEh2E2bYkRafg==|Dyy8BlNZnBiuC/0U9PoM1+ysExlH9RqEE4t+RyWmDqPRgCV+szzeHvfTJkVg5xofWLhtbLXWEpcUzSXvtdLAkMXEBI4+waJ6QbMsPjfK1m0=|rZZMQ+ExL8xGWgai3+bOuH4Pq3vII/IbVsxB8Eh3b1Y="; // pragma: allowlist secret

/** 진짜 JWT 모양의 합성 토큰 — 덤프에서 찾기 쉬우라고 접두사 `eyJ` 를 그대로 쓴다. */
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.c3R1Yi1hY2Nlc3M.c2ln"; // pragma: allowlist secret
const REFRESH_TOKEN = "stub-refresh-token-7f3a91"; // pragma: allowlist secret

const FACTS = () => ({ email: "poc@axelabs.ai", kdf: { pBKDF2: { iterations: 600000 } }, encUserKey: ENC_USER_KEY });
const TOKENS = () => ({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
const userKey = () => PureCrypto.make_user_key_aes256_cbc_hmac();

const stored = () => store.get("axe-vault.session");

/** 잠긴 탭의 sessionStorage 를 통째로 뜬 것 — 공격자가 볼 수 있는 전부. */
const dump = () => JSON.stringify([...store.entries()]);

// ------------------------------------------------------------ 새로고침 복원

test("새로고침 복원 — 저장된 세션이 있으면 로그인이 아니라 잠금 화면에서 시작한다", () => {
  persist.saveSession(FACTS(), TOKENS(), userKey());

  const boot = persist.restoreSession();
  assert.equal(boot.phase, "locked");
  assert.equal(boot.session.email, "poc@axelabs.ai");
  // 잠금 화면을 그리고 유저키를 유도할 재료가 살아 있다 — 없으면 화면만 잠금이고 열 수가 없다.
  assert.equal(boot.session.encUserKey, ENC_USER_KEY);
  assert.deepEqual(boot.session.kdf, { pBKDF2: { iterations: 600000 } });
});

test("저장된 세션이 없으면 로그인 화면에서 시작한다", () => {
  const boot = persist.restoreSession();
  assert.equal(boot.phase, "login");
  assert.equal(boot.session, null);
});

test("낯선 스키마·오염된 저장분은 되살리지 않고 버린다", () => {
  const junk = [
    "not json",
    "{}",
    JSON.stringify({ v: 99, ...FACTS(), encTokens: "2.a|b|c" }),
    // 구 스키마(v1, 평문 토큰) — 마이그레이션하지 않고 버린다. 평문 토큰을 되살릴 이유가 없다.
    JSON.stringify({ v: 1, ...FACTS(), accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN }),
    JSON.stringify({ v: 2, ...FACTS() }), // 봉인 누락
  ];
  for (const j of junk) {
    store.set("axe-vault.session", j);
    assert.equal(persist.loadSession(), null, `되살아나면 안 된다: ${j.slice(0, 40)}`);
    assert.equal(stored(), undefined, "쓸 수 없는 저장분은 지워져야 한다");
  }
});

// ------------------------------------------------------- 탭 수명 · 로그아웃

test("탭 계약 — 저장은 sessionStorage 의 axe-vault 이름공간에만 한다", () => {
  persist.saveSession(FACTS(), TOKENS(), userKey());
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
  persist.saveSession(FACTS(), TOKENS(), userKey());
  assert.ok(stored());

  persist.clearSession();
  assert.equal(stored(), undefined);
  assert.equal(store.size, 0);
  assert.equal(persist.loadSession(), null);
  assert.equal(persist.restoreSession().phase, "login");
});

// ------------------------------------------ 저장 페이로드 스키마 (핵심 회귀 방어)

test("저장 페이로드는 허용 필드가 전부다", () => {
  persist.saveSession(FACTS(), TOKENS(), userKey());
  assert.deepEqual(Object.keys(JSON.parse(stored())), [...persist.SESSION_FIELDS]);
});

test("잠긴 탭의 저장분에 평문 토큰이 없다 — 토큰은 유저키 봉인 안에만 있다", () => {
  const key = userKey();
  persist.saveSession(FACTS(), TOKENS(), key);

  const raw = dump();
  // 토큰 값 자체는 물론이고, 접두사·필드명까지 새면 안 된다.
  for (const forbidden of [ACCESS_TOKEN, REFRESH_TOKEN, "eyJ", "accessToken", "refreshToken", "Bearer"]) {
    assert.ok(!raw.includes(forbidden), `잠긴 저장분에 ${forbidden} 이 새어 나갔다`);
  }
  // 봉인은 EncString 이고, 그 안에서만 토큰이 되살아난다.
  const sealed = JSON.parse(stored()).encTokens;
  assert.match(sealed, /^\d+\.[A-Za-z0-9+/=|]+$/);
  assert.deepEqual(persist.unsealTokens({ encTokens: sealed }, key), TOKENS());
});

test("봉인은 그 유저키로만 풀린다 (저장분만 훔쳐서는 못 쓴다)", () => {
  const key = userKey();
  const other = userKey();
  const stolen = persist.saveSession(FACTS(), TOKENS(), key);

  assert.deepEqual(persist.unsealTokens(stolen, key), TOKENS());
  assert.throws(() => persist.unsealTokens(stolen, other), /.*/, "다른 키로 풀리면 봉인이 아니다");
});

test("평문 키·마스터 패스워드는 저장 페이로드에 절대 들어가지 않는다", () => {
  const MASTER_PASSWORD = "poc-master-password-2026"; // pragma: allowlist secret
  const PLAINTEXT_USER_KEY = "9SEU4QnrcNT/b2fDjH3F6H7HFvE9YPviF0dv3A7MMFo="; // pragma: allowlist secret
  const AUTH_HASH = "QyFNkeOez/m7Ix/LykBkZYNLawEG2/hgb+lKQtl97NU="; // pragma: allowlist secret

  // 호출부가 실수로 비밀을 얹은 상황을 그대로 재현한다.
  persist.saveSession(
    {
      ...FACTS(),
      masterPassword: MASTER_PASSWORD,
      userKey: new Uint8Array([1, 2, 3, 4]),
      masterKey: PLAINTEXT_USER_KEY,
      authHash: AUTH_HASH,
      sync: { ciphers: [{ name: "평문 이름" }] },
      orgKeys: { org: PLAINTEXT_USER_KEY },
    },
    TOKENS(),
    userKey(),
  );

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
      () => persist.saveSession({ ...FACTS(), encUserKey: bad }, TOKENS(), userKey()),
      /EncString|비어 있거나/,
      `저장이 통과하면 안 된다: ${String(bad).slice(0, 20)}`,
    );
  }
  assert.equal(stored(), undefined, "실패한 저장이 흔적을 남기면 안 된다");
});

test("KDF 는 두 변종의 숫자 필드만 옮긴다 (딸려 오는 것 없음)", () => {
  persist.saveSession({ ...FACTS(), kdf: { pBKDF2: { iterations: 600000, masterKey: "secret" } } }, TOKENS(), userKey());
  assert.deepEqual(JSON.parse(stored()).kdf, { pBKDF2: { iterations: 600000 } });

  persist.saveSession(
    { ...FACTS(), kdf: { argon2id: { iterations: 3, memory: 64, parallelism: 4, password: "secret" } } },
    TOKENS(),
    userKey(),
  );
  assert.deepEqual(JSON.parse(stored()).kdf, { argon2id: { iterations: 3, memory: 64, parallelism: 4 } });

  assert.throws(() => persist.saveSession({ ...FACTS(), kdf: { scrypt: { n: 1 } } }, TOKENS(), userKey()), /KDF/);
});

test("리프레시 토큰이 없는 세션도 봉인·복원된다", () => {
  const key = userKey();
  const s = persist.saveSession(FACTS(), { accessToken: ACCESS_TOKEN, refreshToken: null }, key);
  assert.deepEqual(persist.unsealTokens(s, key), { accessToken: ACCESS_TOKEN, refreshToken: null });
});

// ------------------------------------------------ 채택의 원자성 (복호 키 누수 방지)

/** deriveOrgKeys·buildIndex 가 통과할 최소 sync 원문 (조직 없음 → 크립토 호출 없음). */
const RAW_SYNC = () => ({ profile: { email: "poc@axelabs.ai", key: ENC_USER_KEY }, ciphers: [], folders: [], collections: [] });

test("채택 — 저장까지 성공해야 키와 인덱스를 돌려준다", () => {
  const key = userKey();
  const adoption = session.prepareAdoption(RAW_SYNC(), FACTS(), TOKENS(), key);

  assert.equal(adoption.keys.userKey, key);
  assert.ok(adoption.keys.userKey.some((b) => b !== 0), "성공 경로에서 키를 지우면 안 된다");
  assert.equal(adoption.data.items.length, 0);
  assert.deepEqual(Object.keys(JSON.parse(stored())), [...persist.SESSION_FIELDS]);
});

test("저장이 실패하면 새로 유도한 키는 남지 않는다 (반쯤 채택된 상태 금지)", () => {
  const key = userKey();
  // 브라우저에서 실제로 나는 실패: 저장 용량 초과.
  sessionStub.setItem = () => {
    throw new DOMException("QuotaExceededError");
  };

  assert.throws(() => session.prepareAdoption(RAW_SYNC(), FACTS(), TOKENS(), key), /Quota/);
  // (b) 키 참조 0 — 넘겨준 유저키가 실제로 덮어써졌다. 조직 키도 같은 wipeKeys 로 지워진다.
  assert.ok(key.every((b) => b === 0), "실패했는데 복호된 유저키가 살아 있다");
  // (a) 저장분도 화면도 열리지 않는다 — 예외가 그대로 올라가 호출부(useSession.adopt)의
  //     설치 구간에 도달하지 않으므로 phase 는 login/locked 그대로 남는다.
  assert.equal(stored(), undefined);
});

test("저장 페이로드 검사에 걸려도 마찬가지로 키를 지운다", () => {
  const key = userKey();
  assert.throws(() => session.prepareAdoption(RAW_SYNC(), { ...FACTS(), encUserKey: "평문" }, TOKENS(), key), /EncString/);
  assert.ok(key.every((b) => b === 0), "실패했는데 복호된 유저키가 살아 있다");
  assert.equal(stored(), undefined);
});

// ------------------------------------------------------- 경합 (뒤늦은 완료·토큰 회전)

/**
 * 잠금해제는 서버 왕복을 포함한다. 그 사이에 로그아웃·잠금이 끼어들고, 심지어 **다른 계정으로
 * 로그인**까지 될 수 있다. 채택 지점만 막는 것으로는 부족하다 — 시도는 채택 이전에도 쓴다
 * (토큰 회전분 저장). 그래서 여기서 고정하는 것은 "쓰기 직전 대조" 자체다:
 * 취소·세션 교체 이후의 뒤늦은 완료는 **아무것도 쓰지 않고**, 남의 저장분은 지우지도 않는다.
 * (phase·배너가 오염되지 않는 것은 구조로 보장된다: useSession.unlock 이 catch 에서
 *  live()·isAbort·AbandonedError 를 보고 setState 한 줄 없이 되돌아간다.)
 */

/** api.ts 가 쓰는 것만 흉내낸다 (ok·status·text). signal 이 이미 끊겼으면 진짜처럼 거절한다. */
const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

const ROTATED_ACCESS = "eyJhbGciOiJSUzI1NiJ9.cm90YXRlZA.c2ln"; // pragma: allowlist secret
const ROTATED_REFRESH = "rotated-refresh-9c2b"; // pragma: allowlist secret

/** 401 → 리프레시 성공 → (그다음 sync 는 호출부가 정한다) */
function rotatingFetch(afterRotate) {
  let syncCalls = 0;
  return async (url, init) => {
    if (init?.signal?.aborted) throw abortError();
    if (String(url).includes("/identity/connect/token")) {
      return res(200, { access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600 });
    }
    syncCalls += 1;
    return syncCalls === 1 ? res(401, {}) : afterRotate();
  };
}

/** 지금 이 순간부터 stale 인 시도 (로그아웃·세션 교체가 epoch 을 올린 뒤). */
function staleAttempt() {
  let epoch = 0;
  const attempt = session.startAttempt(() => epoch);
  epoch += 1; // 로그아웃/세션 교체
  return attempt;
}

test("로그아웃 중 리프레시가 성공해도 저장분을 다시 만들지 않는다", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = rotatingFetch(() => res(200, { profile: {} }));
  try {
    // 로그아웃 직후 = 저장분이 비어 있다.
    assert.equal(stored(), undefined);
    let rotated = false;
    await assert.rejects(
      () => session.pullSync(FACTS(), TOKENS(), userKey(), staleAttempt(), () => (rotated = true)),
      (e) => e instanceof session.AbandonedError,
      "취소된 시도는 물러나야 한다",
    );
    assert.equal(rotated, false, "onRotate 가 불렸다 = 쓰기 직전 대조가 없다");
    assert.equal(stored(), undefined, "로그아웃한 세션의 저장분이 되살아났다");
    assert.equal(store.size, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("다른 계정으로 로그인한 뒤 도착한 뒤늦은 회전은 새 세션의 저장분을 건드리지 않는다", async () => {
  // 계정 B 로 새로 로그인한 상태.
  const keyB = userKey();
  const factsB = { ...FACTS(), email: "other@axelabs.ai" };
  const tokensB = { accessToken: "eyJhbGciOiJSUzI1NiJ9.Yg.c2ln", refreshToken: "b-refresh" }; // pragma: allowlist secret
  persist.saveSession(factsB, tokensB, keyB);
  const snapshot = stored();

  const origFetch = globalThis.fetch;
  globalThis.fetch = rotatingFetch(() => res(200, { profile: {} }));
  try {
    // 계정 A 의 시도가 뒤늦게 회전에 성공해 돌아온다.
    await assert.rejects(
      () => session.pullSync(FACTS(), TOKENS(), userKey(), staleAttempt(), () => {}),
      (e) => e instanceof session.AbandonedError,
    );

    // 덮어쓰기도, 삭제도 없어야 한다 — 내가 만든 저장분이 아니면 손대지 않는다.
    assert.equal(stored(), snapshot, "새 세션의 저장분이 오염됐다");
    assert.deepEqual(persist.unsealTokens(persist.loadSession(), keyB), tokensB, "B 세션이 여전히 열려야 한다");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("취소는 대기 중인 유도 키를 즉시 지운다 (뒤늦은 완료를 기다리지 않는다)", async () => {
  const key = userKey();
  let epoch = 0;
  const attempt = session.startAttempt(() => epoch);
  attempt.secrets.push(key);

  // 영영 끝나지 않는 왕복 — 이 상태에서 로그아웃이 일어난다.
  let release;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((r) => (release = r));
  try {
    const inflight = session.pullSync(FACTS(), TOKENS(), key, attempt, () => {}).catch((e) => e);

    // 로그아웃: 취소 + 세션 정체성 상승
    session.cancelAttempt(attempt);
    epoch += 1;

    // 완료를 기다리지 않고 지금 이미 지워져 있어야 한다.
    assert.ok(zeroed(key), "취소했는데 대기 중이던 유저키가 살아 있다");
    assert.equal(attempt.controller.signal.aborted, true, "진행 중 왕복이 중단되지 않았다");
    assert.equal(attempt.live(), false);
    assert.equal(attempt.secrets.length, 0);

    release(res(200, { profile: {} }));
    await inflight;
    assert.equal(stored(), undefined, "취소된 시도가 저장분을 만들었다");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("중단(abort)은 AbortError 로 식별돼 조용히 끝난다 (화면에 사유를 띄우지 않는다)", async () => {
  const attempt = session.startAttempt(() => 0);
  session.cancelAttempt(attempt); // 이미 중단된 상태로 들어간다

  const origFetch = globalThis.fetch;
  globalThis.fetch = rotatingFetch(() => res(200, { profile: {} }));
  try {
    const err = await session.pullSync(FACTS(), TOKENS(), userKey(), attempt, () => {}).catch((e) => e);
    assert.ok(session.isAbort(err), `AbortError 로 식별돼야 한다: ${err?.name}`);
    // 중단은 "세션 거부" 가 아니다 — 저장분을 지우지도, 로그인으로 보내지도 않는다.
    assert.equal(api.isAuthRejection(err), false);
    assert.equal(persist.restoreFailurePhase(err), "locked");
    assert.equal(stored(), undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("살아 있는 시도에서는 회전한 토큰이 sync 실패에도 저장분에 남는다 (다음 시도가 그걸 쓴다)", async () => {
  const facts = FACTS();
  const key = userKey();
  persist.saveSession(facts, TOKENS(), key); // 저장분은 아직 구 토큰

  const origFetch = globalThis.fetch;
  globalThis.fetch = rotatingFetch(() => res(500, { message: "일시 장애" }));
  try {
    let rotatedSeen = null;
    await assert.rejects(
      () => session.pullSync(facts, TOKENS(), key, session.startAttempt(() => 0), (s, t) => (rotatedSeen = t)),
      /일시 장애/,
      "sync 실패는 그대로 올라와야 한다 (잠금 화면 유지·재시도 가능)",
    );

    // 핵심: 서버는 회전 시점에 구 리프레시 토큰을 죽인다. 그걸 저장하지 않으면 일시 장애가
    // 강제 재로그인으로 굳는다.
    assert.deepEqual(rotatedSeen, { accessToken: ROTATED_ACCESS, refreshToken: ROTATED_REFRESH });
    assert.deepEqual(persist.unsealTokens(persist.loadSession(), key), {
      accessToken: ROTATED_ACCESS,
      refreshToken: ROTATED_REFRESH,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ------------------------------------------- 저장소 자체가 막힌 환경 (프라이빗 모드 등)

/**
 * `sessionStorage` 는 있다고 가정할 수 없다 — 프라이빗 모드·용량 초과·기업 정책은 접근 **자체**를
 * 던진다. 그 실패가 부팅을 죽이거나(로그인 화면조차 못 뜸) 로그아웃의 메모리 폐기를 막으면
 * (지우려다 예외 → zeroize·화면 전이 통째 중단) 저장소 문제가 보안 문제로 번진다.
 */
function withBrokenStorage(run) {
  const orig = globalThis.sessionStorage;
  const boom = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  globalThis.sessionStorage = { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
  const warn = console.warn;
  console.warn = () => {};
  try {
    return run();
  } finally {
    globalThis.sessionStorage = orig;
    console.warn = warn;
  }
}

test("저장소 접근이 막혀도 부팅은 로그인 화면으로 정상 진행한다", () => {
  withBrokenStorage(() => {
    const boot = persist.restoreSession();
    assert.equal(boot.phase, "login", "저장소가 막혔다고 부팅이 죽으면 안 된다");
    assert.equal(boot.session, null);
    assert.equal(persist.loadSession(), null);
  });
});

test("삭제가 실패해도 로그아웃의 키 폐기·화면 전이는 멈추지 않는다", () => {
  const key = userKey();
  withBrokenStorage(() => {
    // clearSession 이 던지면 호출부(logout·forget)의 이후 줄이 통째로 건너뛰어진다.
    assert.doesNotThrow(() => persist.clearSession());
    // 그래서 뒤따르는 메모리 폐기가 실제로 실행된다.
    key.fill(0);
    assert.ok(zeroed(key));
    // 복원 실패 판정 경로도 같은 이유로 던지지 않아야 한다.
    assert.equal(persist.restoreFailurePhase(new api.HttpError(401, "만료", null)), "login");
  });
});

test("저장 실패는 여전히 예외다 (채택 원자성이 여기 걸려 있다)", () => {
  const key = userKey();
  withBrokenStorage(() => {
    assert.throws(() => persist.saveSession(FACTS(), TOKENS(), key), /insecure|SecurityError/);
  });
});

// ------------------------------------- SSO 대기 구간 (봉인 전 평문 토큰) · 시한

/**
 * SSO 인증 직후 ~ 첫 잠금해제 사이는 토큰을 감쌀 유저키가 없어 **평문 토큰이 메모리에 있는**
 * 유일한 구간이다. 방치된 탭이 계정 권한(refresh 토큰)을 무기한 들고 있으면 안 되므로 시한이 있고,
 * 만료·취소·언마운트가 참조를 끊는다. (phase 가 login 으로 가고 배너가 뜨는 것은 useSession 의
 * 타이머가 forget(SSO_EXPIRED) 을 부르는 구조로 보장된다.)
 */
test("SSO 대기 구간에는 시한이 있고, 만료·취소가 평문 토큰 참조를 끊는다", () => {
  const t0 = 1_000_000;
  const p = session.startPending(TOKENS(), t0);

  assert.equal(p.expiresAt, t0 + session.SSO_PENDING_MS);
  assert.equal(session.SSO_PENDING_MS, session.IDLE_LOCK_MS, "방치 시한은 앱 전체에서 한 숫자여야 한다");
  assert.ok(session.pendingAlive(p, t0 + 1));
  assert.equal(session.pendingAlive(p, t0 + session.SSO_PENDING_MS), false, "시한이 지난 토큰은 쓰지 않는다");

  session.clearPending(p);
  assert.equal(p.tokens, null, "만료됐는데 평문 토큰을 계속 들고 있다");
  assert.equal(session.pendingAlive(p, t0 + 1), false, "비워진 보관함이 살아 있다고 나온다");
  assert.equal(stored(), undefined, "SSO 대기 구간은 애초에 저장분을 만들지 않는다");
  assert.match(session.SSO_EXPIRED, /다시 로그인/);
});

// --------------------------- 복원 세션 vs 서버의 현재 계정 상태 (키 회전 반영)

const syncFor = (key, email) => ({ profile: { email, key }, ciphers: [], folders: [], collections: [] });

test("복원 — 서버에서 키가 회전됐으면 저장분을 폐기하고 전체 로그인을 요구한다", () => {
  const facts = FACTS();
  const rotatedKey = "2.bmV3aXY9PQ==|bmV3ZGF0YQ==|bmV3bWFj"; // pragma: allowlist secret

  // 비밀번호·키 회전 = profile.key 가 새 값. 낡은 저장분으로 계속 열어 주면 **폐기된 옛 마스터
  // 패스워드가 이 탭에서만 통한다**. KDF 변경도 여기서 함께 걸린다(마스터키가 달라지면 서버가
  // profile.key 를 다시 감싼다).
  assert.equal(session.staleSessionMetadata(syncFor(rotatedKey, facts.email), facts), true);
  // 계정 자체가 다른 경우
  assert.equal(session.staleSessionMetadata(syncFor(facts.encUserKey, "other@axelabs.ai"), facts), true);
  // 마스터 패스워드가 없는 계정으로 뒤바뀐 경우 / 프로필이 낯선 경우
  assert.equal(session.staleSessionMetadata({ profile: { email: facts.email } }, facts), true);
  assert.equal(session.staleSessionMetadata({}, facts), true);
  assert.match(session.ACCOUNT_CHANGED, /계정 보안 정보가 변경/);
});

test("복원 — 서버 값이 저장분과 같으면 정상 채택하고 저장을 갱신한다", () => {
  const facts = FACTS();
  const raw = syncFor(facts.encUserKey, facts.email);
  assert.equal(session.staleSessionMetadata(raw, facts), false);

  const key = userKey();
  const adoption = session.prepareAdoption(raw, facts, TOKENS(), key);
  assert.ok(adoption.stored.encTokens, "채택이 저장까지 마쳐야 한다");
  assert.deepEqual(persist.unsealTokens(persist.loadSession(), key), TOKENS());
});

// -------------------------------------------- 조직 키 유도의 부분 결과 (누수 방지)

/**
 * 진짜 재료로 유도 상황을 만든다 — 실패 주입만 합성이다(2번째 조직에서 예외).
 * 유도 중 만들어지는 버퍼는 함수 밖에서 볼 수 없으므로, SDK 호출을 **통과시키며 기록만 하는**
 * 스파이로 참조를 잡는다. 크립토는 그대로 실물이 돌고, 우리가 보는 건 위생뿐이다.
 */
function orgFixture() {
  const key = userKey();
  const priv = PureCrypto.rsa_generate_keypair();
  const pub = PureCrypto.rsa_extract_public_key(priv);
  const orgKey = PureCrypto.make_user_key_aes256_cbc_hmac();
  return {
    key,
    orgKey,
    profile: {
      privateKey: PureCrypto.wrap_decapsulation_key(priv, key),
      encOrgKey: PureCrypto.encapsulate_key_unsigned(orgKey, pub),
    },
  };
}

function withSpies(run) {
  const origUnwrap = PureCrypto.unwrap_decapsulation_key;
  const origDecap = PureCrypto.decapsulate_key_unsigned;
  const seen = { privateKeys: [], orgKeys: [] };
  PureCrypto.unwrap_decapsulation_key = (...a) => {
    const out = origUnwrap(...a);
    seen.privateKeys.push(out);
    return out;
  };
  PureCrypto.decapsulate_key_unsigned = (...a) => {
    const out = origDecap(...a);
    seen.orgKeys.push(out);
    return out;
  };
  try {
    return run(seen);
  } finally {
    PureCrypto.unwrap_decapsulation_key = origUnwrap;
    PureCrypto.decapsulate_key_unsigned = origDecap;
  }
}

const zeroed = (b) => b.every((x) => x === 0);

test("조직 키 유도가 중간에 실패하면 그때까지 복호한 조직 키·개인키를 전부 지운다", () => {
  const fx = orgFixture();
  withSpies((seen) => {
    const sync = {
      profile: {
        privateKey: fx.profile.privateKey,
        organizations: [
          { id: "org-1", key: fx.profile.encOrgKey },
          // 2번째에서 유도 자체가 깨진다 (필드 접근이 터지는 응답 — decapsulate 개별 실패와 달리
          // 이 예외는 루프 밖으로 나간다).
          {
            get id() {
              throw new Error("유도 중 폭발");
            },
          },
          { id: "org-3", key: fx.profile.encOrgKey },
        ],
      },
    };

    assert.throws(() => vault.deriveOrgKeys(sync, fx.key), /폭발/);
    assert.equal(seen.orgKeys.length, 1, "1번째 조직까지만 복호됐어야 한다");
    assert.ok(zeroed(seen.orgKeys[0]), "실패했는데 1번째 조직 키가 살아 있다");
    assert.ok(zeroed(seen.privateKeys[0]), "실패했는데 개인키가 살아 있다");
  });
});

test("성공 경로 — 조직 키는 살려 내보내고 개인키만 지운다", () => {
  const fx = orgFixture();
  withSpies((seen) => {
    const sync = {
      profile: { privateKey: fx.profile.privateKey, organizations: [{ id: "org-1", key: fx.profile.encOrgKey }] },
    };

    const keys = vault.deriveOrgKeys(sync, fx.key);
    assert.deepEqual([...keys.get("org-1")], [...fx.orgKey], "조직 키가 원본과 달라졌다");
    assert.ok(zeroed(seen.privateKeys[0]), "개인키는 org 키 유도에만 쓰이므로 남으면 안 된다");
  });
});

// ------------------------------------------------- 토큰 만료 → 로그인 복귀

test("서버가 세션을 거부하면(401·invalid_grant) 저장분을 버리고 로그인으로 돌아간다", () => {
  for (const rejection of [
    new api.HttpError(401, "세션이 만료됐다. 다시 로그인해야 한다.", null),
    new api.HttpError(400, "Unable to refresh login credentials", { error: "invalid_grant" }),
  ]) {
    persist.saveSession(FACTS(), TOKENS(), userKey());
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
    persist.saveSession(FACTS(), TOKENS(), userKey());
    assert.equal(api.isAuthRejection(transient), false);
    assert.equal(persist.restoreFailurePhase(transient), "locked");
    assert.ok(stored(), "잠깐 끊긴 네트워크가 재로그인을 강요하면 안 된다");
  }
});
