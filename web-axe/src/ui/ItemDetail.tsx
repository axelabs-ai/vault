/**
 * 우측 상세 패널 — @axe/ui workspace context rail (.axe-workspace-context).
 *
 * 비밀 위생:
 *  · 항목을 열면 notes·TOTP 시드만 복호한다. 비밀번호는 "보기"/"복사" 를 누른 순간에만 푼다.
 *  · 비밀번호 평문은 reveal 상태에서만 DOM 에 들어간다. 복사는 DOM 을 거치지 않는다.
 *  · 항목이 바뀌면 노출 상태를 즉시 되돌린다.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { describe } from "../lib/api.ts";
import { generateTotp, parseTotp, totpRemainingSeconds } from "../lib/totp.ts";
import { CIPHER_TYPE_LABEL, type RevealedItem, type SecretField, type VaultItem } from "../lib/vault.ts";

interface Props {
  item: VaultItem | null;
  location: string;
  reveal: (item: VaultItem, fields: SecretField[]) => RevealedItem;
}

/** 6자리는 3+3, 8자리는 4+4 로 끊어 읽기 쉽게. */
const groupCode = (code: string) => `${code.slice(0, Math.ceil(code.length / 2))} ${code.slice(Math.ceil(code.length / 2))}`;

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (tag: string, value: () => string | undefined) => {
    const v = value();
    if (!v) return;
    await navigator.clipboard.writeText(v);
    setCopied(tag);
  }, []);
  const reset = useCallback(() => setCopied(null), []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return { copied, copy, reset };
}

function CopyButton({ label, tag, copied, onCopy }: { label: string; tag: string; copied: string | null; onCopy: () => void }) {
  return (
    <button className="axe-btn axe-btn--ghost axe-btn--sm" type="button" onClick={onCopy}>
      {copied === tag ? "복사됨" : label}
    </button>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="axe-kv__key">{term}</dt>
      <dd className="axe-kv__value">{children}</dd>
    </>
  );
}

export function ItemDetail({ item, location, reveal }: Props) {
  const [opened, setOpened] = useState<RevealedItem>({});
  const [shownPassword, setShownPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ code: string; remaining: number; period: number } | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const { copied, copy, reset } = useCopy();

  // 항목 전환 = 노출 상태 초기화 + 표시용 필드만 복호.
  useEffect(() => {
    setShownPassword(null);
    setError(null);
    reset();
    if (!item) {
      setOpened({});
      return;
    }
    try {
      setOpened(reveal(item, ["totp", "notes"]));
    } catch (e) {
      setOpened({});
      setError(describe(e));
    }
  }, [item, reveal, reset]);

  // TOTP 는 초당 갱신한다. 시드는 화면에 절대 노출하지 않는다 (코드만).
  useEffect(() => {
    const seed = opened.totp;
    if (!seed) {
      setTotp(null);
      setTotpError(null);
      return;
    }
    let params;
    try {
      params = parseTotp(seed);
    } catch (e) {
      setTotp(null);
      setTotpError(describe(e));
      return;
    }
    setTotpError(null);
    let cancelled = false;
    const tick = async () => {
      try {
        const code = await generateTotp(params);
        if (!cancelled) setTotp({ code, remaining: totpRemainingSeconds(params.period), period: params.period });
      } catch (e) {
        if (!cancelled) setTotpError(describe(e));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [opened.totp]);

  if (!item) {
    return (
      <div className="axe-workspace-context">
        <div className="axe-workspace-context__body">
          <div className="axe-empty-state axe-empty-state--size-sm">
            <div className="axe-empty-state__icon" aria-hidden="true">
              ◇
            </div>
            <div className="axe-empty-state__title">항목을 선택하세요</div>
            <div className="axe-empty-state__description">왼쪽 목록에서 항목을 고르면 여기에 상세가 열립니다.</div>
          </div>
        </div>
      </div>
    );
  }

  const revealPassword = () => {
    try {
      setShownPassword(reveal(item, ["password"]).password ?? "");
    } catch (e) {
      setError(describe(e));
    }
  };

  return (
    <div className="axe-workspace-context">
      <div className="axe-workspace-context__header">
        <span className="axe-workspace-context__eyebrow">
          {CIPHER_TYPE_LABEL[item.type] ?? `유형 ${item.type}`}
        </span>
        <h2 className="axe-workspace-context__title">{item.name}</h2>
        <p className="axe-workspace-context__summary">{location}</p>
        <div className="axe-cluster axe-cluster--gap-1">
          <span className={`axe-badge${item.organizationId ? " axe-badge--info" : ""}`}>
            {item.organizationId ? "조직" : "개인"}
          </span>
          {item.favorite && <span className="axe-badge axe-badge--accent">즐겨찾기</span>}
          {item.reprompt && <span className="axe-badge axe-badge--warning">재확인 항목</span>}
        </div>
      </div>

      <div className="axe-workspace-context__body">
        {error && (
          <output className="axe-status-banner axe-status-banner--error" role="alert">
            <span className="axe-status-banner__icon" aria-hidden="true">
              ✕
            </span>
            <div className="axe-status-banner__body">
              <div className="axe-status-banner__title">복호 실패</div>
              <div className="axe-status-banner__description">{error}</div>
            </div>
          </output>
        )}

        {/* 좁은 패널이라 key 열을 줄인다 — 디자인 시스템이 노출한 knob(--axe-kv-key-w). */}
        <dl className="axe-kv axe-kv--compact" style={{ ["--axe-kv-key-w" as string]: "4.5rem" }}>
          {item.username && (
            <Row term="계정">
              <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
                <code className="axe-code-inline">{item.username}</code>
                <CopyButton
                  label="복사"
                  tag="username"
                  copied={copied}
                  onCopy={() => void copy("username", () => item.username)}
                />
              </div>
            </Row>
          )}

          {item.enc.password && (
            <Row term="비밀번호">
              <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
                <code className="axe-code-inline">{shownPassword ?? "••••••••••••"}</code>
                <button
                  className="axe-btn axe-btn--ghost axe-btn--sm"
                  type="button"
                  onClick={() => (shownPassword === null ? revealPassword() : setShownPassword(null))}
                  aria-pressed={shownPassword !== null}
                >
                  {shownPassword === null ? "보기" : "가리기"}
                </button>
                <CopyButton
                  label="복사"
                  tag="password"
                  copied={copied}
                  onCopy={() => void copy("password", () => reveal(item, ["password"]).password)}
                />
              </div>
            </Row>
          )}

          {item.enc.totp && (
            <Row term="TOTP">
              {totpError ? (
                <span className="axe-badge axe-badge--danger">{totpError}</span>
              ) : totp ? (
                <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
                  <code className="axe-code-inline">{groupCode(totp.code)}</code>
                  <span
                    className={`axe-badge${totp.remaining <= 5 ? " axe-badge--warning" : ""}`}
                    aria-label={`${totp.remaining}초 후 갱신`}
                  >
                    {totp.remaining}초
                  </span>
                  <CopyButton label="복사" tag="totp" copied={copied} onCopy={() => void copy("totp", () => totp.code)} />
                </div>
              ) : (
                <span className="axe-badge">계산 중…</span>
              )}
            </Row>
          )}

          {item.uris.length > 0 && (
            <Row term="주소">
              <div className="axe-stack axe-stack--gap-1">
                {item.uris.map((uri, i) => (
                  <div key={`${uri}-${i}`} className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
                    {/^https?:\/\//i.test(uri) ? (
                      // 볼트 항목의 URI 는 서버가 준 값이다. 새 탭 + noopener 로만 연다.
                      <a href={uri} target="_blank" rel="noopener noreferrer nofollow">
                        {uri}
                      </a>
                    ) : (
                      <code className="axe-code-inline">{uri}</code>
                    )}
                    <CopyButton label="복사" tag={`uri-${i}`} copied={copied} onCopy={() => void copy(`uri-${i}`, () => uri)} />
                  </div>
                ))}
              </div>
            </Row>
          )}

          {opened.notes && (
            <Row term="노트">
              <div className="axe-stack axe-stack--gap-2">
                <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{opened.notes}</p>
                <div>
                  <CopyButton label="노트 복사" tag="notes" copied={copied} onCopy={() => void copy("notes", () => opened.notes)} />
                </div>
              </div>
            </Row>
          )}
        </dl>

        {item.type !== 1 && item.type !== 2 && (
          <div className="axe-callout axe-callout--note" role="note">
            <div className="axe-callout__icon" aria-hidden="true">
              ⓘ
            </div>
            <div className="axe-callout__content">
              <div className="axe-callout__title">{CIPHER_TYPE_LABEL[item.type]} 전용 필드는 P1 미지원</div>
              카드 번호·신원 항목의 개별 필드는 아직 렌더링하지 않습니다. 기본 볼트에서 확인하세요.
            </div>
          </div>
        )}
      </div>

      <div className="axe-workspace-context__footer">
        <code className="axe-code-inline">{item.id}</code>
      </div>
    </div>
  );
}
