import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { purgeLegacyStorage } from "./lib/api.ts";
import { ssoForwardTarget } from "./lib/classic.ts";

// @axe/ui Consumer Kit — 디자인 결정의 유일한 출처. 이 앱은 소비자다.
// 재-export: `npm run axe-ui:sync` (axelabs 정본은 읽기만 한다).
// reset 이 이 번들에 포함돼 있으므로 앱 로컬 reset 을 따로 싣지 않는다.
import "./axe-ui/axe-ui.css";

// SSO 콜백이 이 오리진 루트로 떨어질 수 있다 (서버 DOMAIN 이 여기라서). 우리는 PKCE
// verifier 가 없어 완결할 수 없으므로, 렌더하지 말고 흐름을 시작한 오리진으로 즉시 넘긴다.
// 근거 = lib/classic.ts.
const ssoTarget = ssoForwardTarget(location.hash);
if (ssoTarget) {
  location.replace(ssoTarget);
} else {
  purgeLegacyStorage();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
