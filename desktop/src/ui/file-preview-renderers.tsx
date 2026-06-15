import { useEffect, useRef, useState } from "react";
import { Markdown } from "../Markdown";

export type PreviewRendererKind = "text" | "markdown" | "image" | "pdf" | "docx" | "unsupported";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function previewRendererKind(path: string, mime?: string | null): PreviewRendererKind {
  const clean = path.split(/[?#]/)[0]?.toLowerCase() ?? path.toLowerCase();
  const normalizedMime = mime?.toLowerCase() ?? "";
  if (clean.endsWith(".pdf") || normalizedMime === "application/pdf") return "pdf";
  if (clean.endsWith(".docx") || normalizedMime === DOCX_MIME) return "docx";
  if (clean.endsWith(".doc")) return "unsupported";
  if (/\.(md|mdx|markdown)$/i.test(clean) || normalizedMime === "text/markdown") {
    return "markdown";
  }
  if (normalizedMime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(clean)) {
    return "image";
  }
  return "text";
}

export function FilePreviewRenderer({
  path,
  url,
  mime,
  text,
  loadBytes,
}: {
  path: string;
  url: string;
  mime?: string | null;
  text?: string | null;
  loadBytes?: () => Promise<Uint8Array>;
}): React.ReactElement {
  const kind = previewRendererKind(path, mime);
  if (kind === "pdf") return <PdfPreview url={url} />;
  if (kind === "docx") return <DocxPreview url={url} loadBytes={loadBytes} />;
  if (kind === "markdown") {
    return (
      <div className="file-preview-markdown">
        <Markdown source={text ?? ""} />
      </div>
    );
  }
  if (kind === "image") return <img className="file-preview-image" src={url} alt={path} />;
  if (kind === "unsupported") {
    return (
      <div className="ctx-empty">
        <div>Document preview is not supported for this file type.</div>
        <div>Open it in the default application instead.</div>
      </div>
    );
  }
  return <pre className="file-preview-text">{text ?? ""}</pre>;
}

function PdfPreview({ url }: { url: string }): React.ReactElement {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; Document: React.ComponentType<any>; Page: React.ComponentType<any> }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void import("react-pdf")
      .then((mod) => {
        mod.pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        if (!cancelled) setState({ status: "ready", Document: mod.Document, Page: mod.Page });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="file-preview-rich file-preview-rich--loading">
        <div>PDF preview</div>
        <div>Loading...</div>
      </div>
    );
  }
  if (state.status === "error") {
    return <div className="ctx-empty">PDF preview failed: {state.message}</div>;
  }
  const { Document, Page } = state;
  return (
    <div className="file-preview-rich file-preview-pdf">
      <Document file={url} loading={<div>Loading PDF...</div>} error={<div>PDF preview failed.</div>}>
        <Page pageNumber={1} width={320} renderAnnotationLayer={false} renderTextLayer={false} />
      </Document>
    </div>
  );
}

function DocxPreview({
  url,
  loadBytes,
}: {
  url: string;
  loadBytes?: () => Promise<Uint8Array>;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const target = ref.current;
    if (!target) return;
    target.replaceChildren();
    void Promise.all([
      import("docx-preview"),
      loadBytes
        ? loadBytes()
        : fetch(url).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return new Uint8Array(await response.arrayBuffer());
          }),
    ])
      .then(async ([docx, bytes]) => {
        if (cancelled) return;
        await docx.renderAsync(bytes, target, undefined, {
          inWrapper: true,
          ignoreWidth: true,
          ignoreHeight: true,
          className: "file-preview-docx-body",
        });
        if (!cancelled) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [url, loadBytes]);

  return (
    <div className="file-preview-rich file-preview-docx">
      {status === "loading" ? <div className="ctx-empty">Loading DOCX preview...</div> : null}
      {status === "error" ? <div className="ctx-empty">DOCX preview failed.</div> : null}
      <div ref={ref} hidden={status !== "ready"} />
    </div>
  );
}
