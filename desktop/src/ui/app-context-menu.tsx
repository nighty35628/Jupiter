import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FilePreviewTarget } from "../file-preview";
import { openDefaultFile, openFileWithApp, revealFileInFolder } from "../file-preview";
import { t, useLang } from "../i18n";
import { I } from "../icons";

type Anchor = { left: number; top: number };
type MenuSize = { width: number; height: number };
type ViewportSize = { width: number; height: number };

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export type ContextMenuDetails = {
  editable: EditableElement | null;
  canEdit: boolean;
  editableSelection: string;
  selectionText: string;
  file: { path: string; line?: string } | null;
  link: { href: string; label: string } | null;
};

export type ContextMenuItemKind =
  | "copy"
  | "cut"
  | "paste"
  | "selectAll"
  | "previewFile"
  | "openFile"
  | "revealFile"
  | "openWith"
  | "copyFilePath"
  | "openLink"
  | "copyLink";

const MENU_MARGIN = 8;
const FALLBACK_MENU_SIZE: MenuSize = { width: 236, height: 246 };

function viewportSize(): ViewportSize {
  return {
    width:
      typeof window === "undefined"
        ? FALLBACK_MENU_SIZE.width + MENU_MARGIN * 2
        : window.innerWidth,
    height:
      typeof window === "undefined"
        ? FALLBACK_MENU_SIZE.height + MENU_MARGIN * 2
        : window.innerHeight,
  };
}

export function positionAppContextMenu(
  anchor: Anchor,
  size: MenuSize = FALLBACK_MENU_SIZE,
  viewport: ViewportSize = viewportSize(),
): Anchor {
  const maxLeft = Math.max(MENU_MARGIN, viewport.width - size.width - MENU_MARGIN);
  const maxTop = Math.max(MENU_MARGIN, viewport.height - size.height - MENU_MARGIN);
  return {
    left: Math.min(Math.max(anchor.left, MENU_MARGIN), maxLeft),
    top: Math.min(Math.max(anchor.top, MENU_MARGIN), maxTop),
  };
}

function closestElement(target: EventTarget | null): Element | null {
  if (!target) return null;
  if (target instanceof Element) return target;
  const node = target instanceof Node ? target.parentElement : null;
  return node instanceof Element ? node : null;
}

function editableInputType(input: HTMLInputElement): boolean {
  const type = input.type.toLowerCase();
  return ["", "email", "password", "search", "tel", "text", "url"].includes(type);
}

function isTextControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && editableInputType(element);
}

function isContentEditableElement(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.contentEditable === "true")
  );
}

function findEditable(element: Element | null): EditableElement | null {
  if (!element) return null;
  const direct = element.closest("input, textarea, [contenteditable='true']");
  if (!direct) return null;
  if (isTextControl(direct) || isContentEditableElement(direct)) return direct;
  return null;
}

function editableCanMutate(editable: EditableElement | null): boolean {
  if (!editable) return false;
  if (isTextControl(editable)) return !editable.disabled && !editable.readOnly;
  return isContentEditableElement(editable);
}

function editableSelectionText(editable: EditableElement | null): string {
  if (!editable) return "";
  if (isTextControl(editable)) {
    const start = editable.selectionStart ?? 0;
    const end = editable.selectionEnd ?? start;
    if (end <= start) return "";
    return editable.value.slice(start, end);
  }
  return typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? "");
}

function readSelectionText(): string {
  return typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? "");
}

function fileFromElement(element: Element | null): ContextMenuDetails["file"] {
  const target = element?.closest<HTMLElement>("[data-jupiter-file-path]");
  if (!target) return null;
  const path = target.dataset.jupiterFilePath?.trim();
  if (!path) return null;
  const line = target.dataset.jupiterFileLine?.trim();
  return { path, ...(line ? { line } : {}) };
}

function linkFromElement(element: Element | null): ContextMenuDetails["link"] {
  const link = element?.closest<HTMLAnchorElement>("a[href]");
  if (!link) return null;
  const href = link.href || link.getAttribute("href") || "";
  if (!href) return null;
  const label = link.textContent?.trim() || href;
  return { href, label };
}

export function getContextMenuDetails(
  target: EventTarget | null,
  selectionText = readSelectionText(),
): ContextMenuDetails {
  const element = closestElement(target);
  const editable = findEditable(element);
  return {
    editable,
    canEdit: editableCanMutate(editable),
    editableSelection: editableSelectionText(editable),
    selectionText: selectionText.trim(),
    file: fileFromElement(element),
    link: linkFromElement(element),
  };
}

export function contextMenuItemKinds(
  details: ContextMenuDetails,
  hasPreviewFile: boolean,
): ContextMenuItemKind[] {
  const items: ContextMenuItemKind[] = [];
  const hasEditableSelection = details.editableSelection.length > 0;
  const hasLooseSelection = details.selectionText.length > 0;

  if (details.editable) {
    if (hasEditableSelection) items.push("copy");
    if (details.canEdit && hasEditableSelection) items.push("cut");
    if (details.canEdit) items.push("paste");
    items.push("selectAll");
  } else if (hasLooseSelection) {
    items.push("copy");
  }

  if (details.file) {
    if (hasPreviewFile) items.push("previewFile");
    items.push("openFile", "revealFile", "openWith", "copyFilePath");
  }

  if (details.link) {
    items.push("openLink", "copyLink");
  }

  return items;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText) return navigator.clipboard.readText();
  return "";
}

function dispatchInput(editable: EditableElement): void {
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

function replaceTextControlSelection(
  editable: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): void {
  const start = editable.selectionStart ?? editable.value.length;
  const end = editable.selectionEnd ?? start;
  editable.setRangeText(text, start, end, "end");
  dispatchInput(editable);
}

function replaceEditableSelection(editable: EditableElement, text: string): void {
  editable.focus();
  if (isTextControl(editable)) {
    replaceTextControlSelection(editable, text);
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    editable.append(document.createTextNode(text));
    dispatchInput(editable);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  dispatchInput(editable);
}

function selectEditable(editable: EditableElement): void {
  editable.focus();
  if (isTextControl(editable)) {
    editable.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(editable);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

async function openLink(href: string): Promise<void> {
  if (/^(https?|mailto):/i.test(href)) {
    await openUrl(href);
    return;
  }
  await openPath(href);
}

function fileDisplayPath(file: { path: string; line?: string }): string {
  return file.line ? `${file.path}:${file.line}` : file.path;
}

export function AppContextMenu({
  workspaceDir,
  editor,
  onPreviewFile,
}: {
  workspaceDir?: string;
  editor?: string;
  onPreviewFile?: (target: FilePreviewTarget) => void;
}) {
  useLang();
  const [menu, setMenu] = useState<{ anchor: Anchor; details: ContextMenuDetails } | null>(null);
  const [openWithShown, setOpenWithShown] = useState(false);
  const [app, setApp] = useState(editor?.trim() ?? "");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openWithRef = useRef<HTMLInputElement | null>(null);
  const [position, setPosition] = useState(() => positionAppContextMenu({ left: 0, top: 0 }));

  useEffect(() => {
    setApp(editor?.trim() ?? "");
  }, [editor]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const element = closestElement(event.target);
      if (element?.closest(".app-context-menu, .file-action-menu, .session-menu")) return;
      const details = getContextMenuDetails(event.target);
      if (contextMenuItemKinds(details, Boolean(onPreviewFile)).length === 0) return;
      event.preventDefault();
      setOpenWithShown(false);
      setMenu({ anchor: { left: event.clientX, top: event.clientY }, details });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [onPreviewFile]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const onPointer = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest(".app-context-menu")) setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const updatePosition = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      setPosition(
        positionAppContextMenu(
          menu.anchor,
          rect ? { width: rect.width, height: rect.height } : FALLBACK_MENU_SIZE,
        ),
      );
    };

    updatePosition();
    if (openWithShown) openWithRef.current?.focus();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [menu, openWithShown]);

  if (!menu) return null;

  const { details } = menu;
  const kinds = contextMenuItemKinds(details, Boolean(onPreviewFile));
  const file = details.file;
  const link = details.link;
  const close = () => setMenu(null);
  const selectedText = () => details.editableSelection || details.selectionText;

  const run = (kind: ContextMenuItemKind) => async () => {
    if (kind === "openWith") {
      setOpenWithShown((value) => !value);
      return;
    }

    if (kind === "copy") {
      await writeClipboardText(selectedText());
    } else if (kind === "cut" && details.editable && details.canEdit) {
      await writeClipboardText(editableSelectionText(details.editable));
      replaceEditableSelection(details.editable, "");
    } else if (kind === "paste" && details.editable && details.canEdit) {
      replaceEditableSelection(details.editable, await readClipboardText());
    } else if (kind === "selectAll" && details.editable) {
      selectEditable(details.editable);
    } else if (kind === "previewFile" && file) {
      onPreviewFile?.({ path: file.path, line: file.line });
    } else if (kind === "openFile" && file) {
      await openDefaultFile(file.path, workspaceDir);
    } else if (kind === "revealFile" && file) {
      await revealFileInFolder(file.path, workspaceDir);
    } else if (kind === "copyFilePath" && file) {
      await writeClipboardText(fileDisplayPath(file));
    } else if (kind === "openLink" && link) {
      await openLink(link.href);
    } else if (kind === "copyLink" && link) {
      await writeClipboardText(link.href);
    }
    close();
  };

  const submitOpenWith = (event: FormEvent) => {
    event.preventDefault();
    if (file) void openFileWithApp(file.path, workspaceDir, app);
    close();
  };

  const labelFor = (kind: ContextMenuItemKind): string => {
    switch (kind) {
      case "copy":
        return t("contextMenu.copy");
      case "cut":
        return t("contextMenu.cut");
      case "paste":
        return t("contextMenu.paste");
      case "selectAll":
        return t("contextMenu.selectAll");
      case "previewFile":
        return t("fileActions.preview");
      case "openFile":
        return t("fileActions.openDefault");
      case "revealFile":
        return t("fileActions.reveal");
      case "openWith":
        return t("fileActions.openWith");
      case "copyFilePath":
        return t("fileActions.copyPath");
      case "openLink":
        return t("contextMenu.openLink");
      case "copyLink":
        return t("contextMenu.copyLink");
    }
  };

  const iconFor = (kind: ContextMenuItemKind) => {
    switch (kind) {
      case "copy":
      case "copyFilePath":
      case "copyLink":
        return <I.copy size={13} />;
      case "cut":
        return <I.x size={13} />;
      case "paste":
        return <I.download size={13} />;
      case "selectAll":
        return <I.check size={13} />;
      case "previewFile":
      case "openFile":
        return <I.file size={13} />;
      case "revealFile":
        return <I.folder size={13} />;
      case "openWith":
        return <I.pencil size={13} />;
      case "openLink":
        return <I.link size={13} />;
    }
  };
  const fileKinds = new Set<ContextMenuItemKind>([
    "previewFile",
    "openFile",
    "revealFile",
    "openWith",
    "copyFilePath",
  ]);
  const linkKinds = new Set<ContextMenuItemKind>(["openLink", "copyLink"]);

  const menuNode = (
    <div
      ref={menuRef}
      role="menu"
      className="app-context-menu"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {file ? <div className="app-context-title">{fileDisplayPath(file)}</div> : null}
      {kinds.map((kind, index) => {
        const previous = kinds[index - 1];
        const needsDivider =
          index > 0 &&
          ((fileKinds.has(kind) && !fileKinds.has(previous!)) ||
            (linkKinds.has(kind) && !linkKinds.has(previous!)));
        return (
          <div key={kind}>
            {needsDivider ? <div className="app-context-divider" /> : null}
            <button type="button" role="menuitem" onClick={run(kind)}>
              {iconFor(kind)}
              <span>{labelFor(kind)}</span>
            </button>
            {kind === "openWith" && openWithShown && file ? (
              <form className="app-context-open-with" onSubmit={submitOpenWith}>
                <input
                  ref={openWithRef}
                  value={app}
                  onChange={(event) => setApp(event.currentTarget.value)}
                  placeholder={t("fileActions.openWithPlaceholder")}
                />
                <button type="submit">{t("fileActions.open")}</button>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  return createPortal(menuNode, document.body);
}
