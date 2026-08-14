/**
 * SSO 콜백 포워딩 심 — 이 앱이 완결할 수 없는 흐름을 놓치지도, 남의 라우트를 삼키지도
 * 않는지 고정한다.
 *
 * 왜 테스트가 필요한가: 이 심이 조용히 안 돌면 SSO 로그인이 "루트에서 아무 일도 안 일어남"
 * 으로 죽고(콜백 hash 를 든 채 앱만 렌더된다), 반대로 너무 넓게 잡으면 정상 라우트를
 * 엉뚱한 오리진으로 날린다. 둘 다 배포 후에야 드러나는 종류라 경계를 여기서 못박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ssoForwardTarget, CLASSIC_ORIGIN } from "../src/lib/classic.ts";

test("SSO 콜백 hash 는 classic 오리진으로, hash 를 그대로 달고 넘어간다", () => {
  const hash = "#/sso?code=abc123&state=xyz";
  assert.equal(ssoForwardTarget(hash), `${CLASSIC_ORIGIN}/${hash}`);
  // code/state 가 소실되면 교환이 불가능해진다 — 원문 보존이 이 심의 전부다.
  assert.ok(ssoForwardTarget(hash).endsWith(hash));
});

test("경계 문자까지만 SSO 로 인정한다 (다른 라우트를 삼키지 않는다)", () => {
  for (const h of ["#/sso", "#/sso?code=1", "#/sso&x=1", "#/sso/cb"]) {
    assert.ok(ssoForwardTarget(h), `포워딩됐어야 한다: ${h}`);
  }
  for (const h of ["#/ssoconfig", "#/sso-settings", "#/vault", "#/", "", "#/login?sso=1"]) {
    assert.equal(ssoForwardTarget(h), null, `포워딩되면 안 된다: ${h}`);
  }
});

test("classic 오리진은 이 앱의 오리진과 달라야 한다 (같으면 무한 루프)", () => {
  assert.notEqual(CLASSIC_ORIGIN, "https://vault.axelabs.ai");
  assert.match(CLASSIC_ORIGIN, /^https:\/\//);
});
