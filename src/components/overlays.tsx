/**
 * Fedőrétegek: képnagyító, alkalmazás-párbeszéd, Claude jóváhagyás és kérdés,
 * parancspaletta.
 *
 * Mind ugyanaz a fajta: a képernyő fölé kerülnek, a saját adatukon kívül
 * semmit nem ismernek az alkalmazásból, és mindegyik egy `on…` visszahívással
 * mondja meg, mit tegyen a hívó. Ezért lehetett őket elsőként kiemelni.
 */
import { useEffect, useRef, useState } from "react";

const PREVIEW_MIN_SCALE = 0.2;
const PREVIEW_MAX_SCALE = 12;

export type AppDialog =
  | {
      kind: "input";
      title: string;
      label: string;
      value: string;
      confirmLabel: string;
      onConfirm: (value: string) => boolean | void;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => boolean | void;
    };

export type ClaudeApprovalRequest = {
  approvalId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  displayName: string | null;
  description: string | null;
};

export type ClaudeQuestionRequest = {
  questionId: string;
  requestId: string;
  questions: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
};

export type SelectionQuote = {
  text: string;
  x: number;
  y: number;
  anchorId: string;
};

export function ImagePreviewOverlay({
  path,
  source,
  error,
  onClose,
  onOpenExternal,
}: {
  path: string;
  source: string | null;
  error: string | null;
  onClose: () => void;
  onOpenExternal: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  // A new image should never inherit the previous one's zoom.
  useEffect(() => {
    reset();
  }, [path]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "0") reset();
      if (event.key === "+" || event.key === "=") setScale((s) => Math.min(PREVIEW_MAX_SCALE, s * 1.25));
      if (event.key === "-") setScale((s) => Math.max(PREVIEW_MIN_SCALE, s / 1.25));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Attached manually because a passive React wheel handler cannot stop the
  // page from scrolling behind the overlay.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left - rect.width / 2;
      const pointerY = event.clientY - rect.top - rect.height / 2;
      setScale((previous) => {
        const next = Math.min(
          PREVIEW_MAX_SCALE,
          Math.max(PREVIEW_MIN_SCALE, previous * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
        );
        // Keep the point under the cursor fixed while the scale changes.
        const ratio = next / previous;
        setOffset((current) => ({
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        }));
        return next;
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.ox + (event.clientX - drag.x),
      y: drag.oy + (event.clientY - drag.y),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      className="agent-interaction-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="image-preview-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Előnézet: ${path}`}
      >
        <div className="image-preview-header">
          <div>
            <span className="approval-eyebrow">ELŐNÉZET</span>
            <h2>{path}</h2>
          </div>
          <div className="image-preview-actions">
            <button
              type="button"
              className="settings-compact-button"
              onClick={() => setScale((s) => Math.max(PREVIEW_MIN_SCALE, s / 1.25))}
              aria-label="Kicsinyítés"
            >
              −
            </button>
            <button type="button" className="settings-compact-button" onClick={reset}>
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              className="settings-compact-button"
              onClick={() => setScale((s) => Math.min(PREVIEW_MAX_SCALE, s * 1.25))}
              aria-label="Nagyítás"
            >
              +
            </button>
            <button type="button" className="settings-compact-button" onClick={onOpenExternal}>
              Külső program
            </button>
            <button
              type="button"
              className="inline-code-diff-close"
              onClick={onClose}
              aria-label="Előnézet bezárása"
            >
              ×
            </button>
          </div>
        </div>
        <div
          className="image-preview-body"
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={reset}
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
        >
          {error ? (
            <p className="image-preview-error">{error}</p>
          ) : source ? (
            <img
              src={source}
              alt={path}
              draggable={false}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              }}
            />
          ) : (
            <p className="image-preview-error">Betöltés…</p>
          )}
        </div>
        <p className="image-preview-hint">
          Görgetés: nagyítás · húzás: mozgatás · dupla kattintás vagy 0: alaphelyzet · Esc: bezárás
        </p>
      </section>
    </div>
  );
}


/**
 * Az alkalmazás saját párbeszédablaka — átnevezés, törlés megerősítése.
 *
 * Az érték és a megerősítés a hívónál marad: a párbeszéd megjeleníti, amit
 * kap, és szól, ha történt valami. Ezért lehetett elsőként kiemelni.
 */
export function AppDialogOverlay({
  dialog,
  onChangeValue,
  onSubmit,
  onClose,
}: {
  dialog: AppDialog;
  onChangeValue: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="app-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className={`app-dialog${dialog.kind === "confirm" && dialog.danger ? " is-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="app-dialog-header">
          <div>
            <span className="approval-eyebrow">Min</span>
            <h2 id="app-dialog-title">{dialog.title}</h2>
          </div>
          <button
            type="button"
            className="app-dialog-close"
            onClick={() => onClose()}
            aria-label="Ablak bezárása"
          >
            ×
          </button>
        </div>
        {dialog.kind === "input" ? (
          <label className="app-dialog-field">
            <span>{dialog.label}</span>
            <input
              autoFocus
              value={dialog.value}
              onChange={(event) => onChangeValue(event.target.value)}
            />
          </label>
        ) : (
          <p className="app-dialog-message">{dialog.message}</p>
        )}
        <div className="app-dialog-actions">
          <button
            type="button"
            className="app-dialog-cancel"
            onClick={() => onClose()}
          >
            Mégse
          </button>
          <button type="submit" className="app-dialog-confirm">
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Claude eszközhasználati jóváhagyás. */
export function ClaudeApprovalOverlay({
  request,
  onRespond,
}: {
  request: ClaudeApprovalRequest;
  onRespond: (decision: string, reason?: string) => void;
}) {
  return (
    <div className="agent-interaction-overlay" role="presentation">
      <section className="agent-interaction-card" role="dialog" aria-modal="true" aria-labelledby="claude-approval-title">
        <span className="approval-eyebrow">CLAUDE JÓVÁHAGYÁS</span>
        <h2 id="claude-approval-title">
          {request.title || `${request.toolName} futtatása`}
        </h2>
        {request.description && <p>{request.description}</p>}
        {request.reason && <p className="agent-interaction-reason">{request.reason}</p>}
        <pre className="agent-interaction-preview">
          {JSON.stringify(request.input, null, 2)}
        </pre>
        <div className="agent-interaction-actions">
          <button type="button" onClick={() => onRespond("decline", "A felhasználó elutasította a műveletet.")}>Tiltás</button>
          {/* The grant outlives the turn now, so the label says what it
              actually does: it is remembered for this project until the
              approvals file is cleared. */}
          <button type="button" onClick={() => onRespond("acceptForSession")}>Engedélyezés ebben a projektben</button>
          <button type="button" className="agent-interaction-primary" onClick={() => onRespond("accept")}>Engedélyezés egyszer</button>
        </div>
      </section>
    </div>
  );
}

/** Claude visszakérdezése futás közben. */
export function ClaudeQuestionOverlay({
  request,
  draft,
  selections,
  onDraftChange,
  onSelectionsChange,
  onRespond,
}: {
  request: ClaudeQuestionRequest;
  draft: string;
  selections: string[];
  onDraftChange: (value: string) => void;
  onSelectionsChange: (update: (current: string[]) => string[]) => void;
  /** Több választásnál tömb megy vissza — a bridge így várja. */
  onRespond: (answerKey: string, answer: string | string[]) => void;
}) {
  const question = request.questions[0];
  if (!question) return null;
  // The Agent SDK keys the answers record by the question's full text.
  // Using the short header instead makes the SDK drop the answer and tell
  // the model "no answer provided", losing the selection silently.
  const answerKey = question.question || question.header || "answer";
  const options = question.options ?? [];
  const multiSelect = question.multiSelect === true;
  const selected = multiSelect
    ? selections
    : draft
      ? [draft]
      : [];
  return (
    <div className="agent-interaction-overlay" role="presentation">
      <section className="agent-interaction-card" role="dialog" aria-modal="true" aria-labelledby="claude-question-title">
        <span className="approval-eyebrow">CLAUDE KÉRDÉS</span>
        <h2 id="claude-question-title">{question.question || question.header || "Válassz egy lehetőséget"}</h2>
        <div className="agent-question-options">
          {options.map((option) => {
            const label = option.label || "Választás";
            const active = selected.includes(label);
            return (
              <button
                type="button"
                className={active ? "is-selected" : ""}
                key={label}
                onClick={() => {
                  if (multiSelect) {
                    onSelectionsChange((current) =>
                      current.includes(label)
                        ? current.filter((item) => item !== label)
                        : [...current, label],
                    );
                  } else {
                    onDraftChange(label);
                  }
                }}
              >
                <strong>{label}</strong>
                {option.description && <small>{option.description}</small>}
              </button>
            );
          })}
        </div>
        <input
          className="agent-question-free-text"
          value={multiSelect ? draft : draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Saját válasz…"
          aria-label="Saját válasz"
        />
        <div className="agent-interaction-actions">
          <button type="button" onClick={() => onRespond(answerKey, "")}>
            Mégse
          </button>
          <button
            type="button"
            className="agent-interaction-primary"
            disabled={selected.length === 0 && !draft.trim()}
            onClick={() => {
              const answer = draft.trim() || (multiSelect ? selected : selected[0]);
              onRespond(answerKey, answer);
            }}
          >
            Válasz küldése
          </button>
        </div>
      </section>
    </div>
  );
}

/** Parancspaletta. */
export function CommandPaletteOverlay({
  onClose,
  onNewConversation,
  onOpenSettings,
  onFindProject,
  onOpenWorkCard,
}: {
  onClose: () => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
  onFindProject: () => void;
  onOpenWorkCard: () => void;
}) {
  return (
    <div
      className="command-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-modal">
        <div className="command-search">
          <span>⌕</span>
          <input autoFocus placeholder="Parancs keresése…" />
        </div>
        <button onClick={onNewConversation}>
          <kbd>N</kbd>
          <span>Új beszélgetés</span>
        </button>
        <button
          onClick={() => {
            onClose();
            onFindProject();
          }}
        >
          <kbd>P</kbd>
          <span>Projekt keresése</span>
        </button>
        <button
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          <kbd>A</kbd>
          <span>Olvasási beállítások</span>
        </button>
        <button
          onClick={() => {
            onClose();
            onOpenWorkCard();
          }}
        >
          <kbd>G</kbd>
          <span>Kódolási kártya megnyitása</span>
        </button>
      </div>
    </div>
  );
}
