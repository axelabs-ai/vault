/**
 * PoC 플로우: prelogin → 로그인 → sync → cipher 복호.
 *
 * 볼트 크립토(KDF·마스터키·유저키 언랩·org 키 decapsulate·cipher 복호)는 전부
 * @bitwarden/sdk-internal 의 PureCrypto 가 한다. 이 파일은 HTTP 배선과 필드 매핑만 한다.
 *
 * ── 실측된 서버 계약 드리프트 (2026-08-13, OIDCWarden 2025.12.0 vs SDK 2026-08 main) ──
 *  1. SDK 의 `LoginClient.get_password_prelogin` 은 응답에 `kdf_settings` 를 요구하는데
 *     서버는 구형 평면 형식 `{kdf, kdfIterations, ...}` 을 준다 → SDK prelogin 사용 불가.
 *     그래서 prelogin 은 우리가 직접 치고 SDK 타입으로 매핑한다 (데이터 매핑, 크립토 아님).
 *  2. SDK 의 `login_via_password` 는 서버까지 도달해 자격증명 검사를 받지만, 서버의
 *     에러 바디(`{message, validationErrors, errorModel, error:"" ...}`)를
 *     `LoginErrorApiResponse` 로 디코드하지 못한다. 성공 응답 파싱 여부는 실계정이 있어야 확인된다.
 *  → 따라서 Lane A(SDK 로그인)를 먼저 시도하고, 실패 시 Lane B(토큰 grant 직접)로 폴백한다.
 *     어느 lane 이든 볼트 복호는 동일하게 PureCrypto 가 한다.
 */
import {
  PasswordManagerClient,
  PureCrypto,
  type ClientSettings,
  type Kdf,
  type LoginClient,
  type PasswordPreloginResponse,
} from "./sdk.ts";

/** dev 에서는 Vite proxy 가 vault.axelabs.ai 로 넘긴다 (CORS 우회). */
const identityUrl = () => `${location.origin}/identity`;
const apiUrl = () => `${location.origin}/api`;

const DEVICE_NAME = "AXE Vault PoC";
const CLIENT_ID = "web";
const DEVICE_TYPE_WEB = 9; // ChromeBrowser

/** 서버가 device 를 등록하므로 브라우저마다 안정적인 식별자를 유지한다. */
function deviceIdentifier(): string {
  const KEY = "axe-vault-poc.device-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = PureCrypto.new_guid();
    localStorage.setItem(KEY, id);
  }
  return id;
}

function settings(): ClientSettings {
  return {
    identityUrl: identityUrl(),
    apiUrl: apiUrl(),
    userAgent: DEVICE_NAME,
    deviceType: "ChromeBrowser",
    deviceIdentifier: deviceIdentifier(),
  };
}

function loginClient(): LoginClient {
  // 미인증 구간이라 토큰 공급자는 스텁이면 된다.
  const tokenProvider = { get_access_token: async () => undefined };
  return new PasswordManagerClient(tokenProvider, settings()).auth().login(settings());
}

/** Bitwarden 관례: KDF salt = 소문자·trim 한 이메일. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** 서버의 구형 prelogin JSON → SDK `PasswordPreloginResponse` 매핑. */
export function mapPrelogin(raw: Record<string, number | null>, email: string): PasswordPreloginResponse {
  const iterations = Number(raw.kdfIterations ?? 0);
  if (!iterations) throw new Error(`prelogin 응답에 kdfIterations 가 없다: ${JSON.stringify(raw)}`);
  const kdf: Kdf =
    Number(raw.kdf) === 0
      ? { pBKDF2: { iterations } }
      : {
          argon2id: {
            iterations,
            memory: Number(raw.kdfMemory ?? 64),
            parallelism: Number(raw.kdfParallelism ?? 4),
          },
        };
  return { kdf, salt: normalizeEmail(email) };
}

/** 익명 엔드포인트 — 자격증명 없이 실서버 왕복 검증에 쓴다. */
export async function prelogin(email: string): Promise<PasswordPreloginResponse> {
  const res = await fetch(`${identityUrl()}/accounts/prelogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: normalizeEmail(email) }),
  });
  if (!res.ok) throw new Error(`prelogin ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return mapPrelogin(await res.json(), email);
}

export type Lane = "sdk-login" | "raw-token-grant";

export interface AuthResult {
  lane: Lane;
  accessToken: string;
  kdf: Kdf;
  /** 서버가 신형 계약(masterPasswordUnlock)을 줬는지 — 계약 드리프트 관측용. */
  masterPasswordUnlockPresent: boolean;
  laneANote?: string;
}

/**
 * Lane A — SDK 가 마스터키 유도·마스터패스워드 해시·토큰 POST 를 전부 수행하는 최대 재사용 경로.
 * prelogin 만 우리가 매핑해 넘긴다.
 */
async function loginViaSdk(
  email: string,
  password: string,
  pre: PasswordPreloginResponse,
): Promise<AuthResult> {
  const res = await loginClient().login_via_password({
    loginRequest: {
      clientId: CLIENT_ID,
      device: {
        deviceType: "ChromeBrowser",
        deviceIdentifier: deviceIdentifier(),
        deviceName: DEVICE_NAME,
        devicePushToken: undefined,
      },
    },
    email: normalizeEmail(email),
    password,
    preloginResponse: pre,
  });
  const ok = res.Authenticated;
  return {
    lane: "sdk-login",
    accessToken: ok.accessToken,
    kdf: pre.kdf,
    masterPasswordUnlockPresent: !!ok.userDecryptionOptions?.masterPasswordUnlock,
  };
}

/**
 * 마스터패스워드 인증 해시 = PBKDF2(마스터키, salt=마스터패스워드, 1 iteration).
 *
 * ⚠ 유일하게 SDK 밖 프리미티브를 쓰는 지점. SDK 의 `derive_kdf_material` 은 PBKDF2 최소
 * iteration 을 강제해 1회 유도를 거부하고("Insufficient KDF parameters"), WASM 표면에
 * stateless 한 인증해시 API 가 노출돼 있지 않다. 그래서 이 한 단계만 플랫폼 네이티브
 * WebCrypto 로 처리한다 — PBKDF2 를 우리가 구현하는 게 아니라 브라우저 것을 호출한다.
 * 마스터키 자체와 볼트 복호는 여전히 100% SDK.
 */
async function masterPasswordAuthHash(masterKey: Uint8Array, password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", masterKey as BufferSource, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: utf8(password), iterations: 1 },
    key,
    256,
  );
  return b64(new Uint8Array(bits));
}

/** Lane B — 폴백. 토큰 grant 는 직접 치되 마스터키는 SDK 가 유도한다. */
async function loginViaRawGrant(
  email: string,
  password: string,
  pre: PasswordPreloginResponse,
  totp: string,
): Promise<AuthResult> {
  const mail = normalizeEmail(email);
  const masterKey = PureCrypto.derive_kdf_material(utf8(password), utf8(pre.salt), pre.kdf);

  const body = new URLSearchParams({
    grant_type: "password",
    username: mail,
    password: await masterPasswordAuthHash(masterKey, password),
    scope: "api offline_access",
    client_id: CLIENT_ID,
    deviceType: String(DEVICE_TYPE_WEB),
    deviceIdentifier: deviceIdentifier(),
    deviceName: DEVICE_NAME,
  });
  if (totp.trim()) {
    body.set("twoFactorToken", totp.trim());
    body.set("twoFactorProvider", "0");
    body.set("twoFactorRemember", "0");
  }

  const res = await fetch(`${identityUrl()}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json.errorModel?.message ??
      json.ErrorModel?.Message ??
      json.message ??
      json.error_description ??
      JSON.stringify(json).slice(0, 400);
    throw new Error(`token grant ${res.status}: ${msg}`);
  }
  const token = json.access_token ?? json.accessToken;
  if (!token) throw new Error(`token grant 응답에 access_token 이 없다: ${JSON.stringify(json).slice(0, 300)}`);
  const udo = json.userDecryptionOptions ?? json.UserDecryptionOptions;
  return {
    lane: "raw-token-grant",
    accessToken: token,
    kdf: pre.kdf,
    masterPasswordUnlockPresent: !!(udo?.masterPasswordUnlock ?? udo?.MasterPasswordUnlock),
  };
}

export async function authenticate(
  email: string,
  password: string,
  totp: string,
  pre: PasswordPreloginResponse,
): Promise<AuthResult> {
  let laneAError: unknown;
  try {
    return await loginViaSdk(email, password, pre);
  } catch (e) {
    laneAError = e;
  }
  try {
    const b = await loginViaRawGrant(email, password, pre, totp);
    return {
      ...b,
      laneANote: `Lane A(SDK login_via_password) 실패 → Lane B 폴백함.\n원인: ${describe(laneAError)}`,
    };
  } catch (e) {
    // 두 lane 다 실패하면 두 원인을 모두 보여 준다 — 원인 하나만 남으면 진단이 안 된다.
    throw new Error(
      `두 lane 모두 실패.\n· Lane A (SDK login_via_password): ${describe(laneAError)}\n· Lane B (토큰 grant 직접): ${describe(e)}`,
    );
  }
}

/* ------------------------------------------------------------------ sync + 복호 */

/** vaultwarden 계열은 버전에 따라 PascalCase/camelCase 를 섞어 낸다. */
const pick = <T>(obj: Record<string, unknown> | undefined, ...keys: string[]): T | undefined => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
};

export interface DecryptedItem {
  id: string;
  name: string;
  username?: string;
  password?: string;
  totp?: string;
  scope: "personal" | "organization";
  error?: string;
}

export interface SyncResult {
  cipherCount: number;
  organizationCount: number;
  decryptedOk: number;
  decryptedFail: number;
  items: DecryptedItem[];
}

const MAX_SHOWN = 25;

export async function syncAndDecrypt(
  auth: AuthResult,
  email: string,
  password: string,
): Promise<SyncResult> {
  const res = await fetch(`${apiUrl()}/sync?excludeDomains=true`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`sync ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const sync = await res.json();

  const profile = pick<Record<string, unknown>>(sync, "profile", "Profile") ?? {};
  const encUserKey = pick<string>(profile, "key", "Key");
  if (!encUserKey) throw new Error("sync 응답에 profile.key(마스터키로 감싼 유저키)가 없다");

  // 유저키 = SDK 가 KDF 유도 + 언랩까지 한 번에 처리
  const userKey = PureCrypto.decrypt_user_key_with_master_password(
    encUserKey,
    password,
    normalizeEmail(email),
    auth.kdf,
  );

  // 조직 cipher 용 org key: 유저키로 개인키 언랩 → 개인키로 org key decapsulate
  const orgKeys = new Map<string, Uint8Array>();
  const encPrivateKey = pick<string>(profile, "privateKey", "PrivateKey");
  const orgs = pick<Record<string, unknown>[]>(profile, "organizations", "Organizations") ?? [];
  if (encPrivateKey && orgs.length) {
    const privateKey = PureCrypto.unwrap_decapsulation_key(encPrivateKey, userKey);
    for (const org of orgs) {
      const id = pick<string>(org, "id", "Id");
      const key = pick<string>(org, "key", "Key");
      if (!id || !key) continue;
      try {
        orgKeys.set(id, PureCrypto.decapsulate_key_unsigned(key, privateKey));
      } catch {
        /* 이 org 는 건너뛴다 — 아래에서 항목별 에러로 표시된다 */
      }
    }
  }

  const ciphers = pick<Record<string, unknown>[]>(sync, "ciphers", "Ciphers") ?? [];
  const items: DecryptedItem[] = [];
  let ok = 0;
  let fail = 0;

  for (const c of ciphers.slice(0, MAX_SHOWN)) {
    const id = pick<string>(c, "id", "Id") ?? "?";
    const orgId = pick<string>(c, "organizationId", "OrganizationId");
    const scope = orgId ? "organization" : "personal";
    try {
      let key = orgId ? orgKeys.get(orgId) : userKey;
      if (!key) throw new Error(`org key 없음 (${orgId})`);
      // 항목 자체 키가 있으면 그걸로 필드를 푼다 (신형 아이템)
      const itemKey = pick<string>(c, "key", "Key");
      if (itemKey) key = PureCrypto.unwrap_symmetric_key(itemKey, key);
      const k = key;

      const dec = (v: string | undefined) => (v ? PureCrypto.symmetric_decrypt_string(v, k) : undefined);
      const login = pick<Record<string, unknown>>(c, "login", "Login");
      items.push({
        id,
        scope,
        name: dec(pick<string>(c, "name", "Name")) ?? "(이름 없음)",
        username: login && dec(pick<string>(login, "username", "Username")),
        password: login && dec(pick<string>(login, "password", "Password")),
        totp: login && dec(pick<string>(login, "totp", "Totp")),
      });
      ok++;
    } catch (e) {
      items.push({ id, scope, name: "(복호 실패)", error: describe(e) });
      fail++;
    }
  }

  return {
    cipherCount: ciphers.length,
    organizationCount: orgs.length,
    decryptedOk: ok,
    decryptedFail: fail,
    items,
  };
}

/** WASM 에러는 Error 가 아닌 객체로 오는 경우가 있어 화면에 그대로 못 띄운다. */
export function describe(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown; variant?: unknown }).message;
    const v = (e as { variant?: unknown }).variant;
    return v ? `[${String(v)}] ${String(m)}` : String(m);
  }
  if (typeof e === "string") return e;
  try {
    const s = JSON.stringify(e);
    if (s && s !== "{}") return s;
  } catch {
    /* fallthrough */
  }
  return String(e);
}
