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

/** 서버의 구형 평면 prelogin JSON → SDK Kdf 매핑. 데이터 매핑이지 크립토가 아니다. */
export function mapPrelogin(raw: Record<string, unknown>, email: string): PreloginResult {
  const iterations = Number(pick<number>(raw, "kdfIterations", "KdfIterations") ?? 0);
  if (!iterations) throw new Error(`prelogin 응답에 kdfIterations 가 없다: ${JSON.stringify(raw).slice(0, 200)}`);
  const kdfType = Number(pick<number>(raw, "kdf", "Kdf") ?? 0);
  const kdf: Kdf =
    kdfType === 0
      ? { pBKDF2: { iterations } }
      : {
          argon2id: {
            iterations,
            memory: Number(pick<number>(raw, "kdfMemory", "KdfMemory") ?? 64),
            parallelism: Number(pick<number>(raw, "kdfParallelism", "KdfParallelism") ?? 4),
          },
        };
  return { kdf, salt: normalizeEmail(email) };
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
  constructor(providers: number[]) {
    super("2단계 인증 코드가 필요하다");
    this.providers = providers;
  }
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

function twoFactorProviders(body: unknown): number[] | null {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const raw = pick<unknown>(o, "TwoFactorProviders", "twoFactorProviders");
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  const raw2 = pick<Record<string, unknown>>(o, "TwoFactorProviders2", "twoFactorProviders2");
  if (raw2 && typeof raw2 === "object") return Object.keys(raw2).map(Number).filter(Number.isFinite);
  return null;
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

  const body = new URLSearchParams({
    grant_type: "password",
    username: mail,
    password: authHash,
    scope: "api offline_access",
    client_id: CLIENT_ID,
    deviceType: String(DEVICE_TYPE),
    deviceIdentifier: deviceIdentifier(),
    deviceName: DEVICE_NAME,
  });
  if (twoFactorCode?.trim()) {
    body.set("twoFactorToken", twoFactorCode.trim().replace(/\s/g, ""));
    body.set("twoFactorProvider", String(PROVIDER_AUTHENTICATOR));
    // 기억하지 않는다 — 기억 토큰은 영속 저장을 전제하고 P1 은 그걸 금지한다.
    body.set("twoFactorRemember", "0");
  }

  let json: Record<string, unknown>;
  try {
    json = (await identityPost("/connect/token", body)) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) {
      const providers = twoFactorProviders(e.body);
      if (providers?.length) throw new TwoFactorRequiredError(providers);
    }
    throw e;
  }

  const token = pick<string>(json, "access_token", "accessToken");
  if (!token) throw new Error("토큰 응답에 access_token 이 없다");

  // refresh_token 은 의도적으로 버린다 — 보관하려면 어딘가에 두어야 하고 P1 은 영속 저장을
  // 금지한다. 액세스 토큰은 최초 sync 에만 쓰이고, 잠금 해제는 메모리의 암호문을 다시 풀 뿐
  // 네트워크를 타지 않으므로 만료가 화면을 막지 않는다.
  const udo = pick<Record<string, unknown>>(json, "userDecryptionOptions", "UserDecryptionOptions");
  return {
    accessToken: token,
    kdf: pre.kdf,
    email: mail,
    masterPasswordUnlockPresent: !!pick(udo, "masterPasswordUnlock", "MasterPasswordUnlock"),
  };
}
