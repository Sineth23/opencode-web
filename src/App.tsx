import { Show, createSignal, onMount, onCleanup } from "solid-js";
import AuthProvider, { useAuth } from "./components/AuthProvider";
import { clearAuthState } from "./utils/cognito";
import { config } from "./stores/config";

const SESSION_KEY = "autodoc_opencode_session_id";

type Phase = "idle" | "starting" | "running" | "stopping" | "error";

const API_URL = (import.meta as any).env?.VITE_AUTODOC_API_URL as string ?? "";

function apiFetch(path: string, method: string, body?: object) {
  const token = localStorage.getItem("cognito_id_token");
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then((r) => r.json());
}

function Dashboard() {
  const auth = useAuth();
  const albUrl = config().albUrl;

  const [phase, setPhase] = createSignal<Phase>("idle");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [errorMsg, setErrorMsg] = createSignal("");

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const handleSessionEnded = () => {
    stopPolling();
    setSessionId(null);
    localStorage.removeItem(SESSION_KEY);
    setPhase("idle");
  };

  const pollStatus = async (sid: string) => {
    try {
      const data = await apiFetch(`/opencode/sessions/${sid}`, "GET");
      if (data.status === "RUNNING") {
        stopPolling();
        setPhase("running");
      } else if (["STOPPED", "SUCCEEDED", "FAILED"].includes(data.status) || !data.ok) {
        handleSessionEnded();
      }
      // SUBMITTED / PROVISIONING → keep polling
    } catch {
      // transient error — keep polling
    }
  };

  const startPolling = (sid: string) => {
    stopPolling();
    pollTimer = setInterval(() => pollStatus(sid), 5000);
  };

  // On mount: reconnect to any session that survived a page refresh
  onMount(async () => {
    const savedId = localStorage.getItem(SESSION_KEY);
    if (!savedId) return;

    setSessionId(savedId);
    setPhase("starting");

    try {
      const data = await apiFetch(`/opencode/sessions/${savedId}`, "GET");
      if (data.status === "RUNNING") {
        setPhase("running");
      } else if (["STOPPED", "SUCCEEDED", "FAILED"].includes(data.status) || !data.ok) {
        handleSessionEnded();
      } else {
        startPolling(savedId);
      }
    } catch {
      handleSessionEnded();
    }
  });

  onCleanup(stopPolling);

  const handleLaunch = async () => {
    setPhase("starting");
    setErrorMsg("");
    try {
      const data = await apiFetch("/opencode/sessions", "POST", {});
      if (!data.ok) {
        setPhase("error");
        setErrorMsg(data.error ?? "Failed to start session");
        return;
      }
      const sid: string = data.sessionId;
      setSessionId(sid);
      localStorage.setItem(SESSION_KEY, sid);
      startPolling(sid);
    } catch (e: any) {
      setPhase("error");
      setErrorMsg(e?.message ?? "Network error");
    }
  };

  const handleStop = async () => {
    const sid = sessionId();
    setPhase("stopping");
    stopPolling();
    if (sid) {
      try {
        await apiFetch(`/opencode/sessions/${sid}`, "DELETE");
      } catch {
        // best-effort stop
      }
    }
    handleSessionEnded();
  };

  const handleLogout = async () => {
    await handleStop();
    clearAuthState();
    window.location.reload();
  };

  return (
    <div class="h-screen flex items-center justify-center bg-base-200">
      <div class="card w-96 bg-base-100 shadow-xl">
        <div class="card-body items-center text-center gap-3">

          <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-14" />
          <div>
            <h1 class="card-title justify-center">OpenCode</h1>
            <p class="text-base-content/50 text-sm">{auth.email}</p>
          </div>

          {/* Status badge */}
          <Show when={phase() === "idle"}>
            <div class="alert w-full py-2">
              <span class="text-sm">No active workspace</span>
            </div>
          </Show>
          <Show when={phase() === "starting"}>
            <div class="alert alert-info w-full py-2">
              <span class="loading loading-spinner loading-xs" />
              <span class="text-sm">Starting workspace… (~30s)</span>
            </div>
          </Show>
          <Show when={phase() === "running"}>
            <div class="alert alert-success w-full py-2">
              <span class="text-sm">● Workspace is ready</span>
            </div>
          </Show>
          <Show when={phase() === "stopping"}>
            <div class="alert alert-warning w-full py-2">
              <span class="loading loading-spinner loading-xs" />
              <span class="text-sm">Stopping…</span>
            </div>
          </Show>
          <Show when={phase() === "error"}>
            <div class="alert alert-error w-full py-2">
              <span class="text-sm">{errorMsg()}</span>
            </div>
          </Show>

          {/* Actions */}
          <div class="w-full flex flex-col gap-2 pt-1">
            <Show when={phase() === "idle" || phase() === "error"}>
              <button class="btn btn-primary w-full" onClick={handleLaunch}>
                Launch OpenCode
              </button>
            </Show>

            <Show when={phase() === "running"}>
              <a
                href={albUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-success w-full"
              >
                Open OpenCode ↗
              </a>
              <button
                class="btn btn-error btn-outline w-full"
                onClick={handleStop}
              >
                Stop Session
              </button>
            </Show>

            <Show when={phase() === "starting"}>
              <button
                class="btn btn-outline w-full"
                onClick={handleStop}
              >
                Cancel
              </button>
            </Show>

            <Show when={phase() !== "stopping"}>
              <button
                class="btn btn-ghost btn-sm w-full text-base-content/50"
                onClick={handleLogout}
              >
                Logout
              </button>
            </Show>
          </div>

        </div>
      </div>
    </div>
  );
}

export default function App() {
  const cognitoConfig = config().cognito;

  if (cognitoConfig) {
    return (
      <AuthProvider config={cognitoConfig}>
        <Dashboard />
      </AuthProvider>
    );
  }

  return <Dashboard />;
}
