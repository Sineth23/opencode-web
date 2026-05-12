import { Show, createSignal, onMount } from "solid-js";
import { config } from "./stores/config";
import { createClient, type OpenCodeClient } from "./api/client";
import AuthProvider from "./components/AuthProvider";
import { useAuth } from "./components/AuthProvider";
import { clearAuthState } from "./utils/cognito";
import { SessionViewer } from "./components/SessionViewer";

interface Session {
  id: string;
  title: string;
  status?: string;
  time: { created: number; updated: number };
}

function AppContent() {
  const auth = useAuth();
  const [api, setApi] = createSignal<OpenCodeClient | null>(null);
  const [sessions, setSessions] = createSignal<Session[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [isAutoCreating, setIsAutoCreating] = createSignal(false);
  const [viewingSessionId, setViewingSessionId] = createSignal<string | null>(null);

  onMount(async () => {
    const endpoint = config().apiEndpoint;
    console.log("[App] Mounted. Auth email:", auth.email, "Endpoint:", endpoint);

    if (endpoint) {
      const client = createClient(endpoint);
      setApi(client);

      // If user is authenticated, auto-create first session or redirect to existing one
      if (auth.email && !isAutoCreating()) {
        setIsAutoCreating(true);
        try {
          // Try to load existing sessions first
          console.log("[App] Loading existing sessions...");
          const response = await client.session.list({});
          console.log("[App] Session list response:", response);

          const sessionList = (response.data as any)?.data || response.data || response || [];
          const sessions = Array.isArray(sessionList) ? sessionList : [];
          console.log("[App] Parsed sessions:", sessions);

          if (sessions.length > 0) {
            // Show first session
            console.log("[App] Opening first session:", sessions[0]);
            setViewingSessionId(sessions[0].id);
            return;
          }
        } catch (e) {
          console.log("[App] Could not load sessions, will create new one:", e);
        }

        // No sessions exist, create one
        try {
          console.log("[App] Creating new session...");
          const createResponse = await client.session.create({ body: {} });
          console.log("[App] Session create response:", createResponse);

          const session = (createResponse.data as any) || createResponse;
          console.log("[App] Parsed session:", session);

          if (session && (session.id || session.sessionId)) {
            const sessionId = session.id || session.sessionId;
            console.log("[App] Session created with ID:", sessionId);
            // Show the new session
            setViewingSessionId(sessionId);
            return;
          } else {
            console.error("[App] Session response missing id/sessionId:", session);
            setError("Session created but missing ID");
          }
        } catch (e) {
          console.error("[App] Failed to auto-create session:", e);
          setError(`Failed to create session: ${String(e)}`);
          setIsAutoCreating(false);
          // Fall back to manual session creation
          await loadSessions(client);
        }
      } else if (auth.email) {
        // User is authenticated, load sessions
        console.log("[App] Auth email found, loading sessions manually");
        await loadSessions(client);
      } else {
        console.log("[App] Not authenticated, waiting for login");
      }
    }
  });

  const loadSessions = async (client: OpenCodeClient) => {
    try {
      setLoading(true);
      setError(null);
      const response = await client.session.list({});
      const sessionList = (response.data as any)?.data || response.data || [];
      setSessions(Array.isArray(sessionList) ? sessionList : []);
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
      const createResponse = await client.session.create({ body: {} });
      const session = (createResponse.data as any) || createResponse;
      if (session && (session.id || session.sessionId)) {
        setSessions([session, ...sessions()]);
        // Redirect to standalone OpenCode UI for this session
        const endpoint = config().apiEndpoint;
        const sessionId = session.id || session.sessionId;
        window.location.href = `${endpoint}/opencode/${sessionId}`;
      }
    } catch (e) {
      console.error("Failed to create session:", e);
      setError("Failed to create session");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    console.log("[App] Viewing session:", sessionId);
    setViewingSessionId(sessionId);
  };

  const handleLogout = () => {
    clearAuthState();
    window.location.reload();
  };

  return (
    <Show
      when={viewingSessionId()}
      fallback={
        <div class="h-screen flex items-center justify-center bg-base-200">
          <Show
            when={auth.email}
            fallback={
              <div class="card w-96 bg-base-100 shadow-xl">
                <div class="card-body items-center text-center">
                  <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-16 mb-4" />
                  <h1 class="card-title mb-2">OpenCode</h1>
                  <p class="text-base-content/60 mb-4">Collaborative code workspace</p>
                  <div class="alert alert-info w-full">
                    <span>Redirecting to login...</span>
                  </div>
                </div>
              </div>
            }
          >
            <div class="card w-full max-w-2xl bg-base-100 shadow-xl">
              <div class="card-body">
                <div class="flex justify-between items-center mb-6">
                  <h2 class="card-title">Your Sessions</h2>
                  <div class="flex gap-2">
                    <button
                      class="btn btn-primary"
                      onClick={handleCreateSession}
                      disabled={loading()}
                    >
                      {loading() ? <span class="loading loading-spinner loading-sm"></span> : "+ New Session"}
                    </button>
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

                <Show when={error()}>
                  <div class="alert alert-error mb-4">
                    <span>{error()}</span>
                  </div>
                </Show>

                <Show
                  when={sessions().length > 0}
                  fallback={
                    <div class="text-center text-base-content/60 py-8">
                      <p class="text-lg mb-2">No sessions yet</p>
                      <p class="text-sm">Click "+ New Session" to create an isolated OpenCode workspace</p>
                    </div>
                  }
                >
                  <div class="overflow-x-auto">
                    <table class="table table-zebra w-full">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Status</th>
                          <th>Created</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessions().map(session => (
                          <tr>
                            <td class="font-semibold">{session.title}</td>
                            <td>
                              <div class="badge badge-sm">
                                {session.status}
                              </div>
                            </td>
                            <td class="text-sm text-base-content/60">
                              {new Date(session.time.created).toLocaleDateString()}
                            </td>
                            <td>
                              <button
                                class="btn btn-sm btn-primary"
                                onClick={() => handleSelectSession(session.id)}
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      }
    >
      <div class="h-screen w-full bg-base-200">
        <SessionViewer
          sessionId={viewingSessionId()!}
          endpoint={config().apiEndpoint}
          onClose={() => {
            console.log("[App] Closing session viewer");
            setViewingSessionId(null);
          }}
        />
      </div>
    </Show>
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
