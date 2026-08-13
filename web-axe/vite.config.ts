import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";

/**
 * PoC 스파이크 dev 설정.
 *
 * CORS: vault.axelabs.ai 는 preflight 에 Access-Control-Allow-Origin 을 붙이지 않는다
 * (allow-credentials/methods/headers 만 회신 — 실측 2026-08-13). 따라서 브라우저에서
 * 직접 치면 차단된다. dev 에서는 아래 proxy 로 same-origin 화해 우회하고,
 * P1 에서는 같은 오리진(vault.axelabs.ai) 서빙으로 구조적으로 해소한다.
 */
const UPSTREAM = "https://vault.axelabs.ai";

export default defineConfig({
  plugins: [wasm(), react()],
  server: {
    port: 4290,
    strictPort: true,
    proxy: {
      "/identity": { target: UPSTREAM, changeOrigin: true, secure: true },
      "/api": { target: UPSTREAM, changeOrigin: true, secure: true },
    },
  },
  // wasm-bindgen 글루가 top-level await 를 쓰므로 esnext 고정
  build: { target: "esnext" },
  optimizeDeps: { exclude: ["@bitwarden/sdk-internal"] },
});
