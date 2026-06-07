import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { I } from "../icons";
import type {
  SourceSearchResult,
  SourceSearchResultsEvent,
} from "../protocol";
import type { LibrarySource, LibrarySourceInput } from "./context-panel";

const INITIAL_RESULT_LIMIT = 6;
const LOAD_MORE_STEP = 4;
const MAX_RESULT_LIMIT = 30;

type SourceSearchPopoverProps = {
  open: boolean;
  sources: LibrarySource[];
  sourceSearch: SourceSearchResultsEvent | null;
  onClose: () => void;
  onSourceSearch: (query: string, nonce: number, topK: number) => void;
  onAddSource: (source: LibrarySourceInput) => void;
  onOpenWebSource: (url: string) => void;
  onPreviewFileSource: (path: string) => void;
  onRevealFileSource: (path: string) => void;
};

export function SourceSearchPopover({
  open,
  sources,
  sourceSearch,
  onClose,
  onSourceSearch,
  onAddSource,
  onOpenWebSource,
  onPreviewFileSource,
  onRevealFileSource,
}: SourceSearchPopoverProps) {
  const [query, setQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState<{
    query: string;
    nonce: number;
    topK: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nonceRef = useRef(0);
  const activeQuery = activeSearch?.query.trim().toLowerCase() ?? "";

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const matchingSavedSources = useMemo(() => {
    if (!activeQuery) return [];
    const limit = activeSearch?.topK ?? INITIAL_RESULT_LIMIT;
    return sources
      .filter((source) =>
        [
          source.title,
          source.url ?? "",
          source.path ?? "",
          source.snippet ?? "",
          source.contentText ?? "",
          source.contentError ?? "",
        ]
          .join("\n")
          .toLowerCase()
          .includes(activeQuery),
      )
      .slice(0, limit);
  }, [activeQuery, activeSearch?.topK, sources]);

  const activeSearchResults =
    activeSearch && sourceSearch?.nonce === activeSearch.nonce
      ? sourceSearch
      : null;
  const webResults = activeSearchResults?.results ?? [];
  const webPending = Boolean(
    activeSearch && sourceSearch?.nonce !== activeSearch.nonce,
  );
  const addedSourceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const source of sources) {
      if (source.kind === "web" && source.url) keys.add(`web:${source.url}`);
      if (source.kind === "file" && source.path) keys.add(`file:${source.path}`);
    }
    return keys;
  }, [sources]);

  if (!open) return null;

  const runSearch = (topK = INITIAL_RESULT_LIMIT) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const nonce = ++nonceRef.current;
    setActiveSearch({ query: trimmed, nonce, topK });
    onSourceSearch(trimmed, nonce, topK);
  };
  const loadMore = () => {
    if (!activeSearch) return;
    const nextTopK = Math.min(
      MAX_RESULT_LIMIT,
      activeSearch.topK + LOAD_MORE_STEP,
    );
    const nonce = ++nonceRef.current;
    setActiveSearch({
      query: activeSearch.query,
      nonce,
      topK: nextTopK,
    });
    onSourceSearch(activeSearch.query, nonce, nextTopK);
  };
  const addWebResult = (result: SourceSearchResult) => {
    onAddSource({
      kind: "web",
      title: result.title || result.url,
      url: result.url,
      snippet: result.snippet,
    });
  };
  const openSavedSource = (source: LibrarySource) => {
    if (source.kind === "web" && source.url) {
      onOpenWebSource(source.url);
      return;
    }
    if (source.kind === "file" && source.path) {
      onPreviewFileSource(source.path);
    }
  };
  const canLoadMore = Boolean(
    activeSearch &&
      !webPending &&
      !activeSearchResults?.error &&
      activeSearch.topK < MAX_RESULT_LIMIT,
  );

  return (
    <div
      className="source-search-popover"
      role="dialog"
      aria-label={t("contextPanel.library.searchTitle")}
    >
      <div className="source-search-head">
        <div>
          <div className="source-search-title">
            {t("contextPanel.library.searchTitle")}
          </div>
          <div className="source-search-subtitle">
            {t("contextPanel.library.desc")}
          </div>
        </div>
        <button
          type="button"
          className="source-search-close"
          aria-label={t("contextPanel.library.closeSearch")}
          title={t("contextPanel.library.closeSearch")}
          onClick={onClose}
        >
          <I.x size={14} />
        </button>
      </div>

      <form
        className="ctx-library-search source-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <label className="ctx-library-search-box">
          <I.search size={14} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("contextPanel.library.searchPlaceholder")}
          />
        </label>
        <button type="submit" disabled={!query.trim()}>
          {t("contextPanel.library.searchButton")}
        </button>
      </form>

      {activeSearch ? (
        <div className="source-search-body">
          <SourceSearchSection
            title={t("contextPanel.library.savedSources")}
            pending={false}
            empty={matchingSavedSources.length === 0}
          >
            {matchingSavedSources.map((source) => (
              <div className="ctx-library-result" key={source.id}>
                <span className="ctx-library-result-icon">
                  {source.kind === "web" ? (
                    <I.globe size={14} />
                  ) : (
                    <I.file size={14} />
                  )}
                </span>
                <button
                  type="button"
                  className="ctx-library-result-copy ctx-library-result-open"
                  aria-label={t("contextPanel.library.openSource", {
                    title: source.title,
                  })}
                  onClick={() => openSavedSource(source)}
                >
                  <strong>{source.title}</strong>
                  <span>{source.kind === "web" ? source.url : source.path}</span>
                  {source.snippet ? <p>{source.snippet}</p> : null}
                </button>
                <div className="ctx-library-result-actions">
                  {source.kind === "file" && source.path ? (
                    <button
                      type="button"
                      aria-label={t("contextPanel.library.showInFolder", {
                        title: source.path,
                      })}
                      title={t("contextPanel.library.showInFolder", {
                        title: source.path,
                      })}
                      onClick={() => onRevealFileSource(source.path!)}
                    >
                      <I.folder size={13} />
                    </button>
                  ) : null}
                  <button type="button" disabled>
                    {t("contextPanel.library.added")}
                  </button>
                </div>
              </div>
            ))}
          </SourceSearchSection>

          <SourceSearchSection
            title={t("contextPanel.library.webResults")}
            pending={webPending}
            error={activeSearchResults?.error}
            empty={
              !webPending &&
              !activeSearchResults?.error &&
              webResults.length === 0
            }
          >
            {webResults.map((result) => {
              const title = result.title || result.url;
              const added = addedSourceKeys.has(`web:${result.url}`);
              return (
                <div className="ctx-library-result" key={result.url}>
                  <span className="ctx-library-result-icon">
                    <I.globe size={14} />
                  </span>
                  <button
                    type="button"
                    className="ctx-library-result-copy ctx-library-result-open"
                    aria-label={t("contextPanel.library.openSource", {
                      title,
                    })}
                    onClick={() => onOpenWebSource(result.url)}
                  >
                    <strong>{title}</strong>
                    <span>{result.url}</span>
                    {result.snippet ? <p>{result.snippet}</p> : null}
                  </button>
                  <div className="ctx-library-result-actions">
                    <button
                      type="button"
                      disabled={added}
                      onClick={() => addWebResult(result)}
                    >
                      {added
                        ? t("contextPanel.library.added")
                        : t("contextPanel.library.addSource")}
                    </button>
                  </div>
                </div>
              );
            })}
          </SourceSearchSection>
          {canLoadMore ? (
            <button
              type="button"
              className="source-search-load-more"
              onClick={loadMore}
            >
              {t("contextPanel.library.loadMore")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceSearchSection({
  title,
  pending,
  error,
  empty,
  children,
}: {
  title: string;
  pending: boolean;
  error?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ctx-library-result-section">
      <div className="ctx-library-section-title">{title}</div>
      {pending ? (
        <div className="ctx-library-status">{t("contextPanel.searching")}</div>
      ) : error ? (
        <div className="ctx-library-status" data-tone="error">
          {t("contextPanel.library.searchError", { error })}
        </div>
      ) : empty ? (
        <div className="ctx-library-status">
          {t("contextPanel.library.noSearchResults")}
        </div>
      ) : (
        <div className="ctx-library-result-list">{children}</div>
      )}
    </section>
  );
}
