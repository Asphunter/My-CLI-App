import {
  createContext,
  Fragment,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import katex from "katex";
import { mathPattern, parseMath } from "./mathText";
import { markdownTableAt } from "./markdownTable";
import { splitAnswerMarkdownBlocks } from "./answerMarkdown";
import {
  EMPTY_LIVE_FILES,
  activeLiveFile,
  applyEditToFile,
  closeLiveFile,
  canonicalLiveFilePath,
  followLiveFiles,
  openLiveFiles,
  reopenLiveFiles,
  selectLiveFile,
  touchLiveFile,
  removeLiveFile,
  liveFilePathKey,
  wholeFileHighlight,
  type LiveFileMode,
  type LiveFileState,
  type LiveFileTouch,
} from "./liveFiles";
import {
  numberedPlanLines,
  numberedPlanSteps,
  planTextSegments,
  withoutLeadingStepNumber,
} from "./planText";
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
  appendInterruptedAnswerMarker,
  coalesceMessageIdentities,
  hasInterruptedAnswerMarker,
  isNewerSettledAssistantVersion,
  isSettledHistoricalAssistant,
  mergeInterruptedAssistantVersions,
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
  conversationHasContent,
  isUntitledConversation,
  preferredThreadForProject,
} from "./conversationSelection";
import {
  mergePipelineStageTiming,
  pipelineChainTimingBounds,
} from "./pipelineTiming";
import {
  detailedAnswerPanelHeight,
  DETAILED_ANSWER_MIN_HEIGHT,
  DETAILED_ANSWER_MIN_WIDTH,
  DETAILED_STEPS_MIN_WIDTH,
} from "./detailedLayout";
import { changeRowLabels, changeSummaryView } from "./changeSummaryView";
import { listBreak, listIndent, type ComposerEdit } from "./composerList";
import { liveNarrationLines } from "./liveNarration";
import {
  resolveRegenerationRequestSettings,
  type RegenerationRequestSettings,
} from "./regenerationSettings";
import {
  acceptTerminalAgentEvent,
  agentEventIdentity,
  normalizeAgentEventEnvelope,
  normalizeAgentInputStatus,
} from "./agentEvent";
import { ensureCanonicalConversationId } from "./conversationIdentity";
import { agentAnswerMessageId } from "./deterministicId";
import CompactAnswersTimeline from "./CompactAnswersTimeline";
import {
  buildCompactAnswerTimeline,
  buildCompactTraceSections,
  looksHungarianNarrative,
  type CompactAnswerBlock,
  type CompactTraceSection,
  type CompactTraceEvent,
} from "./compactAnswerTimeline";
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
import {
  EMPTY_RUN_INPUT_STATE,
  describeRunInputError,
  followUpsForConversation,
  resolveRunInputTarget,
  runInputReducer,
  runtimeInputsForConversation,
  type QueuedFollowUp,
  type RunInputErrorCode,
  type RunInputMode,
  type RunInputPayload,
  type RunInputTarget,
} from "./runInput";

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
  interaction?: MessageInteraction;
  /** The AI that produced this answer; drives the answer-rail identity icon. */
  provider?: AgentProviderId;
};

type AgentProviderId = "codex" | "anthropic" | "kimi" | "deepseek";
type AgentAccessProfile =
  | "claude"
  | "kimiCode"
  | "kimiOpenPlatform"
  | "deepseekApi";

const PROVIDER_LABELS: Record<AgentProviderId, string> = {
  codex: "ChatGPT",
  anthropic: "Claude",
  kimi: "Kimi",
  deepseek: "DeepSeek",
};

const normalizeAgentProvider = (
  provider: string | null | undefined,
): AgentProviderId | undefined => {
  const value = provider?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "codex" || value === "openai" || value.includes("chatgpt"))
    return "codex";
  if (value === "anthropic" || value.includes("claude")) return "anthropic";
  if (value.includes("kimi")) return "kimi";
  if (value.includes("deepseek")) return "deepseek";
  return undefined;
};

const COMPOSER_PROVIDERS: AgentProviderId[] = [
  "anthropic",
  "codex",
  "kimi",
  "deepseek",
];

type MessageInteraction = {
  kind: "steer";
  inputId: string;
  parentTurnId: string;
  targetProvider: AgentProviderId;
  targetRequestId: string;
  targetProviderTurnId?: string;
  pipelineRunId?: string;
  stageIndex?: number;
  stageRole?: string;
  acceptedAt: string;
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

type SelectionQuote = {
  text: string;
  x: number;
  y: number;
  anchorId: string;
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
  role: "plan" | "plan_review" | "code" | "review";
  provider: AgentProviderId;
  runtime: string;
  accessProfile?: AgentAccessProfile;
  model?: string;
  effort?: string;
  maxTurns?: number;
};

type PipelineStageOverride = {
  model?: string;
  effort?: string;
  provider?: AgentProviderId;
  accessProfile?: AgentAccessProfile;
};

type PipelineRecipeBoundaryRole = "plan" | "code";
type PipelineRecipeReviewTarget = "plan" | "implementation";

type PipelineRecipe = {
  id: string;
  label: string;
  stages: PipelineRecipeStage[];
  /** Explicit recipe behavior; optional for compatibility with old snapshots. */
  outputRole?: PipelineRecipeBoundaryRole;
  retryFromRole?: PipelineRecipeBoundaryRole;
  reviewTarget?: PipelineRecipeReviewTarget;
};

// The browser build is also our lightweight visual preview. Mirror the
// desktop's default recipe there so the composer switch and both faces can be
// inspected without a running Tauri command backend.
const PREVIEW_PIPELINE_RECIPES: PipelineRecipe[] = [
  {
    id: "plan_code_review",
    label: "Terv → Kód → Review",
    stages: [
      {
        role: "plan",
        provider: "anthropic",
        runtime: "claude_agent_bridge",
        accessProfile: "claude",
        model: "claude-opus-5",
        effort: "medium",
        maxTurns: 15,
      },
      {
        role: "code",
        provider: "anthropic",
        runtime: "claude_agent_bridge",
        accessProfile: "claude",
        model: "claude-opus-5",
        effort: "medium",
        maxTurns: 120,
      },
      {
        role: "review",
        provider: "codex",
        runtime: "codex_app_server",
        model: "gpt-5.6-sol",
        effort: "medium",
        maxTurns: 120,
      },
    ],
    outputRole: "code",
    retryFromRole: "code",
    reviewTarget: "implementation",
  },
];

const recipeOutputRole = (recipe: PipelineRecipe): PipelineRecipeBoundaryRole =>
  recipe.outputRole ??
  (recipe.stages.some((stage) => stage.role === "code") ? "code" : "plan");

const recipeRetryFromRole = (
  recipe: PipelineRecipe,
): PipelineRecipeBoundaryRole =>
  recipe.retryFromRole ??
  (recipe.stages.some((stage) => stage.role === "plan_review") ? "plan" : "code");

const recipeReviewTarget = (
  recipe: PipelineRecipe,
): PipelineRecipeReviewTarget =>
  recipe.reviewTarget ??
  (recipe.stages.some((stage) => stage.role === "plan_review")
    ? "plan"
    : "implementation");

type PipelineProgressEvent = {
  runId: string;
  conversationId: string;
  stageIndex: number;
  stageCount: number;
  role: "plan" | "plan_review" | "code" | "review";
  agentLabel: string;
  provider: AgentProviderId;
  requestId: string;
  stageEpoch: number;
  planText?: string | null;
  phase: "started" | "finished" | "failed";
  status: "running" | "completed" | "failed" | "cancelled";
};

type PipelineStageResult = {
  index: number;
  role: "plan" | "plan_review" | "code" | "review";
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
  /** Recipe snapshot identifier; absent on pre-recipe pipeline rows. */
  recipeId?: string;
  /** Shared by every iteration of one question. Absent on pre-versioning rows. */
  chainId?: string;
  /** 1-based; absent or 0 on rows written before re-runs existed. */
  iteration?: number;
  stageIndex: number;
  stageCount: number;
  stageRole: string;
  stageAgent: string;
  /** Full effective recipe, including per-stage model overrides. */
  stageRoster?: Array<{
    stageIndex: number;
    stageRole: string;
    stageAgent: string;
  }>;
  /** Persisted outcome of this phase; a stopped phase must not look completed. */
  stageStatus?: "running" | "completed" | "failed" | "cancelled";
  /** Wall-clock bounds captured from pipeline progress events. */
  stageStartedAt?: number;
  stageCompletedAt?: number;
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

const PIPELINE_STATUS_RANK: Record<
  NonNullable<MessagePipeline["stageStatus"]>,
  number
> = {
  running: 0,
  completed: 1,
  cancelled: 2,
  failed: 3,
};

/** Merge the lifecycle fields instead of letting a verdict-bearing stale row win whole. */
const mergeMessagePipeline = (
  existing: MessagePipeline | undefined,
  incoming: MessagePipeline | undefined,
) => {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const preferred = existing.verdict
    ? existing
    : incoming.verdict
      ? incoming
      : existing;
  const secondary = preferred === existing ? incoming : existing;
  const timing = mergePipelineStageTiming(
    {
      startedAt: existing.stageStartedAt,
      completedAt: existing.stageCompletedAt,
    },
    {
      startedAt: incoming.stageStartedAt,
      completedAt: incoming.stageCompletedAt,
    },
  );
  const statuses = [existing.stageStatus, incoming.stageStatus].filter(
    (status): status is NonNullable<MessagePipeline["stageStatus"]> =>
      Boolean(status),
  );
  return {
    ...secondary,
    ...preferred,
    stageStatus: statuses.sort(
      (left, right) => PIPELINE_STATUS_RANK[right] - PIPELINE_STATUS_RANK[left],
    )[0],
    stageStartedAt: timing.startedAt,
    stageCompletedAt: timing.completedAt,
    verdict: existing.verdict ?? incoming.verdict,
    verdictSummary:
      existing.verdictSummary?.trim() || incoming.verdictSummary?.trim() ||
      undefined,
  } satisfies MessagePipeline;
};

const pipelineVerdictOutcome = (
  verdict: string | undefined,
): "accepted" | "changes" | undefined =>
  verdict === "accepted"
    ? "accepted"
    : verdict === "changes_requested" || verdict === "changes"
      ? "changes"
      : undefined;

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
const PIPELINE_MODELS: Record<AgentProviderId, string[]> = {
  anthropic: [
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-fable-5",
  ],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  kimi: ["kimi-k3", "k3", "k3-256k"],
  deepseek: ["deepseek-v4-flash"],
};

/** Short enough that every cell fits one fixed width. */
const PIPELINE_MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5": "Opus 5",
  "claude-fable-5": "Fable 5",
  // The generation is already implied by the vendor cell above, and carrying
  // it here forced every cell to the width of "5.6 Terra".
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
  "kimi-k3": "K3 Raw",
  k3: "K3 Code",
  "k3-256k": "K3 256K",
  "deepseek-v4-flash": "V4 Flash",
};

/** The chain is read at a glance, so the vendor prefix is dropped. */
const shortModelLabel = (modelId: string) =>
  PIPELINE_MODEL_LABELS[modelId] ?? modelId;

const pipelineStageRoster = (recipe: PipelineRecipe) =>
  recipe.stages.map((stage, stageIndex) => ({
    stageIndex,
    stageRole: stage.role,
    stageAgent: [
      PROVIDER_LABELS[stage.provider],
      stage.model ? shortModelLabel(stage.model) : "",
      stage.effort ?? "",
    ]
      .filter(Boolean)
      .join(" · "),
  }));

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

/** Where a running re-run draws itself: in its own panel, not below them all. */
const LIVE_RERUN_SLOT = "__live-rerun-slot__";

const STAGE_ROLE_LABELS: Record<string, string> = {
  plan: "TERV",
  plan_review: "REVIEW",
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
  plan_review: "0. Tervbírálat előkészítése és a terv áttekintése",
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
  /**
   * A futtató által küldött, teljes útvonal — a `path` a panelre való, rövid
   * alak. A tooltip és a megnyitás ezt használja, hogy a rövidítés ne vegye el
   * a fájl elérhetőségét.
   */
  sourcePath?: string;
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
type PlanSource =
  | "codex-native"
  | "claude-task"
  | "claude-todo"
  | "carried-plan"
  | "fallback";
type PlanSnapshot = {
  turnId: string | null;
  explanation: string;
  steps: PlanStep[];
  /** Provider-declared active step. `null` means explicitly unassigned. */
  activeStepId?: string | null;
  /** Origin of the snapshot; used to avoid guessing Claude's progress. */
  source?: PlanSource | string;
  startedAt?: number;
  completedAt?: number;
  stepTimes?: Record<string, PlanStepTiming>;
};
const planTrackingDiagnosticsEnabled = () => {
  try {
    return localStorage.getItem("min.planTrackingDiagnostics") === "1";
  } catch {
    return false;
  }
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
  provider: AgentProviderId;
  readonly clientTurnId: string;
  liveMessageId: string;
  /** Durable row replaced by a regeneration; absent on ordinary turns. */
  readonly replacementMessageId?: string;
  readonly replacementTurnId?: string;
  /** A provider szálazonosítója; a requestId nélküli események tartaléka. */
  threadId?: string;
  turnId?: string;
  providerTurnId?: string;
  stageEpoch: number;
  turnTiming: PlanStepTiming;
  plan: PlanSnapshot;
  planTextBuffer: Record<string, string>;
  agentMessagePhases: Record<string, string>;
  /** Esemény-deduplikáció futásonként; eddig közös, de körönként ürített. */
  processedEvents: Set<string>;
  completedTerminalTurns: Set<string>;
  /** Lánc esetén a szakaszok saját kérés-azonosítói. */
  chainRequestIds: Set<string>;
  /** Provider task/plan id -> the carried plan step it represents in KOD. */
  planTaskToCarriedStep: Record<string, string>;
  /**
   * A lánc állapota — a szakasz-jelző és az újrafuttatás kerete.
   *
   * Két külön projektben két lánc futhat egyszerre; egy globális
   * „épp melyik szakasznál tartunk" a másik panelére hazudna.
   */
  chain?: {
    /** Recipe captured at send time; never read from the current composer. */
    recipe?: PipelineRecipe;
    progress?: PipelineProgressEvent | null;
    stageTimings?: Record<number, PlanStepTiming>;
    resume?: {
      chainKey: string;
      startStage: number;
      iteration: number;
      carried: Record<number, string>;
    } | null;
  };
  /**
   * A terv-szakasz végleges szövege. A TERV kártya minden nézete (RAW,
   * DETAIL, lépéslista) ebből él — nem a külső buborékból, amit későbbi
   * szakaszok szövege érhet el.
   */
  planText?: string;
  /** A gördülékeny kiírás puffere. */
  answerStream: {
    meta: Omit<CodexDelta, "delta"> | null;
    pending: string;
    frame: number | null;
  };
  status: "preparing" | "streaming" | "finalizing" | "done";
  turnCompleted: boolean;
};

type CommentaryEntry = {
  id: string;
  itemId?: string;
  turnId?: string;
  stepId?: string;
  /** Monotonic client sequence used to merge commentary with internal reasoning. */
  sequence?: number;
  /** Provider-normalized display lane for compact, non-detailed runs. */
  channel?: "assistant-output" | "reasoning-summary" | "status";
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
  /**
   * Amit a futtató a fájlműveletről mond (`add`, `update`, `delete`), ha
   * megmondja. Élő futás közben ez az egyetlen jel arról, hogy a fájl új-e:
   * a lánc végi guard-jelentés még nincs meg. Csak az események hordozzák, a
   * lemezre írt sorok nem — a kész kártya addigra a guard listáját mutatja.
   */
  changeKind?: string;
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
type ClaudeApprovalRequest = {
  approvalId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  displayName: string | null;
  description: string | null;
};
type ClaudeQuestionRequest = {
  questionId: string;
  requestId: string;
  questions: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
};
type AgentAuthStatus = {
  provider: AgentProviderId;
  accessProfile?: AgentAccessProfile;
  configured: boolean;
  source: string;
  preview?: string | null;
};

type AgentConnectionResult = {
  provider: AgentProviderId;
  accessProfile?: AgentAccessProfile;
  success: boolean;
  model: string;
  effort: string;
  text?: string | null;
  error?: string | null;
};

const PROVIDER_CREDENTIALS: Array<{
  key: AgentAccessProfile;
  provider: Exclude<AgentProviderId, "codex">;
  label: string;
  model: string;
  effort: string;
  hint: string;
}> = [
  {
    key: "kimiOpenPlatform",
    provider: "kimi",
    label: "Kimi Open Platform · Raw",
    model: "kimi-k3",
    effort: "high",
    hint: "Tokenalapú api.moonshot.ai kulcs; nincs automatikus feltöltés vagy vásárlás.",
  },
  {
    key: "kimiCode",
    provider: "kimi",
    label: "Kimi Code · Előfizetés",
    model: "k3",
    effort: "high",
    hint: "A Kimi Code Console-ban létrehozott coding kulcs.",
  },
  {
    key: "deepseekApi",
    provider: "deepseek",
    label: "DeepSeek API · Raw",
    model: "deepseek-v4-flash",
    effort: "high",
    hint: "Előre fizetett, használatarányos API-kulcs; a Min nem kezel egyenleget.",
  },
];
type ModelFamily = { key: string; label: string; models: CodexModel[] };
type OpenMenu = { kind: "project" | "thread" | "general"; key: string } | null;
type AppDialog =
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

type DeleteExecutionOptions = {
  archive?: boolean;
  skipGuard?: boolean;
  notification?: string;
};

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "low";
const DEFAULT_CLAUDE_EFFORT = "low";
const DEFAULT_CLAUDE_BUDGET_USD = "0.05";
// Alapból nincs körlimit. A Claude Code interaktív módban sem korlátozza a
// köröket — a `maxTurns` az SDK opcionális kapcsolója —, és a korábbi 40-es
// plafon egy húsz percen át dolgozó kódoló kört ölt meg félúton: a fájlok már
// a lemezen voltak, a turn mégis hibára futott. Egy elszabadult kört nem ez fog
// megállítani, hanem a STOP és a mért módban a költségkeret. Aki mégis akar
// plafont, a beállításban megadhatja — az üres mező jelenti a „nincs limit"-et.
const DEFAULT_CLAUDE_MAX_TURNS = "";

/** Üres/érvénytelen mező = nincs plafon; a bridge ilyenkor el sem küldi. */
const claudeTurnLimit = (value: string): number | null => {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const MODEL_PREFERENCE_VERSION = "4";
const EFFORT_PREFERENCE_VERSION = "1";
const READING_SETTINGS_VERSION = "3";
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
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
 * The same models a chain stage may run, so "Opus 5" means one thing in
 * this app rather than one thing per menu. Auth is the Claude Code
 * subscription, not an API key — the old description said otherwise and was
 * the last place in the UI still claiming it.
 */
const claudeCodingModels: CodexModel[] = [
  {
    id: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Claude Opus 4.8 coding modell.",
    supportedReasoningEfforts: FALLBACK_EFFORTS,
    defaultReasoningEffort: DEFAULT_CLAUDE_EFFORT,
  },
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

const kimiCodingModels: CodexModel[] = [
  {
    id: "kimi-k3",
    displayName: "Kimi K3 (Raw)",
    description: "Kimi Open Platform, közvetlen tokenalapú API-hozzáférés.",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "k3",
    displayName: "Kimi K3 Code",
    description: "Kimi Code előfizetés Anthropic-kompatibilis coding útvonala.",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  },
  {
    id: "k3-256k",
    displayName: "Kimi K3 Code 256K",
    description: "Kimi Code 256K kontextusú coding útvonal.",
    supportedReasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
  },
];

const deepSeekCodingModels: CodexModel[] = [
  {
    id: "deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "DeepSeek közvetlen API, Anthropic-kompatibilis coding útvonal.",
    supportedReasoningEfforts: ["none", "high", "max"],
    defaultReasoningEffort: "high",
  },
];

const externalCodingModels = [...kimiCodingModels, ...deepSeekCodingModels];

const providerOfModel = (modelId: string | null): AgentProviderId => {
  if (modelId?.startsWith("claude-")) return "anthropic";
  if (modelId === "kimi-k3" || modelId === "k3" || modelId === "k3-256k")
    return "kimi";
  if (modelId === "deepseek-v4-flash") return "deepseek";
  return "codex";
};

const accessProfileOfModel = (
  modelId: string | null,
): AgentAccessProfile | undefined => {
  if (modelId?.startsWith("claude-")) return "claude";
  if (modelId === "kimi-k3") return "kimiOpenPlatform";
  if (modelId === "k3" || modelId === "k3-256k") return "kimiCode";
  if (modelId === "deepseek-v4-flash") return "deepseekApi";
  return undefined;
};

const runtimeOfProvider = (provider: AgentProviderId) =>
  provider === "codex"
    ? "codexAppServer"
    : provider === "anthropic"
      ? "claudeAgentBridge"
      : "compatibleAgentBridge";

/** A run owns the exact stage choices that were visible when it was sent. */
const recipeWithStageOverrides = (
  recipe: PipelineRecipe,
  overrides: PipelineStageOverride[],
): PipelineRecipe => ({
  ...recipe,
  stages: recipe.stages.map((stage, index) => {
    const override = overrides[index];
    const provider = override?.provider ?? stage.provider;
    const providerChanged = provider !== stage.provider;
    const model =
      override?.model ??
      (providerChanged ? PIPELINE_MODELS[provider][0] : stage.model);
    return {
      ...stage,
      provider,
      runtime: runtimeOfProvider(provider),
      model,
      effort: override?.effort ?? stage.effort,
      accessProfile:
        override?.accessProfile ??
        accessProfileOfModel(model ?? null) ??
        (providerChanged ? undefined : stage.accessProfile),
    };
  }),
});

const providerSupportsImageInput = (
  provider: AgentProviderId,
  accessProfile?: AgentAccessProfile | null,
) =>
  provider === "codex" ||
  provider === "anthropic" ||
  (provider === "kimi" && accessProfile === "kimiOpenPlatform");

const bridgeSessionCacheKey = (
  conversationKey: string,
  provider: AgentProviderId,
) => `${provider}:${conversationKey}`;

const providerEfforts = (provider: AgentProviderId) =>
  provider === "kimi"
    ? ["low", "high", "max"]
    : provider === "deepseek"
      ? ["none", "high", "max"]
      : FALLBACK_EFFORTS;

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

/** `tervek/ÉÉÉÉ-HH-NN-<téma>-v<kör>.md` — a terv-fájl neve. */
const planFileNameFor = (title: string, iteration: number) => {
  const slug =
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "terv";
  const date = new Date().toISOString().slice(0, 10);
  return `tervek/${date}-${slug}-v${iteration}.md`;
};

/**
 * An answer as paragraphs rather than one `pre-wrap` block.
 *
 * A model separates paragraphs with a blank line, and `pre-wrap` renders that
 * blank line as a full line box — which is why every paragraph break looked
 * like a whole empty row of text. Splitting on the blank line and letting CSS
 * set the gap keeps the structure and drops the hole.
 */
const answerTextParagraphs = (
  text: string,
  keyPrefix = "answer",
  renderInline: (value: string) => ReactNode = (value) => (
    <InlineMarkdown text={value} />
  ),
): ReactNode[] =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index): ReactNode[] => {
      // A `## Cím` sor fejezetcím, nem szöveg: nyers kettőskeresztekkel a terv
      // RAW nézete olvashatatlan volt. Csak az egysoros bekezdés cím — egy
      // bekezdés belsejében a # mást jelent (pl. kódkomment).
      const heading = paragraph.match(/^(#{1,4})\s+(\S[^\n]*)$/);
      if (heading)
        return [
          <p
            key={`${keyPrefix}-para-${index}`}
            className={`answer-heading answer-heading-${heading[1].length}`}
          >
            {renderInline(heading[2])}
          </p>,
        ];
      const lines = paragraph.split("\n");
      const unorderedItems = lines.map((line) =>
        line.match(/^\s*[-*+]\s+(\S.*)$/)?.[1],
      );
      if (unorderedItems.every(Boolean))
        return [
          <ul className="answer-list" key={`${keyPrefix}-list-${index}`}>
            {unorderedItems.map((item, itemIndex) => (
              <li key={`${keyPrefix}-list-${index}-${itemIndex}`}>
                {renderInline(item!)}
              </li>
            ))}
          </ul>,
        ];
      const orderedItems = lines.map((line) =>
        line.match(/^\s*(\d+)[.)]\s+(\S.*)$/),
      );
      if (orderedItems.every(Boolean))
        return [
          <ol
            className="answer-list"
            key={`${keyPrefix}-ordered-${index}`}
            start={Number(orderedItems[0]![1])}
          >
            {orderedItems.map((item, itemIndex) => (
              <li key={`${keyPrefix}-ordered-${index}-${itemIndex}`}>
                {renderInline(item![2])}
              </li>
            ))}
          </ol>,
        ];
      const quoteLines = lines.map((line) =>
        line.match(/^\s*>\s?(.*)$/)?.[1],
      );
      if (quoteLines.every((line) => line !== undefined))
        return [
          <blockquote
            className="answer-blockquote"
            key={`${keyPrefix}-quote-${index}`}
          >
            {renderInline(quoteLines.join("\n"))}
          </blockquote>,
        ];
      // A bekezdés tartalmazhat táblát — akár egy bevezető mondat után is.
      // A tábla sorai táblává állnak össze, a köztük lévő szöveg bekezdés
      // marad; ha nincs tábla, ez pontosan a régi egy-bekezdés ág.
      const blocks: ReactNode[] = [];
      let buffer: string[] = [];
      const flushText = (key: string) => {
        const body = buffer.join("\n").trim();
        buffer = [];
        if (body) blocks.push(<p key={key}>{renderInline(body)}</p>);
      };
      for (let line = 0; line < lines.length; ) {
        const table = markdownTableAt(lines, line);
        if (!table) {
          buffer.push(lines[line]);
          line += 1;
          continue;
        }
        flushText(`${keyPrefix}-para-${index}-text-${line}`);
        blocks.push(
          <div
            className="answer-table-wrap"
            key={`${keyPrefix}-para-${index}-table-${line}`}
          >
            <table className="answer-table">
              <thead>
                <tr>
                  {table.header.map((cell, cellIndex) => (
                    <th key={`h-${cellIndex}`}>
                      <InlineMarkdown text={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`r-${rowIndex}`}>
                    {table.header.map((_, cellIndex) => (
                      <td key={`c-${cellIndex}`}>
                        <InlineMarkdown text={row[cellIndex] ?? ""} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        line = table.end;
      }
      flushText(`${keyPrefix}-para-${index}`);
      return blocks;
    })
    .flat();

const planStepBody = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0)
    lines[0] = lines[0].replace(/^\s*\d+[.)]\s+/, "");
  return lines.join("\n").trim();
};

/** Render full answer Markdown without dropping executable instructions. */
const answerParagraphs = (
  text: string,
  quoteRefs: QuoteReference[] = [],
  onQuoteJump?: QuoteJumpHandler,
) => {
  const remainingQuoteIds = new Set(quoteRefs.map((quote) => quote.id));
  const renderInline = (value: string) => {
    if (!onQuoteJump) return <InlineMarkdown text={value} />;
    const matches = quoteRefs.filter(
      (quote) =>
        remainingQuoteIds.has(quote.id) &&
        [quote.text, quote.instruction]
          .filter(Boolean)
          .some((needle) => value.includes(needle)),
    );
    matches.forEach((quote) => remainingQuoteIds.delete(quote.id));
    return matches.length > 0 ? (
      answerWithQuoteBacklinks(value, matches, onQuoteJump)
    ) : (
      <InlineMarkdown text={value} />
    );
  };
  const blocks: ReactNode[] = [];
  splitAnswerMarkdownBlocks(text).forEach((block, index) => {
    if (block.type === "text") {
      blocks.push(...answerTextParagraphs(
        block.text,
        `answer-block-${index}`,
        renderInline,
      ));
      return;
    }
    blocks.push(
      <AnswerCodeBlock
        code={block.code}
        language={block.language}
        key={`answer-code-${index}`}
      />,
    );
  });
  const unmatchedQuotes = quoteRefs.filter((quote) =>
    remainingQuoteIds.has(quote.id),
  );
  if (onQuoteJump && unmatchedQuotes.length > 0)
    blocks.push(
      <div className="answer-quote-backlinks" key="answer-quote-backlinks">
        {quoteBacklinkButtons(unmatchedQuotes, onQuoteJump)}
      </div>,
    );
  return blocks;
};

function AnswerCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyCode = async () => {
    try {
      await writeTextToClipboard(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="code-block answer-code-block">
      <div className="code-header">
        <span>KÓD</span>
        <span className="answer-code-language">{language}</span>
        <button
          type="button"
          className="answer-code-copy"
          aria-label={copied ? "Kód másolva" : "Kód másolása"}
          title={copied ? "Másolva" : "Kód másolása"}
          onClick={() => void copyCode()}
        >
          <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
        </button>
      </div>
      <pre>
        <code>{highlightCode(code)}</code>
      </pre>
    </section>
  );
}

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

const PERMANENT_DELETE_REASON = "min:permanent-delete:v1";
const isPermanentSyncTombstone = (tombstone: SyncTombstone) =>
  tombstone.reason === PERMANENT_DELETE_REASON;

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

// A kiválasztás szabályai önálló modulban élnek, hogy tesztelhetők legyenek.

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

const formatSyncHealthTime = (value: string | null | undefined) => {
  if (!value) return "még nincs";
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return value;
  return new Intl.DateTimeFormat("hu-HU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(timestamp));
};

const syncHealthStatusLabel = (status: string) => {
  if (status === "healthy") return "Rendben · írható";
  if (status === "empty") return "Üres journal";
  if (status === "quarantine") return "Quarantine · csak olvasás";
  return status;
};

const syncTombstoneTypeLabel = (entityType: string) =>
  entityType === "project" ? "Projekt" : "Beszélgetés";

const syncTombstoneProjectContext = (tombstone: SyncTombstone) => {
  const path = tombstone.relativePath ?? tombstone.pathHint;
  const projectName = path
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  if (projectName) return `Projekt: ${projectName}`;
  return tombstone.projectId
    ? `Projekt ID: ${tombstone.projectId.slice(0, 8)}`
    : "";
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
      const interruptedMerge = mergeInterruptedAssistantVersions(
        existing,
        message,
      );
      // A submitted user payload is immutable. In particular, never let the
      // old "longer text wins" assistant heuristic splice two user turns when
      // a stale cache and a pulled snapshot meet.
      const mergedText =
        interruptedMerge?.text ??
        (preferIncomingSettledAssistant
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
                  : existing.text);
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
        interrupted:
          interruptedMerge?.interrupted ??
          message.interrupted ??
          existing.interrupted,
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
        interaction: existing.interaction ?? message.interaction,
        provider: message.provider ?? existing.provider,
        changeSummary:
          existing.changeSummary && existing.changeSummary.length > 0
            ? existing.changeSummary
            : message.changeSummary,
        // A szakasz-címke a sor identitásának része. A journal hozhat
        // címkézés ELŐTTI példányt ugyanarról a sorról; ha az kerül előre, a
        // spread nélküle hagyta volna a sort — a lánc-panel erre esett szét
        // különálló kártyákra projektváltás után. A verdiktes példány a
        // teljesebb: a címke a lánc végén, a verdikt ismeretében készül.
        pipeline: mergeMessagePipeline(existing.pipeline, message.pipeline),
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

/**
 * Ez a tároló az egész szálmapot újraírja minden commitnál, a localStorage
 * kvótája pedig origónként néhány megabájt. Egy elég nagy válasz után a
 * `setItem` tartósan elhasal — és mivel a hiba le volt nyelve, onnantól *minden*
 * szál mentése csendben megszűnt. A kvótát ezért a legrégebbi szálak eldobásával
 * szabadítjuk fel, a most mentett szálat pedig soha nem dobjuk el.
 */
const saveThreadMessages = (key: string, messages: Message[]) => {
  const repaired = messages.map(repairHistoricalAssistantText);
  let saved: Record<string, Message[]> = {};
  try {
    saved = JSON.parse(
      localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, Message[]>;
  } catch {
    saved = {};
  }
  const store = { ...saved, [key]: repaired };
  // A saját szálát mindig megtartjuk; a többit a mapban lévő sorrendben — ami a
  // beszúrás sorrendje, tehát a legrégebben látott szál van elöl — dobjuk.
  const evictable = Object.keys(store).filter((candidate) => candidate !== key);
  for (let attempt = 0; ; attempt += 1) {
    try {
      localStorage.setItem(MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify(store));
      return;
    } catch {
      const victim = evictable.shift();
      if (victim === undefined) {
        // Már csak ez az egy szál van, és az sem fér el: a beszélgetés a
        // SQLite-ban akkor is megvan, ez a tároló csak előnézet-gyorsítótár.
        try {
          localStorage.removeItem(MESSAGE_HISTORY_STORAGE_KEY);
        } catch {
          // Ha a törlés sem megy, nincs mit tenni — a futás ettől nem áll meg.
        }
        return;
      }
      delete store[victim];
    }
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
    const statusRank: Record<WorkItemStatus, number> = {
      running: 0,
      done: 1,
      error: 2,
    };
    const structural =
      statusRank[item.status] >= statusRank[existing.status] ? item : existing;
    merged[existingIndex] = {
      ...existing,
      ...structural,
      id: existing.id,
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
  const hasActiveStepId =
    Object.prototype.hasOwnProperty.call(raw, "activeStepId") ||
    Object.prototype.hasOwnProperty.call(raw, "active_step_id");
  const rawActiveStepId = Object.prototype.hasOwnProperty.call(
    raw,
    "activeStepId",
  )
    ? raw.activeStepId
    : raw.active_step_id;
  const activeStepId = hasActiveStepId
    ? rawActiveStepId === null
      ? null
      : firstString(rawActiveStepId)
    : undefined;
  const source = firstString(raw.source);
  return {
    turnId: firstString(raw.turnId, raw.turn_id) ?? fallbackTurnId,
    explanation:
      firstString(raw.explanation, raw.explanationText, raw.reason) ?? "",
    steps,
    ...(activeStepId !== undefined ? { activeStepId } : {}),
    ...(source !== undefined ? { source } : {}),
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
      ...(normalized?.activeStepId !== undefined
        ? { activeStepId: normalized.activeStepId }
        : {}),
      ...(normalized?.source !== undefined ? { source: normalized.source } : {}),
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
              channel:
                raw.channel === "assistant-output" ||
                raw.channel === "reasoning-summary" ||
                raw.channel === "status"
                  ? raw.channel
                  : undefined,
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

/** Amit egy futtató a fájlművelet fajtájáról mondhat. */
const CHANGE_KIND_WORDS = new Set([
  "add",
  "added",
  "create",
  "created",
  "new",
  "update",
  "updated",
  "modify",
  "modified",
  "change",
  "changed",
  "edit",
  "edited",
  "delete",
  "deleted",
  "remove",
  "removed",
]);

/**
 * A fájlművelet fajtája az eseményből, ha kimondja.
 *
 * A Codex `fileChange` eleme a `changes` tömbben adja meg, más alakok a
 * `kind`/`changeKind` mezőben; ismeretlen alakból nem tippelünk, a hívó
 * ilyenkor marad az esemény nevénél. Csak fájl-elemre kérdezzük meg, mert a
 * `kind` szó máshol nem a változásról szól.
 */
const extractChangeKind = (
  params: Record<string, unknown>,
  item: Record<string, unknown>,
): string | undefined =>
  [
    params.changeKind,
    item.changeKind,
    params.changeType,
    item.changeType,
    ...[params.changes, item.changes].flatMap((value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            const record = asRecord(entry);
            return [record.kind, record.changeKind, record.type];
          })
        : [],
    ),
    asRecord(params.change).kind,
    asRecord(item.change).kind,
    params.kind,
    item.kind,
  ].find(
    (value): value is string =>
      typeof value === "string" &&
      CHANGE_KIND_WORDS.has(value.trim().toLowerCase()),
  );

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
  const changeKind =
    kind === "file" ? extractChangeKind(params, item) : undefined;
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
    changeKind,
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
    // A `started` esemény mondja meg a fájlművelet fajtáját, a `completed`
    // gyakran már nem; a szétosztott spread különben visszaütné üresre.
    changeKind: incoming.changeKind ?? existing.changeKind,
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

/**
 * A záró „VERDIKT: …" sor a gép jele, nem az olvasóé: a kártya alján a színes
 * sáv mondja ki ugyanazt. Csak akkor kerül le, ha tényleg az utolsó sor — a
 * szöveg közepén álló említés érv, nem ítélet.
 */
const textWithoutVerdictLine = (text: string) => {
  const lines = text.trimEnd().split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  const cleaned = lines[last]
    ?.trim()
    .replace(/^[#*_>\s-]+/, "")
    .toUpperCase();
  return cleaned?.startsWith("VERDIKT:")
    ? lines.slice(0, last).join("\n").trimEnd()
    : text;
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

const inlineTextPattern =
  /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^\)]+\)|(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^<>\n`]*?\.[A-Za-z0-9]{1,12}\b|(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\\\\)?[\w.-]+(?:[\\/][\w.-]+)*\.[A-Za-z0-9]{1,12}\b/;

// A képlet előbb áll, mint a hivatkozás-minta: a `\[ ... \]` egy karakterrel
// korábban kezdődik, mint a benne látszó `[ ... ]`, és a korábbi találat nyer.
const inlineMarkdownPattern = new RegExp(
  `(${mathPattern.source}|${inlineTextPattern.source})`,
  "g",
);

const mathHtmlCache = new Map<string, string | null>();

/**
 * Egy TeX-kifejezés HTML-je. A streamelés minden képkockán újrarendereli a
 * szöveget, ezért a KaTeX kimenete gyorsítótárba megy — enélkül minden képlet
 * újra-parse-olódna másodpercenként hatvanszor.
 */
/**
 * A `$$…$$` és `\[…\]` minta bármeddig nyúlhat, a KaTeX pedig szinkronban fut a
 * fő szálon: egy megabájtos „képlet" befagyasztaná a felületet, és a
 * gyorsítótárban is ott maradna. Ennél hosszabb bemenetnél a hívó a nyers TeX-et
 * jeleníti meg, ami ilyen méretben amúgy is olvashatóbb.
 */
const MAX_MATH_LENGTH = 2000;

const renderMathHtml = (tex: string, display: boolean) => {
  if (tex.length > MAX_MATH_LENGTH) return null;
  const key = `${display ? "d" : "i"}|${tex}`;
  const cached = mathHtmlCache.get(key);
  if (cached !== undefined) return cached;
  let html: string | null = null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      // Csak HTML: a MathML-lel együtt minden képlet kétszer került a
      // kijelölésbe, és az idézetek duplán vették volna át.
      output: "html",
    });
  } catch {
    html = null;
  }
  if (mathHtmlCache.size > 400) mathHtmlCache.clear();
  mathHtmlCache.set(key, html);
  return html;
};

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

/**
 * Egy válaszban a link *címkéje* és a *célja* is a modelltől jön, egymástól
 * függetlenül, ez az ablak pedig címsor nélküli — a felhasználó kattintás előtt
 * és után sem látja, hová megy. Ezért csak webes séma mehet át, és a gazdagép
 * a címke mellett megjelenik: barátságos szöveg így nem takarhatja el a célt.
 */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

const safeExternalLink = (href: string) => {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (!SAFE_LINK_SCHEMES.has(url.protocol)) return null;
  return {
    href: url.href,
    origin: url.protocol === "mailto:" ? url.pathname : url.host,
  };
};

/** Kiterjesztések, amelyeknél a „Futtatás" előbb megkérdezi a felhasználót. */
const EXECUTABLE_EXTENSIONS = new Set(["bat", "cmd", "ps1", "py", "exe"]);

const executableExtensionOf = (path: string) =>
  path.match(/\.([A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase() ?? "";

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
    const math = parseMath(value);
    if (math) {
      const html = renderMathHtml(math.tex, math.display);
      parts.push(
        html ? (
          <span
            key={`math-${index}`}
            className={`inline-math${math.display ? " is-display" : ""}`}
            role="math"
            aria-label={math.tex}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          // Ha a KaTeX nem érti, a nyers TeX olvashatóbb, mint egy hibajelzés.
          <span className="inline-math is-raw" key={`math-raw-${index}`}>
            {value}
          </span>
        ),
      );
    } else if (value.startsWith("`") && value.endsWith("`")) {
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
        const external = safeExternalLink(link[2]);
        parts.push(
          fileButton(link[2], link[1], `file-link-${index}`) ??
            (external ? (
              <a
                href={external.href}
                target="_blank"
                rel="noreferrer"
                key={`link-${index}`}
              >
                {link[1]}
                <span className="inline-link-origin"> ({external.origin})</span>
              </a>
            ) : (
              // Nem webes séma vagy értelmezhetetlen cél: a nyers szöveg
              // olvasható marad, de kattinthatóvá nem válik.
              <span key={`link-inert-${index}`}>{value}</span>
            )),
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

/**
 * Az élő kódnézet: amit a modell épp ír, abban a fájlban, ahol írja.
 *
 * A fülek gyűlnek — minden érintett fájl fent marad —, és a nézet magától a
 * dolgozó fájlra áll. Egy kézi fülválasztás megállítja a követést, mert aki
 * olvas valamit, azt ne rángassa el a következő fájl; a „Követés" gomb
 * visszaadja. Olvasó nézet: futás közben a fájlt az ügynök írja, nem mi.
 */
function LiveCodePanel({
  state,
  open,
  onToggle,
  onSelect,
  onClose,
  onFollow,
  onReopen,
}: {
  state: LiveFileState;
  open: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onFollow: () => void;
  onReopen: () => void;
}) {
  const file = activeLiveFile(state);
  const openFiles = openLiveFiles(state);
  const hiddenCount = state.files.length - openFiles.length;
  const codeRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(
    // A színezés soronként fut: a fájl végére írt karakter így nem
    // rajzoltatja újra az egész fájlt, csak az utolsó sorát.
    () => (file?.content ?? "").split("\n"),
    [file?.content],
  );
  // Írás közben a friss rész legyen a szem előtt. Új fájlnál ez a fájl vége,
  // meglévő fájl szerkesztésénél viszont a ténylegesen módosított sor — nem a
  // patch eleje és nem automatikusan a 100. sor helyett a dokumentum vége.
  useEffect(() => {
    if (!open || !file?.streaming) return;
    const node = codeRef.current;
    if (!node) return;
    if (file.mode === "edit") {
      const changedLine = node.querySelector<HTMLElement>(
        ".live-code-line.is-changed",
      );
      if (!changedLine) return;
      node.scrollTop = Math.max(
        0,
        changedLine.offsetTop - node.clientHeight * 0.35,
      );
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [open, file?.streaming, file?.content, file?.mode, file?.highlight]);
  if (state.files.length === 0) return null;
  const writing = state.files.some((item) => item.streaming);
  return (
    <section className={`live-code-panel${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="live-code-toggle"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="live-code-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <strong>KÓD</strong>
        <span className="live-code-count">
          {`${state.files.length} fájl`}
        </span>
        {/* A fájl neve a fülön áll; ide az kerül, amit a fül nem mond meg. */}
        {open && file && (
          <span className="live-code-mode">
            {file.mode === "write" ? "új tartalom" : "szerkesztés"}
          </span>
        )}
        {writing && (
          <span className="live-code-writing">
            <span className="trace-answer-spinner" aria-hidden="true" />
            írás…
          </span>
        )}
      </button>
      {open && (
        <div className="live-code-expanded">
          <div className="live-code-tabs" role="tablist">
            {openFiles.map((item) => (
              <span
                key={item.path}
                className={`live-code-tab${item.path === file?.path ? " is-active" : ""}${
                  item.streaming ? " is-writing" : ""
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={item.path === file?.path}
                  title={item.path}
                  onClick={() => onSelect(item.path)}
                >
                  {item.path.split(/[\\/]/).pop()}
                </button>
                <button
                  type="button"
                  className="live-code-tab-close"
                  aria-label={`${item.path} bezárása`}
                  title="Fül bezárása"
                  onClick={() => onClose(item.path)}
                >
                  ×
                </button>
              </span>
            ))}
            <span className="live-code-tabs-actions">
              {hiddenCount > 0 && (
                // A bezárt fül nem törlés: a futás hozzányúlt a fájlhoz, és ez
                // így is marad. Enélkül az utolsó X-szel a panel elérhetetlenné
                // vált.
                <button
                  type="button"
                  className="live-code-tab-action"
                  onClick={onReopen}
                  title="A bezárt fülek visszahozása"
                >
                  {`+${hiddenCount} vissza`}
                </button>
              )}
              {!state.following && openFiles.length > 0 && (
                // Csak akkor van értelme, ha a nézet tényleg le van horgonyozva.
                <button
                  type="button"
                  className="live-code-tab-action is-follow"
                  onClick={onFollow}
                  title="Ugrás arra a fájlra, amelyiken a modell dolgozik"
                >
                  Követés
                </button>
              )}
            </span>
          </div>
          {file ? (
            <div className="live-code-lines" ref={codeRef}>
              {lines.map((line, index) => {
                const number = index + 1;
                const changed =
                  file.highlight &&
                  number >= file.highlight.from &&
                  number <= file.highlight.to;
                return (
                  <div
                    key={`${file.path}-${number}`}
                    className={`live-code-line${changed ? " is-changed" : ""}`}
                  >
                    <span className="live-code-number">{number}</span>
                    <code>{line ? highlightCode(line) : " "}</code>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="live-code-empty">
              Minden fül be van zárva.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

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
  /** A sor eredeti szövege szorzó nélkül, hogy az ismétlés felismerhető legyen. */
  baseBody?: string;
  /** Hányszor futott egymás után ugyanaz a parancs. */
  repeat?: number;
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

/**
 * A projekt gyökeréhez képest, ahogy a lánc guard-jelentése is adja.
 *
 * A futtató abszolút útvonalat küld, a kész kártya viszont relatívat mutat: az
 * élő lista fölöslegesen lett volna másfajta ugyanarról a fájlról, és az egész
 * `C:\Users\…` a panelt is szélesre nyitotta. A gyökér nem mindig ismerhető
 * fel — a store kanonizált `\\?\C:\…` alakot is ír, a cache simát —, ezért a
 * ki nem ismert abszolút útvonalból a fájlnév marad; a teljes út a sor
 * tooltipjében és a megnyitásban továbbra is megvan.
 */
const plainPath = (value: string) =>
  value.trim().replace(/^\\\\\?\\/, "").replaceAll("\\", "/");

const relativeChangePath = (path: string, projectPath?: string) => {
  const normalized = plainPath(path);
  const root = projectPath ? plainPath(projectPath).replace(/\/+$/, "") : "";
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`))
    return normalized.slice(root.length + 1);
  return /^([a-zA-Z]:\/|\/)/.test(normalized)
    ? (normalized.split("/").at(-1) ?? normalized)
    : normalized;
};

const changeSummaryFromActivities = (
  activities: CodeActivity[],
  projectPath?: string,
): ChangeSummaryFile[] => {
  const byPath = new Map<string, ChangeSummaryFile>();
  for (const activity of activities) {
    const path = relativeChangePath(activity.detail, projectPath);
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
    // A fájlművelet neve nem mindig mondja meg, hogy változás történt: az
    // app-server új protokollja `item/completed`-et küld, és hogy fájlírás
    // volt, csak az elem típusából derül ki. Ilyenkor a jel az, hogy a
    // művelet a fájl tartalmát is hordozza, illetve amit a futtató a változás
    // fajtájáról mond. Enélkül a KÓD szakasz alatt üres volt a fájllista, és
    // a lánc végi guard-jelentésig semmi nem látszott.
    const looksLikeChange =
      activity.kind === "file" &&
      !readOnlyActivity &&
      (Boolean(activity.changeKind) ||
        Boolean(activity.code?.trim()) ||
        /(change|create|delete|remove|write|patch|edit)/i.test(
          activity.eventType,
        ));
    if (!path || !pathLike || (!hasCodeBoundary && !looksLikeChange)) continue;
    const before = activity.beforeCode ?? "";
    const after = activity.afterCode ?? activity.code ?? "";
    const rows = buildInlineDiffRows(before, after);
    const next = {
      ...summaryFromDiffRows(
        path,
        activity.changeKind ?? activity.eventType,
        rows,
        !hasCodeBoundary && Boolean(activity.code),
      ),
      sourcePath: plainPath(activity.detail),
    };
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

/**
 * A Codex escape-elve adja át az exec-parancsot (`"C:\\WINDOWS\\System32\\…"`),
 * amitől a sor fele fordított törtvonal. Csak akkor bontjuk vissza, ha minden
 * törtvonal párban áll: egy igazi UNC-útvonal (`\\gép\megosztás`) így
 * érintetlen marad.
 */
const unescapeDoubledBackslashes = (value: string) =>
  value.includes("\\\\") &&
  !value.split("\\\\").some((part) => part.includes("\\"))
    ? value.replaceAll("\\\\", "\\")
    : value;

/**
 * A parancs-bullet zaját szedi le: a munkakönyvtárba lépő `cd "…" && ` előtag
 * minden sor elején ugyanaz volt, két sornyi útvonal nulla információval — a
 * lényeg, maga a parancs, csak utána kezdődött. A `cd` csak akkor marad, ha
 * nem az elején áll (ott már a parancs része).
 */
const stripLeadingCdPrefix = (value: string) => {
  const match = value.match(
    /^cd\s+(?:"[^"]*"|'[^']*'|[^\s"']+)\s*(?:&&|;)\s*/,
  );
  return match ? value.slice(match[0].length) : value;
};

/**
 * A puszta eszköznév néha semmit nem mond: a Codex node-REPL-je `js`-nek hívja
 * magát, és a bullet is ennyi volt — maga a hívás a `</>` alatt lapult. A név
 * mellé az első sora kerül, hogy a lista kattintás nélkül is olvasható legyen.
 */
const toolCallBullet = (activity: CodeActivity) => {
  const detail = activity.detail.trim();
  const source = (activity.code ?? activity.afterCode ?? "").trim();
  if (!source || detail.length > 24 || /\s/.test(detail)) return detail;
  const lines = source.split("\n");
  const rest = lines.slice(1).some((line) => line.trim());
  return `${detail} — ${lines[0].trim()}${rest ? " …" : ""}`;
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
const vendorOfModel = providerOfModel;

/** A GPT family whose variants occupy the next click-open cascade level. */
const GPT_FLYOUT_FAMILY = "gpt-5.6";

type ModelPickerProps = {
  open: boolean;
  activeLabel: string;
  selectedModel: string | null;
  modelFamilies: ModelFamily[];
  onToggle: () => void;
  onSelectModel: (id: string | null) => void;
};

function ModelPicker({
  open,
  activeLabel,
  selectedModel,
  modelFamilies,
  onToggle,
  onSelectModel,
}: ModelPickerProps) {
  const [vendor, setVendor] = useState<AgentProviderId | null>(null);
  const [flyoutFamily, setFlyoutFamily] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setVendor(null);
    setFlyoutFamily(null);
  }, [open]);

  const claudeModels =
    modelFamilies.find((family) => family.key === "claude")?.models ?? [];
  const kimiModels =
    modelFamilies.find((family) => family.key === "kimi")?.models ?? [];
  const deepSeekModels =
    modelFamilies.find((family) => family.key === "deepseek")?.models ?? [];
  const selectedVendor = selectedModel ? vendorOfModel(selectedModel) : null;
  const seenChatModels = new Set<string>();
  const chatFamilies = modelFamilies.flatMap((family) => {
    if (["claude", "kimi", "deepseek"].includes(family.key)) return [];
    const models = family.models.filter((model) => {
      if (
        vendorOfModel(model.id) !== "codex" ||
        seenChatModels.has(model.id)
      )
        return false;
      seenChatModels.add(model.id);
      return true;
    });
    return models.length > 0 ? [{ ...family, models }] : [];
  });

  return (
    <div className="model-picker">
      <button
        type="button"
        className="model-chip"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{activeLabel}</span>
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
            {/* One segmented control with two sides; the models below belong
                to whichever vendor side is showing. */}
            <div
              className="model-vendor-switch"
              role="tablist"
              aria-label="Gyártó"
            >
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "codex"}
                className={`${vendor === "codex" ? "is-active" : ""}${selectedVendor === "codex" ? " is-selected" : ""}`}
                onClick={() => {
                  setVendor((current) => current === "codex" ? null : "codex");
                  setFlyoutFamily(null);
                }}
              >
                <span>ChatGPT</span><span aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "anthropic"}
                className={`${vendor === "anthropic" ? "is-active" : ""}${selectedVendor === "anthropic" ? " is-selected" : ""}`}
                onClick={() => {
                  setVendor((current) => current === "anthropic" ? null : "anthropic");
                  setFlyoutFamily(null);
                }}
              >
                <span>Claude</span><span aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "kimi"}
                className={`${vendor === "kimi" ? "is-active" : ""}${selectedVendor === "kimi" ? " is-selected" : ""}`}
                onClick={() => {
                  setVendor((current) => current === "kimi" ? null : "kimi");
                  setFlyoutFamily(null);
                }}
              >
                <span>Kimi</span><span aria-hidden="true">›</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={vendor === "deepseek"}
                className={`${vendor === "deepseek" ? "is-active" : ""}${selectedVendor === "deepseek" ? " is-selected" : ""}`}
                onClick={() => {
                  setVendor((current) => current === "deepseek" ? null : "deepseek");
                  setFlyoutFamily(null);
                }}
              >
                <span>DeepSeek</span><span aria-hidden="true">›</span>
              </button>
            </div>
            {vendor && (
              <div className="model-variants" role="menu">
                {vendor === "anthropic"
                  ? claudeModels.map((model) => (
                      <button
                        type="button"
                        role="menuitem"
                        className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                        onClick={() => onSelectModel(model.id)}
                        key={model.id}
                      >
                        <strong>{PIPELINE_MODEL_LABELS[model.id] ?? model.displayName}</strong>
                        <span className="model-check">
                          {model.id === selectedModel ? "✓" : ""}
                        </span>
                      </button>
                    ))
                  : vendor === "kimi"
                    ? kimiModels.map((model) => (
                        <button
                          type="button"
                          role="menuitem"
                          className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                          onClick={() => onSelectModel(model.id)}
                          key={model.id}
                          title={model.description}
                        >
                          <strong>{PIPELINE_MODEL_LABELS[model.id] ?? model.displayName}</strong>
                          <span className="model-check">
                            {model.id === selectedModel ? "✓" : ""}
                          </span>
                        </button>
                      ))
                    : vendor === "deepseek"
                      ? deepSeekModels.map((model) => (
                          <button
                            type="button"
                            role="menuitem"
                            className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                            onClick={() => onSelectModel(model.id)}
                            key={model.id}
                            title={model.description}
                          >
                            <strong>{PIPELINE_MODEL_LABELS[model.id] ?? model.displayName}</strong>
                            <span className="model-check">
                              {model.id === selectedModel ? "✓" : ""}
                            </span>
                          </button>
                        ))
                      : chatFamilies.map((family) => {
                          const familySelected = family.models.some(
                            (model) => model.id === selectedModel,
                          );
                          if (family.models.length === 1) {
                            const model = family.models[0];
                            return (
                              <button
                                type="button"
                                role="menuitem"
                                className={`model-variant${familySelected ? " is-selected" : ""}`}
                                onClick={() => onSelectModel(model.id)}
                                key={family.key}
                              >
                                <strong>{family.key.startsWith("gpt-") ? `GPT ${family.label}` : family.label}</strong>
                                <span className="model-check">
                                  {familySelected ? "✓" : ""}
                                </span>
                              </button>
                            );
                          }
                          const familyOpen = flyoutFamily === family.key;
                          return (
                            <div className="model-flyout-anchor" key={family.key}>
                              <button
                                type="button"
                                role="menuitem"
                                className={`model-variant${familySelected ? " is-selected" : ""}${familyOpen ? " is-open" : ""}`}
                                aria-haspopup="menu"
                                aria-expanded={familyOpen}
                                onClick={() =>
                                  setFlyoutFamily((current) =>
                                    current === family.key ? null : family.key,
                                  )
                                }
                              >
                                <strong>{family.key.startsWith("gpt-") ? `GPT ${family.label}` : family.label}</strong>
                                <span className="model-flyout-arrow">›</span>
                              </button>
                              {familyOpen && (
                                <div className="model-flyout" role="menu">
                                  {family.models.map((model) => (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                                      onClick={() => onSelectModel(model.id)}
                                      key={model.id}
                                    >
                                      <strong>{familyVariantLabel(family, model)}</strong>
                                      <span className="model-check">
                                        {model.id === selectedModel ? "✓" : ""}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type EffortSliderProps = {
  efforts: string[];
  activeIndex: number;
  activeLabel: string;
  onSelect: (index: number) => void;
  provider: AgentProviderId;
  modelId: string;
  models: string[];
  onCycleProvider: (direction: 1 | -1) => void;
  onSelectModel: (modelId: string) => void;
  controlLabel: string;
};

function ProviderMark({ provider }: { provider: AgentProviderId }) {
  if (provider === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" data-provider="anthropic" aria-hidden="true">
        <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
      </svg>
    );
  }
  if (provider === "kimi") {
    return (
      <svg viewBox="0 0 24 24" data-provider="kimi" aria-hidden="true">
        <path className="kimi-k" d="M4.2 3.2v17.6M4.2 12h6.1L15.8 3h4.1l-5.8 9 6.2 8.8h-4.4L10.3 12" />
        <path className="kimi-dot" d="M17.2 3.1h3.7v4.2h-3.7z" />
      </svg>
    );
  }
  if (provider === "deepseek") {
    return (
      <svg viewBox="0 0 24 24" data-provider="deepseek" aria-hidden="true">
        <path className="deepseek-whale" d="M2.2 11.6c1.8.3 3.5-.1 5-1.2 1.5-1 3.2-1.4 5.1-1.1l1.6-2.6c.5-.8 1.1-1.2 1.8-1.3-.1 1.1.1 2 .6 2.7.8-.8 1.8-1.1 3-.9-.2 1.4-1 2.5-2.4 3.1.7 4.6-2.2 8-7.2 8-4.2 0-6.8-2.2-7.5-6.7Z" />
        <path className="deepseek-belly" d="M5.5 13.4c2.4.9 4.8.6 7.1-.8-1 2.2-2.7 3.2-5.1 2.8" />
        <circle className="deepseek-eye" cx="13.7" cy="10.8" r=".8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" data-provider="codex" aria-hidden="true">
      {[0, 60, 120, 180, 240, 300].map((rotation) => (
        <path
          d="M12 2.8a4.5 4.5 0 0 1 4.5 4.5v3.8L14 12.6V7.3a2 2 0 0 0-2-2H8.2"
          transform={`rotate(${rotation} 12 12)`}
          key={rotation}
        />
      ))}
    </svg>
  );
}

function EffortSlider({
  efforts,
  activeIndex,
  activeLabel,
  onSelect,
  provider,
  modelId,
  models,
  onCycleProvider,
  onSelectModel,
  controlLabel,
}: EffortSliderProps) {
  const max = Math.max(0, efforts.length - 1);
  const progress = max > 0 ? (activeIndex / max) * 100 : 0;
  const thumbOffset = 9 - 18 * (progress / 100);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const wheelAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node))
        setModelMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelMenuOpen]);

  // React a wheel-t passzívként köti be, ezért a JSX `onWheel`-ből a
  // `preventDefault()` csak egy konzolhibát ír ("Unable to preventDefault inside
  // passive event listener invocation") — a beszélgetés eközben elgörgült a
  // provider-váltás alatt. Ezért kézzel, `passive: false`-szal kötjük be.
  const cycleProviderRef = useRef(onCycleProvider);
  cycleProviderRef.current = onCycleProvider;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (Math.abs(event.deltaY) < 2) return;
      event.preventDefault();
      const now = Date.now();
      if (now - wheelAtRef.current < 240) return;
      wheelAtRef.current = now;
      setModelMenuOpen(false);
      cycleProviderRef.current(event.deltaY > 0 ? 1 : -1);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="composer-effort-slider has-model-thumb"
      style={
        {
          "--effort-progress": `${progress}%`,
          "--effort-thumb-left": `calc(${progress}% + ${thumbOffset}px)`,
        } as CSSProperties
      }
      data-provider={provider}
      data-model={modelId}
      ref={rootRef}
    >
      <div className="composer-effort-track" aria-hidden="true">
        {efforts.map((effort, index) => (
          <span
            className={`${index === activeIndex ? "is-active" : ""}${index === 0 ? " is-first" : ""}${index === max ? " is-last" : ""}`}
            style={{ left: `${max > 0 ? (index / max) * 100 : 50}%` }}
            key={effort}
          />
        ))}
      </div>
      <span className="composer-submodel-label" aria-hidden="true">
        {shortModelLabel(modelId)}
      </span>
      <span
        className="composer-model-thumb"
        data-provider={provider}
        data-model={modelId}
        aria-hidden="true"
      >
        <ProviderMark provider={provider} />
      </span>
      <input
        type="range"
        min="0"
        max={max}
        step="1"
        value={activeIndex}
        onChange={(event) => onSelect(Number(event.currentTarget.value))}
        onContextMenu={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const thumbX =
            bounds.left + 9 + (bounds.width - 18) * (progress / 100);
          if (Math.abs(event.clientX - thumbX) <= 14)
            setModelMenuOpen((open) => !open);
        }}
        aria-label={`${controlLabel} reasoning erőssége`}
        aria-valuetext={activeLabel}
        aria-orientation="horizontal"
      />
      {modelMenuOpen && (
        <div
          className="composer-model-variants"
          role="menu"
          aria-label={`${PROVIDER_LABELS[provider]} modellek`}
          onContextMenu={(event) => event.preventDefault()}
        >
          {models.map((model) => (
            <button
              type="button"
              role="menuitem"
              className={model === modelId ? "is-selected" : ""}
              onClick={() => {
                onSelectModel(model);
                setModelMenuOpen(false);
              }}
              key={model}
            >
              {shortModelLabel(model)}
            </button>
          ))}
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
      : message.text;
  const final = isFinal ?? message.final;
  const isPending =
    message.role === "assistant" && !message.text.trim() && !final;
  const promptTimestamp =
    message.role === "user" ? messagePromptTimestamp(message) : undefined;
  const anchorId = messageAnchorId(message);
  const isSteer = message.interaction?.kind === "steer";

  return (
    <article
      className={`message ${message.role === "user" ? "user-message" : "assistant-message"}${isSteer ? " is-steer" : ""}${final ? " is-final" : ""}${!showAvatar ? " no-avatar" : ""}`}
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
        {isSteer && (
          <div className="message-interaction-badge">
            ⇢ TE · MENET KÖZBEN
            {message.interaction?.stageRole
              ? ` → ${STAGE_ROLE_LABELS[message.interaction.stageRole] ?? message.interaction.stageRole}`
              : ""}
          </div>
        )}
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
            message.role === "user" ? (
              <p>
                <InlineMarkdown text={visibleText} />
                {onQuoteJump &&
                  quoteBacklinkButtons(message.quoteRefs ?? [], onQuoteJump)}
              </p>
            ) : (
              <div className="message-answer-text">
                {answerParagraphs(visibleText)}
              </div>
            )
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
        {message.role === "user" && !isSteer && onRevert && (
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
const TreeRunMark = ({
  state,
  idleClassName,
}: {
  state: "thinking" | "saving" | null;
  idleClassName: string;
}) => {
  if (state === "thinking")
    return <ThinkingDots label="Ebben a beszélgetésben épp fut egy válasz" />;
  if (state === "saving")
    return (
      <span
        className="saving-mark"
        role="status"
        aria-label="A munkaterület mentése folyik"
        title="A válasz kész; a munkaterület mentése folyik"
      />
    );
  return <span className={idleClassName} />;
};

/** „Gondolkodik" jelzés a fában — a pont helyén, ugyanakkora helyen. */
const ThinkingDots = ({ label }: { label: string }) => (
  <span className="thinking-dots" role="status" aria-label={label} title={label}>
    <span />
    <span />
    <span />
  </span>
);

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

const PREVIEW_MIN_SCALE = 0.2;
const PREVIEW_MAX_SCALE = 12;

/**
 * Full-size preview for an agent-generated image.
 *
 * A block diagram is only useful if its labels can be read, so the view zooms
 * toward the pointer and pans by dragging. The image is rendered from a data
 * URL, which keeps SVG inert: no scripts, no network access.
 */
function ImagePreviewOverlay({
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
  // A panel a saját, teljes magasságú hasábjában él, ezért nincs sorkorlát és
  // lenyitó gomb: a lista lefelé kifér, és csak akkor görget, ha a hasáb
  // plafonjánál is több (~20+) fájl van.
  //
  // A nulla-változású fájlok (generált melléktermék) egyetlen csoportba
  // csuklanak — churn szerint, nem darabszám szerint, tehát amit a futás
  // ténylegesen írt, az mindig látszik.
  const [untouchedOpen, setUntouchedOpen] = useState(false);
  const view = useMemo(() => changeSummaryView(files), [files]);
  const labels = useMemo(() => {
    const ordered = [...view.changed, ...view.untouched];
    const text = changeRowLabels(ordered);
    return new Map(ordered.map((file, index) => [file, text[index]]));
  }, [view]);
  if (files.length === 0) return null;
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const statusLabel = (status: ChangeSummaryFile["status"]) =>
    status === "added" ? "ÚJ" : status === "removed" ? "TÖRÖLT" : null;
  const renderRow = (file: ChangeSummaryFile) => {
    const label = view.showStatus ? statusLabel(file.status) : null;
    const name = labels.get(file) ?? file.path;
    return (
      <li
        className={`${label ? "has-status" : ""}${view.showRemoved ? " has-removed" : ""}`.trim() || undefined}
        key={`${file.status}:${file.path}`}
        title={file.sourcePath ?? file.path}
      >
        {onPreviewImage && isPreviewableImagePath(file.path) ? (
          <button
            type="button"
            className="trace-change-preview"
            onClick={() => onPreviewImage(file.sourcePath ?? file.path)}
            title="Előnézet megnyitása"
          >
            <code>{name}</code>
          </button>
        ) : (
          <code>{name}</code>
        )}
        {label && <span className="trace-change-status">{label}</span>}
        <span className="trace-change-added">+{file.added}</span>
        {view.showRemoved && (
          <span className="trace-change-removed">−{file.removed}</span>
        )}
      </li>
    );
  };
  return (
    <aside className="trace-change-summary" aria-label="Fájlok és változások">
      <div className="trace-change-heading">
        <strong>FÁJLOK / VÁLTOZÁSOK</strong>
        <span
          className="trace-change-totals"
          aria-label={`${files.length} fájl, ${added} hozzáadott és ${removed} eltávolított sor`}
        >
          <span>{files.length} fájl</span>
          <span className="trace-change-total-added">+{added}</span>
          {removed > 0 && (
            <span className="trace-change-total-removed">−{removed}</span>
          )}
        </span>
      </div>
      <ul className="trace-change-list">
        {view.changed.map(renderRow)}
        {view.untouched.length > 0 && (
          <li className="trace-change-untouched">
            <button
              type="button"
              className="trace-change-untouched-toggle"
              aria-expanded={untouchedOpen}
              onClick={() => setUntouchedOpen((open) => !open)}
              title={
                untouchedOpen
                  ? "Változás nélküli fájlok elrejtése"
                  : "Változás nélküli fájlok megjelenítése"
              }
            >
              <span aria-hidden="true">{untouchedOpen ? "⌃" : "⌄"}</span>
              {`${view.untouched.length} fájl változás nélkül`}
            </button>
          </li>
        )}
        {untouchedOpen && view.untouched.map(renderRow)}
      </ul>
      {onRollback && (
        <div className="trace-change-footer">
          <button
            type="button"
            className="trace-change-rollback"
            onClick={onRollback}
            disabled={rollbackBusy}
            title="A turn összes fájlváltozásának visszaállítása a turn előtti állapotra"
          >
            {rollbackBusy ? "Visszavonás…" : "↺ Visszavonás"}
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * A fájl-hasáb keskeny ablakon csíkká csuklik, és a panel overlayben nyílik.
 *
 * 1100 px-es ablaknál mérve a válasz 295 px-re szorult, és a szakszöveg ott
 * már csúnyán tördel. Az engedményt keskenyen a fájloknak kell megtenniük, nem
 * a válasznak: a sáv 240 px helyett 28 px, a lista pedig egy kattintásra, a
 * kártya jobb széléről nyílik.
 */
function FilesLane({
  files,
  className,
  onRollback,
  rollbackBusy,
  onPreviewImage,
}: {
  files: ChangeSummaryFile[];
  className: string;
  onRollback?: () => void;
  rollbackBusy?: boolean;
  onPreviewImage?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Capture fázisban: a kártya saját kattintáskezelői (lépésválasztás,
    // előnézet) különben előbb futnának le, mint a záródás.
    const closeOnOutside = (event: globalThis.PointerEvent) => {
      if (!laneRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutside, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutside, true);
    };
  }, [open]);
  if (files.length === 0) return null;
  const added = files.reduce((total, file) => total + file.added, 0);
  return (
    <div className="files-lane" ref={laneRef}>
      {/* A csík mindig renderel; hogy melyik látszik — csík vagy panel —, azt
          a szélességi breakpoint dönti el, nem JS. */}
      <button
        type="button"
        className="files-lane-strip"
        aria-expanded={open}
        aria-label={`Fájlok és változások — ${files.length} fájl`}
        title={`${files.length} fájl · +${added}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="files-lane-strip-glyph" aria-hidden="true">
          ▤
        </span>
        <span className="files-lane-strip-count">{files.length}</span>
        <span className="files-lane-strip-added">+{added}</span>
      </button>
      <div className={`${className} files-lane-body${open ? " is-open" : ""}`}>
        <ChangeSummaryPanel
          files={files}
          onRollback={onRollback}
          rollbackBusy={rollbackBusy}
          onPreviewImage={onPreviewImage}
        />
      </div>
    </div>
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
  /** Chain-wide result shown beside the elapsed time, independent of the open phase. */
  runOutcome?: "accepted" | "changes" | "stopped";
  runHeader?: ReactNode;
  /** Number of real phases shown by the compact vertical phase rail. */
  runStageCount?: number;
  /** What a run offers once it has a verdict, e.g. re-running after a reject. */
  runFooter?: ReactNode;
  /** One chain-wide file list, reused below the steps in every phase. */
  runChangeSummary?: ChangeSummaryFile[];
  /** Reserve the same step-list height in every phase of one chain. */
  runStepSlotCount?: number;
  /** Which chain stage this card belongs to; labels the pre-plan step. */
  stageRole?: string;
  /** A futás projektgyökere: az élő fájllista ehhez képest ír útvonalat. */
  projectPath?: string;
  /**
   * A futás még tart, tehát a kódoló szakasz fájllistája a saját eseményeiből
   * áll össze. Lezárt futásnál nem szabad: ott a guard-jelentés a hiteles.
   */
  liveFiles?: boolean;
  /**
   * A futás kezdete. Ha meg van adva, a kártya órája innen jár — egy lánc
   * szakaszváltásánál nem indul újra a számlálás.
   */
  runStartedAt?: number;
  /**
   * A futás vége. Lezárt láncnál a fejléc órája eddig mér, így minden szakasz
   * fülén ugyanaz a teljes futásidő olvasható; a szakasz saját ideje a
   * LÉPÉSEK lista alján marad.
   */
  runCompletedAt?: number;
  provider?: AgentProviderId;
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
  onRegenerate,
  onRollbackChanges,
  rollbackBusy,
  onPreviewImage,
  runPosition,
  runTone,
  runOutcome,
  runHeader,
  runStageCount,
  runFooter,
  runChangeSummary,
  runStepSlotCount,
  stageRole,
  projectPath,
  liveFiles,
  runStartedAt,
  runCompletedAt,
  provider = "codex",
}: TurnProgressCardProps) {
  const detailedShellRef = useRef<HTMLDivElement>(null);
  const detailedGridRef = useRef<HTMLDivElement>(null);
  const [detailedPromptWidth, setDetailedPromptWidth] = useState<number>();
  useLayoutEffect(() => {
    const shell = detailedShellRef.current;
    const stream = shell?.closest(".message-stream");
    if (!shell || !stream) return;
    const prompt = Array.from(
      stream.querySelectorAll<HTMLElement>(".user-message .message-body"),
    )
      .filter(
        (candidate) =>
          Boolean(
            candidate.compareDocumentPosition(shell) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
      )
      .at(-1);
    if (!prompt) return;

    const measurePromptEdge = () => {
      const width = prompt.getBoundingClientRect().right - shell.getBoundingClientRect().left;
      setDetailedPromptWidth(Math.max(0, Math.round(width * 10) / 10));
    };
    measurePromptEdge();
    const observer = new ResizeObserver(measurePromptEdge);
    observer.observe(prompt);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [compact, quoteAnchorPrefix]);

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
          (hasMeaningfulPlanTiming && step.status === "completed") ||
          // A terv hordozott pontja akkor is a terv része, ha a kódoló nem
          // jelentett róla külön eseményt — kiszűrve a KÓD kártya listája a
          // futás végén rövidebb lett, mint amit a futás alatt mutatott.
          step.id.startsWith("carried-plan-")
        );
      });
  // A terv-fázis kártyája nem naplót mutat, hanem magát a tervet.
  const isPlanStage = stageRole === "plan";
  const isReviewStage = stageRole === "review" || stageRole === "plan_review";
  const isCodeOrReviewStage = stageRole === "code" || isReviewStage;
  const hasAnswer = Boolean(answer?.text.trim());
  // Íródó terv: a pontjai között nincs „épp ez fut", és nincs kiválasztott sem
  // — a lista egyszerűen egymás alá írja őket, ahogy megszületnek. A kiemelés
  // és a halványítás a kész terven, illetve a többi szakasz lépéslistáján
  // marad, ahol tényleg egy futó munkafázist jelöl.
  const planDrafting = isPlanStage && streaming;
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
  // model plan arrives. Once real plan steps exist, unassigned preparation
  // work is attached to the first real step; it is not a checklist step.
  // Terv-fázison a számozott pontok maguk a lépések. A tervfrissítésből
  // született lista erősebb; ez csak akkor lép be, ha az elmaradt.
  const derivedPlanSteps =
    isPlanStage && answer?.text
      ? numberedPlanSteps(answer.text).map((step) => ({
          ...step,
          status: (streaming ? "pending" : "completed") as PlanStep["status"],
        }))
      : [];
  // A terv kártyáján a terv pontjai a lépések — a tervező menet közbeni
  // munkafolyamat-todo-i nem. Amíg a szövegben nincs két számozott pont,
  // a lista „készül". Egyetlen számozott pont is teljes, érvényes terv.
  const effectivePlannedSteps = isPlanStage
    ? derivedPlanSteps.length >= 1
      ? derivedPlanSteps
      : []
    : plannedSteps;
  // Unassigned preparation/tool events are kept honest by attaching them to
  // the first real step once a real checklist exists. They must not become a
  // synthetic extra checklist item: that row was permanently selected by the
  // earliest Read/Grep event and made an 8-step stage render as 8+1.
  const steps =
    effectivePlannedSteps.length === 0 ? [fallbackStep] : effectivePlannedSteps;
  const prePlanDisplayStepId = plannedSteps[0]?.id ?? fallbackStep.id;
  // Egy szakasz lépéslistája menet közben lecserélődhet: a KÓD a hordozott terv
  // pontjaival indul, majd a kódoló saját todo-listája veszi át a helyüket, más
  // azonosítókkal. Az addig megírt kommentár a régi azonosítókra mutat, és
  // onnantól egyetlen lépés alatt sem látszott — a KÓD első egy-két sora így
  // tűnt el nyomtalanul, pedig meg volt írva. Az árva bejegyzés ugyanoda kerül,
  // ahová az előkészítő sorok: az első látható lépés alá.
  const stepIds = new Set(steps.map((step) => step.id));
  const isOrphanStepId = (stepId?: string | null) =>
    Boolean(stepId) && !isPrePlanStepId(stepId) && !stepIds.has(stepId!);
  const isUnassignedStepId = (stepId?: string | null) =>
    isPrePlanStepId(stepId) || isOrphanStepId(stepId);
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
    return isUnassignedStepId(entry.stepId)
      ? stepId === prePlanDisplayStepId
      : entry.stepId === stepId;
  };
  const activityBelongsToStep = (activity: CodeActivity, stepId: string) =>
    isUnassignedStepId(activity.planStepId)
      ? stepId === prePlanDisplayStepId
      : activity.planStepId === stepId;
  const hasTraceForStep = (stepId: string) =>
    activities.some(
      (activity) =>
        activityBelongsToStep(activity, stepId) &&
        (activity.kind !== "reasoning" || Boolean(activity.body?.trim())),
    ) ||
    commentary.some(
      (entry) =>
        Boolean(entry.body.trim()) && commentaryBelongsToStep(entry, stepId),
    );
  const hasUnassignedTrace =
    activities.some(
      (activity) =>
        isUnassignedStepId(activity.planStepId) &&
        (activity.kind !== "reasoning" || Boolean(activity.body?.trim())),
    ) ||
    commentary.some(
      (entry) => isUnassignedStepId(entry.stepId) && Boolean(entry.body.trim()),
    );
  // While streaming, follow the active step. Once the turn is complete, keep
  // the last step that actually has trace data selected instead of jumping to
  // a final plan step that may contain no commentary at all.
  const lastTracedStep = [...steps]
    .reverse()
    .find((step) => hasTraceForStep(step.id));
  const explicitActiveStep = plan.activeStepId
    ? steps.find((step) => step.id === plan.activeStepId)
    : undefined;
  const activeStep = isPlanStage
    ? // A terv pontjai nem munkafázisok: nincs köztük „épp ez fut", és a lista
      // vége sem jelent haladást. Írás közben az utolsó megszületett pontnál
      // tartunk, kész terven pedig az elsőnél — olvasási sorrendben. Enélkül a
      // kijelölés végig az elsőn állt, majd a terv elkészültekor átugrott az
      // utolsóra, mert azt hitte, ott tart a munka.
      (streaming ? (steps[steps.length - 1] ?? steps[0]) : steps[0])
    : streaming
      ? (explicitActiveStep ??
        lastTracedStep ??
        steps.find((step) => step.status === "inProgress") ??
        steps[0] ??
        steps[steps.length - 1])
      : ((hasAnswer && isCodeOrReviewStage ? steps.at(-1) : undefined) ??
        lastTracedStep ??
        (hasUnassignedTrace ? steps[0] : undefined) ??
        [...steps].reverse().find((step) => step.status === "completed") ??
        steps[0]);
  const [selectedStepId, setSelectedStepId] = useState(activeStep.id);
  /** Elrejtett lépés-oszlop: a válasz ilyenkor a teljes szélességet kapja. */
  const [stepsCollapsed, setStepsCollapsed] = useState(false);
  // Ugyanaz a két húzóka, mint a Nem-Részletes kártyán: a VÁLASZ és a LÉPÉSEK
  // határa, illetve az alsó keretvonal. A szélesség a közös
  // `--compact-answer-width`-en át megy, tehát a két mód egymásra illeszkedik.
  const [detailedAnswerWidth, setDetailedAnswerWidth] = useState<number>();
  const [detailedCardHeight, setDetailedCardHeight] = useState<number>();
  const [detailedResizing, setDetailedResizing] = useState<
    "columns" | "height" | null
  >(null);
  const detailedResizeRef = useRef<{
    kind: "columns" | "height";
    pointerId: number;
    startClient: number;
    startValue: number;
    min: number;
    max: number;
  } | null>(null);
  // A terv-fázis GONDOLKODÁS MENETE panelje nem naplót mutat, hanem magát a
  // tervet: RAW = a teljes szöveg (élőben streamelve), DETAIL = a kiválasztott
  // lépés szelete.
  const planContentRef = useRef<HTMLDivElement>(null);
  const planSegments = useMemo(
    () => planTextSegments(answer?.text ?? ""),
    [answer?.text],
  );
  const [inlineDiff, setInlineDiff] = useState<InlineCodeDiff | null>(null);
  const followActiveStepRef = useRef(true);

  // A kézi lépésválasztás csak az épp aktív lépés idejére szól: amikor a
  // futás új lépésre ugrik, a panel újra követ. Enélkül egy visszakattintás
  // után a nézet a régi lépésen ragadt, miközben a munka már máshol járt.
  const lastFollowTargetRef = useRef(activeStep.id);
  useEffect(() => {
    if (!steps.some((step) => step.id === selectedStepId))
      setSelectedStepId(activeStep.id);
    if (activeStep.id !== lastFollowTargetRef.current) {
      lastFollowTargetRef.current = activeStep.id;
      // Terv-fázisban az „aktív" pont csak az utolsó megszületett sor; egy
      // olvasás közbeni kézi választást nem rángat el minden új pont.
      if (!isPlanStage) followActiveStepRef.current = true;
    }
    if (followActiveStepRef.current) setSelectedStepId(activeStep.id);
  }, [activeStep.id, isPlanStage, selectedStepId, steps, streaming]);

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
  const selectedStepIndex = steps.findIndex(
    (step) => step.id === selectedStep.id,
  );
  const finalAnswerStep = isCodeOrReviewStage ? steps.at(-1) : undefined;
  const selectedIsFinalAnswerStep =
    Boolean(finalAnswerStep) && selectedStep.id === finalAnswerStep?.id;
  const selectedShowsFinalAnswer = isCodeOrReviewStage
    ? selectedIsFinalAnswerStep
    : !isPlanStage && hasAnswer;
  const finalAnswerStepLabel = "VÁLASZ";
  useEffect(() => {
    if (!isPlanStage || selectedStepIndex < 0) return;
    const container = planContentRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-plan-step-index="${selectedStepIndex}"]`,
    );
    if (!container || !target) return;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: Math.max(0, target.offsetTop - 6),
        behavior: streaming ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isPlanStage, selectedStepIndex, streaming]);
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
    // A parancs sora nem 110 karakternél ér véget: a Codex a bal oldalra a
    // teljes értelmezőt írja (`"C:\\WINDOWS\\…\\powershell.exe" -Command "…"`),
    // így a csonk pont a lényeget, magát a parancsot vágta le. Az előtag-
    // takarítás (cd, escape) után viszont ami sokáig tart, az tényleg hosszú:
    // a 400 karakter fölötti rész már nem olvasás, hanem görgetés.
    // Karakter- és sorplafon együtt: egy többsoros inline-script (python -c,
    // heredoc) 400 karakterből is tucatnyi rövid sort rak ki, és a panelt a
    // parancs törzse tölti meg a munka helyett. Az első sorok mutatják, mi
    // indult; a többi a fájlban van, nem itt.
    const clipBullet = (value: string) => {
      const clipped =
        value.length > 400 ? `${value.slice(0, 400)}…` : value;
      const lines = clipped.split("\n");
      return lines.length > 6 ? `${lines.slice(0, 6).join("\n")}\n…` : clipped;
    };
    const toolBullet = (activity: CodeActivity) =>
      activity.kind === "command"
        ? `$ ${clipBullet(
            stripLeadingCdPrefix(unescapeDoubledBackslashes(activity.detail)),
          )}`
        : activity.kind === "file"
          ? `Fájl — ${activity.detail}`
          : clipBullet(toolCallBullet(activity));
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
        const previous = entries[entries.length - 1];
        // Ugyanaz a parancs kétszer egymás után: a modell újrapróbálta. Két
        // azonos sor helyett egy sor és egy szorzó — a lista így arról szól,
        // mi történt, nem arról, hányszor gördült le ugyanaz.
        if (previous && (previous.baseBody ?? previous.body) === item.record.body) {
          previous.repeat = (previous.repeat ?? 1) + 1;
          previous.baseBody = item.record.body;
          previous.body = `${item.record.body}  (${previous.repeat}×)`;
          previous.codeActivity =
            previous.codeActivity ??
            (toolActivity.code || toolActivity.beforeCode || toolActivity.afterCode
              ? toolActivity
              : undefined);
          continue;
        }
        entries.push({
          id: `tool-${toolActivity.id}`,
          body: item.record.body,
          baseBody: item.record.body,
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
  const [expandedTechnicalSectionId, setExpandedTechnicalSectionId] =
    useState<string | null>(null);
  // Lásd a Nem-Részletes párját: az első kézi csukás után az automatika
  // elhallgat, különben minden új technikai sor visszanyitná a csoportot.
  const [technicalAutoPaused, setTechnicalAutoPaused] = useState(false);
  // A LÉPÉSEK hasáb nyitó animációja — a gondolkodás-hasáb mozdulatának párja.
  const [stepsOpening, setStepsOpening] = useState(false);
  const [expandedTraceDetailId, setExpandedTraceDetailId] =
    useState<string | null>(null);
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
    const list = thinkingListRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      if (streaming || list.scrollTop + list.clientHeight >= list.scrollHeight - 72)
        list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedStep.id, streaming, thinkingEntries]);
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
  // A fejléc órája a futásé: az egész lánc kezdetétől az egész lánc végéig
  // (élőben mostanáig). A szakaszváltás nem nullázza, és a lezárt kártya
  // bármelyik fülén ugyanaz a teljes futásidő olvasható — a „mennyi ideig
  // futott" kérdésre másutt nem volt válasz. A szakasz saját ideje nem vész
  // el: a LÉPÉSEK lista alján, az Összesen sorban áll.
  const elapsedEnd = streaming
    ? clockNow
    : (runCompletedAt ?? completedAtForDisplay);
  const elapsedStart = runStartedAt ?? startedAtForDisplay;
  const overallElapsed =
    elapsedStart !== undefined && elapsedEnd !== undefined
      ? formatElapsed(Math.max(0, elapsedEnd - elapsedStart))
      : "";
  const stageElapsedEnd = streaming ? clockNow : completedAtForDisplay;
  const stageElapsed =
    startedAtForDisplay !== undefined && stageElapsedEnd !== undefined
      ? formatElapsed(Math.max(0, stageElapsedEnd - startedAtForDisplay))
      : "";
  const answerInterrupted = Boolean(
    answer?.interrupted || hasInterruptedAnswerMarker(answer?.text ?? ""),
  );
  const runCounterState = streaming
    ? "running"
    : answerInterrupted || runOutcome === "stopped"
      ? "stopped"
      : runOutcome === "accepted"
        ? "passed"
        : runOutcome === "changes"
          ? "failed"
          : "complete";
  const runCounterGlyph =
    runCounterState === "passed"
      ? "✓"
      : runCounterState === "failed"
        ? "×"
        : runCounterState === "stopped"
          ? "■"
          : "";
  const runCounterLabel =
    runCounterState === "running"
      ? "Az AI dolgozik"
      : runCounterState === "stopped"
        ? "A futás leállítva"
        : runCounterState === "passed"
          ? "A futás eredménye: PASS"
          : runCounterState === "failed"
            ? "A futás eredménye: FAIL"
            : "A válasz kész";
  // A verdikt a kártya alján, színes sávként hangzik el; a nyers záró sor
  // ilyenkor kétszer mondaná ugyanazt.
  const answerBodyText = answer?.pipeline?.verdict
    ? textWithoutVerdictLine(answer?.text ?? "")
    : (answer?.text ?? "");
  // A lánc fájllistája a guard-jelentésből jön, az pedig csak a futás legvégén
  // készül el — a KÓD kártyáján addig semmi nem látszott, pedig a fájlok ott,
  // akkor születtek. Amíg a lánc fut, a kódoló szakasz saját fájlműveletei
  // adják a listát: a munka ilyenkor tényleg a fán van, a lánc csak a végén
  // állítja vissza a bázist. A tervező és a bíráló kártyáján soha nincs lista
  // — nem írnak fájlt, és egy „módosítva" kártya abszolút útvonalakkal a
  // bírálón pontosan ebből lett korábban. Lezárt futásnál a guard a hiteles:
  // egy leállított lánc munkája visszaáll, ott már nincs mit felsorolni.
  const filesStageRole = answer?.pipeline?.stageRole ?? stageRole;
  const filesFromActivities = filesStageRole
    ? filesStageRole === "code" && liveFiles === true
    : true;
  const changeSummary =
    answer?.changeSummary && answer.changeSummary.length > 0
      ? answer.changeSummary
      : filesFromActivities
        ? changeSummaryFromActivities(activities, projectPath)
        : [];
  const displayedChangeSummary =
    runChangeSummary && runChangeSummary.length > 0
      ? runChangeSummary
      : changeSummary;
  const visibleStepCount =
    isPlanStage && effectivePlannedSteps.length === 0 ? 0 : steps.length;
  const reservedStepSlots = Math.max(
    1,
    visibleStepCount,
    runStepSlotCount ?? 0,
  );
  const longestStepLabel = (isPlanStage && effectivePlannedSteps.length === 0
    ? []
    : steps
  ).reduce((longest, step) => Math.max(longest, step.step.trim().length), 0);
  // Measured against the app's 10 px UI face: label + marker + elapsed +
  // paddings. CSS still caps this at 40% so the answer remains the primary pane.
  const preferredStepLaneWidth = Math.max(
    260,
    Math.min(440, Math.ceil(86 + longestStepLabel * 5.2)),
  );
  const regenerateAction =
    hasAnswer && !streaming && onRegenerate ? (
      <button
        type="button"
        aria-label="Válasz újragenerálása"
        title="Újragenerálás"
        onClick={() => answer && onRegenerate(answer)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M13.25 5V2.25H10.5" />
          <path d="M13 4.25A5.5 5.5 0 1 0 13.2 11" />
        </svg>
      </button>
    ) : null;
  // A lépések oszlopa ugyanúgy elrejthető, mint a Nem-Részletes nézet
  // gondolkodás-hasábja, és a kapcsoló ugyanott, a reload mellett van.
  const stepsToggleAction = (
    <button
      type="button"
      className="compact-thinking-toolbar-toggle"
      aria-expanded={!stepsCollapsed}
      aria-label={
        stepsCollapsed ? "Lépések megnyitása" : "Lépések bezárása"
      }
      title={stepsCollapsed ? "Lépések megnyitása" : "Lépések bezárása"}
      onClick={() =>
        setStepsCollapsed((collapsed) => {
          if (collapsed) setStepsOpening(true);
          return !collapsed;
        })
      }
    >
      {/* Ugyanaz az irány, mint a Nem-Részletes gondolkodás-kapcsolóján:
          nyitva a becsukás iránya (‹), csukva a kinyitás iránya (›). */}
      <span aria-hidden="true">{stepsCollapsed ? "›" : "‹"}</span>
    </button>
  );
  // A Nem-Részletes nézetnek megvan a saját gondolkodás-csukó gombja; a lépés-
  // kapcsoló csak a Részletes rácsban jelent bármit, ezért csak oda kerül.
  const answerActions = regenerateAction ? (
    <div className="trace-answer-actions">{regenerateAction}</div>
  ) : null;
  const detailedAnswerActions = (
    <div className="trace-answer-actions">
      {regenerateAction}
      {stepsToggleAction}
    </div>
  );
  // A Nem-Részletes kártya két húzókájának párja. A szélesség a közös
  // `--compact-answer-width`-et állítja (ezt olvassa a `--detailed-answer-track`
  // képlete), a magasság pedig a rács fix magasságát és vele a sávok plafonját.
  const clampSize = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)));
  const startDetailedResize = (
    kind: "columns" | "height",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const grid = detailedGridRef.current;
    if (!grid) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const horizontal = kind === "columns";
    const answerLane = grid.querySelector<HTMLElement>(
      ".detailed-thinking-lane, .detailed-plan-lane",
    );
    const filesLane = grid.querySelector<HTMLElement>(".detailed-files-lane");
    detailedResizeRef.current = {
      kind,
      pointerId: event.pointerId,
      startClient: horizontal ? event.clientX : event.clientY,
      startValue: horizontal
        ? (answerLane?.offsetWidth ?? Math.round(grid.offsetWidth / 2))
        : grid.offsetHeight,
      min: horizontal ? DETAILED_ANSWER_MIN_WIDTH : DETAILED_ANSWER_MIN_HEIGHT,
      max: horizontal
        ? Math.max(
            DETAILED_ANSWER_MIN_WIDTH,
            grid.offsetWidth -
              DETAILED_STEPS_MIN_WIDTH -
              (filesLane?.offsetWidth ?? 0),
          )
        : Math.max(DETAILED_ANSWER_MIN_HEIGHT, window.innerHeight - 140),
    };
    setDetailedResizing(kind);
  };
  const moveDetailedResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = detailedResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const client = drag.kind === "columns" ? event.clientX : event.clientY;
    const next = clampSize(
      drag.startValue + (client - drag.startClient),
      drag.min,
      drag.max,
    );
    if (drag.kind === "columns") setDetailedAnswerWidth(next);
    else setDetailedCardHeight(next);
  };
  const finishDetailedResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (detailedResizeRef.current?.pointerId !== event.pointerId) return;
    detailedResizeRef.current = null;
    setDetailedResizing(null);
  };
  const resizeDetailedColumnsByKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const delta =
      event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    const grid = detailedGridRef.current;
    if (!delta || !grid) return;
    event.preventDefault();
    const answerLane = grid.querySelector<HTMLElement>(
      ".detailed-thinking-lane, .detailed-plan-lane",
    );
    const filesLane = grid.querySelector<HTMLElement>(".detailed-files-lane");
    setDetailedAnswerWidth(
      clampSize(
        (detailedAnswerWidth ?? answerLane?.offsetWidth ?? 0) + delta,
        DETAILED_ANSWER_MIN_WIDTH,
        Math.max(
          DETAILED_ANSWER_MIN_WIDTH,
          grid.offsetWidth -
            DETAILED_STEPS_MIN_WIDTH -
            (filesLane?.offsetWidth ?? 0),
        ),
      ),
    );
  };
  const resizeDetailedHeightByKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const delta =
      event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
    const grid = detailedGridRef.current;
    if (!delta || !grid) return;
    event.preventDefault();
    setDetailedCardHeight(
      clampSize(
        (detailedCardHeight ?? grid.offsetHeight) + delta,
        DETAILED_ANSWER_MIN_HEIGHT,
        Math.max(DETAILED_ANSWER_MIN_HEIGHT, window.innerHeight - 140),
      ),
    );
  };
  const selectStep = (stepId: string) => {
    followActiveStepRef.current = false;
    setSelectedStepId(stepId);
  };
  // Az íródó terv pontjai közül egyik sem „fut": a tervező szöveget ír, nem
  // lépéseket hajt végre. Enélkül az első pont futóként jelent meg, órával.
  const displayStatus = (step: PlanStep) =>
    !planDrafting &&
    streaming &&
    plan.activeStepId != null &&
    step.id === activeStep.id &&
    step.status === "pending"
      ? "inProgress"
      : step.status;
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

  const compactTurnId =
    answer?.turnId ??
    commentary.find((entry) => entry.turnId)?.turnId ??
    activities.find((activity) => activity.turnId)?.turnId;
  const durableReasoningBodies = new Set(
    activities
      .filter((activity) => activity.kind === "reasoning")
      .map((activity) => activity.body?.trim())
      .filter((body): body is string => Boolean(body)),
  );
  const compactTraceCommentary = commentary.filter(
    (entry) =>
      entry.body.trim() &&
      !durableReasoningBodies.has(entry.body.trim()),
  );
  const compactOneLine = (value: string, maxLength = 132) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
      : normalized;
  };
  const compactTraceText = (activity: CodeActivity) => {
    if (activity.kind === "reasoning") {
      // The compact view exposes concise provider summaries, never the raw
      // extended-thinking transcript. Claude's durable thinking commonly has
      // bold summary headings; without one the neutral activity label is safer.
      const summaries = [...(activity.body ?? "").matchAll(/\*\*([^*]+)\*\*/g)]
        .map((match) => match[1].trim())
        .filter(Boolean);
      return summaries.at(-1) ?? activity.label;
    }
    if (activity.kind === "command")
      return `$ ${stripLeadingCdPrefix(
        unescapeDoubledBackslashes(activity.detail),
      )}`;
    if (activity.kind === "file") return `Fájl — ${activity.detail}`;
    if (activity.kind === "tool") return toolCallBullet(activity);
    return activity.body?.trim() || activity.detail.trim() || activity.label;
  };
  const compactCommandSummary = (activity: CodeActivity) => {
    let command = stripLeadingCdPrefix(
      unescapeDoubledBackslashes(activity.detail),
    ).trim();
    command = command
      .replace(/^"[^"]*powershell(?:\.exe)?"\s+-Command\s+/i, "")
      .replace(/^powershell(?:\.exe)?\s+-Command\s+/i, "")
      .replace(/^['"]|['"]$/g, "");
    return `$ ${compactOneLine(command, 116)}`;
  };
  const compactActivityPresentation = (activity: CodeActivity) => {
    const detail = compactTraceText(activity);
    const presentation: CompactTraceEvent["presentation"] =
      activity.kind === "reasoning"
        ? looksHungarianNarrative(detail) && detail !== activity.label
          ? "narrative"
          : "reasoning"
        : activity.kind;
    const summary =
      activity.kind === "command"
        ? compactCommandSummary(activity)
        : presentation === "narrative"
          ? detail
          : compactOneLine(detail);
    return {
      presentation,
      summary,
      detail:
        presentation === "reasoning"
          ? summary
          : detail.trim() === summary.trim()
            ? summary
            : detail,
      important:
        activity.status === "error" ||
        /approval|engedély|jóváhagy|question|kérdés/i.test(
          `${activity.eventType} ${activity.label}`,
        ),
    };
  };
  const compactTraceRecords = new Map<
    string,
    { activity?: CodeActivity; commentary?: CommentaryEntry }
  >();
  const compactTrace: CompactTraceEvent[] = [];
  for (const activity of activities) {
    const id = `activity:${activity.id}`;
    const display = compactActivityPresentation(activity);
    compactTraceRecords.set(id, { activity });
    compactTrace.push({
      id,
      turnId: activity.turnId,
      sequence: activity.id,
      kind: activity.kind === "reasoning" ? "internal" : "activity",
      ...display,
    });
  }
  compactTraceCommentary.forEach((entry, index) => {
    const id = `commentary:${entry.id}`;
    const text = entry.body.trim();
    const narrative = looksHungarianNarrative(text);
    const important =
      entry.status === "error" ||
      /approval|engedély|jóváhagy|question|kérdés|hiba|failed|error/i.test(text);
    const summary = narrative ? text : compactOneLine(text);
    compactTraceRecords.set(id, { commentary: entry });
    compactTrace.push({
      id,
      turnId: entry.turnId,
      kind:
        entry.channel === "reasoning-summary" ? "internal" : "activity",
      presentation: narrative
        ? "narrative"
        : entry.channel === "status"
          ? "status"
          : "reasoning",
      summary,
      detail: narrative || text === summary ? summary : text,
      important,
      sequence:
        entry.sequence ??
        (activities.at(-1)?.id ?? Date.now()) + (index + 1) / 1000,
    });
  });
  const detailedTraceSections = buildCompactTraceSections(
    compactTrace.filter((item) => {
      const record = compactTraceRecords.get(item.id);
      if (record?.activity)
        return activityBelongsToStep(record.activity, selectedStep.id);
      if (record?.commentary)
        return commentaryBelongsToStep(record.commentary, selectedStep.id);
      return true;
    }),
  );
  // Futás közben a technikai csoport magától nyílik, hogy látszódjon, ahogy
  // telnek a sorai — és becsukódik, amint valódi mondat (narratív elem)
  // érkezik. Lezárt futásnál a kézi állítás marad érvényben.
  useEffect(() => {
    if (!streaming || technicalAutoPaused) return;
    const last = detailedTraceSections.at(-1);
    if (!last) return;
    setExpandedTechnicalSectionId(last.kind === "technical" ? last.id : null);
  }, [streaming, detailedTraceSections, technicalAutoPaused]);
  // A nyitó animáció egy körre él: utána a sáv a saját helyén marad.
  useEffect(() => {
    if (!stepsOpening) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStepsOpening(false);
      return;
    }
    const timeout = window.setTimeout(() => setStepsOpening(false), 230);
    return () => window.clearTimeout(timeout);
  }, [stepsOpening]);
  useLayoutEffect(() => {
    const grid = detailedGridRef.current;
    const content = isPlanStage
      ? planContentRef.current
      : thinkingListRef.current;
    const lane = content?.closest<HTMLElement>(".detailed-thinking-lane");
    if (!grid || !content || !lane) return;

    const measureDetailedAnswerHeight = () => {
      const laneStyle = window.getComputedStyle(lane);
      const verticalPadding =
        Number.parseFloat(laneStyle.paddingTop) +
        Number.parseFloat(laneStyle.paddingBottom);
      const nextHeight = `${detailedAnswerPanelHeight(
        content.scrollHeight,
        verticalPadding,
      )}px`;
      if (
        grid.style.getPropertyValue("--detailed-answer-height") !== nextHeight
      )
        grid.style.setProperty("--detailed-answer-height", nextHeight);
    };

    measureDetailedAnswerHeight();
    const observer = new ResizeObserver(measureDetailedAnswerHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    answerBodyText,
    detailedTraceSections.length,
    expandedTechnicalSectionId,
    expandedTraceDetailId,
    isPlanStage,
    planSegments.length,
    selectedStep.id,
    streaming,
  ]);
  const compactTimeline = buildCompactAnswerTimeline({
    answers: [],
    trace: compactTrace,
    finalAnswer: hasAnswer
      ? {
          id: answer!.id ?? answerAnchorId,
          turnId: answer!.turnId,
          text: answerBodyText,
          live: streaming,
        }
      : undefined,
    streaming,
    turnId: compactTurnId,
  });
  const renderCompactTraceAction = (
    traceItem: CompactTraceEvent,
  ): ReactNode => {
    const activity = compactTraceRecords.get(traceItem.id)?.activity;
    if (
      !activity ||
      (!activity.code && !activity.beforeCode && !activity.afterCode)
    )
      return null;
    return (
      <button
        type="button"
        className="trace-code-button"
        onClick={() => openInlineDiff(activity)}
        aria-label="Kóddiff megnyitása"
        title="Kóddiff megnyitása"
      >
        &lt;/&gt;
      </button>
    );
  };

  const runClasses =
    (runPosition ? ` in-run is-run-${runPosition}` : "") +
    (runTone ? ` is-verdict-${runTone}` : "");
  if (compact) {
    return (
      <>
      {runHeader}
      <CompactAnswersTimeline
        className={`compact-answer-card compact-answers-timeline${answerInterrupted ? " is-interrupted" : ""}${runClasses}`}
        quoteAnchor={answerAnchorId}
        blocks={compactTimeline}
        streaming={streaming}
        interrupted={answerInterrupted}
        elapsed={overallElapsed}
        statusIcon={<ProviderMark provider={provider} />}
        actions={answerActions}
        renderAnswer={(block: CompactAnswerBlock) =>
          // A DeepSeek futás közben tagolás nélkül fűzi egymás után a
          // szerszámhívások közti mondatait: egyetlen, egyre hosszabb
          // szövegtömb lesz belőle, amiben nem látszik, hol ér véget az egyik
          // gondolat. Ott — és csak ott — kap minden sor külön bulletet.
          // A többi szolgáltató saját markdown-szerkezetet ír (címsorok,
          // listák), arra ráültetve a sor-bullet dupla felsorolást adna.
          streaming && provider === "deepseek" ? (
            <ul className="compact-answer-stream">
              {liveNarrationLines(block.text).map((line, index) => (
                <li key={`${index}:${line.slice(0, 24)}`}>
                  <span className="trace-thinking-bullet" aria-hidden="true">
                    •
                  </span>
                  <div className="compact-answer-text">
                    {answerParagraphs(line, [], onQuoteJump)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="compact-answer-text">
              {answerParagraphs(
                block.text,
                block.final ? answerQuoteRefs : [],
                onQuoteJump,
              )}
            </div>
          )
        }
        renderTraceText={(text) => <InlineMarkdown text={text} />}
        renderTraceAction={renderCompactTraceAction}
        changes={
          changeSummary.length > 0 ? (
            <FilesLane
              className="compact-answer-changes"
              files={changeSummary}
              onRollback={onRollbackChanges}
              rollbackBusy={rollbackBusy}
              onPreviewImage={onPreviewImage}
            />
          ) : null
        }
        footer={runFooter}
      />
      </>
    );
  }

  return (
    <div
      ref={detailedShellRef}
      className={`detailed-run-shell${runHeader ? " has-phase-rail" : ""}`}
      style={
        {
          "--run-stage-count": Math.max(1, runStageCount ?? 1),
          "--detailed-prompt-width": detailedPromptWidth
            ? `${detailedPromptWidth}px`
            : "720px",
        } as CSSProperties
      }
    >
      {runHeader}
      <article
        className={`turn-progress-card trace-card detailed-trace-card${streaming ? " is-live" : ""}${answerInterrupted ? " is-interrupted" : ""}${runClasses}`}
        aria-label="Lépések és gondolkodás"
      >
        <div
          className={`compact-answer-status-rail detailed-answer-status-rail is-${runCounterState}`}
          aria-label={runCounterLabel}
        >
          {!runHeader && (
            <div className="compact-answer-provider-mark">
              <ProviderMark provider={provider} />
            </div>
          )}
          <time>
            {runCounterGlyph && (
              <span className="detailed-run-result-mark" aria-hidden="true">
                {runCounterGlyph}
              </span>
            )}
            <span>{overallElapsed || (streaming ? "0:00" : "—")}</span>
          </time>
        </div>

        <div
          ref={detailedGridRef}
          className={`detailed-trace-grid${isPlanStage ? " is-plan-stage" : " is-work-stage"}${stepsCollapsed ? " is-steps-collapsed" : ""}${displayedChangeSummary.length > 0 ? " has-file-lane" : ""}${detailedResizing === "columns" ? " is-resizing-columns" : ""}${detailedResizing === "height" ? " is-resizing-height" : ""}`}
          style={
            {
              "--detailed-step-slots": reservedStepSlots,
              "--detailed-steps-width": `${preferredStepLaneWidth}px`,
              ...(detailedAnswerWidth
                ? { "--compact-answer-width": `${detailedAnswerWidth}px` }
                : {}),
              ...(detailedCardHeight
                ? {
                    "--detailed-card-height": `${detailedCardHeight}px`,
                    "--detailed-lane-cap": `${detailedCardHeight}px`,
                  }
                : {}),
            } as CSSProperties
          }
        >
          {/* A rácson ül, nem a görgethető válaszsávon: onnan a gomb elgörgött
              a tartalommal, itt viszont végig a válasz felett marad. */}
          <div className="detailed-answer-toolbar">{detailedAnswerActions}</div>
          <section
            className={`detailed-trace-lane detailed-steps-lane${stepsOpening ? " is-opening" : ""}`}
            aria-label="Lépések listája"
          >
            <div
              className="trace-step-list detailed-step-list"
              data-quote-selectable="true"
              role="list"
            >
              {(isPlanStage && effectivePlannedSteps.length === 0
                ? []
                : steps
              ).map((step, stepIndex) => {
                const disabled =
                  planDrafting ||
                  (streaming &&
                    step.status === "pending" &&
                    step.id !== activeStep.id &&
                    !hasTraceForStep(step.id));
                const currentStep =
                  !planDrafting && streaming && step.id === activeStep.id;
                const elapsed = stepElapsedFor(step);
                const finalAnswerRow = finalAnswerStep?.id === step.id;
                const verdictRowClass =
                  finalAnswerRow && isReviewStage && runTone
                    ? ` is-verdict-step is-verdict-${runTone}`
                    : "";
                return (
                  <div
                    className="trace-step-target"
                    key={step.id}
                    data-quote-anchor={quoteAnchor(`step:${step.id}`)}
                  >
                    <button
                      type="button"
                      role="listitem"
                      className={
                        planDrafting
                          ? "trace-step-row is-plain"
                          : `trace-step-row trace-step-row-${displayStatus(step)}${selectedStep.id === step.id ? " is-selected" : ""}${currentStep ? " is-current" : ""}${disabled ? " is-disabled" : ""}${finalAnswerRow ? " is-final-answer-step" : ""}${verdictRowClass}`
                      }
                      onClick={() => selectStep(step.id)}
                      disabled={disabled}
                      aria-pressed={
                        planDrafting ? undefined : selectedStep.id === step.id
                      }
                    >
                      <span
                        className="trace-step-marker is-numbered"
                        data-step-number={stepIndex + 1}
                        aria-hidden="true"
                      >
                        <span className="detailed-step-index">{stepIndex + 1}</span>
                      </span>
                      <span className="trace-step-name">
                        {withoutLeadingStepNumber(step.step)}
                      </span>
                      {(elapsed || (finalAnswerRow && !isReviewStage)) && (
                        <span className="trace-step-meta">
                          {finalAnswerRow && !isReviewStage && (
                            <span className="trace-step-final-mark">
                              {finalAnswerStepLabel}
                            </span>
                          )}
                          {elapsed && (
                            <span className="trace-step-elapsed">{elapsed}</span>
                          )}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
              {isPlanStage && effectivePlannedSteps.length === 0 && (
                <div className="trace-thinking-empty detailed-lane-empty">
                  {streaming ? (
                    <span className="trace-answer-spinner" aria-hidden="true" />
                  ) : (
                    <span className="trace-thinking-empty-text">
                      A terv nem tartalmaz külön lépéslistát.
                    </span>
                  )}
                </div>
              )}
              {!isPlanStage && steps.length === 0 && (
                <div className="trace-thinking-empty detailed-lane-empty">
                  <span className="trace-thinking-empty-text">
                    Ez a szakasz nem rögzített külön lépést.
                  </span>
                </div>
              )}
              {isReviewStage && runFooter}
              {stageElapsed && (
                <div className="trace-total-elapsed detailed-steps-total">
                  <time>{stageElapsed}</time>
                </div>
              )}
            </div>
          </section>

          <section
            className={`detailed-trace-lane detailed-thinking-lane${isPlanStage ? " detailed-plan-lane" : ""}`}
            data-quote-selectable="true"
            data-quote-anchor={quoteAnchor(`thinking:${selectedStep.id}`)}
            aria-label="Gondolkodás menete"
          >
            {isPlanStage ? (
              <>
                <div
                  ref={planContentRef}
                  className="trace-thinking-list trace-plan-content detailed-plan-content"
                  data-quote-anchor={answerAnchorId}
                >
                  {planSegments.length > 0 ? (
                    planSegments.map((segment, segmentIndex) =>
                      segment.kind === "step" ? (
                        <section
                          className={`detailed-plan-step${segment.stepIndex === selectedStepIndex ? " is-highlighted" : ""}`}
                          data-plan-step-index={segment.stepIndex}
                          key={`plan-step-${segment.stepIndex}`}
                        >
                          <span
                            className="detailed-plan-step-number"
                            aria-hidden="true"
                          >
                            <span className="detailed-plan-step-index">
                              {segment.number}
                            </span>
                            <span className="detailed-plan-step-period">.</span>
                          </span>
                          <div className="detailed-plan-step-body">
                            {answerParagraphs(
                              planStepBody(segment.text),
                              answerQuoteRefs,
                              onQuoteJump,
                            )}
                          </div>
                        </section>
                      ) : (
                        <div
                          className="detailed-plan-context"
                          key={`plan-context-${segmentIndex}`}
                        >
                          {answerParagraphs(
                            segment.text,
                            answerQuoteRefs,
                            onQuoteJump,
                          )}
                        </div>
                      ),
                    )
                  ) : (
                    <div className="trace-thinking-empty detailed-lane-empty">
                      {streaming ? (
                        <span className="trace-answer-spinner" aria-hidden="true" />
                      ) : (
                        <span className="trace-thinking-empty-text">
                          A terv szövege nem érkezett meg.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <ul
                className="compact-thinking-list detailed-thinking-list"
                ref={thinkingListRef}
              >
                {detailedTraceSections.map((section: CompactTraceSection) =>
                  section.kind === "primary" ? (
                    <li
                      className={`trace-thinking-item compact-primary-trace${section.item.presentation === "narrative" ? " is-narrative" : " is-important"}`}
                      key={section.id}
                    >
                      {section.item.presentation === "narrative" ? (
                        <>
                          <span className="trace-thinking-bullet">•</span>
                          <p><InlineMarkdown text={section.item.summary ?? ""} /></p>
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
                            setExpandedTraceDetailId((current) =>
                              current === section.item.id ? null : section.item.id,
                            )
                          }
                          aria-expanded={expandedTraceDetailId === section.item.id}
                        >
                          <span className="trace-thinking-bullet">•</span>
                          <span className="compact-technical-summary">
                            {section.item.summary ?? ""}
                          </span>
                          {section.item.detail &&
                            section.item.detail !== section.item.summary && (
                              <span className="trace-internal-caret" aria-hidden="true">
                                {expandedTraceDetailId === section.item.id ? "▾" : "▸"}
                              </span>
                            )}
                        </button>
                      )}
                      {renderCompactTraceAction(section.item)}
                      {section.item.presentation !== "narrative" &&
                        expandedTraceDetailId === section.item.id && (
                          <div className="compact-technical-detail">
                            {section.item.detail ?? ""}
                          </div>
                        )}
                    </li>
                  ) : (
                    <li className="compact-technical-section" key={section.id}>
                      <div className="compact-technical-heading">
                        <span className="trace-thinking-bullet">•</span>
                        <button
                          type="button"
                          className="compact-technical-toggle"
                          onClick={() => {
                            setTechnicalAutoPaused(true);
                            setExpandedTechnicalSectionId((current) =>
                              current === section.id ? null : section.id,
                            );
                          }}
                          aria-expanded={expandedTechnicalSectionId === section.id}
                        >
                          <span className="compact-technical-label">{section.label}</span>
                        </button>
                      </div>
                      {expandedTechnicalSectionId === section.id && (
                        <ul className="compact-technical-details">
                          {section.items.map((item) => {
                            const detail = item.detail?.trim() ?? "";
                            const summary = item.summary?.trim() ?? "";
                            const expandable = Boolean(detail && detail !== summary);
                            const detailOpen = expandedTraceDetailId === item.id;
                            return (
                              <li className="compact-technical-item" key={item.id}>
                                <div className="compact-technical-item-line">
                                  <button
                                    type="button"
                                    className="compact-technical-item-toggle"
                                    disabled={!expandable}
                                    onClick={() =>
                                      expandable &&
                                      setExpandedTraceDetailId((current) =>
                                        current === item.id ? null : item.id,
                                      )
                                    }
                                    aria-expanded={expandable ? detailOpen : undefined}
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
                                    <span className="compact-technical-summary">{summary}</span>
                                    {expandable && (
                                      <span className="trace-internal-caret" aria-hidden="true">
                                        {detailOpen ? "▾" : "▸"}
                                      </span>
                                    )}
                                  </button>
                                  {renderCompactTraceAction(item)}
                                </div>
                                {detailOpen && (
                                  <div className="compact-technical-detail">{detail}</div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  ),
                )}
                {selectedShowsFinalAnswer &&
                  (hasAnswer || streaming || changeSummary.length > 0) && (
                    <li
                      className={`detailed-final-answer${isReviewStage && runTone ? ` is-verdict-${runTone}` : ""}`}
                      data-quote-anchor={answerAnchorId}
                    >
                      <div className="turn-progress-answer-body detailed-final-answer-body">
                        {hasAnswer && (
                          <div className="trace-answer-text">
                            {answerParagraphs(
                              answerBodyText,
                              answerQuoteRefs,
                              onQuoteJump,
                            )}
                          </div>
                        )}
                        {streaming && (
                          <span
                            className="trace-answer-spinner"
                            aria-label="Válasz készül"
                          />
                        )}
                      </div>
                    </li>
                  )}
                {detailedTraceSections.length === 0 &&
                  !(selectedShowsFinalAnswer && (hasAnswer || streaming)) && (
                    <li className="trace-thinking-empty detailed-lane-empty">
                      {streaming ? (
                        <span className="trace-answer-spinner" aria-hidden="true" />
                      ) : (
                        <span className="trace-thinking-empty-text">
                          Ehhez a lépéshez nem érkezett külön összefoglaló.
                        </span>
                      )}
                    </li>
                  )}
              </ul>
            )}
          </section>

          {/* A fájlok a rács harmadik hasábja a lépések mellett, a másik két
              sávval azonos magasságban — nem a válasz aljára fűzött panel. */}
          {displayedChangeSummary.length > 0 && (
            <div className="detailed-trace-lane detailed-files-lane">
              <FilesLane
                className="detailed-step-changes"
                files={displayedChangeSummary}
                onRollback={onRollbackChanges}
                rollbackBusy={rollbackBusy}
                onPreviewImage={onPreviewImage}
              />
            </div>
          )}

          {/* Ugyanaz a két húzóka, mint a Nem-Részletes kártyán: a VÁLASZ és a
              LÉPÉSEK határa, illetve az alsó keretvonal. */}
          {!stepsCollapsed && (
            <div
              className="detailed-column-resizer"
              role="separator"
              aria-label="Válasz és lépések szélességének állítása"
              aria-orientation="vertical"
              aria-valuemin={DETAILED_ANSWER_MIN_WIDTH}
              aria-valuenow={detailedAnswerWidth}
              tabIndex={0}
              title="Panelek szélességének állítása"
              onKeyDown={resizeDetailedColumnsByKeyboard}
              onPointerDown={(event) => startDetailedResize("columns", event)}
              onPointerMove={moveDetailedResize}
              onPointerUp={finishDetailedResize}
              onPointerCancel={finishDetailedResize}
              onLostPointerCapture={finishDetailedResize}
            />
          )}
          <div
            className="detailed-height-resizer"
            role="separator"
            aria-label="Panel magasságának állítása"
            aria-orientation="horizontal"
            aria-valuemin={DETAILED_ANSWER_MIN_HEIGHT}
            aria-valuenow={detailedCardHeight}
            tabIndex={0}
            title="Panelmagasság állítása"
            onKeyDown={resizeDetailedHeightByKeyboard}
            onPointerDown={(event) => startDetailedResize("height", event)}
            onPointerMove={moveDetailedResize}
            onPointerUp={finishDetailedResize}
            onPointerCancel={finishDetailedResize}
            onLostPointerCapture={finishDetailedResize}
          />
        </div>


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
      </article>
    </div>
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
  // In the composer, detailed mode is now synonymous with the multi-agent
  // pipeline. Persisted historical single-agent turns can still render their
  // old detailed trace; only creating a new one is no longer offered.
  const [showDetailedTrace, setShowDetailedTrace] = useState(false);
  const [composerControlFlip, setComposerControlFlip] = useState<{
    phase: "out" | "in";
    targetDetailed: boolean;
  } | null>(null);
  const [pipelineRecipes, setPipelineRecipes] = useState<PipelineRecipe[]>(
    isTauri ? [] : PREVIEW_PIPELINE_RECIPES,
  );
  const [pipelineRecipeId, setPipelineRecipeId] = useState(() =>
    localStorage.getItem("min-pipeline-recipe") ?? "plan_code_review",
  );
  // Which phase of a running chain the reader is looking at. Null follows the
  // one that is actually running, which is what a progress display should do.
  const [liveStageChoice, setLiveStageChoice] = useState<number | null>(null);

  // Per-stage model and reasoning, keyed by `${recipeId}:${stageIndex}`. Empty
  // means "keep what the preset recommends", so the picker never has to
  // pre-fill values the user did not choose.
  const [pipelineStageOverrides, setPipelineStageOverrides] = useState<
    Record<
      string,
      {
        model?: string;
        effort?: string;
        provider?: AgentProviderId;
        accessProfile?: AgentAccessProfile;
      }
    >
  >({});
  const stageOverrideKey = (index: number) =>
    `${activePipelineRecipe?.id ?? ""}:${index}`;
  const stageValue = (index: number, field: "model" | "effort") => {
    const stage = activePipelineRecipe?.stages[index];
    const override = pipelineStageOverrides[stageOverrideKey(index)];
    // A vendor switch invalidates the model that belonged to the old one.
    if (field === "effort") {
      const allowed = providerEfforts(stageProvider(index));
      const candidate = override?.effort ?? stage?.effort ?? "";
      return allowed.includes(candidate)
        ? candidate
        : (allowed.includes("high") ? "high" : allowed[0] ?? "");
    }
    const vendor = stageProvider(index);
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
  const stageAccessProfile = (index: number) =>
    pipelineStageOverrides[stageOverrideKey(index)]?.accessProfile ??
    accessProfileOfModel(stageValue(index, "model")) ??
    activePipelineRecipe?.stages[index]?.accessProfile;
  /** The values a stage may cycle through, in a stable order. */
  const stageChoices = (index: number, field: "model" | "effort") => {
    const stage = activePipelineRecipe?.stages[index];
    if (!stage) return [] as string[];
    if (field === "effort") return providerEfforts(stageProvider(index));
    return PIPELINE_MODELS[stageProvider(index)];
  };
  const setStageValue = (
    index: number,
    field: "model" | "effort",
    value: string,
  ) => {
    setPipelineStageOverrides((state) => ({
      ...state,
      [stageOverrideKey(index)]: {
        ...state[stageOverrideKey(index)],
        [field]: value,
        ...(field === "model"
          ? { accessProfile: accessProfileOfModel(value) }
          : {}),
      },
    }));
  };
  /** Stepping instead of a dropdown: the chain stays two lines tall. */
  const cycleStageValue = (
    index: number,
    field: "model" | "effort" | "vendor",
    direction: 1 | -1,
  ) => {
    if (field === "vendor") {
      const currentIndex = COMPOSER_PROVIDERS.indexOf(stageProvider(index));
      const next =
        COMPOSER_PROVIDERS[
          (currentIndex + direction + COMPOSER_PROVIDERS.length) %
            COMPOSER_PROVIDERS.length
        ] ?? COMPOSER_PROVIDERS[0];
      setPipelineStageOverrides((state) => ({
        ...state,
        [stageOverrideKey(index)]: {
          ...state[stageOverrideKey(index)],
          provider: next,
          accessProfile: undefined,
          // The old vendor's model cannot run on the new one.
          model: undefined,
          effort: undefined,
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
    setStageValue(index, field, next);
  };
  const activePipelineRecipe =
    pipelineRecipes.find((recipe) => recipe.id === pipelineRecipeId) ??
    pipelineRecipes[0];
  const selectPipelineRecipe = (recipeId: string) => {
    setPipelineRecipeId(recipeId);
    localStorage.setItem("min-pipeline-recipe", recipeId);
  };
  const setCodingPipelineEnabled = (enabled: boolean) => {
    const target = pipelineRecipes.find((recipe) =>
      enabled
        ? recipeReviewTarget(recipe) === "implementation"
        : recipeReviewTarget(recipe) === "plan",
    );
    if (target) selectPipelineRecipe(target.id);
  };

  // Every phase is the same two-cell row: role + model-bearing effort slider.
  // Keeping all three rows on one grid is what makes their tracks pixel-aligned.
  const renderComposerStageRow = (
    stage: PipelineRecipeStage,
    index: number,
  ) => {
    const isCodeStage = stage.role === "code";
    const efforts = stageChoices(index, "effort");
    const activeEffort = stageValue(index, "effort") || efforts[0] || "";
    const activeEffortIndex = Math.max(0, efforts.indexOf(activeEffort));
    return (
      <div className="composer-stage-row" key={`stage-${stage.role}-${index}`}>
        <span className="composer-stage-role">
          {isCodeStage ? (
            <label
              className="composer-stage-toggle"
              title="KÓD bekapcsolása — TERV → KÓD → REVIEW"
            >
              <input
                type="checkbox"
                checked
                onChange={(event) =>
                  setCodingPipelineEnabled(event.currentTarget.checked)
                }
                aria-label="KÓD szakasz bekapcsolása"
              />
              <span>KÓD</span>
            </label>
          ) : (
            stage.role === "plan_review"
              ? "REVIEW"
              : STAGE_ROLE_LABELS[stage.role] ?? stage.role
          )}
        </span>
        <EffortSlider
          efforts={efforts}
          activeIndex={activeEffortIndex}
          activeLabel={activeEffort}
          onSelect={(effortIndex) => {
            const effort = efforts[effortIndex];
            if (effort) setStageValue(index, "effort", effort);
          }}
          provider={stageProvider(index)}
          modelId={stageValue(index, "model") ?? ""}
          models={stageChoices(index, "model")}
          onCycleProvider={(direction) =>
            cycleStageValue(index, "vendor", direction)
          }
          onSelectModel={(model) => setStageValue(index, "model", model)}
          controlLabel={
            stage.role === "plan_review"
              ? "REVIEW"
              : STAGE_ROLE_LABELS[stage.role] ?? stage.role
          }
        />
      </div>
    );
  };
  const composerPlanStage = activePipelineRecipe?.stages.find(
    (stage) => stage.role === "plan",
  );
  const composerPlanStageIndex = composerPlanStage
    ? activePipelineRecipe?.stages.indexOf(composerPlanStage) ?? -1
    : -1;
  const composerCodeStage = activePipelineRecipe?.stages.find(
    (stage) => stage.role === "code",
  );
  const composerCodeStageIndex = composerCodeStage
    ? activePipelineRecipe?.stages.indexOf(composerCodeStage) ?? -1
    : -1;
  const composerReviewStage = activePipelineRecipe?.stages.find(
    (stage) => stage.role === "review" || stage.role === "plan_review",
  );
  const composerReviewStageIndex = composerReviewStage
    ? activePipelineRecipe?.stages.indexOf(composerReviewStage) ?? -1
    : -1;
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
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [providerAuthStatuses, setProviderAuthStatuses] = useState<
    Partial<Record<AgentAccessProfile, AgentAuthStatus>>
  >({});
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<
    Partial<Record<AgentAccessProfile, string>>
  >({});
  const [providerAuthBusy, setProviderAuthBusy] = useState<string | null>(null);
  const [providerTestResults, setProviderTestResults] = useState<
    Partial<Record<AgentAccessProfile, AgentConnectionResult>>
  >({});
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
  // Kérdésenként külön tárolva a listából választott címkék és a saját szöveg.
  // Egyetlen közös mezőben a kattintás beleírta a címkét a szövegdobozba, több
  // választásnál pedig egyetlen leütés némán eldobta az összes bepipált opciót.
  const [claudeQuestionChoices, setClaudeQuestionChoices] = useState<string[][]>([]);
  const [claudeQuestionTexts, setClaudeQuestionTexts] = useState<string[]>([]);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelCatalog, setModelCatalog] =
    useState<CodexModel[]>([
      ...fallbackModels,
      ...claudeCodingModels,
      ...externalCodingModels,
    ]);
  const [modelsLoading, setModelsLoading] = useState(isTauri);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    if (
      localStorage.getItem("min-model-version") !== MODEL_PREFERENCE_VERSION
    ) {
      localStorage.setItem("min-model-version", MODEL_PREFERENCE_VERSION);
      return DEFAULT_MODEL;
    }
    const stored = localStorage.getItem("min-model");
    // Removed Claude variants must stay on Claude instead of silently falling
    // through to the default GPT model.
    if (stored === "claude-sonnet-5") return "claude-opus-5";
    if (stored === "claude-opus-4-6" || stored === "claude-opus-4-7")
      return "claude-opus-4-8";
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
  const [codeStatus, setCodeStatus] = useState("készen");
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
  const [transportStatus, setTransportStatus] =
    useState<CodexTransportStatus | null>(null);
  const [agentConversationStatus, setAgentConversationStatus] =
    useState<AgentConversationStatus | null>(null);
  const [agentStatusRevision, setAgentStatusRevision] = useState(0);
  const [watchdogMessage, setWatchdogMessage] = useState("");
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
  const [runInputState, dispatchRunInput] = useReducer(
    runInputReducer,
    EMPTY_RUN_INPUT_STATE,
  );
  const runInputStateRef = useRef(runInputState);
  runInputStateRef.current = runInputState;
  const sessionQueuedFollowUpsRef = useRef<Set<string>>(new Set());
  const followUpDispatchingRef = useRef<Set<string>>(new Set());
  const [runInputMode, setRunInputMode] = useState<
    RunInputMode | "stage_next"
  >("steer");
  const [stageInputQueues, setStageInputQueues] = useState<
    Record<string, RunInputPayload[]>
  >({});
  const stageInputQueuesRef = useRef(stageInputQueues);
  stageInputQueuesRef.current = stageInputQueues;
  // Az élő kódnézet fájljai beszélgetésenként. Nem perzisztál: ez a *munka
  // közbeni* nézet, a lezárt futás változásait a fájllista és a diff mutatja.
  const [liveFilesByConversation, setLiveFilesByConversation] = useState<
    Record<string, LiveFileState>
  >({});
  // A szerkesztéshez a lemezen álló tartalom kell, hogy a folt fájlra
  // vetülhessen. Futásonként egyszer olvassuk be fájlonként — a delták
  // másodpercenként tucatjával jönnek, és mindegyiknél olvasni a lemezt
  // értelmetlen. A `null` azt jelenti: olvastuk, nincs ilyen fájl (új fájl).
  const liveFileBaseRef = useRef<Map<string, string | null>>(new Map());
  // Keep one in-flight read per file while streamed edit deltas arrive.
  const liveFileBaseReadRef = useRef<Map<string, Promise<string | null>>>(
    new Map(),
  );
  // If the read is slower than the stream, let its completion use the latest
  // edit delta rather than the first (still incomplete) one.
  const liveFileBaseProjectRef = useRef<
    Map<string, (base: string | null) => void>
  >(new Map());
  // ChatGPT/Codex can deliver a complete file item before the LIVE-specific
  // stream exists. Remember which activity versions have been backfilled so
  // the render-side recovery below does not re-read the same file forever.
  const liveFileBackfillKeysRef = useRef<Set<string>>(new Set());
  // A delták gyorsabban jönnek, mint ahogy a React festeni tud; a képkockára
  // adagolt írás ugyanaz a fogás, mint a válasz-stream `drainAnswerStream`-je.
  const liveFilePendingRef = useRef<Map<string, LiveFileTouch>>(new Map());
  const liveFileFrameRef = useRef<number | null>(null);
  // A panel magától nyílik, amikor a modell írni kezd — ez a kérés lényege —,
  // de a becsukás az olvasóé: ha egyszer összecsukta, a következő fájl nem
  // nyitja ki újra a háta mögött.
  const [liveCodeOpen, setLiveCodeOpen] = useState(true);
  const [isCancelling, setIsCancelling] = useState(false);
  // The model turn can be complete while the native command is still
  // finalizing the workspace snapshot. Keep the request locked during that
  // short phase, but remove the stop affordance so a late click cannot cancel
  // an answer that has already arrived.
  const [turnCompletedRequestId, setTurnCompletedRequestId] = useState<
    string | null
  >(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toast, setToast] = useState("");
  const [reviewCommentTarget, setReviewCommentTarget] = useState<string | null>(
    null,
  );
  const [reviewRerunChoiceTarget, setReviewRerunChoiceTarget] = useState<
    string | null
  >(null);
  const [fileActionMenu, setFileActionMenu] =
    useState<FileActionMenuState | null>(null);
  const [selectionQuote, setSelectionQuote] = useState<SelectionQuote | null>(
    null,
  );
  const [appDialog, setAppDialog] = useState<AppDialog | null>(null);
  const [projectOpening, setProjectOpening] = useState(false);
  const projectOpeningRef = useRef(false);
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
  // A restore mutates the canonical sync state outside React. While it is in
  // flight, a debounced snapshot captured before the restore must not be
  // allowed to publish the old tombstone again.
  const snapshotWriteBlockedRef = useRef(false);

  const invalidatePendingSnapshotWrites = () => {
    projectMutationRevisionRef.current += 1;
    pendingLocalMutationRef.current = true;
  };

  const markLocalMutation = () => {
    invalidatePendingSnapshotWrites();
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
  const recoverableTombstones = useMemo(
    () => tombstones.filter((tombstone) => !isPermanentSyncTombstone(tombstone)),
    [tombstones],
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
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const activePlanRef = useRef(activePlan);
  const activeTurnTimingRef = useRef<PlanStepTiming>({});
  const planKeyRef = useRef<string | null>(null);
  const commentaryKeyRef = useRef<string | null>(null);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const regenerationTargetRef = useRef<{
    source: Message;
    answer: Message;
    requestSettings: RegenerationRequestSettings<
      AgentProviderId,
      AgentAccessProfile
    >;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const quoteInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  // Keep fast quote typing out of the root render path. The conversation can
  // contain thousands of nodes, so updating React state on every keystroke
  // made the WebView renderer stall and appear gray.
  const quoteInstructionDraftsRef = useRef<Record<string, string>>({});
  const inputDraftRef = useRef("");
  const composerSendingInputRef = useRef<string | null>(null);
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
    setReviewCommentTarget(null);
    setReviewRerunChoiceTarget(null);
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
  const activeRequestIdRef = useRef<string | null>(null);
  const completionSoundRequestsRef = useRef<Set<string>>(new Set());
  const activeLiveMessageIdRef = useRef<string | null>(null);
  const preparingRequestIdRef = useRef<string | null>(null);
  const turnCompletedRequestIdRef = useRef<string | null>(null);
  const syncActionBusyRef = useRef(false);
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());
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

  /**
   * A régi, modulszintű refek a 2. fázisig élnek: sok olvasó (render-beli
   * származtatott értékek, hang, watchdog) még rájuk néz. Egyetlen írójuk ez
   * a függvény, és mindig az élő futásból írja őket — így nem lehet belőlük
   * második igazság. Amint elfogy az utolsó olvasójuk, a refek eltűnnek.
   */
  const syncRunAliases = () => {
    const run = runsRef.current.values().next().value as RunHandle | undefined;
    activeRequestIdRef.current = run?.requestId ?? null;
    runOwnerConversationIdRef.current = run?.ownerConversationId ?? null;
    activeLiveMessageIdRef.current = run?.liveMessageId ?? null;
    activeTurnIdRef.current = run?.turnId;
    activeTurnTimingRef.current = run?.turnTiming ?? {};
    runPlanRef.current = run?.plan ?? EMPTY_PLAN;
    turnCompletedRequestIdRef.current = run?.turnCompleted
      ? run.requestId
      : null;
  };

  /** Fut-e bármi. A sync-pull szünete és a munkaterület-zárak kérdezik. */
  const anyRunActive = () => runsRef.current.size > 0;

  const beginRun = (run: RunHandle) => {
    runsRef.current.set(run.requestId, run);
    runByConversationRef.current.set(run.ownerConversationId, run.requestId);
    if (run.projectPathKey)
      runByProjectRef.current.set(run.projectPathKey, run.requestId);
    syncRunAliases();
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
    syncRunAliases();
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
  const runOwnerConversationIdRef = useRef<string | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  // A futás munkakönyvtára. Az `activeProjectPathRef` a kiválasztott projekté;
  // ha futás közben másik projektre kattintanak, a futás fájljait attól
  // kezdve a másik projektben kereste volna.
  const runProjectPathRef = useRef("");
  // A futás saját terve. Az `activePlanRef` azé a beszélgetésé, amit épp
  // nézünk — ha a kettő szétvált, a futás ebből építi a következő lépést.
  const runPlanRef = useRef<PlanSnapshot>({
    turnId: null,
    explanation: "",
    steps: [],
  });

  /**
   * Melyik beszélgetés sorai vannak most a nézet-állapotban. Nem a render-beli
   * `threadKey`, hanem a `messageKeyRef`: azt a navigációs kezelők szinkron
   * állítják, tehát ez az egyetlen óra, ami nem tart szét a váltás ablakában.
   */
  const viewedConversationId = () =>
    conversationIdForKey(conversationKeyIndexRef.current, messageKeyRef.current);

  const ownedConversationKey = (conversationId: string) =>
    conversationKeyByIdRef.current[conversationId.trim()] ?? null;

  /** A futó beszélgetés cache-kulcsa, ha épp fut valami. */
  const runOwnerConversationKey = () => {
    const ownerId = runOwnerConversationIdRef.current;
    if (!ownerId) return null;
    return conversationKeyByIdRef.current[ownerId] ?? null;
  };

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
    // A híd az `itemId`-ben jelzi, hányadik assistant-üzenetről van szó, épp
    // azért, hogy két külön üzenet szövege ne ragadjon egybe. A határt viszont
    // eddig senki nem fordította le bekezdésre: a delták vakon fűződtek
    // egymáshoz, és a mentett válaszban „…a repo állapotát ellenőrzöm:A forrás
    // fájlok rendben." lett belőle — a sorok összeolvadtak, a felsorolás
    // eltűnt. Az üzenethatár innentől bekezdéshatár.
    const previousItemId = stream.meta?.itemId;
    const boundary =
      meta.itemId && previousItemId && meta.itemId !== previousItemId
        ? "\n\n"
        : "";
    stream.meta = meta;
    stream.pending += `${boundary}${delta}`;
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
  // A lánc-jelzők a *nézett* futásé: egy másik projektben futó lánc szakaszai
  // nem rajzolhatnak ide panelt.
  const pipelineProgress = viewedRun?.chain?.progress ?? null;
  useEffect(() => {
    if (!composerControlFlip) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShowDetailedTrace(composerControlFlip.targetDetailed);
      setComposerControlFlip(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      if (composerControlFlip.phase === "out") {
        setShowDetailedTrace(composerControlFlip.targetDetailed);
        setComposerControlFlip({
          ...composerControlFlip,
          phase: "in",
        });
        return;
      }
      setComposerControlFlip(null);
    }, composerControlFlip.phase === "out" ? 145 : 165);
    return () => window.clearTimeout(timeout);
  }, [composerControlFlip]);
  const activeRunInputTarget = resolveRunInputTarget(
    activeConversationId,
    runsRef.current.values(),
    pipelineProgress,
  );
  const pipelineStageQueueAvailable = Boolean(
    viewedRun?.chain?.progress &&
      (viewedRun.chain.progress.phase === "started" ||
        viewedRun.chain.progress.stageIndex <
          viewedRun.chain.progress.stageCount - 1),
  );
  const activeFollowUps = followUpsForConversation(
    runInputState,
    activeConversationId,
  );
  const activeRuntimeInputs = runtimeInputsForConversation(
    runInputState,
    activeConversationId,
  );
  const activeStageInputs = viewedRun
    ? stageInputQueues[viewedRun.requestId] ?? []
    : [];
  const liveRunResume = viewedRun?.chain?.resume ?? null;
  // A dokumentumra kötött kattintásfigyelő a renderen kívül fut, ezért a
  // nézett beszélgetés azonosítóját ref-ben is látnia kell.
  activeConversationIdRef.current = activeConversationId;
  const viewingActiveRun = Boolean(viewedRun);

  useEffect(() => {
    setRunInputMode(
      activeRunInputTarget
        ? "steer"
        : pipelineStageQueueAvailable
          ? "stage_next"
          : "follow_up",
    );
  }, [
    activeConversationId,
    activeRunInputTarget?.providerRequestId,
    activeRunInputTarget?.providerTurnId,
    activeRunInputTarget?.stageEpoch,
    pipelineStageQueueAvailable,
  ]);

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
    const progress = run?.chain?.progress;
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
    const timing = run?.turnTiming ?? activeTurnTimingRef.current;
    const startedAt = next.startedAt ?? timing.startedAt;
    const completedAt = next.completedAt ?? timing.completedAt;
    // A futás órája a lánc egészéé: az első indulástól az utolsó zárásig.
    // Korábban minden szakasz-terv commitja felülírta a kezdőidőt a sajátjával,
    // ezért a fejléc órája a TERV → KÓD → REVIEW váltásnál nullázódott.
    if (
      startedAt !== undefined &&
      (timing.startedAt === undefined || startedAt < timing.startedAt)
    )
      timing.startedAt = startedAt;
    if (
      completedAt !== undefined &&
      (timing.completedAt === undefined || completedAt > timing.completedAt)
    )
      timing.completedAt = completedAt;
    return { ...next, startedAt, completedAt };
  };

  const planSnapshotKey = (snapshot: PlanSnapshot) =>
    snapshot.turnId ?? activeTurnIdRef.current ?? "current";

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
        syncRunAliases();
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
      syncRunAliases();
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
      activeStepId: stepId,
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
    const plan = runForConversation(ownerId)?.plan ?? runPlanRef.current;
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
      setCodeStatus("változások visszavonva");
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
      setCodeStatus("apply hiba");
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

  const beginSnapshotProtectedSyncMutation = async () => {
    snapshotWriteBlockedRef.current = true;
    // Invalidate both a pending debounce timer and a save that is waiting in
    // the queue. No React state update is triggered here: the old tombstone
    // must not be captured by a new snapshot while restore is still running.
    invalidatePendingSnapshotWrites();
    setSyncReady(false);
    await snapshotWriteQueueRef.current.catch(() => undefined);
  };

  const finishSnapshotProtectedSyncMutation = (
    restoredTombstones?: SyncTombstone[],
  ) => {
    if (restoredTombstones) setTombstones(restoredTombstones);
    snapshotWriteBlockedRef.current = false;
    // Schedule one snapshot from the post-restore React state. This also
    // makes a failed restore durable without resurrecting a stale queued one.
    markLocalMutation();
  };

  const restoreTombstone = async (tombstone: SyncTombstone) => {
    if (!isTauri || syncActionBusyRef.current) return;
    if (isPermanentSyncTombstone(tombstone)) {
      notify("A véglegesen törölt elem nem állítható vissza.", "notify");
      return;
    }
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
    let snapshotMutationStarted = false;
    let snapshotMutationFinished = false;
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
      snapshotMutationStarted = true;
      await beginSnapshotProtectedSyncMutation();
      for (const target of targets) {
        lastResult = await invoke<SyncV2Result>("sync_v2_restore_entity", {
          tombstone: target,
        });
      }
      if (lastResult) {
        setSyncHealth(lastResult.health);
        setSyncWriteEnabled(lastResult.canWrite);
      }
      finishSnapshotProtectedSyncMutation(lastResult?.snapshot.tombstones ?? []);
      snapshotMutationFinished = true;
      pendingRestoreSelectionRef.current = tombstone;
      setSyncHealthOpen(false);
      setRetentionPreview(null);
      setSyncStatus("visszaállítás · Tree frissítése");
      setSyncReady(false);
      notify("A visszaállítás rögzítve; a Tree frissül…");
    } catch (error) {
      if (snapshotMutationStarted && !snapshotMutationFinished)
        finishSnapshotProtectedSyncMutation();
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
  ): Promise<SyncV2Result | null> => {
    if (!isTauri) return null;
    if (syncActionBusyRef.current) return null;
    if (anyRunActive()) {
      setToast("Aktív válasz közben a Recovery restore szünetel.");
      return null;
    }
    const shouldRestore = (tombstone: SyncTombstone) =>
      !isPermanentSyncTombstone(tombstone) &&
      (tombstone.entityType === "project" || restoreConversations) &&
      tombstoneMatchesProjectScope(tombstone, project);

    let prefetchedResult: SyncV2Result | null = null;
    let candidates = tombstones.filter(shouldRestore);
    if (candidates.length === 0) {
      try {
        const pulled = await invoke<SyncV2Result>("sync_v2_pull");
        prefetchedResult = pulled;
        setSyncHealth(pulled.health);
        setSyncWriteEnabled(pulled.canWrite);
        candidates = (pulled.snapshot.tombstones ?? []).filter(shouldRestore);
      } catch (error) {
        // This is a best-effort resurrection check. The normal sync poll can
        // retry it later without making a successful project creation fail.
        console.warn("Project tombstone check after creation failed", error);
        return null;
      }
    }
    if (candidates.length === 0) return prefetchedResult;

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
    let lastResult: SyncV2Result | null = null;
    let snapshotMutationStarted = false;
    let snapshotMutationFinished = false;
    syncActionBusyRef.current = true;
    try {
      snapshotMutationStarted = true;
      await beginSnapshotProtectedSyncMutation();
      for (const tombstone of uniqueCandidates) {
        lastResult = await invoke<SyncV2Result>("sync_v2_restore_entity", {
          tombstone,
        });
        setSyncHealth(lastResult.health);
        setSyncWriteEnabled(lastResult.canWrite);
        restoredEvents += lastResult.writtenEvents;
      }
      finishSnapshotProtectedSyncMutation(lastResult?.snapshot.tombstones ?? []);
      snapshotMutationFinished = true;
      setSyncStatus(restoredEvents > 0 ? "restore · journal" : "visszaállítva");
      setSyncReady(false);
      notify(`Korábbi törlési jelölés feloldva: ${project.name}`);
      return lastResult ?? prefetchedResult;
    } catch (error) {
      if (snapshotMutationStarted && !snapshotMutationFinished)
        finishSnapshotProtectedSyncMutation();
      setSyncStatus("restore hiba");
      notify(
        `A projekt létrejött, de a korábbi törlési jelölés feloldása nem sikerült: ${String(error)}`,
      );
      console.warn("Project tombstone restore failed", error);
      return null;
    } finally {
      syncActionBusyRef.current = false;
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
    prefetchedResult: SyncV2Result | null = null,
  ): Promise<HydratedProject | null> => {
    let result: SyncV2Result;
    if (prefetchedResult) {
      result = prefetchedResult;
    } else {
      try {
        result = await invoke<SyncV2Result>("sync_v2_pull");
      } catch (error) {
        console.warn("Existing project sync hydration failed", error);
        return null;
      }
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
    setCodeStatus(
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
      {
        key: "kimi",
        label: "Kimi",
        matches: (id: string) =>
          id === "kimi-k3" || id === "k3" || id === "k3-256k",
      },
      {
        key: "deepseek",
        label: "DeepSeek",
        matches: (id: string) => id === "deepseek-v4-flash",
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
              ...PIPELINE_MODELS.kimi,
              ...PIPELINE_MODELS.deepseek,
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
  const selectedProvider = providerOfModel(selectedModel);
  const selectedAccessProfile = accessProfileOfModel(selectedModel);
  const composerImageProvider =
    activeMode !== "general" && showDetailedTrace && activePipelineRecipe
      ? stageProvider(0)
      : selectedProvider;
  const composerImageAccessProfile =
    activeMode !== "general" && showDetailedTrace && activePipelineRecipe
      ? stageAccessProfile(0)
      : selectedAccessProfile;
  const composerSupportsImages = providerSupportsImageInput(
    composerImageProvider,
    composerImageAccessProfile,
  );
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
      activeTurnKey: activeTurnIdRef.current,
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
    if (!isTauri || !localStoreReady) return;
    let active = true;
    void invoke<QueuedFollowUp[]>("pending_followups_list")
      .then((followUps) => {
        if (active)
          dispatchRunInput({ type: "hydrate_follow_ups", followUps });
      })
      .catch((error) => console.warn("Follow-up queue unavailable", error));
    return () => {
      active = false;
    };
  }, [isTauri, localStoreReady]);

  useEffect(() => {
    if (pipelineRecipes.length === 0) return;
    if (pipelineRecipes.some((recipe) => recipe.id === pipelineRecipeId)) return;
    const fallback =
      pipelineRecipes.find((recipe) => recipe.id === "plan_code_review") ??
      pipelineRecipes[0];
    if (fallback) selectPipelineRecipe(fallback.id);
  }, [pipelineRecipes, pipelineRecipeId]);

  useEffect(() => {
    if (!isTauri) return;
    // A chain takes minutes, so the UI has to follow it stage by stage instead
    // of showing nothing until the whole run finishes. The stage's request id
    // arrives here before its first event does, which is what lets the live
    // trace attribute those events to the turn that is actually running.
    const unlisten = listen<PipelineProgressEvent>("pipeline-progress", (event) => {
      const progress = event.payload;
      const progressReceivedAt = Date.now();
      // A szakasz requestId-je a külső kérés-azonosító + `-stage-N`; ha a
      // stage-id-t egyik run sem ismeri (pl. straggler egy lezárt lánctól), a
      // külső azonosító még köthető. Az „első run" fallback csak egyetlen
      // futás mellett jogos — két párhuzamos projektnél a B lánc kósza
      // eseménye az A szakasz-sávját írta át.
      const runForProgress = (requestId: string) =>
        runForEvent({ requestId }) ??
        runForRequest(requestId.replace(/-stage-\d+$/, "")) ??
        (runsRef.current.size === 1
          ? (runsRef.current.values().next().value as RunHandle)
          : undefined);
      const progressRun = runForProgress(progress.requestId);
      let receivedStageTiming: PlanStepTiming | undefined;
      if (progressRun) {
        const previousTiming =
          progressRun.chain?.stageTimings?.[progress.stageIndex] ?? {};
        receivedStageTiming =
          progress.phase === "started"
            ? {
                ...previousTiming,
                startedAt: previousTiming.startedAt ?? progressReceivedAt,
              }
            : {
                startedAt:
                  previousTiming.startedAt ??
                  progressRun.plan.startedAt ??
                  progressReceivedAt,
                completedAt:
                  previousTiming.completedAt ?? progressReceivedAt,
              };
        progressRun.chain = {
          ...progressRun.chain,
          progress,
          stageTimings: {
            ...progressRun.chain?.stageTimings,
            [progress.stageIndex]: receivedStageTiming,
          },
        };
        progressRun.provider = progress.provider;
        progressRun.stageEpoch = progress.stageEpoch;
        if (progress.phase === "started") {
          // A previous stage's provider turn id must never be a valid target
          // for the next stage during the short start-event race.
          progressRun.providerTurnId = undefined;
          progressRun.turnCompleted = false;
          progressRun.status = "streaming";
        }
        // A szakasz sávja a lánc sajátja: a nézet-választás csak addig él,
        // amíg ugyanaz a szakasz fut.
        setRunsRevision((revision) => revision + 1);
      }
      // A lezárt szakasz sora azonnal megkapja a lánc-metaadatát.
      //
      // Eddig csak a futás legvégén kapta meg, és addig egy szakasz-válasz
      // „sima" asszisztens-sor volt. Ennek két következménye volt: a szakaszok
      // időrendi határai (amihez a lépések és a kommentár tartoznak) nem
      // ismerték ezt a szakaszt, így a saját eseményei az *előző kör* utolsó
      // szakaszához kerültek — és annak a csoportnak a válasza is ez a
      // metaadat nélküli sor lett. Onnantól a lánc paneljének nem volt
      // szakasza (fejléc és fülek nélkül rajzolódott, illetve egy
      // újrafuttatásnál egyáltalán nem), a korábbi kör bírálata pedig
      // kicsúszott a kártyája alól és nyers üzenetsorként jelent meg. A
      // verdikt nem itt derül ki, azt továbbra is a futás vége írja rá.
      if (progress.phase !== "started" && progressRun) {
        const stageTurnId = `request:${progress.requestId}`;
        const resume = progressRun.chain?.resume;
        const stageStatus: MessagePipeline["stageStatus"] =
          progress.phase === "finished"
            ? "completed"
            : progress.status === "cancelled"
              ? "cancelled"
              : "failed";
        writeOwnedMessages(progressRun.ownerConversationId, (current) =>
          current.map((message) =>
            message.role === "assistant" &&
            message.turnId === stageTurnId
              ? {
                  ...message,
                  pipeline: mergeMessagePipeline(message.pipeline, {
                    runId: progress.runId,
                    recipeId: progressRun.chain?.recipe?.id,
                    chainId: resume?.chainKey ?? progress.runId,
                    iteration: resume?.iteration ?? 1,
                    stageIndex: progress.stageIndex,
                    stageCount: progress.stageCount,
                    stageRole: progress.role,
                    stageAgent: progress.agentLabel,
                    stageStatus,
                    stageStartedAt: receivedStageTiming?.startedAt,
                    stageCompletedAt: receivedStageTiming?.completedAt,
                  }),
                }
              : message,
          ),
        );
      }
      if (progress.phase === "started") {
        // A szakasz a saját láncának futásához tartozik: a kérés-azonosítója
        // oda kerül be, és onnantól az eseményei is odatalálnak.
        const chainRun = runForProgress(progress.requestId);
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
        syncRunAliases();
        const stageStartedAt =
          chainRun.chain?.stageTimings?.[progress.stageIndex]?.startedAt ??
          progressReceivedAt;
        // A kódoló szakasz lépéslistája maga a terv: a terv-szakasz számozott
        // fő pontjai. Enélkül a KÓD alatt egy „0. lépés" placeholder állt,
        // miközben a terv tíz lépést vett fel — a lista sosem látszott.
        const carriedPlanText =
          progress.role === "code"
            ? progress.planText ??
              chainRun.planText ??
              messagesRef.current.find(
                (message) => message.id === chainRun.liveMessageId,
              )?.text ??
              ""
            : "";
        const carriedSteps = numberedPlanSteps(carriedPlanText).map(
          (step) => ({
            ...step,
            // A carried plan is a description, not a claim that step 1 has
            // started. Claude must explicitly announce the active task.
            status: "pending" as const,
          }),
        );
        // A TERV kártya lépéslistája is most születik meg: ugyanezek a
        // pontok, kész státusszal — a terv-fázis alatt a lista üres volt,
        // mert a dump közben még nem léteztek a pontok.
        if (progress.role === "code" && carriedSteps.length >= 1) {
          const outerRequestId = progress.requestId.replace(/-stage-\d+$/, "");
          const planStageTurnId = `request:${outerRequestId}-stage-${progress.stageIndex - 1}`;
          setPlanHistory((current) => ({
            ...current,
            [planStageTurnId]: {
              turnId: planStageTurnId,
              explanation: "",
              steps: carriedSteps.map((step) => ({
                ...step,
                status: "completed" as const,
              })),
            },
          }));
        }
        const stageSteps =
          carriedSteps.length >= 1
            ? carriedSteps
            : progress.role === "plan"
              ? []
              : [
                  {
                    id: "client-pre-plan",
                    step: prePlanStepLabel(progress.role),
                    status: "inProgress" as const,
                  },
                ];
        updateOwnedPlanState(chainRun.ownerConversationId, {
          turnId: `request:${progress.requestId}`,
          explanation: "",
          steps: stageSteps,
          activeStepId: null,
          source: carriedSteps.length >= 1 ? "carried-plan" : "fallback",
          startedAt: stageStartedAt,
          stepTimes: stageSteps.length && carriedSteps.length < 2
            ? { [stageSteps[0].id]: { startedAt: stageStartedAt } }
            : {},
        });
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
        setClaudeQuestionChoices([]);
        setClaudeQuestionTexts([]);
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
              { keepLiveSelection: true },
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
          setSyncStatus(result.canWrite ? "szinkronizálva" : "karantén · olvasás");
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
                // A poll-driven pull must not relocate the reader: an empty,
                // freshly created conversation is a deliberate choice, and
                // losing it also loses the composer settings set up in it.
                { keepLiveSelection: true },
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
      setCodeStatus(saved.length > 0 ? "kész" : "készen");
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
      snapshotWriteBlockedRef.current ||
      !pendingLocalMutationRef.current
    )
      return;
    const revisionAtSchedule = projectMutationRevisionRef.current;
    const pendingMutationAtSchedule = pendingLocalMutationRef.current;
    const timer = window.setTimeout(() => {
      if (snapshotWriteBlockedRef.current) return;
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
          if (
            snapshotWriteBlockedRef.current ||
            projectMutationRevisionRef.current !== revisionAtSchedule
          )
            return;
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
          setModelCatalog([
            ...models,
            ...claudeCodingModels,
            ...externalCodingModels,
          ]);
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
    document.documentElement.classList.toggle(
      "is-project-opening",
      projectOpening,
    );
    return () => document.documentElement.classList.remove("is-project-opening");
  }, [projectOpening]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listen<{ message?: string }>("app-close-blocked", (event) => {
      if (!disposed)
        setToast(
          event.payload?.message ??
            "A futás még folyamatban van. Várd meg a végét vagy állítsd le.",
        );
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTauri]);

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
      setTransportStatus(event.payload);
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
      setWatchdogMessage("");
      return;
    }
    setWatchdogMessage("");
    const timer = window.setTimeout(
      () =>
        setWatchdogMessage(
          "A Codex dolgozik; még nem érkezett megjeleníthető összefoglaló.",
        ),
      8000,
    );
    return () => window.clearTimeout(timer);
  }, [viewingActiveRun]);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void listen<unknown>("agent-input-status", (event) => {
      const status = normalizeAgentInputStatus(event.payload);
      if (!status) return;
      const runtimeInput = runInputStateRef.current.inputs[status.inputId];
      if (!runtimeInput) return;
      if (status.status === "sending") return;
      if (status.status === "accepted") {
        if (runtimeInput.delivery.status === "accepted") return;
        const capturedTarget = runtimeInput.payload.target;
        if (!capturedTarget) return;
        const accepted = status.acceptedTarget ?? {};
        const target: RunInputTarget = {
          ...capturedTarget,
          providerThreadId:
            firstString(accepted.providerThreadId, accepted.provider_thread_id) ??
            capturedTarget.providerThreadId,
          providerTurnId:
            firstString(accepted.providerTurnId, accepted.provider_turn_id) ??
            capturedTarget.providerTurnId,
        };
        dispatchRunInput({
          type: "accepted",
          inputId: status.inputId,
          acceptedAt: status.timestamp,
          target,
        });
        const ownerRun = runForRequest(target.rootRequestId);
        const parentTurnId =
          ownerRun?.clientTurnId ?? `request:${target.rootRequestId}`;
        const interaction: MessageInteraction = {
          kind: "steer",
          inputId: status.inputId,
          parentTurnId,
          targetProvider: target.provider,
          targetRequestId: target.providerRequestId,
          targetProviderTurnId: target.providerTurnId,
          pipelineRunId: target.pipelineRunId,
          stageIndex: target.stageIndex,
          stageRole: target.stageRole,
          acceptedAt: status.timestamp,
        };
        writeOwnedMessages(status.conversationId, (current) =>
          current.some(
            (message) => message.interaction?.inputId === status.inputId,
          )
            ? current
            : [
                ...current,
                {
                  id: status.inputId,
                  role: "user",
                  text: runtimeInput.payload.text,
                  time: status.timestamp,
                  live: false,
                  final: true,
                  sequence: nextTimelineSequence(),
                  turnId: parentTurnId,
                  quoteRefs: runtimeInput.payload.quoteRefs,
                  interaction,
                },
              ],
        );
        markLocalMutation();
        if (
          composerSendingInputRef.current === status.inputId &&
          inputDraftRef.current.trim() === runtimeInput.payload.text.trim()
        ) {
          inputDraftRef.current = "";
          if (inputRef.current) {
            inputRef.current.value = "";
            resizeComposerTextarea(inputRef.current);
          }
          quoteInputRefs.current = {};
          quoteInstructionDraftsRef.current = {};
          setComposerQuotes([]);
        }
        if (composerSendingInputRef.current === status.inputId)
          composerSendingInputRef.current = null;
        notify("A futó AI elfogadta a terelést");
        return;
      }
      const code = (status.code ?? "runtime_failed") as RunInputErrorCode;
      dispatchRunInput({
        type: "failed",
        inputId: status.inputId,
        code,
        message: status.message ?? describeRunInputError(code),
        failedAt: status.timestamp,
      });
      if (composerSendingInputRef.current === status.inputId)
        composerSendingInputRef.current = null;
      notify(describeRunInputError(code), "notify");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTauri]);

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
      if (codexEvent.providerTurnId?.trim()) {
        run.providerTurnId = codexEvent.providerTurnId.trim();
        const queuedForStage = stageInputQueuesRef.current[run.requestId] ?? [];
        const progress = run.chain?.progress;
        if (queuedForStage.length > 0 && progress?.phase === "started") {
          const target = resolveRunInputTarget(
            run.ownerConversationId,
            runsRef.current.values(),
            progress,
          );
          if (target) {
            const nextQueues = { ...stageInputQueuesRef.current };
            delete nextQueues[run.requestId];
            stageInputQueuesRef.current = nextQueues;
            setStageInputQueues(nextQueues);
            queuedForStage.forEach((payload) => void sendSteer(payload, target));
          }
        }
      }
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
        syncRunAliases();
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

      // Az élő kódnézet csatornája. Külön fut a munkanaplótól: a fájl írása
      // közben másodpercenként tucatnyi adag érkezik, és ezekből *nem* lesz
      // naplósor — a napló a műveletet könyveli, a panel a tartalmat mutatja.
      if (codexEvent.eventType === "item/fileWrite/delta") {
        const path = firstString(item.filePath, params.filePath);
        if (path)
          trackLiveFileWrite(ownerConversationId, {
            path,
            mode: firstString(item.mode) === "edit" ? "edit" : "write",
            content: firstString(item.content),
            oldString: firstString(item.oldString),
            newString: firstString(item.newString),
            streaming: item.streaming !== false,
            sequence: nextTimelineSequence(),
          });
        return;
      }

      if (codexEvent.eventType === "item/agentMessage/delta") {
        const deltaText = firstString(params.delta);
        const itemId = eventItemId(codexEvent, params, item);
        const explicitChannel = firstString(params.channel, item.channel);
        const itemType = firstString(item.type, params.itemType)?.toLowerCase();
        const phase =
          (itemId ? run.agentMessagePhases[itemId] : undefined) ??
          firstString(params.phase, item.phase);
        if (deltaText) {
          setWatchdogMessage("");
          if (phase === "final_answer") {
            enqueueAnswerDelta(run, deltaText, {
              threadId: codexEvent.threadId,
              itemId,
              turnId: uiTurnId,
              phase,
            });
          } else {
            const hasExplicitActiveStep = Object.prototype.hasOwnProperty.call(
              run.plan,
              "activeStepId",
            );
            const stepId = hasExplicitActiveStep
              ? run.plan.activeStepId ?? undefined
              : run.plan.source === "claude-task" ||
                  run.plan.source === "claude-todo" ||
                  run.plan.source === "carried-plan"
                ? undefined
                : run.plan.steps.find((step) => step.status === "inProgress")?.id;
            const channel: CommentaryEntry["channel"] =
              explicitChannel === "assistant-output" ||
              explicitChannel === "reasoning-summary" ||
              explicitChannel === "status"
                ? explicitChannel
                : itemType === "reasoning"
                  ? "reasoning-summary"
                  : "assistant-output";
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
                    channel,
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
                      channel: entry.channel ?? channel,
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
          // Lánc-szakasz nem cserélheti le a ≥2 lépéses listát egyetlen
          // todo-ra: ez tüntette el a terv 10 pontját, és lett belőle
          // „1/1 kész". Egy teljes (≥2 lépéses) todo-lista viszont nyer.
          const carriedListActive = current.steps.some((step) =>
            step.id.startsWith("carried-plan-"),
          );
          const isClaudePlan =
            snapshot.source === "claude-task" ||
            snapshot.source === "claude-todo" ||
            snapshot.steps.some(
              (step) =>
                step.id.startsWith("claude-task:") ||
                step.id.startsWith("todo-"),
            );
          const canonicalTitle = (value: string) =>
            value
              .toLocaleLowerCase("hu-HU")
              .replace(/^\s*\d+[.)]\s*/, "")
              .replace(/[\u0060*_]/g, "")
              .replace(/[^\p{L}\p{N}]+/gu, " ")
              .trim();
          const titlesMatch = (left: string, right: string) => {
            const a = canonicalTitle(left);
            const b = canonicalTitle(right);
            if (!a || !b) return false;
            return (
              a === b ||
              (Math.min(a.length, b.length) >= 12 &&
                (a.startsWith(b) || b.startsWith(a)))
            );
          };
          const mapIncomingTasksToCarried = () => {
            const mapping = { ...run.planTaskToCarriedStep };
            const used = new Set(Object.values(mapping));
            const carried = current.steps.filter((step) =>
              step.id.startsWith("carried-plan-"),
            );
            for (const incoming of snapshot.steps) {
              if (mapping[incoming.id]) continue;
              // New Claude tasks arrive in creation order. Only the next
              // unused carried step may claim a new task; a title mismatch is
              // left unassigned instead of pairing a later similar title.
              const next = carried.find((step) => !used.has(step.id));
              if (next && titlesMatch(next.step, incoming.step)) {
                mapping[incoming.id] = next.id;
                used.add(next.id);
              }
            }
            run.planTaskToCarriedStep = mapping;
            return mapping;
          };
          if (
            !isActiveRequest &&
            snapshot.steps.length < 2 &&
            current.steps.length >= 2 &&
            !isClaudePlan
          ) {
            setCodeStatus("terv frissítve");
          } else if (carriedListActive) {
            // A kódoló a terv pontjait veszi fel checklistként, méghozzá
            // elemenként, egyre hosszabb lista. Ha ezeket beengednénk, a KÓD
            // lépéslistája újra „kiíródna" fentről lefelé,
            // ahogy a TERV-ben — pedig ugyanaz a lista, csak most már halad.
            // A hordozott lista marad, és csak az állapotokat vesszük át róla.
            const mapping = mapIncomingTasksToCarried();
            const merged = current.steps.map((step) => {
              const incoming = snapshot.steps.find(
                (candidate) => mapping[candidate.id] === step.id,
              );
              return incoming && incoming.status !== step.status
                ? { ...step, status: incoming.status }
                : step;
            });
            const hasExplicitSnapshotActive = Object.prototype.hasOwnProperty.call(
              snapshot,
              "activeStepId",
            );
            const incomingActiveStepId = hasExplicitSnapshotActive
              ? snapshot.activeStepId
              : snapshot.steps.find((step) => step.status === "inProgress")?.id;
            const mappedActiveStepId =
              incomingActiveStepId === null
                ? isClaudePlan
                  ? current.activeStepId ?? null
                  : null
                : incomingActiveStepId
                  ? mapping[incomingActiveStepId] ?? null
                  : isClaudePlan
                    ? current.activeStepId ?? null
                    : null;
            if (planTrackingDiagnosticsEnabled() && isClaudePlan) {
              console.debug("[plan-tracking] carried mapping", {
                requestId: run.requestId,
                source:
                  snapshot.source ??
                  (isClaudePlan ? "claude-task" : "codex-native"),
                tasks: snapshot.steps.map((step) => step.id),
                mapping,
                activeStepId: mappedActiveStepId,
              });
            }
            const changed = merged.some(
              (step, index) => step.status !== current.steps[index].status,
            ) || mappedActiveStepId !== (current.activeStepId ?? null);
            if (changed || snapshot.source !== current.source) {
              const next = planWithTiming(
                {
                  ...current,
                  turnId: current.turnId ?? uiTurnId,
                  source:
                    snapshot.source ??
                    (isClaudePlan ? "claude-task" : "codex-native"),
                  activeStepId: mappedActiveStepId,
                  explanation: snapshot.explanation || current.explanation,
                },
                merged,
                Date.now(),
              );
              planStepIdOverride = mappedActiveStepId ?? undefined;
              updateOwnedPlanState(ownerConversationId, next);
              setWatchdogMessage("");
            }
            setCodeStatus("terv frissítve");
          } else {
            const hasExplicitSnapshotActive = Object.prototype.hasOwnProperty.call(
              snapshot,
              "activeStepId",
            );
            const activeStepId = hasExplicitSnapshotActive
              ? snapshot.activeStepId === null && isClaudePlan
                ? current.activeStepId ?? null
                : snapshot.activeStepId ?? undefined
              : snapshot.steps.find((step) => step.status === "inProgress")?.id;
            const next = planWithTiming(
              {
                ...current,
                turnId: current.turnId ?? uiTurnId,
                source:
                  snapshot.source ??
                  (isClaudePlan
                    ? "claude-todo"
                    : current.source ?? "codex-native"),
                activeStepId: activeStepId ?? null,
                explanation: snapshot.explanation || current.explanation,
              },
              snapshot.steps,
              Date.now(),
            );
            planStepIdOverride = activeStepId ?? undefined;
            updateOwnedPlanState(ownerConversationId, next);
            setWatchdogMessage("");
            setCodeStatus("terv frissítve");
          }
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
        // Tartalék-léptetés a lánc alatt: ha a kódoló nem vezet todo-t, a
        // lépésben megnevezett fájl írása lépteti a listát — az első még nem
        // kész, egyező lépésre. A todo-frissítés (planStepIdOverride) erősebb.
        let inferredStepId: string | undefined;
        if (
          !planStepIdOverride &&
          run.provider === "codex" &&
          codexEvent.requestId &&
          run.chainRequestIds.has(codexEvent.requestId) &&
          run.plan.steps.length >= 1
        ) {
          const inferencePath =
            extractFilePath(codexEvent.payload) ?? activity.detail;
          const baseName = inferencePath
            ?.replaceAll("\\", "/")
            .split("/")
            .pop()
            ?.toLowerCase();
          if (baseName && baseName.includes(".")) {
            // A lista címeket mutat, a fájlnév viszont a pont magyarázatában
            // szerepel — a keresés ezért a terv teljes sorát nézi, és csak
            // annak hiányában a rövid címet.
            const planLines = run.planText
              ? numberedPlanLines(run.planText)
              : [];
            inferredStepId = run.plan.steps.find(
              (step, index) =>
                step.status !== "completed" &&
                (planLines[index] ?? step.step)
                  .toLowerCase()
                  .includes(baseName),
            )?.id;
          }
        }
        const hasExplicitActiveStep = Object.prototype.hasOwnProperty.call(
          run.plan,
          "activeStepId",
        );
        const statusActiveStepId =
          !hasExplicitActiveStep &&
          run.plan.source !== "claude-task" &&
          run.plan.source !== "claude-todo" &&
          run.plan.source !== "carried-plan"
            ? run.plan.steps.find((step) => step.status === "inProgress")?.id
            : undefined;
        const explicitActiveStepId = hasExplicitActiveStep
          ? run.plan.activeStepId ?? undefined
          : statusActiveStepId;
        const planStepId =
          planStepIdOverride ??
          // ChatGPT/Codex does not always emit a new activeStepId when it
          // moves from one carried-plan file to the next. A reliable filename
          // match must outrank the stale first active step; Claude keeps its
          // TaskUpdate mapping as the authoritative path.
          (run.provider === "codex" ? inferredStepId : undefined) ??
          explicitActiveStepId ??
          inferredStepId;
        if (planTrackingDiagnosticsEnabled() && run.provider !== "codex") {
          console.debug("[plan-tracking] activity assignment", {
            requestId: run.requestId,
            eventType: codexEvent.eventType,
            planStepId: planStepId ?? null,
            assignmentSource: planStepIdOverride
              ? "plan-update"
              : explicitActiveStepId
                ? "explicit-active"
                : inferredStepId
                  ? "filename-fallback"
                  : "unassigned",
          });
        }
        const activityWithStep = { ...activity, planStepId };
        markOwnedPlanStepStarted(ownerConversationId, planStepId, Date.now());
        writeOwnedWorkItems(ownerConversationId, (current) =>
          mergeCodeActivity(current, activityWithStep),
        );
        // A ChatGPT nem karakterenként ír: kész foltot ad. Ugyanabba a panelbe
        // kerül, csak nem gépel — a fül és a fájlnézet ugyanaz. A Claude
        // fájljait a saját, élő csatornája hozza; itt a lezáró esemény már
        // csak megerősítené ugyanazt.
        const filePath =
          extractFilePath(codexEvent.payload) ??
          (activityWithStep.kind === "file"
            ? activityWithStep.detail
            : undefined);
        if (
          activityWithStep.kind === "file" &&
          activityWithStep.status === "error" &&
          filePath
        ) {
          const cwd =
            runProjectPathRef.current || activeProjectPathRef.current;
          const livePath = relativeChangePath(filePath, cwd);
          void invoke<string | null>("read_code_file", {
            cwd,
            path: filePath,
          })
            .then((disk) => {
              if (disk === null) {
                discardLiveFile(ownerConversationId, livePath);
                return;
              }
              queueLiveFile(ownerConversationId, {
                path: livePath,
                content: disk,
                streaming: false,
                mode: activityWithStep.beforeCode ? "edit" : "write",
                highlight: wholeFileHighlight(disk),
                sequence: activityWithStep.id,
              });
            })
            .catch(() => discardLiveFile(ownerConversationId, livePath));
          return;
        }
        if (
          activityWithStep.kind === "file" &&
          (activityWithStep.afterCode?.trim() || activityWithStep.code?.trim())
        ) {
          const livePath = relativeChangePath(
            filePath ?? activityWithStep.detail,
            runProjectPathRef.current || activeProjectPathRef.current,
          );
          const content =
            activityWithStep.afterCode ?? activityWithStep.code ?? "";
          if (livePath)
            queueLiveFile(ownerConversationId, {
              path: livePath,
              content,
              streaming: false,
              mode: activityWithStep.beforeCode ? "edit" : "write",
              highlight: wholeFileHighlight(content),
              sequence: activityWithStep.id,
            });
        }
        if (
          activityWithStep.kind === "file" &&
          filePath &&
          /\.[a-z0-9]{1,8}$/i.test(filePath) &&
          (!activityWithStep.code || !activityWithStep.afterCode)
        ) {
          void invoke<string | null>("read_code_file", {
            cwd: runProjectPathRef.current || activeProjectPathRef.current,
            path: filePath,
          })
            .then((code) => {
              if (!code) return;
              // Codex often reports only a patch or the file path in the
              // activity. The finished file on disk is the authoritative
              // content for the LIVE panel, so backfill it when available.
              // Claude's dedicated fileWrite stream may already have painted
              // the same path; touching it here is harmless and also covers
              // Claude runtimes that only emit a completed file item.
              const livePath = relativeChangePath(
                filePath,
                runProjectPathRef.current || activeProjectPathRef.current,
              );
              if (livePath)
                queueLiveFile(ownerConversationId, {
                  path: livePath,
                  content: code,
                  streaming: false,
                  mode: activityWithStep.beforeCode ? "edit" : "write",
                  highlight: wholeFileHighlight(code),
                  sequence: activityId,
                });
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
                  step: prePlanStepLabel(run.chain?.progress?.role),
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
        setWatchdogMessage("");
        setCodeStatus("dolgozik");
      } else if (codexEvent.eventType === "turn/completed") {
        settleAnswerStream(run);
        // Szakasz-lezárásnál a szakasz kérése zárul le, nem a lánc külső
        // kérése — a checkpoint és a „kész" könyvelés is az övé.
        const completedRequestId = isActiveRequest
          ? run.requestId
          : (codexEvent.requestId ?? run.requestId);
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
          // Lánc-szakasz: a saját (turn-azonosítójú) élő buboréka zárul le.
          // A külső buborék az első szakasz szövegét őrzi — azt egy későbbi
          // szakasz lezárása nem írhatja felül.
          const answerIndex =
            !isActiveRequest && fallbackIndex >= 0
              ? fallbackIndex
              : targetIndex >= 0
                ? targetIndex
                : fallbackIndex;
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
            replaceMessageId: run.replacementMessageId,
            replaceTurnId: run.replacementTurnId,
          }).catch(() => undefined);
        }
        // `turn/completed` is the durable answer boundary. Protect this
        // terminal message from an in-flight pull and force the zero-delay
        // SQLite + journal flush before the slower workspace guard finishes.
        // Use the stateful mutation path too: a ref-only revision bump does
        // not re-run the persistence effect when the stream already flushed
        // its provisional empty assistant row.
        markLocalMutation();
        if (
          !isActiveRequest &&
          run.chain?.progress?.role === "plan" &&
          checkpointAnswerText.trim()
        ) {
          // A terv kész: a szövege a futásé, a számozott pontjai pedig a
          // hivatalos lépéslista — a tervező saját munkafolyamat-todo-it
          // ezek váltják le a tárban is. (Ez volt a „3 pont a 6 helyett".)
          run.planText = checkpointAnswerText;
          const bornSteps = numberedPlanSteps(checkpointAnswerText);
          if (bornSteps.length >= 1) {
            updateOwnedPlanState(ownerConversationId, {
              turnId: uiTurnId,
              explanation: "",
              steps: bornSteps.map((step) => ({
                ...step,
                status: "completed" as const,
              })),
            });
          }
        }
        if (isActiveRequest) {
          run.turnCompleted = true;
          syncRunAliases();
          setTurnCompletedRequestId(completedRequestId);
        }
        const completedSteps = run.plan.steps.map((step) =>
          step.status === "inProgress"
            ? { ...step, status: "completed" as const }
            : step,
        );
        const completedPlan = planWithTiming(
          { ...run.plan, activeStepId: null },
          completedSteps,
          completedAt,
          completedAt,
        );
        updateOwnedPlanState(ownerConversationId, completedPlan);
        setCodeStatus("kész");
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
      } else if (codexEvent.eventType.includes("error")) setCodeStatus("hiba");
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

  const refreshProviderAuthStatuses = async () => {
    if (!isTauri) return;
    const entries = await Promise.all(
      PROVIDER_CREDENTIALS.map(async (credential) => {
        try {
          const status = await invoke<AgentAuthStatus>("agent_auth_status", {
            provider: credential.provider,
            accessProfile: credential.key,
          });
          return [credential.key, status] as const;
        } catch {
          return [credential.key, undefined] as const;
        }
      }),
    );
    setProviderAuthStatuses(
      Object.fromEntries(entries.filter((entry) => entry[1])) as Partial<
        Record<AgentAccessProfile, AgentAuthStatus>
      >,
    );
  };

  const saveProviderKey = async (
    credential: (typeof PROVIDER_CREDENTIALS)[number],
  ) => {
    const apiKey = providerKeyDrafts[credential.key]?.trim() ?? "";
    if (!apiKey) {
      notify("Az API-kulcs mező üres.", "notify");
      return;
    }
    setProviderAuthBusy(`save:${credential.key}`);
    try {
      const status = await invoke<AgentAuthStatus>("agent_save_api_key", {
        provider: credential.provider,
        accessProfile: credential.key,
        apiKey,
      });
      setProviderAuthStatuses((current) => ({
        ...current,
        [credential.key]: status,
      }));
      setProviderKeyDrafts((current) => ({ ...current, [credential.key]: "" }));
      notify(`${credential.label}: kulcs elmentve`);
    } catch (error) {
      notify(`A kulcs nem menthető: ${String(error)}`, "notify");
    } finally {
      setProviderAuthBusy(null);
    }
  };

  const deleteProviderKey = async (
    credential: (typeof PROVIDER_CREDENTIALS)[number],
  ) => {
    setProviderAuthBusy(`delete:${credential.key}`);
    try {
      const status = await invoke<AgentAuthStatus>("agent_delete_api_key", {
        provider: credential.provider,
        accessProfile: credential.key,
      });
      setProviderAuthStatuses((current) => ({
        ...current,
        [credential.key]: status,
      }));
      setProviderTestResults((current) => ({
        ...current,
        [credential.key]: undefined,
      }));
      notify(`${credential.label}: kulcs törölve`);
    } catch (error) {
      notify(`A kulcs nem törölhető: ${String(error)}`, "notify");
    } finally {
      setProviderAuthBusy(null);
    }
  };

  const testProviderConnection = async (
    credential: (typeof PROVIDER_CREDENTIALS)[number],
  ) => {
    setProviderAuthBusy(`test:${credential.key}`);
    try {
      const result = await invoke<AgentConnectionResult>(
        "agent_test_connection",
        {
          provider: credential.provider,
          accessProfile: credential.key,
          model: credential.model,
          effort: credential.effort,
          maxBudgetUsd: Number(claudeBudgetUsd),
          maxTurns: 1,
          cwd: activeProjectPathRef.current || null,
        },
      );
      setProviderTestResults((current) => ({
        ...current,
        [credential.key]: result,
      }));
      notify(
        result.success
          ? `${credential.label}: kapcsolat rendben`
          : `${credential.label}: ${result.error ?? "kapcsolati hiba"}`,
        result.success ? undefined : "notify",
      );
    } catch (error) {
      setProviderTestResults((current) => ({
        ...current,
        [credential.key]: {
          provider: credential.provider,
          accessProfile: credential.key,
          success: false,
          model: credential.model,
          effort: credential.effort,
          error: String(error),
        },
      }));
      notify(`A kapcsolatteszt sikertelen: ${String(error)}`, "notify");
    } finally {
      setProviderAuthBusy(null);
    }
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
    setClaudeQuestionChoices([]);
    setClaudeQuestionTexts([]);
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
    // A fájlhivatkozás a modell szövegéből is jöhet, ahol a látható címke és a
    // tényleges útvonal független egymástól. Végrehajtható típusnál ezért a
    // teljes utat megmutatjuk, és külön igent kérünk rá.
    if (EXECUTABLE_EXTENSIONS.has(executableExtensionOf(target))) {
      setAppDialog({
        kind: "confirm",
        title: "Végrehajtható fájl indítása",
        message: `Elindítod ezt a fájlt? Kód fut le a gépeden.\n\n${target}`,
        confirmLabel: "Indítás",
        danger: true,
        onConfirm: () => void launchProjectFile(target),
      });
      return;
    }
    await launchProjectFile(target);
  };

  const launchProjectFile = async (target: string) => {
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
    const ownerKey = runOwnerConversationKey();
    if (!ownerKey || !conversationKeysMatch(ownerKey, conversationKey))
      return false;
    notify(
      "Ebben a beszélgetésben épp fut egy válasz. Előbb állítsd le.",
      "notify",
    );
    return true;
  };

  /** Ugyanez projektre: a benne futó beszélgetés miatt zárol. */
  const blockRunProjectMutation = (project: Project) => {
    const ownerKey = runOwnerConversationKey();
    if (
      !ownerKey ||
      !project.threads.some((thread) =>
        conversationKeysMatch(ownerKey, `${project.path}/${thread}`),
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

  const selectModel = (model: string | null, announce = true) => {
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
    if (announce)
      notify(
        model
          ? `Modell kiválasztva: ${modelData?.displayName ?? model}`
          : "Automatikus modell kiválasztva",
      );
  };

  const cycleSelectedProvider = (direction: 1 | -1) => {
    const currentProvider = providerOfModel(selectedModel);
    const currentIndex = COMPOSER_PROVIDERS.indexOf(currentProvider);
    const nextProvider =
      COMPOSER_PROVIDERS[
        (currentIndex + direction + COMPOSER_PROVIDERS.length) %
          COMPOSER_PROVIDERS.length
      ] ?? COMPOSER_PROVIDERS[0];
    const nextModel = PIPELINE_MODELS[nextProvider][0];
    if (nextModel) selectModel(nextModel, false);
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

  const performDeleteProject = (
    project: Project,
    options: DeleteExecutionOptions = {},
  ) => {
    const {
      archive = true,
      skipGuard = false,
      notification = `Eltávolítva a Tree-ből: ${project.name}`,
    } = options;
    if (!skipGuard && blockRunProjectMutation(project)) return;
    markProjectMutation();
    if (isTauri && archive) {
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
    notify(notification);
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

  const performDeleteThread = (
    project: Project,
    thread: string,
    options: DeleteExecutionOptions = {},
  ) => {
    const {
      archive = true,
      skipGuard = false,
      notification = `Beszélgetés törölve: ${thread}`,
    } = options;
    if (!skipGuard && blockRunOwnerMutation(`${project.path}/${thread}`)) return;
    const oldKey = `${project.path}/${thread}`;
    if (isTauri && archive) {
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
    notify(notification);
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

  const performDeleteGeneralConversation = (
    conversation: SyncConversation,
    options: DeleteExecutionOptions = {},
  ) => {
    const {
      archive = true,
      skipGuard = false,
      notification = `Beszélgetés törölve: ${conversation.title}`,
    } = options;
    if (!conversation.id) return;
    if (
      !skipGuard &&
      blockRunOwnerMutation(generalConversationCacheKey(conversation.id))
    )
      return;
    const conversationId = conversation.id;
    const key = generalConversationCacheKey(conversationId);
    const nextCache = { ...localConversationCacheRef.current };
    delete nextCache[key];
    markLocalMutation();
    localConversationCacheRef.current = nextCache;
    setLocalConversationCache(nextCache);
    if (isTauri && archive) {
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
    notify(notification);
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

  const permanentlyDeleteSyncEntity = async (
    tombstone: SyncTombstone,
    removeLocally: () => void,
  ) => {
    if (!isTauri) {
      notify("A OneDrive-os végleges törlés csak a natív appban érhető el.");
      return;
    }
    if (syncActionBusyRef.current) {
      notify("Egy másik szinkronművelet még folyamatban van.", "notify");
      return;
    }
    if (anyRunActive()) {
      notify("Aktív válasz közben nem törölhető véglegesen elem.", "notify");
      return;
    }

    let snapshotMutationStarted = false;
    let snapshotMutationFinished = false;
    syncActionBusyRef.current = true;
    setOpenMenu(null);
    setSyncStatus("végleges törlés…");
    try {
      snapshotMutationStarted = true;
      await beginSnapshotProtectedSyncMutation();
      const result = await invoke<SyncV2Result>(
        "sync_v2_permanently_delete_entity",
        { tombstone },
      );
      setSyncHealth(result.health);
      setSyncWriteEnabled(result.canWrite);
      removeLocally();
      finishSnapshotProtectedSyncMutation(result.snapshot.tombstones ?? []);
      snapshotMutationFinished = true;
      setRetentionPreview(null);
      setSyncHealthOpen(false);
      setSyncStatus("szinkronizálva");
      if (result.warnings.length > 0)
        console.warn("Permanent delete completed with warnings", result.warnings);
    } catch (error) {
      if (snapshotMutationStarted && !snapshotMutationFinished)
        finishSnapshotProtectedSyncMutation();
      setSyncStatus("végleges törlési hiba");
      markSyncHealthError("A végleges OneDrive-törlés nem sikerült.");
      notify(`A végleges törlés nem sikerült: ${String(error)}`, "notify");
      console.warn("Permanent OneDrive delete failed", error);
    } finally {
      syncActionBusyRef.current = false;
    }
  };

  const permanentlyDeleteProject = (project: Project) => {
    if (blockRunProjectMutation(project)) return;
    setAppDialog({
      kind: "confirm",
      title: "Biztos? Végleges projekttörlés",
      message: `Biztos? A(z) „${project.name}” projekt és minden beszélgetése végleg törlődik a Min OneDrive-szinkronjából, és a Recovery Centerből sem lesz visszaállítható. A projektmappa és a saját fájljai változatlanul megmaradnak.`,
      confirmLabel: "Végleges törlés",
      danger: true,
      onConfirm: () => {
        void permanentlyDeleteSyncEntity(
          {
            entityType: "project",
            entityId: project.id,
            archivedAt: new Date().toISOString(),
            projectId: null,
            title: project.name,
            relativePath: project.relativePath,
            pathHint: project.path,
            reason: PERMANENT_DELETE_REASON,
          },
          () =>
            performDeleteProject(project, {
              archive: false,
              skipGuard: true,
              notification: `Végleg törölve a Min szinkronjából: ${project.name}`,
            }),
        );
      },
    });
  };

  const permanentlyDeleteThread = (project: Project, thread: string) => {
    const ownerKey = `${project.path}/${thread}`;
    if (blockRunOwnerMutation(ownerKey)) return;
    const conversation = localConversationCacheRef.current[ownerKey];
    const duplicateConversationId = Boolean(
      conversation?.id &&
        Object.entries(localConversationCacheRef.current).some(
          ([key, candidate]) =>
            key !== ownerKey &&
            key.startsWith(`${project.path}/`) &&
            candidate.projectId === project.id &&
            candidate.id === conversation.id,
        ),
    );
    const entityId =
      !duplicateConversationId && conversation?.id
        ? conversation.id
        : `legacy:${project.id}:${thread}`;
    setAppDialog({
      kind: "confirm",
      title: "Biztos? Végleges beszélgetéstörlés",
      message: `Biztos? A(z) „${thread}” beszélgetés végleg törlődik a Min OneDrive-szinkronjából, és a Recovery Centerből sem lesz visszaállítható.`,
      confirmLabel: "Végleges törlés",
      danger: true,
      onConfirm: () => {
        void permanentlyDeleteSyncEntity(
          {
            entityType: "conversation",
            entityId,
            archivedAt: new Date().toISOString(),
            projectId: project.id,
            title: thread,
            relativePath: project.relativePath,
            pathHint: project.path,
            reason: PERMANENT_DELETE_REASON,
          },
          () =>
            performDeleteThread(project, thread, {
              archive: false,
              skipGuard: true,
              notification: `Végleg törölve a Min szinkronjából: ${thread}`,
            }),
        );
      },
    });
  };

  const permanentlyDeleteGeneralConversation = (
    conversation: SyncConversation,
  ) => {
    if (!conversation.id) return;
    if (blockRunOwnerMutation(generalConversationCacheKey(conversation.id)))
      return;
    setAppDialog({
      kind: "confirm",
      title: "Biztos? Végleges beszélgetéstörlés",
      message: `Biztos? A(z) „${conversation.title}” GENERAL beszélgetés végleg törlődik a Min OneDrive-szinkronjából, és a Recovery Centerből sem lesz visszaállítható.`,
      confirmLabel: "Végleges törlés",
      danger: true,
      onConfirm: () => {
        void permanentlyDeleteSyncEntity(
          {
            entityType: "conversation",
            entityId: conversation.id!,
            archivedAt: new Date().toISOString(),
            projectId: null,
            title: conversation.title,
            reason: PERMANENT_DELETE_REASON,
          },
          () =>
            performDeleteGeneralConversation(conversation, {
              archive: false,
              skipGuard: true,
              notification: `Végleg törölve a Min szinkronjából: ${conversation.title}`,
            }),
        );
      },
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
      setCodeStatus("készen");
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
    if (projectOpeningRef.current) return;
    projectOpeningRef.current = true;
    setProjectOpening(true);
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
        const restored = await restoreProjectTombstones(existing);
        const hydrated = await hydrateProjectFromSync(existing, restored);
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
      const restored = await restoreProjectTombstones(project);
      const hydrated = await hydrateProjectFromSync(project, restored);
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
      setCodeStatus("készen");
      setExpandedWorkLogs({});
      setOpenProjects((current) => ({ ...current, [project.path]: true }));
      notify(`Meglévő projekt hozzáadva: ${project.name}`);
    } catch (error) {
      notify(`Nem sikerült megnyitni a projektmappát: ${String(error)}`);
    } finally {
      projectOpeningRef.current = false;
      setProjectOpening(false);
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
    setCodeStatus(workItems.length ? "kész" : "készen");
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
      // Returning to Coding mode should land on the conversation left open,
      // even when nothing has been typed into it yet.
      { keepLiveSelection: true },
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
    const current = run?.plan ?? runPlanRef.current;
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

  const activeTurnHasCompleted = Boolean(
    activeRequestIdRef.current &&
      turnCompletedRequestId === activeRequestIdRef.current,
  );

  const stopGeneration = async () => {
    const requestId = activeRequestIdRef.current;
    if (
      !requestId ||
      isCancelling ||
      turnCompletedRequestIdRef.current === requestId
    )
      return;
    const stoppingRun = runForRequest(requestId);
    if (stoppingRun && stageInputQueuesRef.current[stoppingRun.requestId]) {
      const nextQueues = { ...stageInputQueuesRef.current };
      delete nextQueues[stoppingRun.requestId];
      stageInputQueuesRef.current = nextQueues;
      setStageInputQueues(nextQueues);
    }
    const liveMessageId = stoppingRun?.liveMessageId ?? null;
    const finalizeCancellation = () => {
      cancelledRequestIdsRef.current.add(requestId);
      // A leállítás is a futásnak szól: a „megszakítva" jelölés a futás
      // beszélgetésébe kerül, nem abba, amit közben megnyitottak.
      const ownerConversationId = stoppingRun?.ownerConversationId ?? null;
      settleAnswerStream(stoppingRun);
      preparingRequestIdRef.current = null;
      writeOwnedMessages(ownerConversationId, (current) =>
        current.map((message) =>
          message.id === liveMessageId
            ? {
                ...message,
                text: appendInterruptedAnswerMarker(message.text),
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
      setIsCancelling(false);
      // `codex_send` runs in a native background task and may only settle
      // after the process has been killed. Release the client-side submit
      // guard here so a cancelled request cannot block the next message.
      markSubmitBusy(ownerConversationId, false);
      setImagesPreparing(false);
      setCodeStatus("kész");
      setWatchdogMessage("");
    };
    // A chain is already running by the time it is "preparing": `pipeline_send`
    // has been called and the runner is off. Closing the placeholder locally
    // and returning — which is what this branch used to do — left it working
    // for another eleven minutes after the user had stopped it. Ask the backend
    // by request id, which is the one name that exists before the first stage
    // reports itself.
    if (preparingRequestIdRef.current === requestId) {
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
    setIsCancelling(true);
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
      await invoke("agent_cancel", {
        provider: stoppingRun?.provider ?? "codex",
        requestId,
      });
      finalizeCancellation();
      notify("A válaszgenerálás leállítva");
    } catch (error) {
      if (/már befejeződött|not found|finished/i.test(String(error))) {
        // The backend no longer owns this request, so no future event can
        // safely keep the UI live. Close the placeholder immediately.
        finalizeCancellation();
        notify("A válaszgenerálás leállítva");
      } else {
        setIsCancelling(false);
        notify(`Nem sikerült leállítani: ${String(error)}`, "notify");
      }
    }
  };

  /**
   * A futás tényleg véget ért — ha várt egy küldés, most indul. A `requestSubmit`
   * ugyanazon az ajtón megy be, mint a kézi Enter: a csatolmányok, idézetek és a
   * mód is az, ami a szerkesztőben van.
   */
  /**
   * Az élő fájlok írása képkockánként.
   *
   * Egy fájlnak egy adagja marad függőben: a delta a *teljes* eddigi tartalmat
   * hozza, tehát az újabb mindig érvényteleníti a régebbit. Így egy 500 soros
   * fájl gépelése is annyi rendert csinál, ahány képkocka — nem annyit, ahány
   * karakter.
   */
  const flushLiveFiles = () => {
    liveFileFrameRef.current = null;
    const pending = [...liveFilePendingRef.current.entries()];
    liveFilePendingRef.current.clear();
    if (pending.length === 0) return;
    setLiveFilesByConversation((current) => {
      const next = { ...current };
      for (const [key, touch] of pending) {
        const [conversationId] = key.split("\u0000");
        next[conversationId] = touchLiveFile(
          next[conversationId] ?? EMPTY_LIVE_FILES,
          touch,
          runProjectPathRef.current || activeProjectPathRef.current,
        );
      }
      return next;
    });
  };

  const queueLiveFile = (
    conversationId: string | null | undefined,
    touch: LiveFileTouch,
  ) => {
    if (!conversationId) return;
    const projectRoot =
      runProjectPathRef.current || activeProjectPathRef.current;
    const path = canonicalLiveFilePath(touch.path, projectRoot);
    const normalizedTouch = { ...touch, path };
    liveFilePendingRef.current.set(`${conversationId}\u0000${liveFilePathKey(path)}`, normalizedTouch);
    if (liveFileFrameRef.current === null)
      liveFileFrameRef.current = window.requestAnimationFrame(flushLiveFiles);
  };

  const discardLiveFile = (
    conversationId: string | null | undefined,
    value: string,
  ) => {
    if (!conversationId || !value) return;
    const projectRoot =
      runProjectPathRef.current || activeProjectPathRef.current;
    const path = canonicalLiveFilePath(value, projectRoot);
    liveFilePendingRef.current.delete(
      `${conversationId}\u0000${liveFilePathKey(path)}`,
    );
    setLiveFilesByConversation((current) => ({
      ...current,
      [conversationId]: removeLiveFile(
        current[conversationId] ?? EMPTY_LIVE_FILES,
        path,
      ),
    }));
  };

  /**
   * Egy fájlművelet vetülete az élő nézetre.
   *
   * `Write` esetén a tartalom maga a fájl. `Edit` esetén a modell csak a
   * cserélendő és az új szöveget adja: a fájlt a lemezről olvassuk hozzá, és
   * arra illesztjük a foltot — így a fülön a *fájl* áll, nem egy kiszakított
   * részlet. Ha a keresett szöveg nincs meg a lemezen, a folt önmagában
   * jelenik meg; félrevezető fájlt nem rajzolunk.
   */
  const trackLiveFileWrite = (
    conversationId: string | null | undefined,
    write: {
      path: string;
      mode: "write" | "edit";
      content?: string;
      oldString?: string;
      newString?: string;
      streaming: boolean;
      sequence: number;
    },
  ) => {
    if (!conversationId || !write.path) return;
    const projectRoot =
      runProjectPathRef.current || activeProjectPathRef.current;
    const path = canonicalLiveFilePath(write.path, projectRoot);
    if (write.mode === "write") {
      const content = write.content ?? "";
      queueLiveFile(conversationId, {
        path,
        content,
        streaming: write.streaming,
        mode: "write",
        highlight: wholeFileHighlight(content),
        sequence: write.sequence,
      });
      return;
    }
    const newString = write.newString ?? "";
    const showPatch = () =>
      queueLiveFile(conversationId, {
        path,
        content: newString,
        streaming: write.streaming,
        mode: "edit",
        highlight: wholeFileHighlight(newString),
        sequence: write.sequence,
      });
    // The original file is needed before we can safely place an edit. Do not
    // render the patch at line 1 while old_string is still streaming.
    const baseKey = `${conversationId}\u0000${liveFilePathKey(path)}`;
    const project = (base: string | null) => {
      // Until old_string is complete, keep the whole original file on screen
      // so an edit around line 100 keeps its real line numbers.
      if (!write.oldString) {
        if (base !== null) {
          queueLiveFile(conversationId, {
            path,
            content: base,
            streaming: write.streaming,
            mode: "edit",
            sequence: write.sequence,
          });
        } else {
          showPatch();
        }
        return;
      }
      const applied =
        base === null
          ? null
          : applyEditToFile(base, write.oldString ?? "", newString);
      if (!applied) {
        showPatch();
        return;
      }
      queueLiveFile(conversationId, {
        path,
        content: applied.content,
        streaming: write.streaming,
        mode: "edit",
        highlight: applied.highlight,
        sequence: write.sequence,
      });
    };
    const known = liveFileBaseRef.current.get(baseKey);
    liveFileBaseProjectRef.current.set(baseKey, project);
    if (known !== undefined) {
      liveFileBaseProjectRef.current.delete(baseKey);
      project(known);
      return;
    }
    const pending = liveFileBaseReadRef.current.get(baseKey);
    if (pending) return;
    const read = invoke<string | null>("read_code_file", {
      cwd: runProjectPathRef.current || activeProjectPathRef.current,
      path,
    })
      .then((base) => {
        const value = base ?? null;
        liveFileBaseRef.current.set(baseKey, value);
        liveFileBaseReadRef.current.delete(baseKey);
        const latestProject =
          liveFileBaseProjectRef.current.get(baseKey) ?? project;
        liveFileBaseProjectRef.current.delete(baseKey);
        latestProject(value);
        return value;
      })
      .catch(() => {
        liveFileBaseRef.current.set(baseKey, null);
        liveFileBaseReadRef.current.delete(baseKey);
        const latestProject =
          liveFileBaseProjectRef.current.get(baseKey) ?? project;
        liveFileBaseProjectRef.current.delete(baseKey);
        latestProject(null);
        return null;
      });
    liveFileBaseReadRef.current.set(baseKey, read);
  };

  const sendSteer = async (
    payload: RunInputPayload,
    target: RunInputTarget,
  ) => {
    composerSendingInputRef.current = payload.inputId;
    dispatchRunInput({
      type: "send_started",
      payload: { ...payload, target },
      sentAt: new Date().toISOString(),
    });
    try {
      await invoke("agent_steer", {
        request: {
          inputId: payload.inputId,
          conversationId: target.conversationId,
          rootRequestId: target.rootRequestId,
          providerRequestId: target.providerRequestId,
          provider: target.provider,
          expectedProviderTurnId: target.providerTurnId,
          expectedStageEpoch: target.stageEpoch,
          text: payload.modelPrompt || payload.text,
          pipelineRunId: target.pipelineRunId,
          stageIndex: target.stageIndex,
          stageRole: target.stageRole,
        },
      });
    } catch (error) {
      const details = asRecord(error);
      const code = (firstString(details.code) ??
        "runtime_failed") as RunInputErrorCode;
      const message = firstString(details.message) ?? describeRunInputError(code);
      dispatchRunInput({
        type: "failed",
        inputId: payload.inputId,
        code,
        message,
        failedAt: new Date().toISOString(),
      });
      if (composerSendingInputRef.current === payload.inputId)
        composerSendingInputRef.current = null;
      notify(describeRunInputError(code), "notify");
    }
  };

  const enqueueFollowUp = async (payload: RunInputPayload) => {
    const conversationId = activeConversationIdRef.current?.trim();
    if (!conversationId) {
      notify("A következő üzenethez még nincs mentett beszélgetés.", "notify");
      return;
    }
    const existing = followUpsForConversation(
      runInputStateRef.current,
      conversationId,
    );
    const now = new Date().toISOString();
    const followUp: QueuedFollowUp = {
      id: payload.inputId,
      conversationId,
      position: existing.length,
      body: payload.text,
      modelPrompt: payload.modelPrompt,
      quoteRefs: payload.quoteRefs,
      attachments: payload.images,
      requestSettings: {
        mode: activeModeRef.current,
        provider:
          activeModeRef.current === "general"
            ? "codex"
            : showDetailedTrace && activePipelineRecipe
              ? stageProvider(0)
              : selectedProvider,
        accessProfile:
          activeModeRef.current === "general"
            ? null
            : showDetailedTrace && activePipelineRecipe
              ? stageAccessProfile(0) ?? null
              : selectedAccessProfile ?? null,
        projectId:
          activeModeRef.current === "general" ? null : activeProjectData.id,
        projectPath:
          activeModeRef.current === "general" ? null : activeProjectData.path,
        conversationKey: threadKey,
        model: selectedModel,
        effort: effectiveEffort,
        detailed:
          activeModeRef.current !== "general" && showDetailedTrace,
        pipelineRecipeId:
          activeModeRef.current !== "general" && showDetailedTrace
            ? activePipelineRecipe?.id
            : null,
        pipelineEnabled:
          activeModeRef.current !== "general" && showDetailedTrace,
        maxBudgetUsd: Number(claudeBudgetUsd),
        maxTurns: claudeTurnLimit(claudeMaxTurns),
        pipelineStageOverrides: activePipelineRecipe?.stages.map((_, index) => ({
          model: stageValue(index, "model") || undefined,
          effort: stageValue(index, "effort") || undefined,
          provider: stageProvider(index),
          accessProfile: stageAccessProfile(index),
        })),
      },
      createdAt: now,
      updatedAt: now,
    };
    try {
      const stored = await invoke<QueuedFollowUp>("pending_followup_upsert", {
        followUp,
      });
      sessionQueuedFollowUpsRef.current.add(stored.id);
      dispatchRunInput({ type: "enqueue_follow_up", followUp: stored });
      inputDraftRef.current = "";
      if (inputRef.current) {
        inputRef.current.value = "";
        resizeComposerTextarea(inputRef.current);
      }
      quoteInputRefs.current = {};
      quoteInstructionDraftsRef.current = {};
      setComposerQuotes([]);
      setPendingImages([]);
      notify("A következő üzenet tartósan sorba állt");
    } catch (error) {
      notify(`A következő üzenet nem menthető: ${String(error)}`, "notify");
    }
  };

  const enqueueStageInput = (payload: RunInputPayload, run: RunHandle) => {
    const next = {
      ...stageInputQueuesRef.current,
      [run.requestId]: [
        ...(stageInputQueuesRef.current[run.requestId] ?? []),
        { ...payload, mode: "steer" as const, target: undefined },
      ],
    };
    stageInputQueuesRef.current = next;
    setStageInputQueues(next);
    inputDraftRef.current = "";
    if (inputRef.current) {
      inputRef.current.value = "";
      resizeComposerTextarea(inputRef.current);
    }
    quoteInputRefs.current = {};
    quoteInstructionDraftsRef.current = {};
    setComposerQuotes([]);
    setPendingImages([]);
    notify("Az üzenet a következő pipeline-fázisnak várakozik");
  };

  const startQueuedFollowUp = async (followUp: QueuedFollowUp) => {
    if (
      followUpDispatchingRef.current.has(followUp.id) ||
      runForConversation(followUp.conversationId) ||
      runsRef.current.size >= MAX_CONCURRENT_RUNS
    )
      return false;
    const key = ownedConversationKey(followUp.conversationId);
    const conversation = key
      ? readConversation(localConversationCacheRef.current, key)
      : undefined;
    if (!key || !conversation) return false;
    const settings = followUp.requestSettings;
    const projectPath = settings.projectPath?.trim() || null;
    if (projectPath && runForProject(projectPath)) return false;
    const recipe = settings.pipelineEnabled
      ? pipelineRecipes.find(
          (candidate) => candidate.id === settings.pipelineRecipeId,
        )
      : undefined;
    if (settings.pipelineEnabled && !recipe) return false;
    const queuedRecipeSnapshot = recipe
      ? recipeWithStageOverrides(
          recipe,
          (settings.pipelineStageOverrides ?? []) as PipelineStageOverride[],
        )
      : undefined;

    followUpDispatchingRef.current.add(followUp.id);
    const requestId = createRequestId();
    const clientTurnId = `request:${requestId}`;
    const requestStartedAt = Date.now();
    let storedImages: MessageImageAttachment[] = [];
    try {
      if (followUp.attachments.length > 0) {
        if (!projectPath) throw new Error("A képekhez hiányzik a projektmappa.");
        storedImages = await invoke<MessageImageAttachment[]>(
          "save_image_attachments",
          {
            cwd: projectPath,
            images: followUp.attachments.map(({ name, mimeType, dataUrl }) => ({
              name,
              mimeType,
              dataUrl,
            })),
          },
        );
      }
      // A follow-upot még azelőtt fogyasszuk el tartósan, hogy a beszélgetés
      // mentése új SQLite-írást indítana. A fordított sorrendben a snapshot és
      // a queue törlése egymásra tudott zárni, ezért egy már lefutott üzenet a
      // következő appindításkor ismét megjelent a sorban.
      if (!(await deleteFollowUp(followUp.id))) return false;
      sessionQueuedFollowUpsRef.current.delete(followUp.id);

      const previousMessages = conversation.messages ?? [];
      const liveMessageId = agentAnswerMessageId(
        followUp.conversationId,
        requestId,
      );
      const userMessage: Message = {
        id: followUp.id,
        role: "user",
        text: followUp.body,
        time: followUp.createdAt,
        images: storedImages,
        quoteRefs: followUp.quoteRefs,
        detailed: settings.detailed,
        sequence: nextTimelineSequence(),
        turnId: clientTurnId,
      };
      const liveMessage: Message = {
        id: liveMessageId,
        role: "assistant",
        text: "",
        time: "most",
        live: true,
        final: false,
        sequence: nextTimelineSequence(),
        turnId: clientTurnId,
      };
      writeOwnedMessages(followUp.conversationId, (current) => [
        ...current,
        userMessage,
        liveMessage,
      ]);
      markLocalMutation();
      const initialPlan: PlanSnapshot = {
        turnId: clientTurnId,
        explanation: "",
        steps:
          settings.mode === "general"
            ? []
            : [
                {
                  id: "client-pre-plan",
                  step: prePlanStepLabel(queuedRecipeSnapshot?.stages[0]?.role),
                  status: "inProgress",
                },
              ],
        startedAt: requestStartedAt,
        stepTimes:
          settings.mode === "general"
            ? {}
            : { "client-pre-plan": { startedAt: requestStartedAt } },
      };
      const runHandle = beginRun({
        requestId,
        ownerConversationId: followUp.conversationId,
        ownerConversationKey: key,
        projectPathKey: projectPath
          ? normalizeConversationKey(projectPath)
          : null,
        provider: settings.provider,
        clientTurnId,
        stageEpoch: 1,
        liveMessageId,
        turnId: clientTurnId,
        turnTiming: { startedAt: requestStartedAt },
        plan: initialPlan,
        planTextBuffer: {},
        agentMessagePhases: {},
        processedEvents: new Set(),
        completedTerminalTurns: new Set(),
        chainRequestIds: new Set(),
        planTaskToCarriedStep: {},
        chain: queuedRecipeSnapshot
          ? { recipe: queuedRecipeSnapshot }
          : undefined,
        answerStream: { meta: null, pending: "", frame: null },
        status: "streaming",
        turnCompleted: false,
      });
      updateOwnedPlanState(followUp.conversationId, initialPlan);

      let sessionId: string | null = null;
      if (settings.provider !== "codex") {
        const status = await invoke<AgentConversationStatus | null>(
          "agent_conversation_status",
          { conversationId: followUp.conversationId },
        ).catch(() => null);
        sessionId =
          status?.hasConflict || status?.provider !== settings.provider
            ? null
            : (status?.activeSessionId ?? null);
      } else {
        sessionId = conversation.threadId ?? null;
      }
      const conversationContext = conversationContextForRehydration(
        previousMessages,
      );
      try {
        if (recipe) {
          const stageRequestIds = recipe.stages.map(
            (_, index) => `${requestId}-stage-${index}`,
          );
          stageRequestIds.forEach((id) => runHandle.chainRequestIds.add(id));
          const run = await invoke<PipelineRunResult>("pipeline_send", {
            request: {
              recipeId: recipe.id,
              prompt: followUp.modelPrompt || followUp.body,
              conversationId: followUp.conversationId,
              planFile: projectPath
                ? planFileNameFor(conversation.title, 1)
                : null,
              requestIds: stageRequestIds,
              placeholderRequestId: requestId,
              images: storedImages,
              cwd: projectPath,
              // A pipeline új szerepkörrel és új checklisttel indul. A régi
              // provider-session Task állapota különben átfolyik az új TERV-be;
              // a beszélgetési előzményt a külön conversationContext viszi.
              sessionId: null,
              conversationContext: conversationContext || null,
              maxBudgetUsd: settings.maxBudgetUsd ?? null,
              stageOverrides: settings.pipelineStageOverrides ?? [],
              runInputs: [],
            },
          });
          const chainSummary = await settleChainGuard(
            run.guard,
            followUp.conversationId,
            projectPath,
          );
          const stageMessages: Message[] = run.stages.map((stage, index) => ({
            id: stage.answerMessageId ?? crypto.randomUUID(),
            role: "assistant",
            text: stage.succeeded
              ? stage.text
              : `A(z) ${STAGE_ROLE_LABELS[stage.role] ?? stage.role} szakasz megszakadt: ${stage.error ?? "ismeretlen hiba"}`,
            time: "most",
            live: false,
            final: true,
            turnId: `request:${stage.requestId}`,
            itemId: "assistant-0",
            changeSummary:
              index === run.stages.length - 1 && chainSummary.length > 0
                ? chainSummary
                : undefined,
            pipeline: {
              runId: run.runId,
              recipeId: run.recipe.id,
              chainId: run.chainId,
              iteration: run.iteration,
              stageIndex: stage.index,
              stageCount: run.recipe.stages.length,
              stageRole: stage.role,
              stageAgent: stage.agentLabel,
              stageRoster: pipelineStageRoster(run.recipe),
              stageStatus: stage.succeeded
                ? "completed"
                : run.status === "cancelled"
                  ? "cancelled"
                  : "failed",
              stageStartedAt:
                runHandle.chain?.stageTimings?.[stage.index]?.startedAt,
              stageCompletedAt:
                runHandle.chain?.stageTimings?.[stage.index]?.completedAt,
              verdict: stage.review?.verdict,
              verdictSummary: stage.review?.summary,
            },
          }));
          writeOwnedMessages(followUp.conversationId, (current) => [
            ...current.filter(
              (message) =>
                message.id !== liveMessageId &&
                !message.turnId?.startsWith(`request:${requestId}-stage-`),
            ),
            ...stageMessages.map((message) => ({
              ...message,
              sequence: nextTimelineSequence(),
            })),
          ]);
        } else {
          const response = await invoke<CodexResponse>("agent_send", {
            request: {
              prompt: followUp.modelPrompt || followUp.body,
              images: storedImages,
              provider: settings.provider,
              runtime: runtimeOfProvider(settings.provider),
              accessProfile: settings.accessProfile ?? undefined,
              conversationId: followUp.conversationId,
              sessionId,
              conversationContext: conversationContext || null,
              model: settings.model,
              effort: settings.effort,
              cwd: projectPath,
              requestId,
              maxBudgetUsd: settings.maxBudgetUsd ?? null,
              maxTurns: settings.maxTurns ?? null,
            },
          });
          let changeSummary: ChangeSummaryFile[] | undefined;
          if (
            projectPath &&
            (response.guard.changedFiles.length > 0 ||
              response.guard.addedFiles.length > 0 ||
              response.guard.removedFiles.length > 0)
          ) {
            changeSummary = changeSummaryFromGuard(response.guard);
            await applyAgentSnapshotAutomatically(response.guard, projectPath);
          }
          settleAnswerStream(runHandle);
          writeOwnedMessages(followUp.conversationId, (current) =>
            current.map((message) =>
              message.id === liveMessageId
                ? {
                    ...message,
                    text: message.text || response.text,
                    live: false,
                    final: true,
                    changeSummary,
                  }
                : message,
            ),
          );
          if (response.threadId && settings.provider === "codex")
            writeBackgroundConversation(followUp.conversationId, (current) => ({
              ...current,
              threadId: response.threadId,
            }));
        }
        markLocalMutation();
      } catch (error) {
        settleAnswerStream(runHandle);
        writeOwnedMessages(followUp.conversationId, (current) =>
          current.map((message) =>
            message.id === liveMessageId
              ? {
                  ...message,
                  text:
                    message.text ||
                    `A sorba állított kérés nem sikerült: ${String(error)}`,
                  live: false,
                  final: true,
                }
              : message,
          ),
        );
        markLocalMutation();
      } finally {
        endRun(requestId);
        setRunsRevision((revision) => revision + 1);
      }
      window.setTimeout(() => void dispatchNextFollowUp(), 0);
      return true;
    } catch (error) {
      notify(`A sorba állított üzenet nem indítható: ${String(error)}`, "notify");
      return false;
    } finally {
      followUpDispatchingRef.current.delete(followUp.id);
    }
  };

  const dispatchNextFollowUp = async () => {
    const eligible = runInputStateRef.current.followUps.filter(
      (followUp) =>
        sessionQueuedFollowUpsRef.current.has(followUp.id) &&
        !followUpDispatchingRef.current.has(followUp.id) &&
        !runForConversation(followUp.conversationId),
    );
    for (const followUp of eligible) {
      if (await startQueuedFollowUp(followUp)) return;
    }
  };

  const deleteFollowUp = async (id: string): Promise<boolean> => {
    const retryDelaysMs = [0, 100, 250, 500, 1_000, 2_000];
    let lastError: unknown = null;
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
      try {
        await invoke("pending_followup_delete", { id });
        dispatchRunInput({ type: "delete_follow_up", id });
        return true;
      } catch (error) {
        lastError = error;
        if (!/database is (?:locked|busy)/i.test(String(error))) break;
      }
    }
    notify(`A következő üzenet nem törölhető: ${String(lastError)}`, "notify");
    return false;
  };

  const moveFollowUp = async (id: string, direction: -1 | 1) => {
    const item = runInputStateRef.current.followUps.find(
      (candidate) => candidate.id === id,
    );
    if (!item) return;
    dispatchRunInput({ type: "move_follow_up", id, direction });
    const preview = runInputReducer(runInputStateRef.current, {
      type: "move_follow_up",
      id,
      direction,
    });
    const ids = followUpsForConversation(preview, item.conversationId).map(
      (followUp) => followUp.id,
    );
    try {
      const stored = await invoke<QueuedFollowUp[]>(
        "pending_followups_reorder",
        { conversationId: item.conversationId, ids },
      );
      dispatchRunInput({
        type: "hydrate_follow_ups",
        followUps: [
          ...runInputStateRef.current.followUps.filter(
            (followUp) => followUp.conversationId !== item.conversationId,
          ),
          ...stored,
        ],
      });
    } catch (error) {
      const stored = await invoke<QueuedFollowUp[]>("pending_followups_list").catch(
        () => runInputStateRef.current.followUps,
      );
      dispatchRunInput({ type: "hydrate_follow_ups", followUps: stored });
      notify(`A sorrend nem menthető: ${String(error)}`, "notify");
    }
  };

  const editFollowUp = async (followUp: QueuedFollowUp, send = false) => {
    inputDraftRef.current = followUp.body;
    if (inputRef.current) {
      inputRef.current.value = followUp.body;
      resizeComposerTextarea(inputRef.current);
    }
    quoteInstructionDraftsRef.current = Object.fromEntries(
      followUp.quoteRefs.map((quote) => [quote.id, quote.instruction]),
    );
    setComposerQuotes(followUp.quoteRefs);
    setPendingImages(followUp.attachments);
    if (!(await deleteFollowUp(followUp.id))) return;
    if (send) window.setTimeout(() => composerFormRef.current?.requestSubmit(), 0);
    else window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reviewCommentTarget) {
      const comment = inputDraftRef.current.trim();
      if (!comment) {
        notify("Írj egy kommentet a v2 újrafuttatásához.", "notify");
        inputRef.current?.focus();
        return;
      }
      void rerunChainFromReview(reviewCommentTarget, comment);
      return;
    }
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
    const detailedRequest = !isGeneralMode && showDetailedTrace;
    const regenerationSettings = pendingRegeneration?.requestSettings;
    const runProvider: AgentProviderId = isGeneralMode
      ? "codex"
      : (regenerationSettings?.provider ?? selectedProvider);
    const runAccessProfile = regenerationSettings
      ? regenerationSettings.accessProfile
      : selectedAccessProfile;
    const runModel = regenerationSettings
      ? regenerationSettings.model
      : selectedModel;
    const runEffort = regenerationSettings?.effort ?? effectiveEffort;
    const useBridge = runProvider !== "codex";
    if (!text && quoteSnapshot.length === 0 && pendingImageSnapshot.length === 0)
      return;
    const imageProvider =
      detailedRequest && activePipelineRecipe
        ? stageProvider(0)
        : runProvider;
    const imageAccessProfile =
      detailedRequest && activePipelineRecipe
        ? stageAccessProfile(0)
        : runAccessProfile;
    if (
      pendingImageSnapshot.length > 0 &&
      !providerSupportsImageInput(imageProvider, imageAccessProfile)
    ) {
      notify(
        `${PROVIDER_LABELS[imageProvider]} ezen az útvonalon nem fogad képet. Válassz ChatGPT-t, Claude-ot vagy Kimi K3 Raw modellt.`,
        "notify",
      );
      return;
    }
    // Egy beszélgetésben egy kör: a beszélgetés lineáris, a következő kérdés
    // kontextusa az előző válasz. A szöveg a szerkesztőben marad, és a futás
    // végén magától elindul.
    const conversationBusy =
      Boolean(runForConversation(activeConversationId)) ||
      submitBusyConversationsRef.current.has(activeConversationId ?? "");
    if (conversationBusy) {
      const liveRun = runForConversation(activeConversationId);
      const target = resolveRunInputTarget(
        activeConversationId,
        runsRef.current.values(),
        liveRun?.chain?.progress ?? null,
      );
      const queueForNextStage = Boolean(
        !target &&
          runInputMode === "stage_next" &&
          liveRun?.chain?.progress &&
          (liveRun.chain.progress.phase === "started" ||
            liveRun.chain.progress.stageIndex <
              liveRun.chain.progress.stageCount - 1),
      );
      const payload: RunInputPayload = {
        inputId: crypto.randomUUID(),
        mode:
          (target && runInputMode === "steer") || queueForNextStage
            ? "steer"
            : "follow_up",
        text,
        modelPrompt: modelPrompt || text,
        quoteRefs: quoteSnapshot,
        images: pendingImageSnapshot,
        target: target ?? undefined,
        createdAt: new Date().toISOString(),
      };
      if (queueForNextStage && liveRun) {
        if (pendingImageSnapshot.length > 0) {
          notify(
            "Képes üzenet jelenleg csak következő üzenetként küldhető.",
            "notify",
          );
          return;
        }
        enqueueStageInput(payload, liveRun);
        return;
      }
      if (payload.mode === "steer" && target) {
        if (composerSendingInputRef.current) {
          notify("Várd meg az előző terelés provider-visszaigazolását.", "notify");
          return;
        }
        if (pendingImageSnapshot.length > 0) {
          notify(
            "Képes üzenet jelenleg csak következő üzenetként küldhető.",
            "notify",
          );
          return;
        }
        void sendSteer(payload, target);
      } else {
        void enqueueFollowUp(payload);
      }
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
    // A zár kulcsa az, ami *most* van: egy első kérdésnél a beszélgetésnek még
    // nincs azonosítója, tehát a kulcs "". A feloldás viszont a kanonikus
    // azonosítót nevezte meg, amit csak lentebb kap meg a futás — a "" így
    // örökre foglalt maradt, és onnantól minden ÚJ beszélgetés első küldése
    // sorba állt egy rég véget ért futás mögé. A kulcsot végig visszük, és
    // amint megvan a végleges azonosító, a zár átköltözik rá.
    let submitBusyKey = activeConversationId;
    markSubmitBusy(submitBusyKey, true);
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
      markSubmitBusy(submitBusyKey, false);
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
    const promptText = text || "Vizsgáld meg a csatolt képet vagy képeket.";
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
    // A zár átköltözik a végleges gazdára. A régi kulcs (első kérdésnél az
    // üres) itt szabadul fel — különben a futás végi feloldás sosem találná
    // meg, és a kulcs a következő új beszélgetést zárná ki.
    if (submitBusyKey !== runConversationId) {
      markSubmitBusy(submitBusyKey, false);
      markSubmitBusy(runConversationId, true);
      submitBusyKey = runConversationId;
    }
    runProjectPathRef.current = isGeneralMode ? "" : activeProjectData.path;
    const previousMessages = mergeMessages(
      localConversationCacheRef.current[requestThreadKey]?.messages ?? [],
      messagesRef.current,
      false,
    );
    const regenerationBase = pendingRegeneration
      ? beginAssistantRegeneration(
          previousMessages,
          pendingRegeneration.source,
          pendingRegeneration.answer,
          fallbackTurnId,
        )
      : undefined;
    // `beginAssistantRegeneration` resolves the authoritative stored user row,
    // but the mode of the retry comes from the composer as it stands now. This
    // lets a compact answer be retried either as another compact answer or as
    // a full multi-stage run without inheriting the old turn's layout.
    const regeneration = regenerationBase
      ? {
          ...regenerationBase,
          source: { ...regenerationBase.source, detailed: detailedRequest },
          messages: regenerationBase.messages.map((message, index) =>
            index === regenerationBase.sourceIndex
              ? { ...message, detailed: detailedRequest }
              : message,
          ),
        }
      : undefined;
    const clientTurnId = regeneration?.turnId ?? fallbackTurnId;
    // The current composer mode owns the retry. In detailed mode regeneration
    // is a real pipeline run; in compact mode it remains a single fresh turn.
    const runPipeline = detailedRequest && Boolean(activePipelineRecipe);
    const pipelineStageOverridesSnapshot: PipelineStageOverride[] =
      runPipeline && activePipelineRecipe
        ? activePipelineRecipe.stages.map((_, index) => ({
            model: stageValue(index, "model") || undefined,
            effort: stageValue(index, "effort") || undefined,
            provider: stageProvider(index),
            accessProfile: stageAccessProfile(index),
          }))
        : [];
    const pipelineRecipeSnapshot =
      runPipeline && activePipelineRecipe
        ? recipeWithStageOverrides(
            activePipelineRecipe,
            pipelineStageOverridesSnapshot,
          )
        : undefined;
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
          provider: runProvider,
          pipeline: undefined,
          interaction: undefined,
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
          provider: runProvider,
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
          detailed: detailedRequest,
          sequence: userSequence,
          // User and assistant rows share one client turn identity. This is the
          // cross-device idempotency key even when cache/SQLite copies carry
          // different row UUIDs.
          turnId: clientTurnId,
        };
    rememberDetailMode(userMessageId, detailedRequest);
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
    setTransportStatus({
      stage: "request-accepted",
      detail: "Kérés fogadva; a feladat értelmezése indul.",
      threadId: null,
    });
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
      provider:
        runPipeline && activePipelineRecipe
          ? stageProvider(0)
          : runProvider,
      clientTurnId,
      stageEpoch: 1,
      liveMessageId,
      replacementMessageId: regeneration?.originalAnswer.id,
      replacementTurnId: regeneration?.turnId,
      turnId: clientTurnId,
      turnTiming: { startedAt: requestStartedAt },
      plan: initialPlan,
      planTextBuffer: {},
      agentMessagePhases: {},
      processedEvents: new Set(),
      completedTerminalTurns: new Set(),
      chainRequestIds: new Set(),
      planTaskToCarriedStep: {},
      chain:
        pipelineRecipeSnapshot ? { recipe: pipelineRecipeSnapshot } : undefined,
      answerStream: { meta: null, pending: "", frame: null },
      status: "preparing",
      turnCompleted: false,
    });
    // A küldés maga az állítás, hogy ez a beszélgetés van a képernyőn. Ezt a
    // nézet-óra is így lássa, különben az első két címzett írás — a kérdés és
    // a terv — a tárba menne ugyan, de a képernyőn nem jelenne meg.
    messageKeyRef.current = requestThreadKey;
    // Az első üzenet átnevezi a beszélgetést, tehát a render-kulcs változik —
    // a szerkesztő eddig ezt beszélgetés-váltásnak nézte, és mindent
    // kiürített: a Részletes kapcsolót, a képeket, az idézeteket. Ugyanaz a
    // beszélgetés, csak új néven; a szerkesztő hatóköre vele költözik.
    composerScopeRef.current = requestThreadKey;
    updateOwnedPlanState(runConversationId, initialPlan);
    writeOwnedMessages(runConversationId, () => nextMessages);
    inputDraftRef.current = "";
    if (inputRef.current) inputRef.current.value = "";
    quoteInputRefs.current = {};
    quoteInstructionDraftsRef.current = {};
    setComposerQuotes([]);
    setPendingImages([]);
    setTurnCompletedRequestId(null);
    preparingRequestIdRef.current = requestId;
    setIsCancelling(false);
    setCodeStatus("dolgozik");
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
    if (cancelledRequestIdsRef.current.delete(requestId)) {
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
      preparingRequestIdRef.current = null;
      endRun(requestId);
      markSubmitBusy(runConversationId, false);
      return;
    }
    preparingRequestIdRef.current = null;
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
      const sessionProvider: AgentProviderId =
        runPipeline && activePipelineRecipe
          ? stageProvider(0)
          : runProvider;
      let durableBridgeSessionId: string | null = null;
      if (sessionProvider !== "codex" && isTauri && !regeneration) {
        try {
          const status = await invoke<AgentConversationStatus | null>(
            "agent_conversation_status",
            { conversationId: requestConversationId },
          );
          if (
            status &&
            !status.hasConflict &&
            status.provider === sessionProvider
          )
            durableBridgeSessionId = status.activeSessionId;
        } catch (error) {
          console.warn("Agent conversation status unavailable", error);
        }
      }
      const resumeBridgeSessionId = regeneration
        ? null
        : (durableBridgeSessionId ??
          claudeSessionIds[
            bridgeSessionCacheKey(requestThreadKey, sessionProvider)
          ] ??
          (sessionProvider === "anthropic"
            ? claudeSessionIds[requestThreadKey]
            : null) ??
          null);
      // A chain is its own call: the runner drives the stages, records each
      // answer, and returns them together. The ordinary single-turn path below
      // is untouched, which is what keeps the default behaviour identical.
      if (runPipeline && activePipelineRecipe && isTauri) {
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
              // A terv fájlként is megmarad a projektben; a futtató írja ki
              // a terv-szakasz végén.
              planFile: planFileNameFor(activeThread, 1),
              requestIds: stageRequestIds,
              placeholderRequestId: requestId,
              replaceMessageId: regeneration?.originalAnswer.id ?? null,
              replaceTurnId: regeneration?.turnId ?? null,
              images: storedImages,
              cwd: isGeneralMode ? null : activeProjectData.path,
              // A TERV minden új láncnál tiszta sessiont nyit. A KÓD ugyanazt
              // a friss sessiont folytatja, a REVIEW pedig eleve külön indul.
              sessionId: null,
              conversationContext: rehydrationContext || null,
              maxBudgetUsd: Number(claudeBudgetUsd),
              stageOverrides: pipelineStageOverridesSnapshot,
            },
          });
          // Stopping a chain used to throw away everything it had already
          // produced: the runner returns the finished stages with a cancelled
          // status, and this line dropped them on the floor. A plan and a
          // finished implementation are worth keeping — pressing stop means
          // "go no further", not "pretend none of it happened".
          const cancelled = cancelledRequestIdsRef.current.delete(requestId);
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
          const outputStageRole = recipeOutputRole(run.recipe);
          const outputStageIndex = run.stages.findIndex(
            (stage) => stage.role === outputStageRole,
          );
          const artifactStageIndex =
            outputStageIndex >= 0
              ? outputStageIndex
              : run.stages.findIndex((stage) => stage.role === "plan");
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
            provider: run.recipe.stages[stageIndex]?.provider ?? "codex",
            changeSummary:
              stageIndex === artifactStageIndex && chainSummary.length > 0
                ? chainSummary
                : undefined,
            pipeline: {
              runId: run.runId,
              recipeId: run.recipe.id,
              chainId: run.chainId,
              iteration: run.iteration,
              stageIndex: stage.index,
              stageCount: run.recipe.stages.length,
              stageRole: stage.role,
              stageAgent: stage.agentLabel,
              stageRoster: pipelineStageRoster(run.recipe),
              stageStatus: stage.succeeded
                ? "completed"
                : run.status === "cancelled"
                  ? "cancelled"
                  : "failed",
              stageStartedAt:
                runHandle.chain?.stageTimings?.[stage.index]?.startedAt,
              stageCompletedAt:
                runHandle.chain?.stageTimings?.[stage.index]?.completedAt,
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
          const lastSessionStage = [...run.stages]
            .reverse()
            .find((stage) => stage.sessionId);
          if (lastSessionStage?.sessionId) {
            const lastSessionProvider = stageProvider(lastSessionStage.index);
            setClaudeSessionIds((current) => ({
              ...current,
              [bridgeSessionCacheKey(
                requestThreadKey,
                lastSessionProvider,
              )]: lastSessionStage.sessionId!,
            }));
          }
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
          runHandle.chain = undefined;
          setRunsRevision((revision) => revision + 1);
          // A chain runs under one request id per stage, so the shared reset
          // at the end of this function — which only fires when the active
          // request id is still the one it started with — never matches after
          // a chain. Without this the composer stayed "busy" for good: the
          // send button looked ready and silently dropped every next message
          // until the app was restarted.
          setIsCancelling(false);
          preparingRequestIdRef.current = null;
          setTurnCompletedRequestId(null);
          markSubmitBusy(runConversationId, false);
          endRun(requestId);
          void dispatchNextFollowUp();
        }
        return;
      }
      const response = useBridge
        ? await invoke<CodexResponse>("agent_send", {
            request: {
              prompt: codexPrompt,
              images: storedImages,
              provider: runProvider,
              runtime: runtimeOfProvider(runProvider),
              accessProfile: runAccessProfile,
              conversationId: requestConversationId,
              sessionId: resumeBridgeSessionId,
              conversationContext: rehydrationContext || null,
              model: runModel,
              // The reasoning slider, like every other model: the Claude panel
              // used to carry an effort of its own, and being set it always
              // won — moving the slider changed nothing for a Claude turn.
              effort: runEffort,
              cwd: activeProjectData.path,
              requestId,
              replaceMessageId: regeneration?.originalAnswer.id,
              replaceTurnId: regeneration?.turnId,
              maxBudgetUsd: Number(claudeBudgetUsd),
              maxTurns: claudeTurnLimit(claudeMaxTurns),
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
              model: runModel,
              effort: runEffort,
              cwd: isGeneralMode ? null : activeProjectData.path,
              requestId,
              replaceMessageId: regeneration?.originalAnswer.id,
              replaceTurnId: regeneration?.turnId,
            },
          });
      if (cancelledRequestIdsRef.current.delete(requestId)) return;
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
        if (useBridge) {
          const sessionId = response.threadId || null;
          if (sessionId)
            setClaudeSessionIds((current) => ({
              ...current,
              [bridgeSessionCacheKey(requestThreadKey, runProvider)]: sessionId,
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
          provider: runProvider,
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
                      turnId: activeTurnIdRef.current,
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
      setCodeStatus("kész");
      setWatchdogMessage("");
      // Fallback for an app-server that completes the request without
      // emitting turn/completed. The per-request guard prevents duplicates.
      playCompletionSoundOnce(requestId);
      notify(
        response.threadRehydrated
          ? "Beszélgetés folytatva ezen a gépen"
          : "Codex válasz megérkezett",
      );
    } catch (error) {
      const providerName = PROVIDER_LABELS[runProvider];
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
        cancelledRequestIdsRef.current.delete(requestId) ||
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
                text: wasCancelled
                  ? appendInterruptedAnswerMarker(
                      stripStaleInterruptionMarker(message).text.trim() ||
                        regeneration?.originalAnswer.text ||
                        "",
                    )
                  : // Bukott futásnál a hiba a válasz — nem az előző verzió.
                    // A régi szöveg visszaállítása itt azt a látszatot keltette,
                    // hogy az új futás ezt az eredményt adta: egy 20 perces
                    // DeepSeek-kör után a *megelőző* Claude-hiba jelent meg a
                    // kártyán, holott az új kör bukott el. Az eredeti szöveg a
                    // regenerálás verziótárában marad meg, nem itt.
                    stripStaleInterruptionMarker(message).text.trim() ||
                    `Nem sikerült a ${providerName}-kérés: ${errorDescription.userMessage}`,
                turnId: message.turnId ?? activeTurnIdRef.current,
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
      setCodeStatus(wasCancelled || answerArrived ? "kész" : "hiba");
      setTransportStatus({
        requestId,
        stage: wasCancelled ? "cancelled" : "error",
        detail: `${errorDescription.code}: ${errorDescription.detail}`,
        threadId: activeTurnIdRef.current,
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
      if (activeRequestIdRef.current === requestId) {
        setIsCancelling(false);
        preparingRequestIdRef.current = null;
        setTurnCompletedRequestId(null);
      }
      markSubmitBusy(runConversationId, false);
      // Gazdátlan futás nincs: a táblából kikerülve a késői eseményei nem
      // találnak haza, tehát eldobódnak — nem pedig „mindenhová" írnak.
      endRun(requestId);
      void dispatchNextFollowUp();
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
    const answerStageIndex = answer.pipeline?.stageIndex;
    const regenerationStageIndex = answerStageIndex ?? 0;
    const visibleStageSettings =
      showDetailedTrace &&
      activePipelineRecipe?.stages[regenerationStageIndex]
        ? {
            provider: stageProvider(regenerationStageIndex),
            accessProfile: stageAccessProfile(regenerationStageIndex) ?? null,
            model: stageValue(regenerationStageIndex, "model") ?? null,
            effort:
              stageValue(regenerationStageIndex, "effort") || effectiveEffort,
          }
        : undefined;
    const requestSettings = resolveRegenerationRequestSettings(
      {
        provider: selectedProvider,
        accessProfile: selectedAccessProfile ?? null,
        model: selectedModel,
        effort: effectiveEffort,
      },
      visibleStageSettings,
    );
    regenerationTargetRef.current = { source, answer, requestSettings };
    inputDraftRef.current = source.text;
    if (inputRef.current) {
      inputRef.current.value = source.text;
      resizeComposerTextarea(inputRef.current);
    }
    quoteInstructionDraftsRef.current = Object.fromEntries(
      (source.quoteRefs ?? []).map((quote) => [quote.id, quote.instruction]),
    );
    setComposerQuotes(source.quoteRefs ?? []);
    // Keep the composer's current mode until submit snapshots it. A compact
    // answer can therefore be regenerated as a full detailed pipeline when
    // the user has opened the three-stage rail.
    window.setTimeout(() => composerFormRef.current?.requestSubmit(), 0);
  };

  /**
   * Runs the chain again from the role targeted by a rejected review.
   *
   * Not a fresh chain, and not a new question: the plan the reviewer agreed to
   * is handed back as an artifact. A plan review re-runs the planner itself;
   * an implementation review keeps the accepted plan and resumes at coding.
   */
  const activateReviewCommentMode = (chainKey: string) => {
    setReviewRerunChoiceTarget(null);
    setReviewCommentTarget(chainKey);
    // A REVIEW comment is a separate instruction, never a continuation of a
    // draft that happened to be in the normal composer.
    inputDraftRef.current = "";
    if (inputRef.current) {
      inputRef.current.value = "";
      resizeComposerTextarea(inputRef.current);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const cancelReviewCommentMode = () => {
    setReviewCommentTarget(null);
    inputDraftRef.current = "";
    if (inputRef.current) {
      inputRef.current.value = "";
      resizeComposerTextarea(inputRef.current);
    }
  };

  const rerunChainFromReview = async (
    chainKey: string,
    userComments = "",
  ) => {
    if (!isTauri) return;
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
    const chainRecipeId = chainMessages
      .map((message) => message.pipeline?.recipeId)
      .find((id): id is string => Boolean(id));
    const chainRecipe =
      pipelineRecipes.find((recipe) => recipe.id === chainRecipeId) ??
      (chainMessages.some(
        (message) => message.pipeline?.stageRole === "plan_review",
      )
        ? pipelineRecipes.find((recipe) => recipe.id === "plan_review")
        : pipelineRecipes.find((recipe) => recipe.id === "plan_code_review")) ??
      activePipelineRecipe;
    if (!chainRecipe) return;
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
    const reviewTarget = recipeReviewTarget(chainRecipe);
    const reviewRole =
      reviewTarget === "plan" ? "plan_review" : "review";
    const objection = newestOfRole(reviewRole)?.text.trim();
    const userCommentText = userComments.trim();
    if (!objection) {
      notify("A bíráló szövege nélkül nincs mit javítani.");
      return;
    }
    const chainStartsAt = messagesRef.current.indexOf(chainMessages[0]);
    const originalPromptMessage = [...messagesRef.current.slice(0, chainStartsAt)]
      .reverse()
      .find((message) => message.role === "user" && !message.interaction);
    const originalPrompt = originalPromptMessage?.text.trim();
    if (!originalPrompt) {
      notify("Az eredeti kérdés nem található, a lánc nem indítható újra.");
      return;
    }
    const startRole = recipeRetryFromRole(chainRecipe);
    const startStage = chainRecipe.stages.findIndex(
      (recipeStage) => recipeStage.role === startRole,
    );
    if (startStage < 0) {
      notify("A receptben nincs újrafuttatható szakasz.");
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
      newestOfRole("plan_review") && {
        role: "plan_review",
        text: newestOfRole("plan_review")!.text,
        changedFiles: [],
      },
    ].filter(Boolean);

    const iteration = latestVersion + 1;
    const requestId = createEntityId();
    const stageRequestIds = chainRecipe.stages.map(
      (_, index) => `${requestId}-stage-${index}`,
    );
    const rerunStageOverrides: PipelineStageOverride[] = chainRecipe.stages.map(
      (_, index) => ({
        model:
          pipelineStageOverrides[`${chainRecipe.id}:${index}`]?.model ??
          undefined,
        effort:
          pipelineStageOverrides[`${chainRecipe.id}:${index}`]?.effort ??
          undefined,
        provider:
          pipelineStageOverrides[`${chainRecipe.id}:${index}`]?.provider ??
          undefined,
        accessProfile:
          pipelineStageOverrides[`${chainRecipe.id}:${index}`]
            ?.accessProfile ??
          accessProfileOfModel(
            pipelineStageOverrides[`${chainRecipe.id}:${index}`]?.model ??
              chainRecipe.stages[index]?.model ??
              null,
          ),
      }),
    );
    const rerunRecipeSnapshot = recipeWithStageOverrides(
      chainRecipe,
      rerunStageOverrides,
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
    setReviewRerunChoiceTarget(null);

    // A re-run is a chain, and a chain is read in the detailed layout: the
    // panel it draws has phases. Without this the composer would stay compact,
    // and the run would render as if it were a single turn.
    selectPipelineRecipe(chainRecipe.id);
    setShowDetailedTrace(true);
    // The elapsed clock counts from the plan's start, and the plan still held
    // the *original* run's timestamp — which is how a one-minute re-run came
    // to report an hour and twenty minutes. This round starts now.
    const rerunStartedAt = Date.now();
    runProjectPathRef.current =
      activeMode === "general" ? "" : activeProjectData.path;
    const rerunRun = beginRun({
      requestId,
      ownerConversationId: rerunConversationId,
      ownerConversationKey: threadKey,
      projectPathKey:
        activeMode === "general"
          ? null
          : normalizeConversationKey(activeProjectData.path),
      provider: rerunRecipeSnapshot.stages[startStage]?.provider ?? "anthropic",
      clientTurnId: `request:${requestId}`,
      stageEpoch: 1,
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
      planTaskToCarriedStep: {},
      // A `startStage` előtti szakaszok ebben a körben nem futnak: enélkül a
      // sáv úgy rajzolná őket, mintha még sorra kerülnének.
      chain: {
        recipe: rerunRecipeSnapshot,
        resume: { chainKey, startStage, iteration, carried },
      },
      answerStream: { meta: null, pending: "", frame: null },
      status: "streaming",
      turnCompleted: false,
    });
    updateOwnedPlanState(rerunConversationId, {
      turnId: `request:${requestId}`,
      explanation: "",
      steps: [
        {
          id: "client-pre-plan",
          step: prePlanStepLabel(
            chainRecipe.stages[startStage]?.role ?? "code",
          ),
          status: "inProgress",
        },
      ],
      startedAt: rerunStartedAt,
      stepTimes: { "client-pre-plan": { startedAt: rerunStartedAt } },
    });
    setReviewCommentTarget(null);
    if (userCommentText) {
      inputDraftRef.current = "";
      if (inputRef.current) {
        inputRef.current.value = "";
        resizeComposerTextarea(inputRef.current);
      }
    }
    try {
      const run = await invoke<PipelineRunResult>("pipeline_send", {
        request: {
          recipeId: chainRecipe.id,
          prompt: originalPrompt,
          conversationId: activeConversationId,
          // Egy kérdés = egy terv-fájl. Az újrafuttatás nem tervez, csak a
          // A TERV REVIEW újrafutása új tervet ír; a KÓD-tól induló javítás a
          // korábbi tervet tartja meg, ezért annak v1 fájlját naplózza.
          planFile: planFileNameFor(
            activeThread,
            chainRecipe.id === "plan_review" ? iteration : 1,
          ),
          requestIds: stageRequestIds,
          placeholderRequestId: null,
          images: [],
          cwd: activeMode === "general" ? null : activeProjectData.path,
          // A seedelt terv és a reviewer kifogása teljes kontextus; egy régi
          // provider-session todo-listája csak összekeverné a javítási kört.
          sessionId: null,
          conversationContext: null,
          maxBudgetUsd: Number(claudeBudgetUsd),
          stageOverrides: rerunStageOverrides,
          startStage,
          seedArtifacts,
          retryFeedback: objection,
          userComments: userCommentText || null,
          chainId: chainKey,
          iteration,
          runInputs: messagesRef.current
            .filter(
              (message) =>
                message.interaction?.kind === "steer" &&
                message.interaction.parentTurnId === originalPromptMessage?.turnId,
            )
            .map((message) => ({
              inputId: message.interaction!.inputId,
              acceptedAtStage: message.interaction!.stageIndex ?? -1,
              acceptedAtRole: message.interaction!.stageRole ?? "run",
              text: message.text,
              acceptedAt: message.interaction!.acceptedAt,
            })),
        },
      });
      // Same as the first pass: the edits go on disk before the answer does.
      const chainSummary = await settleChainGuard(
        run.guard,
        rerunConversationId,
        activeMode === "general" ? null : activeProjectData.path,
      );
      const outputStageRole = recipeOutputRole(run.recipe);
      const outputStageIndex = run.stages.findIndex(
        (stage) => stage.role === outputStageRole,
      );
      const artifactStageIndex =
        outputStageIndex >= 0
          ? outputStageIndex
          : run.stages.findIndex((stage) => stage.role === "plan");
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
          stageIndex === artifactStageIndex && chainSummary.length > 0
            ? chainSummary
            : undefined,
        pipeline: {
          runId: run.runId,
          recipeId: run.recipe.id,
          chainId: run.chainId,
          iteration: run.iteration,
          stageIndex: stageResult.index,
          stageCount: run.recipe.stages.length,
          stageRole: stageResult.role,
          stageAgent: stageResult.agentLabel,
          stageRoster: pipelineStageRoster(run.recipe),
          stageStatus: stageResult.succeeded
            ? "completed"
            : run.status === "cancelled"
              ? "cancelled"
              : "failed",
          stageStartedAt:
            rerunRun.chain?.stageTimings?.[stageResult.index]?.startedAt,
          stageCompletedAt:
            rerunRun.chain?.stageTimings?.[stageResult.index]?.completedAt,
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
      rerunRun.chain = undefined;
      setRunsRevision((revision) => revision + 1);
      setIsCancelling(false);
      endRun(requestId);
      void dispatchNextFollowUp();
    }
  };

  const applyComposerEdit = (
    textarea: HTMLTextAreaElement,
    edit: ComposerEdit,
  ) => {
    textarea.setRangeText(edit.text, edit.from, edit.to, "end");
    const quoteId = textarea.dataset.quoteId;
    if (quoteId) {
      quoteInstructionDraftsRef.current[quoteId] = textarea.value;
    } else inputDraftRef.current = textarea.value;
    requestAnimationFrame(() => {
      const position = edit.from + edit.text.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
      resizeComposerTextarea(textarea);
    });
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab a listában szintet vált; listán kívül marad a fókuszléptetés.
    if (event.key === "Tab") {
      const textarea = event.currentTarget;
      if (textarea.selectionStart !== textarea.selectionEnd) return;
      const edit = listIndent(
        textarea.value,
        textarea.selectionStart,
        event.shiftKey ? "out" : "in",
      );
      if (!edit) return;
      event.preventDefault();
      applyComposerEdit(textarea, edit);
      return;
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey) {
      const textarea = event.currentTarget;
      const edit = listBreak(textarea.value, textarea.selectionStart);
      if (!edit) return;
      event.preventDefault();
      applyComposerEdit(textarea, edit);
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      // Részletes (láncos) futás alatt az Enter nem küld a futó AI-nak: egy
      // véletlen leütés a fázis addigi gondolkodását dobná el. A ⇢ gomb marad
      // a szándékos terelés útja.
      if (
        pipelineProgress &&
        (runInputMode === "steer" || runInputMode === "stage_next")
      )
        return;
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
    setCodeStatus("készen");
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
  const activeWorkGroup = viewingActiveRun
    ? findActiveWorkGroup(
        workLogGroups,
        messages,
        activeTurnIdRef.current,
      )
    : undefined;
  const currentWorkGroup =
    activeWorkGroup ??
    (activeTurnIdRef.current
      ? workLogGroups.find((group) =>
          workGroupTurnKeys(group).includes(activeTurnIdRef.current!),
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
    return hasInterruptedAnswerMarker(text);
  };
  const interruptedAnswerWithPartial = (
    answer: Message,
    commentary: CommentaryEntry[],
  ): Message => {
    if (!(answer.interrupted || hasInterruptedAnswerMarker(answer.text)))
      return answer;
    const storedPartial = answer.text.replace(interruptedMarkerPattern, "").trim();
    const commentaryPartial = [...commentary]
      .reverse()
      .find(
        (entry) =>
          entry.channel === "assistant-output" && entry.body.trim().length > 0,
      )
      ?.body.trim();
    return {
      ...answer,
      text: appendInterruptedAnswerMarker(storedPartial || commentaryPartial || ""),
      interrupted: true,
      live: false,
      final: true,
    };
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
    // A stop marker is the terminal truth for the turn. Preferring an older,
    // non-interrupted alias made a cancelled run look completed and hid the
    // marker behind its last streamed sentence.
    const interrupted = [...candidates]
      .reverse()
      .find(
        ({ message }) =>
          message.interrupted || isInterruptedAssistantText(message.text),
      );
    if (interrupted) return interrupted.message;
    const nonInterrupted = [...candidates].reverse().find(({ message }) =>
      Boolean(message.text.trim()),
    );
    if (nonInterrupted) return nonInterrupted.message;
    if (candidates.length > 0) return candidates[candidates.length - 1].message;
    // A trace without a user bucket has no reliable owner. Never attach the
    // nearest answer to it: stale plan metadata would otherwise render an
    // orphaned VÁLASZ card before the first visible user message.
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
    stageCount: number;
    role: string;
    agent: string;
    iteration: number;
    runId: string;
    recipeId?: string;
    stageRoster?: MessagePipeline["stageRoster"];
    status?: MessagePipeline["stageStatus"];
    startedAt?: number;
    completedAt?: number;
    verdict?: string;
    verdictSummary?: string;
  };
  // Every iteration of one question, in one bucket. A re-run adds later
  // versions of the stages it re-ran, not a second chain.
  const stagesByChain = new Map<string, ChainStage[]>();
  // Közvetlenül az üzenetek metaadatából, nem a munkacsoportokon át: a
  // csoportok a napló hidratálása közben állnak össze, és amíg nem álltak
  // össze, a fül-sávból hiányzott az a szakasz, amelyiké épp nem volt kész —
  // hidegindítás után egy lezárt láncról így tűnt el a 3/3 REVIEW fül. A
  // metaadat viszont az első képkockától teljes.
  // Ugyanannak a szakasznak több sora is lehet (saját mentés + hidratált
  // másolat); a sávra egy kerül, a legutóbbi — az hordozza a verdiktet is.
  const chainStageRows = new Map<string, MessagePipeline>();
  for (const message of messages) {
    const stage = message.role === "assistant" ? message.pipeline : undefined;
    if (!stage) continue;
    chainStageRows.set(`${stage.runId}#${stage.stageIndex}`, stage);
  }
  for (const stage of chainStageRows.values()) {
    const key = chainKeyOf(stage);
    const stages = stagesByChain.get(key) ?? [];
    stages.push({
      stageIndex: stage.stageIndex,
      stageCount: stage.stageCount,
      role: stage.stageRole,
      agent: stage.stageAgent,
      iteration: iterationOf(stage),
      runId: stage.runId,
      recipeId: stage.recipeId,
      stageRoster: stage.stageRoster,
      status: stage.stageStatus,
      startedAt: stage.stageStartedAt,
      completedAt: stage.stageCompletedAt,
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
    let groupAnswer = answerForWorkGroup(entry.group);
    // A quote-only/aborted turn can leave plan metadata behind without an
    // assistant answer. Rendering that orphaned trace produces a stray
    // horizontal rule between messages, so keep the timeline clean.
    if (!groupAnswer?.text.trim()) return null;
    const storedPlan = planForWorkGroup(entry.group, groupAnswer.turnId);
    const groupCommentary = commentaryForWorkGroup(
      entry.group,
      groupAnswer.turnId,
    );
    groupAnswer = interruptedAnswerWithPartial(groupAnswer, groupCommentary);
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
    const storedChainSlots = slotsOfChain(chain);
    const expectedStageCount = Math.max(
      ...chain.map((item) => item.stageCount || 0),
      (storedChainSlots.at(-1) ?? -1) + 1,
    );
    const chainSlots = Array.from(
      { length: expectedStageCount },
      (_, index) => index,
    );
    // The strip is built from the chain's slots, so a re-run that skipped the
    // planner still shows a TERV tab -- filled by the version that wrote it.
    const runStages = chainSlots
      .map((slot) => stageForVersion(chain, selectedVersion, slot))
      .filter((item): item is ChainStage => Boolean(item));
    const chainRecipe = pipelineRecipes.find(
      (recipe) => recipe.id === chain.find((item) => item.recipeId)?.recipeId,
    );
    const chainRoster = chain.find((item) => item.stageRoster?.length)
      ?.stageRoster;
    // A STOP may happen in the first provider call, before KÓD or REVIEW ever
    // create an answer row. They still belong to the run: render their recipe
    // slots as disabled future phases instead of making a three-stage run look
    // like an ordinary single-model answer.
    const runStageTabs = chainSlots.map((slot) => {
      const stored = stageForVersion(chain, selectedVersion, slot);
      if (stored) return { ...stored, pending: false };
      const rosterStage = chainRoster?.find(
        (item) => item.stageIndex === slot,
      );
      const recipeStage = chainRecipe?.stages[slot];
      const provider = recipeStage?.provider ?? "codex";
      const model = recipeStage?.model ?? "";
      return {
        stageIndex: slot,
        stageCount: expectedStageCount,
        role: rosterStage?.stageRole ?? recipeStage?.role ?? `stage-${slot + 1}`,
        agent:
          rosterStage?.stageAgent ??
          `${PROVIDER_LABELS[provider]}${model ? ` · ${shortModelLabel(model)}` : ""}`,
        iteration: selectedVersion,
        runId: stage?.runId ?? "",
        recipeId: stage?.recipeId,
        pending: true,
      };
    });
    const lastStageIndex = chainSlots.at(-1) ?? 0;
    // The result-producing stage is the useful default: TERV for a planning
    // recipe, KÓD for an implementation recipe. VÁLASZ is no longer a separate
    // tab because every stage shows its answer, steps and thinking together.
    const outputStage =
      runStages.find((item) => item.role === "code") ??
      runStages.find((item) => item.role === "plan") ??
      runStages.at(-1);
    const requestedStage = stage
      ? (selectedStages[chainKey] ?? outputStage?.stageIndex ?? lastStageIndex)
      : 0;
    // Olyan fázisra mutató kiválasztás, aminek ebben a verzióban nincs üzenete,
    // MINDEN szakasz-kártyát elnémít: a `stageForVersion` semmit nem ad vissza,
    // a lenti azonosság-feltétel pedig így mindegyikre igaz lesz, és eltűnik az
    // egész VÁLASZ panel. Mivel a rossz index a state-ben marad, csak a GUI
    // újraindítása hozta vissza. A kiválasztás ezért mindig létező fázisra esik.
    const resolvableStages = stage
      ? slotsOfChain(chain).filter((slot) =>
          stageForVersion(chain, selectedVersion, slot),
        )
      : [];
    const selectedStage = !stage
      ? 0
      : resolvableStages.includes(requestedStage)
        ? requestedStage
        : (resolvableStages.at(-1) ?? requestedStage);
    // Only the chosen phase draws itself; the others are one click away.
    // Matched on the run as well as the slot: two versions own the same slot,
    // and without the run id both of them would draw the panel.
    const shownStage = stage
      ? stageForVersion(chain, selectedVersion, selectedStage)
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
    // A jelölőt csak akkor szabad kiírni, ha be is fogják váltani. A beváltás
    // feltétele `rerunInPlace` = `liveRunResume && pipelineProgress &&
    // hasLiveRerunSlot`; ha a jelölő ennél lazább feltétellel megy ki, a
    // maradék ágon a szűrő **kidobja** — és a lánc kártyája nyom nélkül eltűnik
    // a beszélgetésből. Pont ez történt: a re-run lefutott, a `pipelineProgress`
    // elszállt, a `chain.resume` viszont a futáskezelőben maradt, így a
    // legutolsó válasz kártyája kiesett a timeline-ból, és csak a GUI
    // újraindítása hozta vissza.
    //
    // A korábbi megjegyzés a `pipelineProgress` bevárását azért kerülte, mert
    // addig az élő kártya alul rajzol, majd a helyére ugrik. Ez a csere egy
    // pillanatnyi ugrást vált ki egy tartósan elveszett kártya helyett — a
    // kettő közül ez a rosszabbik eset megszűnik.
    if (stage && liveRunResume?.chainKey === chainKey && pipelineProgress) {
      return LIVE_RERUN_SLOT;
    }
    // The verdict of the version being read, not of the newest one: a reader
    // who went back to v1 is looking at what v1 concluded.
    const runVerdict = stageForVersion(chain, selectedVersion, lastStageIndex);
    const versionIndex = chainVersions.indexOf(selectedVersion);
    const stepVersion = (delta: number) => {
      const next = chainVersions[versionIndex + delta];
      if (next === undefined) return;
      setSelectedVersions((current) => ({ ...current, [chainKey]: next }));
    };
    // A verziócímke a kiválasztott fázis nyilához tapad, tehát vele együtt
    // mozog a sínen. A sorköz a sín geometriája: 21 px ikon + 9 px rés.
    const activeTabIndex = Math.max(
      0,
      runStageTabs.findIndex((item) => item.stageIndex === selectedStage),
    );
    const runHeader = stage ? (
        <div
          className="pipeline-run-header is-history"
          data-run-id={chainKey}
          style={{ "--active-tab-index": activeTabIndex } as CSSProperties}
        >
          {chainVersions.length > 1 && (
            // A re-run does not replace what it was answering: both attempts
            // stay readable, and this picks which one the panel is showing.
            // Csak a szám, nyíl-indikáció nélkül, kattintásra körbejár. A
            // kiválasztott fázis nyilához tapad (lásd `--active-tab-index`),
            // tehát vele együtt mozog a sínen, és nem tolja lejjebb az
            // ikonokat.
            <button
              type="button"
              className="pipeline-run-version"
              aria-label={`Verzió: v${selectedVersion} — kattintásra vált`}
              title="Kattintás: verzióváltás"
              onClick={() =>
                stepVersion(
                  versionIndex >= chainVersions.length - 1
                    ? -versionIndex
                    : 1,
                )
              }
            >
              <span className="pipeline-run-version-value" aria-live="polite">
                {`v${selectedVersion}`}
              </span>
            </button>
          )}
          <span
            className="pipeline-run-tabs"
            role="tablist"
            style={{ "--tab-count": runStageTabs.length } as CSSProperties}
          >
            {runStageTabs.map((item) => ({
                key: item.stageIndex,
                label: STAGE_ROLE_LABELS[item.role] ?? item.role,
                agent: item.agent,
                status: item.status,
                pending: item.pending,
              })).map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={item.key === selectedStage}
                disabled={item.pending}
                // The phase that carries the verdict says so in the strip as
                // well, so a run's outcome is readable without opening it.
                className={`pipeline-run-tab${item.pending ? " is-future" : item.status === "failed" ? " is-failed" : item.status === "cancelled" ? " is-stopped" : " is-complete"}${item.key === selectedStage ? " is-active" : ""}${
                  item.key === lastStageIndex && runVerdict?.verdict
                    ? runVerdict.verdict === "accepted"
                      ? " is-verdict-accepted"
                      : " is-verdict-changes"
                    : ""
                }`}
                aria-label={`${item.label}: ${item.agent}`}
                title={`${item.label} · ${item.agent}${item.pending ? " · nem indult el" : item.status === "cancelled" ? " · leállítva" : item.status === "failed" ? " · hibára futott" : ""}`}
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
                <span className="compact-answer-provider-mark pipeline-stage-provider-mark">
                  <ProviderMark
                    provider={normalizeAgentProvider(item.agent) ?? "codex"}
                  />
                </span>
              </button>
            ))}
          </span>
        </div>
      ) : undefined;
    const historicalRecipe = stage
      ? pipelineRecipes.find((recipe) => recipe.id === stage.recipeId)
      : undefined;
    const planReviewRecipe = historicalRecipe
      ? recipeReviewTarget(historicalRecipe) === "plan"
      : chain.map((item) => item.role).includes("plan_review");
    // A rejected verdict gets a direct, recipe-aware retry. PlanReview starts
    // from TERV; implementation review starts from KÓD with the accepted plan.
    const rejected = runVerdict?.verdict === "changes_requested";
    const atNewestVersion = selectedVersion === latestVersion;
    const canRerun =
      rejected &&
      atNewestVersion &&
      latestVersion < MAX_CHAIN_ITERATIONS &&
      !viewingActiveRun;
    // Keep the verdict visible both on the producing stage (the default view)
    // and on the review stage that issued it.
    const footerBelongsHere =
      selectedStage === outputStage?.stageIndex || selectedStage === lastStageIndex;
    const rawVerdictConclusion = runVerdict?.verdictSummary?.trim() ?? "";
    const hasUsefulVerdictConclusion =
      rawVerdictConclusion.length > 0 &&
      !/^(ELFOGAD|JAVÍTÁST KÉR|CHANGES REQUESTED)$/i.test(rawVerdictConclusion);
    const verdictConclusion = hasUsefulVerdictConclusion
      ? rawVerdictConclusion
      : runVerdict?.verdict === "accepted"
        ? planReviewRecipe
          ? "A terv megfelel."
          : "A megoldás megfelel."
        : "Javítás szükséges.";
    // A verdikt konklúziója közvetlenül a VERDIKT lépés alá kerül. A színe már
    // kimondja az állapotot, ezért nem ismételjük elé, hogy „a bíráló...".
    const acceptedFooter =
      runVerdict?.verdict === "accepted" && footerBelongsHere ? (
        <div className="pipeline-answer-next is-accepted">
          <span>{verdictConclusion}</span>
        </div>
      ) : undefined;
    const runFooter =
      rejected && atNewestVersion && footerBelongsHere ? (
        <div className="pipeline-answer-next">
          <span>{verdictConclusion}</span>
          {latestVersion < MAX_CHAIN_ITERATIONS && (
            <button
              type="button"
              disabled={!canRerun}
              title={
                  viewingActiveRun
                    ? "Előbb fejezze be a futó kérés."
                    : planReviewRecipe
                      ? "A tervet és a tervbírálatot futtatja újra, új tervverzióban."
                      : "A tervet megtartja, a kódolást és a bírálatot futtatja újra."
              }
              onClick={() =>
                setReviewRerunChoiceTarget((current) =>
                  current === chainKey ? null : chainKey,
                )
              }
            >
              {planReviewRecipe
                ? `Újra a TERV-től (v${latestVersion + 1})`
                : `Újra a KÓD-tól (v${latestVersion + 1})`}
            </button>
          )}
          {reviewRerunChoiceTarget === chainKey && (
            <div
              className="pipeline-rerun-options"
              role="group"
              aria-label="V2 komment beállítása"
            >
              <button
                type="button"
                onClick={() => activateReviewCommentMode(chainKey)}
              >
                Komment
              </button>
              <button
                type="button"
                onClick={() => {
                  setReviewRerunChoiceTarget(null);
                  void rerunChainFromReview(chainKey);
                }}
              >
                Nincs komment
              </button>
            </div>
          )}
        </div>
      ) : acceptedFooter;
    // Mennyi ideig futott a lánc: a szakaszok terveinek legkorábbi indulása és
    // legkésőbbi zárása. A fejléc órája ebből mér, így bármelyik fülön ugyanaz
    // a teljes futásidő áll — a szakasz saját ideje a LÉPÉSEK alján marad.
    const chainPlans = stage
      ? messages.flatMap((message, index) => {
          if (message.role !== "assistant" || !message.pipeline) return [];
          if (chainKeyOf(message.pipeline) !== chainKey) return [];
          const group = workGroupForMessage(message, index);
          const chainPlan = group
            ? planForWorkGroup(group, message.turnId)
            : message.turnId
              ? planHistory[message.turnId]
              : undefined;
          return chainPlan ? [chainPlan] : [];
        })
      : [];
    const chainStepCounts = stage
      ? messages.flatMap((message, index) => {
          if (message.role !== "assistant" || !message.pipeline) return [];
          if (chainKeyOf(message.pipeline) !== chainKey) return [];
          const group = workGroupForMessage(message, index);
          const chainPlan = group
            ? planForWorkGroup(group, message.turnId)
            : message.turnId
              ? planHistory[message.turnId]
              : undefined;
          const storedCount = (chainPlan?.steps ?? []).filter(
            (step) =>
              step.id !== "client-pre-plan" &&
              !step.id.startsWith("client-fallback"),
          ).length;
          const writtenPlanCount =
            message.pipeline.stageRole === "plan"
              ? numberedPlanSteps(message.text).length
              : 0;
          return [Math.max(storedCount, writtenPlanCount)];
        })
      : [];
    const chainStepSlotCount = Math.max(
      1,
      plan.steps.length,
      ...chainStepCounts,
    );
    const chainChangeSummary = stage
      ? [...messages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              message.pipeline &&
              chainKeyOf(message.pipeline) === chainKey &&
              Boolean(message.changeSummary?.length),
          )?.changeSummary
      : undefined;
    const selectedIterationTiming = pipelineChainTimingBounds(
      stage
        ? chain
            .filter((item) => item.iteration === selectedVersion)
            .map((item) => ({
              startedAt: item.startedAt,
              completedAt: item.completedAt,
            }))
        : [],
    );
    const chainStartedAt = selectedIterationTiming.startedAt;
    const chainCompletedAt = selectedIterationTiming.completedAt;
    const chainInterrupted = stage
      ? messages.some(
          (message) =>
            message.role === "assistant" &&
            message.pipeline &&
            chainKeyOf(message.pipeline) === chainKey &&
            iterationOf(message.pipeline) === selectedVersion &&
            (message.interrupted || hasInterruptedAnswerMarker(message.text)),
        )
      : Boolean(
          groupAnswer.interrupted ||
            hasInterruptedAnswerMarker(groupAnswer.text),
        );
    const chainOutcome: TurnProgressCardProps["runOutcome"] = chainInterrupted
      ? "stopped"
      : pipelineVerdictOutcome(
          stage ? runVerdict?.verdict : groupAnswer.pipeline?.verdict,
        );
    return (
      <TurnProgressCard
        key={entry.key}
        runPosition={stage ? "end" : undefined}
        runStartedAt={chainStartedAt}
        runCompletedAt={chainCompletedAt}
        provider={
          groupAnswer.provider ??
          normalizeAgentProvider(groupAnswer.pipeline?.stageAgent) ??
          normalizeAgentProvider(agentConversationStatus?.provider) ??
          selectedProvider
        }
        runTone={
          groupAnswer.pipeline?.verdict
            ? groupAnswer.pipeline.verdict === "accepted"
              ? "accepted"
              : "changes"
            : undefined
        }
        runOutcome={chainOutcome}
        runHeader={runHeader}
        runStageCount={runStages.length}
        runFooter={runFooter}
        runChangeSummary={chainChangeSummary}
        runStepSlotCount={chainStepSlotCount}
        plan={plan}
        activities={entry.group.activities}
        commentary={groupCommentary}
        status={isCurrentGroup ? codeStatus : "kész"}
        streaming={false}
        expanded={expanded}
        transport={null}
        watchdogMessage=""
        stageRole={groupAnswer.pipeline?.stageRole}
        projectPath={activeProjectPath}
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
  const liveTurnId = activePlan.turnId ?? activeTurnIdRef.current;
  const liveExpanded = liveWorkGroup
    ? expandedForWorkGroup(liveWorkGroup, true)
    : Object.prototype.hasOwnProperty.call(expandedWorkLogs, liveTurnKey)
      ? expandedWorkLogs[liveTurnKey]
      : (expandedWorkLogChoicesRef.current[liveTurnKey] ?? true);
  // A stage that has started but not yet streamed has no bubble of its own,
  // and the newest "live" row can then be a leftover from an earlier run --
  // which is how the panel came to show a verdict while the coder was working.
  // While a chain runs, only the running stage's own bubble counts.
  // A szakasz lezárult, de a következő még nem indult el: a buborék ilyenkor
  // már nem „live", és a panel néhány másodpercre kiürült — a LÉPÉSEK
  // visszaesett a „terv készítése" placeholderre, a RAW meg arra, hogy a terv
  // még nem kezdett íródni. A kész szöveg ugyanezé a szakaszé, csak máshol
  // van; a lyuk ideje alatt onnan olvasunk. A `phase` erre nem jó jel: a
  // `finished` csak a szakasz-záró munka (guard, másolás) UTÁN érkezik, a lyuk
  // meg pont az — a szakasz saját, lezárt szövege viszont már az első
  // pillanatában megvan.
  const liveStageTurnId = pipelineProgress
    ? `request:${pipelineProgress.requestId}`
    : "";
  const liveStreamingAnswer = pipelineProgress
    ? messages.find(
        (message) =>
          message.role === "assistant" &&
          message.live &&
          message.turnId === liveStageTurnId,
      ) ??
      // A lánc minden szakasza a futás külső élő buborékába streamel — az is
      // ennek a futásnak a szövege, ne legyen láthatatlan. Kivéve, amíg a
      // buborékban még az ELŐZŐ szakasz lezárt szövege áll: az új szakasz
      // indulásakor a REVIEW kártyáján így a KÓD válasza ült, és a lépések
      // helyett azon ragadt a nézet. Ami szóról szóra egyezik egy korábbi
      // szakasz eltárolt válaszával, az nem ennek a szakasznak a szövege.
      (() => {
        const outerBubble = messages.find(
          (message) =>
            message.role === "assistant" &&
            message.live &&
            message.id === viewedRun?.liveMessageId,
        );
        if (!outerBubble) return undefined;
        const stale =
          pipelineProgress.stageIndex > 0 &&
          Boolean(liveRunStagePrefix) &&
          messages.some(
            (message) =>
              message.role === "assistant" &&
              !message.live &&
              message.turnId?.startsWith(liveRunStagePrefix!) &&
              message.text.trim() === outerBubble.text.trim(),
          );
        return stale ? undefined : outerBubble;
      })()
    : undefined;
  const settledStageText = pipelineProgress
    ? ((pipelineProgress.role === "plan" ? viewedRun?.planText : undefined) ??
      messages.find(
        (message) =>
          message.role === "assistant" &&
          !message.live &&
          message.turnId === liveStageTurnId,
      )?.text ??
      // A külső buborék szövege csak a szakasz lejelentése után egyértelmű —
      // előtte még az előző szakaszé lehetne.
      (pipelineProgress.phase !== "started"
        ? messages.find(
            (message) =>
              message.role === "assistant" &&
              message.turnId === `request:${liveRunOuterRequestId}` &&
              !message.live,
          )?.text
        : undefined) ??
      // Utolsó mentsvár a szakaszok KÖZTI lyukra: a lezárt szakasz szövege
      // marad a képernyőn, amíg a következő el nem indul. Szigorúan csak a
      // `finished` fázisban — amint az új szakasz elindult (`started`), ez a
      // kártya már az övé, és az előző szakasz ideragadt válasza pontosan az
      // a bug volt, hogy a REVIEW alatt a KÓD szövege állt.
      (pipelineProgress.phase !== "started" && liveRunStagePrefix
        ? [...messages]
            .reverse()
            .find(
              (message) =>
                message.role === "assistant" &&
                !message.live &&
                Boolean(message.text.trim()) &&
                message.turnId?.startsWith(liveRunStagePrefix),
            )?.text
        : undefined))
    : undefined;
  // A szakasz „ül": a saját szövege lezárult, és már senki nem streamel.
  const liveStageSettled = Boolean(
    pipelineProgress && !liveStreamingAnswer && settledStageText?.trim(),
  );
  const liveAnswer = pipelineProgress
    ? liveStreamingAnswer ??
      (settledStageText?.trim()
        ? {
            role: "assistant" as const,
            text: settledStageText,
            time: "kész",
            live: false,
            final: true,
            turnId: liveStageTurnId,
          }
        : undefined)
    : [...messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.live);

  // The run owns the durable conversation id. During the first message (and
  // while an untitled thread is renamed) the tree-derived active id can lag
  // behind it by one render; using that lagging key would hide a correctly
  // queued LIVE file from the panel.
  const liveFilesConversationId =
    viewedRun?.ownerConversationId ?? activeConversationId;

  // A native Codex turn reports file changes as ordinary `item/started` /
  // `item/completed` work items. Those rows are enough for the FÁJLOK /
  // VÁLTOZÁSOK summary, but older app-server versions do not emit the
  // dedicated `item/fileWrite/delta` stream that Claude uses. Recover the
  // active stage's files from the work log as a second path to the LIVE panel;
  // this also covers a turn that was hydrated before the panel was mounted.
  useEffect(() => {
    if (
      !isTauri ||
      activeMode !== "coding" ||
      !viewingActiveRun ||
      !liveFilesConversationId
    )
      return;
    const activities =
      pipelineProgress && liveTurnId
        ? [
            ...codeActivity.filter((activity) => activity.turnId === liveTurnId),
            ...(liveWorkGroup?.activities ?? []),
          ]
        : (liveWorkGroup?.activities ?? []);
    if (activities.length === 0) return;
    const cwd = runProjectPathRef.current || activeProjectPath;
    for (const activity of activities) {
      if (activity.kind !== "file") continue;
      if (activity.status === "error") continue;
      const rawPath = activity.detail?.trim();
      if (!rawPath || !/\.[a-z0-9]{1,8}$/i.test(rawPath)) continue;
      const readOnly =
        /(?:^|[\\/._-])(read|inspect|view|open)(?:$|[\\/._-])/i.test(
          activity.eventType,
        ) || /(?:read|inspect|view|open)$/i.test(activity.eventType);
      if (
        readOnly &&
        activity.beforeCode === undefined &&
        activity.afterCode === undefined &&
        !activity.changeKind
      )
        continue;
      const source = activity.afterCode ?? activity.code ?? "";
      const patchLike = /^\s*(?:@@|diff --|\+\+\+\s|---\s)/.test(source);
      const hasWriteEvidence =
        Boolean(source.trim()) ||
        activity.beforeCode !== undefined ||
        activity.afterCode !== undefined ||
        Boolean(activity.changeKind) ||
        /(?:change|create|delete|remove|write|patch|edit)/i.test(
          activity.eventType,
        );
      if (!hasWriteEvidence) continue;
      const path = relativeChangePath(rawPath, cwd);
      const version = [
        activity.status,
        activity.code?.length ?? 0,
        activity.beforeCode?.length ?? 0,
        activity.afterCode?.length ?? 0,
      ].join(":");
      const key = `${liveFilesConversationId}\u0000${activity.id}\u0000${path}\u0000${version}`;
      if (liveFileBackfillKeysRef.current.has(key)) continue;
      liveFileBackfillKeysRef.current.add(key);
      const fallback = patchLike ? "" : source;
      const mode: LiveFileMode =
        activity.beforeCode !== undefined ||
        activity.afterCode !== undefined ||
        patchLike ||
        /(?:change|patch|edit)/i.test(activity.eventType)
          ? "edit"
          : "write";
      void invoke<string | null>("read_code_file", {
        cwd,
        path: rawPath,
      })
        .then((disk) => {
          const content = disk ?? fallback;
          if (!content) {
            liveFileBackfillKeysRef.current.delete(key);
            return;
          }
          queueLiveFile(liveFilesConversationId, {
            path,
            content,
            streaming: activity.status === "running",
            mode,
            highlight: wholeFileHighlight(content),
            sequence: activity.id,
          });
        })
        .catch(() => {
          if (fallback)
            queueLiveFile(liveFilesConversationId, {
              path,
              content: fallback,
              streaming: activity.status === "running",
              mode,
              highlight: wholeFileHighlight(fallback),
              sequence: activity.id,
            });
          else liveFileBackfillKeysRef.current.delete(key);
        });
    }
  }, [
    activeMode,
    activeProjectPath,
    codeActivity,
    isTauri,
    liveFilesConversationId,
    liveTurnId,
    liveWorkGroup,
    pipelineProgress,
    viewingActiveRun,
  ]);

  const activeUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const liveCompact = activeUserMessage
    ? !messageUsesDetailedTrace(activeUserMessage)
    : !showDetailedTrace;
  // Everything a running chain shows lives in one panel. Its phases are known
  // the moment it starts, so the strip is complete from the first second and
  // the marker simply follows the phase that is running.
  const livePipelineRecipe = viewedRun?.chain?.recipe ?? activePipelineRecipe;
  const liveRunStages = pipelineProgress
    ? (livePipelineRecipe?.stages.map((stage, index) => ({
        index,
        role: stage.role,
        provider: stage.provider,
      })) ??
      Array.from({ length: pipelineProgress.stageCount }, (_, index) => ({
        index,
        role: index === pipelineProgress.stageIndex ? pipelineProgress.role : "",
        provider:
          index === pipelineProgress.stageIndex
            ? pipelineProgress.provider
            : selectedProvider,
      })))
    : [];
  // A futó szakasz adatai — ugyanaz, amit a kártya is kap. Külön néven, mert a
  // „van-e már mit mutatni" döntés is ebből él.
  const liveStageActivities =
    pipelineProgress && liveTurnId
      ? codeActivity.filter((activity) => activity.turnId === liveTurnId)
      : (liveWorkGroup?.activities ?? []);
  const liveStageCommentary = liveWorkGroup
    ? commentaryForWorkGroup(
        liveWorkGroup,
        pipelineProgress && liveTurnId ? liveTurnId : undefined,
      )
    : commentaryEntries.filter((commentary) =>
        Boolean(liveTurnId && commentary.turnId === liveTurnId),
      );
  /**
   * Van-e már bármi, amit a panelek megmutathatnak. Amíg nincs, a kártya meg
   * sem jelenik: induláskor eddig két üres panel állt egymás mellett pörgő
   * ikonokkal, szöveg nélkül. Ilyenkor csak a fázissín látszik.
   */
  // Csak *szöveg* számít tartalomnak. Az aktivitások (szerszámhívások) nem:
  // élőben mérve már 300 ms-nál befutott az első, és a kártya ott állt üresen,
  // pörgő ikonokkal — pontosan az az állapot, amit el akartunk tüntetni. A
  // válasz szövege vagy egy narrációs sor viszont valódi látnivaló.
  const liveTurnHasContent =
    Boolean(liveAnswer?.text?.trim()) ||
    liveStageCommentary.some((entry) => entry.body?.trim());
  /**
   * A *mutatott* szakasz csak akkor lép a következőre, ha annak már van
   * tartalma — addig az előző szakasz paneljei maradnak a képernyőn. Enélkül a
   * váltás pillanatában a nézet átugrott egy üres kártyára.
   */
  const [liveRevealedStage, setLiveRevealedStage] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (!pipelineProgress) {
      setLiveRevealedStage(null);
      return;
    }
    if (!liveTurnHasContent) return;
    setLiveRevealedStage((current) =>
      current === pipelineProgress.stageIndex
        ? current
        : pipelineProgress.stageIndex,
    );
  }, [pipelineProgress?.stageIndex, pipelineProgress?.runId, liveTurnHasContent]);
  const liveShownStage = pipelineProgress
    ? (liveStageChoice ?? liveRevealedStage ?? pipelineProgress.stageIndex)
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
    if (
      pipelineProgress &&
      (index === 0 || index === pipelineProgress.stageIndex - 1)
    )
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
    <div className="pipeline-run-header is-live" data-run-id={pipelineProgress.runId}>
      <span
        className="pipeline-run-tabs"
        role="tablist"
        style={{ "--tab-count": liveRunStages.length } as CSSProperties}
      >
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
              className={`pipeline-run-tab${stage.index === liveShownStage ? " is-active" : ""}${done ? " is-complete" : running ? "" : " is-future"}${running ? " is-running" : ""}${stageSettled && pipelineProgress.phase === "failed" ? " is-failed" : ""}`}
              aria-label={`${STAGE_ROLE_LABELS[stage.role] ?? stage.role}: ${stage.provider}`}
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
              <span className="compact-answer-provider-mark pipeline-stage-provider-mark">
                <ProviderMark provider={stage.provider} />
              </span>
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
  const liveFinishedStageTurnId = `request:${liveRunOuterRequestId}-stage-${liveShownStage}`;
  const liveFinishedStagePanel =
    pipelineProgress && liveShownStage !== pipelineProgress.stageIndex ? (
      <TurnProgressCard
        runPosition="end"
        runHeader={liveRunHeader}
        runOutcome={
          liveAnswer?.interrupted ||
          hasInterruptedAnswerMarker(liveAnswer?.text ?? "")
            ? "stopped"
            : pipelineVerdictOutcome(liveAnswer?.pipeline?.verdict)
        }
        runStageCount={liveRunStages.length}
        runStepSlotCount={Math.max(
          activePlan.steps.length,
          numberedPlanSteps(viewedRun?.planText ?? "").length,
        )}
        runChangeSummary={liveAnswer?.changeSummary}
        stageRole={liveRunStages[liveShownStage]?.role || undefined}
        projectPath={activeProjectPath}
        liveFiles
        runStartedAt={viewedRun?.turnTiming?.startedAt}
        runCompletedAt={viewedRun?.turnTiming?.completedAt}
        provider={
          viewedRun?.chain?.recipe?.stages[liveShownStage]?.provider ??
          viewedRun?.provider ??
          selectedProvider
        }
        plan={
          planHistory[liveFinishedStageTurnId] ??
          (liveShownStage === 0
            ? planHistory[`request:${liveRunOuterRequestId}`]
            : undefined) ?? {
            turnId: liveFinishedStageTurnId,
            explanation: "",
            steps: [],
          }
        }
        activities={codeActivity.filter(
          (activity) =>
            activity.turnId === liveFinishedStageTurnId ||
            (liveShownStage === 0 &&
              activity.turnId === `request:${liveRunOuterRequestId}`),
        )}
        commentary={commentaryEntries.filter(
          (entry) =>
            entry.turnId === liveFinishedStageTurnId ||
            (liveShownStage === 0 &&
              entry.turnId === `request:${liveRunOuterRequestId}`),
        )}
        status="kész"
        streaming={false}
        expanded
        transport={null}
        watchdogMessage=""
        onToggle={() => {}}
        answer={(() => {
          const text =
            (liveRunStages[liveShownStage]?.role === "plan"
              ? viewedRun?.planText
              : undefined) ?? liveFinishedStageText(liveShownStage);
          return text.trim()
            ? {
                role: "assistant" as const,
                text,
                time: "kész",
                live: false,
                final: true,
                turnId: liveFinishedStageTurnId,
              }
            : undefined;
        })()}
        quoteAnchorPrefix={`live-stage:${liveFinishedStageTurnId}`}
        onQuoteJump={jumpToQuote}
      />
    ) : null;
  // A chain finishes a turn per stage, so between two stages the completed
  // request is still the active one and this panel used to unmount -- while the
  // settled stage cards stayed hidden, because the run that owns them is still
  // going. The result was the whole answer blinking out of existence for a few
  // seconds at every hand-off. A chain is one panel from its first second to
  // its last, so a stage boundary is not a reason to take it down.
  // Az élő kódnézet a képernyőn álló beszélgetésé — akkor is, ha a futás már
  // véget ért: a munka végén is jogos megnézni, mi került a fájlokba.
  const viewedLiveFiles =
    liveFilesByConversation[liveFilesConversationId ?? ""] ?? EMPTY_LIVE_FILES;
  const updateViewedLiveFiles = (
    change: (state: LiveFileState) => LiveFileState,
  ) => {
    const id = liveFilesConversationId ?? "";
    setLiveFilesByConversation((current) => ({
      ...current,
      [id]: change(current[id] ?? EMPTY_LIVE_FILES),
    }));
  };
  const liveCodePanel = (
    <LiveCodePanel
      state={viewedLiveFiles}
      open={liveCodeOpen}
      onToggle={() => setLiveCodeOpen((open) => !open)}
      onSelect={(path) =>
        updateViewedLiveFiles((state) => selectLiveFile(state, path))
      }
      onClose={(path) =>
        updateViewedLiveFiles((state) => closeLiveFile(state, path))
      }
      onFollow={() => updateViewedLiveFiles(followLiveFiles)}
      onReopen={() => updateViewedLiveFiles(reopenLiveFiles)}
    />
  );
  const liveTurnContent =
    activeMode === "coding" &&
    viewingActiveRun &&
    (!activeTurnHasCompleted || Boolean(pipelineProgress)) && (
      <div className="live-turn-anchor">
        {/* Amíg nincs mit mutatni, csak a fázissín áll itt — nem két üres
            panel pörgő ikonokkal. Ugyanez fázisváltáskor: a `liveShownStage`
            addig az előző szakaszon marad, amíg az újnak nincs tartalma, tehát
            ide csak a legelső fázis kezdete előtt jutunk el.
            Csak láncnál rejtünk: egyágenses futásnál nincs fázissín, ott a
            kártya elrejtése azt jelentené, hogy az Enter után semmi nem
            jelezné, hogy elindult a munka. */}
        {pipelineProgress && !liveTurnHasContent && !liveFinishedStagePanel ? (
          liveRunHeader
        ) : liveFinishedStagePanel ? (
          liveFinishedStagePanel
        ) : (
        <TurnProgressCard
          runPosition={pipelineProgress ? "end" : undefined}
          runHeader={liveRunHeader}
          runOutcome={
            liveAnswer?.interrupted ||
            hasInterruptedAnswerMarker(liveAnswer?.text ?? "")
              ? "stopped"
              : pipelineVerdictOutcome(liveAnswer?.pipeline?.verdict)
          }
          runStageCount={liveRunStages.length}
          runStepSlotCount={Math.max(
            activePlan.steps.length,
            numberedPlanSteps(viewedRun?.planText ?? "").length,
          )}
          stageRole={pipelineProgress?.role}
          projectPath={activeProjectPath}
          liveFiles
          runStartedAt={viewedRun?.turnTiming?.startedAt}
          runCompletedAt={viewedRun?.turnTiming?.completedAt}
          provider={
            pipelineProgress?.provider ??
            viewedRun?.provider ??
            selectedProvider
          }
          plan={activePlan}
          activities={liveStageActivities}
          commentary={liveStageCommentary}
          status={codeStatus}
          // A lezárt szakasz nem „ír" — a következő indulására vár. Amíg
          // streamelőnek mondtuk, a lépései félkésznek látszottak a váltás
          // néhány másodpercében.
          streaming={
            viewingActiveRun && !activeTurnHasCompleted && !liveStageSettled
          }
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
        {liveCodePanel}
      </div>
    );
  // A re-run draws itself inside the panel it belongs to; everything else
  // still streams below the conversation, where a new answer belongs.
  const hasLiveRerunSlot = timelineContent.some(
    (node) => node === LIVE_RERUN_SLOT,
  );
  // Csak akkor rejtjük el az alsó live panelt, ha a történetben tényleg
  // megtaláltuk és ki is tudjuk cserélni a v2 helyőrzőjét. Egy részben
  // visszatöltött vagy megszakított láncnál korábban a panel mindkét
  // helyről eltűnhetett.
  const rerunInPlace = Boolean(
    liveRunResume && pipelineProgress && hasLiveRerunSlot,
  );
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
      <div
        className="app-shell"
        aria-busy={projectOpening}
        onClickCapture={handleLocalLinkClickCapture}
      >
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
        <aside
          className={`sidebar panel-edge${activeMode === "general" ? " is-general" : ""}`}
        >
          <div className="sidebar-heading">
            <span>Projektek</span>
            <div className="sidebar-heading-actions">
              <div className="tree-sort-wrap">
                <button
                  type="button"
                  className="tree-sort-button"
                  onClick={() => setTreeSortMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={treeSortMenuOpen}
                  aria-label="Tree rendezése"
                  title={`Rendezés: ${treeSortMode === "modified" ? "módosítás szerint" : "idő szerint"}`}
                >
                  ↕
                </button>
                {treeSortMenuOpen && (
                  <div className="tree-sort-menu" role="menu">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={treeSortMode === "modified"}
                      className={treeSortMode === "modified" ? "is-selected" : ""}
                      onClick={() => {
                        setTreeSortMode("modified");
                        setTreeSortMenuOpen(false);
                      }}
                    >
                      Módosítás szerint
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={treeSortMode === "time"}
                      className={treeSortMode === "time" ? "is-selected" : ""}
                      onClick={() => {
                        setTreeSortMode("time");
                        setTreeSortMenuOpen(false);
                      }}
                    >
                      Idő szerint
                    </button>
                  </div>
                )}
              </div>
              {activeMode === "general" ? (
              <button
                type="button"
                className="new-button"
                onClick={newGeneralConversation}
                aria-label="Új beszélgetés"
                title="Új beszélgetés"
              >
                +
              </button>
            ) : (
              <div className="new-project-wrap">
              <button
                type="button"
                className="new-button"
                onClick={() => setNewProjectMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={newProjectMenuOpen}
                title="Projekt hozzáadása"
              >
                +
              </button>
              {newProjectMenuOpen && (
                <div className="new-project-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewProjectMenuOpen(false);
                      void addProject();
                    }}
                  >
                    Új projekt
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setNewProjectMenuOpen(false);
                      void addExistingProject();
                    }}
                  >
                    Meglévő projekt
                  </button>
                </div>
              )}
              </div>
            )}
            </div>
          </div>
          <div className="mode-switch" role="tablist" aria-label="Alkalmazasi mod">
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "coding"}
              className={activeMode === "coding" ? "is-active" : ""}
              onClick={() => selectAppMode("coding")}
            >
              CODING
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "general"}
              className={activeMode === "general" ? "is-active" : ""}
              onClick={() => selectAppMode("general")}
            >
              GENERAL
            </button>
          </div>
          <div className="project-list">
            {historyHydrating && (
              <div className="project-list-loading" role="status">
                Helyi előzmények betöltése…
              </div>
            )}
            {sortedProjects.map((project) => {
              const isOpen = Boolean(openProjects[project.path]);
              return (
                <section
                  className={`project-group${isOpen ? " is-open" : ""}`}
                  data-project={project.name}
                  key={project.path}
                >
                  <div className="project-row-wrap">
                    <button
                      className="project-row"
                      onClick={() => {
                        selectProject(project);
                        setOpenProjects((current) => ({
                          ...current,
                          [project.path]: !isOpen,
                        }));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Delete" || !event.shiftKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        permanentlyDeleteProject(project);
                      }}
                      aria-expanded={isOpen}
                      aria-keyshortcuts="Shift+Delete"
                      title={`${project.path}\nShift+Delete: végleges törlés`}
                    >
                      <span className="chevron">{isOpen ? "⌄" : "›"}</span>
                      <span className="folder-icon">◫</span>
                      <span className="project-name">{project.name}</span>
                      {projectIsThinking(project) && !isOpen && (
                        <ThinkingDots label="Ebben a projektben épp fut egy válasz vagy mentés" />
                      )}
                      <span className="project-count">
                        {project.threads.length}
                      </span>
                    </button>
                    <div className="overflow-menu-wrap">
                      <button
                        type="button"
                        className="overflow-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenMenu(
                            openMenu?.kind === "project" &&
                              openMenu.key === project.id
                              ? null
                              : { kind: "project", key: project.id },
                          );
                        }}
                        aria-haspopup="menu"
                        aria-expanded={
                          openMenu?.kind === "project" &&
                          openMenu.key === project.id
                        }
                        title="Projekt menüje"
                      >
                        ⋮
                      </button>
                      {openMenu?.kind === "project" &&
                        openMenu.key === project.id && (
                          <div className="overflow-menu" role="menu">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenu(null);
                                newConversationForProject(project);
                              }}
                            >
                              Új beszélgetés
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenu(null);
                                renameProject(project);
                              }}
                            >
                              Átnevezés
                            </button>
                            <button
                              type="button"
                              className="danger-action"
                              onClick={() => deleteProject(project)}
                            >
                              Törlés
                            </button>
                            <button
                              type="button"
                              className="danger-action"
                              onClick={() => permanentlyDeleteProject(project)}
                              title="Gyorsbillentyű: Shift+Delete"
                            >
                              Végleges törlés…
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                  <div className="conversation-list">
                    {project.threads.map((thread) => {
                      const menuKey = `${project.id}::${thread}`;
                      return (
                        <div className="conversation-row-wrap" key={thread}>
                          <button
                            className={`conversation-row${thread === activeThread && project.name === activeProject ? " is-active" : ""}`}
                            onClick={() => selectThread(project, thread)}
                            onKeyDown={(event) => {
                              if (event.key !== "Delete" || !event.shiftKey)
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              permanentlyDeleteThread(project, thread);
                            }}
                            aria-keyshortcuts="Shift+Delete"
                            title={`${thread}\nShift+Delete: végleges törlés`}
                          >
                            <TreeRunMark
                              state={conversationRunState(
                                `${project.path}/${thread}`,
                              )}
                              idleClassName="conversation-dot"
                            />
                            <span>{thread}</span>
                          </button>
                          <div className="overflow-menu-wrap">
                            <button
                              type="button"
                              className="overflow-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpenMenu(
                                  openMenu?.kind === "thread" &&
                                    openMenu.key === menuKey
                                    ? null
                                    : { kind: "thread", key: menuKey },
                                );
                              }}
                              aria-haspopup="menu"
                              aria-expanded={
                                openMenu?.kind === "thread" &&
                                openMenu.key === menuKey
                              }
                              title="Beszélgetés menüje"
                            >
                              ⋮
                            </button>
                            {openMenu?.kind === "thread" &&
                              openMenu.key === menuKey && (
                                <div className="overflow-menu" role="menu">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenu(null);
                                      renameThread(project, thread);
                                    }}
                                  >
                                    Átnevezés
                                  </button>
                                  <button
                                    type="button"
                                    className="danger-action"
                                    onClick={() =>
                                      deleteThread(project, thread)
                                    }
                                  >
                                    Törlés
                                  </button>
                                  <button
                                    type="button"
                                    className="danger-action"
                                    onClick={() =>
                                      permanentlyDeleteThread(project, thread)
                                    }
                                    title="Gyorsbillentyű: Shift+Delete"
                                  >
                                    Végleges törlés…
                                  </button>
                                </div>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          <div className="general-history" aria-label="General beszélgetések">
            {generalConversations.length === 0 ? (
              <div className="general-history-empty">
                A korábbi GENERAL beszélgetések itt jelennek meg.
              </div>
            ) : (
              generalConversations.map(({ conversation }) => {
                const id = conversation.id ?? "";
                return (
                  <div className="general-history-row-wrap" key={id}>
                    <button
                      type="button"
                      className={`general-history-row${id === activeGeneralConversationId ? " is-active" : ""}`}
                      onClick={() => selectGeneralConversation(id)}
                      onKeyDown={(event) => {
                        if (event.key !== "Delete" || !event.shiftKey) return;
                        event.preventDefault();
                        event.stopPropagation();
                        permanentlyDeleteGeneralConversation(conversation);
                      }}
                      aria-keyshortcuts="Shift+Delete"
                      title={`${conversation.title}\nShift+Delete: végleges törlés`}
                    >
                      <TreeRunMark
                        state={conversationRunState(
                          generalConversationCacheKey(id),
                        )}
                        idleClassName="general-history-dot"
                      />
                      <span>{conversation.title}</span>
                    </button>
                    <div className="overflow-menu-wrap">
                      <button
                        type="button"
                        className="overflow-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenMenu(
                            openMenu?.kind === "general" &&
                              openMenu.key === id
                              ? null
                              : { kind: "general", key: id },
                          );
                        }}
                        aria-haspopup="menu"
                        aria-expanded={
                          openMenu?.kind === "general" && openMenu.key === id
                        }
                        title="Beszélgetés menüje"
                      >
                        ⋮
                      </button>
                      {openMenu?.kind === "general" &&
                        openMenu.key === id && (
                          <div className="overflow-menu" role="menu">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenu(null);
                                renameGeneralConversation(conversation);
                              }}
                            >
                              Átnevezés
                            </button>
                            <button
                              type="button"
                              className="danger-action"
                              onClick={() => deleteGeneralConversation(conversation)}
                            >
                              Törlés
                            </button>
                            <button
                              type="button"
                              className="danger-action"
                              onClick={() =>
                                permanentlyDeleteGeneralConversation(
                                  conversation,
                                )
                              }
                              title="Gyorsbillentyű: Shift+Delete"
                            >
                              Végleges törlés…
                            </button>
                          </div>
                        )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="sidebar-footer">
            <button
              type="button"
              className={`sync-health${syncWriteEnabled ? " is-ready" : " is-quarantine"}`}
              onClick={() => isTauri && setSyncHealthOpen((open) => !open)}
              aria-expanded={isTauri ? syncHealthOpen : undefined}
              aria-controls={isTauri ? "sync-health-panel" : undefined}
              title="Részletes Sync Health megnyitása"
            >
              <span className="status-dot" />
              <span>Sync · {syncStatus}</span>
              <span className="sync-health-chevron">
                {isTauri ? (syncHealthOpen ? "⌃" : "⌄") : ""}
              </span>
            </button>
            {syncHealthOpen && (
              <div
                id="sync-health-panel"
                className="sync-health-popover"
                role="dialog"
                aria-label="Sync Health"
              >
                <div className="popover-heading">
                  <span>Sync Health</span>
                  <span className="popover-hint">
                    {syncHealth
                      ? syncHealthStatusLabel(syncHealth.status)
                      : "nincs adat"}
                  </span>
                </div>
                {syncHealth ? (
                  <>
                    <div className="sync-health-grid">
                      <span>Utolsó ellenőrzés</span>
                      <strong>
                        {formatSyncHealthTime(syncHealth.checkedAt)}
                      </strong>
                      <span>Utolsó import</span>
                      <strong>
                        {formatSyncHealthTime(syncHealth.lastImportAt)}
                      </strong>
                      <span>Journal</span>
                      <strong>
                        {syncHealth.scannedEvents} fájl ·{" "}
                        {syncHealth.acceptedEvents} valid
                      </strong>
                      <span>Lokális SQLite</span>
                      <strong>{syncHealth.storedEvents} event</strong>
                    </div>
                    <div
                      className="sync-health-path"
                      title={syncHealth.journalPath}
                    >
                      Journal: {syncHealth.journalPath}
                    </div>
                    <div
                      className="sync-health-path"
                      title={syncHealth.quarantinePath}
                    >
                      Quarantine: {syncHealth.quarantinePath}
                    </div>
                    {syncHealth.blockedDevices.length > 0 && (
                      <div className="sync-health-warning">
                        <strong>Blokkolt eszközök</strong>
                        <ul>
                          {syncHealth.blockedDevices.map((device) => (
                            <li key={device}>{device}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {syncHealth.warnings.length > 0 && (
                      <div className="sync-health-warning">
                        <strong>Figyelmeztetések</strong>
                        <ul>
                          {syncHealth.warnings
                            .slice(0, 3)
                            .map((warning, index) => (
                              <li key={`${warning}-${index}`}>{warning}</li>
                            ))}
                        </ul>
                        {syncHealth.warnings.length > 3 && (
                          <small>
                            +{syncHealth.warnings.length - 3} további
                          </small>
                        )}
                      </div>
                    )}
                    {recoverableTombstones.length > 0 && (
                      <section
                        className="sync-recovery"
                        aria-label="Recovery Center"
                      >
                        <div className="sync-recovery-heading">
                          <strong>Recovery Center</strong>
                          <span>{recoverableTombstones.length}</span>
                        </div>
                        <div className="sync-recovery-list">
                          {[...recoverableTombstones]
                            .sort(
                              (left, right) =>
                                Date.parse(right.archivedAt) -
                                Date.parse(left.archivedAt),
                            )
                            .slice(0, 8)
                            .map((tombstone) => {
                              const label =
                                tombstone.title ??
                                tombstone.relativePath ??
                                tombstone.entityId;
                              const context =
                                syncTombstoneProjectContext(tombstone);
                              const itemBusyKey = `${tombstone.entityType}:${tombstone.entityId}`;
                              const isThisRestoreBusy =
                                restoreBusyKey === itemBusyKey;
                              return (
                                <div
                                  className="sync-recovery-item"
                                  key={`${tombstone.entityType}:${tombstone.entityId}`}
                                >
                                  <div className="sync-recovery-main">
                                    <span className="sync-recovery-type">
                                      {syncTombstoneTypeLabel(
                                        tombstone.entityType,
                                      )}
                                    </span>
                                    <strong title={label}>{label}</strong>
                                    <small>
                                      {context ? `${context} · ` : ""}
                                      {formatSyncHealthTime(
                                        tombstone.archivedAt,
                                      )}
                                    </small>
                                  </div>
                                  <button
                                    type="button"
                                    className="sync-recovery-restore"
                                    onClick={() => restoreTombstone(tombstone)}
                                    disabled={
                                      !syncWriteEnabled ||
                                      restoreBusyKey !== null
                                    }
                                    title={
                                      isThisRestoreBusy
                                        ? "A visszaállítás folyamatban van"
                                        : syncWriteEnabled
                                          ? "Archivált entitás visszaállítása"
                                          : "A journal jelenleg csak olvasható"
                                    }
                                  >
                                    {isThisRestoreBusy
                                      ? "Visszaállítás…"
                                      : "Visszaállítás"}
                                  </button>
                                </div>
                              );
                            })}
                        </div>
                        {recoverableTombstones.length > 8 && (
                          <small className="sync-recovery-more">
                            +{recoverableTombstones.length - 8} további archivált elem
                          </small>
                        )}
                      </section>
                    )}
                    <div className="sync-health-recovery">
                      {syncHealth.recoveryAction}
                    </div>
                    <div className="sync-health-actions">
                      <button
                        type="button"
                        className="footer-action"
                        onClick={refreshSync}
                      >
                        <span>↻</span> Újraellenőrzés
                      </button>
                      <button
                        type="button"
                        className="footer-action"
                        onClick={() => setSyncHealthOpen(false)}
                      >
                        <span>×</span> Bezárás
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="sync-health-empty">
                    A v2 sync health még nem érkezett meg.
                  </div>
                )}
              </div>
            )}
            <button
              className="footer-action"
              onClick={() => {
                if (settingsOpen) {
                  setReadingSettingsOpen(false);
                }
                setSettingsOpen((open) => !open);
              }}
              aria-expanded={settingsOpen}
            >
              <span>⚙</span> Beállítások
            </button>
            {settingsOpen && (
              <div className="settings-popover sidebar-settings-popover">
                <button
                  type="button"
                  className="settings-option"
                  aria-expanded={readingSettingsOpen}
                  onClick={() => setReadingSettingsOpen((open) => !open)}
                >
                  <span>
                    <strong>Megjelenítés</strong>
                  </span>
                  <span aria-hidden="true">
                    {readingSettingsOpen ? "⌃" : "⌄"}
                  </span>
                </button>
                {readingSettingsOpen && (
                  <div className="settings-subpanel">
                    <label className="range-row">
                      <span>Betűméret</span>
                      <output>{fontSize}</output>
                      <input
                        type="range"
                        min="8"
                        max="17"
                        value={parseInt(fontSize, 10)}
                        onChange={(event) =>
                          setFontSize(`${event.target.value}px`)
                        }
                      />
                    </label>
                    <label className="range-row">
                      <span>Sorköz</span>
                      <output>{lineHeight}</output>
                      <input
                        type="range"
                        min="100"
                        max="180"
                        value={Math.round(parseFloat(lineHeight) * 100)}
                        onChange={(event) =>
                          setLineHeight(
                            (Number(event.target.value) / 100).toFixed(2),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="reset-button"
                      onClick={() => {
                        setFontSize("10px");
                        setLineHeight("1.00");
                        notify("Olvasási beállítások visszaállítva");
                      }}
                    >
                      Alapértékek visszaállítása
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="settings-option"
                  disabled={!isTauri}
                  aria-expanded={providerSettingsOpen}
                  onClick={() => {
                    const opening = !providerSettingsOpen;
                    setProviderSettingsOpen(opening);
                    if (opening) void refreshProviderAuthStatuses();
                  }}
                >
                  <span>
                    <strong>AI providerek</strong>
                    <span className="settings-option-hint">
                      Kimi és DeepSeek API-kulcsok
                    </span>
                  </span>
                  <span aria-hidden="true">
                    {providerSettingsOpen ? "⌃" : "⌄"}
                  </span>
                </button>
                {providerSettingsOpen && (
                  <div className="settings-subpanel provider-settings-panel">
                    <p className="provider-settings-intro">
                      A kulcsok a Windows Credential Managerbe kerülnek. A Min
                      nem vásárol kreditet és nem tölt fel egyenleget.
                    </p>
                    {PROVIDER_CREDENTIALS.map((credential) => {
                      const status = providerAuthStatuses[credential.key];
                      const result = providerTestResults[credential.key];
                      const busy = providerAuthBusy?.endsWith(credential.key) ?? false;
                      return (
                        <section
                          className="provider-credential-card"
                          key={credential.key}
                        >
                          <div className="provider-credential-heading">
                            <strong>{credential.label}</strong>
                            <span
                              className={status?.configured ? "is-configured" : ""}
                            >
                              {status?.configured
                                ? status.preview || "Beállítva"
                                : "Nincs kulcs"}
                            </span>
                          </div>
                          <p>{credential.hint}</p>
                          <label className="provider-key-field">
                            <span>API-kulcs</span>
                            <input
                              type="password"
                              value={providerKeyDrafts[credential.key] ?? ""}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={
                                status?.configured
                                  ? "Új kulcs megadásával cserélhető"
                                  : "Kulcs beillesztése"
                              }
                              disabled={busy}
                              onChange={(event) =>
                                setProviderKeyDrafts((current) => ({
                                  ...current,
                                  [credential.key]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <div className="provider-settings-actions">
                            <button
                              type="button"
                              className="settings-compact-button"
                              disabled={
                                busy ||
                                !(providerKeyDrafts[credential.key]?.trim())
                              }
                              onClick={() => void saveProviderKey(credential)}
                            >
                              Mentés
                            </button>
                            <button
                              type="button"
                              className="settings-compact-button"
                              disabled={busy || !status?.configured}
                              title="Egy rövid, valós és esetleg díjköteles API-kérést küld."
                              onClick={() => void testProviderConnection(credential)}
                            >
                              Teszt
                            </button>
                            <button
                              type="button"
                              className="settings-compact-button danger"
                              disabled={busy || !status?.configured}
                              onClick={() => void deleteProviderKey(credential)}
                            >
                              Törlés
                            </button>
                          </div>
                          {result && (
                            <div
                              className={`provider-test-result ${
                                result.success ? "is-success" : "is-error"
                              }`}
                              role="status"
                            >
                              <strong>
                                {result.success ? "Kapcsolat rendben" : "Kapcsolati hiba"}
                              </strong>
                              <span>
                                {result.success
                                  ? result.text || `${result.model} válaszolt.`
                                  : result.error || "Ismeretlen hiba"}
                              </span>
                            </div>
                          )}
                        </section>
                      );
                    })}
                    <p className="provider-settings-footnote">
                      A Teszt gomb egyetlen rövid, valós API-hívást végezhet, ezért
                      minimális szolgáltatói költsége lehet. Automatikusan sosem fut.
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  className="settings-option"
                  disabled={!isTauri}
                  onClick={() => {
                    if (isTauri) {
                      void changeProjectsRoot();
                    }
                  }}
                >
                  <span>
                    <strong>Mappa</strong>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </div>
            )}
          </div>
        </aside>

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
            {/* A KÓD panel csak írás közben él. Korábban a futás után is itt
                maradt, a stream legalján — így egy ezer üzenettel korábbi
                válaszhoz tartozó panel a beszélgetés legaljára ült. A megírt
                fájlok a FÁJLOK / VÁLTOZÁSOK hasábban a saját kártyájukon
                maradnak, tehát semmi nem vész el. */}
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
            {activeFollowUps.length > 0 && (
              <div className="follow-up-queue" role="region" aria-label="Következő üzenetek">
                <div className="follow-up-queue-title">
                  KÖVETKEZŐ ÜZENETEK · {activeFollowUps.length}
                </div>
                {activeFollowUps.map((followUp, index) => (
                  <div className="follow-up-queue-row" key={followUp.id}>
                    <span className="follow-up-queue-index">{index + 1}.</span>
                    <span className="follow-up-queue-body" title={followUp.body}>
                      {followUp.body || "Képes üzenet"}
                    </span>
                    {!viewingActiveRun && (
                      <button type="button" onClick={() => void editFollowUp(followUp, true)}>
                        Küldés
                      </button>
                    )}
                    <button type="button" onClick={() => void editFollowUp(followUp)}>
                      Szerkeszt
                    </button>
                    <button
                      type="button"
                      aria-label="Feljebb"
                      disabled={index === 0}
                      onClick={() => void moveFollowUp(followUp.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Lejjebb"
                      disabled={index === activeFollowUps.length - 1}
                      onClick={() => void moveFollowUp(followUp.id, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label="Törlés"
                      onClick={() => void deleteFollowUp(followUp.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {activeStageInputs.length > 0 && (
              <div className="runtime-input-status" aria-live="polite">
                {activeStageInputs.map((input) => (
                  <div className="runtime-input-row" key={input.inputId}>
                    <span>Következő fázisra vár…</span>
                    <span>{input.text}</span>
                  </div>
                ))}
              </div>
            )}
            {activeRuntimeInputs.some(
              (input) => input.delivery.status === "sending" || input.delivery.status === "failed",
            ) && (
              <div className="runtime-input-status" aria-live="polite">
                {activeRuntimeInputs
                  .filter(
                    (input) =>
                      input.delivery.status === "sending" ||
                      input.delivery.status === "failed",
                  )
                  .map((input) => (
                    <div
                      key={input.payload.inputId}
                      className={`runtime-input-row is-${input.delivery.status}`}
                    >
                      <span>{input.delivery.status === "sending" ? "Küldés a futó AI-nak…" : "A terelés nem ment át"}</span>
                      <span>{input.payload.text}</span>
                    </div>
                  ))}
              </div>
            )}
            <div className="composer-shell">
              <div
                className={`composer-controls${!showDetailedTrace ? " is-simple" : ""}${composerControlFlip ? ` is-flip-${composerControlFlip.phase}` : ""}`}
                id="composer-multi-ai-settings"
              >
                {showDetailedTrace && activePipelineRecipe && (
                  <div className="composer-stage-grid" aria-label="Lánc beállítása">
                    {composerPlanStage &&
                      renderComposerStageRow(
                        composerPlanStage,
                        composerPlanStageIndex,
                      )}
                    {composerCodeStage
                      ? renderComposerStageRow(
                          composerCodeStage,
                          composerCodeStageIndex,
                        )
                      : (
                        <div className="composer-stage-row composer-code-toggle-row">
                          <span className="composer-stage-role">
                            <label
                              className="composer-stage-toggle"
                              title="KÓD bekapcsolása — TERV → KÓD → REVIEW"
                            >
                              <input
                                type="checkbox"
                                checked={false}
                                onChange={(event) =>
                                  setCodingPipelineEnabled(
                                    event.currentTarget.checked,
                                  )
                                }
                                aria-label="KÓD szakasz bekapcsolása"
                              />
                              <span>KÓD</span>
                            </label>
                          </span>
                          <span
                            className="composer-stage-slider-placeholder"
                            aria-hidden="true"
                          />
                        </div>
                      )}
                    {composerReviewStage &&
                      renderComposerStageRow(
                        composerReviewStage,
                        composerReviewStageIndex,
                      )}
                  </div>
                )}
                {!showDetailedTrace && (
                  <div className="composer-simple-controls" aria-label="Modell és reasoning beállítása">
                    <EffortSlider
                      efforts={supportedEfforts}
                      activeIndex={activeEffortIndex}
                      activeLabel={activeEffortLabel}
                      onSelect={selectEffortIndex}
                      provider={selectedProvider}
                      modelId={selectedModel ?? activeModel.id}
                      models={PIPELINE_MODELS[selectedProvider]}
                      onCycleProvider={cycleSelectedProvider}
                      onSelectModel={(model) => selectModel(model, false)}
                      controlLabel="EGY AI"
                    />
                  </div>
                )}
                {/* A chain that is waiting on the user looks identical to one
                    that is thinking, and that cost a whole run: the stage sat
                    on an approval nobody knew about until it timed out. Only
                    that warning earns a line here — the roster itself already
                    reads from the stage rows above. */}
                {pipelineProgress &&
                  (pendingClaudeApproval || pendingClaudeQuestion) && (
                    <div className="composer-pipeline-progress" role="status">
                      {STAGE_ROLE_LABELS[pipelineProgress.role] ??
                        pipelineProgress.role}
                      <strong className="composer-pipeline-waiting"> · rád vár</strong>
                    </div>
                  )}
              </div>
            <div
              className={`composer${reviewCommentTarget ? " is-review-comment" : ""}${activeMode !== "general" && activePipelineRecipe ? " has-multi-ai-toggle" : ""}${showDetailedTrace ? " is-multi-ai-open" : ""}`}
            >
              {activeMode !== "general" && activePipelineRecipe && (
                <button
                  type="button"
                  className="composer-multi-ai-toggle"
                  aria-expanded={showDetailedTrace}
                  aria-controls="composer-multi-ai-settings"
                  aria-label={
                    showDetailedTrace
                      ? "Részletes MULTI-AI beállítások bezárása"
                      : "Részletes MULTI-AI beállítások megnyitása"
                  }
                  title={
                    showDetailedTrace
                      ? "Részletes MULTI-AI bezárása"
                      : "Részletes MULTI-AI megnyitása"
                  }
                  onClick={() => {
                    if (composerControlFlip) return;
                    setModelMenuOpen(false);
                    setComposerControlFlip({
                      phase: "out",
                      targetDetailed: !showDetailedTrace,
                    });
                  }}
                >
                  <svg aria-hidden="true" viewBox="0 0 14 14">
                    <path d="M2 4h9m-2.5-2.5L11 4 8.5 6.5M12 10H3m2.5 2.5L3 10l2.5-2.5" />
                  </svg>
                </button>
              )}
              {reviewCommentTarget && (
                <div className="composer-review-comment-banner">
                  <span>REVIEW KOMMENT</span>
                  <button
                    type="button"
                    onClick={cancelReviewCommentMode}
                    aria-label="REVIEW komment mód bezárása"
                  >
                    Mégse
                  </button>
                </div>
              )}
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
                placeholder={
                  reviewCommentTarget
                    ? "Írd be a kommentet a v2 újrafuttatásához…"
                    : viewingActiveRun && runInputMode === "steer" && activeRunInputTarget
                      ? "Írj a futó AI-nak…"
                      : viewingActiveRun && runInputMode === "stage_next"
                        ? "Írj a következő pipeline-fázisnak…"
                      : viewingActiveRun
                        ? "Írd meg a következő üzenetet…"
                    : "Írj egy üzenetet, vagy illessz be egy screenshotot…"
                }
                aria-label={
                  reviewCommentTarget
                    ? "REVIEW komment a v2 újrafuttatásához"
                    : "Üzenet"
                }
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
                      title={
                        composerSupportsImages
                          ? "Kép megnyitása"
                          : `${PROVIDER_LABELS[composerImageProvider]} ezen az útvonalon nem fogad képet`
                      }
                      aria-label="Kép megnyitása és csatolása"
                      disabled={
                        imagesPreparing ||
                        pendingImages.length >= MAX_IMAGE_ATTACHMENTS ||
                        !composerSupportsImages
                      }
                      onClick={() => imageInputRef.current?.click()}
                    >
                      ＋
                    </button>
                  )}
                  {viewingActiveRun && (
                    <button
                      type="button"
                      className={`run-input-intent is-${runInputMode}`}
                      aria-label={
                        runInputMode === "follow_up"
                          ? "Küldés a jelenlegi válasz után"
                          : runInputMode === "stage_next"
                            ? "Terelés küldése a következő fázisnak"
                            : "Terelés küldése a most dolgozó AI-nak"
                      }
                      title="Kattintással váltás: most dolgozó AI / válasz után"
                      onClick={() =>
                        setRunInputMode((current) =>
                          current === "follow_up"
                            ? activeRunInputTarget
                              ? "steer"
                              : pipelineStageQueueAvailable
                                ? "stage_next"
                                : "follow_up"
                            : "follow_up",
                        )
                      }
                    >
                      <span aria-hidden="true">
                        {runInputMode === "follow_up" ? "↳" : "⇢"}
                      </span>
                      <span>
                        {runInputMode === "follow_up"
                          ? "UTÁNA"
                          : runInputMode === "stage_next"
                            ? "KÖV. FÁZIS"
                            : "MOST"}
                      </span>
                    </button>
                  )}
                </div>
                <div className="composer-primary-actions">
                  <button
                    type="submit"
                    className="send-button"
                    aria-label={
                      reviewCommentTarget
                        ? "Komment küldése"
                        : viewingActiveRun &&
                            (runInputMode === "steer" || runInputMode === "stage_next")
                          ? "Terelés küldése a futó AI-nak"
                          : "Üzenet küldése"
                    }
                    disabled={imagesPreparing}
                  >
                    {viewingActiveRun &&
                    (runInputMode === "steer" || runInputMode === "stage_next")
                      ? "⇢"
                      : "↑"}
                  </button>
                  {viewingActiveRun && !activeTurnHasCompleted && (
                    <button
                      type="button"
                      className="stop-button"
                      aria-label="Gondolkodás leállítása"
                      title="Gondolkodás leállítása"
                      disabled={isCancelling}
                      onClick={() => void stopGeneration()}
                    >
                      ■
                    </button>
                  )}
                </div>
              </div>
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
        <div
          className="app-dialog-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAppDialog(null);
          }}
        >
          <form
            className={`app-dialog${appDialog.kind === "confirm" && appDialog.danger ? " is-danger" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              submitAppDialog();
            }}
          >
            <div className="app-dialog-header">
              <div>
                <span className="approval-eyebrow">Min</span>
                <h2 id="app-dialog-title">{appDialog.title}</h2>
              </div>
              <button
                type="button"
                className="app-dialog-close"
                onClick={() => setAppDialog(null)}
                aria-label="Ablak bezárása"
              >
                ×
              </button>
            </div>
            {appDialog.kind === "input" ? (
              <label className="app-dialog-field">
                <span>{appDialog.label}</span>
                <input
                  autoFocus
                  value={appDialog.value}
                  onChange={(event) =>
                    setAppDialog((current) =>
                      current?.kind === "input"
                        ? { ...current, value: event.target.value }
                        : current,
                    )
                  }
                />
              </label>
            ) : (
              <p className="app-dialog-message">{appDialog.message}</p>
            )}
            <div className="app-dialog-actions">
              <button
                type="button"
                className="app-dialog-cancel"
                onClick={() => setAppDialog(null)}
              >
                Mégse
              </button>
              <button type="submit" className="app-dialog-confirm">
                {appDialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}
      {pendingClaudeApproval && (
        <div className="agent-interaction-overlay" role="presentation">
          <section className="agent-interaction-card" role="dialog" aria-modal="true" aria-labelledby="claude-approval-title">
            <span className="approval-eyebrow">CLAUDE JÓVÁHAGYÁS</span>
            {/* A cím, a leírás és az indoklás az ügynöktől jön: egy elterelt
                modell egy törlést is nevezhet „a README beolvasásának". Ezért
                elsőként a tényleges eszköz és a paraméterei állnak — arról szól
                a döntés —, a modell szövege pedig alattuk, jelölve, hogy az
                nem ellenőrzött állítás. */}
            <h2 id="claude-approval-title">
              {pendingClaudeApproval.toolName} futtatása
            </h2>
            <pre className="agent-interaction-preview">
              {JSON.stringify(pendingClaudeApproval.input, null, 2)}
            </pre>
            {(pendingClaudeApproval.title ||
              pendingClaudeApproval.description ||
              pendingClaudeApproval.reason) && (
              <div className="agent-interaction-claim">
                <span className="agent-interaction-claim-label">
                  Az ügynök indoklása
                </span>
                {pendingClaudeApproval.title && (
                  <p>{pendingClaudeApproval.title}</p>
                )}
                {pendingClaudeApproval.description && (
                  <p>{pendingClaudeApproval.description}</p>
                )}
                {pendingClaudeApproval.reason && (
                  <p className="agent-interaction-reason">
                    {pendingClaudeApproval.reason}
                  </p>
                )}
              </div>
            )}
            <div className="agent-interaction-actions">
              <button type="button" onClick={() => void respondClaudeApproval("decline", "A felhasználó elutasította a műveletet.")}>Tiltás</button>
              {/* The grant outlives the turn now, so the label says what it
                  actually does: it is remembered for this project until the
                  approvals file is cleared. */}
              <button type="button" onClick={() => void respondClaudeApproval("acceptForSession")}>Engedélyezés ebben a projektben</button>
              <button type="button" className="agent-interaction-primary" onClick={() => void respondClaudeApproval("accept")}>Engedélyezés egyszer</button>
            </div>
          </section>
        </div>
      )}
      {pendingClaudeQuestion && (() => {
        // Az eszköz egyszerre négy kérdést is feladhat. Korábban csak az első
        // jelent meg, a többiről a modell „no answer provided"-ot kapott.
        const questions = pendingClaudeQuestion.questions.filter(
          (item) => item.question || item.header,
        );
        if (questions.length === 0) return null;

        const answerFor = (
          question: ClaudeQuestionRequest["questions"][number],
          index: number,
        ): string | string[] | null => {
          const picked = claudeQuestionChoices[index] ?? [];
          const typed = (claudeQuestionTexts[index] ?? "").trim();
          if (question.multiSelect === true) {
            const all = typed ? [...picked, typed] : picked;
            return all.length > 0 ? all : null;
          }
          return picked[0] ?? (typed || null);
        };

        const answered = questions.filter(
          (question, index) => answerFor(question, index) !== null,
        ).length;

        const submit = () => {
          const answer: Record<string, unknown> = {};
          questions.forEach((question, index) => {
            const value = answerFor(question, index);
            if (value === null) return;
            // The Agent SDK keys the answers record by the question's full text.
            // Using the short header instead makes the SDK drop the answer and
            // tell the model "no answer provided", losing the selection silently.
            answer[question.question || question.header || `answer-${index}`] = value;
          });
          void respondClaudeQuestion(answer);
        };

        const setChoice = (index: number, next: string[]) =>
          setClaudeQuestionChoices((current) => {
            const copy = [...current];
            copy[index] = next;
            return copy;
          });
        const setText = (index: number, next: string) =>
          setClaudeQuestionTexts((current) => {
            const copy = [...current];
            copy[index] = next;
            return copy;
          });

        return (
          <div className="agent-interaction-overlay" role="presentation">
            <section
              className="agent-interaction-card agent-question-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="claude-question-title"
            >
              <span className="agent-question-eyebrow">Claude kérdez</span>
              {questions.map((question, index) => {
                const title =
                  question.question || question.header || "Válassz egy lehetőséget";
                const options = question.options ?? [];
                const multiSelect = question.multiSelect === true;
                const picked = claudeQuestionChoices[index] ?? [];
                return (
                  <div className="agent-question-block" key={`${index}:${title}`}>
                    <h2
                      className="agent-question-title"
                      id={index === 0 ? "claude-question-title" : undefined}
                    >
                      {title}
                    </h2>
                    <div
                      className="agent-question-options"
                      role={multiSelect ? "group" : "radiogroup"}
                      aria-label={title}
                    >
                      {options.map((option) => {
                        const label = option.label || "Választás";
                        const active = picked.includes(label);
                        return (
                          <button
                            type="button"
                            key={label}
                            role={multiSelect ? "checkbox" : "radio"}
                            aria-checked={active}
                            className={`agent-question-option${active ? " is-selected" : ""}`}
                            onClick={() => {
                              setChoice(
                                index,
                                multiSelect
                                  ? active
                                    ? picked.filter((item) => item !== label)
                                    : [...picked, label]
                                  : active
                                    ? []
                                    : [label],
                              );
                              // Egyválasztósnál a lista és a saját szöveg
                              // kizárja egymást, így mindig látszik, mi megy el.
                              if (!multiSelect) setText(index, "");
                            }}
                          >
                            <span className="agent-question-mark" aria-hidden="true" />
                            <span className="agent-question-label">{label}</span>
                            {option.description && (
                              <span className="agent-question-note">
                                {option.description}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <label className="agent-question-free">
                      <span className="agent-question-free-label">
                        {multiSelect ? "És a magad szavaival" : "Vagy a magad szavaival"}
                      </span>
                      <input
                        className="agent-question-free-text"
                        value={claudeQuestionTexts[index] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setText(index, value);
                          if (!multiSelect && value.trim()) setChoice(index, []);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || answered === 0) return;
                          event.preventDefault();
                          submit();
                        }}
                        placeholder="Írd ide…"
                      />
                    </label>
                  </div>
                );
              })}
              <div className="agent-interaction-actions">
                {questions.length > 1 && (
                  <span className="agent-question-progress">
                    {answered} / {questions.length} megválaszolva
                  </span>
                )}
                <button type="button" onClick={() => void respondClaudeQuestion({})}>
                  Mégse
                </button>
                <button
                  type="button"
                  className="agent-interaction-primary"
                  disabled={answered === 0}
                  onClick={submit}
                >
                  Válasz küldése
                </button>
              </div>
            </section>
          </div>
        );
      })()}
      {toast && (
        <div className="toast is-visible" role="status">
          {toast}
        </div>
      )}
      {commandsOpen && (
        <div
          className="command-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setCommandsOpen(false);
          }}
        >
          <div className="command-modal">
            <div className="command-search">
              <span>⌕</span>
              <input autoFocus placeholder="Parancs keresése…" />
            </div>
            <button onClick={newConversation}>
              <kbd>N</kbd>
              <span>Új beszélgetés</span>
            </button>
            <button
              onClick={() => {
                setCommandsOpen(false);
                notify("Projekt keresése hamarosan");
              }}
            >
              <kbd>P</kbd>
              <span>Projekt keresése</span>
            </button>
            <button
              onClick={() => {
                setCommandsOpen(false);
                setSettingsOpen(true);
              }}
            >
              <kbd>A</kbd>
              <span>Olvasási beállítások</span>
            </button>
            <button
              onClick={() => {
                setCommandsOpen(false);
                const key = latestWorkLogKeyRef.current;
                if (key)
                  setExpandedWorkLogs((current) => ({
                    ...current,
                    [key]: true,
                  }));
              }}
            >
              <kbd>G</kbd>
              <span>Kódolási kártya megnyitása</span>
            </button>
          </div>
        </div>
      )}
      </div>
    </FileActionContext.Provider>
  );
}

export default App;
