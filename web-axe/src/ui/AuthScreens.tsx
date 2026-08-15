/**
 * 로그인 / 잠금해제 화면.
 *
 * @axe/ui Authentication 페이지 패턴(.axe-pattern-auth)을 그대로 조립한다. 이 패턴은
 * core-data 프로파일에서 "완전"하다고 명시된 표면이라 필요한 프리미티브
 * (Button·Input·FormField·Logo·StatusBanner)가 전부 번들에 있다.
 * 새 시각 클래스는 하나도 만들지 않는다 — 디자인 결정은 @axe/ui 한 곳에서만 한다.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { describe } from "../lib/api.ts";
import { CLASSIC_ORIGIN } from "../lib/classic.ts";
import { PROVIDER_LABELS, TwoFactorRequiredError, PROVIDER_AUTHENTICATOR, twoFactorRejection } from "../lib/auth.ts";
import { beginSso, describeSsoFailure, type SsoHandoff } from "../lib/sso.ts";
import { SDK_VERSION } from "../sdk.ts";
import { ServiceSwitcher } from "./ServiceSwitcher.tsx";

/**
 * 스톡 볼트 — SSO·계정 설정·항목 편집처럼 P1 밖의 일은 여기로 보낸다.
 * 2026-08-14 컷오버로 루트(`/`)는 이 앱이 됐다. 스톡 볼트는 별도 호스트로 옮겨졌다.
 */
const STOCK_VAULT_URL = CLASSIC_ORIGIN;

function StatusBanner({ tone, title, description }: { tone: "error" | "info"; title: string; description?: ReactNode }) {
  return (
    <output className={`axe-status-banner axe-status-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="axe-status-banner__icon" aria-hidden="true">
        {tone === "error" ? "✕" : "ⓘ"}
      </span>
      <div className="axe-status-banner__body">
        <div className="axe-status-banner__title">{title}</div>
        {description && <div className="axe-status-banner__description">{description}</div>}
      </div>
    </output>
  );
}

/**
 * 패턴 크롬. 좌측 서사(context) + 우측 카드(stage) — 두 화면이 공유한다.
 *
 * `pending` = SSO 인증만 끝나고 아직 아무것도 봉인하지 못한 구간. 공용 신뢰 문구가 그대로 서면
 * "탭에 남는 것은 암호문뿐" 이라고 **거짓말을 하게 된다** — 그 구간에서는 인증 결과가 평문으로
 * 메모리에 있고 저장분은 없다. 그래서 01·02 카드를 그 구간의 사실로 갈아 끼운다.
 */
function AuthShell({
  heading,
  lead,
  pending,
  children,
}: {
  heading: string;
  lead: string;
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="axe-pattern-auth">
      <a className="axe-pattern-skip-link" href="#auth-panel">
        로그인 양식으로 건너뛰기
      </a>

      <section className="axe-pattern-auth__context" aria-labelledby="auth-context-title">
        <div className="axe-pattern-auth__context-top">
          <span className="axe-logo">AXE Vault</span>
          <span lang="en">Password manager</span>
        </div>

        <div className="axe-pattern-auth__context-copy">
          <span className="axe-pattern-auth__context-kicker" lang="en">
            End-to-end encrypted
          </span>
          <p id="auth-context-title" className="axe-pattern-auth__context-title">
            금고는 브라우저 안에서만 열립니다.
          </p>
          <p>
            마스터 패스워드는 서버로 전송되지 않습니다. 키 유도와 복호는 전부 이 탭 안에서
            Bitwarden 공식 크립토가 수행하고, 서버는 암호문만 돌려줍니다.
          </p>
        </div>

        <ul className="axe-pattern-auth__trust-list">
          <li>
            <span className="axe-pattern-auth__trust-index">01</span>
            <span>
              <strong lang="en">Keys the page can't read</strong> 마스터 패스워드와 복호 키는 이 탭
              메모리에 있습니다.{" "}
              {pending
                ? "지금은 SSO 인증 결과를 이 탭 메모리에만 들고 있고, 저장된 것은 아직 없습니다 — 마스터 패스워드를 넣으면 그때 세션이 봉인돼 저장됩니다."
                : "새로고침을 넘기기 위해 키 하나를 브라우저가 대신 보관합니다. 페이지가 그 바이트를 읽어 낼 수 없는 형태(non-extractable)라 이 앱은 열쇠를 다룰 때도 손잡이만 잡습니다 — 나머지 저장분은 전부 암호문입니다. 다만 이건 기기·브라우저 프로필을 손에 넣은 사람까지 막아 주는 보관은 아닙니다."}
            </span>
          </li>
          <li>
            <span className="axe-pattern-auth__trust-index">02</span>
            <span>
              {pending ? (
                <>
                  <strong lang="en">Time-boxed</strong> 이 인증 상태는 15분 뒤 만료됩니다. 그때까지
                  마스터 패스워드를 넣지 않거나 새로고침하면, SSO 부터 다시 시작합니다.
                </>
              ) : (
                <>
                  <strong lang="en">Idle lock</strong> 15분간 조작이 없거나, 직접 잠그거나,
                  로그아웃하면 메모리의 키도 브라우저가 보관하던 키도 폐기합니다. 탭을 닫으면
                  세션 암호문이 함께 사라지므로, 어딘가 키가 남아 있어도 그 키로 열 대상이
                  없습니다 — 남은 기록을 치우는 것은 저장소 정리일 뿐입니다. 그 안에서의
                  새로고침만 쓰던 금고 화면 그대로 이어집니다.
                </>
              )}
            </span>
          </li>
          <li>
            <span className="axe-pattern-auth__trust-index">03</span>
            <span>
              <strong lang="en">Official crypto</strong> 알고리즘은 한 줄도 자체 구현이 아닙니다 —
              @bitwarden/sdk-internal {SDK_VERSION}.
            </span>
          </li>
        </ul>

        <div className="axe-pattern-auth__context-foot" lang="en">
          <span aria-hidden="true" />
          vault.axelabs.ai
        </div>
      </section>

      <section className="axe-pattern-auth__stage" aria-label="로그인">
        <div className="axe-pattern-auth__card" id="auth-panel" tabIndex={-1}>
          {/*
            서비스 전환기는 **카드 헤더**에 있다. 좌측 브랜드 패널의 같은 자리
            (`__context-top` 의 후행 요소)에도 넣을 수 있지만, 패턴이 ≤799.98px 에서 그
            자리를 접는다(`.axe-pattern-auth__context-top > span { display: none }` — 좁은
            폭에서 그 행은 로고만 남긴다). 카드 헤더는 전 폭에서 서므로 모바일에서도 전환기가
            닿는다. 원래 이 자리에 있던 "Vault" 라벨을 전환기가 대신한다 — 같은 말을 하면서
            누를 수 있다.
          */}
          <div className="axe-pattern-auth__card-brand">
            <span className="axe-logo axe-logo--sm">AXE</span>
            <ServiceSwitcher />
          </div>

          <header className="axe-pattern-auth__card-header">
            <h1>{heading}</h1>
            <p>{lead}</p>
          </header>

          {children}
        </div>

        <div className="axe-pattern-auth__support">
          <span>항목 편집·공유·계정 설정이 필요하신가요?</span>
          <a href={STOCK_VAULT_URL}>기본 볼트 열기</a>
        </div>
      </section>
    </main>
  );
}

interface LoginScreenProps {
  onSignIn: (email: string, password: string, twoFactorCode?: string) => Promise<void>;
  /** 저장된 탭 세션이 서버에 거부돼 여기로 되돌아왔다면 그 사유. */
  notice?: string | null;
}

export function LoginScreen({ onSignIn, notice }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [providers, setProviders] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // 2FA 단계로 넘어가면 코드 칸으로 초점을 옮긴다 — 손이 멈추지 않게.
  useEffect(() => {
    if (providers) codeRef.current?.focus();
  }, [providers]);

  const codeSupported = !providers || providers.includes(PROVIDER_AUTHENTICATOR);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const submitted = providers ? code : undefined;
    try {
      await onSignIn(email, password, submitted);
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        setProviders(err.providers);
        // 코드를 제출했는데 같은 요구가 돌아왔다 = 거절이다. 침묵하면 안 된다.
        setError(twoFactorRejection(err, submitted));
      } else {
        setError(describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * SSO 시작. prevalidate 가 성공해야만 이동한다 — SSO 가 꺼져 있거나 서버가 응답하지
   * 않으면 여기서 갈라져 화면에 사유가 남는다(빈 화면으로 튕기지 않는다).
   */
  async function startSso() {
    setSsoBusy(true);
    setSsoError(null);
    try {
      location.assign(await beginSso());
    } catch (err) {
      setSsoError(describeSsoFailure(err) ?? describe(err));
      setSsoBusy(false);
    }
  }

  return (
    <AuthShell
      heading="금고 열기"
      lead="AXE 계정으로 인증하고, 마스터 패스워드로 이 브라우저에서 직접 복호합니다."
    >
      <form className="axe-pattern-auth__form" onSubmit={submit}>
        {/* 새로고침으로 되살린 세션이 서버에 거부됐을 때만 뜬다 — 왜 잠금 화면이 아니라
            로그인 화면으로 왔는지 말해 주지 않으면 사용자는 이유를 알 길이 없다. */}
        {notice && (
          <StatusBanner tone="error" title="저장된 세션을 이어갈 수 없습니다 — 다시 로그인하세요" description={notice} />
        )}

        <button
          className={`axe-btn axe-btn--secondary axe-btn--lg axe-pattern-auth__provider${ssoBusy ? " axe-btn--loading" : ""}`}
          type="button"
          onClick={startSso}
          disabled={ssoBusy || busy}
          aria-busy={ssoBusy}
        >
          {ssoBusy ? "Entra 로 이동 중…" : "SSO 로 로그인"}
        </button>

        {ssoError && <StatusBanner tone="error" title="SSO 를 시작하지 못했습니다" description={ssoError} />}

        <p className="axe-form-field__hint">
          Microsoft Entra 로 신원을 확인한 뒤, 같은 자리에서 마스터 패스워드를 한 번 더 받습니다 —
          유저키가 마스터 패스워드로 감싸여 있어 SSO 만으로는 금고가 열리지 않습니다.
        </p>

        <div className="axe-pattern-auth__divider">
          <span>또는 이메일로</span>
        </div>

        <div className="axe-form-field">
          <label className="axe-label axe-form-field__label" htmlFor="email">
            이메일
          </label>
          <div className="axe-form-field__control">
            <input
              id="email"
              className="axe-input"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@axellc.com"
            />
          </div>
        </div>

        <div className="axe-form-field">
          <label className="axe-label axe-form-field__label" htmlFor="master-password">
            마스터 패스워드
          </label>
          <div className="axe-form-field__control">
            <input
              id="master-password"
              className="axe-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <p className="axe-form-field__hint">서버로 전송되지 않습니다. 키 유도는 이 탭에서 일어납니다.</p>
        </div>

        {providers && codeSupported && (
          <div className="axe-form-field">
            <label className="axe-label axe-form-field__label" htmlFor="twofactor">
              2단계 인증 코드
            </label>
            <div className="axe-form-field__control">
              <input
                id="twofactor"
                ref={codeRef}
                className="axe-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
              />
            </div>
            <p className="axe-form-field__hint">인증 앱에 표시된 6자리 코드</p>
          </div>
        )}

        {providers && !codeSupported && (
          <StatusBanner
            tone="error"
            title="이 2단계 인증 방식은 P1 미지원"
            description={
              <>
                서버가 요구한 방식: {providers.map((p) => PROVIDER_LABELS[p] ?? `provider ${p}`).join(", ")}. 인증
                앱(TOTP)만 지원합니다 — <a href={STOCK_VAULT_URL}>기본 볼트</a>를 이용하세요.
              </>
            }
          />
        )}

        {error && <StatusBanner tone="error" title="로그인 실패" description={error} />}

        <button
          className={`axe-btn axe-btn--primary axe-btn--lg axe-pattern-auth__email-action${busy ? " axe-btn--loading" : ""}`}
          type="submit"
          disabled={busy || ssoBusy || (!!providers && !codeSupported)}
          aria-busy={busy}
        >
          {busy ? "여는 중…" : providers ? "코드 확인하고 열기" : "금고 열기"}
        </button>
      </form>

      <p className="axe-pattern-auth__privacy">
        어느 경로로 들어오든 금고를 여는 것은 마스터 패스워드입니다. 이 서버는 SSO 를 <em>인증</em>에만
        쓰도록 설정돼 있고(SSO_AUTH_ONLY_NOT_SESSION), 그와 별개로 유저키 자체가 마스터 패스워드로
        감싸여 저장됩니다. 마스터 패스워드는 어느 쪽 경로에서도 서버로 전송되지 않습니다.
      </p>
    </AuthShell>
  );
}

interface LockScreenProps {
  email: string;
  onUnlock: (password: string) => Promise<void>;
  onLogout: () => void;
  /** SSO 직후처럼 "잠겼다"가 아니라 "2단계"인 맥락에서 문구만 갈아 끼운다. */
  heading?: string;
  lead?: string;
  /**
   * SSO 인증만 끝나고 아직 아무것도 봉인하지 못한 구간인가.
   *
   * 이때는 "탭에 남은 것은 암호문뿐" 이라는 취지의 문구를 쓰면 **거짓말이 된다** — 봉인 전이라
   * 인증 결과가 평문으로 메모리에 있고, 저장분은 아예 없다. 그래서 이 구간 전용 문구를 쓴다.
   */
  pending?: boolean;
}

export function LockScreen({ email, onUnlock, onLogout, heading, lead, pending }: LockScreenProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
      setPassword("");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      heading={heading ?? "금고가 잠겼습니다"}
      lead={lead ?? `${email} · 마스터 패스워드로 다시 엽니다.`}
      pending={pending}
    >
      <form className="axe-pattern-auth__form" onSubmit={submit}>
        <div className="axe-form-field">
          <label className="axe-label axe-form-field__label" htmlFor="unlock-password">
            마스터 패스워드
          </label>
          <div className="axe-form-field__control">
            <input
              id="unlock-password"
              className="axe-input"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <p className="axe-form-field__hint">
            {pending
              ? "마스터 패스워드는 서버로 전송되지 않습니다. 지금은 인증 결과만 이 탭 메모리에 있고 아직 아무것도 저장되지 않았습니다 — 마스터 패스워드를 넣어야 세션이 봉인돼 저장됩니다. 새로고침하거나 15분이 지나면 SSO 부터 다시 합니다."
              : "마스터 패스워드는 서버로 전송되지 않습니다 — 이 탭에 남은 암호문을 여기서 다시 풀 뿐입니다. 이 화면은 세션이 실제로 잠겼을 때만 뜹니다(유휴 15분 초과·수동 잠금·이어가기 실패). 잠기지 않은 새로고침은 묻지 않고 그대로 이어집니다."}
          </p>
        </div>

        {error && <StatusBanner tone="error" title="잠금 해제 실패" description={error} />}

        <button
          className={`axe-btn axe-btn--primary axe-btn--lg axe-pattern-auth__email-action${busy ? " axe-btn--loading" : ""}`}
          type="submit"
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "여는 중…" : "잠금 해제"}
        </button>
      </form>

      <p className="axe-pattern-auth__privacy">
        다른 계정으로 들어가려면 <button className="axe-btn axe-btn--ghost axe-btn--sm" type="button" onClick={onLogout}>로그아웃</button> 후 다시 로그인하세요. 로그아웃은 이 탭에 남은 암호문과 토큰까지 지웁니다.
      </p>
    </AuthShell>
  );
}

/**
 * 이어가기 화면 — 새로고침 직후 봉인을 푸는 짧은 구간.
 *
 * 여기서 잠금 화면을 스쳐 보이면 사용자는 마스터 패스워드를 넣으려 든다. 사실은 넣을 필요가
 * 없으므로 그 사실만 말하고 기다린다. 실패하면 곧바로 진짜 잠금 화면이 대신 선다.
 *
 * `onCancel` = 기다리지 않고 마스터 패스워드로 열기. 서버 왕복에는 시한이 없으므로(이 앱의
 * fetch 는 어디에도 타임아웃이 없다) 출구가 하나는 있어야 한다 — 없으면 응답 없는 서버가
 * 이 화면을 막다른 길로 만든다.
 */
export function ResumeScreen({ email, onCancel }: { email: string; onCancel: () => void }) {
  return (
    <AuthShell
      heading="쓰던 금고를 이어갑니다"
      lead={
        email
          ? `${email} · 잠기지 않은 세션이라 마스터 패스워드가 필요 없습니다.`
          : "잠기지 않은 세션이라 마스터 패스워드가 필요 없습니다."
      }
    >
      <div className="axe-pattern-auth__form">
        <StatusBanner
          tone="info"
          title="봉인을 푸는 중…"
          description="브라우저가 보관하던 키로 이 탭의 세션을 되열고, 서버에서 최신 암호문을 받아 옵니다."
        />
        <button className="axe-btn axe-btn--secondary axe-btn--lg axe-pattern-auth__email-action" type="button" onClick={onCancel}>
          기다리지 않고 마스터 패스워드로 열기
        </button>
      </div>
    </AuthShell>
  );
}

interface SsoScreenProps {
  handoff: SsoHandoff;
  email: string;
  /** 인증 단계가 끝났는가 — session.phase 가 "login" 을 벗어났으면 끝난 것이다. */
  authenticated: boolean;
  onComplete: (code: string, verifier: string, twoFactorCode?: string) => Promise<void>;
  onUnlock: (password: string) => Promise<void>;
  onLogout: () => void;
}

/**
 * SSO 콜백 화면 — 2단 중 **1단(인증)** 을 끝내고 곧바로 2단(잠금해제)으로 넘긴다.
 *
 * 교환은 부팅 직후 한 번 자동으로 시작한다(사용자가 누를 것이 없다). StrictMode 의
 * 이중 마운트에도 code 를 두 번 쓰지 않도록 ref 로 1회를 보장한다 — 서버가 재교환을
 * 허용하긴 하지만(sso.rs:464) 두 번 칠 이유가 없다.
 */
export function SsoScreen({ handoff, email, authenticated, onComplete, onUnlock, onLogout }: SsoScreenProps) {
  const [providers, setProviders] = useState<number[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);

  async function exchange(twoFactorCode?: string) {
    setBusy(true);
    setError(null);
    try {
      await onComplete(handoff.code, handoff.verifier, twoFactorCode);
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        // 프로바이더 선택은 유지한다 — 코드가 거절돼도 폼은 그 자리에 남아야 한다.
        setProviders(err.providers);
        setError(twoFactorRejection(err, twoFactorCode));
      } else {
        setError(describeSsoFailure(err) ?? describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void exchange();
    // 마운트 1회. handoff 는 부팅 시 고정된 값이다.
  }, []);

  useEffect(() => {
    if (providers) codeRef.current?.focus();
  }, [providers]);

  // 인증이 끝났다 = 서버가 암호문을 내줬다. 남은 건 마스터 패스워드 한 단계뿐이다.
  if (authenticated) {
    return (
      <LockScreen
        email={email}
        onUnlock={onUnlock}
        onLogout={onLogout}
        heading="2단계 · 마스터 패스워드"
        lead={`${email} 로 인증했습니다. 금고 복호에는 마스터 패스워드가 필요합니다.`}
        // 이 화면은 정의상 SSO 도착 직후다 — 아직 봉인 전이므로 그 사실대로 말한다.
        pending
      />
    );
  }

  const codeSupported = !providers || providers.includes(PROVIDER_AUTHENTICATOR);
  /** 코드 폼이 떠 있다 = 사용자가 그 자리에서 다시 시도할 수 있다. */
  const retryable = !!error && !!providers && codeSupported;

  return (
    <AuthShell
      heading="SSO 인증 확인 중"
      lead="Microsoft Entra 가 보낸 인증 코드를 서버와 교환하고 있습니다."
    >
      <div className="axe-pattern-auth__form">
        {providers && codeSupported && (
          <form
            className="axe-pattern-auth__form"
            onSubmit={(e) => {
              e.preventDefault();
              void exchange(code);
            }}
          >
            <div className="axe-form-field">
              <label className="axe-label axe-form-field__label" htmlFor="sso-twofactor">
                2단계 인증 코드
              </label>
              <div className="axe-form-field__control">
                <input
                  id="sso-twofactor"
                  ref={codeRef}
                  className="axe-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="000000"
                />
              </div>
              <p className="axe-form-field__hint">인증 앱에 표시된 6자리 코드</p>
            </div>
            <button
              className={`axe-btn axe-btn--primary axe-btn--lg axe-pattern-auth__email-action${busy ? " axe-btn--loading" : ""}`}
              type="submit"
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "확인 중…" : "코드 확인"}
            </button>
          </form>
        )}

        {providers && !codeSupported && (
          <StatusBanner
            tone="error"
            title="이 2단계 인증 방식은 P1 미지원"
            description={
              <>
                서버가 요구한 방식: {providers.map((p) => PROVIDER_LABELS[p] ?? `provider ${p}`).join(", ")}. 인증
                앱(TOTP)만 지원합니다 — <a href={STOCK_VAULT_URL}>기본 볼트</a>를 이용하세요.
              </>
            }
          />
        )}

        {error && (
          <StatusBanner
            tone="error"
            title={retryable ? "인증 코드가 거절됐습니다" : "SSO 로그인 실패"}
            description={error}
          />
        )}

        {busy && !providers && <StatusBanner tone="info" title="인증 코드를 교환하는 중…" />}

        {/* 코드를 다시 넣으면 되는 상황에서는 되돌아가기를 권하지 않는다 — 로그인 화면으로
            나가면 SSO 를 처음부터 다시 해야 한다. */}
        {!retryable && (error || (providers && !codeSupported)) && (
          <a className="axe-btn axe-btn--secondary axe-btn--lg axe-pattern-auth__email-action" href="/">
            로그인 화면으로 돌아가기
          </a>
        )}
      </div>
    </AuthShell>
  );
}
