/**
 * 탭 세션 보존 — 새로고침이 **로그아웃이 아니라 잠금**이 되게 하는 최소 저장분.
 *
 * 저장 규칙의 집행은 이 파일 하나에서만 한다. 다른 어떤 모듈도 세션을 직접 쓰지 않는다.
 *
 *  · **sessionStorage 만** 쓴다. 탭 수명과 정확히 일치한다 — 새로고침은 살아남고, 탭을 닫으면
 *    브라우저가 지운다. localStorage 는 여전히 전면 금지다.
 *  · **평문으로 저장하는 것** = 그것만으로는 아무것도 열 수 없는 값뿐이다: 계정 이메일(=KDF
 *    salt 겸 잠금 화면 표시), KDF 파라미터(익명 prelogin 이 누구에게나 알려 주는 값),
 *    그리고 마스터 패스워드로 감싸인 **채로의** 유저키 암호문.
 *  · **세션 토큰은 평문으로 저장하지 않는다.** access/refresh 토큰은 "서버도 가진 값" 이 아니라
 *    **권한 그 자체**다 — 특히 refresh 토큰은 마스터 패스워드 없이 계정 권한을 행사한다. 그래서
 *    유저키로 감싸(`encTokens`) 둔다. 봉인을 푸는 유저키는 마스터 패스워드로만 나오므로,
 *    **잠금 상태의 저장분에는 쓸 수 있는 토큰이 존재하지 않는다.**
 *  · **어디에도 저장하지 않는 것** = 마스터 패스워드, 유도된 마스터키/유저키(평문 대칭키),
 *    복호된 항목 필드, 인증 해시, sync 페이로드.
 *
 * 그래서 복호 순서가 이렇게 된다:
 *   마스터 패스워드 → 마스터키 → `encUserKey` 복호 → **유저키** → `encTokens` 복호 → 토큰 → sync
 *
 * 암·복호는 전부 PureCrypto 다 (우리 크립토 0줄 원칙 유지). `serializeSession` 이 저장
 * 페이로드를 만드는 **유일한** 자리이고, 허용 필드를 하나씩 옮겨 담으며 EncString 모양까지
 * 검사한다 — 호출부가 실수로 평문을 얹으면 저장 단계에서 죽는다
 * (tests/session-restore.test.mjs 가 이 회귀를 막는다 — 조용히 새면 눈으로는 못 잡는다).
 */
import { PureCrypto } from "../sdk.ts";
import { isAuthRejection } from "./api.ts";
import type { TokenPair } from "./auth.ts";
import type { Kdf } from "../sdk.ts";

/** 저장 키. 위생 감사에서 한눈에 잡히도록 `axe-vault.` 이름공간을 쓴다. */
export const SESSION_KEY = "axe-vault.session";

/** 스키마가 바뀌면 올린다 — 낯선 버전은 로드 단계에서 버려진다(부분 복원 금지). */
export const SESSION_SCHEMA = 2;

/**
 * 잠금 상태에서도 들고 있어도 되는 사실. 전부 서버가 아는 값이고, 이것만으로는 아무것도 못 연다.
 * 잠금 화면을 그리는 데 필요하므로 복호 이전에 읽을 수 있어야 한다 → 평문으로 둔다.
 */
export interface SessionFacts {
  email: string;
  kdf: Kdf;
  /** 서버가 준 `profile.key` — 마스터 패스워드로 감싸인 유저키 **암호문 그대로**. */
  encUserKey: string;
}

export interface StoredSession extends SessionFacts {
  v: number;
  /** 유저키로 감싼 토큰 쌍. 마스터 패스워드 없이는 풀 수 없다. */
  encTokens: string;
}

/** 저장 페이로드의 전체 필드. 테스트가 이 목록과 실제 JSON 키를 대조한다. */
export const SESSION_FIELDS = ["v", "email", "kdf", "encUserKey", "encTokens"] as const;

/**
 * EncString 모양 — `<타입번호>.<본문>` (본문은 base64 조각들을 `|` 로 이은 것).
 * 평문 토큰(JWT 는 `eyJ…`)·바이트배열·JSON 은 이 모양이 아니다. 저장 직전의 마지막 그물이다.
 */
const ENC_STRING = /^\d+\.[A-Za-z0-9+/=|]+$/;

function text(label: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`세션 저장: ${label} 가 비어 있거나 문자열이 아니다`);
  return v;
}

function encString(label: string, v: unknown): string {
  const s = text(label, v);
  if (!ENC_STRING.test(s)) {
    throw new Error(`세션 저장: ${label} 가 EncString 이 아니다 — 평문을 저장하려는 것 아닌가`);
  }
  return s;
}

function count(label: string, v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`세션 저장: ${label} 가 양의 정수가 아니다`);
  return n;
}

/** KDF 는 통째로 옮기지 않고 두 변종의 숫자 필드만 다시 만든다 (딸려 오는 것 없음). */
function kdfParams(kdf: unknown): Kdf {
  const k = (kdf ?? {}) as {
    pBKDF2?: { iterations: number };
    argon2id?: { iterations: number; memory: number; parallelism: number };
  };
  if (k.pBKDF2) return { pBKDF2: { iterations: count("kdf.iterations", k.pBKDF2.iterations) } };
  if (k.argon2id) {
    return {
      argon2id: {
        iterations: count("kdf.iterations", k.argon2id.iterations),
        memory: count("kdf.memory", k.argon2id.memory),
        parallelism: count("kdf.parallelism", k.argon2id.parallelism),
      },
    };
  }
  throw new Error("세션 저장: 알 수 없는 KDF 파라미터");
}

/**
 * 저장 페이로드 생성 — 허용 필드만, 하나씩, 검사하며 옮겨 담는다.
 * 입력에 무엇이 더 붙어 있든(평문 토큰·평문 키·sync 원문) 결과에는 오지 못한다.
 */
function serializeSession(facts: SessionFacts, encTokens: string): StoredSession {
  return {
    v: SESSION_SCHEMA,
    email: text("email", facts.email),
    kdf: kdfParams(facts.kdf),
    encUserKey: encString("encUserKey", facts.encUserKey),
    encTokens: encString("encTokens", encTokens),
  };
}

/** 토큰 쌍을 유저키로 감싼다. 공식 SDK 대칭 암호화 그대로 — 우리 알고리즘은 0줄이다. */
export function sealTokens(tokens: TokenPair, userKey: Uint8Array): string {
  return PureCrypto.symmetric_encrypt_string(
    JSON.stringify({ accessToken: text("accessToken", tokens.accessToken), refreshToken: tokens.refreshToken ?? null }),
    userKey,
  );
}

/** 봉인 해제. 유저키가 있어야 하고, 그 유저키는 마스터 패스워드에서만 나온다. */
export function unsealTokens(stored: StoredSession, userKey: Uint8Array): TokenPair {
  const o = JSON.parse(PureCrypto.symmetric_decrypt_string(stored.encTokens, userKey)) as TokenPair;
  return {
    accessToken: text("accessToken", o.accessToken),
    refreshToken: o.refreshToken == null ? null : text("refreshToken", o.refreshToken),
  };
}

/**
 * 저장. 토큰을 유저키로 감싸므로 **유저키가 손에 있을 때만** 저장할 수 있다 — 즉 금고를 실제로
 * 연 순간에만. (SSO 인증 직후처럼 아직 잠긴 상태에서는 저장하지 않는다. 감쌀 키가 없으니
 * 평문으로 두느니 저장하지 않는 것이 맞다.)
 */
export function saveSession(facts: SessionFacts, tokens: TokenPair, userKey: Uint8Array): StoredSession {
  const clean = serializeSession(facts, sealTokens(tokens, userKey));
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(clean));
  return clean;
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/** 읽기. 스키마가 안 맞거나 오염됐으면 조용히 되살리지 않고 **버린다**. */
export function loadSession(): StoredSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed?.v !== SESSION_SCHEMA) throw new Error(`알 수 없는 스키마 버전: ${parsed?.v}`);
    return serializeSession(parsed, parsed.encTokens);
  } catch {
    clearSession();
    return null;
  }
}

export interface Restored {
  /** 저장된 세션이 있으면 로그인이 아니라 **잠금**에서 시작한다. */
  phase: "login" | "locked";
  session: StoredSession | null;
}

/** 부팅 1회. "새로고침 = 잠금 화면" 이라는 규칙이 사는 자리. */
export function restoreSession(): Restored {
  const session = loadSession();
  return { phase: session ? "locked" : "login", session };
}

/**
 * 복원 중 실패했을 때 어디로 가는가.
 *
 * 서버가 **세션 자체를 거부**했으면(만료·폐기) 저장분은 쓸모가 없다 — 지우고 로그인으로.
 * 그 밖의 실패(네트워크 끊김·서버 5xx)는 세션 문제가 아니다. 저장분을 버리면 잠깐의 오프라인이
 * 재로그인을 강요하게 되므로 **잠금 화면에 남아** 사유만 보여 주고 다시 시도하게 한다.
 */
export function restoreFailurePhase(e: unknown): "login" | "locked" {
  if (!isAuthRejection(e)) return "locked";
  clearSession();
  return "login";
}
