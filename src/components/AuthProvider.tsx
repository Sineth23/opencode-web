import { createSignal, Show, type JSX } from "solid-js";
import CognitoLogin from "./CognitoLogin";
import { loadAuthState, clearAuthState, isAuthenticated } from "../utils/cognito";
import type { CognitoConfig } from "../utils/cognito";

interface AuthProviderProps {
  config: CognitoConfig;
  children: JSX.Element;
}

export default function AuthProvider(props: AuthProviderProps) {
  const [isAuth, setIsAuth] = createSignal(isAuthenticated());

  const handleLoginSuccess = (idToken: string, accessToken: string) => {
    setIsAuth(true);
  };

  const handleLogout = () => {
    clearAuthState();
    setIsAuth(false);
  };

  return (
    <Show
      when={isAuth()}
      fallback={<CognitoLogin config={props.config} onSuccess={handleLoginSuccess} />}
    >
      {props.children}
    </Show>
  );
}

export function useAuth() {
  const auth = loadAuthState();
  return {
    isAuthenticated: !!auth.idToken,
    idToken: auth.idToken,
    accessToken: auth.accessToken,
    userId: auth.userId,
    email: auth.email,
  };
}
