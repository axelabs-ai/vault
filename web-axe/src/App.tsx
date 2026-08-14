import { useEffect, useState } from "react";
import { useSession } from "./lib/session.ts";
import type { SsoHandoff } from "./lib/sso.ts";
import { LockScreen, LoginScreen, SsoScreen } from "./ui/AuthScreens.tsx";
import { VaultScreen } from "./ui/VaultScreen.tsx";

export default function App({ ssoHandoff }: { ssoHandoff: SsoHandoff | null }) {
  const session = useSession();
  // SSO 도착 흐름은 1회다. 금고가 한 번 열리면 소비된 것으로 보고 놓는다 — 그래야 이후의
  // 유휴 잠금이 SSO 화면을 되살리지 않는다(같은 code 를 다시 교환하려 들 것이다).
  const [sso, setSso] = useState<SsoHandoff | null>(ssoHandoff);
  useEffect(() => {
    if (session.phase === "unlocked") setSso(null);
  }, [session.phase]);

  if (sso && session.phase !== "unlocked") {
    return (
      <SsoScreen
        handoff={sso}
        email={session.email}
        authenticated={session.phase === "locked"}
        onComplete={session.completeSso}
        onUnlock={session.unlock}
        onLogout={session.logout}
      />
    );
  }

  if (session.phase === "locked") {
    return <LockScreen email={session.email} onUnlock={session.unlock} onLogout={session.logout} />;
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

  return <LoginScreen onSignIn={session.signIn} />;
}
