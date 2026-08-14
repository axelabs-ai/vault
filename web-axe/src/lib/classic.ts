/**
 * 스톡 web-vault("classic") 오리진 — 같은 vaultwarden 컨테이너를 다른 호스트명으로 낸다.
 *
 * 2026-08-14 컷오버로 `vault.axelabs.ai` **루트가 이 앱**이 됐다. 스톡 볼트는
 * `vault-classic.axelabs.ai` 로 옮겨져 관리 콘솔·SSO 첫 가입·P1 이 아직 구현하지 않은
 * 기능(항목 편집·공유·계정 설정)의 폴백을 계속 맡는다.
 */
export const CLASSIC_ORIGIN = "https://vault-classic.axelabs.ai";

/**
 * SSO 콜백 포워딩 심 — **이 오리진에서 끝낼 수 없는 흐름만** 시작한 곳으로 돌려보낸다.
 *
 * 서버(vaultwarden)는 SSO 콜백을 자기 `DOMAIN` 설정값 = `https://vault.axelabs.ai` 로
 * 되돌리고, 스톡 `sso-connector.html` 이 마지막으로 **루트 + `#/sso?code=…&state=…`** 로
 * 넘긴다. 즉 착지점은 언제나 이 앱이다.
 *
 * 이 앱도 이제 SSO 를 시작한다(lib/sso.ts). 그래서 착지한 콜백은 둘 중 하나다:
 *  · **우리가 시작한 것** — PKCE `code_verifier` 가 이 오리진의 sessionStorage 에 있다.
 *    네이티브로 완결한다.
 *  · **남이 시작한 것** (사용자가 classic 에서 SSO 버튼을 눌렀다) — verifier 가 그쪽
 *    오리진에 있고 `sessionStorage` 는 오리진별로 격리돼 여기서는 읽을 수 없다. 코드를
 *    가로채 봐야 교환에 필요한 verifier 가 없다. → **hash 를 그대로 들고 넘긴다.**
 *
 * 어느 쪽인지 가르는 것은 `lib/sso.ts` 의 `ssoRoute` (state 대조)다. 이 파일은 "넘길 때
 * 어디로 넘기는가"만 안다. 서버의 DOMAIN 은 바꾸지 않는다 — 이메일 링크·SSO 등록 URL 이
 * 연쇄로 깨진다.
 *
 * `#/sso` 뒤에 경계 문자(`?`·`&`·`/`)나 문자열 끝만 허용한다 — `#/ssoconfig` 같은 다른
 * 라우트를 삼키지 않기 위해서다. 이 판정을 sso.ts 가 재사용하므로 경계 규칙은 한 곳뿐이다.
 */
const SSO_CALLBACK = /^#\/sso(?=$|[?&/])/;

/** 포워딩해야 하면 목적지 URL, 아니면 null. */
export function ssoForwardTarget(hash: string): string | null {
  return SSO_CALLBACK.test(hash) ? `${CLASSIC_ORIGIN}/${hash}` : null;
}
