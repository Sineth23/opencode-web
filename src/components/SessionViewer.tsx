import { Show, createSignal, onMount } from "solid-js";

export interface SessionViewerProps {
  sessionId: string;
  endpoint: string;
  albUrl?: string;
  onClose: () => void;
}

export function SessionViewer(props: SessionViewerProps) {
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [retryCount, setRetryCount] = createSignal(0);

  onMount(() => {
    const checkSessionReady = async () => {
      try {
        // Use ALB directly if available, otherwise use API Gateway proxy
        const baseUrl = props.albUrl || props.endpoint;
        const checkUrl = props.albUrl
          ? `${props.albUrl}/?sessionId=${props.sessionId}`
          : `${props.endpoint}/opencode/${props.sessionId}`;

        console.log(`[SessionViewer] Checking if session ${props.sessionId} is ready (${baseUrl ? 'ALB' : 'API Gateway'})`);
        const response = await fetch(checkUrl, {
          method: "HEAD",
          headers: { "Accept": "text/html" },
        });

        if (response.ok || response.status === 200) {
          console.log("[SessionViewer] Session is ready!");
          setIsLoading(false);
          setError(null);
          return;
        }

        if (response.status === 502 || response.status === 503) {
          console.log(`[SessionViewer] Task not ready yet (${response.status}), will retry`);
          setRetryCount(c => c + 1);
          if (retryCount() < 30) {
            const delayMs = Math.min(500 * (retryCount() + 1), 3000);
            setTimeout(checkSessionReady, delayMs);
          } else {
            setError("Session startup timeout. Please try creating a new session.");
            setIsLoading(false);
          }
          return;
        }

        setError(`Session check failed with status ${response.status}`);
        setIsLoading(false);
      } catch (e) {
        console.error("[SessionViewer] Error checking session:", e);
        // Network error - might be CORS or actual error. Retry anyway
        setRetryCount(c => c + 1);
        if (retryCount() < 30) {
          const delayMs = Math.min(500 * (retryCount() + 1), 3000);
          setTimeout(checkSessionReady, delayMs);
        } else {
          setError("Failed to connect to session after multiple attempts.");
          setIsLoading(false);
        }
      }
    };

    checkSessionReady();
  });

  return (
    <div class="w-full h-full flex flex-col">
      <Show when={!isLoading() && !error()}>
        {/* Session is ready, embed it in an iframe */}
        <div class="flex-1 flex flex-col">
          <div class="flex justify-between items-center px-4 py-2 bg-base-200 border-b">
            <h2 class="font-semibold">OpenCode Session: {props.sessionId}</h2>
            <button class="btn btn-sm btn-ghost" onClick={props.onClose}>
              ← Back
            </button>
          </div>
          <iframe
            src={props.albUrl
              ? `${props.albUrl}/?sessionId=${props.sessionId}`
              : `${props.endpoint}/opencode/${props.sessionId}`}
            class="flex-1 w-full border-0"
            title="OpenCode Session"
          />
        </div>
      </Show>

      <Show when={isLoading()}>
        <div class="h-screen flex items-center justify-center bg-base-200">
          <div class="card w-96 bg-base-100 shadow-xl">
            <div class="card-body items-center text-center">
              <div class="flex justify-center mb-4">
                <span class="loading loading-spinner loading-lg"></span>
              </div>
              <h3 class="font-semibold mb-2">Starting Session</h3>
              <p class="text-sm text-base-content/60 mb-4">
                Initializing your OpenCode environment...
              </p>
              {retryCount() > 0 && (
                <p class="text-xs text-base-content/40">
                  Waiting for task to start (attempt {retryCount() + 1})
                </p>
              )}
            </div>
          </div>
        </div>
      </Show>

      <Show when={error() && !isLoading()}>
        <div class="h-screen flex items-center justify-center bg-base-200">
          <div class="card w-96 bg-base-100 shadow-xl">
            <div class="card-body">
              <h3 class="font-semibold text-error mb-2">Session Error</h3>
              <p class="text-sm text-base-content/60 mb-4">{error()}</p>
              <div class="flex gap-2">
                <button class="btn btn-sm btn-primary flex-1" onClick={props.onClose}>
                  Back to Sessions
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
