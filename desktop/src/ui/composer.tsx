import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { t, type TKey } from "../i18n";
import { I } from "../icons";
import {
  DEFAULT_COMPOSER_ROWS,
  applyComposerTextareaAutosize,
} from "./composer-sizing";
import { fmtElapsed } from "./live";

export type ReasoningEffort = "low" | "medium" | "high" | "max";
export type EditMode = "review" | "auto" | "yolo";

type ModeEntry = { k: EditMode; label: TKey; icon: React.ReactNode; hint: TKey };
export type ComposerSendPayload = { hiddenMentions?: string[] };

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "max"];

const MODE_INFO: ModeEntry[] = [
  { k: "review", label: "editMode.review", icon: <I.shield size={12} />, hint: "editMode.reviewHint" },
  { k: "auto", label: "editMode.auto", icon: <I.zap size={12} />, hint: "editMode.autoHint" },
  { k: "yolo", label: "editMode.yolo", icon: <I.warn size={12} />, hint: "editMode.yoloHint" },
];

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: EditMode;
  onChange: (m: EditMode) => void;
}) {
  return (
    <div className="mode-switch" data-mode={mode}>
      {MODE_INFO.map((m) => (
        <button
          key={m.k}
          type="button"
          className="ms-seg"
          data-on={mode === m.k}
          data-k={m.k}
          onClick={() => onChange(m.k)}
          title={t(m.hint)}
        >
          {m.icon}
          <span>{t(m.label)}</span>
        </button>
      ))}
    </div>
  );
}

export type SlashCmd = {
  cmd: string;
  desc: string;
  run: () => void;
  kb?: string;
  insertOnly?: boolean;
};
export type MentionItem = {
  name: string;
  path?: string;
  kind: "file" | "dir" | "url" | "agent" | "clip";
  desc?: string;
};

export type Chip =
  | { kind: "at"; label: string }
  | { kind: "slash"; label: string };

type ComposerAttachment = {
  id: string;
  kind: "image" | "file";
  path: string;
  previewUrl?: string;
  revokePreviewUrl?: boolean;
  name: string;
  meta: string;
};

type ImagePreview = {
  url: string;
  revoke: boolean;
};

function createImagePreview(file: File): ImagePreview | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  return { url: URL.createObjectURL(file), revoke: true };
}

function revokeImagePreview(attachment: ComposerAttachment | ImagePreview | undefined) {
  if (!attachment) return;
  const shouldRevoke = "url" in attachment ? attachment.revoke : attachment.revokePreviewUrl;
  const url = "url" in attachment ? attachment.url : attachment.previewUrl;
  if (!shouldRevoke || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  if (!url) return;
  URL.revokeObjectURL(url);
}

function revokeImagePreviews(attachments: ComposerAttachment[]) {
  for (const attachment of attachments) revokeImagePreview(attachment);
}

function fileMeta(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).replace(/[^a-z0-9]+/gi, "") : "";
  if (!ext) return "FILE";
  return ext.length <= 6 ? ext.toUpperCase() : "FILE";
}

function isImagePath(path: string): boolean {
  const clean = path.split(/[?#]/)[0] ?? path;
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)$/i.test(clean);
}

/** For long paths show only the filename; truncate filename if it's still too long. */
function chipLabel(label: string, maxLen = 32): string {
  if (label.length <= maxLen) return label;
  const sep = label.includes("/") ? "/" : "\\";
  const segments = label.split(sep);
  const filename = segments[segments.length - 1]!;
  if (filename.length <= maxLen) return filename;
  return filename.slice(0, maxLen - 1) + "…";
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

type Popup =
  | { kind: "slash"; query: string }
  | { kind: "at"; query: string; nonce: number }
  | null;

type ActiveRange = { start: number; end: number; sigil: string; query: string };

/** Return the @word or /word range at cursorPos, or null. */
function findActiveRange(text: string, cursorPos: number): ActiveRange | null {
  if (cursorPos < 0 || cursorPos > text.length) return null;
  let wordStart = cursorPos;
  while (wordStart > 0 && !/\s/.test(text[wordStart - 1]!)) wordStart--;
  let wordEnd = cursorPos;
  while (wordEnd < text.length && !/\s/.test(text[wordEnd]!)) wordEnd++;
  if (wordStart === wordEnd) return null;
  const word = text.slice(wordStart, wordEnd);
  if (word.length > 0 && (word[0] === "@" || word[0] === "/")) {
    if (wordStart === 0 || /\s/.test(text[wordStart - 1]!)) {
      return { start: wordStart, end: wordEnd, sigil: word[0], query: word.slice(1) };
    }
  }
  return null;
}

/** Render draft text with @word and /word tokens wrapped in highlight spans. */
function highlightTokens(text: string): React.ReactNode {
  if (!text) return text;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  for (const m of text.matchAll(/(\s|^)([@\/]\S+)/g)) {
    const pre = text.slice(lastIdx, m.index);
    if (pre) parts.push(pre);
    parts.push(
      <span key={m.index}>
        {m[1]}
        <span className="hl-token">{m[2]}</span>
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts.length > 0 ? parts : text;
}

function slashIcon(cmd: string) {
  const m: Record<string, React.ReactNode> = {
    "/clear": <I.x size={12} />,
    "/new": <I.plus size={12} />,
    "/abort": <I.stop size={12} />,
    "/copy": <I.layers size={12} />,
    "/export": <I.download size={12} />,
    "/model": <I.cpu size={12} />,
    "/theme": <I.sun size={12} />,
    "/lang": <I.globe size={12} />,
  };
  return m[cmd] || <I.slash size={12} />;
}

/** Parent dir of the current @ query, with trailing slash. `null` = no parent to show (at workspace root). */
function parentOfAtQuery(query: string): string | null {
  const normalized = query.replace(/\\/g, "/");
  const trailingSlash = normalized.endsWith("/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const dirContext = trailingSlash ? normalized.slice(0, -1) : normalized.slice(0, lastSlash);
  if (!dirContext) return null;
  const parentIdx = dirContext.lastIndexOf("/");
  return parentIdx >= 0 ? `${dirContext.slice(0, parentIdx)}/` : "";
}

function displayMentionPath(path: string): { name: string; desc?: string } {
  const normalized = path.replace(/\\/g, "/");
  const isDir = /[\\/]$/.test(path);
  const trimmed = normalized.replace(/\/+$/, "");
  if (!trimmed) return { name: path };
  const slash = trimmed.lastIndexOf("/");
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const parent = slash >= 0 ? `${trimmed.slice(0, slash)}/` : "";
  return {
    name: isDir ? `${base}/` : base,
    desc: parent || undefined,
  };
}

function atIcon(k: MentionItem["kind"]) {
  if (k === "file") return <I.file size={12} />;
  if (k === "dir") return <I.folder size={12} />;
  if (k === "url") return <I.globe size={12} />;
  if (k === "agent") return <I.bot size={12} />;
  if (k === "clip") return <I.layers size={12} />;
  return <I.at size={12} />;
}

function guessImageExtension(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/svg+xml") return "svg";
  const slash = normalized.indexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1).replace(/[^a-z0-9]+/g, "") || "png" : "png";
}

function safeGetClipboardData(data: Pick<DataTransfer, "getData">, type: string): string {
  try {
    return data.getData(type) ?? "";
  } catch {
    return "";
  }
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.startsWith("/.file/id=")) return null;
    if (url.hostname) return `//${url.hostname}${decodedPath}`;
    return decodedPath.replace(/^\/([A-Za-z]:\/)/, "$1");
  } catch {
    return null;
  }
}

function looksLikeLocalPath(value: string): boolean {
  return /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(value.trim());
}

function looksLikeFilename(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\\/]/.test(trimmed)) return false;
  return /^[^:]+\.([A-Za-z0-9]{1,8})$/.test(trimmed);
}

function clipboardFileObjectPath(file: File): string | null {
  const candidate =
    (file as File & { path?: unknown }).path ??
    (file as File & { webkitRelativePath?: unknown }).webkitRelativePath;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return looksLikeLocalPath(trimmed) ? trimmed : null;
}

function normalizeMentionPath(picked: string, workspaceDir?: string): string {
  const normalizedPicked = picked.replace(/\\/g, "/");
  const normalizedWorkspace = workspaceDir?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    normalizedWorkspace &&
    (normalizedPicked === normalizedWorkspace ||
      normalizedPicked.startsWith(`${normalizedWorkspace}/`))
  ) {
    return normalizedPicked.slice(normalizedWorkspace.length).replace(/^\/+/, "") || ".";
  }
  return normalizedPicked;
}

export function clipboardFileMentionPaths(
  data: Pick<DataTransfer, "files" | "getData">,
  workspaceDir?: string,
): string[] {
  const rawPaths: string[] = [];
  const uriList = safeGetClipboardData(data, "text/uri-list");
  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const path = fileUrlToPath(trimmed);
    if (path) rawPaths.push(path);
  }

  if (rawPaths.length === 0 && data.files?.length) {
    for (const file of Array.from(data.files as ArrayLike<File>)) {
      if (!file) continue;
      const path = clipboardFileObjectPath(file);
      if (path) rawPaths.push(path);
    }
  }

  if (rawPaths.length === 0) {
    const plain = safeGetClipboardData(data, "text/plain");
    const lines = plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 0 && lines.every((line) => line.startsWith("file://") || looksLikeLocalPath(line))) {
      for (const line of lines) {
        rawPaths.push(fileUrlToPath(line) ?? line);
      }
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawPaths) {
    const path = normalizeMentionPath(raw, workspaceDir);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

export function Composer({
  draft,
  setDraft,
  onSend,
  onAbort,
  disabled,
  busy,
  busyLabel,
  busyElapsedMs,
  modelLabel,
  reasoningEffort,
  onModelChange,
  onEffortChange,
  editMode,
  onEditModeChange,
  planArmed = false,
  onPlanArmedChange,
  textareaRef,
  slashCommands,
  onMentionQuery,
  onMentionPreview,
  onMentionPicked,
  mentionResults,
  onOpenSourceSearch,
  variant = "default",
  workspacePickerLabel,
  onOpenWorkspacePicker,
  workspaceDir,
  queuedSends,
  onQueueWhileBusy,
  onDequeueSend,
  onPrioritizeQueuedSend,
  initialHistory,
  onHistoryPush,
}: {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  onSend: (payload?: ComposerSendPayload) => void;
  onAbort: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Rendered as a compact footer status while the agent is running — typically "Reasoning" or "Skill · <name>". */
  busyLabel?: string;
  busyElapsedMs?: number;
  modelLabel: string;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  editMode: EditMode;
  onEditModeChange: (mode: EditMode) => void;
  planArmed?: boolean;
  onPlanArmedChange?: (armed: boolean) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  slashCommands: SlashCmd[];
  onMentionQuery?: (q: string, nonce: number) => void;
  onMentionPreview?: (path: string, nonce: number) => void;
  onMentionPicked?: (path: string) => void;
  mentionResults?: { nonce: number; query: string; results: string[] } | null;
  onOpenSourceSearch?: () => void;
  variant?: "default" | "hero";
  workspacePickerLabel?: string;
  onOpenWorkspacePicker?: (anchor: { top?: number; bottom?: number; left: number }) => void;
  workspaceDir?: string;
  /** Messages typed while busy=true; rendered as removable chips above the textarea and auto-drained FIFO on turn-complete. */
  queuedSends?: string[];
  /** Called when the user presses Enter while busy with a non-empty draft. Owns clearing the draft. */
  onQueueWhileBusy?: (text: string) => void;
  onDequeueSend?: (index: number) => void;
  onPrioritizeQueuedSend?: (index: number) => void;
  /** Seed the in-session history from persisted storage so ArrowUp works after restart (#2051). */
  initialHistory?: string[];
  /** Called whenever an entry is pushed so the caller can persist the updated list. */
  onHistoryPush?: (entry: string, history: string[]) => void;
}) {
  const [popup, setPopup] = useState<Popup>(null);
  const [pickedChips, setPickedChips] = useState<Map<string, Chip["kind"]>>(new Map());
  const [imageAttachments, setImageAttachments] = useState<ComposerAttachment[]>([]);
  const chips = useMemo(() => {
    const result: Chip[] = [];
    for (const [label, kind] of pickedChips) {
      const sigil = kind === "at" ? "@" : "/";
      const escaped = sigil + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
      if (re.test(draft)) {
        result.push({ kind, label });
      }
    }
    return result;
  }, [draft, pickedChips]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const backdropContent = useMemo(() => highlightTokens(draft), [draft]);
  const nonceRef = useRef(0);
  const plusWrapRef = useRef<HTMLDivElement>(null);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  // macOS Chinese IME fires compositionend BEFORE the confirm keydown.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  // Persisted history is stored most-recent-first; historyRef uses oldest-first
  // (entries are appended via push, ArrowUp reads from the end). Reverse on load.
  const historyRef = useRef<string[]>(initialHistory ? [...initialHistory].reverse() : []);
  const [browseIdx, setBrowseIdx] = useState(-1);
  const savedDraftRef = useRef("");
  const activeRangeRef = useRef<ActiveRange | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const imageAttachmentsRef = useRef<ComposerAttachment[]>([]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    return () => revokeImagePreviews(imageAttachmentsRef.current);
  }, []);

  // `initialHistory` arrives asynchronously (settings load after mount).
  // Sync historyRef when it first becomes available and the user hasn't
  // started navigating yet, so ArrowUp works from the first keystroke (#2051).
  useEffect(() => {
    if (initialHistory && initialHistory.length > 0 && browseIdx === -1) {
      historyRef.current = [...initialHistory].reverse();
    }
  }, [initialHistory, browseIdx]);

  const insertMentions = (pickedPaths: string[]) => {
    const rels = pickedPaths
      .map((picked) => normalizeMentionPath(picked, workspaceDir))
      .filter(Boolean);
    if (rels.length === 0) return;
    const range = activeRangeRef.current;
    if (range && range.sigil === "@") {
      const savedRange = { ...range };
      setDraft((current) => {
        const before = current.slice(0, savedRange.start);
        const after = current.slice(savedRange.end);
        const insertion = rels.map((rel) => `@${rel}`).join(" ");
        const spacerBefore = before && !before.endsWith(" ") ? " " : "";
        const spacerAfter = after ? (after.startsWith(" ") ? "" : " ") : " ";
        return `${before}${spacerBefore}${insertion}${spacerAfter}${after}`;
      });
    } else {
      const insertion = rels.map((rel) => `@${rel}`).join(" ");
      setDraft((current) =>
        current ? `${current.replace(/\s+$/, "")} ${insertion} ` : `${insertion} `,
      );
    }
    activeRangeRef.current = null;
    setPickedChips((prev) => {
      const next = new Map(prev);
      for (const rel of rels) next.set(rel, "at");
      return next;
    });
    for (const rel of rels) onMentionPicked?.(rel);
    setPopup(null);
    textareaRef.current?.focus();
  };

  const insertMention = (picked: string) => insertMentions([picked]);

  const insertPlainTextAtCursor = (text: string) => {
    if (!text) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? start;
    setDraft((current) => `${current.slice(0, start)}${text}${current.slice(end)}`);
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      const cursor = start + text.length;
      target.selectionStart = cursor;
      target.selectionEnd = cursor;
      applyComposerTextareaAutosize(target);
    });
  };

  const addImageAttachment = (path: string, preview?: ImagePreview) => {
    const normalized = normalizeMentionPath(path, workspaceDir);
    const attachment: ComposerAttachment = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "image",
      path: normalized,
      previewUrl: preview?.url ?? convertFileSrc(path),
      revokePreviewUrl: preview?.revoke,
      name: basename(path),
      meta: fileMeta(path),
    };
    setImageAttachments((prev) => [...prev, attachment]);
    onMentionPicked?.(normalized);
    setPopup(null);
    textareaRef.current?.focus();
  };

  const addFileAttachments = (paths: string[]) => {
    const attachments: ComposerAttachment[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const normalized = normalizeMentionPath(path, workspaceDir);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      attachments.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${attachments.length}`,
        kind: "file",
        path: normalized,
        name: basename(normalized),
        meta: fileMeta(normalized),
      });
      onMentionPicked?.(normalized);
    }
    if (attachments.length === 0) return;
    setImageAttachments((prev) => [...prev, ...attachments]);
    setPopup(null);
    textareaRef.current?.focus();
  };

  const addPathAttachments = (paths: string[]) => {
    const imagePaths = paths.filter(isImagePath);
    const filePaths = paths.filter((path) => !isImagePath(path));
    if (filePaths.length > 0) addFileAttachments(filePaths);
    for (const path of imagePaths) addImageAttachment(path);
  };

  const tryAddDesktopClipboardPaths = async (logLabel: string) => {
    try {
      const paths = await invoke<string[]>("read_clipboard_file_paths");
      if (Array.isArray(paths) && paths.length > 0) {
        addPathAttachments(paths);
        return true;
      }
    } catch (err) {
      console.error(logLabel, err);
    }
    return false;
  };

  const addPastedImageFile = async (file: File) => {
    const preview = createImagePreview(file);
    try {
      const buffer = await file.arrayBuffer();
      const savedPath = await invoke<string>("save_clipboard_image", {
        bytes: buffer,
        extension: guessImageExtension(file.type),
      });
      addImageAttachment(savedPath, preview);
      return true;
    } catch (err) {
      revokeImagePreview(preview);
      console.error("clipboard image paste failed", err);
      return false;
    }
  };

  const tryAddNavigatorClipboardImage = async () => {
    const readClipboard = navigator.clipboard?.read;
    if (typeof readClipboard !== "function") return false;
    try {
      const clipboardItems = await readClipboard.call(navigator.clipboard);
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        return await addPastedImageFile(
          new File([blob], "jupiter-pasted-image", { type: imageType }),
        );
      }
    } catch (err) {
      console.error("navigator clipboard image paste failed", err);
    }
    return false;
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    applyComposerTextareaAutosize(textarea);
  });

  // Programmatic draft transitions to "/" must open the slash popup, since handleChange only fires on actual user input.
  const prevDraftRef = useRef(draft);
  useEffect(() => {
    const prev = prevDraftRef.current;
    prevDraftRef.current = draft;
    if (draft === "/" && prev !== "/") {
      activeRangeRef.current = { start: 0, end: 1, sigil: "/", query: "" };
      setPopup({ kind: "slash", query: "" });
    }
  }, [draft]);

  useEffect(() => {
    if (!modelMenuOpen && !plusMenuOpen && !modeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        plusWrapRef.current &&
        !plusWrapRef.current.contains(e.target as Node)
      ) {
        setPlusMenuOpen(false);
      }
      if (
        modeWrapRef.current &&
        !modeWrapRef.current.contains(e.target as Node)
      ) {
        setModeMenuOpen(false);
      }
      if (
        modelWrapRef.current &&
        !modelWrapRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen, plusMenuOpen, modeMenuOpen]);

  const attachFile = async (filter?: "image") => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        defaultPath: workspaceDir,
        filters:
          filter === "image"
            ? [
                {
                  name: t("composer.imageFilterName"),
                  extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
                },
              ]
            : undefined,
      });
      if (typeof picked !== "string" || !picked) return;
      if (filter === "image" || isImagePath(picked)) {
        addImageAttachment(picked);
      } else {
        addFileAttachments([picked]);
      }
    } catch (err) {
      console.error("attach failed", err);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileMentions = clipboardFileMentionPaths(e.clipboardData, workspaceDir);
    if (fileMentions.length > 0) {
      e.preventDefault();
      addPathAttachments(fileMentions);
      return;
    }
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = Array.from((e.clipboardData?.files ?? []) as ArrayLike<File>);
    const clipboardTypes = Array.from(e.clipboardData?.types ?? []);
    const imageItem = items.find((item) => item.type?.startsWith("image/"));
    const imageFile =
      imageItem?.getAsFile() ??
      files.find((file) => typeof file.type === "string" && file.type.startsWith("image/")) ??
      null;
    const hasFilePayload =
      files.length > 0 || items.some((item) => item.kind === "file");
    const hasFileClipboardType = clipboardTypes.some((type) =>
      ["Files", "public.file-url", "CorePasteboardFlavorType 0x6675726C"].includes(type),
    );
    const plainText = safeGetClipboardData(e.clipboardData, "text/plain");
    const shouldProbeDesktopFiles =
      hasFilePayload || hasFileClipboardType || looksLikeFilename(plainText) || !plainText;
    if (shouldProbeDesktopFiles) {
      e.preventDefault();
      if (await tryAddDesktopClipboardPaths("clipboard file paste failed")) return;
      if (!imageFile) {
        insertPlainTextAtCursor(plainText);
        return;
      }
    }
    if (!imageFile) {
      return;
    }
    e.preventDefault();
    await addPastedImageFile(imageFile);
  };

  const openPopupAtCursor = (sigil: "/" | "@") => {
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? draft.length;
    activeRangeRef.current = { start: cursor, end: cursor, sigil, query: "" };
    const nonce = ++nonceRef.current;
    setPopup(
      sigil === "/"
        ? { kind: "slash", query: "" }
        : { kind: "at", query: "", nonce },
    );
    textarea?.focus();
  };

  const openSlashMenu = () => {
    setPlusMenuOpen(false);
    openPopupAtCursor("/");
  };

  const openMentionMenu = () => {
    setPlusMenuOpen(false);
    openPopupAtCursor("@");
  };

  const openSourceSearch = () => {
    setPlusMenuOpen(false);
    setModeMenuOpen(false);
    setModelMenuOpen(false);
    setPopup(null);
    onOpenSourceSearch?.();
  };

  const slashItems = useMemo(() => {
    if (!popup || popup.kind !== "slash") return [];
    const q = popup.query.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.cmd.toLowerCase().includes(q));
  }, [popup, slashCommands]);

  const atItems = useMemo<MentionItem[]>(() => {
    if (!popup || popup.kind !== "at") return [];
    if (!mentionResults || mentionResults.nonce !== popup.nonce) return [];
    const base: MentionItem[] = mentionResults.results.map((path) => {
      const display = displayMentionPath(path);
      return {
        name: display.name,
        path,
        kind: path.endsWith("/") || path.endsWith("\\") ? "dir" : "file",
        desc: display.desc,
      };
    });
    // "../" entry (#1019): one level up whenever the @ query is inside a subdir.
    const parent = parentOfAtQuery(popup.query);
    if (parent !== null) {
      base.unshift({
        name: "..",
        kind: "dir",
        desc: parent ? `↑ ${parent}` : `↑ ${t("composer.workspaceRoot")}`,
      });
    }
    return base;
  }, [popup, mentionResults]);

  const items =
    popup?.kind === "slash" ? slashItems : popup?.kind === "at" ? atItems : [];

  useEffect(() => {
    setActiveIdx(0);
  }, [popup?.kind]);

  useEffect(() => {
    setActiveIdx((i) => (items.length ? Math.min(i, items.length - 1) : 0));
  }, [items.length]);

  useEffect(() => {
    if (!popup || popup.kind !== "at" || !onMentionQuery) return;
    onMentionQuery(popup.query, popup.nonce);
  }, [popup, onMentionQuery]);

  const syncPopupFromCursor = (value: string, cursorPos: number) => {
    const range = findActiveRange(value, cursorPos);
    if (range && (range.sigil === "/" || range.sigil === "@")) {
      activeRangeRef.current = range;
      if (range.sigil === "/") {
        if (popup?.kind !== "slash" || popup.query !== range.query) {
          setPopup({ kind: "slash", query: range.query });
        }
      } else {
        if (popup?.kind !== "at" || popup.query !== range.query) {
          const nonce = ++nonceRef.current;
          setPopup({ kind: "at", query: range.query, nonce });
        }
      }
    } else if (popup) {
      const active = activeRangeRef.current;
      const expectedSigil = popup.kind === "slash" ? "/" : "@";
      if (
        active &&
        active.sigil === expectedSigil &&
        active.start === active.end &&
        active.query === "" &&
        cursorPos === active.start
      ) {
        return;
      }
      activeRangeRef.current = null;
      setPopup(null);
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setDraft(v);
    const cursorPos = e.target.selectionStart ?? v.length;
    syncPopupFromCursor(v, cursorPos);
  };

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const cursorPos = ta.selectionStart;
    if (cursorPos === null) return;
    syncPopupFromCursor(ta.value, cursorPos);
  };

  const handleTextareaScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  const dismiss = () => setPopup(null);

  const pickItem = (idx: number) => {
    const it = items[idx];
    if (!it || !popup) return;
    const range = activeRangeRef.current;
    const before = range ? draft.slice(0, range.start) : draft;
    const after = range ? draft.slice(range.end) : "";
    if (popup.kind === "slash") {
      const cmd = (it as SlashCmd).cmd;
      const insertOnly = (it as SlashCmd).insertOnly === true;
      if (insertOnly) {
        const spacer = before && !before.endsWith(" ") ? " " : "";
        setDraft(`${before}${spacer}${cmd} ${after}`);
        setPickedChips((prev) => new Map(prev).set(cmd.replace(/^\//, ""), "slash"));
      } else {
        setDraft(`${before}${after}`);
        (it as SlashCmd).run();
      }
    } else {
      const mention = it as MentionItem;
      if (mention.name === "..") {
        const parent = parentOfAtQuery(popup.query) ?? "";
        const newText = `@${parent}`;
        const next = `${before}${newText}${after}`;
        setDraft(next);
        activeRangeRef.current = {
          start: range?.start ?? 0,
          end: (range?.start ?? 0) + newText.length,
          sigil: "@",
          query: parent,
        };
        const nonce = ++nonceRef.current;
        setPopup({ kind: "at", query: parent, nonce });
        textareaRef.current?.focus();
        return;
      }
      const mentionPath = mention.path ?? mention.name;
      insertMention(mentionPath);
      return;
    }
    activeRangeRef.current = null;
    setPopup(null);
    textareaRef.current?.focus();
  };

  const recordSendAndReset = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    historyRef.current.push(trimmed);
    if (historyRef.current.length > 100) historyRef.current.shift();
    setBrowseIdx(-1);
    onHistoryPush?.(trimmed, [...historyRef.current]);
  };

  const submitNow = () => {
    const hiddenMentions = imageAttachments.map((attachment) => attachment.path);
    const hasPayload = Boolean(draft.trim()) || hiddenMentions.length > 0;
    if (disabled || !hasPayload || busy) return;
    recordSendAndReset();
    onSend(hiddenMentions.length > 0 ? { hiddenMentions } : undefined);
    setPickedChips(new Map());
    revokeImagePreviews(imageAttachments);
    setImageAttachments([]);
  };

  const navigateHistory = (dir: -1 | 1) => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (dir === -1) {
      const nextIdx = browseIdx + 1;
      if (nextIdx < hist.length) {
        if (browseIdx === -1) savedDraftRef.current = draft;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      }
    } else {
      if (browseIdx > 0) {
        const nextIdx = browseIdx - 1;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      } else if (browseIdx === 0) {
        setBrowseIdx(-1);
        setDraft(savedDraftRef.current);
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      const draftBeforePaste = draft;
      const attachmentCountBeforePaste = imageAttachmentsRef.current.length;
      window.setTimeout(() => {
        const textarea = textareaRef.current;
        const textChanged = textarea ? textarea.value !== draftBeforePaste : false;
        const attachmentsChanged =
          imageAttachmentsRef.current.length !== attachmentCountBeforePaste;
        if (textChanged || attachmentsChanged) return;
        void (async () => {
          if (await tryAddDesktopClipboardPaths("keyboard clipboard file paste failed")) return;
          await tryAddNavigatorClipboardImage();
        })();
      }, 250);
    }
    if (popup) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (items.length ? (i + 1) % items.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) =>
          items.length ? (i - 1 + items.length) % items.length : 0,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key === "Tab" && popup.kind === "at" && items.length > 0) {
        e.preventDefault();
        // `..` is the synthetic parent-dir entry (#1019); same shape
        // but rewrites to the parent path.
        const it = items[activeIdx];
        if (it && (it as MentionItem).kind === "dir") {
          const mention = it as MentionItem;
          const range = activeRangeRef.current;
          const before = range ? draft.slice(0, range.start) : draft;
          const after = range ? draft.slice(range.end) : "";
          if (mention.name === "..") {
            const parent = parentOfAtQuery(popup.query) ?? "";
            const newText = `@${parent}`;
            const next = `${before}${newText}${after}`;
            setDraft(next);
            activeRangeRef.current = {
              start: range?.start ?? 0,
              end: (range?.start ?? 0) + newText.length,
              sigil: "@",
              query: parent,
            };
            const nonce = ++nonceRef.current;
            setPopup({ kind: "at", query: parent, nonce });
            return;
          }
          const dirPath = (mention.path ?? mention.name).replace(/[\\/]+$/, "");
          const newText = `@${dirPath}/`;
          const next = `${before}${newText}${after}`;
          setDraft(next);
          activeRangeRef.current = {
            start: range?.start ?? 0,
            end: (range?.start ?? 0) + newText.length,
            sigil: "@",
            query: `${dirPath}/`,
          };
          const nonce = ++nonceRef.current;
          setPopup({ kind: "at", query: `${dirPath}/`, nonce });
          return;
        }
      }
      if (e.key === "Enter") {
        if (items.length > 0) {
          e.preventDefault();
          pickItem(activeIdx);
          return;
        }
        dismiss();
      }
    }
    if (!popup) {
      const ta = textareaRef.current;
      if (e.key === "ArrowUp" && ta && ta.selectionStart === 0) {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
      if (e.key === "ArrowDown" && ta && ta.selectionStart === draft.length) {
        e.preventDefault();
        navigateHistory(1);
        return;
      }
    }
    if (composingRef.current || e.nativeEvent.isComposing || Date.now() - compositionEndedAtRef.current < 50) return;
    if (e.key === "Enter" && !e.shiftKey && !popup) {
      e.preventDefault();
      if (busy) {
        const text = draft.trim();
        if (text && onQueueWhileBusy) {
          onQueueWhileBusy(text);
          setPickedChips(new Map());
        }
      } else {
        submitNow();
      }
    }
  };

  return (
    <div className={`composer-wrap${variant === "hero" ? " composer-wrap--hero" : ""}`}>
      <div className="composer-inner">
        {queuedSends && queuedSends.length > 0 ? (
          <div className="composer-queued">
            <div className="composer-queued-head">
              <span>{t("composer.queueCount", { n: queuedSends.length })}</span>
            </div>
            {queuedSends.map((text, i) => (
              <div key={`${i}-${text}`} className="composer-queue-row" title={text}>
                <span className="composer-queue-corner" aria-hidden="true">
                  ↳
                </span>
                <span className="composer-queue-text">{text}</span>
                {onPrioritizeQueuedSend ? (
                  <button
                    type="button"
                    className="composer-queue-action"
                    aria-label={t("composer.queuePrioritizeLabel", { text })}
                    title={t("composer.queuePrioritizeLabel", { text })}
                    onClick={() => onPrioritizeQueuedSend(i)}
                  >
                    <span aria-hidden="true">↪</span>
                    <span>{t("composer.queuePrioritize")}</span>
                  </button>
                ) : null}
                {onDequeueSend ? (
                  <button
                    type="button"
                    className="composer-queue-icon-action"
                    aria-label={t("composer.queueRemoveLabel", { text })}
                    title={t("composer.queueRemoveLabel", { text })}
                    onClick={() => onDequeueSend(i)}
                  >
                    <I.trash size={13} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div className="composer">
          {imageAttachments.length > 0 ? (
            <div className="composer-attachments">
              {imageAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={
                    attachment.kind === "image"
                      ? "composer-image-attachment"
                      : "composer-file-attachment"
                  }
                  title={attachment.path}
                  aria-label={
                    attachment.kind === "image"
                      ? `Attached image ${attachment.name}`
                      : `Attached file ${attachment.name}`
                  }
                >
                  {attachment.kind === "image" && attachment.previewUrl ? (
                    <img src={attachment.previewUrl} alt="pasted image" />
                  ) : (
                    <>
                      <span className="composer-file-icon">
                        <I.file size={17} />
                      </span>
                      <span className="composer-file-copy">
                        <span className="composer-file-name">{attachment.name}</span>
                        <span className="composer-file-meta">{attachment.meta}</span>
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label={t("composer.removeAttachment")}
                    title={t("composer.removeAttachment")}
                    onClick={() =>
                      setImageAttachments((prev) => {
                        const removed = prev.find((item) => item.id === attachment.id);
                        revokeImagePreview(removed);
                        return prev.filter((item) => item.id !== attachment.id);
                      })
                    }
                  >
                    <I.x size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {chips.length > 0 ? (
            <div className="composer-tags">
              {chips.map((c, i) => (
                <span key={`${c.kind}-${c.label}-${i}`} className={`chip ${c.kind}`} title={c.label}>
                  {c.kind === "slash" ? (
                    <I.slash size={11} />
                  ) : (
                    <I.at size={11} />
                  )}
                  <span>{chipLabel(c.label)}</span>
                </span>
              ))}
            </div>
          ) : null}

          <div className="composer-textarea-wrap">
            <div className="composer-backdrop" ref={backdropRef} aria-hidden="true">
              {backdropContent}
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              placeholder={t("composer.placeholder")}
              onChange={handleChange}
              onSelect={handleSelect}
              onScroll={handleTextareaScroll}
              onPaste={(e) => void handlePaste(e)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => {
                composingRef.current = false;
                compositionEndedAtRef.current = Date.now();
              }}
              rows={DEFAULT_COMPOSER_ROWS}
              disabled={disabled}
            />
          </div>

          <div className="composer-foot">
            <div className="composer-left-tools">
              {onOpenWorkspacePicker ? (
                <button
                  type="button"
                  className="composer-workspace-btn"
                  title={t("composer.switchWorkspace")}
                  aria-label={t("composer.switchWorkspaceWithName", {
                    workspace: workspacePickerLabel ?? "Jupiter",
                  })}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    onOpenWorkspacePicker({
                      bottom: Math.max(12, window.innerHeight - rect.top + 8),
                      left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)),
                    });
                    setPlusMenuOpen(false);
                    setModeMenuOpen(false);
                    setModelMenuOpen(false);
                  }}
                >
                  <I.folder size={13} />
                  <span>{workspacePickerLabel ?? "Jupiter"}</span>
                  <I.chev size={10} />
                </button>
              ) : null}
              <div className="composer-plus-wrap" ref={plusWrapRef}>
                <button
                  type="button"
                  className="composer-plus-btn"
                  title={t("composer.addContext")}
                  aria-label={t("composer.addContext")}
                  aria-expanded={plusMenuOpen}
                  onClick={() => {
                    setPlusMenuOpen((v) => !v);
                    setModeMenuOpen(false);
                    setModelMenuOpen(false);
                  }}
                >
                  <I.plus size={16} />
                </button>
                {plusMenuOpen ? (
                  <div className="composer-plus-menu" onMouseDown={(e) => e.preventDefault()}>
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        void attachFile();
                      }}
                    >
                      <span className="ico"><I.paperclip size={14} /></span>
                      <span className="copy">
                        <span className="title">{t("composer.insertFile")}</span>
                        <span className="hint">{t("composer.attachmentCard")}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={openMentionMenu}
                    >
                      <span className="ico"><I.at size={14} /></span>
                      <span className="copy">
                        <span className="title">{t("composer.mentionFiles")}</span>
                        <span className="hint">@</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={() => {
                        onPlanArmedChange?.(!planArmed);
                        setPlusMenuOpen(false);
                      }}
                    >
                      <span className="ico"><I.list size={14} /></span>
                      <span className="copy">
                        <span className="title">{t("editMode.plan")}</span>
                        <span className="hint">{t("editMode.planDesc")}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={openSlashMenu}
                    >
                      <span className="ico"><I.slash size={14} /></span>
                      <span className="copy">
                        <span className="title">{t("composer.commandsLabel")}</span>
                        <span className="hint">/</span>
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="composer-plus-btn composer-source-search-btn"
                title={t("composer.searchSources")}
                aria-label={t("composer.searchSources")}
                onClick={openSourceSearch}
              >
                <I.search size={15} />
              </button>

              {planArmed ? (
                <button
                  type="button"
                  className="composer-plan-armed"
                  title={t("editMode.planDesc")}
                  onClick={() => onPlanArmedChange?.(false)}
                >
                  <I.list size={12} />
                  <span>{t("editMode.plan")}</span>
                  <I.x size={10} />
                </button>
              ) : null}

              <PermissionModeMenu
                mode={editMode}
                open={modeMenuOpen}
                setOpen={(open) => {
                  setModeMenuOpen(open);
                  if (open) {
                    setPlusMenuOpen(false);
                    setModelMenuOpen(false);
                  }
                }}
                onChange={(mode) => {
                  onEditModeChange(mode);
                  setModeMenuOpen(false);
                }}
                wrapRef={modeWrapRef}
              />

              {busy && busyLabel ? (
                <span className="composer-busy-status">
                  <span className="composer-busy-pip" />
                  <span className="composer-busy-label">{busyLabel}</span>
                  <span className="composer-busy-time">
                    {fmtElapsed(busyElapsedMs ?? 0)}
                  </span>
                </span>
              ) : null}
            </div>

            <span className="grow" />

            <div className="composer-model-wrap" ref={modelWrapRef}>
              <button
                type="button"
                className="model-pill"
                onClick={() => setModelMenuOpen((v) => !v)}
                title={t("composer.switchModel")}
              >
                <I.brain size={12} />
                <span>{modelLabel}</span>
                <span className="badge">{reasoningEffort}</span>
                <I.chev size={10} />
              </button>
              {modelMenuOpen ? (
                <ModelEffortMenu
                  modelLabel={modelLabel}
                  currentEffort={reasoningEffort}
                  onPickModel={(m) => {
                    onModelChange(m);
                    setModelMenuOpen(false);
                  }}
                  onPickEffort={(e) => {
                    onEffortChange(e);
                    setModelMenuOpen(false);
                  }}
                />
              ) : null}
            </div>
            {busy ? (
              <button
                type="button"
                className="send-btn"
                style={{ background: "var(--danger)" }}
                onClick={onAbort}
                title={t("composer.interrupt")}
              >
                <I.stop size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                disabled={disabled || (!draft.trim() && imageAttachments.length === 0)}
                onClick={submitNow}
              >
                <I.send size={14} />
              </button>
            )}
          </div>

          {popup ? (
            <Popup
              kind={popup.kind}
              items={items}
              activeIdx={activeIdx}
              onPick={(i) => pickItem(i)}
              onClose={dismiss}
              onHover={(i, item) => {
                setActiveIdx(i);
                if (popup.kind === "at" && onMentionPreview) {
                  const mention = item as MentionItem;
                  const path = mention.path ?? mention.name;
                  onMentionPreview(path, popup.nonce);
                }
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PermissionModeMenu({
  mode,
  open,
  setOpen,
  onChange,
  wrapRef,
}: {
  mode: EditMode;
  open: boolean;
  setOpen: (open: boolean) => void;
  onChange: (mode: EditMode) => void;
  wrapRef: RefObject<HTMLDivElement | null>;
}) {
  const active = MODE_INFO.find((m) => m.k === mode) ?? MODE_INFO[0]!;

  return (
    <div className="composer-mode-wrap" ref={wrapRef}>
      <button
        type="button"
        className="composer-permission"
        data-mode={mode}
        title={t(active.hint)}
        aria-label={t("editMode.label")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="composer-permission-icon">{active.icon}</span>
        <span className="composer-permission-label">{t(active.label)}</span>
        <I.chev className="composer-permission-chev" size={9} />
      </button>
      {open ? (
        <div className="composer-mode-menu" onMouseDown={(e) => e.preventDefault()}>
          {MODE_INFO.map((m) => (
            <button
              key={m.k}
              type="button"
              className="composer-mode-option"
              data-active={mode === m.k}
              data-mode={m.k}
              onClick={() => onChange(m.k)}
            >
              <span className="ico">{m.icon}</span>
              <span className="copy">
                <span className="title">{t(m.label)}</span>
                <span className="hint">{t(m.hint)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Popup({
  kind,
  items,
  activeIdx,
  onPick,
  onClose,
  onHover,
}: {
  kind: "slash" | "at";
  items: (SlashCmd | MentionItem)[];
  activeIdx: number;
  onPick: (i: number) => void;
  onClose: () => void;
  onHover: (i: number, item: SlashCmd | MentionItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  }, [activeIdx]);

  return (
    <div
      className={kind === "at" ? "popup at-popup" : "popup"}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="ph">
        <span className="tok">{kind === "slash" ? "/" : "@"}</span>
        <span>
          {kind === "slash"
            ? t("composer.slashHeader")
            : t("composer.atHeader")}
        </span>
        <span className="grow" />
        <span style={{ cursor: "pointer" }} onClick={onClose}>
          <I.x size={11} />
        </span>
      </div>
      <div className={kind === "at" ? "popup-list at-popup-list" : "popup-list"} ref={listRef}>
        {items.length === 0 ? (
          <div
            style={{
              padding: "12px 8px",
              fontSize: 11.5,
              color: "var(--muted-2)",
              fontFamily: "Geist Mono, monospace",
            }}
          >
            {t("composer.noMatches")}
          </div>
        ) : null}
        {items.map((it, i) => (
          <div
            key={i}
            className="popup-item"
            data-active={i === activeIdx}
            onClick={() => onPick(i)}
            onMouseEnter={() => onHover(i, it)}
          >
            <span className="ico">
              {kind === "slash"
                ? slashIcon((it as SlashCmd).cmd)
                : atIcon((it as MentionItem).kind)}
            </span>
            <div className="nm">
              {kind === "slash" ? (
                <>
                  <span className="cmd">{(it as SlashCmd).cmd}</span>
                  <span className="desc">{(it as SlashCmd).desc}</span>
                </>
              ) : (
                <>
                  <span className="mention-name">{(it as MentionItem).name}</span>
                  {(it as MentionItem).desc ? (
                    <div className="desc">{(it as MentionItem).desc}</div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const KNOWN_MODELS: readonly string[] = ["deepseek-v4-flash", "deepseek-v4-pro"];
const MODEL_HINTS: Record<string, string> = {
  "deepseek-v4-flash": "fast",
  "deepseek-v4-pro": "pro",
};

function ModelEffortMenu({
  modelLabel,
  currentEffort,
  onPickModel,
  onPickEffort,
}: {
  modelLabel: string;
  currentEffort: ReasoningEffort;
  onPickModel: (model: string) => void;
  onPickEffort: (effort: ReasoningEffort) => void;
}) {
  return (
    <div
      className="composer-model-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="composer-menu-head">
        <I.brain size={13} />
        <span>{t("composer.switchModel")}</span>
      </div>
      <div className="composer-model-list">
        {KNOWN_MODELS.map((m) => (
          <button
            key={m}
            type="button"
            className="composer-model-option"
            data-active={m === modelLabel}
            onClick={() => onPickModel(m)}
          >
            <span className="ico">
              {m === modelLabel ? <I.check size={12} /> : <I.brain size={12} />}
            </span>
            <span className="copy">
              <span className="title">{m}</span>
              <span className="hint">{MODEL_HINTS[m] ?? ""}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="composer-menu-head compact">
        <I.cpu size={13} />
        <span>{t("composer.switchEffort")}</span>
      </div>
      <div className="composer-effort-grid">
        {EFFORTS.map((e) => (
          <button
            key={e}
            type="button"
            className="composer-effort-option"
            data-active={e === currentEffort}
            title={t(`effort.${e}Desc` as TKey)}
            onClick={() => onPickEffort(e)}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
