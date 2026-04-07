import { startTransition, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactNode } from "react";

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
  conversation_id: string;
  conversation_title: string;
  answer: string;
  model: string;
  selected_folders: string[];
  sources: ChatSource[];
};

type ChatStreamStartEvent = {
  type: "start";
  conversation_id: string;
  conversation_title: string;
  model: string;
  selected_folders: string[];
  sources: ChatSource[];
};

type ChatStreamDeltaEvent = {
  type: "delta";
  delta: string;
};

type ChatStreamFinalEvent = ChatResponse & {
  type: "final";
};

type ChatStreamErrorEvent = {
  type: "error";
  detail: string;
};

type ChatStreamEvent =
  | ChatStreamStartEvent
  | ChatStreamDeltaEvent
  | ChatStreamFinalEvent
  | ChatStreamErrorEvent;

type ChatHistoryMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  meta?: string | null;
  sources: ChatSource[];
  created_at: string;
};

type ConversationSummary = {
  id: string;
  title: string;
  folder_names: string[];
  preview?: string | null;
  message_count: number;
  updated_at: string;
};

type ConversationListPayload = {
  conversations: ConversationSummary[];
};

type ConversationDetailPayload = {
  conversation: ConversationSummary;
  messages: ChatHistoryMessage[];
};

type Message = {
  id: string;
  role: "assistant" | "user";
  content: string;
  meta?: string;
  sources?: ChatSource[];
  streaming?: boolean;
};

type BrowserFile = File & {
  webkitRelativePath?: string;
};

type SidebarView = "library" | "conversations";

const EVIDENCE_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "also",
  "and",
  "are",
  "based",
  "been",
  "being",
  "between",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "show",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

function createIntroMessage(): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content:
      "Pick a folder or load the example document, then ask a question. I’ll answer from the indexed text and show the source snippets I used.",
    meta: "Ready when your document library is ready.",
  };
}

function toUiMessage(message: ChatHistoryMessage): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    meta: message.meta ?? undefined,
    sources: message.sources,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEvidenceTerms(question: string): string[] {
  const rawTerms = question.toLowerCase().match(/[a-z0-9][a-z0-9/-]*/g) ?? [];
  return Array.from(
    new Set(
      rawTerms.filter(
        (term) => term.length >= 3 && !EVIDENCE_STOP_WORDS.has(term),
      ),
    ),
  ).slice(0, 6);
}

function highlightEvidenceText(
  text: string,
  terms: string[],
  keyPrefix: string,
): ReactNode[] {
  if (!text || terms.length === 0) {
    return [text];
  }

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part, index) =>
      terms.some((term) => part.toLowerCase() === term.toLowerCase()) ? (
        <mark className="source-highlight" key={`${keyPrefix}-mark-${index}`}>
          {part}
        </mark>
      ) : (
        <span key={`${keyPrefix}-text-${index}`}>{part}</span>
      ),
    );
}

function getSourceMatchedTerms(source: ChatSource, terms: string[]): string[] {
  const haystack = [
    source.document_name,
    source.relative_path,
    source.folder_name,
    source.excerpt,
  ]
    .join(" ")
    .toLowerCase();

  return terms.filter((term) => haystack.includes(term.toLowerCase())).slice(0, 3);
}

function getSourceTypeLabel(documentName: string): string {
  const extension = documentName.split(".").pop()?.trim().toUpperCase();
  return extension || "FILE";
}

function buildFollowUpPrompts(question: string): string[] {
  const normalized = question.toLowerCase();

  if (
    normalized.includes("date") ||
    normalized.includes("deadline") ||
    normalized.includes("commitment") ||
    normalized.includes("obligation")
  ) {
    return [
      "Which of these items needs my attention first, and why?",
      "Turn this into a simple checklist I can act on.",
      "Which deadlines are coming up soonest?",
    ];
  }

  if (
    normalized.includes("amount") ||
    normalized.includes("cost") ||
    normalized.includes("payment") ||
    normalized.includes("price")
  ) {
    return [
      "Which of these amounts is still outstanding or due next?",
      "What could cost me money if I miss it?",
      "Group these amounts by category and timing.",
    ];
  }

  if (
    normalized.includes("summary") ||
    normalized.includes("pay attention") ||
    normalized.includes("need to know")
  ) {
    return [
      "What should I do next based on these documents?",
      "Which parts of this answer are the most important?",
      "Turn this into a short action plan.",
    ];
  }

  return [
    "What should I do next based on these documents?",
    "Which sources matter most here, and why?",
    "Turn this into a short checklist for me.",
  ];
}

type SourceDocumentGroup = {
  document_id: string;
  document_name: string;
  folder_name: string;
  relative_path: string;
  excerpt_count: number;
  best_score: number;
};

function groupSourcesByDocument(sources: ChatSource[]): SourceDocumentGroup[] {
  const grouped = new Map<string, SourceDocumentGroup>();

  for (const source of sources) {
    const current = grouped.get(source.document_id);
    if (!current) {
      grouped.set(source.document_id, {
        document_id: source.document_id,
        document_name: source.document_name,
        folder_name: source.folder_name,
        relative_path: source.relative_path,
        excerpt_count: 1,
        best_score: source.score,
      });
      continue;
    }

    current.excerpt_count += 1;
    current.best_score = Math.max(current.best_score, source.score);
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (right.best_score !== left.best_score) {
      return right.best_score - left.best_score;
    }

    return left.document_name.localeCompare(right.document_name);
  });
}

function summarizeEvidenceCoverage(sources: ChatSource[]): string {
  const uniqueDocuments = new Set(sources.map((source) => source.document_id)).size;
  const uniqueFolders = new Set(sources.map((source) => source.folder_name)).size;
  const excerptCount = sources.length;

  return `${excerptCount} excerpt${excerptCount === 1 ? "" : "s"} from ${uniqueDocuments} document${uniqueDocuments === 1 ? "" : "s"} across ${uniqueFolders} folder${uniqueFolders === 1 ? "" : "s"}`;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) {
        return <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>;
      }

      return part;
    });
}

function renderMarkdown(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraphLines: string[] = [];
  let unorderedItems: string[] = [];
  let orderedItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const content = paragraphLines.join(" ");
    blocks.push(
      <p key={`paragraph-${blocks.length}`}>
        {renderInlineMarkdown(content, `paragraph-${blocks.length}`)}
      </p>,
    );
    paragraphLines = [];
  };

  const flushUnorderedList = () => {
    if (unorderedItems.length === 0) {
      return;
    }

    blocks.push(
      <ul key={`unordered-${blocks.length}`} className="markdown-list">
        {unorderedItems.map((item, index) => (
          <li key={`unordered-item-${index}`}>
            {renderInlineMarkdown(item, `unordered-${blocks.length}-${index}`)}
          </li>
        ))}
      </ul>,
    );
    unorderedItems = [];
  };

  const flushOrderedList = () => {
    if (orderedItems.length === 0) {
      return;
    }

    blocks.push(
      <ol key={`ordered-${blocks.length}`} className="markdown-list markdown-list-ordered">
        {orderedItems.map((item, index) => (
          <li key={`ordered-item-${index}`}>
            {renderInlineMarkdown(item, `ordered-${blocks.length}-${index}`)}
          </li>
        ))}
      </ol>,
    );
    orderedItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushUnorderedList();
      flushOrderedList();

      const level = Math.min(headingMatch[1].length, 3);
      const content = headingMatch[2];
      const headingChildren = renderInlineMarkdown(content, `heading-${blocks.length}`);

      if (level === 1) {
        blocks.push(
          <h3 key={`heading-${blocks.length}`} className="markdown-heading markdown-heading-primary">
            {headingChildren}
          </h3>,
        );
      } else if (level === 2) {
        blocks.push(
          <h4 key={`heading-${blocks.length}`} className="markdown-heading markdown-heading-secondary">
            {headingChildren}
          </h4>,
        );
      } else {
        blocks.push(
          <h5 key={`heading-${blocks.length}`} className="markdown-heading markdown-heading-tertiary">
            {headingChildren}
          </h5>,
        );
      }
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushOrderedList();
      unorderedItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushUnorderedList();
      orderedItems.push(orderedMatch[1]);
      continue;
    }

    flushUnorderedList();
    flushOrderedList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushUnorderedList();
  flushOrderedList();

  return blocks.length > 0
    ? blocks
    : [
        <p key="paragraph-0">
          {renderInlineMarkdown(text, "paragraph-0")}
        </p>,
      ];
}

function App() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const demoRequestedRef = useRef(false);
  const demoPlaybackRef = useRef(false);
  const demoTimerRef = useRef<number | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [currentConversationTitle, setCurrentConversationTitle] = useState("New briefing");
  const [sidebarView, setSidebarView] = useState<SidebarView>("library");
  const [showEvidenceInspector, setShowEvidenceInspector] = useState(false);
  const [showRuntimeInspector, setShowRuntimeInspector] = useState(false);
  const [inspectedSources, setInspectedSources] = useState<ChatSource[]>([]);
  const [inspectedQuestion, setInspectedQuestion] = useState("");
  const [focusedSourceDocumentId, setFocusedSourceDocumentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([createIntroMessage()]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string>("Fetching workspace status...");
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [mutatingTarget, setMutatingTarget] = useState<string | null>(null);
  const isDemoMode =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("demo") === "1";
  const demoFolderName = "Examples";
  const demoQuestion = "What are the main steps to build a Claude Code skill?";
  const totalDocuments = folders.reduce(
    (sum, folder) => sum + folder.document_count,
    0,
  );
  const totalChunks = folders.reduce((sum, folder) => sum + folder.chunk_count, 0);
  const activeFolderNames =
    selectedFolders.length > 0
      ? selectedFolders
      : folders.map((folder) => folder.name);
  const activeFolderPreview = activeFolderNames.slice(0, 3).join(" • ");
  const activeFolderOverflow = Math.max(activeFolderNames.length - 3, 0);
  const isPristineConversation =
    currentConversationId === null &&
    messages.length === 1 &&
    messages[0]?.role === "assistant" &&
    !messages[0]?.sources?.length;
  const lastAssistantSources =
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.sources?.length)?.sources ?? [];
  const latestQuestion =
    [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const activeEvidenceSources =
    inspectedSources.length > 0 ? inspectedSources : lastAssistantSources;
  const activeEvidenceQuestion = inspectedQuestion || latestQuestion;
  const activeEvidenceDocumentGroups = groupSourcesByDocument(activeEvidenceSources);
  const activeEvidenceTerms = extractEvidenceTerms(activeEvidenceQuestion);
  const focusedEvidenceDocument =
    focusedSourceDocumentId !== null
      ? activeEvidenceDocumentGroups.find(
          (group) => group.document_id === focusedSourceDocumentId,
        ) ?? null
      : null;
  const orderedActiveEvidenceSources =
    focusedSourceDocumentId === null
      ? activeEvidenceSources
      : [
          ...activeEvidenceSources.filter(
            (source) => source.document_id === focusedSourceDocumentId,
          ),
          ...activeEvidenceSources.filter(
            (source) => source.document_id !== focusedSourceDocumentId,
          ),
        ];
  const hasVisibleEvidence = showEvidenceInspector && activeEvidenceSources.length > 0;
  const latestAssistantMessageId =
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.sources?.length)?.id ?? null;
  const workspaceStateLabel = syncing ? "Indexing" : asking ? "Thinking" : "Ready";

  const loadConversations = async () => {
    const response = await fetch("/api/chat/conversations");
    if (!response.ok) {
      throw new Error(`Conversation list failed with status ${response.status}`);
    }

    const payload = (await response.json()) as ConversationListPayload;
    startTransition(() => {
      setConversations(payload.conversations);
    });
    setHistoryLoading(false);

    return payload.conversations;
  };

  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, asking]);

  useEffect(() => {
    const textarea = composerInputRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, 220);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (lastAssistantSources.length > 0) {
      setInspectedSources(lastAssistantSources);
      setInspectedQuestion(latestQuestion);
      setFocusedSourceDocumentId(null);
    }
  }, [lastAssistantSources, latestQuestion]);

  useEffect(() => {
    const loadWorkspace = async () => {
      try {
        const [healthResponse, foldersResponse, conversationsResponse] = await Promise.all([
          fetch("/health_check"),
          fetch("/api/library/folders"),
          fetch("/api/chat/conversations"),
        ]);

        if (!healthResponse.ok) {
          throw new Error(`Health check failed with status ${healthResponse.status}`);
        }

        if (!foldersResponse.ok) {
          throw new Error(`Folder list failed with status ${foldersResponse.status}`);
        }

        if (!conversationsResponse.ok) {
          throw new Error(`Conversation list failed with status ${conversationsResponse.status}`);
        }

        const healthPayload = (await healthResponse.json()) as HealthPayload;
        const foldersPayload = (await foldersResponse.json()) as FolderListPayload;
        const conversationsPayload = (await conversationsResponse.json()) as ConversationListPayload;

        startTransition(() => {
          setHealth(healthPayload);
          setFolders(foldersPayload.folders);
          setConversations(conversationsPayload.conversations);
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
        setHistoryLoading(false);
      }
    };

    void loadWorkspace();
  }, []);

  useEffect(() => {
    return () => {
      if (demoTimerRef.current !== null) {
        window.clearTimeout(demoTimerRef.current);
      }
    };
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

  const handleDeleteDocument = async (
    documentId: string,
    documentName: string,
  ) => {
    const shouldDelete = window.confirm(
      `Remove "${documentName}" from the indexed library? This only removes the indexed copy and chat data, not the original file on your Mac.`,
    );
    if (!shouldDelete) {
      return;
    }

    setMutatingTarget(`document:${documentId}`);
    setError(null);
    setActivity(`Removing ${documentName} from the indexed library...`);

    try {
      const response = await fetch(`/api/library/documents/${documentId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`Document delete failed with status ${response.status}`);
      }

      const payload = (await response.json()) as FolderListPayload;
      applyFolderState(payload);
      setActivity(`Removed ${documentName} from the indexed library.`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to remove the document.";
      setError(message);
      setActivity("Document removal failed.");
    } finally {
      setMutatingTarget(null);
    }
  };

  const handleClearFolder = async (folderName: string) => {
    const shouldClear = window.confirm(
      `Clear "${folderName}" from the indexed library? This removes all indexed copies and chunks for that folder but does not delete the source folder on your Mac.`,
    );
    if (!shouldClear) {
      return;
    }

    setMutatingTarget(`folder:${folderName}`);
    setError(null);
    setActivity(`Clearing ${folderName} from the indexed library...`);

    try {
      const response = await fetch(
        `/api/library/folders/${encodeURIComponent(folderName)}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error(`Folder clear failed with status ${response.status}`);
      }

      const payload = (await response.json()) as FolderListPayload;
      applyFolderState(payload);
      setActivity(`Cleared ${folderName} from the indexed library.`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to clear the folder.";
      setError(message);
      setActivity("Folder clear failed.");
    } finally {
      setMutatingTarget(null);
    }
  };

  const handleOpenSource = (documentId: string) => {
    window.open(`/api/library/documents/${documentId}/file`, "_blank", "noopener,noreferrer");
  };

  const handleInspectSources = (
    sources: ChatSource[],
    question: string,
    documentId?: string,
  ) => {
    setInspectedSources(sources);
    setInspectedQuestion(question);
    setFocusedSourceDocumentId(documentId ?? null);
    setShowEvidenceInspector(true);
  };

  const handleSuggestedPrompt = (prompt: string) => {
    setDraft(prompt);
    composerInputRef.current?.focus();
  };

  const getQuestionForAssistantIndex = (messageIndex: number) => {
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        return messages[index]?.content ?? "";
      }
    }

    return "";
  };

  const handleNewConversation = () => {
    setCurrentConversationId(null);
    setCurrentConversationTitle("New briefing");
    setMessages([createIntroMessage()]);
    setInspectedSources([]);
    setInspectedQuestion("");
    setFocusedSourceDocumentId(null);
    setShowEvidenceInspector(false);
    setDraft("");
    setError(null);
    setActivity("Started a fresh conversation.");
  };

  const handleLoadConversation = async (conversationId: string) => {
    setError(null);
    setActivity("Loading conversation history...");

    try {
      const response = await fetch(`/api/chat/conversations/${conversationId}`);
      if (!response.ok) {
        throw new Error(`Conversation load failed with status ${response.status}`);
      }

      const payload = (await response.json()) as ConversationDetailPayload;
      startTransition(() => {
        setCurrentConversationId(payload.conversation.id);
        setCurrentConversationTitle(payload.conversation.title);
        setMessages(
          payload.messages.length > 0
            ? payload.messages.map(toUiMessage)
            : [createIntroMessage()],
        );
        if (payload.conversation.folder_names.length > 0) {
          const validFolders = payload.conversation.folder_names.filter((folderName) =>
            folders.some((folder) => folder.name === folderName),
          );
          if (validFolders.length > 0) {
            setSelectedFolders(validFolders);
          }
        }
      });
      setFocusedSourceDocumentId(null);
      setShowEvidenceInspector(false);
      setActivity(`Loaded "${payload.conversation.title}".`);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to load that conversation.";
      setError(message);
      setActivity("Conversation load failed.");
    }
  };

  const handleDeleteConversation = async (
    conversationId: string,
    title: string,
  ) => {
    const shouldDelete = window.confirm(
      `Delete "${title}" from chat history? This only removes the saved conversation, not your indexed documents.`,
    );
    if (!shouldDelete) {
      return;
    }

    setMutatingTarget(`conversation:${conversationId}`);
    setError(null);

    try {
      const response = await fetch(`/api/chat/conversations/${conversationId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`Conversation delete failed with status ${response.status}`);
      }

      const payload = (await response.json()) as ConversationListPayload;
      startTransition(() => {
        setConversations(payload.conversations);
      });
      if (currentConversationId === conversationId) {
        handleNewConversation();
      } else {
        setActivity(`Removed "${title}" from chat history.`);
      }
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to delete that conversation.";
      setError(message);
      setActivity("Conversation delete failed.");
    } finally {
      setMutatingTarget(null);
    }
  };

  const submitQuestion = async (
    question: string,
    effectiveFolders: string[],
  ) => {
    const assistantMessageId = crypto.randomUUID();
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      meta:
        effectiveFolders.length > 0
          ? `Searching ${effectiveFolders.length} folder${effectiveFolders.length === 1 ? "" : "s"}`
          : "Searching all indexed folders",
    };
    const assistantPlaceholder: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      meta: "Reviewing the selected documents",
      sources: [],
      streaming: true,
    };

    setMessages((current) =>
      isPristineConversation
        ? [userMessage, assistantPlaceholder]
        : [...current, userMessage, assistantPlaceholder],
    );
    setDraft("");
    setAsking(true);
    setError(null);
    setActivity("Thinking over the selected documents...");

    try {
      const response = await fetch("/api/chat/answers/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question,
          folder_names: effectiveFolders,
          conversation_id: currentConversationId,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { detail?: string }
          | null;
        throw new Error(payload?.detail ?? `Chat request failed with status ${response.status}`);
      }

      if (!response.body) {
        throw new Error("Streaming response body was unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalized = false;
      let activeModel = health?.ollama.chat_model ?? "local model";

      const applyEvent = (event: ChatStreamEvent) => {
        if (event.type === "start") {
          activeModel = event.model;
          setCurrentConversationId(event.conversation_id);
          setCurrentConversationTitle(event.conversation_title);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    meta: `${event.model} • drafting answer`,
                    sources: event.sources,
                  }
                : message,
            ),
          );
          return;
        }

        if (event.type === "delta") {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: `${message.content}${event.delta}`,
                  }
                : message,
            ),
          );
          return;
        }

        if (event.type === "final") {
          finalized = true;
          activeModel = event.model;
          setCurrentConversationId(event.conversation_id);
          setCurrentConversationTitle(event.conversation_title);
          setInspectedSources(event.sources);
          setInspectedQuestion(question);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: event.answer,
                    meta: `${event.model} • ${event.sources.length} source${event.sources.length === 1 ? "" : "s"}`,
                    sources: event.sources,
                    streaming: false,
                  }
                : message,
            ),
          );
          if (isDemoMode && event.sources.length > 0) {
            setShowEvidenceInspector(true);
          }
          setActivity("Answer ready.");
          return;
        }

        throw new Error(event.detail);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          applyEvent(JSON.parse(trimmed) as ChatStreamEvent);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        applyEvent(JSON.parse(buffer.trim()) as ChatStreamEvent);
      }

      if (!finalized) {
        throw new Error(`Streaming finished before ${activeModel} returned a final answer.`);
      }

      void loadConversations().catch(() => undefined);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Unable to generate an answer.";
      setError(message);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content:
                  "I couldn't finish that answer. Check that Ollama is running and that the selected folders contain machine-readable text.",
                meta: "Request failed",
                sources: [],
                streaming: false,
              }
            : message,
        ),
      );
      void loadConversations().catch(() => undefined);
      setActivity("Answer failed.");
    } finally {
      setAsking(false);
    }
  };

  useEffect(() => {
    if (!isDemoMode || loading || syncing || asking) {
      return;
    }

    const hasExampleFolder = folders.some((folder) => folder.name === demoFolderName);
    if (!hasExampleFolder) {
      if (!demoRequestedRef.current) {
        demoRequestedRef.current = true;
        void handleExampleSync();
      }
      return;
    }

    if (selectedFolders.length !== 1 || selectedFolders[0] !== demoFolderName) {
      setSelectedFolders([demoFolderName]);
    }

    if (currentConversationId !== null || !isPristineConversation || demoPlaybackRef.current) {
      return;
    }

    demoPlaybackRef.current = true;
    setActivity("Preparing guided demo...");
    demoTimerRef.current = window.setTimeout(() => {
      void submitQuestion(demoQuestion, [demoFolderName]);
    }, 900);
  }, [
    asking,
    currentConversationId,
    folders,
    isDemoMode,
    isPristineConversation,
    loading,
    selectedFolders,
    syncing,
  ]);

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

    void submitQuestion(question, effectiveFolders);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    if (!draft.trim() || asking) {
      return;
    }

    event.currentTarget.form?.requestSubmit();
  };

  const scopeSummary =
    activeFolderNames.length > 0
      ? `${activeFolderPreview}${activeFolderOverflow > 0 ? ` +${activeFolderOverflow} more` : ""}`
      : "All indexed folders";
  const promptSuggestions = [
    "What should I pay attention to in these documents?",
    "What are the dates, amounts, and commitments I need to know?",
    "Which items need my attention first, and why?",
  ];

  return (
    <>
      <main className={`app-shell workspace-page${isDemoMode ? " demo-mode" : ""}`}>
        <input
          ref={folderInputRef}
          hidden
          type="file"
          multiple
          onChange={handleFolderUpload}
        />

        <header className="workspace-topbar">
          <div className="workspace-brand">
            <p className="eyebrow">Personal Records Intelligence</p>
            <h1>Ask your records.</h1>
            <p className="workspace-tagline">
              {isDemoMode
                ? "Guided demo using a safe local example set, with grounded answers and visible evidence."
                : "Local-first answers grounded in the documents you choose, with proof kept close and noise kept out."}
            </p>
          </div>

          <div className="workspace-status-card">
            <div className="workspace-status-head">
              <div>
                <span className="label">Active scope</span>
                <strong>{scopeSummary}</strong>
              </div>
              <span className={`status-pill ${workspaceStateLabel.toLowerCase()}`}>
                {workspaceStateLabel}
              </span>
            </div>
            <div className="workspace-stat-grid">
              <div className="workspace-stat">
                <strong>{folders.length}</strong>
                <span>Folders</span>
              </div>
              <div className="workspace-stat">
                <strong>{totalDocuments}</strong>
                <span>Documents</span>
              </div>
              <div className="workspace-stat">
                <strong>{totalChunks}</strong>
                <span>Chunks</span>
              </div>
            </div>
          </div>

          <div className="workspace-topbar-actions">
            {isDemoMode ? <span className="pill-neutral">Demo mode</span> : null}
            <button
              className="secondary-button"
              type="button"
              onClick={handleNewConversation}
            >
              New chat
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={syncing}
            >
              {syncing ? "Syncing..." : "Sync folder"}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setShowRuntimeInspector(true)}
            >
              Settings
            </button>
          </div>
        </header>

        <section className={`workspace-shell ${hasVisibleEvidence ? "with-evidence" : ""}`}>
          <aside className="workspace-sidebar">
            <div className="sidebar-switcher">
              <button
                className={`sidebar-tab ${sidebarView === "library" ? "active" : ""}`}
                type="button"
                onClick={() => setSidebarView("library")}
              >
                Library
              </button>
              <button
                className={`sidebar-tab ${sidebarView === "conversations" ? "active" : ""}`}
                type="button"
                onClick={() => setSidebarView("conversations")}
              >
                Conversations
              </button>
            </div>

            {sidebarView === "library" ? (
              <div className="sidebar-stack">
                <section className="sidebar-panel sidebar-summary-panel">
                  <div className="sidebar-panel-header">
                    <div>
                      <p className="eyebrow">Library</p>
                      <h2>Ready for questions</h2>
                    </div>
                    <span className="count-pill">
                      {activeFolderNames.length} in scope
                    </span>
                  </div>
                  <p className="sidebar-copy">{activity}</p>
                  {error && <p className="inline-error">{error}</p>}
                  <div className="sidebar-action-stack">
                    <button
                      className="primary-button sidebar-action-button"
                      type="button"
                      onClick={() => folderInputRef.current?.click()}
                      disabled={syncing}
                    >
                      {syncing ? "Syncing..." : "Sync a folder"}
                    </button>
                    <button
                      className="secondary-button sidebar-action-button"
                      type="button"
                      onClick={handleExampleSync}
                      disabled={syncing}
                    >
                      Load local examples
                    </button>
                  </div>
                </section>

                <section className="sidebar-panel">
                  <div className="sidebar-panel-header">
                    <div>
                      <p className="eyebrow">Scope</p>
                      <h2>Folders in play</h2>
                    </div>
                    <span className="count-pill">
                      {activeFolderNames.length} active
                    </span>
                  </div>
                  <p className="sidebar-copy">
                    Choose the folders that should inform the next answer. Clear
                    anything you no longer want indexed.
                  </p>

                  {loading && <p className="status-copy">Loading library...</p>}

                  {!loading && folders.length === 0 && (
                    <p className="status-copy">
                      No folders are indexed yet. Sync a folder from your Mac or
                      load the local examples to get started.
                    </p>
                  )}

                  {!loading && folders.length > 0 && (
                    <div className="folder-list workspace-folder-list">
                      {folders.map((folder) => {
                        const checked = selectedFolders.includes(folder.name);
                        const previewDocuments = folder.documents.slice(0, 2);
                        const hasOverflow = folder.documents.length > previewDocuments.length;

                        return (
                          <article
                            className={`folder-card ${checked ? "selected" : ""}`}
                            key={folder.name}
                          >
                            <div className="folder-card-top">
                              <div className="folder-select">
                                <input
                                  checked={checked}
                                  type="checkbox"
                                  onChange={() => handleToggleFolder(folder.name)}
                                />
                                <div className="folder-title-group">
                                  <strong>{folder.name}</strong>
                                  <p>
                                    {folder.document_count} doc
                                    {folder.document_count === 1 ? "" : "s"} •{" "}
                                    {folder.chunk_count} chunks
                                  </p>
                                </div>
                              </div>
                              <button
                                className="ghost-button danger"
                                disabled={mutatingTarget === `folder:${folder.name}`}
                                type="button"
                                onClick={() => void handleClearFolder(folder.name)}
                              >
                                {mutatingTarget === `folder:${folder.name}` ? "Clearing..." : "Clear"}
                              </button>
                            </div>

                            <div className="folder-meta-row">
                              <span className="origin-tag">
                                {folder.origin === "api_examples" ? "example" : "local"}
                              </span>
                              <span className="mini-stat">
                                Updated {new Date(folder.updated_at).toLocaleDateString()}
                              </span>
                            </div>

                            {previewDocuments.length > 0 && (
                              <div className="folder-preview-list compact">
                                {previewDocuments.map((document) => (
                                  <article className="preview-tile" key={document.id}>
                                    <div className="document-copy">
                                      <span>{document.filename}</span>
                                      <small>{document.relative_path}</small>
                                    </div>
                                  </article>
                                ))}

                                {hasOverflow && (
                                  <div className="preview-tile preview-more">
                                    <span>+{folder.documents.length - previewDocuments.length} more</span>
                                  </div>
                                )}
                              </div>
                            )}

                            <details className="folder-details">
                              <summary>
                                Manage {folder.documents.length} indexed document
                                {folder.documents.length === 1 ? "" : "s"}
                              </summary>
                              <ul className="document-list">
                                {folder.documents.map((document) => (
                                  <li key={document.id}>
                                    <div className="document-copy">
                                      <span>{document.filename}</span>
                                      <small>{document.relative_path}</small>
                                    </div>
                                    <button
                                      className="ghost-button"
                                      disabled={mutatingTarget === `document:${document.id}`}
                                      type="button"
                                      onClick={() =>
                                        void handleDeleteDocument(document.id, document.filename)
                                      }
                                    >
                                      {mutatingTarget === `document:${document.id}` ? "Removing..." : "Remove"}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="sidebar-stack">
                <section className="sidebar-panel">
                  <div className="sidebar-panel-header">
                    <div>
                      <p className="eyebrow">Conversations</p>
                      <h2>Recent briefings</h2>
                    </div>
                    <span className="count-pill">
                      {conversations.length} saved
                    </span>
                  </div>
                  <p className="sidebar-copy">
                    Re-open a saved thread to keep its question trail, evidence,
                    and folder context intact.
                  </p>

                  <button
                    className="secondary-button history-new-button"
                    type="button"
                    onClick={handleNewConversation}
                  >
                    Start a new chat
                  </button>

                  {historyLoading && <p className="status-copy">Loading conversations...</p>}

                  {!historyLoading && conversations.length === 0 && (
                    <p className="status-copy">
                      Saved conversations will appear here after your first answer.
                    </p>
                  )}

                  <div className="history-list">
                    {conversations.map((conversation) => {
                      const isActive = currentConversationId === conversation.id;

                      return (
                        <article
                          className={`history-item ${isActive ? "active" : ""}`}
                          key={conversation.id}
                        >
                          <button
                            className="history-select"
                            type="button"
                            onClick={() => void handleLoadConversation(conversation.id)}
                          >
                            <strong>{conversation.title}</strong>
                            <p>{conversation.preview ?? "Saved conversation"}</p>
                            <div className="history-meta">
                              <span>
                                {conversation.message_count} message
                                {conversation.message_count === 1 ? "" : "s"}
                              </span>
                              <span>
                                {new Date(conversation.updated_at).toLocaleDateString()}
                              </span>
                            </div>
                          </button>
                          <button
                            className="ghost-button"
                            disabled={mutatingTarget === `conversation:${conversation.id}`}
                            type="button"
                            onClick={() =>
                              void handleDeleteConversation(conversation.id, conversation.title)
                            }
                          >
                            {mutatingTarget === `conversation:${conversation.id}` ? "Deleting..." : "Delete"}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </aside>

          <section className="chat-stage">
            <header className="chat-stage-header">
              <div className="chat-stage-header-copy">
                <p className="eyebrow">Conversation</p>
                <h2>{currentConversationTitle}</h2>
                <p className="chat-stage-note">
                  {activeFolderNames.length > 0
                    ? `Searching ${activeFolderNames.length} folder${activeFolderNames.length === 1 ? "" : "s"} in ${scopeSummary}`
                    : "Searching all indexed folders"}
                </p>
              </div>
              <div className="chat-stage-actions">
                <span className="chat-session-state">
                  {currentConversationId ? "Saved conversation" : "Draft conversation"}
                </span>
                {activeEvidenceSources.length > 0 && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setShowEvidenceInspector((current) => !current)}
                  >
                    {hasVisibleEvidence
                      ? "Hide sources"
                      : `View ${activeEvidenceSources.length} source${activeEvidenceSources.length === 1 ? "" : "s"}`}
                  </button>
                )}
              </div>
            </header>

            <section className={`chat-surface ${isPristineConversation ? "empty" : ""}`}>
              {isPristineConversation ? (
                <div className="chat-welcome">
                  <p className="eyebrow">Grounded answers</p>
                  <h3>Start with the one thing you need to know.</h3>
                  <p>
                    Ask for the dates, totals, obligations, people, travel
                    details, or simply what deserves attention first. Every
                    answer is tied back to the indexed records in scope.
                  </p>

                  <div className="prompt-grid">
                    {promptSuggestions.map((prompt) => (
                      <button
                        className="prompt-card"
                        key={prompt}
                        type="button"
                        onClick={() => handleSuggestedPrompt(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>

                  <div className="welcome-support">
                    <span className="welcome-scope">
                      {folders.length > 0
                        ? `${folders.length} indexed folder${folders.length === 1 ? "" : "s"} ready`
                        : "No indexed folders yet"}
                    </span>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleExampleSync}
                      disabled={syncing}
                    >
                      Load local examples
                    </button>
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((message, index) => {
                    if (
                      currentConversationId === null &&
                      message.role === "assistant" &&
                      !message.sources?.length &&
                      index === 0
                    ) {
                      return null;
                    }

                    const sourceQuestion =
                      message.role === "assistant"
                        ? getQuestionForAssistantIndex(index)
                        : "";
                    const messageEvidenceGroups = message.sources
                      ? groupSourcesByDocument(message.sources)
                      : [];

                    return (
                      <article
                        className={`message-bubble ${message.role}${message.role === "assistant" && message.sources?.length ? " grounded" : ""}`}
                        key={message.id}
                      >
                        <div className="message-meta">
                          <span>{message.role === "assistant" ? "Assistant" : "You"}</span>
                          {message.meta && <small>{message.meta}</small>}
                        </div>
                        {message.role === "assistant" && message.sources?.length ? (
                          <div className="message-briefing-bar">
                            <div className="message-briefing-copy">
                              <span className="message-briefing-label">Grounded answer</span>
                              <p>{summarizeEvidenceCoverage(message.sources)}</p>
                            </div>
                            <button
                              className="message-evidence-button"
                              type="button"
                              onClick={() =>
                                handleInspectSources(message.sources ?? [], sourceQuestion)
                              }
                            >
                              Open evidence
                            </button>
                          </div>
                        ) : null}
                        <div
                          className={`message-content ${message.role === "assistant" ? "message-markdown" : ""}`}
                        >
                          {message.role === "assistant" && message.streaming && !message.content.trim() ? (
                            <div className="thinking-content">
                              <span className="thinking-copy">
                                Thinking through your records
                              </span>
                              <span className="thinking-dots" aria-hidden="true">
                                <span />
                                <span />
                                <span />
                              </span>
                            </div>
                          ) : message.role === "assistant" ? (
                            renderMarkdown(message.content)
                          ) : (
                            <p>{message.content}</p>
                          )}
                        </div>
                        {message.role === "assistant" && message.sources?.length ? (
                          <div className="message-evidence-row">
                            <div className="message-source-chip-row">
                              {messageEvidenceGroups.slice(0, 4).map((group, groupIndex) => (
                                <button
                                  className={`message-source-chip${focusedSourceDocumentId === group.document_id ? " active" : ""}`}
                                  key={`${message.id}-${group.document_id}`}
                                  type="button"
                                  onClick={() =>
                                    handleInspectSources(
                                      message.sources ?? [],
                                      sourceQuestion,
                                      group.document_id,
                                    )
                                  }
                                >
                                  <span className="message-source-chip-index">
                                    {groupIndex + 1}
                                  </span>
                                  <span className="message-source-chip-copy">
                                    <strong>{group.document_name}</strong>
                                    <small>
                                      {group.excerpt_count} excerpt
                                      {group.excerpt_count === 1 ? "" : "s"}
                                    </small>
                                  </span>
                                </button>
                              ))}
                              {messageEvidenceGroups.length > 4 ? (
                                <button
                                  className="message-source-chip message-source-chip-more"
                                  type="button"
                                  onClick={() =>
                                    handleInspectSources(message.sources ?? [], sourceQuestion)
                                  }
                                >
                                  +{messageEvidenceGroups.length - 4} more
                                </button>
                              ) : null}
                            </div>
                            {message.id === latestAssistantMessageId ? (
                              <div className="followup-chip-row">
                                {buildFollowUpPrompts(sourceQuestion).map((prompt) => (
                                  <button
                                    className="followup-chip"
                                    key={`${message.id}-${prompt}`}
                                    type="button"
                                    onClick={() => handleSuggestedPrompt(prompt)}
                                  >
                                    {prompt}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </section>

            <form className="composer composer-shell" onSubmit={handleSubmit}>
              <div className="composer-topline composer-intro">
                <div>
                  <label className="composer-label" htmlFor="question">
                    Ask about the selected records
                  </label>
                  <p className="composer-scope">
                    Try totals, deadlines, obligations, people, clauses, or
                    “what should I pay attention to?”
                  </p>
                </div>
                {activeEvidenceSources.length > 0 ? (
                  <button
                    className="ghost-button composer-evidence-button"
                    type="button"
                    onClick={() => setShowEvidenceInspector((current) => !current)}
                  >
                    {hasVisibleEvidence ? "Hide evidence" : "Open evidence"}
                  </button>
                ) : null}
              </div>
              <div className="composer-row">
                <textarea
                  ref={composerInputRef}
                  id="question"
                  placeholder="Ask one precise question about the records in scope."
                  rows={1}
                  value={draft}
                  onKeyDown={handleComposerKeyDown}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  className="primary-button composer-send"
                  disabled={asking || folders.length === 0}
                  type="submit"
                >
                  {asking ? "Thinking..." : "Send"}
                </button>
              </div>
              <div className="composer-footer">
                <div className="composer-scope-chips">
                  {activeFolderNames.slice(0, 4).map((name) => (
                    <span className="scope-chip" key={name}>
                      {name}
                    </span>
                  ))}
                  {activeFolderNames.length > 4 && (
                    <span className="scope-chip muted">
                      +{activeFolderNames.length - 4} more
                    </span>
                  )}
                </div>
                <span className="composer-hint">Enter to send · Shift+Enter for newline</span>
              </div>
            </form>
          </section>

          {hasVisibleEvidence ? (
            <aside className="evidence-drawer">
              <header className="evidence-drawer-header">
                <div className="source-header-copy">
                  <p className="eyebrow">Evidence</p>
                  <h2>Proof behind the answer</h2>
                  {activeEvidenceQuestion && (
                    <p className="source-panel-summary">
                      Matched against “{activeEvidenceQuestion}”
                    </p>
                  )}
                </div>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setShowEvidenceInspector(false)}
                >
                  Close
                </button>
              </header>

              <div className="evidence-overview">
                <strong>{summarizeEvidenceCoverage(activeEvidenceSources)}</strong>
                <p>Open any source to inspect the indexed copy used for this answer.</p>
              </div>

              <div className="evidence-filter-row">
                <button
                  className={`evidence-filter-chip${focusedSourceDocumentId === null ? " active" : ""}`}
                  type="button"
                  onClick={() => setFocusedSourceDocumentId(null)}
                >
                  All sources
                </button>
                {activeEvidenceDocumentGroups.map((group) => (
                  <button
                    className={`evidence-filter-chip${focusedSourceDocumentId === group.document_id ? " active" : ""}`}
                    key={group.document_id}
                    type="button"
                    onClick={() => setFocusedSourceDocumentId(group.document_id)}
                  >
                    {group.document_name}
                  </button>
                ))}
              </div>

              {focusedEvidenceDocument ? (
                <div className="focused-source-summary">
                  <div>
                    <span className="label">Focused source</span>
                    <strong>{focusedEvidenceDocument.document_name}</strong>
                    <p>
                      {focusedEvidenceDocument.folder_name} / {focusedEvidenceDocument.relative_path}
                    </p>
                  </div>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setFocusedSourceDocumentId(null)}
                  >
                    Show all
                  </button>
                </div>
              ) : null}

              <div className="source-list">
                {orderedActiveEvidenceSources.map((source, index) => {
                  const matchedTerms = getSourceMatchedTerms(source, activeEvidenceTerms);

                  return (
                    <button
                      className={`source-card source-card-button${focusedSourceDocumentId === source.document_id ? " active" : ""}`}
                      key={`${source.document_id}-${index}`}
                      type="button"
                      onClick={() => handleOpenSource(source.document_id)}
                    >
                      <div className="source-top">
                        <span className="source-rank">{index + 1}</span>
                        <div className="source-copy">
                          <strong className="source-name" title={source.document_name}>
                            {highlightEvidenceText(
                              source.document_name,
                              activeEvidenceTerms,
                              `inspector-name-${index}`,
                            )}
                          </strong>
                          <p
                            className="source-path"
                            title={`${source.folder_name} / ${source.relative_path}`}
                          >
                            {highlightEvidenceText(
                              `${source.folder_name} / ${source.relative_path}`,
                              activeEvidenceTerms,
                              `inspector-path-${index}`,
                            )}
                          </p>
                        </div>
                        <span className="source-score">Score {source.score.toFixed(2)}</span>
                      </div>

                      {matchedTerms.length > 0 && (
                        <div className="source-matchline">
                          <span className="source-matchlabel">Matched on</span>
                          <div className="source-tags">
                            {matchedTerms.map((term) => (
                              <span className="source-tag" key={`${source.document_id}-${term}`}>
                                {term}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <p className="source-excerpt">
                        {highlightEvidenceText(
                          source.excerpt,
                          activeEvidenceTerms,
                          `inspector-excerpt-${index}`,
                        )}
                      </p>

                      <div className="source-footnote">
                        <span>{getSourceTypeLabel(source.document_name)}</span>
                        <span>{source.folder_name}</span>
                        <span>Open file</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>
          ) : null}
        </section>
      </main>

      {showRuntimeInspector ? (
        <div
          className="runtime-overlay"
          role="presentation"
          onClick={() => setShowRuntimeInspector(false)}
        >
          <section
            className="runtime-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Runtime settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="runtime-dialog-header">
              <div>
                <p className="eyebrow">Runtime</p>
                <h2>Local stack</h2>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => setShowRuntimeInspector(false)}
              >
                Close
              </button>
            </div>

            {health ? (
              <div className="runtime-list">
                <article className="runtime-item">
                  <div className="runtime-item-top">
                    <span className="label">API</span>
                    <small className="runtime-meta">{health.version}</small>
                  </div>
                  <p className="runtime-value">{health.service}</p>
                </article>

                <article className="runtime-item">
                  <div className="runtime-item-top">
                    <span className="label">DuckDB</span>
                    <small className="runtime-meta">{health.database.version}</small>
                  </div>
                  <p className="runtime-value">{health.database.engine}</p>
                </article>

                <article className="runtime-item">
                  <div className="runtime-item-top">
                    <span className="label">Chat model</span>
                    <small className="runtime-meta">{health.ollama.chat_num_ctx} ctx</small>
                  </div>
                  <p className="runtime-value">{health.ollama.chat_model}</p>
                </article>

                <article className="runtime-item">
                  <div className="runtime-item-top">
                    <span className="label">Embeddings</span>
                    <small className="runtime-meta">Local model</small>
                  </div>
                  <p className="runtime-value">{health.ollama.embedding_model}</p>
                </article>
              </div>
            ) : (
              <p className="status-copy">Runtime status is unavailable until the API responds.</p>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}

export default App;
