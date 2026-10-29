"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders wiki text. Raw HTML in the text is shown as text, never run, and
 * unsafe link types (javascript: etc.) are stripped, so a page can't inject
 * scripts. External links open in a new tab.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="wiki-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // A link whose address was removed as unsafe shows as plain text.
          a: ({ href, children: c }) =>
            !href ? <span>{c}</span> : href.startsWith("/") || href.startsWith("#") ? <a href={href}>{c}</a> : <a href={href} target="_blank" rel="noopener noreferrer">{c}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
