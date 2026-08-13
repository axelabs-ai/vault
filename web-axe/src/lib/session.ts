/**
 * 세션 — 메모리 전용 상태 기계 (login → unlocked ⇄ locked).
 *
 * 위생 규칙:
 *  · 영속 저장 전면 금지. localStorage 미사용, refresh token 미보관. 탭을 닫으면 전부 소멸한다.
 *  · 키는 React state 가 아니라 ref 에 둔다 — 렌더 트리·devtools 에 노출되지 않고, 잠금 시
 *    Uint8Array 를 fill(0) 으로 실제 덮어쓴 뒤 참조를 끊는다.
 *  · 잠금은 네트워크를 타지 않는다. 암호문 sync 원문은 그대로 들고 있고 키만 폐기하므로,
 *    해제는 마스터패스워드로 유저키를 다시 유도해 인덱스를 재구축하면 끝이다.
 *    (액세스 토큰 만료가 화면을 막지 않는 이유이기도 하다.)
 *
 * 한계(정직하게): JS 문자열은 zeroize 할 수 없다. 복호된 이름/계정 문자열과 잠깐 노출한
 * 비밀번호 문자열은 GC 가 회수할 때까지 힙에 남는다. 그래서 애초에 미리 푸는 평문을 최소화하고
 * (vault.ts 의 지연 복호), 키만큼은 확실히 덮어쓴다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate, prelogin, type PreloginResult } from "./auth.ts";
import {
  buildIndex,
  fetchSync,
  revealItem,
  unlockKeys,
  wipeKeys,
  type RevealedItem,
  type SecretField,
  type VaultData,
  type VaultItem,
  type VaultKeys,
} from "./vault.ts";

export type Phase = "login" | "unlocked" | "locked";

export const IDLE_LOCK_MS = 15 * 60 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export interface Session {
  phase: Phase;
  email: string;
  vault: VaultData | null;
  signIn: (email: string, password: string, twoFactorCode?: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  logout: () => void;
  /** 항목의 지정한 비밀 필드만 그때 푼다. 키는 밖으로 내보내지 않는다. */
  reveal: (item: VaultItem, fields: SecretField[]) => RevealedItem;
}

export function useSession(): Session {
  const [phase, setPhase] = useState<Phase>("login");
  const [email, setEmail] = useState("");
  const [vault, setVault] = useState<VaultData | null>(null);

  // 비밀 재료 — 렌더링되지 않는다.
  const keysRef = useRef<VaultKeys | null>(null);
  const rawSyncRef = useRef<Record<string, unknown> | null>(null);
  const preRef = useRef<PreloginResult | null>(null);
  const emailRef = useRef("");

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
    dropKeys();
    rawSyncRef.current = null;
    preRef.current = null;
    emailRef.current = "";
    setVault(null);
    setEmail("");
    setPhase("login");
  }, [dropKeys]);

  const signIn = useCallback(async (emailInput: string, password: string, twoFactorCode?: string) => {
    const pre = await prelogin(emailInput);
    const auth = await authenticate(emailInput, password, pre, twoFactorCode);
    const raw = await fetchSync(auth.accessToken);
    // ponytail: WASM KDF 가 메인 스레드를 잠깐 막는다 (argon2id 기준 수백 ms).
    // 체감 지연이 문제가 되면 worker 로 옮긴다.
    const keys = unlockKeys(raw, auth.email, password, pre.kdf);
    const data = buildIndex(raw, keys);

    dropKeys();
    keysRef.current = keys;
    rawSyncRef.current = raw;
    preRef.current = pre;
    emailRef.current = auth.email;
    setEmail(auth.email);
    setVault(data);
    setPhase("unlocked");
  }, [dropKeys]);

  const unlock = useCallback(async (password: string) => {
    const raw = rawSyncRef.current;
    const pre = preRef.current;
    if (!raw || !pre) throw new Error("잠금 해제할 세션이 없다. 다시 로그인하라.");
    const keys = unlockKeys(raw, emailRef.current, password, pre.kdf);
    dropKeys();
    keysRef.current = keys;
    setVault(buildIndex(raw, keys));
    setPhase("unlocked");
  }, [dropKeys]);

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

  return { phase, email, vault, signIn, unlock, lock, logout, reveal };
}
