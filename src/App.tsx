import { Show, onMount, onCleanup, createSignal } from "solid-js";
import { batch } from "solid-js";
import { config } from "./stores/config";
import { createClient, type OpenCodeClient } from "./api/client";
import { subscribeToEvents, type EventHandlers } from "./api/sse";
import type { Message, Part } from "./api/types";
import {
  setSessions,
  currentSessionId,
  setCurrentSessionId,
  setSessionMessages,
  updateMessage,
  updatePart,
} from "./stores/session";
import SessionList from "./components/SessionList";
import ChatView from "./components/ChatView";
import MessageInput from "./components/MessageInput";
import Settings from "./components/Settings";
import AuthProvider from "./components/AuthProvider";
import { addSession } from "./stores/session";
import { useAuth } from "./components/AuthProvider";
import { clearAuthState } from "./utils/cognito";

let pendingParts: Part[] = [];
let partDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const PART_FLUSH_INTERVAL = 16;

const flushParts = () => {
  if (pendingParts.length === 0) return;
  const parts = pendingParts.splice(0);
  batch(() => {
    for (const part of parts) {
      updatePart(part.sessionID, part.messageID, part);
    }
  });
};

const debouncedUpdatePart = (part: Part) => {
  pendingParts.push(part);
  if (!partDebounceTimer) {
    partDebounceTimer = setTimeout(() => {
      partDebounceTimer = null;
      flushParts();
    }, PART_FLUSH_INTERVAL);
  }
};

function AppContent() {
  const [api, setApi] = createSignal<OpenCodeClient | null>(null);
  const [showSettings, setShowSettings] = createSignal(false);
  const [isReconnecting, setIsReconnecting] = createSignal(false);
  const auth = useAuth();

  let eventStreamAbort: AbortController | null = null;
  let reconnectWake: (() => void) | null = null;
  let eventLoopStopped = false;
  let hasConnectedToEvents = false;
  let connectionErrorNotified = false;

  const handleCreateSession = async () => {
    const client = api();
    if (!client) return;
    try {
      const { data: session } = await client.session.create({ body: {} });
      if (session) {
        addSession(session);
        setCurrentSessionId(session.id);
        setSessionMessages(session.id, []);
      }
    } catch (e) {
      console.error("Failed to create session:", e);
      alert("Failed to create session");
    }
  };

  const startEventStream = (client: OpenCodeClient) => {
    const handlers = {
      onMessageCreated: (data: { info: Message }) => batch(() => {
        updateMessage(data.info.sessionID, data.info.id, data.info);
      }),
      onMessageUpdate: (data: { info: Message }) => batch(() => {
        updateMessage(data.info.sessionID, data.info.id, data.info);
      }),
      onPartCreated: (data: { part: Part }) => {
        debouncedUpdatePart(data.part);
      },
      onPartUpdate: (data: { part: Part }) => {
        debouncedUpdatePart(data.part);
      },
    } satisfies EventHandlers;

    const loadSessions = async (signal: AbortSignal) => {
      const response = await client.session.list({ signal });
      const sessionList = (response.data as any)?.data || response.data;
      if (!sessionList) throw new Error("Failed to fetch sessions");

      const sortedSessions = [...sessionList].sort(
        (a, b) => b.time.updated - a.time.updated,
      );
      setSessions(sortedSessions);

      let targetId = currentSessionId();
      if (
        !targetId ||
        !sortedSessions.some((session) => session.id === targetId)
      ) {
        targetId = sortedSessions[0]?.id ?? null;
        setCurrentSessionId(targetId ?? null);
      }

      if (targetId) {
        try {
          const { data: msgs } = await client.session.messages({
            path: { id: targetId },
            signal,
          });
          setSessionMessages(targetId, msgs ?? []);
        } catch (error: any) {
          // Task may still be provisioning, don't break the connection
          if (error?.response?.status === 502 || error?.status === 502) {
            console.warn(`Session ${targetId} task not ready yet, skipping message load`);
            // Don't clear messages - keep what we have
          } else {
            throw error;
          }
        }
      }
    };

    const baseDelay = 1000;
    const maxDelay = 30000;

    void (async () => {
      let attempt = 0;
      while (!eventLoopStopped) {
        try {
          const loadController = new AbortController();
          eventStreamAbort = loadController;
          await loadSessions(loadController.signal);
          eventStreamAbort = null;

          const controller = new AbortController();
          eventStreamAbort = controller;
          const sub: any = await client.event.subscribe({
            signal: controller.signal,
          });
          const stream = sub?.data?.stream ?? sub?.stream;
          if (!stream) {
            throw new Error("Event subscription did not include a stream");
          }

          hasConnectedToEvents = true;
          connectionErrorNotified = false;
          setIsReconnecting(false);
          attempt = 0;
          await subscribeToEvents(stream, handlers);

          if (eventLoopStopped) {
            break;
          }

          console.info("Event stream ended; attempting to reconnect...");
          setIsReconnecting(true);
        } catch (error) {
          if (eventLoopStopped) {
            break;
          }
          if ((error as any)?.name === "AbortError") {
            break;
          }
          if (!hasConnectedToEvents && !connectionErrorNotified) {
            connectionErrorNotified = true;
            setShowSettings(true);
          }
          setIsReconnecting(true);
          attempt = Math.min(attempt + 1, 5);
          console.warn("Event stream interrupted, retrying shortly...", error);
        } finally {
          eventStreamAbort = null;
        }

        if (eventLoopStopped) {
          break;
        }

        const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            reconnectWake = null;
            resolve();
          }, delay);
          reconnectWake = () => {
            clearTimeout(timeout);
            reconnectWake = null;
            resolve();
          };
        });
      }
    })();
  };

  onMount(() => {
    const endpoint = config().apiEndpoint;

    if (!endpoint) {
      setShowSettings(true);
      return;
    }

    const client = createClient(endpoint);
    setApi(client);
    eventLoopStopped = false;
    reconnectWake = null;
    hasConnectedToEvents = false;
    connectionErrorNotified = false;
    startEventStream(client);
  });

  onCleanup(() => {
    eventLoopStopped = true;
    eventStreamAbort?.abort();
    reconnectWake?.();
    eventStreamAbort = null;
    reconnectWake = null;
    if (partDebounceTimer) {
      clearTimeout(partDebounceTimer);
      flushParts();
    }
  });

  return (
    <div class="h-screen flex flex-col bg-base-100">
      <div class="drawer lg:drawer-open h-full">
        <input id="drawer-toggle" type="checkbox" class="drawer-toggle" />

        <div class="drawer-content flex flex-col max-h-dvh">
          <Show when={isReconnecting()}>
            <div class="alert alert-warning m-2">
              <span class="loading loading-spinner loading-sm"></span>
              <span>Reconnecting...</span>
            </div>
          </Show>
          <div class="navbar bg-base-200 lg:hidden">
            <div class="flex-none">
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
            <div class="flex-none flex items-center gap-1">
              <button
                class="btn btn-ghost btn-sm"
                onClick={handleCreateSession}
              >
                + New
              </button>
              <button
                class="btn btn-square btn-ghost"
                onClick={() => setShowSettings(true)}
              >
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
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
              <div class="dropdown dropdown-end">
                <button class="btn btn-ghost btn-sm" title="Account menu">
                  <Show when={auth.email} fallback="Account">
                    {auth.email}
                  </Show>
                </button>
                <ul class="dropdown-content z-50 menu p-2 shadow bg-base-100 rounded-box w-52">
                  <li><a onClick={() => {
                    clearAuthState();
                    window.location.reload();
                  }}>Logout</a></li>
                </ul>
              </div>
            </div>
          </div>

          <div class="grid grid-rows-[1fr_auto] h-dvh overflow-hidden">
            <div class="min-h-0 overflow-hidden">
              <ChatView api={api()} />
            </div>
            <Show when={currentSessionId()}>
              <MessageInput api={api()} />
            </Show>
          </div>
        </div>

        <div class="drawer-side">
          <label for="drawer-toggle" class="drawer-overlay"></label>
          <div class="w-80 h-full bg-base-200 flex flex-col">
            <div class="p-4 flex justify-between items-center border-b border-base-300">
              <img src="/images/autodoc-logo.svg" alt="AutoDoc" class="h-8" />
              <div class="flex items-center gap-1">
                <button
                  class="btn btn-ghost btn-sm hidden lg:flex"
                  onClick={handleCreateSession}
                  title="New Session"
                >
                  + New
                </button>
                <button
                  class="btn btn-square btn-ghost btn-sm hidden lg:flex"
                  onClick={() => setShowSettings(true)}
                  title="Settings"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    class="inline-block w-5 h-5 stroke-current"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                </button>
                <div class="dropdown dropdown-end hidden lg:flex">
                  <button class="btn btn-ghost btn-sm" title="Account menu">
                    <Show when={auth.email} fallback="Account">
                      {auth.email}
                    </Show>
                  </button>
                  <ul class="dropdown-content z-50 menu p-2 shadow bg-base-100 rounded-box w-52">
                    <li><a onClick={() => {
                      clearAuthState();
                      window.location.reload();
                    }}>Logout</a></li>
                  </ul>
                </div>
              </div>
            </div>

            <SessionList api={api()} />
          </div>
        </div>
        <Show when={showSettings()}>
          <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div class="max-h-[90vh] overflow-auto">
              <Settings onClose={() => setShowSettings(false)} />
            </div>
          </div>
        </Show>
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
