/**
 * 크립토 자가검증 — Bitwarden 공식 SDK 를 조립만 했다는 전제를 기계적으로 지킨다.
 *
 * 1. KDF 교차검증: SDK 의 마스터키 유도 결과가 Node WebCrypto 의 PBKDF2-SHA256
 *    (스펙 정의 독립 구현)과 바이트 단위로 같은지. 서로 다른 구현이 같은 값을 내면
 *    우리가 쓰는 파라미터 구성(password=마스터패스워드, salt=이메일, 600k, 32B)이 맞다.
 * 2. 고정 KAT: 아래 벡터는 한 번 생성해 박아 둔 값이다. 랜덤 IV 가 섞인 실제
 *    EncString 을 고정 입력으로 복호하므로, SDK 업그레이드 시 포맷/의미 드리프트가
 *    나면 이 테스트가 깨진다 (앱이 실제로 부르는 그 API 를 그대로 부른다).
 *
 * 실행: npm test   (node --test, 추가 의존성 없음)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const require = createRequire(import.meta.url);
const { PureCrypto } = require("@bitwarden/sdk-internal");

const EMAIL = "poc@axelabs.ai";
const PASSWORD = "poc-master-password-2026";
const KDF = { pBKDF2: { iterations: 600000 } };

// --- 고정 벡터 ---
// 존재하지 않는 계정(poc@axelabs.ai)용으로 1회 생성한 합성 값이다. 실계정·실볼트와 무관하며
// 어떤 실서버에도 통하지 않는다. 아래 pragma 는 repo 시크릿 스캐너의 엔트로피 오탐 억제용.
const MASTER_KEY_B64 = "vX0Ul00VMeYP4adutIb7lPFMawL1F37Qyfw3jbLOXxA="; // pragma: allowlist secret
const AUTH_HASH_B64 = "QyFNkeOez/m7Ix/LykBkZYNLawEG2/hgb+lKQtl97NU="; // pragma: allowlist secret
const USER_KEY_B64 = "9SEU4QnrcNT/b2fDjH3F6H7HFvE9YPviF0dv3A7MMFonBwLu8EYTI1J/E3OOQojLVOKnVDNC6vmMWWNz6CGAZw=="; // pragma: allowlist secret
const WRAPPED_USER_KEY = "2.Q8rMaxWA3mEh2E2bYkRafg==|Dyy8BlNZnBiuC/0U9PoM1+ysExlH9RqEE4t+RyWmDqPRgCV+szzeHvfTJkVg5xofWLhtbLXWEpcUzSXvtdLAkMXEBI4+waJ6QbMsPjfK1m0=|rZZMQ+ExL8xGWgai3+bOuH4Pq3vII/IbVsxB8Eh3b1Y="; // pragma: allowlist secret
const ENC_STRING = "2.8xykHVRyKZQdLCavH3tS9A==|FslZkCCmWMrfz8VlB1WNSAgidrQn4ncc5lBPSM9RMWU=|3QDBI8m7QmyKuQPjkr84oiYCIdvcBxZJLv094RY+0/8="; // pragma: allowlist secret
const PLAINTEXT = "AXE Vault PoC — 복호 확인";

const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function pbkdf2(passwordBytes, saltBytes, iterations) {
  const key = await webcrypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

test("마스터키 유도: SDK == WebCrypto PBKDF2-SHA256 (독립 구현 교차검증)", async () => {
  const fromSdk = PureCrypto.derive_kdf_material(utf8(PASSWORD), utf8(EMAIL), KDF);
  const fromWebCrypto = await pbkdf2(utf8(PASSWORD), utf8(EMAIL), 600000);
  assert.equal(b64(fromSdk), b64(fromWebCrypto));
  assert.equal(b64(fromSdk), MASTER_KEY_B64);
});

test("마스터패스워드 인증 해시: 고정 벡터 일치", async () => {
  // 1 iteration 은 SDK 가 거부하므로(Insufficient KDF parameters) 이 단계만 WebCrypto.
  const masterKey = PureCrypto.derive_kdf_material(utf8(PASSWORD), utf8(EMAIL), KDF);
  const hash = await pbkdf2(masterKey, utf8(PASSWORD), 1);
  assert.equal(b64(hash), AUTH_HASH_B64);
});

test("SDK 가 1-iteration PBKDF2 를 거부한다 (Lane B 가 WebCrypto 를 쓰는 이유)", () => {
  assert.throws(() =>
    PureCrypto.derive_kdf_material(utf8(PASSWORD), utf8(EMAIL), { pBKDF2: { iterations: 1 } }),
  );
});

test("유저키 언랩: 고정 wrapped 유저키를 마스터패스워드로 복호 (앱이 쓰는 그 API)", () => {
  const userKey = PureCrypto.decrypt_user_key_with_master_password(
    WRAPPED_USER_KEY,
    PASSWORD,
    EMAIL,
    KDF,
  );
  assert.equal(b64(userKey), USER_KEY_B64);
});

test("cipher 필드 복호: 고정 EncString → 알려진 평문", () => {
  const userKey = Buffer.from(USER_KEY_B64, "base64");
  assert.equal(PureCrypto.symmetric_decrypt_string(ENC_STRING, userKey), PLAINTEXT);
});

test("틀린 마스터패스워드는 유저키 언랩에 실패한다", () => {
  assert.throws(() =>
    PureCrypto.decrypt_user_key_with_master_password(WRAPPED_USER_KEY, "wrong-password", EMAIL, KDF),
  );
});
