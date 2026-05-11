import { Show, onMount } from "solid-js";
import { config } from "./stores/config";
import AuthProvider from "./components/AuthProvider";
import { useAuth } from "./components/AuthProvider";
import { clearAuthState } from "./utils/cognito";

function AppContent() {
  const auth = useAuth();

  onMount(() => {
    const email = auth.email;
    const albUrl = config().albUrl;
    console.log("AppContent mounted:", { email, albUrl });

    if (email && albUrl) {
      console.log("Redirecting to:", albUrl);
      window.location.href = albUrl;
    } else {
      console.log("Not redirecting - missing:", {
        email: !email ? "email" : null,
        albUrl: !albUrl ? "albUrl" : null
      });
    }
  });

  const handleLogout = () => {
    clearAuthState();
    window.location.reload();
  };

  return (
    <div class="h-screen flex items-center justify-center bg-base-200">
      <div class="card w-96 bg-base-100 shadow-xl">
        <div class="card-body items-center text-center">
          <div class="mb-4">
            <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-16 mx-auto" />
          </div>

          <h1 class="card-title mb-2">OpenCode</h1>
          <p class="text-base-content/60 mb-6">Collaborative code workspace</p>

          <Show
            when={auth.email}
            fallback={
              <div class="alert alert-info mb-4 w-full">
                <span>Redirecting to login...</span>
              </div>
            }
          >
            <div class="w-full space-y-3">
              <div class="alert alert-success">
                <span>✓ Authenticated as <strong>{auth.email}</strong></span>
              </div>
              <div class="alert alert-info">
                <span>Redirecting to OpenCode...</span>
              </div>
              <button
                class="btn btn-error w-full"
                onClick={handleLogout}
              >
                Logout
              </button>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const cfg = config();
  const cognitoConfig = cfg.cognito;

  if (cognitoConfig) {
    return (
      <AuthProvider config={cognitoConfig}>
        <AppContent />
      </AuthProvider>
    );
  }

  return <AppContent />;
}
