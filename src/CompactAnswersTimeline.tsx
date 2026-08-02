import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
const COMPACT_ANSWER_MIN_WIDTH = 260;
const COMPACT_THINKING_MIN_WIDTH = 240;

type PanelResizeKind = "columns" | "height";

type PanelResizeDrag = {
  kind: PanelResizeKind;
  pointerId: number;
  startClient: number;
  startValue: number;
  scale: number;
  min: number;
  max: number;
};

const clampPanelSize = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

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
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [thinkingClosing, setThinkingClosing] = useState(false);
  const [answerColumnWidth, setAnswerColumnWidth] = useState<number>();
  const [manualPanelHeight, setManualPanelHeight] = useState<number>();
  const [resizing, setResizing] = useState<PanelResizeKind | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const answersPanelRef = useRef<HTMLElement>(null);
  const answersListRef = useRef<HTMLDivElement>(null);
  const thinkingPanelRef = useRef<HTMLElement>(null);
  const changesSlotRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<PanelResizeDrag | null>(null);
  const [panelHeights, setPanelHeights] = useState<{
    answer: number;
    timeline: number;
    changes: number;
  }>();
  useLayoutEffect(() => {
    const answersList = answersListRef.current;
    const answersPanel = answersPanelRef.current;
    const thinkingPanel = thinkingPanelRef.current;
    const changesSlot = changesSlotRef.current;
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
      const changesHeight = changesSlot ? Math.ceil(changesSlot.offsetHeight) : 0;
      const answerWithChangesHeight = Math.ceil(answerHeight) + changesHeight;
      const next = {
        answer: Math.ceil(answerHeight),
        timeline: thinkingExpanded || thinkingClosing
          ? Math.max(answerWithChangesHeight, expandedThinkingHeight)
          : answerWithChangesHeight,
        changes: changesHeight,
      };
      setPanelHeights((current) =>
        current?.answer === next.answer &&
        current.timeline === next.timeline &&
        current.changes === next.changes
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
    if (changesSlot) observer.observe(changesSlot);
    for (const child of thinkingPanel.children) observer.observe(child);
    return () => observer.disconnect();
  }, [
    expandedDetailId,
    expandedTechnicalId,
    selected?.text,
    thinkingExpanded,
    thinkingClosing,
    visibleTrace,
    Boolean(changes),
  ]);
  useEffect(() => {
    setExpandedTechnicalId(null);
    setExpandedDetailId(null);
    setThinkingExpanded(false);
    setThinkingClosing(false);
    setAnswerColumnWidth(undefined);
    setManualPanelHeight(undefined);
  }, [selected?.id]);

  useEffect(() => {
    if (!thinkingClosing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setThinkingClosing(false);
      return;
    }
    const timeout = window.setTimeout(() => setThinkingClosing(false), 230);
    return () => window.clearTimeout(timeout);
  }, [thinkingClosing]);

  const toggleThinking = () => {
    if (thinkingExpanded) {
      setThinkingExpanded(false);
      setThinkingClosing(true);
      return;
    }
    const closedAnswerWidth =
      answersPanelRef.current?.getBoundingClientRect().width;
    if (closedAnswerWidth) setAnswerColumnWidth(closedAnswerWidth);
    setThinkingClosing(false);
    setThinkingExpanded(true);
  };

  const startPanelResize = (
    kind: PanelResizeKind,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const layout = layoutRef.current;
    const answersPanel = answersPanelRef.current;
    if (!layout || !answersPanel) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = layout.getBoundingClientRect();
    const horizontal = kind === "columns";
    const layoutSize = horizontal ? layout.offsetWidth : layout.offsetHeight;
    const visualSize = horizontal ? bounds.width : bounds.height;
    const scale = layoutSize > 0 && visualSize > 0 ? visualSize / layoutSize : 1;
    const contentHeightFloor =
      (panelHeights?.answer ?? 0) + (panelHeights?.changes ?? 0);
    const min = horizontal
      ? COMPACT_ANSWER_MIN_WIDTH
      : Math.max(COMPACT_TIMELINE_MIN_HEIGHT, contentHeightFloor);
    const max = horizontal
      ? Math.max(min, layout.offsetWidth - COMPACT_THINKING_MIN_WIDTH)
      : Math.max(min, window.innerHeight - 140);
    resizeDragRef.current = {
      kind,
      pointerId: event.pointerId,
      startClient: horizontal ? event.clientX : event.clientY,
      startValue: horizontal ? answersPanel.offsetWidth : layout.offsetHeight,
      scale,
      min,
      max,
    };
    setResizing(kind);
  };

  const movePanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const client = drag.kind === "columns" ? event.clientX : event.clientY;
    const next = clampPanelSize(
      drag.startValue + (client - drag.startClient) / drag.scale,
      drag.min,
      drag.max,
    );
    if (drag.kind === "columns") setAnswerColumnWidth(next);
    else setManualPanelHeight(next);
  };

  const finishPanelResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeDragRef.current?.pointerId !== event.pointerId) return;
    resizeDragRef.current = null;
    setResizing(null);
  };

  const resizeColumnsByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!delta) return;
    const layout = layoutRef.current;
    const answersPanel = answersPanelRef.current;
    if (!layout || !answersPanel) return;
    event.preventDefault();
    setAnswerColumnWidth(
      clampPanelSize(
        (answerColumnWidth ?? answersPanel.offsetWidth) + delta,
        COMPACT_ANSWER_MIN_WIDTH,
        Math.max(COMPACT_ANSWER_MIN_WIDTH, layout.offsetWidth - COMPACT_THINKING_MIN_WIDTH),
      ),
    );
  };

  const resizeHeightByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
    if (!delta) return;
    const layout = layoutRef.current;
    if (!layout) return;
    event.preventDefault();
    setManualPanelHeight(
      clampPanelSize(
        (manualPanelHeight ?? layout.offsetHeight) + delta,
        Math.max(
          COMPACT_TIMELINE_MIN_HEIGHT,
          (panelHeights?.answer ?? 0) + (panelHeights?.changes ?? 0),
        ),
        Math.max(
          COMPACT_TIMELINE_MIN_HEIGHT,
          (panelHeights?.answer ?? 0) + (panelHeights?.changes ?? 0),
          window.innerHeight - 140,
        ),
      ),
    );
  };

  const displayedAnswerHeight = panelHeights?.answer;
  const displayedContentFloor = panelHeights
    ? panelHeights.answer + panelHeights.changes
    : undefined;
  const displayedLayoutHeight =
    manualPanelHeight && displayedContentFloor
      ? Math.max(manualPanelHeight, displayedContentFloor)
      : manualPanelHeight ??
        (thinkingExpanded || thinkingClosing
          ? panelHeights?.timeline
          : displayedContentFloor);
  const thinkingVisible = thinkingExpanded || thinkingClosing;
  const layoutStyle = {
    ...(displayedAnswerHeight
      ? { "--compact-answer-height": `${displayedAnswerHeight}px` }
      : {}),
    ...(displayedLayoutHeight
      ? { "--compact-timeline-height": `${displayedLayoutHeight}px` }
      : {}),
    ...(answerColumnWidth
      ? { "--compact-answer-width": `${answerColumnWidth}px` }
      : {}),
  } as CSSProperties;

  return (
    <article
      className={`${className}${thinkingVisible ? " is-thinking-expanded" : " is-thinking-collapsed"}${thinkingClosing ? " is-thinking-closing" : ""}`}
      data-quote-selectable="true"
      data-quote-anchor={quoteAnchor}
      aria-label="Válasz és gondolkodás"
    >
      <div
        className={`compact-answers-layout${thinkingVisible ? "" : " is-thinking-collapsed"}${thinkingClosing ? " is-thinking-closing" : ""}${footer ? " has-compact-tail" : ""}${resizing === "columns" ? " is-resizing-columns" : ""}${resizing === "height" ? " is-resizing-height" : ""}${selected?.live ? " is-current" : ""}`}
        style={layoutStyle}
        ref={layoutRef}
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
            <button
              type="button"
              className="compact-thinking-side-toggle"
              onClick={toggleThinking}
              aria-expanded={thinkingExpanded}
              aria-controls={`compact-thinking-${selected?.id ?? "pending"}`}
              aria-label={
                thinkingExpanded
                  ? "Gondolkodás menetének bezárása"
                  : "Gondolkodás menetének megnyitása"
              }
              title={
                thinkingExpanded
                  ? "Gondolkodás menetének bezárása"
                  : "Gondolkodás menetének megnyitása"
              }
            >
              <span aria-hidden="true">{thinkingExpanded ? "‹" : "›"}</span>
            </button>
          </div>
          <div className="compact-answers-list" ref={answersListRef}>
            {actions && <div className="compact-answer-action-row">{actions}</div>}
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
          {changes && (
            <div className="compact-answer-change-slot" ref={changesSlotRef}>
              {changes}
            </div>
          )}
        </section>
        {thinkingVisible && (
          <div
            className="compact-column-resizer"
            role="separator"
            aria-label="Válasz és gondolkodás szélességének állítása"
            aria-orientation="vertical"
            aria-valuemin={COMPACT_ANSWER_MIN_WIDTH}
            aria-valuenow={answerColumnWidth}
            tabIndex={0}
            title="Panelek szélességének állítása"
            onKeyDown={resizeColumnsByKeyboard}
            onPointerDown={(event) => startPanelResize("columns", event)}
            onPointerMove={movePanelResize}
            onPointerUp={finishPanelResize}
            onPointerCancel={finishPanelResize}
            onLostPointerCapture={finishPanelResize}
          />
        )}
        <section
          className={`compact-thinking-panel${thinkingExpanded ? " is-opening" : thinkingClosing ? " is-closing" : " is-collapsed"}`}
          id={`compact-thinking-${selected?.id ?? "pending"}`}
          aria-label="Gondolkodás menete"
          aria-hidden={!thinkingExpanded}
          ref={thinkingPanelRef}
        >
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
        <div
          className="compact-height-resizer"
          role="separator"
          aria-label="Válaszpanel magasságának állítása"
          aria-orientation="horizontal"
          aria-valuemin={COMPACT_TIMELINE_MIN_HEIGHT}
          aria-valuenow={displayedLayoutHeight}
          tabIndex={0}
          title="Panelmagasság állítása"
          onKeyDown={resizeHeightByKeyboard}
          onPointerDown={(event) => startPanelResize("height", event)}
          onPointerMove={movePanelResize}
          onPointerUp={finishPanelResize}
          onPointerCancel={finishPanelResize}
          onLostPointerCapture={finishPanelResize}
        />
      </div>
      {footer}
    </article>
  );
}
