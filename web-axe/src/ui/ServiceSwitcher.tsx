/**
 * 서비스 전환기 — @axe/ui 레일 셀렉터 계약의 `service` 갈래.
 *
 * 마크업은 정본 픽스처 `axelabs/src/lib/contracts/rail-selectors/service-rail.html` 을
 * 그대로 옮긴 것이다(클래스·속성·중첩 순서 동일). 계약 파일
 * `contracts/rail-selectors/contract.json` 이 요구하는 대로:
 *  · trigger 클래스 = `axe-workspace-entity`, 식별자 = `data-axe-selector="service"`
 *  · 현재 서비스 표시 = `aria-current="page"` (`selectors.service.currentAria`)
 *  · 행 = `axe-workspace-rail__link` > `axe-workspace-entity__row` > `axe-workspace-entity__copy`
 *
 * ⚠ 픽스처와 **한 곳** 다르다: native `<details>` 패널에 `axe-workspace-entity__menu` 를
 * 붙였다. 픽스처는 이 자리를 클래스 없이 두고 `details.axe-workspace-entity > :not(summary)`
 * 로 잡는데, 그 규칙 묶음은 `--workspace-*` 재료를 **선언하지 않고 상속에 기댄다**. 재료는
 * `.axe-workspace-shell`(과 portal 표면들)에만 선언돼 있어서, 셸 밖인 `.axe-pattern-auth`
 * 안에서는 배경·테두리가 통째로 사라진다(실측 2026-08-14: 투명 패널). `__menu` 는 바로 그
 * "셸 밖에 뜨는 메뉴 표면"을 위해 같은 재료를 자기 자신에 싣는 클래스라 이 자리에 맞는다 —
 * 규칙 본문은 두 갈래가 동일하므로 시각적으로 달라지는 것은 재료 확보뿐이다.
 * 근본 해소는 @axe/ui 쪽 결정이다(auth 패턴을 재료 선언 목록에 넣거나, 패턴에 셀렉터 슬롯을
 * 명명하거나) — design-lock 이라 여기서 만들지 않고 제안만 올린다.
 *
 * 시각 클래스를 여기서 새로 만들지 않는다. 목록 데이터의 출처는 lib/services.ts 주석 참조.
 */
import { platformServices, SELF_SERVICE_KEY } from "../lib/services.ts";

const SELF = platformServices.find((s) => s.key === SELF_SERVICE_KEY);

/** 픽스처와 같은 정렬 — 라벨 오름차순. */
const rows = [...platformServices].sort((a, b) => a.label.localeCompare(b.label, "en"));

export function ServiceSwitcher() {
  const current = SELF?.label ?? "Vault";
  return (
    <details className="axe-workspace-entity" data-axe-selector="service">
      <summary aria-label={`현재 서비스: ${current}. 서비스 전환`}>
        <span className="axe-workspace-entity__label">{current}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none">
          <path
            d="m5.5 7.5 4.5 4.5 4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="axe-workspace-entity__menu">
        {rows.map((s) => (
          <a
            key={s.key}
            className="axe-workspace-rail__link"
            href={s.href}
            aria-current={s.key === SELF_SERVICE_KEY ? "page" : undefined}
          >
            <span className="axe-workspace-entity__row">
              <span className="axe-workspace-entity__copy">
                <strong>{s.label}</strong>
                <small>{s.detail}</small>
              </span>
            </span>
          </a>
        ))}
      </div>
    </details>
  );
}
