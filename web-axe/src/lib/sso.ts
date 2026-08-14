/**
 * SSO(Entra) 로그인 — 이 오리진에서 끝내는 네이티브 구현.
 *
 * 흐름은 2단이다: **Entra 로 인증**하고, 그다음 **마스터 패스워드로 금고를 연다.**
 * 두 번째 단계는 서버 설정(SSO_AUTH_ONLY_NOT_SESSION) 때문만이 아니다 — 유저키가
 * 애초에 마스터 패스워드로 감싸여 서버에 저장돼 있어서, 어느 경로로 인증하든 복호에는
 * 마스터 패스워드가 필요하다 (아래 `Key` 항목).
 *
 * ── 서버 계약 (fork 소스 실측: `~/vault/build/.work/timshel-vaultwarden`) ────────────
 *  1. `GET /identity/sso/prevalidate` → `{"token":"<jwt>"}` (src/api/identity.rs:1182).
 *     SSO 가 꺼져 있으면 여기서 에러 — 흐름을 시작하기 전 유일한 사전 판별 지점이다.
 *  2. `GET /identity/connect/authorize` (identity.rs:1281) 는 필수 필드
 *     `client_id`·`redirect_uri`·`state`·`code_challenge`·`code_challenge_method` 를 받아
 *     IdP 로 307 한다. `code_challenge_method` 는 **"S256" 만** 허용한다(identity.rs:1292).
 *  3. ⚠ **client_id="web" 이면 서버가 우리 `redirect_uri` 를 버리고
 *     `{DOMAIN}/sso-connector.html` 로 고정한다** (sso.rs:307 `authorize_url`).
 *     즉 콜백 착지점은 우리가 고를 수 없다. redirect_uri 는 필수 필드라 보내되 무시된다.
 *  4. IdP → `GET /identity/connect/oidc-signin` → 서버가 그 고정 redirect_uri 에
 *     `code`·`state`·`scope`·`iss` 를 **쿼리로** 붙여 307 (identity.rs:1240-1253).
 *     state 는 **디코드된 원문**이 돌아온다 — base64 는 서버가 IdP 로 보낼 때만 쓴다
 *     (sso_client.rs:354 `BASE64.encode` ↔ identity.rs:1229 `decode_state`).
 *  5. `sso-connector.html` 은 스톡 web-vault 정적 파일이다(우리 allowlist 밖이라
 *     vaultwarden 이 서빙 — DEPLOY.md 2절). 그 번들이 마지막으로
 *     `{origin}/#/sso?code=<code>&state=<state>` 로 넘긴다 (실측 2026-08-14
 *     `connectors/sso.<hash>.js`). state 에 `_returnUri='…'` 가 있으면 그 경로로 가지만
 *     우리는 붙이지 않는다. ⚠ 이 마지막 단계는 code·state 를 **인코딩 없이** URL 에
 *     이어 붙이므로 state 는 URL 안전 문자만 써야 한다 (그래서 base64url).
 *  6. `POST /identity/connect/token` `grant_type=authorization_code` 는
 *     `client_id`·`code`·`code_verifier`·`device_*` 를 요구하고(identity.rs:101-111),
 *     `scope` 는 정확히 `api offline_access` 여야 한다(auth.rs:1178 `AuthMethod::Sso.scope()`).
 *  7. 성공 응답에는 **`Key`(마스터패스워드로 감싼 유저키)와 `Kdf*` 가 들어 있다**
 *     (identity.rs:583-603 `authenticated_response`). 그래서 SSO 뒤 prelogin 이 불필요하다 —
 *     KDF 파라미터를 토큰 응답에서 그대로 얻는다.
 *  8. 2FA 는 SSO 에서도 같은 방식으로 요구된다. 재시도로 **같은 code 를 다시 보내도**
 *     되도록 서버가 설계돼 있다(sso.rs:464 주석 + `sso_auth.auth_response` 캐시).
 *
 * ⚠ dev(:4290)에서는 왕복이 끝나지 않는다. 서버의 `DOMAIN` 이 vault.axelabs.ai 라
 * 콜백이 프로덕션으로 착지한다. dev 에서 검증 가능한 것은 시작 요청 구성까지다.
 */
import { CLIENT_ID, HttpError, identityGet, pick } from "./api.ts";
import {
  SCOPE,
  applyTwoFactor,
  grantBaseFields,
  mapKdf,
  masterPasswordUnlockPresent,
  tokenGrant,
  type SsoAuthResult,
} from "./auth.ts";
import { ssoForwardTarget } from "./classic.ts";

/**
 * 리다이렉트 왕복을 건너야 하는 핸드셰이크 값. **비밀이 아니다** — state 는 CSRF 논스이고
 * verifier 는 이 탭이 시작한 흐름을 자기 것이라고 증명하는 1회용 값이다. 그래도 탭 수명을
 * 넘겨 살 이유가 없으므로 sessionStorage 를 쓰고(localStorage 금지 규칙과 정합),
 * 콜백에서 **소비 즉시 지운다**.
 */
const STATE_KEY = "axe-vault.sso-state";
const VERIFIER_KEY = "axe-vault.sso-verifier";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** base64url 난수. 32바이트 → 43자 = RFC 7636 의 code_verifier 최소 길이. */
export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/**
 * IdP 로 보낼 authorize URL. 파라미터 이름·값은 스톡 web-vault 가 같은 서버에 보내는 것과
 * 같게 맞췄다(실측 2026-08-14 `app/main.<hash>.js` `buildAuthorizeUrl`). 다른 점 둘:
 *  · `domain_hint`/`user_identifier` 미전송 — 조직 SSO 식별자 개념을 우리는 쓰지 않는다.
 *  · state 에 `_returnUri`/`_identifier` 접미사를 붙이지 않는다 — 붙이면 커넥터가 우리를
 *    `#/sso` 가 아닌 다른 라우트로 보낸다(위 계약 5).
 */
export function authorizeUrl(opts: { state: string; challenge: string; ssoToken: string; identityUrl: string; origin: string }): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    // 서버가 client_id="web" 에서 이 값을 버리고 {DOMAIN}/sso-connector.html 로 고정한다
    // (계약 3). 필수 필드라 보낼 뿐이고, 실제 착지점은 여기가 결정하지 않는다.
    redirect_uri: `${opts.origin}/sso-connector.html`,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    response_mode: "query",
    ssoToken: opts.ssoToken,
  });
  return `${opts.identityUrl}/connect/authorize?${q}`;
}

/** prevalidate — SSO 가능 여부 확인 겸 ssoToken 획득. */
export async function prevalidateSso(): Promise<string> {
  const json = (await identityGet("/sso/prevalidate")) as Record<string, unknown>;
  const token = pick<string>(json, "token", "Token");
  if (!token) throw new Error(`prevalidate 응답에 token 이 없다: ${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

/**
 * 흐름 시작. 핸드셰이크를 sessionStorage 에 남기고 **이동할 URL 을 돌려준다** —
 * 이동 자체는 호출부가 한다(테스트 가능성 + 화면이 실패를 먼저 그릴 수 있게).
 */
export async function beginSso(): Promise<string> {
  const ssoToken = await prevalidateSso();
  const state = randomToken(24);
  const { verifier, challenge } = await createPkce();
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  return authorizeUrl({
    state,
    challenge,
    ssoToken,
    identityUrl: `${location.origin}/identity`,
    origin: location.origin,
  });
}

export interface SsoCallback {
  code: string;
  state: string;
}

/**
 * `#/sso?code=…&state=…` 파싱. 경계 규칙은 classic.ts 의 포워딩 심과 같은 정규식을 쓴다 —
 * 두 판정이 갈라지면 콜백이 어느 쪽에서도 처리되지 않는 구멍이 생긴다.
 */
export function parseSsoCallback(hash: string): SsoCallback | null {
  if (!ssoForwardTarget(hash)) return null;
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  const code = params.get("code");
  const state = params.get("state");
  return code && state ? { code, state } : null;
}

/** 네이티브 처리에 필요한 전부 — 서버가 준 code + 이 탭이 시작할 때 만든 verifier. */
export interface SsoHandoff {
  code: string;
  verifier: string;
}

export type SsoRoute = { kind: "none" } | { kind: "forward"; target: string } | ({ kind: "native" } & SsoHandoff);

/**
 * 콜백을 누가 처리하는가.
 *
 * **우리가 시작한 흐름만 우리가 끝낸다**: state 가 이 탭이 저장한 값과 일치할 때만
 * 네이티브로 처리한다. 불일치·부재면 예전처럼 classic 으로 넘긴다 — 스톡 볼트에서 시작한
 * 흐름(외부 개시)은 verifier 가 그쪽 오리진에 있어 여기서 완결할 수 없기 때문이다.
 * 이 분기가 SSO 를 "둘 중 하나만" 되게 만들지 않는 유일한 이유다.
 */
export function ssoRoute(hash: string, stored: { state: string | null; verifier: string | null }): SsoRoute {
  const forward = ssoForwardTarget(hash);
  if (!forward) return { kind: "none" };
  const cb = parseSsoCallback(hash);
  if (cb && stored.state && stored.verifier && cb.state === stored.state) {
    return { kind: "native", code: cb.code, verifier: stored.verifier };
  }
  return { kind: "forward", target: forward };
}

/**
 * 부팅 시 받은 SSO 핸드오프의 **수명**.
 *
 * 핸드오프는 1회용이다: 그 안의 `code` 는 교환하는 순간 소비된다. 그런데 SSO 화면은
 * phase 가 "login"·"locked" 인 동안 떠 있어야 하므로(교환 중 → 잠금해제 대기), phase 만
 * 보고는 "아직 진행 중"과 "끝났는데 다시 login 으로 돌아왔다"를 구별할 수 없다.
 *
 * ⚠ 이 구별을 놓치면 실제로 고착된다: SSO 로 인증한 뒤 잠금해제 화면에서 로그아웃하면
 * phase 가 "login" 으로 돌아오는데, 핸드오프가 살아 있으면 **이미 쓴 code 를 든 SSO 화면이
 * 되살아나** 아무 일도 일어나지 않는 빈 화면이 된다 (교환은 마운트 1회라 재실행되지도 않는다).
 *
 * 그래서 폐기를 로그아웃 핸들러에 매달지 않고 phase 에서 **파생**한다 — 로그아웃 경로가
 * 늘어나도(잠금해제 화면·금고 화면·향후 무엇이든) 규칙이 한 곳에 남는다.
 *
 * `ssoFlowStep` 은 같은 phase 로 여러 번 불러도 결과가 같다(멱등) — StrictMode 의 이중
 * 렌더에서도 안전해야 하기 때문이다.
 */
export interface SsoFlow {
  handoff: SsoHandoff | null;
  /** 교환이 성공해 phase 가 "login" 을 벗어난 적이 있는가. */
  authenticated: boolean;
}

export const ssoFlowStart = (handoff: SsoHandoff | null): SsoFlow => ({ handoff, authenticated: false });

const RETIRED: SsoFlow = { handoff: null, authenticated: false };

export function ssoFlowStep(flow: SsoFlow, phase: "login" | "locked" | "unlocked"): SsoFlow {
  if (!flow.handoff) return flow;
  // 금고가 열렸다 — 도착 흐름은 여기서 끝난다. 이후의 유휴 잠금이 SSO 화면을 되살리지 않는다.
  if (phase === "unlocked") return RETIRED;
  // 인증까지 끝났고 잠금해제를 기다린다.
  if (phase === "locked") return flow.authenticated ? flow : { ...flow, authenticated: true };
  // phase === "login": 인증까지 갔다가 돌아왔다면 로그아웃이다.
  return flow.authenticated ? RETIRED : flow;
}

export function clearSsoHandshake(): void {
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
}

/** 부팅 1회. 판정과 동시에 핸드셰이크를 소비(제거)해 재사용·재생을 막는다. */
export function takeSsoRoute(hash: string): SsoRoute {
  const route = ssoRoute(hash, {
    state: sessionStorage.getItem(STATE_KEY),
    verifier: sessionStorage.getItem(VERIFIER_KEY),
  });
  if (route.kind !== "none") clearSsoHandshake();
  return route;
}

/**
 * authorization_code 교환. 성공 응답의 Kdf* 를 그대로 쓰므로 prelogin 이 필요 없다(계약 7).
 * 2FA 가 필요하면 `TwoFactorRequiredError` 가 올라오고, 같은 code 로 재호출하면 된다(계약 8).
 */
export async function exchangeSsoCode(code: string, codeVerifier: string, twoFactorCode?: string): Promise<SsoAuthResult> {
  const body = grantBaseFields();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("code_verifier", codeVerifier);
  applyTwoFactor(body, twoFactorCode);

  const { json, accessToken } = await tokenGrant(body);
  return { accessToken, kdf: mapKdf(json), masterPasswordUnlockPresent: masterPasswordUnlockPresent(json) };
}

/**
 * 교환 실패를 사람 말로. 서버가 던지는 문자열은 원인이 전혀 다른 것들이 섞여 있어
 * 그대로 보여 주면 다음 행동을 못 고른다.
 */
export function describeSsoFailure(e: unknown): string | null {
  const msg = e instanceof HttpError || e instanceof Error ? e.message : "";
  if (/cannot retrieve sso auth|Invalid code/i.test(msg)) {
    return "인증 코드가 이미 쓰였거나 만료됐습니다. 로그인 화면에서 다시 시작하세요.";
  }
  if (/Missing invitation|Signups are disabled|Email domain not allowed/i.test(msg)) {
    return "이 계정은 아직 이 서버에 초대되지 않았습니다. 관리자에게 초대를 요청하세요.";
  }
  return null;
}
