/**
 * SSO 네이티브 흐름의 경계 검증.
 *
 * 왜 이것들인가 — 전부 **배포 후에야 드러나는** 종류라서다:
 *  · 콜백 분기: 우리가 시작한 흐름을 classic 으로 넘겨 버리면 SSO 가 조용히 두 번 시작하고,
 *    반대로 남이 시작한 흐름을 가로채면 verifier 가 없어 영영 못 끝낸다.
 *  · PKCE: 서버는 S256 만 받고(identity.rs:1292) 그 검증은 IdP 와 서버에서 일어나므로,
 *    challenge 계산이 틀리면 리다이렉트를 다 돌고 나서야 실패한다.
 *  · 교환 요청 구성: 필드 하나가 빠지면 서버가 "cannot be blank" 로 끊는다.
 *
 * 브라우저 전역(sessionStorage·crypto·location·btoa)은 Node 에 없거나 다르므로 최소 스텁을
 * 이 파일에서 깐다. crypto.subtle 은 Node 것을 그대로 쓴다 — SHA-256 을 우리가 흉내내면
 * 검증의 의미가 사라진다.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const ORIGIN = "https://vault.axelabs.ai";

// --- 브라우저 전역 스텁 (import 전에 깔아야 모듈 최상단 평가가 통과한다) ---
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.location = { origin: ORIGIN, hash: "", pathname: "/", search: "" };
// globalThis.crypto 는 Node 가 이미 webcrypto 로 제공한다 (getter-only — 덮어쓸 수 없다).

let sso;
let auth;
let api;

before(async () => {
  sso = await import("../src/lib/sso.ts");
  auth = await import("../src/lib/auth.ts");
  api = await import("../src/lib/api.ts");
});

// ---------------------------------------------------------------- 콜백 분기

test("우리가 시작한 흐름(state 일치)은 네이티브로 처리한다", () => {
  const route = sso.ssoRoute("#/sso?code=CODE-1&state=OUR-STATE", {
    state: "OUR-STATE",
    verifier: "OUR-VERIFIER",
  });
  assert.equal(route.kind, "native");
  assert.equal(route.code, "CODE-1");
  assert.equal(route.verifier, "OUR-VERIFIER");
});

test("남이 시작한 흐름(state 불일치·부재)은 classic 포워딩을 유지한다", () => {
  const hash = "#/sso?code=CODE-1&state=SOMEONE-ELSE";
  const cases = [
    { state: "OUR-STATE", verifier: "V" }, // 다른 탭/오리진에서 시작
    { state: null, verifier: null }, // 이 탭은 아무것도 시작한 적 없다
    { state: "SOMEONE-ELSE", verifier: null }, // state 만 남고 verifier 유실
  ];
  for (const stored of cases) {
    const route = sso.ssoRoute(hash, stored);
    assert.equal(route.kind, "forward", `forward 였어야 한다: ${JSON.stringify(stored)}`);
    // 원문 보존 — code/state 가 소실되면 저쪽에서도 교환이 불가능해진다.
    assert.ok(route.target.endsWith(hash));
  }
});

test("code 나 state 가 없는 #/sso 는 네이티브로 처리하지 않는다", () => {
  for (const hash of ["#/sso", "#/sso?code=only", "#/sso?state=only"]) {
    const route = sso.ssoRoute(hash, { state: "only", verifier: "V" });
    assert.equal(route.kind, "forward", `forward 였어야 한다: ${hash}`);
  }
});

test("SSO 콜백이 아닌 hash 는 아무 분기도 타지 않는다", () => {
  for (const hash of ["", "#/", "#/vault", "#/ssoconfig", "#/login?sso=1"]) {
    assert.equal(sso.ssoRoute(hash, { state: "S", verifier: "V" }).kind, "none", hash);
  }
});

test("takeSsoRoute 는 판정과 동시에 핸드셰이크를 소비한다 (재생 방지)", () => {
  store.clear();
  sessionStorage.setItem("axe-vault.sso-state", "S1");
  sessionStorage.setItem("axe-vault.sso-verifier", "V1");

  const first = sso.takeSsoRoute("#/sso?code=C&state=S1");
  assert.equal(first.kind, "native");
  assert.equal(first.verifier, "V1");

  // 두 번째 호출은 저장된 게 없으므로 더 이상 네이티브가 아니다.
  const second = sso.takeSsoRoute("#/sso?code=C&state=S1");
  assert.equal(second.kind, "forward");
  assert.equal(sessionStorage.getItem("axe-vault.sso-verifier"), null);
});

test("SSO 콜백이 아니면 핸드셰이크를 지우지 않는다 (진행 중 흐름 보호)", () => {
  store.clear();
  sessionStorage.setItem("axe-vault.sso-state", "S1");
  sessionStorage.setItem("axe-vault.sso-verifier", "V1");
  assert.equal(sso.takeSsoRoute("#/vault").kind, "none");
  assert.equal(sessionStorage.getItem("axe-vault.sso-verifier"), "V1");
});

// ------------------------------------------------- 도착 흐름 수명 (회귀: 로그아웃 고착)

/** App 이 하는 일 그대로 — phase 가 바뀔 때마다 한 걸음씩 밟는다. */
function walk(handoff, phases) {
  let flow = sso.ssoFlowStart(handoff);
  for (const p of phases) flow = sso.ssoFlowStep(flow, p);
  return flow;
}

const HANDOFF = { code: "C", verifier: "V" };

test("회귀: SSO 완료 → 로그아웃 → 로그인 화면 (빈 SSO 화면에 고착되지 않는다)", () => {
  // login(교환 중) → locked(인증 완료, 잠금해제 대기) → login(로그아웃)
  const flow = walk(HANDOFF, ["login", "locked", "login"]);
  assert.equal(flow.handoff, null, "핸드오프가 살아 있으면 이미 쓴 code 로 SSO 화면이 되살아난다");
  assert.equal(flow.authenticated, false);
});

test("교환이 끝나기 전(phase 계속 login)에는 핸드오프가 살아 있다", () => {
  // 2FA 코드를 받는 동안 phase 는 "login" 에 머문다 — 여기서 폐기하면 흐름이 끊긴다.
  const flow = walk(HANDOFF, ["login", "login", "login"]);
  assert.deepEqual(flow.handoff, HANDOFF);
  assert.equal(flow.authenticated, false);
});

test("금고가 열리면 도착 흐름은 끝난다 — 이후 유휴 잠금이 SSO 화면을 되살리지 않는다", () => {
  const opened = walk(HANDOFF, ["login", "locked", "unlocked"]);
  assert.equal(opened.handoff, null);
  // 그 뒤 유휴 잠금으로 다시 locked 가 돼도 되살아나지 않는다.
  assert.equal(sso.ssoFlowStep(opened, "locked").handoff, null);
});

test("ssoFlowStep 은 멱등이다 (StrictMode 이중 렌더 안전)", () => {
  for (const phase of ["login", "locked", "unlocked"]) {
    const once = walk(HANDOFF, ["locked", phase]);
    const twice = sso.ssoFlowStep(once, phase);
    assert.deepEqual(twice, once, `phase=${phase}`);
  }
});

test("SSO 없이 부팅하면(handoff null) 어떤 phase 에서도 SSO 화면이 뜨지 않는다", () => {
  for (const phase of ["login", "locked", "unlocked"]) {
    assert.equal(walk(null, [phase]).handoff, null);
  }
});

// ---------------------------------------------------------------- PKCE

test("PKCE: challenge = base64url(SHA-256(verifier)), 패딩 없음", async () => {
  const { verifier, challenge } = await sso.createPkce();

  // RFC 7636: verifier 는 43~128자의 unreserved 문자.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `길이 ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);

  // 독립 계산과 바이트 단위로 같아야 한다 (여기가 틀리면 IdP 가 마지막에 거절한다).
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const expected = Buffer.from(digest).toString("base64url");
  assert.equal(challenge, expected);
  assert.ok(!challenge.includes("="), "패딩이 남으면 안 된다");
});

test("PKCE 고정 벡터 — RFC 7636 Appendix B", async () => {
  assert.equal(
    await sso.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("state·verifier 는 URL 안전 문자만 쓴다 (커넥터가 인코딩 없이 이어 붙인다)", () => {
  for (let i = 0; i < 20; i++) {
    assert.match(sso.randomToken(24), /^[A-Za-z0-9\-_]+$/);
  }
});

// ---------------------------------------------------------------- 요청 구성

test("authorize URL — 서버 필수 필드와 스톡 web-vault 파라미터를 모두 만족한다", () => {
  const url = new URL(
    sso.authorizeUrl({
      state: "STATE",
      challenge: "CHALLENGE",
      ssoToken: "SSO-TOKEN",
      identityUrl: `${ORIGIN}/identity`,
      origin: ORIGIN,
    }),
  );
  assert.equal(url.origin + url.pathname, `${ORIGIN}/identity/connect/authorize`);

  const q = url.searchParams;
  // identity.rs 의 AuthorizeData 가 Option 이 아닌 필드 = 없으면 400.
  for (const required of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]) {
    assert.ok(q.get(required), `필수 파라미터 누락: ${required}`);
  }
  assert.equal(q.get("client_id"), "web");
  assert.equal(q.get("code_challenge_method"), "S256", "서버는 S256 외를 거부한다");
  assert.equal(q.get("scope"), "api offline_access");
  assert.equal(q.get("state"), "STATE");
  assert.equal(q.get("ssoToken"), "SSO-TOKEN");
  // state 에 _returnUri 를 붙이면 커넥터가 우리를 #/sso 가 아닌 곳으로 보낸다.
  assert.ok(!q.get("state").includes("_returnUri"));
});

test("교환 요청 — grant_type=authorization_code 에 서버가 요구하는 필드가 전부 실린다", async () => {
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: new URLSearchParams(init.body) });
    return new Response(
      JSON.stringify({ access_token: "AT", Kdf: 0, KdfIterations: 600000, Key: "2.x|y|z" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const result = await sso.exchangeSsoCode("CODE", "VERIFIER", "123 456");
    assert.equal(result.accessToken, "AT");
    // KDF 는 prelogin 이 아니라 토큰 응답에서 온다 (identity.rs authenticated_response).
    assert.deepEqual(result.kdf, { pBKDF2: { iterations: 600000 } });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${ORIGIN}/identity/connect/token`);
  const b = sent[0].body;
  assert.equal(b.get("grant_type"), "authorization_code");
  assert.equal(b.get("code"), "CODE");
  assert.equal(b.get("code_verifier"), "VERIFIER");
  assert.equal(b.get("client_id"), "web");
  assert.equal(b.get("scope"), "api offline_access", "check_scope 는 완전일치를 본다");
  assert.equal(b.get("deviceType"), String(api.DEVICE_TYPE));
  assert.equal(b.get("deviceName"), api.DEVICE_NAME);
  assert.ok(b.get("deviceIdentifier"), "device_identifier cannot be blank");
  // 2FA 코드의 공백은 서버로 가기 전에 정리된다.
  assert.equal(b.get("twoFactorToken"), "123456");
  assert.equal(b.get("twoFactorProvider"), "0");
  assert.equal(b.get("twoFactorRemember"), "0", "기억 토큰은 영속 저장을 전제 — 항상 끈다");
});

test("서버가 2FA 를 요구하면 TwoFactorRequiredError 로 정규화된다 (같은 code 로 재시도 가능)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ TwoFactorProviders: [0], error: "invalid_grant" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(
      () => sso.exchangeSsoCode("CODE", "VERIFIER"),
      (e) => e instanceof auth.TwoFactorRequiredError && e.providers.includes(0),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("제출한 2FA 코드가 거절되면 침묵하지 않는다 (서버 설명 보존)", () => {
  // 서버는 최초 요구와 코드 거절을 같은 모양으로 답한다 — 제출 여부로만 갈린다.
  const err = new auth.TwoFactorRequiredError([0], "Two-step token is invalid. Try again.");

  // 최초 요구: 아직 아무것도 제출하지 않았다 → 에러가 아니라 챌린지다.
  assert.equal(auth.twoFactorRejection(err, undefined), null);
  assert.equal(auth.twoFactorRejection(err, "   "), null);

  // 제출 후 같은 요구 = 거절. 서버 설명을 그대로 보여 준다.
  assert.equal(auth.twoFactorRejection(err, "123456"), "Two-step token is invalid. Try again.");

  // 서버가 설명을 안 줬어도 사용자는 무슨 일이 났는지 알아야 한다.
  const bare = new auth.TwoFactorRequiredError([0]);
  assert.match(auth.twoFactorRejection(bare, "123456"), /인증 코드/);
});

test("2FA 요구 에러는 서버 설명을 싣고 온다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ TwoFactorProviders: [0], error_description: "Two-step token is invalid." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(
      () => sso.exchangeSsoCode("CODE", "VERIFIER", "000000"),
      (e) => {
        assert.equal(e.detail, "Two-step token is invalid.");
        assert.equal(auth.twoFactorRejection(e, "000000"), "Two-step token is invalid.");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("access_token 이 없는 응답은 조용히 통과하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ Kdf: 0, KdfIterations: 600000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(() => sso.exchangeSsoCode("CODE", "VERIFIER"), /access_token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
