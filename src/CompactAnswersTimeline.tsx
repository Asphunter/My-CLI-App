import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  buildCompactTraceSections,
  type CompactAnswerBlock,
  type CompactTraceSection,
  type CompactTraceEvent,
} from "./compactAnswerTimeline";

type CompactAnswersTimelineProps = {
  className: string;
  quoteAnchor: string;
  blocks: CompactAnswerBlock[];
  streaming: boolean;
  statusLabel: string;
  elapsed?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  changes?: ReactNode;
  footer?: ReactNode;
  renderAnswer: (block: CompactAnswerBlock) => ReactNode;
  renderTraceText: (text: string) => ReactNode;
  renderTraceAction?: (item: CompactTraceEvent) => ReactNode;
};

export default function CompactAnswersTimeline({
  className,
  quoteAnchor,
  blocks,
  streaming,
  statusLabel,
  elapsed,
  badge,
  actions,
  changes,
  footer,
  renderAnswer,
  renderTraceText,
  renderTraceAction,
}: CompactAnswersTimelineProps) {
  const selected = blocks.at(-1);
  const visibleTrace = useMemo(
    () =>
      buildCompactTraceSections(
        (selected?.trace ?? []).filter((item) => item.summary?.trim()),
      ),
    [selected],
  );
  const [expandedTechnicalId, setExpandedTechnicalId] = useState<string | null>(
    null,
  );
  const [expandedDetailId, setExpandedDetailId] = useState<string | null>(null);
  const answersPanelRef = useRef<HTMLElement>(null);
  const [answersPanelHeight, setAnswersPanelHeight] = useState<number>();
  useLayoutEffect(() => {
    const panel = answersPanelRef.current;
    if (!panel) return;
    const measure = () => {
      const next = Math.ceil(panel.getBoundingClientRect().height);
      setAnswersPanelHeight((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setExpandedTechnicalId(null);
    setExpandedDetailId(null);
  }, [selected?.id]);

  return (
    <article
      className={className}
      data-quote-selectable="true"
      data-quote-anchor={quoteAnchor}
      aria-label="Válasz és gondolkodás"
    >
      <div className="compact-answer-header">
        <strong>VÁLASZ</strong>
        {badge}
        <span>{statusLabel}</span>
        {elapsed && <time>{elapsed}</time>}
        {actions}
      </div>
      <div
        className="compact-answers-layout"
        style={
          answersPanelHeight
            ? ({
                "--compact-answers-height": `${answersPanelHeight}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <section
          className={`compact-answers-panel${selected?.live ? " is-current" : ""}`}
          aria-label="Válasz"
          ref={answersPanelRef}
        >
          <div className="compact-answers-list">
            {selected && (
              <article
                className={`compact-answer-block${selected.pending ? " is-pending" : ""}`}
              >
                {selected.pending ? (
                  <div className="compact-answer-pending-row">
                    <span className="trace-answer-spinner" aria-hidden="true" />
                    <p className="compact-answer-pending-text">
                      A válasz készül…
                    </p>
                  </div>
                ) : (
                  <div className="compact-answer-block-content">
                    {renderAnswer(selected)}
                  </div>
                )}
              </article>
            )}
          </div>
        </section>
        <section className="compact-thinking-panel" aria-label="Gondolkodás menete">
          <div className="trace-panel-heading trace-panel-heading-thinking">
            <strong>GONDOLKODÁS MENETE</strong>
          </div>
          {visibleTrace.length > 0 ? (
            <ul className="compact-thinking-list">
              {visibleTrace.map((section: CompactTraceSection) =>
                section.kind === "primary" ? (
                  <li
                    className={`trace-thinking-item compact-primary-trace${section.item.presentation === "narrative" ? " is-narrative" : " is-important"}`}
                    key={section.id}
                  >
                    {section.item.presentation === "narrative" ? (
                      <>
                        <span className="trace-thinking-bullet">•</span>
                        <p>{renderTraceText(section.item.summary ?? "")}</p>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="compact-primary-toggle"
                        disabled={
                          !section.item.detail ||
                          section.item.detail === section.item.summary
                        }
                        onClick={() =>
                          setExpandedDetailId((current) =>
                            current === section.item.id ? null : section.item.id,
                          )
                        }
                        aria-expanded={expandedDetailId === section.item.id}
                      >
                        <span className="trace-thinking-bullet">•</span>
                        <span className="compact-technical-summary">
                          {section.item.summary ?? ""}
                        </span>
                        {section.item.detail &&
                          section.item.detail !== section.item.summary && (
                          <span className="trace-internal-caret" aria-hidden="true">
                            {expandedDetailId === section.item.id ? "▾" : "▸"}
                          </span>
                          )}
                      </button>
                    )}
                    {renderTraceAction?.(section.item)}
                    {section.item.presentation !== "narrative" &&
                      expandedDetailId === section.item.id && (
                        <div className="compact-technical-detail">
                          {section.item.detail ?? ""}
                        </div>
                      )}
                  </li>
                ) : (
                  <li className="compact-technical-section" key={section.id}>
                    <button
                      type="button"
                      className="compact-technical-toggle"
                      onClick={() =>
                        setExpandedTechnicalId((current) =>
                          current === section.id ? null : section.id,
                        )
                      }
                      aria-expanded={expandedTechnicalId === section.id}
                    >
                      <span className="trace-thinking-bullet">•</span>
                      <span className="compact-technical-label">
                        {section.label}
                      </span>
                      <span className="trace-internal-caret" aria-hidden="true">
                        {expandedTechnicalId === section.id ? "▾" : "▸"}
                      </span>
                    </button>
                    {expandedTechnicalId === section.id && (
                      <ul className="compact-technical-details">
                        {section.items.map((item) => {
                          const detail = item.detail?.trim() ?? "";
                          const summary = item.summary?.trim() ?? "";
                          const expandable = Boolean(detail && detail !== summary);
                          const detailOpen = expandedDetailId === item.id;
                          return (
                            <li className="compact-technical-item" key={item.id}>
                              <div className="compact-technical-item-line">
                                <button
                                  type="button"
                                  className="compact-technical-item-toggle"
                                  disabled={!expandable}
                                  onClick={() =>
                                    expandable &&
                                    setExpandedDetailId((current) =>
                                      current === item.id ? null : item.id,
                                    )
                                  }
                                  aria-expanded={expandable ? detailOpen : undefined}
                                  title={expandable ? "Teljes technikai részlet" : undefined}
                                >
                                  <span className="compact-technical-kind" aria-hidden="true">
                                    {item.presentation === "command"
                                      ? "$"
                                      : item.presentation === "file"
                                        ? "F"
                                        : item.presentation === "tool"
                                          ? "T"
                                          : item.presentation === "status"
                                            ? "!"
                                            : "·"}
                                  </span>
                                  <span className="compact-technical-summary">
                                    {summary}
                                  </span>
                                  {expandable && (
                                    <span className="trace-internal-caret" aria-hidden="true">
                                      {detailOpen ? "▾" : "▸"}
                                    </span>
                                  )}
                                </button>
                                {renderTraceAction?.(item)}
                              </div>
                              {detailOpen && (
                                <div className="compact-technical-detail">
                                  {detail}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ),
              )}
            </ul>
          ) : (
            <div className="trace-thinking-empty">
              <span className="trace-thinking-empty-text">
                {selected?.pending && streaming
                  ? "A következő válasz előzményei itt jelennek meg."
                  : "Ehhez a válaszhoz nem érkezett külön gondolkodási összefoglaló."}
              </span>
            </div>
          )}
        </section>
      </div>
      {changes}
      {footer}
    </article>
  );
}
