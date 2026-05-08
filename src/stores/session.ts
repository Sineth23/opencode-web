import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Session, MessageWithParts, Part, Message } from '../api/types';

export const [sessions, setSessions] = createSignal<Session[]>([]);
export const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);

export const [messages, setMessages] = createStore<Record<string, MessageWithParts[]>>({});

export const [isLoading, setIsLoading] = createSignal(false);
export const [isSending, setIsSending] = createSignal(false);
export const [abortController, setAbortController] = createSignal<AbortController | null>(null);

export function abortCurrentRequest() {
  const controller = abortController();
  if (controller) {
    controller.abort();
    setAbortController(null);
    setIsSending(false);
  }
}

export function forceResetSending() {
  setAbortController(null);
  setIsSending(false);
}

export function clearStaleParts(sessionId: string) {
  const sessionMessages = messages[sessionId];
  if (!sessionMessages) return;
  
  const cleaned = sessionMessages.map(msg => {
    const parts = msg.parts.filter(part => 
      part.type === "tool" ? part.state.status !== "running" : true
    );
    return { ...msg, parts };
  }).filter(msg => msg.parts.length > 0 || msg.info.role === "user");
  
  setMessages(sessionId, cleaned);
}

export function currentSession() {
  const id = currentSessionId();
  if (!id) return null;
  return sessions().find((s) => s.id === id) || null;
}

export function currentMessages(): MessageWithParts[] {
  const id = currentSessionId();
  if (!id) return [];
  return messages[id] || [];
}

export function addSession(session: Session) {
  setSessions((prev) => [session, ...prev]);
}

export function updateSession(session: Session) {
  setSessions((prev) =>
    prev.map((s) => (s.id === session.id ? session : s))
  );
}

export function removeSession(sessionId: string) {
  setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  if (currentSessionId() === sessionId) {
    setCurrentSessionId(null);
  }
}

export function setSessionMessages(sessionId: string, msgs: MessageWithParts[]) {
  setMessages(sessionId, msgs);
}

export function updateMessage(sessionId: string, messageId: string, info: Message) {
  const sessionMessages = messages[sessionId];

  if (!sessionMessages) {
    // Create first message for this session
    const newMessages: MessageWithParts[] = [{ info, parts: [] }];
    setMessages(sessionId, newMessages);
    console.debug('[updateMessage] Created first message:', { sessionId, messageId, totalMessages: 1 });
    return;
  }

  const index = sessionMessages.findIndex((m) => m.info.id === messageId);
  if (index !== -1) {
    // Update existing message
    setMessages(sessionId, index, 'info', info);
    console.debug('[updateMessage] Updated existing message:', { sessionId, messageId, index });
  } else {
    // Add new message to session
    const newMessages: MessageWithParts[] = [
      ...sessionMessages,
      { info, parts: [] }
    ];
    setMessages(sessionId, newMessages);
    console.debug('[updateMessage] Added new message:', { sessionId, messageId, totalMessages: newMessages.length });
  }
}

export function updatePart(sessionId: string, messageId: string, part: Part) {
  const sessionMessages = messages[sessionId];

  if (!sessionMessages) {
    // Create first message with part
    const newMessages: MessageWithParts[] = [{
      info: { id: messageId } as any,
      parts: [part]
    }];
    setMessages(sessionId, newMessages);
    console.debug('[updatePart] Created first message with part:', { sessionId, messageId, partId: part.id });
    return;
  }

  const msgIndex = sessionMessages.findIndex((m) => m.info.id === messageId);
  if (msgIndex === -1) {
    // Message doesn't exist, create it with the part
    const newMessages: MessageWithParts[] = [
      ...sessionMessages,
      { info: { id: messageId } as any, parts: [part] }
    ];
    setMessages(sessionId, newMessages);
    console.debug('[updatePart] Added new message with part:', { sessionId, messageId, partId: part.id });
    return;
  }

  // Message exists, update or add part
  const message = sessionMessages[msgIndex];
  const partIndex = message.parts.findIndex((p) => p.id === part.id);

  if (partIndex !== -1) {
    // Part already exists, update it
    setMessages(sessionId, msgIndex, 'parts', partIndex, part);
    console.debug('[updatePart] Updated existing part:', { sessionId, messageId, partId: part.id });
  } else {
    // Add new part to message
    const newParts: Part[] = [...message.parts, part];
    setMessages(sessionId, msgIndex, 'parts', newParts);
    console.debug('[updatePart] Added new part to message:', { sessionId, messageId, partId: part.id, totalParts: newParts.length });
  }
}

export function removePart(sessionId: string, messageId: string, partId: string) {
  const sessionMessages = messages[sessionId];
  if (!sessionMessages) return;

  const msgIndex = sessionMessages.findIndex((m) => m.info.id === messageId);
  if (msgIndex !== -1) {
    setMessages(
      sessionId,
      msgIndex,
      'parts',
      sessionMessages[msgIndex].parts.filter((p) => p.id !== partId)
    );
  }
}
