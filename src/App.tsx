import { Show, createSignal, onMount, onCleanup } from "solid-js";
import AuthProvider, { useAuth } from "./components/AuthProvider";
import FileBrowser from "./components/FileBrowser";
import { clearAuthState } from "./utils/cognito";
import { config } from "./stores/config";

const SESSION_KEY = "autodoc_opencode_session_id";
const PASSWORD_KEY = "autodoc_opencode_session_password";

type Phase = "idle" | "starting" | "running" | "stopping" | "error";
type Tab = "session" | "files";

const API_URL: string =
  import.meta.env.VITE_AUTODOC_API_URL ||
  "https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com";

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

  const [tab, setTab] = createSignal<Tab>("session");
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [errorMsg, setErrorMsg] = createSignal("");
  const [password, setPassword] = createSignal<string | null>(
    sessionStorage.getItem(PASSWORD_KEY)
  );
  const [copied, setCopied] = createSignal(false);

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
    setPassword(null);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PASSWORD_KEY);
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
    } catch {
      // transient — keep polling
    }
  };

  const startPolling = (sid: string) => {
    stopPolling();
    pollTimer = setInterval(() => pollStatus(sid), 5000);
  };

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
      const pw: string = data.password ?? "";
      setSessionId(sid);
      setPassword(pw);
      localStorage.setItem(SESSION_KEY, sid);
      if (pw) sessionStorage.setItem(PASSWORD_KEY, pw);
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
        // best-effort
      }
    }
    handleSessionEnded();
  };

  const handleCopyPassword = () => {
    const pw = password();
    if (!pw) return;
    navigator.clipboard.writeText(pw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleLogout = async () => {
    await handleStop();
    clearAuthState();
    window.location.reload();
  };

  return (
    <div class="h-screen flex flex-col bg-base-200">
      {/* Header */}
      <header class="navbar bg-base-100 shadow-sm px-4 py-2 shrink-0">
        <div class="flex-1">
          <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-8" />
        </div>
        <div class="flex-none flex items-center gap-3">
          <Show when={phase() === "running"}>
            <span class="badge badge-success badge-sm">● Session Active</span>
          </Show>
          <Show when={phase() === "starting"}>
            <span class="badge badge-info badge-sm">Starting…</span>
          </Show>
          <span class="text-sm text-base-content/50 hidden sm:block">{auth.email}</span>
          <button
            class="btn btn-ghost btn-sm"
            onClick={handleLogout}
            disabled={phase() === "stopping"}
          >
            Logout
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div class="bg-base-100 border-b border-base-300 px-4 shrink-0">
        <div class="tabs tabs-bordered">
          <button
            class="tab"
            classList={{ "tab-active": tab() === "session" }}
            onClick={() => setTab("session")}
          >
            AI Workspace
          </button>
          <button
            class="tab"
            classList={{ "tab-active": tab() === "files" }}
            onClick={() => setTab("files")}
          >
            Files
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div class="flex-1 overflow-auto">
        {/* Session Tab */}
        <Show when={tab() === "session"}>
          <div class="flex items-center justify-center min-h-full p-6">
            <div class="card w-96 bg-base-100 shadow-xl">
              <div class="card-body items-center text-center gap-3">
                <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-12" />
                <div>
                  <h1 class="card-title justify-center text-lg">AI Workspace</h1>
                  <p class="text-base-content/50 text-sm">{auth.email}</p>
                </div>

                {/* Status */}
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
                      Launch AI Workspace
                    </button>
                  </Show>

                  <Show when={phase() === "running"}>
                    <div class="w-full flex gap-2">
                      <a
                        href={`${albUrl}/connect?session=${sessionId()}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn btn-success flex-1"
                      >
                        Open Workspace ↗
                      </a>
                      <Show when={password()}>
                        <button
                          class="btn btn-outline btn-success"
                          onClick={handleCopyPassword}
                          title="Copy session password"
                        >
                          {copied() ? "✓" : "🔑"}
                        </button>
                      </Show>
                    </div>
                    <Show when={password()}>
                      <div class="w-full bg-base-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                        <span class="text-xs text-base-content/50 font-mono truncate">
                          {password()}
                        </span>
                        <button
                          class="btn btn-ghost btn-xs shrink-0"
                          onClick={handleCopyPassword}
                        >
                          {copied() ? "Copied!" : "Copy"}
                        </button>
                      </div>
                    </Show>
                    <button
                      class="btn btn-error btn-outline w-full"
                      onClick={handleStop}
                    >
                      Stop Session
                    </button>
                  </Show>

                  <Show when={phase() === "starting"}>
                    <button class="btn btn-outline w-full" onClick={handleStop}>
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
        </Show>

        {/* Files Tab */}
        <Show when={tab() === "files"}>
          <div class="p-4 h-full flex flex-col">
            <Show when={phase() !== "running"}>
              <div class="alert alert-info mb-4 text-sm">
                <span>
                  Start a workspace session to enable pulling files into the AI workspace.
                </span>
                <button
                  class="btn btn-sm btn-info btn-outline ml-auto"
                  onClick={() => setTab("session")}
                >
                  Go to Session
                </button>
              </div>
            </Show>
            <FileBrowser sessionId={sessionId()} />
          </div>
        </Show>
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
