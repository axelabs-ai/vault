/**
 * 탭 세션 보존 — 새로고침이 **로그아웃도 잠금도 아니라 "이어가기"** 가 되게 하는 최소 저장분.
 *
 * 저장 규칙의 집행은 이 파일 하나에서만 한다. 다른 어떤 모듈도 세션을 직접 쓰지 않는다.
 *
 * 저장분은 두 겹이다 — 목적이 다르다.
 *
 *  1. **잠금 폴백** (금고를 한 번이라도 연 뒤에는 항상): 계정 이메일·KDF·마스터 패스워드로
 *     감싸인 **채로의** 유저키 암호문, 그리고 그 유저키로 감싼 세션 토큰(`encTokens`).
 *     이것만으로는 아무것도 열리지 않는다 — 봉인을 푸는 유저키는 마스터 패스워드에서만
 *     나오므로 **잠긴 저장분에는 쓸 수 있는 토큰이 존재하지 않는다.**
 *  2. **재개 봉인** (금고가 열려 있는 동안만, `resume`): 유저키와 토큰을 **랩 키**로 감싼
 *     암호문. 랩 키는 `generateKey(…, extractable=false, …)` 로 만든 **non-extractable**
 *     CryptoKey 이고 IndexedDB(`axe-vault` / store `wrap`)에 **객체 그대로** 산다 — 브라우저가
 *     들고 있을 뿐 이 페이지의 JS 는 그 바이트를 꺼낼 수 없다(`exportKey` 가 거부된다).
 *     이 한 겹 덕분에 새로고침이 마스터 패스워드를 다시 묻지 않고 금고를 그대로 이어간다.
 *     (그것이 무엇을 뜻하고 무엇을 뜻하지 않는지는 아래 "막는 것과 막지 않는 것".)
 *
 * 재개 봉인이 **사라지는 지점**: 유휴 15분 초과, 수동 잠금, 로그아웃, 복원 직후 감지된 서버
 * 키 회전. 유휴는 타이머만으로는 부족해 **부팅 시에도 검사한다** — 새로고침이 타이머를
 * 리셋하면 방치된 탭이 무한히 연장되기 때문이다(그래서 마지막 활동 시각을 함께 저장한다).
 * 탭을 닫으면 sessionStorage 의 암호문이 사라지고 랩 키만 IndexedDB 에 남는데, 그건 **다음
 * 부팅이 고아로 보고 즉시 지운다** — 암호문 없는 랩 키는 아무것도 열지 못한다.
 *
 * 정직하게, `extractable: false` 가 막는 것과 **막지 않는 것** (과장하기 쉬운 자리다):
 *  · 막는다 — **이 페이지의 JS 가 키 바이트를 읽어 내는 것.** `exportKey` 가 거부되므로 키를
 *    문자열로 만들어 로그·네트워크·다른 저장소로 옮길 수 없고, 우리가 쓰는 sessionStorage 를
 *    통째로 떠도 열쇠가 글자로 나타나지 않는다. 우리가 다루는 것은 언제나 핸들뿐이다.
 *  · **막지 않는다 — at-rest 보호가 아니다.** 브라우저는 이 키를 자기 프로필 저장소에 보관하고,
 *    그 보관이 암호화되는지·어떤 키로 되는지는 브라우저·OS·플랫폼에 달렸다. 우리는 그것을
 *    보장하지 않는다. **기기·브라우저 프로필·디스크를 손에 넣은 공격자**를 이 플래그가 막아
 *    준다고 읽으면 안 된다. 그 층의 방어는 디스크 암호화·기기 잠금이지 이 코드가 아니다.
 *  · 막지 않는다 — **같은 오리진에서 실행되는 스크립트**는 키를 꺼내지는 못해도 *쓸 수는*
 *    있다. XSS 는 이 계층이 아니라 CSP·의존성 위생이 막는 문제다.
 *  · 그래서 실질적인 방어선은 **수명**이다: 유휴 15분·수동 잠금·로그아웃이 키를 폐기하고,
 *    탭을 닫으면 짝이 되는 암호문이 사라진다.
 *
 *  · **sessionStorage 만** 쓴다(랩 키만 IndexedDB — CryptoKey 는 문자열이 아니라 객체로만
 *    보관할 수 있다). localStorage 는 여전히 전면 금지다.
 *  · **어디에도 저장하지 않는 것** = 마스터 패스워드, 마스터키, 복호된 항목 필드, 인증 해시,
 *    sync 페이로드. 유저키는 **봉인 안에서만** 저장분에 닿는다(평문으로는 결코).
 *
 * 그래서 복호 순서가 이렇게 된다:
 *   · 잠금 해제: 마스터 패스워드 → 마스터키 → `encUserKey` → **유저키** → `encTokens` → 토큰 → sync
 *   · 이어가기: 랩 키(브라우저 보관) → `resume` → **유저키 + 토큰** → sync
 *
 * 암·복호는 PureCrypto(항목·토큰 봉인) 와 WebCrypto AES-GCM(재개 봉인) 이 한다 — 우리 크립토는
 * 여전히 0줄이다. 재개 봉인만 WebCrypto 인 이유는 PureCrypto 키가 정의상 **꺼낼 수 있는 raw
 * 바이트**라 이 계층의 목적(꺼낼 수 없음)을 달성할 수 없기 때문이다.
 *
 * `serializeSession` 이 저장 페이로드를 만드는 **유일한** 자리이고, 허용 필드를 하나씩 옮겨
 * 담으며 EncString·base64 모양까지 검사한다 — 호출부가 실수로 평문을 얹으면 저장 단계에서
 * 죽는다 (tests/session-restore.test.mjs 가 이 회귀를 막는다 — 조용히 새면 눈으로는 못 잡는다).
 */
import { PureCrypto } from "../sdk.ts";
import { isAuthRejection } from "./api.ts";
import type { TokenPair } from "./auth.ts";
import type { Kdf } from "../sdk.ts";

/** 저장 키. 위생 감사에서 한눈에 잡히도록 `axe-vault.` 이름공간을 쓴다. */
export const SESSION_KEY = "axe-vault.session";

/**
 * 마지막 활동 시각(ms). 세션 레코드와 따로 두는 이유는 쓰기 빈도다 — 활동 이벤트마다 수 KB 의
 * 세션 JSON 을 다시 쓰는 대신 숫자 한 줄만 갱신한다.
 */
export const ACTIVITY_KEY = "axe-vault.activity";

/**
 * 이 탭의 식별자. 랩 키는 **탭마다 다른 슬롯**에 산다 — 금고를 두 탭으로 열어 두는 것은 흔한
 * 사용이고, 오리진 전역 슬롯 하나면 한 탭의 로그아웃·재무장·고아 청소가 **다른 탭의 봉인을
 * 못 열게 만든다**(랩 키가 덮이거나 지워져서). 그 간섭을 슬롯 분리로 끊는다.
 *
 * sessionStorage 에 두는 것이 정확한 수명이다 — 새로고침은 살아남고 탭을 닫으면 사라진다.
 * (api.ts 의 기기 식별자와 수명이 같지만 일부러 따로 만든다: 그쪽은 **서버로 가는 기기 신원**
 * 이고 이건 로컬 슬롯 이름이다. 한쪽 수명을 바꿨을 때 다른 쪽이 조용히 깨지면 안 된다.)
 */
export const TAB_KEY = "axe-vault.tab";

/** 스키마가 바뀌면 올린다 — 낯선 버전은 로드 단계에서 버려진다(부분 복원 금지). */
export const SESSION_SCHEMA = 3;

/**
 * 유휴 자동 잠금 한도. **저장 계층이 이 숫자를 안다** — 새로고침을 넘겨 이어갈지 말지가
 * 부팅 시점의 이 판정에 달려 있기 때문이다(타이머는 새로고침으로 리셋되므로 그것만 믿으면
 * 방치된 탭이 무한 연장된다). session.ts 가 같은 상수를 재-export 한다.
 */
export const IDLE_LOCK_MS = 15 * 60 * 1000;

/**
 * 남겨진 슬롯을 치우는 나이 — **위생이지 보안 경계가 아니다.**
 *
 * 이 값이 커도 위험해지지 않는 이유가 이 하위 시스템 전체의 열쇠다: **봉인 암호문 없이 남은
 * 랩 키는 아무것도 복호하지 못한다.** 암호문은 sessionStorage 에 있어 탭과 함께 죽으므로,
 * 주인 없는 슬롯은 이미 열 것이 없는 손잡이다. 청소의 목적은 저장소가 무한히 늘지 않게 하는
 * 것뿐이다.
 *
 * 그래서 **넉넉하게** 잡는다(24시간). 오탐(살아 있는 탭의 슬롯을 지움)의 결과는 "그 탭이 다음
 * 새로고침 때 마스터 패스워드를 한 번 더 받는다" 이고, 미탐의 결과는 "쓸모없는 레코드 하나가
 * 하루 더 남는다" 다. 공격적으로 지울 이유가 없다.
 * (진짜 보안 경계는 **유휴 15분 잠금**이고 그건 그대로다 — IDLE_LOCK_MS.)
 */
export const SLOT_TTL_MS = 24 * 60 * 60 * 1000;

/** 생존 신호 갱신 최소 간격 — 활동 이벤트마다 IndexedDB 를 두드리지 않기 위해서다. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * 재개 봉인 — 랩 키(IndexedDB 의 non-extractable CryptoKey)로 감싼 AES-GCM 암호문.
 * 이 값만 훔쳐도 열리지 않고, 랩 키만 훔쳐도(꺼낼 수 없으니 애초에 못 훔치지만) 열 것이 없다.
 */
export interface ResumeSeal {
  /** base64 AES-GCM 암호문 */
  ct: string;
  /** base64 12바이트 IV */
  iv: string;
}

export interface StoredSession extends SessionFacts {
  v: number;
  /** 유저키로 감싼 토큰 쌍. 마스터 패스워드 없이는 풀 수 없다. */
  encTokens: string;
  /** 금고가 열려 있는 동안에만 존재한다. 잠기면 지운다. */
  resume?: ResumeSeal;
}

/** 저장 페이로드의 허용 필드 전부. 테스트가 이 목록과 실제 JSON 키를 대조한다. */
export const SESSION_FIELDS = ["v", "email", "kdf", "encUserKey", "encTokens", "resume"] as const;

/**
 * EncString 모양 — `<타입번호>.<본문>` (본문은 base64 조각들을 `|` 로 이은 것).
 * 평문 토큰(JWT 는 `eyJ…`)·바이트배열·JSON 은 이 모양이 아니다. 저장 직전의 마지막 그물이다.
 */
const ENC_STRING = /^\d+\.[A-Za-z0-9+/=|]+$/;

/** 재개 봉인의 두 조각은 순수 base64 다 (EncString 이 아니다 — 다른 크립토 계층이다). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

function base64(label: string, v: unknown): string {
  const s = text(label, v);
  if (!BASE64.test(s)) throw new Error(`세션 저장: ${label} 가 base64 가 아니다`);
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

/** 재개 봉인도 같은 규칙으로 옮겨 담는다 — 딸려 오는 필드 없음, 모양 검사 통과 필수. */
function resumeSeal(v: unknown): ResumeSeal | undefined {
  if (v == null) return undefined;
  const o = v as ResumeSeal;
  return { ct: base64("resume.ct", o.ct), iv: base64("resume.iv", o.iv) };
}

/**
 * 저장 페이로드 생성 — 허용 필드만, 하나씩, 검사하며 옮겨 담는다.
 * 입력에 무엇이 더 붙어 있든(평문 토큰·평문 키·sync 원문) 결과에는 오지 못한다.
 */
function serializeSession(facts: SessionFacts, encTokens: string, resume?: unknown): StoredSession {
  const clean: StoredSession = {
    v: SESSION_SCHEMA,
    email: text("email", facts.email),
    kdf: kdfParams(facts.kdf),
    encUserKey: encString("encUserKey", facts.encUserKey),
    encTokens: encString("encTokens", encTokens),
  };
  const seal = resumeSeal(resume);
  if (seal) clean.resume = seal;
  return clean;
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
 *
 * 재개 봉인은 여기서 만들지 않는다 — 비동기이고 실패해도 앱이 계속 굴러야 하므로 별도 문
 * (`armResume`)으로 갈랐다. 이 함수의 실패는 채택 원자성이 걸린 예외로 남는다.
 */
export function saveSession(facts: SessionFacts, tokens: TokenPair, userKey: Uint8Array): StoredSession {
  const clean = serializeSession(facts, sealTokens(tokens, userKey));
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(clean));
  return clean;
}

/**
 * 저장소가 있다고 가정하지 않는다 — 프라이빗 모드·용량 초과·기업 정책은 `sessionStorage` 접근
 * **자체**를 던진다. 그 실패가 앱 흐름을 막으면 안 된다:
 *  · 읽기 실패 = "저장분 없음" 으로 취급한다 (부팅은 로그인 화면으로 정상 진행).
 *  · 삭제 실패 = 흔적이 남을 수 있지만 로그만 남기고 넘어간다 — 로그아웃의 **메모리 키 폐기와
 *    화면 전이는 반드시 끝나야 하기 때문**이다. 지우지 못한 저장분은 어차피 탭을 닫으면 사라지고,
 *    봉인돼 있어 마스터 패스워드 없이는 쓸 수 없다.
 *  · **저장 실패는 그대로 던진다** — 채택 원자성이 그 예외에 걸려 있다 (prepareAdoption).
 */
function readRaw(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch (e) {
    console.warn("axe-vault: 세션 저장분을 읽지 못했다 — 저장분 없음으로 취급한다", e);
    return null;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ACTIVITY_KEY);
  } catch (e) {
    // 여기서 던지면 호출부(logout·forget)의 zeroize·phase 전이가 통째로 멈춘다. 그게 더 나쁘다.
    console.warn("axe-vault: 세션 저장분을 지우지 못했다 (저장소 접근 실패)", e);
  }
}

/** 읽기. 스키마가 안 맞거나 오염됐으면 조용히 되살리지 않고 **버린다**. */
export function loadSession(): StoredSession | null {
  const raw = readRaw();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed?.v !== SESSION_SCHEMA) throw new Error(`알 수 없는 스키마 버전: ${parsed?.v}`);
    return serializeSession(parsed, parsed.encTokens, parsed.resume);
  } catch {
    clearSession();
    return null;
  }
}

// ------------------------------------------------------------------ 유휴 시계

/**
 * 마지막 활동 시각을 새긴다. 유휴 잠금 타이머와 **같은 사건**에 매달아 둬야 의미가 있다
 * (session.ts 의 activity 리스너 + 채택 직후).
 */
export function markActivity(now = Date.now()): void {
  try {
    sessionStorage.setItem(ACTIVITY_KEY, String(now));
  } catch {
    /* 저장소가 막힌 환경 — 이어가기를 못 할 뿐, 앱은 그대로 돈다 */
  }
  // 같은 사건에 생존 신호를 얹는다 — 이게 없으면 살아 있는 탭의 슬롯을 다른 탭의 청소가
  // 지운다. (비동기·실패 무시: 신호를 못 보내면 최악이 재-잠금이다.)
  void beat(now);
}

/**
 * 마지막 활동으로부터 유휴 한도를 넘겼는가.
 *
 * **표식이 없으면 넘긴 것으로 본다.** 재개 봉인은 표식과 함께만 쓰이므로(armResume 이 둘을
 * 같이 쓴다), 표식이 사라진 봉인은 "언제부터 방치됐는지 알 수 없는" 봉인이고 그건 폐기 사유다.
 */
export function idleExpired(now = Date.now()): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(ACTIVITY_KEY);
  } catch {
    return true;
  }
  const at = Number(raw);
  return !raw || !Number.isFinite(at) || now - at >= IDLE_LOCK_MS;
}

// --------------------------------------------------- 랩 키 (IndexedDB · non-extractable)

const DB_NAME = "axe-vault";
const DB_VERSION = 2;
/** 랩 키 레코드. **오직 무장·폐기만** 이 스토어를 쓴다. */
const WRAP_STORE = "wrap";
/**
 * 생존 신호. 키와 **다른 스토어**에 두는 것이 핵심이다 — 한 레코드에 같이 두면 하트비트가
 * 레코드 전체를 read-modify-write 하게 되고, 그 사이에 새로 무장한 랩 키를 **옛 키로 되돌린다**
 * (다음 부팅에 봉인이 안 열려 사용자가 이유 없이 잠긴다). 경합을 트랜잭션으로 이기려 하지 말고
 * 공유 자체를 없앤다.
 */
const BEAT_STORE = "beat";
const WRAP_ALG = "AES-GCM";
const IV_BYTES = 12;

type TxResult<T> = { ok: true; value: T | undefined } | { ok: false };

/**
 * 한 탭의 랩 키 슬롯.
 *
 * `id` 를 값 안에도 두는 것은 중복이지만 의도적이다 — 청소가 `getAll()` **한 번**으로 끝나
 * (getAllKeys 와 짝을 맞추거나 커서를 돌릴 필요가 없다) 트랜잭션이 항상 단순하게 유지된다.
 */
interface WrapSlot {
  id: string;
  key: CryptoKey;
  /**
   * 이 슬롯의 **세대** — 무장할 때마다 새로 만든다.
   *
   * 이 값 하나가 "누가 이 슬롯을 흔들어도 되는가" 를 전부 답한다. 삭제는 언제나 *시작 시점에
   * 캡처한* (id, gen) 로만 하므로, 그 사이 누가 다시 무장했다면(세대가 달라졌다면) 그 삭제는
   * 조용히 아무 일도 하지 않는다. 실행 인스턴스 논스·소유자 필드 같은 별도 신원 개념이
   * 필요 없다 — 새 세대를 쓴 쪽이 곧 현재 주인이다.
   */
  gen: string;
}

const newGen = (): string =>
  crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

/**
 * 지금 이 실행이 **쥐고 있는** 슬롯. 무장했거나(내가 쓴 세대) 부팅에서 읽었을 때(그때 저장돼
 * 있던 세대) 잡힌다. 삭제는 전부 이 캡처를 기준으로 한다.
 */
let held: { id: string; gen: string } | null = null;

/** 생존 신호 한 건. 같은 이유로 `id` 를 값에 함께 둔다. */
interface Beat {
  id: string;
  at: number;
}

/** 이 탭의 식별자 — **만들지 않고** 읽기만 한다 (없으면 이 탭엔 슬롯이 없다는 뜻). */
function tabId(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

/** 봉인을 만들 때만 부른다 — 슬롯을 실제로 갖게 되는 순간에 식별자가 생긴다. */
function ensureTabId(): string | null {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * IndexedDB 는 **있다고 가정하지 않는다** — 프라이빗 모드·기업 정책·구형 환경에서 없거나
 * 막힌다. 없으면 재개가 없을 뿐이고 앱은 잠금 폴백으로 정상 동작해야 한다. 그래서 이 계층의
 * 모든 실패는 예외가 아니라 `null`/`false` 다.
 */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) return resolve(null);
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      // 스키마가 바뀌면 남은 슬롯은 버린다 — 세션 스키마와 같은 규칙(부분 복원 금지)이고,
      // 대가는 그 탭들이 마스터 패스워드를 한 번 더 받는 것뿐이다.
      for (const name of [WRAP_STORE, BEAT_STORE]) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * 한 건짜리 트랜잭션. **완료(oncomplete)에서 결과를 낸다** — 요청 성공은 커밋을 뜻하지 않아서다.
 * 특히 삭제는 폐기 지점이라 "요청은 성공했는데 트랜잭션이 abort 됐다" 를 성공으로 읽으면
 * 조용히 지워지지 않은 랩 키가 남는다.
 */
async function wrapTx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<TxResult<T>> {
  const db = await openDb();
  if (!db) return { ok: false };
  try {
    return await new Promise<TxResult<T>>((resolve) => {
      try {
        const tx = db.transaction(store, mode);
        const req = run(tx.objectStore(store));
        tx.oncomplete = () => resolve({ ok: true, value: req.result as T });
        tx.onerror = () => resolve({ ok: false });
        tx.onabort = () => resolve({ ok: false });
      } catch {
        resolve({ ok: false });
      }
    });
  } catch {
    return { ok: false };
  } finally {
    db.close();
  }
}

/**
 * 슬롯을 **잡는다** — 지금 저장돼 있는 세대를 캡처한다. 쓰기는 없다.
 *
 * 부팅에서 봉인을 읽을 때와 만료 봉인을 치울 때 쓴다. 이후의 삭제는 전부 이 캡처를 기준으로
 * 하므로, 그 사이 누가 다시 무장했다면 내 삭제는 아무 일도 하지 않는다.
 */
async function claim(id: string): Promise<WrapSlot | null> {
  const r = await wrapTx<WrapSlot>(WRAP_STORE, "readonly", (s) => s.get(id));
  const slot = r.ok ? r.value ?? null : null;
  if (slot?.gen) held = { id, gen: slot.gen };
  return slot;
}

/**
 * 내가 쥔 세대의 슬롯을 놓는다 — **(id, gen) 이 맞을 때만** 지운다. 판정과 삭제는 두 스토어를
 * 함께 여는 **하나의 readwrite 트랜잭션** 안에 있다.
 *
 * 돌려주는 값 = "이제 이 탭의 슬롯은 없다". 레코드가 애초에 없었거나 내 세대를 지웠으면 true,
 * **다른 세대가 자리를 차지하고 있으면 false** 다(그건 내 것이 아니므로 손대지 않는다).
 * 호출부는 이 값이 true 일 때만 탭 식별자까지 버린다.
 */
async function releaseSlot(): Promise<boolean> {
  const mine = held;
  const id = mine?.id ?? tabId();
  if (!id) return true; // 슬롯을 가진 적이 없다
  const db = await openDb();
  if (!db) return false;
  try {
    const gone = await new Promise<boolean>((resolve) => {
      let ok = false;
      try {
        const tx = db.transaction([WRAP_STORE, BEAT_STORE], "readwrite");
        const wrap = tx.objectStore(WRAP_STORE);
        const read = wrap.get(id);
        read.onsuccess = () => {
          const current = read.result as WrapSlot | undefined;
          if (!current) {
            ok = true; // 이미 없다
            return;
          }
          if (current.gen !== mine?.gen) return; // 그 사이 다시 무장됐다 — 내 것이 아니다
          ok = true;
          wrap.delete(id);
          tx.objectStore(BEAT_STORE).delete(id);
        };
        tx.oncomplete = () => resolve(ok);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
    if (gone && held?.id === id) held = null;
    return gone;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** **이 탭의** 랩 키. 다른 탭의 슬롯은 읽지 않는다 (세대는 건드리지 않는 순수 읽기). */
export async function getWrapKey(): Promise<CryptoKey | null> {
  const id = tabId();
  if (!id) return null;
  const r = await wrapTx<WrapSlot>(WRAP_STORE, "readonly", (s) => s.get(id));
  return r.ok ? r.value?.key ?? null : null;
}

/**
 * 폐기 — 내가 쥔 세대의 슬롯만 지운다. 실패해도 던지지 않는다 (호출부의 나머지 폐기가 멈추면
 * 더 나쁘고, 못 지운 슬롯은 **열 것이 없는 손잡이**라 다음 스윕에 맡기면 된다).
 */
export async function deleteWrapKey(): Promise<void> {
  await releaseSlot();
}

/**
 * 이 탭이 아직 살아 있다고 알린다. **활동 표식과 같은 자리에서만** 불린다(markActivity) —
 * 새 타이머를 만들지 않는다. 갱신 간격을 두는 이유는 활동 이벤트가 키 입력마다 오기 때문이다.
 *
 * 키 레코드는 **읽지도 쓰지도 않는다** (BEAT_STORE 주석 참조).
 */
let touchedAt = 0;

async function beat(now: number): Promise<void> {
  if (now - touchedAt < TOUCH_INTERVAL_MS) return;
  touchedAt = now;
  const id = tabId();
  if (id) await wrapTx(BEAT_STORE, "readwrite", (s) => s.put({ id, at: now } satisfies Beat, id));
}

/**
 * 오래 조용한 슬롯 청소 — **위생이지 보안 경계가 아니다** (SLOT_TTL_MS 주석 참조).
 * 짝이 되는 암호문은 이미 없으므로, 여기서 못 지워도 열리는 것은 없다.
 *
 * 판정과 삭제는 두 스토어를 함께 여는 **하나의 readwrite 트랜잭션** 안에서 한다. 그 안에서
 * 생존 신호를 **다시 읽고**(그 사이 되살아난 탭을 지우지 않기 위해) 세대를 **다시 대조한다**
 * (그 사이 다시 무장한 슬롯을 지우지 않기 위해). 자기 슬롯을 따로 골라낼 필요는 없다 —
 * 살아 있는 탭의 신호는 유휴 한도(15분)보다 젊고 TTL 은 24시간이라 애초에 후보가 아니다.
 */
export async function sweepStaleWrapSlots(now = Date.now()): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([WRAP_STORE, BEAT_STORE], "readwrite");
        const wrap = tx.objectStore(WRAP_STORE);
        const beats = tx.objectStore(BEAT_STORE);
        const all = wrap.getAll();
        all.onsuccess = () => {
          const slots = ((all.result as WrapSlot[]) ?? []).filter((s) => s?.id);
          // 짝 없는 생존 신호도 같은 트랜잭션에서 치운다 — 지킬 슬롯이 없는 표식이다.
          // (무장이 신호를 슬롯보다 먼저 쓰므로 나이로 한 번 걸러, 그 찰나를 치지 않는다.)
          const paired = new Set(slots.map((s) => s.id));
          const strays = beats.getAll();
          strays.onsuccess = () => {
            for (const b of (strays.result as Beat[]) ?? []) {
              if (b?.id && !paired.has(b.id) && now - b.at > SLOT_TTL_MS) beats.delete(b.id);
            }
          };

          for (const slot of slots) {
            const { id, gen } = slot;
            const seen = beats.get(id);
            seen.onsuccess = () => {
              const at = (seen.result as Beat | undefined)?.at;
              if (typeof at === "number" && now - at <= SLOT_TTL_MS) return; // 아직 살아 있다
              const again = wrap.get(id);
              again.onsuccess = () => {
                if ((again.result as WrapSlot | undefined)?.gen !== gen) return; // 다시 무장됐다
                wrap.delete(id);
                beats.delete(id);
              };
            };
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    /* 청소 실패는 위생 문제일 뿐이다 — 앱 흐름을 세우지 않는다 */
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ 재개 봉인

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 봉인이 되돌려 주는 것 — 새로고침을 넘긴 금고를 다시 여는 데 필요한 전부. */
export interface ResumePayload {
  userKey: Uint8Array;
  tokens: TokenPair;
}

/**
 * 재개 봉인을 만든다 — 랩 키 생성 → IndexedDB 보관 → 유저키·토큰 봉인 → 저장분에 기록.
 *
 * `live()` = "지금 봉인하려는 유저키가 아직 설치된 그 키인가". 잠금은 세션 정체성(epoch)을
 * 올리지 않고 **키만 zeroize** 하므로 epoch 대조로는 못 잡는다 — 봉인 도중 잠금이 끼어들면
 * **0으로 채워진 유저키가 봉인돼** 다음 새로고침이 "열렸지만 아무것도 못 푸는" 금고가 된다.
 * 그래서 (a) 평문을 만들기 직전과 (b) 저장분에 쓰기 직전, 두 번 확인하고 어긋나면 랩 키까지
 * 도로 지운다. 두 확인과 그 다음 동작 사이에는 await 가 없어 단일 스레드에서 원자적이다.
 *
 * 실패는 전부 `null` 이다 — 재개는 **있으면 좋은 것**이고, 없으면 마스터 패스워드 경로로
 * 돌아갈 뿐이다. 이 함수의 어떤 실패도 열려 있는 금고를 방해하지 않는다.
 *
 * 무장은 **직렬화된다** (armResume 이 이 함수를 줄 세운다). 겹치면 앞선 무장의 정리 경로가
 * 뒤 무장이 방금 만든 세대를 지운다 — 세대 비교를 더 정교하게 만드는 대신 **겹침 자체를
 * 없앤다**. 무장은 잠금해제당 한 번이라 줄 세워도 잃을 것이 없다.
 */
async function armOnce(
  stored: StoredSession,
  tokens: TokenPair,
  userKey: Uint8Array,
  live: () => boolean,
): Promise<StoredSession | null> {
  if (typeof crypto === "undefined" || !crypto?.subtle) return null;
  const id = ensureTabId();
  if (!id) return null;

  let key: CryptoKey;
  try {
    // non-extractable — 이 앱도, 이 오리진의 어떤 스크립트도 raw 바이트를 꺼낼 수 없다.
    key = await crypto.subtle.generateKey({ name: WRAP_ALG, length: 256 }, false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
  // 생존 신호가 **먼저**다 — 신호 없는 슬롯은 청소 후보라, 순서를 뒤집으면 갓 무장한 슬롯이
  // 다른 탭의 청소에 걸릴 수 있다.
  const now = Date.now();
  touchedAt = now; // 방금 새 신호를 썼다 — 뒤이은 활동이 곧바로 다시 두드리지 않게.
  await wrapTx(BEAT_STORE, "readwrite", (s) => s.put({ id, at: now } satisfies Beat, id));

  // 무장 = 이 탭이 **새 세대로** 슬롯을 갖는다. 마지막에 쓴 쪽이 현재 주인이고, 그 이전 세대를
  // 쥐고 있던 실행(탭 복제 등)의 삭제는 이제부터 아무 일도 하지 않는다.
  const gen = newGen();
  if (!(await wrapTx(WRAP_STORE, "readwrite", (s) => s.put({ id, key, gen } satisfies WrapSlot, id))).ok) {
    return null;
  }
  held = { id, gen };

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  let sealed: ArrayBuffer;
  let plain: Uint8Array<ArrayBuffer>;
  try {
    // (a) 확인 직후 평문을 만든다 — 사이에 await 가 없어야 zeroize 된 키를 봉인하지 않는다.
    if (!live()) {
      await deleteWrapKey();
      return null;
    }
    plain = new TextEncoder().encode(
      JSON.stringify({
        userKey: b64(userKey),
        accessToken: text("accessToken", tokens.accessToken),
        refreshToken: tokens.refreshToken ?? null,
      }),
    );
    sealed = await crypto.subtle.encrypt({ name: WRAP_ALG, iv }, key, plain);
  } catch {
    await deleteWrapKey();
    return null;
  }
  // 봉인 재료는 즉시 덮어쓴다. (JSON 문자열 자체는 zeroize 할 수 없다 — 이 파일 머리의 한계.)
  plain.fill(0);

  // (b) 쓰기 직전 마지막 확인.
  if (!live()) {
    await deleteWrapKey();
    return null;
  }
  try {
    const next = serializeSession(stored, stored.encTokens, {
      ct: b64(new Uint8Array(sealed)),
      iv: b64(iv),
    });
    // 봉인과 유휴 시계는 한 몸이다 — 시계 없는 봉인은 곧바로 만료로 읽힌다(idleExpired).
    markActivity();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    return next;
  } catch {
    await deleteWrapKey();
    return null;
  }
}

/** 진행 중인 무장. 겹쳐 부르면 여기에 이어 붙는다 (실패해도 줄은 끊기지 않는다). */
let arming: Promise<unknown> = Promise.resolve();

/**
 * 무장 — **직렬화된 armOnce**. 겹쳐 부르면 앞선 무장이 끝난 뒤에 시작한다.
 *
 * 겹침을 허용하면 앞선 무장의 실패 정리(`deleteWrapKey`)가 **뒤 무장이 방금 만든 세대**를
 * 지운다 — 그러면 금고는 열려 있는데 다음 새로고침이 잠금으로 떨어진다. 세대 비교를 더
 * 정교하게 만드는 대신 겹침 자체를 없앤다.
 */
export function armResume(
  stored: StoredSession,
  tokens: TokenPair,
  userKey: Uint8Array,
  live: () => boolean = () => true,
): Promise<StoredSession | null> {
  const next = arming.then(() => armOnce(stored, tokens, userKey, live));
  arming = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * 봉인 해제 — 랩 키와 암호문이 **둘 다** 있어야 한다. 하나라도 없거나 어긋나면 `null` 이고,
 * 호출부는 기존 잠금 화면(마스터 패스워드) 경로로 폴백한다.
 */
export async function takeResume(stored: StoredSession): Promise<ResumePayload | null> {
  const seal = stored.resume;
  if (!seal || typeof crypto === "undefined" || !crypto?.subtle) return null;
  const id = tabId();
  // 부팅 1회 — 읽으면서 지금 세대를 잡는다(claim). 이후의 폐기는 그 세대에만 적용된다.
  const key = id ? (await claim(id))?.key ?? null : null;
  if (!key) return null;

  let plain: Uint8Array | null = null;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: WRAP_ALG, iv: unb64(seal.iv) }, key, unb64(seal.ct)));
    const o = JSON.parse(new TextDecoder().decode(plain)) as {
      userKey: string;
      accessToken: string;
      refreshToken: string | null;
    };
    return {
      userKey: unb64(base64("resume.userKey", o.userKey)),
      tokens: {
        accessToken: text("accessToken", o.accessToken),
        refreshToken: o.refreshToken == null ? null : text("refreshToken", o.refreshToken),
      },
    };
  } catch {
    return null;
  } finally {
    plain?.fill(0);
  }
}

/**
 * 저장분에서 재개 봉인과 유휴 시계만 걷어낸다 — **세션 자체는 남는다**(잠금 화면이 그것으로
 * 선다). 동기 함수인 이유는 잠금·로그아웃의 화면 전이가 이것을 기다리면 안 되기 때문이다.
 */
export function clearResumeSeal(): void {
  try {
    const raw = readRaw();
    if (raw) {
      const parsed = JSON.parse(raw) as StoredSession;
      if (parsed?.resume) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(serializeSession(parsed, parsed.encTokens)));
      }
    }
    sessionStorage.removeItem(ACTIVITY_KEY);
  } catch (e) {
    console.warn("axe-vault: 재개 봉인을 지우지 못했다 (저장소 접근 실패)", e);
  }
}

/**
 * 재개 폐기 — 암호문(sessionStorage)과 랩 키(IndexedDB)를 함께 없앤다.
 *
 * 부팅의 **고아 청소**도 이 함수다: 탭을 닫으면 sessionStorage 는 사라지지만 IndexedDB 는
 * 남으므로, 암호문 없는 랩 키가 발견되면 그 자리에서 지운다(그 키로는 열 것이 없다).
 * 아직 세대를 쥐고 있지 않으면(부팅 청소) **먼저 잡고(claim) 나서** 그 세대로만 지운다 —
 * 그래야 그 사이 새로 무장된 슬롯을 뒤늦은 청소가 치지 않는다.
 *
 * 실패는 조용히 넘긴다. 못 지운 슬롯은 **열 것이 없는 손잡이**이고(암호문이 이미 없다) 다음
 * 스윕이 치운다. 여기서 예외를 올리면 잠금·로그아웃의 나머지 폐기가 통째로 멈춘다.
 *
 * 탭 식별자는 **슬롯이 실제로 정리됐을 때만** 버린다. 남의 세대가 자리를 지키고 있으면
 * 식별자도 남겨 둔다 — 그 탭이 계속 쓰고 있는 자리다.
 */
export async function dropResume(): Promise<void> {
  clearResumeSeal();
  const id = tabId();
  // 부팅 청소 — 지울 대상의 세대를 먼저 잡는다.
  if (id && !held) await claim(id);
  if (!(await releaseSlot())) return;
  try {
    sessionStorage.removeItem(TAB_KEY);
  } catch {
    /* 저장소 접근 실패 — 다음 봉인이 새 식별자를 받을 뿐이다 */
  }
}

export interface Restored {
  /**
   * 저장분이 없으면 로그인, 있으면 잠금, **재개 봉인까지 살아 있으면 이어가기**.
   * "resuming" 은 화면이 아니라 약속이다 — 부팅이 랩 키로 봉인을 풀어 보고, 실패하면 잠금이 된다.
   */
  phase: "login" | "locked" | "resuming";
  session: StoredSession | null;
}

/**
 * 부팅 1회. "새로고침 = 이어가기" 라는 규칙이 사는 자리이고, 동시에 **그 규칙의 한도**가 사는
 * 자리다: 유휴 한도를 넘긴 봉인은 여기서 걷어낸다. 타이머는 새로고침으로 리셋되므로 부팅
 * 검사가 없으면 방치된 탭이 새로고침만으로 무한 연장된다.
 */
export function restoreSession(now = Date.now()): Restored {
  const session = loadSession();
  if (!session) return { phase: "login", session: null };
  if (!session.resume) return { phase: "locked", session };
  if (idleExpired(now)) {
    // 랩 키는 부팅 직후의 고아 청소(dropResume)가 지운다 — 그쪽이 비동기라 여기서 기다리지 않는다.
    clearResumeSeal();
    return { phase: "locked", session: loadSession() };
  }
  return { phase: "resuming", session };
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
