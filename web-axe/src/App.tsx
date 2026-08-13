import { useSession } from "./lib/session.ts";
import { LockScreen, LoginScreen } from "./ui/AuthScreens.tsx";
import { VaultScreen } from "./ui/VaultScreen.tsx";

export default function App() {
  const session = useSession();

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
