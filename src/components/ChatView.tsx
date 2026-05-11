import { Show } from 'solid-js';
import { config } from '../stores/config';
import type { OpenCodeClient } from '../api/client';
import { currentSession } from '../stores/session';

interface ChatViewProps {
  api: OpenCodeClient | null;
}

export default function ChatView(_props: ChatViewProps) {
  const session = currentSession;
  const apiEndpoint = () => config().apiEndpoint;

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <Show when={session()}>
        <div class="bg-base-200 px-4 py-3 border-b border-base-300 flex items-center justify-between">
          <h1 class="text-lg font-semibold truncate flex-1">
            {session()?.title}
          </h1>
        </div>
      </Show>

      <div class="relative flex-1 min-h-0">
        <Show
          when={session()}
          fallback={
            <div class="h-full flex items-center justify-center text-base-content/60">
              <div class="text-center">
                <p class="text-lg mb-2">No session selected</p>
                <p class="text-sm">Create a new session or select an existing one from the list</p>
              </div>
            </div>
          }
        >
          {() => {
            const sessionId = session()?.id;
            const url = `${apiEndpoint()}/opencode/${sessionId}`;

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
  );
}
