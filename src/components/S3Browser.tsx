import { createSignal, For, Show } from "solid-js";
import { config } from "../stores/config";
import { useAuth } from "./AuthProvider";

interface S3File {
  key: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

interface S3BrowserProps {
  onSelectFile?: (file: S3File, content?: string) => void;
}

export default function S3Browser(props: S3BrowserProps) {
  const auth = useAuth();
  const apiEndpoint = config().apiEndpoint;

  const [files, setFiles] = createSignal<S3File[]>([]);
  const [prefix, setPrefix] = createSignal("projects/default/");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [selectedFile, setSelectedFile] = createSignal<S3File | null>(null);
  const [fileContent, setFileContent] = createSignal("");
  const [loadingContent, setLoadingContent] = createSignal(false);

  const listFiles = async () => {
    if (!apiEndpoint || !auth.idToken) {
      setError("Not configured or not authenticated");
      return;
    }

    setLoading(true);
    setError("");
    setFiles([]);

    try {
      const url = new URL(`${apiEndpoint}/s3/list`);
      url.searchParams.set("prefix", prefix());
      url.searchParams.set("maxKeys", "100");

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${auth.idToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to list files: ${response.statusText}`
        );
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || "Failed to list files");
      }

      const items: S3File[] = (data.items || []).map((item: any) => ({
        key: item.key,
        size: item.size || 0,
        lastModified: item.lastModified || "",
        isDirectory: item.isDirectory || item.key.endsWith("/"),
      }));

      setFiles(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const readFile = async (file: S3File) => {
    if (!apiEndpoint || !auth.idToken) {
      setError("Not configured or not authenticated");
      return;
    }

    setLoadingContent(true);
    setError("");

    try {
      const url = new URL(`${apiEndpoint}/s3/read`);
      url.searchParams.set("key", file.key);

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${auth.idToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to read file: ${response.statusText}`
        );
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || "Failed to read file");
      }

      const content = data.content || "";
      setFileContent(content);
      setSelectedFile(file);
      props.onSelectFile?.(file, content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingContent(false);
    }
  };

  return (
    <div class="space-y-4">
      <div class="card bg-base-200 shadow">
        <div class="card-body space-y-3">
          <h3 class="card-title text-sm">S3 File Browser</h3>

          <div class="breadcrumbs text-sm">
            <ul>
              <li>
                <a
                  class="link"
                  onClick={() => setPrefix("projects/default/")}
                  classList={{
                    "pointer-events-none": prefix() === "projects/default/",
                  }}
                >
                  Root
                </a>
              </li>
              <For each={prefix().split("/").filter(Boolean)}>
                {(part, idx) => (
                  <li>
                    <a
                      class="link"
                      onClick={() => {
                        const newPrefix = prefix()
                          .split("/")
                          .slice(0, idx() + 1)
                          .join("/") + "/";
                        setPrefix(newPrefix);
                      }}
                    >
                      {part}
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </div>

          <div class="flex gap-2">
            <input
              type="text"
              placeholder="Folder prefix..."
              class="input input-sm flex-1"
              value={prefix()}
              onInput={(e) => setPrefix(e.currentTarget.value)}
            />
            <button
              class="btn btn-sm btn-primary"
              onClick={listFiles}
              disabled={loading()}
            >
              {loading() ? (
                <span class="loading loading-spinner loading-sm"></span>
              ) : (
                "Browse"
              )}
            </button>
          </div>

          <Show when={error()}>
            <div class="alert alert-error alert-sm">
              <span>{error()}</span>
            </div>
          </Show>

          <Show when={files().length > 0}>
            <div class="space-y-2 max-h-64 overflow-y-auto border rounded p-2">
              <For each={files()}>
                {(file) => (
                  <button
                    class="w-full text-left p-2 rounded hover:bg-base-300 transition text-sm flex justify-between items-center"
                    classList={{
                      "bg-primary text-primary-content":
                        selectedFile()?.key === file.key,
                    }}
                    onClick={() => {
                      if (file.isDirectory) {
                        setPrefix(file.key);
                        listFiles();
                      } else {
                        readFile(file);
                      }
                    }}
                  >
                    <span class="flex-1 truncate">
                      {file.isDirectory ? "📁 " : "📄 "}
                      {file.key.split("/").filter(Boolean).pop()}
                    </span>
                    <span class="text-xs opacity-70">
                      {file.isDirectory
                        ? "-"
                        : `${(file.size / 1024).toFixed(1)}KB`}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={selectedFile() && fileContent()}>
            <div class="space-y-2">
              <div class="text-sm font-bold">
                Selected: {selectedFile()?.key}
              </div>
              <Show when={loadingContent()}>
                <div class="flex items-center gap-2 text-sm">
                  <span class="loading loading-spinner loading-sm"></span>
                  Loading content...
                </div>
              </Show>
              <Show when={!loadingContent() && fileContent()}>
                <textarea
                  class="textarea textarea-sm textarea-bordered w-full h-32 text-xs font-mono"
                  value={fileContent()}
                  readOnly
                  placeholder="File content will appear here"
                />
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
