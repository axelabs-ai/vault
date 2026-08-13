/**
 * 인라인 아이콘 — @axe/ui 는 CSS 전용 Consumer Kit 이라 아이콘 자산을 배달하지 않는다.
 * 레일 링크/버튼 안에 그냥 자식 <svg> 로 들어간다 (아이콘 래퍼 클래스 없음이 계약).
 * currentColor + aria-hidden 이 전부다 — 시각 결정은 없다.
 */
const base = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const IconVault = () => (
  <svg {...base}>
    <rect x="3" y="10" width="18" height="11" rx="2" />
    <path d="M7.5 10V7a4.5 4.5 0 1 1 9 0v3" />
  </svg>
);

export const IconStar = () => (
  <svg {...base}>
    <path d="m12 3.8 2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z" />
  </svg>
);

export const IconFolder = () => (
  <svg {...base}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

export const IconCollection = () => (
  <svg {...base}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.6 5.6 0 0 0-2-4.3" />
  </svg>
);

export const IconList = () => (
  <svg {...base}>
    <path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
  </svg>
);
