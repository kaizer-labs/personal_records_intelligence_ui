import { startTransition, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

type HealthPayload = {
  status: string;
  service: string;
  version: string;
  environment: string;
  database: {
    status: string;
    engine: string;
    version: string;
    path: string;
    table_count: number;
  };
  ollama: {
    base_url: string;
    chat_model: string;
    embedding_model: string;
    chat_num_ctx: number;
  };
};

type DocumentSummary = {
  id: string;
  filename: string;
  relative_path: string;
  media_type: string;
  char_count: number;
  chunk_count: number;
  updated_at: string;
};

type FolderSummary = {
  name: string;
  origin: "api_examples" | "browser_upload";
  document_count: number;
  chunk_count: number;
  updated_at: string;
  documents: DocumentSummary[];
};

type FolderListPayload = {
  folders: FolderSummary[];
};

type SyncResponse = {
  folders: FolderSummary[];
  processed_files: {
    folder_name: string;
    relative_path: string;
    filename: string;
    status: "ingested" | "skipped";
    char_count: number;
    chunk_count: number;
    reason: string | null;
  }[];
};

type ChatSource = {
  document_id: string;
  folder_name: string;
  document_name: string;
  relative_path: string;
  excerpt: string;
  score: number;
};

type ChatResponse = {
  answer: string;
  model: string;
  selected_folders: string[];
  sources: ChatSource[];
};

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  meta?: string;
  sources?: ChatSource[];
};

type BrowserFile = File & {
  webkitRelativePath?: string;
};

function App() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content:
        "Pick a folder or load the example document, then ask a question. I’ll answer from the indexed text and show the source snippets I used.",
      meta: "Ready when your document library is ready.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string>("Fetching workspace status...");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [asking, setAsking] = useState(false);

  const lastAssistantSources =
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.sources?.length)?.sources ?? [];

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    const loadWorkspace = async () => {
      try {
        const [healthResponse, foldersResponse] = await Promise.all([
          fetch("/health_check"),
          fetch("/api/library/folders"),
        ]);

        if (!healthResponse.ok) {
          throw new Error(`Health check failed with status ${healthResponse.status}`);
        }

        if (!foldersResponse.ok) {
          throw new Error(`Folder list failed with status ${foldersResponse.status}`);
        }

        const healthPayload = (await healthResponse.json()) as HealthPayload;
        const foldersPayload = (await foldersResponse.json()) as FolderListPayload;

        startTransition(() => {
          setHealth(healthPayload);
          setFolders(foldersPayload.folders);
          setSelectedFolders((current) =>
            current.length > 0
              ? current.filter((name) =>
                  foldersPayload.folders.some((folder) => folder.name === name),
                )
              : foldersPayload.folders.map((folder) => folder.name),
          );
        });

        if (foldersPayload.folders.length > 0) {
          setActivity(`Loaded ${foldersPayload.folders.length} indexed folder${foldersPayload.folders.length === 1 ? "" : "s"}.`);
        } else {
          setActivity("No indexed folders yet. Load the example file or sync a folder from your machine.");
        }
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to reach the backend.";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void loadWorkspace();
  }, []);

  const applyFolderState = (payload: SyncResponse | FolderListPayload) => {
    startTransition(() => {
      setFolders(payload.folders);
      setSelectedFolders((current) => {
        if (current.length === 0) {
          return payload.folders.map((folder) => folder.name);
        }

        const nextSelection = current.filter((name) =>
          payload.folders.some((folder) => folder.name === name),
        );

        return nextSelection.length > 0
          ? nextSelection
          : payload.folders.map((folder) => folder.name);
      });
    });
  };

  const handleExampleSync = async () => {
    setSyncing(true);
    setError(null);
    setActivity("Indexing the example document...");

    try {
      const response = await fetch("/api/library/examples/sync", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Example sync failed with status ${response.status}`);
      }

      const payload = (await response.json()) as SyncResponse;
      applyFolderState(payload);

      const ingestedCount = payload.processed_files.filter(
        (file) => file.status === "ingested",
      ).length;
      setActivity(
        ingestedCount > 0
          ? `Indexed ${ingestedCount} example file${ingestedCount === 1 ? "" : "s"}.`
          : "No example files were indexed.",
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to sync the example document.";
      setError(message);
      setActivity("Example sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const handleFolderUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []) as BrowserFile[];
    if (files.length === 0) {
      return;
    }

    setSyncing(true);
    setError(null);
    setActivity(`Uploading ${files.length} file${files.length === 1 ? "" : "s"} for indexing...`);

    const formData = new FormData();
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      formData.append("files", file, relativePath);
    }

    try {
      const response = await fetch("/api/library/folders/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Folder upload failed with status ${response.status}`);
      }

      const payload = (await response.json()) as SyncResponse;
      applyFolderState(payload);

      const ingestedCount = payload.processed_files.filter(
        (file) => file.status === "ingested",
      ).length;
      const skippedCount = payload.processed_files.length - ingestedCount;
      setActivity(
        `Indexed ${ingestedCount} file${ingestedCount === 1 ? "" : "s"}${skippedCount > 0 ? ` and skipped ${skippedCount}.` : "."}`,
      );
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to sync the selected folder.";
      setError(message);
      setActivity("Folder sync failed.");
    } finally {
      setSyncing(false);
      event.target.value = "";
    }
  };

  const handleToggleFolder = (folderName: string) => {
    setSelectedFolders((current) =>
      current.includes(folderName)
        ? current.filter((name) => name !== folderName)
        : [...current, folderName],
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const question = draft.trim();
    if (!question || asking) {
      return;
    }

    const effectiveFolders =
      selectedFolders.length > 0
        ? selectedFolders
        : folders.map((folder) => folder.name);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      meta:
        effectiveFolders.length > 0
          ? `Searching ${effectiveFolders.length} folder${effectiveFolders.length === 1 ? "" : "s"}`
          : "Searching all indexed folders",
    };

    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setAsking(true);
    setError(null);
    setActivity("Thinking over the selected documents...");

    try {
      const response = await fetch("/api/chat/answers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question,
          folder_names: effectiveFolders,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { detail?: string }
          | null;
        throw new Error(payload?.detail ?? `Chat request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as ChatResponse;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: payload.answer,
          meta: `${payload.model} • ${payload.sources.length} source${payload.sources.length === 1 ? "" : "s"}`,
          sources: payload.sources,
        },
      ]);
      setActivity("Answer ready.");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to generate an answer.";
      setError(message);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            "I couldn't finish that answer. Check that Ollama is running and that the selected folders contain machine-readable text.",
          meta: "Request failed",
        },
      ]);
      setActivity("Answer failed.");
    } finally {
      setAsking(false);
    }
  };

  return (
    <main className="app-shell">
      <input
        ref={folderInputRef}
        hidden
        type="file"
        multiple
        onChange={handleFolderUpload}
      />

      <aside className="sidebar-shell">
        <section className="brand-card">
          <p className="eyebrow">Personal Records Intelligence</p>
          <h1>Chat with the folders you trust</h1>
          <p className="lede">
            Index selected folders from your machine, ask pointed questions, and
            keep the source snippets close to the answer.
          </p>

          <div className="action-row">
            <button
              className="primary-button"
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={syncing}
            >
              {syncing ? "Syncing..." : "Sync a Folder"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={handleExampleSync}
              disabled={syncing}
            >
              Load Local Examples
            </button>
          </div>

          <div className="activity-card">
            <span className="label">Workspace activity</span>
            <strong>{activity}</strong>
            {error && <p className="inline-error">{error}</p>}
          </div>
        </section>

        <section className="panel-card folders-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Indexed folders</p>
              <h2>Search scope</h2>
            </div>
            <span className="count-pill">
              {folders.length} folder{folders.length === 1 ? "" : "s"}
            </span>
          </div>

          {loading && <p className="status-copy">Loading workspace...</p>}

          {!loading && folders.length === 0 && (
            <p className="status-copy">
              No folders are indexed yet. Start with the example PDF or upload a
              folder from your Mac.
            </p>
          )}

          <div className="folder-list">
            {folders.map((folder) => {
              const checked = selectedFolders.includes(folder.name);
              return (
                <label className="folder-card" key={folder.name}>
                  <div className="folder-card-top">
                    <input
                      checked={checked}
                      type="checkbox"
                      onChange={() => handleToggleFolder(folder.name)}
                    />
                    <div>
                      <strong>{folder.name}</strong>
                      <p>
                        {folder.document_count} doc
                        {folder.document_count === 1 ? "" : "s"} •{" "}
                        {folder.chunk_count} chunks
                      </p>
                    </div>
                    <span className="origin-tag">
                      {folder.origin === "api_examples" ? "example" : "local"}
                    </span>
                  </div>

                  <ul className="document-list">
                    {folder.documents.slice(0, 3).map((document) => (
                      <li key={document.id}>
                        <span>{document.filename}</span>
                        <small>{document.relative_path}</small>
                      </li>
                    ))}
                  </ul>
                </label>
              );
            })}
          </div>
        </section>

        <section className="panel-card stack-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>Local stack</h2>
            </div>
          </div>

          {health && (
            <div className="stat-grid">
              <div className="stat-card">
                <span className="label">API</span>
                <strong>{health.status}</strong>
                <small>{health.service}</small>
              </div>
              <div className="stat-card">
                <span className="label">DuckDB</span>
                <strong>{health.database.engine}</strong>
                <small>{health.database.version}</small>
              </div>
              <div className="stat-card">
                <span className="label">Chat model</span>
                <strong>{health.ollama.chat_model}</strong>
                <small>{health.ollama.chat_num_ctx} ctx</small>
              </div>
              <div className="stat-card">
                <span className="label">Embeddings</span>
                <strong>{health.ollama.embedding_model}</strong>
                <small>configured</small>
              </div>
            </div>
          )}
        </section>
      </aside>

      <section className="workspace-shell">
        <section className="hero-strip">
          <div>
            <p className="eyebrow">Document copilot</p>
            <h2>Ask focused questions across selected folders</h2>
          </div>
          <div className="hero-metrics">
            <div>
              <span className="label">Selected folders</span>
              <strong>
                {selectedFolders.length > 0 ? selectedFolders.length : folders.length}
              </strong>
            </div>
            <div>
              <span className="label">Messages</span>
              <strong>{messages.length}</strong>
            </div>
          </div>
        </section>

        <div className="workspace-grid">
          <section className="chat-card">
            <div className="chat-header">
              <div>
                <p className="eyebrow">Conversation</p>
                <h2>Chat window</h2>
              </div>
              <span className="count-pill">
                {asking ? "Thinking..." : "Ready"}
              </span>
            </div>

            <div className="messages">
              {messages.map((message) => (
                <article
                  className={`message-bubble ${message.role}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <span>{message.role === "assistant" ? "Assistant" : "You"}</span>
                    {message.meta && <small>{message.meta}</small>}
                  </div>
                  <p>{message.content}</p>
                </article>
              ))}
            </div>

            <form className="composer" onSubmit={handleSubmit}>
              <label className="composer-label" htmlFor="question">
                Ask about the selected folders
              </label>
              <textarea
                id="question"
                placeholder="Try: What does the cover letter emphasize about my product and AI experience?"
                rows={4}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="composer-footer">
                <p>
                  {selectedFolders.length > 0
                    ? `Searching ${selectedFolders.join(", ")}`
                    : "Searching all indexed folders"}
                </p>
                <button
                  className="primary-button"
                  disabled={asking || folders.length === 0}
                  type="submit"
                >
                  {asking ? "Thinking..." : "Send"}
                </button>
              </div>
            </form>
          </section>

          <aside className="panel-card source-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Evidence</p>
                <h2>Latest sources</h2>
              </div>
              <span className="count-pill">
                {lastAssistantSources.length} source
                {lastAssistantSources.length === 1 ? "" : "s"}
              </span>
            </div>

            {lastAssistantSources.length === 0 && (
              <p className="status-copy">
                Source snippets will appear here after the first successful
                answer.
              </p>
            )}

            <div className="source-list">
              {lastAssistantSources.map((source, index) => (
                <article className="source-card" key={`${source.document_id}-${index}`}>
                  <div className="source-top">
                    <strong>{source.document_name}</strong>
                    <span>{source.score.toFixed(2)}</span>
                  </div>
                  <p className="source-path">
                    {source.folder_name} / {source.relative_path}
                  </p>
                  <p className="source-excerpt">{source.excerpt}</p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

export default App;
