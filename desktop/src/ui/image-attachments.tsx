import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type ImageAttachment, isImageAttachment } from "../../../src/attachments/types";
import { getLang } from "../i18n";
import { I } from "../icons";
import { readImageDraft, subscribeImageDraft, writeImageDraft } from "./image-draft-store";

export async function importImage(path: string, tabId: string): Promise<ImageAttachment> {
  const requestId = crypto.randomUUID();
  let finish: (image: ImageAttachment) => void;
  let fail: (error: Error) => void;
  const result = new Promise<ImageAttachment>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const stop = await listen<{ data: string }>("rpc:event", ({ payload }) => {
    try {
      const event = JSON.parse(payload.data);
      if (event.type !== "$attachment_result" || event.requestId !== requestId) return;
      if (isImageAttachment(event.attachment)) finish(event.attachment);
      else fail(new Error(event.error || "Image import failed"));
    } catch {
      /* Other runtime events do not belong to this request. */
    }
  });
  const timer = setTimeout(() => fail(new Error("Image import timed out; please retry")), 90_000);
  try {
    // Attach a rejection handler before awaiting the transport acknowledgement.
    const sent = invoke("rpc_send", {
      line: JSON.stringify({ cmd: "attachment_import", path, requestId, tabId }),
    }).catch((error) => fail(error));
    const image = await result;
    await sent;
    return image;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

export async function imagePreviewUrl(id: string, thumbnail = true): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid image id");
  if (document.documentElement.dataset.runtime === "web")
    return `/api/images/${id}${thumbnail ? "?thumbnail=1" : ""}`;
  return convertFileSrc(await invoke<string>("image_attachment_path", { id, thumbnail }));
}

export function useImageDraft(key: string) {
  const current = useSyncExternalStore(
    useCallback((listener) => subscribeImageDraft(key, listener), [key]),
    useCallback(() => readImageDraft(key), [key]),
  );
  const setText = useCallback(
    (value: React.SetStateAction<string>) =>
      writeImageDraft(key, (draft) => ({
        ...draft,
        text: typeof value === "function" ? value(draft.text) : value,
      })),
    [key],
  );
  const setImages = useCallback(
    (value: React.SetStateAction<ImageAttachment[]>) =>
      writeImageDraft(key, (draft) => ({
        ...draft,
        attachments: typeof value === "function" ? value(draft.attachments ?? []) : value,
      })),
    [key],
  );
  return {
    draft: current.text,
    setDraft: setText,
    images: current.attachments ?? [],
    setImages,
    pending: current.pending,
  };
}

export function ImageAttachmentView({
  image,
  onRemove,
}: { image: ImageAttachment; onRemove?: () => void }) {
  const zh = getLang() === "zh-CN";
  const [src, setSrc] = useState("");
  const [full, setFull] = useState("");
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let live = true;
    imagePreviewUrl(image.id).then(
      (url) => {
        if (live) {
          setSrc(url);
          setError(false);
        }
      },
      () => {
        if (live) setError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [image.id]);
  return (
    <div className="image-attachment">
      <button
        type="button"
        className="image-attachment-preview"
        title={`${image.name} · ${image.width} × ${image.height}${image.staticFrame ? " · First frame" : ""}`}
        onClick={() => {
          dialog.current?.showModal();
          imagePreviewUrl(image.id, false).then(setFull, () => setError(true));
        }}
        aria-label={`${zh ? "预览" : "Preview"} ${image.name}`}
      >
        {src && !error ? (
          <img
            src={src}
            alt={image.name}
            loading="lazy"
            decoding="async"
            onError={() => setError(true)}
          />
        ) : (
          <span>
            {error
              ? zh
                ? "图片不可用"
                : "Image unavailable"
              : zh
                ? "图片加载中"
                : "Loading image"}
          </span>
        )}
        <span className="image-attachment-name">{image.name}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="image-attachment-remove"
          aria-label={`${zh ? "移除" : "Remove"} ${image.name}`}
          title={zh ? "移除图片" : "Remove image"}
          onClick={onRemove}
        >
          <I.x size={12} />
        </button>
      )}
      <dialog
        className="image-attachment-dialog"
        ref={dialog}
        aria-label={image.name}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          dialog.current?.close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="image-attachment-toolbar">
          <span>{image.name}</span>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label={zh ? "关闭图片" : "Close image"}
          >
            <I.x size={18} />
          </button>
        </div>
        {full && !error ? (
          <img src={full} alt={image.name} onError={() => setError(true)} />
        ) : (
          <p>{error ? "Image unavailable" : "Loading image"}</p>
        )}
      </dialog>
    </div>
  );
}
