import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { purgeLegacyStorage } from "./lib/api.ts";

// @axe/ui Consumer Kit — 디자인 결정의 유일한 출처. 이 앱은 소비자다.
// 재-export: `npm run axe-ui:sync` (axelabs 정본은 읽기만 한다).
// reset 이 이 번들에 포함돼 있으므로 앱 로컬 reset 을 따로 싣지 않는다.
import "./axe-ui/axe-ui.css";

purgeLegacyStorage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
