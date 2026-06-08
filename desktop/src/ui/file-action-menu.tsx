import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { FilePreviewTarget } from "../file-preview";
import { openDefaultFile, openFileWithApp, revealFileInFolder } from "../file-preview";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { FloatingLayer } from "./floating-layer";

type Anchor = { left: number; top: number };
type MenuSize = { width: number; height: number };
type ViewportSize = { width: number; height: number };

const MENU_MARGIN = 8;
const FALLBACK_MENU_SIZE: MenuSize = { width: 236, height: 224 };

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

export function positionFileActionMenu(
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

export function FileActionMenu({
  anchor,
  path,
  line,
  workspaceDir,
  editor,
  onPreviewFile,
  onClose,
}: {
  anchor: Anchor;
  path: string;
  line?: string;
  workspaceDir?: string;
  editor?: string;
  onPreviewFile?: (target: FilePreviewTarget) => void;
  onClose: () => void;
}) {
  useLang();
  const [openWithShown, setOpenWithShown] = useState(false);
  const [app, setApp] = useState(editor?.trim() ?? "");
  const openWithRef = useRef<HTMLInputElement | null>(null);
  const positionedAnchor = useMemo(
    () => positionFileActionMenu(anchor),
    [anchor.left, anchor.top],
  );

  useEffect(() => {
    if (openWithShown) openWithRef.current?.focus();
  }, [openWithShown]);

  const preview = () => {
    onPreviewFile?.({ path, line });
    onClose();
  };
  const openDefault = () => {
    void openDefaultFile(path, workspaceDir);
    onClose();
  };
  const reveal = () => {
    void revealFileInFolder(path, workspaceDir);
    onClose();
  };
  const copy = () => {
    void navigator.clipboard?.writeText(line ? `${path}:${line}` : path);
    onClose();
  };
  const submitOpenWith = (event: FormEvent) => {
    event.preventDefault();
    void openFileWithApp(path, workspaceDir, app);
    onClose();
  };

  return (
    <FloatingLayer anchor={positionedAnchor} open onClose={onClose}>
      <div role="menu" className="file-action-menu">
        <div className="file-action-title">{path}</div>
        <button type="button" onClick={preview} disabled={!onPreviewFile}>
          <I.file size={13} />
          <span>{t("fileActions.preview")}</span>
        </button>
        <button type="button" onClick={openDefault}>
          <I.link size={13} />
          <span>{t("fileActions.openDefault")}</span>
        </button>
        <button type="button" onClick={reveal}>
          <I.folder size={13} />
          <span>{t("fileActions.reveal")}</span>
        </button>
        <button type="button" onClick={() => setOpenWithShown((v) => !v)}>
          <I.pencil size={13} />
          <span>{t("fileActions.openWith")}</span>
        </button>
        {openWithShown ? (
          <form className="file-action-open-with" onSubmit={submitOpenWith}>
            <input
              ref={openWithRef}
              value={app}
              onChange={(event) => setApp(event.currentTarget.value)}
              placeholder={t("fileActions.openWithPlaceholder")}
            />
            <button type="submit">{t("fileActions.open")}</button>
          </form>
        ) : null}
        <button type="button" onClick={copy}>
          <I.copy size={13} />
          <span>{t("fileActions.copyPath")}</span>
        </button>
      </div>
    </FloatingLayer>
  );
}
