import { Show, createSignal, onMount, createEffect } from "solid-js";
import { config } from "./stores/config";
import { createClient, type OpenCodeClient } from "./api/client";
import AuthProvider from "./components/AuthProvider";
import { useAuth } from "./components/AuthProvider";
import { clearAuthState } from "./utils/cognito";

interface Session {
  id: string;
  title: string;
  status: string;
  time: { created: string; updated: string };
}

function AppContent() {
  const auth = useAuth();
  const [api, setApi] = createSignal<OpenCodeClient | null>(null);
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    const endpoint = config().apiEndpoint;
    if (endpoint) {
      const client = createClient(endpoint);
      setApi(client);
      loadSessions(client);
    }
  });

  const loadSessions = async (client: OpenCodeClient) => {
    try {
      setLoading(true);
      setError(null);
      const response = await client.session.list({});
      const sessionList = (response.data as any)?.data || response.data || [];
      setSessions(Array.isArray(sessionList) ? sessionList : []);
      if (sessionList.length > 0 && !selectedSessionId()) {
        setSelectedSessionId(sessionList[0].id);
      }
    } catch (e) {
      console.error("Failed to load sessions:", e);
      setError("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSession = async () => {
    const client = api();
    if (!client) return;
    try {
      setLoading(true);
      const { data: session } = await client.session.create({ body: {} });
      if (session) {
        setSessions(prev => [session, ...prev]);
        setSelectedSessionId(session.id);
      }
    } catch (e) {
      console.error("Failed to create session:", e);
      setError("Failed to create session");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    clearAuthState();
    window.location.reload();
  };

  const currentSession = () => sessions().find(s => s.id === selectedSessionId());
  const apiEndpoint = () => config().apiEndpoint;

  return (
    <div class="h-screen flex flex-col bg-base-100">
      <Show
        when={auth.email}
        fallback={
          <div class="h-screen flex items-center justify-center bg-base-200">
            <div class="card w-96 bg-base-100 shadow-xl">
              <div class="card-body items-center text-center">
                <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-16 mb-4" />
                <h1 class="card-title mb-2">OpenCode</h1>
                <p class="text-base-content/60">Collaborative code workspace</p>
                <div class="alert alert-info mt-4 w-full">
                  <span>Redirecting to login...</span>
                </div>
              </div>
            </div>
          </div>
        }
      >
        <div class="drawer lg:drawer-open h-full">
          <input id="drawer-toggle" type="checkbox" class="drawer-toggle" />

          <div class="drawer-content flex flex-col max-h-dvh">
            <div class="navbar bg-base-200">
              <div class="flex-none lg:hidden">
                <label for="drawer-toggle" class="btn btn-square btn-ghost">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    class="inline-block w-6 h-6 stroke-current"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </label>
              </div>
              <div class="flex-1">
                <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-8" />
              </div>
              <div class="flex-none gap-2">
                <div class="dropdown dropdown-end">
                  <button class="btn btn-ghost btn-sm" title="Account menu">
                    {auth.email}
                  </button>
                  <ul class="dropdown-content z-50 menu p-2 shadow bg-base-100 rounded-box w-52">
                    <li><a onClick={handleLogout}>Logout</a></li>
                  </ul>
                </div>
              </div>
            </div>

            <div class="flex-1 min-h-0 overflow-hidden">
              <Show
                when={selectedSessionId() && apiEndpoint()}
                fallback={
                  <div class="h-full flex items-center justify-center text-base-content/60">
                    <div class="text-center">
                      <p class="text-lg mb-2">No session selected</p>
                      <p class="text-sm">Create a new session or select one from the list</p>
                    </div>
                  </div>
                }
              >
                {() => {
                  const sessionId = selectedSessionId();
                  const endpoint = apiEndpoint();
                  const url = `${endpoint}/opencode/${sessionId}`;

                  return (
                    <iframe
                      src={url}
                      class="w-full h-full border-none"
                      allow="same-origin"
                      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-presentation"
                      title="OpenCode Web UI"
                    />
                  );
                }}
              </Show>
            </div>
          </div>

          <div class="drawer-side">
            <label for="drawer-toggle" class="drawer-overlay"></label>
            <div class="w-80 h-full bg-base-200 flex flex-col">
              <div class="p-4 flex justify-between items-center border-b border-base-300">
                <h2 class="font-semibold">Sessions</h2>
                <button
                  class="btn btn-primary btn-sm"
                  onClick={handleCreateSession}
                  disabled={loading()}
                >
                  {loading() ? <span class="loading loading-spinner loading-sm"></span> : "+ New"}
                </button>
              </div>

              <Show when={error()}>
                <div class="alert alert-error m-2">
                  <span>{error()}</span>
                </div>
              </Show>

              <div class="flex-1 overflow-y-auto">
                <Show
                  when={sessions().length > 0}
                  fallback={
                    <div class="p-4 text-center text-base-content/60 text-sm">
                      <p>No sessions yet</p>
                      <p>Create one to get started</p>
                    </div>
                  }
                >
                  <ul class="menu p-2 space-y-1">
                    {sessions().map(session => (
                      <li>
                        <a
                          onClick={() => setSelectedSessionId(session.id)}
                          class={selectedSessionId() === session.id ? "active" : ""}
                        >
                          <div class="flex-1">
                            <div class="font-semibold truncate">{session.title}</div>
                            <div class="text-xs text-base-content/60">{session.status}</div>
                          </div>
                        </a>
                      </li>
                    ))}
                  </ul>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
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
