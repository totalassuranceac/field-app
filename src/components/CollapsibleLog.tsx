import { ReactNode } from "react";

/**
 * Compact collapsible lists for logs / history throughout the app.
 * Uses native <details> so items stay collapsed until tapped.
 */

export function CollapsibleSection({
  title,
  count,
  hint,
  children,
  defaultOpen = false,
  className = "",
}: {
  title: ReactNode;
  count?: number;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={`collapsible-section ${className}`.trim()} open={defaultOpen || undefined}>
      <summary className="collapsible-section-summary">
        <span className="collapsible-chevron" aria-hidden />
        <span className="collapsible-section-title">{title}</span>
        {count != null && count > 0 ? (
          <span className="collapsible-section-count">{count}</span>
        ) : null}
        {hint ? <span className="muted collapsible-section-hint">{hint}</span> : null}
      </summary>
      <div className="collapsible-section-body">{children}</div>
    </details>
  );
}

export function LogList({
  children,
  className = "",
  empty,
}: {
  children: ReactNode;
  className?: string;
  empty?: ReactNode;
}) {
  const hasKids = Array.isArray(children)
    ? children.filter(Boolean).length > 0
    : Boolean(children);
  if (!hasKids && empty != null) {
    return <div className="muted empty log-list-empty">{empty}</div>;
  }
  return <ul className={`log-list ${className}`.trim()}>{children}</ul>;
}

export function LogItem({
  summary,
  children,
  defaultOpen = false,
  tone,
  className = "",
}: {
  /** One compact line always visible */
  summary: ReactNode;
  /** Expanded details */
  children?: ReactNode;
  defaultOpen?: boolean;
  /** optional: urgent | overdue | done | ok | warn | bad */
  tone?: string;
  className?: string;
}) {
  const hasBody = children != null && children !== false;
  if (!hasBody) {
    return (
      <li className={`log-item log-item-static ${tone ? `tone-${tone}` : ""} ${className}`.trim()}>
        <div className="log-item-summary log-item-summary-static">{summary}</div>
      </li>
    );
  }
  return (
    <li className={`log-item ${tone ? `tone-${tone}` : ""} ${className}`.trim()}>
      <details open={defaultOpen || undefined}>
        <summary className="log-item-summary">
          <span className="collapsible-chevron" aria-hidden />
          <span className="log-item-summary-main">{summary}</span>
        </summary>
        <div className="log-item-body">{children}</div>
      </details>
    </li>
  );
}
