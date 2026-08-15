/**
 * 세션 — 상태 기계 (login → resuming → unlocked ⇄ locked).
 *
 * 위생 규칙:
 *  · **복호 키는 메모리에만 산다 — 새로고침을 넘길 때만 브라우저가 봉인해 들고 있는다.**
 *    탭 세션(sessionStorage)에 남기는 것은 잠금 화면을 그리는 데 필요한 사실(이메일·KDF)과
 *    암호문뿐이다: 마스터 패스워드로 감싸인 유저키, 유저키로 감싼 세션 토큰, 그리고 **랩 키로
 *    감싼 재개 봉인**(유저키+토큰). 랩 키는 IndexedDB 의 non-extractable CryptoKey 라 JS 가
 *    바이트를 꺼낼 수 없다. 그래서 새로고침은 **쓰던 금고 화면 그대로 이어진다** — 그리고 그
 *    이어가기가 불가능하면(유휴 초과·봉인 없음·언랩 실패) 예전처럼 **잠금**으로 떨어진다.
 *    무엇이 어떤 모양으로 저장되는지는 lib/persist.ts 한 곳이 정한다.
 *  · **평문 토큰은 금고가 열려 있는 동안에만 메모리에 있다.** 잠그면 키와 함께 버리고, 다음
 *    잠금해제가 유저키로 봉인을 풀어 되찾는다. 잠긴 탭에는 쓸 수 있는 토큰이 존재하지 않는다.
 *    예외는 딱 하나, SSO 인증 직후 ~ 첫 잠금해제 사이다: 토큰을 감쌀 유저키가 아직 없어 메모리에만
 *    들고 있고 저장도 하지 않는다. 그 구간은 별도 상태(`sso-pending`)로 갈라 **15분 시한**을
 *    걸었다 — 방치된 탭이 평문 refresh 토큰(=마스터 패스워드 없이 쓰이는 계정 권한)을 무기한
 *    들고 있지 않게 하기 위해서다. 만료되면 토큰을 버리고 로그인부터 다시 한다.
 *  · **복원한 세션은 서버의 현재 상태와 대조한 뒤에만 채택한다** (staleSessionMetadata) —
 *    서버에서 비밀번호·키가 회전됐는데 낡은 저장분으로 계속 열어 주면 폐기된 옛 마스터
 *    패스워드가 이 탭에서만 통하게 된다.
 *  · localStorage 는 전면 금지. 탭을 닫으면 브라우저가 sessionStorage 를 지우고, 명시적
 *    로그아웃은 우리가 지운다.
 *  · 키는 React state 가 아니라 ref 에 둔다 — 렌더 트리·devtools 에 노출되지 않고, 잠금 시
 *    Uint8Array 를 fill(0) 으로 실제 덮어쓴 뒤 참조를 끊는다.
 *  · 잠금(유휴·수동)은 네트워크를 타지 않는다. 이 탭이 암호문 sync 원문을 그대로 들고 있고
 *    키만 폐기하므로, 해제는 유저키를 다시 유도해 인덱스를 재구축하면 끝이다.
 *    새로고침으로 되살아난 세션만 그 암호문이 없어 서버에서 한 번 다시 받아 온다.
 *  · **유휴 15분은 새로고침으로 리셋되지 않는다.** 마지막 활동 시각을 탭 세션에 새기고
 *    **부팅 시에도 검사한다** — 타이머만 믿으면 방치된 탭이 새로고침만으로 무한 연장된다.
 *
 * 한계(정직하게): JS 문자열은 zeroize 할 수 없다. 복호된 이름/계정 문자열, 잠깐 노출한 비밀번호,
 * 그리고 열려 있는 동안의 토큰 문자열은 GC 가 회수할 때까지 힙에 남는다. 그래서 애초에 미리 푸는
 * 평문을 최소화하고(vault.ts 의 지연 복호), 키만큼은 확실히 덮어쓴다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, describe } from "./api.ts";
import { authenticate, prelogin, refreshTokens, type TokenPair } from "./auth.ts";
import {
  IDLE_LOCK_MS,
  armResume,
  clearSession,
  dropResume,
  idleExpired,
  markActivity,
  restoreFailurePhase,
  restoreSession,
  saveSession,
  takeResume,
  unsealTokens,
  type Restored,
  type SessionFacts,
  type StoredSession,
} from "./persist.ts";
import { exchangeSsoCode } from "./sso.ts";
import {
  buildIndex,
  decryptUserKey,
  deriveOrgKeys,
  fetchSync,
  profileEmail,
  revealItem,
  wipeKeys,
  wrappedUserKey,
  type RevealedItem,
  type SecretField,
  type VaultData,
  type VaultItem,
  type VaultKeys,
} from "./vault.ts";

/**
 * `sso-pending` = SSO 인증만 끝나고 아직 첫 잠금해제 전. 겉보기에는 잠금 화면이지만 내부 사정이
 * 다르다 — 토큰을 감쌀 유저키가 아직 없어 **평문 토큰이 메모리에 있고 저장분은 없다**. 그래서
 * 상태를 갈라 두고 시한을 건다(아래 SSO_PENDING_MS). 화면 문구도 이 구간만 다르다.
 *
 * `resuming` = 새로고침 직후, 재개 봉인을 풀어 금고를 되여는 중. 잠금 화면을 띄우지 않는 이유는
 * 그게 **거짓말이기 때문**이다 — 이 구간의 사용자는 마스터 패스워드를 넣을 필요가 없고, 잠금
 * 화면을 스쳐 보이면 넣으려 든다. 실패하면 그때 진짜 잠금으로 떨어진다.
 */
export type Phase = "login" | "unlocked" | "locked" | "sso-pending" | "resuming";

/** 유휴 한도. 부팅 검사(새로고침 연장 방지)를 위해 저장 계층이 정의하고 여기서 재-export 한다. */
export { IDLE_LOCK_MS };

/**
 * SSO 인증 후 마스터 패스워드를 받기까지의 시한.
 *
 * 유휴 자동잠금과 **같은 15분**으로 맞춘다: 방치된 탭이 비밀을 들고 있을 수 있는 시간을 이 앱에서
 * 하나의 숫자로 유지하기 위해서다(둘이 다르면 "이 탭은 언제까지 위험한가"에 답이 두 개가 된다).
 * 이 구간은 오히려 유휴 잠금보다 노출이 크다 — 평문 refresh 토큰 = 마스터 패스워드 없이도 쓰이는
 * 계정 권한이므로, 넉넉하게 잡을 이유가 없다. 사용자는 방금 인증을 끝내고 곧바로 마스터
 * 패스워드를 넣는 흐름이라 15분은 충분히 여유롭다.
 */
export const SSO_PENDING_MS = IDLE_LOCK_MS;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

const NO_MASTER_PASSWORD =
  "이 계정에는 아직 마스터 패스워드가 없습니다. 기본 볼트에서 최초 설정을 마친 뒤 다시 시도하세요.";
const NO_SESSION = "잠금 해제할 세션이 없다. 다시 로그인하라.";
const WRONG_PASSWORD = "마스터 패스워드가 맞지 않습니다. 다시 입력하세요.";
const BROKEN_SESSION = "저장된 세션이 손상돼 복원할 수 없습니다. 다시 로그인하세요.";
export const SSO_EXPIRED = "SSO 인증이 만료됐습니다. 처음부터 다시 로그인하세요.";
export const ACCOUNT_CHANGED =
  "계정 보안 정보가 변경됐습니다(마스터 패스워드 또는 키 회전). 이 탭의 세션은 더 이상 쓸 수 없으니 다시 로그인하세요.";

/**
 * SSO 인증만 끝난 구간의 보관함 — 이 앱에서 **봉인되지 않은 평문 토큰이 존재하는 유일한 자리**다.
 * 그래서 값과 함께 시한을 들고 다닌다. 만료·취소·언마운트가 `clearPending` 으로 참조를 끊는다.
 *
 * 한계(정직하게): 토큰은 JS 문자열이라 Uint8Array 처럼 덮어쓸 수 없다. 우리가 할 수 있는 것은
 * 참조를 끊어 GC 에 넘기는 것뿐이고, 그래서 애초에 **이 구간을 짧게 유지하는 것**이 방어다.
 */
export interface Pending {
  tokens: TokenPair | null;
  expiresAt: number;
}

export const startPending = (tokens: TokenPair, now = Date.now()): Pending => ({
  tokens,
  expiresAt: now + SSO_PENDING_MS,
});

export const pendingAlive = (p: Pending | null, now = Date.now()): boolean =>
  !!p?.tokens && now < p.expiresAt;

export function clearPending(p: Pending | null): void {
  if (!p) return;
  p.tokens = null;
  p.expiresAt = 0;
}

/**
 * 복원한 저장분이 **서버의 현재 계정 상태**와 같은가.
 *
 * 서버에서 마스터 패스워드나 키가 회전되면 `profile.key`(마스터 패스워드로 감싼 유저키)가 새
 * 값으로 바뀐다. 저장분의 낡은 `encUserKey` 로 계속 열어 주면 **폐기된 옛 마스터 패스워드가 이
 * 탭에서만 계속 통한다** — 회전의 의미가 사라진다. 그래서 sync 를 받은 **직후, 채택 전에** 대조한다.
 *
 * KDF 파라미터도 이 한 번의 비교로 함께 걸린다: KDF 가 바뀌면 마스터키가 달라지고 서버는
 * `profile.key` 를 새 마스터키로 다시 감싸므로 값이 반드시 달라진다 (sync 프로필에는 KDF 필드가
 * 없다 — fork 소스 db/models/user.rs `to_json` 은 email·key·privateKey·securityStamp 만 낸다).
 * 계정 식별자(email)도 함께 본다 — 같은 오리진에서 계정이 바뀐 저장분을 쓰지 않기 위해서다.
 */
export function staleSessionMetadata(raw: Record<string, unknown>, facts: SessionFacts): boolean {
  const freshKey = wrappedUserKey(raw);
  if (!freshKey || freshKey !== facts.encUserKey) return true;
  try {
    return profileEmail(raw) !== facts.email;
  } catch {
    return true;
  }
}

export interface Adoption {
  keys: VaultKeys;
  data: VaultData;
  stored: StoredSession;
}

/**
 * 복호된 유저키를 **채택 가능한 상태**로 만든다 — 조직 키 유도 · 목록 인덱스 구축 · 저장까지.
 *
 * 하나라도 실패하면 새로 유도한 키(유저키·조직 키 전부)를 zeroize 하고 던진다. 반쯤 채택된
 * 상태 — 화면은 로그인/잠금인데 메모리에는 복호된 키가 살아 있는 — 를 만들지 않기 위해서다.
 * **저장이 설치보다 먼저**인 것도 같은 이유다: 저장에 실패한 세션을 열어 두면 화면과 저장분이
 * 갈라져, 다음 새로고침이 조용히 로그인 화면으로 떨어진다.
 *
 * 훅 밖의 순수 함수다 (tests/session-restore.test.mjs 가 실패를 주입해 확인한다).
 */
export function prepareAdoption(
  raw: Record<string, unknown>,
  facts: SessionFacts,
  tokens: TokenPair,
  userKey: Uint8Array,
): Adoption {
  const keys: VaultKeys = { userKey, orgKeys: new Map() };
  try {
    keys.orgKeys = deriveOrgKeys(raw, userKey);
    const data = buildIndex(raw, keys);
    const stored = saveSession(facts, tokens, userKey);
    return { keys, data, stored };
  } catch (e) {
    wipeKeys(keys);
    throw e;
  }
}

/**
 * 진행 중인 잠금해제 **한 건의 정체성**.
 *
 * 잠금해제는 서버 왕복을 포함하므로, 그 사이에 로그아웃·잠금이 끼어들고 심지어 **다른 계정으로
 * 로그인**까지 될 수 있다. 결과를 채택할 때만 확인하는 것으로는 부족하다 — 시도는 채택 이전에도
 * 쓴다(토큰 회전분 저장). 그래서 확인을 "채택 문 하나"가 아니라 **모든 쓰기 직전**으로 올린다.
 *
 *  · `epoch` = 세션 정체성. 로그아웃·세션 폐기가 값을 올린다. 값이 달라졌다는 것은 지금 저장분이
 *    **내가 만든 것이 아니라는** 뜻이므로, 그 위에는 아무것도 쓰지 않는다 — 덮어쓰기는 물론
 *    **지우지도 않는다**(남의 세션을 청소할 권한이 없다).
 *  · `cancelled` = 이 시도가 취소됐는가. 잠금·로그아웃·언마운트가 세운다. 취소는 진행 중 fetch 를
 *    실제로 끊고(AbortController) 유도해 둔 비밀을 **즉시** 지운다 — 뒤늦은 완료를 기다리지 않는다.
 *
 * `live()` 하나로 두 조건을 함께 본다. 쓰기 **직전에** 부르고 그 사이에 await 를 두지 않으면,
 * 단일 스레드에서 검사와 쓰기는 원자적이다.
 */
export interface Attempt {
  readonly epoch: number;
  readonly controller: AbortController;
  /** 이 시도가 유도한 비밀. 취소가 즉시 덮어쓴다. */
  readonly secrets: Uint8Array[];
  cancelled: boolean;
  live(): boolean;
}

export function startAttempt(currentEpoch: () => number): Attempt {
  const epoch = currentEpoch();
  const attempt: Attempt = {
    epoch,
    controller: new AbortController(),
    secrets: [],
    cancelled: false,
    live: () => !attempt.cancelled && currentEpoch() === epoch,
  };
  return attempt;
}

/** 취소 — 진행 중 fetch 를 실제로 끊고, 유도해 둔 비밀을 **즉시** 지운다. */
export function cancelAttempt(attempt: Attempt | null): void {
  if (!attempt) return;
  attempt.cancelled = true;
  attempt.controller.abort();
  for (const s of attempt.secrets) s.fill(0);
  attempt.secrets.length = 0;
}

/** 취소된 시도가 계속 굴러가지 않게 하는 신호. 화면에는 띄우지 않는다. */
export class AbandonedError extends Error {
  constructor() {
    super("이 잠금해제 시도는 취소됐다");
    this.name = "AbandonedError";
  }
}

/** 중단으로 인한 실패인가 — 사용자가 그만두라고 한 것이므로 사유를 화면에 띄우지 않는다. */
export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === "AbortError";

/**
 * 저장된 세션으로 암호문을 다시 받아 온다. 액세스 토큰이 만료(401)됐으면 리프레시 토큰으로
 * 한 번 되살린다.
 *
 * ⚠ 회전에 성공하면 **sync 성공을 기다리지 않고 곧바로 재봉인해 저장한다.** 서버는 회전 시점에
 * 구 리프레시 토큰을 무효화하므로(fork 소스 auth.rs `refresh_tokens` → 새 device token),
 * 회전분을 들고만 있다가 sync 가 실패해 버리면 **일시적인 장애가 강제 재로그인으로 굳는다** —
 * 다음 시도가 이미 죽은 토큰을 다시 꺼내 쓰기 때문이다. 저장이 먼저, 그다음이 sync 다.
 * `onRotate` 는 호출부의 메모리 사본을 같은 순간에 맞춰 준다 (sync 가 실패해도 갱신은 남는다).
 *
 * ⚠ 그 저장은 **`attempt.live()` 를 통과할 때만** 한다. 취소됐다면 유도 키는 이미 zeroize 됐고
 * (그 키로 봉인하면 못 여는 저장분이 된다), 세션이 바뀌었다면 그 저장분은 남의 것이다. 어느
 * 쪽이든 쓰지 않고 물러난다 — 그 대가로 회전된 토큰 하나를 잃을 뿐이고(다음 로그인으로 회복),
 * 남의 세션을 깨뜨리지 않는다.
 */
export async function pullSync(
  facts: SessionFacts,
  tokens: TokenPair,
  userKey: Uint8Array,
  attempt: Attempt,
  onRotate: (stored: StoredSession, tokens: TokenPair) => void,
): Promise<{ raw: Record<string, unknown>; tokens: TokenPair }> {
  const signal = attempt.controller.signal;
  try {
    return { raw: await fetchSync(tokens.accessToken, signal), tokens };
  } catch (e) {
    if (!tokens.refreshToken || !(e instanceof HttpError) || e.status !== 401) throw e;
    const rotated = await refreshTokens(tokens.refreshToken, signal);
    // 쓰기 직전 대조 — 여기부터 saveSession 까지 await 가 없어야 원자적이다.
    if (!attempt.live()) throw new AbandonedError();
    onRotate(saveSession(facts, rotated, userKey), rotated);
    return { raw: await fetchSync(rotated.accessToken, signal), tokens: rotated };
  }
}

/**
 * 이어가기 한 건의 결말. 화면 조작은 하지 않는다 — 훅이 이 값을 받아 설치·폐기를 결정한다.
 *
 * `abandon` 이 따로 있는 이유: 취소는 **아무것도 하지 않는 것**이 정답이다. 잠금·로그아웃·
 * 출구 버튼이 이미 화면을 정했으므로, 뒤늦게 도착한 완료가 그 위에 phase 를 덮어쓰면 안 된다.
 */
export type ResumeOutcome =
  | { kind: "adopt"; raw: Record<string, unknown>; tokens: TokenPair; userKey: Uint8Array }
  /** 취소됐다 — 유도 키는 이미 지웠고, 화면도 저장분도 건드리지 않는다. */
  | { kind: "abandon" }
  /** 이어갈 수 없다 — 봉인·랩 키를 폐기하고 잠금 화면(마스터 패스워드)으로. */
  | { kind: "lock" }
  /** 세션 자체가 죽었다 — 저장분을 버리고 사유와 함께 로그인으로. */
  | { kind: "forget"; reason: string };

/**
 * 이어가기 한 건 — 봉인 해제부터 채택 직전까지. 훅 밖의 순수 함수다
 * (tests/session-restore.test.mjs 가 취소·마감선을 여기에 주입해 확인한다).
 *
 * 두 개의 문이 이 함수의 존재 이유다:
 *
 *  1. **취소는 봉인 읽기 구간부터 닿는다.** 이어가기 화면의 출구("기다리지 않고 마스터
 *     패스워드로 열기")·유휴 잠금·로그아웃은 언제든 들어올 수 있다. 그때 진행 중이던
 *     이어가기가 나중에 완료돼 금고를 열어 버리면, 사용자가 내린 더 최근의 지시가 뒤집힌다.
 *     그래서 유도된 유저키를 **얻는 즉시 시도에 등록**하고, 취소가 지나갔으면 같은 문
 *     (`cancelAttempt`)으로 그 키까지 지운 뒤 `abandon` 으로 물러난다.
 *  2. **유휴 마감선을 채택 직전에 다시 본다.** 부팅 1회 검사만으로는 부족하다 — 마감 직전에
 *     시작한 이어가기가 sync 왕복(수 초) 동안 마감선을 넘어 열릴 수 있다. 이 검사와 반환
 *     사이에는 await 가 없고, 호출부의 `adopt` 는 이 반환에 이어지는 동기 구간에 있다.
 */
export async function openResume(
  stored: StoredSession,
  facts: SessionFacts,
  attempt: Attempt,
  onRotate: (stored: StoredSession) => void,
): Promise<ResumeOutcome> {
  const payload = await takeResume(stored);
  if (!payload) return attempt.live() ? { kind: "lock" } : { kind: "abandon" };
  // 등록이 먼저다 — 취소가 이미 지나갔더라도 이 뒤늦은 키가 같은 문으로 지워지게.
  attempt.secrets.push(payload.userKey);
  if (!attempt.live()) {
    cancelAttempt(attempt);
    return { kind: "abandon" };
  }

  try {
    const pulled = await pullSync(facts, payload.tokens, payload.userKey, attempt, (next) => {
      if (attempt.live()) onRotate(next);
    });
    if (!attempt.live()) return { kind: "abandon" };
    // 서버에서 키가 회전됐다면 이 봉인은 폐기된 옛 세션이다 — 화면을 열기 **전에** 걸린다.
    if (staleSessionMetadata(pulled.raw, facts)) {
      payload.userKey.fill(0);
      return { kind: "forget", reason: ACCOUNT_CHANGED };
    }
    // 마감선 재확인 (위 2). 여기부터 반환까지, 그리고 호출부의 adopt 까지 await 가 없다.
    if (idleExpired()) {
      payload.userKey.fill(0);
      return { kind: "lock" };
    }
    return { kind: "adopt", raw: pulled.raw, tokens: pulled.tokens, userKey: payload.userKey };
  } catch (e) {
    if (!attempt.live() || isAbort(e) || e instanceof AbandonedError) return { kind: "abandon" };
    payload.userKey.fill(0);
    // 서버가 세션을 거부했으면 저장분 자체가 쓸모없다. 네트워크 실패면 잠금 화면에 남아
    // 마스터 패스워드로 다시 시도하게 한다 — 잠금해제 실패와 같은 규칙이다.
    return restoreFailurePhase(e) === "login" ? { kind: "forget", reason: describe(e) } : { kind: "lock" };
  }
}

export interface Session {
  phase: Phase;
  email: string;
  vault: VaultData | null;
  /** 저장된 세션이 서버에 거부·손상돼 로그인으로 되돌아왔을 때의 사유. 로그인 화면이 띄운다. */
  notice: string | null;
  signIn: (email: string, password: string, twoFactorCode?: string) => Promise<void>;
  /**
   * SSO 콜백 완결 — Entra 인증 결과(code)를 토큰으로 바꾸고 암호문을 받아 온다.
   * 여기서 끝나는 건 **인증**이고, 금고는 아직 잠긴 채다(phase="locked"). 복호는 이어지는
   * 잠금해제 화면이 마스터 패스워드로 한다.
   */
  completeSso: (code: string, verifier: string, twoFactorCode?: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  logout: () => void;
  /** 항목의 지정한 비밀 필드만 그때 푼다. 키는 밖으로 내보내지 않는다. */
  reveal: (item: VaultItem, fields: SecretField[]) => RevealedItem;
}

export function useSession(): Session {
  // 부팅 1회 — 저장된 탭 세션이 있으면 로그인 화면이 아니라 잠금 화면에서 시작한다.
  const bootRef = useRef<Restored | null>(null);
  const boot = (bootRef.current ??= restoreSession());

  const [phase, setPhase] = useState<Phase>(boot.phase);
  const [email, setEmail] = useState(boot.session?.email ?? "");
  const [vault, setVault] = useState<VaultData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 비밀 재료 — 렌더링되지 않는다.
  const keysRef = useRef<VaultKeys | null>(null);
  const rawSyncRef = useRef<Record<string, unknown> | null>(null);
  /** 잠금 화면을 그리고 유저키를 유도하는 데 필요한 사실. 잠금 상태에서도 들고 있어도 된다. */
  const factsRef = useRef<SessionFacts | null>(boot.session);
  /** 평문 토큰 — 금고가 열려 있는 동안만. 잠그면 버리고 봉인에서 되찾는다. */
  const tokensRef = useRef<TokenPair | null>(null);
  /** SSO 인증만 끝난 구간의 보관함(시한 포함). 이 밖에서는 봉인되지 않은 토큰을 두지 않는다. */
  const pendingRef = useRef<Pending | null>(null);
  /** sessionStorage 에 있는 것의 메모리 사본. */
  const storedRef = useRef<StoredSession | null>(boot.session);
  /**
   * 세션 정체성. **세션을 버릴 때만** 올린다(로그아웃·복원 포기) — 값이 달라졌다는 것은 지금
   * 저장분이 내가 만든 것이 아니라는 뜻이고, 그러면 진행 중이던 시도는 아무것도 쓰지 않는다.
   * 잠금은 세션을 버리는 게 아니므로 올리지 않는다(취소만 한다 — 회전 토큰을 살릴 수 있는 만큼
   * 살린다).
   */
  const epochRef = useRef(0);
  /** 진행 중인 잠금해제 한 건. 로그아웃·잠금·언마운트가 이것을 즉시 취소한다. */
  const workRef = useRef<Attempt | null>(null);

  /** 진행 중 작업 취소 — fetch 중단 + 대기 중이던 유도 키 즉시 zeroize. */
  const cancelWork = useCallback(() => {
    cancelAttempt(workRef.current);
    workRef.current = null;
  }, []);

  const dropKeys = useCallback(() => {
    wipeKeys(keysRef.current);
    keysRef.current = null;
  }, []);

  const lock = useCallback(() => {
    // 진행 중이던 잠금해제가 있다면 그 결과는 이제 무효다 (잠그라는 지시가 더 최근이다).
    // 세션 자체는 그대로이므로 epoch 은 올리지 않는다.
    cancelWork();
    dropKeys();
    // 잠금 = 이어갈 권리의 폐기다. 봉인(sessionStorage)과 랩 키(IndexedDB)를 함께 없앤다 —
    // 이게 없으면 "잠갔는데 새로고침 한 번에 다시 열리는" 잠금이 된다.
    void dropResume();
    // 봉인된 저장분이 있을 때만 평문 토큰을 버린다 — 다음 잠금해제가 유저키로 되찾을 수 있는
    // 경우에 한해서다. (저장분이 없는 SSO 대기 상태는 unlocked 를 지난 적이 없어 여기 오지 않지만,
    // 규칙을 조건으로 못박아 둔다.)
    if (storedRef.current) tokensRef.current = null;
    setVault(null);
    // "resuming" 에서의 잠금 = 이어가기 포기다 (사용자가 기다리지 않고 마스터 패스워드로 열기를
    // 고른 경우). 그 화면에는 다른 출구가 없으므로 이 전이가 없으면 막다른 길이 된다.
    setPhase((p) => (p === "unlocked" || p === "resuming" ? "locked" : p));
  }, [dropKeys]);

  const logout = useCallback(() => {
    // 진행 중이던 잠금해제는 즉시 취소하고(대기 키 zeroize), 세션 정체성을 올려 뒤늦은 완료가
    // 저장분에 아무것도 쓰지 못하게 한다.
    cancelWork();
    epochRef.current++;
    clearSession();
    void dropResume();
    dropKeys();
    clearPending(pendingRef.current);
    pendingRef.current = null;
    rawSyncRef.current = null;
    factsRef.current = null;
    tokensRef.current = null;
    storedRef.current = null;
    setVault(null);
    setEmail("");
    setNotice(null);
    setPhase("login");
  }, [dropKeys]);

  /** 저장분을 되살릴 수 없다 — 지우고 사유와 함께 로그인 화면으로. */
  const forget = useCallback((reason: string) => {
    cancelWork();
    epochRef.current++;
    clearSession();
    void dropResume();
    clearPending(pendingRef.current);
    pendingRef.current = null;
    rawSyncRef.current = null;
    factsRef.current = null;
    tokensRef.current = null;
    storedRef.current = null;
    setVault(null);
    setEmail("");
    setNotice(reason);
    setPhase("login");
  }, []);

  /**
   * 채택 — 저장까지 끝난 재료만 설치한다. 실패는 prepareAdoption 안에서 원자적으로 되돌아간다.
   * 호출부가 **직전에** 유효성을 확인한 뒤 부른다 (동기 구간이라 그 사이가 원자적이다).
   *
   * 금고가 열리는 **모든** 경로(로그인·잠금해제·이어가기)가 여기를 지나므로, 재개 봉인을
   * 새로 거는 자리도 여기 하나다. 토큰이 회전됐다면 회전분으로 다시 봉인된다 — 회전은 항상
   * 채택(또는 폐기)으로 끝나므로 죽은 토큰이 봉인에 남는 구간이 생기지 않는다.
   */
  const adopt = useCallback(
    (raw: Record<string, unknown>, facts: SessionFacts, tokens: TokenPair, userKey: Uint8Array) => {
      const { keys, data, stored } = prepareAdoption(raw, facts, tokens, userKey);
      dropKeys();
      // 봉인이 끝났으니 시한 있는 평문 보관함은 더 이상 필요 없다.
      clearPending(pendingRef.current);
      pendingRef.current = null;
      keysRef.current = keys;
      rawSyncRef.current = raw;
      factsRef.current = facts;
      tokensRef.current = tokens;
      storedRef.current = stored;
      setEmail(facts.email);
      setVault(data);
      setNotice(null);
      setPhase("unlocked");

      // 이어가기 봉인은 **있으면 좋은 것**이다 — IndexedDB 가 없거나 막혀 실패해도 금고는 그대로
      // 열려 있고, 새로고침이 잠금 화면으로 갈 뿐이다. 그래서 기다리지 않고 실패도 삼킨다.
      // `live` = "내가 봉인하려는 그 유저키가 아직 설치돼 있는가". 잠금은 epoch 을 올리지 않고
      // 키만 zeroize 하므로, 이 신원 대조가 없으면 봉인 도중의 잠금이 **0으로 채워진 키**를
      // 봉인해 다음 새로고침이 "열렸는데 아무것도 못 푸는" 금고가 된다.
      const live = () => keysRef.current?.userKey === userKey;
      void armResume(stored, tokens, userKey, live).then((next) => {
        if (next && live()) storedRef.current = next;
      });
      return true;
    },
    [dropKeys],
  );

  // 로그인·SSO 교환 중에는 로그아웃 버튼이 화면에 없다(로그인 화면·SSO 대기 화면 모두). 그래서
  // 이 두 흐름에는 취소가 도달할 수 없고, 경합 장치도 필요 없다. 경합이 실제로 가능한 것은
  // 잠금해제 하나뿐이다 — 잠금 화면에는 로그아웃이 있고 유휴 타이머도 돈다.
  const signIn = useCallback(
    async (emailInput: string, password: string, twoFactorCode?: string) => {
      const pre = await prelogin(emailInput);
      const auth = await authenticate(emailInput, password, pre, twoFactorCode);
      const raw = await fetchSync(auth.accessToken);
      const encUserKey = wrappedUserKey(raw);
      if (!encUserKey) throw new Error(NO_MASTER_PASSWORD);

      // ponytail: WASM KDF 가 메인 스레드를 잠깐 막는다 (argon2id 기준 수백 ms).
      // 체감 지연이 문제가 되면 worker 로 옮긴다.
      const userKey = decryptUserKey(encUserKey, auth.email, password, pre.kdf);
      adopt(
        raw,
        { email: auth.email, kdf: pre.kdf, encUserKey },
        { accessToken: auth.accessToken, refreshToken: auth.refreshToken },
        userKey,
      );
    },
    [adopt],
  );

  const completeSso = useCallback(
    async (code: string, verifier: string, twoFactorCode?: string) => {
      const auth = await exchangeSsoCode(code, verifier, twoFactorCode);
      const raw = await fetchSync(auth.accessToken);
      const encUserKey = wrappedUserKey(raw);
      if (!encUserKey) throw new Error(NO_MASTER_PASSWORD);
      const mail = profileEmail(raw);

      // 인증만 끝났다. 키는 아직 없다 — rawSync 는 통째로 암호문이고, 잠금해제가 마스터
      // 패스워드로 유저키를 유도해야 열린다. 저장은 하지 않는다: 토큰을 감쌀 유저키가 없으니
      // 저장하려면 평문이어야 하고, 그건 하지 않기로 한 바로 그것이다. 첫 잠금해제가 봉인해서
      // 저장한다. 그때까지 평문 토큰은 **시한이 붙은 보관함**에만 둔다 — 이 구간이 phase
      // "sso-pending" 이고, 만료되면 토큰을 버리고 로그인부터 다시 한다.
      dropKeys();
      rawSyncRef.current = raw;
      factsRef.current = { email: mail, kdf: auth.kdf, encUserKey };
      tokensRef.current = null;
      clearPending(pendingRef.current);
      pendingRef.current = startPending({ accessToken: auth.accessToken, refreshToken: auth.refreshToken });
      setEmail(mail);
      setVault(null);
      setNotice(null);
      setPhase("sso-pending");
    },
    [dropKeys],
  );

  /**
   * 잠금 해제. 갈래는 둘이지만 사람에게는 한 화면이다:
   *  · 이 탭이 암호문을 아직 들고 있으면(유휴·수동 잠금) 메모리에서 바로 푼다 — 네트워크 없음.
   *  · 새로고침으로 되살아난 세션이면 봉인을 풀어 얻은 토큰으로 암호문을 다시 받아 온다.
   * 어느 쪽이든 **유저키 복호가 먼저다** — 마스터 패스워드가 틀리면 서버를 부르기 전에 끝나고,
   * 토큰 봉인도 그 유저키로만 열린다.
   */
  const unlock = useCallback(
    async (password: string) => {
      const facts = factsRef.current;
      if (!facts) throw new Error(NO_SESSION);
      // 이전 시도가 남아 있으면 먼저 정리한다 (화면이 중복 제출을 막지만 규칙은 여기 둔다).
      cancelWork();

      // 이 단계의 입력 중 사용자가 준 것은 패스워드뿐이다 (암호문·KDF·이메일은 서버가 준 값이고
      // 저장 시 검사를 통과했다). 그래서 여기서의 실패 = 패스워드 불일치다. SDK 원문
      // ("The provided key is not the expected type")을 그대로 띄우면 사용자가 다음 행동을
      // 고를 수 없다 — 이 화면은 이제 새로고침마다 지나가는 자리라 더욱 그렇다.
      let userKey: Uint8Array;
      try {
        userKey = decryptUserKey(facts.encUserKey, facts.email, password, facts.kdf);
      } catch {
        throw new Error(WRONG_PASSWORD);
      }

      // 여기서부터가 "진행 중인 작업" 이다. 유도한 키를 등록해 두면 로그아웃·잠금·언마운트가
      // 뒤늦은 완료를 기다리지 않고 **즉시** 덮어쓸 수 있다.
      const attempt = startAttempt(() => epochRef.current);
      attempt.secrets.push(userKey);
      workRef.current = attempt;

      // 토큰의 출처는 셋 중 하나다: 열려 있는 동안의 메모리 사본, SSO 대기 보관함(시한 검사),
      // 그리고 저장분의 봉인. 어느 쪽도 없으면 열 세션이 없는 것이다.
      const pending = pendingRef.current;
      if (pending?.tokens && !pendingAlive(pending)) {
        // 시한이 지났는데 타이머가 못 돌았다(탭 절전 등). 여기서 확실히 끊는다.
        userKey.fill(0);
        forget(SSO_EXPIRED);
        throw new Error(SSO_EXPIRED);
      }

      let tokens = tokensRef.current ?? pending?.tokens ?? null;
      if (!tokens) {
        const stored = storedRef.current;
        if (!stored) {
          userKey.fill(0);
          throw new Error(NO_SESSION);
        }
        try {
          tokens = unsealTokens(stored, userKey);
        } catch (e) {
          // 유저키는 맞는데 봉인이 안 풀린다 = 저장분 손상. 되살릴 길이 없다.
          userKey.fill(0);
          forget(BROKEN_SESSION);
          throw new Error(BROKEN_SESSION, { cause: e });
        }
      }

      try {
        let raw = rawSyncRef.current;
        if (!raw) {
          // 토큰이 회전되면 그 즉시 저장분과 메모리 사본이 함께 갱신된다 (pullSync 주석 참조).
          // 그 저장도 attempt.live() 를 통과할 때만 일어난다.
          const pulled = await pullSync(facts, tokens, userKey, attempt, (stored) => {
            if (!attempt.live()) return;
            storedRef.current = stored;
          });
          raw = pulled.raw;
          tokens = pulled.tokens;
        }
        // 설치 직전 마지막 대조 — 여기부터 adopt 끝까지 await 가 없어 원자적이다.
        if (!attempt.live()) return;
        // 서버가 방금 준 값과 저장분이 다르면(비밀번호·키 회전) 이 세션은 죽은 것이다.
        // 그대로 열어 주면 폐기된 옛 마스터 패스워드가 이 탭에서만 계속 통한다.
        if (staleSessionMetadata(raw, facts)) {
          userKey.fill(0);
          forget(ACCOUNT_CHANGED);
          return;
        }
        adopt(raw, facts, tokens, userKey);
      } catch (e) {
        // 취소됐다면 키는 cancelAttempt 가 이미 지웠고, 화면도 더 이상 내 것이 아니다.
        // 중단(abort)도 사용자가 그만두라고 한 것이므로 사유를 띄우지 않는다.
        if (!attempt.live() || isAbort(e) || e instanceof AbandonedError) return;
        userKey.fill(0);
        // 서버가 세션을 거부했으면 저장분은 쓸모없다 — 지우고 사유와 함께 로그인 화면으로.
        // 네트워크 실패면 잠금 화면에 남아 다시 시도하게 한다 (persist.ts 참조).
        if (restoreFailurePhase(e) === "login") forget(describe(e));
        throw e;
      } finally {
        // 끝난 시도는 더 이상 취소 대상이 아니다 — 채택된 키를 나중에 지워 버리지 않게.
        if (workRef.current === attempt) workRef.current = null;
      }
    },
    [adopt, cancelWork, forget],
  );

  /**
   * 이어가기 — 새로고침을 넘긴 봉인을 브라우저 보관 랩 키로 풀어 금고를 되연다.
   *
   * 마스터 패스워드 단계만 빠졌을 뿐 **그 뒤는 잠금해제와 완전히 같은 길**이다: 같은 pullSync
   * (토큰 회전 포함), 같은 신선도 대조(staleSessionMetadata), 같은 채택(adopt), 같은 실패 라우팅.
   * 복원 전용 경로를 따로 파지 않은 이유가 이것이다 — 갈라 두면 한쪽에만 가드가 붙는다.
   *
   * 판단은 전부 `openResume`(순수 함수)이 하고, 여기서는 그 결말을 설치한다. 취소된 결말
   * (`abandon`)에는 **아무것도 하지 않는다** — 잠금·로그아웃·출구 버튼이 이미 화면을 정했다.
   *
   * `resumeRef` 는 겹침 방지다. **취소된 시도만 다시 시작할 수 있다** — StrictMode 의 이중
   * 마운트는 setup → cleanup(cancelWork 로 첫 시도 취소) → setup 순이라, 여기서 재시작을
   * 허용하지 않으면 dev 에서만 이어가기가 죽는다. 반대로 이미 돌고 있거나 끝까지 간 시도는
   * 다시 시작하지 않는다.
   */
  const resumeRef = useRef<Attempt | null>(null);
  const resume = useCallback(async () => {
    const prior = resumeRef.current;
    if (prior && !prior.cancelled) return;

    /** 봉인을 쓸 수 없다 — 랩 키까지 치우고 기존 잠금 화면(마스터 패스워드)으로 넘긴다. */
    const fallback = () => {
      void dropResume();
      setPhase((p) => (p === "resuming" ? "locked" : p));
    };

    const facts = factsRef.current;
    const stored = storedRef.current;
    if (!facts || !stored) return fallback();

    // **봉인을 읽기 전에** 등록한다 — 그래야 잠금·로그아웃·출구 버튼의 취소가 읽기 구간부터
    // 닿고, 뒤늦은 완료가 금고를 열지 못한다 (openResume 의 첫 번째 문).
    const attempt = startAttempt(() => epochRef.current);
    resumeRef.current = attempt;
    workRef.current = attempt;
    try {
      const outcome = await openResume(stored, facts, attempt, (next) => {
        storedRef.current = next;
      });
      switch (outcome.kind) {
        case "adopt":
          // openResume 의 마지막 문에서 여기까지 await 가 없다.
          adopt(outcome.raw, facts, outcome.tokens, outcome.userKey);
          return;
        case "forget":
          forget(outcome.reason);
          return;
        case "lock":
          fallback();
          return;
        case "abandon":
          // 더 최근의 지시(잠금·로그아웃·출구)가 이미 화면을 정했다. 덮어쓰지 않는다.
          return;
      }
    } finally {
      if (workRef.current === attempt) workRef.current = null;
    }
  }, [adopt, forget]);

  /**
   * 부팅 1회.
   *  · 살아 있는 봉인이 있으면 이어간다.
   *  · 없으면 **고아 랩 키를 지운다** — 탭을 닫으면 sessionStorage 의 암호문은 사라지지만
   *    IndexedDB 는 남는다. 열 것이 없는 랩 키를 계속 두지 않는다. (유휴 만료로 봉인이 걷힌
   *    부팅도 여기로 온다 — restoreSession 이 이미 암호문을 걷어 냈다.)
   */
  useEffect(() => {
    // 부팅 판정(boot)은 첫 렌더에 고정된 값이라 의존성이 없다.
    if (boot.phase === "resuming") void resume();
    else void dropResume();
  }, [boot.phase, resume]);

  const reveal = useCallback((item: VaultItem, fields: SecretField[]): RevealedItem => {
    const keys = keysRef.current;
    if (!keys) throw new Error("금고가 잠겨 있다");
    return revealItem(item, keys, fields);
  }, []);

  /**
   * SSO 대기 시한. 이 구간에서만 평문 토큰이 봉인 없이 메모리에 있으므로, 방치된 탭이 계정 권한을
   * 무기한 들고 있지 않게 시계를 건다. 만료되면 토큰 참조를 끊고 사유와 함께 로그인 화면으로.
   * (유휴 잠금과 달리 활동으로 연장되지 않는다 — 이 창은 "곧 마스터 패스워드를 넣는다"는 전제
   *  위에서만 존재한다.)
   */
  useEffect(() => {
    if (phase !== "sso-pending") return;
    const p = pendingRef.current;
    if (!p) return;
    const timer = setTimeout(() => forget(SSO_EXPIRED), Math.max(0, p.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, forget]);

  // 유휴 자동 잠금. 잠금 상태에서는 타이머를 걸지 않는다 (더 잠글 게 없다).
  useEffect(() => {
    if (phase !== "unlocked") return;
    let timer = 0;
    const arm = () => {
      // 타이머와 **같은 사건**에 마지막 활동 시각을 새긴다. 타이머는 새로고침으로 사라지지만
      // 이 표식은 남아, 부팅이 유휴 한도를 다시 판정한다 (새로고침 무한 연장 차단).
      markActivity();
      clearTimeout(timer);
      timer = setTimeout(lock, IDLE_LOCK_MS);
    };
    arm();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, arm, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, arm);
    };
  }, [phase, lock]);

  // 언마운트(탭 이탈 포함) 시 진행 중 왕복을 끊고 키를 덮어쓴다. 메모리는 어차피 사라지지만
  // 명시적으로 지운다 — 대기 중이던 유도 키도 여기서 함께 사라진다.
  useEffect(
    () => () => {
      cancelWork();
      dropKeys();
      clearPending(pendingRef.current);
      pendingRef.current = null;
    },
    [cancelWork, dropKeys],
  );

  return { phase, email, vault, notice, signIn, completeSso, unlock, lock, logout, reveal };
}
