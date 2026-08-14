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
import { PROVIDER_LABELS, TwoFactorRequiredError, PROVIDER_AUTHENTICATOR } from "../lib/auth.ts";
import { SDK_VERSION } from "../sdk.ts";

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

/** 패턴 크롬. 좌측 서사(context) + 우측 카드(stage) — 두 화면이 공유한다. */
function AuthShell({ heading, lead, children }: { heading: string; lead: string; children: ReactNode }) {
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
              <strong lang="en">Zero persistence</strong> 키·토큰·평문 어느 것도 저장하지 않습니다. 탭을
              닫으면 사라집니다.
            </span>
          </li>
          <li>
            <span className="axe-pattern-auth__trust-index">02</span>
            <span>
              <strong lang="en">Idle lock</strong> 15분간 조작이 없으면 메모리의 키를 폐기합니다.
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
          <div className="axe-pattern-auth__card-brand">
            <span className="axe-logo axe-logo--sm">AXE</span>
            <span lang="en">Vault</span>
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
}

export function LoginScreen({ onSignIn }: LoginScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [providers, setProviders] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    try {
      await onSignIn(email, password, providers ? code : undefined);
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        setProviders(err.providers);
        setError(null);
      } else {
        setError(describe(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      heading="금고 열기"
      lead="이메일과 마스터 패스워드로 이 브라우저에서 직접 금고를 복호합니다."
    >
      <form className="axe-pattern-auth__form" onSubmit={submit}>
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
          disabled={busy || (!!providers && !codeSupported)}
          aria-busy={busy}
        >
          {busy ? "여는 중…" : providers ? "코드 확인하고 열기" : "금고 열기"}
        </button>
      </form>

      <p className="axe-pattern-auth__privacy">
        SSO 로그인은 P1 범위 밖입니다. 이 서버는 SSO 를 <em>인증</em>에만 쓰고 금고 세션 해제에는 쓰지
        않도록 설정돼 있어(SSO_AUTH_ONLY_NOT_SESSION), 어느 경로로 들어오든 금고를 열려면 마스터
        패스워드가 필요합니다. SSO 로 들어가야 한다면 <a href={STOCK_VAULT_URL}>기본 볼트</a>를 쓰세요.
      </p>
    </AuthShell>
  );
}

interface LockScreenProps {
  email: string;
  onUnlock: (password: string) => Promise<void>;
  onLogout: () => void;
}

export function LockScreen({ email, onUnlock, onLogout }: LockScreenProps) {
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
    <AuthShell heading="금고가 잠겼습니다" lead={`${email} · 마스터 패스워드로 다시 엽니다.`}>
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
            서버를 다시 부르지 않습니다 — 메모리에 남은 암호문을 다시 풀 뿐입니다.
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
        다른 계정으로 들어가려면 <button className="axe-btn axe-btn--ghost axe-btn--sm" type="button" onClick={onLogout}>로그아웃</button> 후 다시 로그인하세요.
      </p>
    </AuthShell>
  );
}
