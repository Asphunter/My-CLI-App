import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Message = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  time: string;
  code?: boolean;
  live?: boolean;
  final?: boolean;
  itemId?: string;
  sequence?: number;
  /** Codex turn that produced this assistant response. */
  turnId?: string;
  hlc?: string;
  originDeviceId?: string;
  images?: MessageImageAttachment[];
};

type MessageImageAttachment = {
  path: string;
  name: string;
  mimeType: string;
};

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
type AgentApplyResult = {
  snapshotId: string;
  root: string;
  appliedFiles: number;
  removedFiles: number;
  baseHash: string;
  resultingHash: string;
  rollbackAvailable: boolean;
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
type CodexEvent = { threadId: string; eventType: string; payload: unknown };
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
type WorkLogGroup = {
  key: string;
  /** Raw turn ids folded into this one visual session. */
  turnKeys?: string[];
  /** Stable user-message bucket used to keep a session in place. */
  userMessageKey?: string;
  activities: CodeActivity[];
  sequence: number;
  hlc?: string;
  originDeviceId?: string;
};
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
type OpenMenu = { kind: "project" | "thread"; key: string } | null;
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

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "low";
const MODEL_PREFERENCE_VERSION = "4";
const EFFORT_PREFERENCE_VERSION = "1";
const READING_SETTINGS_VERSION = "2";
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

const PROJECTS_STORAGE_KEY = "min-projects";
const MESSAGE_HISTORY_STORAGE_KEY = "min-message-history";
const WORK_LOG_STORAGE_KEY = "min-work-log";
const PLAN_STORAGE_KEY = "min-plan-history";
const COMMENTARY_STORAGE_KEY = "min-commentary-history";
const DEVICE_ID_STORAGE_KEY = "min-device-id";
const LOCAL_THREAD_IDS_STORAGE_KEY = "min-local-thread-ids";
const SYNC_SCHEMA_VERSION = 1;
const LOCAL_STORE_SNAPSHOT_VERSION = 8;
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
  projectId: string;
  title: string;
  messages: Message[];
  workItems?: CodeActivity[];
  threadId: string | null;
  updatedAt: string;
  planHistory?: Record<string, PlanSnapshot>;
  commentary?: CommentaryEntry[];
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

const conversationTitleFromPrompt = (prompt: string) => {
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const normalized = firstLine
    .replace(/^[#>*\-\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Kódolási kör";
  if (normalized.length <= 42) return normalized;
  const shortened = normalized
    .slice(0, 42)
    .replace(/\s+\S*$/, "")
    .trim();
  return `${shortened || normalized.slice(0, 42).trim()}…`;
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
    if (
      message.role === "assistant" &&
      message.itemId &&
      previous?.role === "assistant" &&
      previous.itemId === message.itemId
    ) {
      const final = Boolean(previous.final || message.final);
      compacted[compacted.length - 1] = {
        ...previous,
        text: `${previous.text}${message.text}`,
        // A final response must never be resurrected as a live spinner when
        // a stale streamed copy is merged back from the local cache.
        live: final ? false : Boolean(previous.live || message.live),
        final,
        turnId: previous.turnId ?? message.turnId,
      };
    } else {
      compacted.push(message);
    }
  }
  return compacted;
};

// A Codex request cannot remain live across an app reload. Every persisted
// assistant row is therefore a settled response (or an interrupted empty
// placeholder), never an active stream. Normalizing all of them here also
// repairs rows whose live flag was cleared by sync sanitization.
const settleInterruptedMessages = (messages: Message[]) =>
  messages.map((message) =>
    message.role === "assistant"
      ? {
          ...message,
          text: message.text.trim() || "A válasz megszakítva.",
          live: false,
          final: true,
        }
      : message,
  );

const normalizedThreadStorageKey = (key: string) =>
  key
    .replaceAll("/", "\\")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\+$/, "")
    .toLowerCase();

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

const messageMergeKey = (message: Message, index: number) =>
  message.id ??
  (message.sequence !== undefined
    ? `sequence:${message.sequence}`
    : `${message.role}:${message.time}:${index}:${message.text}`);

const mergeMessages = (
  primary: Message[],
  secondary: Message[] = [],
  settleInterrupted = true,
) => {
  const merged: Message[] = [];
  const indexes = new Map<string, number>();
  for (const message of [...primary, ...secondary]) {
    const key = messageMergeKey(message, merged.length);
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push(message);
      continue;
    }

    // Sync and SQLite can contain the same row with different private/runtime
    // fields. Keep the most complete text and merge lifecycle flags instead of
    // letting the sanitized remote copy hide the local live/final state.
    const existing = merged[existingIndex];
    const final = Boolean(existing.final || message.final);
    merged[existingIndex] = {
      ...existing,
      text:
        message.text.trim().length > existing.text.trim().length
          ? message.text
          : existing.text,
      code: existing.code ?? message.code,
      // Prefer the settled lifecycle once either source knows that the
      // answer is final. Otherwise a stale SQLite/browser row can hide the
      // answer by keeping the merged row in the live state forever.
      live: final ? false : Boolean(existing.live || message.live),
      final,
      itemId: existing.itemId ?? message.itemId,
      sequence: existing.sequence ?? message.sequence,
      turnId: existing.turnId ?? message.turnId,
      hlc: existing.hlc ?? message.hlc,
      originDeviceId: existing.originDeviceId ?? message.originDeviceId,
      images:
        existing.images && existing.images.length > 0
          ? existing.images
          : message.images,
    };
  }
  const compacted = compactMessages(merged);
  return (settleInterrupted
    ? settleInterruptedMessages(compacted)
    : compacted
  ).sort(compareMessages);
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
      ? settleInterruptedMessages(
          compactMessages(
            messages.filter(
              (message) =>
                message &&
                (message.role === "user" || message.role === "assistant") &&
                typeof message.text === "string",
            ),
          ),
        ).sort(compareMessages)
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
      JSON.stringify({ ...saved, [key]: messages }),
    );
  } catch {
    // A storage quota error must not break the conversation.
  }
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
) => ({ ...primary, ...secondary });

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
  for (const step of steps) {
    const previousTiming = stepTimes[step.id] ?? {};
    const startedAt =
      previousTiming.startedAt ??
      (step.status !== "pending" ? now : undefined);
    const finished = step.status === "completed" || step.status === "error";
    stepTimes[step.id] = {
      startedAt,
      completedAt:
        previousTiming.completedAt ?? (finished ? now : undefined),
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
  compactMessages(messages).map((message) => ({ ...message, live: false }));

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
  const payload = Object.prototype.hasOwnProperty.call(envelope, "payload")
    ? envelope.payload
    : Object.prototype.hasOwnProperty.call(envelope, "params")
      ? envelope.params
      : envelope;
  return { threadId, eventType, payload };
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
    return messages.map((message, index) =>
      index === targetIndex
        ? {
            ...message,
            itemId: itemId ?? message.itemId,
            turnId: delta.turnId ?? message.turnId,
            text: `${target.text}${delta.delta}`,
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
      /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:py|js|jsx|ts|tsx|rs|go|java|cpp|c|h|json|yaml|yml|html|css|md|txt|toml|ini|sh|bat|ps1)\b/gi,
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
  const filePath = firstString(
    params.path,
    params.filePath,
    item.path,
    item.filePath,
    item.filename,
    item.name,
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
          ? (tool ?? itemType)
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

const inlineMarkdownPattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^\)]+\))/g;

const renderInlineMarkdown = (text: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlineMarkdownPattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    if (value.startsWith("`") && value.endsWith("`")) {
      parts.push(
        <code className="inline-code" key={`inline-${index}`}>
          {value.slice(1, -1)}
        </code>,
      );
    } else if (value.startsWith("**")) {
      parts.push(<strong key={`bold-${index}`}>{value.slice(2, -2)}</strong>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (link)
        parts.push(
          <a
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            key={`link-${index}`}
          >
            {link[1]}
          </a>,
        );
      else parts.push(value);
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

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

type ModelPickerProps = {
  open: boolean;
  loading: boolean;
  activeLabel: string;
  selectedModel: string | null;
  modelFamilies: ModelFamily[];
  activeFamily: ModelFamily | undefined;
  activeEffortLabel: string;
  supportedEfforts: string[];
  activeEffortIndex: number;
  onToggle: () => void;
  onFamilyHover: (key: string) => void;
  onSelectModel: (id: string | null) => void;
  onSelectEffort: (index: number) => void;
};

function ModelPicker({
  open,
  loading,
  activeLabel,
  selectedModel,
  modelFamilies,
  activeFamily,
  activeEffortLabel,
  supportedEfforts,
  activeEffortIndex,
  onToggle,
  onFamilyHover,
  onSelectModel,
  onSelectEffort,
}: ModelPickerProps) {
  return (
    <div className="model-picker">
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
            <div className="model-families">
              <button
                type="button"
                className={`model-family-option${selectedModel === null ? " is-selected" : ""}`}
                onClick={() => onSelectModel(null)}
              >
                <span>Automatikus</span>
                <span>{selectedModel === null ? "✓" : ""}</span>
              </button>
              {modelFamilies.map((family) => (
                <button
                  type="button"
                  className={`model-family-option${family.key === activeFamily?.key ? " is-open" : ""}`}
                  onMouseEnter={() => onFamilyHover(family.key)}
                  onFocus={() => onFamilyHover(family.key)}
                  onClick={() => onFamilyHover(family.key)}
                  key={family.key}
                >
                  <span>{family.label}</span>
                  <span>›</span>
                </button>
              ))}
            </div>
            <div className="model-variants">
              {activeFamily ? (
                <>
                  <div className="model-menu-label">
                    {activeFamily.label === "Codex"
                      ? "Codex"
                      : `GPT-${activeFamily.label}`}
                  </div>
                  {activeFamily.models.map((model) => (
                    <button
                      type="button"
                      className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`}
                      onClick={() => onSelectModel(model.id)}
                      key={model.id}
                    >
                      <span>
                        <strong>
                          {familyVariantLabel(activeFamily, model)}
                        </strong>
                        <small>{model.description}</small>
                      </span>
                      <span className="model-check">
                        {model.id === selectedModel ? "✓" : ""}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <div className="model-empty">Válassz modellcsaládot</div>
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

function MessageRow({
  message,
  projectPath,
  isFinal,
  showAvatar = true,
}: {
  message: Message;
  projectPath: string;
  isFinal?: boolean;
  showAvatar?: boolean;
}) {
  const visibleText = textWithoutCodeBlocks(message.text);
  const final = isFinal ?? message.final;
  const isPending =
    message.role === "assistant" && !message.text.trim() && !final;

  return (
    <article
      className={`message ${message.role === "user" ? "user-message" : "assistant-message"}${final ? " is-final" : ""}${!showAvatar ? " no-avatar" : ""}`}
    >
      <span
        className={`avatar ${message.role === "user" ? "user-avatar" : "assistant-avatar"}`}
      >
        {showAvatar ? (message.role === "user" ? "D" : "m") : ""}
      </span>
      <div className="message-content">
        <div className={`message-body${isPending ? " is-pending" : ""}`}>
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
          {visibleText && <p>{renderInlineMarkdown(visibleText)}</p>}
          {isPending && (
            <div className="assistant-pending" aria-label="A min válaszol">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

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
        <div className="plan-step-list" role="list" aria-live="polite">
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
                      ? "›"
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
        <div className="plan-detail-panel">
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
}: TurnProgressCardProps) {
  const plannedSteps = plan.steps
    .filter(
      (step) =>
        step.id !== "client-pre-plan" && !step.id.startsWith("client-fallback"),
    )
    .map((step) =>
      !streaming && step.status !== "error"
        ? { ...step, status: "completed" as const }
        : step,
    );
  const fallbackStep: PlanStep = {
    id: "client-pre-plan",
    step: "0. Terv előkészítése és feladatértelmezése",
    status: streaming && plannedSteps.length === 0 ? "inProgress" : "completed",
  };
  const isPrePlanStepId = (stepId?: string | null) =>
    !stepId ||
    stepId === fallbackStep.id ||
    stepId.startsWith("client-fallback");
  const hasPrePlanTrace =
    activities.some(
      (activity) =>
        isPrePlanStepId(activity.planStepId) &&
        activity.kind === "reasoning" &&
        Boolean(activity.body?.trim()),
    ) ||
    commentary.some(
      (entry) =>
        isPrePlanStepId(entry.stepId) && Boolean(entry.body.trim()),
    );
  const steps =
    plannedSteps.length === 0 || hasPrePlanTrace
      ? [fallbackStep, ...plannedSteps]
      : plannedSteps;
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
        ? stepId === fallbackStep.id
        : entry.stepId === stepId
      : stepId === fallbackStep.id;
  };
  const hasTraceForStep = (stepId: string) =>
    activities.some(
      (activity) =>
        (stepId === fallbackStep.id
          ? isPrePlanStepId(activity.planStepId)
          : activity.planStepId === stepId) &&
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
  const stepActivities = orderedActivities.filter((activity) =>
    selectedStep.id === fallbackStep.id
      ? isPrePlanStepId(activity.planStepId)
      : activity.planStepId === selectedStep.id,
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
    const commentaryRecords = stepCommentary
      .map((entry, index) => {
        const body = entry.body.trim();
        if (!body) return null;
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
  const activityTimes = activities
    .map((activity) => activity.id)
    .filter((value) => Number.isFinite(value));
  const inferredPlanStartedAt = Math.min(
    ...recordedStepStarts,
    ...(activityTimes.length > 0 ? [Math.min(...activityTimes)] : []),
  );
  const inferredPlanCompletedAt = Math.max(
    ...recordedStepEnds,
    ...(activityTimes.length > 0 ? [Math.max(...activityTimes)] : []),
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
  const overallElapsed = startedAtForDisplay
    ? formatElapsed(
        (completedAtForDisplay ?? (streaming ? clockNow : startedAtForDisplay)) -
          startedAtForDisplay,
      )
    : !streaming && plan.steps.length > 0
      ? "0:00"
      : "";
  const hasAnswer = Boolean(answer?.text.trim());
  const showAnswer = streaming || hasAnswer;
  const answerPending = streaming;
  const selectStep = (stepId: string) => {
    followActiveStepRef.current = false;
    setSelectedStepId(stepId);
  };
  const displayStatus = (step: PlanStep) =>
    streaming && step.id === activeStep.id && step.status === "pending"
      ? "inProgress"
      : step.status;
  const reasoningCountFor = (stepId: string) =>
    orderedActivities.filter(
      (activity) =>
        activity.kind === "reasoning" &&
        (stepId === fallbackStep.id
          ? isPrePlanStepId(activity.planStepId)
          : activity.planStepId === stepId),
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
    let startedAt =
      timing?.startedAt ??
      (currentStatus === "inProgress" ? startedAtForDisplay : undefined);
    let fallbackEnd: number | undefined;
    if (
      startedAt === undefined &&
      step.id === fallbackStep.id &&
      startedAtForDisplay !== undefined
    ) {
      // The synthetic preparation row is not part of the model-provided
      // plan. Its end is the moment the first real plan step starts.
      startedAt = startedAtForDisplay;
      fallbackEnd =
        plan.stepTimes?.[plannedSteps[0]?.id ?? ""]?.startedAt ??
        (currentStatus === "inProgress" ? clockNow : plan.completedAt);
    }
    if (startedAt === undefined)
      return !streaming && plan.steps.length > 0 ? "0:00" : "";
    const end =
      timing?.completedAt ??
      fallbackEnd ??
      (currentStatus === "inProgress"
        ? clockNow
        : !streaming
          ? completedAtForDisplay
          : undefined);
    return end === undefined ? "" : formatElapsed(end - startedAt);
  };
  const openInlineDiff = (activity: CodeActivity) =>
    setInlineDiff(inlineCodeDiffForActivity(activity));

  return (
    <article
      className={`turn-progress-card trace-card${streaming ? " is-live" : ""}`}
      aria-label="Lépések és gondolkodás"
    >
      {showAnswer && (
        <section className="turn-progress-answer" aria-label="Válasz">
          <div className="turn-progress-answer-heading">
            VÁLASZ
            {answerPending && <span className="trace-answer-spinner" aria-label="Válasz készül" />}
          </div>
          <div className="turn-progress-answer-body">
            {hasAnswer ? (
              <p>
                {renderInlineMarkdown(textWithoutCodeBlocks(answer?.text ?? ""))}
              </p>
            ) : (
              <div className="trace-answer-pending">
                <span className="trace-answer-spinner" aria-hidden="true" />
              </div>
            )}
          </div>
        </section>
      )}

      <div className="trace-step-bar">
        <button
          type="button"
          className="trace-collapse"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? "Lépések és gondolkodás összecsukása"
              : "Lépések és gondolkodás kinyitása"
          }
        >
          {expanded ? "⌃" : "⌄"}
        </button>
        <strong className="trace-step-label">
          LÉPÉSEK
          {overallElapsed && (
            <span className="trace-elapsed" aria-label="Teljes eltelt idő">
              {overallElapsed}
            </span>
          )}
        </strong>
      </div>

      {expanded && (
        <div className="trace-content">
          <section className="trace-steps-panel" aria-label="Lépések listája">
            <div className="trace-step-list" role="list">
              {steps.map((step) => {
                const disabled =
                  streaming &&
                  step.status === "pending" &&
                  step.id !== activeStep.id;
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={step.id}
                    className={`trace-step-row trace-step-row-${displayStatus(step)}${selectedStep.id === step.id ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
                    onClick={() => selectStep(step.id)}
                    disabled={disabled}
                    aria-pressed={selectedStep.id === step.id}
                  >
                    <span className="trace-step-marker" aria-hidden="true">
                      {stepIndicator(step)}
                    </span>
                    <span className="trace-step-name">{step.step}</span>
                    {stepElapsedFor(step) && (
                      <span className="trace-step-elapsed">
                        {stepElapsedFor(step)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
          <section
            className="trace-thinking-panel"
            aria-label="Gondolkodás menete"
          >
            <div className="trace-thinking-heading">GONDOLKODÁS MENETE</div>
            {thinkingEntries.length > 0 ? (
              <ul className="trace-thinking-list" ref={thinkingListRef}>
                {thinkingEntries.map((entry) => (
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
                            {renderInlineMarkdown(entry.body)}
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
                            <div className="trace-internal-history-body">
                              {entry.internalHistory.map((line, index) => (
                                <div key={`${entry.id}-history-${index}`}>{line}</div>
                              ))}
                            </div>
                          )}
                      </>
                    ) : (
                      <>
                        <span className="trace-thinking-bullet">•</span>
                        <p>{renderInlineMarkdown(entry.body)}</p>
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
                {streaming ? (
                  <>
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </>
                ) : (
                  <span className="trace-thinking-empty-text">
                    Ehhez a lÃ©pÃ©shez nem Ã©rkezett kÃ¼lÃ¶n gondolkodÃ¡si naplÃ³.
                  </span>
                )}
              </div>
            )}
          </section>
        </div>
      )}

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
      <div className="live-response-body">
        {visibleText && <p>{renderInlineMarkdown(visibleText)}</p>}
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
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProject, setActiveProject] = useState(
    () => (isTauri ? "" : (localStorage.getItem("min-active-project") ?? "")),
  );
  const [activeThread, setActiveThread] = useState(
    () =>
      isTauri ? "" : (localStorage.getItem("min-active-thread") ?? "Új beszélgetés"),
  );
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Message[]>(
    isTauri ? [] : loadInitialMessages,
  );
  const [input, setInput] = useState("");
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
      return { fontSize: "8px", lineHeight: "1.00" };
    }
    return {
      fontSize: localStorage.getItem("min-font-size") ?? "8px",
      lineHeight: localStorage.getItem("min-line-height") ?? "1.00",
    };
  });
  const [fontSize, setFontSize] = useState(readingDefaults.fontSize);
  const [lineHeight, setLineHeight] = useState(readingDefaults.lineHeight);
  const [threadIds, setThreadIds] =
    useState<Record<string, string>>(loadLocalThreadIds);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [activeFamilyKey, setActiveFamilyKey] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] =
    useState<CodexModel[]>(fallbackModels);
  const [modelsLoading, setModelsLoading] = useState(isTauri);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    if (
      localStorage.getItem("min-model-version") !== MODEL_PREFERENCE_VERSION
    ) {
      localStorage.setItem("min-model-version", MODEL_PREFERENCE_VERSION);
      return DEFAULT_MODEL;
    }
    return localStorage.getItem("min-model") ?? DEFAULT_MODEL;
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
  const [watchdogMessage, setWatchdogMessage] = useState("");
  const [agentApplyBusy, setAgentApplyBusy] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toast, setToast] = useState("");
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
  >({});
  const [tombstones, setTombstones] = useState<SyncTombstone[]>([]);
  const [restoreBusyKey, setRestoreBusyKey] = useState<string | null>(null);
  const projectMutationRevisionRef = useRef(0);
  const pendingLocalMutationRef = useRef(false);
  const pendingRestoreSelectionRef = useRef<SyncTombstone | null>(null);
  const snapshotWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const markLocalMutation = () => {
    projectMutationRevisionRef.current += 1;
    pendingLocalMutationRef.current = true;
    // Pull must not merge a stale remote snapshot between the user's local
    // mutation and its debounced SQLite/journal write.
    if (isTauri && localStoreReady) setSyncReady(false);
  };
  const markProjectMutation = markLocalMutation;

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
  const activeProjectPath = activeProjectData?.path ?? workspaceRoot;
  const threadKey = `${activeProjectPath}/${activeThread}`;
  const messageKeyRef = useRef(threadKey);
  const workLogKeyRef = useRef<string | null>(null);
  const projectsRef = useRef(projects);
  const activeProjectRef = useRef(activeProject);
  const activeThreadRef = useRef(activeThread);
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
  const timelineSequenceRef = useRef(Date.now());
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const activePlanRef = useRef(activePlan);
  const activeTurnTimingRef = useRef<PlanStepTiming>({});
  const agentMessagePhasesRef = useRef<Record<string, string>>({});
  const planKeyRef = useRef<string | null>(null);
  const commentaryKeyRef = useRef<string | null>(null);
  const planTextBufferRef = useRef<Record<string, string>>({});
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const submitBusyRef = useRef(false);
  const composerScopeRef = useRef(threadKey);
  useEffect(() => {
    if (composerScopeRef.current === threadKey) return;
    composerScopeRef.current = threadKey;
    setPendingImages([]);
  }, [threadKey]);
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const maxHeight = Math.min(260, Math.max(150, Math.round(window.innerHeight * 0.32)));
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(43, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);
  const shouldStickToBottom = useRef(true);
  const autoScrollFrameRef = useRef<number | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const completionSoundRequestsRef = useRef<Set<string>>(new Set());
  const activeLiveMessageIdRef = useRef<string | null>(null);
  const preparingRequestIdRef = useRef<string | null>(null);
  const syncActionBusyRef = useRef(false);
  const cancelledRequestIdsRef = useRef<Set<string>>(new Set());
  const activeProjectPathRef = useRef(activeProjectPath);
  const isStreamingRef = useRef(isStreaming);
  activeProjectPathRef.current = activeProjectPath;
  isStreamingRef.current = isStreaming;
  activePlanRef.current = activePlan;

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

  const playCompletionSoundOnce = (requestOrTurnId: string) => {
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

  const updatePlanState = (next: PlanSnapshot) => {
    const startedAt = next.startedAt ?? activeTurnTimingRef.current.startedAt;
    const completedAt =
      next.completedAt ?? activeTurnTimingRef.current.completedAt;
    if (startedAt !== undefined)
      activeTurnTimingRef.current.startedAt = startedAt;
    if (completedAt !== undefined)
      activeTurnTimingRef.current.completedAt = completedAt;
    const normalizedNext = {
      ...next,
      startedAt,
      completedAt,
    };
    // Event notifications can arrive back-to-back before React commits the
    // previous state update. Keep the imperative snapshot in sync as well so
    // the next plan/activity event builds on the newest step list instead of
    // resurrecting the synthetic pre-plan row.
    activePlanRef.current = normalizedNext;
    setActivePlan(normalizedNext);
    const key = normalizedNext.turnId ?? activeTurnIdRef.current ?? "current";
    setPlanHistory((current) => ({ ...current, [key]: normalizedNext }));
  };

  const markPlanStepStarted = (stepId: string | undefined, now = Date.now()) => {
    if (!stepId) return;
    const current = activePlanRef.current;
    const existing = current.stepTimes?.[stepId];
    if (existing?.startedAt !== undefined) return;
    updatePlanState({
      ...current,
      startedAt: current.startedAt ?? now,
      stepTimes: {
        ...(current.stepTimes ?? {}),
        [stepId]: { ...existing, startedAt: now },
      },
    });
  };

  const refreshSync = () => {
    if (!isTauri || !workspaceRoot || !localStoreReady) return;
    if (syncActionBusyRef.current) return;
    if (isStreamingRef.current) {
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
    if (isStreamingRef.current) {
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

  const applyAgentSnapshotAutomatically = async (guard: AgentGuardReport) => {
    if (!isTauri || !guard.applyAvailable) return true;
    setAgentApplyBusy(true);
    try {
      await invoke<AgentApplyResult>("codex_apply_snapshot", {
        snapshotId: guard.snapshotId,
      });
      return true;
    } catch (error) {
      // There is intentionally no review dock anymore. Surface only a short
      // toast and release the UI so a later turn can still be attempted.
      setCodeStatus("apply hiba");
      notify(
        `A létrehozott fájlok automatikus alkalmazása sikertelen: ${String(error)}`,
        "notify",
      );
      return false;
    } finally {
      setAgentApplyBusy(false);
    }
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
        projectId: project.id,
        title,
        messages: mergeMessages(remote?.messages ?? [], localMessages, false),
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
          const preferred = ["luna", "terra", "sol"];
          const aRank = preferred.findIndex((name) =>
            a.id.endsWith(`-${name}`),
          );
          const bRank = preferred.findIndex((name) =>
            b.id.endsWith(`-${name}`),
          );
          return (
            (aRank < 0 ? 50 : aRank) - (bRank < 0 ? 50 : bRank) ||
            a.displayName.localeCompare(b.displayName)
          );
        }),
      }));
  }, [modelCatalog]);

  const activeModel =
    modelCatalog.find((model) => model.id === selectedModel) ??
    fallbackModels.find((model) => model.id === DEFAULT_MODEL) ??
    fallbackModels[0];
  const activeLabel = selectedModel ? modelLabel(activeModel) : "Automatikus";
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
  const selectedFamily = modelFamilies.find((family) =>
    family.models.some((model) => model.id === selectedModel),
  );
  const activeFamily =
    modelFamilies.find((family) => family.key === activeFamilyKey) ??
    selectedFamily ??
    modelFamilies[0];
  const codeSnippets = useMemo<CodeSnippet[]>(() => {
    const lastUserIndex = messages
      .map((message) => message.role)
      .lastIndexOf("user");
    const currentTurn = messages.slice(
      lastUserIndex >= 0 ? lastUserIndex + 1 : 0,
    );
    return currentTurn.flatMap((message, messageIndex) =>
      extractCodeBlocks(message.text).map((block, blockIndex) => ({
        ...block,
        id: `${lastUserIndex + 1 + messageIndex}-${blockIndex}`,
        messageIndex: lastUserIndex + 1 + messageIndex,
      })),
    );
  }, [messages]);

  const workLogGroups = useMemo<WorkLogGroup[]>(() => {
    const grouped = new Map<string, CodeActivity[]>();
    for (const activity of codeActivity) {
      const key = activity.turnId ?? "legacy";
      const items = grouped.get(key) ?? [];
      items.push(activity);
      grouped.set(key, items);
    }
    const userMessages = messages
      .filter((message) => message.role === "user")
      .map((message, index) => ({
        key: message.id ?? `user:${message.sequence ?? index}`,
        sequence: message.sequence ?? index,
        hlc: message.hlc,
      }))
      .sort((left, right) => left.sequence - right.sequence);
    const precedingUserBucket = (sequence: number) => {
      let bucket: (typeof userMessages)[number] | undefined;
      for (const message of userMessages) {
        if (message.sequence <= sequence) bucket = message;
        else break;
      }
      return bucket?.key ?? "before-first-user";
    };
    type MutableGroup = WorkLogGroup & {
      bucket: string;
      turnKeySet: Set<string>;
    };
    const canonical = new Map<string, MutableGroup>();
    for (const [rawKey, activities] of grouped.entries()) {
      const orderedActivities = [...activities].sort(compareWorkItems);
      const firstActivity = orderedActivities[0];
      const lastActivity = orderedActivities[orderedActivities.length - 1];
      const bucket = precedingUserBucket(
        lastActivity?.id ?? firstActivity?.id ?? 0,
      );
      const userMessageKey =
        bucket === "before-first-user" ? undefined : bucket;
      const existing = canonical.get(bucket);
      if (!existing) {
        canonical.set(bucket, {
          key: `session:${bucket}`,
          bucket,
          turnKeySet: new Set([rawKey]),
          turnKeys: [rawKey],
          userMessageKey,
          activities: orderedActivities,
          sequence: firstActivity?.id ?? lastActivity?.id ?? 0,
          hlc: firstActivity?.hlc,
          originDeviceId: firstActivity?.originDeviceId,
        });
        continue;
      }
      existing.turnKeySet.add(rawKey);
      existing.turnKeys = [...existing.turnKeySet];
      existing.activities = [...existing.activities, ...orderedActivities].sort(
        compareWorkItems,
      );
      if (firstActivity && firstActivity.id < existing.sequence) {
        existing.sequence = firstActivity.id;
        existing.hlc = firstActivity.hlc;
        existing.originDeviceId = firstActivity.originDeviceId;
      }
    }
    const groups = [...canonical.values()].map(({ bucket, turnKeySet, ...group }) =>
      group,
    );
    const pendingAssistant = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.live && !message.final,
      );
    const activeTurnKey = activeTurnIdRef.current;
    const hasActiveTurnGroup = Boolean(
      activeTurnKey &&
        groups.some(
          (group) =>
            group.key === activeTurnKey ||
            Boolean(group.turnKeys?.includes(activeTurnKey)),
        ),
    );
    const pendingTurnKey = pendingAssistant?.id
      ? `pending:${pendingAssistant.id}`
      : undefined;
    const hasPendingTurnGroup = Boolean(
      pendingTurnKey &&
        groups.some(
          (group) =>
            group.key === pendingTurnKey ||
            Boolean(group.turnKeys?.includes(pendingTurnKey)),
        ),
    );
    if (
      (isStreaming &&
        Boolean(pendingAssistant) &&
        !activeTurnKey &&
        !hasPendingTurnGroup) ||
      (isStreaming && Boolean(activeTurnKey) && !hasActiveTurnGroup) ||
      ((codeSnippets.length > 0 || activePlan.steps.length > 0) &&
        groups.length === 0)
    ) {
      const lastMessage = pendingAssistant ?? messages[messages.length - 1];
      const lastMessageSequence = lastMessage?.sequence ?? messages.length;
      const placeholderBucket = precedingUserBucket(lastMessageSequence);
      const placeholderKey =
        placeholderBucket === "before-first-user"
          ? pendingTurnKey ?? activeTurnKey ?? "current"
          : `session:${placeholderBucket}`;
      groups.push({
        key: placeholderKey,
        turnKeys: [pendingTurnKey, activeTurnKey].filter(
          (key): key is string => Boolean(key),
        ),
        userMessageKey:
          placeholderBucket === "before-first-user"
            ? undefined
            : placeholderBucket,
        activities: [],
        sequence: lastMessageSequence + 1,
        hlc: lastMessage?.hlc,
        originDeviceId: lastMessage?.originDeviceId,
      });
    }
    return groups.sort((left, right) =>
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
    activePlan.steps.length,
    codeActivity,
    codeSnippets.length,
    isStreaming,
    messages,
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

  const latestWorkLogKeyRef = useRef<string | null>(null);
  latestWorkLogKeyRef.current =
    workLogGroups[workLogGroups.length - 1]?.key ?? null;

  const workGroupTurnKeys = (group: WorkLogGroup) => [
    group.key,
    ...(group.turnKeys ?? []),
  ].filter((key, index, values): key is string => Boolean(key) && values.indexOf(key) === index);
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
  const planForWorkGroup = (group: WorkLogGroup) => {
    const candidates = workGroupTurnKeys(group)
      .map((key, index) => ({ plan: planHistory[key], index }))
      .filter(
        (candidate): candidate is { plan: PlanSnapshot; index: number } =>
          Boolean(candidate.plan),
      );
    if (candidates.length === 0) return undefined;
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
  const commentaryForWorkGroup = (group: WorkLogGroup) => {
    const keys = new Set(workGroupTurnKeys(group));
    return commentaryEntries.filter(
      (entry) => entry.turnId && keys.has(entry.turnId),
    );
  };

  useEffect(() => {
    if (!isStreaming) return;
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
  }, [isStreaming, workLogGroups]);

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
        const snapshot = await invoke<LocalStoreSnapshot>("local_store_load");
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
        const localConversationCache: Record<string, SyncConversation> = {};
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
              projectId: project.id,
              title,
              messages: mergeMessages(
                databaseConversation?.messages ?? [],
                localMessages,
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
              projectId: local.id,
              title,
              messages: mergeMessages(
                databaseConversation?.messages ?? [],
                messages,
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

        const selectedProject =
          nextProjects.find((project) => project.name === activeProject) ??
          nextProjects[0];
        if (selectedProject) {
          const selectedThread = preferredThreadForProject(
            selectedProject,
            localConversationCache,
            activeThread,
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
    if (!isTauri || !activeProjectData.path) return;
    void invoke<boolean>("ensure_project_instructions", {
      path: activeProjectData.path,
    }).catch((error) => {
      console.warn("Projekt AGENTS.md seeding failed", error);
    });
  }, [activeProjectData.path]);

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
      .then((result) => {
        if (!active) return;
        // The pull is asynchronous. Always merge against the state that is
        // current when it finishes, not the render that started it; otherwise
        // a restart-time pull can replace an already visible conversation.
        const currentProjects = projectsRef.current;
        const currentConversationCache = localConversationCacheRef.current;
        const currentThreadIds = threadIdsRef.current;
        setSyncHealth(result.health);
        const state = result.snapshot;
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
        if (state.projects.length === 0 && remoteTombstones.length === 0) {
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
        if (visibleProjects.length === 0) {
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
              messages: mergeMessages(
                selectedConversation.messages,
                messagesRef.current,
                false,
              ),
              workItems: mergeWorkItems(
                selectedConversation.workItems ?? [],
                codeActivityRef.current,
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
      if (isStreamingRef.current || syncActionBusyRef.current) return;
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
      if (projects.length === 0) {
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
    if (isTauri && (!syncReady || !localStoreReady)) return;
    if (messageKeyRef.current !== threadKey) {
      messageKeyRef.current = threadKey;
      commitMessages(
        localConversationCacheRef.current[threadKey]?.messages ??
          loadThreadMessages(threadKey),
      );
      return;
    }
    if (isTauri) {
      setLocalConversationCache((current) => {
        const existing = current[threadKey];
        const next = {
          ...current,
          [threadKey]: {
          ...(existing ?? {
            projectId: activeProjectData.id,
            title: activeThread,
            messages: [],
            workItems: [],
            threadId: threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          projectId: activeProjectData.id,
          title: activeThread,
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
  }, [
    threadKey,
    messages,
    syncReady,
    localStoreReady,
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
            projectId: activeProjectData.id,
            title: activeThread,
            messages: [],
            workItems: [],
            threadId: threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          projectId: activeProjectData.id,
          title: activeThread,
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
    activeProjectData.id,
    activeThread,
    threadIds,
  ]);

  useEffect(() => {
    if (planKeyRef.current !== threadKey) {
      planKeyRef.current = threadKey;
      planTextBufferRef.current = {};
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
  }, [threadKey, planHistory, isTauri, localStoreReady]);

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
  }, [threadKey, commentaryEntries, isTauri, localStoreReady]);

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
    isStreaming,
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
      (!syncReady && !pendingLocalMutationRef.current)
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
          const projectIsActive = project.name === currentActiveProject;
          const conversationMessages =
            projectIsActive && title === currentActiveThread
              ? mergeMessages(
                  cached?.messages ?? loadThreadMessages(localKey),
                  currentMessages,
                  false,
                )
              : (cached?.messages ?? loadThreadMessages(localKey));
          const conversationWorkItems =
            projectIsActive && title === currentActiveThread
              ? mergeWorkItems(cached?.workItems ?? [], currentWorkItems)
              : (cached?.workItems ?? loadThreadWorkItems(localKey));
          const conversationPlanHistory =
            projectIsActive && title === currentActiveThread
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
            projectIsActive && title === currentActiveThread
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
          const saved = await invoke<LocalStoreSnapshot>("local_store_save", {
            snapshot,
          });
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
          if (syncWriteEnabled && (syncReady || pendingMutationAtSchedule)) {
            setSyncStatus("journal…");
            try {
              const result = await invoke<SyncV2Result>(
                "sync_v2_publish_snapshot",
                { snapshot: saved },
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
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    activeProject,
    activeThread,
    codeActivity,
    localStoreReady,
    localStoreWriteEnabled,
    messages,
    projects,
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
        if (active && models.length > 0) setModelCatalog(models);
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
    if (!isStreaming) {
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
  }, [isStreaming]);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    let activeTurnId: string | undefined;
    void listen<CodexEvent>("codex-event", (event) => {
      const codexEvent = normalizeCodexEvent(event.payload);
      if (!codexEvent) return;
      const params = asRecord(codexEvent.payload);
      const item = asRecord(params.item);
      const explicitTurnId = eventTurnId(codexEvent, params, item);
      let planStepIdOverride: string | undefined;
      if (codexEvent.eventType === "turn/started")
        activeTurnId = explicitTurnId;
      if (activeTurnId) activeTurnIdRef.current = activeTurnId;

      if (
        codexEvent.eventType === "item/started" &&
        String(item.type ?? "").toLowerCase() === "agentmessage"
      ) {
        const itemId = firstString(item.id, params.itemId, params.item_id);
        const phase = firstString(item.phase, params.phase);
        if (itemId && phase) agentMessagePhasesRef.current[itemId] = phase;
      }

      if (codexEvent.eventType === "item/agentMessage/delta") {
        const deltaText = firstString(params.delta);
        const itemId = eventItemId(codexEvent, params, item);
        const phase =
          (itemId ? agentMessagePhasesRef.current[itemId] : undefined) ??
          firstString(params.phase, item.phase);
        if (deltaText) {
          setWatchdogMessage("");
          if (phase === "final_answer") {
            commitMessages((current) =>
              appendCodexDelta(
                current,
                {
                  threadId: codexEvent.threadId,
                  delta: deltaText,
                  itemId,
                  turnId: explicitTurnId,
                  phase,
                },
                activeLiveMessageIdRef.current ?? undefined,
              ),
            );
          } else {
            const stepId =
              activePlanRef.current.steps.find(
                (step) => step.status === "inProgress",
              )?.id ?? activePlanRef.current.steps[0]?.id;
            setCommentaryEntries((current) => {
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
                    turnId: explicitTurnId,
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
          (itemId ? agentMessagePhasesRef.current[itemId] : undefined) ??
          firstString(item.phase, params.phase);
        if (itemId && phase !== "final_answer")
          setCommentaryEntries((current) =>
            current.map((entry) =>
              entry.itemId === itemId ? { ...entry, status: "done" } : entry,
            ),
          );
      }

      if (codexEvent.eventType === "turn/plan/updated") {
        const snapshot = normalizePlanSnapshot(
          codexEvent.payload,
          explicitTurnId,
        );
        if (snapshot) {
          const current = activePlanRef.current;
          const next = planWithTiming(
            {
              ...current,
              turnId: snapshot.turnId ?? current.turnId,
              explanation: snapshot.explanation || current.explanation,
            },
            snapshot.steps,
            activeTurnTimingRef.current.startedAt ?? Date.now(),
          );
          const targetStep =
            next.steps.find((step) => step.status === "inProgress") ??
            next.steps[0];
          if (targetStep) {
            planStepIdOverride = targetStep.id;
          }
          updatePlanState(next);
          setWatchdogMessage("");
          setCodeStatus("terv frissítve");
        }
      } else if (
        codexEvent.eventType === "item/plan/delta" ||
        (codexEvent.eventType === "item/completed" &&
          String(item.type ?? "").toLowerCase() === "plan")
      ) {
        const delta = firstString(params.delta, params.text, item.text);
        const bufferKey =
          eventItemId(codexEvent, params, item) ?? explicitTurnId;
        if (delta && bufferKey) {
          const nextText = `${planTextBufferRef.current[bufferKey] ?? ""}${delta}`;
          planTextBufferRef.current[bufferKey] = nextText;
          const steps = planTextToSteps(nextText);
          if (steps.length > 0)
            updatePlanState(
              planWithTiming(
                {
                  ...activePlanRef.current,
                  turnId: activePlanRef.current.turnId ?? explicitTurnId,
                },
                steps,
                activeTurnTimingRef.current.startedAt ?? Date.now(),
              ),
            );
        }
      }
      const activityId = nextTimelineSequence();
      const activity = summarizeCodexWorkEvent(
        codexEvent,
        activityId,
        activeTurnId,
      );
      if (activity) {
        const planStepId =
          planStepIdOverride ??
          activePlanRef.current.steps.find(
            (step) => step.status === "inProgress",
        )?.id ??
          activePlanRef.current.steps[0]?.id;
        const activityWithStep = { ...activity, planStepId };
        markPlanStepStarted(planStepId, Date.now());
        setCodeActivity((current) =>
          mergeCodeActivity(current, activityWithStep),
        );
        const filePath = extractFilePath(codexEvent.payload);
        if (
          !activityWithStep.code &&
          filePath &&
          /\.[a-z0-9]{1,8}$/i.test(filePath)
        ) {
          void invoke<string | null>("read_code_file", {
            cwd: activeProjectPathRef.current,
            path: filePath,
          })
            .then((code) => {
              if (!code) return;
              setCodeActivity((current) =>
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
        const current = activePlanRef.current;
        const steps =
          current.steps.length > 0
            ? current.steps
            : [
                {
                  id: "client-pre-plan",
                  step: "0. Terv előkészítése és feladatértelmezése",
                  status: "inProgress" as const,
                },
              ];
        updatePlanState(
          planWithTiming(
            { ...current, turnId: explicitTurnId, explanation: current.explanation },
            steps,
            current.startedAt ?? activeTurnTimingRef.current.startedAt ?? Date.now(),
          ),
        );
        setWatchdogMessage("");
        setCodeStatus("dolgozik");
      } else if (codexEvent.eventType === "turn/completed") {
        const completedAt = Date.now();
        const completedSteps = activePlanRef.current.steps.map((step) =>
          step.status === "error"
            ? step
            : { ...step, status: "completed" as const },
        );
        const completedPlan = planWithTiming(
          activePlanRef.current,
          completedSteps,
          activePlanRef.current.startedAt ??
            activeTurnTimingRef.current.startedAt ??
            completedAt,
          completedAt,
        );
        updatePlanState(completedPlan);
        setCodeStatus("kész");
        playCompletionSoundOnce(
          activeRequestIdRef.current ?? explicitTurnId,
        );
      } else if (codexEvent.eventType.includes("error")) setCodeStatus("hiba");
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

  const notify = (message: string, sound?: AppSound) => {
    setToast(message);
    if (sound) playAppSound(sound);
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
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = `${input.slice(0, start)}${pastedText}${input.slice(end)}`;
      setInput(next);
      requestAnimationFrame(() => {
        const position = start + pastedText.length;
        textarea.focus();
        textarea.setSelectionRange(position, position);
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
    setActiveFamilyKey(
      modelFamilies.find((family) =>
        family.models.some((candidate) => candidate.id === model),
      )?.key ?? null,
    );
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
        : "Automatikus Codex-modell kiválasztva",
    );
  };

  const toggleModelMenu = () => {
    const nextOpen = !modelMenuOpen;
    if (nextOpen)
      setActiveFamilyKey(selectedFamily?.key ?? modelFamilies[0]?.key ?? null);
    setModelMenuOpen(nextOpen);
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
    if (isStreaming) {
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
    setAppDialog({
      kind: "input",
      title: "Projekt átnevezése",
      label: "Projekt neve",
      value: project.name,
      confirmLabel: "Mentés",
      onConfirm: (value) => {
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
    setAppDialog({
      kind: "input",
      title: "Beszélgetés átnevezése",
      label: "Beszélgetés neve",
      value: thread,
      confirmLabel: "Mentés",
      onConfirm: (value) => {
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
    setAppDialog({
      kind: "confirm",
      title: "Beszélgetés törlése",
      message: `Biztosan törlöd a(z) „${thread}” beszélgetést?`,
      confirmLabel: "Beszélgetés törlése",
      danger: true,
      onConfirm: () => performDeleteThread(project, thread),
    });
  };

  const changeProjectsRoot = async () => {
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
      setCodeStatus("készen");
      setExpandedWorkLogs({});
      setOpenProjects((current) => ({ ...current, [project.path]: true }));
      notify(`Meglévő projekt hozzáadva: ${project.name}`);
    } catch (error) {
      notify(`Nem sikerült megnyitni a projektmappát: ${String(error)}`);
    }
  };

  const selectThread = (project: Project, thread: string) => {
    setActiveProject(project.name);
    setActiveThread(thread);
    commitMessages(messagesForThread(`${project.path}/${thread}`));
    setCodeActivity(workItemsForThread(`${project.path}/${thread}`));
    setCodeStatus(
      workItemsForThread(`${project.path}/${thread}`).length > 0
        ? "kész"
        : "készen",
    );
    setExpandedWorkLogs({});
    notify(`Megnyitva: ${thread}`);
  };

  const createRequestId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const settleActivePlan = (status: "completed" | "error") => {
    const current = activePlanRef.current;
    if (
      current.steps.length === 0 ||
      !current.steps.some((step) => step.status === "inProgress")
    )
      return;
    const now = Date.now();
    updatePlanState(
      planWithTiming(
        current,
        current.steps.map((step) =>
          step.status === "inProgress" ? { ...step, status } : step,
        ),
        current.startedAt ?? activeTurnTimingRef.current.startedAt ?? now,
        now,
      ),
    );
  };

  const stopGeneration = async () => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || isCancelling) return;
    const liveMessageId = activeLiveMessageIdRef.current;
    const finalizeCancellation = () => {
      cancelledRequestIdsRef.current.add(requestId);
      preparingRequestIdRef.current = null;
      activeRequestIdRef.current = null;
      activeLiveMessageIdRef.current = null;
      commitMessages((current) =>
        current.map((message) =>
          message.id === liveMessageId
            ? {
                ...message,
                text: message.text.trim()
                  ? `${message.text.trimEnd()}\n\nA válasz megszakítva.`
                  : "A válasz megszakítva.",
                turnId: message.turnId ?? activeTurnIdRef.current,
                live: false,
                final: true,
              }
            : message,
        ),
      );
      settleActivePlan("completed");
      setIsStreaming(false);
      setIsCancelling(false);
      setCodeStatus("kész");
      setWatchdogMessage("");
    };
    if (preparingRequestIdRef.current === requestId) {
      finalizeCancellation();
      notify("A válaszgenerálás leállítva");
      return;
    }
    setIsCancelling(true);
    try {
      await invoke("codex_cancel", { requestId });
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

  useEffect(() => {
    document.documentElement.classList.toggle("is-streaming", isStreaming);
    document.documentElement.classList.toggle("is-cancelling", isCancelling);
    document
      .querySelectorAll<HTMLButtonElement>(".send-button")
      .forEach((button) => {
        button.setAttribute(
          "aria-label",
          isStreaming ? "Gondolkodás leállítása" : "Üzenet küldése",
        );
      });
    return () => {
      document.documentElement.classList.remove(
        "is-streaming",
        "is-cancelling",
      );
    };
  }, [isStreaming, isCancelling]);

  useEffect(() => {
    const onSendButtonClick = (event: MouseEvent) => {
      if (!isStreaming || !(event.target instanceof Element)) return;
      const button = event.target.closest(".send-button");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      void stopGeneration();
    };
    document.addEventListener("click", onSendButtonClick, true);
    return () => document.removeEventListener("click", onSendButtonClick, true);
  }, [isStreaming, isCancelling]);

  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    const pendingImageSnapshot = [...pendingImages];
    if (
      (!text && pendingImageSnapshot.length === 0) ||
      isStreaming ||
      submitBusyRef.current
    )
      return;
    if (agentApplyBusy) {
      notify("A létrehozott fájlok alkalmazása még folyamatban van.");
      return;
    }
    if (!isTauri) {
      notify("A natív Tauri appban érhető el a Codex-kapcsolat");
      return;
    }
    if (!activeProjectData?.path) {
      notify("Előbb válassz vagy adj hozzá egy projektmappát");
      return;
    }
    submitBusyRef.current = true;
    setImagesPreparing(true);
    let storedImages: MessageImageAttachment[] = [];
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
      submitBusyRef.current = false;
      setImagesPreparing(false);
      notify(`A képcsatolmány nem menthető: ${String(error)}`, "notify");
      return;
    }
    setImagesPreparing(false);
    // A continued conversation is a local mutation too. This invalidates any
    // restart-time sync pull that began before the user pressed Send, so its
    // older snapshot cannot replace the visible history mid-request.
    markLocalMutation();
    const promptText = text || "Vizsgáld meg a csatolt képet vagy képeket.";
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
    const requestId = createRequestId();
    const liveMessageId = createEntityId();
    const userSequence = nextTimelineSequence();
    const liveSequence = nextTimelineSequence();
    const liveMessage: Message = {
      id: liveMessageId,
      role: "assistant",
      time: "most",
      text: "",
      live: true,
      final: false,
      sequence: liveSequence,
    };
    const previousMessages = mergeMessages(
      localConversationCacheRef.current[threadKey]?.messages ?? [],
      messagesRef.current,
      false,
    );
    const userMessage: Message = {
      id: createEntityId(),
      role: "user",
      time: "most",
      text,
      images: storedImages,
      sequence: userSequence,
    };
    const nextMessages = [...previousMessages, userMessage, liveMessage];
    let requestThreadKey = threadKey;
    const activeProjectForNaming = projects.find(
      (project) => project.id === activeProjectData.id,
    );
    if (
      activeProjectForNaming &&
      (isUntitledConversation(activeThread) || !activeThread.trim()) &&
      !previousMessages.some((message) => message.role === "user")
    ) {
      const nextTitle = uniqueConversationTitle(
        activeProjectForNaming,
        conversationTitleFromPrompt(
          text || storedImages[0]?.name || "Képes kérdés",
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
            projectId: activeProjectForNaming.id,
            title: nextTitle,
            messages: [],
            workItems: [],
            threadId: null,
            updatedAt: new Date().toISOString(),
          }),
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
    activeTurnIdRef.current = undefined;
    const requestStartedAt = Date.now();
    activeTurnTimingRef.current = { startedAt: requestStartedAt };
    planTextBufferRef.current = {};
    agentMessagePhasesRef.current = {};
    setTransportStatus({
      stage: "request-accepted",
      detail: "Kérés fogadva; a feladat értelmezése indul.",
      threadId: null,
    });
    const initialPlan: PlanSnapshot = {
      turnId: null,
      explanation: "",
      steps: [
        {
          id: "client-pre-plan",
          step: "0. Terv előkészítése és feladatértelmezése",
          status: "inProgress",
        },
      ],
      startedAt: requestStartedAt,
      stepTimes: {
        "client-pre-plan": { startedAt: requestStartedAt },
      },
    };
    activePlanRef.current = initialPlan;
    setActivePlan(initialPlan);
    commitMessages(nextMessages);
    setInput("");
    setPendingImages([]);
    preparingRequestIdRef.current = requestId;
    activeRequestIdRef.current = requestId;
    activeLiveMessageIdRef.current = liveMessageId;
    setIsStreaming(true);
    setIsCancelling(false);
    setCodeStatus("dolgozik");
    let codexPrompt = promptText;
    const rehydrationContext =
      conversationContextForRehydration(previousMessages);
    if (isTauri && activeProjectData?.path) {
      const localFileContext = await loadLocalFileContext(
        promptText,
        rehydrationContext,
        activeProjectData.path,
      );
      if (localFileContext)
        codexPrompt = `${promptText}\n\n${localFileContext}`;
    }
    if (cancelledRequestIdsRef.current.delete(requestId)) {
      preparingRequestIdRef.current = null;
      activeRequestIdRef.current = null;
      activeLiveMessageIdRef.current = null;
      submitBusyRef.current = false;
      return;
    }
    preparingRequestIdRef.current = null;

    try {
      const response = await invoke<CodexResponse>("codex_send", {
        request: {
          prompt: codexPrompt,
          threadId: threadIds[requestThreadKey] ?? null,
          conversationContext: rehydrationContext || null,
          model: selectedModel,
          effort: effectiveEffort,
          cwd: activeProjectData.path,
          images: storedImages,
          requestId,
        },
      });
      if (cancelledRequestIdsRef.current.delete(requestId)) return;
      const hasAgentChanges =
        response.guard.changedFiles.length > 0 ||
        response.guard.addedFiles.length > 0 ||
        response.guard.removedFiles.length > 0;
      if (hasAgentChanges)
        await applyAgentSnapshotAutomatically(response.guard);
      setThreadIds((current) => ({
        ...current,
        [requestThreadKey]: response.threadId,
      }));
      commitMessages((current) => {
        const targetIndex = current.findIndex(
          (message) => message.id === liveMessageId,
        );
        if (targetIndex < 0) return current;
        return current.map((message, index) =>
          index === targetIndex
            ? {
                ...message,
                text: message.text || response.text,
                turnId: message.turnId ?? activeTurnIdRef.current,
                live: false,
                final: true,
              }
            : message,
        );
      });
      for (const filePath of extractMentionedFilePaths(response.text)) {
        void invoke<string | null>("read_code_file", {
          cwd: activeProjectPathRef.current,
          path: filePath,
        })
          .then((code) => {
            if (!code) return;
            const extension = filePath
              .split(/[\\/.]/)
              .pop()
              ?.toLowerCase();
            const activityId = nextTimelineSequence();
            setCodeActivity((current) =>
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
      const currentPlan = activePlanRef.current;
      if (currentPlan.steps.length > 0) {
        updatePlanState(
          planWithTiming(
            currentPlan,
            currentPlan.steps.map((step) =>
              step.status === "error"
                ? step
                : { ...step, status: "completed" as const },
            ),
            currentPlan.startedAt ??
              activeTurnTimingRef.current.startedAt ??
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
      const errorText = String(error);
      const wasCancelled =
        cancelledRequestIdsRef.current.delete(requestId) ||
        /megszakítva|leállítva|cancel/i.test(errorText);
      commitMessages((current) => {
        const targetIndex = current.findIndex(
          (message) => message.id === liveMessageId,
        );
        if (targetIndex < 0) return current;
        return current.map((message, index) =>
          index === targetIndex
            ? {
                ...message,
                text: wasCancelled
                  ? "A válasz megszakítva."
                  : `Nem sikerült a Codex-kérés: ${errorText}`,
                turnId: message.turnId ?? activeTurnIdRef.current,
                live: false,
                final: true,
              }
            : message,
        );
      });
      settleActivePlan(wasCancelled ? "completed" : "error");
      setCodeStatus(wasCancelled ? "kész" : "hiba");
      notify(
        wasCancelled ? "Codex-kérés megszakítva" : "Codex-kapcsolati hiba",
        wasCancelled ? undefined : "notify",
      );
    } finally {
      if (activeRequestIdRef.current === requestId) {
        setIsStreaming(false);
        setIsCancelling(false);
        activeRequestIdRef.current = null;
        activeLiveMessageIdRef.current = null;
        preparingRequestIdRef.current = null;
      }
      submitBusyRef.current = false;
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
      setInput(textarea.value);
      requestAnimationFrame(() => {
        const position = cursor + insertion.length;
        textarea.focus();
        textarea.setSelectionRange(position, position);
      });
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const newConversationForProject = (project: Project) => {
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
    commitMessages(messagesForThread(`${project.path}/${thread}`));
    setCodeActivity(workItemsForThread(`${project.path}/${thread}`));
    setCodeStatus(
      workItemsForThread(`${project.path}/${thread}`).length > 0
        ? "kész"
        : "készen",
    );
    setExpandedWorkLogs({});
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
  const userMessageKeyAtIndex = (index: number) => {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const message = messages[cursor];
      if (message?.role === "user")
        return message.id ?? `user:${message.sequence ?? cursor}`;
    }
    return undefined;
  };
  const userMessageKeyForGroup = (group: WorkLogGroup) => {
    if (group.userMessageKey) return group.userMessageKey;
    let candidate: string | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "user") continue;
      const sequence = message.sequence ?? index;
      if (sequence <= group.sequence)
        candidate = message.id ?? `user:${sequence}`;
      else break;
    }
    return candidate;
  };
  const messageBelongsToWorkGroup = (
    message: Message,
    messageIndex: number,
    group: WorkLogGroup,
  ) => {
    const turnKeys = new Set(workGroupTurnKeys(group));
    if (message.turnId && turnKeys.has(message.turnId)) return true;
    const groupUserKey = userMessageKeyForGroup(group);
    if (groupUserKey && userMessageKeyAtIndex(messageIndex) === groupUserKey)
      return true;
    if (message.role !== "assistant" || message.live) return false;
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
    /(?:^|\n\n)A vÃ¡lasz megszakÃ­tva\.?\s*$/i.test(text.trim());
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
    const completedAssistants = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          message.role === "assistant" &&
          !message.live &&
          message.text.trim().length > 0,
      );
    const nearest = completedAssistants.reduce<
      { message: Message; index: number } | undefined
    >((current, item) => {
      if (!current) return item;
      const currentDistance = Math.abs(
        (current.message.sequence ?? current.index) - group.sequence,
      );
      const itemDistance = Math.abs(
        (item.message.sequence ?? item.index) - group.sequence,
      );
      return itemDistance < currentDistance ? item : current;
    }, undefined);
    return nearest?.message;
  };
  const workGroupForMessage = (message: Message, messageIndex: number) =>
    workLogGroups.find(
      (group) =>
        workGroupHasVisibleTrace(group) &&
        messageBelongsToWorkGroup(message, messageIndex, group),
    );
  const timelineContent = timelineEntries.map((entry) => {
    if (entry.kind === "message") {
      const nextMessage = messages[entry.messageIndex + 1];
      const isFinal =
        entry.message.final ??
        (entry.message.role === "assistant" &&
          entry.message.text.trim().length > 0 &&
          (!nextMessage || nextMessage.role === "user"));
      if (entry.message.role === "assistant" && !isFinal) return null;
      const showAvatar =
        entry.message.role === "user" ||
        messages[entry.messageIndex - 1]?.role !== "assistant";
      const associatedGroup =
        entry.message.role === "assistant" && isFinal
          ? workGroupForMessage(entry.message, entry.messageIndex)
          : undefined;
      // A completed assistant response is rendered inside its own trace
      // session. Keeping the standalone MessageRow as well created the
      // apparent "answer above VÁLASZ" duplicate.
      // The response already lives inside its trace card. Starting a later
      // request must not make the old standalone assistant row reappear and
      // duplicate the VÁLASZ panel above the new user message.
      if (associatedGroup) return null;
      return (
        <MessageRow
          key={entry.key}
          message={entry.message}
          projectPath={activeProjectPath}
          isFinal={isFinal}
          showAvatar={showAvatar}
        />
      );
    }
    if (isStreaming && entry.group.key === latestWorkGroup?.key) return null;
    const storedPlan = planForWorkGroup(entry.group);
    if (!workGroupHasVisibleTrace(entry.group)) return null;
    const isLatestGroup = entry.group.key === latestWorkGroup?.key;
    const expanded = expandedForWorkGroup(entry.group, isLatestGroup);
    const basePlan =
      storedPlan ??
      (isLatestGroup
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
    const plan: PlanSnapshot = isLatestGroup
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
      : basePlan;
    return (
      <TurnProgressCard
        key={entry.key}
        plan={plan}
        activities={entry.group.activities}
        commentary={commentaryForWorkGroup(entry.group)}
        status={isLatestGroup ? codeStatus : "kész"}
        streaming={false}
        expanded={expanded}
        transport={null}
        watchdogMessage=""
        answer={answerForWorkGroup(entry.group)}
        onToggle={() =>
          setExpandedForWorkGroup(entry.group, !expanded)
        }
      />
    );
  });
  const liveWorkGroup = isStreaming ? latestWorkGroup : undefined;
  const liveTurnKey = liveWorkGroup?.key ?? activePlan.turnId ?? "current";
  const liveTurnId = activePlan.turnId ?? activeTurnIdRef.current;
  const liveExpanded = liveWorkGroup
    ? expandedForWorkGroup(liveWorkGroup, true)
    : Object.prototype.hasOwnProperty.call(expandedWorkLogs, liveTurnKey)
      ? expandedWorkLogs[liveTurnKey]
      : (expandedWorkLogChoicesRef.current[liveTurnKey] ?? true);
  const liveAnswer = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.live,
    );
  const liveTurnContent = isStreaming && (
    <div className="live-turn-anchor">
      <TurnProgressCard
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
        streaming
        expanded={liveExpanded}
        transport={transportStatus}
        watchdogMessage={watchdogMessage}
        answer={liveAnswer}
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
    </div>
  );

  return (
    <div className="app-shell">
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
        {settingsOpen && (
          <div className="settings-popover">
            <div className="popover-heading">
              <span>Beállítások</span>
              <span className="popover-hint">azonnal él</span>
            </div>
            <label className="range-row">
              <span>Betűméret</span>
              <output>{fontSize}</output>
              <input
                type="range"
                min="8"
                max="17"
                value={parseInt(fontSize, 10)}
                onChange={(event) => setFontSize(`${event.target.value}px`)}
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
                  setLineHeight((Number(event.target.value) / 100).toFixed(2))
                }
              />
            </label>
            <button
              className="reset-button"
              onClick={() => {
                setFontSize("8px");
                setLineHeight("1.00");
                notify("Olvasási beállítások visszaállítva");
              }}
            >
              Alapértékek visszaállítása
            </button>
            {isTauri && (
              <div className="settings-root-section">
                <div className="settings-section-heading">
                  Projektek gyökere
                </div>
                <div className="settings-root-path" title={workspaceRoot}>
                  {workspaceRoot || "Nincs beállítva OneDrive-gyökér"}
                </div>
                <button
                  type="button"
                  className="settings-root-button"
                  onClick={() => {
                    void changeProjectsRoot();
                  }}
                >
                  Gyökér módosítása
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <div className="local-store-health" role="status" aria-live="polite">
        SQLite · {localStoreStatus}
      </div>

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
        <aside className="sidebar panel-edge">
          <div className="sidebar-heading">
            <span>Projektek</span>
            <div className="new-project-wrap">
              <button
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
          </div>
          <div className="project-list">
            {projects.map((project) => {
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
                      aria-expanded={isOpen}
                      title={project.path}
                    >
                      <span className="chevron">{isOpen ? "⌄" : "›"}</span>
                      <span className="folder-icon">◫</span>
                      <span className="project-name">{project.name}</span>
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
                            title={thread}
                          >
                            <span className="conversation-dot" />
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
                    {tombstones.length > 0 && (
                      <section
                        className="sync-recovery"
                        aria-label="Recovery Center"
                      >
                        <div className="sync-recovery-heading">
                          <strong>Recovery Center</strong>
                          <span>{tombstones.length}</span>
                        </div>
                        <div className="sync-recovery-list">
                          {[...tombstones]
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
                        {tombstones.length > 8 && (
                          <small className="sync-recovery-more">
                            +{tombstones.length - 8} további archivált elem
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
            <button className="footer-action">
              <span>⌕</span> Keresés
            </button>
            <button
              className="footer-action"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
            >
              <span>⚙</span> Beállítások
            </button>
            {settingsOpen && (
              <div className="settings-popover sidebar-settings-popover">
                <div className="popover-heading">
                  <span>Olvasási beállítások</span>
                  <span className="popover-hint">azonnal él</span>
                </div>
                <label className="range-row">
                  <span>Betűméret</span>
                  <output>{fontSize}</output>
                  <input
                    type="range"
                    min="8"
                    max="17"
                    value={parseInt(fontSize, 10)}
                    onChange={(event) => setFontSize(`${event.target.value}px`)}
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
                  className="reset-button"
                  onClick={() => {
                    setFontSize("8px");
                    setLineHeight("1.00");
                    notify("Olvasási beállítások visszaállítva");
                  }}
                >
                  Alapértékek visszaállítása
                </button>
                {isTauri && (
                  <RetentionSettingsSection
                    preview={retentionPreview}
                    selection={retentionSelection}
                    onRefresh={refreshRetention}
                    onAction={runRetentionAction}
                    onSelectAll={selectAllEligibleRetention}
                    onClearSelection={() => setRetentionSelection([])}
                    onPurgeSelected={purgeSelectedRetention}
                    onToggleSelection={toggleRetentionSelection}
                  />
                )}
              </div>
            )}
          </div>
        </aside>

        <section className="chat panel-edge">
          <div className="chat-header">
            <div>
              <div className="eyebrow">{activeProjectData.name}</div>
              <h1>{activeThread || "Nincs beszélgetés"}</h1>
            </div>
            <div className="chat-header-actions">
              <button className="header-icon" title="Keresés a beszélgetésben">
                ⌕
              </button>
              <button
                className="header-icon"
                title="Beszélgetés műveletei"
                onClick={() => {
                  setOpenProjects((current) => ({
                    ...current,
                    [activeProjectData.path]: true,
                  }));
                  setOpenMenu({
                    kind: "thread",
                    key: `${activeProjectData.id}::${activeThread}`,
                  });
                }}
              >
                •••
              </button>
            </div>
          </div>
          <div
            className="message-stream"
            ref={messageStreamRef}
            onScroll={handleMessageScroll}
            onWheelCapture={handleMessageWheel}
          >
            {timelineContent}
            {liveTurnContent}
            {isStreaming && !isAtBottom && (
              <button
                type="button"
                className="jump-to-bottom"
                onClick={jumpToBottom}
              >
                ↓ Legaljára
              </button>
            )}
          </div>
          <form className="composer-wrap" onSubmit={submitMessage}>
            <div className="composer">
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
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleInputKeyDown}
                onPaste={handleInputPaste}
                placeholder="Írj egy üzenetet, vagy illessz be egy screenshotot…"
              />
              <input
                ref={imageInputRef}
                className="hidden-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                tabIndex={-1}
                onChange={handleImageInputChange}
              />
              <div className="composer-toolbar">
                <div className="composer-tools">
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
                  <ModelPicker
                    open={modelMenuOpen}
                    loading={modelsLoading}
                    activeLabel={activeLabel}
                    selectedModel={selectedModel}
                    modelFamilies={modelFamilies}
                    activeFamily={activeFamily}
                    activeEffortLabel={activeEffortLabel}
                    supportedEfforts={supportedEfforts}
                    activeEffortIndex={activeEffortIndex}
                    onToggle={toggleModelMenu}
                    onFamilyHover={setActiveFamilyKey}
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
  );
}

export default App;
