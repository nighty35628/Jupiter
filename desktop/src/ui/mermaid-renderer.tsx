import { useEffect, useMemo, useState } from "react";
import { sanitizeHtmlFragment } from "./safe-content";

type MermaidState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

type MermaidModule = {
  default: {
    initialize: (config: { securityLevel: "strict"; startOnLoad: false }) => void;
    render: (id: string, source: string) => Promise<{ svg: string }>;
  };
};

const MERMAID_PACKAGE = "mermaid";

let mermaidLoader: () => Promise<MermaidModule> = () => import(/* @vite-ignore */ MERMAID_PACKAGE);

export function setMermaidLoaderForTest(loader: () => Promise<MermaidModule>): void {
  mermaidLoader = loader;
}

function stableMermaidId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `jupiter-mermaid-${Math.abs(hash).toString(36)}`;
}

export function MermaidBlock({
  source,
  idSeed,
}: {
  source: string;
  idSeed: string;
}): React.ReactElement {
  const [state, setState] = useState<MermaidState>({ status: "loading" });
  const id = useMemo(() => stableMermaidId(`${idSeed}:${source}`), [idSeed, source]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void mermaidLoader()
      .then(async (mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
        const rendered = await mermaid.render(id, source);
        if (!cancelled) {
          setState({ status: "ready", svg: sanitizeHtmlFragment(rendered.svg) });
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (state.status === "error") {
    return (
      <div className="mermaid-block mermaid-block--error">
        <div className="mermaid-error">Mermaid render failed: {state.message}</div>
        <details>
          <summary>Source</summary>
          <pre className="file-preview-text">{source}</pre>
        </details>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="mermaid-block mermaid-block--loading" aria-busy="true">
        Rendering diagram...
      </div>
    );
  }

  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: state.svg }}
      data-mermaid-id={id}
    />
  );
}
