/**
 * 세션 — 상태 기계 (login → unlocked ⇄ locked).
 *
 * 위생 규칙:
 *  · **복호 키는 메모리에만 산다.** 탭 세션(sessionStorage)에 남기는 것은 서버가 어차피 가진
 *    값뿐이다 — 세션 토큰과, 마스터 패스워드로 감싸인 채인 유저키 암호문(+KDF 파라미터·이메일).
 *    그래서 새로고침은 **로그아웃이 아니라 잠금**이 된다: 탭이 암호문을 되찾고, 그것을 풀
 *    마스터 패스워드만 한 번 더 받는다. 무엇이 저장되는지는 lib/persist.ts 한 곳이 정한다.
 *  · localStorage 는 전면 금지. 탭을 닫으면 브라우저가 sessionStorage 를 지우고, 명시적
 *    로그아웃은 우리가 지운다.
 *  · 키는 React state 가 아니라 ref 에 둔다 — 렌더 트리·devtools 에 노출되지 않고, 잠금 시
 *    Uint8Array 를 fill(0) 으로 실제 덮어쓴 뒤 참조를 끊는다.
 *  · 잠금(유휴·수동)은 네트워크를 타지 않는다. 이 탭이 암호문 sync 원문을 그대로 들고 있고
 *    키만 폐기하므로, 해제는 유저키를 다시 유도해 인덱스를 재구축하면 끝이다.
 *    새로고침으로 되살아난 세션만 그 암호문이 없어 서버에서 한 번 다시 받아 온다.
 *
 * 한계(정직하게): JS 문자열은 zeroize 할 수 없다. 복호된 이름/계정 문자열과 잠깐 노출한
 * 비밀번호 문자열은 GC 가 회수할 때까지 힙에 남는다. 그래서 애초에 미리 푸는 평문을 최소화하고
 * (vault.ts 의 지연 복호), 키만큼은 확실히 덮어쓴다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, describe } from "./api.ts";
import { authenticate, prelogin, refreshTokens } from "./auth.ts";
import {
  clearSession,
  restoreFailurePhase,
  restoreSession,
  saveSession,
  type Restored,
  type SessionSeed,
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

export interface Session {
  phase: Phase;
  email: string;
  vault: VaultData | null;
  /** 저장된 세션이 서버에 거부돼 로그인으로 되돌아왔을 때의 사유. 로그인 화면이 띄운다. */
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
  /** 저장된 세션의 메모리 사본. 여기 있는 값은 전부 sessionStorage 에도 있는 값이다. */
  const storedRef = useRef<StoredSession | null>(boot.session);

  const dropKeys = useCallback(() => {
    wipeKeys(keysRef.current);
    keysRef.current = null;
  }, []);

  const lock = useCallback(() => {
    dropKeys();
    setVault(null);
    setPhase((p) => (p === "unlocked" ? "locked" : p));
  }, [dropKeys]);

  const logout = useCallback(() => {
    clearSession();
    dropKeys();
    rawSyncRef.current = null;
    storedRef.current = null;
    setVault(null);
    setEmail("");
    setNotice(null);
    setPhase("login");
  }, [dropKeys]);

  /** 인증 직후 공통 마무리 — 저장분을 갱신하고 암호문을 메모리에 건다. */
  const adopt = useCallback((raw: Record<string, unknown>, seed: SessionSeed) => {
    rawSyncRef.current = raw;
    storedRef.current = saveSession(seed);
    setEmail(seed.email);
    setNotice(null);
  }, []);

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
      const keys: VaultKeys = { userKey, orgKeys: deriveOrgKeys(raw, userKey) };
      const data = buildIndex(raw, keys);

      dropKeys();
      keysRef.current = keys;
      adopt(raw, {
        email: auth.email,
        kdf: pre.kdf,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        encUserKey,
      });
      setVault(data);
      setPhase("unlocked");
    },
    [adopt, dropKeys],
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
      dropKeys();
      adopt(raw, {
        email: mail,
        kdf: auth.kdf,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        encUserKey,
      });
      setVault(null);
      setPhase("locked");
    },
    [adopt, dropKeys],
  );

  /**
   * 새로고침으로 되살아난 세션의 암호문 다시 받기. 액세스 토큰이 만료(401)됐으면 리프레시
   * 토큰으로 한 번 되살려 보고, 새 토큰을 저장분에 반영한다.
   */
  const pullSync = useCallback(async (stored: StoredSession) => {
    try {
      return await fetchSync(stored.accessToken);
    } catch (e) {
      if (!stored.refreshToken || !(e instanceof HttpError) || e.status !== 401) throw e;
      const rotated = await refreshTokens(stored.refreshToken);
      const next = saveSession({ ...stored, ...rotated });
      storedRef.current = next;
      return await fetchSync(next.accessToken);
    }
  }, []);

  /**
   * 잠금 해제. 갈래는 둘이지만 사람에게는 한 화면이다:
   *  · 이 탭이 암호문을 아직 들고 있으면(유휴·수동 잠금) 메모리에서 바로 푼다 — 네트워크 없음.
   *  · 새로고침으로 되살아난 세션이면 저장된 토큰으로 암호문을 다시 받아 온다.
   * 어느 쪽이든 **유저키 복호가 먼저다** — 마스터 패스워드가 틀리면 서버를 부르기 전에 끝난다.
   */
  const unlock = useCallback(
    async (password: string) => {
      const stored = storedRef.current;
      if (!stored) throw new Error("잠금 해제할 세션이 없다. 다시 로그인하라.");

      // 이 단계의 입력 중 사용자가 준 것은 패스워드뿐이다 (암호문·KDF·이메일은 서버가 준 값이고
      // 저장 시 검사를 통과했다). 그래서 여기서의 실패 = 패스워드 불일치다. SDK 원문
      // ("The provided key is not the expected type")을 그대로 띄우면 사용자가 다음 행동을
      // 고를 수 없다 — 이 화면은 이제 새로고침마다 지나가는 자리라 더욱 그렇다.
      let userKey: Uint8Array;
      try {
        userKey = decryptUserKey(stored.encUserKey, stored.email, password, stored.kdf);
      } catch {
        throw new Error("마스터 패스워드가 맞지 않습니다. 다시 입력하세요.");
      }

      let raw: Record<string, unknown>;
      try {
        raw = rawSyncRef.current ?? (await pullSync(stored));
      } catch (e) {
        userKey.fill(0);
        // 서버가 세션을 거부했으면 저장분은 쓸모없다 — 지우고 사유와 함께 로그인 화면으로.
        // 네트워크 실패면 잠금 화면에 남아 다시 시도하게 한다 (persist.ts 참조).
        if (restoreFailurePhase(e) === "login") {
          storedRef.current = null;
          rawSyncRef.current = null;
          setEmail("");
          setNotice(describe(e));
          setPhase("login");
        }
        throw e;
      }

      const keys: VaultKeys = { userKey, orgKeys: deriveOrgKeys(raw, userKey) };
      dropKeys();
      keysRef.current = keys;
      rawSyncRef.current = raw;
      setVault(buildIndex(raw, keys));
      setPhase("unlocked");
    },
    [dropKeys, pullSync],
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

  // 언마운트(탭 이탈 포함) 시 키를 덮어쓴다. 메모리는 어차피 사라지지만 명시적으로 지운다.
  useEffect(() => dropKeys, [dropKeys]);

  return { phase, email, vault, notice, signIn, completeSso, unlock, lock, logout, reveal };
}
