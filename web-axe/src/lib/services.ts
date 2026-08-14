/**
 * AXE 플랫폼 서비스 목록 — @axe/ui 계약의 **사본**이다. 여기서 값을 새로 정하지 않는다.
 *
 * 정본: `axelabs/src/lib/contracts/services.ts` 의 `platformServices`
 * (서버렌더 소비자를 위한 생성 투영본은 같은 디렉터리의 `services.json`).
 * 목록을 고칠 곳은 그 파일 하나다 — 이 파일은 따라간다.
 *
 * ⚠ 왜 복사인가 (실측 2026-08-14, @axe/ui 0.36.0): Consumer Kit 내보내기
 * (`axelabs/scripts/export-axe-ui.mjs` `buildKit`)는 CSS·폰트·theme 매니페스트와
 * `contracts/context-panel` 하나만 복사한다. `contracts/services.json` 도
 * `contracts/rail-selectors/` 도 kit 에 들어오지 않고, 그 데이터는 React 소비자를 위한
 * npm 패키지 경로(`build-package.mjs`)로만 나간다. 이 앱은 CSS 소비자라 그 경로를 쓰지
 * 않으므로, 목록을 kit 에서 읽을 방법이 없다. profile 플래그로 해결되는 문제가 아니다
 * (프로파일은 CSS 필터일 뿐이다). → 최소 사본 + 드리프트 테스트(tests/services.test.mjs).
 *
 * 마크업은 복사하지 않는다: 칩·메뉴 DOM 은 `contracts/rail-selectors/service-rail.html`
 * 픽스처의 클래스 계약을 그대로 쓴다 (ui/ServiceSwitcher.tsx).
 */

export interface PlatformService {
  /** 안정 식별자 — 소비 서비스가 자기 자신을 가리킬 때 쓰는 값. */
  key: string;
  label: string;
  /** 행 둘째 줄 — 이 서비스가 무엇을 하는가. */
  detail: string;
  href: string;
}

/** 정본과 같은 순서(=선언 순서). 화면에서는 라벨 오름차순으로 그린다 — 픽스처와 동일. */
export const platformServices: PlatformService[] = [
  { key: "blueprint", label: "Blueprint", detail: "AI 네이티브 워크스페이스", href: "https://axelabs.ai" },
  { key: "gate", label: "Gate", detail: "전자결재와 전자계약", href: "https://gate.axelabs.ai" },
  { key: "layer", label: "Layer", detail: "커뮤니케이션 통한 온보딩", href: "https://layer.axelabs.ai" },
  { key: "frame", label: "Frame", detail: "회계 관리와 회계사 협업", href: "https://docs.axelabs.ai/services/frame" },
  { key: "cortex", label: "Cortex", detail: "이해관계자 네트워크 관리", href: "https://cortex.axelabs.ai" },
  { key: "index", label: "Index", detail: "투자 기회 심사 및 자산 관리", href: "https://index.axelabs.ai" },
  { key: "matrix", label: "Matrix", detail: "통합 관제 시스템", href: "https://matrix.axelabs.ai" },
  { key: "vault", label: "Vault", detail: "통합 비밀번호 관리", href: "https://vault.axelabs.ai" },
];

/** 이 앱이 정본 목록에서 자기 자신을 가리키는 키. */
export const SELF_SERVICE_KEY = "vault";
