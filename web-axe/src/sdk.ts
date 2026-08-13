/**
 * Bitwarden 공식 WASM SDK 로더.
 *
 * `bitwarden_wasm_internal.js` = wasm-bindgen 브라우저 엔트리로, import 시점에
 * `__wbg_set_wasm()` 을 스스로 호출한다 (side-effect init). 따라서 우리가 별도로
 * init() 을 부를 필요가 없다. wasm ESM import 는 vite-plugin-wasm 이 처리한다.
 *
 * 이 파일이 크립토 관련해 하는 유일한 일 = 재수출. 알고리즘은 한 줄도 우리 것이 아니다.
 */
export {
  PureCrypto,
  PasswordManagerClient,
  type AuthClient,
  type LoginClient,
  type ClientSettings,
  type Kdf,
  type LoginResponse,
  type LoginSuccessResponse,
  type PasswordPreloginResponse,
} from "@bitwarden/sdk-internal/bitwarden_wasm_internal.js";

export { default as SDK_VERSION } from "./sdk-version.ts";
