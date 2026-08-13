/**
 * TOTP (RFC 6238) 생성.
 *
 * 왜 여기만 우리 코드인가: PureCrypto 는 볼트 크립토(KDF·키 언랩·EncString 복호)만 노출한다.
 * TOTP 는 볼트 크립토가 아니라 항목 값(시드)을 받아 코드를 만드는 표준 알고리즘이고, SDK 의
 * WASM 표면에 stateless 생성 API 가 없다. HMAC 자체는 우리가 구현하지 않고 플랫폼 네이티브
 * WebCrypto 를 부른다 — 우리 코드는 카운터 조립과 동적 truncation(RFC 4226 §5.3)뿐이다.
 * 정확성은 tests/crypto.test.mjs 의 RFC 6238 Appendix B 벡터가 고정한다.
 *
 * 타입 스트리핑만으로 Node 에서 그대로 import 되도록 erasable 문법만 쓴다 (enum 금지).
 */

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpParams {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (padding·공백·하이픈 관대). Bitwarden 항목의 시드는 이 인코딩이다. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean) throw new Error("TOTP 시드가 비어 있다");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error(`TOTP 시드에 base32 아닌 문자가 있다: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, i);
}

function normalizeAlgorithm(raw: string | null): TotpAlgorithm {
  const a = (raw ?? "SHA1").toUpperCase().replace(/[-_]/g, "");
  if (a === "SHA1") return "SHA-1";
  if (a === "SHA256") return "SHA-256";
  if (a === "SHA512") return "SHA-512";
  throw new Error(`지원하지 않는 TOTP 알고리즘: ${raw}`);
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`TOTP 파라미터 범위를 벗어났다: ${raw}`);
  return n;
}

/**
 * 항목의 totp 필드 파싱. 두 형태를 받는다.
 *  1. `otpauth://totp/Label?secret=...&algorithm=SHA1&digits=6&period=30`
 *  2. 맨 base32 시드 (Bitwarden 이 가장 흔하게 저장하는 형태)
 *
 * Steam guard(`steam://`)는 자리수 5 + 커스텀 알파벳이라 별도 구현이 필요하다 — P1 미지원.
 */
export function parseTotp(raw: string): TotpParams {
  const t = raw.trim();
  if (/^steam:\/\//i.test(t)) throw new Error("Steam Guard TOTP 는 P1 미지원이다");
  if (/^otpauth:\/\//i.test(t)) {
    const url = new URL(t);
    if (url.host.toLowerCase() !== "totp") throw new Error(`otpauth 타입이 totp 가 아니다: ${url.host}`);
    const secret = url.searchParams.get("secret");
    if (!secret) throw new Error("otpauth URI 에 secret 파라미터가 없다");
    return {
      secret: base32Decode(secret),
      algorithm: normalizeAlgorithm(url.searchParams.get("algorithm")),
      digits: boundedInt(url.searchParams.get("digits"), 6, 6, 10),
      period: boundedInt(url.searchParams.get("period"), 30, 1, 300),
    };
  }
  return { secret: base32Decode(t), algorithm: "SHA-1", digits: 6, period: 30 };
}

/** 현재 시간 스텝의 코드. `atMs` 는 테스트에서 RFC 벡터 시각을 주입하기 위한 것. */
export async function generateTotp(p: TotpParams, atMs: number = Date.now()): Promise<string> {
  const counter = BigInt(Math.floor(atMs / 1000 / p.period));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter);

  const key = await crypto.subtle.importKey(
    "raw",
    p.secret as unknown as BufferSource,
    { name: "HMAC", hash: p.algorithm },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message as unknown as BufferSource));

  // RFC 4226 §5.3 dynamic truncation
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** p.digits).padStart(p.digits, "0");
}

/** 현재 스텝에 남은 초 (표시용 카운트다운). */
export function totpRemainingSeconds(period: number, atMs: number = Date.now()): number {
  return period - Math.floor(atMs / 1000) % period;
}
