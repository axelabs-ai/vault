import { useState } from "react";
import { useSession, type Phase } from "./lib/session.ts";
import { ssoFlowStart, ssoFlowStep, type SsoFlow, type SsoHandoff } from "./lib/sso.ts";
import { LockScreen, LoginScreen, SsoScreen } from "./ui/AuthScreens.tsx";
import { VaultScreen } from "./ui/VaultScreen.tsx";

export default function App({ ssoHandoff }: { ssoHandoff: SsoHandoff | null }) {
  const session = useSession();

  // SSO 도착 흐름의 수명은 session.phase 에서 **파생**한다 (React 의 "렌더 중 상태 조정"
  // 패턴 — effect 로 미루면 폐기 직전 한 프레임이 잘못된 화면으로 그려진다).
  // 폐기를 로그아웃 핸들러에 매달지 않는 이유는 lib/sso.ts 의 `ssoFlowStep` 주석 참조.
  const [flow, setFlow] = useState<SsoFlow>(() => ssoFlowStart(ssoHandoff));
  const [seenPhase, setSeenPhase] = useState<Phase>(session.phase);
  if (seenPhase !== session.phase) {
    setSeenPhase(session.phase);
    setFlow((f) => ssoFlowStep(f, session.phase));
  }

  if (flow.handoff) {
    return (
      <SsoScreen
        handoff={flow.handoff}
        email={session.email}
        authenticated={flow.authenticated}
        onComplete={session.completeSso}
        onUnlock={session.unlock}
        onLogout={session.logout}
      />
    );
  }

  // "sso-pending" 도 사람에게는 잠금 화면이다. 다만 이 탭이 아직 아무것도 봉인하지 못한
  // 구간이라(시한부 평문 토큰) 문구가 다르다 — LockScreen 의 `pending` 참조.
  if (session.phase === "locked" || session.phase === "sso-pending") {
    return (
      <LockScreen
        email={session.email}
        onUnlock={session.unlock}
        onLogout={session.logout}
        pending={session.phase === "sso-pending"}
      />
    );
  }

  if (session.phase === "unlocked" && session.vault) {
    return (
      <VaultScreen
        email={session.email}
        vault={session.vault}
        reveal={session.reveal}
        onLock={session.lock}
        onLogout={session.logout}
      />
    );
  }

  return <LoginScreen onSignIn={session.signIn} notice={session.notice} />;
}
