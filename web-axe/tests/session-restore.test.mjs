/**
 * 탭 세션 보존의 경계 검증 — "새로고침 = 이어가기, 단 잠기지 않았을 때만" 을 지탱하는 저장 계약.
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
 *  · **재개 봉인은 잠금을 무력화할 수 있는 종류의 편의다.** 유휴 만료가 부팅에서 안 걸리면
 *    새로고침만으로 15분 잠금이 무한 연장되고, 잠금·로그아웃이 랩 키를 안 지우면 "잠갔는데
 *    새로고침 한 번에 열리는" 잠금이 된다. 어느 쪽도 화면에는 아무 흔적을 남기지 않는다.
 *
 * 브라우저 전역(sessionStorage·localStorage·indexedDB)은 Node 에 없으므로 최소 스텁을 여기서
 * 깐다. localStorage 스텁은 **쓰기를 시도하면 터진다** — 규칙 위반이 테스트 실패로 드러나게.
 * 크립토는 앱과 **같은 SDK/WebCrypto 인스턴스**를 쓴다 (봉인을 우리가 흉내내면 검증의 의미가
 * 없다 — 특히 랩 키의 non-extractable 성질은 실물이라야 검증된다).
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

/**
 * IndexedDB 최소 스텁 — 랩 키 보관의 계약만 흉내낸다: 비동기 요청, 최초 열기의 upgrade,
 * 그리고 **트랜잭션 커밋(oncomplete)에서 나오는 결과**. 마지막 항목이 중요하다 — 삭제는
 * 폐기 지점이라 "요청은 성공, 트랜잭션은 abort" 를 성공으로 읽으면 지워지지 않은 랩 키가
 * 조용히 남는다.
 */
function makeIndexedDb() {
  const dbs = new Map();
  return {
    dbs,
    open(name, version = 1) {
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        let db = dbs.get(name);
        if (!db) dbs.set(name, (db = { version: 0, stores: new Map() }));
        const stores = db.stores;
        const upgrade = version > db.version;
        req.result = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => stores.set(s, new Map()),
          deleteObjectStore: (s) => stores.delete(s),
          close: () => {},
          transaction: (store) => {
            const data = stores.get(store);
            const tx = { oncomplete: null, onerror: null, onabort: null };
            // 요청이 끝날 때마다 커밋하면 **소유권 확인 후 쓰기**(get → onsuccess 안에서 put)를
            // 흉내낼 수 없다. 진짜 IndexedDB 처럼 pending 이 0이 될 때 한 번만 커밋한다.
            let pending = 0;
            let settled = false;
            const request = (fn) => {
              const r = { result: undefined, onsuccess: null };
              pending += 1;
              setTimeout(() => {
                r.result = fn();
                r.onsuccess?.({ target: r }); // 여기서 새 요청을 걸면 pending 이 다시 오른다
                pending -= 1;
                if (pending === 0 && !settled) {
                  settled = true;
                  tx.oncomplete?.();
                }
              }, 0);
              return r;
            };
            tx.objectStore = () => ({
              put: (v, k) => request(() => void data.set(k, v)),
              get: (k) => request(() => data.get(k)),
              delete: (k) => request(() => void data.delete(k)),
              getAll: () => request(() => [...data.values()]),
            });
            return tx;
          },
        };
        if (upgrade) {
          db.version = version;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

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

/** 현재 테스트의 IndexedDB 스텁 — 스토어 내부를 직접 들여다볼 때 쓴다. */
let idb;
/** 스토어에 남은 레코드 (청소가 두 스토어를 함께 치우는지 보려면 이게 필요하다). */
const rows = (name) => [...(idb.dbs.get("axe-vault")?.stores.get(name)?.values() ?? [])];

beforeEach(() => {
  store.clear();
  sessionStub.setItem = (k, v) => store.set(k, String(v));
  // 매 테스트가 빈 IndexedDB 에서 시작한다 (탭도 프로필도 새것).
  idb = makeIndexedDb();
  globalThis.indexedDB = idb;
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

/**
 * 재개 봉인이 없는 저장분(= 잠긴 탭이 들고 있는 전부)의 필드. `resume` 은 금고가 열려 있는
 * 동안에만 붙으므로 이 목록에 없다 — 그 사실 자체가 계약이다.
 */
const SEALLESS_FIELDS = ["v", "email", "kdf", "encUserKey", "encTokens"];

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
    // 구 스키마(v2, 재개 봉인 개념 이전) — 마이그레이션하지 않고 버린다.
    JSON.stringify({ v: 2, ...FACTS(), encTokens: "2.a|b|c" }),
    JSON.stringify({ v: 3, ...FACTS() }), // 봉인 누락
    // 재개 봉인이 오염된 경우도 부분 복원하지 않는다.
    JSON.stringify({ v: 3, ...FACTS(), encTokens: "2.a|b|c", resume: { ct: "not base64!", iv: "AAAA" } }),
    JSON.stringify({ v: 3, ...FACTS(), encTokens: "2.a|b|c", resume: { ct: "AAAA" } }),
  ];
  for (const j of junk) {
    store.set("axe-vault.session", j);
    assert.equal(persist.loadSession(), null, `되살아나면 안 된다: ${j.slice(0, 40)}`);
    assert.equal(stored(), undefined, "쓸 수 없는 저장분은 지워져야 한다");
  }
});

// ------------------------------------------------------- 탭 수명 · 로그아웃

test("탭 계약 — 저장은 sessionStorage 의 axe-vault 이름공간에만 한다", async () => {
  const key = userKey();
  const s = persist.saveSession(FACTS(), TOKENS(), key);
  // localStorage 스텁이 쓰기에서 터지므로, 여기까지 왔다는 것 자체가 절반의 증명이다.
  assert.deepEqual([...store.keys()], ["axe-vault.session"]);
  assert.equal(persist.SESSION_KEY, "axe-vault.session");

  // 재개 봉인이 붙어도 이름공간 밖으로 나가지 않는다 (유휴 시계·탭 식별자까지 포함해서).
  await persist.armResume(s, TOKENS(), key);
  assert.deepEqual([...store.keys()].sort(), ["axe-vault.activity", "axe-vault.session", "axe-vault.tab"]);
  assert.equal(persist.ACTIVITY_KEY, "axe-vault.activity");
  assert.equal(persist.TAB_KEY, "axe-vault.tab");
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
  assert.deepEqual([...persist.SESSION_FIELDS], [...SEALLESS_FIELDS, "resume"], "허용 목록이 바뀌었다");
  persist.saveSession(FACTS(), TOKENS(), userKey());
  // 잠금 폴백 저장은 재개 봉인을 만들지 않는다 (그건 armResume 의 몫이다).
  assert.deepEqual(Object.keys(JSON.parse(stored())), SEALLESS_FIELDS);
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
  assert.deepEqual(Object.keys(JSON.parse(raw)), SEALLESS_FIELDS);
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
  assert.deepEqual(Object.keys(JSON.parse(stored())), SEALLESS_FIELDS);
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

// ------------------------------------------------ 재개 봉인 (새로고침 = 이어가기)

/**
 * 새로고침이 잠금 화면이 아니라 **쓰던 금고 화면**으로 돌아오게 하는 계층.
 *
 * 여기서 고정하는 것은 편의가 아니라 **그 편의의 한도**다: 봉인은 랩 키(브라우저가 들고 있고
 * JS 가 꺼낼 수 없는 CryptoKey)와 짝일 때만 열리고, 유휴 15분·수동 잠금·로그아웃·탭 닫기 중
 * 하나라도 일어나면 사라져야 한다. 하나라도 새면 "잠금" 이라는 말이 거짓이 된다.
 */
const armed = async (key = userKey(), tokens = TOKENS()) => {
  const s = persist.saveSession(FACTS(), tokens, key);
  const next = await persist.armResume(s, tokens, key);
  assert.ok(next?.resume, "봉인이 만들어지지 않았다");
  return { key, stored: next };
};

/**
 * 탭 = **자기 sessionStorage 를 가진 실행 단위**. IndexedDB 는 오리진이 공유한다 — 그래서
 * 랩 키를 슬롯 하나에 두면 한 탭의 로그아웃·재무장이 다른 탭의 봉인을 못 열게 만든다.
 * 여기서는 sessionStorage 스냅샷을 갈아 끼워 그 구조를 그대로 재현한다.
 */
const tabSnapshot = () => new Map(store);
const newTab = () => store.clear();
const enterTab = (snap) => {
  store.clear();
  for (const [k, v] of snap) store.set(k, v);
};
/** 그 탭인 척하고 슬롯을 들여다본다 (탭은 자기 슬롯만 읽을 수 있으므로). */
const slotOf = async (snap) => {
  const keep = tabSnapshot();
  enterTab(snap);
  const key = await persist.getWrapKey();
  enterTab(keep);
  return key;
};

test("새로고침 — 봉인이 살아 있으면 잠금이 아니라 이어가기로 부팅한다", async () => {
  const key = userKey();
  const s = persist.saveSession(FACTS(), TOKENS(), key);
  assert.equal(persist.restoreSession().phase, "locked", "봉인 전에는 잠금이 맞다");

  await persist.armResume(s, TOKENS(), key);

  // 새로고침 = 같은 sessionStorage·같은 IndexedDB 를 다시 읽는 것.
  const boot = persist.restoreSession();
  assert.equal(boot.phase, "resuming");

  const payload = await persist.takeResume(boot.session);
  assert.deepEqual([...payload.userKey], [...key], "유저키가 봉인을 그대로 통과해야 한다");
  assert.deepEqual(payload.tokens, TOKENS());

  // 그 재료로 곧바로 채택된다 — 마스터 패스워드를 한 번도 묻지 않고 금고 화면으로 간다.
  const adoption = session.prepareAdoption(RAW_SYNC(), FACTS(), payload.tokens, payload.userKey);
  assert.equal(adoption.data.items.length, 0);
  assert.equal(session.staleSessionMetadata(RAW_SYNC(), FACTS()), false);
});

test("유휴 15분이 지난 새로고침은 이어가지 않는다 — 봉인을 걷고 잠금으로", async () => {
  const { key } = await armed();
  assert.equal(persist.restoreSession().phase, "resuming");

  // 방치. 유휴 타이머는 새로고침으로 사라지므로 **이 부팅 검사가 유일한 방어**다.
  const boot = persist.restoreSession(Date.now() + persist.IDLE_LOCK_MS + 1);
  assert.equal(boot.phase, "locked");
  assert.equal(boot.session.resume, undefined, "만료된 봉인이 저장분에 남았다");
  assert.equal(store.get("axe-vault.activity"), undefined, "만료된 유휴 시계가 남았다");

  // 잠금 폴백은 그대로다 — 마스터 패스워드로 열 수 있어야 한다.
  assert.deepEqual(persist.unsealTokens(persist.loadSession(), key), TOKENS());
  // 그리고 부팅의 고아 청소가 랩 키까지 지운다 (암호문이 없으니 열 것이 없다).
  const me = tabSnapshot();
  await persist.dropResume();
  assert.equal(await slotOf(me), null);
});

test("자기 탭의 고아 슬롯은 부팅이 바로 지운다 (봉인만 걷힌 경우)", async () => {
  await armed();
  const me = tabSnapshot();
  assert.ok(await persist.getWrapKey());

  // 봉인만 사라진 상태 = 이 탭의 랩 키로는 열 것이 없다.
  persist.clearResumeSeal();
  assert.equal(persist.restoreSession().phase, "locked");

  await persist.dropResume();
  assert.equal(await slotOf(me), null, "열 것이 없는 랩 키가 남았다");
});

test("로그아웃 — sessionStorage 도 IndexedDB 도 잔존 0", async () => {
  await armed();
  const me = tabSnapshot();
  assert.ok(store.size > 0 && (await persist.getWrapKey()));

  persist.clearSession();
  await persist.dropResume();

  assert.equal(store.size, 0, "탭에 남은 것이 있다");
  assert.equal(await slotOf(me), null, "이 탭의 랩 키가 남았다");
  assert.equal(persist.restoreSession().phase, "login");
});

test("잠금 — 재개 봉인만 폐기하고 잠금 폴백은 남긴다", async () => {
  const { key } = await armed();
  const me = tabSnapshot();
  await persist.dropResume();

  assert.equal(await slotOf(me), null);
  const left = persist.loadSession();
  assert.equal(left.resume, undefined);
  assert.equal(persist.restoreSession().phase, "locked", "잠갔는데 새로고침이 다시 열면 잠금이 아니다");
  assert.deepEqual(persist.unsealTokens(left, key), TOKENS(), "폴백까지 지웠다면 그건 로그아웃이다");
});

test("언랩 실패는 이어가지 않고 잠금으로 폴백한다 (랩 키 없음·다른 랩 키·암호문 변조)", async () => {
  const first = await armed();

  // (1) 랩 키만 사라진 경우 (프로필 정리·저장소 축출)
  await persist.deleteWrapKey();
  assert.equal(await persist.takeResume(first.stored), null);

  // (2) 다른 세션의 랩 키로는 열리지 않는다 — 봉인마다 새 랩 키를 만든다.
  const second = await armed();
  assert.equal(await persist.takeResume(first.stored), null, "옛 봉인이 새 랩 키로 열렸다");

  // (3) 암호문이 한 바이트라도 어긋나면 AES-GCM 이 거절한다 (인증 암호).
  const tampered = { ...second.stored, resume: { ...second.stored.resume, ct: flip(second.stored.resume.ct) } };
  assert.equal(await persist.takeResume(tampered), null);
  const ivTampered = { ...second.stored, resume: { ...second.stored.resume, iv: flip(second.stored.resume.iv) } };
  assert.equal(await persist.takeResume(ivTampered), null);

  // 어느 경우든 마스터 패스워드 경로는 멀쩡하다.
  assert.deepEqual(persist.unsealTokens(persist.loadSession(), second.key), TOKENS());
});

const flip = (b64) => (b64[0] === "A" ? "B" : "A") + b64.slice(1);

test("IndexedDB 가 없거나 막혀도 크래시 없이 잠금 동작으로 폴백한다", async () => {
  const key = userKey();
  const s = persist.saveSession(FACTS(), TOKENS(), key);

  const broken = [
    undefined, // 지원하지 않는 환경
    {
      open() {
        throw new DOMException("The operation is insecure.", "SecurityError"); // 정책·프라이빗 모드
      },
    },
    {
      open() {
        const req = {};
        setTimeout(() => req.onerror?.(), 0); // 열기 실패
        return req;
      },
    },
  ];

  for (const idb of broken) {
    globalThis.indexedDB = idb;
    assert.equal(await persist.armResume(s, TOKENS(), key), null, "봉인 못 하면 null 이어야 한다 (예외 아님)");
    assert.equal(persist.loadSession().resume, undefined, "열지 못할 봉인을 저장분에 남겼다");
    assert.equal(persist.restoreSession().phase, "locked", "저장소가 막혔다고 부팅이 죽으면 안 된다");
    assert.equal(await persist.takeResume({ ...s, resume: { ct: "AAAA", iv: "AAAA" } }), null);
    await assert.doesNotReject(() => persist.dropResume());
  }

  // 잠금 폴백은 그대로 — 마스터 패스워드로 여는 길은 IndexedDB 와 무관하다.
  assert.deepEqual(persist.unsealTokens(persist.loadSession(), key), TOKENS());
});

/**
 * `extractable: false` 가 보장하는 것은 **이 페이지의 JS 가 키 바이트를 읽어 낼 수 없다**는 것
 * 하나뿐이다. 브라우저 프로필·디스크를 가진 공격자에 대한 at-rest 보호가 아니다 — 그렇게 읽히는
 * 문구를 코드·화면에 쓰지 않는다(persist.ts 머리 "막는 것과 막지 않는 것").
 */
test("랩 키는 이 페이지가 꺼낼 수 없다 (exportKey 거부)", async () => {
  await armed();
  const wrap = await persist.getWrapKey();

  assert.equal(wrap.extractable, false, "extractable 랩 키는 이 설계의 전제를 깬다");
  await assert.rejects(() => crypto.subtle.exportKey("raw", wrap), "랩 키가 export 됐다");
  await assert.rejects(() => crypto.subtle.exportKey("jwk", wrap));
});

test("재개 봉인 밖으로 유저키·토큰이 새지 않는다", async () => {
  const key = userKey();
  await persist.armResume(persist.saveSession(FACTS(), TOKENS(), key), TOKENS(), key);

  const raw = dump();
  const plainUserKey = btoa(String.fromCharCode(...key));
  for (const forbidden of [ACCESS_TOKEN, REFRESH_TOKEN, plainUserKey, "accessToken", "refreshToken", "userKey"]) {
    assert.ok(!raw.includes(forbidden), `재개 봉인 밖으로 ${forbidden.slice(0, 24)} 가 새어 나갔다`);
  }
  // 봉인은 base64 두 조각뿐이고, 그 둘만으로는 아무것도 열리지 않는다 (랩 키가 있어야 한다).
  const seal = JSON.parse(stored()).resume;
  assert.deepEqual(Object.keys(seal).sort(), ["ct", "iv"]);
  assert.match(seal.iv, /^[A-Za-z0-9+/]+={0,2}$/);
});

test("봉인 도중 잠금이 끼어들면 봉인도 랩 키도 남지 않는다", async () => {
  const key = userKey();
  const s = persist.saveSession(FACTS(), TOKENS(), key);

  // (a) 평문을 만들기도 전에 잠긴 경우. 이 확인이 없으면 **0으로 덮어쓴 유저키**가 봉인돼
  //     다음 새로고침이 "열렸는데 아무것도 못 푸는" 금고가 된다.
  assert.equal(await persist.armResume(s, TOKENS(), key, () => false), null);
  assert.equal(await persist.getWrapKey(), null, "쓰지 않을 랩 키를 남겼다");
  assert.equal(persist.loadSession().resume, undefined);

  // (b) 봉인은 끝났는데 저장 직전에 잠긴 경우 — 두 번째 확인이 잡는다.
  let checks = 0;
  assert.equal(await persist.armResume(s, TOKENS(), key, () => ++checks === 1), null);
  assert.equal(checks, 2, "확인은 두 번이어야 한다 (평문 직전 + 쓰기 직전)");
  assert.equal(await persist.getWrapKey(), null);
  assert.equal(persist.loadSession().resume, undefined);
  assert.equal(persist.restoreSession().phase, "locked");
});

test("유휴 시계 — 표식이 없거나 읽을 수 없으면 만료로 본다", () => {
  const t0 = 1_700_000_000_000;
  assert.equal(persist.idleExpired(t0), true, "표식 없는 봉인 = 언제부터 방치됐는지 모르는 봉인");

  persist.markActivity(t0);
  assert.equal(persist.idleExpired(t0 + persist.IDLE_LOCK_MS - 1), false);
  assert.equal(persist.idleExpired(t0 + persist.IDLE_LOCK_MS), true, "한도에 닿으면 만료다");
  assert.equal(persist.IDLE_LOCK_MS, session.IDLE_LOCK_MS, "유휴 한도는 앱 전체에서 한 숫자여야 한다");

  store.set("axe-vault.activity", "어제쯤");
  assert.equal(persist.idleExpired(t0), true);
});

// ------------------------------------------------------- 탭별 슬롯 (탭 간 간섭 차단)

/**
 * 금고를 여러 탭으로 여는 것은 흔한 사용이다. 랩 키를 오리진 전역 슬롯 하나에 두면
 * **한 탭의 정상 동작이 다른 탭의 금고를 잠가 버린다** — A 의 로그아웃이 키를 지우고, A 의
 * 재무장이 키를 덮고, A 의 고아 청소가 B 의 키를 치운다. 화면에는 "새로고침했더니 갑자기
 * 마스터 패스워드를 묻는다" 로만 보여서, 원인을 찾을 단서가 없다.
 *
 * 그래서 슬롯을 탭별로 가른다. 대가는 **다른 탭의 슬롯을 직접 판정할 수 없다**는 것이다 —
 * 그 탭의 암호문은 그 탭의 sessionStorage 에 있다. 그 자리를 `lastSeen` 나이가 메운다.
 */
test("탭 A 의 로그아웃이 탭 B 의 이어가기를 깨뜨리지 않는다", async () => {
  const a = await armed();
  const tabA = tabSnapshot();

  // 탭 B — 같은 오리진의 다른 탭 (sessionStorage 는 자기 것, IndexedDB 는 공유).
  newTab();
  const b = await armed();
  const tabB = tabSnapshot();
  assert.notEqual(tabA.get("axe-vault.tab"), tabB.get("axe-vault.tab"), "두 탭이 같은 슬롯을 쓴다");

  // 탭 A 에서 로그아웃.
  enterTab(tabA);
  persist.clearSession();
  await persist.dropResume();
  assert.equal(await slotOf(tabA), null, "A 는 자기 슬롯을 지웠어야 한다");

  // 탭 B 는 아무 일도 없었다는 듯 이어간다.
  enterTab(tabB);
  assert.equal(persist.restoreSession().phase, "resuming");
  const payload = await persist.takeResume(b.stored);
  assert.ok(payload, "A 의 로그아웃이 B 의 봉인을 못 열게 만들었다");
  assert.deepEqual([...payload.userKey], [...b.key]);
  assert.notDeepEqual([...b.key], [...a.key], "두 탭이 같은 키를 봉인했다 — 시나리오가 무의미하다");
});

test("고아 청소는 살아 있는 다른 탭의 슬롯을 지우지 않는다", async () => {
  newTab();
  const b = await armed();
  const tabB = tabSnapshot();

  // 탭 A — 봉인 없는 부팅(로그인 화면). 자기 슬롯 폐기 + 죽은 슬롯 청소를 한다.
  newTab();
  assert.equal(persist.restoreSession().phase, "login");
  await persist.dropResume();
  await persist.sweepStaleWrapSlots();

  enterTab(tabB);
  assert.ok(await persist.getWrapKey(), "최근까지 살아 있던 탭의 슬롯을 지웠다");
  assert.ok(await persist.takeResume(b.stored), "B 가 이어가지 못하게 됐다");
});

test("유휴 마감 + 여유를 넘도록 조용한 슬롯은 청소된다 (탭이 청소 없이 사라진 경우)", async () => {
  const t0 = Date.now();
  newTab();
  await armed();
  const dead = tabSnapshot();

  // 그 탭이 강제 종료됐다 = 암호문(sessionStorage)은 사라지고 슬롯만 남는다.
  newTab();
  await persist.sweepStaleWrapSlots(t0 + persist.STALE_SLOT_MS - 5000);
  assert.ok(await slotOf(dead), "아직 마감+여유를 넘지 않았는데 지웠다");

  await persist.sweepStaleWrapSlots(t0 + persist.STALE_SLOT_MS + 5000);
  assert.equal(await slotOf(dead), null, "죽은 탭의 슬롯이 남았다");
  assert.equal(persist.STALE_SLOT_MS, persist.IDLE_LOCK_MS + persist.SLOT_GRACE_MS);
});

test("활동이 슬롯의 생존 신호를 갱신한다 (살아 있는 탭이 청소되지 않는 이유)", async () => {
  const t0 = Date.now();
  newTab();
  await armed();
  const live = tabSnapshot();

  // 마감선 직전의 활동 — 유휴 잠금은 이걸로 연장되고, 슬롯 나이도 같이 젊어져야 한다.
  persist.markActivity(t0 + persist.STALE_SLOT_MS - 1000);
  await new Promise((r) => setTimeout(r, 20)); // 생존 신호는 비동기다

  newTab();
  await persist.sweepStaleWrapSlots(t0 + persist.STALE_SLOT_MS + 5000);
  assert.ok(await slotOf(live), "활동을 보고했는데도 살아 있는 탭의 슬롯이 청소됐다");
});

test("하트비트는 키 레코드를 건드리지 않는다 (재무장과 겹쳐도 새 랩 키가 살아남는다)", async () => {
  const first = await armed();

  // 하트비트를 먼저 띄우고(비동기), 그 사이에 재무장이 새 랩 키를 쓴다. 생존 신호가 키와 한
  // 레코드에 있으면 하트비트의 read-modify-write 가 **새 키를 옛 키로 되돌린다**.
  persist.markActivity(Date.now() + 10 * 60 * 1000);
  const second = await armed();
  await new Promise((r) => setTimeout(r, 30)); // 하트비트가 늦게 착지

  const payload = await persist.takeResume(second.stored);
  assert.ok(payload, "하트비트가 새 랩 키를 옛 키로 되돌렸다");
  assert.deepEqual([...payload.userKey], [...second.key]);
  assert.equal(await persist.takeResume(first.stored), null, "옛 봉인이 되살아났다");

  // 키 레코드에는 생존 시각이 없다 — 애초에 공유하지 않는다.
  assert.deepEqual(Object.keys(rows("wrap")[0]).sort(), ["id", "key", "owner"]);
  assert.equal(rows("beat").length, 1);
});

test("탭 복제 — 나중 인스턴스가 슬롯을 소유하고 이전 인스턴스의 쓰기는 무시된다", async () => {
  const { key, stored } = await armed();

  // 탭 복제 = sessionStorage(탭 식별자·봉인)가 그대로 복사된 **다른 실행 인스턴스**.
  // 논스는 메모리에만 있으므로 모듈을 새로 적재하면 그 상황이 된다.
  const dup = await import("../src/lib/persist.ts?instance=dup");

  // 복제 탭은 그 봉인을 정당하게 연다 (같은 탭의 복사본이다) — 그리고 소유권을 가져간다.
  const dupPayload = await dup.takeResume(stored);
  assert.ok(dupPayload, "복제 탭이 자기 봉인을 열지 못했다");
  assert.deepEqual([...dupPayload.userKey], [...key]);

  // 원본 인스턴스의 쓰기는 이제 걸러진다 → 봉인을 갱신하지 못하고 잠금으로 폴백한다.
  assert.equal(await persist.armResume(stored, TOKENS(), key), null, "소유권을 잃은 인스턴스가 슬롯을 덮어썼다");
  assert.deepEqual(persist.loadSession().resume, stored.resume, "덮어쓰지 못했으면 저장분도 그대로여야 한다");

  // 삭제도 마찬가지 — 남의 슬롯은 치우지 않는다.
  const id = store.get("axe-vault.tab");
  await persist.dropResume();
  store.set("axe-vault.tab", id); // 복제 탭의 sessionStorage 는 원본과 별개다
  assert.ok(await dup.getWrapKey(), "소유권을 잃은 인스턴스가 복제 탭의 랩 키를 지웠다");
  assert.ok(await dup.takeResume(stored), "복제 탭이 이어가지 못하게 됐다");
});

test("고아 청소는 슬롯과 생존 신호를 함께 치운다", async () => {
  const t0 = Date.now();
  newTab();
  await armed();
  const dead = tabSnapshot();
  assert.equal(rows("wrap").length, 1);
  assert.equal(rows("beat").length, 1);

  // 그 탭이 청소 없이 사라졌다 (강제 종료·크래시).
  newTab();
  await persist.sweepStaleWrapSlots(t0 + persist.STALE_SLOT_MS + 5000);

  assert.equal(await slotOf(dead), null, "죽은 탭의 슬롯이 남았다");
  assert.deepEqual(rows("wrap"), [], "wrap 스토어에 잔재가 남았다");
  assert.deepEqual(rows("beat"), [], "beat 스토어에 잔재가 남았다");
});

test("같은 탭의 새로고침은 같은 슬롯을 다시 쓴다", async () => {
  const { key } = await armed();
  const id = store.get("axe-vault.tab");
  assert.ok(id, "봉인을 건 탭은 식별자를 가져야 한다");

  // 새로고침 = 같은 sessionStorage 를 그대로 다시 읽는 것 (탭 식별자 포함).
  const boot = persist.restoreSession();
  assert.equal(boot.phase, "resuming");
  assert.equal(store.get("axe-vault.tab"), id, "새로고침이 탭 식별자를 갈아 치웠다");
  assert.deepEqual([...(await persist.takeResume(boot.session)).userKey], [...key]);
});

/**
 * 이어가기 한 건의 결말(openResume). 여기서 막는 것은 **더 최근의 지시가 뒤집히는 일**이다:
 *  · 사용자가 "기다리지 않고 마스터 패스워드로 열기" 를 눌렀는데(또는 잠금·로그아웃) 진행
 *    중이던 이어가기가 나중에 완료돼 금고를 열어 버리면, 화면은 멀쩡하지만 사용자가 내린
 *    지시가 조용히 무시된 것이다.
 *  · 마감 직전에 시작한 이어가기가 sync 왕복 동안 마감선을 넘어 열리면, 유휴 잠금은 왕복
 *    시간만큼 늘어나는 잠금이 된다.
 */
test("이어가기 취소 — 봉인을 읽는 중 취소되면 뒤늦은 완료가 금고를 열지 않는다", async () => {
  const { stored } = await armed();
  const facts = FACTS();

  const attempt = session.startAttempt(() => 0);
  // 이 시도가 봉인에서 유도해 낸 비밀을 잡아 둔다 (함수 밖에서는 보이지 않는다).
  const derived = [];
  const push = attempt.secrets.push.bind(attempt.secrets);
  attempt.secrets.push = (...keys) => (derived.push(...keys), push(...keys));

  const origFetch = globalThis.fetch;
  let synced = false;
  globalThis.fetch = async () => {
    synced = true;
    return res(200, syncFor(facts.encUserKey, facts.email));
  };
  try {
    const inflight = session.openResume(stored, facts, attempt, () => assert.fail("취소된 시도가 저장분을 갱신했다"));
    // 출구 버튼·유휴 잠금·로그아웃이 하는 일이 정확히 이 취소다.
    session.cancelAttempt(attempt);

    const outcome = await inflight;
    // "abandon" = 훅이 아무 setState 도 하지 않는 결말 (phase 는 취소가 정한 그대로 남는다).
    assert.equal(outcome.kind, "abandon", "취소된 시도가 채택 재료를 내놨다");
    assert.equal(synced, false, "취소했는데 서버 왕복이 일어났다");
    assert.equal(derived.length, 1, "봉인에서 유도한 키를 시도에 등록하지 않았다 (취소가 못 지운다)");
    assert.ok(zeroed(derived[0]), "취소했는데 뒤늦게 도착한 유저키가 살아 있다");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("이어가기 취소 — sync 왕복 중 취소도 같은 결말이다", async () => {
  const { stored } = await armed();
  const facts = FACTS();
  const attempt = session.startAttempt(() => 0);

  let release;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (_url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      release = resolve;
    });
  try {
    const inflight = session.openResume(stored, facts, attempt, () => {});
    // 왕복이 끝나기 전에 잠금이 들어온다.
    await new Promise((r) => setTimeout(r, 10));
    session.cancelAttempt(attempt);

    assert.equal((await inflight).kind, "abandon");
    assert.equal(attempt.controller.signal.aborted, true, "진행 중 왕복이 실제로 끊기지 않았다");
    assert.equal(attempt.secrets.length, 0);
    release?.(res(200, syncFor(facts.encUserKey, facts.email)));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("이어가기 — sync 왕복 동안 유휴 마감선을 넘으면 채택하지 않고 잠근다", async () => {
  const { stored } = await armed();
  const facts = FACTS();

  const origFetch = globalThis.fetch;
  // 마감 직전에 시작한 이어가기 = 왕복 도중에 마감선이 지나간다 (탭 절전·느린 서버).
  globalThis.fetch = async () => {
    persist.markActivity(Date.now() - persist.IDLE_LOCK_MS - 1);
    return res(200, syncFor(facts.encUserKey, facts.email));
  };
  try {
    const outcome = await session.openResume(stored, facts, session.startAttempt(() => 0), () => {});
    assert.equal(outcome.kind, "lock", "마감선을 넘긴 세션이 열렸다 — 부팅 1회 검사만으로는 부족하다");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("이어가기 — 마감선 안이면 채택 재료를 그대로 내준다 (마스터 패스워드를 묻지 않는다)", async () => {
  const { key, stored } = await armed();
  const facts = FACTS();

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => res(200, syncFor(facts.encUserKey, facts.email));
  try {
    const outcome = await session.openResume(stored, facts, session.startAttempt(() => 0), () => {});
    assert.equal(outcome.kind, "adopt");
    assert.deepEqual([...outcome.userKey], [...key], "봉인이 돌려준 유저키가 원본과 다르다");
    assert.deepEqual(outcome.tokens, TOKENS());
    assert.equal(session.prepareAdoption(outcome.raw, facts, outcome.tokens, outcome.userKey).data.items.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("토큰이 회전되면 봉인도 회전분으로 다시 걸린다 (죽은 토큰을 이어가지 않는다)", async () => {
  const key = userKey();
  const first = await armed(key, TOKENS());

  const rotated = { accessToken: ROTATED_ACCESS, refreshToken: ROTATED_REFRESH };
  // 회전은 항상 채택(saveSession → armResume)으로 끝난다 — 그 순서를 그대로 재현한다.
  const saved = persist.saveSession(FACTS(), rotated, key);
  const next = await persist.armResume(saved, rotated, key);

  assert.deepEqual((await persist.takeResume(next)).tokens, rotated);
  assert.equal(await persist.takeResume(first.stored), null, "옛 봉인이 아직 열린다 = 죽은 토큰이 살아 있다");
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
