/**
 * 세션 — 상태 기계 (login → unlocked ⇄ locked).
 *
 * 위생 규칙:
 *  · **복호 키는 메모리에만 산다.** 탭 세션(sessionStorage)에 남기는 것은 잠금 화면을 그리는 데
 *    필요한 사실(이메일·KDF)과 암호문 둘 — 마스터 패스워드로 감싸인 유저키, 그리고 **유저키로
 *    감싼 세션 토큰** — 뿐이다. 그래서 새로고침은 **로그아웃이 아니라 잠금**이 된다: 탭이
 *    암호문을 되찾고, 그것을 풀 마스터 패스워드만 한 번 더 받는다.
 *    무엇이 어떤 모양으로 저장되는지는 lib/persist.ts 한 곳이 정한다.
 *  · **평문 토큰은 금고가 열려 있는 동안에만 메모리에 있다.** 잠그면 키와 함께 버리고, 다음
 *    잠금해제가 유저키로 봉인을 풀어 되찾는다. 잠긴 탭에는 쓸 수 있는 토큰이 존재하지 않는다.
 *    (예외 하나: SSO 인증 직후 ~ 첫 잠금해제 사이. 토큰을 감쌀 유저키가 아직 없어서 메모리에만
 *     들고 있고, 그래서 그 창에서는 **저장도 하지 않는다** — 새로고침하면 로그인부터다.)
 *  · localStorage 는 전면 금지. 탭을 닫으면 브라우저가 sessionStorage 를 지우고, 명시적
 *    로그아웃은 우리가 지운다.
 *  · 키는 React state 가 아니라 ref 에 둔다 — 렌더 트리·devtools 에 노출되지 않고, 잠금 시
 *    Uint8Array 를 fill(0) 으로 실제 덮어쓴 뒤 참조를 끊는다.
 *  · 잠금(유휴·수동)은 네트워크를 타지 않는다. 이 탭이 암호문 sync 원문을 그대로 들고 있고
 *    키만 폐기하므로, 해제는 유저키를 다시 유도해 인덱스를 재구축하면 끝이다.
 *    새로고침으로 되살아난 세션만 그 암호문이 없어 서버에서 한 번 다시 받아 온다.
 *
 * 한계(정직하게): JS 문자열은 zeroize 할 수 없다. 복호된 이름/계정 문자열, 잠깐 노출한 비밀번호,
 * 그리고 열려 있는 동안의 토큰 문자열은 GC 가 회수할 때까지 힙에 남는다. 그래서 애초에 미리 푸는
 * 평문을 최소화하고(vault.ts 의 지연 복호), 키만큼은 확실히 덮어쓴다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, describe } from "./api.ts";
import { authenticate, prelogin, refreshTokens, type TokenPair } from "./auth.ts";
import {
  clearSession,
  restoreFailurePhase,
  restoreSession,
  saveSession,
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

export type Phase = "login" | "unlocked" | "locked";

export const IDLE_LOCK_MS = 15 * 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

const NO_MASTER_PASSWORD =
  "이 계정에는 아직 마스터 패스워드가 없습니다. 기본 볼트에서 최초 설정을 마친 뒤 다시 시도하세요.";
const NO_SESSION = "잠금 해제할 세션이 없다. 다시 로그인하라.";
const WRONG_PASSWORD = "마스터 패스워드가 맞지 않습니다. 다시 입력하세요.";
const BROKEN_SESSION = "저장된 세션이 손상돼 복원할 수 없습니다. 다시 로그인하세요.";

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
    // 봉인된 저장분이 있을 때만 평문 토큰을 버린다 — 다음 잠금해제가 유저키로 되찾을 수 있는
    // 경우에 한해서다. (저장분이 없는 SSO 대기 상태는 unlocked 를 지난 적이 없어 여기 오지 않지만,
    // 규칙을 조건으로 못박아 둔다.)
    if (storedRef.current) tokensRef.current = null;
    setVault(null);
    setPhase((p) => (p === "unlocked" ? "locked" : p));
  }, [dropKeys]);

  const logout = useCallback(() => {
    // 진행 중이던 잠금해제는 즉시 취소하고(대기 키 zeroize), 세션 정체성을 올려 뒤늦은 완료가
    // 저장분에 아무것도 쓰지 못하게 한다.
    cancelWork();
    epochRef.current++;
    clearSession();
    dropKeys();
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
    rawSyncRef.current = null;
    factsRef.current = null;
    tokensRef.current = null;
    storedRef.current = null;
    setEmail("");
    setNotice(reason);
    setPhase("login");
  }, []);

  /**
   * 채택 — 저장까지 끝난 재료만 설치한다. 실패는 prepareAdoption 안에서 원자적으로 되돌아간다.
   * 호출부가 **직전에** 유효성을 확인한 뒤 부른다 (동기 구간이라 그 사이가 원자적이다).
   */
  const adopt = useCallback(
    (raw: Record<string, unknown>, facts: SessionFacts, tokens: TokenPair, userKey: Uint8Array) => {
      const { keys, data, stored } = prepareAdoption(raw, facts, tokens, userKey);
      dropKeys();
      keysRef.current = keys;
      rawSyncRef.current = raw;
      factsRef.current = facts;
      tokensRef.current = tokens;
      storedRef.current = stored;
      setEmail(facts.email);
      setVault(data);
      setNotice(null);
      setPhase("unlocked");
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
      // 패스워드로 유저키를 유도해야 열린다. 그래서 로그인 직후 상태가 정확히 "locked" 다.
      // 저장은 하지 않는다: 토큰을 감쌀 유저키가 없으니 저장하려면 평문이어야 하고, 그건 하지
      // 않기로 한 바로 그것이다. 첫 잠금해제가 봉인해서 저장한다.
      dropKeys();
      rawSyncRef.current = raw;
      factsRef.current = { email: mail, kdf: auth.kdf, encUserKey };
      tokensRef.current = { accessToken: auth.accessToken, refreshToken: auth.refreshToken };
      setEmail(mail);
      setVault(null);
      setNotice(null);
      setPhase("locked");
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

      let tokens = tokensRef.current;
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

  const reveal = useCallback((item: VaultItem, fields: SecretField[]): RevealedItem => {
    const keys = keysRef.current;
    if (!keys) throw new Error("금고가 잠겨 있다");
    return revealItem(item, keys, fields);
  }, []);

  // 유휴 자동 잠금. 잠금 상태에서는 타이머를 걸지 않는다 (더 잠글 게 없다).
  useEffect(() => {
    if (phase !== "unlocked") return;
    let timer = 0;
    const arm = () => {
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
    },
    [cancelWork, dropKeys],
  );

  return { phase, email, vault, notice, signIn, completeSso, unlock, lock, logout, reveal };
}
