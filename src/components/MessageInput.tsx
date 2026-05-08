import { createSignal, onMount, createEffect, Show, For } from "solid-js";
import type { OpenCodeClient, Provider, Agent } from "../api/client";
import {
  currentSessionId,
  currentMessages,
  isSending,
  setIsSending,
  abortCurrentRequest,
  setAbortController,
  setSessionMessages,
  forceResetSending,
  clearStaleParts,
  updateMessage,
  updatePart,
} from "../stores/session";
import S3Browser from "./S3Browser";

interface MessageInputProps {
  api: OpenCodeClient | null;
}

export default function MessageInput(props: MessageInputProps) {
  const [message, setMessage] = createSignal("");
  const [providers, setProviders] = createSignal<Provider[]>([]);
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [selectedProvider, setSelectedProvider] = createSignal<string>("");
  const [selectedModel, setSelectedModel] = createSignal<string>("");
  const [selectedAgent, setSelectedAgent] = createSignal<string>("");
  const [selectedFile, setSelectedFile] = createSignal<{ key: string; size: number } | null>(null);
  const [selectedFileContent, setSelectedFileContent] = createSignal<string>("");

  let textareaRef: HTMLTextAreaElement | undefined;

  onMount(async () => {
    console.log('[MessageInput] onMount called, api:', !!props.api);
    if (!props.api) {
      console.warn('[MessageInput] No API client available');
      return;
    }

    try {
      console.log('[MessageInput] Loading providers and agents...');
      const [providersResp, agentsResp] = await Promise.all(
        [props.api.config.providers(), props.api.app.agents()],
      );

      console.log('[MessageInput] Providers response:', providersResp);
      console.log('[MessageInput] Agents response:', agentsResp);

      const providersData = providersResp?.data;
      const agentsData = agentsResp?.data;

      if (providersData?.providers) {
        console.log('[MessageInput] Setting providers:', providersData.providers.length);
        setProviders(providersData.providers);

        if (providersData.providers.length > 0) {
          const defaultProvider = providersData.providers[0];
          setSelectedProvider(defaultProvider.id);

          const models = Object.keys(defaultProvider.models || {});
          if (models.length > 0) {
            setSelectedModel(models[0]);
          }
        }
      } else {
        console.warn('[MessageInput] No providers data in response');
      }

      if (agentsData) {
        console.log('[MessageInput] Setting agents:', agentsData.length);
        const filtered = Array.isArray(agentsData)
          ? agentsData.filter((a: any) => a.mode !== "subagent")
          : [];
        setAgents(filtered);

        if (filtered.length > 0) {
          const buildAgent = filtered.find((a: any) => a.name === "build");
          setSelectedAgent(buildAgent?.name || filtered[0].name);
        }
      } else {
        console.warn('[MessageInput] No agents data in response');
      }

      updateFromLastMessage();
    } catch (error) {
      console.error("[MessageInput] Failed to load models/agents:", error);
    }
  });

  // Update model/agent selection when messages change
  const updateFromLastMessage = () => {
    const lastMessage = [...currentMessages()]
      .reverse()
      .find((m: any) => m.info.role === "assistant");
    if (lastMessage && "modelID" in lastMessage.info) {
      setSelectedProvider(lastMessage.info.providerID);
      setSelectedModel(lastMessage.info.modelID);
      setSelectedAgent(lastMessage.info.mode);
    }
  };

  createEffect(() => {
    // Watch for changes in current session or messages
    const sessionId = currentSessionId();
    const messages = currentMessages();

    if (sessionId && messages.length > 0) {
      updateFromLastMessage();
    }
  });

  const handleSend = async () => {
    if (!message().trim() || isSending() || !currentSessionId()) {
      return;
    }

    let text = message().trim();

    // Check for slash commands
    if (text.startsWith("/")) {
      const [cmd] = text.split(" ");

      if (cmd === "/clear") {
        setMessage("");
        setSessionMessages(currentSessionId()!, []);
        return;
      }

      if (cmd === "/compact") {
        setMessage("");
        await handleCompact();
        return;
      }
    }

    // Include S3 file content if selected
    if (selectedFileContent()) {
      text += `\n\nS3 File: ${selectedFile()?.key}\n\`\`\`\n${selectedFileContent()}\n\`\`\``;
    }

    setMessage("");
    setSelectedFile(null);
    setSelectedFileContent("");
    setIsSending(true);

    const controller = new AbortController();
    setAbortController(controller);

    const sessionId = currentSessionId();
    if (!sessionId) {
      console.error('No session ID available');
      setIsSending(false);
      return;
    }

    // Add user message to UI immediately (before sending)
    const userMessageId = `msg-${Date.now()}`;
    const userInfo = {
      id: userMessageId,
      role: "user",
    };
    updateMessage(sessionId, userMessageId, userInfo);
    console.log('[MessageInput] Added user message:', userMessageId);

    const userPart = {
      id: `part-${Date.now()}`,
      messageID: userMessageId,
      type: "text" as const,
      index: 0,
      text,
    };
    updatePart(sessionId, userMessageId, userPart);
    console.log('[MessageInput] Added user part:', userPart.id);

    try {
      const requestBody: any = {
        parts: [
          {
            type: "text",
            text,
          },
        ],
      };

      // Add model/agent if selected
      if (selectedProvider() && selectedModel()) {
        requestBody.model = {
          providerID: selectedProvider(),
          modelID: selectedModel(),
        };
      }

      if (selectedAgent()) {
        requestBody.agent = selectedAgent();
      }

      // Use direct fetch instead of SDK to bypass GET/HEAD issue
      const token = localStorage.getItem('cognito_id_token');
      const apiUrl = import.meta.env.VITE_API_DEFAULT || 'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com';

      const response = await fetch(
        `${apiUrl}/session/${sessionId}/message`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` }),
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      // Parse response and add to messages
      let responseData: any = null;
      const responseText = await response.text();
      console.log("Raw message response:", responseText);

      if (responseText) {
        try {
          responseData = JSON.parse(responseText);
        } catch (e) {
          console.warn("Failed to parse response as JSON:", e);
        }
      }
      console.log("Parsed message response:", responseData);

      // Add assistant response if present
      if (responseData && typeof responseData === 'object') {
        const assistantMessageId = `msg-${Date.now() + 1}`;
        const assistantInfo = {
          id: assistantMessageId,
          role: "assistant",
        };
        updateMessage(sessionId, assistantMessageId, assistantInfo);
        console.log('[MessageInput] Added assistant message:', assistantMessageId);

        const responsePart = {
          id: `part-${Date.now() + 1}`,
          messageID: assistantMessageId,
          type: "text" as const,
          index: 0,
          text: JSON.stringify(responseData, null, 2),
        };
        updatePart(sessionId, assistantMessageId, responsePart);
        console.log('[MessageInput] Added assistant part:', responsePart.id);
      }
    } catch (error: any) {
      if (error?.name === "AbortError") {
        console.log("Request aborted");
        return;
      }
      console.error("Failed to send message:", error);
    } finally {
      setIsSending(false);
      setAbortController(null);
    }
  };

  const handleStop = () => {
    abortCurrentRequest();
  };

  const handleCompact = async () => {
    if (!props.api || !currentSessionId() || isSending()) {
      return;
    }

    setIsSending(true);

    try {
      await props.api.session.summarize({
        path: { id: currentSessionId()! },
        body: {
          providerID: selectedProvider(),
          modelID: selectedModel(),
        },
      });
    } catch (error) {
      console.error("Failed to compact session:", error);
      alert("Failed to compact session");
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const currentProvider = () => {
    return providers().find((p) => p.id === selectedProvider());
  };

  const availableModels = () => {
    const provider = currentProvider();
    if (!provider) return [];
    const models = Object.entries(provider.models as Record<string, any>);
    return models.map(([id, model]) => ({ id, name: (model as any).name }));
  };

  return (
    <div class="border-t border-base-300 bg-base-200 p-4">
      <div class="max-w-4xl mx-auto space-y-3">
        <div class="flex gap-2 flex-wrap">
          <select
            class="select select-sm basis-full sm:flex-1 sm:basis-0 min-w-[150px] max-w-none"
            value={selectedProvider()}
            onChange={(e) => {
              setSelectedProvider(e.currentTarget.value);
              const models = availableModels();
              if (models.length > 0) {
                setSelectedModel(models[0].id);
              }
            }}
          >
            <For each={providers()}>
              {(provider) => (
                <option value={provider.id}>{provider.name}</option>
              )}
            </For>
          </select>

          <select
            class="select select-sm basis-full sm:flex-1 sm:basis-0 min-w-[150px] max-w-none"
            value={selectedModel()}
            onChange={(e) => setSelectedModel(e.currentTarget.value)}
          >
            <For each={availableModels()}>
              {(model) => <option value={model.id}>{model.name}</option>}
            </For>
          </select>

          <select
            class="select select-sm basis-full sm:flex-1 sm:basis-0 min-w-[150px] max-w-none"
            value={selectedAgent()}
            onChange={(e) => setSelectedAgent(e.currentTarget.value)}
          >
            <For each={agents()}>
              {(agent) => (
                <option value={agent.name}>
                  {agent.name}{" "}
                  {agent.description ? `- ${agent.description}` : ""}
                </option>
              )}
            </For>
          </select>
        </div>

        <div class="border-t border-base-300">
          <details class="collapse collapse-arrow bg-base-100">
            <summary class="collapse-title text-sm font-semibold">
              📁 S3 File Browser
              <Show when={selectedFile()}>
                <span class="badge badge-primary badge-sm ml-2">{selectedFile()?.key?.split("/").pop()}</span>
              </Show>
            </summary>
            <div class="collapse-content">
              <S3Browser
                onSelectFile={(file, content) => {
                  setSelectedFile(file);
                  setSelectedFileContent(content || "");
                }}
              />
            </div>
          </details>
        </div>

        <Show when={selectedFile() && selectedFileContent()}>
          <div class="bg-base-200 p-3 rounded border-l-4 border-primary">
            <div class="text-sm font-semibold mb-2">📎 Selected File</div>
            <div class="text-xs text-base-content/70 mb-2">{selectedFile()?.key}</div>
            <div class="max-h-24 overflow-y-auto bg-base-100 p-2 rounded text-xs font-mono">
              {selectedFileContent()?.substring(0, 200)}
              {selectedFileContent()?.length ?? 0 > 200 ? "..." : ""}
            </div>
            <button
              class="btn btn-xs btn-ghost mt-2"
              onClick={() => {
                setSelectedFile(null);
                setSelectedFileContent("");
              }}
            >
              Remove
            </button>
          </div>
        </Show>

        <div class="flex gap-2">
          <textarea
            ref={textareaRef}
            class="textarea flex-1 min-h-[60px] max-h-[200px] w-full"
            placeholder="Type a message... (Shift+Enter for new line)"
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={isSending()}
          />
          <Show
            when={isSending()}
            fallback={
              <button
                class="btn btn-primary"
                onClick={handleSend}
                disabled={!message().trim() || isSending()}
              >
                Send
              </button>
            }
          >
            <button class="btn btn-error" onClick={handleStop}>
              Stop
            </button>
          </Show>
          <button
            class="btn btn-ghost btn-sm"
            onClick={() => {
              forceResetSending();
              const sid = currentSessionId();
              if (sid) clearStaleParts(sid);
            }}
            title="Reset stuck state"
          >
            ↺
          </button>
        </div>
      </div>
    </div>
  );
}
