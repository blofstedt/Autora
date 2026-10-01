import React from "react";
import { useState } from "react";
import { Search, Loader2, ChevronRight, X, ShieldAlert } from "lucide-react";

interface PdfSearchProps {
  pdfDocProxy: any;
  onNavigate: (pageNumber: number) => void;
  onOpenFindAndRedactModal?: () => void;
}

export default function PdfSearch({
  pdfDocProxy,
  onNavigate,
  onOpenFindAndRedactModal,
}: PdfSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { page: number; snippet: string }[]
  >([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !pdfDocProxy) return;

    setIsSearching(true);
    setHasSearched(true);
    setSearchResults([]);

    try {
      const numPages = pdfDocProxy.numPages;
      const query = searchQuery.toLowerCase();
      const results: { page: number; snippet: string }[] = [];

      for (let i = 1; i <= numPages; i++) {
        const page = await pdfDocProxy.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ");
        const lowerPageText = pageText.toLowerCase();

        const idx = lowerPageText.indexOf(query);
        if (idx !== -1) {
          // Get a snippet of text around the match
          const start = Math.max(0, idx - 20);
          const end = Math.min(pageText.length, idx + query.length + 20);
          let snippet = pageText.substring(start, end).trim();
          if (start > 0) snippet = "..." + snippet;
          if (end < pageText.length) snippet = snippet + "...";

          results.push({ page: i, snippet });
        }
      }

      setSearchResults(results);
    } catch (err) {
      console.error("Search failed", err);
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
    setHasSearched(false);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          title="Search PDF"
          disabled={!pdfDocProxy}
          className="p-2 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Search className="w-5 h-5" />
        </button>
      ) : (
        <div className="absolute right-0 top-0 w-72 max-w-[calc(100vw-24px)] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden flex flex-col max-h-[80vh]">
          <form
            onSubmit={handleSearch}
            className="flex items-center p-2 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50"
          >
            <input
              type="text"
              autoFocus
              placeholder="Search document..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent border-none outline-none text-sm px-2 text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
            />
            {isSearching ? (
              <Loader2 className="w-4 h-4 text-indigo-500 animate-spin mx-2 shrink-0" />
            ) : (
              <button
                type="submit"
                disabled={!searchQuery.trim()}
                className="p-1.5 text-slate-400 hover:text-indigo-500 cursor-pointer disabled:opacity-50 shrink-0"
              >
                <Search className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={clearSearch}
              className="p-1.5 text-slate-400 hover:text-rose-500 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </form>

          {onOpenFindAndRedactModal && (
            <div className="p-2 border-b border-slate-100 dark:border-slate-700 bg-rose-50/50 dark:bg-rose-950/30">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onOpenFindAndRedactModal();
                }}
                className="w-full py-1.5 px-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Find & Auto-Redact Patterns...</span>
              </button>
            </div>
          )}

          {hasSearched && (
            <div className="overflow-y-auto p-2 space-y-1">
              {searchResults.length === 0 && !isSearching ? (
                <div className="text-xs text-center text-slate-500 py-4">
                  No results found.
                </div>
              ) : (
                searchResults.map((res, i) => (
                  <button
                    key={`${res.page}-${i}`}
                    onClick={() => {
                      onNavigate(res.page);
                      // Optionally close on navigate: setIsOpen(false);
                    }}
                    className="w-full text-left p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors cursor-pointer group flex flex-col"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                        Page {res.page}
                      </span>
                      <ChevronRight className="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <p
                      className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate w-full"
                      title={res.snippet}
                    >
                      {res.snippet}
                    </p>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
