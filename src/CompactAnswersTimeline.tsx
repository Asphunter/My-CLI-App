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
  interrupted?: boolean;
  elapsed?: string;
  actions?: ReactNode;
  changes?: ReactNode;
  footer?: ReactNode;
  renderAnswer: (block: CompactAnswerBlock) => ReactNode;
  renderTraceText: (text: string) => ReactNode;
  renderTraceAction?: (item: CompactTraceEvent) => ReactNode;
};

const COMPACT_TIMELINE_MIN_HEIGHT = 72;
const COMPACT_TIMELINE_MAX_HEIGHT = 360;
const COMPACT_ANSWER_MAX_HEIGHT = 520;

export default function CompactAnswersTimeline({
  className,
  quoteAnchor,
  blocks,
  streaming,
  interrupted = false,
  elapsed,
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
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const answersPanelRef = useRef<HTMLElement>(null);
  const answersListRef = useRef<HTMLDivElement>(null);
  const thinkingPanelRef = useRef<HTMLElement>(null);
  const [panelHeights, setPanelHeights] = useState<{
    answer: number;
    timeline: number;
  }>();
  useLayoutEffect(() => {
    const answersList = answersListRef.current;
    const answersPanel = answersPanelRef.current;
    const thinkingPanel = thinkingPanelRef.current;
    if (!answersList || !answersPanel || !thinkingPanel) return;
    const measure = () => {
      const thinkingViewportLimit = Math.max(
        180,
        Math.min(COMPACT_TIMELINE_MAX_HEIGHT, window.innerHeight - 280),
      );
      const answerViewportLimit = Math.max(
        180,
        Math.min(COMPACT_ANSWER_MAX_HEIGHT, window.innerHeight - 230),
      );
      const answerHeading = answersPanel.querySelector<HTMLElement>(
        ".compact-answer-panel-heading",
      );
      const answerHeight = Math.max(
        42,
        Math.min(
          answerViewportLimit,
          (answerHeading?.offsetHeight ?? 29) + answersList.scrollHeight + 2,
        ),
      );
      const heading = thinkingPanel.querySelector<HTMLElement>(
        ".trace-panel-heading",
      );
      const thinkingList = thinkingPanel.querySelector<HTMLElement>(
        ".compact-thinking-list, .trace-thinking-empty",
      );
      const thinkingHeight =
        (heading?.offsetHeight ?? 29) + (thinkingList?.scrollHeight ?? 42) + 8;
      const expandedThinkingHeight = Math.max(
        COMPACT_TIMELINE_MIN_HEIGHT,
        Math.min(thinkingViewportLimit, Math.ceil(thinkingHeight)),
      );
      const next = {
        answer: Math.ceil(answerHeight),
        timeline: thinkingExpanded
          ? Math.max(answerHeight, expandedThinkingHeight)
          : answerHeight,
      };
      setPanelHeights((current) =>
        current?.answer === next.answer && current.timeline === next.timeline
          ? current
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(answersList);
    observer.observe(answersPanel);
    observer.observe(thinkingPanel);
    for (const child of thinkingPanel.children) observer.observe(child);
    return () => observer.disconnect();
  }, [
    expandedDetailId,
    expandedTechnicalId,
    selected?.text,
    thinkingExpanded,
    visibleTrace,
  ]);
  useEffect(() => {
    setExpandedTechnicalId(null);
    setExpandedDetailId(null);
    setThinkingExpanded(true);
  }, [selected?.id]);

  return (
    <article
      className={className}
      data-quote-selectable="true"
      data-quote-anchor={quoteAnchor}
      aria-label="Válasz és gondolkodás"
    >
      <div
        className={`compact-answers-layout${selected?.live ? " is-current" : ""}`}
        style={
          panelHeights
            ? ({
                "--compact-answer-height": `${panelHeights.answer}px`,
                "--compact-timeline-height": `${panelHeights.timeline}px`,
              } as CSSProperties)
            : undefined
        }
      >
        <section
          className="compact-answers-panel"
          aria-label="Válasz"
          ref={answersPanelRef}
        >
          <div className="trace-panel-heading compact-answer-panel-heading">
            <strong>VÁLASZ</strong>
            <span
              className={`compact-answer-state${streaming ? " is-running" : interrupted ? " is-interrupted" : " is-complete"}`}
              role="status"
              aria-label={
                streaming
                  ? "A válasz készül"
                  : interrupted
                    ? "A válasz megszakítva"
                    : "A válasz elkészült"
              }
            >
              {streaming ? (
                <span className="trace-answer-spinner" aria-hidden="true" />
              ) : interrupted ? (
                <>
                  <span className="compact-answer-interrupted-icon" aria-hidden="true">
                    ■
                  </span>
                  <span className="compact-answer-interrupted-label">
                    MEGSZAKÍTVA
                  </span>
                </>
              ) : (
                <span className="compact-answer-complete-icon" aria-hidden="true">
                  ✓
                </span>
              )}
              {elapsed && <time>{elapsed}</time>}
            </span>
            {actions}
          </div>
          <div className="compact-answers-list" ref={answersListRef}>
            {selected && (
              <article
                className={`compact-answer-block${selected.pending ? " is-pending" : ""}`}
              >
                {selected.pending ? (
                  <div className="compact-answer-pending-space" aria-hidden="true" />
                ) : (
                  <div className="compact-answer-block-content">
                    {renderAnswer(selected)}
                  </div>
                )}
              </article>
            )}
          </div>
        </section>
        <section
          className={`compact-thinking-panel${thinkingExpanded ? "" : " is-collapsed"}`}
          aria-label="Gondolkodás menete"
          ref={thinkingPanelRef}
        >
          <div className="trace-panel-heading trace-panel-heading-thinking">
            <strong>GONDOLKODÁS MENETE</strong>
            <button
              type="button"
              className="compact-thinking-height-toggle"
              onClick={() => setThinkingExpanded((current) => !current)}
              aria-expanded={thinkingExpanded}
              title={
                thinkingExpanded
                  ? "Gondolkodás menetének összecsukása"
                  : "Gondolkodás menetének lenyitása"
              }
            >
              <span className="trace-internal-caret" aria-hidden="true">
                {thinkingExpanded ? "▴" : "▾"}
              </span>
              {thinkingExpanded ? "ÖSSZECSUK" : "LENYIT"}
            </button>
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
