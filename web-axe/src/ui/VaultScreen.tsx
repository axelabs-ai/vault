/**
 * 금고 화면 — @axe/ui 워크스페이스 3-zone 셸.
 *
 *   .axe-app-shell.axe-workspace-shell[data-shell="docs"]
 *     > .axe-app-shell__topbar > .axe-workspace-bar        (검색 · 세션 조작)
 *     > .axe-app-shell__main
 *         > .axe-app-shell__sidebar > .axe-workspace-rail  (폴더·컬렉션 내비)
 *         > .axe-app-shell__content                        (항목 목록)
 *         > .axe-app-shell__toc > .axe-workspace-context   (항목 상세)
 *
 * 스톡 볼트가 못 하는 진짜 3-zone 이 이 프로젝트의 존재 이유다 — 목록과 상세가 같은 화면에
 * 공존하고, 좌측 레일이 소속(폴더/컬렉션)을 상시 보여 준다.
 */
import { useMemo, useState, type ReactNode } from "react";
import { IDLE_LOCK_MS } from "../lib/session.ts";
import type { RevealedItem, SecretField, VaultData, VaultItem } from "../lib/vault.ts";
import { CIPHER_TYPE_LABEL } from "../lib/vault.ts";
import { ItemDetail } from "./ItemDetail.tsx";
import { IconCollection, IconFolder, IconList, IconStar } from "./icons.tsx";
import { ServiceSwitcher } from "./ServiceSwitcher.tsx";

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "folder"; id: string | null }
  | { kind: "collection"; id: string };

const sameFilter = (a: Filter, b: Filter) =>
  a.kind === b.kind && ("id" in a ? a.id : null) === ("id" in b ? (b as { id?: string | null }).id ?? null : null);

interface Props {
  email: string;
  vault: VaultData;
  reveal: (item: VaultItem, fields: SecretField[]) => RevealedItem;
  onLock: () => void;
  onLogout: () => void;
}

export function VaultScreen({ email, vault, reveal, onLock, onLogout }: Props) {
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const folderName = useMemo(() => new Map(vault.folders.map((f) => [f.id, f.name])), [vault.folders]);
  const collectionName = useMemo(() => new Map(vault.collections.map((c) => [c.id, c.name])), [vault.collections]);
  const orgName = useMemo(() => new Map(vault.organizations.map((o) => [o.id, o.name])), [vault.organizations]);

  const matchesFilter = useMemo(() => {
    return (it: VaultItem) => {
      switch (filter.kind) {
        case "all":
          return true;
        case "favorites":
          return it.favorite;
        case "folder":
          return (it.folderId ?? null) === filter.id;
        case "collection":
          return it.collectionIds.includes(filter.id);
      }
    };
  }, [filter]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vault.items.filter((it) => matchesFilter(it) && (!q || it.haystack.includes(q)));
  }, [vault.items, matchesFilter, query]);

  // 전체 목록에서 찾는다 — 검색어를 좁히다 선택 항목이 목록에서 빠져도 상세는 열려 있어야 한다.
  const selected = useMemo(() => vault.items.find((it) => it.id === selectedId) ?? null, [vault.items, selectedId]);

  const locationOf = (it: VaultItem) => {
    const parts: string[] = [];
    if (it.organizationId) parts.push(orgName.get(it.organizationId) ?? "조직");
    for (const cid of it.collectionIds) {
      const n = collectionName.get(cid);
      if (n) parts.push(n);
    }
    if (it.folderId) parts.push(folderName.get(it.folderId) ?? "폴더");
    return parts.length ? parts.join(" · ") : "개인 · 폴더 없음";
  };

  const count = (predicate: (it: VaultItem) => boolean) => vault.items.filter(predicate).length;

  const railLink = (key: string, f: Filter, label: string, icon: ReactNode, n: number, level2 = false) => (
    <button
      key={key}
      type="button"
      className="axe-workspace-rail__link"
      data-level={level2 ? "2" : undefined}
      aria-current={sameFilter(filter, f) ? "page" : undefined}
      onClick={() => {
        setFilter(f);
        setSelectedId(null);
      }}
    >
      {icon}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ marginLeft: "auto", opacity: 0.65, fontVariantNumeric: "tabular-nums" }}>{n}</span>
    </button>
  );

  const orgCollections = vault.collections.filter((c) => c.organizationId);

  return (
    <div
      className="axe-app-shell axe-workspace-shell axe-workspace-shell--wide"
      data-shell="docs"
      data-has-sidebar="true"
      data-has-toc="true"
      // 목록 화면이라 문서용 세로 여백을 좁힌다 — 디자인 시스템이 노출한 knob.
      style={{ ["--workspace-content-pad" as string]: "var(--space-5)" }}
    >
      <a href="#main" className="axe-skip-link">
        본문으로 건너뛰기
      </a>

      <header className="axe-app-shell__topbar">
        <div className="axe-workspace-bar">
          <div className="axe-workspace-bar__left">
            <span className="axe-workspace-bar__mobile-brand">AXE Vault</span>
          </div>
          <div className="axe-workspace-bar__center">
            <label className="axe-label" htmlFor="vault-search" style={{ position: "absolute", left: -9999 }}>
              금고 검색
            </label>
            <input
              id="vault-search"
              className="axe-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 · 계정 · 주소로 검색"
              autoComplete="off"
              style={{ maxWidth: "36rem" }}
            />
          </div>
          <div className="axe-workspace-bar__right">
            <button className="axe-btn axe-btn--ghost axe-btn--sm" type="button" onClick={onLock}>
              잠그기
            </button>
          </div>
        </div>
      </header>

      <div className="axe-app-shell__main">
        <aside className="axe-app-shell__sidebar" aria-label="Primary">
          <nav className="axe-workspace-rail" aria-label="금고 탐색">
            {/*
              레일 머리 행. @axe/ui 레일 구성 계약(`contracts/rail-selectors/contract.json`
              의 `composition` → slot `axe-workspace-rail__brand`)은 이 자리의 첫 자식으로
              **서비스 전환기를 required 로 명시**한다. 예전의 `--static` 워드마크 칩은 그
              자리를 이름표로만 쓰고 있어 계약 미달이었다 — 전환기로 바꾸면서 해소된다.
              제품명은 전환기가 목록(contracts/services.ts)에서 가져오므로 여기서 쓰지 않는다.
            */}
            <div className="axe-workspace-rail__brand">
              <ServiceSwitcher />
            </div>

            <div className="axe-workspace-rail__body">
              <div className="axe-workspace-rail__nav">
                {railLink("all", { kind: "all" }, "전체", <IconList />, vault.items.length)}
                {railLink("fav", { kind: "favorites" }, "즐겨찾기", <IconStar />, count((it) => it.favorite))}

                <div className="axe-workspace-rail__group-label">폴더</div>
                {railLink(
                  "nofolder",
                  { kind: "folder", id: null },
                  "폴더 없음",
                  <IconFolder />,
                  count((it) => !it.folderId),
                  true,
                )}
                {vault.folders.map((f) =>
                  railLink(f.id, { kind: "folder", id: f.id }, f.name, <IconFolder />, count((it) => it.folderId === f.id), true),
                )}

                {orgCollections.length > 0 && (
                  <>
                    <div className="axe-workspace-rail__group-label">조직 컬렉션</div>
                    {orgCollections.map((c) =>
                      railLink(
                        c.id,
                        { kind: "collection", id: c.id },
                        c.organizationId && orgName.size > 1
                          ? `${orgName.get(c.organizationId) ?? "조직"} / ${c.name}`
                          : c.name,
                        <IconCollection />,
                        count((it) => it.collectionIds.includes(c.id)),
                        true,
                      ),
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="axe-workspace-rail__identity">
              <details className="axe-workspace-identity-menu">
                <summary className="axe-workspace-identity" aria-label={`${email} 계정 메뉴`}>
                  <span className="axe-workspace-identity__avatar" aria-hidden="true">
                    {email.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="axe-workspace-identity__label">{email}</span>
                </summary>
                <div className="axe-workspace-identity-menu__panel">
                  <button className="axe-workspace-rail__link" type="button" onClick={onLock}>
                    금고 잠그기
                  </button>
                  <button className="axe-workspace-rail__link" type="button" onClick={onLogout}>
                    로그아웃
                  </button>
                </div>
              </details>
            </div>
          </nav>
        </aside>

        <main id="main" className="axe-app-shell__content">
          <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center axe-cluster--justify-between">
            <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
              <strong>{visible.length}</strong>
              <span className="axe-badge">전체 {vault.items.length}</span>
              {vault.failed > 0 && <span className="axe-badge axe-badge--danger">복호 실패 {vault.failed}</span>}
            </div>
            <span className="axe-badge">유휴 {Math.round(IDLE_LOCK_MS / 60000)}분 자동잠금</span>
          </div>

          {visible.length === 0 ? (
            <div className="axe-empty-state">
              <div className="axe-empty-state__icon" aria-hidden="true">
                ⌕
              </div>
              <div className="axe-empty-state__title">일치하는 항목이 없습니다</div>
              <div className="axe-empty-state__description">
                {query ? `"${query}" 에 맞는 항목이 없습니다.` : "이 위치에는 항목이 없습니다."}
              </div>
            </div>
          ) : (
            <div className="axe-data-table">
              <div className="axe-data-table__scroll">
                <table className="axe-data-table__table">
                  <thead className="axe-data-table__thead">
                    <tr className="axe-data-table__tr">
                      <th className="axe-data-table__th" scope="col">
                        이름
                      </th>
                      <th className="axe-data-table__th" scope="col">
                        계정
                      </th>
                      <th className="axe-data-table__th" scope="col">
                        위치
                      </th>
                      <th className="axe-data-table__th" scope="col">
                        유형
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((it) => (
                      <tr
                        key={it.id}
                        className="axe-data-table__tr axe-data-table__tr--clickable axe-interactive"
                        aria-selected={it.id === selectedId}
                        tabIndex={0}
                        onClick={() => setSelectedId(it.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(it.id);
                          }
                        }}
                      >
                        <td className="axe-data-table__td">
                          <div className="axe-cluster axe-cluster--gap-2 axe-cluster--align-center">
                            {it.favorite && (
                              <span aria-label="즐겨찾기">
                                <IconStar />
                              </span>
                            )}
                            <span>{it.name}</span>
                            {it.error && <span className="axe-badge axe-badge--danger">{it.error}</span>}
                          </div>
                        </td>
                        <td className="axe-data-table__td">
                          {it.username ? <code className="axe-code-inline">{it.username}</code> : "—"}
                        </td>
                        <td className="axe-data-table__td">{locationOf(it)}</td>
                        <td className="axe-data-table__td">
                          <span className="axe-badge">{CIPHER_TYPE_LABEL[it.type] ?? it.type}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>

        <aside className="axe-app-shell__toc" aria-label="항목 상세">
          <ItemDetail item={selected} location={selected ? locationOf(selected) : ""} reveal={reveal} />
        </aside>
      </div>
    </div>
  );
}
