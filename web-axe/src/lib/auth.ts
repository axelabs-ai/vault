/**
 * 인증 — prelogin → 마스터키 유도 → 토큰 grant (+2FA).
 *
 * 크립토는 전부 PureCrypto 다. 예외는 마스터패스워드 인증 해시 한 단계뿐이고 그것도 우리가
 * PBKDF2 를 구현하는 게 아니라 브라우저 WebCrypto 를 부른다 (아래 masterPasswordAuthHash 주석).
 *
 * 상위 SDK 클라이언트(LoginClient.login_via_password 등)는 쓰지 않는다 — 이 서버(OIDCWarden
 * 2025.12.0)와 SDK main 사이에 계약 드리프트가 실측됐다. tests/server-contract.test.mjs 의
 * 카나리가 그 경계를 기계로 고정한다. 드리프트가 해소되면 그 테스트가 깨지며 알려 준다.
 */
import { PureCrypto, type Kdf } from "../sdk.ts";
import { CLIENT_ID, DEVICE_NAME, DEVICE_TYPE, HttpError, deviceIdentifier, identityPost, identityPostJson, pick } from "./api.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Bitwarden 관례: KDF salt = 소문자·trim 한 이메일. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface PreloginResult {
  kdf: Kdf;
  salt: string;
}

/**
 * 서버의 구형 평면 KDF JSON → SDK Kdf 매핑. 데이터 매핑이지 크립토가 아니다.
 *
 * 두 곳이 같은 모양을 준다: `/accounts/prelogin` 응답과, `/connect/token` 성공 응답의
 * `Kdf`·`KdfIterations`·`KdfMemory`·`KdfParallelism`
 * (fork 소스 src/api/identity.rs `authenticated_response`). SSO 경로는 prelogin 을
 * 치지 않고 토큰 응답에서 곧바로 이 값을 얻는다.
 */
export function mapKdf(raw: Record<string, unknown>): Kdf {
  const iterations = Number(pick<number>(raw, "kdfIterations", "KdfIterations") ?? 0);
  if (!iterations) throw new Error(`KDF 파라미터에 kdfIterations 가 없다: ${JSON.stringify(raw).slice(0, 200)}`);
  const kdfType = Number(pick<number>(raw, "kdf", "Kdf") ?? 0);
  return kdfType === 0
    ? { pBKDF2: { iterations } }
    : {
        argon2id: {
          iterations,
          memory: Number(pick<number>(raw, "kdfMemory", "KdfMemory") ?? 64),
          parallelism: Number(pick<number>(raw, "kdfParallelism", "KdfParallelism") ?? 4),
        },
      };
}

export function mapPrelogin(raw: Record<string, unknown>, email: string): PreloginResult {
  return { kdf: mapKdf(raw), salt: normalizeEmail(email) };
}

/** 익명 엔드포인트 — 자격증명 없이 KDF 파라미터만 받아 온다. */
export async function prelogin(email: string): Promise<PreloginResult> {
  const raw = (await identityPostJson("/accounts/prelogin", { email: normalizeEmail(email) })) as Record<string, unknown>;
  return mapPrelogin(raw, email);
}

/**
 * 마스터패스워드 인증 해시 = PBKDF2(마스터키, salt=마스터패스워드, 1 iteration).
 *
 * ⚠ 유일하게 SDK 밖 프리미티브를 쓰는 지점. PureCrypto.derive_kdf_material 은 PBKDF2 최소
 * iteration 을 강제해 1회 유도를 거부하고("Insufficient KDF parameters"), WASM 표면에
 * stateless 인증해시 API 가 없다. 그래서 이 한 단계만 플랫폼 네이티브 WebCrypto 로 처리한다.
 * 마스터키 유도 자체와 볼트 복호는 여전히 100% SDK.
 * tests/crypto.test.mjs 의 카나리가 "SDK 가 1-iteration 을 거부한다"를 계속 확인한다.
 */
export async function masterPasswordAuthHash(masterKey: Uint8Array, password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", masterKey as unknown as BufferSource, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8(password), iterations: 1 },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

/** 서버가 2FA 를 요구했다. 화면이 코드 입력란을 띄우고 같은 자격증명으로 재시도한다. */
export class TwoFactorRequiredError extends Error {
  providers: number[];
  /** 서버가 함께 준 설명. 코드가 **거절**된 경우의 사유가 여기 담긴다. */
  detail?: string;
  constructor(providers: number[], detail?: string) {
    super("2단계 인증 코드가 필요하다");
    this.providers = providers;
    this.detail = detail;
  }
}

/**
 * 제출한 2FA 코드가 거절됐는가.
 *
 * ⚠ 서버는 **최초 요구**와 **코드 거절**을 같은 모양으로 답한다(둘 다 `TwoFactorProviders`
 * 를 든 400). 그래서 응답만 보면 구별할 수 없고, "우리가 코드를 보냈는가"라는 문맥으로만
 * 갈린다. 이걸 놓치면 틀린 코드를 넣었을 때 폼이 아무 말 없이 되돌아온다 —
 * 사용자는 무엇이 잘못됐는지 알 방법이 없다.
 *
 * 최초 요구면 null(에러 아님), 거절이면 화면에 띄울 문구를 준다.
 */
export function twoFactorRejection(err: TwoFactorRequiredError, submittedCode: string | undefined): string | null {
  if (!submittedCode?.trim()) return null;
  return err.detail ?? "인증 코드가 올바르지 않습니다. 앱에 표시된 새 코드로 다시 시도하세요.";
}

/** Bitwarden TwoFactorProviderType.Authenticator — P1 이 지원하는 유일한 방식. */
export const PROVIDER_AUTHENTICATOR = 0;

export const PROVIDER_LABELS: Record<number, string> = {
  0: "인증 앱 (TOTP)",
  1: "이메일",
  2: "Duo",
  3: "YubiKey",
  4: "U2F",
  6: "Duo (조직)",
  7: "WebAuthn",
};

export interface AuthResult {
  accessToken: string;
  kdf: Kdf;
  email: string;
  /** 서버가 신형 계약(masterPasswordUnlock)을 줬는지 — 계약 드리프트 관측용. */
  masterPasswordUnlockPresent: boolean;
}

/** SSO 는 이메일을 사용자가 입력하지 않는다 — sync 프로필에서 읽으므로 여기 없다. */
export type SsoAuthResult = Omit<AuthResult, "email">;

export function twoFactorProviders(body: unknown): number[] | null {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const raw = pick<unknown>(o, "TwoFactorProviders", "twoFactorProviders");
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  const raw2 = pick<Record<string, unknown>>(o, "TwoFactorProviders2", "twoFactorProviders2");
  if (raw2 && typeof raw2 === "object") return Object.keys(raw2).map(Number).filter(Number.isFinite);
  return null;
}

/**
 * 서버가 password grant / authorization_code grant 양쪽에 공통으로 요구하는 필드.
 * (fork 소스 src/api/identity.rs 의 `login` — 두 갈래 모두 client_id·device_* 를 검사한다.
 *  스톡 web-vault 번들의 `toIdentityToken` 베이스도 정확히 이 집합을 만든다 — 실측 2026-08-14.)
 */
export function grantBaseFields(): URLSearchParams {
  return new URLSearchParams({
    scope: SCOPE,
    client_id: CLIENT_ID,
    deviceType: String(DEVICE_TYPE),
    deviceIdentifier: deviceIdentifier(),
    deviceName: DEVICE_NAME,
  });
}

/** password·SSO 양쪽이 요구하는 scope. 서버는 문자열 완전일치를 본다 (src/auth.rs `check_scope`). */
export const SCOPE = "api offline_access";

/** 2FA 코드를 grant 바디에 얹는다. 기억 토큰은 영속 저장을 전제하므로 항상 끈다. */
export function applyTwoFactor(body: URLSearchParams, twoFactorCode: string | undefined): void {
  if (!twoFactorCode?.trim()) return;
  body.set("twoFactorToken", twoFactorCode.trim().replace(/\s/g, ""));
  body.set("twoFactorProvider", String(PROVIDER_AUTHENTICATOR));
  body.set("twoFactorRemember", "0");
}

/**
 * `/connect/token` 왕복 + 2FA 요구 정규화 + access_token 추출.
 * grant 종류(password·authorization_code)와 무관한 공통 껍데기다.
 */
export async function tokenGrant(body: URLSearchParams): Promise<{ json: Record<string, unknown>; accessToken: string }> {
  let json: Record<string, unknown>;
  try {
    json = (await identityPost("/connect/token", body)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) {
      const providers = twoFactorProviders(e.body);
      // e.message 는 이미 서버 바디에서 뽑은 설명이다 (api.ts serverMessage).
      if (providers?.length) throw new TwoFactorRequiredError(providers, e.message);
    }
    throw e;
  }

  const accessToken = pick<string>(json, "access_token", "accessToken");
  if (!accessToken) throw new Error("토큰 응답에 access_token 이 없다");
  return { json, accessToken };
}

/** 서버가 신형 계약(masterPasswordUnlock)을 줬는지 — 계약 드리프트 관측용. */
export function masterPasswordUnlockPresent(json: Record<string, unknown>): boolean {
  const udo = pick<Record<string, unknown>>(json, "userDecryptionOptions", "UserDecryptionOptions");
  return !!pick(udo, "masterPasswordUnlock", "MasterPasswordUnlock");
}

/**
 * 토큰 grant. `twoFactorCode` 없이 먼저 치고, 서버가 2FA 를 요구하면
 * TwoFactorRequiredError 를 던져 화면이 코드를 받아 재호출하게 한다.
 */
export async function authenticate(
  email: string,
  password: string,
  pre: PreloginResult,
  twoFactorCode?: string,
): Promise<AuthResult> {
  const mail = normalizeEmail(email);
  const masterKey = PureCrypto.derive_kdf_material(utf8(password), utf8(pre.salt), pre.kdf);
  let authHash: string;
  try {
    authHash = await masterPasswordAuthHash(masterKey, password);
  } finally {
    masterKey.fill(0);
  }

  const body = grantBaseFields();
  body.set("grant_type", "password");
  body.set("username", mail);
  body.set("password", authHash);
  applyTwoFactor(body, twoFactorCode);

  // refresh_token 은 의도적으로 버린다 — 보관하려면 어딘가에 두어야 하고 P1 은 영속 저장을
  // 금지한다. 액세스 토큰은 최초 sync 에만 쓰이고, 잠금 해제는 메모리의 암호문을 다시 풀 뿐
  // 네트워크를 타지 않으므로 만료가 화면을 막지 않는다.
  const { json, accessToken } = await tokenGrant(body);
  return {
    accessToken,
    kdf: pre.kdf,
    email: mail,
    masterPasswordUnlockPresent: masterPasswordUnlockPresent(json),
  };
}
