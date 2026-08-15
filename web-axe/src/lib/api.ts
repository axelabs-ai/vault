/**
 * 서버 HTTP 배선 — 이 파일에 크립토는 없다. 주소·헤더·에러 정규화만 한다.
 *
 * 오리진: dev 는 Vite proxy 가 /identity·/api 를 vault.axelabs.ai 로 넘겨 same-origin 을
 * 흉내내고(vault.axelabs.ai 는 preflight 에 Access-Control-Allow-Origin 을 안 붙인다),
 * prod 는 같은 오리진에서 서빙해 구조적으로 해소한다 (DEPLOY.md).
 */

/** dev proxy / prod same-origin 둘 다 오리진 루트 기준이다. 서브패스로 서빙해도 API 는 루트. */
export const identityUrl = () => `${location.origin}/identity`;
export const apiUrl = () => `${location.origin}/api`;

/**
 * Bitwarden 클라이언트 식별 헤더.
 *
 * 실측(2026-08-13): 이 서버(OIDCWarden 2025.12.0)가 서빙하는 스톡 web-vault 번들
 * `app/main.<hash>.js` 는
 *   applyPlatformHeaders(h) { h.set("Bitwarden-Client-Name", getClientType());
 *                             h.set("Bitwarden-Client-Version", getApplicationVersionNumber()); }
 * 를 모든 API 요청에 적용하고, getApplicationVersion() = "2026.7.0-1" 을
 * split(/[+|-]/)[0] 로 잘라 "2026.7.0" 을 보낸다. getClientType() = ClientType.Web = "web".
 *
 * 서버는 이 헤더가 없거나 semver 파싱이 안 되면 요청을 죽이진 않지만 ERROR 로그를 남기고,
 * 버전 게이팅(클라이언트가 감당 못 하는 신형 필드 회피) 판단을 못 한다. 그래서 스톡 web-vault 와
 * 같은 값을 보낸다 — 우리는 같은 서버의 같은 계약을 소비하는 웹 클라이언트다.
 * 서버의 web-vault 를 올릴 때 이 상수도 같이 올린다 (tests/server-contract.test.mjs 가 감시).
 */
export const CLIENT_NAME = "web";
export const CLIENT_VERSION = "2026.7.0";

export const DEVICE_NAME = "AXE Vault (web-axe)";
/** Bitwarden DeviceType.ChromeBrowser — 스톡 web-vault 가 크롬에서 보내는 값. */
export const DEVICE_TYPE = 9;
/** 서버가 password grant 에 요구하는 client_id. */
export const CLIENT_ID = "web";

/**
 * 기기 식별자.
 *
 * 비밀이 아니지만 세션 위생 규칙상 localStorage 는 일절 쓰지 않는다. sessionStorage 는 탭
 * 수명과 정확히 일치한다 — 새로고침은 살아남고 탭을 닫으면 사라진다. 이게 정확히 우리가
 * 원하는 의미다: 새로고침마다 서버에 새 기기가 등록돼 "새 기기 로그인" 메일이 날아가는 것을
 * 막으면서 "탭 닫으면 소멸"을 지킨다.
 *
 * ⚠ 여기에는 비밀을 절대 넣지 않는다. 세션 토큰과 유저키 **암호문**은 lib/persist.ts 가
 * 같은 sessionStorage 의 자기 키에 따로 두고, 복호 키와 평문은 어디에도 저장하지 않는다.
 */
const DEVICE_ID_KEY = "axe-vault.device-id";

/**
 * PoC 스파이크는 기기 식별자를 localStorage 에 뒀다. 같은 오리진에 남은 우리 흔적이므로
 * 우리가 치운다 — "localStorage 를 쓰지 않는다"는 약속은 남의 브라우저에 남긴 것까지 포함한다.
 * 부팅 시 1회 (main.tsx).
 */
export function purgeLegacyStorage(): void {
  localStorage.removeItem("axe-vault-poc.device-id");
}

export function deviceIdentifier(): string {
  let id = sessionStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function clientHeaders(init?: Record<string, string>): Headers {
  const h = new Headers(init);
  h.set("Bitwarden-Client-Name", CLIENT_NAME);
  h.set("Bitwarden-Client-Version", CLIENT_VERSION);
  h.set("Device-Type", String(DEVICE_TYPE));
  return h;
}

export async function identityGet(path: string): Promise<unknown> {
  const res = await fetch(`${identityUrl()}${path}`, { headers: clientHeaders() });
  return readJson(res, `identity ${path}`);
}

export async function identityPost(path: string, body: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${identityUrl()}${path}`, {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body,
    signal,
  });
  return readJson(res, `identity ${path}`);
}

export async function identityPostJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${identityUrl()}${path}`, {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return readJson(res, `identity ${path}`);
}

/** `signal` 로 중단할 수 있다 — 로그아웃·잠금이 진행 중인 왕복을 실제로 끊는다. */
export async function apiGet(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${apiUrl()}${path}`, {
    headers: clientHeaders({ Authorization: `Bearer ${token}` }),
    signal,
  });
  // 401 만 문구를 갈아 준다 — 서버 바디가 화면에 그대로 쓸 수 없는 형태다.
  if (res.status === 401) throw new HttpError(401, "세션이 만료됐다. 다시 로그인해야 한다.", null);
  return readJson(res, `api ${path}`);
}

/** 응답 상태와 무관하게 JSON 을 읽는다 — 서버 에러 바디가 진단의 전부인 경우가 많다. */
async function readJson(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
    throw new Error(`${label}: JSON 이 아닌 응답 — ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new HttpError(res.status, serverMessage(json) ?? `${label} ${res.status}`, json);
  return json;
}

// 파라미터 프로퍼티(`constructor(readonly x)`)를 쓰지 않는다 — 타입 스트리핑으로 지울 수 없는
// 문법이라 테스트가 이 모듈을 직접 import 하지 못하게 된다. tsconfig 의 erasableSyntaxOnly 가 강제.
export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * 서버가 **세션 자체를 거부**했는가 (토큰 만료·폐기).
 *
 * 두 모양뿐이다: 보호된 API 의 401, 그리고 리프레시 grant 가 죽었을 때의
 * `400 {"error":"invalid_grant"}` (fork 소스 identity.rs `refresh_login` 이 이 계약을 명시한다).
 * 네트워크 오류·5xx 는 여기 해당하지 않는다 — 세션은 멀쩡한데 길이 막힌 것이므로 저장분을
 * 버리면 안 된다 (lib/persist.ts `restoreFailurePhase`).
 */
export function isAuthRejection(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status === 401) return true;
  const body = e.body as Record<string, unknown> | null;
  return e.status === 400 && pick<string>(body, "error", "Error") === "invalid_grant";
}

/** vaultwarden 계열은 버전·엔드포인트마다 에러 모양이 달라 알려진 자리를 순서대로 본다. */
function serverMessage(json: unknown): string | undefined {
  const o = json as Record<string, Record<string, string> | string | undefined> | null;
  if (!o || typeof o !== "object") return undefined;
  const nested = (k: string) => {
    const v = o[k];
    return v && typeof v === "object" ? (v as Record<string, string>).message ?? (v as Record<string, string>).Message : undefined;
  };
  const flat = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return (
    nested("errorModel") ??
    nested("ErrorModel") ??
    flat("error_description") ??
    flat("message") ??
    flat("Message") ??
    flat("error")
  );
}

/**
 * WASM 에러는 Error 인스턴스가 아니라 `{message, variant}` 평범한 객체로 오는 경우가 있어
 * 그대로 화면에 못 띄운다.
 */
export function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
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

/** vaultwarden 은 버전에 따라 PascalCase/camelCase 를 섞어 낸다. */
export const pick = <T>(obj: Record<string, unknown> | undefined | null, ...keys: string[]): T | undefined => {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
};
