import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { purgeLegacyStorage } from "./lib/api.ts";
import { clearSession } from "./lib/persist.ts";
import { takeSsoRoute } from "./lib/sso.ts";

// @axe/ui Consumer Kit — 디자인 결정의 유일한 출처. 이 앱은 소비자다.
// 재-export: `npm run axe-ui:sync` (axelabs 정본은 읽기만 한다).
// reset 이 이 번들에 포함돼 있으므로 앱 로컬 reset 을 따로 싣지 않는다.
import "./axe-ui/axe-ui.css";

// SSO 콜백은 서버 DOMAIN 설정 때문에 항상 이 오리진 루트로 떨어진다. 둘 중 하나다:
//  · **우리가 시작한 흐름** (state 가 이 탭이 저장한 값과 일치) → 여기서 완결한다.
//  · **남이 시작한 흐름** (스톡 볼트에서 눌렀다) → PKCE verifier 가 그쪽 오리진에 있어
//    우리는 끝낼 수 없다. 렌더하지 말고 hash 를 그대로 들고 넘긴다 (lib/classic.ts).
// 판정과 동시에 핸드셰이크를 소비한다.
const route = takeSsoRoute(location.hash);

if (route.kind === "forward") {
  location.replace(route.target);
} else {
  purgeLegacyStorage();

  if (route.kind === "native") {
    // 콜백 hash 는 소비했으니 주소에서 지운다 — 새로고침이 이미 쓴 code 로 재시도하는 것을
    // 막고, 인증 코드가 주소창·히스토리에 남지 않게 한다.
    history.replaceState(null, "", location.pathname + location.search);
    // 새 SSO 인증이 도착했다 = 사용자가 지금 로그인을 다시 하는 중이다. 이 탭에 남아 있던
    // 세션은 그것으로 대체된다. 지우지 않으면 부팅이 곧장 잠금 화면으로 가 버려 도착한
    // 인증 흐름이 화면을 얻지 못한다 (App 의 SSO 흐름은 phase 전이로 단계를 읽는다).
    clearSession();
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App ssoHandoff={route.kind === "native" ? { code: route.code, verifier: route.verifier } : null} />
    </StrictMode>,
  );
}
