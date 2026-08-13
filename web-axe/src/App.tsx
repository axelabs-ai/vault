import { useState } from "react";
import {
  authenticate,
  describe,
  prelogin,
  syncAndDecrypt,
  type AuthResult,
  type SyncResult,
} from "./vault.ts";
import { SDK_VERSION, type PasswordPreloginResponse } from "./sdk.ts";

type Status = { kind: "idle" | "busy" | "error"; msg?: string };

export default function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [pre, setPre] = useState<PasswordPreloginResponse | null>(null);
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState<string | null>(null);

  const busy = status.kind === "busy";

  async function run<T>(label: string, fn: () => Promise<T>) {
    setStatus({ kind: "busy", msg: label });
    try {
      await fn();
      setStatus({ kind: "idle" });
    } catch (e) {
      console.error(e);
      setStatus({ kind: "error", msg: `${label} 실패 — ${describe(e)}` });
    }
  }

  const onPrelogin = () =>
    run("prelogin", async () => {
      setPre(await prelogin(email));
    });

  const onLogin = () =>
    run("로그인 + sync + 복호", async () => {
      const p = pre ?? (await prelogin(email));
      setPre(p);
      const a = await authenticate(email, password, totp, p);
      setAuth(a);
      setSync(await syncAndDecrypt(a, email, password));
    });

  async function copy(value: string, tag: string) {
    await navigator.clipboard.writeText(value);
    setCopied(tag);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="wrap">
      <header>
        <h1>
          <span>AXE</span> Vault — PoC 스파이크
        </h1>
        <p>
          브라우저에서 Bitwarden 공식 WASM 크립토로 vault.axelabs.ai 로그인 → sync → cipher 복호가
          되는지만 검증한다. 비밀은 브라우저 밖으로 나가지 않는다 (서버 컴포넌트 없음).
          <br />
          <span className="badge">@bitwarden/sdk-internal {SDK_VERSION}</span>{" "}
          <span className="badge">dev proxy → vault.axelabs.ai</span>
        </p>
      </header>

      <div className="card">
        <h2>1. prelogin (익명 · 자격증명 불요)</h2>
        <label htmlFor="email">이메일</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@axellc.com"
        />
        <div className="actions">
          <button onClick={onPrelogin} disabled={busy || !email}>
            prelogin 확인
          </button>
          {pre && <span className="ok">✓ KDF 파라미터 수신</span>}
        </div>
        {pre && <pre style={{ marginTop: 12 }}>{JSON.stringify(pre, null, 2)}</pre>}
      </div>

      <div className="card">
        <h2>2. 로그인 → sync → 복호</h2>
        <div className="row">
          <div>
            <label htmlFor="pw">마스터 패스워드</label>
            <input
              id="pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="totp">2FA 코드 (설정된 경우만)</label>
            <input
              id="totp"
              inputMode="numeric"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="000000"
            />
          </div>
        </div>
        <div className="actions">
          <button className="primary" onClick={onLogin} disabled={busy || !email || !password}>
            로그인 + 동기화
          </button>
          {busy && <span className="badge">{status.msg} 진행 중…</span>}
        </div>
        <p className="note">
          Lane A = SDK 의 login_via_password(최대 재사용). 실패 시 Lane B(토큰 grant 직접 + SDK KDF
          프리미티브)로 자동 폴백한다.
        </p>
      </div>

      {status.kind === "error" && (
        <div className="card err">
          <h2 style={{ color: "inherit" }}>에러</h2>
          <pre className="err">{status.msg}</pre>
          <p className="note">브라우저 콘솔에 원본 객체가 그대로 찍혀 있다.</p>
        </div>
      )}

      {auth && (
        <div className="card">
          <h2>인증 결과</h2>
          <div className="stats">
            <div>
              <b>{auth.lane}</b>사용된 lane
            </div>
            <div>
              <b>{auth.accessToken ? "발급" : "없음"}</b>access token
            </div>
            <div>
              <b>{auth.masterPasswordUnlockPresent ? "예" : "아니오"}</b>
              masterPasswordUnlock 계약
            </div>
          </div>
          {auth.laneANote && <pre>{auth.laneANote}</pre>}
        </div>
      )}

      {sync && (
        <div className="card">
          <h2>sync + 복호</h2>
          <div className="stats">
            <div>
              <b>{sync.cipherCount}</b>총 cipher
            </div>
            <div>
              <b>{sync.organizationCount}</b>조직
            </div>
            <div>
              <b className="ok">{sync.decryptedOk}</b>복호 성공 (최대 25건 표시)
            </div>
            <div>
              <b style={{ color: sync.decryptedFail ? "var(--danger)" : undefined }}>
                {sync.decryptedFail}
              </b>
              복호 실패
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>이름 (복호됨)</th>
                <th>계정</th>
                <th>범위</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sync.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    {it.name}
                    {it.error && (
                      <div className="mono" style={{ color: "var(--danger)" }}>
                        {it.error}
                      </div>
                    )}
                  </td>
                  <td className="mono">{it.username ?? "—"}</td>
                  <td>
                    <span className="badge">{it.scope === "organization" ? "org" : "personal"}</span>
                  </td>
                  <td>
                    {it.password && (
                      <button className="mini" onClick={() => copy(it.password!, it.id)}>
                        {copied === it.id ? "복사됨" : "비밀번호 복사"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
