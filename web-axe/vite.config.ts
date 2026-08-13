import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

/**
 * CORS: vault.axelabs.ai 는 preflight 에 Access-Control-Allow-Origin 을 붙이지 않는다
 * (allow-credentials/methods/headers 만 회신 — 실측 2026-08-13). 따라서 브라우저에서 직접 치면
 * 차단된다. dev 는 아래 proxy 로 same-origin 화해 우회하고, prod 는 같은 오리진 서빙으로
 * 구조적으로 해소한다 (DEPLOY.md).
 */
const UPSTREAM = "https://vault.axelabs.ai";

/**
 * CSP 를 index.html 에 심는다.
 *
 * dev 는 Vite 가 HMR 클라이언트를 인라인 스크립트로 주입하므로 script-src 에 'unsafe-inline' 이
 * 필요하다. 배포 산출물에는 그게 없어야 하므로 command 에 따라 갈라 준다 (빌드된 HTML 이 곧
 * 정책의 증거가 된다). WASM 실행에는 'wasm-unsafe-eval' 이 반드시 필요하다 — 이게 없으면
 * 크립토가 통째로 죽는다.
 *
 * meta 태그 CSP 는 frame-ancestors 를 지원하지 않는다. 진짜 방어선은 엣지의 HTTP 헤더이고
 * (DEPLOY.md 에 헤더 세트 명시), 여기 meta 는 그게 빠졌을 때의 2선이다.
 */
function cspMeta(isDev: boolean): Plugin {
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${isDev ? " 'unsafe-inline'" : ""}`,
    // React 가 인라인 style 속성을 쓴다 (TOTP 진행바 등). 엣지 헤더에서 nonce 로 좁히는 건
    // DEPLOY.md 의 하드닝 항목.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // 서버와 같은 오리진만 친다. 외부로 나가는 경로가 아예 없어야 한다.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  return {
    name: "axe-vault-csp",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html.replace(
          "<head>",
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        ),
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [wasm(), react(), cspMeta(command === "serve")],
  server: {
    port: 4290,
    strictPort: true,
    proxy: {
      "/identity": { target: UPSTREAM, changeOrigin: true, secure: true },
      "/api": { target: UPSTREAM, changeOrigin: true, secure: true },
    },
  },
  build: {
    // wasm-bindgen 글루가 top-level await 를 쓴다.
    target: "esnext",
    // modulepreload 폴리필은 인라인 <script> 로 주입된다 — 그것 하나 때문에 prod CSP 에
    // 'unsafe-inline' 을 열 이유가 없다. target 이 esnext 라 폴리필 대상 브라우저도 아니다.
    modulePreload: { polyfill: false },
  },
  optimizeDeps: { exclude: ["@bitwarden/sdk-internal"] },
}));
