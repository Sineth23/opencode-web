import { createSignal, For, Show, onMount } from "solid-js";
import { marked } from "marked";

const API_URL: string =
  import.meta.env.VITE_AUTODOC_API_URL ||
  "https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com";

function apiFetch(path: string, method = "GET", body?: object) {
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


interface Folder {
  prefix: string;
  name: string;
}

interface FileItem {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  contentType: string;
}

interface FileBrowserProps {
  sessionId: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderContent(key: string, content: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") {
    return marked.parse(content) as string;
  }
  if (ext === "json") {
    try {
      return `<pre class="text-xs font-mono whitespace-pre-wrap">${JSON.stringify(JSON.parse(content), null, 2)}</pre>`;
    } catch {
      return `<pre class="text-xs font-mono whitespace-pre-wrap">${content}</pre>`;
    }
  }
  return `<pre class="text-xs font-mono whitespace-pre-wrap">${content}</pre>`;
}

export default function FileBrowser(props: FileBrowserProps) {
  const [prefix, setPrefix] = createSignal("projects/");
  const [rootFolders, setRootFolders] = createSignal<Folder[]>([]);
  const [folders, setFolders] = createSignal<Folder[]>([]);
  const [files, setFiles] = createSignal<FileItem[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");

  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal("");
  const [fileLoading, setFileLoading] = createSignal(false);
  const [fileError, setFileError] = createSignal("");

  const [pulling, setPulling] = createSignal(false);
  const [pullMsg, setPullMsg] = createSignal("");

  const listFolder = async (p: string) => {
    setLoading(true);
    setError("");
    setFolders([]);
    setFiles([]);
    setSelectedKey(null);
    setFileContent("");
    setFileError("");
    setPullMsg("");
    try {
      const data = await apiFetch(`/opencode/files?prefix=${encodeURIComponent(p)}`);
      if (!data.ok) throw new Error(data.error || "Failed to list files");
      setFolders(data.folders || []);
      setFiles(data.files || []);
      if (p === "projects/" || p === "repos/") setRootFolders(prev => prev);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const navigate = (p: string) => {
    setPrefix(p);
    listFolder(p);
  };

  onMount(() => listFolder("projects/"));

  const openFile = async (key: string) => {
    setSelectedKey(key);
    setFileContent("");
    setFileError("");
    setPullMsg("");
    setFileLoading(true);
    try {
      const data = await apiFetch(`/opencode/files/read?key=${encodeURIComponent(key)}`);
      if (!data.ok) throw new Error(data.error || "Failed to read file");
      setFileContent(data.content || "");
    } catch (e: any) {
      setFileError(e.message);
    } finally {
      setFileLoading(false);
    }
  };

  const pullToWorkspace = async () => {
    const sid = props.sessionId;
    const key = selectedKey();
    if (!sid || !key) return;
    setPulling(true);
    setPullMsg("");
    try {
      const data = await apiFetch("/opencode/files/pull", "POST", { sessionId: sid, key });
      if (!data.ok) throw new Error(data.error || "Pull failed");
      setPullMsg(data.message || "Pull started");
    } catch (e: any) {
      setPullMsg(`Error: ${e.message}`);
    } finally {
      setPulling(false);
    }
  };

  const breadcrumbs = () => {
    const parts = prefix().split("/").filter(Boolean);
    return parts.map((_, i) => ({
      label: parts[i],
      prefix: parts.slice(0, i + 1).join("/") + "/",
    }));
  };

  return (
    <div class="flex flex-col gap-4 h-full">
      {/* Top folder selector */}
      <div class="flex gap-2 flex-wrap">
        {[{ label: "Projects", prefix: "projects/" }, { label: "Repos", prefix: "repos/" }].map((f) => (
          <button
            class="btn btn-sm"
            classList={{
              "btn-primary": prefix().startsWith(f.prefix),
              "btn-ghost": !prefix().startsWith(f.prefix),
            }}
            onClick={() => navigate(f.prefix)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Breadcrumb */}
      <div class="breadcrumbs text-sm bg-base-100 rounded-box px-4 py-2">
        <ul>
          <li>
            <button class="link" onClick={() => navigate("projects/")}>
              Projects
            </button>
          </li>
          <For each={breadcrumbs()}>
            {(crumb) => (
              <li>
                <button class="link" onClick={() => navigate(crumb.prefix)}>
                  {crumb.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>

      <Show when={error()}>
        <div class="alert alert-error">
          <span>{error()}</span>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="flex items-center gap-2 text-sm text-base-content/60">
          <span class="loading loading-spinner loading-sm" />
          Loading…
        </div>
      </Show>

      {/* File listing + content viewer side by side */}
      <div class="flex gap-4 flex-1 min-h-0">
        {/* Left: file listing */}
        <div class="w-72 shrink-0 flex flex-col gap-1 overflow-y-auto">
          <Show when={folders().length === 0 && files().length === 0 && !loading()}>
            <div class="text-sm text-base-content/50 p-2">
              Select a folder above to browse files.
            </div>
          </Show>

          <For each={folders()}>
            {(folder) => (
              <button
                class="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors"
                onClick={() => navigate(folder.prefix)}
              >
                <span>📁</span>
                <span class="truncate">{folder.name}</span>
              </button>
            )}
          </For>

          <For each={files()}>
            {(file) => (
              <button
                class="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-base-200 text-sm text-left transition-colors"
                classList={{
                  "bg-primary text-primary-content hover:bg-primary":
                    selectedKey() === file.key,
                }}
                onClick={() => openFile(file.key)}
              >
                <span>📄</span>
                <span class="flex-1 truncate">{file.name}</span>
                <span class="text-xs opacity-60 shrink-0">{formatSize(file.size)}</span>
              </button>
            )}
          </For>
        </div>

        {/* Right: file content viewer */}
        <div class="flex-1 flex flex-col gap-3 min-w-0">
          <Show when={!selectedKey()}>
            <div class="flex items-center justify-center h-full text-base-content/30 text-sm">
              Select a file to preview
            </div>
          </Show>

          <Show when={selectedKey()}>
            {/* File header */}
            <div class="flex items-center justify-between gap-3 bg-base-100 rounded-box px-4 py-2">
              <span class="text-sm font-mono truncate text-base-content/70">
                {selectedKey()}
              </span>
              <Show when={props.sessionId}>
                <button
                  class="btn btn-sm btn-outline btn-primary shrink-0"
                  onClick={pullToWorkspace}
                  disabled={pulling()}
                >
                  {pulling() ? (
                    <span class="loading loading-spinner loading-xs" />
                  ) : (
                    "⬇ Pull to Workspace"
                  )}
                </button>
              </Show>
            </div>

            <Show when={pullMsg()}>
              <div
                class="alert alert-sm py-2 text-sm"
                classList={{
                  "alert-error": pullMsg().startsWith("Error"),
                  "alert-success": !pullMsg().startsWith("Error"),
                }}
              >
                {pullMsg()}
              </div>
            </Show>

            <Show when={fileLoading()}>
              <div class="flex items-center gap-2 text-sm text-base-content/60 p-4">
                <span class="loading loading-spinner loading-sm" />
                Loading file…
              </div>
            </Show>

            <Show when={fileError()}>
              <div class="alert alert-error text-sm">{fileError()}</div>
            </Show>

            <Show when={fileContent() && !fileLoading()}>
              <div
                class="flex-1 overflow-auto bg-base-100 rounded-box p-4 prose prose-sm max-w-none"
                innerHTML={renderContent(selectedKey()!, fileContent())}
              />
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
