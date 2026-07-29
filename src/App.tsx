import {
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildWorkLogGroups,
  findActiveWorkGroup,
  mergePlanHistoryRecords,
  messageBelongsToWorkGroup as timelineMessageBelongsToWorkGroup,
  settleHistoricalPlan,
  workGroupTurnKeys,
  type WorkLogGroup as TimelineWorkLogGroup,
} from "./chatTimeline";
import {
  beginAssistantRegeneration,
  collapseAbandonedRegenerationRetries,
  collapseRepeatedAssistantText,
  bothAssistantVersionsAreSettled,
  coalesceMessageIdentities,
  isNewerSettledAssistantVersion,
  isSettledHistoricalAssistant,
  messagesShareIdentity,
} from "./messageIdentity";
import {
  conversationTitleFromPrompt,
  DEFAULT_APP_MODE,
  GENERAL_PROJECT_ID,
  generalConversationCacheKey,
  isGeneralConversationCacheKey,
  normalizeConversationScope,
  type AppMode,
  type ConversationScope,
} from "./conversationScope";
import {
  acceptTerminalAgentEvent,
  agentEventIdentity,
  normalizeAgentEventEnvelope,
} from "./agentEvent";
import { ensureCanonicalConversationId } from "./conversationIdentity";
import { agentAnswerMessageId } from "./deterministicId";
import {
  formatSyncHealthTime,
  syncHealthStatusLabel,
  syncTombstoneProjectContext,
  syncTombstoneTypeLabel,
} from "./syncFormat";
import {
  conversationIdForKey,
  conversationKeyIndex,
  conversationKeysMatch,
  normalizeConversationKey,
  readConversation,
  writeConversation,
  writeTarget,
} from "./conversationState";
import {
  describeAgentError,
  describeThrownAgentError,
} from "./agentError";
import { Sidebar } from "./components/Sidebar";
import { ThinkingDots } from "./components/runMarks";
import {
  AppDialogOverlay,
  ClaudeApprovalOverlay,
  ClaudeQuestionOverlay,
  CommandPaletteOverlay,
  ImagePreviewOverlay,
  type AppDialog,
  type ClaudeApprovalRequest,
  type ClaudeQuestionRequest,
  type SelectionQuote,
} from "./components/overlays";

type Message = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  time: string;
  code?: boolean;
  live?: boolean;
  final?: boolean;
  /** True only when the user explicitly stopped this turn. */
  interrupted?: boolean;
  itemId?: string;
  sequence?: number;
  /** Codex turn that produced this assistant response. */
  turnId?: string;
  hlc?: string;
  originDeviceId?: string;
  images?: MessageImageAttachment[];
  /** Quote references created from text selected in the conversation. */
  quoteRefs?: QuoteReference[];
  /** Whether this turn should render the detailed plan/reasoning trace. */
  detailed?: boolean;
  /** File changes produced by this response, when the native guard exposed them. */
  changeSummary?: ChangeSummaryFile[];
  /** Which pipeline stage produced this message, when it belongs to a run. */
  pipeline?: MessagePipeline;
};

type MessageImageAttachment = {
  path: string;
  name: string;
  mimeType: string;
};

type FileActionMenuState = {
  path: string;
  x: number;
  y: number;
};

type QuoteReference = {
  id: string;
  text: string;
  instruction: string;
  anchorId: string;
};

type QuoteJumpHandler = (quote: QuoteReference) => void;

/**
 * Változatlan azonosságú callback, ami mindig a legfrissebb testet hívja.
 *
 * A memoizált üzenetsor csak akkor spórol rendert, ha *minden* propja azonos
 * marad; egy renderenként újragyártott handler mindet elrontja.
 */
const useStableCallback = <Arguments extends unknown[], Result>(
  callback: (...args: Arguments) => Result,
) => {
  const latest = useRef(callback);
  latest.current = callback;
  return useRef((...args: Arguments) => latest.current(...args)).current;
};

type FileClickHandler = (path: string, x: number, y: number) => void;

const FileActionContext = createContext<FileClickHandler | null>(null);

type PendingImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

type Project = {
  id: string;
  name: string;
  path: string;
  relativePath: string | null;
  threads: string[];
};
type TreeSortMode = "modified" | "time";
type AgentGuardReport = {
  snapshotId: string;
  snapshotPath: string;
  baseHash: string;
  postHash: string | null;
  changedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
  rollbackAvailable: boolean;
  applyAvailable: boolean;
  applyBaseHash: string | null;
  rebased: boolean;
  isolationMode: "gitWorktree" | "nonGitSnapshot";
};
/** What returning to an earlier prompt would cost, asked before doing it. */
type RevertPreview = {
  removedMessages: number;
  removedTurns: number;
  snapshotId: string | null;
  prompt: string;
  filesUnavailable: boolean;
};
type AgentApplyResult = {
  snapshotId: string;
  root: string;
  appliedFiles: number;
  removedFiles: number;
  baseHash: string;
  resultingHash: string;
  rollbackAvailable: boolean;
};
type AgentRollbackResult = {
  snapshotId: string;
  root: string;
  restoredFiles: number;
  removedFiles: number;
  baseHash: string;
  resultingHash: string;
};
type AgentDiffLine = {
  kind: "context" | "added" | "removed" | "empty" | "meta" | string;
  oldLine?: number | null;
  newLine?: number | null;
  text: string;
};
type AgentDiffFile = {
  path: string;
  status: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  binaryOrTruncated?: boolean;
  lines: AgentDiffLine[];
};
type AgentDiffPreview = {
  snapshotId: string;
  root: string;
  baseHash: string;
  postHash: string;
  currentHash: string;
  currentState: string;
  createdAt?: string | null;
  lastAction?: string | null;
  lastActionAt?: string | null;
  files: AgentDiffFile[];
};
type PipelineRecipeStage = {
  role: "plan" | "code" | "review";
  provider: "codex" | "anthropic";
  runtime: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
};

type PipelineRecipe = {
  id: string;
  label: string;
  stages: PipelineRecipeStage[];
};

type PipelineProgressEvent = {
  runId: string;
  conversationId: string;
  stageIndex: number;
  stageCount: number;
  role: "plan" | "code" | "review";
  agentLabel: string;
  requestId: string;
  phase: "started" | "finished" | "failed";
  status: "running" | "completed" | "failed" | "cancelled";
};

type PipelineStageResult = {
  index: number;
  role: "plan" | "code" | "review";
  agentLabel: string;
  requestId: string;
  succeeded: boolean;
  text: string;
  error?: string;
  review?: { verdict: "accepted" | "changes_requested"; summary: string };
  sessionId?: string;
  /** Id of the row the runner stored for this stage's answer. */
  answerMessageId?: string;
};

type PipelineRunResult = {
  runId: string;
  chainId: string;
  iteration: number;
  recipe: PipelineRecipe;
  status: "running" | "completed" | "failed" | "cancelled";
  stages: PipelineStageResult[];
  /** The chain's staged workspace changes; applying them is the caller's job. */
  guard?: AgentGuardReport | null;
  error?: string;
};

/** The stage badge a message carries so a run groups on any device. */
type MessagePipeline = {
  runId: string;
  /** Shared by every iteration of one question. Absent on pre-versioning rows. */
  chainId?: string;
  /** 1-based; absent or 0 on rows written before re-runs existed. */
  iteration?: number;
  stageIndex: number;
  stageCount: number;
  stageRole: string;
  stageAgent: string;
  verdict?: string;
  verdictSummary?: string;
};

/**
 * Which panel a stage belongs to.
 *
 * A re-run is its own run with its own id, so grouping by run would draw the
 * second attempt as a separate panel below the first. The chain is what the
 * user asked one question about, and that is what gets one panel.
 */
const chainKeyOf = (pipeline: MessagePipeline) =>
  pipeline.chainId?.trim() || pipeline.runId;

/** Rows written before versioning existed are the first and only iteration. */
const iterationOf = (pipeline: MessagePipeline) =>
  pipeline.iteration && pipeline.iteration > 0 ? pipeline.iteration : 1;

/** v1 plus two re-runs. Mirrors `MAX_CHAIN_ITERATIONS` in the runner. */
const MAX_CHAIN_ITERATIONS = 3;

/**
 * What a chain stage may run, per vendor.
 *
 * Deliberately a fixed list rather than the model catalog: deriving it from the
 * catalog gave every stage a different set - one offered only Sonnet, another
 * only the model its preset happened to name - and a chain is unusable if the
 * same click means something different in each column.
 */
const PIPELINE_MODELS: Record<"anthropic" | "codex", string[]> = {
  anthropic: ["claude-opus-5", "claude-fable-5"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
};

/** Short enough that every cell fits one fixed width. */
const PIPELINE_MODEL_LABELS: Record<string, string> = {
  "claude-opus-5": "Opus 5",
  "claude-fable-5": "Fable 5",
  // The generation is already implied by the vendor cell above, and carrying
  // it here forced every cell to the width of "5.6 Terra".
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
};

/** The chain is read at a glance, so the vendor prefix is dropped. */
const shortModelLabel = (modelId: string) =>
  PIPELINE_MODEL_LABELS[modelId] ?? modelId;

/** Scrolls so the end of a freshly opened phase is visible, composer and all. */
const revealPanelBottom = (panel: Element | null) => {
  if (!(panel instanceof HTMLElement)) return;
  // Measured in viewport coordinates on purpose: offsetTop is relative to the
  // nearest positioned ancestor, which is not the element that scrolls.
  const floor =
    document.querySelector(".composer-wrap")?.getBoundingClientRect().top ??
    window.innerHeight;
  const delta = panel.getBoundingClientRect().bottom - (floor - 12);
  if (delta <= 0) return;
  let scroller: HTMLElement | null = panel.parentElement;
  while (
    scroller &&
    scroller.scrollHeight <= scroller.clientHeight + 1 &&
    scroller !== document.body
  )
    scroller = scroller.parentElement;
  if (scroller && scroller !== document.body)
    scroller.scrollBy({ top: delta, behavior: "smooth" });
  else window.scrollBy({ top: delta, behavior: "smooth" });
};

/** The composed answer tab, which is not one of the chain's stages. */
const PIPELINE_ANSWER_TAB = -1;

/** Where a running re-run draws itself: in its own panel, not below them all. */
const LIVE_RERUN_SLOT = "__live-rerun-slot__";

const STAGE_ROLE_LABELS: Record<string, string> = {
  plan: "TERV",
  code: "KÓD",
  review: "REVIEW",
};

/**
 * The client-side step shown before the model's own plan arrives. A chain
 * runs three different roles through the same trace panel, and a reviewer
 * "preparing a plan" reads as the wrong stage running — the placeholder has
 * to say what this stage is actually warming up to do.
 */
const PRE_PLAN_STEP_LABELS: Record<string, string> = {
  plan: "0. Terv előkészítése és feladatértelmezése",
  code: "0. Kódolás előkészítése és a terv értelmezése",
  review: "0. Bírálat előkészítése és a változások áttekintése",
};
const prePlanStepLabel = (stageRole?: string | null) =>
  PRE_PLAN_STEP_LABELS[stageRole ?? ""] ?? PRE_PLAN_STEP_LABELS.plan;

/** The badge that tells a stage apart from an ordinary answer at a glance. */
const stageBadge = (pipeline?: MessagePipeline) => {
  if (!pipeline) return null;
  const role = STAGE_ROLE_LABELS[pipeline.stageRole] ?? pipeline.stageRole;
  const accepted = pipeline.verdict === "accepted";
  return (
    <>
      <span
        className="stage-badge"
        title={`${pipeline.stageIndex + 1}/${pipeline.stageCount} ${role}`}
      >
        {pipeline.stageAgent}
      </span>
    </>
  );
};

type ChangeSummaryFile = {
  path: string;
  status: "modified" | "added" | "removed";
  added: number;
  removed: number;
  binaryOrTruncated?: boolean;
};
type CodexResponse = {
  threadId: string;
  text: string;
  events?: CodexEvent[];
  guard: AgentGuardReport;
  threadRehydrated?: boolean;
};
type CodexDelta = {
  threadId: string;
  delta: string;
  itemId?: string | null;
  turnId?: string | null;
  phase?: string | null;
  sequence?: number;
};
type CodexEvent = {
  requestId?: string | null;
  sequence?: number;
  messageId?: string | null;
  threadId: string;
  eventType: string;
  payload: unknown;
  providerTurnId?: string | null;
  terminalEventId?: string | null;
};
type CodexTransportStatus = {
  requestId?: string | null;
  stage: string;
  detail: string;
  threadId?: string | null;
};
type WorkItemKind = "status" | "reasoning" | "command" | "file" | "tool";
type WorkItemStatus = "running" | "done" | "error";
type PlanStepStatus = "pending" | "inProgress" | "completed" | "error";
type PlanStep = { id: string; step: string; status: PlanStepStatus };
type PlanStepTiming = { startedAt?: number; completedAt?: number };
type PlanSnapshot = {
  turnId: string | null;
  explanation: string;
  steps: PlanStep[];
  startedAt?: number;
  completedAt?: number;
  stepTimes?: Record<string, PlanStepTiming>;
};
/**
 * Egyszerre ennyi válasz futhat.
 *
 * Nem elvi korlát: a gép és a OneDrive védelme. Ha bármi rosszul sül el, ennek
 * az 1-re állítása azonnali visszaút — a futás-tábla és a kapuk maradnak.
 */
const MAX_CONCURRENT_RUNS = 3;

const EMPTY_PLAN: PlanSnapshot = {
  turnId: null,
  explanation: "",
  steps: [],
};

/**
 * Egy futás — mindaz, ami eddig „az aktuális kérés" néven tizenhárom
 * modulszintű refben lakott.
 *
 * A két kulcsmező (`requestId`, `ownerConversationId`) a küldés pillanatában
 * rögzül, és soha nem változik: az események kizárólag ezeken találnak haza.
 * Semmi nem igazodik render-órához — pontosan ez a különbség a korábbi,
 * guard-alapú javításokhoz képest, amelyek váltás közben mind széttartottak.
 */
type RunHandle = {
  readonly requestId: string;
  readonly ownerConversationId: string;
  /** Cache-kulcs; írásmód-toleráns kereséshez, nem azonosításhoz. */
  ownerConversationKey: string;
  /** Coding: a projekt-zár kulcsa (normalizált path). GENERAL: null. */
  readonly projectPathKey: string | null;
  /** A futás munkakönyvtára. A kiválasztott projekt közben változhat. */
  readonly projectPath: string;
  readonly provider: "codex" | "anthropic";
  readonly clientTurnId: string;
  /** A felhasználó leállította-e; a lezáró ágak ezt kérdezik. */
  cancelled: boolean;
  liveMessageId: string;
  /** A provider szálazonosítója; a requestId nélküli események tartaléka. */
  threadId?: string;
  turnId?: string;
  turnTiming: PlanStepTiming;
  plan: PlanSnapshot;
  planTextBuffer: Record<string, string>;
  agentMessagePhases: Record<string, string>;
  /** Esemény-deduplikáció futásonként; eddig közös, de körönként ürített. */
  processedEvents: Set<string>;
  completedTerminalTurns: Set<string>;
  /** Lánc esetén a szakaszok saját kérés-azonosítói. */
  chainRequestIds: Set<string>;
  /** A gördülékeny kiírás puffere. */
  answerStream: {
    meta: Omit<CodexDelta, "delta"> | null;
    pending: string;
    frame: number | null;
  };
  status: "preparing" | "streaming" | "finalizing" | "done";
  turnCompleted: boolean;
  /**
   * Amit a futás a felületnek üzen. Eddig globális state volt, tehát két
   * futás mellett a legutóbbié látszott — bármelyik beszélgetésben.
   */
  statusLabel: string;
  transport: CodexTransportStatus | null;
  watchdog: string;
  cancelling: boolean;
};

type CommentaryEntry = {
  id: string;
  itemId?: string;
  turnId?: string;
  stepId?: string;
  /** Monotonic client sequence used to merge commentary with internal reasoning. */
  sequence?: number;
  body: string;
  status: "running" | "done" | "error";
  time: string;
};
type CodeActivity = {
  id: number;
  itemId?: string;
  turnId?: string;
  planStepId?: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  label: string;
  detail: string;
  eventType: string;
  time: string;
  body?: string;
  code?: string;
  beforeCode?: string;
  afterCode?: string;
  language?: string;
  hlc?: string;
  originDeviceId?: string;
};
type CodeBlock = { language: string; code: string };
type CodeSnippet = CodeBlock & { id: string; messageIndex: number };
type TimelineOrder = {
  hlc?: string;
  originDeviceId?: string;
  sequence?: number;
  tieBreaker?: string;
};
type WorkLogGroup = TimelineWorkLogGroup<CodeActivity>;
type TimelineEntry =
  | {
      kind: "message";
      key: string;
      sequence: number;
      hlc?: string;
      originDeviceId?: string;
      tieBreaker: string;
      message: Message;
      messageIndex: number;
    }
  | {
      kind: "work";
      key: string;
      sequence: number;
      hlc?: string;
      originDeviceId?: string;
      tieBreaker: string;
      group: WorkLogGroup;
    };
type CodexModel = {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
};
type ModelFamily = { key: string; label: string; models: CodexModel[] };
type OpenMenu = { kind: "project" | "thread" | "general"; key: string } | null;

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "low";
const DEFAULT_CLAUDE_EFFORT = "low";
const DEFAULT_CLAUDE_BUDGET_USD = "0.05";
// A tool-using coding turn needs several agent turns: read, edit, run the test,
// then answer. The old default of 1 came from the API-key era where every turn
// cost money; with subscription auth the turn limit is the only guard, so it has
// to be high enough for the work to actually finish.
const DEFAULT_CLAUDE_MAX_TURNS = "40";
const MODEL_PREFERENCE_VERSION = "4";
const EFFORT_PREFERENCE_VERSION = "1";
const READING_SETTINGS_VERSION = "3";
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const fallbackModels: CodexModel[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Balanced agentic coding model.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model for complex coding.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Strong model for everyday coding.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Small, fast coding model.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: "high",
  },
];

/**
 * The Claude side of the picker.
 *
 * The same two models a chain stage may run, so "Opus 5" means one thing in
 * this app rather than one thing per menu. Auth is the Claude Code
 * subscription, not an API key — the old description said otherwise and was
 * the last place in the UI still claiming it.
 */
const claudeCodingModels: CodexModel[] = [
  {
    id: "claude-opus-5",
    displayName: "Opus 5",
    description: "A legerősebb Claude coding modell.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: DEFAULT_CLAUDE_EFFORT,
  },
  {
    id: "claude-fable-5",
    displayName: "Fable 5",
    description: "Gyors Claude coding modell.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: DEFAULT_CLAUDE_EFFORT,
  },
];

type AppSound = "notify" | "complete";
const APP_SOUND_FILES: Record<AppSound, string> = {
  notify: "notify.wav",
  complete: "tada.wav",
};
const APP_SOUND_VOLUME = 0.72;
const COMPLETION_SOUND_REPETITIONS = 5;
const appSoundPlayers = new Map<AppSound, HTMLAudioElement>();
let appSoundQueue = Promise.resolve();

const appSoundPlayer = (sound: AppSound) => {
  const existing = appSoundPlayers.get(sound);
  if (existing) return existing;
  const audio = new Audio(`/sounds/${APP_SOUND_FILES[sound]}`);
  audio.preload = "auto";
  audio.volume = APP_SOUND_VOLUME;
  appSoundPlayers.set(sound, audio);
  return audio;
};

const playAudioToEnd = async (audio: HTMLAudioElement) => {
  audio.pause();
  audio.currentTime = 0;
  audio.volume = APP_SOUND_VOLUME;
  let cleanup = () => undefined;
  const finished = new Promise<void>((resolve, reject) => {
    const onEnded = () => resolve();
    const onError = () => reject(new Error("A hangfájl lejátszása megszakadt."));
    cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
  });
  try {
    await audio.play();
    await finished;
  } finally {
    cleanup();
  }
};

const playAppSound = (sound: AppSound, repetitions = 1) => {
  if (typeof window === "undefined") return;
  const count = Math.max(1, Math.trunc(repetitions));
  appSoundQueue = appSoundQueue
    .catch(() => undefined)
    .then(async () => {
      const audio = appSoundPlayer(sound);
      for (let index = 0; index < count; index += 1)
        await playAudioToEnd(audio);
    });
  void appSoundQueue.catch((error) =>
    console.warn(`A(z) ${APP_SOUND_FILES[sound]} nem játszható le.`, error),
  );
};

const primeAppSounds = () => {
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", primeAppSounds, true);
  window.removeEventListener("keydown", primeAppSounds, true);
  for (const sound of Object.keys(APP_SOUND_FILES) as AppSound[]) {
    const audio = appSoundPlayer(sound);
    audio.volume = 0;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = APP_SOUND_VOLUME;
      })
      .catch((error) => {
        audio.volume = APP_SOUND_VOLUME;
        console.warn(`A(z) ${APP_SOUND_FILES[sound]} előkészítése sikertelen.`, error);
      });
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", primeAppSounds, true);
  window.addEventListener("keydown", primeAppSounds, true);
}

const supportedImageMime = (file: File) => {
  const declared = file.type.toLowerCase();
  if (["image/png", "image/jpeg", "image/webp"].includes(declared))
    return declared;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
};

const fileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("A kép nem alakítható data URL-lé."));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("A kép nem olvasható.")),
    );
    reader.readAsDataURL(file);
  });

const messageImageContext = (message: Message) =>
  message.images?.length
    ? `\nCsatolt projektképek: ${message.images.map((image) => image.path).join(", ")}`
    : "";

const messageAnchorId = (message: Pick<Message, "id" | "sequence" | "time">) =>
  `message:${message.id ?? `${message.sequence ?? "unknown"}:${message.time}`}`;

const quoteBacklinkButtons = (
  quotes: QuoteReference[],
  onQuoteJump: QuoteJumpHandler,
) => {
  if (quotes.length === 0) return null;
  return (
    <span className="quote-backlinks" aria-label="Idézetek visszaugrása">
      {quotes.map((quote, index) => (
        <button
          type="button"
          className="quote-backlink-button"
          key={quote.id}
          onClick={() => onQuoteJump(quote)}
          aria-label={`Idézet ${index + 1} megnyitása`}
          title={quote.instruction || `Idézet ${index + 1} megnyitása`}
        >
          <span className="quote-backlink-glyph" aria-hidden="true">
            {quotes.length > 1 ? index + 1 : null}
          </span>
        </button>
      ))}
    </span>
  );
};

/**
 * An answer as paragraphs rather than one `pre-wrap` block.
 *
 * A model separates paragraphs with a blank line, and `pre-wrap` renders that
 * blank line as a full line box — which is why every paragraph break looked
 * like a whole empty row of text. Splitting on the blank line and letting CSS
 * set the gap keeps the structure and drops the hole.
 */
const answerParagraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => (
      <p key={`para-${index}`}>
        <InlineMarkdown text={paragraph} />
      </p>
    ));

const answerWithQuoteBacklinks = (
  text: string,
  quotes: QuoteReference[],
  onQuoteJump: QuoteJumpHandler,
) => {
  if (quotes.length === 0) return <InlineMarkdown text={text} />;
  const matches = quotes
    .map((quote) => {
      const needles = [quote.text, quote.instruction].filter(Boolean);
      const found = needles
        .map((needle) => ({ needle, index: text.indexOf(needle) }))
        .filter((candidate) => candidate.index >= 0)
        .sort((a, b) => a.index - b.index)[0];
      if (!found) return { quote, needle: "", index: -1 };
      let index = found.index;
      let needle = found.needle;
      for (const marker of ["**", "__", "`", "*"]) {
        if (
          index >= marker.length &&
          text.slice(index - marker.length, index) === marker &&
          text.slice(index + needle.length, index + needle.length + marker.length) ===
            marker
        ) {
          index -= marker.length;
          needle = text.slice(index, index + needle.length + marker.length * 2);
          break;
        }
      }
      return { quote, needle, index };
    })
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (matches.length === 0)
    return (
      <>
        <InlineMarkdown text={text} />
        {quoteBacklinkButtons(quotes, onQuoteJump)}
      </>
    );

  // Put the backlink after the complete sentence that contains the match.
  // A selected passage can end in the middle of a word or before the final
  // punctuation; placing the icon at the raw match boundary makes it look as
  // if the answer text was cut in half.
  const sentenceEndFor = (match: (typeof matches)[number]) => {
    const matchEnd = match.index + match.needle.length;
    const matchedText = text.slice(match.index, matchEnd);
    if (/[.!?…](?:["'”»)\]]*|\*{1,2}|`)$/.test(matchedText))
      return matchEnd;
    const remainder = text.slice(matchEnd);
    const newline = remainder.search(/\r?\n/);
    const boundary = /[.!?…](?:["'”»)\]]*)?(?=\s|$)/.exec(remainder);
    const boundaryOffset = boundary?.index ?? -1;
    if (newline >= 0 && (boundaryOffset < 0 || newline < boundaryOffset))
      return matchEnd + newline;
    if (boundary && boundaryOffset >= 0)
      return matchEnd + boundaryOffset + boundary[0].length;
    return text.length;
  };
  const groupedMatches: Array<{
    start: number;
    end: number;
    quotes: QuoteReference[];
  }> = [];
  for (const match of matches) {
    const end = sentenceEndFor(match);
    const previous = groupedMatches.at(-1);
    if (previous && match.index < previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.quotes.push(match.quote);
    } else {
      groupedMatches.push({
        start: match.index,
        end,
        quotes: [match.quote],
      });
    }
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  groupedMatches.forEach((group, index) => {
    if (group.start < cursor) return;
    if (group.start > cursor)
      parts.push(
        <InlineMarkdown
          key={`answer-prefix-${group.start}`}
          text={text.slice(cursor, group.start)}
        />,
      );
    parts.push(
      <span
        className="trace-answer-quoted-sentence"
        key={`answer-quote-${group.start}-${index}`}
      >
        <InlineMarkdown text={text.slice(group.start, group.end)} />
        {quoteBacklinkButtons(group.quotes, onQuoteJump)}
      </span>,
    );
    cursor = group.end;
  });
  if (cursor < text.length)
    parts.push(<InlineMarkdown key="answer-suffix" text={text.slice(cursor)} />);
  const matchedQuoteIds = new Set(matches.map((match) => match.quote.id));
  const unmatchedQuotes = quotes.filter((quote) => !matchedQuoteIds.has(quote.id));
  if (unmatchedQuotes.length > 0)
    parts.push(
      <span className="trace-answer-quoted-sentence" key="answer-unmatched-quotes">
        {quoteBacklinkButtons(unmatchedQuotes, onQuoteJump)}
      </span>,
    );
  return <>{parts}</>;
};

const selectQuoteText = (root: HTMLElement, text: string) => {
  const needle = text.trim();
  if (!needle) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) nodes.push(current as Text);
    current = walker.nextNode();
  }
  const fullText = nodes.map((node) => node.nodeValue ?? "").join("");
  const start = fullText.indexOf(needle);
  if (start < 0) return false;
  const end = start + needle.length;
  let cursor = 0;
  let startNode: Text | undefined;
  let endNode: Text | undefined;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const length = (node.nodeValue ?? "").length;
    if (!startNode && start >= cursor && start <= cursor + length) {
      startNode = node;
      startOffset = start - cursor;
    }
    if (end >= cursor && end <= cursor + length) {
      endNode = node;
      endOffset = end - cursor;
      break;
    }
    cursor += length;
  }
  if (!startNode || !endNode) return false;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

const normalizedQuoteSearchText = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const findQuoteTarget = (quote: QuoteReference) => {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-quote-selectable="true"][data-quote-anchor]',
    ),
  );
  const exact = candidates.find(
    (candidate) => candidate.dataset.quoteAnchor === quote.anchorId,
  );
  const needles = [quote.text, quote.instruction]
    .map(normalizedQuoteSearchText)
    .filter((needle) => needle.length >= 3);
  const containsNeedle = (candidate: HTMLElement) => {
    if (needles.length === 0) return true;
    const body = normalizedQuoteSearchText(candidate.textContent ?? "");
    return needles.some((needle) => body.includes(needle));
  };
  // Prefer the persisted anchor, but only when the referenced text is still
  // present in that node. Sync/restart can preserve a stale anchor id while
  // the message id changes; in that case fall back to the visible quote text.
  if (exact && containsNeedle(exact)) return exact;
  const scored = candidates
    .filter(containsNeedle)
    .map((candidate) => {
      let score = Math.max(
        ...needles.map((needle) => needle.length),
        0,
      );
      if (candidate.classList.contains("message-body")) score += 20;
      if (candidate.closest(".user-message")) score += 10;
      if (candidate.closest(".trace-thinking-panel")) score += 5;
      if (candidate.closest(".turn-progress-answer")) score += 4;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score);
  return scored[0]?.candidate ?? exact;
};

const PROJECTS_STORAGE_KEY = "min-projects";
const MESSAGE_HISTORY_STORAGE_KEY = "min-message-history";
const DETAIL_MODE_STORAGE_KEY = "min-detail-mode";
const WORK_LOG_STORAGE_KEY = "min-work-log";
const PLAN_STORAGE_KEY = "min-plan-history";
const COMMENTARY_STORAGE_KEY = "min-commentary-history";
const GENERAL_HISTORY_STORAGE_KEY = "min-general-conversations";
const DEVICE_ID_STORAGE_KEY = "min-device-id";
const LOCAL_THREAD_IDS_STORAGE_KEY = "min-local-thread-ids";
const ACTIVE_MODE_STORAGE_KEY = "min-active-mode";
const ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY =
  "min-active-general-conversation-id";
const TREE_SORT_MODE_STORAGE_KEY = "min-tree-sort-mode";
const SYNC_SCHEMA_VERSION = 1;
const LOCAL_STORE_SNAPSHOT_VERSION = 11;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SYNC_POLL_INTERVAL_MS = 15_000;
const MAX_WORK_ITEMS_PER_THREAD = 320;
const MAX_COMMENTARY_ENTRIES_PER_THREAD = 320;

type SyncProject = {
  id: string;
  name: string;
  relativePath: string | null;
  pathHint: string;
  threads: string[];
};

type SyncConversation = {
  id?: string;
  scope: ConversationScope;
  projectId: string | null;
  title: string;
  messages: Message[];
  workItems?: CodeActivity[];
  threadId: string | null;
  updatedAt: string;
  planHistory?: Record<string, PlanSnapshot>;
  commentary?: CommentaryEntry[];
};

type AgentConversationStatus = {
  conversationId: string;
  provider: string | null;
  runtime: string | null;
  model: string | null;
  effort: string | null;
  activeSessionId: string | null;
  sessionHeadTurnId: string | null;
  conversationHeadTurnId: string | null;
  hasConflict: boolean;
};

type SyncTombstone = {
  entityType: "project" | "conversation" | string;
  entityId: string;
  archivedAt: string;
  projectId?: string | null;
  title?: string | null;
  relativePath?: string | null;
  pathHint?: string | null;
  reason?: string | null;
};

type SyncState = {
  schemaVersion: number;
  deviceId: string;
  updatedAt: string;
  activeProjectId: string | null;
  activeThread: string | null;
  projects: SyncProject[];
  conversations: Record<string, SyncConversation>;
};

type SyncHealth = {
  status: "healthy" | "empty" | "quarantine" | string;
  journalPath: string;
  quarantinePath: string;
  checkedAt: string;
  lastImportAt: string | null;
  scannedEvents: number;
  acceptedEvents: number;
  importedEvents: number;
  storedEvents: number;
  blockedDevices: string[];
  warnings: string[];
  canWrite: boolean;
  recoveryAction: string;
};

type SyncRestorePreview = {
  entityType: string;
  entityId: string;
  label: string;
  archivedAt: string;
  targetPath: string | null;
  canRestore: boolean;
  blockingReason: string | null;
  warnings: string[];
  effects: string[];
  health: SyncHealth;
};

type SyncRetentionCandidate = {
  selectionKey: string;
  entityType: string;
  entityId: string;
  label: string;
  archivedAt: string;
  ageDays: number | null;
  eligible: boolean;
  reason: string;
};

type SyncRetentionDevice = {
  deviceId: string;
  ackedAt: string | null;
  ackedEventCount: number;
  ackedJournalDigest: string | null;
  backupAt: string | null;
  backupEventCount: number;
  backupJournalDigest: string | null;
  backupVerified: boolean;
  ready: boolean;
};

type SyncRetentionAuditEntry = {
  schemaVersion: number;
  auditId: string;
  deviceId: string;
  createdAt: string;
  action: string;
  outcome: string;
  eventCount: number;
  journalDigest: string;
  selectedCount: number;
  snapshotId: string | null;
  details: string | null;
};

type SyncRetentionPreview = {
  snapshot: LocalStoreSnapshot;
  health: SyncHealth;
  retentionDays: number;
  candidates: SyncRetentionCandidate[];
  eligibleCount: number;
  protocolReady: boolean;
  currentEventCount: number;
  currentJournalDigest: string;
  compactionSnapshotId: string | null;
  compactionCreatedAt: string | null;
  devices: SyncRetentionDevice[];
  audit: SyncRetentionAuditEntry[];
  purgeAllowed: boolean;
  blockingReasons: string[];
};

type LocalStoreHealth = {
  path: string;
  status: string;
  schemaVersion: number | null;
  integrity: string;
  recoveryRequired: boolean;
  message: string | null;
};

type LocalStoreSnapshot = {
  schemaVersion: number;
  projects: SyncProject[];
  conversations: Record<string, SyncConversation>;
  tombstones: SyncTombstone[];
};

type SyncV2Result = {
  deviceId: string;
  snapshot: LocalStoreSnapshot;
  health: SyncHealth;
  importedEvents: number;
  writtenEvents: number;
  blockedDevices: string[];
  warnings: string[];
  canWrite: boolean;
};

type V1ImportReport = {
  sourcePath: string;
  sourceSha256: string;
  projectsSeen: number;
  conversationsSeen: number;
  messagesSeen: number;
  workItemsSeen: number;
  insertedProjects: number;
  insertedConversations: number;
  insertedMessages: number;
  insertedWorkItems: number;
  alreadyImported: boolean;
};

const projectNameFromPath = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

const projectNameForMerge = (
  incomingName: string | null | undefined,
  localName: string | null | undefined,
) => {
  const incoming = incomingName?.trim() ?? "";
  const local = localName?.trim() ?? "";
  if (!incoming) return local;
  // Path identity is case-insensitive on Windows, but the project label is not.
  // Keep the local spelling when sync only differs in letter case.
  return local && local.toLowerCase() === incoming.toLowerCase()
    ? local
    : incoming;
};

const normalizePath = (path: string) =>
  path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

const hashText = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const oneDriveRootFrom = (path: string) => {
  const match = path.match(/^(.*?)[\\/]OneDrive(?:[\\/]|$)/i);
  return match ? `${match[1]}\\OneDrive` : null;
};

const relativeOneDrivePath = (path: string) => {
  const match = path.match(/^[^]*?[\\/]OneDrive[\\/](.+)$/i);
  return match?.[1]?.replaceAll("\\", "/") ?? null;
};

const projectIdFromPath = (
  path: string,
  relativePath: string | null = relativeOneDrivePath(path),
) =>
  `project-${hashText(relativePath ? `onedrive/${relativePath.toLowerCase()}` : normalizePath(path))}`;

const projectFromPath = (
  name: string,
  path: string,
  threads?: string[],
): Project => {
  const relativePath = relativeOneDrivePath(path);
  return {
    id: projectIdFromPath(path, relativePath),
    name,
    path,
    relativePath,
    threads: threads ?? ["Új beszélgetés"],
  };
};

const isUntitledConversation = (title: string) =>
  /^Új beszélgetés(?: \d+)?$/i.test(title.trim());

const conversationHasContent = (conversation?: SyncConversation | null) =>
  Boolean(
    conversation &&
      ((conversation.messages?.length ?? 0) > 0 ||
        (conversation.workItems?.length ?? 0) > 0),
  );

const preferredThreadForProject = (
  project: Project,
  cache: Record<string, SyncConversation>,
  preferredTitle: string,
) => {
  const preferred = project.threads.includes(preferredTitle)
    ? preferredTitle
    : "";
  const preferredConversation = preferred
    ? cache[`${project.path}/${preferred}`]
    : undefined;
  if (
    preferred &&
    (!isUntitledConversation(preferred) ||
      conversationHasContent(preferredConversation))
  ) {
    return preferred;
  }

  const populatedThreads = project.threads
    .map((title) => ({
      title,
      conversation: cache[`${project.path}/${title}`],
    }))
    .filter(({ conversation }) => conversationHasContent(conversation))
    .sort((left, right) =>
      (left.conversation?.updatedAt ?? "").localeCompare(
        right.conversation?.updatedAt ?? "",
      ),
    );
  return populatedThreads[populatedThreads.length - 1]?.title || preferred || project.threads[0] || "";
};

const uniqueConversationTitle = (
  project: Project,
  baseTitle: string,
  reservedTitles: string[] = [],
) => {
  let title = baseTitle;
  let suffix = 2;
  const unavailable = new Set(
    [...project.threads, ...reservedTitles].map((value) => value.toLowerCase()),
  );
  while (unavailable.has(title.toLowerCase()))
    title = `${baseTitle} ${suffix++}`;
  return title;
};

const resolveSyncedPath = (
  relativePath: string | null | undefined,
  pathHint: string | undefined,
  workspaceRoot: string,
) => {
  const oneDriveRoot = oneDriveRootFrom(workspaceRoot);
  if (relativePath && oneDriveRoot)
    return `${oneDriveRoot}\\${relativePath.replaceAll("/", "\\")}`;
  return pathHint ?? workspaceRoot;
};

const syncConversationKey = (projectId: string, title: string) =>
  `${projectId}::${title}`;

const syncGeneralConversationKey = (conversationId: string) =>
  generalConversationCacheKey(conversationId);

const normalizeSyncConversation = (
  conversation: SyncConversation,
): SyncConversation => ({
  ...conversation,
  scope: normalizeConversationScope(conversation.scope, conversation.projectId),
  projectId:
    normalizeConversationScope(conversation.scope, conversation.projectId) ===
    "general"
      ? null
      : conversation.projectId ?? null,
});

const normalizeLocalStoreSnapshot = (
  snapshot: LocalStoreSnapshot,
): LocalStoreSnapshot => {
  const conversations: Record<string, SyncConversation> = {};
  const tombstones = snapshot.tombstones ?? [];
  for (const [rawKey, rawConversation] of Object.entries(
    snapshot.conversations ?? {},
  )) {
    const conversation = normalizeSyncConversation(rawConversation);
    const isGeneral =
      conversation.scope === "general" || isGeneralConversationCacheKey(rawKey);
    const conversationId =
      conversation.id ??
      (isGeneral && isGeneralConversationCacheKey(rawKey)
        ? rawKey.slice("general::".length)
        : undefined);
    if (
      conversationId &&
      tombstones.some(
        (tombstone) =>
          tombstone.entityType === "conversation" &&
          tombstone.entityId === conversationId,
      )
    ) {
      // A local/sync snapshot can contain an older row beside its tombstone.
      // Never hydrate that row into the Tree; the tombstone is authoritative.
      continue;
    }
    const key =
      isGeneral && conversationId
        ? generalConversationCacheKey(conversationId)
        : rawKey;
    conversations[key] = {
      ...conversation,
      id: conversationId,
      scope: isGeneral ? "general" : "coding",
      projectId: isGeneral ? null : conversation.projectId,
    };
  }
  return { ...snapshot, conversations };
};

const snapshotForStorage = (snapshot: LocalStoreSnapshot): LocalStoreSnapshot => ({
  ...snapshot,
  conversations: Object.fromEntries(
    Object.entries(snapshot.conversations ?? {})
      .filter(([, conversation]) => conversation.scope !== "coding" || Boolean(conversation.projectId))
      .map(([key, conversation]) => [
        key,
        {
          ...conversation,
          projectId:
            conversation.scope === "general"
              ? GENERAL_PROJECT_ID
              : conversation.projectId,
        },
      ]),
  ),
});

const loadStoredGeneralConversations = (): Record<string, SyncConversation> => {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(GENERAL_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, SyncConversation>;
    const entries: Array<[string, SyncConversation]> = [];
    for (const [key, conversation] of Object.entries(parsed)) {
      const normalized = normalizeSyncConversation(conversation);
      const id =
        normalized.id ??
        (isGeneralConversationCacheKey(key)
          ? key.slice("general::".length)
          : undefined);
      if (!id) continue;
      entries.push([
        generalConversationCacheKey(id),
        {
          ...normalized,
          id,
          scope: "general",
          projectId: null,
        },
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

const persistStoredGeneralConversations = (
  conversations: Record<string, SyncConversation>,
) => {
  const general = Object.fromEntries(
    Object.entries(conversations).filter(
      ([key, conversation]) =>
        conversation.scope === "general" || isGeneralConversationCacheKey(key),
    ),
  );
  localStorage.setItem(GENERAL_HISTORY_STORAGE_KEY, JSON.stringify(general));
};

const tombstoneMatchesProjectPath = (
  tombstone: SyncTombstone,
  project: Project,
) =>
  tombstone.entityType === "project" &&
  (Boolean(
    tombstone.relativePath &&
      project.relativePath &&
      tombstone.relativePath.toLowerCase() ===
        project.relativePath.toLowerCase(),
  ) ||
    Boolean(
      tombstone.pathHint &&
        normalizePath(tombstone.pathHint) === normalizePath(project.path),
    ));

const tombstoneMatchesProject = (tombstone: SyncTombstone, project: Project) =>
  tombstone.entityType === "project" &&
  (tombstone.entityId === project.id ||
    tombstoneMatchesProjectPath(tombstone, project));

const tombstoneMatchesConversation = (
  tombstone: SyncTombstone,
  title: string,
  conversationId?: string | null,
  project?: Pick<Project, "id" | "path" | "relativePath">,
) => {
  if (tombstone.entityType !== "conversation") return false;
  if (conversationId && tombstone.entityId === conversationId) return true;
  if (!tombstone.title || tombstone.title !== title) return false;
  if (!project) return false;
  return (
    tombstone.projectId === project.id ||
    Boolean(
      tombstone.relativePath &&
        project.relativePath &&
        tombstone.relativePath.toLowerCase() ===
          project.relativePath.toLowerCase(),
    ) ||
    Boolean(
      tombstone.pathHint &&
        normalizePath(tombstone.pathHint) === normalizePath(project.path),
    )
  );
};

const tombstoneMatchesProjectScope = (
  tombstone: SyncTombstone,
  project: Project,
) =>
  tombstone.entityType === "project"
    ? tombstoneMatchesProject(tombstone, project) ||
      tombstoneMatchesProjectPath(tombstone, project)
    : tombstone.entityType === "conversation" &&
      (tombstone.projectId === project.id ||
        Boolean(
          tombstone.relativePath &&
            project.relativePath &&
            tombstone.relativePath.toLowerCase() ===
              project.relativePath.toLowerCase(),
        ) ||
        Boolean(
          tombstone.pathHint &&
            normalizePath(tombstone.pathHint) === normalizePath(project.path),
        ));

const getDeviceId = () => {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
};

const createEntityId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `entity-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const parseMessageTimestamp = (value: string | undefined) => {
  if (!value || value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const messagePromptTimestamp = (message: Pick<Message, "time" | "sequence">) => {
  const storedTimestamp = parseMessageTimestamp(message.time);
  if (storedTimestamp !== undefined) return storedTimestamp;
  // Older rows kept `time: "most"`, but their timeline sequence is a
  // millisecond timestamp. Use it only when it is clearly epoch-ms data;
  // imported legacy sequence numbers must not turn into 00:00.
  return typeof message.sequence === "number" && message.sequence > 1e12
    ? message.sequence
    : undefined;
};

const treeConversationTimestamp = (
  conversation: SyncConversation | undefined,
  mode: TreeSortMode,
) => {
  if (!conversation) return 0;
  const messageTimes = (conversation.messages ?? [])
    .filter((message) => mode !== "time" || message.role === "user")
    .map((message) => messagePromptTimestamp(message))
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  const activityTimes = (conversation.workItems ?? [])
    .map((item) => parseMessageTimestamp(item.time))
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  const allTimes = [...messageTimes, ...activityTimes];
  const updatedTimestamp = parseMessageTimestamp(conversation.updatedAt);
  if (mode === "time") {
    return messageTimes[0] !== undefined
      ? Math.min(...messageTimes)
      : allTimes.length > 0
        ? Math.min(...allTimes)
        : updatedTimestamp ?? 0;
  }
  return Math.max(updatedTimestamp ?? 0, ...allTimes);
};

const treeProjectTimestamp = (
  project: Project,
  cache: Record<string, SyncConversation>,
  mode: TreeSortMode,
) =>
  Math.max(
    0,
    ...project.threads.map((title) =>
      treeConversationTimestamp(cache[`${project.path}/${title}`], mode),
    ),
  );

const compareTreeItems = (
  leftTimestamp: number,
  rightTimestamp: number,
  leftLabel: string,
  rightLabel: string,
) => rightTimestamp - leftTimestamp || leftLabel.localeCompare(rightLabel);

const formatPromptTime = (timestamp: number | undefined) => {
  if (timestamp === undefined) return "";
  return new Intl.DateTimeFormat("hu-HU", {
    timeZone: "Europe/Budapest",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
};


const projectIdentityKey = (project: Pick<Project, "path" | "relativePath">) =>
  project.relativePath?.trim().toLowerCase() || normalizePath(project.path);

const dedupeProjects = (items: Project[]) => {
  const byIdentity = new Map<string, Project>();
  for (const item of items) {
    const key = projectIdentityKey(item);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, item);
      continue;
    }
    byIdentity.set(key, {
      ...existing,
      name: projectNameForMerge(item.name, existing.name),
      threads: [...new Set([...existing.threads, ...item.threads])],
    });
  }
  return [...byIdentity.values()];
};

const loadStoredProjects = (): Project[] => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]",
    ) as Array<Partial<Project>>;
    if (!Array.isArray(saved)) return [];
    return dedupeProjects(
      saved
        .filter(
          (project) =>
            typeof project.name === "string" &&
            typeof project.path === "string" &&
            project.path.length > 0,
        )
        .map((project) =>
          projectFromPath(
            project.name as string,
            project.path as string,
            Array.isArray(project.threads)
              ? project.threads.filter(
                  (thread): thread is string => typeof thread === "string",
                )
              : [],
          ),
        ),
    );
  } catch {
    return [];
  }
};

const loadInitialMessages = () => {
  const storedProjects = loadStoredProjects();
  const activeProjectName = localStorage.getItem("min-active-project") ?? "";
  const project =
    storedProjects.find((candidate) => candidate.name === activeProjectName) ??
    storedProjects[0];
  const thread =
    localStorage.getItem("min-active-thread") ?? project?.threads[0];
  return project && thread
    ? loadThreadMessages(`${project.path}/${thread}`)
    : [];
};

const compactMessages = (messages: Message[]) => {
  const compacted: Message[] = [];
  for (const message of messages) {
    const previous = compacted[compacted.length - 1];
    // Same turn as well as same item: a provider labels content blocks by
    // position, so every turn's first answer block is `assistant-0`. A chain
    // runs each stage as its own turn, so the planner's answer and the coder's
    // answer are adjacent and both `assistant-0` -- gluing on the item alone
    // appended the coder's summary to the plan and destroyed its row, which is
    // why the KÓD tab was missing and the run's answer showed the review.
    // `messageIdentityKeys` already scopes an item id to its turn; this is the
    // one place that had not been told.
    if (
      message.role === "assistant" &&
      message.itemId &&
      previous?.role === "assistant" &&
      previous.itemId === message.itemId &&
      (previous.turnId ?? "") === (message.turnId ?? "")
    ) {
      const final = Boolean(previous.final || message.final);
      compacted[compacted.length - 1] = {
        ...previous,
        text: `${previous.text}${message.text}`,
        // A final response must never be resurrected as a live spinner when
        // a stale streamed copy is merged back from the local cache.
        live: final ? false : Boolean(previous.live || message.live),
        final,
        interrupted: message.interrupted ?? previous.interrupted,
        turnId: previous.turnId ?? message.turnId,
      };
    } else {
      compacted.push(message);
    }
  }
  return compacted;
};

const repairHistoricalAssistantText = (message: Message): Message => {
  const text = collapseRepeatedAssistantText(message.role, message.text);
  const repaired = text === message.text ? message : { ...message, text };
  // The layout choice used to live only in this browser profile, so every other
  // device fell back to the detailed trace and rendered the same turn
  // differently. Lift the remembered value onto the message once, so the next
  // save carries it to SQLite and from there to the journal.
  if (repaired.detailed !== undefined) return repaired;
  const remembered = rememberedDetailMode(repaired.id);
  return remembered === undefined
    ? repaired
    : { ...repaired, detailed: remembered };
};

// A Codex request cannot remain live across an app reload. Every persisted
// assistant row is therefore settled and never remains an active stream.
const interruptedMarkerPattern = /(?:\n\s*){0,2}A válasz megszakítva\.?\s*$/i;

// A persisted assistant row may still be a provisional failure marker when
// the WebView was closed during the finalization race. Treat it as an
// incomplete version only while merging the same logical message identity.
// When no completed copy exists, the marker is real conversation history and
// must remain visible after reload.
const persistedUnavailableAssistantPattern =
  /^(?:A v\u00e1lasz megszak\u00edtva\.?|Nem siker\u00fclt a Codex-k\u00e9r\u00e9s:)/i;

const isUnavailablePersistedAssistant = (message: Message) => {
  if (message.role !== "assistant") return false;
  const text = message.text.trim();
  // A known failure marker is never useful content, even if an older client
  // accidentally left its live bit set. Empty rows are hidden only after
  // they have settled so an active stream can still render its spinner.
  return (
    persistedUnavailableAssistantPattern.test(text) ||
    (!message.live && !text)
  );
};

const dropUnrecoverablePersistedAnswers = (messages: Message[]) =>
  messages.filter(
    (message, index) =>
      message.role !== "assistant" ||
      message.live ||
      Boolean(message.text.trim()) ||
      Boolean(message.images?.length) ||
      // Keep a durable empty assistant row when it belongs to a submitted
      // user turn. There is no answer text to recover, but silently deleting
      // the row makes the GUI look as if conversation history vanished.
      messages[index - 1]?.role === "user",
  );

const stripStaleInterruptionMarker = (message: Message): Message => {
  if (message.role !== "assistant" || message.interrupted) return message;
  const cleaned = message.text.replace(interruptedMarkerPattern, "").trimEnd();
  return cleaned === message.text ? message : { ...message, text: cleaned };
};

// Settling a persisted row must never invent an interruption message for an
// empty placeholder. Explicit interruption/error text already stored in the
// row is conversation history, even when an older client omitted the private
// `interrupted` flag, so reloading must not erase it.
const settleInterruptedMessages = (messages: Message[]) =>
  messages.map((message) => {
    return message.role === "assistant"
      ? {
          ...message,
          text:
            message.text.trim() ||
            (message.interrupted ? "A válasz megszakítva." : ""),
          live: false,
          final: true,
        }
      : message;
  });

// One spelling rule for conversation keys, shared with the addressing layer.
// Two copies of it was how a write could be dropped in one place and land in
// another.
const normalizedThreadStorageKey = normalizeConversationKey;

const threadStorageParts = (key: string) => {
  const normalized = normalizedThreadStorageKey(key);
  const separator = normalized.lastIndexOf("\\");
  return {
    path: separator >= 0 ? normalized.slice(0, separator) : "",
    title: separator >= 0 ? normalized.slice(separator + 1) : normalized,
  };
};

const threadStoragePathTail = (path: string) =>
  path.split("\\").filter(Boolean).slice(-3).join("\\");

const findStoredThreadValue = (
  saved: Record<string, unknown>,
  key: string,
  isUseful: (value: unknown) => boolean = () => true,
) => {
  const direct = saved[key];
  if (direct !== undefined && isUseful(direct)) return direct;

  const target = threadStorageParts(key);
  const targetTail = threadStoragePathTail(target.path);
  const candidates = Object.entries(saved);
  const normalizedMatch = candidates.find(
    ([candidate, value]) =>
      normalizedThreadStorageKey(candidate) ===
        normalizedThreadStorageKey(key) && isUseful(value),
  );
  if (normalizedMatch) return normalizedMatch[1];

  // Sync can canonicalize a Windows path (for example by adding/removing
  // the \\?\\ prefix) while the browser storage still uses the previous
  // thread key. Keep a non-empty local trace when the title and the
  // project-path tail identify the same conversation.
  const compatibleMatch = candidates.find(([candidate, value]) => {
    if (!isUseful(value)) return false;
    const parts = threadStorageParts(candidate);
    return (
      parts.title === target.title &&
      Boolean(targetTail) &&
      (parts.path.endsWith(targetTail) ||
        targetTail.endsWith(threadStoragePathTail(parts.path)))
    );
  });
  return compatibleMatch?.[1] ?? direct;
};

const findCachedConversation = (
  cache: Record<string, SyncConversation>,
  key: string,
) => {
  const candidate = findStoredThreadValue(
    cache as Record<string, unknown>,
    key,
    (value): value is SyncConversation => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      return Array.isArray((value as Partial<SyncConversation>).messages);
    },
  );
  return candidate as SyncConversation | undefined;
};

const conversationContextForRehydration = (messages: Message[]) =>
  compactMessages(messages)
    .filter(
      (message) =>
        !message.live &&
        (message.text.trim().length > 0 || Boolean(message.images?.length)) &&
        !message.text.startsWith("Nem sikerült a Codex-kérés:"),
    )
    .slice(-40)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}${messageImageContext(message)}`,
    )
    .join("\n\n");

const loadLocalThreadIds = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(LOCAL_THREAD_IDS_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0,
      ),
    );
  } catch {
    return {};
  }
};

const timelinePhysicalKey = (hlc?: string, sequence?: number) => {
  const match = hlc?.trim().match(/^(\d{20})-\d{8}$/);
  if (match) return match[1];
  if (typeof sequence === "number" && Number.isFinite(sequence))
    return Math.trunc(sequence).toString().padStart(20, "0");
  return "";
};

const timelinePhysicalMillis = (hlc?: string) => {
  const key = timelinePhysicalKey(hlc);
  if (!key) return Number.NaN;
  try {
    const value = Number(BigInt(key));
    return Number.isSafeInteger(value) ? value : Number.NaN;
  } catch {
    return Number.NaN;
  }
};

const compareTimelineOrder = (left: TimelineOrder, right: TimelineOrder) => {
  // `sequence` is the immutable conversation position. An HLC belongs to the
  // latest sync upsert, so restoring or finalizing an older row can legitimately
  // give it a newer HLC. Sorting by HLC first would then move the old answer
  // below a later user message and attach the wrong LÉPÉSEK panel to it.
  const leftSequence = left.sequence;
  const rightSequence = right.sequence;
  if (
    typeof leftSequence === "number" &&
    Number.isFinite(leftSequence) &&
    typeof rightSequence === "number" &&
    Number.isFinite(rightSequence) &&
    leftSequence !== rightSequence
  ) {
    return leftSequence - rightSequence;
  }

  const leftHlc = left.hlc?.trim() ?? "";
  const rightHlc = right.hlc?.trim() ?? "";
  if (leftHlc && rightHlc) {
    return (
      leftHlc.localeCompare(rightHlc) ||
      (left.originDeviceId ?? "").localeCompare(right.originDeviceId ?? "") ||
      (left.sequence ?? 0) - (right.sequence ?? 0) ||
      (left.tieBreaker ?? "").localeCompare(right.tieBreaker ?? "")
    );
  }

  const leftPhysical = timelinePhysicalKey(leftHlc, left.sequence);
  const rightPhysical = timelinePhysicalKey(rightHlc, right.sequence);
  if (leftPhysical && rightPhysical && leftPhysical !== rightPhysical) {
    return leftPhysical.localeCompare(rightPhysical);
  }
  return (
    (left.sequence ?? 0) - (right.sequence ?? 0) ||
    (left.originDeviceId ?? "").localeCompare(right.originDeviceId ?? "") ||
    (leftHlc ? 1 : 0) - (rightHlc ? 1 : 0) ||
    (left.tieBreaker ?? "").localeCompare(right.tieBreaker ?? "")
  );
};

const compareMessages = (left: Message, right: Message) =>
  compareTimelineOrder(
    {
      hlc: left.hlc,
      originDeviceId: left.originDeviceId,
      sequence: left.sequence,
      tieBreaker: left.id,
    },
    {
      hlc: right.hlc,
      originDeviceId: right.originDeviceId,
      sequence: right.sequence,
      tieBreaker: right.id,
    },
  );

const compareWorkItems = (left: CodeActivity, right: CodeActivity) =>
  compareTimelineOrder(
    {
      hlc: left.hlc,
      originDeviceId: left.originDeviceId,
      sequence: left.id,
      tieBreaker: left.itemId ?? left.eventType,
    },
    {
      hlc: right.hlc,
      originDeviceId: right.originDeviceId,
      sequence: right.id,
      tieBreaker: right.itemId ?? right.eventType,
    },
  );

/**
 * A chain's outer request carries a live bubble that the first stage's stream
 * fills, and that bubble reaches SQLite before the run can delete it. Loading
 * it back put a badge-less twin of the plan beside the real stage answer, and
 * the merge below then kept the twin -- the plan lost its badge and its tab
 * vanished from the run. The outer request never answers on its own, so any
 * row whose turn has stages of its own is dropped on the way in.
 */
const withoutChainPlaceholders = (messages: Message[]) => {
  const turnsWithStages = new Set<string>();
  for (const message of messages) {
    const marker = message.turnId?.indexOf("-stage-") ?? -1;
    if (marker > 0) turnsWithStages.add(message.turnId!.slice(0, marker));
  }
  if (turnsWithStages.size === 0) return messages;
  return messages.filter(
    (message) =>
      message.role !== "assistant" ||
      !message.turnId ||
      !turnsWithStages.has(message.turnId),
  );
};

const mergeMessages = (
  primary: Message[],
  secondary: Message[] = [],
  settleInterrupted = false,
) => {
  const merged = coalesceMessageIdentities(
    withoutChainPlaceholders([...primary, ...secondary]),
    (existing, message) => {
      // Sync and SQLite can contain the same row with different private/runtime
      // fields. Keep the most complete text and merge lifecycle flags instead of
      // letting the sanitized remote copy hide the local live/final state.
      const final = Boolean(existing.final || message.final);
      const existingUnavailable = isUnavailablePersistedAssistant(existing);
      const messageUnavailable = isUnavailablePersistedAssistant(message);
      const preferIncomingSettledAssistant =
        isNewerSettledAssistantVersion(existing, message);
      // A submitted user payload is immutable. In particular, never let the
      // old "longer text wins" assistant heuristic splice two user turns when
      // a stale cache and a pulled snapshot meet.
      const mergedText =
        preferIncomingSettledAssistant
          ? message.text
          : existing.role === "user"
          ? existing.text
          : existingUnavailable && !messageUnavailable
            ? message.text
            : !existingUnavailable && messageUnavailable
              ? existing.text
              : bothAssistantVersionsAreSettled(existing, message)
                ? existing.text
                : message.text.trim().length > existing.text.trim().length
                  ? message.text
                  : existing.text;
      return {
        ...existing,
        time:
          preferIncomingSettledAssistant
            ? message.time
            : existing.role === "user" ||
          parseMessageTimestamp(existing.time) !== undefined ||
          parseMessageTimestamp(message.time) === undefined
            ? existing.time
            : message.time,
        text: mergedText,
        code: existing.code ?? message.code,
        // Prefer the settled lifecycle once either source knows that the
        // answer is final. Otherwise a stale SQLite/browser row can hide the
        // answer by keeping the merged row in the live state forever.
        live: final ? false : Boolean(existing.live || message.live),
        final,
        interrupted: message.interrupted ?? existing.interrupted,
        id: preferIncomingSettledAssistant
          ? message.id ?? existing.id
          : existing.id ?? message.id,
        itemId: preferIncomingSettledAssistant
          ? message.itemId ?? existing.itemId
          : existing.itemId ?? message.itemId,
        sequence: preferIncomingSettledAssistant
          ? message.sequence ?? existing.sequence
          : existing.sequence ?? message.sequence,
        turnId: message.turnId ?? existing.turnId,
        hlc: existing.hlc ?? message.hlc,
        originDeviceId: existing.originDeviceId ?? message.originDeviceId,
        images:
          existing.role === "user"
            ? existing.images
            : existing.images && existing.images.length > 0
              ? existing.images
              : message.images,
        quoteRefs:
          existing.role === "user"
            ? existing.quoteRefs
            : existing.quoteRefs && existing.quoteRefs.length > 0
              ? existing.quoteRefs
              : message.quoteRefs,
        detailed: existing.detailed ?? message.detailed,
        changeSummary:
          existing.changeSummary && existing.changeSummary.length > 0
            ? existing.changeSummary
            : message.changeSummary,
      };
    },
  );
  const compacted = compactMessages(merged).map(repairHistoricalAssistantText);
  const ordered = (settleInterrupted
    ? settleInterruptedMessages(compacted)
    : compacted
  ).sort(compareMessages);
  return collapseAbandonedRegenerationRetries(ordered);
};

const mergeLocalStoreSnapshotForHydration = (
  syncSnapshot: LocalStoreSnapshot,
  localSnapshot: LocalStoreSnapshot,
): LocalStoreSnapshot => {
  const conversations = { ...syncSnapshot.conversations };
  const tombstones = syncSnapshot.tombstones ?? [];
  for (const [rawKey, localConversation] of Object.entries(
    localSnapshot.conversations ?? {},
  )) {
    if (
      localConversation.id &&
      tombstones.some(
        (tombstone) =>
          tombstone.entityType === "conversation" &&
          tombstone.entityId === localConversation.id,
      )
    ) {
      continue;
    }
    const existingEntry = Object.entries(conversations).find(
      ([key, conversation]) =>
        key === rawKey ||
        Boolean(
          localConversation.id &&
            conversation.id &&
            localConversation.id === conversation.id,
        ),
    );
    if (!existingEntry) {
      conversations[rawKey] = localConversation;
      continue;
    }
    const [key, conversation] = existingEntry;
    conversations[key] = {
      ...conversation,
      messages: mergeMessages(
        conversation.messages ?? [],
        localConversation.messages ?? [],
      ),
    };
  }
  return { ...syncSnapshot, conversations };
};

const loadThreadMessages = (key: string): Message[] => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const messages = findStoredThreadValue(
      saved,
      key,
      (value) => Array.isArray(value) && value.length > 0,
    ) as Message[] | undefined;
    return Array.isArray(messages)
      ? dropUnrecoverablePersistedAnswers(
          settleInterruptedMessages(
            compactMessages(
              messages.filter(
                (message) =>
                  message &&
                  (message.role === "user" || message.role === "assistant") &&
                  typeof message.text === "string",
              ),
            ).map(repairHistoricalAssistantText),
          ).sort(compareMessages),
        )
      : [];
  } catch {
    return [];
  }
};

const loadStoredMessageMap = (): Record<string, Message[]> => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, Message[]>;
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
};

const saveThreadMessages = (key: string, messages: Message[]) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, Message[]>;
    localStorage.setItem(
      MESSAGE_HISTORY_STORAGE_KEY,
      JSON.stringify({
        ...saved,
        [key]: messages.map(repairHistoricalAssistantText),
      }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const rememberDetailMode = (messageId: string | undefined, detailed: boolean) => {
  if (typeof window === "undefined" || !messageId) return;
  try {
    const saved = JSON.parse(
      localStorage.getItem(DETAIL_MODE_STORAGE_KEY) ?? "{}",
    ) as Record<string, boolean>;
    localStorage.setItem(
      DETAIL_MODE_STORAGE_KEY,
      JSON.stringify({ ...saved, [messageId]: detailed }),
    );
  } catch {
    // A storage quota error must not affect sending a prompt.
  }
};

const rememberedDetailMode = (messageId: string | undefined) => {
  if (typeof window === "undefined" || !messageId) return undefined;
  try {
    const saved = JSON.parse(
      localStorage.getItem(DETAIL_MODE_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const savedMode = saved[messageId];
    return typeof savedMode === "boolean" ? savedMode : undefined;
  } catch {
    return undefined;
  }
};

const messageUsesDetailedTrace = (message: Message) => {
  if (typeof message.detailed === "boolean") return message.detailed;
  const remembered = rememberedDetailMode(message.id);
  if (remembered !== undefined) return remembered;
  // Messages created before the toggle existed retain their established UI.
  return true;
};

const workItemKinds = new Set<WorkItemKind>([
  "status",
  "reasoning",
  "command",
  "file",
  "tool",
]);
const workItemStatuses = new Set<WorkItemStatus>(["running", "done", "error"]);

const inferWorkItemKind = (eventType: string, label = ""): WorkItemKind => {
  const value = `${eventType} ${label}`.toLowerCase();
  if (
    value.includes("reason") ||
    value.includes("think") ||
    value.includes("gondolk")
  )
    return "reasoning";
  if (
    value.includes("command") ||
    value.includes("terminal") ||
    value.includes("exec") ||
    value.includes("paranc")
  )
    return "command";
  if (
    value.includes("file") ||
    value.includes("patch") ||
    value.includes("fájl")
  )
    return "file";
  if (
    value.includes("tool") ||
    value.includes("mcp") ||
    value.includes("search") ||
    value.includes("eszköz")
  )
    return "tool";
  return "status";
};

const ignoredWorkEventTypes = new Set([
  "account/ratelimits/updated",
  "mcpserver/startupstatus/updated",
  "skills/changed",
  "thread/goal/cleared",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenusage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/started",
]);

const isIgnoredWorkEventType = (eventType: string) =>
  ignoredWorkEventTypes.has(eventType.toLowerCase());

const normalizeWorkItem = (
  value: unknown,
  index: number,
): CodeActivity | null => {
  const raw = asRecord(value);
  if (typeof raw.label !== "string" || typeof raw.detail !== "string")
    return null;
  const eventType =
    typeof raw.eventType === "string" ? raw.eventType : "work/item";
  const label = raw.label;
  const kind =
    typeof raw.kind === "string" && workItemKinds.has(raw.kind as WorkItemKind)
      ? (raw.kind as WorkItemKind)
      : inferWorkItemKind(eventType, label);
  const status =
    typeof raw.status === "string" &&
    workItemStatuses.has(raw.status as WorkItemStatus)
      ? (raw.status as WorkItemStatus)
      : /completed|finished|succeeded|done/i.test(eventType)
        ? "done"
        : /error|failed|rejected/i.test(eventType)
          ? "error"
          : "running";
  const id =
    typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : index;
  return {
    id,
    itemId: typeof raw.itemId === "string" ? raw.itemId : undefined,
    turnId: typeof raw.turnId === "string" ? raw.turnId : undefined,
    planStepId: typeof raw.planStepId === "string" ? raw.planStepId : undefined,
    kind,
    status,
    label,
    detail: raw.detail,
    eventType,
    time: typeof raw.time === "string" ? raw.time : "most",
    body: typeof raw.body === "string" ? raw.body : undefined,
    code: typeof raw.code === "string" ? raw.code : undefined,
    beforeCode: typeof raw.beforeCode === "string" ? raw.beforeCode : undefined,
    afterCode: typeof raw.afterCode === "string" ? raw.afterCode : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
    hlc: typeof raw.hlc === "string" ? raw.hlc : undefined,
    originDeviceId:
      typeof raw.originDeviceId === "string" ? raw.originDeviceId : undefined,
  };
};

const workItemMergeKey = (item: CodeActivity) =>
  item.itemId ?? `${item.id}:${item.eventType}:${item.detail}`;

const mergeWorkItems = (
  primary: CodeActivity[],
  secondary: CodeActivity[] = [],
) => {
  const merged: CodeActivity[] = [];
  const indexes = new Map<string, number>();
  for (const item of [...primary, ...secondary]) {
    if (isIgnoredWorkEventType(item.eventType)) continue;
    const key = workItemMergeKey(item);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(item);
      continue;
    }

    // Shared/synced work items intentionally omit private reasoning and code
    // payloads. When that sanitized copy is merged before the device-local
    // copy, a simple "first item wins" merge silently erased the detailed
    // live trace after completion. Keep the authoritative structural fields
    // from the first copy, but fill private payloads from whichever copy has
    // them (normally the local secondary list).
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      planStepId: existing.planStepId ?? item.planStepId,
      body: existing.body?.trim() ? existing.body : item.body,
      code: existing.code?.trim() ? existing.code : item.code,
      beforeCode: existing.beforeCode ?? item.beforeCode,
      afterCode: existing.afterCode?.trim()
        ? existing.afterCode
        : item.afterCode,
      language: existing.language ?? item.language,
    };
  }
  return merged.sort(compareWorkItems).slice(-MAX_WORK_ITEMS_PER_THREAD);
};

const mergePlanHistory = (
  primary: Record<string, PlanSnapshot> = {},
  secondary: Record<string, PlanSnapshot> = {},
) => mergePlanHistoryRecords(primary, secondary);

const mergeCommentary = (
  primary: CommentaryEntry[] = [],
  secondary: CommentaryEntry[] = [],
) => {
  const merged: CommentaryEntry[] = [];
  const indexes = new Map<string, number>();
  for (const entry of [...primary, ...secondary]) {
    const key = entry.id;
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(entry);
    } else {
      merged[existingIndex] = { ...merged[existingIndex], ...entry };
    }
  }
  return merged
    .sort(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(-MAX_COMMENTARY_ENTRIES_PER_THREAD);
};

const loadThreadWorkItems = (key: string): CodeActivity[] => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const items = findStoredThreadValue(
      saved,
      key,
      (value) => Array.isArray(value) && value.length > 0,
    );
    return Array.isArray(items)
      ? items
          .map((item, index) => normalizeWorkItem(item, index))
          .filter(
            (item): item is CodeActivity =>
              item !== null && !isIgnoredWorkEventType(item.eventType),
          )
          .sort(compareWorkItems)
          .slice(-MAX_WORK_ITEMS_PER_THREAD)
      : [];
  } catch {
    return [];
  }
};

const loadStoredWorkItemMap = (): Record<string, CodeActivity[]> => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(saved).map(([key, items]) => [
        key,
        Array.isArray(items)
          ? items
              .map((item, index) => normalizeWorkItem(item, index))
              .filter(
                (item): item is CodeActivity =>
                  item !== null && !isIgnoredWorkEventType(item.eventType),
              )
              .slice(-MAX_WORK_ITEMS_PER_THREAD)
          : [],
      ]),
    );
  } catch {
    return {};
  }
};

const saveThreadWorkItems = (key: string, items: CodeActivity[]) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}",
    ) as Record<string, CodeActivity[]>;
    localStorage.setItem(
      WORK_LOG_STORAGE_KEY,
      JSON.stringify({ ...saved, [key]: items }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const normalizePlanStepStatus = (value: unknown): PlanStepStatus => {
  const status = String(value ?? "pending")
    .toLowerCase()
    .replaceAll("_", "");
  if (
    status.includes("complete") ||
    status.includes("done") ||
    status.includes("finish") ||
    status.includes("success")
  )
    return "completed";
  if (
    status.includes("progress") ||
    status.includes("running") ||
    status.includes("active") ||
    status.includes("current")
  )
    return "inProgress";
  if (
    status.includes("error") ||
    status.includes("fail") ||
    status.includes("reject")
  )
    return "error";
  return "pending";
};

const normalizePlanSteps = (value: unknown): PlanStep[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      if (typeof entry === "string") {
        return {
          id: `plan-${index}`,
          step: entry.trim(),
          status: "pending" as const,
        };
      }
      const raw = asRecord(entry);
      const step = firstString(
        raw.step,
        raw.title,
        raw.label,
        raw.description,
        raw.text,
      );
      if (!step) return null;
      const id =
        firstString(raw.id, raw.stepId, raw.step_id) ?? `plan-${index}`;
      return {
        id,
        step: step.trim(),
        status: normalizePlanStepStatus(raw.status),
      };
    })
    .filter((step): step is PlanStep => Boolean(step && step.step));
};

const normalizePlanSnapshot = (
  value: unknown,
  fallbackTurnId: string | null = null,
): PlanSnapshot | null => {
  const raw = asRecord(value);
  const steps = normalizePlanSteps(raw.plan ?? raw.steps ?? raw.items);
  if (steps.length === 0) return null;
  const rawStepTimes = asRecord(raw.stepTimes ?? raw.step_times);
  const stepTimes: Record<string, PlanStepTiming> = {};
  for (const [stepId, value] of Object.entries(rawStepTimes)) {
    const timing = asRecord(value);
    const startedAt =
      typeof timing.startedAt === "number" && Number.isFinite(timing.startedAt)
        ? timing.startedAt
        : undefined;
    const completedAt =
      typeof timing.completedAt === "number" && Number.isFinite(timing.completedAt)
        ? timing.completedAt
        : undefined;
    if (startedAt !== undefined || completedAt !== undefined)
      stepTimes[stepId] = { startedAt, completedAt };
  }
  const startedAt =
    typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
      ? raw.startedAt
      : undefined;
  const completedAt =
    typeof raw.completedAt === "number" && Number.isFinite(raw.completedAt)
      ? raw.completedAt
      : undefined;
  return {
    turnId: firstString(raw.turnId, raw.turn_id) ?? fallbackTurnId,
    explanation:
      firstString(raw.explanation, raw.explanationText, raw.reason) ?? "",
    steps,
    startedAt,
    completedAt,
    stepTimes: Object.keys(stepTimes).length > 0 ? stepTimes : undefined,
  };
};

const planWithTiming = (
  previous: PlanSnapshot,
  steps: PlanStep[],
  now: number,
  completedAt?: number,
): PlanSnapshot => {
  const stepTimes: Record<string, PlanStepTiming> = {
    ...(previous.stepTimes ?? {}),
  };
  for (const [index, step] of steps.entries()) {
    const previousTiming = stepTimes[step.id] ?? {};
    const finished = step.status === "completed" || step.status === "error";
    // A plan snapshot describes the state at `now`; it must not use the
    // request's original start time as the timestamp for every new step.
    // When a server sends a completed step without an earlier in-progress
    // snapshot, use the previous step's completion (or the turn start) as a
    // best available start instead of manufacturing a zero-length interval.
    const precedingCompletion = steps
      .slice(0, index)
      .reverse()
      .map((candidate) => stepTimes[candidate.id]?.completedAt)
      .find((value): value is number => Number.isFinite(value));
    const startedAt =
      previousTiming.startedAt ??
      (step.status === "inProgress"
        ? now
        : step.status === "completed" || step.status === "error"
          ? precedingCompletion ?? previous.startedAt ?? now
          : undefined);
    stepTimes[step.id] = {
      startedAt,
      completedAt:
        previousTiming.completedAt ?? (finished ? now : undefined),
    };
  }
  const firstRealStep = steps.find(
    (step) =>
      step.id !== "client-pre-plan" && !step.id.startsWith("client-fallback"),
  );
  const preparationTiming = stepTimes["client-pre-plan"];
  const firstRealStart = firstRealStep
    ? stepTimes[firstRealStep.id]?.startedAt
    : undefined;
  if (
    preparationTiming?.startedAt !== undefined &&
    preparationTiming.completedAt === undefined &&
    firstRealStart !== undefined &&
    firstRealStart >= preparationTiming.startedAt
  ) {
    stepTimes["client-pre-plan"] = {
      ...preparationTiming,
      completedAt: firstRealStart,
    };
  }
  return {
    ...previous,
    steps,
    startedAt: previous.startedAt ?? now,
    completedAt: completedAt ?? previous.completedAt,
    stepTimes,
  };
};

const planTextToSteps = (text: string): PlanStep[] =>
  text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, ""),
    )
    .filter(
      (line) =>
        line.length > 2 && !/^plan:?$/i.test(line) && !/^terv:?$/i.test(line),
    )
    .slice(0, 8)
    .map((step, index) => ({
      id: `plan-text-${index}`,
      step,
      status: "pending" as const,
    }));

const loadThreadPlan = (key: string): PlanSnapshot => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const raw = asRecord(
      findStoredThreadValue(saved, key, (value) => {
        const candidate = asRecord(value);
        return (
          normalizePlanSteps(candidate.steps).length > 0 ||
          Boolean(
            asRecord(candidate.byTurn) &&
              Object.keys(asRecord(candidate.byTurn)).length > 0,
          )
        );
      }),
    );
    const steps = normalizePlanSteps(raw.steps);
    const normalized = normalizePlanSnapshot(raw, null);
    return {
      turnId: firstString(raw.turnId, raw.turn_id) ?? null,
      explanation: firstString(raw.explanation) ?? "",
      steps,
      startedAt: normalized?.startedAt,
      completedAt: normalized?.completedAt,
      stepTimes: normalized?.stepTimes,
    };
  } catch {
    return { turnId: null, explanation: "", steps: [] };
  }
};

const saveThreadPlan = (key: string, plan: PlanSnapshot) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, PlanSnapshot>;
    localStorage.setItem(
      PLAN_STORAGE_KEY,
      JSON.stringify({ ...saved, [key]: plan }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const loadThreadPlanHistory = (key: string): Record<string, PlanSnapshot> => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const raw = asRecord(
      findStoredThreadValue(saved, key, (value) => {
        const candidate = asRecord(value);
        return (
          normalizePlanSteps(candidate.steps).length > 0 ||
          Boolean(
            asRecord(candidate.byTurn) &&
              Object.keys(asRecord(candidate.byTurn)).length > 0,
          )
        );
      }),
    );
    const history = asRecord(raw.byTurn);
    const normalized = Object.fromEntries(
      Object.entries(history)
        .map(([turnId, value]) => {
          const snapshot = normalizePlanSnapshot(value, turnId);
          return [turnId, snapshot];
        })
        .filter((entry): entry is [string, PlanSnapshot] => Boolean(entry[1])),
    );
    if (Object.keys(normalized).length > 0) return normalized;
    const legacy = normalizePlanSnapshot(
      raw,
      firstString(raw.turnId, raw.turn_id),
    );
    return legacy ? { [legacy.turnId ?? "legacy"]: legacy } : {};
  } catch {
    return {};
  }
};

const saveThreadPlanHistory = (
  key: string,
  history: Record<string, PlanSnapshot>,
) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const latest = Object.values(history).at(-1);
    localStorage.setItem(
      PLAN_STORAGE_KEY,
      JSON.stringify({
        ...saved,
        [key]: {
          ...(latest ?? { turnId: null, explanation: "", steps: [] }),
          byTurn: history,
        },
      }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const loadThreadCommentary = (key: string): CommentaryEntry[] => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(COMMENTARY_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const entries = findStoredThreadValue(
      saved,
      key,
      (value) => Array.isArray(value) && value.length > 0,
    );
    return Array.isArray(entries)
      ? entries.flatMap((entry): CommentaryEntry[] => {
          const raw = asRecord(entry);
          if (typeof raw.id !== "string" || typeof raw.body !== "string")
            return [];
          const sequence = Number(raw.sequence);
          return [
            {
              id: raw.id,
              itemId: typeof raw.itemId === "string" ? raw.itemId : undefined,
              turnId: typeof raw.turnId === "string" ? raw.turnId : undefined,
              stepId: typeof raw.stepId === "string" ? raw.stepId : undefined,
              sequence: Number.isFinite(sequence) ? sequence : undefined,
              body: raw.body,
              status:
                raw.status === "done" || raw.status === "error"
                  ? raw.status
                  : "running",
              time: typeof raw.time === "string" ? raw.time : "most",
            },
          ];
        })
      : [];
  } catch {
    return [];
  }
};

const saveThreadCommentary = (key: string, entries: CommentaryEntry[]) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(COMMENTARY_STORAGE_KEY) ?? "{}",
    ) as Record<string, CommentaryEntry[]>;
    localStorage.setItem(
      COMMENTARY_STORAGE_KEY,
      JSON.stringify({
        ...saved,
        [key]: entries.slice(-MAX_COMMENTARY_ENTRIES_PER_THREAD),
      }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const moveThreadPlan = (fromKey: string, toKey: string) => {
  if (fromKey === toKey) return;
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(saved, fromKey)) return;
    saved[toKey] = saved[fromKey];
    delete saved[fromKey];
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage failure must not block a thread rename.
  }
};

const moveThreadCommentary = (fromKey: string, toKey: string) => {
  if (fromKey === toKey) return;
  try {
    const saved = JSON.parse(
      localStorage.getItem(COMMENTARY_STORAGE_KEY) ?? "{}",
    ) as Record<string, CommentaryEntry[]>;
    if (!Object.prototype.hasOwnProperty.call(saved, fromKey)) return;
    saved[toKey] = saved[fromKey];
    delete saved[fromKey];
    localStorage.setItem(COMMENTARY_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage failure must not block a thread rename.
  }
};

const removeThreadWorkItems = (key: string) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}",
    ) as Record<string, CodeActivity[]>;
    delete saved[key];
    localStorage.setItem(WORK_LOG_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage error must not block renaming.
  }
};

const removeThreadPlan = (key: string) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(PLAN_STORAGE_KEY) ?? "{}",
    ) as Record<string, PlanSnapshot>;
    delete saved[key];
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage error must not block renaming.
  }
};

const removeThreadCommentary = (key: string) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(COMMENTARY_STORAGE_KEY) ?? "{}",
    ) as Record<string, CommentaryEntry[]>;
    delete saved[key];
    localStorage.setItem(COMMENTARY_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage failure must not block thread removal.
  }
};

const removeThreadMessages = (key: string) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, Message[]>;
    delete saved[key];
    localStorage.setItem(MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage error must not block renaming.
  }
};

const messagesForSync = (messages: Message[]) =>
  compactMessages(messages)
    .map(repairHistoricalAssistantText)
    .map((message) => ({ ...message, live: false }));

const isSyncState = (value: unknown): value is SyncState => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const state = value as Partial<SyncState>;
  return (
    state.schemaVersion === SYNC_SCHEMA_VERSION &&
    typeof state.deviceId === "string" &&
    state.deviceId.length > 0 &&
    typeof state.updatedAt === "string" &&
    state.updatedAt.length > 0 &&
    Array.isArray(state.projects) &&
    typeof state.conversations === "object" &&
    state.conversations !== null &&
    !Array.isArray(state.conversations)
  );
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseEventValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const normalizeCodexEvent = (value: unknown): CodexEvent | null => {
  const envelope = asRecord(parseEventValue(value));
  const normalizedAgentEvent = normalizeAgentEventEnvelope(envelope);
  if (normalizedAgentEvent) return normalizedAgentEvent;
  const eventType =
    typeof envelope.eventType === "string"
      ? envelope.eventType
      : typeof envelope.event_type === "string"
        ? envelope.event_type
        : typeof envelope.method === "string"
          ? envelope.method
          : "";
  if (!eventType) return null;
  const threadId =
    typeof envelope.threadId === "string"
      ? envelope.threadId
      : typeof envelope.thread_id === "string"
        ? envelope.thread_id
        : "";
  const requestId =
    typeof envelope.requestId === "string"
      ? envelope.requestId
      : typeof envelope.request_id === "string"
        ? envelope.request_id
        : null;
  const sequence =
    typeof envelope.sequence === "number" && Number.isFinite(envelope.sequence)
      ? envelope.sequence
      : undefined;
  const messageId =
    typeof envelope.messageId === "string"
      ? envelope.messageId
      : typeof envelope.message_id === "string"
        ? envelope.message_id
        : null;
  const payload = Object.prototype.hasOwnProperty.call(envelope, "payload")
    ? envelope.payload
    : Object.prototype.hasOwnProperty.call(envelope, "params")
      ? envelope.params
      : envelope;
  return { requestId, sequence, messageId, threadId, eventType, payload };
};

const normalizeCodexDelta = (value: unknown): CodexDelta | null => {
  const envelope = asRecord(parseEventValue(value));
  const delta = typeof envelope.delta === "string" ? envelope.delta : "";
  if (!delta) return null;
  const itemId =
    typeof envelope.itemId === "string"
      ? envelope.itemId
      : typeof envelope.item_id === "string"
        ? envelope.item_id
        : undefined;
  const phase = typeof envelope.phase === "string" ? envelope.phase : null;
  const turnId =
    typeof envelope.turnId === "string"
      ? envelope.turnId
      : typeof envelope.turn_id === "string"
        ? envelope.turn_id
        : null;
  const sequence =
    typeof envelope.sequence === "number" && Number.isFinite(envelope.sequence)
      ? envelope.sequence
      : undefined;
  return {
    threadId: typeof envelope.threadId === "string" ? envelope.threadId : "",
    delta,
    itemId,
    turnId,
    phase,
    sequence,
  };
};

const appendCodexDelta = (
  messages: Message[],
  delta: CodexDelta,
  targetMessageId?: string,
) => {
  const itemId = delta.itemId ?? undefined;
  let targetIndex = -1;
  if (targetMessageId) {
    targetIndex = messages.findIndex(
      (message) =>
        message.id === targetMessageId &&
        message.live &&
        message.role === "assistant",
    );
  }
  if (itemId) {
    for (
      let index = messages.length - 1;
      index >= 0 && targetIndex < 0;
      index -= 1
    ) {
      const message = messages[index];
      if (
        message.live &&
        message.role === "assistant" &&
        message.itemId === itemId
      ) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0 && !targetMessageId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.live &&
        message.role === "assistant" &&
        (!itemId || !message.itemId || message.itemId === itemId)
      ) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex >= 0) {
    const target = messages[targetIndex];
    // A new content block gluing straight onto the previous one is how
    // "tests.32/32 teszt zöld" happens: blocks are separate paragraphs, so a
    // block boundary that lands mid-text earns a blank line.
    const blockBoundary =
      Boolean(itemId) &&
      Boolean(target.itemId) &&
      target.itemId !== itemId &&
      target.text.length > 0 &&
      !/\s$/.test(target.text);
    return messages.map((message, index) =>
      index === targetIndex
        ? {
            ...message,
            itemId: itemId ?? message.itemId,
            turnId: message.turnId ?? delta.turnId ?? undefined,
            text: `${target.text}${blockBoundary ? "\n\n" : ""}${delta.delta}`,
            final: false,
          }
        : message,
    );
  }
  const sequence =
    messages.reduce(
      (maximum, message, index) => Math.max(maximum, message.sequence ?? index),
      0,
    ) + 1;
  return [
    ...messages,
    {
      id: createEntityId(),
      role: "assistant" as const,
      time: "most",
      text: delta.delta,
      live: true,
      final: false,
      itemId,
      turnId: delta.turnId ?? undefined,
      sequence,
    },
  ];
};

const extractCodeLike = (value: unknown, keyHint = ""): string | undefined => {
  if (typeof value === "string") {
    const normalizedKey = keyHint.toLowerCase().replaceAll("_", "");
    if (
      /(diff|patch|code|source|content|newcontent|filecontent)/.test(
        normalizedKey,
      ) &&
      value.trim().length > 20
    )
      return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractCodeLike(item, keyHint);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      const found = extractCodeLike(nested, key);
      if (found) return found;
    }
  }
  return undefined;
};

const extractFilePath = (value: unknown, keyHint = ""): string | undefined => {
  if (typeof value === "string") {
    const normalizedKey = keyHint.toLowerCase().replaceAll("_", "");
    if (
      /(filepath|filename|path)/.test(normalizedKey) &&
      value.trim().length > 0
    )
      return value;
    if (normalizedKey === "name" && /\.[a-z0-9]{1,8}$/i.test(value.trim()))
      return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFilePath(item, keyHint);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      const found = extractFilePath(nested, key);
      if (found) return found;
    }
  }
  return undefined;
};

const extractMentionedFilePaths = (text: string) => {
  const matches =
    text.match(
      /(?:[A-Za-z]:[\\/][^<>\n`]*?\.(?:py|js|jsx|ts|tsx|rs|go|java|cpp|c|h|json|yaml|yml|html|css|md|txt|toml|ini|sh|bat|ps1|exe)\b|(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:py|js|jsx|ts|tsx|rs|go|java|cpp|c|h|json|yaml|yml|html|css|md|txt|toml|ini|sh|bat|ps1|exe)\b)/gi,
    ) ?? [];
  return [...new Set(matches)];
};

const LOCAL_FILE_CONTEXT_TIMEOUT_MS = 3000;
const LOCAL_FILE_CONTEXT_MAX_FILES = 4;
const LOCAL_FILE_CONTEXT_MAX_CHARS = 120_000;

const promiseWithTimeout = <T,>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(null);
      });
  });

const loadLocalFileContext = async (
  promptText: string,
  conversationContext: string,
  cwd: string,
) => {
  const candidates = extractMentionedFilePaths(
    `${promptText}\n${conversationContext}`,
  )
    .filter((path) => !path.includes("://") && !path.includes(".."))
    .slice(0, LOCAL_FILE_CONTEXT_MAX_FILES);
  if (candidates.length === 0) return "";

  const results = await Promise.all(
    candidates.map(async (path) => ({
      path,
      content: await promiseWithTimeout(
        invoke<string | null>("read_code_file", { cwd, path }),
        LOCAL_FILE_CONTEXT_TIMEOUT_MS,
      ),
    })),
  );
  const loaded: Array<{ path: string; content: string }> = [];
  let remaining = LOCAL_FILE_CONTEXT_MAX_CHARS;
  for (const result of results) {
    if (remaining <= 0) break;
    if (!result.content) continue;
    const clipped = result.content.slice(0, remaining);
    loaded.push({ path: result.path, content: clipped });
    remaining -= clipped.length;
  }
  if (loaded.length === 0) return "";
  return [
    "The local client already read the following project files directly. Use this content as authoritative context; do not try to read these files through a shell command or request another read permission.",
    ...loaded.map(
      ({ path, content }) => `--- ${path} ---\n${content}\n--- end ${path} ---`,
    ),
  ].join("\n\n");
};

const firstString = (...values: unknown[]) =>
  values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );

const eventTurnId = (
  event: CodexEvent,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
) =>
  firstString(
    params.turnId,
    params.turn_id,
    asRecord(params.turn).id,
    item.turnId,
    item.turn_id,
    params.threadId,
  ) ?? `thread:${event.threadId}`;

const eventItemId = (
  event: CodexEvent,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
) => {
  if (event.eventType.startsWith("turn/"))
    return (
      firstString(params.turnId, params.turn_id, asRecord(params.turn).id) ??
      `turn:${event.threadId}`
    );
  return firstString(
    params.itemId,
    params.item_id,
    params.callId,
    params.call_id,
    item.id,
    item.itemId,
  );
};

const eventItemType = (
  event: CodexEvent,
  params: Record<string, unknown>,
  item: Record<string, unknown>,
) =>
  firstString(item.type, params.itemType, params.type) ??
  (event.eventType.startsWith("turn/") ? "turn" : "");

const workItemStatus = (
  event: CodexEvent,
  item: Record<string, unknown>,
): WorkItemStatus => {
  const value =
    `${event.eventType} ${firstString(item.status, item.state) ?? ""}`.toLowerCase();
  if (
    value.includes("error") ||
    value.includes("failed") ||
    value.includes("failure") ||
    value.includes("rejected")
  )
    return "error";
  if (
    value.includes("completed") ||
    value.includes("finished") ||
    value.includes("succeeded") ||
    value.includes("success") ||
    value.includes("done")
  )
    return "done";
  return "running";
};

const workItemLabel = (
  event: CodexEvent,
  kind: WorkItemKind,
  status: WorkItemStatus,
) => {
  if (event.eventType === "turn/started") return "Feladat indult";
  if (event.eventType === "turn/completed") return "Feladat kész";
  if (status === "error") return "Hiba a munkafolyamatban";
  const isCompleted = status === "done";
  if (kind === "reasoning")
    return isCompleted ? "Gondolkodás kész" : "Gondolkodás";
  if (kind === "command") return isCompleted ? "Parancs kész" : "Parancs fut";
  if (kind === "file")
    return isCompleted ? "Fájlművelet kész" : "Fájlművelet folyamatban";
  if (kind === "tool") return isCompleted ? "Eszköz kész" : "Eszköz fut";
  return isCompleted ? "Részfeladat kész" : "Részfeladat";
};

const summarizeCodexWorkEvent = (
  event: CodexEvent,
  id: number,
  turnId?: string,
): CodeActivity | null => {
  const params = asRecord(event.payload);
  const item = asRecord(params.item);
  const summaryPart = asRecord(params.part ?? params.summaryPart ?? item.part);
  if (
    isIgnoredWorkEventType(event.eventType) ||
    event.eventType === "turn/plan/updated" ||
    event.eventType.startsWith("item/plan/") ||
    event.eventType === "item/reasoning/textDelta"
  )
    return null;
  const itemType = eventItemType(event, params, item);
  if (
    ["agentmessage", "usermessage"].includes(itemType.toLowerCase()) ||
    event.eventType.startsWith("item/agentMessage/")
  )
    return null;

  const itemId = eventItemId(event, params, item);
  // `item.name` is deliberately absent: for tool items it holds the tool's
  // name ("Read", "Edit"), and treating that as a path is how the change
  // summary once listed a file called Read with +138 lines.
  // `extractFilePath` still accepts a `name` that looks like a filename.
  const filePath = firstString(
    params.path,
    params.filePath,
    item.path,
    item.filePath,
    item.filename,
    extractFilePath(event.payload),
  );
  const kind = inferWorkItemKind(`${event.eventType} ${itemType}`);
  const status = workItemStatus(event, item);
  const command = firstString(
    params.command,
    params.commandLine,
    item.command,
    item.commandLine,
    params.input,
    item.input,
  );
  const tool = firstString(
    params.tool,
    params.toolName,
    item.tool,
    item.toolName,
    item.serverName,
    item.method,
    item.name,
  );
  const detail =
    kind === "file"
      ? (filePath ?? firstString(item.title, params.description) ?? itemType)
      : kind === "command"
        ? (command ?? filePath ?? itemType)
        : kind === "tool"
          // "Read — math.js" tells the reader what happened; "Read" alone
          // reads as a step that did nothing in particular.
          ? (tool && filePath ? `${tool} — ${filePath}` : (tool ?? itemType))
          : (firstString(
              item.title,
              item.name,
              params.description,
              params.status,
            ) ?? (event.eventType.startsWith("turn/") ? "" : itemType));

  const rawBody =
    kind === "reasoning"
      ? firstString(
          params.delta,
          params.summaryTextDelta,
          params.text,
          params.summary,
          params.part,
          params.summaryPart,
          summaryPart.text,
          summaryPart.summary,
          summaryPart.content,
          item.text,
          item.summary,
        )
      : kind === "command" || kind === "tool" || kind === "file"
        ? firstString(
            params.output,
            params.stdout,
            params.stderr,
            params.delta,
            item.output,
            item.stdout,
            item.stderr,
          )
        : firstString(
            params.description,
            params.summary,
            item.description,
            item.summary,
          );
  const body = rawBody && rawBody !== detail ? rawBody : undefined;
  const rawCode =
    params.code ??
    params.patch ??
    params.diff ??
    item.code ??
    item.patch ??
    item.diff ??
    extractCodeLike(event.payload);
  const code =
    typeof rawCode === "string" && rawCode.trim().length > 0
      ? rawCode
      : undefined;
  const beforeCode = firstString(
    params.before,
    params.beforeContent,
    params.oldContent,
    params.oldText,
    item.before,
    item.beforeContent,
    item.oldContent,
    item.oldText,
  );
  const afterCode = firstString(
    params.after,
    params.afterContent,
    params.newContent,
    params.newText,
    item.after,
    item.afterContent,
    item.newContent,
    item.newText,
  );
  const extension = filePath
    ?.split(/[\\/.]/)
    .pop()
    ?.toLowerCase();
  const language = extension && extension.length <= 8 ? extension : undefined;
  return {
    id,
    itemId,
    turnId: turnId ?? eventTurnId(event, params, item),
    kind,
    status,
    label: workItemLabel(event, kind, status),
    detail: detail ?? "",
    eventType: event.eventType,
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    body,
    code,
    beforeCode,
    afterCode,
    language,
  };
};

const mergeCodeActivity = (current: CodeActivity[], incoming: CodeActivity) => {
  const existingIndex = incoming.itemId
    ? current.findIndex((item) => item.itemId === incoming.itemId)
    : -1;
  if (existingIndex < 0)
    return [...current, incoming]
      .sort((a, b) => a.id - b.id)
      .slice(-MAX_WORK_ITEMS_PER_THREAD);

  const existing = current[existingIndex];
  const isDelta = incoming.eventType.toLowerCase().includes("delta");
  const appendStreamText = (
    previous: string | undefined,
    next: string | undefined,
  ) => {
    if (!next) return previous;
    if (!previous) return next;
    const separator = /\s$/.test(previous) || /^\s/.test(next) ? "" : " ";
    return `${previous}${separator}${next}`;
  };
  const body = incoming.body
    ? isDelta
      ? appendStreamText(existing.body, incoming.body)?.slice(-24000)
      : incoming.body
    : existing.body;
  const code = incoming.code
    ? isDelta && existing.code
      ? `${existing.code}${incoming.code}`
      : incoming.code
    : existing.code;
  const beforeCode = incoming.beforeCode ?? existing.beforeCode;
  const afterCode = incoming.afterCode
    ? isDelta
      ? appendStreamText(existing.afterCode, incoming.afterCode)
      : incoming.afterCode
    : existing.afterCode;
  const status =
    incoming.status === "running" && existing.status !== "running"
      ? existing.status
      : incoming.status;
  const merged = {
    ...existing,
    ...incoming,
    id: existing.id,
    status,
    body,
    code,
    beforeCode,
    afterCode,
    detail: incoming.detail || existing.detail,
  };
  return current
    .map((item, index) => (index === existingIndex ? merged : item))
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_WORK_ITEMS_PER_THREAD);
};

const fencedCodePattern = /```([^\r\n`]*)\r?\n?([\s\S]*?)```/g;
const fenceMarkerPattern = /```/g;

const stripUnclosedCodeBlock = (text: string) => {
  const markers = [...text.matchAll(fenceMarkerPattern)];
  if (markers.length % 2 === 0) return text;
  const lastMarker = markers[markers.length - 1].index ?? text.length;
  return text.slice(0, lastMarker).trimEnd();
};

const extractCodeBlocks = (text: string): CodeBlock[] => {
  const blocks: CodeBlock[] = [];
  for (const match of text.matchAll(fencedCodePattern)) {
    blocks.push({
      language: match[1].trim() || "text",
      code: match[2].replace(/^\n/, "").trimEnd(),
    });
  }
  const markers = [...text.matchAll(fenceMarkerPattern)];
  if (markers.length % 2 === 1) {
    const start = markers[markers.length - 1].index ?? text.length;
    const remainder = text.slice(start + 3);
    const newline = remainder.search(/\r?\n/);
    if (newline >= 0)
      blocks.push({
        language: remainder.slice(0, newline).trim() || "text",
        code: remainder
          .slice(newline + (remainder[newline] === "\r" ? 2 : 1))
          .trimEnd(),
      });
  }
  return blocks;
};

const textWithoutCodeBlocks = (text: string) =>
  stripUnclosedCodeBlock(text.replace(fencedCodePattern, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const cleanUserMessageText = (text: string) =>
  text
    .replace(/^\s*\*{0,2}---?\s*Idézet\s*---?\s*\*{0,2}\s*$/gim, "")
    .replace(/^\s*\*{0,2}---?\s*Idézet vége\s*---?\s*\*{0,2}\s*$/gim, "")
    .replace(/^\s*\*{0,2}---?\s*Idézethez tartozó utasítás\s*---?\s*\*{0,2}\s*$/gim, "")
    .replace(/^\s*\*{0,2}---?\s*Általános utasítás(?: \(nem az idézetre\))?\s*---?\s*\*{0,2}\s*$/gim, "")
    .replace(/\*{0,2}(?:Idézet|Az idézethez kapcsolódó utasítás|Általános utasítás(?: \(nem az idézetre\))?):\*{0,2}\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const userMessageDisplayText = (message: Message) => {
  let text = textWithoutCodeBlocks(message.text);
  const hasEmbeddedQuote = (message.quoteRefs ?? []).some((quote) => {
    const quotedBlock = quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    return text.includes(quotedBlock) || text.includes(quote.text);
  });
  for (const quote of message.quoteRefs ?? []) {
    const quotedBlock = quote.text
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    text = text.replace(quotedBlock, "").replace(quote.text, "");
    // Older snapshots embedded each quote instruction in message.text. New
    // messages keep only the general instruction there, so remove this only
    // when the legacy quoted block was actually present.
    if (hasEmbeddedQuote && quote.instruction)
      text = text.replace(quote.instruction, "");
  }
  const cleanedText = cleanUserMessageText(text);
  // Quote-only turns keep their per-quote instructions in quoteRefs rather
  // than in message.text. Show those instructions in the user bubble too;
  // otherwise the backlink icon would replace the entire visible prompt.
  const quoteInstructions = (message.quoteRefs ?? [])
    .map((quote) => quote.instruction.trim())
    .filter(Boolean)
    .filter((instruction) => !cleanedText.includes(instruction));
  return [cleanedText, ...quoteInstructions].filter(Boolean).join("\n");
};

const localFileExtensions = new Set([
  "7z",
  "avi",
  "bmp",
  "bat",
  "c",
  "cmd",
  "cpp",
  "css",
  "csv",
  "doc",
  "docx",
  "dll",
  "exe",
  "gif",
  "go",
  "h",
  "html",
  "ico",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "lnk",
  "log",
  "md",
  "mid",
  "midi",
  "mkv",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "ps1",
  "ppt",
  "pptx",
  "py",
  "rar",
  "rs",
  "sh",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "wav",
  "webp",
  "yaml",
  "yml",
  "xls",
  "xlsx",
  "xml",
  "zip",
]);

const inlineMarkdownPattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^\)]+\)|(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^<>\n`]*?\.[A-Za-z0-9]{1,12}\b|(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\\\\)?[\w.-]+(?:[\\/][\w.-]+)*\.[A-Za-z0-9]{1,12}\b)/g;

const normalizeFileReference = (value: string) => {
  let candidate = value
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/^[([{\"']+|[\]},.;:!?\"']+$/g, "");
  candidate = candidate
    .replace(/^file:\/\/\//i, "")
    .replace(/^file:\/\//i, "");
  // </C:/...> is valid Markdown syntax, but the leading slash is not
  // part of a Windows drive path.
  candidate = candidate.replace(/^\/(?=[A-Za-z]:[\\/])/, "");
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep a literal percent sign when the response is not URI-encoded.
  }
  return candidate;
};

const isWindowsPathLike = (value: string) =>
  /^[A-Za-z]:[\\/]/.test(value) ||
  /^\\\\/.test(value) ||
  /^\.{1,2}[\\/]/.test(value);

const isLocalFileReference = (value: string) => {
  const candidate = normalizeFileReference(value);
  if (!candidate || /^(?:https?|mailto|data|file):\/\//i.test(candidate))
    return false;
  const extension = candidate.match(/\.([A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase();
  if (!extension || !localFileExtensions.has(extension)) return false;
  return (
    candidate.length <= 400 &&
    (candidate.includes("\\") ||
      candidate.includes("/") ||
      /^[A-Za-z]:/.test(candidate) ||
      /^[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(candidate))
  );
};

const renderInlineMarkdown = (
  text: string,
  onFileClick?: FileClickHandler,
): ReactNode[] => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  const fileButton = (value: string, label: string, key: string) => {
    const path = normalizeFileReference(value);
    if (!onFileClick || !isLocalFileReference(path)) return null;
    return (
      <button
        type="button"
        className="inline-file-link"
        key={key}
        title={`${path} – fájlműveletek`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFileClick(path, event.clientX, event.clientY);
        }}
      >
        {label}
      </button>
    );
  };
  for (const match of text.matchAll(inlineMarkdownPattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    if (value.startsWith("`") && value.endsWith("`")) {
      const code = value.slice(1, -1);
      parts.push(
        fileButton(code, code, `file-inline-${index}`) ?? (
          <code className="inline-code" key={`inline-${index}`}>
            {code}
          </code>
        ),
      );
    } else if (value.startsWith("**")) {
      parts.push(<strong key={`bold-${index}`}>{value.slice(2, -2)}</strong>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (link) {
        parts.push(
          fileButton(link[2], link[1], `file-link-${index}`) ?? (
            <a
              href={link[2]}
              target="_blank"
              rel="noreferrer"
              key={`link-${index}`}
            >
              {link[1]}
            </a>
          ),
        );
      } else {
        const previousCharacter = text[index - 1] ?? "";
        const renderedFile =
          previousCharacter !== "/" && previousCharacter !== ":"
            ? fileButton(value, value, `file-plain-${index}`)
            : null;
        parts.push(
          renderedFile ?? value,
        );
      }
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

function InlineMarkdown({ text }: { text: string }) {
  const onFileClick = useContext(FileActionContext);
  return <>{renderInlineMarkdown(text, onFileClick ?? undefined)}</>;
}

const codeKeywords = new Set([
  "and",
  "as",
  "async",
  "await",
  "break",
  "case",
  "class",
  "const",
  "continue",
  "def",
  "else",
  "elif",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "fn",
  "function",
  "if",
  "import",
  "in",
  "let",
  "match",
  "new",
  "None",
  "not",
  "null",
  "of",
  "or",
  "pass",
  "pub",
  "return",
  "self",
  "static",
  "struct",
  "switch",
  "this",
  "throw",
  "try",
  "type",
  "use",
  "var",
  "while",
  "with",
  "yield",
]);
const codeConstants = new Set([
  "True",
  "False",
  "None",
  "true",
  "false",
  "null",
  "undefined",
]);
const codeTokenPattern =
  /(#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|=>|===|!==|==|!=|<=|>=|[()[\]{}:.,=+\-*\/%<>])/g;

const highlightCode = (code: string): ReactNode[] => {
  const tokens: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(codeTokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push(code.slice(cursor, index));
    const afterToken = code.slice(index + token.length);
    let className = "code-punctuation";
    if (token.startsWith("#") || token.startsWith("//"))
      className = "code-comment";
    else if (/^[\"'`]/.test(token)) className = "code-string";
    else if (/^\d/.test(token)) className = "code-number";
    else if (codeConstants.has(token)) className = "code-constant";
    else if (codeKeywords.has(token)) className = "code-keyword";
    else if (/^[A-Za-z_$]/.test(token) && /^\s*\(/.test(afterToken))
      className = "code-function";
    tokens.push(
      <span className={className} key={`token-${index}`}>
        {token}
      </span>,
    );
    cursor = index + token.length;
  }
  if (cursor < code.length) tokens.push(code.slice(cursor));
  return tokens;
};

type InlineDiffLineKind = "context" | "added" | "removed" | "empty" | "meta";
type InlineDiffLine = {
  kind: InlineDiffLineKind;
  text: string;
  number: number | null;
};
type InlineDiffRow = { before: InlineDiffLine; after: InlineDiffLine };
type InlineCodeDiff = { path: string; language: string; rows: InlineDiffRow[] };
type ThinkingEntry = {
  id: string;
  body: string;
  kind: "commentary" | "internal";
  sequence: number;
  codeActivity?: CodeActivity;
  internalHistory?: string[];
};

const formatElapsed = (milliseconds: number | undefined) => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "";
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const emptyInlineDiffLine = (): InlineDiffLine => ({
  kind: "empty",
  text: "",
  number: null,
});

const buildInlineDiffRows = (
  beforeText: string,
  afterText: string,
): InlineDiffRow[] => {
  const before = beforeText ? beforeText.replace(/\r/g, "").split("\n") : [];
  const after = afterText ? afterText.replace(/\r/g, "").split("\n") : [];
  const maxLines = 420;
  const oldLines = before.slice(0, maxLines);
  const newLines = after.slice(0, maxLines);
  const lcs = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint16Array(newLines.length + 1),
  );
  for (let old = oldLines.length - 1; old >= 0; old -= 1) {
    for (let next = newLines.length - 1; next >= 0; next -= 1) {
      lcs[old][next] =
        oldLines[old] === newLines[next]
          ? lcs[old + 1][next + 1] + 1
          : Math.max(lcs[old + 1][next], lcs[old][next + 1]);
    }
  }
  const rows: InlineDiffRow[] = [];
  let old = 0;
  let next = 0;
  while (old < oldLines.length || next < newLines.length) {
    if (
      old < oldLines.length &&
      next < newLines.length &&
      oldLines[old] === newLines[next]
    ) {
      rows.push({
        before: { kind: "context", text: oldLines[old], number: old + 1 },
        after: { kind: "context", text: newLines[next], number: next + 1 },
      });
      old += 1;
      next += 1;
    } else if (
      old < oldLines.length &&
      (next >= newLines.length || lcs[old + 1][next] >= lcs[old][next + 1])
    ) {
      rows.push({
        before: { kind: "removed", text: oldLines[old], number: old + 1 },
        after: emptyInlineDiffLine(),
      });
      old += 1;
    } else if (next < newLines.length) {
      rows.push({
        before: emptyInlineDiffLine(),
        after: { kind: "added", text: newLines[next], number: next + 1 },
      });
      next += 1;
    }
  }
  return rows.length > 0
    ? rows
    : [{ before: emptyInlineDiffLine(), after: emptyInlineDiffLine() }];
};

const changeStatus = (status: string): ChangeSummaryFile["status"] => {
  const normalized = status.toLowerCase();
  if (normalized.includes("add") || normalized.includes("create")) return "added";
  if (normalized.includes("remove") || normalized.includes("delete")) return "removed";
  return "modified";
};

const summaryFromDiffRows = (
  path: string,
  status: string,
  rows: InlineDiffRow[],
  binaryOrTruncated = false,
): ChangeSummaryFile => ({
  path,
  status: changeStatus(status),
  added: rows.filter((row) => row.after.kind === "added").length,
  removed: rows.filter((row) => row.before.kind === "removed").length,
  binaryOrTruncated,
});

const changeSummaryFromDiffFiles = (
  files: AgentDiffFile[],
): ChangeSummaryFile[] =>
  files
    .filter((file) => file.path.trim())
    .map((file) =>
      summaryFromDiffRows(
        file.path.trim(),
        file.status,
        file.lines.map((line) => ({
          before: {
            kind: line.kind === "removed" ? "removed" : "context",
            text: line.text,
            number: line.oldLine ?? null,
          },
          after: {
            kind: line.kind === "added" ? "added" : "context",
            text: line.text,
            number: line.newLine ?? null,
          },
        })),
        file.binaryOrTruncated,
      ),
    );

const changeSummaryFromGuard = (
  guard: AgentGuardReport,
): ChangeSummaryFile[] => {
  const files = new Map<string, ChangeSummaryFile>();
  for (const path of guard.changedFiles) {
    if (path.trim())
      files.set(path, { path, status: "modified", added: 0, removed: 0 });
  }
  for (const path of guard.addedFiles) {
    if (path.trim())
      files.set(path, { path, status: "added", added: 0, removed: 0 });
  }
  for (const path of guard.removedFiles) {
    if (path.trim())
      files.set(path, { path, status: "removed", added: 0, removed: 0 });
  }
  return [...files.values()];
};

const changeSummaryFromActivities = (
  activities: CodeActivity[],
): ChangeSummaryFile[] => {
  const byPath = new Map<string, ChangeSummaryFile>();
  for (const activity of activities) {
    const path = activity.detail.trim();
    // A bare tool name ("Read", "Edit") sneaking in as a detail must not
    // become a file row; anything without a separator or an extension is not
    // a path the summary can honestly claim was modified.
    const pathLike = /[\\/]/.test(path) || /\.[a-z0-9]{1,8}$/i.test(path);
    const readOnlyActivity =
      /(?:^|[\\/._-])(read|inspect|view|open)(?:$|[\\/._-])/i.test(
        activity.eventType,
      ) || /(?:read|inspect|view|open)$/i.test(activity.eventType);
    const hasCodeBoundary =
      !readOnlyActivity &&
      (activity.beforeCode !== undefined || activity.afterCode !== undefined);
    const looksLikeChange =
      activity.kind === "file" &&
      /(change|create|delete|remove|write|patch|edit)/i.test(activity.eventType);
    if (!path || !pathLike || (!hasCodeBoundary && !looksLikeChange)) continue;
    const before = activity.beforeCode ?? "";
    const after = activity.afterCode ?? activity.code ?? "";
    const rows = buildInlineDiffRows(before, after);
    const next = summaryFromDiffRows(
      path,
      activity.eventType,
      rows,
      !hasCodeBoundary && Boolean(activity.code),
    );
    const previous = byPath.get(path);
    if (!previous) {
      byPath.set(path, next);
      continue;
    }
    previous.added += next.added;
    previous.removed += next.removed;
    if (next.status === "added" || next.status === "removed")
      previous.status = next.status;
    previous.binaryOrTruncated ||= next.binaryOrTruncated;
  }
  return [...byPath.values()];
};

const parseUnifiedInlineDiff = (source: string): InlineDiffRow[] => {
  const rows: InlineDiffRow[] = [];
  const lines = source.replace(/\r/g, "").split("\n");
  let oldNumber = 0;
  let newNumber = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      const header = line.match(/@@ -([0-9]+)/);
      const addedHeader = line.match(/@@[^+]*\+([0-9]+)/);
      oldNumber = header ? Number(header[1]) : oldNumber;
      newNumber = addedHeader ? Number(addedHeader[1]) : newNumber;
      rows.push({
        before: { kind: "meta", text: line, number: null },
        after: { kind: "meta", text: line, number: null },
      });
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const removed: InlineDiffLine = {
        kind: "removed",
        text: line.slice(1),
        number: oldNumber++,
      };
      const nextLine = lines[index + 1];
      if (nextLine?.startsWith("+") && !nextLine.startsWith("+++")) {
        rows.push({
          before: removed,
          after: {
            kind: "added",
            text: nextLine.slice(1),
            number: newNumber++,
          },
        });
        index += 1;
      } else {
        rows.push({ before: removed, after: emptyInlineDiffLine() });
      }
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({
        before: emptyInlineDiffLine(),
        after: { kind: "added", text: line.slice(1), number: newNumber++ },
      });
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      before: { kind: "context", text, number: oldNumber++ },
      after: { kind: "context", text, number: newNumber++ },
    });
  }
  return rows.length > 0
    ? rows
    : [{ before: emptyInlineDiffLine(), after: emptyInlineDiffLine() }];
};

const inlineCodeDiffForActivity = (activity: CodeActivity): InlineCodeDiff => {
  const source = activity.code ?? "";
  const hasUnifiedHeaders =
    /^--- .+$/m.test(source) && /^\+\+\+ .+$/m.test(source);
  const hasHunk = /^@@/m.test(source);
  const rows =
    activity.beforeCode !== undefined || activity.afterCode !== undefined
      ? buildInlineDiffRows(
          activity.beforeCode ?? "",
          activity.afterCode ?? source,
        )
      : hasUnifiedHeaders || hasHunk
        ? parseUnifiedInlineDiff(source)
        : buildInlineDiffRows("", source);
  const path = activity.detail || "kódmódosítás";
  const language = activity.language || path.split(/[\\/.]/).pop() || "diff";
  return { path, language, rows };
};

const modelLabel = (model: CodexModel) =>
  model.displayName
    .replace("GPT-5.6-", "GPT-5.6 ")
    .replace("GPT-5.5-", "GPT-5.5 ")
    .replace("GPT-5.4-", "GPT-5.4 ");

const familyVariantLabel = (family: ModelFamily, model: CodexModel) => {
  if (family.key === "gpt-5.6") {
    return model.id
      .replace("gpt-5.6-", "")
      .replace(/^./, (letter) => letter.toUpperCase());
  }
  return modelLabel(model);
};

/** Which side of the picker a model sits on. */
const vendorOfModel = (modelId: string | null): "anthropic" | "codex" =>
  modelId?.startsWith("claude-") ? "anthropic" : "codex";

/**
 * The GPT generation whose variants hide behind a hover.
 *
 * One row for the generation and a flyout for Luna/Terra/Sol keeps the menu as
 * narrow as the chip above it; listing all three inline made the panel wider
 * than the composer needed it to be.
 */
const GPT_FLYOUT_FAMILY = "gpt-5.6";
const GPT_FLYOUT_LABEL = "GPT 5.6";

type ModelPickerProps = {
  /** A chain picks its own model per stage, so this one is not in charge. */
  disabled?: boolean;
  open: boolean;
  loading: boolean;
  activeLabel: string;
  selectedModel: string | null;
  modelFamilies: ModelFamily[];
  activeEffortLabel: string;
  supportedEfforts: string[];
  activeEffortIndex: number;
  onToggle: () => void;
  onSelectModel: (id: string | null) => void;
  onSelectEffort: (index: number) => void;
};

function ModelPicker({
  open,
  loading,
  activeLabel,
  selectedModel,
  modelFamilies,
  activeEffortLabel,
  supportedEfforts,
  activeEffortIndex,
  onToggle,
  onSelectModel,
  onSelectEffort,
  disabled = false,
}: ModelPickerProps) {
  // Which vendor's models the menu is showing. It follows the selection when
  // the menu opens, so the list you see is the list the chip is naming.
  const [vendor, setVendor] = useState<"anthropic" | "codex">(() =>
    vendorOfModel(selectedModel),
  );
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  useEffect(() => {
    if (open) {
      setVendor(vendorOfModel(selectedModel));
      setFlyoutOpen(false);
    }
  }, [open, selectedModel]);

  const claudeModels =
    modelFamilies.find((family) => family.key === "claude")?.models ?? [];
  const gptVariants =
    modelFamilies.find((family) => family.key === GPT_FLYOUT_FAMILY)?.models ??
    [];
  const gptSelected = gptVariants.some((model) => model.id === selectedModel);

  return (
    <div className={`model-picker${disabled ? " is-disabled" : ""}`} aria-disabled={disabled}>
      <button
        type="button"
        className="model-chip"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>
          {activeLabel} · {activeEffortLabel}
        </span>
        <span className="model-chevron">⌄</span>
      </button>
      {open && (
        <div
          className="model-menu model-menu-nested"
          role="menu"
          aria-label="Modell kiválasztása"
        >
          <div className="model-menu-body">
            <button
              type="button"
              className={`model-auto-option${selectedModel === null ? " is-selected" : ""}`}
              onClick={() => onSelectModel(null)}
            >
              <span>Automatikus</span>
              <span>{selectedModel === null ? "✓" : ""}</span>
            </button>
            {/* The same switch as EGY AI | MULTI-AI: one control, two sides,
                and the models below belong to whichever side is showing. */}
            <div
              className="model-vendor-switch mode-switch"
              role="tablist"
              aria-label="Gyártó"
            >
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "anthropic"}
                className={vendor === "anthropic" ? "is-active" : ""}
                onClick={() => {
                  setVendor("anthropic");
                  setFlyoutOpen(false);
                }}
              >
                Claude
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "codex"}
                className={vendor === "codex" ? "is-active" : ""}
                onClick={() => setVendor("codex")}
              >
                ChatGPT
              </button>
            </div>
            <div className="model-variants">
              {vendor === "anthropic"
                ? claudeModels.map((model) => (
                    <button
                      type="button"
                      className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                      onClick={() => onSelectModel(model.id)}
                      key={model.id}
                    >
                      <strong>{model.displayName}</strong>
                      <span className="model-check">
                        {model.id === selectedModel ? "✓" : ""}
                      </span>
                    </button>
                  ))
                : gptVariants.length > 0 && (
                    <div
                      className="model-flyout-anchor"
                      onMouseEnter={() => setFlyoutOpen(true)}
                      onMouseLeave={() => setFlyoutOpen(false)}
                    >
                      <button
                        type="button"
                        className={`model-variant${gptSelected ? " is-selected" : ""}${flyoutOpen ? " is-open" : ""}`}
                        aria-haspopup="menu"
                        aria-expanded={flyoutOpen}
                        onFocus={() => setFlyoutOpen(true)}
                        onClick={() => setFlyoutOpen((value) => !value)}
                      >
                        <span className="model-flyout-arrow">‹</span>
                        <strong>{GPT_FLYOUT_LABEL}</strong>
                        <span className="model-check">
                          {gptSelected ? "✓" : ""}
                        </span>
                      </button>
                      {/* Opens to the left: the picker sits at the right edge
                          of the composer, and a right-hand flyout would run
                          off the window. */}
                      {flyoutOpen && (
                        <div className="model-flyout" role="menu">
                          {gptVariants.map((model) => (
                            <button
                              type="button"
                              className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                              onClick={() => onSelectModel(model.id)}
                              key={model.id}
                            >
                              <strong>
                                {familyVariantLabel(
                                  { key: GPT_FLYOUT_FAMILY, label: "5.6", models: gptVariants },
                                  model,
                                )}
                              </strong>
                              <span className="model-check">
                                {model.id === selectedModel ? "✓" : ""}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
            </div>
          </div>
          <div className="reasoning-control">
            <div className="reasoning-heading">
              <span>Reasoning</span>
              <strong>{activeEffortLabel}</strong>
            </div>
            <input
              className="reasoning-slider"
              type="range"
              min="0"
              max={Math.max(0, supportedEfforts.length - 1)}
              step="1"
              value={activeEffortIndex}
              onChange={(event) => onSelectEffort(Number(event.target.value))}
              aria-label="Reasoning erőssége"
            />
            <div className="reasoning-scale">
              <span>
                {EFFORT_LABELS[supportedEfforts[0]] ?? supportedEfforts[0]}
              </span>
              <span>
                {loading
                  ? "modellek betöltése…"
                  : (EFFORT_LABELS[
                      supportedEfforts[supportedEfforts.length - 1]
                    ] ?? supportedEfforts[supportedEfforts.length - 1])}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectImagePreview({
  image,
  cwd,
}: {
  image: MessageImageAttachment;
  cwd: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    setSource(null);
    if (!isTauri || !cwd) return () => undefined;
    void invoke<string | null>("read_project_image", {
      cwd,
      path: image.path,
    })
      .then((value) => {
        if (active) setSource(value);
      })
      .catch(() => {
        if (active) setSource(null);
      });
    return () => {
      active = false;
    };
  }, [cwd, image.path]);

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expanded]);

  return (
    <>
      <button
        type="button"
        className="message-image-button"
        title={source ? `${image.name} megnyitása` : image.path}
        disabled={!source}
        onClick={() => setExpanded(true)}
      >
        {source ? (
          <img src={source} alt={image.name} />
        ) : (
          <span>{image.name}</span>
        )}
      </button>
      {expanded && source && (
        <div
          className="image-lightbox"
          role="presentation"
          onMouseDown={() => setExpanded(false)}
        >
          <button
            type="button"
            className="image-lightbox-close"
            aria-label="Kép bezárása"
            onClick={() => setExpanded(false)}
          >
            ×
          </button>
          <img
            src={source}
            alt={image.name}
            onMouseDown={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// Streamelés közben csak az élő sor szövege változik, a többi üzenet
// objektuma azonos marad — ez a memo tehát a beszélgetés egészének
// újrarajzolását spórolja meg minden egyes képkockán.
const MessageRow = memo(function MessageRow({
  message,
  projectPath,
  isFinal,
  showAvatar = true,
  onQuoteJump,
  onRevert,
}: {
  message: Message;
  projectPath: string;
  isFinal?: boolean;
  showAvatar?: boolean;
  onQuoteJump?: QuoteJumpHandler;
  /** Offered on a prompt: return the conversation and the files to here. */
  onRevert?: (message: Message) => void;
}) {
  const visibleText =
    message.role === "user"
      ? userMessageDisplayText(message)
      : textWithoutCodeBlocks(message.text);
  const final = isFinal ?? message.final;
  const isPending =
    message.role === "assistant" && !message.text.trim() && !final;
  const promptTimestamp =
    message.role === "user" ? messagePromptTimestamp(message) : undefined;
  const anchorId = messageAnchorId(message);

  return (
    <article
      className={`message ${message.role === "user" ? "user-message" : "assistant-message"}${final ? " is-final" : ""}${!showAvatar ? " no-avatar" : ""}`}
    >
      <div className="message-avatar-column">
        <span
          className={`avatar ${message.role === "user" ? "user-avatar" : "assistant-avatar"}`}
        >
          {showAvatar ? (message.role === "user" ? "D" : "m") : ""}
        </span>
        {showAvatar && promptTimestamp !== undefined && (
          <time
            className="message-prompt-time"
            dateTime={new Date(promptTimestamp).toISOString()}
            title="A prompt elküldésének ideje"
          >
            {formatPromptTime(promptTimestamp)}
          </time>
        )}
      </div>
      <div className="message-content">
        {message.pipeline && (
          // A stage answer often has no trace card of its own, so without this
          // the run's structure would be invisible on the plain row.
          <div className="message-stage-badges">{stageBadge(message.pipeline)}</div>
        )}
        <div
          className={`message-body${isPending ? " is-pending" : ""}`}
          data-quote-selectable="true"
          data-quote-anchor={anchorId}
        >
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image) => (
                <ProjectImagePreview
                  key={image.path}
                  image={image}
                  cwd={projectPath}
                />
              ))}
            </div>
          )}
          {visibleText && (
            <p>
              <InlineMarkdown text={visibleText} />
              {message.role === "user" && onQuoteJump &&
                quoteBacklinkButtons(message.quoteRefs ?? [], onQuoteJump)}
            </p>
          )}
          {!visibleText && message.role === "user" && onQuoteJump &&
            quoteBacklinkButtons(message.quoteRefs ?? [], onQuoteJump)}
          {isPending && (
            <div className="assistant-pending" aria-label="A min válaszol">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
        {message.role === "user" && onRevert && (
          // On the prompt rather than on the answer: what you return to is a
          // question you asked, and the state the project was in when you
          // asked it. Beside the bubble, so it never covers the words.
          <button
            type="button"
            className="message-revert"
            title="A beszélgetés és a fájlok visszaállítása erre a pontra"
            onClick={() => onRevert(message)}
          >
            ⤺ Visszaállítás ide
          </button>
        )}
      </div>
    </article>
  );
});

/**
 * A fa sorának állapotjele: gondolkodik, ment, vagy semmi. A mentés a válasz
 * *után* jön (teljes munkaterület-snapshot), és az nem gondolkodás — külön
 * jelet érdemel, különben úgy néz ki, mintha a modell még dolgozna.
 */

type CodeWorkCardProps = {
  expanded: boolean;
  activities: CodeActivity[];
  snippets: CodeSnippet[];
  status: string;
  streaming: boolean;
  onToggle: () => void;
};

const workKindIcons: Record<WorkItemKind, string> = {
  status: "•",
  reasoning: "◌",
  command: "›",
  file: "▣",
  tool: "◇",
};

const workStatusLabels: Record<WorkItemStatus, string> = {
  running: "folyamatban",
  done: "kész",
  error: "hiba",
};

function WorkLogCard({
  expanded,
  activities,
  snippets,
  status,
  streaming,
  onToggle,
}: CodeWorkCardProps) {
  const visibleActivities = [...activities]
    .sort((a, b) => a.id - b.id)
    .slice(-32);
  const label =
    visibleActivities.length > 0
      ? streaming
        ? "Munkafolyamat folyamatban"
        : "Munkafolyamat"
      : "Kód";
  return (
    <article
      className={`code-work-card work-log-card${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}
    >
      <button
        type="button"
        className="code-work-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        <span className="code-work-status">
          {streaming ? "folyamatban" : status}
        </span>
        <span className="code-work-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && (
        <div
          className="code-work-body"
          data-quote-selectable="true"
          role="log"
          aria-live={streaming ? "polite" : undefined}
        >
          {visibleActivities.map((activity) => (
            <div
              className={`code-work-activity work-item-${activity.kind} work-item-${activity.status}`}
              key={`activity-${activity.itemId ?? activity.id}`}
            >
              <span className="code-work-marker">
                {workKindIcons[activity.kind]}
              </span>
              <div className="work-item-content">
                <div className="work-item-heading">
                  <strong>{activity.label}</strong>
                  <span className="work-item-state">
                    {workStatusLabels[activity.status]}
                  </span>
                  <time>{activity.time}</time>
                </div>
                {activity.detail && <code>{activity.detail}</code>}
                {activity.body &&
                  (activity.kind === "reasoning" ? (
                    <p className="work-item-body">{activity.body}</p>
                  ) : (
                    <pre className="work-item-output">{activity.body}</pre>
                  ))}
                {activity.code && (
                  <>
                    <small className="code-work-language">
                      {activity.language ?? "diff"}
                    </small>
                    <pre>
                      <code>{highlightCode(activity.code)}</code>
                    </pre>
                  </>
                )}
              </div>
            </div>
          ))}
          {snippets.map((snippet) => (
            <div className="code-work-snippet" key={`inline-${snippet.id}`}>
              <div className="code-work-snippet-label">{snippet.language}</div>
              <pre>
                <code>{highlightCode(snippet.code)}</code>
              </pre>
            </div>
          ))}
          {streaming && visibleActivities.length === 0 && (
            <div className="code-work-placeholder">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" /> Codex dolgozik…
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function WorkFlowCard({
  expanded,
  activities,
  snippets,
  status,
  streaming,
  onToggle,
}: CodeWorkCardProps) {
  const [selectedItem, setSelectedItem] = useState<{
    type: "activity" | "snippet";
    id: string;
  } | null>(null);
  const visibleActivities = [...activities]
    .sort((a, b) => a.id - b.id)
    .slice(-32);
  const selectedActivity =
    selectedItem?.type === "activity"
      ? visibleActivities.find(
          (activity) =>
            `activity-${activity.itemId ?? activity.id}` === selectedItem.id,
        )
      : undefined;
  const selectedSnippet =
    selectedItem?.type === "snippet"
      ? snippets.find((snippet) => `snippet-${snippet.id}` === selectedItem.id)
      : undefined;
  const label =
    visibleActivities.length > 0
      ? streaming
        ? "Munkafolyamat folyamatban"
        : "Munkafolyamat"
      : "Kód";
  const iconFor = (activity: CodeActivity) => {
    if (activity.status === "error") return "!";
    if (activity.kind === "reasoning") return "◌";
    if (activity.kind === "command") return "›_";
    if (activity.kind === "file") return "□";
    if (activity.kind === "tool") return "◇";
    return "•";
  };
  return (
    <article
      className={`code-work-card work-log-card${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}
    >
      <button
        type="button"
        className="code-work-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        {visibleActivities.length > 0 && (
          <span className="code-work-count">
            {visibleActivities.length} lépés
          </span>
        )}
        <span className="code-work-status">
          {streaming ? "folyamatban" : status}
        </span>
        <span className="code-work-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && (
        <div
          className="work-flow-panel"
          data-quote-selectable="true"
          role="region"
          aria-label="Munkafolyamat részletei"
          aria-live={streaming ? "polite" : undefined}
        >
          <div
            className="work-flow-track"
            role="list"
            aria-label="Munkafolyamat lépései"
          >
            {visibleActivities.map((activity, index) => {
              const id = `activity-${activity.itemId ?? activity.id}`;
              const canInspect =
                activity.status === "error" ||
                !["reasoning", "status"].includes(activity.kind);
              const icon = iconFor(activity);
              return (
                <div className="work-flow-step" role="listitem" key={id}>
                  {canInspect ? (
                    <button
                      type="button"
                      className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}${selectedItem?.id === id ? " is-selected" : ""}`}
                      onClick={() =>
                        setSelectedItem((current) =>
                          current?.id === id ? null : { type: "activity", id },
                        )
                      }
                      title={`${activity.label}: ${activity.detail || workStatusLabels[activity.status]}`}
                      aria-label={activity.label}
                      aria-pressed={selectedItem?.id === id}
                    >
                      {icon}
                    </button>
                  ) : (
                    <span
                      className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}`}
                      title={activity.label}
                      aria-label={activity.label}
                      aria-disabled="true"
                    >
                      {icon}
                    </span>
                  )}
                  {index < visibleActivities.length - 1 && (
                    <span className="work-flow-arrow" aria-hidden="true">
                      →
                    </span>
                  )}
                </div>
              );
            })}
            {visibleActivities.length === 0 && (
              <span className="work-flow-placeholder">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" /> Codex dolgozik…
              </span>
            )}
          </div>
          {snippets.length > 0 && (
            <div className="work-flow-code-links" aria-label="Kódrészletek">
              {snippets.map((snippet) => {
                const id = `snippet-${snippet.id}`;
                return (
                  <button
                    type="button"
                    className={`work-flow-code-link${selectedItem?.id === id ? " is-selected" : ""}`}
                    key={id}
                    onClick={() =>
                      setSelectedItem((current) =>
                        current?.id === id ? null : { type: "snippet", id },
                      )
                    }
                    aria-pressed={selectedItem?.id === id}
                  >
                    <span>⌘</span>
                    {snippet.language}
                  </button>
                );
              })}
            </div>
          )}
          {selectedActivity || selectedSnippet ? (
            <div className="work-flow-detail">
              <div className="work-flow-detail-header">
                <span className="work-flow-detail-icon">
                  {selectedActivity ? iconFor(selectedActivity) : "⌘"}
                </span>
                <strong>
                  {selectedActivity?.label ??
                    `Kódrészlet · ${selectedSnippet?.language ?? "text"}`}
                </strong>
                <button
                  type="button"
                  className="work-flow-detail-close"
                  onClick={() => setSelectedItem(null)}
                  aria-label="Részlet bezárása"
                >
                  ×
                </button>
              </div>
              {selectedActivity?.detail && (
                <code className="work-flow-detail-path">
                  {selectedActivity.detail}
                </code>
              )}
              {selectedActivity?.body && (
                <pre className="work-flow-detail-output">
                  {selectedActivity.body}
                </pre>
              )}
              {selectedActivity?.code && (
                <>
                  <small className="code-work-language">
                    {selectedActivity.language ?? "diff"}
                  </small>
                  <pre className="work-flow-detail-code">
                    <code>{highlightCode(selectedActivity.code)}</code>
                  </pre>
                </>
              )}
              {selectedSnippet && (
                <pre className="work-flow-detail-code">
                  <code>{highlightCode(selectedSnippet.code)}</code>
                </pre>
              )}
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

const planStatusLabels: Record<PlanStepStatus, string> = {
  pending: "várakozik",
  inProgress: "folyamatban",
  completed: "kész",
  error: "hiba",
};

function PlanProgressCard({
  plan,
  streaming,
  expanded,
  onToggle,
}: {
  plan: PlanSnapshot;
  streaming: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const completed = plan.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const active = plan.steps.find((step) => step.status === "inProgress");
  const hasSteps = plan.steps.length > 0;
  return (
    <article
      className={`plan-progress-card${streaming ? " is-live" : ""}${expanded ? " is-expanded" : ""}`}
      aria-label="Codex feladatterve"
    >
      <button
        type="button"
        className="plan-card-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <span className="plan-card-heading">
          <strong>Feladatterv</strong>
          <small>{hasSteps ? "Codex értelmezése" : "terv készül…"}</small>
        </span>
        {hasSteps && (
          <span className="plan-card-progress">
            {completed}/{plan.steps.length} kész
          </span>
        )}
        <span className="code-work-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {hasSteps ? (
        <div
          className="plan-step-list"
          data-quote-selectable="true"
          role="list"
          aria-live="polite"
        >
          {plan.steps.map((step, index) => (
            <div
              className={`plan-step plan-step-${step.status}`}
              role="listitem"
              key={step.id}
            >
              <span className="plan-step-marker" aria-hidden="true">
                {step.status === "completed"
                  ? "✓"
                  : step.status === "error"
                    ? "!"
                    : step.status === "inProgress"
                      ? <span className="plan-step-spinner" aria-label="Fut" />
                      : index + 1}
              </span>
              <span className="plan-step-copy">{step.step}</span>
              <span className="plan-step-status">
                {planStatusLabels[step.status]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="plan-empty-state">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span>
            Az értelmezett lépések megjelennek, amint a plan elkészül.
          </span>
        </div>
      )}
      {expanded && (
        <div className="plan-detail-panel" data-quote-selectable="true">
          {plan.explanation && (
            <p className="plan-explanation">
              <strong>Miért ez a felbontás?</strong>
              {plan.explanation}
            </p>
          )}
          {active && (
            <div className="plan-active-note">
              <span>→</span>
              <span>
                Most ezen dolgozik: <strong>{active.step}</strong>
              </span>
            </div>
          )}
          {!plan.explanation && !active && (
            <div className="plan-detail-hint">
              A feladatterv részletei és az aktuális lépés itt jelennek meg.
            </div>
          )}
        </div>
      )}
    </article>
  );
}


/**
 * Full-size preview for an agent-generated image.
 *
 * A block diagram is only useful if its labels can be read, so the view zooms
 * toward the pointer and pans by dragging. The image is rendered from a data
 * URL, which keeps SVG inert: no scripts, no network access.
 */

/** Files the preview overlay can render; everything else stays plain text. */
const PREVIEWABLE_IMAGE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "webp"];
const isPreviewableImagePath = (filePath: string) => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEWABLE_IMAGE_EXTENSIONS.includes(extension);
};

function ChangeSummaryPanel({
  files,
  onRollback,
  rollbackBusy,
  onPreviewImage,
}: {
  files: ChangeSummaryFile[];
  onRollback?: () => void;
  rollbackBusy?: boolean;
  onPreviewImage?: (path: string) => void;
}) {
  if (files.length === 0) return null;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const statusLabel = (status: ChangeSummaryFile["status"]) =>
    status === "added" ? "ÚJ" : status === "removed" ? "TÖRÖLT" : "MÓDOSÍTVA";
  return (
    <aside className="trace-change-summary" aria-label="Fájlok és változások">
      <div className="trace-change-heading">
        <strong>FÁJLOK / VÁLTOZÁSOK</strong>
        <span>{files.length} fájl</span>
      </div>
      <ul className="trace-change-list">
        {files.map((file) => (
          <li key={`${file.status}:${file.path}`} title={file.path}>
            {onPreviewImage && isPreviewableImagePath(file.path) ? (
              <button
                type="button"
                className="trace-change-preview"
                onClick={() => onPreviewImage(file.path)}
                title="Előnézet megnyitása"
              >
                <code>{file.path}</code>
              </button>
            ) : (
              <code>{file.path}</code>
            )}
            <span className="trace-change-status">{statusLabel(file.status)}</span>
            <span className="trace-change-added">+{file.added}</span>
            <span className="trace-change-removed">−{file.removed}</span>
          </li>
        ))}
      </ul>
      <div className="trace-change-footer" aria-label="Változási összesítő">
        <span><i className="trace-change-dot is-added" />{added} hozzáadva</span>
        <span><i className="trace-change-dot is-removed" />{removed} kivéve</span>
        {onRollback && (
          <button
            type="button"
            className="trace-change-rollback"
            onClick={onRollback}
            disabled={rollbackBusy}
            title="A turn összes fájlváltozásának visszaállítása a turn előtti állapotra"
          >
            {rollbackBusy ? "Visszavonás…" : "↺ Visszavonás"}
          </button>
        )}
      </div>
    </aside>
  );
}

const writeTextToClipboard = async (text: string) => {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (copied) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("A vágólap nem érhető el.");
};

type TurnProgressCardProps = {
  plan: PlanSnapshot;
  activities: CodeActivity[];
  commentary: CommentaryEntry[];
  status: string;
  streaming: boolean;
  expanded: boolean;
  transport: CodexTransportStatus | null;
  watchdogMessage: string;
  onToggle: () => void;
  answer?: Message;
  quoteRefs?: QuoteReference[];
  quoteAnchorPrefix: string;
  onQuoteJump?: QuoteJumpHandler;
  compact?: boolean;
  onCopyAnswer?: (answer: Message) => Promise<void> | void;
  onRegenerate?: (answer: Message) => void;
  onRollbackChanges?: () => void;
  rollbackBusy?: boolean;
  onPreviewImage?: (path: string) => void;
  /** Where this card sits inside a chain, so the run reads as one block. */
  runPosition?: "start" | "middle" | "end";
  /** A review says pass or fail in its colour rather than in a chip. */
  runTone?: "accepted" | "changes";
  runHeader?: ReactNode;
  /** What a run offers once it has a verdict, e.g. re-running after a reject. */
  runFooter?: ReactNode;
  /** Which chain stage this card belongs to; labels the pre-plan step. */
  stageRole?: string;
};

function TurnProgressCard({
  plan,
  activities,
  commentary,
  status,
  streaming,
  expanded,
  transport,
  watchdogMessage,
  onToggle,
  answer,
  quoteRefs = [],
  quoteAnchorPrefix,
  onQuoteJump,
  compact = false,
  onCopyAnswer,
  onRegenerate,
  onRollbackChanges,
  rollbackBusy,
  onPreviewImage,
  runPosition,
  runTone,
  runHeader,
  runFooter,
  stageRole,
}: TurnProgressCardProps) {
  const quoteAnchor = (suffix: string) =>
    `${quoteAnchorPrefix}:${suffix}`;
  const quotesForAnchor = (anchorId: string) =>
    quoteRefs.filter((quote) => quote.anchorId === anchorId);
  const answerAnchorId = answer ? messageAnchorId(answer) : quoteAnchor("answer");
  const answerText = answer?.text ?? "";
  const answerQuoteRefs = Array.from(
    new Map(
      [
        ...quotesForAnchor(answerAnchorId),
        ...quotesForAnchor(quoteAnchor("answer")),
        ...quoteRefs.filter(
          (quote) =>
            quote.instruction.trim().length >= 3 &&
            answerText.includes(quote.instruction.trim()),
        ),
      ].map((quote) => [quote.id, quote]),
    ).values(),
  );
  const hasPlanStepEvidence = (stepId: string) =>
    activities.some((activity) => activity.planStepId === stepId) ||
    commentary.some((entry) => entry.stepId === stepId);
  const hasMeaningfulStepTiming = (stepId: string) => {
    const timing = plan.stepTimes?.[stepId];
    return (
      (timing?.startedAt !== undefined || timing?.completedAt !== undefined) &&
      !(
        timing?.startedAt !== undefined &&
        timing?.completedAt !== undefined &&
        timing.completedAt <= timing.startedAt
      )
    );
  };
  const hasMeaningfulPlanTiming = plan.steps.some((step) => {
    return hasMeaningfulStepTiming(step.id);
  });
  const normalizedPlannedSteps = plan.steps
    .filter(
      (step) =>
        step.id !== "client-pre-plan" && !step.id.startsWith("client-fallback"),
    )
    .map((step) => {
      const timing = plan.stepTimes?.[step.id];
      const hasZeroStoredTiming =
        timing?.startedAt !== undefined &&
        timing?.completedAt !== undefined &&
        timing.completedAt <= timing.startedAt;
      // Old clients marked every planned row as completed at the same
      // request-start timestamp. Rows with no trace evidence are recovered as
      // pending so historical cards do not claim work that never ran.
      return step.status === "completed" &&
        hasZeroStoredTiming &&
        !hasPlanStepEvidence(step.id) &&
        !hasMeaningfulPlanTiming
        ? { ...step, status: "pending" as const }
        : step;
    });
  const plannedSteps = streaming
    ? normalizedPlannedSteps
    : normalizedPlannedSteps.filter((step) => {
        const timing = plan.stepTimes?.[step.id];
        const hasTraceEvidence = hasPlanStepEvidence(step.id);
        const hasMeaningfulTiming =
          (timing?.startedAt !== undefined || timing?.completedAt !== undefined) &&
          !(timing?.startedAt !== undefined &&
            timing?.completedAt !== undefined &&
            timing.completedAt <= timing.startedAt);
        // A completed plan with at least one real timing boundary is
        // authoritative: retain its explicitly completed zero-duration rows
        // too. Older all-zero phantom plans are normalized to pending above
        // and remain hidden here.
        return (
          hasTraceEvidence ||
          hasMeaningfulTiming ||
          step.status === "error" ||
          step.status === "inProgress" ||
          (hasMeaningfulPlanTiming && step.status === "completed")
        );
      });
  const fallbackStep: PlanStep = {
    id: "client-pre-plan",
    step: prePlanStepLabel(stageRole ?? answer?.pipeline?.stageRole),
    status: streaming && plannedSteps.length === 0 ? "inProgress" : "completed",
  };
  const isPrePlanStepId = (stepId?: string | null) =>
    !stepId ||
    stepId === fallbackStep.id ||
    stepId.startsWith("client-fallback");
  // The preparation row is a client-side placeholder used only until a real
  // model plan arrives. Once real plan steps exist, attach unassigned
  // preparation notes to the first real step instead of rendering a separate
  // synthetic `0. Terv...` row with a misleading 0:00 duration.
  const steps = plannedSteps.length === 0 ? [fallbackStep] : plannedSteps;
  const prePlanDisplayStepId = plannedSteps[0]?.id ?? fallbackStep.id;
  const commentaryStepId = (body: string) => {
    const match = body.match(/\b(\d+)\.\s*lépés\b/i);
    const index = match ? Number(match[1]) - 1 : -1;
    return index >= 0 && index < plannedSteps.length
      ? plannedSteps[index].id
      : undefined;
  };
  const commentaryBelongsToStep = (entry: CommentaryEntry, stepId: string) => {
    const numberedStepId = commentaryStepId(entry.body);
    if (numberedStepId) return numberedStepId === stepId;
    return entry.stepId
      ? isPrePlanStepId(entry.stepId)
        ? stepId === prePlanDisplayStepId
        : entry.stepId === stepId
      : stepId === prePlanDisplayStepId;
  };
  const activityBelongsToStep = (activity: CodeActivity, stepId: string) =>
    isPrePlanStepId(activity.planStepId)
      ? stepId === prePlanDisplayStepId
      : activity.planStepId === stepId;
  const hasTraceForStep = (stepId: string) =>
    activities.some(
      (activity) =>
        activityBelongsToStep(activity, stepId) &&
        activity.kind === "reasoning" &&
        Boolean(activity.body?.trim()),
    ) ||
    commentary.some(
      (entry) =>
        Boolean(entry.body.trim()) && commentaryBelongsToStep(entry, stepId),
    );
  const hasUnassignedTrace =
    activities.some(
      (activity) =>
        isPrePlanStepId(activity.planStepId) &&
        activity.kind === "reasoning" &&
        Boolean(activity.body?.trim()),
    ) ||
    commentary.some(
      (entry) => isPrePlanStepId(entry.stepId) && Boolean(entry.body.trim()),
    );
  // While streaming, follow the active step. Once the turn is complete, keep
  // the last step that actually has trace data selected instead of jumping to
  // a final plan step that may contain no commentary at all.
  const lastTracedStep = [...steps]
    .reverse()
    .find((step) => hasTraceForStep(step.id));
  const activeStep = streaming
    ? (steps.find((step) => step.status === "inProgress") ??
      steps.find((step) => step.status === "pending") ??
      lastTracedStep ??
      steps[steps.length - 1])
    : (lastTracedStep ??
      (hasUnassignedTrace ? steps[0] : undefined) ??
      [...steps].reverse().find((step) => step.status === "completed") ??
      steps[0]);
  const [selectedStepId, setSelectedStepId] = useState(activeStep.id);
  const [inlineDiff, setInlineDiff] = useState<InlineCodeDiff | null>(null);
  const followActiveStepRef = useRef(true);

  useEffect(() => {
    if (!steps.some((step) => step.id === selectedStepId))
      setSelectedStepId(activeStep.id);
    if (followActiveStepRef.current) setSelectedStepId(activeStep.id);
  }, [activeStep.id, selectedStepId, steps, streaming]);

  useEffect(() => {
    if (!inlineDiff) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setInlineDiff(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inlineDiff]);

  const selectedStep =
    steps.find((step) => step.id === selectedStepId) ?? activeStep;
  const orderedActivities = [...activities].sort(
    (left, right) => left.id - right.id,
  );
  const evidenceTimesForStep = (stepId: string) => {
    const activityTimes = orderedActivities
      .filter((activity) => activityBelongsToStep(activity, stepId))
      .map((activity) => activity.id)
      .filter((value) => Number.isFinite(value) && value > 1e12);
    const commentaryTimes = commentary
      .filter((entry) => commentaryBelongsToStep(entry, stepId))
      .map((entry) => entry.sequence)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > 1e12,
      );
    return [...activityTimes, ...commentaryTimes].sort((left, right) => left - right);
  };
  const stepActivities = orderedActivities.filter((activity) =>
    activityBelongsToStep(activity, selectedStep.id),
  );
  const stepCommentary = commentary
    .filter((entry) => commentaryBelongsToStep(entry, selectedStep.id))
    .sort(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(-32);
  const thinkingEntries = useMemo<ThinkingEntry[]>(() => {
    const entries: ThinkingEntry[] = [];
    const internalActivities = stepActivities.filter(
      (activity) => activity.kind === "reasoning" && Boolean(activity.body?.trim()),
    );
    const summariesFor = (body: string | undefined) => {
      const summaries = [...(body ?? "").matchAll(/\*\*([^*]+)\*\*/g)]
        .map((match) => match[1].trim())
        .filter(Boolean);
      return summaries.length > 0 ? summaries : body?.trim() ? [body.trim()] : [];
    };
    type InternalChunk = {
      body: string;
      sequence: number;
      activity: CodeActivity;
    };
    const internalChunks: InternalChunk[] = internalActivities.flatMap(
      (activity) =>
        summariesFor(activity.body).map((body, index) => ({
          body,
          sequence: activity.id + (index + 1) / 1000,
          activity,
        })),
    );
    // A Claude thinking block arrives twice: streamed live as commentary and
    // once more as the durable reasoning row of the complete message. Showing
    // both would repeat every thought verbatim; the durable row wins.
    const internalBodies = new Set(
      internalActivities.map((activity) => activity.body?.trim() ?? ""),
    );
    // What the stage actually did, one row per tool call. Without these a
    // coding stage that thought silently showed a single "Kódmódosítás
    // történt." line for four edits and a test run.
    const toolBullet = (activity: CodeActivity) =>
      activity.kind === "command"
        ? `$ ${
            activity.detail.length > 110
              ? `${activity.detail.slice(0, 110)}…`
              : activity.detail
          }`
        : activity.kind === "file"
          ? `Fájl — ${activity.detail}`
          : activity.detail;
    const toolRecords = stepActivities
      .filter(
        (activity) =>
          (activity.kind === "file" ||
            activity.kind === "command" ||
            activity.kind === "tool") &&
          Boolean(activity.detail?.trim()),
      )
      .map((activity) => ({
        activity,
        body: toolBullet(activity),
        sequence: activity.id,
      }));
    const commentaryRecords = stepCommentary
      .map((entry, index) => {
        const body = entry.body.trim();
        if (!body) return null;
        if (internalBodies.has(body)) return null;
        const fallbackSequence =
          (orderedActivities.at(-1)?.id ?? Date.now()) + (index + 1) / 1000;
        return {
          entry,
          body,
          sequence:
            typeof entry.sequence === "number" && Number.isFinite(entry.sequence)
              ? entry.sequence
              : fallbackSequence,
        };
      })
      .filter(
        (
          value,
        ): value is {
          entry: CommentaryEntry;
          body: string;
          sequence: number;
        } => Boolean(value),
      );
    const timeline = [
      ...internalChunks.map((chunk) => ({ kind: "internal" as const, chunk })),
      ...commentaryRecords.map((record) => ({
        kind: "commentary" as const,
        record,
      })),
      ...toolRecords.map((record) => ({ kind: "tool" as const, record })),
    ].sort((left, right) => {
      const leftSequence =
        left.kind === "internal" ? left.chunk.sequence : left.record.sequence;
      const rightSequence =
        right.kind === "internal" ? right.chunk.sequence : right.record.sequence;
      return leftSequence - rightSequence;
    });
    let pendingInternal: InternalChunk[] = [];
    const flushInternal = () => {
      if (pendingInternal.length === 0) return;
      const history = pendingInternal
        .map((chunk) => chunk.body)
        .filter((body, index, values) => values.indexOf(body) === index);
      const latest = pendingInternal.at(-1);
      if (!latest || history.length === 0) {
        pendingInternal = [];
        return;
      }
      entries.push({
        id: `internal-${latest.activity.id}-${latest.sequence}`,
        body: history.at(-1) ?? latest.body,
        kind: "internal",
        sequence: latest.sequence,
        internalHistory: history,
        codeActivity: [...pendingInternal]
          .reverse()
          .map((chunk) => chunk.activity)
          .find(
            (activity) =>
              activity.code || activity.beforeCode || activity.afterCode,
          ),
      });
      pendingInternal = [];
    };
    for (const item of timeline) {
      if (item.kind === "internal") {
        pendingInternal.push(item.chunk);
        continue;
      }
      // Keep only the last internal phase in each gap, while retaining its
      // complete history behind the clickable English line.
      flushInternal();
      if (item.kind === "tool") {
        const toolActivity = item.record.activity;
        entries.push({
          id: `tool-${toolActivity.id}`,
          body: item.record.body,
          kind: "commentary",
          sequence: item.record.sequence,
          codeActivity:
            toolActivity.code || toolActivity.beforeCode || toolActivity.afterCode
              ? toolActivity
              : undefined,
        });
        continue;
      }
      entries.push({
        id: `commentary-${item.record.entry.id}`,
        body: item.record.body,
        kind: "commentary",
        sequence: item.record.sequence,
      });
    }
    flushInternal();
    const codeActivities = stepActivities.filter(
      (activity) => activity.code || activity.beforeCode || activity.afterCode,
    );
    if (
      codeActivities.length > 0 &&
      !entries.some((entry) => entry.codeActivity)
    ) {
      const last = entries[entries.length - 1];
      if (last && !last.codeActivity)
        last.codeActivity = codeActivities[codeActivities.length - 1];
      else if (!last)
        entries.push({
          id: `code-${codeActivities[codeActivities.length - 1].id}`,
          body: "Kódmódosítás történt.",
          kind: "commentary",
          sequence: codeActivities[codeActivities.length - 1].id,
          codeActivity: codeActivities[codeActivities.length - 1],
        });
    }
    return entries.slice(-80);
  }, [orderedActivities, stepActivities, stepCommentary]);
  const [expandedInternalEntryId, setExpandedInternalEntryId] =
    useState<string | null>(null);
  const [essentialTraceOnly, setEssentialTraceOnly] = useState(false);
  const visibleThinkingEntries = essentialTraceOnly
    ? thinkingEntries.filter((entry) => entry.kind !== "internal")
    : thinkingEntries;
  const thinkingListRef = useRef<HTMLUListElement>(null);
  const inferredStartedAtRef = useRef<number | undefined>(plan.startedAt);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (plan.startedAt !== undefined)
      inferredStartedAtRef.current = plan.startedAt;
  }, [plan.startedAt]);
  useEffect(() => {
    if (!streaming) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);
  useEffect(() => {
    if (!expanded) return;
    const list = thinkingListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      if (streaming || list.scrollTop + list.clientHeight >= list.scrollHeight - 72)
        list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, selectedStep.id, streaming, thinkingEntries]);
  const recordedStepStarts = Object.values(plan.stepTimes ?? {})
    .map((timing) => timing.startedAt)
    .filter((value): value is number => Number.isFinite(value));
  const recordedStepEnds = Object.values(plan.stepTimes ?? {})
    .map((timing) => timing.completedAt)
    .filter((value): value is number => Number.isFinite(value));
  const inferredPlanStartedAt = Math.min(
    ...recordedStepStarts,
  );
  const inferredPlanCompletedAt = Math.max(
    ...recordedStepEnds,
  );
  const startedAtForDisplay =
    plan.startedAt ??
    (Number.isFinite(inferredPlanStartedAt) ? inferredPlanStartedAt : undefined) ??
    (streaming ? inferredStartedAtRef.current : undefined);
  const completedAtForDisplay =
    plan.completedAt ??
    (!streaming && Number.isFinite(inferredPlanCompletedAt)
      ? inferredPlanCompletedAt
      : undefined);
  const elapsedEnd = streaming ? clockNow : completedAtForDisplay;
  const overallElapsed =
    startedAtForDisplay !== undefined && elapsedEnd !== undefined
      ? formatElapsed(Math.max(0, elapsedEnd - startedAtForDisplay))
      : "";
  const hasAnswer = Boolean(answer?.text.trim());
  const changeSummary =
    answer?.changeSummary && answer.changeSummary.length > 0
      ? answer.changeSummary
      : answer?.pipeline
        // A chain's files card comes from the chain guard and sits on the
        // coding stage's answer. Deriving one from another stage's activities
        // put a "modified" card with absolute paths on the reviewer, which
        // never wrote a file.
        ? []
        : changeSummaryFromActivities(activities);
  const [copiedAnswer, setCopiedAnswer] = useState(false);
  const copyAnswer = async () => {
    if (!answer?.text.trim()) return;
    try {
      if (onCopyAnswer) await onCopyAnswer(answer);
      else await writeTextToClipboard(answer.text);
      setCopiedAnswer(true);
      window.setTimeout(() => setCopiedAnswer(false), 1400);
    } catch {
      setCopiedAnswer(false);
    }
  };
  const answerActions = hasAnswer && !streaming && (onCopyAnswer || onRegenerate) ? (
    <div className="trace-answer-actions">
      {onCopyAnswer && (
        <button type="button" onClick={() => void copyAnswer()}>
          <span aria-hidden="true">{copiedAnswer ? "✓" : "⧉"}</span>
          {copiedAnswer ? "Másolva" : "Másolás"}
        </button>
      )}
      {onRegenerate && (
        <button type="button" onClick={() => answer && onRegenerate(answer)}>
          <span aria-hidden="true">↻</span>
          Újragenerálás
        </button>
      )}
    </div>
  ) : null;
  type TraceView = "answer" | "steps";
  const [traceView, setTraceView] = useState<TraceView>(
    streaming ? (hasAnswer ? "answer" : "steps") : "answer",
  );
  const manualTraceViewRef = useRef(false);
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    // A completed answer is the primary view, including after a cold start
    // where the persisted expansion flag may still be true. Only a live turn
    // follows the phase flow; an answer-less historical card can still open
    // its trace when explicitly expanded.
    const enteredStreaming = streaming && !wasStreamingRef.current;
    const leftStreaming = !streaming && wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    if (enteredStreaming || leftStreaming) manualTraceViewRef.current = false;
    if (manualTraceViewRef.current) return;
    if (streaming) {
      setTraceView(hasAnswer ? "answer" : "steps");
    } else if (hasAnswer) {
      // Recovery can populate the answer after the first render. Do not leave
      // the user on LÉPÉSEK just because the placeholder initially had no text.
      setTraceView("answer");
    } else {
      setTraceView(expanded ? "steps" : "answer");
    }
  }, [expanded, hasAnswer, streaming]);
  useEffect(() => {
    if (!streaming) return;
    const nextView: TraceView = hasAnswer ? "answer" : "steps";
    setTraceView(nextView);
    // Keep the durable expansion choice in sync so the completed card does
    // not jump back to LÉPÉSEK after the live card is replaced in the timeline.
    if ((nextView === "steps") !== expanded) onToggle();
    // This is deliberately phase-driven. A later manual tab choice must not be
    // immediately overwritten while the answer remains in the same phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAnswer, streaming]);
  const selectTraceView = (next: TraceView) => {
    manualTraceViewRef.current = true;
    setTraceView(next);
    if ((next === "steps") !== expanded) onToggle();
  };
  const selectStep = (stepId: string) => {
    followActiveStepRef.current = false;
    setSelectedStepId(stepId);
  };
  const displayStatus = (step: PlanStep) =>
    streaming && step.id === activeStep.id && step.status === "pending"
      ? "inProgress"
      : step.status;
  const completedStepCount = steps.filter(
    (step) => displayStatus(step) === "completed",
  ).length;
  const reasoningCountFor = (stepId: string) =>
    orderedActivities.filter(
      (activity) =>
        activity.kind === "reasoning" &&
        activityBelongsToStep(activity, stepId),
    ).length;
  const stepIndicator = (step: PlanStep) => {
    const currentStatus = displayStatus(step);
    if (currentStatus === "inProgress")
      return <span className="trace-step-spinner" aria-label="Fut" />;
    if (currentStatus === "error")
      return <span className="trace-step-error-indicator">!</span>;
    if (currentStatus !== "completed") return null;
    const count = reasoningCountFor(step.id);
    const barCount = Math.min(8, Math.max(1, count));
    return (
      <span
        className="trace-step-intensity"
        aria-label={`${count} gondolkodási esemény`}
        title={`${count} gondolkodási esemény`}
      >
        {Array.from({ length: barCount }, (_, index) => (
          <span
            className="trace-step-intensity-line"
            key={`${step.id}-bar-${index}`}
          />
        ))}
      </span>
    );
  };
  const stepElapsedFor = (step: PlanStep) => {
    const timing = plan.stepTimes?.[step.id];
    const currentStatus = displayStatus(step);
    let startedAt = timing?.startedAt;
    let end = timing?.completedAt;
    if (
      startedAt === undefined &&
      step.id === fallbackStep.id &&
      startedAtForDisplay !== undefined
    ) {
      // The synthetic preparation row is not part of the model-provided
      // plan. Its end is the moment the first real plan step starts.
      startedAt = startedAtForDisplay;
      end =
        plan.stepTimes?.[plannedSteps[0]?.id ?? ""]?.startedAt ??
        (plannedSteps[0]
          ? evidenceTimesForStep(plannedSteps[0].id)[0]
          : undefined) ??
        (currentStatus === "inProgress" ? clockNow : completedAtForDisplay);
    }
    if (startedAt === undefined && currentStatus === "inProgress")
      startedAt = startedAtForDisplay;
    if (startedAt === undefined) return "";
    if (end === undefined && currentStatus === "inProgress") end = clockNow;
    const stepIndex = steps.findIndex((candidate) => candidate.id === step.id);
    const nextStep = stepIndex >= 0 ? steps[stepIndex + 1] : undefined;
    const nextStepEvidenceStart = nextStep
      ? evidenceTimesForStep(nextStep.id)[0]
      : undefined;
    const evidenceTimes = evidenceTimesForStep(step.id);
    const hasInvalidStoredTiming =
      end !== undefined && end <= startedAt;
    if (hasInvalidStoredTiming && evidenceTimes.length > 0) {
      // Older snapshots recorded the request start for both sides of every
      // step. Recover a useful interval from the durable activity timeline.
      startedAt = evidenceTimes[0];
      end =
        currentStatus === "inProgress"
          ? clockNow
          : nextStepEvidenceStart ??
            plan.stepTimes?.[nextStep?.id ?? ""]?.startedAt ??
            completedAtForDisplay ??
            evidenceTimes.at(-1);
    }
    if (
      hasInvalidStoredTiming &&
      evidenceTimes.length === 0 &&
      currentStatus !== "inProgress"
    )
      return "";
    if (end === undefined && currentStatus === "completed") {
      end = nextStep
        ? plan.stepTimes?.[nextStep.id]?.startedAt
        : completedAtForDisplay;
    }
    return end === undefined
      ? ""
      : formatElapsed(Math.max(0, end - startedAt));
  };
  const openInlineDiff = (activity: CodeActivity) =>
    setInlineDiff(inlineCodeDiffForActivity(activity));

  const runClasses =
    (runPosition ? ` in-run is-run-${runPosition}` : "") +
    (runTone ? ` is-verdict-${runTone}` : "");
  if (compact) {
    return (
      <>
      {runHeader}
      <article
        className={`compact-answer-card${runClasses}`}
        data-quote-selectable="true"
        data-quote-anchor={answerAnchorId}
        aria-label="Válasz"
      >
        <div className="compact-answer-header">
          <strong>VÁLASZ</strong>
          {stageBadge(answer?.pipeline)}
          {(streaming || !runPosition) && (
            <span>{streaming ? "készül" : "kész"}</span>
          )}
          {answerActions}
        </div>
        <div className="compact-answer-body">
          <div className="compact-answer-line">
            {hasAnswer && (
              <p>
                {answerWithQuoteBacklinks(
                  textWithoutCodeBlocks(answer?.text ?? ""),
                  answerQuoteRefs,
                  onQuoteJump ?? (() => undefined),
                )}
              </p>
            )}
            {streaming && (
              <span className="trace-answer-spinner" aria-label="Válasz készül" />
            )}
          </div>
          {onQuoteJump && answerQuoteRefs.length > 0 &&
            answerQuoteRefs.some(
              (quote) =>
                !answer?.text.includes(quote.text) &&
                !(quote.instruction && answer?.text.includes(quote.instruction)),
            ) &&
            quoteBacklinkButtons(
              answerQuoteRefs.filter(
                (quote) =>
                  !answer?.text.includes(quote.text) &&
                  !(quote.instruction && answer?.text.includes(quote.instruction)),
              ),
              onQuoteJump,
            )}
        </div>
        {changeSummary.length > 0 && (
          <div className="compact-answer-changes">
            <ChangeSummaryPanel
              files={changeSummary}
              onRollback={onRollbackChanges}
              rollbackBusy={rollbackBusy}
              onPreviewImage={onPreviewImage}
            />
          </div>
        )}
        {runFooter}
      </article>
      </>
    );
  }

  return (
    <>
      {runHeader}
      <article
        className={`turn-progress-card trace-card trace-view-${traceView}${streaming ? " is-live" : ""}${runClasses}`}
        aria-label="Lépések és gondolkodás"
      >
      {(hasAnswer || streaming) && (
        <section
          className="turn-progress-answer"
          data-quote-selectable="true"
          data-quote-anchor={answerAnchorId}
          aria-label={traceView === "answer" ? "Válasz" : "Lépések és gondolkodás"}
        >
          <div className="trace-answer-layout">
            <div className="trace-answer-main">
              <div className="turn-progress-answer-heading">
                <div
                  className="trace-view-switch"
                  role="tablist"
                  aria-label="Panel nézete"
                >
                  <button
                    type="button"
                    role="tab"
                    className={`trace-view-option${traceView === "answer" ? " is-active" : ""}`}
                    aria-selected={traceView === "answer"}
                    // Amíg nincs válasz, a fül üres panelre vinne. Ott marad,
                    // hogy a váltó ne ugráljon, de nem kattintható.
                    disabled={!hasAnswer}
                    title={hasAnswer ? undefined : "A válasz még készül"}
                    onClick={() => selectTraceView("answer")}
                  >
                    VÁLASZ
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`trace-view-option${traceView === "steps" ? " is-active" : ""}`}
                    aria-selected={traceView === "steps"}
                    onClick={() => selectTraceView("steps")}
                  >
                    LÉPÉSEK
                  </button>
                </div>
                {stageBadge(answer?.pipeline)}
                {(streaming || !runPosition) && (
                  <span>{streaming ? "készül" : "kész"}</span>
                )}
                {overallElapsed && <time>{overallElapsed}</time>}
                {answerActions}
              </div>
              {traceView === "answer" && <div className="turn-progress-answer-body">
                <div className="trace-answer-line">
                  {hasAnswer &&
                    // A quote backlink is matched against the whole answer, so
                    // a quote spanning a paragraph break would lose its link if
                    // the text were split. Paragraphs when there is nothing to
                    // lose; one block when there is.
                    //
                    // The wrapper is load-bearing: this row is a flex line so
                    // the spinner can sit beside the text, and loose paragraphs
                    // became flex items — one narrow column per paragraph,
                    // which is exactly as unreadable as it sounds.
                    (answerQuoteRefs.length === 0 ? (
                      <div className="trace-answer-text">
                        {answerParagraphs(
                          textWithoutCodeBlocks(answer?.text ?? ""),
                        )}
                      </div>
                    ) : (
                    <p>
                      {answerWithQuoteBacklinks(
                        textWithoutCodeBlocks(answer?.text ?? ""),
                        answerQuoteRefs,
                        onQuoteJump ?? (() => undefined),
                      )}
                    </p>
                  ))}
                  {streaming && (
                    <span className="trace-answer-spinner" aria-label="Válasz készül" />
                  )}
                </div>
                {onQuoteJump && answerQuoteRefs.length > 0 &&
                  answerQuoteRefs.some(
                    (quote) =>
                      !answer?.text.includes(quote.text) &&
                      !(quote.instruction && answer?.text.includes(quote.instruction)),
                  ) &&
                  quoteBacklinkButtons(
                    answerQuoteRefs.filter(
                      (quote) =>
                        !answer?.text.includes(quote.text) &&
                        !(quote.instruction && answer?.text.includes(quote.instruction)),
                    ),
                    onQuoteJump,
                  )}
              </div>}
            </div>
            <ChangeSummaryPanel
              files={changeSummary}
              onRollback={onRollbackChanges}
              rollbackBusy={rollbackBusy}
              onPreviewImage={onPreviewImage}
            />
          </div>
        </section>
      )}

      {traceView === "steps" && !streaming &&
        plannedSteps.length === 0 &&
        activities.length === 0 &&
        commentary.every((entry) => !entry.body.trim()) ? (
        // A stage that only wrote text has no steps to show. An empty
        // two-pane frame with a fake spinning step reads as a stage that
        // failed to report; the honest state is one sentence.
        <div className="trace-content is-expanded">
          <p className="trace-empty-note">
            Ez a szakasz nem használt eszközt és nem rögzített lépést — a
            teljes kimenete a VÁLASZ fülön olvasható.
          </p>
        </div>
      ) : traceView === "steps" && <div
        className="trace-content is-expanded"
        aria-hidden={false}
      >
          <section className="trace-steps-panel" aria-label="Lépések listája">
            <div className="trace-panel-heading">
              <strong>LÉPÉSEK</strong>
              <span>{completedStepCount}/{steps.length} kész</span>
            </div>
            <div
              className="trace-step-list"
              data-quote-selectable="true"
              role="list"
            >
              {steps.map((step) => {
                const disabled =
                  streaming &&
                  step.status === "pending" &&
                  step.id !== activeStep.id;
                const elapsed = stepElapsedFor(step);
                return (
                  <div
                    className="trace-step-target"
                    key={step.id}
                    data-quote-anchor={quoteAnchor(`step:${step.id}`)}
                  >
                    <button
                      type="button"
                      role="listitem"
                      className={`trace-step-row trace-step-row-${displayStatus(step)}${selectedStep.id === step.id ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
                      onClick={() => selectStep(step.id)}
                      disabled={disabled}
                      aria-pressed={selectedStep.id === step.id}
                    >
                      <span className="trace-step-marker" aria-hidden="true">
                        {stepIndicator(step)}
                      </span>
                      <span className="trace-step-name">{step.step}</span>
                      {elapsed && <span className="trace-step-elapsed">{elapsed}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
            {overallElapsed && (
              <div className="trace-total-elapsed" aria-label="Teljes gondolkodási idő">
                <span>Összesen</span>
                <time>{overallElapsed}</time>
              </div>
            )}
          </section>
          <section
            className="trace-thinking-panel"
            data-quote-selectable="true"
            data-quote-anchor={quoteAnchor(`thinking:${selectedStep.id}`)}
            aria-label="Gondolkodás menete"
          >
            <div className="trace-panel-heading trace-panel-heading-thinking">
              <strong>GONDOLKODÁS MENETE</strong>
              <div className="trace-panel-actions">
                <button
                  type="button"
                  className="trace-panel-action"
                  aria-pressed={essentialTraceOnly}
                  onClick={() => setEssentialTraceOnly((current) => !current)}
                >
                  {essentialTraceOnly ? "Minden részlet" : "Csak lényeges"}
                </button>
              </div>
            </div>
            {visibleThinkingEntries.length > 0 ? (
              <ul className="trace-thinking-list" ref={thinkingListRef}>
                {visibleThinkingEntries.map((entry) => (
                  <li
                    className={`trace-thinking-item${entry.kind === "internal" ? " is-internal" : ""}`}
                    key={entry.id}
                  >
                    {entry.kind === "internal" ? (
                      <>
                        <button
                          type="button"
                          className="trace-internal-line"
                          onClick={() =>
                            setExpandedInternalEntryId((current) =>
                              current === entry.id ? null : entry.id,
                            )
                          }
                          aria-expanded={expandedInternalEntryId === entry.id}
                          title="A teljes belső gondolkodás megjelenítése"
                        >
                          <span className="trace-thinking-bullet">•</span>
                          <span className="trace-internal-preview">
                            <InlineMarkdown text={entry.body} />
                          </span>
                          <span className="trace-internal-caret" aria-hidden="true">
                            {expandedInternalEntryId === entry.id ? "▾" : "▸"}
                          </span>
                        </button>
                        {entry.codeActivity && (
                          <button
                            type="button"
                            className="trace-code-button"
                            onClick={() => openInlineDiff(entry.codeActivity!)}
                            aria-label="Kóddiff megnyitása"
                            title="Kóddiff megnyitása"
                          >
                            &lt;/&gt;
                          </button>
                        )}
                        {expandedInternalEntryId === entry.id &&
                          entry.internalHistory &&
                          entry.internalHistory.length > 0 && (
                            <div
                              className="trace-internal-history-body"
                              data-quote-selectable="true"
                            >
                              {entry.internalHistory.map((line, index) => (
                                <div key={`${entry.id}-history-${index}`}>{line}</div>
                              ))}
                            </div>
                          )}
                      </>
                    ) : (
                      <>
                        <span className="trace-thinking-bullet">•</span>
                        <p><InlineMarkdown text={entry.body} /></p>
                        {entry.codeActivity && (
                          <button
                            type="button"
                            className="trace-code-button"
                            onClick={() => openInlineDiff(entry.codeActivity!)}
                            aria-label="Kóddiff megnyitása"
                            title="Kóddiff megnyitása"
                          >
                            &lt;/&gt;
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="trace-thinking-empty">
                {!streaming && (
                  <span className="trace-thinking-empty-text">
                    {essentialTraceOnly
                      ? "A részletes belső naplósorok el vannak rejtve."
                      : "Ehhez a lépéshez nem érkezett külön gondolkodási napló."}
                  </span>
                )}
              </div>
            )}
          </section>
        </div>}


      {inlineDiff && (
        <div
          className="inline-code-diff-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Kódváltozás összehasonlítása"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setInlineDiff(null);
          }}
        >
          <section className="inline-code-diff-card">
            <div className="inline-code-diff-header">
              <div>
                <span className="approval-eyebrow">KÓDÖSSZEHASONLÍTÁS</span>
                <h2>{inlineDiff.path}</h2>
              </div>
              <button
                type="button"
                className="inline-code-diff-close"
                onClick={() => setInlineDiff(null)}
                aria-label="Kóddiff bezárása"
              >
                ×
              </button>
            </div>
            <div className="inline-code-diff-meta">
              <span>{inlineDiff.language}</span>
              <span>előtte / utána</span>
            </div>
            <div className="inline-code-diff-panes">
              {(["before", "after"] as const).map((side) => (
                <section className={`inline-code-diff-pane ${side}`} key={side}>
                  <header>{side === "before" ? "BEFORE" : "AFTER"}</header>
                  <pre>
                    {inlineDiff.rows.map((row, index) => {
                      const line = row[side];
                      return (
                        <span
                          className={`inline-code-diff-line ${line.kind}`}
                          key={`${side}-${index}`}
                        >
                          <b>{line.number ?? ""}</b>
                          <code>{line.text || " "}</code>
                        </span>
                      );
                    })}
                  </pre>
                </section>
              ))}
            </div>
          </section>
        </div>
      )}
      {runFooter}
      </article>
    </>
  );
}

function LiveResponseCard({ message }: { message?: Message }) {
  const text = message?.text ?? "";
  const visibleText = textWithoutCodeBlocks(text);
  const hasCode = extractCodeBlocks(text).length > 0;
  return (
    <article
      className="live-response-card"
      aria-label="Folyamatban lévő válasz"
    >
      <div className="live-response-header">
        <span className="code-work-dot is-live" />
        <strong>Részeredmény</strong>
        <span>nem végleges</span>
      </div>
      <div className="live-response-body" data-quote-selectable="true">
        {visibleText && <p><InlineMarkdown text={visibleText} /></p>}
        {hasCode && (
          <div className="live-response-code-hint">
            Kódrészlet érkezik · megnyitható a munkafolyamatban
          </div>
        )}
        {!visibleText && !hasCode && (
          <div className="live-response-placeholder">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span>A válasz első összefoglalója készül…</span>
          </div>
        )}
      </div>
    </article>
  );
}

type RetentionAction =
  | "sync_v2_retention_ack"
  | "sync_v2_retention_backup"
  | "sync_v2_retention_purge";

type RetentionSettingsSectionProps = {
  preview: SyncRetentionPreview | null;
  selection: string[];
  onRefresh: () => void;
  onAction: (command: RetentionAction, successMessage: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onPurgeSelected: () => void;
  onToggleSelection: (selectionKey: string) => void;
};

function RetentionSettingsSection({
  preview,
  selection,
  onRefresh,
  onAction,
  onSelectAll,
  onClearSelection,
  onPurgeSelected,
  onToggleSelection,
}: RetentionSettingsSectionProps) {
  return (
    <section
      className="settings-retention"
      aria-label="Haladó szinkron és retention"
    >
      <div className="settings-retention-heading">
        <div>
          <strong>Haladó szinkron</strong>
          <small>Retention / purge</small>
        </div>
        <button
          type="button"
          className="settings-retention-refresh"
          onClick={onRefresh}
        >
          ↻ Ellenőrzés
        </button>
      </div>
      {!preview ? (
        <p className="settings-retention-hint">
          Az archivált projektek és beszélgetések karbantartása csak többgépes
          szinkron használatakor szükséges.
        </p>
      ) : (
        <>
          <div className="retention-dock-status">
            {preview.protocolReady
              ? "ACK + backup gate kész · snapshot + purge indítható"
              : preview.purgeAllowed
                ? "Purge engedélyezve"
                : "Purge tiltva: gate vár"}
          </div>
          <div className="retention-audit-meta">
            <span>
              Journal: <code>{preview.currentEventCount} event</code>
            </span>
            <span>
              Digest: <code>{preview.currentJournalDigest.slice(0, 12)}…</code>
            </span>
            <span>
              Snapshot:{" "}
              <code>
                {preview.compactionSnapshotId
                  ? `${preview.compactionSnapshotId.slice(0, 12)}…`
                  : "nincs"}
              </code>
            </span>
          </div>
          <div
            className="retention-dock-digest"
            title={preview.currentJournalDigest}
          >
            Journal digest:{" "}
            <code>{preview.currentJournalDigest.slice(0, 16)}…</code>
          </div>
          <div className="retention-dock-actions">
            <button
              type="button"
              onClick={() =>
                onAction(
                  "sync_v2_retention_ack",
                  "Retention ACK elküldve a többi gép számára.",
                )
              }
              disabled={!preview.health.canWrite}
            >
              Saját ACK
            </button>
            <button
              type="button"
              onClick={() =>
                onAction(
                  "sync_v2_retention_backup",
                  "Lokális retention backup és ACK elkészült.",
                )
              }
              disabled={!preview.health.canWrite}
            >
              Backup + ACK
            </button>
            {preview.purgeAllowed && (
              <button
                type="button"
                onClick={() =>
                  onAction(
                    "sync_v2_retention_purge",
                    "Compaction snapshot elkészült, a retention purge lefutott.",
                  )
                }
                disabled={!preview.health.canWrite}
              >
                Snapshot + purge
              </button>
            )}
          </div>
          <div className="retention-audit-heading">
            <strong>Archivált elemek</strong>
            <span>
              {selection.length} / {preview.eligibleCount} kijelölve
            </span>
          </div>
          <div className="retention-audit-actions">
            <button
              type="button"
              onClick={onSelectAll}
              disabled={!preview.purgeAllowed || preview.eligibleCount === 0}
            >
              Összes jelölt
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              disabled={selection.length === 0}
            >
              Kijelölés törlése
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={onPurgeSelected}
              disabled={!preview.purgeAllowed || selection.length === 0}
            >
              Kijelöltek purge
            </button>
          </div>
          <div className="retention-audit-list">
            {preview.candidates.map((candidate) => (
              <label
                className={`retention-audit-item${candidate.eligible ? "" : " is-ineligible"}`}
                key={candidate.selectionKey}
              >
                <input
                  type="checkbox"
                  checked={selection.includes(candidate.selectionKey)}
                  disabled={!candidate.eligible || !preview.purgeAllowed}
                  onChange={() => onToggleSelection(candidate.selectionKey)}
                />
                <span className="retention-audit-copy">
                  <strong title={candidate.entityId}>
                    {syncTombstoneTypeLabel(candidate.entityType)} ·{" "}
                    {candidate.label}
                  </strong>
                  <small>
                    {candidate.ageDays === null
                      ? "ismeretlen kor"
                      : `${candidate.ageDays} napos`}{" "}
                    · archiválva: {formatSyncHealthTime(candidate.archivedAt)}
                  </small>
                </span>
                <em>
                  {candidate.eligible ? "purge-jelölt" : candidate.reason}
                </em>
              </label>
            ))}
          </div>
          {preview.candidates.length === 0 && (
            <div className="retention-audit-empty">
              Nincs archivált retention-jelölt.
            </div>
          )}
          <div className="retention-dock-devices">
            {preview.devices.map((device) => (
              <div className="retention-dock-device" key={device.deviceId}>
                <span title={device.deviceId}>
                  {device.deviceId.slice(0, 8)}…
                </span>
                <span>{device.ready ? "ACK rendben" : "ACK hiányzik"}</span>
                <span>
                  {device.backupVerified ? "backup rendben" : "nincs backup"}
                </span>
              </div>
            ))}
          </div>
          {preview.audit.length > 0 && (
            <div className="retention-audit-log">
              <strong>Legutóbbi auditműveletek</strong>
              <ul>
                {preview.audit
                  .slice()
                  .reverse()
                  .slice(0, 8)
                  .map((entry) => (
                    <li key={entry.auditId}>
                      <span>
                        {entry.action} · {entry.outcome} ·{" "}
                        {entry.deviceId.slice(0, 8)}…
                      </span>
                      <small>
                        {formatSyncHealthTime(entry.createdAt)}
                        {entry.details ? ` · ${entry.details}` : ""}
                      </small>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {preview.blockingReasons.length > 0 && (
            <ul className="settings-retention-blockers">
              {preview.blockingReasons.map((reason, index) => (
                <li key={`${reason}-${index}`}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CompactWorkFlowCard({
  expanded,
  activities,
  snippets,
  streaming,
  onToggle,
}: CodeWorkCardProps) {
  const [selectedItem, setSelectedItem] = useState<{
    type: "activity" | "snippet";
    id: string;
  } | null>(null);
  const visibleActivities = [...activities]
    .sort((a, b) => a.id - b.id)
    .slice(-32);
  const flowActivities = visibleActivities;
  const selectedActivity =
    selectedItem?.type === "activity"
      ? flowActivities.find(
          (activity) =>
            `activity-${activity.itemId ?? activity.id}` === selectedItem.id,
        )
      : undefined;
  const selectedSnippet =
    selectedItem?.type === "snippet"
      ? snippets.find((snippet) => `snippet-${snippet.id}` === selectedItem.id)
      : undefined;
  const iconFor = (activity: CodeActivity) =>
    activity.status === "error"
      ? "!"
      : activity.kind === "command"
        ? "›_"
        : activity.kind === "file"
          ? "□"
          : activity.kind === "tool"
            ? "◇"
            : activity.kind === "reasoning"
              ? "◌"
              : "•";
  const label = "Munkafolyamat";

  return (
    <article
      className={`code-work-card work-log-card compact-work-flow${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}
    >
      <button
        type="button"
        className="code-work-header"
        onClick={() => {
          setSelectedItem(null);
          onToggle();
        }}
        aria-expanded={expanded}
      >
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        {flowActivities.length > 0 && (
          <span className="code-work-count">{flowActivities.length} lépés</span>
        )}
      </button>
      {expanded && (
        <div
          className="work-flow-panel"
          data-quote-selectable="true"
          role="region"
          aria-label="Munkafolyamat részletei"
          aria-live={streaming ? "polite" : undefined}
        >
          <div
            className="work-flow-track"
            role="list"
            aria-label="Munkafolyamat lépései"
          >
            {flowActivities.map((activity, index) => {
              const id = `activity-${activity.itemId ?? activity.id}`;
              const canInspect =
                activity.status === "error" ||
                !["status"].includes(activity.kind);
              return (
                <div className="work-flow-step" role="listitem" key={id}>
                  {canInspect ? (
                    <button
                      type="button"
                      className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}${selectedItem?.id === id ? " is-selected" : ""}`}
                      onClick={() =>
                        setSelectedItem((current) =>
                          current?.id === id ? null : { type: "activity", id },
                        )
                      }
                      title={`${activity.label}: ${activity.detail || workStatusLabels[activity.status]}`}
                      aria-label={activity.label}
                      aria-pressed={selectedItem?.id === id}
                    >
                      {iconFor(activity)}
                    </button>
                  ) : (
                    <span
                      className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}`}
                      title={activity.label}
                      aria-label={activity.label}
                      aria-disabled="true"
                    >
                      •
                    </span>
                  )}
                  {index < flowActivities.length - 1 && (
                    <div className="work-flow-connector">
                      <span className="work-flow-arrow" aria-hidden="true">
                        →
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {visibleActivities.length === 0 && (
              <span className="work-flow-placeholder">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" /> Codex dolgozik…
              </span>
            )}
          </div>
          {snippets.length > 0 && (
            <div className="work-flow-code-links" aria-label="Kódrészletek">
              {snippets.map((snippet) => {
                const id = `snippet-${snippet.id}`;
                return (
                  <button
                    type="button"
                    className={`work-flow-code-link${selectedItem?.id === id ? " is-selected" : ""}`}
                    key={id}
                    onClick={() =>
                      setSelectedItem((current) =>
                        current?.id === id ? null : { type: "snippet", id },
                      )
                    }
                    aria-pressed={selectedItem?.id === id}
                  >
                    <span>⌘</span>
                    {snippet.language}
                  </button>
                );
              })}
            </div>
          )}
          {selectedActivity || selectedSnippet ? (
            <div className="work-flow-detail">
              <div className="work-flow-detail-header">
                <span className="work-flow-detail-icon">
                  {selectedActivity ? iconFor(selectedActivity) : "⌘"}
                </span>
                <strong>
                  {selectedActivity?.label ??
                    `Kódrészlet · ${selectedSnippet?.language ?? "text"}`}
                </strong>
                <button
                  type="button"
                  className="work-flow-detail-close"
                  onClick={() => setSelectedItem(null)}
                  aria-label="Részlet bezárása"
                >
                  ×
                </button>
              </div>
              {selectedActivity?.detail && (
                <code className="work-flow-detail-path">
                  {selectedActivity.detail}
                </code>
              )}
              {selectedActivity?.body && (
                <pre className="work-flow-detail-output">
                  {selectedActivity.body}
                </pre>
              )}
              {selectedActivity?.code && (
                <>
                  <small className="code-work-language">
                    {selectedActivity.language ?? "diff"}
                  </small>
                  <pre className="work-flow-detail-code">
                    <code>{highlightCode(selectedActivity.code)}</code>
                  </pre>
                </>
              )}
              {selectedSnippet && (
                <pre className="work-flow-detail-code">
                  <code>{highlightCode(selectedSnippet.code)}</code>
                </pre>
              )}
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function App() {
  // In Tauri the SQLite/v2 journal is canonical. Hydrating the old browser
  // project list first makes deleted projects reappear whenever startup sync
  // is delayed or quarantined. Keep that browser fallback for the non-Tauri
  // preview only.
  const [projects, setProjects] = useState<Project[]>(
    isTauri ? [] : loadStoredProjects,
  );
  const [activeMode, setActiveMode] = useState<AppMode>(() => {
    const stored = localStorage.getItem(ACTIVE_MODE_STORAGE_KEY);
    return stored === "coding" || stored === "general"
      ? stored
      : DEFAULT_APP_MODE;
  });
  const [activeGeneralConversationId, setActiveGeneralConversationId] =
    useState<string | null>(
      () => localStorage.getItem(ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY),
    );
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProject, setActiveProject] = useState(
    () => localStorage.getItem("min-active-project") ?? "",
  );
  const [activeThread, setActiveThread] = useState(
    () =>
      localStorage.getItem("min-active-thread") ??
      (isTauri ? "" : "Új beszélgetés"),
  );
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [treeSortMode, setTreeSortMode] = useState<TreeSortMode>(() =>
    localStorage.getItem(TREE_SORT_MODE_STORAGE_KEY) === "time"
      ? "time"
      : "modified",
  );
  const [treeSortMenuOpen, setTreeSortMenuOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(
    () => {
      if (isTauri) return [];
      if (activeMode === "general") {
        const id = localStorage.getItem(
          ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY,
        );
        return id
          ? loadStoredGeneralConversations()[generalConversationCacheKey(id)]
              ?.messages ?? []
          : [];
      }
      return loadInitialMessages();
    },
  );
  const [composerQuotes, setComposerQuotes] = useState<QuoteReference[]>([]);
  const [showDetailedTrace, setShowDetailedTrace] = useState(false);
  // The detailed tick opens a second choice: keep today's single-agent trace,
  // or run the prompt as a chain of roles. Off by default, because a chain
  // costs three times the wall clock and three times the reading.
  const [pipelineMode, setPipelineMode] = useState(false);
  const [pipelineRecipes, setPipelineRecipes] = useState<PipelineRecipe[]>([]);
  const [pipelineRecipeId, setPipelineRecipeId] = useState("plan_code_review");
  // Which phase of a running chain the reader is looking at. Null follows the
  // one that is actually running, which is what a progress display should do.
  const [liveStageChoice, setLiveStageChoice] = useState<number | null>(null);

  // Per-stage model and reasoning, keyed by `${recipeId}:${stageIndex}`. Empty
  // means "keep what the preset recommends", so the picker never has to
  // pre-fill values the user did not choose.
  const [pipelineStageOverrides, setPipelineStageOverrides] = useState<
    Record<string, { model?: string; effort?: string; provider?: string }>
  >({});
  const stageOverrideKey = (index: number) =>
    `${activePipelineRecipe?.id ?? ""}:${index}`;
  const stageValue = (index: number, field: "model" | "effort") => {
    const stage = activePipelineRecipe?.stages[index];
    const override = pipelineStageOverrides[stageOverrideKey(index)];
    // A vendor switch invalidates the model that belonged to the old one.
    if (field === "effort") return override?.effort ?? stage?.effort ?? "";
    const vendor = stageProvider(index) === "anthropic" ? "anthropic" : "codex";
    const allowed = PIPELINE_MODELS[vendor];
    const switched = override?.provider && override.provider !== stage?.provider;
    const candidate = switched
      ? override?.model
      : (override?.model ?? stage?.model);
    // Show what will actually run: a preset naming a model outside the list
    // would otherwise display something the click cycle can never return to.
    return candidate && allowed.includes(candidate) ? candidate : allowed[0];
  };
  const stageProvider = (index: number) =>
    pipelineStageOverrides[stageOverrideKey(index)]?.provider ??
    activePipelineRecipe?.stages[index]?.provider ??
    "anthropic";
  /** The values a stage may cycle through, in a stable order. */
  const stageChoices = (index: number, field: "model" | "effort") => {
    const stage = activePipelineRecipe?.stages[index];
    if (!stage) return [] as string[];
    if (field === "effort") return FALLBACK_EFFORTS;
    return PIPELINE_MODELS[
      stageProvider(index) === "anthropic" ? "anthropic" : "codex"
    ];
  };
  /** Stepping instead of a dropdown: the chain stays two lines tall. */
  const cycleStageValue = (
    index: number,
    field: "model" | "effort" | "vendor",
    direction: 1 | -1,
  ) => {
    if (field === "vendor") {
      const next = stageProvider(index) === "anthropic" ? "codex" : "anthropic";
      setPipelineStageOverrides((state) => ({
        ...state,
        [stageOverrideKey(index)]: {
          ...state[stageOverrideKey(index)],
          provider: next,
          // The old vendor's model cannot run on the new one.
          model: undefined,
        },
      }));
      return;
    }
    const choices = stageChoices(index, field);
    if (choices.length === 0) return;
    const current = stageValue(index, field);
    const at = choices.indexOf(current);
    const next =
      choices[(at + direction + choices.length) % choices.length] ?? choices[0];
    setPipelineStageOverrides((state) => ({
      ...state,
      [stageOverrideKey(index)]: {
        ...state[stageOverrideKey(index)],
        [field]: next,
      },
    }));
  };
  const activePipelineRecipe =
    pipelineRecipes.find((recipe) => recipe.id === pipelineRecipeId) ??
    pipelineRecipes[0];
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>(
    [],
  );
  const [imagesPreparing, setImagesPreparing] = useState(false);
  const [readingDefaults] = useState(() => {
    if (
      localStorage.getItem("min-reading-settings-version") !==
      READING_SETTINGS_VERSION
    ) {
      localStorage.setItem(
        "min-reading-settings-version",
        READING_SETTINGS_VERSION,
      );
      return { fontSize: "10px", lineHeight: "1.00" };
    }
    return {
      fontSize: localStorage.getItem("min-font-size") ?? "10px",
      lineHeight: localStorage.getItem("min-line-height") ?? "1.00",
    };
  });
  const [fontSize, setFontSize] = useState(readingDefaults.fontSize);
  const [lineHeight, setLineHeight] = useState(readingDefaults.lineHeight);
  const [threadIds, setThreadIds] =
    useState<Record<string, string>>(loadLocalThreadIds);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);
  // The Claude runtime used to have a settings panel of its own: an API-key
  // field, a model and effort dropdown, and a connection test. It was the
  // scaffolding of the API-key era. Auth is the Claude Code subscription now,
  // and the model and effort are picked where every other model is picked, so
  // the panel only offered a second, competing answer to the same question.
  const [claudeBudgetUsd, setClaudeBudgetUsd] = useState(
    () => localStorage.getItem("min-claude-budget-usd") ?? DEFAULT_CLAUDE_BUDGET_USD,
  );
  const [claudeMaxTurns, setClaudeMaxTurns] = useState(
    () => localStorage.getItem("min-claude-max-turns") ?? DEFAULT_CLAUDE_MAX_TURNS,
  );
  const [claudeSessionIds, setClaudeSessionIds] = useState<Record<string, string>>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("min-claude-sessions") ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [pendingClaudeApproval, setPendingClaudeApproval] =
    useState<ClaudeApprovalRequest | null>(null);
  const [pendingClaudeQuestion, setPendingClaudeQuestion] =
    useState<ClaudeQuestionRequest | null>(null);
  const [claudeQuestionDraft, setClaudeQuestionDraft] = useState("");
  const [claudeQuestionSelections, setClaudeQuestionSelections] = useState<string[]>([]);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelCatalog, setModelCatalog] =
    useState<CodexModel[]>([...fallbackModels, ...claudeCodingModels]);
  const [modelsLoading, setModelsLoading] = useState(isTauri);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    if (
      localStorage.getItem("min-model-version") !== MODEL_PREFERENCE_VERSION
    ) {
      localStorage.setItem("min-model-version", MODEL_PREFERENCE_VERSION);
      return DEFAULT_MODEL;
    }
    const stored = localStorage.getItem("min-model");
    // Sonnet is no longer one of the two Claude models the app offers. Falling
    // through to the catalog check would have answered a Claude selection with
    // a GPT one, so the vendor is kept and the model moved to its neighbour.
    if (stored === "claude-sonnet-5") return "claude-opus-5";
    return stored ?? DEFAULT_MODEL;
  });
  const [selectedEffort, setSelectedEffort] = useState(() => {
    if (
      localStorage.getItem("min-effort-version") !== EFFORT_PREFERENCE_VERSION
    ) {
      localStorage.setItem("min-effort-version", EFFORT_PREFERENCE_VERSION);
      return DEFAULT_EFFORT;
    }
    return localStorage.getItem("min-effort") ?? DEFAULT_EFFORT;
  });
  // A chain is one panel showing one phase at a time. Three stacked answers
  // filled the screen and buried the verdict; the tabs keep a run the same
  // size no matter how much the models wrote.
  const [selectedStages, setSelectedStages] = useState<Record<string, number>>({});
  // Which iteration of a chain the panel is showing, keyed by chain. Absent
  // means the newest, so a fresh re-run opens on itself without being told.
  const [selectedVersions, setSelectedVersions] = useState<
    Record<string, number>
  >({});
  const [expandedWorkLogs, setExpandedWorkLogs] = useState<
    Record<string, boolean>
  >({});
  // Keep an explicit user choice separate from the rendered group key. A
  // late sync/merge may replace a raw turn id with its canonical session key;
  // the choice must survive that identity transition (and scrollbar-driven
  // rerenders) instead of falling back to the default-open state.
  const expandedWorkLogChoicesRef = useRef<Record<string, boolean>>({});
  const [codeActivity, setCodeActivity] = useState<CodeActivity[]>([]);
  // A *nézet* alapállapota: futás nélkül ez látszik. Futás közben a futás
  // sajátja írja felül — így egy másik beszélgetés köre nem üzen ide.
  const [viewCodeStatus, setViewCodeStatus] = useState("készen");
  const [activePlan, setActivePlan] = useState<PlanSnapshot>({
    turnId: null,
    explanation: "",
    steps: [],
  });
  const [planHistory, setPlanHistory] = useState<Record<string, PlanSnapshot>>(
    {},
  );
  const [commentaryEntries, setCommentaryEntries] = useState<CommentaryEntry[]>(
    [],
  );
  const [viewTransportStatus, setViewTransportStatus] =
    useState<CodexTransportStatus | null>(null);
  const [agentConversationStatus, setAgentConversationStatus] =
    useState<AgentConversationStatus | null>(null);
  const [agentStatusRevision, setAgentStatusRevision] = useState(0);
  const [viewWatchdogMessage, setViewWatchdogMessage] = useState("");
  // Melyik projekten fut épp automatikus apply. Projektenként, mert két
  // projekt egymástól függetlenül alkalmazhat.
  const [agentApplyProjects, setAgentApplyProjects] = useState<string[]>([]);
  const [agentRollbackBusy, setAgentRollbackBusy] = useState(false);
  // A generated diagram is only useful if it can be looked at; the data URL is
  // fetched on demand so a large image never sits in state unopened.
  const [imagePreview, setImagePreview] = useState<{
    path: string;
    source: string | null;
    error: string | null;
  } | null>(null);
  // The snapshot whose changes are currently on disk and can still be undone.
  //
  // Beszélgetésenként: egy háttérben befejeződött coding kör visszavonása a
  // *saját* projektjének fájljait állítaná vissza — ha a képernyőn közben egy
  // másik beszélgetés áll, a felkínált „visszavonás" ott idegen fájlokra
  // mutatna. Ezért nem egy globális érték, hanem gazdánként egy.
  const [undoableSnapshots, setUndoableSnapshots] = useState<
    Record<string, { snapshotId: string }>
  >({});
  // A „fut-e valami" nem külön igazság többé, hanem a futás-tábla mérete. Ez a
  // számláló csak arra kell, hogy a tábla változása rendert kérjen: a Map ref,
  // és a React magától nem venné észre.
  const [runsRevision, setRunsRevision] = useState(0);
  // A lánc szakasz-jelzője. Egy projektben egy lánc futhat, és a panel a
  // nézett beszélgetéshez tartozik — ezért ez globális állapot maradhat.
  const [pipelineProgress, setPipelineProgress] =
    useState<PipelineProgressEvent | null>(null);
  const pipelineProgressRef = useRef<PipelineProgressEvent | null>(null);
  pipelineProgressRef.current = pipelineProgress;
  // Újrafuttatás közben: a `startStage` előtti szakaszok ebben a körben nem
  // futnak, enélkül a sáv úgy rajzolná őket, mintha még sorra kerülnének.
  const [liveRunResume, setLiveRunResume] = useState<{
    chainKey: string;
    startStage: number;
    iteration: number;
    carried: Record<number, string>;
  } | null>(null);
  // Mely beszélgetésekben vár egy Enter a futás végére. Beszélgetésenként,
  // különben az A-ban sorba tett üzenet a B futásának végén indulna el.
  const [queuedSendConversations, setQueuedSendConversations] = useState<
    string[]
  >([]);
  const [viewIsCancelling, setViewIsCancelling] = useState(false);
  // The model turn can be complete while the native command is still
  // finalizing the workspace snapshot. Keep the request locked during that
  // short phase, but remove the stop affordance so a late click cannot cancel
  // an answer that has already arrived.
  const [turnCompletedRequestId, setTurnCompletedRequestId] = useState<
    string | null
  >(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toast, setToast] = useState("");
  const [fileActionMenu, setFileActionMenu] =
    useState<FileActionMenuState | null>(null);
  const [selectionQuote, setSelectionQuote] = useState<SelectionQuote | null>(
    null,
  );
  const [appDialog, setAppDialog] = useState<AppDialog | null>(null);
  const [syncReady, setSyncReady] = useState(!isTauri);
  const [syncWriteEnabled, setSyncWriteEnabled] = useState(!isTauri);
  const [syncStatus, setSyncStatus] = useState(
    isTauri ? "szinkronizálás" : "helyi",
  );
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [syncHealthOpen, setSyncHealthOpen] = useState(false);
  const [retentionPreview, setRetentionPreview] =
    useState<SyncRetentionPreview | null>(null);
  const [retentionSelection, setRetentionSelection] = useState<string[]>([]);
  const [localStoreStatus, setLocalStoreStatus] = useState(
    isTauri ? "ellenőrzés" : "böngésző",
  );
  const [localStoreReady, setLocalStoreReady] = useState(!isTauri);
  const [localStoreWriteEnabled, setLocalStoreWriteEnabled] =
    useState(!isTauri);
  const [localConversationCache, setLocalConversationCache] = useState<
    Record<string, SyncConversation>
  >(isTauri ? {} : loadStoredGeneralConversations);
  const [tombstones, setTombstones] = useState<SyncTombstone[]>([]);
  const [restoreBusyKey, setRestoreBusyKey] = useState<string | null>(null);
  const [localMutationRevision, setLocalMutationRevision] = useState(0);
  const projectMutationRevisionRef = useRef(0);
  const pendingLocalMutationRef = useRef(false);
  const pendingRestoreSelectionRef = useRef<SyncTombstone | null>(null);
  const snapshotWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const markLocalMutation = () => {
    projectMutationRevisionRef.current += 1;
    pendingLocalMutationRef.current = true;
    setLocalMutationRevision((current) => current + 1);
    // Pull must not merge a stale remote snapshot between the user's local
    // mutation and its debounced SQLite/journal write.
    if (isTauri && localStoreReady) setSyncReady(false);
  };
  const markProjectMutation = markLocalMutation;
  const historyHydrating =
    isTauri && projects.length === 0 && (!localStoreReady || !syncReady);

  const activeProjectData = useMemo(
    () =>
      projects.find((project) => project.name === activeProject) ??
      projects[0] ?? {
        id: "",
        name: "Projekt",
        path: workspaceRoot,
        relativePath: relativeOneDrivePath(workspaceRoot),
        threads: [],
      },
    [activeProject, projects, workspaceRoot],
  );
  const generalConversations = useMemo(
    () =>
      Object.entries(localConversationCache)
        .filter(
          ([key, conversation]) =>
            conversation.scope === "general" ||
            isGeneralConversationCacheKey(key),
        )
        .map(([key, conversation]) => ({ key, conversation }))
        .filter(({ conversation }) => Boolean(conversation.id))
        .sort((left, right) =>
          compareTreeItems(
            treeConversationTimestamp(left.conversation, treeSortMode),
            treeConversationTimestamp(right.conversation, treeSortMode),
            left.conversation.title,
            right.conversation.title,
          ),
        ),
    [localConversationCache, treeSortMode],
  );
  const sortedProjects = useMemo(
    () =>
      projects
        .map((project) => ({
          ...project,
          threads: [...project.threads].sort((left, right) =>
            compareTreeItems(
              treeConversationTimestamp(
                localConversationCache[`${project.path}/${left}`],
                treeSortMode,
              ),
              treeConversationTimestamp(
                localConversationCache[`${project.path}/${right}`],
                treeSortMode,
              ),
              left,
              right,
            ),
          ),
        }))
        .sort((left, right) =>
          compareTreeItems(
            treeProjectTimestamp(left, localConversationCache, treeSortMode),
            treeProjectTimestamp(right, localConversationCache, treeSortMode),
            left.name,
            right.name,
          ),
        ),
    [localConversationCache, projects, treeSortMode],
  );
  useEffect(() => {
    localStorage.setItem(TREE_SORT_MODE_STORAGE_KEY, treeSortMode);
  }, [treeSortMode]);
  const activeGeneralConversation = activeGeneralConversationId
    ? localConversationCache[
        generalConversationCacheKey(activeGeneralConversationId)
      ]
    : undefined;
  const activeGeneralConversationKey = activeGeneralConversationId
    ? generalConversationCacheKey(activeGeneralConversationId)
    : "general::new";
  const activeProjectPath = activeMode === "general"
    ? ""
    : activeProjectData?.path ?? workspaceRoot;
  const threadKey =
    activeMode === "general"
      ? activeGeneralConversationKey
      : `${activeProjectPath}/${activeThread}`;
  // Írásmód-toleráns: a store kanonizált `\\?\C:\…` alakot ír, a cache sima
  // `C:\…`-t, és az exact lookup ilyenkor csendben „nincs ilyen beszélgetés"-t
  // mondott — a hívó pedig gazdátlanul folytatta.
  const activeConversationId =
    conversationIdForKey(
      conversationKeyIndex(localConversationCache),
      threadKey,
    ) ?? null;

  // A képernyőn álló beszélgetés visszavonható pillanatképe. Váltásnál nem
  // kell törölni semmit: a másiké megmarad a sajátjánál.
  const undoableSnapshot = activeConversationId
    ? undoableSnapshots[activeConversationId] ?? null
    : null;

  const rememberUndoableSnapshot = (
    conversationId: string | null | undefined,
    snapshot: { snapshotId: string } | null,
  ) => {
    const id = conversationId?.trim();
    if (!id) return;
    setUndoableSnapshots((current) => {
      if (!snapshot) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: snapshot };
    });
  };

  useEffect(() => {
    if (!isTauri || !localStoreReady || !activeConversationId) {
      setAgentConversationStatus(null);
      return;
    }
    let active = true;
    void invoke<AgentConversationStatus | null>("agent_conversation_status", {
      conversationId: activeConversationId,
    })
      .then((status) => {
        if (active) setAgentConversationStatus(status);
      })
      .catch(() => {
        if (active) setAgentConversationStatus(null);
      });
    return () => {
      active = false;
    };
  }, [activeConversationId, agentStatusRevision, isTauri, localStoreReady]);

  useEffect(() => {
    const updateSelectionQuote = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setSelectionQuote(null);
        return;
      }
      const text = selection.toString().replace(/\u00a0/g, " ").trim();
      if (!text || text.length > 12_000) {
        setSelectionQuote(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const container =
        range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement;
      if (!container?.closest("[data-quote-selectable=\"true\"]")) {
        setSelectionQuote(null);
        return;
      }
      const quoteAnchor = container.closest<HTMLElement>("[data-quote-anchor]");
      const anchorId = quoteAnchor?.dataset.quoteAnchor;
      if (!anchorId) {
        setSelectionQuote(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      setSelectionQuote((current) =>
        current?.text === text &&
        current.anchorId === anchorId &&
        Math.abs(current.x - rect.right) < 1 &&
        Math.abs(current.y - Math.max(8, rect.top - 8)) < 1
          ? current
          : {
              text,
              anchorId,
              x: Math.min(window.innerWidth - 42, Math.max(8, rect.right + 8)),
              y: Math.min(window.innerHeight - 42, Math.max(8, rect.top - 8)),
            },
      );
    };
    document.addEventListener("selectionchange", updateSelectionQuote);
    return () =>
      document.removeEventListener("selectionchange", updateSelectionQuote);
  }, []);

  const messageKeyRef = useRef(threadKey);
  const workLogKeyRef = useRef<string | null>(null);
  const projectsRef = useRef(projects);
  const activeModeRef = useRef(activeMode);
  const activeProjectRef = useRef(activeProject);
  const activeThreadRef = useRef(activeThread);
  const activeGeneralConversationIdRef = useRef(activeGeneralConversationId);
  const messagesRef = useRef(messages);
  const codeActivityRef = useRef(codeActivity);
  const planHistoryRef = useRef(planHistory);
  const commentaryEntriesRef = useRef(commentaryEntries);
  const threadIdsRef = useRef(threadIds);
  const localConversationCacheRef = useRef(localConversationCache);
  projectsRef.current = projects;
  activeProjectRef.current = activeProject;
  activeThreadRef.current = activeThread;
  messagesRef.current = messages;
  codeActivityRef.current = codeActivity;
  planHistoryRef.current = planHistory;
  commentaryEntriesRef.current = commentaryEntries;
  threadIdsRef.current = threadIds;
  localConversationCacheRef.current = localConversationCache;
  // These two refs are navigation authorities. Keep them under the explicit
  // mode/conversation handlers so an asynchronous hydration render cannot
  // overwrite a selection that the user has just made.
  const updateActiveGeneralConversationId = (conversationId: string | null) => {
    activeGeneralConversationIdRef.current = conversationId;
    setActiveGeneralConversationId(conversationId);
  };
  const timelineSequenceRef = useRef(Date.now());
  const activePlanRef = useRef(activePlan);
  // A *nézet* terv-órája: történeti terv rendezésekor (navigáláskor) nincs
  // futás, amitől az eltelt időt kérdezhetnénk. A futásé a handle-ben van.
  const viewTurnTimingRef = useRef<PlanStepTiming>({});
  const planKeyRef = useRef<string | null>(null);
  const commentaryKeyRef = useRef<string | null>(null);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const regenerationTargetRef = useRef<{
    source: Message;
    answer: Message;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const quoteInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Keep fast quote typing out of the root render path. The conversation can
  // contain thousands of nodes, so updating React state on every keystroke
  // made the WebView renderer stall and appear gray.
  const quoteInstructionDraftsRef = useRef<Record<string, string>>({});
  const inputDraftRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  // A küldés előkészítése (képmentés, fájlkontextus) még a futás létrejötte
  // előtt van, de már beszélgetéshez tartozik: egy másik beszélgetésben
  // indított kör nem várhat rá.
  const submitBusyConversationsRef = useRef<Set<string>>(new Set());
  const markSubmitBusy = (conversationId: string | null, busy: boolean) => {
    const key = conversationId ?? "";
    if (busy) submitBusyConversationsRef.current.add(key);
    else submitBusyConversationsRef.current.delete(key);
  };
  // A válasz szövege előbb kész van, mint a futás: a munkaterület mentése
  // (teljes snapshot + másolás) OneDrive-on tíz másodperceket is elvihet.
  // Az Enter ezért nem vész el — a küldés megvárja a futás végét.
  const queuedSendRef = useRef<Set<string>>(new Set());
  const composerScopeRef = useRef(threadKey);
  useEffect(() => {
    if (composerScopeRef.current === threadKey) return;
    composerScopeRef.current = threadKey;
    inputDraftRef.current = "";
    if (inputRef.current) inputRef.current.value = "";
    setPendingImages([]);
    quoteInstructionDraftsRef.current = {};
    setComposerQuotes([]);
    setShowDetailedTrace(false);
  }, [threadKey]);
  const resizeComposerTextarea = (textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    const maxHeight = Math.min(
      260,
      Math.max(150, Math.round(window.innerHeight * 0.32)),
    );
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(43, nextHeight)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };
  useEffect(() => {
    resizeComposerTextarea(inputRef.current);
    Object.values(quoteInputRefs.current).forEach(resizeComposerTextarea);
  }, [composerQuotes, pendingImages, threadKey]);
  const shouldStickToBottom = useRef(true);
  const autoScrollFrameRef = useRef<number | null>(null);
  const completionSoundRequestsRef = useRef<Set<string>>(new Set());
  const syncActionBusyRef = useRef(false);
  const activeProjectPathRef = useRef(activeProjectPath);

  activeProjectPathRef.current = activeProjectPath;
  activePlanRef.current = activePlan;

  // --- Futás-regiszter ---------------------------------------------------
  //
  // Eddig egyetlen futás létezett: „az aktuális kérés", tizenhárom
  // modulszintű refben szétszórva. Innentől a futás egy tárgy, amit a
  // kérés-azonosítója nevez meg, és minden hozzá tartozó állapot benne lakik.
  //
  // A plafon ebben a fázisban még 1: a viselkedésnek bitre azonosnak kell
  // maradnia. A tábla viszont már tábla, tehát a 3. fázisban a plafon egy
  // konstans átírása lesz, nem újabb átszervezés.
  const runsRef = useRef<Map<string, RunHandle>>(new Map());
  const runByConversationRef = useRef<Map<string, string>>(new Map());
  const runByProjectRef = useRef<Map<string, string>>(new Map());

  /** Fut-e bármi. A sync-pull szünete és a munkaterület-zárak kérdezik. */
  const anyRunActive = () => runsRef.current.size > 0;

  /**
   * „Megszakították-e, és ha igen, ezt még nem dolgoztuk fel."
   *
   * Egyszer felel igazat: a lezáró ágak közül az fut le, amelyik előbb ér oda,
   * és a többinek már nem szabad ugyanazt a megszakítást másodszor kezelnie.
   */
  const consumeRunCancellation = (run: RunHandle | undefined) => {
    if (!run?.cancelled) return false;
    run.cancelled = false;
    return true;
  };

  /** A futás üzenete a felületnek. Gazdátlan írás itt is eldobás. */
  const setRunStatus = (
    run: RunHandle | undefined,
    patch: Partial<
      Pick<RunHandle, "statusLabel" | "transport" | "watchdog" | "cancelling">
    >,
  ) => {
    if (!run) return;
    Object.assign(run, patch);
    setRunsRevision((revision) => revision + 1);
  };

  const beginRun = (run: RunHandle) => {
    runsRef.current.set(run.requestId, run);
    runByConversationRef.current.set(run.ownerConversationId, run.requestId);
    if (run.projectPathKey)
      runByProjectRef.current.set(run.projectPathKey, run.requestId);
    setRunsRevision((revision) => revision + 1);
    return run;
  };

  const endRun = (requestId: string) => {
    const run = runsRef.current.get(requestId);
    if (!run) return;
    run.status = "done";
    // A gazdátlanítás a tábla törlése, nem egy ref nullázása: a késői
    // eseményei innentől nem találnak haza, tehát eldobódnak.
    runsRef.current.delete(requestId);
    if (runByConversationRef.current.get(run.ownerConversationId) === requestId)
      runByConversationRef.current.delete(run.ownerConversationId);
    if (
      run.projectPathKey &&
      runByProjectRef.current.get(run.projectPathKey) === requestId
    )
      runByProjectRef.current.delete(run.projectPathKey);
    setRunsRevision((revision) => revision + 1);
  };

  const runForRequest = (requestId: string | null | undefined) =>
    (requestId ? runsRef.current.get(requestId) : undefined) ?? undefined;

  const runForConversation = (conversationId: string | null | undefined) => {
    if (!conversationId) return undefined;
    const requestId = runByConversationRef.current.get(conversationId);
    return requestId ? runsRef.current.get(requestId) : undefined;
  };

  const runForProject = (projectPath: string | null | undefined) => {
    if (!projectPath) return undefined;
    const requestId = runByProjectRef.current.get(
      normalizeConversationKey(projectPath),
    );
    return requestId ? runsRef.current.get(requestId) : undefined;
  };

  /**
   * Melyik futáshoz tartozik ez az esemény.
   *
   * A kérés-azonosító az elsődleges út, de a wire-en `Option<String>`: van,
   * hogy nem érkezik. Ilyenkor a futás thread-azonosítója fog — a lánc
   * szakaszai pedig a saját halmazukon keresztül. Ha egyik sem talál, az
   * esemény **eldobódik**; a „biztos az aktuálisé" tartalék pont az a
   * feltevés, amitől a válaszok idegen beszélgetésbe kerültek.
   */
  const runForEvent = (event: {
    requestId?: string | null;
    threadId?: string | null;
  }) => {
    const direct = runForRequest(event.requestId);
    if (direct) return direct;
    if (event.requestId) {
      for (const run of runsRef.current.values()) {
        if (run.chainRequestIds.has(event.requestId)) return run;
      }
      return undefined;
    }
    const threadId = event.threadId?.trim();
    if (threadId) {
      for (const run of runsRef.current.values()) {
        if (run.threadId === threadId) return run;
      }
    }
    // Amíg a plafon 1, az azonosító nélküli esemény az egyetlen futásé — a
    // régi kód is így vette. Ez a 3. fázisban tűnik el: több futás mellett
    // „az egyetlen" nem létezik, és a találgatás pont a szivárgás.
    if (runsRef.current.size === 1)
      return runsRef.current.values().next().value as RunHandle;
    return undefined;
  };

  const commitMessages = (
    next: Message[] | ((current: Message[]) => Message[]),
  ) => {
    if (typeof next !== "function") {
      messagesRef.current = next;
      setMessages(next);
      return;
    }
    setMessages((current) => {
      const resolved = next(current);
      messagesRef.current = resolved;
      return resolved;
    });
  };

  // --- Beszélgetés-ID-vel címzett írás ----------------------------------
  //
  // A nézet-állapot (`messages`, `codeActivity`, …) nem egy beszélgetés adata,
  // hanem „ami épp a képernyőn van". Amíg a futás is ebbe írt, váltás közben
  // idegen beszélgetésbe került a válasz — és a mentőhurok lemezre égette.
  // Innentől minden futás-eredetű írás megnevezi a tulajdonos beszélgetést:
  // a nézet csak akkor mozdul, ha ő a címzett, gazdátlan írás pedig eldobódik.
  const conversationKeyIndexRef = useRef<Record<string, string>>({});
  const conversationKeyByIdRef = useRef<Record<string, string>>({});
  conversationKeyIndexRef.current = conversationKeyIndex(localConversationCache);
  conversationKeyByIdRef.current = Object.entries(
    conversationKeyIndexRef.current,
  ).reduce<Record<string, string>>((index, [key, id]) => {
    // Egy ID több kulcson is szerepelhet (kanonizált path, átnevezés). A
    // pontosan renderelt kulcs a nyerő, hogy a nézet és a tár egy sort lásson.
    if (!index[id] || key === messageKeyRef.current) index[id] = key;
    return index;
  }, {});

  // A futás tulajdonosa. A `finally` nem nullázza vissza „mindenkire": a
  // gazdátlan írás eldobás, nem broadcast.
  const activeConversationIdRef = useRef<string | null>(null);
  const viewedRunRef = useRef<RunHandle | undefined>(undefined);

  /**
   * Melyik beszélgetés sorai vannak most a nézet-állapotban. Nem a render-beli
   * `threadKey`, hanem a `messageKeyRef`: azt a navigációs kezelők szinkron
   * állítják, tehát ez az egyetlen óra, ami nem tart szét a váltás ablakában.
   */
  const viewedConversationId = () =>
    conversationIdForKey(conversationKeyIndexRef.current, messageKeyRef.current);

  const ownedConversationKey = (conversationId: string) =>
    conversationKeyByIdRef.current[conversationId.trim()] ?? null;


  /**
   * Egy háttérben futó beszélgetés slice-ának írása. A tár a cache — nincs
   * második igazság —, csak épp ID-vel címezve keressük ki benne a sort.
   */
  const writeBackgroundConversation = (
    ownerId: string,
    update: (current: SyncConversation) => SyncConversation,
  ) => {
    const key = ownedConversationKey(ownerId);
    // Ismeretlen gazda: nincs hova írni. A régi kód ilyenkor az aktuális
    // nézetbe könyvelt — pontosan ez volt a szivárgás.
    if (!key) return;
    // A módosítás egyszer fut le, a ref alapján, és utána már csak egy kész
    // objektum kerül a state-be: a stream-deltát megismételni annyi lenne,
    // mint kétszer leírni ugyanazt a mondatot.
    const previous = localConversationCacheRef.current;
    if (!previous[key]) return;
    const next = writeConversation(previous, key, (conversation) => {
      const updated = update(conversation as SyncConversation);
      return updated === conversation
        ? conversation
        : { ...updated, updatedAt: new Date().toISOString() };
    });
    if (next === previous) return;
    localConversationCacheRef.current = next;
    setLocalConversationCache((current) => ({ ...current, [key]: next[key] }));
    markLocalMutation();
  };

  const writeOwnedMessages = (
    ownerId: string | null | undefined,
    update: (current: Message[]) => Message[],
  ) => {
    const target = writeTarget(ownerId, viewedConversationId());
    if (target === "drop") return;
    if (target === "store-and-view") {
      commitMessages(update);
      return;
    }
    writeBackgroundConversation(ownerId!.trim(), (conversation) => ({
      ...conversation,
      messages: update(conversation.messages ?? []),
    }));
  };

  const writeOwnedWorkItems = (
    ownerId: string | null | undefined,
    update: (current: CodeActivity[]) => CodeActivity[],
  ) => {
    const target = writeTarget(ownerId, viewedConversationId());
    if (target === "drop") return;
    if (target === "store-and-view") {
      setCodeActivity(update);
      return;
    }
    writeBackgroundConversation(ownerId!.trim(), (conversation) => ({
      ...conversation,
      workItems: update(conversation.workItems ?? []),
    }));
  };

  const writeOwnedCommentary = (
    ownerId: string | null | undefined,
    update: (current: CommentaryEntry[]) => CommentaryEntry[],
  ) => {
    const target = writeTarget(ownerId, viewedConversationId());
    if (target === "drop") return;
    if (target === "store-and-view") {
      setCommentaryEntries(update);
      return;
    }
    writeBackgroundConversation(ownerId!.trim(), (conversation) => ({
      ...conversation,
      commentary: update(conversation.commentary ?? []),
    }));
  };

  /**
   * A futás saját sorai — akkor is, ha közben másik beszélgetést nézünk. A
   * korábbi kód ilyenkor a nézet-állapotot olvasta vissza, és a másik
   * beszélgetés sorai közt kereste a saját válaszát.
   */
  const ownedMessages = (ownerId: string | null | undefined): Message[] => {
    const target = writeTarget(ownerId, viewedConversationId());
    if (target === "drop") return [];
    if (target === "store-and-view") return messagesRef.current;
    const key = ownedConversationKey(ownerId!.trim());
    if (!key) return [];
    return (
      readConversation(localConversationCacheRef.current, key)?.messages ?? []
    );
  };

  // --- A válasz gördülékeny kiírása ------------------------------------
  //
  // A modell nem betűnként küld, hanem szavankénti-mondatonkénti darabokban,
  // és minden darab egy teljes React-rendert kért a teljes beszélgetésre.
  // Ettől a szöveg rángatva jelent meg: néhány szó, szünet, néhány szó.
  //
  // A beérkező szöveg a futás saját pufferébe megy, és képkockánként adagoljuk
  // ki belőle — a hátralék arányában, tehát ha felgyűlik, gyorsabban ürül, és
  // sosem marad le. Egy képkocka = egy render, akárhány darab érkezett közben.
  const commitAnswerDelta = (run: RunHandle, delta: string) => {
    const meta = run.answerStream.meta;
    if (!delta || !meta) return;
    // Élő buborék nélküli futás (lánc-újrafuttatás): a szakasz szövegét a
    // runner adja vissza kész sorként. Cél nélkül ez jelöletlen, második
    // másolatot írna a beszélgetésbe.
    if (!run.liveMessageId) return;
    writeOwnedMessages(run.ownerConversationId, (current) =>
      appendCodexDelta(current, { ...meta, delta }, run.liveMessageId),
    );
  };

  const drainAnswerStream = (run: RunHandle) => {
    const stream = run.answerStream;
    stream.frame = null;
    if (!stream.pending) return;
    // Nem fix sebesség: a hátralék arányos része megy ki képkockánként. Egy
    // hosszabb darab így gyorsabban fut be, a vége felé pedig lelassul —
    // olvasásra ez érzik folyamatosnak.
    const size = Math.max(2, Math.ceil(stream.pending.length / 4));
    const chunk = stream.pending.slice(0, size);
    stream.pending = stream.pending.slice(size);
    commitAnswerDelta(run, chunk);
    if (stream.pending)
      stream.frame = window.requestAnimationFrame(() => drainAnswerStream(run));
  };

  /** Az egész hátralék egyszerre — ha nincs mit néznie senkinek. */
  const flushAnswerStream = (run: RunHandle) => {
    const stream = run.answerStream;
    if (stream.frame !== null) {
      window.cancelAnimationFrame(stream.frame);
      stream.frame = null;
    }
    const pending = stream.pending;
    stream.pending = "";
    if (pending) commitAnswerDelta(run, pending);
  };

  /**
   * A kör lezárása: a hátralék kimegy, a puffer elengedi a kört. Előbb a
   * kiírás, csak utána az elengedés — a lezáró ágak egy része a *streamelt*
   * szövegre esik vissza, ha a szolgáltató nem küld teljes választ.
   */
  const settleAnswerStream = (run: RunHandle | undefined) => {
    if (!run) return;
    flushAnswerStream(run);
    run.answerStream.meta = null;
  };

  const enqueueAnswerDelta = (
    run: RunHandle,
    delta: string,
    meta: Omit<CodexDelta, "delta">,
  ) => {
    const stream = run.answerStream;
    stream.meta = meta;
    stream.pending += delta;
    // Gördülékenységre csak akkor van szükség, ha látszik: háttérben futó
    // beszélgetésnél vagy elrejtett ablaknál az adagolás csak fölösleges
    // rendereket csinálna, ott a teljes darab megy egyben.
    if (
      document.hidden ||
      writeTarget(run.ownerConversationId, viewedConversationId()) !==
        "store-and-view"
    ) {
      flushAnswerStream(run);
      return;
    }
    if (stream.frame === null)
      stream.frame = window.requestAnimationFrame(() => drainAnswerStream(run));
  };

  /**
   * A futó válasz *ebben* a beszélgetésben látszik-e. A futás egy
   * beszélgetésé: a másikban nem pörög a jelző, nem nyílik ki a LÉPÉSEK
   * panel, és nem ugrik a görgető sem. A küldés viszont mindenhol zárolt
   * marad, mert egyszerre egy futás van.
   */
  // A fa sorai a *táblából* olvasnak, nem egy globális jelzőből: több futás
  // esetén több sor pöröghet egyszerre, és mindegyik a magáét mutatja.
  // A `runsRevision` maga a render-jel — a Map nem state.
  void runsRevision;
  const runForConversationKey = (key: string) => {
    for (const run of runsRef.current.values()) {
      if (conversationKeysMatch(run.ownerConversationKey, key)) return run;
    }
    return undefined;
  };
  // A válasz szövege hamarabb kész, mint a futás: utána még a munkaterület
  // mentése megy. Attól már nem „gondolkodik" — ne is úgy nézzen ki.
  const conversationRunState = (key: string) => {
    const run = runForConversationKey(key);
    if (!run) return null;
    return run.turnCompleted ? ("saving" as const) : ("thinking" as const);
  };
  const conversationIsThinking = (key: string) =>
    conversationRunState(key) !== null;
  const projectIsThinking = (project: Project) =>
    project.threads.some((thread) =>
      conversationIsThinking(`${project.path}/${thread}`),
    );

  /** A képernyőn álló beszélgetés futása, ha van neki. */
  const viewedRun = runForConversation(activeConversationId);
  // Amit a felület mutat: a nézett futás üzenete, ha van futás; különben a
  // nézet saját alapállapota. Egy másik beszélgetés köre nem üzenhet ide.
  const codeStatus = viewedRun?.statusLabel ?? viewCodeStatus;
  const transportStatus = viewedRun?.transport ?? viewTransportStatus;
  const watchdogMessage = viewedRun?.watchdog ?? viewWatchdogMessage;
  const isCancelling = viewedRun?.cancelling ?? viewIsCancelling;
  // A dokumentumra kötött kattintásfigyelő a renderen kívül fut, ezért a
  // nézett beszélgetés azonosítóját ref-ben is látnia kell.
  activeConversationIdRef.current = activeConversationId;
  viewedRunRef.current = viewedRun;
  const viewingActiveRun = Boolean(viewedRun);

  const maxKnownTimelineSequence = [
    Date.now(),
    ...messages.map((message) => message.sequence ?? 0),
    ...messages.map((message) => timelinePhysicalMillis(message.hlc)),
    ...codeActivity.map((activity) => activity.id),
    ...codeActivity.map((activity) => timelinePhysicalMillis(activity.hlc)),
  ]
    .filter(Number.isFinite)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  timelineSequenceRef.current = Math.max(
    timelineSequenceRef.current,
    maxKnownTimelineSequence + 1,
  );

  const messagesForThread = (key: string) =>
    localConversationCacheRef.current[key]?.messages ?? loadThreadMessages(key);
  const workItemsForThread = (key: string) =>
    localConversationCacheRef.current[key]?.workItems ??
    loadThreadWorkItems(key);

  const nextTimelineSequence = () => {
    const sequence = timelineSequenceRef.current;
    timelineSequenceRef.current += 1;
    return sequence;
  };

  const playCompletionSoundOnce = (
    requestOrTurnId: string,
    run?: RunHandle,
  ) => {
    // A chain is one answer as far as the room is concerned. Chiming after
    // every stage turned a single question into three announcements.
    const progress = pipelineProgressRef.current;
    if (progress && progress.stageIndex + 1 < progress.stageCount) return;
    const played = completionSoundRequestsRef.current;
    if (played.has(requestOrTurnId)) return;
    played.add(requestOrTurnId);
    if (played.size > 64) {
      const oldest = played.values().next().value;
      if (oldest) played.delete(oldest);
    }
    // Let React commit the final answer text before starting the audible cue.
    window.setTimeout(
      () => playAppSound("complete", COMPLETION_SOUND_REPETITIONS),
      0,
    );
  };

  const normalizePlanCommit = (next: PlanSnapshot, run?: RunHandle) => {
    // Az eltelt idő órája a futásé. Amíg nincs futás (történeti terv
    // rendezése navigáláskor), a régi, közös óra marad — az a nézeté.
    const timing = run?.turnTiming ?? viewTurnTimingRef.current;
    const startedAt = next.startedAt ?? timing.startedAt;
    const completedAt = next.completedAt ?? timing.completedAt;
    if (startedAt !== undefined) timing.startedAt = startedAt;
    if (completedAt !== undefined) timing.completedAt = completedAt;
    return { ...next, startedAt, completedAt };
  };

  const planSnapshotKey = (snapshot: PlanSnapshot, run?: RunHandle) =>
    snapshot.turnId ?? run?.turnId ?? viewedRunRef.current?.turnId ?? "current";

  const updatePlanState = (next: PlanSnapshot) => {
    const normalizedNext = normalizePlanCommit(next);
    // Event notifications can arrive back-to-back before React commits the
    // previous state update. Keep the imperative snapshot in sync as well so
    // the next plan/activity event builds on the newest step list instead of
    // resurrecting the synthetic pre-plan row.
    activePlanRef.current = normalizedNext;
    setActivePlan(normalizedNext);
    setPlanHistory((current) => ({
      ...current,
      [planSnapshotKey(normalizedNext)]: normalizedNext,
    }));
  };

  /**
   * A futás terve a futásé. Amíg a tulajdonos beszélgetés van a képernyőn, ez
   * a nézet terve is; ha nem, a terv a saját beszélgetése tárába megy, és a
   * képernyőn látható LÉPÉSEK panel meg sem mozdul.
   */
  const updateOwnedPlanState = (
    ownerId: string | null | undefined,
    next: PlanSnapshot,
  ) => {
    const target = writeTarget(ownerId, viewedConversationId());
    if (target === "drop") return;
    const owned = runForConversation(ownerId);
    if (target === "store-and-view") {
      const normalizedNext = normalizePlanCommit(next, owned);
      if (owned) {
        owned.plan = normalizedNext;
          }
      activePlanRef.current = normalizedNext;
      setActivePlan(normalizedNext);
      setPlanHistory((current) => ({
        ...current,
        [planSnapshotKey(normalizedNext)]: normalizedNext,
      }));
      return;
    }
    const normalizedNext = normalizePlanCommit(next, owned);
    if (owned) {
      owned.plan = normalizedNext;
      }
    writeBackgroundConversation(ownerId!.trim(), (conversation) => ({
      ...conversation,
      planHistory: {
        ...(conversation.planHistory ?? {}),
        [planSnapshotKey(normalizedNext)]: normalizedNext,
      },
    }));
  };

  const planWithStartedStep = (
    current: PlanSnapshot,
    stepId: string,
    now: number,
  ) => {
    const existing = current.stepTimes?.[stepId];
    const activeStep = current.steps.find(
      (step) => step.status === "inProgress" && step.id !== stepId,
    );
    const stepTimes = { ...(current.stepTimes ?? {}) };
    if (activeStep) {
      const activeTiming = stepTimes[activeStep.id];
      if (activeTiming?.startedAt !== undefined) {
        stepTimes[activeStep.id] = {
          ...activeTiming,
          completedAt: activeTiming.completedAt ?? now,
        };
      }
    }
    if (
      stepId !== "client-pre-plan" &&
      stepTimes["client-pre-plan"]?.startedAt !== undefined
    ) {
      const preparationTiming = stepTimes["client-pre-plan"];
      stepTimes["client-pre-plan"] = {
        ...preparationTiming,
        completedAt: preparationTiming.completedAt ?? now,
      };
    }
    const nextSteps = current.steps.map((step) => {
      if (activeStep && step.id === activeStep.id)
        return { ...step, status: "completed" as const };
      if (step.id === stepId && step.status === "pending")
        return { ...step, status: "inProgress" as const };
      return step;
    });
    if (existing?.startedAt !== undefined && !activeStep) {
      // The activity is another event from the same step. Do not rewrite its
      // original start time or create a new React plan snapshot.
      return null;
    }
    stepTimes[stepId] = {
      ...existing,
      startedAt: existing?.startedAt ?? now,
      completedAt: existing?.completedAt,
    };
    return {
      ...current,
      steps: nextSteps,
      startedAt: current.startedAt ?? now,
      stepTimes,
    };
  };

  const markOwnedPlanStepStarted = (
    ownerId: string | null | undefined,
    stepId: string | undefined,
    now = Date.now(),
  ) => {
    if (!stepId) return;
    const plan = runForConversation(ownerId)?.plan ?? activePlanRef.current;
    const next = planWithStartedStep(plan, stepId, now);
    if (next) updateOwnedPlanState(ownerId, next);
  };

  const markPlanStepStarted = (stepId: string | undefined, now = Date.now()) => {
    if (!stepId) return;
    const next = planWithStartedStep(activePlanRef.current, stepId, now);
    if (next) updatePlanState(next);
  };

  const refreshSync = () => {
    if (!isTauri || !workspaceRoot || !localStoreReady) return;
    if (syncActionBusyRef.current) return;
    if (anyRunActive()) {
      setToast("Aktív stream közben a sync pull szünetel.");
      return;
    }
    setSyncStatus("frissítés…");
    setSyncHealthOpen(false);
    setSyncReady(false);
  };

  const rebuildSyncFromLocal = () => {
    if (
      !isTauri ||
      !workspaceRoot ||
      !localStoreReady ||
      syncActionBusyRef.current
    )
      return;
    if (anyRunActive()) {
      setToast("Aktív stream közben a sync journal nem építhető újra.");
      return;
    }
    if (
      !window.confirm(
        "A jelenlegi lokális SQLite snapshotból új, hiteles compaction snapshot készül a OneDrive v2 journalhoz. " +
          "A meglévő event fájlok megmaradnak, de a helyi régi cursorok újra lesznek indexelve. " +
          "Másik gépet előbb állíts le vagy frissíts ugyanígy. Folytatod?",
      )
    )
      return;
    syncActionBusyRef.current = true;
    setSyncStatus("journal újraépítése…");
    void invoke<SyncV2Result>("sync_v2_rebuild_from_local")
      .then((result) => {
        setSyncHealth(result.health);
        setTombstones(result.snapshot.tombstones ?? []);
        setSyncWriteEnabled(result.canWrite);
        setSyncStatus(
          result.canWrite
            ? "journal újraépítve · frissítés…"
            : "journal · helyreállítás blokkolva",
        );
        notify(
          result.canWrite
            ? "A sync journal lokális snapshotból újraépült"
            : "A sync journal helyreállítása blokkolva",
        );
        syncActionBusyRef.current = false;
        // Force one normal pull after the command, even if a poll happened
        // while the explicit recovery action was running.
        setSyncReady(true);
        window.setTimeout(() => setSyncReady(false), 0);
      })
      .catch((error) => {
        syncActionBusyRef.current = false;
        setSyncStatus("karantén · helyreállítási hiba");
        markSyncHealthError(
          `A v2 journal lokális helyreállítása nem sikerült: ${String(error)}`,
        );
        setSyncReady(true);
        console.warn("OneDrive v2 local journal rebuild failed", error);
      });
  };

  // Changes are applied to the workspace automatically, so the only way back
  // is an explicit undo. The snapshot that produced the current on-disk state
  // is kept here so the change summary can offer it.
  const rollbackAgentChanges = async () => {
    const snapshot = undoableSnapshot;
    if (!isTauri || !snapshot || agentRollbackBusy) return;
    setAgentRollbackBusy(true);
    try {
      await invoke<AgentRollbackResult>("agent_rollback_snapshot", {
        snapshotId: snapshot.snapshotId,
      });
      rememberUndoableSnapshot(activeConversationId, null);
      setViewCodeStatus("változások visszavonva");
      notify("A turn fájlváltozásai visszaálltak a turn előtti állapotra");
    } catch (error) {
      // The guard refuses to roll back when the files changed after the turn,
      // which is the correct outcome — say so instead of failing silently.
      notify(`A visszavonás nem lehetséges: ${String(error)}`, "notify");
    } finally {
      setAgentRollbackBusy(false);
    }
  };

  /**
   * Returns the conversation and the workspace to an earlier prompt.
   *
   * The dialog states what will be lost in counts rather than in adjectives:
   * this deletes history on both machines, and a vague warning is not consent.
   */
  const revertToMessage = async (message: Message) => {
    if (!isTauri || !activeConversationId || !message.id) return;
    if (anyRunActive()) {
      notify("Előbb állítsd le a futó kérést.");
      return;
    }
    let preview: RevertPreview;
    try {
      preview = await invoke<RevertPreview>("conversation_revert_preview", {
        conversationId: activeConversationId,
        messageId: message.id,
      });
    } catch (error) {
      notify(`A visszaállítás nem készíthető elő: ${String(error)}`, "notify");
      return;
    }
    if (preview.removedMessages === 0) {
      notify("Ez az utolsó kérdés; nincs mit visszaállítani.");
      return;
    }
    const files = preview.filesUnavailable
      ? "A fájlok nem állíthatók vissza: ez a szakasz még a snapshotok rögzítése előtt futott."
      : preview.snapshotId
        ? "A projekt fájljai visszaállnak arra az állapotra, amilyenek a kérdés elküldésekor voltak."
        : "Ehhez a ponthoz nem tartozik fájlváltozás.";
    setAppDialog({
      kind: "confirm",
      title: "Visszaállítás erre a kérdésre",
      message: [
        `${preview.removedMessages} üzenet és ${preview.removedTurns} futás törlődik.`,
        files,
        "A törlés a másik gépedre is átterjed. A visszaállítás előtti állapotról mentés készül, tehát a művelet visszavonható.",
      ].join("\n\n"),
      confirmLabel: "Visszaállítás",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const result = await invoke<{
              removedMessages: number;
              restoredFiles: number;
              undoSnapshotId: string | null;
              sessionId: string | null;
            }>("conversation_revert_to", {
              conversationId: activeConversationId,
              messageId: message.id,
              cwd: activeMode === "general" ? null : activeProjectData.path,
            });
            // The prompt itself survives, so put it in the composer: the point
            // of going back is usually to ask it differently.
            inputDraftRef.current = preview.prompt;
            if (inputRef.current) {
              inputRef.current.value = preview.prompt;
              resizeComposerTextarea(inputRef.current);
            }
            rememberUndoableSnapshot(
              activeConversationId,
              result.undoSnapshotId
                ? { snapshotId: result.undoSnapshotId }
                : null,
            );
            setClaudeSessionIds((current) => ({
              ...current,
              [threadKey]: result.sessionId ?? "",
            }));
            // Truncated in place rather than re-hydrated: the store is already
            // the truth, and a full reload would rebuild every conversation to
            // shorten one.
            const cutoff = message.sequence ?? 0;
            commitMessages((current) =>
              current.filter((row) => (row.sequence ?? 0) <= cutoff),
            );
            setCodeActivity((current) =>
              current.filter((item) => item.id <= cutoff),
            );
            setCommentaryEntries((current) =>
              current.filter((entry) => (entry.sequence ?? 0) <= cutoff),
            );
            markLocalMutation();
            notify(
              `Visszaállítva: ${result.removedMessages} üzenet törölve, ${result.restoredFiles} fájl visszaállítva.`,
              "notify",
            );
          } catch (error) {
            notify(`A visszaállítás nem sikerült: ${String(error)}`, "notify");
          }
        })();
      },
    });
  };

  const openImagePreview = (path: string) => {
    setImagePreview({ path, source: null, error: null });
    if (!isTauri) return;
    const load = (attempt: number) => {
      void invoke<string | null>("read_project_image", {
        cwd: activeProjectPathRef.current || activeProjectPath,
        path,
      })
        .then((source) => {
          setImagePreview((current) =>
            current && current.path === path
              ? {
                  ...current,
                  source,
                  error: source ? null : "A fájl nem jeleníthető meg képként.",
                }
              : current,
          );
        })
        .catch((error) => {
          // A turn stages its changes and the workspace is restored to base
          // until the automatic apply lands, so a click right after the answer
          // can arrive while the file briefly does not exist. Retry once.
          const missing = /os error 2|cannot find the file|nem található/i.test(
            String(error),
          );
          if (missing && attempt === 0) {
            window.setTimeout(() => load(1), 1200);
            return;
          }
          setImagePreview((current) =>
            current && current.path === path
              ? { ...current, error: String(error) }
              : current,
          );
        });
    };
    load(0);
  };

  const applyAgentSnapshotAutomatically = async (
    guard: AgentGuardReport,
    projectPath: string | null | undefined,
  ) => {
    if (!isTauri || !guard.applyAvailable) return true;
    const projectKey = projectPath
      ? normalizeConversationKey(projectPath)
      : "";
    setAgentApplyProjects((current) =>
      current.includes(projectKey) ? current : [...current, projectKey],
    );
    try {
      await invoke<AgentApplyResult>("agent_apply_snapshot", {
        snapshotId: guard.snapshotId,
      });
      return true;
    } catch (error) {
      // Applying is automatic, so a failure only warrants a short toast; the
      // undo affordance stays pointed at the last snapshot that did apply.
      setViewCodeStatus("apply hiba");
      notify(
        `A létrehozott fájlok automatikus alkalmazása sikertelen: ${String(error)}`,
        "notify",
      );
      return false;
    } finally {
      setAgentApplyProjects((current) =>
        current.filter((candidate) => candidate !== projectKey),
      );
    }
  };

  /**
   * Applies a finished chain's staged snapshot to the working tree.
   *
   * `pipeline_send` stages the whole chain's edits and restores the tree to
   * its base, exactly like a single turn; this is the chain's version of the
   * apply-after-answer step. Without it the coder's work stays parked in the
   * snapshot directory while the answer claims the files exist. Returns the
   * change summary for the coding stage's card, or [] when nothing changed.
   */
  const settleChainGuard = async (
    guard: AgentGuardReport | null | undefined,
    conversationId: string | null,
    projectPath: string | null,
  ): Promise<ChangeSummaryFile[]> => {
    if (!guard) return [];
    const hasChanges =
      guard.changedFiles.length > 0 ||
      guard.addedFiles.length > 0 ||
      guard.removedFiles.length > 0;
    if (!hasChanges) return [];
    let summary = changeSummaryFromGuard(guard);
    if (isTauri) {
      try {
        const preview = await invoke<AgentDiffPreview>("agent_preview_snapshot", {
          snapshotId: guard.snapshotId,
        });
        const previewSummary = changeSummaryFromDiffFiles(preview.files);
        if (previewSummary.length > 0) summary = previewSummary;
      } catch (error) {
        console.warn("Chain diff preview unavailable", error);
      }
    }
    const applied = await applyAgentSnapshotAutomatically(guard, projectPath);
    rememberUndoableSnapshot(
      conversationId,
      applied || guard.rollbackAvailable
        ? { snapshotId: guard.snapshotId }
        : null,
    );
    return summary;
  };

  const markSyncHealthError = (message: string) => {
    setSyncHealth((current) => {
      const fallback: SyncHealth = {
        status: "quarantine",
        journalPath: workspaceRoot
          ? `${workspaceRoot}\\.min-sync\\v2\\events`
          : "",
        quarantinePath: workspaceRoot
          ? `${workspaceRoot}\\.min-sync\\v2\\quarantine`
          : "",
        checkedAt: String(Date.now()),
        lastImportAt: null,
        scannedEvents: 0,
        acceptedEvents: 0,
        importedEvents: 0,
        storedEvents: 0,
        blockedDevices: [],
        warnings: [],
        canWrite: false,
        recoveryAction:
          "A sync hívás nem fejeződött be. Ellenőrizd a OneDrive elérhetőségét, majd indíts újraellenőrzést.",
      };
      const base = current ?? fallback;
      return {
        ...base,
        status: "quarantine",
        checkedAt: String(Date.now()),
        canWrite: false,
        warnings: [...new Set([...base.warnings, message])].slice(-5),
        recoveryAction: fallback.recoveryAction,
      };
    });
  };

  const applyRetentionResult = (
    result: SyncRetentionPreview,
    status: string,
  ) => {
    setRetentionPreview(result);
    setRetentionSelection((current) =>
      current.filter((key) =>
        result.candidates.some(
          (candidate) => candidate.selectionKey === key && candidate.eligible,
        ),
      ),
    );
    setSyncHealth(result.health);
    setTombstones(result.snapshot.tombstones ?? []);
    setSyncWriteEnabled(result.health.canWrite);
    setSyncReady(false);
    setSyncStatus(status);
  };

  const runRetentionAction = (
    command:
      | "sync_v2_retention_ack"
      | "sync_v2_retention_backup"
      | "sync_v2_retention_purge"
      | "sync_v2_retention_purge_selected",
    successMessage: string,
    payload?: Record<string, unknown>,
  ) => {
    if (!isTauri || !localStoreReady) return;
    if (
      command === "sync_v2_retention_purge" &&
      !window.confirm(
        "Az összes aktuális retention-jelölt compaction snapshotba kerül és törlődik az event-journalból. Folytatod?",
      )
    )
      return;
    setSyncStatus(
      command === "sync_v2_retention_backup"
        ? "retention backup készül…"
        : command.includes("purge")
          ? "retention snapshot + purge…"
          : "retention ACK íródik…",
    );
    void invoke<SyncRetentionPreview>(command, payload)
      .then((result) => {
        applyRetentionResult(
          result,
          result.protocolReady
            ? "retention · gate kész"
            : "retention · gate vár",
        );
        notify(successMessage);
      })
      .catch((error) => {
        setSyncStatus("karantén · retention hiba");
        markSyncHealthError(
          `A retention művelet nem sikerült: ${String(error)}`,
        );
        console.warn("OneDrive v2 retention action failed", error);
      });
  };

  const toggleRetentionSelection = (selectionKey: string) => {
    setRetentionSelection((current) =>
      current.includes(selectionKey)
        ? current.filter((key) => key !== selectionKey)
        : [...current, selectionKey],
    );
  };

  const selectAllEligibleRetention = () => {
    setRetentionSelection(
      retentionPreview?.candidates
        .filter((candidate) => candidate.eligible)
        .map((candidate) => candidate.selectionKey) ?? [],
    );
  };

  const purgeSelectedRetention = () => {
    if (retentionSelection.length === 0) {
      notify("Előbb jelölj ki legalább egy retention elemet.");
      return;
    }
    if (
      !window.confirm(
        `${retentionSelection.length} kijelölt archivált elem kerül compaction snapshotba és törlődik az event-journalból. Folytatod?`,
      )
    ) {
      return;
    }
    runRetentionAction(
      "sync_v2_retention_purge_selected",
      "A kijelölt retention elemek snapshotba kerültek és purge-olva lettek.",
      { entityKeys: retentionSelection },
    );
  };

  const refreshRetention = () => {
    if (!isTauri || !localStoreReady) return;
    setSyncStatus("retention ellenőrzés…");
    void invoke<SyncRetentionPreview>("sync_v2_retention_preview")
      .then((result) => {
        applyRetentionResult(
          result,
          result.protocolReady
            ? "retention · gate kész"
            : "retention · gate vár",
        );
      })
      .catch((error) => {
        setSyncStatus("karantén · retention hiba");
        markSyncHealthError("A retention előnézet nem sikerült.");
        console.warn("OneDrive v2 retention preview failed", error);
      });
  };

  const restoreTombstone = async (tombstone: SyncTombstone) => {
    if (!isTauri || syncActionBusyRef.current) return;
    if (anyRunActive()) {
      setToast("Aktív válasz közben a Recovery restore szünetel.");
      return;
    }
    const busyKey = `${tombstone.entityType}:${tombstone.entityId}`;
    const sameProjectScope = (candidate: SyncTombstone) =>
      candidate.entityType === "project" &&
      (candidate.entityId === tombstone.projectId ||
        Boolean(
          candidate.relativePath &&
            tombstone.relativePath &&
            candidate.relativePath.toLowerCase() ===
              tombstone.relativePath.toLowerCase(),
        ) ||
        Boolean(
          candidate.pathHint &&
            tombstone.pathHint &&
            normalizePath(candidate.pathHint) ===
              normalizePath(tombstone.pathHint),
        ));
    const parentProject =
      tombstone.entityType === "conversation"
        ? tombstones.find(sameProjectScope)
        : undefined;
    const targets = [
      ...new Map(
        [parentProject, tombstone]
          .filter((candidate): candidate is SyncTombstone => Boolean(candidate))
          .map((candidate) => [
            `${candidate.entityType}:${candidate.entityId}`,
            candidate,
          ]),
      ).values(),
    ];

    setRestoreBusyKey(busyKey);
    setSyncStatus("restore dry-run…");
    try {
      const previews: SyncRestorePreview[] = [];
      for (const target of targets) {
        const preview = await invoke<SyncRestorePreview>(
          "sync_v2_preview_restore_entity",
          { tombstone: target },
        );
        previews.push(preview);
        setSyncHealth(preview.health);
        setSyncWriteEnabled(preview.health.canWrite);
        if (!preview.canRestore) {
          setSyncStatus("restore tiltva");
          notify(
            preview.blockingReason ?? "A restore jelenleg nem hajtható végre.",
          );
          return;
        }
      }

      const primaryPreview = previews[previews.length - 1];
      const pathLine = primaryPreview.targetPath
        ? `\nCél: ${primaryPreview.targetPath}`
        : "";
      const parentLine = parentProject
        ? "\nA hozzá tartozó archivált projekt is visszaáll."
        : "";
      const warnings =
        [...new Set(previews.flatMap((preview) => preview.warnings))]
          .map((warning) => `• ${warning}`)
          .join("\n") || "• Nincs.";
      const effects =
        [...new Set(previews.flatMap((preview) => preview.effects))]
          .map((effect) => `• ${effect}`)
          .join("\n") || "• Megjelenik a Tree-ben.";
      const confirmed = window.confirm(
        `Restore előnézet\n\n${primaryPreview.label}${pathLine}${parentLine}\n\nVárható hatás:\n${effects}\n\nFigyelmeztetés:\n${warnings}\n\nVisszaállítod?`,
      );
      if (!confirmed) {
        setSyncStatus("restore megszakítva");
        return;
      }

      syncActionBusyRef.current = true;
      setSyncStatus("restore…");
      let lastResult: SyncV2Result | null = null;
      for (const target of targets) {
        lastResult = await invoke<SyncV2Result>("sync_v2_restore_entity", {
          tombstone: target,
        });
      }
      if (lastResult) {
        setSyncHealth(lastResult.health);
        setSyncWriteEnabled(lastResult.canWrite);
      }
      pendingRestoreSelectionRef.current = tombstone;
      setSyncHealthOpen(false);
      setRetentionPreview(null);
      setSyncStatus("visszaállítás · Tree frissítése");
      setSyncReady(false);
      notify("A visszaállítás rögzítve; a Tree frissül…");
    } catch (error) {
      setSyncStatus("restore hiba");
      markSyncHealthError("A restore dry-run vagy event írása nem sikerült.");
      notify(`A visszaállítás nem sikerült: ${String(error)}`, "notify");
      console.warn("OneDrive v2 restore failed", error);
    } finally {
      syncActionBusyRef.current = false;
      setRestoreBusyKey(null);
    }
  };

  const restoreProjectTombstones = async (
    project: Project,
    restoreConversations = false,
  ) => {
    if (!isTauri) return;
    if (anyRunActive()) {
      setToast("Aktív válasz közben a Recovery restore szünetel.");
      return;
    }
    const shouldRestore = (tombstone: SyncTombstone) =>
      (tombstone.entityType === "project" || restoreConversations) &&
      tombstoneMatchesProjectScope(tombstone, project);

    let candidates = tombstones.filter(shouldRestore);
    if (candidates.length === 0) {
      try {
        const pulled = await invoke<SyncV2Result>("sync_v2_pull");
        setSyncHealth(pulled.health);
        setSyncWriteEnabled(pulled.canWrite);
        candidates = (pulled.snapshot.tombstones ?? []).filter(shouldRestore);
      } catch (error) {
        // This is a best-effort resurrection check. The normal sync poll can
        // retry it later without making a successful project creation fail.
        console.warn("Project tombstone check after creation failed", error);
        return;
      }
    }
    if (candidates.length === 0) return;

    const uniqueCandidates = [
      ...new Map(
        candidates.map((tombstone) => [
          tombstone.entityType === "project"
            ? `project:${(tombstone.relativePath ?? tombstone.pathHint ?? tombstone.entityId).replaceAll("\\", "/").toLowerCase()}`
            : `conversation:${tombstone.entityId}`,
          tombstone,
        ]),
      ).values(),
    ];

    let restoredEvents = 0;
    try {
      for (const tombstone of uniqueCandidates) {
        const result = await invoke<SyncV2Result>("sync_v2_restore_entity", {
          tombstone,
        });
        setSyncHealth(result.health);
        setSyncWriteEnabled(result.canWrite);
        setTombstones(result.snapshot.tombstones ?? []);
        restoredEvents += result.writtenEvents;
      }
      setSyncStatus(restoredEvents > 0 ? "restore · journal" : "visszaállítva");
      setSyncReady(false);
      notify(`Korábbi törlési jelölés feloldva: ${project.name}`);
    } catch (error) {
      setSyncStatus("restore hiba");
      notify(
        `A projekt létrejött, de a korábbi törlési jelölés feloldása nem sikerült: ${String(error)}`,
      );
      console.warn("Project tombstone restore failed", error);
    }
  };

  type HydratedProject = {
    result: SyncV2Result;
    project: Project;
    cache: Record<string, SyncConversation>;
    selectedThread: string;
  };

  const hydrateProjectFromSync = async (
    fallback: Project,
  ): Promise<HydratedProject | null> => {
    let result: SyncV2Result;
    try {
      result = await invoke<SyncV2Result>("sync_v2_pull");
    } catch (error) {
      console.warn("Existing project sync hydration failed", error);
      return null;
    }

    const fallbackRelativePath =
      fallback.relativePath ?? relativeOneDrivePath(fallback.path);
    const syncedProject = result.snapshot.projects.find(
      (candidate) =>
        candidate.id === fallback.id ||
        Boolean(
          candidate.relativePath &&
            fallbackRelativePath &&
            candidate.relativePath.toLowerCase() ===
              fallbackRelativePath.toLowerCase(),
        ) ||
        normalizePath(candidate.pathHint) === normalizePath(fallback.path),
    );
    if (!syncedProject) return null;

    const projectPath = resolveSyncedPath(
      syncedProject.relativePath,
      syncedProject.pathHint,
      workspaceRoot,
    );
    const project: Project = {
      id: syncedProject.id,
      name: syncedProject.name || fallback.name,
      path: projectPath,
      relativePath: syncedProject.relativePath ?? fallbackRelativePath,
      threads: [...new Set(syncedProject.threads)],
    };
    const cache = { ...localConversationCacheRef.current };

    for (const title of project.threads) {
      const key = `${project.path}/${title}`;
      const fallbackKey = `${fallback.path}/${title}`;
      const cached = cache[key] ?? cache[fallbackKey];
      const remote =
        result.snapshot.conversations[
          syncConversationKey(syncedProject.id, title)
        ];
      const localMessages =
        cached?.messages ?? loadThreadMessages(fallbackKey);
      const localWorkItems =
        cached?.workItems ?? loadThreadWorkItems(fallbackKey);
      const localPlanHistory =
        cached?.planHistory ?? loadThreadPlanHistory(fallbackKey);
      const localCommentary =
        cached?.commentary ?? loadThreadCommentary(fallbackKey);
      cache[key] = {
        id: remote?.id ?? cached?.id,
        scope: "coding",
        projectId: project.id,
        title,
        messages: dropUnrecoverablePersistedAnswers(
          mergeMessages(remote?.messages ?? [], localMessages, false),
        ),
        workItems: mergeWorkItems(remote?.workItems ?? [], localWorkItems),
        planHistory: mergePlanHistory(
          remote?.planHistory ?? {},
          localPlanHistory,
        ),
        commentary: mergeCommentary(
          remote?.commentary ?? [],
          localCommentary,
        ),
        threadId:
          threadIdsRef.current[key] ??
          threadIdsRef.current[fallbackKey] ??
          cached?.threadId ??
          null,
        updatedAt:
          remote?.updatedAt ?? cached?.updatedAt ?? new Date().toISOString(),
      };
    }

    return {
      result,
      project,
      cache,
      selectedThread: preferredThreadForProject(project, cache, ""),
    };
  };

  const applyHydratedProject = (hydrated: HydratedProject) => {
    const { project, cache, result, selectedThread } = hydrated;
    const isSameProject = (candidate: Project) =>
      candidate.id === project.id ||
      normalizePath(candidate.path) === normalizePath(project.path);
    const nextProjects = dedupeProjects([
      ...projectsRef.current.filter((candidate) => !isSameProject(candidate)),
      project,
    ]);
    const selectedKey = `${project.path}/${selectedThread}`;
    const selectedConversation = cache[selectedKey];
    const selectedHistory = selectedConversation?.planHistory ?? {};

    projectsRef.current = nextProjects;
    localConversationCacheRef.current = cache;
    setProjects(nextProjects);
    setLocalConversationCache(cache);
    setTombstones(result.snapshot.tombstones ?? []);
    setSyncHealth(result.health);
    setSyncWriteEnabled(result.canWrite);
    setSyncStatus(result.canWrite ? "szinkronizálva" : "karantén · olvasás");
    setActiveProject(project.name);
    setActiveThread(selectedThread);
    messageKeyRef.current = selectedKey;
    workLogKeyRef.current = selectedKey;
    commitMessages(selectedConversation?.messages ?? []);
    setCodeActivity(selectedConversation?.workItems ?? []);
    setViewCodeStatus(
      (selectedConversation?.workItems?.length ?? 0) > 0 ? "kész" : "készen",
    );
    setPlanHistory(selectedHistory);
    setActivePlan(
      Object.values(selectedHistory).at(-1) ?? loadThreadPlan(selectedKey),
    );
    setCommentaryEntries(selectedConversation?.commentary ?? []);
    setExpandedWorkLogs({});
    setOpenProjects((current) => ({ ...current, [project.path]: true }));
    setSyncReady(true);
  };

  const modelFamilies = useMemo<ModelFamily[]>(() => {
    const definitions = [
      {
        key: "gpt-5.6",
        label: "5.6",
        matches: (id: string) => id.startsWith("gpt-5.6-"),
      },
      {
        key: "gpt-5.5",
        label: "5.5",
        matches: (id: string) => id === "gpt-5.5" || id.startsWith("gpt-5.5-"),
      },
      {
        key: "gpt-5.4",
        label: "5.4",
        matches: (id: string) => id === "gpt-5.4" || id.startsWith("gpt-5.4-"),
      },
      {
        key: "codex",
        label: "Codex",
        matches: (id: string) => id.includes("codex"),
      },
      {
        key: "claude",
        label: "Claude",
        matches: (id: string) => id.startsWith("claude-"),
      },
      { key: "other", label: "Egyéb", matches: (_id: string) => true },
    ];
    return definitions
      .map((definition) => {
        const models = modelCatalog.filter((model) =>
          definition.key === "other"
            ? !definitions.slice(0, -1).some((known) => known.matches(model.id))
            : definition.matches(model.id),
        );
        return { key: definition.key, label: definition.label, models };
      })
      .filter((family) => family.models.length > 0)
      .map((family) => ({
        ...family,
        models: [...family.models].sort((a, b) => {
          // The chain's own order, so a vendor's models are listed the same
          // way wherever they are offered. Alphabetical put Fable above Opus,
          // which is neither the strength order nor the chain's.
          const chainOrder = (id: string) => {
            const index = [
              ...PIPELINE_MODELS.anthropic,
              ...PIPELINE_MODELS.codex,
            ].indexOf(id);
            return index < 0 ? 50 : index;
          };
          return (
            chainOrder(a.id) - chainOrder(b.id) ||
            a.displayName.localeCompare(b.displayName)
          );
        }),
      }));
  }, [modelCatalog]);

  const activeModel =
    modelCatalog.find((model) => model.id === selectedModel) ??
    fallbackModels.find((model) => model.id === DEFAULT_MODEL) ??
    fallbackModels[0];
  const selectedClaudeModel = Boolean(selectedModel?.startsWith("claude-"));
  // The chip names the model the way the chain's cells do — "Opus 5", "Sol" —
  // rather than "Claude Sonnet 5" or "GPT-5.6 Luna". The long form set the
  // width of the chip, and the chip sets the width of the menu under it.
  const activeLabel = selectedModel
    ? (PIPELINE_MODEL_LABELS[activeModel.id] ?? modelLabel(activeModel))
    : "Automatikus";
  const supportedEfforts = activeModel.supportedReasoningEfforts.length
    ? activeModel.supportedReasoningEfforts
    : FALLBACK_EFFORTS;
  const effectiveEffort = supportedEfforts.includes(selectedEffort)
    ? selectedEffort
    : (activeModel.defaultReasoningEffort ??
      supportedEfforts[Math.min(1, supportedEfforts.length - 1)]);
  const activeEffortIndex = Math.max(
    0,
    supportedEfforts.indexOf(effectiveEffort),
  );
  const activeEffortLabel = EFFORT_LABELS[effectiveEffort] ?? effectiveEffort;
  const workLogGroups = useMemo<WorkLogGroup[]>(() => {
    return buildWorkLogGroups({
      messages,
      activities: codeActivity,
      planHistory,
      commentary: commentaryEntries,
      activeTurnKey: viewedRun?.turnId,
      compareActivities: compareWorkItems,
    }).sort((left, right) =>
      compareTimelineOrder(
        {
          hlc: left.hlc,
          originDeviceId: left.originDeviceId,
          sequence: left.sequence,
          tieBreaker: left.key,
        },
        {
          hlc: right.hlc,
          originDeviceId: right.originDeviceId,
          sequence: right.sequence,
          tieBreaker: right.key,
        },
      ),
    );
  }, [
    codeActivity,
    commentaryEntries,
    messages,
    planHistory,
  ]);

  const timelineEntries = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = messages.map((message, index) => ({
      kind: "message",
      key: `message-${message.sequence ?? index}-${index}`,
      sequence: message.sequence ?? index,
      hlc: message.hlc,
      originDeviceId: message.originDeviceId,
      tieBreaker: message.id ?? `message-${index}`,
      message,
      messageIndex: index,
    }));
    for (const group of workLogGroups) {
      entries.push({
        kind: "work",
        key: `work-${group.key}`,
        sequence: group.sequence,
        hlc: group.hlc,
        originDeviceId: group.originDeviceId,
        tieBreaker: group.key,
        group,
      });
    }
    return entries.sort(
      (left, right) =>
        compareTimelineOrder(left, right) || (left.kind === "message" ? -1 : 1),
    );
  }, [messages, workLogGroups]);

  useEffect(() => {
    if (!isTauri) return;
    void invoke<PipelineRecipe[]>("pipeline_recipes")
      .then(setPipelineRecipes)
      .catch((error) => console.warn("Pipeline recipes unavailable", error));
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    // A chain takes minutes, so the UI has to follow it stage by stage instead
    // of showing nothing until the whole run finishes. The stage's request id
    // arrives here before its first event does, which is what lets the live
    // trace attribute those events to the turn that is actually running.
    const unlisten = listen<PipelineProgressEvent>("pipeline-progress", (event) => {
      const progress = event.payload;
      setPipelineProgress(progress);
      if (progress.phase === "started") {
        // A szakasz a saját láncának futásához tartozik: a kérés-azonosítója
        // oda kerül be, és onnantól az eseményei is odatalálnak.
        const chainRun =
          runForEvent({ requestId: progress.requestId }) ??
          (runsRef.current.values().next().value as RunHandle | undefined);
        if (!chainRun) return;
        chainRun.chainRequestIds.add(progress.requestId);
        // Named, not cleared. Clearing it left the stage's first event to fall
        // back to `thread:${threadId}` -- and the bridge sends no thread id, so
        // every stage streamed into a message whose turn was the literal
        // string "thread:". That message carried no stage badge, was saved
        // next to the badged one the runner stores, and with no sequence of
        // its own it sorted to the top of the conversation: the same answer
        // again, in a card of its own, above the panel that owns it.
        // The runner stores the stage answer under exactly this turn id, so
        // naming it here makes the live bubble and the stored row one row.
        chainRun.turnId = `request:${progress.requestId}`;
          }
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  const latestWorkLogKeyRef = useRef<string | null>(null);
  latestWorkLogKeyRef.current =
    workLogGroups[workLogGroups.length - 1]?.key ?? null;

  const workGroupExpansionKeys = (group: WorkLogGroup) => [
    ...workGroupTurnKeys(group),
    group.userMessageKey ? `session:${group.userMessageKey}` : undefined,
  ].filter((key, index, values): key is string => Boolean(key) && values.indexOf(key) === index);
  const expandedForWorkGroup = (group: WorkLogGroup, fallback: boolean) => {
    const keys = workGroupExpansionKeys(group);
    const stateKey = keys.find((key) =>
      Object.prototype.hasOwnProperty.call(expandedWorkLogs, key),
    );
    if (stateKey) return expandedWorkLogs[stateKey] ?? fallback;
    const rememberedKey = keys.find((key) =>
      Object.prototype.hasOwnProperty.call(
        expandedWorkLogChoicesRef.current,
        key,
      ),
    );
    return rememberedKey
      ? expandedWorkLogChoicesRef.current[rememberedKey]
      : fallback;
  };
  const setExpandedForKeys = (keys: string[], expanded: boolean) => {
    const uniqueKeys = [...new Set(keys.filter(Boolean))];
    for (const key of uniqueKeys)
      expandedWorkLogChoicesRef.current[key] = expanded;
    setExpandedWorkLogs((current) => {
      const next = { ...current };
      for (const key of uniqueKeys) next[key] = expanded;
      return next;
    });
  };
  const setExpandedForWorkGroup = (group: WorkLogGroup, expanded: boolean) =>
    setExpandedForKeys(workGroupExpansionKeys(group), expanded);
  const planForWorkGroup = (group: WorkLogGroup, preferredTurnKey?: string) => {
    const candidates = workGroupTurnKeys(group)
      .map((key, index) => ({ key, plan: planHistory[key], index }))
      .filter(
        (candidate): candidate is { key: string; plan: PlanSnapshot; index: number } =>
          Boolean(candidate.plan),
      );
    if (candidates.length === 0) return undefined;
    const preferred = preferredTurnKey
      ? candidates.find(
          ({ key, plan }) =>
            plan.turnId === preferredTurnKey ||
            key === preferredTurnKey,
        )
      : undefined;
    if (preferred) return preferred.plan;
    // A session can contain more than one server turn key. Prefer the
    // settled snapshot, then the newest timestamp, instead of the first key
    // that happened to create an activity. This prevents a stale pending
    // plan from bringing back loading dots after the final answer arrived.
    const planTimestamp = (plan: PlanSnapshot) =>
      Math.max(
        plan.completedAt ?? 0,
        plan.startedAt ?? 0,
        ...Object.values(plan.stepTimes ?? {}).map(
          (timing) => timing.completedAt ?? timing.startedAt ?? 0,
        ),
      );
    return [...candidates].sort((left, right) => {
      const leftSettled = left.plan.completedAt !== undefined ? 1 : 0;
      const rightSettled = right.plan.completedAt !== undefined ? 1 : 0;
      if (leftSettled !== rightSettled) return rightSettled - leftSettled;
      return planTimestamp(right.plan) - planTimestamp(left.plan) ||
        right.index - left.index;
    })[0].plan;
  };
  const commentaryForWorkGroup = (
    group: WorkLogGroup,
    preferredTurnKey?: string,
  ) => {
    const keys = new Set(
      preferredTurnKey ? [preferredTurnKey] : workGroupTurnKeys(group),
    );
    return commentaryEntries.filter(
      (entry) => entry.turnId && keys.has(entry.turnId),
    );
  };

  useEffect(() => {
    if (!viewingActiveRun) return;
    const group = workLogGroups[workLogGroups.length - 1];
    const key = group?.key ?? latestWorkLogKeyRef.current;
    if (!key) return;
    if (
      group &&
      workGroupExpansionKeys(group).some(
        (candidate) =>
          expandedWorkLogChoicesRef.current[candidate] === false,
      )
    )
      return;
    setExpandedWorkLogs((current) =>
      Object.prototype.hasOwnProperty.call(current, key)
        ? current
        : { ...current, [key]: true },
    );
  }, [viewingActiveRun, workLogGroups]);

  useEffect(() => {
    expandedWorkLogChoicesRef.current = {};
  }, [threadKey]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", fontSize);
    localStorage.setItem("min-font-size", fontSize);
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty("--line-height", lineHeight);
    localStorage.setItem("min-line-height", lineHeight);
  }, [lineHeight]);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    void (async () => {
      try {
        let root = await invoke<string | null>("codex_workspace");
        if (!root) {
          setSyncStatus("OneDrive-gyökér kiválasztása…");
          const selected = await invoke<string | null>("pick_projects_root");
          if (selected) {
            root = await invoke<string>("codex_set_projects_root", {
              path: selected,
            });
          }
        }
        if (!active) return;
        if (!root) {
          setWorkspaceRoot("");
          setLocalStoreStatus("nincs projektek-gyökér");
          setLocalStoreWriteEnabled(false);
          setSyncWriteEnabled(false);
          setSyncReady(true);
          setSyncStatus("helyi · szinkron letiltva");
          return;
        }
        setWorkspaceRoot(root);
      } catch (error) {
        if (!active) return;
        setSyncWriteEnabled(false);
        setSyncReady(true);
        setSyncStatus("helyi · szinkron letiltva");
        console.warn("Projects root initialization failed", error);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let cleanup: Array<() => void> = [];
    void Promise.all([
      listen<ClaudeApprovalRequest>("agent-approval", (event) => {
        setPendingClaudeApproval(event.payload);
        setPendingClaudeQuestion(null);
      }),
      listen<ClaudeQuestionRequest>("agent-question", (event) => {
        setPendingClaudeQuestion(event.payload);
        setPendingClaudeApproval(null);
        setClaudeQuestionDraft("");
        setClaudeQuestionSelections([]);
      }),
    ])
      .then((unlisteners) => {
        if (disposed) unlisteners.forEach((unlisten) => unlisten());
        else cleanup = unlisteners;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
      cleanup = [];
    };
  }, []);

  useEffect(() => {
    if (!isTauri || !workspaceRoot || localStoreReady) return;
    const hydrationRevision = projectMutationRevisionRef.current;
    let active = true;
    void invoke<LocalStoreHealth>("local_store_initialize")
      .then(async (health) => {
        if (!active) return;
        if (health.recoveryRequired) {
          setLocalStoreStatus("karantén");
          setLocalStoreWriteEnabled(false);
          setSyncWriteEnabled(false);
          setLocalStoreReady(true);
          return;
        }

        const reports = await invoke<V1ImportReport[]>("local_store_import_v1");
        const snapshot = normalizeLocalStoreSnapshot(
          await invoke<LocalStoreSnapshot>("local_store_load"),
        );
        if (!active) return;

        if (projectMutationRevisionRef.current !== hydrationRevision) {
          setLocalStoreStatus("helyi módosítás megőrizve");
          setLocalStoreWriteEnabled(true);
          setLocalStoreReady(true);
          return;
        }

        const localTombstones = snapshot.tombstones ?? [];
        setTombstones(localTombstones);

        const browserHistory = loadStoredMessageMap();
        const browserWorkItems = loadStoredWorkItemMap();
        const localProjects = projects;
        const mergedThreadIds: Record<string, string> = { ...threadIds };
        const localConversationCache: Record<string, SyncConversation> =
          isTauri ? {} : loadStoredGeneralConversations();
        for (const [key, conversation] of Object.entries(
          snapshot.conversations,
        )) {
          if (conversation.scope !== "general") continue;
          const id = conversation.id;
          if (!id) continue;
          const generalKey = generalConversationCacheKey(id);
          localConversationCache[generalKey] = {
            ...conversation,
            id,
            scope: "general",
            projectId: null,
            messages: dropUnrecoverablePersistedAnswers(
              conversation.messages ?? [],
            ),
            workItems: mergeWorkItems(conversation.workItems ?? [], []),
          };
        }
        const matchedLocalProjectIds = new Set<string>();
        const dbProjects = snapshot.projects
          .map((project) => {
            const local = localProjects.find(
              (candidate) =>
                candidate.id === project.id ||
                Boolean(
                  project.relativePath &&
                    candidate.relativePath &&
                    project.relativePath.toLowerCase() ===
                      candidate.relativePath.toLowerCase(),
                ) ||
                normalizePath(candidate.path) ===
                  normalizePath(project.pathHint || workspaceRoot),
            );
            const pathHint = project.pathHint || local?.path || workspaceRoot;
            const resolvedProject = {
              id: project.id,
              name:
                projectNameForMerge(project.name, local?.name) ||
                projectNameFromPath(pathHint),
              path: resolveSyncedPath(
                project.relativePath,
                pathHint,
                workspaceRoot,
              ),
              relativePath:
                project.relativePath ??
                local?.relativePath ??
                relativeOneDrivePath(pathHint),
            };
            return {
              ...resolvedProject,
              threads: [
                ...new Set([
                  ...(project.threads ?? []),
                  ...(local?.threads ?? []),
                ]),
              ].filter(
                (title) =>
                  !localTombstones.some((tombstone) =>
                    tombstoneMatchesConversation(
                      tombstone,
                      title,
                      snapshot.conversations[
                        syncConversationKey(project.id, title)
                      ]?.id,
                      resolvedProject,
                    ),
                  ),
              ),
              local,
            };
          })
          .filter(
            (project) =>
              !localTombstones.some((tombstone) =>
                tombstoneMatchesProject(tombstone, project),
              ),
          );
        const mergedProjects: Project[] = [];

        for (const databaseProject of dbProjects) {
          const local = databaseProject.local;
          if (local) matchedLocalProjectIds.add(local.id);
          const project: Project = {
            id: databaseProject.id,
            name: databaseProject.name,
            path: databaseProject.path,
            relativePath: databaseProject.relativePath,
            threads: databaseProject.threads,
          };
          mergedProjects.push(project);

          for (const title of project.threads) {
            const localKey = `${project.path}/${title}`;
            const localKeys = [
              ...new Set([
                localKey,
                local ? `${local.path}/${title}` : localKey,
              ]),
            ];
            const databaseConversation =
              snapshot.conversations[syncConversationKey(project.id, title)];
            const localMessages =
              localKeys
                .map((key) => browserHistory[key])
                .find((value) => Array.isArray(value) && value.length > 0) ??
              [];
            const localWork =
              localKeys
                .map((key) => browserWorkItems[key])
                .find((value) => Array.isArray(value) && value.length > 0) ??
              [];
            const threadId =
              localKeys
                .map((key) => threadIds[key])
                .find((value): value is string => Boolean(value)) ??
              databaseConversation?.threadId ??
              null;
            const localPlanHistory = localKeys.reduce(
              (merged, key) =>
                mergePlanHistory(merged, loadThreadPlanHistory(key)),
              {} as Record<string, PlanSnapshot>,
            );
            const localCommentary = localKeys.reduce(
              (merged, key) =>
                mergeCommentary(merged, loadThreadCommentary(key)),
              [] as CommentaryEntry[],
            );
            localConversationCache[localKey] = {
              id: databaseConversation?.id,
              scope: "coding",
              projectId: project.id,
              title,
              messages: dropUnrecoverablePersistedAnswers(
                mergeMessages(
                  databaseConversation?.messages ?? [],
                  localMessages,
                ),
              ),
              workItems: mergeWorkItems(
                databaseConversation?.workItems ?? [],
                localWork,
              ),
              planHistory: mergePlanHistory(
                databaseConversation?.planHistory ?? {},
                localPlanHistory,
              ),
              commentary: mergeCommentary(
                databaseConversation?.commentary ?? [],
                localCommentary,
              ),
              threadId,
              updatedAt:
                databaseConversation?.updatedAt ?? new Date().toISOString(),
            };
            if (threadId) mergedThreadIds[localKey] = threadId;
          }
        }

        for (const local of localProjects) {
          if (matchedLocalProjectIds.has(local.id)) continue;
          if (
            localTombstones.some((tombstone) =>
              tombstoneMatchesProject(tombstone, local),
            )
          )
            continue;
          const isWorkspacePlaceholder =
            normalizePath(local.path) === normalizePath(workspaceRoot) &&
            local.name === projectNameFromPath(workspaceRoot) &&
            local.threads.length === 1 &&
            local.threads[0] === "Új beszélgetés";
          if (isWorkspacePlaceholder && mergedProjects.length > 0) continue;
          mergedProjects.push(local);
          const visibleThreads = local.threads.filter(
            (title) =>
              !localTombstones.some((tombstone) =>
                tombstoneMatchesConversation(
                  tombstone,
                  title,
                  snapshot.conversations[syncConversationKey(local.id, title)]
                    ?.id,
                  local,
                ),
              ),
          );
          const visibleLocalProject = { ...local, threads: visibleThreads };
          mergedProjects[mergedProjects.length - 1] = visibleLocalProject;
          for (const title of visibleThreads) {
            const localKey = `${local.path}/${title}`;
            const databaseConversation =
              snapshot.conversations[syncConversationKey(local.id, title)];
            const messages = loadThreadMessages(localKey);
            const workItems = loadThreadWorkItems(localKey);
            const planHistory = mergePlanHistory(
              databaseConversation?.planHistory ?? {},
              loadThreadPlanHistory(localKey),
            );
            const commentary = mergeCommentary(
              databaseConversation?.commentary ?? [],
              loadThreadCommentary(localKey),
            );
            localConversationCache[localKey] = {
              id: databaseConversation?.id,
              scope: "coding",
              projectId: local.id,
              title,
              messages: dropUnrecoverablePersistedAnswers(
                mergeMessages(
                  databaseConversation?.messages ?? [],
                  messages,
                ),
              ),
              workItems: mergeWorkItems(
                databaseConversation?.workItems ?? [],
                workItems,
              ),
              planHistory,
              commentary,
              threadId:
                threadIds[localKey] ?? databaseConversation?.threadId ?? null,
              updatedAt:
                databaseConversation?.updatedAt ?? new Date().toISOString(),
            };
          }
        }

        const nextProjects = dedupeProjects(
          mergedProjects.length > 0 ? mergedProjects : localProjects,
        );
        setProjects(nextProjects);
        setThreadIds(mergedThreadIds);
        projectsRef.current = nextProjects;
        threadIdsRef.current = mergedThreadIds;
        localConversationCacheRef.current = localConversationCache;
        setLocalConversationCache(localConversationCache);

        // Hydration is asynchronous. The user may select another project or
        // thread while SQLite is loading; using the render-time closure here
        // used to snap the GUI back to the stale startup selection seconds
        // later (and could send the next prompt into the wrong conversation).
        if (activeModeRef.current === "general") {
          const selectedId = activeGeneralConversationIdRef.current;
          const selectedKey = selectedId
            ? generalConversationCacheKey(selectedId)
            : "general::new";
          const selectedConversation = selectedId
            ? localConversationCache[selectedKey]
            : undefined;
          const resolvedId = selectedConversation?.id ?? null;
          updateActiveGeneralConversationId(resolvedId);
          if (resolvedId) {
            localStorage.setItem(
              ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY,
              resolvedId,
            );
          } else {
            localStorage.removeItem(ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY);
          }
          messageKeyRef.current = selectedKey;
          workLogKeyRef.current = selectedKey;
          commitMessages(selectedConversation?.messages ?? []);
          setCodeActivity([]);
          setPlanHistory(selectedConversation?.planHistory ?? {});
          setActivePlan({ turnId: null, explanation: "", steps: [] });
          setCommentaryEntries(selectedConversation?.commentary ?? []);
        } else {
          const selectedProject =
            nextProjects.find(
              (project) => project.name === activeProjectRef.current,
            ) ?? nextProjects[0];
          if (selectedProject) {
            const selectedThread = preferredThreadForProject(
              selectedProject,
              localConversationCache,
              activeThreadRef.current,
            );
            const selectedKey = `${selectedProject.path}/${selectedThread}`;
            messageKeyRef.current = selectedKey;
            workLogKeyRef.current = selectedKey;
            setActiveProject(selectedProject.name);
            setActiveThread(selectedThread);
            const selectedConversation = localConversationCache[selectedKey];
            commitMessages(selectedConversation?.messages ?? []);
            setCodeActivity(selectedConversation?.workItems ?? []);
            const selectedHistory = selectedConversation?.planHistory ?? {};
            setPlanHistory(selectedHistory);
            setActivePlan(
              Object.values(selectedHistory).at(-1) ??
                loadThreadPlan(selectedKey),
            );
            setCommentaryEntries(selectedConversation?.commentary ?? []);
          }
        }

        const inserted = reports.reduce(
          (total, report) =>
            total +
            report.insertedProjects +
            report.insertedConversations +
            report.insertedMessages +
            report.insertedWorkItems,
          0,
        );
        setLocalStoreStatus(inserted > 0 ? `seed · +${inserted}` : "kész");
        setLocalStoreWriteEnabled(true);
        setLocalStoreReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setLocalStoreStatus("karantén");
        setLocalStoreWriteEnabled(false);
        setSyncWriteEnabled(false);
        setLocalStoreReady(true);
        console.warn("Local SQLite initialization/import/load failed", error);
      });
    return () => {
      active = false;
    };
  }, [workspaceRoot, localStoreReady]);

  useEffect(() => {
    if (activeMode !== "coding" || !isTauri || !activeProjectData.path) return;
    void invoke<boolean>("ensure_project_instructions", {
      path: activeProjectData.path,
    }).catch((error) => {
      console.warn("Projekt AGENTS.md seeding failed", error);
    });
  }, [activeMode, activeProjectData.path]);

  useEffect(() => {
    if (
      !isTauri ||
      !workspaceRoot ||
      syncReady ||
      !localStoreReady ||
      pendingLocalMutationRef.current ||
      syncActionBusyRef.current
    )
      return;
    const pullRevision = projectMutationRevisionRef.current;
    let active = true;
    void invoke<SyncV2Result>("sync_v2_pull")
      .then(async (result) => {
        if (!active) return;
        // The pull is asynchronous. Always merge against the state that is
        // current when it finishes, not the render that started it; otherwise
        // a restart-time pull can replace an already visible conversation.
        const currentProjects = projectsRef.current;
        const currentConversationCache = localConversationCacheRef.current;
        const currentThreadIds = threadIdsRef.current;
        setSyncHealth(result.health);
        const localSnapshot = await invoke<LocalStoreSnapshot>(
          "local_store_load",
        ).catch(() => null);
        const state = normalizeLocalStoreSnapshot(
          localSnapshot
            ? mergeLocalStoreSnapshotForHydration(
                result.snapshot,
                localSnapshot,
              )
            : result.snapshot,
        );
        const hasGeneralConversations = Object.values(state.conversations).some(
          (conversation) => conversation.scope === "general",
        );
        const remoteTombstones = state.tombstones ?? [];
        const localCursorRecovery = result.warnings.some((warning) =>
          warning.includes("helyi sync cursor"),
        );
        if (!result.canWrite) {
          setSyncWriteEnabled(false);
          setSyncStatus(
            localCursorRecovery
              ? "helyi snapshot · journal újraépítés szükséges"
              : `karantén · ${result.warnings[0] ?? "v2 sync figyelmeztetés"}`,
          );
        } else {
          setSyncWriteEnabled(true);
          setSyncStatus(
            result.importedEvents > 0
              ? `importálva · ${result.importedEvents}`
              : "kész",
          );
        }

        if (
          projectMutationRevisionRef.current !== pullRevision ||
          pendingLocalMutationRef.current
        ) {
          setSyncStatus("helyi módosítás megőrizve");
          setSyncReady(true);
          return;
        }

        setTombstones(remoteTombstones);
        if (
          state.projects.length === 0 &&
          remoteTombstones.length === 0 &&
          !hasGeneralConversations
        ) {
          setSyncReady(true);
          return;
        }

        const syncedProjects = state.projects
          .filter(
            (project) =>
              typeof project.name === "string" &&
              typeof project.id === "string",
          )
          .map((project) => ({
            id:
              project.id ||
              projectIdFromPath(
                project.pathHint ?? workspaceRoot,
                project.relativePath,
              ),
            name: project.name,
            path: resolveSyncedPath(
              project.relativePath,
              project.pathHint,
              workspaceRoot,
            ),
            relativePath: project.relativePath ?? null,
            threads: Array.isArray(project.threads) ? project.threads : [],
          }))
          .filter(
            (project) =>
              !remoteTombstones.some((tombstone) =>
                tombstoneMatchesProject(tombstone, project),
              ),
          );
        const localProjects = currentProjects;
        const matchedLocalProjectIds = new Set<string>();
        const matchingLocalProject = (project: Project) =>
          localProjects.find(
            (local) =>
              local.id === project.id ||
              Boolean(
                project.relativePath &&
                  local.relativePath &&
                  project.relativePath.toLowerCase() ===
                    local.relativePath.toLowerCase(),
              ) ||
              normalizePath(local.path) === normalizePath(project.path),
          );
        const mergedProjects = syncedProjects.map((project) => {
          const local = matchingLocalProject(project);
          if (!local) return project;
          matchedLocalProjectIds.add(local.id);
          const threads = [
            ...new Set([...project.threads, ...local.threads]),
          ].filter(
            (title) =>
              !remoteTombstones.some((tombstone) =>
                tombstoneMatchesConversation(
                  tombstone,
                  title,
                  currentConversationCache[`${local.path}/${title}`]?.id,
                  local,
                ),
              ),
          );
          return {
            ...project,
            name: projectNameForMerge(project.name, local.name),
            threads,
          };
        });
        for (const local of localProjects) {
          if (
            remoteTombstones.some((tombstone) =>
              tombstoneMatchesProject(tombstone, local),
            )
          )
            continue;
          const isWorkspacePlaceholder =
            normalizePath(local.path) === normalizePath(workspaceRoot) &&
            local.name === projectNameFromPath(workspaceRoot) &&
            local.threads.length === 1 &&
            local.threads[0] === "Új beszélgetés";
          if (
            !isWorkspacePlaceholder &&
            !matchedLocalProjectIds.has(local.id)
          ) {
            const threads = local.threads.filter(
              (title) =>
                !remoteTombstones.some((tombstone) =>
                  tombstoneMatchesConversation(
                    tombstone,
                    title,
                    currentConversationCache[`${local.path}/${title}`]?.id,
                    local,
                  ),
                ),
            );
            mergedProjects.push({ ...local, threads });
          }
        }
        const visibleProjects = dedupeProjects(mergedProjects);
        if (visibleProjects.length === 0 && activeModeRef.current !== "general") {
          if (remoteTombstones.length > 0) {
            setProjects([]);
            setLocalConversationCache({});
            setActiveProject("");
            setActiveThread("");
            commitMessages([]);
            setCodeActivity([]);
            setCommentaryEntries([]);
            setPlanHistory({});
            setActivePlan({ turnId: null, explanation: "", steps: [] });
          }
          setSyncWriteEnabled(result.canWrite);
          setSyncStatus(
            result.canWrite
              ? "kész · nincs távoli adat"
              : localCursorRecovery
                ? "helyi snapshot · journal újraépítés szükséges"
                : "karantén",
          );
          setSyncReady(true);
          return;
        }

        const cachedHistory = loadStoredMessageMap();
        const cachedWorkLogs = loadStoredWorkItemMap();
        const nextLocalConversationCache: Record<string, SyncConversation> = {
          ...currentConversationCache,
        };
        const syncedThreadIds: Record<string, string> = { ...currentThreadIds };
        for (const conversation of Object.values(state.conversations)) {
          if (conversation.scope !== "general" || !conversation.id) continue;
          const key = generalConversationCacheKey(conversation.id);
          const cached = currentConversationCache[key];
          nextLocalConversationCache[key] = {
            ...conversation,
            id: conversation.id,
            scope: "general",
            projectId: null,
            messages: dropUnrecoverablePersistedAnswers(
              mergeMessages(
                conversation.messages ?? [],
                cached?.messages ?? [],
                false,
              ),
            ),
            workItems: mergeWorkItems(
              conversation.workItems ?? [],
              cached?.workItems ?? [],
            ),
            planHistory: mergePlanHistory(
              conversation.planHistory ?? {},
              cached?.planHistory ?? {},
            ),
            commentary: mergeCommentary(
              conversation.commentary ?? [],
              cached?.commentary ?? [],
            ),
            threadId: null,
          };
        }
        for (const project of visibleProjects) {
          const localProject = matchingLocalProject(project);
          for (const title of project.threads) {
            if (
              remoteTombstones.some((tombstone) =>
                tombstoneMatchesConversation(
                  tombstone,
                  title,
                  currentConversationCache[
                    `${localProject?.path ?? project.path}/${title}`
                  ]?.id,
                  localProject ?? project,
                ),
              )
            )
              continue;
            const conversation =
              state.conversations[syncConversationKey(project.id, title)];
            const localKey = `${project.path}/${title}`;
            const localKeys = [
              ...new Set([
                localKey,
                localProject ? `${localProject.path}/${title}` : localKey,
              ]),
            ];
            const cachedConversation = localKeys
              .map((key) => currentConversationCache[key])
              .find((value): value is SyncConversation => Boolean(value));
            const localMessages = mergeMessages(
              cachedConversation?.messages ?? [],
              localKeys
                .map((key) => cachedHistory[key])
                .find((value): value is Message[] => Array.isArray(value)) ??
                [],
            );
            const localWorkItems = mergeWorkItems(
              cachedConversation?.workItems ?? [],
              localKeys
                .map((key) => cachedWorkLogs[key])
                .find((value): value is CodeActivity[] =>
                  Array.isArray(value),
                ) ?? [],
            );
            const localPlanHistory = localKeys.reduce(
              (merged, key) =>
                mergePlanHistory(merged, loadThreadPlanHistory(key)),
              cachedConversation?.planHistory ?? {},
            );
            const localCommentary = localKeys.reduce(
              (merged, key) =>
                mergeCommentary(merged, loadThreadCommentary(key)),
              cachedConversation?.commentary ?? [],
            );
            const syncedMessages =
              conversation && Array.isArray(conversation.messages)
                ? compactMessages(conversation.messages)
                : [];
            const syncedWorkItems =
              conversation && Array.isArray(conversation.workItems)
                ? conversation.workItems
                    .map((item, index) => normalizeWorkItem(item, index))
                    .filter((item): item is CodeActivity => Boolean(item))
                : [];
            const mergedMessages = mergeMessages(syncedMessages, localMessages);
            const mergedWorkItems = mergeWorkItems(
              syncedWorkItems,
              localWorkItems,
            );
            const mergedPlanHistory = mergePlanHistory(
              conversation?.planHistory ?? {},
              localPlanHistory,
            );
            const mergedCommentary = mergeCommentary(
              conversation?.commentary ?? [],
              localCommentary,
            );
            const localThreadId =
              localKeys
                .map((key) => currentThreadIds[key])
                .find((value): value is string => Boolean(value)) ?? null;
            cachedHistory[localKey] = mergedMessages;
            cachedWorkLogs[localKey] = mergedWorkItems;
            nextLocalConversationCache[localKey] = {
              id: conversation?.id ?? cachedConversation?.id,
              scope: "coding",
              projectId: project.id,
              title,
              messages: mergedMessages,
              workItems: mergedWorkItems,
              planHistory: mergedPlanHistory,
              commentary: mergedCommentary,
              // Codex rollout IDs are device-local; never hydrate one from OneDrive.
              threadId: localThreadId,
              updatedAt:
                conversation?.updatedAt ??
                cachedConversation?.updatedAt ??
                new Date().toISOString(),
            };
            if (localThreadId) syncedThreadIds[localKey] = localThreadId;
          }
        }
        if (activeModeRef.current === "general") {
          const selectedId = activeGeneralConversationIdRef.current;
          const selectedKey = selectedId
            ? generalConversationCacheKey(selectedId)
            : "general::new";
          const selectedConversation = selectedId
            ? nextLocalConversationCache[selectedKey]
            : undefined;
          const resolvedId = selectedConversation?.id ?? null;
          projectsRef.current = visibleProjects;
          threadIdsRef.current = syncedThreadIds;
          localConversationCacheRef.current = nextLocalConversationCache;
          setLocalConversationCache(nextLocalConversationCache);
          setThreadIds(syncedThreadIds);
          setProjects(visibleProjects);
          updateActiveGeneralConversationId(resolvedId);
          if (resolvedId) {
            localStorage.setItem(
              ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY,
              resolvedId,
            );
          } else {
            localStorage.removeItem(ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY);
          }
          commitMessages(selectedConversation?.messages ?? []);
          setCodeActivity([]);
          const selectedHistory = selectedConversation?.planHistory ?? {};
          setPlanHistory(selectedHistory);
          setActivePlan({ turnId: null, explanation: "", steps: [] });
          setCommentaryEntries(selectedConversation?.commentary ?? []);
          messageKeyRef.current = selectedKey;
          workLogKeyRef.current = selectedKey;
          setSyncWriteEnabled(result.canWrite);
          setSyncStatus(result.canWrite ? "szinkronizÃ¡lva" : "karantÃ©n Â· olvasÃ¡s");
          setSyncReady(true);
          return;
        }
        const pendingRestore = pendingRestoreSelectionRef.current;
        const restoredProject = pendingRestore
          ? visibleProjects.find(
              (project) =>
                (pendingRestore.entityType === "project" &&
                  (pendingRestore.entityId === project.id ||
                    Boolean(
                      pendingRestore.relativePath &&
                        project.relativePath &&
                        pendingRestore.relativePath.toLowerCase() ===
                          project.relativePath.toLowerCase(),
                    ) ||
                    Boolean(
                      pendingRestore.pathHint &&
                        normalizePath(pendingRestore.pathHint) ===
                          normalizePath(project.path),
                    ))) ||
                (pendingRestore.entityType === "conversation" &&
                  (pendingRestore.projectId === project.id ||
                    Boolean(
                      pendingRestore.relativePath &&
                        project.relativePath &&
                        pendingRestore.relativePath.toLowerCase() ===
                          project.relativePath.toLowerCase(),
                    ) ||
                    Boolean(
                      pendingRestore.pathHint &&
                        normalizePath(pendingRestore.pathHint) ===
                          normalizePath(project.path),
                    ))),
            )
          : undefined;
        const restoredThread =
          pendingRestore?.entityType === "conversation" &&
          pendingRestore.title &&
          restoredProject?.threads.includes(pendingRestore.title)
            ? pendingRestore.title
            : undefined;
        const restoreIsVisible = Boolean(
          restoredProject &&
            (pendingRestore?.entityType !== "conversation" || restoredThread),
        );
        const selectedProject =
          restoreIsVisible && restoredProject
            ? restoredProject
            : (visibleProjects.find(
                (project) => project.name === activeProjectRef.current,
              ) ?? visibleProjects[0]);
        const selectedThread =
          restoreIsVisible && restoredThread
            ? restoredThread
            : preferredThreadForProject(
                selectedProject,
                nextLocalConversationCache,
                activeThreadRef.current,
              );
        const selectedKey = `${selectedProject.path}/${selectedThread}`;
        const selectionStayedActive =
          !restoreIsVisible &&
          selectedProject.name === activeProjectRef.current &&
          selectedThread === activeThreadRef.current;
        if (selectionStayedActive) {
          const selectedConversation = nextLocalConversationCache[selectedKey];
          if (selectedConversation) {
            nextLocalConversationCache[selectedKey] = {
              ...selectedConversation,
              // A request may start while a restart-time pull is in flight.
              // Merge its newest in-memory rows into the pulled snapshot so
              // neither the previous history nor the live row can disappear.
              // Plans and commentary belong to the same turn and must be
              // protected by the same merge; replacing only those two with
              // the pulled snapshot made LÉPÉSEK vanish until the next event.
              messages: dropUnrecoverablePersistedAnswers(
                mergeMessages(
                  selectedConversation.messages,
                  messagesRef.current,
                  false,
                ),
              ),
              workItems: mergeWorkItems(
                selectedConversation.workItems ?? [],
                codeActivityRef.current,
              ),
              planHistory: mergePlanHistory(
                selectedConversation.planHistory ?? {},
                planHistoryRef.current,
              ),
              commentary: mergeCommentary(
                selectedConversation.commentary ?? [],
                commentaryEntriesRef.current,
              ),
            };
          }
        }
        projectsRef.current = visibleProjects;
        threadIdsRef.current = syncedThreadIds;
        localConversationCacheRef.current = nextLocalConversationCache;
        setLocalConversationCache(nextLocalConversationCache);
        setThreadIds(syncedThreadIds);
        setProjects(visibleProjects);
        setActiveProject(selectedProject.name);
        setActiveThread(selectedThread);
        if (restoreIsVisible && pendingRestore) {
          pendingRestoreSelectionRef.current = null;
          setOpenProjects((current) => ({
            ...current,
            [selectedProject.path]: true,
          }));
          setSyncHealthOpen(false);
          setToast(
            `Visszaállítva és megnyitva: ${pendingRestore.title ?? selectedProject.name}`,
          );
        }
        const selectedConversation = nextLocalConversationCache[selectedKey];
        commitMessages(selectedConversation?.messages ?? []);
        setCodeActivity(selectedConversation?.workItems ?? []);
        const selectedHistory = selectedConversation?.planHistory ?? {};
        setPlanHistory(selectedHistory);
        setActivePlan(
          Object.values(selectedHistory).at(-1) ?? loadThreadPlan(selectedKey),
        );
        setCommentaryEntries(selectedConversation?.commentary ?? []);
        messageKeyRef.current = selectedKey;
        workLogKeyRef.current = selectedKey;
        setSyncWriteEnabled(result.canWrite);
        setSyncStatus(
          result.canWrite
            ? "szinkronizálva"
            : localCursorRecovery
              ? "helyi snapshot · journal újraépítés szükséges"
              : "karantén · olvasás",
        );
        setSyncReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setSyncWriteEnabled(false);
        setSyncStatus("karantén · szinkronhiba");
        markSyncHealthError(`A v2 pull nem sikerült: ${String(error)}`);
        setSyncReady(true);
        console.warn("OneDrive sync load failed", error);
      });
    return () => {
      active = false;
    };
  }, [workspaceRoot, syncReady, localStoreReady]);

  useEffect(() => {
    if (!isTauri || !workspaceRoot || !localStoreReady || !syncReady) return;
    const timer = window.setInterval(() => {
      if (anyRunActive() || syncActionBusyRef.current) return;
      setSyncStatus("frissítés…");
      setSyncReady(false);
    }, SYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [workspaceRoot, syncReady, localStoreReady]);

  useEffect(() => {
    if (isTauri) {
      // This cache is only a browser-preview fallback. Keeping it in the
      // desktop profile can resurrect deleted Tree entries on the next boot.
      localStorage.removeItem(PROJECTS_STORAGE_KEY);
      // `projects` is intentionally empty while SQLite/OneDrive hydration is
      // running. Clearing the active keys during that transient state made
      // every restart forget the exact conversation and fall back to the
      // newest thread. Only clear a selection after the canonical store has
      // finished loading and is genuinely empty.
      if (localStoreReady && projects.length === 0) {
        localStorage.removeItem("min-active-project");
        localStorage.removeItem("min-active-thread");
        if (activeProject) setActiveProject("");
        if (activeThread) setActiveThread("");
      }
    }
    if (!isTauri || !localStoreReady) {
      if (projects.length > 0)
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
      else localStorage.removeItem(PROJECTS_STORAGE_KEY);
    }
    if (!activeProject && projects[0]) {
      setActiveProject(projects[0].name);
      setActiveThread(projects[0].threads[0] ?? "");
    } else if (
      activeProject &&
      !projects.some((project) => project.name === activeProject) &&
      projects[0]
    ) {
      setActiveProject(projects[0].name);
      setActiveThread(projects[0].threads[0] ?? "");
    }
  }, [projects, activeProject, localStoreReady]);

  useEffect(
    () => localStorage.setItem("min-active-project", activeProject),
    [activeProject],
  );
  useEffect(
    () => localStorage.setItem("min-active-thread", activeThread),
    [activeThread],
  );
  useEffect(() => {
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, activeMode);
  }, [activeMode]);
  useEffect(() => {
    if (activeGeneralConversationId) {
      localStorage.setItem(
        ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY,
        activeGeneralConversationId,
      );
    } else {
      localStorage.removeItem(ACTIVE_GENERAL_CONVERSATION_STORAGE_KEY);
    }
  }, [activeGeneralConversationId]);

  useEffect(() => {
    if (isTauri && (!syncReady || !localStoreReady)) return;
    if (messageKeyRef.current !== threadKey) {
      messageKeyRef.current = threadKey;
      const cachedConversation = findCachedConversation(
        localConversationCacheRef.current,
        threadKey,
      );
      if (cachedConversation) {
        // SQLite/sync may canonicalize the project path (for example with or
        // without the Windows \\?\\ prefix). Keep the hydrated conversation
        // under the exact render key as well, otherwise this effect would
        // fall back to the browser cache and hide freshly restored answers.
        const next = {
          ...localConversationCacheRef.current,
          [threadKey]: {
            ...cachedConversation,
            scope: activeMode,
            projectId: activeMode === "general" ? null : activeProjectData.id,
            title:
              activeMode === "general"
                ? activeGeneralConversation?.title ?? "Új beszélgetés"
                : activeThread,
          },
        };
        localConversationCacheRef.current = next;
        setLocalConversationCache(next);
        commitMessages(cachedConversation.messages);
      } else {
        commitMessages(loadThreadMessages(threadKey));
      }
      return;
    }
    if (isTauri) {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        const next = {
          ...current,
          [threadKey]: {
          ...(existing ?? {
            scope: activeMode,
            projectId: activeMode === "general" ? null : activeProjectData.id,
            title:
              activeMode === "general"
                ? activeGeneralConversation?.title ?? "Új beszélgetés"
                : activeThread,
            messages: [],
            workItems: [],
            threadId: activeMode === "general" ? null : threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          scope: activeMode,
          projectId: activeMode === "general" ? null : activeProjectData.id,
          title:
            activeMode === "general"
              ? activeGeneralConversation?.title ?? "Új beszélgetés"
              : activeThread,
          messages: mergeMessages(existing?.messages ?? [], messages, false),
          updatedAt: new Date().toISOString(),
        },
        };
        localConversationCacheRef.current = next;
        return next;
      });
      return;
    }
    saveThreadMessages(threadKey, messages);
    if (activeMode === "general") {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        const next = {
          ...current,
          [threadKey]: {
            ...(existing ?? {
              id: activeGeneralConversationId ?? undefined,
              scope: "general" as const,
              projectId: null,
              title: activeGeneralConversation?.title ?? "Új beszélgetés",
              messages: [],
              workItems: [],
              threadId: null,
              updatedAt: new Date().toISOString(),
            }),
            id: existing?.id ?? activeGeneralConversationId ?? undefined,
            scope: "general" as const,
            projectId: null,
            title: activeGeneralConversation?.title ?? "Új beszélgetés",
            messages,
            updatedAt: new Date().toISOString(),
          },
        };
        localConversationCacheRef.current = next;
        return next;
      });
    }
  }, [
    threadKey,
    messages,
    syncReady,
    localStoreReady,
    activeMode,
    activeGeneralConversation?.title,
    activeProjectData.id,
    activeThread,
    threadIds,
  ]);

  useEffect(() => {
    if (isTauri && (!syncReady || !localStoreReady)) return;
    if (workLogKeyRef.current !== threadKey) {
      workLogKeyRef.current = threadKey;
      const saved =
        localConversationCacheRef.current[threadKey]?.workItems ??
        loadThreadWorkItems(threadKey);
      setCodeActivity(saved);
      setViewCodeStatus(saved.length > 0 ? "kész" : "készen");
      setExpandedWorkLogs({});
      return;
    }
    if (isTauri) {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        const next = {
          ...current,
          [threadKey]: {
          ...(existing ?? {
            scope: activeMode,
            projectId: activeMode === "general" ? null : activeProjectData.id,
            title:
              activeMode === "general"
                ? activeGeneralConversation?.title ?? "Új beszélgetés"
                : activeThread,
            messages: [],
            workItems: [],
            threadId: activeMode === "general" ? null : threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          scope: activeMode,
          projectId: activeMode === "general" ? null : activeProjectData.id,
          title:
            activeMode === "general"
              ? activeGeneralConversation?.title ?? "Új beszélgetés"
              : activeThread,
          workItems: mergeWorkItems(existing?.workItems ?? [], codeActivity),
          updatedAt: new Date().toISOString(),
        },
        };
        localConversationCacheRef.current = next;
        return next;
      });
      return;
    }
    saveThreadWorkItems(threadKey, codeActivity);
  }, [
    threadKey,
    codeActivity,
    syncReady,
    localStoreReady,
    activeMode,
    activeGeneralConversation?.title,
    activeProjectData.id,
    activeThread,
    threadIds,
  ]);

  useEffect(() => {
    if (planKeyRef.current !== threadKey) {
      planKeyRef.current = threadKey;
      const cachedHistory =
        localConversationCacheRef.current[threadKey]?.planHistory ?? {};
      const history =
        Object.keys(cachedHistory).length > 0
          ? cachedHistory
          : loadThreadPlanHistory(threadKey);
      setPlanHistory(history);
      const snapshots = Object.values(history);
      setActivePlan(
        snapshots[snapshots.length - 1] ?? loadThreadPlan(threadKey),
      );
      return;
    }
    saveThreadPlanHistory(threadKey, planHistory);
    if (isTauri && localStoreReady) {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        if (!existing) return current;
        return {
          ...current,
          [threadKey]: { ...existing, planHistory },
        };
      });
    }
    if (!isTauri && activeMode === "general") {
      setLocalConversationCache((current) => ({
        ...current,
        [threadKey]: {
          ...(current[threadKey] ?? {
            id: activeGeneralConversationId ?? undefined,
            scope: "general" as const,
            projectId: null,
            title: activeGeneralConversation?.title ?? "Új beszélgetés",
            messages,
            workItems: [],
            threadId: null,
            updatedAt: new Date().toISOString(),
          }),
          planHistory,
        },
      }));
    }
  }, [
    threadKey,
    planHistory,
    isTauri,
    localStoreReady,
    activeMode,
    activeGeneralConversationId,
    activeGeneralConversation?.title,
  ]);

  useEffect(() => {
    if (commentaryKeyRef.current !== threadKey) {
      commentaryKeyRef.current = threadKey;
      const cachedCommentary =
        localConversationCacheRef.current[threadKey]?.commentary ?? [];
      setCommentaryEntries(
        cachedCommentary.length > 0
          ? cachedCommentary
          : loadThreadCommentary(threadKey),
      );
      return;
    }
    saveThreadCommentary(threadKey, commentaryEntries);
    if (isTauri && localStoreReady) {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        if (!existing) return current;
        return {
          ...current,
          [threadKey]: { ...existing, commentary: commentaryEntries },
        };
      });
    }
    if (!isTauri && activeMode === "general") {
      setLocalConversationCache((current) => ({
        ...current,
        [threadKey]: {
          ...(current[threadKey] ?? {
            id: activeGeneralConversationId ?? undefined,
            scope: "general" as const,
            projectId: null,
            title: activeGeneralConversation?.title ?? "Új beszélgetés",
            messages,
            workItems: [],
            threadId: null,
            updatedAt: new Date().toISOString(),
          }),
          commentary: commentaryEntries,
        },
      }));
    }
  }, [
    threadKey,
    commentaryEntries,
    isTauri,
    localStoreReady,
    activeMode,
    activeGeneralConversationId,
    activeGeneralConversation?.title,
  ]);

  useEffect(() => {
    if (!isTauri) persistStoredGeneralConversations(localConversationCache);
  }, [localConversationCache]);

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    if (!stream || !shouldStickToBottom.current) return;
    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      if (!shouldStickToBottom.current) return;
      stream.scrollTo({ top: stream.scrollHeight, behavior: "auto" });
      setIsAtBottom(true);
    });
    return () => {
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    };
  }, [
    messages,
    viewingActiveRun,
    codeActivity,
    activePlan,
    commentaryEntries,
    transportStatus,
  ]);

  useEffect(() => {
    try {
      // This mapping is intentionally local to this WebView/device. It must
      // not travel through the OneDrive journal.
      localStorage.setItem(
        LOCAL_THREAD_IDS_STORAGE_KEY,
        JSON.stringify(threadIds),
      );
    } catch {
      // A storage failure must not break the conversation.
    }
  }, [threadIds]);

  useEffect(() => {
    if (
      !isTauri ||
      !workspaceRoot ||
      !localStoreReady ||
      !localStoreWriteEnabled ||
      !pendingLocalMutationRef.current
    )
      return;
    const revisionAtSchedule = projectMutationRevisionRef.current;
    const pendingMutationAtSchedule = pendingLocalMutationRef.current;
    const timer = window.setTimeout(() => {
      const currentProjects = projectsRef.current;
      const currentActiveProject = activeProjectRef.current;
      const currentActiveThread = activeThreadRef.current;
      const currentMessages = messagesRef.current;
      const currentWorkItems = codeActivityRef.current;
      const currentThreadIds = threadIdsRef.current;
      const conversations: Record<string, SyncConversation> = {};
      const syncProjects: SyncProject[] = currentProjects.map((project) => ({
        id: project.id,
        name: project.name,
        relativePath:
          project.relativePath ?? relativeOneDrivePath(project.path),
        pathHint: project.path,
        threads: project.threads,
      }));

      for (const project of currentProjects) {
        for (const title of project.threads) {
          const localKey = `${project.path}/${title}`;
          const cached = localConversationCacheRef.current[localKey];
          // GENERAL renders the same composer/message state while the last
          // Coding project remains selected in the background. Never copy a
          // General message into that project's conversation during the
          // debounced SQLite snapshot save.
          //
          // A kérdés nem az, hogy „melyik projekt van kiválasztva", hanem hogy
          // *ennek* a beszélgetésnek a sorai vannak-e a nézet-állapotban. A
          // kettő váltás közben széttart, és az uniós merge egy tranziens
          // keveredést véglegesen lemezre ír.
          const viewHoldsThisConversation =
            activeMode === "coding" &&
            project.name === currentActiveProject &&
            title === currentActiveThread &&
            conversationKeysMatch(localKey, messageKeyRef.current);
          const conversationMessages =
            viewHoldsThisConversation
              ? mergeMessages(
                  cached?.messages ?? loadThreadMessages(localKey),
                  currentMessages,
                  false,
                )
              : (cached?.messages ?? loadThreadMessages(localKey));
          const conversationWorkItems =
            viewHoldsThisConversation
              ? mergeWorkItems(cached?.workItems ?? [], currentWorkItems)
              : (cached?.workItems ?? loadThreadWorkItems(localKey));
          const conversationPlanHistory =
            viewHoldsThisConversation
              ? mergePlanHistory(
                  mergePlanHistory(
                    cached?.planHistory ?? {},
                    loadThreadPlanHistory(localKey),
                  ),
                  planHistoryRef.current,
                )
              : mergePlanHistory(
                  cached?.planHistory ?? {},
                  loadThreadPlanHistory(localKey),
                );
          const conversationCommentary =
            viewHoldsThisConversation
              ? mergeCommentary(
                  mergeCommentary(
                    cached?.commentary ?? [],
                    loadThreadCommentary(localKey),
                  ),
                  commentaryEntriesRef.current,
                )
              : mergeCommentary(
                  cached?.commentary ?? [],
                  loadThreadCommentary(localKey),
                );
          const threadId =
            currentThreadIds[localKey] ?? cached?.threadId ?? null;
          conversations[syncConversationKey(project.id, title)] = {
            id: cached?.id,
            scope: "coding",
            projectId: project.id,
            title,
            messages: compactMessages(conversationMessages),
            workItems: conversationWorkItems,
            planHistory: conversationPlanHistory,
            commentary: conversationCommentary,
            threadId,
            updatedAt: cached?.updatedAt ?? new Date().toISOString(),
          };
        }
      }

      for (const [key, cached] of Object.entries(
        localConversationCacheRef.current,
      )) {
        if (cached.scope !== "general" || !cached.id) continue;
        const selectedGeneralId =
          activeMode === "general"
            ? activeGeneralConversationId ??
              activeGeneralConversationIdRef.current
            : null;
        const activeGeneralKey =
          activeMode === "general"
            ? selectedGeneralId
              ? generalConversationCacheKey(selectedGeneralId)
              : "general::new"
            : null;
        const isActive =
          activeGeneralKey !== null &&
          key === activeGeneralKey &&
          conversationKeysMatch(key, messageKeyRef.current);
        const conversationMessages = isActive
          ? mergeMessages(cached.messages ?? [], currentMessages, false)
          : cached.messages ?? [];
        conversations[key] = {
          ...cached,
          id: cached.id,
          scope: "general",
          projectId: null,
          messages: compactMessages(conversationMessages),
          workItems: isActive
            ? mergeWorkItems(cached.workItems ?? [], currentWorkItems)
            : cached.workItems ?? [],
          planHistory: isActive
            ? mergePlanHistory(cached.planHistory ?? {}, planHistoryRef.current)
            : cached.planHistory ?? {},
          commentary: isActive
            ? mergeCommentary(cached.commentary ?? [], commentaryEntriesRef.current)
            : cached.commentary ?? [],
          threadId: null,
          updatedAt: isActive ? new Date().toISOString() : cached.updatedAt,
        };
      }

      const snapshot: LocalStoreSnapshot = {
        schemaVersion: LOCAL_STORE_SNAPSHOT_VERSION,
        projects: syncProjects,
        conversations,
        tombstones,
      };
      const saveOperation = snapshotWriteQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          // A debounced snapshot may have been queued before a newer Tree
          // mutation. Never let that stale snapshot archive the newer state.
          if (projectMutationRevisionRef.current !== revisionAtSchedule) return;
          setLocalStoreStatus("mentés…");
          const saved = normalizeLocalStoreSnapshot(
            await invoke<LocalStoreSnapshot>("local_store_save", {
              snapshot: snapshotForStorage(snapshot),
            }),
          );
          if (projectMutationRevisionRef.current !== revisionAtSchedule) {
            setLocalStoreStatus("újabb módosítás mentése…");
            return;
          }
          setLocalConversationCache((current) => {
            const next = { ...current };
            for (const project of currentProjects) {
              const savedProject = saved.projects.find(
                (candidate) =>
                  (candidate.relativePath &&
                    project.relativePath &&
                    candidate.relativePath.toLowerCase() ===
                      project.relativePath.toLowerCase()) ||
                  normalizePath(candidate.pathHint) ===
                    normalizePath(project.path) ||
                  candidate.name === project.name,
              );
              for (const title of project.threads) {
                const key = `${project.path}/${title}`;
                const savedConversation = savedProject
                  ? saved.conversations[
                      syncConversationKey(savedProject.id, title)
                    ]
                  : undefined;
                if (savedConversation && next[key])
                  next[key] = { ...next[key], id: savedConversation.id };
              }
            }
            return next;
          });
          setLocalStoreStatus("kész");
          if (syncWriteEnabled && pendingMutationAtSchedule) {
            setSyncStatus("journal…");
            try {
              const result = await invoke<SyncV2Result>(
                "sync_v2_publish_snapshot",
                { snapshot: snapshotForStorage(saved) },
              );
              setSyncHealth(result.health);
              if (!result.canWrite) {
                setSyncWriteEnabled(false);
                setSyncStatus("karantén · v2 sync");
              } else {
                setSyncStatus(
                  result.writtenEvents > 0
                    ? `journal · +${result.writtenEvents}`
                    : "szinkronizálva",
                );
              }
            } catch (error) {
              setSyncWriteEnabled(false);
              setSyncStatus("karantén · journal hiba");
              markSyncHealthError("A v2 journal publish nem sikerült.");
              console.warn("OneDrive v2 journal publish failed", error);
            }
          }
          if (projectMutationRevisionRef.current === revisionAtSchedule) {
            pendingLocalMutationRef.current = false;
            // The local snapshot (and, when writable, its journal events) now
            // contains this mutation. Re-enable polling only after that point.
            if (pendingMutationAtSchedule) setSyncReady(true);
          }
        });
      snapshotWriteQueueRef.current = saveOperation;
      void saveOperation.catch((error) => {
        setLocalStoreWriteEnabled(false);
        setSyncWriteEnabled(false);
        setLocalStoreStatus("karantén · mentési hiba");
        console.warn("Local SQLite snapshot save failed", error);
      });
    // A completed turn must reach SQLite before the user can close/restart
    // the desktop app. Keep the debounce while deltas are arriving, but
    // flush the settled/final answer on the next event-loop turn instead of
    // leaving it in a 350 ms crash window.
    }, anyRunActive() && !turnCompletedRequestId ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [
    activeProject,
    activeThread,
    activeMode,
    activeGeneralConversationId,
    codeActivity,
    localStoreReady,
    localStoreWriteEnabled,
    localMutationRevision,
    messages,
    projects,
    runsRevision,
    turnCompletedRequestId,
    syncReady,
    syncWriteEnabled,
    threadIds,
    tombstones,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!isTauri) {
      setModelsLoading(false);
      return;
    }
    let active = true;
    void invoke<CodexModel[]>("codex_models")
      .then((models) => {
        if (active && models.length > 0)
          setModelCatalog([...models, ...claudeCodingModels]);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (activeModel && !supportedEfforts.includes(selectedEffort))
      setSelectedEffort(effectiveEffort);
  }, [modelCatalog, selectedModel]);

  useEffect(() => {
    if (
      selectedModel &&
      !modelCatalog.some((model) => model.id === selectedModel) &&
      !modelsLoading
    )
      setSelectedModel(DEFAULT_MODEL);
  }, [modelCatalog, modelsLoading, selectedModel]);

  useEffect(() => {
    if (selectedModel) localStorage.setItem("min-model", selectedModel);
    else localStorage.removeItem("min-model");
  }, [selectedModel]);

  useEffect(() => {
    localStorage.setItem("min-claude-budget-usd", claudeBudgetUsd);
  }, [claudeBudgetUsd]);

  useEffect(() => {
    localStorage.setItem("min-claude-max-turns", claudeMaxTurns);
  }, [claudeMaxTurns]);

  useEffect(() => {
    localStorage.setItem("min-claude-sessions", JSON.stringify(claudeSessionIds));
  }, [claudeSessionIds]);

  useEffect(
    () => localStorage.setItem("min-effort", selectedEffort),
    [selectedEffort],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandsOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        const key = latestWorkLogKeyRef.current;
        if (key)
          setExpandedWorkLogs((current) => ({
            ...current,
            [key]: !(current[key] ?? false),
          }));
      }
      if (event.key === "Escape") {
        setCommandsOpen(false);
        setSettingsOpen(false);
        setModelMenuOpen(false);
        setAppDialog(null);
        setExpandedWorkLogs({});
        setFileActionMenu(null);
        setSelectionQuote(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const closeOverflowMenu = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".overflow-menu-wrap")
      )
        setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeOverflowMenu);
    return () => document.removeEventListener("pointerdown", closeOverflowMenu);
  }, []);

  useEffect(() => {
    if (!fileActionMenu) return;
    const closeFileMenu = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".file-action-menu")
      )
        setFileActionMenu(null);
    };
    document.addEventListener("pointerdown", closeFileMenu);
    return () => document.removeEventListener("pointerdown", closeFileMenu);
  }, [fileActionMenu]);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void listen<CodexTransportStatus>("codex-transport", (event) => {
      // A transport-jelentés a kérésé; a futása mondja meg, hol látszik.
      const transportRun = runForRequest(event.payload.requestId);
      if (transportRun) setRunStatus(transportRun, { transport: event.payload });
      else setViewTransportStatus(event.payload);
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          cleanup = unlisten;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      const unlisten = cleanup;
      cleanup = undefined;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!viewingActiveRun) {
      setViewWatchdogMessage("");
      return;
    }
    setViewWatchdogMessage("");
    const timer = window.setTimeout(
      () =>
        setRunStatus(viewedRunRef.current, {
          watchdog:
            "A Codex dolgozik; még nem érkezett megjeleníthető összefoglaló.",
        }),
      8000,
    );
    return () => window.clearTimeout(timer);
  }, [viewingActiveRun]);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: Array<() => void> = [];
    let disposed = false;
    const handleAgentEvent = (value: unknown) => {
      // Events are meaningful only for the request currently owned by this
      // view. Late notifications from a completed/cancelled request must not
      // leak into a conversation selected afterwards.
      const codexEvent = normalizeCodexEvent(value);
      if (!codexEvent) return;
      // Melyik futáshoz tartozik ez az esemény. Ha egyikhez sem — mert a futás
      // már lezárult, vagy egy azonosító nélküli esemény nem köthető senkihez
      // — eldobjuk. A címzett a futás beszélgetése, nem az, ami a képernyőn
      // van: navigálás közben ezek a sorok is a helyükre mennek.
      const run = runForEvent(codexEvent);
      if (!run) return;
      const ownerConversationId = run.ownerConversationId;
      // A chain stage's final events — the complete assistant message that
      // carries the tool inputs and file paths — race the next stage's
      // "started" progress. They are still this run's events; dropping them
      // is how the coding stage's trace lost its file rows.
      const isActiveRequest =
        !codexEvent.requestId || codexEvent.requestId === run.requestId;
      if (codexEvent.sequence !== undefined) {
        const eventKey = agentEventIdentity(codexEvent);
        const processed = run.processedEvents;
        if (processed.has(eventKey)) return;
        processed.add(eventKey);
        if (processed.size > 4096) {
          const oldest = processed.values().next().value;
          if (oldest) processed.delete(oldest);
        }
      }
      const params = asRecord(codexEvent.payload);
      const item = asRecord(params.item);
      const explicitTurnId = eventTurnId(codexEvent, params, item);
      if (!run.turnId) {
        run.turnId = explicitTurnId;
          }
      // A szálazonosító a requestId nélküli események egyetlen fogódzója.
      if (!run.threadId && codexEvent.threadId?.trim())
        run.threadId = codexEvent.threadId.trim();
      // The UI identity is created before the request leaves the client and
      // remains stable even if app-server emits multiple/fallback turn ids.
      // A straggler from an earlier chain stage keeps its own turn: filing it
      // under the stage that is running now would move its rows to the wrong
      // panel.
      const uiTurnId = isActiveRequest
        ? (run.turnId ?? explicitTurnId)
        : `request:${codexEvent.requestId}`;
      const terminalTurnKey =
        codexEvent.terminalEventId ??
        `${codexEvent.requestId ?? run.requestId}:${uiTurnId}`;
      if (
        run.completedTerminalTurns.has(terminalTurnKey) &&
        codexEvent.eventType !== "turn/completed"
      ) {
        return;
      }
      if (codexEvent.eventType === "turn/completed") {
        const completed = run.completedTerminalTurns;
        if (
          !acceptTerminalAgentEvent(completed, {
            requestId: codexEvent.requestId ?? run.requestId,
            threadId: uiTurnId,
            terminalEventId: codexEvent.terminalEventId,
            eventType: codexEvent.eventType,
          })
        )
          return;
        if (completed.size > 128) {
          const oldest = completed.values().next().value;
          if (oldest) completed.delete(oldest);
        }
      }
      let planStepIdOverride: string | undefined;

      if (
        codexEvent.eventType === "item/started" &&
        String(item.type ?? "").toLowerCase() === "agentmessage"
      ) {
        const itemId = firstString(item.id, params.itemId, params.item_id);
        const phase = firstString(item.phase, params.phase);
        if (itemId && phase) run.agentMessagePhases[itemId] = phase;
      }

      if (codexEvent.eventType === "item/agentMessage/delta") {
        const deltaText = firstString(params.delta);
        const itemId = eventItemId(codexEvent, params, item);
        const phase =
          (itemId ? run.agentMessagePhases[itemId] : undefined) ??
          firstString(params.phase, item.phase);
        if (deltaText) {
          setRunStatus(run, { watchdog: "" });
          if (phase === "final_answer") {
            enqueueAnswerDelta(run, deltaText, {
              threadId: codexEvent.threadId,
              itemId,
              turnId: uiTurnId,
              phase,
            });
          } else {
            const stepId =
              run.plan.steps.find((step) => step.status === "inProgress")?.id ??
              run.plan.steps[0]?.id;
            writeOwnedCommentary(ownerConversationId, (current) => {
              const existingIndex = itemId
                ? current.findIndex((entry) => entry.itemId === itemId)
                : -1;
              const sequence =
                existingIndex < 0 ? nextTimelineSequence() : undefined;
              if (existingIndex < 0)
                return [
                  ...current,
                  {
                    id: itemId ?? `commentary-${sequence}`,
                    itemId,
                    turnId: uiTurnId,
                    stepId,
                    sequence: sequence!,
                    body: deltaText,
                    status: "running" as const,
                    time: "most",
                  },
                ].slice(-MAX_COMMENTARY_ENTRIES_PER_THREAD);
              return current.map((entry, index) =>
                index === existingIndex
                  ? {
                      ...entry,
                      body: `${entry.body}${deltaText}`,
                      stepId: entry.stepId ?? stepId,
                    }
                  : entry,
              );
            });
          }
        }
      }

      if (
        codexEvent.eventType === "item/completed" &&
        String(item.type ?? "").toLowerCase() === "agentmessage"
      ) {
        const itemId = firstString(item.id, params.itemId, params.item_id);
        const phase =
          (itemId ? run.agentMessagePhases[itemId] : undefined) ??
          firstString(item.phase, params.phase);
        if (phase === "final_answer") {
          // Some app-server versions send the complete final item without
          // deltas. Commit it as soon as `item/completed` arrives so a slow
          // snapshot finalization (or an app restart during it) cannot turn a
          // valid answer into an empty interrupted placeholder.
          //
          // The completed item wins over the accumulated stream: the stream
          // glues the model's between-tools narration onto the answer, while
          // this event carries the answer alone. Keeping "whichever is longer"
          // preserved exactly the glued junk this event exists to shed.
          const completedText = firstString(item.text, params.text);
          if (completedText) {
            settleAnswerStream(run);
            const liveMessageId = run.liveMessageId;
            writeOwnedMessages(ownerConversationId, (current) =>
              current.map((message) =>
                message.id === liveMessageId && message.role === "assistant"
                  ? {
                      ...message,
                      itemId: itemId ?? message.itemId,
                      turnId: message.turnId ?? uiTurnId,
                      text: completedText,
                    }
                  : message,
              ),
            );
          }
        } else if (itemId) {
          writeOwnedCommentary(ownerConversationId, (current) =>
            current.map((entry) =>
              entry.itemId === itemId ? { ...entry, status: "done" } : entry,
            ),
          );
        }
      }

      if (codexEvent.eventType === "turn/plan/updated") {
        const snapshot = normalizePlanSnapshot(
          codexEvent.payload,
          uiTurnId,
        );
        if (snapshot) {
          const current = run.plan;
          const next = planWithTiming(
            {
              ...current,
              turnId: current.turnId ?? uiTurnId,
              explanation: snapshot.explanation || current.explanation,
            },
            snapshot.steps,
            Date.now(),
          );
          const targetStep =
            next.steps.find((step) => step.status === "inProgress") ??
            next.steps[0];
          if (targetStep) {
            planStepIdOverride = targetStep.id;
          }
          updateOwnedPlanState(ownerConversationId, next);
          setRunStatus(run, { watchdog: "" });
          setRunStatus(run, { statusLabel: "terv frissítve" });
        }
      } else if (
        codexEvent.eventType === "item/plan/delta" ||
        (codexEvent.eventType === "item/completed" &&
          String(item.type ?? "").toLowerCase() === "plan")
      ) {
        const delta = firstString(params.delta, params.text, item.text);
        const bufferKey =
          eventItemId(codexEvent, params, item) ?? uiTurnId;
        if (delta && bufferKey) {
          const nextText = `${run.planTextBuffer[bufferKey] ?? ""}${delta}`;
          run.planTextBuffer[bufferKey] = nextText;
          const steps = planTextToSteps(nextText);
          if (steps.length > 0)
            updateOwnedPlanState(
              ownerConversationId,
              planWithTiming(
                {
                  ...run.plan,
                  turnId: run.plan.turnId ?? uiTurnId,
                },
                steps,
                Date.now(),
              ),
            );
        }
      }
      const activityId = nextTimelineSequence();
      const activity = summarizeCodexWorkEvent(
        codexEvent,
        activityId,
        uiTurnId,
      );
      if (activity) {
        const planStepId =
          planStepIdOverride ??
          run.plan.steps.find((step) => step.status === "inProgress")?.id ??
          run.plan.steps[0]?.id;
        const activityWithStep = { ...activity, planStepId };
        markOwnedPlanStepStarted(ownerConversationId, planStepId, Date.now());
        writeOwnedWorkItems(ownerConversationId, (current) =>
          mergeCodeActivity(current, activityWithStep),
        );
        const filePath = extractFilePath(codexEvent.payload);
        if (
          !activityWithStep.code &&
          filePath &&
          /\.[a-z0-9]{1,8}$/i.test(filePath)
        ) {
          void invoke<string | null>("read_code_file", {
            cwd: run.projectPath || activeProjectPathRef.current,
            path: filePath,
          })
            .then((code) => {
              if (!code) return;
              writeOwnedWorkItems(ownerConversationId, (current) =>
                current.map((item) =>
                  item.id === activityId ||
                  (activityWithStep.itemId &&
                    item.itemId === activityWithStep.itemId)
                    ? { ...item, code, afterCode: item.afterCode ?? code }
                    : item,
                ),
              );
            })
            .catch(() => undefined);
        }
      }
      if (codexEvent.eventType === "turn/started") {
        const current = run.plan;
        const steps =
          current.steps.length > 0
            ? current.steps
            : [
                {
                  id: "client-pre-plan",
                  // During a chain the running stage names the placeholder;
                  // outside one this falls back to the plan wording.
                  step: prePlanStepLabel(pipelineProgressRef.current?.role),
                  status: "inProgress" as const,
                },
              ];
        updateOwnedPlanState(
          ownerConversationId,
          planWithTiming(
            {
              ...current,
              turnId: current.turnId ?? uiTurnId,
              explanation: current.explanation,
            },
            steps,
            Date.now(),
          ),
        );
        setRunStatus(run, { watchdog: "" });
        setRunStatus(run, { statusLabel: "dolgozik" });
      } else if (codexEvent.eventType === "turn/completed") {
        settleAnswerStream(run);
        const completedRequestId = run.requestId;
        const completedAt = Date.now();
        const completedAnswerText = firstString(
          params.finalText,
          params.final_text,
        );
        const completedMessageId = run.liveMessageId;
        // A futás saját sorai közt keresünk, nem a képernyőn: navigálás után a
        // nézetben egy másik beszélgetés áll, és ott ez a válasz nincs is.
        const currentVisibleAnswer = ownedMessages(ownerConversationId).find(
          (message) =>
            message.role === "assistant" &&
            (message.id === completedMessageId || message.turnId === uiTurnId),
        );
        let checkpointAnswerText =
          completedAnswerText ?? currentVisibleAnswer?.text ?? "";
        writeOwnedMessages(ownerConversationId, (current) => {
          const targetIndex = completedMessageId
            ? current.findIndex((message) => message.id === completedMessageId)
            : -1;
          const fallbackIndex = current.findIndex(
            (message) =>
              message.role === "assistant" &&
              message.live &&
              message.turnId === uiTurnId,
          );
          const answerIndex = targetIndex >= 0 ? targetIndex : fallbackIndex;
          if (answerIndex >= 0) {
            return current.map((message, index) => {
              if (index !== answerIndex) return message;
              const answerText =
                completedAnswerText ??
                stripStaleInterruptionMarker(message).text;
              if (answerText.trim()) checkpointAnswerText = answerText;
              return {
                ...message,
                text: answerText,
                time:
                  message.time === "most"
                    ? new Date(completedAt).toISOString()
                    : message.time,
                live: false,
                final: true,
                interrupted: false,
              };
            });
          }
          const recoveredAnswer = current.find(
            (message) =>
              message.role === "assistant" &&
              (message.id === completedMessageId ||
                message.turnId === uiTurnId),
          );
          const answerText =
            completedAnswerText ?? recoveredAnswer?.text ?? "";
          if (!answerText.trim()) return current;
          checkpointAnswerText = answerText;
          // A stale sync pull may have removed the optimistic live row before
          // the terminal event. Preserve the completed answer in the visible
          // turn instead of silently dropping it.
          return [
            ...current,
            {
              id: completedMessageId ?? createEntityId(),
              role: "assistant" as const,
              time: new Date(completedAt).toISOString(),
              text: answerText,
              live: false,
              final: true,
              interrupted: false,
              sequence: nextTimelineSequence(),
              turnId: uiTurnId,
            },
          ];
        });
        // The UI has the authoritative streamed text even when an older
        // provider/session path returns an empty native response payload.
        // Checkpoint that exact visible answer through the same durable SQLite
        // writer; the native RPC checkpoint remains the first line of defense.
        // A checkpoint a futás beszélgetésének szól. A korábbi „különben az
        // épp látott beszélgetés" tartalék pont a rossz helyre könyvelt.
        const checkpointConversationId = ownerConversationId;
        if (
          isTauri &&
          completedRequestId &&
          checkpointConversationId &&
          checkpointAnswerText.trim()
        ) {
          void invoke("agent_answer_checkpoint", {
            conversationId: checkpointConversationId,
            requestId: completedRequestId,
            text: checkpointAnswerText,
          }).catch(() => undefined);
        }
        // `turn/completed` is the durable answer boundary. Protect this
        // terminal message from an in-flight pull and force the zero-delay
        // SQLite + journal flush before the slower workspace guard finishes.
        // Use the stateful mutation path too: a ref-only revision bump does
        // not re-run the persistence effect when the stream already flushed
        // its provisional empty assistant row.
        markLocalMutation();
        run.turnCompleted = true;
            setTurnCompletedRequestId(completedRequestId);
        const completedSteps = run.plan.steps.map((step) =>
          step.status === "inProgress"
            ? { ...step, status: "completed" as const }
            : step,
        );
        const completedPlan = planWithTiming(
          run.plan,
          completedSteps,
          completedAt,
          completedAt,
        );
        updateOwnedPlanState(ownerConversationId, completedPlan);
        setRunStatus(run, { statusLabel: "kész" });
        playCompletionSoundOnce(run.requestId, run);
        // Ha nem ezt a beszélgetést nézzük, a hang önmagában nem mondja meg,
        // melyik készült el.
        if (run.ownerConversationId !== activeConversationIdRef.current) {
          const title =
            localConversationCacheRef.current[run.ownerConversationKey]?.title;
          notify(
            title
              ? `A(z) „${title}" beszélgetés válasza kész`
              : "Egy másik beszélgetés válasza kész",
          );
        }
      } else if (codexEvent.eventType.includes("error"))
        setRunStatus(run, { statusLabel: "hiba" });
    };
    void Promise.all([
      listen<unknown>("agent-event", (event) =>
        handleAgentEvent(event.payload),
      ),
      listen<unknown>("codex-event", (event) =>
        handleAgentEvent(event.payload),
      ),
    ])
      .then((unlisteners) => {
        if (disposed) {
          unlisteners.forEach((unlisten) => unlisten());
        } else {
          cleanup = unlisteners;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
      cleanup = [];
    };
  }, []);

  const notify = (message: string, sound?: AppSound) => {
    setToast(message);
    if (sound) playAppSound(sound);
  };

  const respondClaudeApproval = async (decision: string, reason?: string) => {
    const pending = pendingClaudeApproval;
    if (!pending) return;
    // Close the modal immediately. The turn may already have ended while the
    // interaction was visible (for example after a budget/cancellation error),
    // in which case the backend correctly rejects the late response.
    setPendingClaudeApproval(null);
    try {
      await invoke("claude_approval_response", {
        approvalId: pending.approvalId,
        decision,
        reason: reason ?? null,
      });
    } catch (error) {
      notify(`A Claude jóváhagyás nem küldhető el: ${String(error)}`, "notify");
    }
  };

  const respondClaudeQuestion = async (answer: Record<string, unknown>) => {
    const pending = pendingClaudeQuestion;
    if (!pending) return;
    // See the approval flow above: never leave a stale question blocking the
    // composer when the underlying bridge turn has already terminated.
    setPendingClaudeQuestion(null);
    setClaudeQuestionDraft("");
    setClaudeQuestionSelections([]);
    try {
      await invoke("claude_question_response", {
        questionId: pending.questionId,
        answer,
      });
    } catch (error) {
      notify(`A Claude kérdés-válasz nem küldhető el: ${String(error)}`, "notify");
    }
  };

  const handleFileClick: FileClickHandler = (path, x, y) => {
    setSelectionQuote(null);
    // An image is almost always clicked to be looked at, so show it in place.
    // Launching the OS handler for that costs seconds of application startup;
    // the overlay still offers it for when the external editor is the point.
    if (isPreviewableImagePath(path)) {
      openImagePreview(path);
      return;
    }
    setFileActionMenu({
      path,
      x: Math.min(Math.max(12, x), Math.max(12, window.innerWidth - 236)),
      y: Math.min(Math.max(12, y + 8), Math.max(12, window.innerHeight - 132)),
    });
  };

  const handleLocalLinkClickCapture = (
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const element =
      event.target instanceof Element
        ? event.target.closest("a")
        : null;
    if (!element) return;
    const path = normalizeFileReference(element.getAttribute("href") ?? "");
    if (!path || (!isWindowsPathLike(path) && !isLocalFileReference(path)))
      return;
    event.preventDefault();
    event.stopPropagation();
    handleFileClick(path, event.clientX, event.clientY);
  };

  const closeFileActionMenu = () => setFileActionMenu(null);

  const runSelectedFile = async () => {
    const target = fileActionMenu?.path;
    if (!target) return;
    closeFileActionMenu();
    try {
      await invoke("run_project_file", {
        cwd: activeProjectPathRef.current || activeProjectPath,
        path: target,
      });
      notify(`Elindítva: ${target}`);
    } catch (error) {
      notify(`Nem sikerült futtatni: ${String(error)}`, "notify");
    }
  };

  const openSelectedFileFolder = async () => {
    const target = fileActionMenu?.path;
    if (!target) return;
    closeFileActionMenu();
    try {
      await invoke("open_project_folder", {
        cwd: activeProjectPathRef.current || activeProjectPath,
        path: target,
      });
      notify(`Mappa megnyitva: ${target}`);
    } catch (error) {
      notify(`Nem sikerült megnyitni a mappát: ${String(error)}`, "notify");
    }
  };

  const insertSelectionQuote = () => {
    const selected = selectionQuote?.text.trim();
    const anchorId = selectionQuote?.anchorId;
    if (!selected || !anchorId) return;
    const quote: QuoteReference = {
      id: createEntityId(),
      text: selected,
      instruction: "",
      anchorId,
    };
    quoteInstructionDraftsRef.current[quote.id] = "";
    setComposerQuotes((current) => [...current, quote]);
    setSelectionQuote(null);
    window.requestAnimationFrame(() => quoteInputRefs.current[quote.id]?.focus());
  };

  // A memoizált sorok propjai ezeken keresztül mennek: a testük renderenként
  // friss, az azonosságuk állandó.
  const stableJumpToQuote = useStableCallback((quote: QuoteReference) =>
    jumpToQuote(quote),
  );
  const stableRevertToMessage = useStableCallback((message: Message) =>
    void revertToMessage(message),
  );

  const jumpToQuote: QuoteJumpHandler = (quote) => {
    const target = findQuoteTarget(quote);
    if (!target) {
      notify("Az idézet eredeti helye jelenleg nem látható.");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("is-quote-target");
    window.setTimeout(() => {
      const selected =
        selectQuoteText(target, quote.text) ||
        (quote.instruction ? selectQuoteText(target, quote.instruction) : false);
      if (!selected) notify("Az idézet szövege már nem található ezen a helyen.");
      window.setTimeout(() => target.classList.remove("is-quote-target"), 1400);
    }, 220);
  };

  /**
   * Zárolás csak arra a beszélgetésre, amelyik épp fut. A többi — másik
   * projektben új beszélgetés, egy régi átnevezése, törlése — nem érinti a
   * futást: az a saját ID-jére ír, nem arra, ami a képernyőn van.
   */
  const blockRunOwnerMutation = (conversationKey: string) => {
    if (!runForConversationKey(conversationKey)) return false;
    notify(
      "Ebben a beszélgetésben épp fut egy válasz. Előbb állítsd le.",
      "notify",
    );
    return true;
  };

  /** Ugyanez projektre: a benne futó beszélgetés miatt zárol. */
  const blockRunProjectMutation = (project: Project) => {
    if (
      !project.threads.some((thread) =>
        runForConversationKey(`${project.path}/${thread}`),
      )
    )
      return false;
    notify(
      `A(z) „${project.name}" projektben épp fut egy válasz. Előbb állítsd le.`,
      "notify",
    );
    return true;
  };

  /** Ami az egész munkaterületet forgatja fel, futás közben nem mehet. */
  const blockWorkspaceMutationDuringStream = () => {
    if (!anyRunActive()) return false;
    notify(
      "Aktív válasz közben a projektgyökér nem cserélhető. Előbb állítsd le a választ.",
      "notify",
    );
    return true;
  };

  const addImageFiles = async (files: File[]) => {
    if (imagesPreparing) return;
    const remainingSlots = MAX_IMAGE_ATTACHMENTS - pendingImages.length;
    if (remainingSlots <= 0) {
      notify(`Legfelj ${MAX_IMAGE_ATTACHMENTS} kép csatolható.`, "notify");
      return;
    }
    const selected = files.slice(0, remainingSlots);
    if (files.length > selected.length)
      notify(`Az első ${remainingSlots} kép lett hozzáadva.`, "notify");
    setImagesPreparing(true);
    try {
      const prepared: PendingImageAttachment[] = [];
      for (const file of selected) {
        const mimeType = supportedImageMime(file);
        if (!mimeType) {
          notify("Csak PNG, JPEG és WebP kép csatolható.", "notify");
          continue;
        }
        if (file.size === 0 || file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          notify("Egy kép legfelj 20 MB lehet.", "notify");
          continue;
        }
        const normalizedFile =
          file.type.toLowerCase() === mimeType
            ? file
            : new File([file], file.name || "kép", { type: mimeType });
        prepared.push({
          id: createEntityId(),
          name: file.name || `Képernyőkép.${mimeType.split("/")[1]}`,
          mimeType,
          dataUrl: await fileAsDataUrl(normalizedFile),
        });
      }
      if (prepared.length > 0) {
        setPendingImages((current) => [
          ...current,
          ...prepared.slice(0, MAX_IMAGE_ATTACHMENTS - current.length),
        ]);
        inputRef.current?.focus();
      }
    } catch (error) {
      notify(`A kép nem olvasható: ${String(error)}`, "notify");
    } finally {
      setImagesPreparing(false);
    }
  };

  const handleImageInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) void addImageFiles(files);
  };

  const handleInputPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    if (activeMode === "general") {
      notify("A GENERAL mód jelenleg szöveges beszélgetésre készült.", "notify");
      return;
    }
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.setRangeText(pastedText, start, end, "end");
      const quoteId = textarea.dataset.quoteId;
      if (quoteId) {
        quoteInstructionDraftsRef.current[quoteId] = textarea.value;
      } else inputDraftRef.current = textarea.value;
      requestAnimationFrame(() => {
        textarea.focus();
        resizeComposerTextarea(textarea);
      });
    }
    void addImageFiles(imageFiles);
  };

  const submitAppDialog = () => {
    const dialog = appDialog;
    if (!dialog) return;
    const result =
      dialog.kind === "input"
        ? dialog.onConfirm(dialog.value)
        : dialog.onConfirm();
    if (result !== false) setAppDialog(null);
  };

  const selectModel = (model: string | null) => {
    setSelectedModel(model);
    const modelData = modelCatalog.find((candidate) => candidate.id === model);
    if (
      modelData &&
      !modelData.supportedReasoningEfforts.includes(selectedEffort)
    )
      setSelectedEffort(
        modelData.defaultReasoningEffort ??
          modelData.supportedReasoningEfforts[0] ??
          DEFAULT_EFFORT,
      );
    setModelMenuOpen(false);
    notify(
      model
        ? `Modell kiválasztva: ${modelData?.displayName ?? model}`
        : "Automatikus modell kiválasztva",
    );
  };

  const toggleModelMenu = () => {
    // Which vendor to show is the picker's own business now, and it works it
    // out from the selection when it opens.
    setModelMenuOpen((open) => !open);
  };

  const selectEffortIndex = (index: number) => {
    const effort = supportedEfforts[index];
    if (effort) setSelectedEffort(effort);
  };

  const handleMessageScroll = () => {
    const stream = messageStreamRef.current;
    if (!stream) return;
    const atBottom =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
    shouldStickToBottom.current = atBottom;
    setIsAtBottom(atBottom);
  };

  const handleMessageWheel = (_event: WheelEvent<HTMLDivElement>) => {
    if (viewingActiveRun) {
      shouldStickToBottom.current = false;
      setIsAtBottom(false);
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
    }
    window.requestAnimationFrame(handleMessageScroll);
  };

  const jumpToBottom = () => {
    const stream = messageStreamRef.current;
    if (!stream) return;
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  };

  const renameProject = (project: Project) => {
    if (blockRunProjectMutation(project)) return;
    setAppDialog({
      kind: "input",
      title: "Projekt átnevezése",
      label: "Projekt neve",
      value: project.name,
      confirmLabel: "Mentés",
      onConfirm: (value) => {
        if (blockRunProjectMutation(project)) return false;
        const nextName = value.trim();
        if (!nextName) return false;
        if (nextName === project.name) return true;
        if (
          projects.some(
            (candidate) =>
              candidate.path !== project.path &&
              candidate.name.toLowerCase() === nextName.toLowerCase(),
          )
        ) {
          notify("Ez a projektnév már használatban van");
          return false;
        }
        markProjectMutation();
        setProjects((current) =>
          current.map((candidate) =>
            candidate.path === project.path
              ? { ...candidate, name: nextName }
              : candidate,
          ),
        );
        if (activeProject === project.name) setActiveProject(nextName);
        notify(`Projekt átnevezve: ${nextName}`);
        return true;
      },
    });
  };

  const performDeleteProject = (project: Project) => {
    if (blockRunProjectMutation(project)) return;
    markProjectMutation();
    if (isTauri) {
      setTombstones((current) => [
        ...current.filter(
          (tombstone) =>
            !(
              tombstone.entityType === "project" &&
              tombstoneMatchesProject(tombstone, project)
            ),
        ),
        {
          entityType: "project",
          entityId: project.id,
          archivedAt: new Date().toISOString(),
          projectId: null,
          title: project.name,
          relativePath: project.relativePath,
          pathHint: project.path,
          reason: "Projekt eltávolítva az alkalmazásból",
        },
      ]);
    }
    project.threads.forEach((thread) => {
      const key = `${project.path}/${thread}`;
      removeThreadCommentary(key);
      removeThreadPlan(key);
      if (!isTauri || !localStoreReady) {
        removeThreadMessages(key);
        removeThreadWorkItems(key);
      }
    });
    if (isTauri) {
      setLocalConversationCache((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${project.path}/`),
          ),
        ),
      );
    }
    setProjects((current) =>
      current.filter(
        (candidate) =>
          candidate.id !== project.id &&
          projectIdentityKey(candidate) !== projectIdentityKey(project),
      ),
    );
    setThreadIds((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => !key.startsWith(`${project.path}/`),
        ),
      ),
    );
    setOpenProjects((current) => {
      const next = { ...current };
      delete next[project.path];
      return next;
    });
    setOpenMenu(null);
    if (activeProject === project.name) {
      const nextProject = projects.find(
        (candidate) =>
          candidate.id !== project.id &&
          projectIdentityKey(candidate) !== projectIdentityKey(project),
      );
      if (nextProject) {
        const nextThread = nextProject.threads[0] ?? "";
        setActiveProject(nextProject.name);
        setActiveThread(nextThread);
        commitMessages(
          nextThread
            ? messagesForThread(`${nextProject.path}/${nextThread}`)
            : [],
        );
        setCodeActivity(
          nextThread
            ? workItemsForThread(`${nextProject.path}/${nextThread}`)
            : [],
        );
      } else {
        setActiveProject("");
        setActiveThread("");
        commitMessages([]);
        setCodeActivity([]);
        setCommentaryEntries([]);
        setPlanHistory({});
        setActivePlan({ turnId: null, explanation: "", steps: [] });
      }
    }
    notify(`Eltávolítva a Tree-ből: ${project.name}`);
  };

  const deleteProject = (project: Project) => {
    if (blockRunProjectMutation(project)) return;
    setAppDialog({
      kind: "confirm",
      title: "Projekt eltávolítása a Tree-ből",
      message: `Eltávolítod a(z) „${project.name}” projektet és a beszélgetéseit a Tree-ből? A projektmappa és minden fájlja a lemezen, illetve a OneDrive-on változatlanul megmarad.`,
      confirmLabel: "Eltávolítás a Tree-ből",
      danger: true,
      onConfirm: () => performDeleteProject(project),
    });
  };

  const renameThread = (project: Project, thread: string) => {
    const threadKeyForRename = `${project.path}/${thread}`;
    if (blockRunOwnerMutation(threadKeyForRename)) return;
    setAppDialog({
      kind: "input",
      title: "Beszélgetés átnevezése",
      label: "Beszélgetés neve",
      value: thread,
      confirmLabel: "Mentés",
      onConfirm: (value) => {
        if (blockRunOwnerMutation(threadKeyForRename)) return false;
        const nextName = value.trim();
        if (!nextName) return false;
        if (nextName === thread) return true;
        if (
          project.threads.some(
            (candidate) =>
              candidate !== thread &&
              candidate.toLowerCase() === nextName.toLowerCase(),
          )
        ) {
          notify("Ez a beszélgetésnév már használatban van a projektben");
          return false;
        }
        const oldKey = `${project.path}/${thread}`;
        const newKey = `${project.path}/${nextName}`;
        const messagesToMove = messagesForThread(oldKey);
        const workItemsToMove = workItemsForThread(oldKey);
        markProjectMutation();
        moveThreadPlan(oldKey, newKey);
        moveThreadCommentary(oldKey, newKey);
        if (isTauri && localStoreReady) {
          setLocalConversationCache((current) => {
            const next = { ...current };
            if (next[oldKey])
              next[newKey] = { ...next[oldKey], title: nextName };
            delete next[oldKey];
            return next;
          });
        } else {
          saveThreadMessages(newKey, messagesToMove);
          saveThreadWorkItems(newKey, workItemsToMove);
          removeThreadMessages(oldKey);
          removeThreadWorkItems(oldKey);
        }
        setThreadIds((current) => {
          const next = { ...current };
          if (next[oldKey]) next[newKey] = next[oldKey];
          delete next[oldKey];
          return next;
        });
        setProjects((current) =>
          current.map((candidate) =>
            candidate.path === project.path
              ? {
                  ...candidate,
                  threads: candidate.threads.map((candidateThread) =>
                    candidateThread === thread ? nextName : candidateThread,
                  ),
                }
              : candidate,
          ),
        );
        if (activeProject === project.name && activeThread === thread)
          setActiveThread(nextName);
        notify(`Beszélgetés átnevezve: ${nextName}`);
        return true;
      },
    });
  };

  const performDeleteThread = (project: Project, thread: string) => {
    if (blockRunOwnerMutation(`${project.path}/${thread}`)) return;
    const oldKey = `${project.path}/${thread}`;
    if (isTauri) {
      const conversation = localConversationCacheRef.current[oldKey];
      const duplicateConversationId = Boolean(
        conversation?.id &&
          Object.entries(localConversationCacheRef.current).some(
            ([key, candidate]) =>
              key !== oldKey &&
              key.startsWith(`${project.path}/`) &&
              candidate.projectId === project.id &&
              candidate.id === conversation.id,
          ),
      );
      setTombstones((current) => [
        ...current.filter(
          (tombstone) =>
            !(
              tombstone.entityType === "conversation" &&
              tombstone.title === thread &&
              (tombstone.projectId === project.id ||
                tombstone.relativePath === project.relativePath)
            ),
        ),
        {
          entityType: "conversation",
          // A legacy/duplicate cache ID is intentionally normalized by the
          // backend from project + title. Reusing a colliding UUID here would
          // tombstone a different conversation after the next local save.
          entityId:
            !duplicateConversationId && conversation?.id
              ? conversation.id
              : `legacy:${project.id}:${thread}`,
          archivedAt: new Date().toISOString(),
          projectId: project.id,
          title: thread,
          relativePath: project.relativePath,
          pathHint: project.path,
          reason: "Beszélgetés eltávolítva az alkalmazásból",
        },
      ]);
    }
    removeThreadCommentary(oldKey);
    removeThreadPlan(oldKey);
    const remainingThreads = project.threads.filter(
      (candidate) => candidate !== thread,
    );
    const nextThreads = remainingThreads;
    markProjectMutation();
    if (isTauri) {
      setLocalConversationCache((current) => {
        const next = { ...current };
        delete next[oldKey];
        return next;
      });
    } else {
      removeThreadMessages(oldKey);
      removeThreadWorkItems(oldKey);
    }
    setThreadIds((current) => {
      const next = { ...current };
      delete next[oldKey];
      return next;
    });
    setProjects((current) =>
      current.map((candidate) =>
        candidate.id === project.id
          ? { ...candidate, threads: nextThreads }
          : candidate,
      ),
    );
    setOpenMenu(null);
    if (activeProject === project.name && activeThread === thread) {
      const nextThread = nextThreads[0] ?? "";
      setActiveThread(nextThread);
      commitMessages(
        nextThread ? messagesForThread(`${project.path}/${nextThread}`) : [],
      );
      setCodeActivity(
        nextThread ? workItemsForThread(`${project.path}/${nextThread}`) : [],
      );
      setExpandedWorkLogs({});
    }
    notify(`Beszélgetés törölve: ${thread}`);
  };

  const deleteThread = (project: Project, thread: string) => {
    if (blockRunOwnerMutation(`${project.path}/${thread}`)) return;
    setAppDialog({
      kind: "confirm",
      title: "Beszélgetés törlése",
      message: `Biztosan törlöd a(z) „${thread}” beszélgetést?`,
      confirmLabel: "Beszélgetés törlése",
      danger: true,
      onConfirm: () => performDeleteThread(project, thread),
    });
  };

  const renameGeneralConversation = (conversation: SyncConversation) => {
    if (!conversation.id) return;
    const generalKeyForRename = generalConversationCacheKey(conversation.id);
    if (blockRunOwnerMutation(generalKeyForRename)) return;
    setAppDialog({
      kind: "input",
      title: "Beszélgetés átnevezése",
      label: "Beszélgetés neve",
      value: conversation.title,
      confirmLabel: "Mentés",
      onConfirm: (value) => {
        if (blockRunOwnerMutation(generalKeyForRename)) return false;
        const nextTitle = value.trim();
        if (!nextTitle) return false;
        if (nextTitle === conversation.title) return true;
        const duplicate = Object.values(localConversationCacheRef.current).some(
          (candidate) =>
            candidate.scope === "general" &&
            candidate.id !== conversation.id &&
            candidate.title.trim().toLowerCase() === nextTitle.toLowerCase(),
        );
        if (duplicate) {
          notify("Ez a beszélgetésnév már használatban van a GENERAL módban");
          return false;
        }
        const key = generalConversationCacheKey(conversation.id!);
        const current = localConversationCacheRef.current[key];
        if (!current) return false;
        const nextConversation: SyncConversation = {
          ...current,
          scope: "general",
          projectId: null,
          title: nextTitle,
          updatedAt: new Date().toISOString(),
        };
        const nextCache = {
          ...localConversationCacheRef.current,
          [key]: nextConversation,
        };
        markLocalMutation();
        localConversationCacheRef.current = nextCache;
        setLocalConversationCache(nextCache);
        setOpenMenu(null);
        notify(`Beszélgetés átnevezve: ${nextTitle}`);
        return true;
      },
    });
  };

  const performDeleteGeneralConversation = (conversation: SyncConversation) => {
    if (!conversation.id) return;
    if (blockRunOwnerMutation(generalConversationCacheKey(conversation.id)))
      return;
    const conversationId = conversation.id;
    const key = generalConversationCacheKey(conversationId);
    const nextCache = { ...localConversationCacheRef.current };
    delete nextCache[key];
    markLocalMutation();
    localConversationCacheRef.current = nextCache;
    setLocalConversationCache(nextCache);
    if (isTauri) {
      setTombstones((current) => [
        ...current.filter(
          (tombstone) =>
            !(
              tombstone.entityType === "conversation" &&
              tombstone.entityId === conversationId
            ),
        ),
        {
          entityType: "conversation",
          entityId: conversationId,
          archivedAt: new Date().toISOString(),
          projectId: null,
          title: conversation.title,
          reason: "GENERAL beszélgetés eltávolítva az alkalmazásból",
        },
      ]);
    }
    setOpenMenu(null);
    if (activeGeneralConversationIdRef.current === conversationId) {
      const replacement = Object.values(nextCache)
        .filter(
          (candidate) =>
            candidate.scope === "general" && Boolean(candidate.id),
        )
        .sort((left, right) => {
          const leftTime = Date.parse(left.updatedAt ?? "");
          const rightTime = Date.parse(right.updatedAt ?? "");
          return (
            (Number.isFinite(rightTime) ? rightTime : 0) -
              (Number.isFinite(leftTime) ? leftTime : 0) ||
            (right.id ?? "").localeCompare(left.id ?? "")
          );
        })[0];
      const replacementId = replacement?.id ?? null;
      activeModeRef.current = "general";
      updateActiveGeneralConversationId(replacementId);
      resetConversationView(
        replacementId
          ? generalConversationCacheKey(replacementId)
          : "general::new",
        replacement,
        "general",
      );
    }
    notify(`Beszélgetés törölve: ${conversation.title}`);
  };

  const deleteGeneralConversation = (conversation: SyncConversation) => {
    if (
      conversation.id &&
      blockRunOwnerMutation(generalConversationCacheKey(conversation.id))
    )
      return;
    setAppDialog({
      kind: "confirm",
      title: "Beszélgetés törlése",
      message: `Biztosan törlöd a(z) „${conversation.title}” GENERAL beszélgetést?`,
      confirmLabel: "Beszélgetés törlése",
      danger: true,
      onConfirm: () => performDeleteGeneralConversation(conversation),
    });
  };

  const changeProjectsRoot = async () => {
    if (blockWorkspaceMutationDuringStream()) return;
    if (!isTauri) return;
    try {
      const selected = await invoke<string | null>("pick_projects_root");
      if (!selected) return;
      const root = await invoke<string>("codex_set_projects_root", {
        path: selected,
      });
      setWorkspaceRoot(root);
      setSyncWriteEnabled(false);
      setSyncReady(false);
      setSyncStatus("projektek-gyökér mentve · frissítés…");
      notify("A projektek-gyökér elmentve; a szinkron frissül.");
    } catch (error) {
      notify(`Nem sikerült elmenteni a projektek-gyökeret: ${String(error)}`);
    }
  };

  const createProject = async (requestedName: string) => {
    if (!isTauri) {
      notify("Az új projekt a natív Tauri appban hozható létre");
      return;
    }
    try {
      const selectedPath = await invoke<string>("create_project_directory", {
        name: requestedName,
      });
      // canonicalize() may return a path with the filesystem's casing. The
      // label must reflect what the user entered, not the identity path.
      const projectName = requestedName.trim();
      const project = projectFromPath(projectName, selectedPath);
      await restoreProjectTombstones(project);
      markProjectMutation();
      setProjects((current) => [...current, project]);
      setActiveProject(projectName);
      setActiveThread("Új beszélgetés");
      commitMessages([]);
      setCodeActivity([]);
      setViewCodeStatus("készen");
      setExpandedWorkLogs({});
      setOpenProjects((current) => ({ ...current, [selectedPath]: true }));
      notify(`Projektmappa létrehozva: ${projectName}`);
    } catch (error) {
      notify(`Nem sikerült létrehozni a projektmappát: ${String(error)}`);
    }
  };

  const addProject = () => {
    if (!isTauri) {
      notify("Az új projekt a natív Tauri appban hozható létre");
      return;
    }
    setAppDialog({
      kind: "input",
      title: "Új projekt létrehozása",
      label: "Projekt neve",
      value: "Új projekt",
      confirmLabel: "Létrehozás",
      onConfirm: (value) => {
        const requestedName = value.trim();
        if (!requestedName) return false;
        void createProject(requestedName);
        return true;
      },
    });
  };

  const addExistingProject = async () => {
    if (!isTauri) {
      notify("A meglévő projekt kiválasztása a natív Tauri appban érhető el");
      return;
    }
    try {
      const selectedPath = await invoke<string | null>(
        "pick_project_directory",
      );
      if (!selectedPath) return;
      const existing = projects.find(
        (project) =>
          normalizePath(project.path) === normalizePath(selectedPath),
      );
      if (existing) {
        await restoreProjectTombstones(existing);
        const hydrated = await hydrateProjectFromSync(existing);
        if (hydrated) {
          applyHydratedProject(hydrated);
          notify(`Megnyitva: ${hydrated.selectedThread || hydrated.project.name}`);
          return;
        }
        selectProject(existing);
        notify(`Már hozzáadva: ${existing.name}`);
        return;
      }
      const project = projectFromPath(
        projectNameFromPath(selectedPath),
        selectedPath,
      );
      await restoreProjectTombstones(project);
      const hydrated = await hydrateProjectFromSync(project);
      if (hydrated) {
        markProjectMutation();
        applyHydratedProject(hydrated);
        notify(`Megnyitva: ${hydrated.selectedThread || hydrated.project.name}`);
        return;
      }
      markProjectMutation();
      setProjects((current) => [...current, project]);
      setActiveProject(project.name);
      setActiveThread(project.threads[0]);
      commitMessages(messagesForThread(`${project.path}/${project.threads[0]}`));
      setCodeActivity(
        workItemsForThread(`${project.path}/${project.threads[0]}`),
      );
      setViewCodeStatus("készen");
      setExpandedWorkLogs({});
      setOpenProjects((current) => ({ ...current, [project.path]: true }));
      notify(`Meglévő projekt hozzáadva: ${project.name}`);
    } catch (error) {
      notify(`Nem sikerült megnyitni a projektmappát: ${String(error)}`);
    }
  };

  const selectThread = (project: Project, thread: string) => {
    // Olvasni futás közben is szabad: a futás a saját beszélgetésébe ír, nem
    // abba, ami a képernyőn van. A *módosítás* (átnevezés, törlés, új
    // beszélgetés) továbbra is zárolt — az a futás alól húzná ki a talajt.
    activeModeRef.current = "coding";
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, "coding");
    setActiveMode("coding");
    setActiveProject(project.name);
    setActiveThread(thread);
    openCodingConversation(project, thread);
    notify(`Megnyitva: ${thread}`);
  };

  const resetConversationView = (
    key: string,
    conversation?: SyncConversation,
    mode: AppMode = activeMode,
  ) => {
    messageKeyRef.current = key;
    workLogKeyRef.current = key;
    planKeyRef.current = key;
    commentaryKeyRef.current = key;
    const workItems = conversation?.workItems ?? loadThreadWorkItems(key);
    commitMessages(conversation?.messages ?? loadThreadMessages(key));
    setCodeActivity(workItems);
    setViewCodeStatus(workItems.length ? "kÃ©sz" : "kÃ©szen");
    const cachedHistory = conversation?.planHistory ?? {};
    const history =
      Object.keys(cachedHistory).length > 0
        ? cachedHistory
        : loadThreadPlanHistory(key);
    setPlanHistory(history);
    setActivePlan(
      mode === "general"
        ? { turnId: null, explanation: "", steps: [] }
        : Object.values(history).at(-1) ?? loadThreadPlan(key),
    );
    const cachedCommentary = conversation?.commentary ?? [];
    setCommentaryEntries(
      cachedCommentary.length > 0 ? cachedCommentary : loadThreadCommentary(key),
    );
    setExpandedWorkLogs({});
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
  };

  /**
   * Egy Coding beszélgetés megnyitása. A négy `*KeyRef` és a nézet-állapot
   * együtt mozdul: ez az óra mondja meg a címzett íróknak, hogy mi van a
   * képernyőn, és ha lemarad, a futás a rossz beszélgetésbe ír.
   */
  const openCodingConversation = (project: Project, thread: string) => {
    const key = `${project.path}/${thread}`;
    resetConversationView(
      key,
      findCachedConversation(localConversationCacheRef.current, key),
      "coding",
    );
  };

  const touchGeneralConversation = (conversationId: string) => {
    const key = generalConversationCacheKey(conversationId);
    const conversation = localConversationCacheRef.current[key];
    if (!conversation) return undefined;
    const touchedConversation: SyncConversation = {
      ...conversation,
      scope: "general",
      projectId: null,
      updatedAt: new Date().toISOString(),
    };
    const nextCache = {
      ...localConversationCacheRef.current,
      [key]: touchedConversation,
    };
    localConversationCacheRef.current = nextCache;
    setLocalConversationCache(nextCache);
    markLocalMutation();
    return touchedConversation;
  };

  const selectGeneralConversation = (conversationId: string) => {
    // Olvasni futás közben is szabad: a futás a saját beszélgetésébe ír, nem
    // abba, ami a képernyőn van. A *módosítás* (átnevezés, törlés, új
    // beszélgetés) továbbra is zárolt — az a futás alól húzná ki a talajt.
    const key = generalConversationCacheKey(conversationId);
    const conversation = localConversationCacheRef.current[key];
    if (!conversation) return;
    activeModeRef.current = "general";
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, "general");
    updateActiveGeneralConversationId(conversationId);
    resetConversationView(
      key,
      touchGeneralConversation(conversationId) ?? conversation,
      "general",
    );
    setOpenMenu(null);
  };

  const newGeneralConversation = () => {
    activeModeRef.current = "general";
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, "general");
    updateActiveGeneralConversationId(null);
    resetConversationView("general::new", undefined, "general");
    setOpenMenu(null);
    setSettingsOpen(false);
    inputRef.current?.focus();
  };

  const selectAppMode = (mode: AppMode) => {
    // Olvasni futás közben is szabad: a futás a saját beszélgetésébe ír, nem
    // abba, ami a képernyőn van. A *módosítás* (átnevezés, törlés, új
    // beszélgetés) továbbra is zárolt — az a futás alól húzná ki a talajt.
    if (mode === activeModeRef.current) return;
    // Keep the selection authoritative immediately. Hydration and sync are
    // asynchronous and must not finish by routing the next prompt into the
    // mode that was active when their request started.
    activeModeRef.current = mode;
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, mode);
    setActiveMode(mode);
    setNewProjectMenuOpen(false);
    if (mode === "general") {
      const selectedId = activeGeneralConversationIdRef.current;
      const conversation = selectedId
        ? localConversationCacheRef.current[
            generalConversationCacheKey(selectedId)
          ]
        : undefined;
      resetConversationView(
        selectedId
          ? generalConversationCacheKey(selectedId)
          : "general::new",
        conversation,
        "general",
      );
      return;
    }
    const project =
      projectsRef.current.find(
        (candidate) => candidate.name === activeProjectRef.current,
      ) ?? projectsRef.current[0];
    if (!project) {
      resetConversationView("/", undefined, "coding");
      return;
    }
    const thread = preferredThreadForProject(
      project,
      localConversationCacheRef.current,
      activeThreadRef.current,
    );
    activeProjectRef.current = project.name;
    activeThreadRef.current = thread;
    setActiveProject(project.name);
    setActiveThread(thread);
    resetConversationView(
      `${project.path}/${thread}`,
      localConversationCacheRef.current[`${project.path}/${thread}`],
      "coding",
    );
  };

  const createRequestId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const settleOwnedPlan = (
    ownerId: string | null | undefined,
    status: "completed" | "error",
    run = runForConversation(ownerId),
  ) => {
    const current = run?.plan ?? activePlanRef.current;
    if (
      current.steps.length === 0 ||
      !current.steps.some((step) => step.status === "inProgress")
    )
      return;
    const now = Date.now();
    updateOwnedPlanState(
      ownerId,
      planWithTiming(
        current,
        current.steps.map((step) =>
          step.status === "inProgress" ? { ...step, status } : step,
        ),
        now,
        now,
      ),
    );
  };

  const activeTurnHasCompleted = Boolean(viewedRun?.turnCompleted);

  const stopGeneration = async () => {
    // A leállítás a *nézett* beszélgetés futására vonatkozik: a stop gomb is
    // ott van, és több futás mellett „az aktuális kérés" nem létezik.
    const stoppingRun = viewedRunRef.current;
    const requestId = stoppingRun?.requestId;
    if (!requestId || isCancelling || stoppingRun?.turnCompleted) return;
    const liveMessageId = stoppingRun?.liveMessageId ?? null;
    const finalizeCancellation = () => {
      if (stoppingRun) stoppingRun.cancelled = true;
      // A leállítás is a futásnak szól: a „megszakítva" jelölés a futás
      // beszélgetésébe kerül, nem abba, amit közben megnyitottak.
      const ownerConversationId = stoppingRun?.ownerConversationId ?? null;
      settleAnswerStream(stoppingRun);
      writeOwnedMessages(ownerConversationId, (current) =>
        current.map((message) =>
          message.id === liveMessageId
            ? {
                ...message,
                text: stripStaleInterruptionMarker(message).text.trim()
                  ? `${stripStaleInterruptionMarker(message).text.trimEnd()}\n\nA válasz megszakítva.`
                  : "A válasz megszakítva.",
                turnId: message.turnId ?? stoppingRun?.turnId,
                live: false,
                final: true,
                interrupted: true,
              }
            : message,
        ),
      );
      settleOwnedPlan(ownerConversationId, "error", stoppingRun);
      // A futás csak most kerül ki a táblából: a terv lezárása még a saját
      // pillanatképéből dolgozott.
      endRun(requestId);
      setRunStatus(stoppingRun, { cancelling: false });
      // `codex_send` runs in a native background task and may only settle
      // after the process has been killed. Release the client-side submit
      // guard here so a cancelled request cannot block the next message.
      markSubmitBusy(ownerConversationId, false);
      setImagesPreparing(false);
      setRunStatus(stoppingRun, { statusLabel: "kész" });
      setRunStatus(stoppingRun, { watchdog: "" });
    };
    // A chain is already running by the time it is "preparing": `pipeline_send`
    // has been called and the runner is off. Closing the placeholder locally
    // and returning — which is what this branch used to do — left it working
    // for another eleven minutes after the user had stopped it. Ask the backend
    // by request id, which is the one name that exists before the first stage
    // reports itself.
    if (stoppingRun.status === "preparing") {
      let stoppedChain = false;
      try {
        stoppedChain = await invoke<boolean>("pipeline_cancel_request", {
          requestId,
        });
      } catch (error) {
        console.warn("Pipeline cancel by request failed", error);
      }
      if (!stoppedChain) {
        // An ordinary turn: whichever runtime owns it, if any. Both refuse
        // harmlessly for a request that never reached them.
        for (const command of ["claude_cancel", "codex_cancel"]) {
          try {
            await invoke(command, { requestId });
          } catch {
            // The request was never handed over; nothing to stop.
          }
        }
      }
      finalizeCancellation();
      notify("A válaszgenerálás leállítva");
      return;
    }
    setRunStatus(stoppingRun, { cancelling: true });
    try {
      // A chain has to be told as well: cancelling the running stage would
      // otherwise just let the next one start. By request id rather than by
      // run id — the run id only arrives with the first stage's progress, and
      // a chain must be stoppable before that.
      try {
        await invoke<boolean>("pipeline_cancel_request", { requestId });
      } catch (error) {
        console.warn("Pipeline cancel by request failed", error);
      }
      // A leállítandó futás mondja meg, melyik runtime-ot kell megkérni.
      await invoke(
        stoppingRun?.provider === "anthropic" ? "claude_cancel" : "codex_cancel",
        { requestId },
      );
      finalizeCancellation();
      notify("A válaszgenerálás leállítva");
    } catch (error) {
      if (/már befejeződött|not found|finished/i.test(String(error))) {
        // The backend no longer owns this request, so no future event can
        // safely keep the UI live. Close the placeholder immediately.
        finalizeCancellation();
        notify("A válaszgenerálás leállítva");
      } else {
        setRunStatus(stoppingRun, { cancelling: false });
        notify(`Nem sikerült leállítani: ${String(error)}`, "notify");
      }
    }
  };

  useEffect(() => {
    const showingStop = viewingActiveRun && !activeTurnHasCompleted;
    document.documentElement.classList.toggle("is-streaming", showingStop);
    // A leállítás jelzése is a nézett beszélgetésé: máshol állítottunk le
    // valamit, ez az ablak attól még nem „megszakítás alatt" van.
    document.documentElement.classList.toggle(
      "is-cancelling",
      isCancelling && viewingActiveRun,
    );
    document
      .querySelectorAll<HTMLButtonElement>(".send-button")
      .forEach((button) => {
        button.setAttribute(
          "aria-label",
          showingStop ? "Gondolkodás leállítása" : "Üzenet küldése",
        );
      });
    return () => {
      document.documentElement.classList.remove(
        "is-streaming",
        "is-cancelling",
      );
    };
  }, [viewingActiveRun, isCancelling, activeTurnHasCompleted]);

  useEffect(() => {
    const onSendButtonClick = (event: MouseEvent) => {
      // A küldés gomb a *nézett* beszélgetés futását állítja le; ha itt nem
      // fut semmi, a gomb küld, nem leállít.
      const stoppable = runForConversation(activeConversationIdRef.current);
      if (
        !stoppable ||
        stoppable.turnCompleted ||
        !(event.target instanceof Element)
      )
        return;
      const button = event.target.closest(".send-button");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      void stopGeneration();
    };
    document.addEventListener("click", onSendButtonClick, true);
    return () => document.removeEventListener("click", onSendButtonClick, true);
  }, [viewingActiveRun, isCancelling, activeTurnHasCompleted]);

  /**
   * A futás tényleg véget ért — ha várt egy küldés, most indul. A `requestSubmit`
   * ugyanazon az ajtón megy be, mint a kézi Enter: a csatolmányok, idézetek és a
   * mód is az, ami a szerkesztőben van.
   */
  const releaseQueuedSend = (conversationId: string | null | undefined) => {
    const id = conversationId?.trim();
    if (!id || !queuedSendRef.current.delete(id)) return;
    setQueuedSendConversations((current) =>
      current.filter((candidate) => candidate !== id),
    );
    // A sorban álló üzenet a *saját* beszélgetésében indul el. Ha közben
    // máshol vagyunk, a küldés nem itt történik meg — a szerkesztő tartalma a
    // beszélgetéssel utazik, tehát csak akkor küldhető, ha ott állunk.
    if (id !== activeConversationIdRef.current) return;
    window.setTimeout(() => composerFormRef.current?.requestSubmit(), 0);
  };

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pendingRegeneration = regenerationTargetRef.current;
    regenerationTargetRef.current = null;
    const generalInstruction = (
      pendingRegeneration?.source.text ?? inputDraftRef.current
    ).trim();
    const quoteSnapshot = (
      pendingRegeneration?.source.quoteRefs ?? composerQuotes
    )
      .map((quote) => ({
        ...quote,
        instruction: (
          quoteInstructionDraftsRef.current[quote.id] ?? quote.instruction
        ).trim(),
      }))
      .filter((quote) => quote.text.trim());
    const quoteInstructionText = quoteSnapshot
      .map((quote) => quote.instruction)
      .filter(Boolean)
      .join("\n");
    const selectedQuote = quoteSnapshot[0]?.text.trim() ?? "";
    // The visible user bubble contains only the actual instructions. The
    // quoted source is kept in quoteRefs and shown as a clickable reference
    // button; the full quoted passages remain in modelPrompt for the model.
    const text = generalInstruction;
    const modelPrompt = [
      ...quoteSnapshot.map((quote, index) =>
        [
          `Quoted passage ${index + 1}:`,
          quote.text
            .split(/\r?\n/)
            .map((line) => `> ${line}`)
            .join("\n"),
          `Instruction for quoted passage ${index + 1}:`,
          quote.instruction || "Apply the general instruction to this passage.",
        ].join("\n"),
      ),
      generalInstruction ? `General instruction:\n${generalInstruction}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const pendingImageSnapshot = pendingRegeneration ? [] : [...pendingImages];
    const requestMode = activeModeRef.current;
    const isGeneralMode = requestMode === "general";
    const useClaude = !isGeneralMode && selectedClaudeModel;
    if (!text && quoteSnapshot.length === 0 && pendingImageSnapshot.length === 0)
      return;
    // Egy beszélgetésben egy kör: a beszélgetés lineáris, a következő kérdés
    // kontextusa az előző válasz. A szöveg a szerkesztőben marad, és a futás
    // végén magától elindul.
    const conversationBusy =
      Boolean(runForConversation(activeConversationId)) ||
      submitBusyConversationsRef.current.has(activeConversationId ?? "");
    if (conversationBusy) {
      const queuedId = activeConversationId ?? "";
      queuedSendRef.current.add(queuedId);
      setQueuedSendConversations((current) =>
        current.includes(queuedId) ? current : [...current, queuedId],
      );
      return;
    }
    // Egy projektben egy kör: a munkaterület-snapshot közös, két futás
    // „előtte" állapota egymás félkész írásait tartalmazná. Ez nem sorba áll,
    // mert az a másik beszélgetés futásának a végét jelentené, nem ezét.
    const projectPathKey = isGeneralMode
      ? null
      : normalizeConversationKey(activeProjectData.path);
    if (projectPathKey && runForProject(activeProjectData.path)) {
      notify(
        "Ebben a projektben már fut egy válasz. Előbb fejezd be vagy állítsd le.",
        "notify",
      );
      return;
    }
    if (runsRef.current.size >= MAX_CONCURRENT_RUNS) {
      notify(
        `Egyszerre legfeljebb ${MAX_CONCURRENT_RUNS} válasz futhat. Várd meg valamelyiket.`,
        "notify",
      );
      return;
    }
    if (
      agentApplyProjects.includes(
        isGeneralMode ? "" : normalizeConversationKey(activeProjectData.path),
      )
    ) {
      notify("A létrehozott fájlok alkalmazása még folyamatban van.");
      return;
    }
    if (!isTauri) {
      notify("A natív Tauri appban érhető el a Codex-kapcsolat");
      return;
    }
    if (!isGeneralMode && !activeProjectData?.path) {
      notify("Előbb válassz vagy adj hozzá egy projektmappát");
      return;
    }
    if (isGeneralMode && pendingImageSnapshot.length > 0) {
      notify("A GENERAL kepfeltoltes meg nincs bekapcsolva.", "notify");
      return;
    }
    markSubmitBusy(activeConversationId, true);
    setImagesPreparing(true);
    let storedImages: MessageImageAttachment[] = [
      ...(pendingRegeneration?.source.images ?? []),
    ];
    try {
      if (pendingImageSnapshot.length > 0) {
        storedImages = await invoke<MessageImageAttachment[]>(
          "save_image_attachments",
          {
            cwd: activeProjectData.path,
            images: pendingImageSnapshot.map(({ name, mimeType, dataUrl }) => ({
              name,
              mimeType,
              dataUrl,
            })),
          },
        );
      }
    } catch (error) {
      markSubmitBusy(activeConversationId, false);
      setImagesPreparing(false);
      notify(`A képcsatolmány nem menthető: ${String(error)}`, "notify");
      return;
    }
    setImagesPreparing(false);
    // A continued conversation is a local mutation too. This invalidates any
    // restart-time sync pull that began before the user pressed Send, so its
    // older snapshot cannot replace the visible history mid-request.
    markLocalMutation();
    shouldStickToBottom.current = !pendingRegeneration;
    if (!pendingRegeneration) setIsAtBottom(true);
    const requestId = createRequestId();
    const fallbackTurnId = `request:${requestId}`;
    const requestStartedAt = Date.now();
    const promptText = text || "VizsgÃ¡ld meg a csatolt kÃ©pet vagy kÃ©peket.";
    let requestThreadKey = isGeneralMode
      ? activeGeneralConversationIdRef.current
        ? generalConversationCacheKey(activeGeneralConversationIdRef.current)
        : "general::new"
      : threadKey;
    if (isGeneralMode && !activeGeneralConversationIdRef.current) {
      activeModeRef.current = "general";
      const conversationId = createEntityId();
      const title = conversationTitleFromPrompt(
        generalInstruction || quoteInstructionText || selectedQuote || promptText,
      );
      const generalKey = generalConversationCacheKey(conversationId);
      const newConversation: SyncConversation = {
        id: conversationId,
        scope: "general",
        projectId: null,
        title,
        messages: [],
        workItems: [],
        threadId: null,
        updatedAt: new Date(requestStartedAt).toISOString(),
      };
      requestThreadKey = generalKey;
      updateActiveGeneralConversationId(conversationId);
      localConversationCacheRef.current = {
        ...localConversationCacheRef.current,
        [generalKey]: newConversation,
      };
      setLocalConversationCache((current) => ({
        ...current,
        [generalKey]: newConversation,
      }));
      messageKeyRef.current = generalKey;
      workLogKeyRef.current = generalKey;
      planKeyRef.current = generalKey;
      commentaryKeyRef.current = generalKey;
    }
    // A futásnak a *beszélgetés* a gazdája, nem a képernyő. Az azonosság itt
    // dől el, egyszer: az átnevezést is túléli, és innentől minden ehhez a
    // futáshoz tartozó írás ezt a címzettet nevezi meg.
    const runConversationId = ensureCanonicalConversationId(
      localConversationCacheRef.current[requestThreadKey]?.id,
      createEntityId,
    );
    const previousMessages = mergeMessages(
      localConversationCacheRef.current[requestThreadKey]?.messages ?? [],
      messagesRef.current,
      false,
    );
    const regeneration = pendingRegeneration
      ? beginAssistantRegeneration(
          previousMessages,
          pendingRegeneration.source,
          pendingRegeneration.answer,
          fallbackTurnId,
        )
      : undefined;
    const clientTurnId = regeneration?.turnId ?? fallbackTurnId;
    // Regeneration replays one turn, so it stays on the single-turn path even
    // when the chain is selected; re-running a chain is a whole-run action.
    const runPipeline = showDetailedTrace && pipelineMode && !regeneration;
    const userSequence = regeneration?.source.sequence ?? nextTimelineSequence();
    const liveSequence =
      regeneration?.originalAnswer.sequence ?? nextTimelineSequence();
    // Ugyanaz az ID, amit a runtime fog írni a `(beszélgetés, kérés)` párból:
    // az élő buborék és a lemezre kerülő sor egyetlen sor, az első
    // képkockától. Két azonosság = két sor, és a takarítás csak utólag,
    // beszélgetésen belül fésülte össze őket.
    const liveMessageId =
      regeneration?.originalAnswer.id ??
      agentAnswerMessageId(runConversationId, requestId);
    const liveMessage: Message = regeneration
      ? {
          ...regeneration.liveAnswer,
          id: liveMessageId,
          sequence: liveSequence,
          interrupted: false,
          changeSummary: undefined,
        }
      : {
          id: liveMessageId,
          role: "assistant",
          time: "most",
          text: "",
          live: true,
          final: false,
          sequence: liveSequence,
          turnId: clientTurnId,
        };
    const userMessageId = regeneration?.source.id ?? createEntityId();
    const userMessage: Message = regeneration
      ? regeneration.source
      : {
          id: userMessageId,
          role: "user",
          time: new Date(requestStartedAt).toISOString(),
          text,
          images: storedImages,
          quoteRefs: quoteSnapshot,
          detailed: showDetailedTrace,
          sequence: userSequence,
          // User and assistant rows share one client turn identity. This is the
          // cross-device idempotency key even when cache/SQLite copies carry
          // different row UUIDs.
          turnId: clientTurnId,
        };
    rememberDetailMode(userMessageId, showDetailedTrace);
    const nextMessages = regeneration
      ? regeneration.messages.map((message, index) =>
          index === regeneration.answerIndex ? liveMessage : message,
        )
      : [...previousMessages, userMessage, liveMessage];
    const activeProjectForNaming = isGeneralMode
      ? undefined
      : projects.find((project) => project.id === activeProjectData.id);
    if (
      activeProjectForNaming &&
      (isUntitledConversation(activeThread) || !activeThread.trim()) &&
      !previousMessages.some((message) => message.role === "user")
    ) {
      const nextTitle = uniqueConversationTitle(
        activeProjectForNaming,
        conversationTitleFromPrompt(
          generalInstruction ||
            quoteInstructionText ||
            selectedQuote ||
            storedImages[0]?.name ||
            "Képes kérdés",
        ),
        tombstones
          .filter(
            (tombstone) =>
              tombstone.entityType === "conversation" &&
              tombstoneMatchesProjectScope(tombstone, activeProjectForNaming),
          )
          .map((tombstone) => tombstone.title)
          .filter((title): title is string => Boolean(title)),
      );
      if (nextTitle !== activeThread) {
        const previousThreadKey = requestThreadKey;
        const nextThreadKey = `${activeProjectForNaming.path}/${nextTitle}`;
        const cachedConversation =
          localConversationCacheRef.current[previousThreadKey];
        const nextConversation: SyncConversation = {
          ...(cachedConversation ?? {
            scope: "coding",
            projectId: activeProjectForNaming.id,
            title: nextTitle,
            messages: [],
            workItems: [],
            threadId: null,
            updatedAt: new Date().toISOString(),
          }),
          scope: "coding",
          projectId: activeProjectForNaming.id,
          title: nextTitle,
          messages: nextMessages,
          workItems: cachedConversation?.workItems ?? codeActivity,
          threadId:
            threadIds[previousThreadKey] ??
            cachedConversation?.threadId ??
            null,
          updatedAt: new Date().toISOString(),
        };
        // The title change and the first request happen in the same React
        // turn. Mark the destination key as already hydrated before changing
        // `activeThread`; otherwise the thread-loading effects can briefly
        // read the old empty conversation and erase the first user message.
        messageKeyRef.current = nextThreadKey;
        workLogKeyRef.current = nextThreadKey;
        planKeyRef.current = nextThreadKey;
        commentaryKeyRef.current = nextThreadKey;
        localConversationCacheRef.current = {
          ...localConversationCacheRef.current,
          [nextThreadKey]: nextConversation,
        };
        delete localConversationCacheRef.current[previousThreadKey];
        markProjectMutation();
        if (isTauri && localStoreReady) {
          setLocalConversationCache((current) => {
            const next = { ...current, [nextThreadKey]: nextConversation };
            delete next[previousThreadKey];
            return next;
          });
        } else {
          saveThreadMessages(nextThreadKey, nextMessages);
          saveThreadWorkItems(nextThreadKey, nextConversation.workItems ?? []);
          removeThreadMessages(previousThreadKey);
          removeThreadWorkItems(previousThreadKey);
          removeThreadPlan(previousThreadKey);
        }
        moveThreadPlan(previousThreadKey, nextThreadKey);
        moveThreadCommentary(previousThreadKey, nextThreadKey);
        setThreadIds((current) => {
          const next = { ...current };
          if (current[previousThreadKey])
            next[nextThreadKey] = current[previousThreadKey];
          delete next[previousThreadKey];
          return next;
        });
        setProjects((current) =>
          current.map((project) => {
            if (project.id !== activeProjectForNaming.id) return project;
            const nextThreads = activeThread
              ? project.threads.map((thread) =>
                  thread === activeThread ? nextTitle : thread,
                )
              : [...project.threads, nextTitle];
            return { ...project, threads: [...new Set(nextThreads)] };
          }),
        );
        setActiveThread(nextTitle);
        requestThreadKey = nextThreadKey;
      }
    }
    const initialTransport: CodexTransportStatus = {
      stage: "request-accepted",
      detail: "Kérés fogadva; a feladat értelmezése indul.",
      threadId: null,
    };
    const initialPlan: PlanSnapshot = {
      turnId: clientTurnId,
      explanation: "",
      steps: isGeneralMode
        ? []
        : [
        {
          id: "client-pre-plan",
          step: prePlanStepLabel(
            runPipeline ? activePipelineRecipe?.stages[0]?.role : null,
          ),
          status: "inProgress",
        },
          ],
      startedAt: requestStartedAt,
      stepTimes: isGeneralMode
        ? {}
        : {
        "client-pre-plan": { startedAt: requestStartedAt },
          },
    };
    const cachedRunConversation =
      localConversationCacheRef.current[requestThreadKey];
    // A kérdés eddig a mentési ciklusig egyetlen példányban, a nézet-állapotban
    // élt: ha közben hidrálás vagy sync-pull futott, örökre elveszett, és a
    // válasz árván érkezett meg. Ezért megy a tárba azonnal, szinkron módon.
    const runConversationSeed: SyncConversation = {
      ...(cachedRunConversation ?? {
        scope: isGeneralMode ? "general" : "coding",
        projectId: isGeneralMode ? null : activeProjectData.id,
        title: isGeneralMode
          ? activeGeneralConversation?.title ?? "Új beszélgetés"
          : activeThread,
        workItems: [],
        threadId: isGeneralMode ? null : threadIds[requestThreadKey] ?? null,
      }),
      id: runConversationId,
      messages: nextMessages,
      updatedAt: new Date(requestStartedAt).toISOString(),
    };
    localConversationCacheRef.current = {
      ...localConversationCacheRef.current,
      [requestThreadKey]: runConversationSeed,
    };
    conversationKeyIndexRef.current = {
      ...conversationKeyIndexRef.current,
      [requestThreadKey]: runConversationId,
    };
    conversationKeyByIdRef.current = {
      ...conversationKeyByIdRef.current,
      [runConversationId]: requestThreadKey,
    };
    setLocalConversationCache((current) => ({
      ...current,
      [requestThreadKey]: runConversationSeed,
    }));
    // Innentől létezik a futás. A két kulcsa — a kérés- és a beszélgetés-
    // azonosító — soha többé nem változik: az események ezeken találnak haza,
    // akkor is, ha közben egy másik beszélgetés kerül a képernyőre.
    const runHandle = beginRun({
      requestId,
      ownerConversationId: runConversationId,
      ownerConversationKey: requestThreadKey,
      projectPathKey: isGeneralMode
        ? null
        : normalizeConversationKey(activeProjectData.path),
      projectPath: isGeneralMode ? "" : activeProjectData.path,
      provider: useClaude ? "anthropic" : "codex",
      clientTurnId,
      liveMessageId,
      turnId: clientTurnId,
      turnTiming: { startedAt: requestStartedAt },
      plan: initialPlan,
      planTextBuffer: {},
      agentMessagePhases: {},
      processedEvents: new Set(),
      completedTerminalTurns: new Set(),
      chainRequestIds: new Set(),
      answerStream: { meta: null, pending: "", frame: null },
      status: "preparing",
      cancelled: false,
      turnCompleted: false,
      statusLabel: "dolgozik",
      transport: initialTransport,
      watchdog: "",
      cancelling: false,
    });
    // A küldés maga az állítás, hogy ez a beszélgetés van a képernyőn. Ezt a
    // nézet-óra is így lássa, különben az első két címzett írás — a kérdés és
    // a terv — a tárba menne ugyan, de a képernyőn nem jelenne meg.
    messageKeyRef.current = requestThreadKey;
    updateOwnedPlanState(runConversationId, initialPlan);
    writeOwnedMessages(runConversationId, () => nextMessages);
    inputDraftRef.current = "";
    if (inputRef.current) inputRef.current.value = "";
    quoteInputRefs.current = {};
    quoteInstructionDraftsRef.current = {};
    setComposerQuotes([]);
    setPendingImages([]);
    setTurnCompletedRequestId(null);
    setRunStatus(runHandle, { cancelling: false });
    setRunStatus(runHandle, { statusLabel: "dolgozik" });
    const baseCodexPrompt = modelPrompt || promptText;
    let codexPrompt = baseCodexPrompt;
    const requestContextMessages = regeneration
      ? previousMessages.slice(0, regeneration.sourceIndex)
      : previousMessages;
    const rehydrationContext =
      conversationContextForRehydration(requestContextMessages);
    if (!isGeneralMode && isTauri && activeProjectData?.path) {
      const localFileContext = await loadLocalFileContext(
        promptText,
        rehydrationContext,
        activeProjectData.path,
      );
      if (localFileContext)
        codexPrompt = `${baseCodexPrompt}\n\n${localFileContext}`;
    }
    if (consumeRunCancellation(runHandle)) {
      settleAnswerStream(runHandle);
      if (regeneration) {
        writeOwnedMessages(runConversationId, (current) =>
          current.map((message) =>
            message.id === liveMessageId
              ? regeneration.originalAnswer
              : message,
          ),
        );
      }
      endRun(requestId);
      markSubmitBusy(runConversationId, false);
      return;
    }
    runHandle.status = "streaming";

    try {
      // The UI cache key is path/title based for Tree navigation, while the
      // agent/session tables need the durable SQLite conversation id. That id
      // is resolved and seeded before the question is written, so the run, its
      // rows and its provider session share one owner from the first frame.
      const requestConversationId = runConversationId;
      // The durable provider session lives in SQLite keyed by the stable
      // conversation id. The localStorage cache is keyed by project path plus
      // a truncated conversation title, so an app restart or a title change
      // silently misses it and the turn starts a brand-new Claude session —
      // the transcript then has to be re-sent as context on every turn.
      // Prefer the durable value; fall back to the cache for conversations
      // that predate it. A flagged head conflict still forks deliberately.
      // Asked at send time for exactly the conversation being sent to, rather
      // than read off React state: the cached status can belong to another
      // conversation or not have loaded yet, and either way the turn would
      // silently start a new provider session.
      let durableClaudeSessionId: string | null = null;
      if (useClaude && isTauri && !regeneration) {
        try {
          const status = await invoke<AgentConversationStatus | null>(
            "agent_conversation_status",
            { conversationId: requestConversationId },
          );
          if (status && !status.hasConflict)
            durableClaudeSessionId = status.activeSessionId;
        } catch (error) {
          console.warn("Agent conversation status unavailable", error);
        }
      }
      const resumeClaudeSessionId = regeneration
        ? null
        : (durableClaudeSessionId ?? claudeSessionIds[requestThreadKey] ?? null);
      // A chain is its own call: the runner drives the stages, records each
      // answer, and returns them together. The ordinary single-turn path below
      // is untouched, which is what keeps the default behaviour identical.
      if (runPipeline && activePipelineRecipe && isTauri && !regeneration) {
        const stageRequestIds = activePipelineRecipe.stages.map(
          (_, index) => `${requestId}-stage-${index}`,
        );
        stageRequestIds.forEach((stageRequestId) =>
          runHandle.chainRequestIds.add(stageRequestId),
        );
        try {
          const run = await invoke<PipelineRunResult>("pipeline_send", {
            request: {
              recipeId: activePipelineRecipe.id,
              prompt: codexPrompt,
              conversationId: requestConversationId,
              requestIds: stageRequestIds,
              placeholderRequestId: requestId,
              images: storedImages,
              cwd: isGeneralMode ? null : activeProjectData.path,
              sessionId: resumeClaudeSessionId,
              conversationContext: rehydrationContext || null,
              maxBudgetUsd: Number(claudeBudgetUsd),
              stageOverrides: activePipelineRecipe.stages.map((_, index) => ({
                model: stageValue(index, "model") || undefined,
                effort: stageValue(index, "effort") || undefined,
                provider: stageProvider(index),
              })),
            },
          });
          // Stopping a chain used to throw away everything it had already
          // produced: the runner returns the finished stages with a cancelled
          // status, and this line dropped them on the floor. A plan and a
          // finished implementation are worth keeping — pressing stop means
          // "go no further", not "pretend none of it happened".
          const cancelled = consumeRunCancellation(runHandle);
          // Put the chain's edits on disk before the answer shows up: an
          // answer that names files which are not there yet reads as a lie.
          // A cancelled chain leaves the tree alone: its work is half-done by
          // definition, and the user stopped it rather than accepted it.
          const chainSummary = cancelled
            ? []
            : await settleChainGuard(
                run.guard,
                runConversationId,
                isGeneralMode ? null : activeProjectData.path,
              );
          // The card with the real file list belongs to the stage that wrote
          // the files.
          const codeStageIndex = run.stages.reduce(
            (last, stage, index) => (stage.role === "code" ? index : last),
            -1,
          );
          const stageMessages: Message[] = run.stages.map((stage, stageIndex) => ({
            // The runner already stored this answer; reuse its id so the row it
            // wrote and the row shown here are the same row. Inventing an id
            // here produced a second copy of every stage answer.
            id: stage.answerMessageId ?? crypto.randomUUID(),
            role: "assistant",
            text: stage.succeeded
              ? stage.text
              : run.status === "cancelled"
                ? // Stopping is not a failure, and the provider's own
                  // cancellation error is not an explanation the reader wants.
                  `A(z) ${STAGE_ROLE_LABELS[stage.role] ?? stage.role} szakasz leállítva.`
                : `A(z) ${STAGE_ROLE_LABELS[stage.role] ?? stage.role} szakasz megszakadt: ${stage.error ?? "ismeretlen hiba"}`,
            time: "most",
            live: false,
            final: true,
            turnId: `request:${stage.requestId}`,
            itemId: "assistant-0",
            changeSummary:
              stageIndex === codeStageIndex && chainSummary.length > 0
                ? chainSummary
                : undefined,
            pipeline: {
              runId: run.runId,
              chainId: run.chainId,
              iteration: run.iteration,
              stageIndex: stage.index,
              stageCount: run.recipe.stages.length,
              stageRole: stage.role,
              stageAgent: stage.agentLabel,
              verdict: stage.review?.verdict,
              verdictSummary: stage.review?.summary,
            },
          }));
          // The outer request has a live bubble of its own, and the first
          // stage's stream filled it. Left in place it became a second,
          // badge-less copy of the plan sitting above the run panel.
          settleAnswerStream(runHandle);
          writeOwnedMessages(runConversationId, (current) => {
            // Every stage streamed into a live bubble of its own, and the
            // runner hands back the stored, badged copy of each. Dropping only
            // the outer bubble left both in state under the same turn id: two
            // work groups, two run panels, the same answer twice on screen.
            // The store never saw it -- it keys by turn id -- so the duplicate
            // vanished on reload, which is why it looked like a render bug
            // with a clean database behind it.
            const stagePrefix = `request:${requestId}-stage-`;
            const kept = current.filter(
              (message) =>
                message.id !== liveMessageId &&
                !message.turnId?.startsWith(stagePrefix),
            );
            // Without a sequence these rows fall back to their array index,
            // which is nowhere near the conversation's clock -- the run then
            // sorted to the top of the timeline instead of after its prompt,
            // and its panel was nowhere to be seen until a reload.
            const lastSequence = kept.reduce(
              (highest, message) => Math.max(highest, message.sequence ?? 0),
              0,
            );
            return [
              ...kept,
              ...stageMessages.map((message, index) => ({
                ...message,
                sequence: lastSequence + 1 + index,
              })),
            ];
          });
          const lastSession = [...run.stages]
            .reverse()
            .find((stage) => stage.sessionId)?.sessionId;
          if (lastSession)
            setClaudeSessionIds((current) => ({
              ...current,
              [requestThreadKey]: lastSession,
            }));
          if (run.status === "failed" && run.error) notify(run.error);
          // The runner already dropped the outer request's answer, but a save
          // queued while its bubble was still on screen can land afterwards
          // and put the row back. Ask again once this state has settled.
          window.setTimeout(() => {
            void invoke("pipeline_forget_placeholder", {
              conversationId: requestConversationId,
              requestId,
            }).catch(() => undefined);
          }, 2500);
        } finally {
          setPipelineProgress(null);
          // A chain runs under one request id per stage, so the shared reset
          // at the end of this function — which only fires when the active
          // request id is still the one it started with — never matches after
          // a chain. Without this the composer stayed "busy" for good: the
          // send button looked ready and silently dropped every next message
          // until the app was restarted.
          setRunStatus(runHandle, { cancelling: false });
              setTurnCompletedRequestId(null);
          markSubmitBusy(runConversationId, false);
          endRun(requestId);
          releaseQueuedSend(runConversationId);
        }
        return;
      }
      const response = useClaude
        ? await invoke<CodexResponse>("agent_send", {
            request: {
              prompt: codexPrompt,
              images: storedImages,
              provider: "anthropic",
              runtime: "claudeAgentBridge",
              conversationId: requestConversationId,
              sessionId: resumeClaudeSessionId,
              conversationContext: rehydrationContext || null,
              model: selectedModel,
              // The reasoning slider, like every other model: the Claude panel
              // used to carry an effort of its own, and being set it always
              // won — moving the slider changed nothing for a Claude turn.
              effort: effectiveEffort,
              cwd: activeProjectData.path,
              requestId,
              maxBudgetUsd: Number(claudeBudgetUsd),
              maxTurns: Number(claudeMaxTurns),
            },
          })
        : // Through the same door as every other turn. `codex_send` is the
          // older, parallel entrance: it runs the turn but records no turn row,
          // so a Codex answer left no trace of which workspace snapshot it ran
          // against — and returning to an earlier prompt needs exactly that.
          // The chain's reviewer has always come this way.
          await invoke<CodexResponse>("agent_send", {
            request: {
              prompt: codexPrompt,
              images: storedImages,
              provider: "codex",
              runtime: "codexAppServer",
              conversationId: requestConversationId,
              // Regeneration creates a fresh branch from the context preceding the
              // source prompt; the old native thread already contains the answer
              // that is being replaced. `sessionId` is the Codex thread here.
              sessionId: regeneration
                ? null
                : (threadIds[requestThreadKey] ?? null),
              conversationContext: rehydrationContext || null,
              model: selectedClaudeModel ? DEFAULT_MODEL : selectedModel,
              effort: effectiveEffort,
              cwd: isGeneralMode ? null : activeProjectData.path,
              requestId,
            },
          });
      if (consumeRunCancellation(runHandle)) return;
      const hasAgentChanges =
        response.guard.changedFiles.length > 0 ||
        response.guard.addedFiles.length > 0 ||
        response.guard.removedFiles.length > 0;
      let responseChangeSummary = hasAgentChanges && !isGeneralMode
        ? changeSummaryFromGuard(response.guard)
        : [];
      if (hasAgentChanges && !isGeneralMode && isTauri) {
        try {
          const preview = await invoke<AgentDiffPreview>("agent_preview_snapshot", {
            snapshotId: response.guard.snapshotId,
          });
          const previewSummary = changeSummaryFromDiffFiles(preview.files);
          if (previewSummary.length > 0) responseChangeSummary = previewSummary;
        } catch (error) {
          console.warn("Agent diff preview unavailable", error);
        }
      }
      if (hasAgentChanges && !isGeneralMode) {
        const applied = await applyAgentSnapshotAutomatically(
          response.guard,
          activeProjectData.path,
        );
        // A Claude turn is staged first: the workspace is restored to base and
        // the report says rollbackAvailable=false / applyAvailable=true, then
        // the automatic apply puts the changes on disk. So the undo is offered
        // when the apply succeeded, or when a non-staged flow already reports
        // the snapshot as rollbackable. Either way the changes are on disk.
        rememberUndoableSnapshot(
          runConversationId,
          applied || response.guard.rollbackAvailable
            ? { snapshotId: response.guard.snapshotId }
            : null,
        );
      }
      if (!isGeneralMode) {
        if (useClaude) {
          const sessionId = response.threadId || null;
          if (sessionId)
            setClaudeSessionIds((current) => ({
              ...current,
              [requestThreadKey]: sessionId,
            }));
        } else {
          setThreadIds((current) => ({
            ...current,
            [requestThreadKey]: response.threadId,
          }));
        }
      }
      settleAnswerStream(runHandle);
      runHandle.status = "finalizing";
      writeOwnedMessages(runConversationId, (current) => {
        const targetIndex = current.findIndex(
          (message) => message.id === liveMessageId,
        );
        const fallbackIndex = current.findIndex(
          (message) =>
            message.role === "assistant" &&
            message.live &&
            message.turnId === clientTurnId,
        );
        const answerIndex = targetIndex >= 0 ? targetIndex : fallbackIndex;
        const answerText =
          answerIndex >= 0
            ? stripStaleInterruptionMarker(current[answerIndex]).text ||
              response.text
            : response.text;
        const answerFields = {
          text: answerText,
          turnId: clientTurnId,
          live: false,
          final: true,
          interrupted: false,
          changeSummary:
            responseChangeSummary.length > 0
              ? responseChangeSummary
              : undefined,
        };
        if (answerIndex >= 0) {
          return current.map((message, index) =>
            index === answerIndex ? { ...message, ...answerFields } : message,
          );
        }
        // A stale sync pull can replace the optimistic live row before the
        // native command resolves. Do not lose the durable answer in that
        // case; append it to this turn exactly once.
        return [
          ...current,
          {
            id: liveMessageId,
            role: "assistant" as const,
            time: new Date().toISOString(),
            ...answerFields,
            sequence: nextTimelineSequence(),
          },
        ];
      });
      // The native response can arrive after the terminal event and after
      // the streaming debounce has already persisted the placeholder. Mark
      // this final RPC result as a fresh mutation so the completed text is
      // guaranteed to reach SQLite as well.
      markLocalMutation();
      for (const filePath of isGeneralMode
        ? []
        : extractMentionedFilePaths(response.text)) {
        void invoke<string | null>("read_code_file", {
          cwd: isGeneralMode ? "" : activeProjectData.path,
          path: filePath,
        })
          .then((code) => {
            if (!code) return;
            const extension = filePath
              .split(/[\\/.]/)
              .pop()
              ?.toLowerCase();
            const activityId = nextTimelineSequence();
            writeOwnedWorkItems(runConversationId, (current) =>
              current.some((item) => item.detail === filePath && item.code)
                ? current
                : [
                    {
                      id: activityId,
                      turnId: runHandle.turnId,
                      kind: "file" as const,
                      status: "done" as const,
                      label: "Fájl tartalma",
                      detail: filePath,
                      eventType: "file/read",
                      time: "most",
                      code,
                      afterCode: code,
                      language: extension,
                    },
                    ...current,
                  ].slice(-MAX_WORK_ITEMS_PER_THREAD),
            );
          })
          .catch(() => undefined);
      }
      const completedAt = Date.now();
      const currentPlan = runHandle.plan;
      if (currentPlan.steps.length > 0) {
        updateOwnedPlanState(
          runConversationId,
          planWithTiming(
            currentPlan,
            currentPlan.steps.map((step) =>
              step.status === "inProgress"
                ? { ...step, status: "completed" as const }
                : step,
            ),
            completedAt,
            currentPlan.completedAt ?? completedAt,
          ),
        );
      }
      setRunStatus(runHandle, { statusLabel: "kész" });
      setRunStatus(runHandle, { watchdog: "" });
      // Fallback for an app-server that completes the request without
      // emitting turn/completed. The per-request guard prevents duplicates.
      playCompletionSoundOnce(requestId);
      notify(
        response.threadRehydrated
          ? "Beszélgetés folytatva ezen a gépen"
          : "Codex válasz megérkezett",
      );
    } catch (error) {
      const providerName = useClaude ? "Claude" : "Codex";
      const errorDescription = describeThrownAgentError(error, providerName);
      const errorText = errorDescription.detail;
      // The native command performs snapshot finalization after the model has
      // emitted its final answer. Preserve that streamed answer if only the
      // later workspace post-processing failed.
      settleAnswerStream(runHandle);
      runHandle.status = "finalizing";
      const streamedAnswer = ownedMessages(runConversationId).find(
        (message) => message.id === liveMessageId,
      );
      const hasStreamedAnswer = Boolean(streamedAnswer?.text.trim());
      const wasCancelled =
        consumeRunCancellation(runHandle) ||
        /megszakítva|leállítva|cancel/i.test(errorText);
      writeOwnedMessages(runConversationId, (current) => {
        const targetIndex = current.findIndex(
          (message) => message.id === liveMessageId,
        );
        if (targetIndex < 0) return current;
        return current.map((message, index) =>
          index === targetIndex
            ? {
                ...message,
                text:
                  stripStaleInterruptionMarker(message).text.trim() ||
                  regeneration?.originalAnswer.text ||
                  (wasCancelled
                    ? "A válasz megszakítva."
                    : `Nem sikerült a ${providerName}-kérés: ${errorDescription.userMessage}`),
                turnId: message.turnId ?? runHandle.turnId,
                live: false,
                final: true,
                interrupted: wasCancelled || message.interrupted,
              }
            : message,
        );
      });
      // Persist a streamed answer/error even when the native post-processing
      // fails after the provider has already produced visible text.
      markLocalMutation();
      const answerArrived = !wasCancelled && hasStreamedAnswer;
      settleOwnedPlan(
        runConversationId,
        wasCancelled || answerArrived ? "completed" : "error",
      );
      setRunStatus(runHandle, {
        statusLabel: wasCancelled || answerArrived ? "kész" : "hiba",
        transport: {
          requestId,
          stage: wasCancelled ? "cancelled" : "error",
          detail: `${errorDescription.code}: ${errorDescription.detail}`,
          threadId: runHandle.turnId,
        },
      });
      notify(
        answerArrived
          ? "A válasz megérkezett; a lezárás utóellenőrzése nem sikerült"
          : wasCancelled
            ? `${providerName}-kérés megszakítva`
            : errorDescription.notification,
        hasStreamedAnswer || wasCancelled ? undefined : "notify",
      );
    } finally {
      setAgentStatusRevision((current) => current + 1);
      if (runsRef.current.has(requestId)) {
        setRunStatus(runHandle, { cancelling: false });
          setTurnCompletedRequestId(null);
      }
      markSubmitBusy(runConversationId, false);
      // Gazdátlan futás nincs: a táblából kikerülve a késői eseményei nem
      // találnak haza, tehát eldobódnak — nem pedig „mindenhová" írnak.
      endRun(requestId);
      releaseQueuedSend(runConversationId);
    }
  };

  const copyAnswerToClipboard = async (answer: Message) => {
    await writeTextToClipboard(answer.text);
    notify("A válasz a vágólapra került");
  };

  const regenerateAnswer = (answer: Message) => {
    if (
      viewingActiveRun ||
      submitBusyConversationsRef.current.has(activeConversationId ?? "")
    ) {
      notify("Újragenerálás csak befejezett válasznál indítható");
      return;
    }
    const answerIndex = messagesRef.current.findIndex(
      (message) => message.id === answer.id,
    );
    const source =
      answerIndex >= 0
        ? [...messagesRef.current.slice(0, answerIndex)]
            .reverse()
            .find((message) => message.role === "user")
        : undefined;
    if (!source) {
      notify("Az eredeti prompt nem található");
      return;
    }
    const latestAnswer = [...messagesRef.current]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && Boolean(message.text.trim()),
      );
    if (!messagesShareIdentity(answer, latestAnswer)) {
      notify("Csak a legutóbbi válasz generálható újra");
      return;
    }
    regenerationTargetRef.current = { source, answer };
    inputDraftRef.current = source.text;
    if (inputRef.current) {
      inputRef.current.value = source.text;
      resizeComposerTextarea(inputRef.current);
    }
    quoteInstructionDraftsRef.current = Object.fromEntries(
      (source.quoteRefs ?? []).map((quote) => [quote.id, quote.instruction]),
    );
    setComposerQuotes(source.quoteRefs ?? []);
    setShowDetailedTrace(messageUsesDetailedTrace(source));
    window.setTimeout(() => composerFormRef.current?.requestSubmit(), 0);
  };

  /**
   * Runs the chain again from the coding stage after a rejected review.
   *
   * Not a fresh chain, and not a new question: the plan the reviewer agreed to
   * is handed back as an artifact, so the coder fixes what was objected to
   * instead of re-deciding what to do. The result joins the same panel as the
   * next version rather than opening a second one below it.
   */
  const rerunChainFromCode = async (chainKey: string) => {
    if (!isTauri || !activePipelineRecipe) return;
    if (anyRunActive()) {
      notify("Előbb fejeződjön be a futó kérés.");
      return;
    }
    if (!activeConversationId) {
      notify("A beszélgetés azonosítója hiányzik, a lánc nem indítható újra.");
      return;
    }
    const chainMessages = messagesRef.current.filter(
      (message) =>
        message.pipeline && chainKeyOf(message.pipeline) === chainKey,
    );
    if (chainMessages.length === 0) return;
    const latestVersion = Math.max(
      ...chainMessages.map((message) => iterationOf(message.pipeline!)),
    );
    if (latestVersion >= MAX_CHAIN_ITERATIONS) {
      notify(
        `A lánc már ${MAX_CHAIN_ITERATIONS} kört futott; ennél tovább nem iterál.`,
      );
      return;
    }
    // Newest first by construction: the timeline holds later versions later.
    const newestOfRole = (role: string) =>
      chainMessages.filter((message) => message.pipeline!.stageRole === role).at(-1);
    const objection = newestOfRole("review")?.text.trim();
    if (!objection) {
      notify("A bíráló szövege nélkül nincs mit javítani.");
      return;
    }
    const chainStartsAt = messagesRef.current.indexOf(chainMessages[0]);
    const originalPrompt = [...messagesRef.current.slice(0, chainStartsAt)]
      .reverse()
      .find((message) => message.role === "user")
      ?.text.trim();
    if (!originalPrompt) {
      notify("Az eredeti kérdés nem található, a lánc nem indítható újra.");
      return;
    }
    const startStage = activePipelineRecipe.stages.findIndex(
      (recipeStage) => recipeStage.role === "code",
    );
    if (startStage < 0) {
      notify("A recept nem tartalmaz kódoló szakaszt.");
      return;
    }
    // The plan is carried, not re-run, so the tab that shows it needs its text
    // from here -- the re-run writes no answer of its own under that stage.
    const carried: Record<number, string> = {};
    for (const message of chainMessages) {
      if (message.pipeline!.stageIndex < startStage)
        carried[message.pipeline!.stageIndex] = message.text;
    }
    // The objection travels in its own block rather than as a fourth artifact:
    // stated as history it reads as something that already happened, and the
    // coder's own earlier summary then wins as the thing to repeat.
    const seedArtifacts = [
      newestOfRole("plan") && {
        role: "plan",
        text: newestOfRole("plan")!.text,
        changedFiles: [],
      },
      newestOfRole("code") && {
        role: "code",
        text: newestOfRole("code")!.text,
        changedFiles: [],
      },
    ].filter(Boolean);

    const iteration = latestVersion + 1;
    const requestId = createEntityId();
    const stageRequestIds = activePipelineRecipe.stages.map(
      (_, index) => `${requestId}-stage-${index}`,
    );
    // Az újrafuttatás is egy futás: a gazdája az a beszélgetés, amelyikből
    // indult — nem az, amelyik közben a képernyőre kerül. Azonosító nélkül
    // nincs kinek címezni, tehát el sem indul.
    const rerunConversationId = activeConversationId;
    if (!rerunConversationId) {
      notify("A beszélgetés azonosító nélkül a lánc nem futtatható újra.");
      return;
    }
    setLiveStageChoice(null);
    setLiveRunResume({ chainKey, startStage, iteration, carried });

    // A re-run is a chain, and a chain is read in the detailed layout: the
    // panel it draws has phases. Without this the composer still showed the
    // plain single-agent settings, and the run rendered as if it were one.
    setShowDetailedTrace(true);
    setPipelineMode(true);
    // The elapsed clock counts from the plan's start, and the plan still held
    // the *original* run's timestamp — which is how a one-minute re-run came
    // to report an hour and twenty minutes. This round starts now.
    const rerunStartedAt = Date.now();
    const rerunRun = beginRun({
      requestId,
      ownerConversationId: rerunConversationId,
      ownerConversationKey: threadKey,
      projectPathKey:
        activeMode === "general"
          ? null
          : normalizeConversationKey(activeProjectData.path),
      projectPath: activeMode === "general" ? "" : activeProjectData.path,
      provider: "anthropic",
      clientTurnId: `request:${requestId}`,
      // Az újrafuttatásnak nincs saját élő buborékja: a szakaszok a maguk
      // kérés-azonosítója alatt streamelnek.
      liveMessageId: "",
      turnId: `request:${requestId}`,
      turnTiming: { startedAt: rerunStartedAt },
      plan: EMPTY_PLAN,
      planTextBuffer: {},
      agentMessagePhases: {},
      processedEvents: new Set(),
      completedTerminalTurns: new Set(),
      chainRequestIds: new Set(stageRequestIds),
      answerStream: { meta: null, pending: "", frame: null },
      status: "streaming",
      cancelled: false,
      turnCompleted: false,
      statusLabel: "dolgozik",
      transport: null,
      watchdog: "",
      cancelling: false,
    });
    updateOwnedPlanState(rerunConversationId, {
      turnId: `request:${requestId}`,
      explanation: "",
      steps: [
        {
          id: "client-pre-plan",
          step: prePlanStepLabel(
            activePipelineRecipe.stages[startStage]?.role ?? "code",
          ),
          status: "inProgress",
        },
      ],
      startedAt: rerunStartedAt,
      stepTimes: { "client-pre-plan": { startedAt: rerunStartedAt } },
    });
    try {
      const run = await invoke<PipelineRunResult>("pipeline_send", {
        request: {
          recipeId: activePipelineRecipe.id,
          prompt: originalPrompt,
          conversationId: activeConversationId,
          requestIds: stageRequestIds,
          placeholderRequestId: null,
          images: [],
          cwd: activeMode === "general" ? null : activeProjectData.path,
          sessionId: claudeSessionIds[threadKey] ?? null,
          conversationContext: null,
          maxBudgetUsd: Number(claudeBudgetUsd),
          stageOverrides: activePipelineRecipe.stages.map((_, index) => ({
            model: stageValue(index, "model") || undefined,
            effort: stageValue(index, "effort") || undefined,
            provider: stageProvider(index),
          })),
          startStage,
          seedArtifacts,
          retryFeedback: objection,
          chainId: chainKey,
          iteration,
        },
      });
      // Same as the first pass: the edits go on disk before the answer does.
      const chainSummary = await settleChainGuard(
        run.guard,
        rerunConversationId,
        activeMode === "general" ? null : activeProjectData.path,
      );
      const codeStageIndex = run.stages.reduce(
        (last, stage, index) => (stage.role === "code" ? index : last),
        -1,
      );
      const stageMessages: Message[] = run.stages.map((stageResult, stageIndex) => ({
        id: stageResult.answerMessageId ?? crypto.randomUUID(),
        role: "assistant",
        text: stageResult.succeeded
          ? stageResult.text
          : `A(z) ${STAGE_ROLE_LABELS[stageResult.role] ?? stageResult.role} szakasz megszakadt: ${stageResult.error ?? "ismeretlen hiba"}`,
        time: "most",
        live: false,
        final: true,
        turnId: `request:${stageResult.requestId}`,
        itemId: "assistant-0",
        changeSummary:
          stageIndex === codeStageIndex && chainSummary.length > 0
            ? chainSummary
            : undefined,
        pipeline: {
          runId: run.runId,
          chainId: run.chainId,
          iteration: run.iteration,
          stageIndex: stageResult.index,
          stageCount: run.recipe.stages.length,
          stageRole: stageResult.role,
          stageAgent: stageResult.agentLabel,
          verdict: stageResult.review?.verdict,
          verdictSummary: stageResult.review?.summary,
        },
      }));
      settleAnswerStream(rerunRun);
      writeOwnedMessages(rerunConversationId, (current) => {
        // The same swap as the first run: the re-run's stages streamed into
        // live bubbles, and these are the stored copies of them.
        const stagePrefix = `request:${requestId}-stage-`;
        const kept = current.filter(
          (message) => !message.turnId?.startsWith(stagePrefix),
        );
        const lastSequence = kept.reduce(
          (highest, message) => Math.max(highest, message.sequence ?? 0),
          0,
        );
        return [
          ...kept,
          ...stageMessages.map((message, index) => ({
            ...message,
            sequence: lastSequence + 1 + index,
          })),
        ];
      });
      // Open on what was just produced. Without this an explicit earlier pick
      // would pin the panel to the version the user was reading when they
      // pressed the button.
      setSelectedVersions((current) => ({
        ...current,
        [chainKey]: run.iteration,
      }));
      const lastSession = [...run.stages]
        .reverse()
        .find((stageResult) => stageResult.sessionId)?.sessionId;
      if (lastSession)
        setClaudeSessionIds((current) => ({
          ...current,
          [threadKey]: lastSession,
        }));
      if (run.status === "failed" && run.error) notify(run.error);
    } catch (error) {
      notify(
        `A lánc újrafuttatása nem sikerült: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setPipelineProgress(null);
      setLiveRunResume(null);
      setRunStatus(rerunRun, { cancelling: false });
      endRun(requestId);
      releaseQueuedSend(rerunConversationId);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) {
      const textarea = event.currentTarget;
      const cursor = textarea.selectionStart;
      const beforeCursor = textarea.value.slice(0, cursor);
      const currentLine = beforeCursor.slice(
        beforeCursor.lastIndexOf("\n") + 1,
      );
      const numberedLine = currentLine.match(/^(\s*)(\d+)\)/);
      if (!numberedLine) return;
      event.preventDefault();
      const insertion = `\n${numberedLine[1]}${Number(numberedLine[2]) + 1}) `;
      textarea.setRangeText(insertion, cursor, textarea.selectionEnd, "end");
      const quoteId = textarea.dataset.quoteId;
      if (quoteId) {
        quoteInstructionDraftsRef.current[quoteId] = textarea.value;
      } else inputDraftRef.current = textarea.value;
      requestAnimationFrame(() => {
        const position = cursor + insertion.length;
        textarea.focus();
        textarea.setSelectionRange(position, position);
        resizeComposerTextarea(textarea);
      });
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const newConversationForProject = (project: Project) => {
    activeModeRef.current = "coding";
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, "coding");
    setActiveMode("coding");
    const baseTitle = "Új beszélgetés";
    const archivedTitles = tombstones
      .filter(
        (tombstone) =>
          tombstone.entityType === "conversation" &&
          tombstoneMatchesProjectScope(tombstone, project),
      )
      .map((tombstone) => tombstone.title)
      .filter((title): title is string => Boolean(title));
    const title = uniqueConversationTitle(project, baseTitle, archivedTitles);
    const conversationId = createEntityId();
    markProjectMutation();
    setProjects((current) =>
      current.map((candidate) =>
        candidate.id === project.id
          ? { ...candidate, threads: [...candidate.threads, title] }
          : candidate,
      ),
    );
    setActiveProject(project.name);
    setActiveThread(title);
    if (isTauri) {
      setLocalConversationCache((current) => ({
        ...current,
        [`${project.path}/${title}`]: {
          id: conversationId,
          scope: "coding",
          projectId: project.id,
          title,
          messages: [],
          workItems: [],
          threadId: null,
          updatedAt: new Date().toISOString(),
        },
      }));
    }
    commitMessages([]);
    setCodeActivity([]);
    setCommentaryEntries([]);
    setPlanHistory({});
    setActivePlan({ turnId: null, explanation: "", steps: [] });
    setViewCodeStatus("készen");
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
    setExpandedWorkLogs({});
    setCommandsOpen(false);
    setOpenMenu(null);
    notify(`Új beszélgetés indult: ${title}`);
  };

  const newConversation = () => {
    const project =
      projects.find((candidate) => candidate.name === activeProject) ??
      projects[0];
    if (!project) {
      notify("Előbb adj hozzá egy projektmappát");
      return;
    }
    newConversationForProject(project);
  };

  const selectProject = (project: Project) => {
    // Olvasni futás közben is szabad: a futás a saját beszélgetésébe ír, nem
    // abba, ami a képernyőn van. A *módosítás* (átnevezés, törlés, új
    // beszélgetés) továbbra is zárolt — az a futás alól húzná ki a talajt.
    activeModeRef.current = "coding";
    localStorage.setItem(ACTIVE_MODE_STORAGE_KEY, "coding");
    setActiveMode("coding");
    const thread =
      project.name === activeProject && project.threads.includes(activeThread)
        ? activeThread
        : preferredThreadForProject(
            project,
            localConversationCacheRef.current,
            "",
          );
    setActiveProject(project.name);
    setActiveThread(thread);
    openCodingConversation(project, thread);
    setOpenProjects((current) => ({ ...current, [project.path]: true }));
  };

  const workGroupHasVisibleTrace = (group: WorkLogGroup) =>
    Boolean(planForWorkGroup(group)?.steps.length) ||
    commentaryForWorkGroup(group).some(
      (commentary) => commentary.body.trim().length > 0,
    ) ||
    group.activities.some(
      (activity) =>
        (activity.kind === "reasoning" && Boolean(activity.body?.trim())) ||
        (activity.kind !== "status" &&
          Boolean(activity.label?.trim() || activity.detail?.trim())) ||
        Boolean(
          activity.code?.trim() ||
            activity.beforeCode?.trim() ||
            activity.afterCode?.trim(),
        ),
    );
  const latestWorkGroup = [...workLogGroups]
    .reverse()
    .find(workGroupHasVisibleTrace);
  const viewedTurnId = viewedRun?.turnId;
  const activeWorkGroup = viewingActiveRun
    ? findActiveWorkGroup(workLogGroups, messages, viewedTurnId)
    : undefined;
  const currentWorkGroup =
    activeWorkGroup ??
    (viewedTurnId
      ? workLogGroups.find((group) =>
          workGroupTurnKeys(group).includes(viewedTurnId),
        )
      : undefined);
  const messageBelongsToWorkGroup = (
    message: Message,
    messageIndex: number,
    group: WorkLogGroup,
  ) => {
    if (timelineMessageBelongsToWorkGroup(messages, messageIndex, group))
      return true;
    if (
      message.turnId ||
      group.userMessageKey ||
      message.role !== "assistant" ||
      message.live
    )
      return false;
    // Older persisted messages did not carry a turn id and some old work
    // items used a different sequence clock. In that case the visual trace
    // is paired with the nearest completed assistant row immediately before
    // it (the timeline already keeps both sides chronologically sorted).
    const completedAssistants = messages
      .map((candidate, index) => ({ candidate, index }))
      .filter(
        ({ candidate }) =>
          candidate.role === "assistant" &&
          !candidate.live &&
          candidate.text.trim().length > 0,
      );
    const nearest = completedAssistants.reduce<
      { candidate: Message; index: number } | undefined
    >((current, item) => {
      if (!current) return item;
      const currentDistance = Math.abs(
        (current.candidate.sequence ?? current.index) - group.sequence,
      );
      const itemDistance = Math.abs(
        (item.candidate.sequence ?? item.index) - group.sequence,
      );
      return itemDistance < currentDistance ? item : current;
    }, undefined);
    return nearest?.index === messageIndex;
  };
  const isInterruptedAssistantText = (text: string) => {
    if (text.toLowerCase().includes("megszak")) return true;
    return /(?:^|\n\n)A válasz megszakítva\.?\s*$/i.test(text.trim());
  };
  const answerForWorkGroup = (group: WorkLogGroup) => {
    const candidates = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message, index }) =>
          message.role === "assistant" &&
          !message.live &&
          message.text.trim().length > 0 &&
          messageBelongsToWorkGroup(message, index, group),
      );
    const nonInterrupted = [...candidates]
      .reverse()
      .find(
        ({ message }) =>
          !isInterruptedAssistantText(message.text) &&
          !message.text.toLowerCase().includes("megszak"),
      );
    if (nonInterrupted) return nonInterrupted.message;
    if (candidates.length > 0) return candidates[candidates.length - 1].message;
    // A trace without a user bucket has no reliable owner. Never attach the
    // nearest answer to it: stale plan metadata would otherwise render an
    // orphaned VÃLASZ card before the first visible user message.
    return undefined;
  };
  const workGroupForMessage = (message: Message, messageIndex: number) =>
    workLogGroups.find(
      (group) =>
        // A chain stage always has a card of its own, even when its steps were
        // recorded against the provider's thread rather than its request. The
        // row must give way to that card, or the stage is shown twice.
        (Boolean(message.pipeline) || workGroupHasVisibleTrace(group)) &&
        messageBelongsToWorkGroup(message, messageIndex, group),
    );
  const allQuoteRefs = messages.flatMap((message) => message.quoteRefs ?? []);
  const userMessageForWorkGroup = (group: WorkLogGroup) =>
    group.userMessageKey
      ? messages.find((message, index) => {
          if (message.role !== "user") return false;
          const key = message.id ?? `user:${message.sequence ?? index}`;
          return key === group.userMessageKey;
        })
      : undefined;
  const workGroupUsesDetailedTrace = (group: WorkLogGroup) => {
    const userMessage = userMessageForWorkGroup(group);
    return userMessage ? messageUsesDetailedTrace(userMessage) : true;
  };
  type ChainStage = {
    stageIndex: number;
    role: string;
    agent: string;
    iteration: number;
    runId: string;
    verdict?: string;
    verdictSummary?: string;
  };
  // Every iteration of one question, in one bucket. A re-run adds later
  // versions of the stages it re-ran, not a second chain.
  const stagesByChain = new Map<string, ChainStage[]>();
  for (const entry of timelineEntries) {
    if (entry.kind !== "work") continue;
    const stage = answerForWorkGroup(entry.group)?.pipeline;
    if (!stage) continue;
    const key = chainKeyOf(stage);
    const stages = stagesByChain.get(key) ?? [];
    stages.push({
      stageIndex: stage.stageIndex,
      role: stage.stageRole,
      agent: stage.stageAgent,
      iteration: iterationOf(stage),
      runId: stage.runId,
      verdict: stage.verdict,
      verdictSummary: stage.verdictSummary,
    });
    stagesByChain.set(key, stages);
  }
  for (const stages of stagesByChain.values())
    stages.sort(
      (left, right) =>
        left.iteration - right.iteration || left.stageIndex - right.stageIndex,
    );
  /**
   * The stage a given version shows in a given slot.
   *
   * A re-run resumes at the coder, so v2 has no plan of its own -- and a TERV
   * tab that goes blank on v2 would read as "the plan was thrown away" when in
   * fact it is the one thing both versions agree on. The newest version at or
   * before the one being read wins, so the carried-over plan simply stays.
   */
  const stageForVersion = (
    chain: ChainStage[],
    iteration: number,
    stageIndex: number,
  ) =>
    chain
      .filter(
        (item) => item.stageIndex === stageIndex && item.iteration <= iteration,
      )
      .at(-1);
  const versionsOfChain = (chain: ChainStage[]) => [
    ...new Set(chain.map((item) => item.iteration)),
  ];
  const slotsOfChain = (chain: ChainStage[]) =>
    [...new Set(chain.map((item) => item.stageIndex))].sort(
      (left, right) => left - right,
    );

  // While a chain runs, its finished stages belong to the live panel. Left in
  // the timeline they piled up as separate cards under the question, which is
  // how a single answer turned into a wall of stacked windows.
  const liveRunOuterRequestId = pipelineProgress
    ? pipelineProgress.requestId.replace(/-stage-\d+$/, "")
    : null;
  const liveRunStagePrefix = liveRunOuterRequestId
    ? `request:${liveRunOuterRequestId}-stage-`
    : null;

  const timelineContent = timelineEntries
    .filter((entry) => activeMode === "coding" || entry.kind === "message")
    .map((entry) => {
    if (liveRunStagePrefix && liveRunOuterRequestId) {
      // Only answers. The question carries the same turn id, and hiding that
      // is exactly the bug this was meant to fix.
      const turnId =
        entry.kind === "message"
          ? entry.message.role === "assistant"
            ? entry.message.turnId
            : undefined
          : // The settled answer first, then the bubble the running stage is
            // still streaming into: `answerForWorkGroup` only considers rows
            // that have finished, so mid-run the group looked like it belonged
            // to nobody and drew itself as a loose card beside the panel that
            // owns it.
            (answerForWorkGroup(entry.group)?.turnId ??
            messages.find(
              (message, index) =>
                message.role === "assistant" &&
                message.live &&
                messageBelongsToWorkGroup(message, index, entry.group),
            )?.turnId);
      // The stage answers are one thing, and the outer request's own settled
      // bubble is another: while the chain runs the frontend only knows the
      // latter, and left alone it drew a finished phase as a separate card
      // above the panel that owns it.
      if (
        turnId?.startsWith(liveRunStagePrefix) ||
        turnId === `request:${liveRunOuterRequestId}`
      )
        return null;
    }
    if (entry.kind === "message") {
      // A persisted turn may contain an empty assistant row when the app was
      // closed before any final text was stored. Do not silently erase that
      // half of the conversation: render an explicit, truthful recovery
      // marker after its user prompt instead of an empty bordered line.
      if (
        entry.message.role === "assistant" &&
        !entry.message.text.trim() &&
        !(entry.message.images && entry.message.images.length > 0)
      ) {
        const previousMessage = messages[entry.messageIndex - 1];
        if (entry.message.live || previousMessage?.role !== "user") return null;
        return (
          <MessageRow
            key={entry.key}
            message={{
              ...entry.message,
              text: "Ehhez a kéréshez nem maradt eltárolt válasz.",
              live: false,
              final: true,
            }}
            projectPath={activeProjectPath}
            isFinal
            onQuoteJump={stableJumpToQuote}
          />
        );
      }
      const nextMessage = messages[entry.messageIndex + 1];
      const isFinal =
        entry.message.role === "assistant"
          ? isSettledHistoricalAssistant(
              entry.message,
              nextMessage?.role,
              Boolean(entry.message.images?.length),
            )
          : entry.message.final;
      if (entry.message.role === "assistant" && !isFinal) return null;
      // Before the chain stopped persisting it, the outer request's live
      // bubble was saved alongside the stage answers -- the same text twice,
      // once with a badge and once without. Hide the copy that has no stage.
      if (
        entry.message.role === "assistant" &&
        !entry.message.pipeline &&
        entry.message.turnId &&
        messages.some((other) =>
          other.turnId?.startsWith(`${entry.message.turnId}-stage-`),
        )
      )
        return null;
      const showAvatar =
        entry.message.role === "user" ||
        messages[entry.messageIndex - 1]?.role !== "assistant";
      const associatedGroup =
        activeMode === "coding" && entry.message.role === "assistant" && isFinal
          ? workGroupForMessage(entry.message, entry.messageIndex)
          : undefined;
      // Hide the standalone row only when this exact logical message is the
      // answer rendered inside the trace card. A stale group can overlap more
      // than one historical assistant row; suppressing every associated row
      // made valid earlier answers disappear from Work 3.
      const associatedGroupAnswer = associatedGroup
        ? answerForWorkGroup(associatedGroup)
        : undefined;
      if (messagesShareIdentity(entry.message, associatedGroupAnswer))
        return null;
      return (
        <MessageRow
          key={entry.key}
          message={entry.message}
          projectPath={activeProjectPath}
          isFinal={isFinal}
          showAvatar={showAvatar}
          onQuoteJump={stableJumpToQuote}
          // Offered on prompts that have something after them; the newest one
          // has nothing to return from.
          onRevert={
            isTauri &&
            entry.message.role === "user" &&
            entry.messageIndex < messages.length - 1
              ? stableRevertToMessage
              : undefined
          }
        />
      );
    }
    if (viewingActiveRun && entry.group.key === activeWorkGroup?.key)
      return null;
    const groupAnswer = answerForWorkGroup(entry.group);
    // A quote-only/aborted turn can leave plan metadata behind without an
    // assistant answer. Rendering that orphaned trace produces a stray
    // horizontal rule between messages, so keep the timeline clean.
    if (!groupAnswer?.text.trim()) return null;
    const storedPlan = planForWorkGroup(entry.group, groupAnswer.turnId);
    const groupCommentary = commentaryForWorkGroup(
      entry.group,
      groupAnswer.turnId,
    );
    if (!groupAnswer.pipeline && !workGroupHasVisibleTrace(entry.group))
      return null;
    // The same legacy leftover as in the message branch, but this copy owns a
    // work group of its own and would draw a full card above its own run.
    if (
      !groupAnswer.pipeline &&
      groupAnswer.turnId &&
      messages.some((other) =>
        other.turnId?.startsWith(`${groupAnswer.turnId}-stage-`),
      )
    )
      return null;
    const isLatestGroup = entry.group.key === latestWorkGroup?.key;
    const isCurrentGroup = entry.group.key === currentWorkGroup?.key;
    // A completed turn should open on its answer after a restart as well.
    // The live card owns the expanded LÉPÉSEK state while streaming; falling
    // back to `true` here made a recovered final answer look missing behind
    // the steps panel until the user clicked VÁLASZ.
    const expanded = expandedForWorkGroup(
      entry.group,
      isLatestGroup && viewingActiveRun,
    );
    const compact = !workGroupUsesDetailedTrace(entry.group);
    const basePlan =
      storedPlan ??
      (isCurrentGroup
        ? activePlan
        : {
            turnId: entry.group.key,
            explanation: "",
            steps: [
              {
                id: "legacy",
                step: "Korábbi munkamenet",
                status: "completed" as const,
              },
            ],
          });
    const plan: PlanSnapshot = settleHistoricalPlan(isCurrentGroup
      ? {
          ...basePlan,
          startedAt: basePlan.startedAt ?? activePlan.startedAt,
          completedAt: basePlan.completedAt ?? activePlan.completedAt,
          stepTimes:
            basePlan.stepTimes || activePlan.stepTimes
              ? {
                  ...(activePlan.stepTimes ?? {}),
                  ...(basePlan.stepTimes ?? {}),
                }
              : undefined,
        }
      : basePlan);
    const stage = groupAnswer.pipeline;
    const chainKey = stage ? chainKeyOf(stage) : "";
    const chain = stage ? (stagesByChain.get(chainKey) ?? []) : [];
    const chainVersions = versionsOfChain(chain);
    const latestVersion = chainVersions.at(-1) ?? 1;
    const selectedVersion = stage
      ? (selectedVersions[chainKey] ?? latestVersion)
      : 1;
    const chainSlots = slotsOfChain(chain);
    // The strip is built from the chain's slots, so a re-run that skipped the
    // planner still shows a TERV tab -- filled by the version that wrote it.
    const runStages = chainSlots
      .map((slot) => stageForVersion(chain, selectedVersion, slot))
      .filter((item): item is ChainStage => Boolean(item));
    const lastStageIndex = chainSlots.at(-1) ?? 0;
    // -1 is the composed answer: what the chain did, in the words of whoever
    // did it, instead of the reviewer's opinion of the coder.
    const selectedStage = stage
      ? (selectedStages[chainKey] ?? PIPELINE_ANSWER_TAB)
      : 0;
    // Only the chosen phase draws itself; the others are one click away. The
    // answer tab has no stage of its own, so the last one hosts it. Matched on
    // the run as well as the slot: two versions own the same slot, and without
    // the run id both of them would draw the panel.
    const shownStage = stage
      ? stageForVersion(
          chain,
          selectedVersion,
          selectedStage === PIPELINE_ANSWER_TAB ? lastStageIndex : selectedStage,
        )
      : undefined;
    if (
      stage &&
      (shownStage?.runId !== stage.runId ||
        shownStage?.stageIndex !== stage.stageIndex)
    )
      return null;
    // Past the deduplication above, so exactly one entry of the chain stands
    // in for it. A re-run belongs to the panel it was started from, not to the
    // bottom of the conversation; the live card is assembled further down the
    // file, so this leaves a marker and the card is dropped in afterwards —
    // cheaper than hoisting half the render above the timeline.
    // Deliberately not waiting for `pipelineProgress`: that arrives with the
    // first stage, and until then the card would render at the bottom and then
    // jump into place — which is exactly the "it started a new conversation"
    // moment this is meant to remove. `liveRunResume` is set before the run is
    // even asked for.
    if (stage && liveRunResume?.chainKey === chainKey) {
      return LIVE_RERUN_SLOT;
    }
    // The verdict of the version being read, not of the newest one: a reader
    // who went back to v1 is looking at what v1 concluded.
    const runVerdict = stageForVersion(chain, selectedVersion, lastStageIndex);
    const runHeader = stage ? (
        <div className="pipeline-run-header" data-run-id={chainKey}>
          <span
            className="pipeline-run-tabs"
            role="tablist"
            style={{ "--tab-count": runStages.length + 1 } as CSSProperties}
          >
            <span
              className="pipeline-run-slider"
              aria-hidden="true"
              style={{
                transform: `translateX(${
                  (selectedStage === PIPELINE_ANSWER_TAB
                    ? 0
                    : chainSlots.indexOf(selectedStage) + 1) * 100
                }%)`,
              }}
            />
            {[
              { key: PIPELINE_ANSWER_TAB, label: "VÁLASZ", agent: "" },
              ...runStages.map((item) => ({
                key: item.stageIndex,
                label: `${item.stageIndex + 1}/${stage.stageCount} ${STAGE_ROLE_LABELS[item.role] ?? item.role}`,
                agent: item.agent,
              })),
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={item.key === selectedStage}
                // The phase that carries the verdict says so in the strip as
                // well, so a run's outcome is readable without opening it.
                className={`pipeline-run-tab${item.key === selectedStage ? " is-active" : ""}${
                  item.key === lastStageIndex && runVerdict?.verdict
                    ? runVerdict.verdict === "accepted"
                      ? " is-verdict-accepted"
                      : " is-verdict-changes"
                    : ""
                }`}
                title={item.agent}
                onClick={() => {
                  setSelectedStages((current) => ({
                    ...current,
                    [chainKey]: item.key,
                  }));
                  // A longer phase used to open below the fold, leaving the
                  // reader to scroll for the answer they just asked for. The
                  // composer floats over the stream, so aligning to the bottom
                  // of the window still hides the end of the panel.
                  // Looked up again rather than captured: the header this
                  // click came from is replaced by the re-render, and a
                  // detached node measures as nothing.
                  window.setTimeout(
                    () =>
                      revealPanelBottom(
                        document.querySelector(
                          `.pipeline-run-header[data-run-id="${chainKey}"]`,
                        )?.nextElementSibling ?? null,
                      ),
                    80,
                  );
                }}
              >
                {item.label}
              </button>
            ))}
          </span>
          {chainVersions.length > 1 && (
            // A re-run does not replace what it was answering: both attempts
            // stay readable, and this picks which one the panel is showing.
            <label className="pipeline-run-version">
              <span>VERZIÓ</span>
              <select
                value={selectedVersion}
                onChange={(event) =>
                  setSelectedVersions((current) => ({
                    ...current,
                    [chainKey]: Number(event.target.value),
                  }))
                }
              >
                {chainVersions.map((version) => (
                  <option key={version} value={version}>
                    {`v${version}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ) : undefined;
    const askForTheFix = () => {
      const reason = runVerdict?.verdictSummary?.trim();
      const draft = reason
        ? `A bíráló ezt kifogásolta: ${reason}
Javítsd ki, majd futtasd le újra a teszteket.`
        : "Javítsd ki, amit a bíráló kifogásolt, majd futtasd le újra a teszteket.";
      inputDraftRef.current = draft;
      if (inputRef.current) {
        inputRef.current.value = draft;
        resizeComposerTextarea(inputRef.current);
        inputRef.current.focus();
      }
    };
    // A rejected verdict used to end the run on a red panel and a shrug: the
    // only affordance wrote a draft into the composer and left the sending to
    // the reader. This re-runs the chain itself, from the coder -- the plan was
    // what the reviewer agreed to, and re-planning only risks drifting off it.
    const rejected = runVerdict?.verdict === "changes_requested";
    const atNewestVersion = selectedVersion === latestVersion;
    const canRerun =
      rejected &&
      atNewestVersion &&
      latestVersion < MAX_CHAIN_ITERATIONS &&
      !viewingActiveRun;
    // On the answer and on the review, which are the two places the verdict is
    // stated. The plan and the code tabs are what the run did, not what it
    // concluded, and a call to action there reads as belonging to that phase.
    const footerBelongsHere =
      selectedStage === PIPELINE_ANSWER_TAB || selectedStage === lastStageIndex;
    const runFooter =
      rejected && atNewestVersion && footerBelongsHere ? (
        <div className="pipeline-answer-next">
          <span>
            {latestVersion < MAX_CHAIN_ITERATIONS
              ? "A bíráló javítást kér."
              : `A lánc ${MAX_CHAIN_ITERATIONS} kört futott, és még mindig javítást kér. Innen érdemesebb kézbe venni.`}
          </span>
          {latestVersion < MAX_CHAIN_ITERATIONS && (
            <button
              type="button"
              disabled={!canRerun}
              title={
                viewingActiveRun
                  ? "Előbb fejezze be a futó kérés."
                  : "A tervet megtartja, a kódolást és a bírálatot futtatja újra."
              }
              onClick={() => void rerunChainFromCode(chainKey)}
            >
              {`Újra a KÓD-tól (v${latestVersion + 1})`}
            </button>
          )}
          <button type="button" className="is-secondary" onClick={askForTheFix}>
            Javíttatom
          </button>
        </div>
      ) : undefined;
    if (stage && selectedStage === PIPELINE_ANSWER_TAB) {
      // Composed here rather than asked of a fourth model: the coder already
      // wrote what changed, and the reviewer already said whether to trust it.
      const coder = runStages.find((item) => item.role === "code");
      const doer = messages.find(
        (message) =>
          message.pipeline?.runId === coder?.runId &&
          message.pipeline?.stageRole === "code",
      );
      const answerText = (doer ?? groupAnswer).text;
      return (
        <Fragment key={entry.key}>
          {runHeader}
          <article className="trace-card in-run is-run-end pipeline-answer-card">
            <div className="pipeline-answer-body">
              {answerParagraphs(textWithoutCodeBlocks(answerText))}
            </div>
            {runFooter}
          </article>
        </Fragment>
      );
    }
    return (
      <TurnProgressCard
        key={entry.key}
        runPosition={stage ? "end" : undefined}
        runTone={
          groupAnswer.pipeline?.verdict
            ? groupAnswer.pipeline.verdict === "accepted"
              ? "accepted"
              : "changes"
            : undefined
        }
        runHeader={runHeader}
        runFooter={runFooter}
        plan={plan}
        activities={entry.group.activities}
        commentary={groupCommentary}
        status={isCurrentGroup ? codeStatus : "kész"}
        streaming={false}
        expanded={expanded}
        transport={null}
        watchdogMessage=""
        answer={groupAnswer}
        quoteRefs={allQuoteRefs}
        quoteAnchorPrefix={`trace:${entry.group.key}`}
        onQuoteJump={stableJumpToQuote}
        compact={compact}
        onCopyAnswer={copyAnswerToClipboard}
        onRegenerate={regenerateAnswer}
        onRollbackChanges={
          isCurrentGroup && undoableSnapshot
            ? () => void rollbackAgentChanges()
            : undefined
        }
        rollbackBusy={agentRollbackBusy}
        onPreviewImage={openImagePreview}
        onToggle={() =>
          setExpandedForWorkGroup(entry.group, !expanded)
        }
      />
    );
  });
  const liveWorkGroup = activeWorkGroup;
  const liveTurnKey = liveWorkGroup?.key ?? activePlan.turnId ?? "current";
  const liveTurnId = activePlan.turnId ?? viewedRun?.turnId;
  const liveExpanded = liveWorkGroup
    ? expandedForWorkGroup(liveWorkGroup, true)
    : Object.prototype.hasOwnProperty.call(expandedWorkLogs, liveTurnKey)
      ? expandedWorkLogs[liveTurnKey]
      : (expandedWorkLogChoicesRef.current[liveTurnKey] ?? true);
  // A stage that has started but not yet streamed has no bubble of its own,
  // and the newest "live" row can then be a leftover from an earlier run --
  // which is how the panel came to show a verdict while the coder was working.
  // While a chain runs, only the running stage's own bubble counts.
  const liveAnswer = pipelineProgress
    ? messages.find(
        (message) =>
          message.role === "assistant" &&
          message.live &&
          message.turnId === `request:${pipelineProgress.requestId}`,
      )
    : [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.live);
  const activeUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const liveCompact = activeUserMessage
    ? !messageUsesDetailedTrace(activeUserMessage)
    : !showDetailedTrace;
  // Everything a running chain shows lives in one panel. Its phases are known
  // the moment it starts, so the strip is complete from the first second and
  // the marker simply follows the phase that is running.
  const liveRunStages = pipelineProgress
    ? (activePipelineRecipe?.stages.map((stage, index) => ({
        index,
        role: stage.role,
      })) ??
      Array.from({ length: pipelineProgress.stageCount }, (_, index) => ({
        index,
        role: index === pipelineProgress.stageIndex ? pipelineProgress.role : "",
      })))
    : [];
  const liveShownStage = pipelineProgress
    ? (liveStageChoice ?? pipelineProgress.stageIndex)
    : 0;
  const liveFinishedStageText = (index: number) => {
    // A re-run carries its earlier phases rather than producing them, so their
    // text comes from the version that wrote it, not from this pass.
    const carried = liveRunResume?.carried[index];
    if (carried) return carried;
    const byStage = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.turnId === `request:${liveRunOuterRequestId}-stage-${index}`,
    );
    if (byStage) return byStage.text;
    // Mid-run the only settled copy the frontend has is the outer bubble, and
    // it holds the phase that finished last. Anything older is not in memory
    // yet, so say that instead of showing the wrong phase.
    if (pipelineProgress && index === pipelineProgress.stageIndex - 1)
      return (
        messages.find(
          (message) =>
            message.role === "assistant" &&
            message.turnId === `request:${liveRunOuterRequestId}` &&
            !message.live,
        )?.text ?? ""
      );
    return "Ez a szakasz akkor lesz olvasható, ha a lánc befejeződött.";
  };
  const liveRunHeader = pipelineProgress ? (
    <div className="pipeline-run-header" data-run-id={pipelineProgress.runId}>
      <span
        className="pipeline-run-tabs"
        role="tablist"
        style={{ "--tab-count": liveRunStages.length + 1 } as CSSProperties}
      >
        <span
          className="pipeline-run-slider"
          aria-hidden="true"
          style={{ transform: `translateX(${(liveShownStage + 1) * 100}%)` }}
        />
        <button
          type="button"
          className="pipeline-run-tab"
          disabled
          title="A válasz a lánc végén készül el"
        >
          VÁLASZ
        </button>
        {liveRunStages.map((stage) => {
          // A szakasz akkor „fut", ha elindult és még nem jelentett vissza.
          // A `phase` eddig sehol nem számított, ezért egy befejezett kódolás
          // a következő szakasz indulásáig futóként látszott — a köztes
          // várakozás így nem hazudik többé.
          const stageStarted = stage.index === pipelineProgress.stageIndex;
          const stageSettled =
            stageStarted && pipelineProgress.phase !== "started";
          const done =
            stage.index < pipelineProgress.stageIndex ||
            stage.index < (liveRunResume?.startStage ?? 0) ||
            stageSettled;
          const running = stageStarted && !stageSettled;
          return (
            <button
              key={stage.index}
              type="button"
              role="tab"
              aria-selected={stage.index === liveShownStage}
              disabled={!done && !running}
              className={`pipeline-run-tab${stage.index === liveShownStage ? " is-active" : ""}${running ? " is-running" : ""}${stageSettled && pipelineProgress.phase === "failed" ? " is-failed" : ""}`}
              title={
                running
                  ? "Ez a szakasz dolgozik"
                  : stageSettled
                    ? pipelineProgress.phase === "failed"
                      ? "Ez a szakasz hibára futott"
                      : "Kész; a következő szakasz indulására vár"
                    : undefined
              }
              onClick={() =>
                setLiveStageChoice(running ? null : stage.index)
              }
            >
              {`${stage.index + 1}/${pipelineProgress.stageCount} ${STAGE_ROLE_LABELS[stage.role] ?? stage.role}`}
            </button>
          );
        })}
      </span>
      {liveRunResume && liveRunResume.iteration > 1 && (
        // Says which round is running, so a re-run is not mistaken for the
        // original chain starting over from nothing.
        <span className="pipeline-run-version is-live">
          {`v${liveRunResume.iteration}`}
        </span>
      )}
    </div>
  ) : undefined;
  const liveFinishedStagePanel =
    pipelineProgress && liveShownStage !== pipelineProgress.stageIndex ? (
      <article className="trace-card in-run is-run-end pipeline-answer-card">
        <div className="pipeline-answer-body">
          {answerParagraphs(
            textWithoutCodeBlocks(liveFinishedStageText(liveShownStage)),
          )}
        </div>
      </article>
    ) : null;
  // A chain finishes a turn per stage, so between two stages the completed
  // request is still the active one and this panel used to unmount -- while the
  // settled stage cards stayed hidden, because the run that owns them is still
  // going. The result was the whole answer blinking out of existence for a few
  // seconds at every hand-off. A chain is one panel from its first second to
  // its last, so a stage boundary is not a reason to take it down.
  const liveTurnContent =
    activeMode === "coding" &&
    viewingActiveRun &&
    (!activeTurnHasCompleted || Boolean(pipelineProgress)) && (
      <div className="live-turn-anchor">
        {liveFinishedStagePanel ? (
          <>
            {liveRunHeader}
            {liveFinishedStagePanel}
          </>
        ) : (
        <TurnProgressCard
          runPosition={pipelineProgress ? "end" : undefined}
          runHeader={liveRunHeader}
          stageRole={pipelineProgress?.role}
          plan={activePlan}
          activities={liveWorkGroup?.activities ?? []}
          commentary={
            liveWorkGroup
              ? commentaryForWorkGroup(liveWorkGroup)
              : commentaryEntries.filter((commentary) =>
                  Boolean(liveTurnId && commentary.turnId === liveTurnId),
                )
          }
          status={codeStatus}
          streaming={viewingActiveRun && !activeTurnHasCompleted}
          expanded={liveExpanded}
          transport={transportStatus}
          watchdogMessage={watchdogMessage}
          answer={liveAnswer}
          quoteRefs={allQuoteRefs}
          quoteAnchorPrefix={`trace:${liveTurnKey}`}
          onQuoteJump={stableJumpToQuote}
          compact={liveCompact}
          onCopyAnswer={copyAnswerToClipboard}
          onRegenerate={regenerateAnswer}
          onRollbackChanges={
            undoableSnapshot ? () => void rollbackAgentChanges() : undefined
          }
          rollbackBusy={agentRollbackBusy}
          onPreviewImage={openImagePreview}
          onToggle={() =>
            setExpandedForKeys(
              [
                liveTurnKey,
                ...(liveWorkGroup ? workGroupExpansionKeys(liveWorkGroup) : []),
              ],
              !liveExpanded,
            )
          }
        />
        )}
      </div>
    );
  // A re-run draws itself inside the panel it belongs to; everything else
  // still streams below the conversation, where a new answer belongs.
  const rerunInPlace = Boolean(liveRunResume && pipelineProgress);
  const timelineWithLiveRerun = rerunInPlace
    ? timelineContent.map((node) =>
        node === LIVE_RERUN_SLOT ? liveTurnContent : node,
      )
    : timelineContent.filter((node) => node !== LIVE_RERUN_SLOT);
  const generalLiveTurnContent =
    activeMode === "general" && viewingActiveRun && liveAnswer ? (
      <div className="general-live-answer">
        <MessageRow
          message={liveAnswer}
          projectPath=""
          isFinal={false}
          onQuoteJump={stableJumpToQuote}
        />
      </div>
    ) : null;

  return (
    <FileActionContext.Provider value={handleFileClick}>
      <div className="app-shell" onClickCapture={handleLocalLinkClickCapture}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">m</div>
          <span className="brand-name">min</span>
          <span className="brand-status">
            <span className="status-dot" /> Codex · local
          </span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Beállítások megnyitása"
          >
            Aa
          </button>
          <button
            className="icon-button"
            onClick={() => setCommandsOpen(true)}
            aria-label="Parancsok megnyitása"
          >
            ⌘K
          </button>
          <button className="profile-button" aria-label="Profil">
            D
          </button>
        </div>
      </header>

      {isTauri &&
        syncHealth?.warnings.some((warning) =>
          warning.includes("helyi sync cursor"),
        ) && (
          <button
            type="button"
            className="footer-action sync-rebuild-action"
            onClick={rebuildSyncFromLocal}
            disabled={syncActionBusyRef.current}
          >
            ⟳ Journal újraépítése a lokálisból
          </button>
        )}

      <main className="workspace">
        <Sidebar
          activeMode={activeMode}
          isTauri={isTauri}
          projects={sortedProjects}
          openProjects={openProjects}
          activeProject={activeProject}
          activeThread={activeThread}
          generalConversations={generalConversations}
          activeGeneralConversationId={activeGeneralConversationId}
          historyHydrating={historyHydrating}
          tombstones={tombstones}
          restoreBusyKey={restoreBusyKey}
          treeSortMode={treeSortMode}
          treeSortMenuOpen={treeSortMenuOpen}
          newProjectMenuOpen={newProjectMenuOpen}
          openMenu={openMenu}
          settingsOpen={settingsOpen}
          readingSettingsOpen={readingSettingsOpen}
          fontSize={fontSize}
          lineHeight={lineHeight}
          syncStatus={syncStatus}
          syncHealth={syncHealth}
          syncHealthOpen={syncHealthOpen}
          syncWriteEnabled={syncWriteEnabled}
          conversationRunState={conversationRunState}
          projectIsThinking={projectIsThinking}
          generalConversationCacheKey={generalConversationCacheKey}
          onSelectAppMode={selectAppMode}
          onSelectProject={selectProject}
          onSelectThread={selectThread}
          onSelectGeneralConversation={selectGeneralConversation}
          onToggleProjectOpen={setOpenProjects}
          onOpenMenu={setOpenMenu}
          onNewConversationForProject={newConversationForProject}
          onNewGeneralConversation={newGeneralConversation}
          onRenameProject={renameProject}
          onDeleteProject={deleteProject}
          onRenameThread={renameThread}
          onDeleteThread={deleteThread}
          onRenameGeneralConversation={renameGeneralConversation}
          onDeleteGeneralConversation={deleteGeneralConversation}
          onRestoreTombstone={(tombstone) => void restoreTombstone(tombstone)}
          onAddProject={addProject}
          onAddExistingProject={() => void addExistingProject()}
          onChangeProjectsRoot={() => void changeProjectsRoot()}
          onRefreshSync={refreshSync}
          onSetTreeSortMode={setTreeSortMode}
          onSetTreeSortMenuOpen={setTreeSortMenuOpen}
          onSetNewProjectMenuOpen={setNewProjectMenuOpen}
          onSetSettingsOpen={setSettingsOpen}
          onSetReadingSettingsOpen={setReadingSettingsOpen}
          onSetSyncHealthOpen={setSyncHealthOpen}
          onFontSizeChange={setFontSize}
          onLineHeightChange={setLineHeight}
          onNotify={notify}
        />

        <section
          className={`chat panel-edge${activeMode === "general" ? " is-general" : ""}`}
        >
          <div className="chat-header">
            <div>
              <div className="chat-header-project">
                {activeMode === "general"
                  ? "GENERAL"
                  : historyHydrating
                    ? "Előzmények"
                    : activeProjectData.name}
              </div>
              <div className="chat-header-thread">
                {activeMode === "general"
                  ? activeGeneralConversation?.title ?? "Új beszélgetés"
                  : historyHydrating
                    ? "Betöltés folyamatban…"
                    : activeThread || "Nincs beszélgetés"}
              </div>
              {agentConversationStatus?.hasConflict && (
                <div
                  className="agent-conflict-indicator"
                  role="status"
                  title="A megosztott Claude session egy masik eszkoz agan maradt; a kovetkezo turn uj sessionben folytatodik."
                >
                  Claude session fork
                </div>
              )}
            </div>
          </div>
          <div
            className="message-stream"
            ref={messageStreamRef}
            onScroll={handleMessageScroll}
            onWheelCapture={handleMessageWheel}
          >
            {activeMode === "general" &&
              messages.length === 0 &&
              !viewingActiveRun && (
                <div className="general-home">
                  <div className="general-home-mark">m</div>
                  <h1>Miben segíthetek?</h1>
                  <p>Kérdezz bármit — ez a min mindennapi beszélgetős módja.</p>
                </div>
              )}
            {timelineWithLiveRerun}
            {activeMode === "general"
              ? generalLiveTurnContent
              : rerunInPlace
                ? null
                : liveTurnContent}
            {viewingActiveRun && !isAtBottom && (
              <button
                type="button"
                className="jump-to-bottom"
                onClick={jumpToBottom}
              >
                ↓ Legaljára
              </button>
            )}
          </div>
          <form ref={composerFormRef} className="composer-wrap" onSubmit={submitMessage}>
            {queuedSendConversations.includes(activeConversationId ?? "") && (
              <div className="queued-send" role="status">
                <ThinkingDots label="Küldés a futó válasz után" />
                <span>
                  {activeTurnHasCompleted
                    ? "A válasz kész, a munkaterület mentése folyik — az üzenet ezután indul."
                    : "Az üzenet a futó válasz után indul."}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const id = activeConversationId ?? "";
                    queuedSendRef.current.delete(id);
                    setQueuedSendConversations((current) =>
                      current.filter((candidate) => candidate !== id),
                    );
                  }}
                >
                  Mégse
                </button>
              </div>
            )}
            <div className="composer-controls">
              <div className="composer-controls-top">
                {showDetailedTrace && pipelineRecipes.length > 0 && (
                  <div
                    className="composer-pipeline-switch mode-switch"
                    role="tablist"
                    aria-label="Részletes mód"
                  >
                    <button
                      type="button"
                      className={!pipelineMode ? "is-active" : ""}
                      aria-pressed={!pipelineMode}
                      onClick={() => setPipelineMode(false)}
                    >
                      EGY AI
                    </button>
                    <button
                      type="button"
                      className={pipelineMode ? "is-active" : ""}
                      aria-pressed={pipelineMode}
                      onClick={() => setPipelineMode(true)}
                    >
                      MULTI-AI
                    </button>
                  </div>
                )}
                <label
                  className="composer-detail-toggle"
                  title="Részletes terv, lépések és gondolkodás megjelenítése"
                >
                  <input
                    type="checkbox"
                    checked={showDetailedTrace}
                    onChange={(event) =>
                      setShowDetailedTrace(event.currentTarget.checked)
                    }
                    aria-label="Részletes terv, lépések és gondolkodás"
                  />
                  <span>Részletes</span>
                </label>
              </div>
              {showDetailedTrace && pipelineMode && activePipelineRecipe && (
                <div className="composer-stage-grid" aria-label="Lánc beállítása">
                  {activePipelineRecipe.stages.map((stage, index) => (
                    <div className="composer-stage-col" key={`stage-${index}`}>
                      <span className="composer-stage-role">
                        {STAGE_ROLE_LABELS[stage.role] ?? stage.role}
                      </span>
                      <button
                        type="button"
                        className="composer-stage-vendor"
                        onClick={() => cycleStageValue(index, "vendor", 1)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          cycleStageValue(index, "vendor", -1);
                        }}
                        title="Gyártó — kattints a másikra"
                      >
                        {stageProvider(index) === "anthropic" ? "Claude" : "ChatGPT"}
                      </button>
                      <button
                        type="button"
                        onClick={() => cycleStageValue(index, "model", 1)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          cycleStageValue(index, "model", -1);
                        }}
                        title="Modell — kattints a következőért, jobb klikk visszafelé"
                      >
                        {shortModelLabel(stageValue(index, "model") ?? "")}
                      </button>
                      <button
                        type="button"
                        onClick={() => cycleStageValue(index, "effort", 1)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          cycleStageValue(index, "effort", -1);
                        }}
                        title="Reasoning — kattints a következőért, jobb klikk visszafelé"
                      >
                        {stageValue(index, "effort") || FALLBACK_EFFORTS[0]}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            {pipelineProgress && (
              <div className="composer-pipeline-progress" role="status">
                {`${STAGE_ROLE_LABELS[pipelineProgress.role] ?? pipelineProgress.role} · ${pipelineProgress.agentLabel} · ${pipelineProgress.stageIndex + 1}/${pipelineProgress.stageCount}`}
                {/* A chain that is waiting on the user looks identical to one
                    that is thinking, and that cost a whole run: the stage sat
                    on an approval nobody knew about until it timed out. */}
                {(pendingClaudeApproval || pendingClaudeQuestion) && (
                  <strong className="composer-pipeline-waiting"> · rád vár</strong>
                )}
              </div>
            )}
            </div>
            <div className="composer">
              {composerQuotes.length > 0 && (
                <div className="composer-quotes" aria-label="Kijelölt idézetek">
                  {composerQuotes.map((quote, index) => (
                    <section className="composer-quote" key={quote.id}>
                      <div className="composer-quote-header">
                        <span className="composer-quote-badge">#{index + 1}</span>
                        <button
                          type="button"
                          className="composer-quote-remove"
                          aria-label="Idézet eltávolítása"
                          title="Idézet eltávolítása"
                          onClick={() => {
                            setComposerQuotes((current) =>
                              current.filter((candidate) => candidate.id !== quote.id),
                            );
                            delete quoteInputRefs.current[quote.id];
                            delete quoteInstructionDraftsRef.current[quote.id];
                            inputRef.current?.focus();
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <blockquote>{quote.text}</blockquote>
                      <textarea
                        ref={(element) => {
                          quoteInputRefs.current[quote.id] = element;
                        }}
                        data-quote-id={quote.id}
                        rows={1}
                        defaultValue={quote.instruction}
                        onChange={(event) => {
                          quoteInstructionDraftsRef.current[quote.id] =
                            event.currentTarget.value;
                        }}
                        onInput={(event) => resizeComposerTextarea(event.currentTarget)}
                        onKeyDown={handleInputKeyDown}
                        onPaste={handleInputPaste}
                        placeholder="Mit szeretnél tudni vagy módosítani ezzel kapcsolatban?"
                      />
                    </section>
                  ))}
                </div>
              )}
              {pendingImages.length > 0 && (
                <div className="composer-attachments" aria-label="Csatolt képek">
                  {pendingImages.map((image) => (
                    <div className="composer-attachment" key={image.id}>
                      <img src={image.dataUrl} alt={image.name} />
                      <button
                        type="button"
                        aria-label={`${image.name} eltávolítása`}
                        title="Kép eltávolítása"
                        onClick={() =>
                          setPendingImages((current) =>
                            current.filter((candidate) => candidate.id !== image.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer-input-row">
                <textarea
                ref={inputRef}
                rows={1}
                defaultValue=""
                onInput={(event) => {
                  inputDraftRef.current = event.currentTarget.value;
                  resizeComposerTextarea(event.currentTarget);
                }}
                onKeyDown={handleInputKeyDown}
                onPaste={handleInputPaste}
                placeholder="Írj egy üzenetet, vagy illessz be egy screenshotot…"
                />
              </div>
              {activeMode !== "general" && (
                <input
                  ref={imageInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  tabIndex={-1}
                  onChange={handleImageInputChange}
                />
              )}
              <div className="composer-toolbar">
                <div className="composer-tools">
                  {activeMode !== "general" && (
                    <button
                      type="button"
                      className="tool-button"
                      title="Kép megnyitása"
                      aria-label="Kép megnyitása és csatolása"
                      disabled={imagesPreparing || pendingImages.length >= MAX_IMAGE_ATTACHMENTS}
                      onClick={() => imageInputRef.current?.click()}
                    >
                      ＋
                    </button>
                  )}
                  <ModelPicker
                    disabled={showDetailedTrace && pipelineMode}
                    open={modelMenuOpen}
                    loading={modelsLoading}
                    activeLabel={activeLabel}
                    selectedModel={selectedModel}
                    modelFamilies={modelFamilies}
                    activeEffortLabel={activeEffortLabel}
                    supportedEfforts={supportedEfforts}
                    activeEffortIndex={activeEffortIndex}
                    onToggle={toggleModelMenu}
                    onSelectModel={selectModel}
                    onSelectEffort={selectEffortIndex}
                  />
                </div>
                <button
                  type="submit"
                  className="send-button"
                  aria-label="Üzenet küldése"
                  disabled={imagesPreparing}
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
        </section>
      </main>

      {selectionQuote && (
        <button
          type="button"
          className="quote-selection-button"
          style={{ left: selectionQuote.x, top: selectionQuote.y }}
          aria-label="Kijelölés idézetként a chatbe"
          title="Idézet hozzáadása a chathez"
          onMouseDown={(event) => event.preventDefault()}
          onClick={insertSelectionQuote}
        >
          💬
        </button>
      )}

      {imagePreview && (
        <ImagePreviewOverlay
          path={imagePreview.path}
          source={imagePreview.source}
          error={imagePreview.error}
          onClose={() => setImagePreview(null)}
          onOpenExternal={() => {
            const target = imagePreview.path;
            setImagePreview(null);
            void invoke("run_project_file", {
              cwd: activeProjectPathRef.current || activeProjectPath,
              path: target,
            }).catch((error) =>
              notify(`Nem sikerült megnyitni: ${String(error)}`, "notify"),
            );
          }}
        />
      )}
      {fileActionMenu && (
        <div
          className="file-action-menu"
          role="menu"
          style={{ left: fileActionMenu.x, top: fileActionMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="file-action-path" title={fileActionMenu.path}>
            {fileActionMenu.path}
          </div>
          <button type="button" role="menuitem" onClick={() => void runSelectedFile()}>
            ▶ Futtatás
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void openSelectedFileFolder()}
          >
            ▣ Mappa megnyitása
          </button>
        </div>
      )}

      {appDialog && (
        <AppDialogOverlay
          dialog={appDialog}
          onChangeValue={(value) =>
            setAppDialog((current) =>
              current?.kind === "input" ? { ...current, value } : current,
            )
          }
          onSubmit={submitAppDialog}
          onClose={() => setAppDialog(null)}
        />
      )}
      {pendingClaudeApproval && (
        <ClaudeApprovalOverlay
          request={pendingClaudeApproval}
          onRespond={(decision, reason) =>
            void respondClaudeApproval(decision, reason)
          }
        />
      )}
      {pendingClaudeQuestion && (
        <ClaudeQuestionOverlay
          request={pendingClaudeQuestion}
          draft={claudeQuestionDraft}
          selections={claudeQuestionSelections}
          onDraftChange={setClaudeQuestionDraft}
          onSelectionsChange={setClaudeQuestionSelections}
          onRespond={(answerKey, answer) =>
            void respondClaudeQuestion({ [answerKey]: answer })
          }
        />
      )}
      {toast && (
        <div className="toast is-visible" role="status">
          {toast}
        </div>
      )}
      {commandsOpen && (
        <CommandPaletteOverlay
          onClose={() => setCommandsOpen(false)}
          onNewConversation={newConversation}
          onOpenSettings={() => setSettingsOpen(true)}
          onFindProject={() => notify("Projekt keresése hamarosan")}
          onOpenWorkCard={() => {
            const key = latestWorkLogKeyRef.current;
            if (key)
              setExpandedWorkLogs((current) => ({ ...current, [key]: true }));
          }}
        />
      )}
      </div>
    </FileActionContext.Provider>
  );
}

export default App;
