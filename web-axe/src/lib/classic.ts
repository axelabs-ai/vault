/**
 * 스톡 web-vault("classic") 오리진 — 같은 vaultwarden 컨테이너를 다른 호스트명으로 낸다.
 *
 * 2026-08-14 컷오버로 `vault.axelabs.ai` **루트가 이 앱**이 됐다. 스톡 볼트는
 * `vault-classic.axelabs.ai` 로 옮겨져 관리 콘솔·SSO 첫 가입·P1 이 아직 구현하지 않은
 * 기능(항목 편집·공유·계정 설정)의 폴백을 계속 맡는다.
 */
export const CLASSIC_ORIGIN = "https://vault-classic.axelabs.ai";

/**
 * SSO 콜백 포워딩 심 — 이 오리진에서 끝낼 수 없는 흐름을 시작한 곳으로 돌려보낸다.
 *
 * 서버(vaultwarden)는 SSO 콜백을 자기 `DOMAIN` 설정값 = `https://vault.axelabs.ai` 의
 * **루트 + `#/sso?code=…&state=…`** 로 307 한다. 컷오버 전에는 그 루트가 스톡 볼트라
 * 곧바로 완결됐지만, 지금 그 자리에는 이 앱이 있다.
 *
 * 그런데 이 앱은 그 흐름을 **완결할 수 없다**: PKCE `code_verifier` 는 흐름을 *시작한*
 * 오리진(= classic, 사용자가 거기서 SSO 버튼을 눌렀다)의 `sessionStorage` 에 있고,
 * `sessionStorage` 는 오리진별로 격리돼 있어 여기서는 읽을 수 없다. 코드를 가로채 봐야
 * 교환에 필요한 verifier 가 없다.
 *
 * 그래서 판단하지 말고 **hash 를 그대로 들고 classic 으로 넘긴다.** verifier 가 있는
 * 오리진에서 원래대로 완결된다. (서버의 DOMAIN 을 바꾸면 다른 것들이 깨지므로 건드리지 않는다.)
 *
 * `#/sso` 뒤에 경계 문자(`?`·`&`·`/`)나 문자열 끝만 허용한다 — `#/ssoconfig` 같은 다른
 * 라우트를 삼키지 않기 위해서다.
 */
const SSO_CALLBACK = /^#\/sso(?=$|[?&/])/;

/** 포워딩해야 하면 목적지 URL, 아니면 null. */
export function ssoForwardTarget(hash: string): string | null {
  return SSO_CALLBACK.test(hash) ? `${CLASSIC_ORIGIN}/${hash}` : null;
}
