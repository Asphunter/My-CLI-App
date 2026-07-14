import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";
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
  hlc?: string;
  originDeviceId?: string;
};

type Project = { id: string; name: string; path: string; relativePath: string | null; threads: string[] };
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
type AgentRollbackResult = {
  snapshotId: string;
  root: string;
  restoredFiles: number;
  removedFiles: number;
  baseHash: string;
  resultingHash: string;
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
type AgentDiscardResult = {
  snapshotId: string;
  root: string;
  baseHash: string;
  resultingHash: string;
};
type AgentDiffLine = { kind: "context" | "added" | "removed" | "meta"; oldLine: number | null; newLine: number | null; text: string };
type AgentDiffFile = { path: string; status: string; beforeHash: string | null; afterHash: string | null; binaryOrTruncated: boolean; lines: AgentDiffLine[] };
type AgentDiffPreview = {
  snapshotId: string;
  root: string;
  baseHash: string;
  postHash: string;
  currentHash: string;
  currentState: string;
  createdAt: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  files: AgentDiffFile[];
};
type AgentRebaseResult = { snapshotId: string; root: string; originalBaseHash: string; applyBaseHash: string; mergedHash: string; mergedFiles: number; rebased: boolean };
type CodexResponse = { threadId: string; text: string; events?: CodexEvent[]; guard: AgentGuardReport; threadRehydrated?: boolean };
type CodexApprovalRequest = {
  approvalId: string;
  requestId: unknown;
  kind: "command" | "fileChange";
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  params: Record<string, unknown>;
};
type CodexDelta = { threadId: string; delta: string; itemId?: string | null };
type CodexEvent = { threadId: string; eventType: string; payload: unknown };
type WorkItemKind = "status" | "reasoning" | "command" | "file" | "tool";
type WorkItemStatus = "running" | "done" | "error";
type CodeActivity = {
  id: number;
  itemId?: string;
  turnId?: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  label: string;
  detail: string;
  eventType: string;
  time: string;
  body?: string;
  code?: string;
  language?: string;
  hlc?: string;
  originDeviceId?: string;
};
type CodeBlock = { language: string; code: string };
type CodeSnippet = CodeBlock & { id: string; messageIndex: number };
type TimelineOrder = { hlc?: string; originDeviceId?: string; sequence?: number; tieBreaker?: string };
type WorkLogGroup = { key: string; activities: CodeActivity[]; sequence: number; hlc?: string; originDeviceId?: string };
type TimelineEntry =
  | { kind: "message"; key: string; sequence: number; hlc?: string; originDeviceId?: string; tieBreaker: string; message: Message; messageIndex: number }
  | { kind: "work"; key: string; sequence: number; hlc?: string; originDeviceId?: string; tieBreaker: string; group: WorkLogGroup };
type CodexModel = {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
};
type ModelFamily = { key: string; label: string; models: CodexModel[] };
type OpenMenu = { kind: "project" | "thread"; key: string } | null;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
  { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest frontier agentic coding model.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced agentic coding model.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", description: "Fast and affordable agentic coding model.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier model for complex coding.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.4", displayName: "GPT-5.4", description: "Strong model for everyday coding.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", description: "Small, fast coding model.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "medium" },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", description: "Ultra-fast coding model.", supportedReasoningEfforts: FALLBACK_EFFORTS, defaultReasoningEffort: "high" },
];

type AppSound = "notify" | "complete";

const playAppSound = (sound: AppSound) => {
  if (typeof window === "undefined") return;
  const audio = new Audio(`/sounds/${sound}.wav`);
  audio.volume = 0.72;
  void audio.play().catch(() => undefined);
};

const PROJECTS_STORAGE_KEY = "min-projects";
const MESSAGE_HISTORY_STORAGE_KEY = "min-message-history";
const WORK_LOG_STORAGE_KEY = "min-work-log";
const DEVICE_ID_STORAGE_KEY = "min-device-id";
const LOCAL_THREAD_IDS_STORAGE_KEY = "min-local-thread-ids";
const SYNC_SCHEMA_VERSION = 1;
const LOCAL_STORE_SNAPSHOT_VERSION = 4;
const SYNC_POLL_INTERVAL_MS = 15_000;

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

const normalizePath = (path: string) => path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

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

const projectIdFromPath = (path: string, relativePath: string | null = relativeOneDrivePath(path)) => (
  `project-${hashText(relativePath ? `onedrive/${relativePath.toLowerCase()}` : normalizePath(path))}`
);

const projectFromPath = (name: string, path: string, threads?: string[]): Project => {
  const relativePath = relativeOneDrivePath(path);
  return { id: projectIdFromPath(path, relativePath), name, path, relativePath, threads: threads ?? ["Új beszélgetés"] };
};

const resolveSyncedPath = (relativePath: string | null | undefined, pathHint: string | undefined, workspaceRoot: string) => {
  const oneDriveRoot = oneDriveRootFrom(workspaceRoot);
  if (relativePath && oneDriveRoot) return `${oneDriveRoot}\\${relativePath.replaceAll("/", "\\")}`;
  return pathHint ?? workspaceRoot;
};

const syncConversationKey = (projectId: string, title: string) => `${projectId}::${title}`;

const tombstoneMatchesProject = (tombstone: SyncTombstone, project: Project) => (
  tombstone.entityType === "project"
  && (
    tombstone.entityId === project.id
    || Boolean(tombstone.relativePath && project.relativePath && tombstone.relativePath.toLowerCase() === project.relativePath.toLowerCase())
    || Boolean(tombstone.pathHint && normalizePath(tombstone.pathHint) === normalizePath(project.path))
  )
);

const tombstoneMatchesConversation = (tombstone: SyncTombstone, project: Project, title: string, conversationId?: string | null) => (
  tombstone.entityType === "conversation"
  && (!tombstone.title || tombstone.title === title)
  && (
    Boolean(conversationId && tombstone.entityId === conversationId)
    || Boolean(tombstone.projectId && tombstone.projectId === project.id)
    || Boolean(tombstone.relativePath && project.relativePath && tombstone.relativePath.toLowerCase() === project.relativePath.toLowerCase())
    || Boolean(tombstone.pathHint && normalizePath(tombstone.pathHint) === normalizePath(project.path))
  )
);

const getDeviceId = () => {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
};

const createEntityId = () => typeof crypto !== "undefined" && "randomUUID" in crypto
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

const syncTombstoneTypeLabel = (entityType: string) => entityType === "project" ? "Projekt" : "Beszélgetés";

const projectIdentityKey = (project: Pick<Project, "path" | "relativePath">) => (
  project.relativePath?.trim().toLowerCase() || normalizePath(project.path)
);

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
      name: item.name || existing.name,
      threads: [...new Set([...existing.threads, ...item.threads])],
    });
  }
  return [...byIdentity.values()];
};

const loadStoredProjects = (): Project[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]") as Array<Partial<Project>>;
    if (!Array.isArray(saved)) return [];
    return dedupeProjects(saved
      .filter((project) => typeof project.name === "string" && typeof project.path === "string" && project.path.length > 0)
      .map((project) => projectFromPath(project.name as string, project.path as string, Array.isArray(project.threads) ? project.threads.filter((thread): thread is string => typeof thread === "string") : [])));
  } catch {
    return [];
  }
};

const loadInitialMessages = () => {
  const storedProjects = loadStoredProjects();
  const activeProjectName = localStorage.getItem("min-active-project") ?? "";
  const project = storedProjects.find((candidate) => candidate.name === activeProjectName) ?? storedProjects[0];
  const thread = localStorage.getItem("min-active-thread") ?? project?.threads[0];
  return project && thread ? loadThreadMessages(`${project.path}/${thread}`) : [];
};

const compactMessages = (messages: Message[]) => {
  const compacted: Message[] = [];
  for (const message of messages) {
    const previous = compacted[compacted.length - 1];
    if (message.role === "assistant" && message.itemId && previous?.role === "assistant" && previous.itemId === message.itemId) {
      compacted[compacted.length - 1] = {
        ...previous,
        text: `${previous.text}${message.text}`,
        live: Boolean(previous.live || message.live),
        final: Boolean(previous.final || message.final),
      };
    } else {
      compacted.push(message);
    }
  }
  return compacted;
};

const conversationContextForRehydration = (messages: Message[]) => compactMessages(messages)
  .filter((message) => (
    !message.live
    && message.text.trim().length > 0
    && !message.text.startsWith("Nem sikerült a Codex-kérés:")
  ))
  .slice(-40)
  .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`)
  .join("\n\n");

const loadLocalThreadIds = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_THREAD_IDS_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0
      )),
    );
  } catch {
    return {};
  }
};

const timelinePhysicalKey = (hlc?: string, sequence?: number) => {
  const match = hlc?.trim().match(/^(\d{20})-\d{8}$/);
  if (match) return match[1];
  if (typeof sequence === "number" && Number.isFinite(sequence)) return Math.trunc(sequence).toString().padStart(20, "0");
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
  const leftHlc = left.hlc?.trim() ?? "";
  const rightHlc = right.hlc?.trim() ?? "";
  if (leftHlc && rightHlc) {
    return leftHlc.localeCompare(rightHlc)
      || (left.originDeviceId ?? "").localeCompare(right.originDeviceId ?? "")
      || (left.sequence ?? 0) - (right.sequence ?? 0)
      || (left.tieBreaker ?? "").localeCompare(right.tieBreaker ?? "");
  }

  const leftPhysical = timelinePhysicalKey(leftHlc, left.sequence);
  const rightPhysical = timelinePhysicalKey(rightHlc, right.sequence);
  if (leftPhysical && rightPhysical && leftPhysical !== rightPhysical) {
    return leftPhysical.localeCompare(rightPhysical);
  }
  return (left.sequence ?? 0) - (right.sequence ?? 0)
    || (left.originDeviceId ?? "").localeCompare(right.originDeviceId ?? "")
    || (leftHlc ? 1 : 0) - (rightHlc ? 1 : 0)
    || (left.tieBreaker ?? "").localeCompare(right.tieBreaker ?? "");
};

const compareMessages = (left: Message, right: Message) => compareTimelineOrder(
  { hlc: left.hlc, originDeviceId: left.originDeviceId, sequence: left.sequence, tieBreaker: left.id },
  { hlc: right.hlc, originDeviceId: right.originDeviceId, sequence: right.sequence, tieBreaker: right.id },
);

const compareWorkItems = (left: CodeActivity, right: CodeActivity) => compareTimelineOrder(
  { hlc: left.hlc, originDeviceId: left.originDeviceId, sequence: left.id, tieBreaker: left.itemId ?? left.eventType },
  { hlc: right.hlc, originDeviceId: right.originDeviceId, sequence: right.id, tieBreaker: right.itemId ?? right.eventType },
);

const messageMergeKey = (message: Message, index: number) => (
  message.id
    ?? (message.sequence !== undefined ? `sequence:${message.sequence}` : `${message.role}:${message.time}:${index}:${message.text}`)
);

const mergeMessages = (primary: Message[], secondary: Message[] = []) => {
  const merged: Message[] = [];
  const keys = new Set<string>();
  for (const message of [...primary, ...secondary]) {
    const key = messageMergeKey(message, merged.length);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(message);
  }
  return compactMessages(merged).sort(compareMessages);
};

const loadThreadMessages = (key: string): Message[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}") as Record<string, Message[]>;
    const messages = saved[key];
    return Array.isArray(messages)
      ? compactMessages(messages.filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string")).sort(compareMessages)
      : [];
  } catch {
    return [];
  }
};

const loadStoredMessageMap = (): Record<string, Message[]> => {
  try {
    const saved = JSON.parse(localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}") as Record<string, Message[]>;
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
};

const saveThreadMessages = (key: string, messages: Message[]) => {
  try {
    const saved = JSON.parse(localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}") as Record<string, Message[]>;
    localStorage.setItem(MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify({ ...saved, [key]: messages }));
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const workItemKinds = new Set<WorkItemKind>(["status", "reasoning", "command", "file", "tool"]);
const workItemStatuses = new Set<WorkItemStatus>(["running", "done", "error"]);

const inferWorkItemKind = (eventType: string, label = ""): WorkItemKind => {
  const value = `${eventType} ${label}`.toLowerCase();
  if (value.includes("reason") || value.includes("think") || value.includes("gondolk")) return "reasoning";
  if (value.includes("command") || value.includes("terminal") || value.includes("exec") || value.includes("paranc")) return "command";
  if (value.includes("file") || value.includes("change") || value.includes("patch") || value.includes("fájl")) return "file";
  if (value.includes("tool") || value.includes("mcp") || value.includes("search") || value.includes("eszköz")) return "tool";
  return "status";
};

const normalizeWorkItem = (value: unknown, index: number): CodeActivity | null => {
  const raw = asRecord(value);
  if (typeof raw.label !== "string" || typeof raw.detail !== "string") return null;
  const eventType = typeof raw.eventType === "string" ? raw.eventType : "work/item";
  const label = raw.label;
  const kind = typeof raw.kind === "string" && workItemKinds.has(raw.kind as WorkItemKind)
    ? raw.kind as WorkItemKind
    : inferWorkItemKind(eventType, label);
  const status = typeof raw.status === "string" && workItemStatuses.has(raw.status as WorkItemStatus)
    ? raw.status as WorkItemStatus
    : /completed|finished|succeeded|done/i.test(eventType) ? "done" : /error|failed|rejected/i.test(eventType) ? "error" : "running";
  const id = typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : index;
  return {
    id,
    itemId: typeof raw.itemId === "string" ? raw.itemId : undefined,
    turnId: typeof raw.turnId === "string" ? raw.turnId : undefined,
    kind,
    status,
    label,
    detail: raw.detail,
    eventType,
    time: typeof raw.time === "string" ? raw.time : "most",
    body: typeof raw.body === "string" ? raw.body : undefined,
    code: typeof raw.code === "string" ? raw.code : undefined,
    language: typeof raw.language === "string" ? raw.language : undefined,
    hlc: typeof raw.hlc === "string" ? raw.hlc : undefined,
    originDeviceId: typeof raw.originDeviceId === "string" ? raw.originDeviceId : undefined,
  };
};

const workItemMergeKey = (item: CodeActivity) => (
  item.itemId ?? `${item.id}:${item.eventType}:${item.detail}`
);

const mergeWorkItems = (primary: CodeActivity[], secondary: CodeActivity[] = []) => {
  const merged: CodeActivity[] = [];
  const keys = new Set<string>();
  for (const item of [...primary, ...secondary]) {
    const key = workItemMergeKey(item);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(item);
  }
  return merged.sort(compareWorkItems);
};

const loadThreadWorkItems = (key: string): CodeActivity[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const items = saved[key];
    return Array.isArray(items)
      ? items.map((item, index) => normalizeWorkItem(item, index)).filter((item): item is CodeActivity => Boolean(item)).sort(compareWorkItems)
      : [];
  } catch {
    return [];
  }
};

const loadStoredWorkItemMap = (): Record<string, CodeActivity[]> => {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(saved).map(([key, items]) => [
      key,
      Array.isArray(items)
        ? items.map((item, index) => normalizeWorkItem(item, index)).filter((item): item is CodeActivity => Boolean(item))
        : [],
    ]));
  } catch {
    return {};
  }
};

const saveThreadWorkItems = (key: string, items: CodeActivity[]) => {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}") as Record<string, CodeActivity[]>;
    localStorage.setItem(WORK_LOG_STORAGE_KEY, JSON.stringify({ ...saved, [key]: items }));
  } catch {
    // A storage quota error must not break the conversation.
  }
};

const removeThreadWorkItems = (key: string) => {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_LOG_STORAGE_KEY) ?? "{}") as Record<string, CodeActivity[]>;
    delete saved[key];
    localStorage.setItem(WORK_LOG_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage error must not block renaming.
  }
};

const removeThreadMessages = (key: string) => {
  try {
    const saved = JSON.parse(localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY) ?? "{}") as Record<string, Message[]>;
    delete saved[key];
    localStorage.setItem(MESSAGE_HISTORY_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // A storage error must not block renaming.
  }
};

const messagesForSync = (messages: Message[]) => compactMessages(messages).map((message) => ({ ...message, live: false }));

const isSyncState = (value: unknown): value is SyncState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<SyncState>;
  return state.schemaVersion === SYNC_SCHEMA_VERSION
    && typeof state.deviceId === "string" && state.deviceId.length > 0
    && typeof state.updatedAt === "string" && state.updatedAt.length > 0
    && Array.isArray(state.projects)
    && typeof state.conversations === "object" && state.conversations !== null && !Array.isArray(state.conversations);
};

const asRecord = (value: unknown): Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

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
  const eventType = typeof envelope.eventType === "string"
    ? envelope.eventType
    : typeof envelope.event_type === "string"
      ? envelope.event_type
      : typeof envelope.method === "string" ? envelope.method : "";
  if (!eventType) return null;
  const threadId = typeof envelope.threadId === "string"
    ? envelope.threadId
    : typeof envelope.thread_id === "string" ? envelope.thread_id : "";
  const payload = Object.prototype.hasOwnProperty.call(envelope, "payload")
    ? envelope.payload
    : Object.prototype.hasOwnProperty.call(envelope, "params") ? envelope.params : envelope;
  return { threadId, eventType, payload };
};

const normalizeCodexDelta = (value: unknown): CodexDelta | null => {
  const envelope = asRecord(parseEventValue(value));
  const delta = typeof envelope.delta === "string" ? envelope.delta : "";
  if (!delta) return null;
  const itemId = typeof envelope.itemId === "string"
    ? envelope.itemId
    : typeof envelope.item_id === "string" ? envelope.item_id : undefined;
  return { threadId: typeof envelope.threadId === "string" ? envelope.threadId : "", delta, itemId };
};

const appendCodexDelta = (messages: Message[], delta: CodexDelta) => {
  const itemId = delta.itemId ?? undefined;
  let targetIndex = -1;
  if (itemId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.live && message.role === "assistant" && message.itemId === itemId) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.live && message.role === "assistant" && (!itemId || !message.itemId || message.itemId === itemId)) {
        targetIndex = index;
        break;
      }
    }
  }
  if (targetIndex >= 0) {
    const target = messages[targetIndex];
    return messages.map((message, index) => index === targetIndex
      ? { ...message, itemId: itemId ?? message.itemId, text: `${target.text}${delta.delta}`, final: false }
      : message);
  }
  const sequence = messages.reduce((maximum, message, index) => Math.max(maximum, message.sequence ?? index), 0) + 1;
  return [...messages, { id: createEntityId(), role: "assistant" as const, time: "most", text: delta.delta, live: true, final: false, itemId, sequence }];
};

const extractCodeLike = (value: unknown, keyHint = ""): string | undefined => {
  if (typeof value === "string") {
    const normalizedKey = keyHint.toLowerCase().replaceAll("_", "");
    if (/(diff|patch|code|source|content|newcontent|filecontent)/.test(normalizedKey) && value.trim().length > 20) return value;
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
    if (/(filepath|filename|path)/.test(normalizedKey) && value.trim().length > 0) return value;
    if (normalizedKey === "name" && /\.[a-z0-9]{1,8}$/i.test(value.trim())) return value;
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
  const matches = text.match(/(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:py|js|jsx|ts|tsx|rs|go|java|cpp|c|h|json|yaml|yml|html|css|md|txt|toml|ini|sh|bat|ps1)\b/gi) ?? [];
  return [...new Set(matches)];
};

const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim().length > 0);

const eventTurnId = (event: CodexEvent, params: Record<string, unknown>, item: Record<string, unknown>) => firstString(
  params.turnId,
  params.turn_id,
  asRecord(params.turn).id,
  item.turnId,
  item.turn_id,
  params.threadId,
) ?? `thread:${event.threadId}`;

const eventItemId = (event: CodexEvent, params: Record<string, unknown>, item: Record<string, unknown>) => {
  if (event.eventType.startsWith("turn/")) return firstString(params.turnId, params.turn_id, asRecord(params.turn).id) ?? `turn:${event.threadId}`;
  return firstString(
    params.itemId,
    params.item_id,
    params.callId,
    params.call_id,
    item.id,
    item.itemId,
  );
};

const eventItemType = (event: CodexEvent, params: Record<string, unknown>, item: Record<string, unknown>) => (
  firstString(item.type, params.itemType, params.type) ?? (event.eventType.startsWith("turn/") ? "turn" : "")
);

const workItemStatus = (event: CodexEvent, item: Record<string, unknown>): WorkItemStatus => {
  const value = `${event.eventType} ${firstString(item.status, item.state) ?? ""}`.toLowerCase();
  if (value.includes("error") || value.includes("failed") || value.includes("failure") || value.includes("rejected")) return "error";
  if (value.includes("completed") || value.includes("finished") || value.includes("succeeded") || value.includes("success") || value.includes("done")) return "done";
  return "running";
};

const workItemLabel = (event: CodexEvent, kind: WorkItemKind, status: WorkItemStatus) => {
  if (event.eventType === "turn/started") return "Feladat indult";
  if (event.eventType === "turn/completed") return "Feladat kész";
  if (status === "error") return "Hiba a munkafolyamatban";
  const isCompleted = status === "done";
  if (kind === "reasoning") return isCompleted ? "Gondolkodás kész" : "Gondolkodás";
  if (kind === "command") return isCompleted ? "Parancs kész" : "Parancs fut";
  if (kind === "file") return isCompleted ? "Fájlművelet kész" : "Fájlművelet folyamatban";
  if (kind === "tool") return isCompleted ? "Eszköz kész" : "Eszköz fut";
  return isCompleted ? "Részfeladat kész" : "Részfeladat";
};

const summarizeCodexWorkEvent = (event: CodexEvent, id: number, turnId?: string): CodeActivity | null => {
  const params = asRecord(event.payload);
  const item = asRecord(params.item);
  const itemType = eventItemType(event, params, item);
  if (itemType.toLowerCase() === "agentmessage" || event.eventType.startsWith("item/agentMessage/")) return null;

  const itemId = eventItemId(event, params, item);
  const filePath = firstString(params.path, params.filePath, item.path, item.filePath, item.filename, item.name, extractFilePath(event.payload));
  const kind = inferWorkItemKind(`${event.eventType} ${itemType}`);
  const status = workItemStatus(event, item);
  const command = firstString(params.command, params.commandLine, item.command, item.commandLine, params.input, item.input);
  const tool = firstString(params.tool, params.toolName, item.tool, item.toolName, item.serverName, item.method, item.name);
  const detail = kind === "file"
    ? filePath ?? firstString(item.title, params.description) ?? itemType
    : kind === "command"
      ? command ?? filePath ?? itemType
      : kind === "tool"
        ? tool ?? itemType
        : firstString(item.title, item.name, params.description, params.status) ?? (event.eventType.startsWith("turn/") ? "" : itemType);

  const rawBody = kind === "reasoning"
    ? firstString(params.delta, params.summaryTextDelta, params.text, params.summary, item.text, item.summary)
    : kind === "command" || kind === "tool" || kind === "file"
      ? firstString(params.output, params.stdout, params.stderr, params.delta, item.output, item.stdout, item.stderr)
      : firstString(params.description, params.summary, item.description, item.summary);
  const body = rawBody && rawBody !== detail ? rawBody : undefined;
  const rawCode = params.code ?? params.patch ?? params.diff ?? item.code ?? item.patch ?? item.diff ?? extractCodeLike(event.payload);
  const code = typeof rawCode === "string" && rawCode.trim().length > 0 ? rawCode : undefined;
  const extension = filePath?.split(/[\\/.]/).pop()?.toLowerCase();
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
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    body,
    code,
    language,
  };
};

const mergeCodeActivity = (current: CodeActivity[], incoming: CodeActivity) => {
  const existingIndex = incoming.itemId ? current.findIndex((item) => item.itemId === incoming.itemId) : -1;
  if (existingIndex < 0) return [...current, incoming].sort((a, b) => a.id - b.id).slice(-80);

  const existing = current[existingIndex];
  const isDelta = incoming.eventType.toLowerCase().includes("delta");
  const body = incoming.body
    ? isDelta && existing.body ? `${existing.body}${incoming.body}`.slice(-24000) : incoming.body
    : existing.body;
  const code = incoming.code
    ? isDelta && existing.code ? `${existing.code}${incoming.code}` : incoming.code
    : existing.code;
  const status = incoming.status === "running" && existing.status !== "running" ? existing.status : incoming.status;
  const merged = { ...existing, ...incoming, id: existing.id, status, body, code, detail: incoming.detail || existing.detail };
  return current.map((item, index) => index === existingIndex ? merged : item).sort((a, b) => a.id - b.id).slice(-80);
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
    blocks.push({ language: match[1].trim() || "text", code: match[2].replace(/^\n/, "").trimEnd() });
  }
  const markers = [...text.matchAll(fenceMarkerPattern)];
  if (markers.length % 2 === 1) {
    const start = markers[markers.length - 1].index ?? text.length;
    const remainder = text.slice(start + 3);
    const newline = remainder.search(/\r?\n/);
    if (newline >= 0) blocks.push({ language: remainder.slice(0, newline).trim() || "text", code: remainder.slice(newline + (remainder[newline] === "\r" ? 2 : 1)).trimEnd() });
  }
  return blocks;
};

const textWithoutCodeBlocks = (text: string) => stripUnclosedCodeBlock(text
  .replace(fencedCodePattern, ""))
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const inlineMarkdownPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^\)]+\))/g;

const renderInlineMarkdown = (text: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlineMarkdownPattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    if (value.startsWith("`") && value.endsWith("`")) {
      parts.push(<code className="inline-code" key={`inline-${index}`}>{value.slice(1, -1)}</code>);
    } else if (value.startsWith("**")) {
      parts.push(<strong key={`bold-${index}`}>{value.slice(2, -2)}</strong>);
    } else {
      const link = value.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
      if (link) parts.push(<a href={link[2]} target="_blank" rel="noreferrer" key={`link-${index}`}>{link[1]}</a>);
      else parts.push(value);
    }
    cursor = index + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
};

const codeKeywords = new Set([
  "and", "as", "async", "await", "break", "case", "class", "const", "continue", "def", "else", "elif", "export", "extends", "finally", "for", "from", "fn", "function", "if", "import", "in", "let", "match", "new", "None", "not", "null", "of", "or", "pass", "pub", "return", "self", "static", "struct", "switch", "this", "throw", "try", "type", "use", "var", "while", "with", "yield",
]);
const codeConstants = new Set(["True", "False", "None", "true", "false", "null", "undefined"]);
const codeTokenPattern = /(#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|=>|===|!==|==|!=|<=|>=|[()[\]{}:.,=+\-*\/%<>])/g;

const highlightCode = (code: string): ReactNode[] => {
  const tokens: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(codeTokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) tokens.push(code.slice(cursor, index));
    const afterToken = code.slice(index + token.length);
    let className = "code-punctuation";
    if (token.startsWith("#") || token.startsWith("//")) className = "code-comment";
    else if (/^[\"'`]/.test(token)) className = "code-string";
    else if (/^\d/.test(token)) className = "code-number";
    else if (codeConstants.has(token)) className = "code-constant";
    else if (codeKeywords.has(token)) className = "code-keyword";
    else if (/^[A-Za-z_$]/.test(token) && /^\s*\(/.test(afterToken)) className = "code-function";
    tokens.push(<span className={className} key={`token-${index}`}>{token}</span>);
    cursor = index + token.length;
  }
  if (cursor < code.length) tokens.push(code.slice(cursor));
  return tokens;
};

const modelLabel = (model: CodexModel) => model.displayName
  .replace("GPT-5.6-", "GPT-5.6 ")
  .replace("GPT-5.5-", "GPT-5.5 ")
  .replace("GPT-5.4-", "GPT-5.4 ");

const familyVariantLabel = (family: ModelFamily, model: CodexModel) => {
  if (family.key === "gpt-5.6") {
    return model.id.replace("gpt-5.6-", "").replace(/^./, (letter) => letter.toUpperCase());
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

function ModelPicker({ open, loading, activeLabel, selectedModel, modelFamilies, activeFamily, activeEffortLabel, supportedEfforts, activeEffortIndex, onToggle, onFamilyHover, onSelectModel, onSelectEffort }: ModelPickerProps) {
  return (
    <div className="model-picker">
      <button type="button" className="model-chip" onClick={onToggle} aria-haspopup="menu" aria-expanded={open}>
        <span>{activeLabel} · {activeEffortLabel}</span><span className="model-chevron">⌄</span>
      </button>
      {open && <div className="model-menu model-menu-nested" role="menu" aria-label="Modell kiválasztása">
        <div className="model-menu-body">
          <div className="model-families">
            <button type="button" className={`model-family-option${selectedModel === null ? " is-selected" : ""}`} onClick={() => onSelectModel(null)}><span>Automatikus</span><span>{selectedModel === null ? "✓" : ""}</span></button>
            {modelFamilies.map((family) => <button type="button" className={`model-family-option${family.key === activeFamily?.key ? " is-open" : ""}`} onMouseEnter={() => onFamilyHover(family.key)} onFocus={() => onFamilyHover(family.key)} onClick={() => onFamilyHover(family.key)} key={family.key}><span>{family.label}</span><span>›</span></button>)}
          </div>
          <div className="model-variants">
            {activeFamily ? <>
              <div className="model-menu-label">{activeFamily.label === "Codex" ? "Codex" : `GPT-${activeFamily.label}`}</div>
              {activeFamily.models.map((model) => <button type="button" className={`model-variant${model.id === selectedModel ? " is-selected" : ""}`} onClick={() => onSelectModel(model.id)} key={model.id}><span><strong>{familyVariantLabel(activeFamily, model)}</strong><small>{model.description}</small></span><span className="model-check">{model.id === selectedModel ? "✓" : ""}</span></button>)}
            </> : <div className="model-empty">Válassz modellcsaládot</div>}
          </div>
        </div>
        <div className="reasoning-control">
          <div className="reasoning-heading"><span>Reasoning</span><strong>{activeEffortLabel}</strong></div>
          <input className="reasoning-slider" type="range" min="0" max={Math.max(0, supportedEfforts.length - 1)} step="1" value={activeEffortIndex} onChange={(event) => onSelectEffort(Number(event.target.value))} aria-label="Reasoning erőssége" />
          <div className="reasoning-scale"><span>{EFFORT_LABELS[supportedEfforts[0]] ?? supportedEfforts[0]}</span><span>{loading ? "modellek betöltése…" : EFFORT_LABELS[supportedEfforts[supportedEfforts.length - 1]] ?? supportedEfforts[supportedEfforts.length - 1]}</span></div>
        </div>
      </div>}
    </div>
  );
}

function MessageRow({ message, isFinal, showAvatar = true }: { message: Message; isFinal?: boolean; showAvatar?: boolean }) {
  const visibleText = textWithoutCodeBlocks(message.text);
  const final = isFinal ?? message.final;
  const isPending = message.role === "assistant" && !message.text.trim() && !final;

  return (
    <article className={`message ${message.role === "user" ? "user-message" : "assistant-message"}${final ? " is-final" : ""}${!showAvatar ? " no-avatar" : ""}`}>
      <span className={`avatar ${message.role === "user" ? "user-avatar" : "assistant-avatar"}`}>{showAvatar ? (message.role === "user" ? "D" : "m") : ""}</span>
      <div className="message-content">
        <div className={`message-body${isPending ? " is-pending" : ""}`}>
          {visibleText && <p>{renderInlineMarkdown(visibleText)}</p>}
          {isPending && <div className="assistant-pending" aria-label="A min válaszol"><span /><span /><span /></div>}
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

function WorkLogCard({ expanded, activities, snippets, status, streaming, onToggle }: CodeWorkCardProps) {
  const visibleActivities = [...activities].sort((a, b) => a.id - b.id).slice(-32);
  const label = visibleActivities.length > 0 ? (streaming ? "Munkafolyamat folyamatban" : "Munkafolyamat") : "Kód";
  return (
    <article className={`code-work-card work-log-card${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}>
      <button type="button" className="code-work-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        <span className="code-work-status">{streaming ? "folyamatban" : status}</span>
        <span className="code-work-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && <div className="code-work-body" role="log" aria-live={streaming ? "polite" : undefined}>
        {visibleActivities.map((activity) => <div className={`code-work-activity work-item-${activity.kind} work-item-${activity.status}`} key={`activity-${activity.itemId ?? activity.id}`}>
          <span className="code-work-marker">{workKindIcons[activity.kind]}</span>
          <div className="work-item-content">
            <div className="work-item-heading"><strong>{activity.label}</strong><span className="work-item-state">{workStatusLabels[activity.status]}</span><time>{activity.time}</time></div>
            {activity.detail && <code>{activity.detail}</code>}
            {activity.body && (activity.kind === "reasoning" ? <p className="work-item-body">{activity.body}</p> : <pre className="work-item-output">{activity.body}</pre>)}
            {activity.code && <><small className="code-work-language">{activity.language ?? "diff"}</small><pre><code>{highlightCode(activity.code)}</code></pre></>}
          </div>
        </div>)}
        {snippets.map((snippet) => <div className="code-work-snippet" key={`inline-${snippet.id}`}><div className="code-work-snippet-label">{snippet.language}</div><pre><code>{highlightCode(snippet.code)}</code></pre></div>)}
        {streaming && visibleActivities.length === 0 && <div className="code-work-placeholder"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /> Codex dolgozik…</div>}
      </div>}
    </article>
  );
}

function WorkFlowCard({ expanded, activities, snippets, status, streaming, onToggle }: CodeWorkCardProps) {
  const [selectedItem, setSelectedItem] = useState<{ type: "activity" | "snippet"; id: string } | null>(null);
  const visibleActivities = [...activities].sort((a, b) => a.id - b.id).slice(-32);
  const selectedActivity = selectedItem?.type === "activity"
    ? visibleActivities.find((activity) => `activity-${activity.itemId ?? activity.id}` === selectedItem.id)
    : undefined;
  const selectedSnippet = selectedItem?.type === "snippet"
    ? snippets.find((snippet) => `snippet-${snippet.id}` === selectedItem.id)
    : undefined;
  const label = visibleActivities.length > 0 ? (streaming ? "Munkafolyamat folyamatban" : "Munkafolyamat") : "Kód";
  const iconFor = (activity: CodeActivity) => {
    if (activity.status === "error") return "!";
    if (activity.kind === "reasoning") return "◌";
    if (activity.kind === "command") return "›_";
    if (activity.kind === "file") return "□";
    if (activity.kind === "tool") return "◇";
    return "•";
  };
  return (
    <article className={`code-work-card work-log-card${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}>
      <button type="button" className="code-work-header" onClick={onToggle} aria-expanded={expanded}>
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        {visibleActivities.length > 0 && <span className="code-work-count">{visibleActivities.length} lépés</span>}
        <span className="code-work-status">{streaming ? "folyamatban" : status}</span>
        <span className="code-work-chevron">{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && <div className="work-flow-panel" role="region" aria-label="Munkafolyamat részletei" aria-live={streaming ? "polite" : undefined}>
        <div className="work-flow-track" role="list" aria-label="Munkafolyamat lépései">
          {visibleActivities.map((activity, index) => {
            const id = `activity-${activity.itemId ?? activity.id}`;
            const canInspect = activity.status === "error" || !["reasoning", "status"].includes(activity.kind);
            const icon = iconFor(activity);
            return <div className="work-flow-step" role="listitem" key={id}>
              {canInspect ? <button type="button" className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}${selectedItem?.id === id ? " is-selected" : ""}`} onClick={() => setSelectedItem((current) => current?.id === id ? null : { type: "activity", id })} title={`${activity.label}: ${activity.detail || workStatusLabels[activity.status]}`} aria-label={activity.label} aria-pressed={selectedItem?.id === id}>{icon}</button>
                : <span className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}`} title={activity.label} aria-label={activity.label} aria-disabled="true">{icon}</span>}
              {index < visibleActivities.length - 1 && <span className="work-flow-arrow" aria-hidden="true">→</span>}
            </div>;
          })}
          {visibleActivities.length === 0 && <span className="work-flow-placeholder"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /> Codex dolgozik…</span>}
        </div>
        {snippets.length > 0 && <div className="work-flow-code-links" aria-label="Kódrészletek">
          {snippets.map((snippet) => {
            const id = `snippet-${snippet.id}`;
            return <button type="button" className={`work-flow-code-link${selectedItem?.id === id ? " is-selected" : ""}`} key={id} onClick={() => setSelectedItem((current) => current?.id === id ? null : { type: "snippet", id })} aria-pressed={selectedItem?.id === id}><span>⌘</span>{snippet.language}</button>;
          })}
        </div>}
        {(selectedActivity || selectedSnippet) ? <div className="work-flow-detail">
          <div className="work-flow-detail-header"><span className="work-flow-detail-icon">{selectedActivity ? iconFor(selectedActivity) : "⌘"}</span><strong>{selectedActivity?.label ?? `Kódrészlet · ${selectedSnippet?.language ?? "text"}`}</strong><button type="button" className="work-flow-detail-close" onClick={() => setSelectedItem(null)} aria-label="Részlet bezárása">×</button></div>
          {selectedActivity?.detail && <code className="work-flow-detail-path">{selectedActivity.detail}</code>}
          {selectedActivity?.body && <pre className="work-flow-detail-output">{selectedActivity.body}</pre>}
          {selectedActivity?.code && <><small className="code-work-language">{selectedActivity.language ?? "diff"}</small><pre className="work-flow-detail-code"><code>{highlightCode(selectedActivity.code)}</code></pre></>}
          {selectedSnippet && <pre className="work-flow-detail-code"><code>{highlightCode(selectedSnippet.code)}</code></pre>}
        </div> : null}
      </div>}
    </article>
  );
}

function CompactWorkFlowCard({ expanded, activities, snippets, streaming, onToggle }: CodeWorkCardProps) {
  const [selectedItem, setSelectedItem] = useState<{ type: "activity" | "snippet"; id: string } | null>(null);
  const visibleActivities = [...activities].sort((a, b) => a.id - b.id).slice(-32);
  const flowActivities = visibleActivities.filter((activity) => activity.kind !== "reasoning");
  const selectedActivity = selectedItem?.type === "activity"
    ? flowActivities.find((activity) => `activity-${activity.itemId ?? activity.id}` === selectedItem.id)
    : undefined;
  const selectedSnippet = selectedItem?.type === "snippet"
    ? snippets.find((snippet) => `snippet-${snippet.id}` === selectedItem.id)
    : undefined;
  const iconFor = (activity: CodeActivity) => activity.status === "error"
    ? "!"
    : activity.kind === "command" ? "›_"
      : activity.kind === "file" ? "□"
        : activity.kind === "tool" ? "◇"
          : "•";
  const label = "Munkafolyamat";

  return (
    <article className={`code-work-card work-log-card compact-work-flow${expanded ? " is-expanded" : ""}${streaming ? " is-live" : ""}`}>
      <button type="button" className="code-work-header" onClick={() => { setSelectedItem(null); onToggle(); }} aria-expanded={expanded}>
        <span className={`code-work-dot${streaming ? " is-live" : ""}`} />
        <strong>{label}</strong>
        {flowActivities.length > 0 && <span className="code-work-count">{flowActivities.length} lépés</span>}
      </button>
      {expanded && <div className="work-flow-panel" role="region" aria-label="Munkafolyamat részletei" aria-live={streaming ? "polite" : undefined}>
        <div className="work-flow-track" role="list" aria-label="Munkafolyamat lépései">
          {flowActivities.map((activity, index) => {
            const id = `activity-${activity.itemId ?? activity.id}`;
            const canInspect = activity.status === "error" || !["status"].includes(activity.kind);
            return <div className="work-flow-step" role="listitem" key={id}>
              {canInspect ? <button type="button" className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}${selectedItem?.id === id ? " is-selected" : ""}`} onClick={() => setSelectedItem((current) => current?.id === id ? null : { type: "activity", id })} title={`${activity.label}: ${activity.detail || workStatusLabels[activity.status]}`} aria-label={activity.label} aria-pressed={selectedItem?.id === id}>{iconFor(activity)}</button>
                : <span className={`work-flow-node work-item-${activity.kind} work-item-${activity.status}`} title={activity.label} aria-label={activity.label} aria-disabled="true">•</span>}
              {index < flowActivities.length - 1 && <div className="work-flow-connector"><span className="work-flow-arrow" aria-hidden="true">→</span></div>}
            </div>;
          })}
          {visibleActivities.length === 0 && <span className="work-flow-placeholder"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /> Codex dolgozik…</span>}
        </div>
        {snippets.length > 0 && <div className="work-flow-code-links" aria-label="Kódrészletek">
          {snippets.map((snippet) => {
            const id = `snippet-${snippet.id}`;
            return <button type="button" className={`work-flow-code-link${selectedItem?.id === id ? " is-selected" : ""}`} key={id} onClick={() => setSelectedItem((current) => current?.id === id ? null : { type: "snippet", id })} aria-pressed={selectedItem?.id === id}><span>⌘</span>{snippet.language}</button>;
          })}
        </div>}
        {(selectedActivity || selectedSnippet) ? <div className="work-flow-detail">
          <div className="work-flow-detail-header"><span className="work-flow-detail-icon">{selectedActivity ? iconFor(selectedActivity) : "⌘"}</span><strong>{selectedActivity?.label ?? `Kódrészlet · ${selectedSnippet?.language ?? "text"}`}</strong><button type="button" className="work-flow-detail-close" onClick={() => setSelectedItem(null)} aria-label="Részlet bezárása">×</button></div>
          {selectedActivity?.detail && <code className="work-flow-detail-path">{selectedActivity.detail}</code>}
          {selectedActivity?.body && <pre className="work-flow-detail-output">{selectedActivity.body}</pre>}
          {selectedActivity?.code && <><small className="code-work-language">{selectedActivity.language ?? "diff"}</small><pre className="work-flow-detail-code"><code>{highlightCode(selectedActivity.code)}</code></pre></>}
          {selectedSnippet && <pre className="work-flow-detail-code"><code>{highlightCode(selectedSnippet.code)}</code></pre>}
        </div> : null}
      </div>}
    </article>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>(loadStoredProjects);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [activeProject, setActiveProject] = useState(() => localStorage.getItem("min-active-project") ?? "");
  const [activeThread, setActiveThread] = useState(() => localStorage.getItem("min-active-thread") ?? "Új beszélgetés");
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Message[]>(loadInitialMessages);
  const [input, setInput] = useState("");
  const [readingDefaults] = useState(() => {
    if (localStorage.getItem("min-reading-settings-version") !== READING_SETTINGS_VERSION) {
      localStorage.setItem("min-reading-settings-version", READING_SETTINGS_VERSION);
      return { fontSize: "8px", lineHeight: "1.00" };
    }
    return { fontSize: localStorage.getItem("min-font-size") ?? "8px", lineHeight: localStorage.getItem("min-line-height") ?? "1.00" };
  });
  const [fontSize, setFontSize] = useState(readingDefaults.fontSize);
  const [lineHeight, setLineHeight] = useState(readingDefaults.lineHeight);
  const [threadIds, setThreadIds] = useState<Record<string, string>>(loadLocalThreadIds);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [activeFamilyKey, setActiveFamilyKey] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<CodexModel[]>(fallbackModels);
  const [modelsLoading, setModelsLoading] = useState(isTauri);
  const [selectedModel, setSelectedModel] = useState<string | null>(() => {
    if (localStorage.getItem("min-model-version") !== MODEL_PREFERENCE_VERSION) {
      localStorage.setItem("min-model-version", MODEL_PREFERENCE_VERSION);
      return DEFAULT_MODEL;
    }
    return localStorage.getItem("min-model") ?? DEFAULT_MODEL;
  });
  const [selectedEffort, setSelectedEffort] = useState(() => {
    if (localStorage.getItem("min-effort-version") !== EFFORT_PREFERENCE_VERSION) {
      localStorage.setItem("min-effort-version", EFFORT_PREFERENCE_VERSION);
      return DEFAULT_EFFORT;
    }
    return localStorage.getItem("min-effort") ?? DEFAULT_EFFORT;
  });
  const [expandedWorkLogs, setExpandedWorkLogs] = useState<Record<string, boolean>>({});
  const [codeActivity, setCodeActivity] = useState<CodeActivity[]>([]);
  const [codeStatus, setCodeStatus] = useState("készen");
  const [agentGuard, setAgentGuard] = useState<AgentGuardReport | null>(null);
  const [agentDiffPreview, setAgentDiffPreview] = useState<AgentDiffPreview | null>(null);
  const [pendingApproval, setPendingApproval] = useState<CodexApprovalRequest | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toast, setToast] = useState("");
  const [syncReady, setSyncReady] = useState(!isTauri);
  const [syncWriteEnabled, setSyncWriteEnabled] = useState(!isTauri);
  const [syncStatus, setSyncStatus] = useState(isTauri ? "szinkronizálás" : "helyi");
  const [syncHealth, setSyncHealth] = useState<SyncHealth | null>(null);
  const [syncHealthOpen, setSyncHealthOpen] = useState(false);
  const [retentionPreview, setRetentionPreview] = useState<SyncRetentionPreview | null>(null);
  const [retentionSelection, setRetentionSelection] = useState<string[]>([]);
  const [localStoreStatus, setLocalStoreStatus] = useState(isTauri ? "ellenőrzés" : "böngésző");
  const [localStoreReady, setLocalStoreReady] = useState(!isTauri);
  const [localStoreWriteEnabled, setLocalStoreWriteEnabled] = useState(!isTauri);
  const [localConversationCache, setLocalConversationCache] = useState<Record<string, SyncConversation>>({});
  const [tombstones, setTombstones] = useState<SyncTombstone[]>([]);
  const projectMutationRevisionRef = useRef(0);
  const pendingLocalMutationRef = useRef(false);
  const snapshotWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  const markProjectMutation = () => {
    projectMutationRevisionRef.current += 1;
    pendingLocalMutationRef.current = true;
  };

  const activeProjectData = useMemo(() => projects.find((project) => project.name === activeProject) ?? projects[0] ?? { id: "", name: "Projekt", path: workspaceRoot, relativePath: relativeOneDrivePath(workspaceRoot), threads: [] }, [activeProject, projects, workspaceRoot]);
  const activeProjectPath = activeProjectData?.path ?? workspaceRoot;
  const threadKey = `${activeProjectPath}/${activeThread}`;
  const messageKeyRef = useRef(threadKey);
  const workLogKeyRef = useRef<string | null>(null);
  const localConversationCacheRef = useRef(localConversationCache);
  localConversationCacheRef.current = localConversationCache;
  const timelineSequenceRef = useRef(Date.now());
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const messageStreamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shouldStickToBottom = useRef(true);
  const autoScrollFrameRef = useRef<number | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeProjectPathRef = useRef(activeProjectPath);
  const isStreamingRef = useRef(isStreaming);
  activeProjectPathRef.current = activeProjectPath;
  isStreamingRef.current = isStreaming;

  const maxKnownTimelineSequence = [
    Date.now(),
    ...messages.map((message) => message.sequence ?? 0),
    ...messages.map((message) => timelinePhysicalMillis(message.hlc)),
    ...codeActivity.map((activity) => activity.id),
    ...codeActivity.map((activity) => timelinePhysicalMillis(activity.hlc)),
  ].filter(Number.isFinite).reduce((maximum, value) => Math.max(maximum, value), 0);
  timelineSequenceRef.current = Math.max(timelineSequenceRef.current, maxKnownTimelineSequence + 1);

  const messagesForThread = (key: string) => localConversationCacheRef.current[key]?.messages ?? loadThreadMessages(key);
  const workItemsForThread = (key: string) => localConversationCacheRef.current[key]?.workItems ?? loadThreadWorkItems(key);

  const nextTimelineSequence = () => {
    const sequence = timelineSequenceRef.current;
    timelineSequenceRef.current += 1;
    return sequence;
  };

  const refreshSync = () => {
    if (!isTauri || !workspaceRoot || !localStoreReady) return;
    if (isStreamingRef.current) {
      setToast("Aktív stream közben a sync pull szünetel.");
      return;
    }
    setSyncStatus("frissítés…");
    setSyncHealthOpen(false);
    setSyncReady(false);
  };

  const rollbackAgentSnapshot = () => {
    if (!isTauri || !agentGuard?.rollbackAvailable) return;
    const changedCount = agentGuard.changedFiles.length + agentGuard.addedFiles.length + agentGuard.removedFiles.length;
    if (!window.confirm(`Visszaállítod az agent-turn előtti állapotot?\n\nÉrintett fájlok: ${changedCount}\nBase-hash: ${agentGuard.baseHash}\n\nA rollback csak akkor fut le, ha a projekt azóta változatlan.`)) return;
    setCodeStatus("rollback…");
    void invoke<AgentRollbackResult>("codex_rollback_snapshot", { snapshotId: agentGuard.snapshotId })
      .then((result) => {
        setAgentGuard((current) => current ? {
          ...current,
          postHash: result.resultingHash,
          changedFiles: [],
          addedFiles: [],
          removedFiles: [],
        } : current);
        setAgentDiffPreview(null);
        setCodeStatus("rollback kész");
        notify(`Rollback kész: ${result.restoredFiles} visszaállítva, ${result.removedFiles} új fájl eltávolítva`);
      })
      .catch((error) => {
        setCodeStatus("rollback blokkolva");
        notify(`Rollback blokkolva: ${String(error)}`);
      });
  };

  const applyAgentSnapshot = () => {
    if (!isTauri || !agentGuard?.applyAvailable) return;
    const changedCount = agentGuard.changedFiles.length + agentGuard.addedFiles.length + agentGuard.removedFiles.length;
    if (!window.confirm(`Alkalmazod az agent által stage-elt változásokat?

Érintett fájlok: ${changedCount}
Base-hash: ${agentGuard.baseHash}

Az apply csak akkor fut le, ha a workspace azóta változatlan.`)) return;
    setCodeStatus("apply...");
    void invoke<AgentApplyResult>("codex_apply_snapshot", { snapshotId: agentGuard.snapshotId })
      .then((result) => {
        setAgentGuard((current) => current ? { ...current, postHash: result.resultingHash, applyAvailable: false, rollbackAvailable: result.rollbackAvailable } : current);
        void invoke<AgentDiffPreview>("codex_preview_snapshot", { snapshotId: result.snapshotId }).then(setAgentDiffPreview).catch(() => undefined);
        setCodeStatus("apply kész");
        notify(`Apply kész: ${result.appliedFiles} fájl írva, ${result.removedFiles} törölve`);
      })
      .catch((error) => {
        setCodeStatus("apply blokkolva");
        notify(`Apply blokkolva: ${String(error)}`);
      });
  };

  const openAgentDiffPreview = () => {
    if (!isTauri || !agentGuard) return;
    void invoke<AgentDiffPreview>("codex_preview_snapshot", { snapshotId: agentGuard.snapshotId })
      .then(setAgentDiffPreview)
      .catch((error) => notify(`Diff preview sikertelen: ${String(error)}`));
  };

  const rebaseAgentSnapshot = () => {
    if (!isTauri || !agentGuard?.applyAvailable) return;
    if (!window.confirm("A workspace közben módosult. Megpróbálod a nem átfedő szöveges változások 3-way merge-ét? Konfliktusnál semmi nem íródik.")) return;
    setCodeStatus("3-way merge...");
    void invoke<AgentRebaseResult>("codex_rebase_snapshot", { snapshotId: agentGuard.snapshotId })
      .then((result) => {
        setAgentGuard((current) => current ? { ...current, postHash: result.mergedHash, applyBaseHash: result.applyBaseHash, rebased: result.rebased, rollbackAvailable: false, applyAvailable: true } : current);
        void invoke<AgentDiffPreview>("codex_preview_snapshot", { snapshotId: result.snapshotId }).then(setAgentDiffPreview).catch(() => undefined);
        setCodeStatus("3-way merge kész");
        notify("3-way merge kész; külön Apply szükséges");
      })
      .catch((error) => {
        setCodeStatus("3-way konfliktus");
        notify(`3-way merge blokkolva: ${String(error)}`);
      });
  };

  const discardAgentSnapshot = () => {
    if (!isTauri || !agentGuard?.applyAvailable) return;
    if (!window.confirm("Elveted az agent által stage-elt változásokat? A canonical workspace base-állapotban marad.")) return;
    setCodeStatus("elvetés...");
    void invoke<AgentDiscardResult>("codex_discard_snapshot", { snapshotId: agentGuard.snapshotId })
      .then(() => {
        setAgentGuard(null);
        setAgentDiffPreview(null);
        setCodeStatus("elvetve");
        notify("Az agent-változások elvetve");
      })
      .catch((error) => {
        setCodeStatus("elvetés blokkolva");
        notify(`Elvetés blokkolva: ${String(error)}`);
      });
  };

  const respondToApproval = (decision: "accept" | "acceptForSession" | "decline" | "cancel") => {
    if (!isTauri || !pendingApproval) return;
    const approvalId = pendingApproval.approvalId;
    setCodeStatus("approval...");
    void invoke("codex_respond_approval", { approvalId, decision })
      .then(() => {
        setPendingApproval(null);
        setCodeStatus(decision === "decline" || decision === "cancel" ? "elutasítva" : "dolgozik");
        notify(decision === "decline" || decision === "cancel" ? "Approval elutasítva" : "Approval elfogadva");
      })
      .catch((error) => {
        setCodeStatus("approval hiba");
        notify(`Approval-válasz sikertelen: ${String(error)}`);
      });
  };

  const markSyncHealthError = (message: string) => {
    setSyncHealth((current) => {
      const fallback: SyncHealth = {
        status: "quarantine",
        journalPath: workspaceRoot ? `${workspaceRoot}\\.min-sync\\v2\\events` : "",
        quarantinePath: workspaceRoot ? `${workspaceRoot}\\.min-sync\\v2\\quarantine` : "",
        checkedAt: String(Date.now()),
        lastImportAt: null,
        scannedEvents: 0,
        acceptedEvents: 0,
        importedEvents: 0,
        storedEvents: 0,
        blockedDevices: [],
        warnings: [],
        canWrite: false,
        recoveryAction: "A sync hívás nem fejeződött be. Ellenőrizd a OneDrive elérhetőségét, majd indíts újraellenőrzést.",
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

  const applyRetentionResult = (result: SyncRetentionPreview, status: string) => {
    setRetentionPreview(result);
    setRetentionSelection((current) => current.filter((key) => result.candidates.some((candidate) => candidate.selectionKey === key && candidate.eligible)));
    setSyncHealth(result.health);
    setTombstones(result.snapshot.tombstones ?? []);
    setSyncWriteEnabled(result.health.canWrite);
    setSyncReady(false);
    setSyncStatus(status);
  };

  const runRetentionAction = (command: "sync_v2_retention_ack" | "sync_v2_retention_backup" | "sync_v2_retention_purge" | "sync_v2_retention_purge_selected", successMessage: string, payload?: Record<string, unknown>) => {
    if (!isTauri || !localStoreReady) return;
    if (command === "sync_v2_retention_purge" && !window.confirm("Az összes aktuális retention-jelölt compaction snapshotba kerül és törlődik az event-journalból. Folytatod?")) return;
    setSyncStatus(command === "sync_v2_retention_backup" ? "retention backup készül…" : command.includes("purge") ? "retention snapshot + purge…" : "retention ACK íródik…");
    void invoke<SyncRetentionPreview>(command, payload)
      .then((result) => {
        applyRetentionResult(result, result.protocolReady ? "retention · gate kész" : "retention · gate vár");
        notify(successMessage);
      })
      .catch((error) => {
        setSyncStatus("karantén · retention hiba");
        markSyncHealthError(`A retention művelet nem sikerült: ${String(error)}`);
        console.warn("OneDrive v2 retention action failed", error);
      });
  };

  const toggleRetentionSelection = (selectionKey: string) => {
    setRetentionSelection((current) => current.includes(selectionKey)
      ? current.filter((key) => key !== selectionKey)
      : [...current, selectionKey]);
  };

  const selectAllEligibleRetention = () => {
    setRetentionSelection(retentionPreview?.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.selectionKey) ?? []);
  };

  const purgeSelectedRetention = () => {
    if (retentionSelection.length === 0) {
      notify("Előbb jelölj ki legalább egy retention elemet.");
      return;
    }
    if (!window.confirm(`${retentionSelection.length} kijelölt archivált elem kerül compaction snapshotba és törlődik az event-journalból. Folytatod?`)) {
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
        applyRetentionResult(result, result.protocolReady ? "retention · gate kész" : "retention · gate vár");
      })
      .catch((error) => {
        setSyncStatus("karantén · retention hiba");
        markSyncHealthError("A retention előnézet nem sikerült.");
        console.warn("OneDrive v2 retention preview failed", error);
      });
  };

  const restoreTombstone = (tombstone: SyncTombstone) => {
    if (!isTauri) return;
    const fallbackLabel = tombstone.title ?? tombstone.entityId;
    setSyncStatus("restore dry-run…");
    void invoke<SyncRestorePreview>("sync_v2_preview_restore_entity", { tombstone })
      .then((preview) => {
        setSyncHealth(preview.health);
        setSyncWriteEnabled(preview.health.canWrite);
        if (!preview.canRestore) {
          setSyncStatus("restore tiltva");
          notify(preview.blockingReason ?? "A restore jelenleg nem hajtható végre.");
          return;
        }
        const pathLine = preview.targetPath ? `\nCél: ${preview.targetPath}` : "";
        const warnings = preview.warnings.map((warning) => `• ${warning}`).join("\n");
        const effects = preview.effects.map((effect) => `• ${effect}`).join("\n");
        const confirmed = window.confirm(
          `Restore előnézet\n\n${preview.label}${pathLine}\n\nVárható hatás:\n${effects}\n\nFigyelmeztetés:\n${warnings}\n\nVisszaállítod?`,
        );
        if (!confirmed) {
          setSyncStatus("restore megszakítva");
          return;
        }
        setSyncStatus("restore…");
        return invoke<SyncV2Result>("sync_v2_restore_entity", { tombstone })
          .then((result) => {
            setSyncHealth(result.health);
            setTombstones(result.snapshot.tombstones ?? []);
            setSyncWriteEnabled(result.canWrite);
            setSyncHealthOpen(false);
            setRetentionPreview(null);
            setSyncStatus(result.writtenEvents > 0 ? "restore · journal" : "visszaállítva");
            setSyncReady(false);
            notify(`Visszaállítva: ${preview.label || fallbackLabel}`);
          });
      })
      .catch((error) => {
        setSyncWriteEnabled(false);
        setSyncStatus("karantén · restore hiba");
        markSyncHealthError("A restore dry-run vagy event írása nem sikerült.");
        console.warn("OneDrive v2 restore failed", error);
      });
  };

  const modelFamilies = useMemo<ModelFamily[]>(() => {
    const definitions = [
      { key: "gpt-5.6", label: "5.6", matches: (id: string) => id.startsWith("gpt-5.6-") },
      { key: "gpt-5.5", label: "5.5", matches: (id: string) => id === "gpt-5.5" || id.startsWith("gpt-5.5-") },
      { key: "gpt-5.4", label: "5.4", matches: (id: string) => id === "gpt-5.4" || id.startsWith("gpt-5.4-") },
      { key: "codex", label: "Codex", matches: (id: string) => id.includes("codex") },
      { key: "other", label: "Egyéb", matches: (_id: string) => true },
    ];
    return definitions.map((definition) => {
      const models = modelCatalog.filter((model) => definition.key === "other"
        ? !definitions.slice(0, -1).some((known) => known.matches(model.id))
        : definition.matches(model.id));
      return { key: definition.key, label: definition.label, models };
    }).filter((family) => family.models.length > 0).map((family) => ({
      ...family,
      models: [...family.models].sort((a, b) => {
        const preferred = ["luna", "terra", "sol"];
        const aRank = preferred.findIndex((name) => a.id.endsWith(`-${name}`));
        const bRank = preferred.findIndex((name) => b.id.endsWith(`-${name}`));
        return (aRank < 0 ? 50 : aRank) - (bRank < 0 ? 50 : bRank) || a.displayName.localeCompare(b.displayName);
      }),
    }));
  }, [modelCatalog]);

  const activeModel = modelCatalog.find((model) => model.id === selectedModel) ?? fallbackModels.find((model) => model.id === DEFAULT_MODEL) ?? fallbackModels[0];
  const activeLabel = selectedModel ? modelLabel(activeModel) : "Automatikus";
  const supportedEfforts = activeModel.supportedReasoningEfforts.length ? activeModel.supportedReasoningEfforts : FALLBACK_EFFORTS;
  const effectiveEffort = supportedEfforts.includes(selectedEffort) ? selectedEffort : activeModel.defaultReasoningEffort ?? supportedEfforts[Math.min(1, supportedEfforts.length - 1)];
  const activeEffortIndex = Math.max(0, supportedEfforts.indexOf(effectiveEffort));
  const activeEffortLabel = EFFORT_LABELS[effectiveEffort] ?? effectiveEffort;
  const selectedFamily = modelFamilies.find((family) => family.models.some((model) => model.id === selectedModel));
  const activeFamily = modelFamilies.find((family) => family.key === activeFamilyKey) ?? selectedFamily ?? modelFamilies[0];
  const codeSnippets = useMemo<CodeSnippet[]>(() => {
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
    const currentTurn = messages.slice(lastUserIndex >= 0 ? lastUserIndex + 1 : 0);
    return currentTurn.flatMap((message, messageIndex) => (
      extractCodeBlocks(message.text).map((block, blockIndex) => ({ ...block, id: `${lastUserIndex + 1 + messageIndex}-${blockIndex}`, messageIndex: lastUserIndex + 1 + messageIndex }))
    ));
  }, [messages]);

  const workLogGroups = useMemo<WorkLogGroup[]>(() => {
    const grouped = new Map<string, CodeActivity[]>();
    for (const activity of codeActivity) {
      const key = activity.turnId ?? "legacy";
      const items = grouped.get(key) ?? [];
      items.push(activity);
      grouped.set(key, items);
    }
    const groups = [...grouped.entries()].map(([key, activities]) => {
      const orderedActivities = [...activities].sort(compareWorkItems);
      const lastActivity = orderedActivities[orderedActivities.length - 1];
      return {
        key,
        activities: orderedActivities,
        sequence: lastActivity?.id ?? 0,
        hlc: lastActivity?.hlc,
        originDeviceId: lastActivity?.originDeviceId,
      };
    });
    const pendingAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.live && !message.final);
    const activeTurnKey = activeTurnIdRef.current;
    const hasActiveTurnGroup = Boolean(activeTurnKey && groups.some((group) => group.key === activeTurnKey));
    if ((isStreaming && !hasActiveTurnGroup) || (codeSnippets.length > 0 && groups.length === 0)) {
      const lastMessage = pendingAssistant ?? messages[messages.length - 1];
      const lastMessageSequence = lastMessage?.sequence ?? messages.length;
      groups.push({
        key: pendingAssistant?.id ? `pending:${pendingAssistant.id}` : activeTurnKey ?? "current",
        activities: [],
        sequence: lastMessageSequence + 1,
        hlc: lastMessage?.hlc,
        originDeviceId: lastMessage?.originDeviceId,
      });
    }
    return groups.sort((left, right) => compareTimelineOrder(
      { hlc: left.hlc, originDeviceId: left.originDeviceId, sequence: left.sequence, tieBreaker: left.key },
      { hlc: right.hlc, originDeviceId: right.originDeviceId, sequence: right.sequence, tieBreaker: right.key },
    ));
  }, [codeActivity, codeSnippets.length, isStreaming, messages]);

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
    return entries.sort((left, right) => compareTimelineOrder(left, right) || (left.kind === "message" ? -1 : 1));
  }, [messages, workLogGroups]);

  const latestWorkLogKeyRef = useRef<string | null>(null);
  latestWorkLogKeyRef.current = workLogGroups[workLogGroups.length - 1]?.key ?? null;

  useEffect(() => {
    if (!isStreaming) return;
    const key = latestWorkLogKeyRef.current;
    if (!key) return;
    setExpandedWorkLogs((current) => current[key] ? current : { ...current, [key]: true });
  }, [isStreaming, workLogGroups]);

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
            root = await invoke<string>("codex_set_projects_root", { path: selected });
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
    return () => { active = false; };
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
        const dbProjects = snapshot.projects.map((project) => {
          const local = localProjects.find((candidate) => (
            candidate.id === project.id
            || Boolean(project.relativePath && candidate.relativePath && project.relativePath.toLowerCase() === candidate.relativePath.toLowerCase())
            || normalizePath(candidate.path) === normalizePath(project.pathHint || workspaceRoot)
          ));
          const pathHint = project.pathHint || local?.path || workspaceRoot;
          return {
            id: project.id,
            name: project.name || local?.name || projectNameFromPath(pathHint),
            path: resolveSyncedPath(project.relativePath, pathHint, workspaceRoot),
            relativePath: project.relativePath ?? local?.relativePath ?? relativeOneDrivePath(pathHint),
            threads: [...new Set([...(project.threads ?? []), ...(local?.threads ?? [])])],
            local,
          };
        }).filter((project) => !localTombstones.some((tombstone) => tombstoneMatchesProject(tombstone, project)));
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
            const localKeys = [...new Set([
              localKey,
              local ? `${local.path}/${title}` : localKey,
            ])];
            const databaseConversation = snapshot.conversations[syncConversationKey(project.id, title)];
            const localMessages = localKeys
              .map((key) => browserHistory[key])
              .find((value) => Array.isArray(value) && value.length > 0) ?? [];
            const localWork = localKeys
              .map((key) => browserWorkItems[key])
              .find((value) => Array.isArray(value) && value.length > 0) ?? [];
            const threadId = localKeys.map((key) => threadIds[key]).find((value): value is string => Boolean(value))
              ?? null;
            localConversationCache[localKey] = {
              id: databaseConversation?.id,
              projectId: project.id,
              title,
              messages: mergeMessages(databaseConversation?.messages ?? [], localMessages),
              workItems: mergeWorkItems(databaseConversation?.workItems ?? [], localWork),
              threadId,
              updatedAt: databaseConversation?.updatedAt ?? new Date().toISOString(),
            };
            if (threadId) mergedThreadIds[localKey] = threadId;
          }
        }

        for (const local of localProjects) {
          if (matchedLocalProjectIds.has(local.id)) continue;
          if (localTombstones.some((tombstone) => tombstoneMatchesProject(tombstone, local))) continue;
          const isWorkspacePlaceholder = normalizePath(local.path) === normalizePath(workspaceRoot)
            && local.name === projectNameFromPath(workspaceRoot)
            && local.threads.length === 1
            && local.threads[0] === "Új beszélgetés";
          if (isWorkspacePlaceholder && mergedProjects.length > 0) continue;
          mergedProjects.push(local);
          for (const title of local.threads) {
            const localKey = `${local.path}/${title}`;
            const databaseConversation = snapshot.conversations[syncConversationKey(local.id, title)];
            const messages = loadThreadMessages(localKey);
            const workItems = loadThreadWorkItems(localKey);
            localConversationCache[localKey] = {
              id: databaseConversation?.id,
              projectId: local.id,
              title,
              messages: mergeMessages(databaseConversation?.messages ?? [], messages),
              workItems: mergeWorkItems(databaseConversation?.workItems ?? [], workItems),
              threadId: threadIds[localKey] ?? null,
              updatedAt: databaseConversation?.updatedAt ?? new Date().toISOString(),
            };
          }
        }

        const nextProjects = dedupeProjects(mergedProjects.length > 0 ? mergedProjects : localProjects);
        setProjects(nextProjects);
        setThreadIds(mergedThreadIds);
        setLocalConversationCache(localConversationCache);
        messageKeyRef.current = "__local-store-hydrated__";
        workLogKeyRef.current = "__local-store-hydrated__";

        const selectedProject = nextProjects.find((project) => project.name === activeProject) ?? nextProjects[0];
        if (selectedProject) {
          const selectedThread = selectedProject.threads.includes(activeThread)
            ? activeThread
            : selectedProject.threads[0] ?? "";
          const selectedKey = `${selectedProject.path}/${selectedThread}`;
          setActiveProject(selectedProject.name);
          setActiveThread(selectedThread);
          setMessages(localConversationCache[selectedKey]?.messages ?? []);
          setCodeActivity(localConversationCache[selectedKey]?.workItems ?? []);
        }

        const inserted = reports.reduce((total, report) => total + report.insertedProjects + report.insertedConversations + report.insertedMessages + report.insertedWorkItems, 0);
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
    return () => { active = false; };
  }, [workspaceRoot, localStoreReady]);

  useEffect(() => {
    if (!isTauri || !activeProjectData.path) return;
    void invoke<boolean>("ensure_project_instructions", { path: activeProjectData.path }).catch((error) => {
      console.warn("Projekt AGENTS.md seeding failed", error);
    });
  }, [activeProjectData.path]);

  useEffect(() => {
    if (!isTauri || !workspaceRoot || syncReady || !localStoreReady) return;
    const pullRevision = projectMutationRevisionRef.current;
    let active = true;
    void invoke<SyncV2Result>("sync_v2_pull")
      .then((result) => {
        if (!active) return;
        setSyncHealth(result.health);
        const state = result.snapshot;
        const remoteTombstones = state.tombstones ?? [];
        if (!result.canWrite) {
          setSyncWriteEnabled(false);
          setSyncStatus(`karantén · ${result.warnings[0] ?? "v2 sync figyelmeztetés"}`);
        } else {
          setSyncWriteEnabled(true);
          setSyncStatus(result.importedEvents > 0 ? `importálva · ${result.importedEvents}` : "kész");
        }

        if (projectMutationRevisionRef.current !== pullRevision || pendingLocalMutationRef.current) {
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
          .filter((project) => typeof project.name === "string" && typeof project.id === "string")
          .map((project) => ({
            id: project.id || projectIdFromPath(project.pathHint ?? workspaceRoot, project.relativePath),
            name: project.name,
            path: resolveSyncedPath(project.relativePath, project.pathHint, workspaceRoot),
            relativePath: project.relativePath ?? null,
            threads: Array.isArray(project.threads) ? project.threads : [],
          }))
          .filter((project) => !remoteTombstones.some((tombstone) => tombstoneMatchesProject(tombstone, project)));
        const localProjects = projects;
        const matchedLocalProjectIds = new Set<string>();
        const matchingLocalProject = (project: Project) => localProjects.find((local) => (
          local.id === project.id
          || Boolean(project.relativePath && local.relativePath && project.relativePath.toLowerCase() === local.relativePath.toLowerCase())
          || normalizePath(local.path) === normalizePath(project.path)
        ));
        const mergedProjects = syncedProjects.map((project) => {
          const local = matchingLocalProject(project);
          if (!local) return project;
          matchedLocalProjectIds.add(local.id);
          const threads = [...new Set([...project.threads, ...local.threads])]
            .filter((title) => !remoteTombstones.some((tombstone) => tombstoneMatchesConversation(
              tombstone,
              project,
              title,
              localConversationCache[`${local.path}/${title}`]?.id,
            )));
          return { ...project, threads };
        });
        for (const local of localProjects) {
          if (remoteTombstones.some((tombstone) => tombstoneMatchesProject(tombstone, local))) continue;
          const isWorkspacePlaceholder = normalizePath(local.path) === normalizePath(workspaceRoot)
            && local.name === projectNameFromPath(workspaceRoot)
            && local.threads.length === 1
            && local.threads[0] === "Új beszélgetés";
          if (!isWorkspacePlaceholder && !matchedLocalProjectIds.has(local.id)) {
            const threads = local.threads.filter((title) => !remoteTombstones.some((tombstone) => tombstoneMatchesConversation(tombstone, local, title)));
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
            setMessages([]);
            setCodeActivity([]);
          }
          setSyncWriteEnabled(result.canWrite);
          setSyncStatus(result.canWrite ? "kész · nincs távoli adat" : "karantén");
          setSyncReady(true);
          return;
        }

        const cachedHistory = loadStoredMessageMap();
        const cachedWorkLogs = loadStoredWorkItemMap();
        const nextLocalConversationCache: Record<string, SyncConversation> = { ...localConversationCache };
        const syncedThreadIds: Record<string, string> = { ...threadIds };
        for (const project of visibleProjects) {
          const localProject = matchingLocalProject(project);
          for (const title of project.threads) {
            if (remoteTombstones.some((tombstone) => tombstoneMatchesConversation(
              tombstone,
              project,
              title,
              localConversationCache[`${localProject?.path ?? project.path}/${title}`]?.id,
            ))) continue;
            const conversation = state.conversations[syncConversationKey(project.id, title)];
            const localKey = `${project.path}/${title}`;
            const localKeys = [...new Set([
              localKey,
              localProject ? `${localProject.path}/${title}` : localKey,
            ])];
            const cachedConversation = localKeys
              .map((key) => localConversationCache[key])
              .find((value): value is SyncConversation => Boolean(value));
            const localMessages = mergeMessages(
              cachedConversation?.messages ?? [],
              localKeys.map((key) => cachedHistory[key]).find((value): value is Message[] => Array.isArray(value)) ?? [],
            );
            const localWorkItems = mergeWorkItems(
              cachedConversation?.workItems ?? [],
              localKeys.map((key) => cachedWorkLogs[key]).find((value): value is CodeActivity[] => Array.isArray(value)) ?? [],
            );
            const syncedMessages = conversation && Array.isArray(conversation.messages) ? compactMessages(conversation.messages) : [];
            const syncedWorkItems = conversation && Array.isArray(conversation.workItems)
              ? conversation.workItems.map((item, index) => normalizeWorkItem(item, index)).filter((item): item is CodeActivity => Boolean(item))
              : [];
            const mergedMessages = mergeMessages(syncedMessages, localMessages);
            const mergedWorkItems = mergeWorkItems(syncedWorkItems, localWorkItems);
            const localThreadId = localKeys
              .map((key) => threadIds[key])
              .find((value): value is string => Boolean(value)) ?? null;
            cachedHistory[localKey] = mergedMessages;
            cachedWorkLogs[localKey] = mergedWorkItems;
            nextLocalConversationCache[localKey] = {
              id: conversation?.id ?? cachedConversation?.id,
              projectId: project.id,
              title,
              messages: mergedMessages,
              workItems: mergedWorkItems,
              // Codex rollout IDs are device-local; never hydrate one from OneDrive.
              threadId: localThreadId,
              updatedAt: conversation?.updatedAt ?? cachedConversation?.updatedAt ?? new Date().toISOString(),
            };
            if (localThreadId) syncedThreadIds[localKey] = localThreadId;
          }
        }
        setLocalConversationCache(nextLocalConversationCache);
        setThreadIds(syncedThreadIds);
        setProjects(visibleProjects);

        const selectedProject = visibleProjects.find((project) => project.name === activeProject)
          ?? visibleProjects[0];
        const selectedThread = selectedProject.threads.includes(activeThread)
          ? activeThread
            : selectedProject.threads[0] ?? "";
        setActiveProject(selectedProject.name);
        setActiveThread(selectedThread);
        const selectedKey = `${selectedProject.path}/${selectedThread}`;
        setMessages(nextLocalConversationCache[selectedKey]?.messages ?? []);
        setCodeActivity(nextLocalConversationCache[selectedKey]?.workItems ?? []);
        messageKeyRef.current = "__remote-hydrated__";
        workLogKeyRef.current = "__remote-hydrated__";
        setSyncWriteEnabled(result.canWrite);
        setSyncStatus(result.canWrite ? "szinkronizálva" : "karantén · olvasás");
        setSyncReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setSyncWriteEnabled(false);
        setSyncStatus("karantén · szinkronhiba");
        markSyncHealthError("A v2 pull nem sikerült.");
        setSyncReady(true);
        console.warn("OneDrive sync load failed", error);
      });
    return () => { active = false; };
  }, [workspaceRoot, syncReady, localStoreReady]);

  useEffect(() => {
    if (!isTauri || !workspaceRoot || !localStoreReady || !syncReady) return;
    const timer = window.setInterval(() => {
      if (isStreamingRef.current) return;
      setSyncStatus("frissítés…");
      setSyncReady(false);
    }, SYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [workspaceRoot, syncReady, localStoreReady]);

  useEffect(() => {
    if (!isTauri || !localStoreReady) {
      if (projects.length > 0) localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
      else localStorage.removeItem(PROJECTS_STORAGE_KEY);
    }
    if (!activeProject && projects[0]) {
      setActiveProject(projects[0].name);
      setActiveThread(projects[0].threads[0] ?? "");
    } else if (activeProject && !projects.some((project) => project.name === activeProject) && projects[0]) {
      setActiveProject(projects[0].name);
      setActiveThread(projects[0].threads[0] ?? "");
    }
  }, [projects, activeProject, localStoreReady]);

  useEffect(() => localStorage.setItem("min-active-project", activeProject), [activeProject]);
  useEffect(() => localStorage.setItem("min-active-thread", activeThread), [activeThread]);

  useEffect(() => {
    if (isTauri && (!syncReady || !localStoreReady)) return;
    if (messageKeyRef.current !== threadKey) {
      messageKeyRef.current = threadKey;
      setMessages(localConversationCacheRef.current[threadKey]?.messages ?? loadThreadMessages(threadKey));
      return;
    }
    if (isTauri) {
      setLocalConversationCache((current) => ({
        ...current,
        [threadKey]: {
          ...(current[threadKey] ?? {
            projectId: activeProjectData.id,
            title: activeThread,
            messages: [],
            workItems: [],
            threadId: threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          projectId: activeProjectData.id,
          title: activeThread,
          messages,
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    saveThreadMessages(threadKey, messages);
  }, [threadKey, messages, syncReady, localStoreReady, activeProjectData.id, activeThread, threadIds]);

  useEffect(() => {
    if (isTauri && (!syncReady || !localStoreReady)) return;
    if (workLogKeyRef.current !== threadKey) {
      workLogKeyRef.current = threadKey;
      const saved = localConversationCacheRef.current[threadKey]?.workItems ?? loadThreadWorkItems(threadKey);
      setCodeActivity(saved);
      setCodeStatus(saved.length > 0 ? "kész" : "készen");
      setExpandedWorkLogs({});
      return;
    }
    if (isTauri) {
      setLocalConversationCache((current) => ({
        ...current,
        [threadKey]: {
          ...(current[threadKey] ?? {
            projectId: activeProjectData.id,
            title: activeThread,
            messages: [],
            workItems: [],
            threadId: threadIds[threadKey] ?? null,
            updatedAt: new Date().toISOString(),
          }),
          projectId: activeProjectData.id,
          title: activeThread,
          workItems: codeActivity,
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    saveThreadWorkItems(threadKey, codeActivity);
  }, [threadKey, codeActivity, syncReady, localStoreReady, activeProjectData.id, activeThread, threadIds]);

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
  }, [messages, isStreaming]);

  useEffect(() => {
    try {
      // This mapping is intentionally local to this WebView/device. It must
      // not travel through the OneDrive journal.
      localStorage.setItem(LOCAL_THREAD_IDS_STORAGE_KEY, JSON.stringify(threadIds));
    } catch {
      // A storage failure must not break the conversation.
    }
  }, [threadIds]);

  useEffect(() => {
    if (!isTauri || !workspaceRoot || !localStoreReady || !localStoreWriteEnabled || (!syncReady && !pendingLocalMutationRef.current)) return;
    const revisionAtSchedule = projectMutationRevisionRef.current;
      const timer = window.setTimeout(() => {
      const conversations: Record<string, SyncConversation> = {};
      const syncProjects: SyncProject[] = projects.map((project) => ({
        id: project.id,
        name: project.name,
        relativePath: project.relativePath ?? relativeOneDrivePath(project.path),
        pathHint: project.path,
        threads: project.threads,
      }));

      for (const project of projects) {
        for (const title of project.threads) {
          const localKey = `${project.path}/${title}`;
          const cached = localConversationCacheRef.current[localKey];
          const projectIsActive = project.name === activeProject;
          const conversationMessages = projectIsActive && title === activeThread
            ? messages
            : cached?.messages ?? loadThreadMessages(localKey);
          const conversationWorkItems = projectIsActive && title === activeThread
            ? codeActivity
            : cached?.workItems ?? loadThreadWorkItems(localKey);
          const threadId = threadIds[localKey] ?? cached?.threadId ?? null;
          conversations[syncConversationKey(project.id, title)] = {
            id: cached?.id,
            projectId: project.id,
            title,
            messages: compactMessages(conversationMessages),
            workItems: conversationWorkItems,
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
          setLocalStoreStatus("mentés…");
          const saved = await invoke<LocalStoreSnapshot>("local_store_save", { snapshot });
          setLocalConversationCache((current) => {
            const next = { ...current };
            for (const project of projects) {
              const savedProject = saved.projects.find((candidate) => (
                (candidate.relativePath && project.relativePath && candidate.relativePath.toLowerCase() === project.relativePath.toLowerCase())
                || normalizePath(candidate.pathHint) === normalizePath(project.path)
                || candidate.name === project.name
              ));
              for (const title of project.threads) {
                const key = `${project.path}/${title}`;
                const savedConversation = savedProject
                  ? saved.conversations[syncConversationKey(savedProject.id, title)]
                  : undefined;
                if (savedConversation && next[key]) next[key] = { ...next[key], id: savedConversation.id };
              }
            }
            return next;
          });
          setLocalStoreStatus("kész");
          if (syncReady && syncWriteEnabled) {
            setSyncStatus("journal…");
            try {
              const result = await invoke<SyncV2Result>("sync_v2_publish_snapshot", { snapshot: saved });
              setSyncHealth(result.health);
              if (!result.canWrite) {
                setSyncWriteEnabled(false);
                setSyncStatus("karantén · v2 sync");
              } else {
                setSyncStatus(result.writtenEvents > 0 ? `journal · +${result.writtenEvents}` : "szinkronizálva");
              }
            } catch (error) {
              setSyncWriteEnabled(false);
              setSyncStatus("karantén · journal hiba");
              markSyncHealthError("A v2 journal publish nem sikerült.");
              console.warn("OneDrive v2 journal publish failed", error);
            }
          }
          if (projectMutationRevisionRef.current === revisionAtSchedule && (syncReady || !pendingLocalMutationRef.current)) {
            pendingLocalMutationRef.current = false;
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
  }, [activeProject, activeThread, codeActivity, localStoreReady, localStoreWriteEnabled, messages, projects, syncReady, syncWriteEnabled, threadIds, tombstones, workspaceRoot]);

  useEffect(() => {
    if (!isTauri) {
      setModelsLoading(false);
      return;
    }
    let active = true;
    void invoke<CodexModel[]>("codex_models")
      .then((models) => { if (active && models.length > 0) setModelCatalog(models); })
      .catch(() => undefined)
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (activeModel && !supportedEfforts.includes(selectedEffort)) setSelectedEffort(effectiveEffort);
  }, [modelCatalog, selectedModel]);

  useEffect(() => {
    if (selectedModel && !modelCatalog.some((model) => model.id === selectedModel) && !modelsLoading) setSelectedModel(DEFAULT_MODEL);
  }, [modelCatalog, modelsLoading, selectedModel]);

  useEffect(() => {
    if (selectedModel) localStorage.setItem("min-model", selectedModel);
    else localStorage.removeItem("min-model");
  }, [selectedModel]);

  useEffect(() => localStorage.setItem("min-effort", selectedEffort), [selectedEffort]);

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
        if (key) setExpandedWorkLogs((current) => ({ ...current, [key]: !(current[key] ?? false) }));
      }
      if (event.key === "Escape") {
        setCommandsOpen(false);
        setSettingsOpen(false);
        setModelMenuOpen(false);
        setExpandedWorkLogs({});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const closeOverflowMenu = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".overflow-menu-wrap")) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", closeOverflowMenu);
    return () => document.removeEventListener("pointerdown", closeOverflowMenu);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    void listen<CodexDelta>("codex-delta", (event) => {
      const delta = normalizeCodexDelta(event.payload);
      if (!delta) return;
      setMessages((current) => appendCodexDelta(current, delta));
    }).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    void listen<CodexApprovalRequest>("codex-approval-request", (event) => {
      setPendingApproval(event.payload);
      setCodeStatus("approval vár");
    }).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let cleanup: (() => void) | undefined;
    let activeTurnId: string | undefined;
    void listen<CodexEvent>("codex-event", (event) => {
      const codexEvent = normalizeCodexEvent(event.payload);
      if (!codexEvent) return;
      const params = asRecord(codexEvent.payload);
      const item = asRecord(params.item);
      const explicitTurnId = eventTurnId(codexEvent, params, item);
      if (codexEvent.eventType === "turn/started") activeTurnId = explicitTurnId;
      if (activeTurnId) activeTurnIdRef.current = activeTurnId;
      const activityId = nextTimelineSequence();
      const activity = summarizeCodexWorkEvent(codexEvent, activityId, activeTurnId);
      if (activity) {
        setCodeActivity((current) => mergeCodeActivity(current, activity));
        const filePath = extractFilePath(codexEvent.payload);
        if (!activity.code && filePath && /\.[a-z0-9]{1,8}$/i.test(filePath)) {
          void invoke<string | null>("read_code_file", { cwd: activeProjectPathRef.current, path: filePath })
            .then((code) => {
              if (!code) return;
              setCodeActivity((current) => current.map((item) => item.id === activityId || (activity.itemId && item.itemId === activity.itemId) ? { ...item, code } : item));
            })
            .catch(() => undefined);
        }
      }
      if (codexEvent.eventType === "turn/started") setCodeStatus("dolgozik");
      else if (codexEvent.eventType === "turn/completed") {
        setPendingApproval(null);
        setCodeStatus("kész");
      }
      else if (codexEvent.eventType.includes("error")) setCodeStatus("hiba");
    }).then((unlisten) => { cleanup = unlisten; });
    return () => cleanup?.();
  }, []);

  const notify = (message: string, sound?: AppSound) => {
    setToast(message);
    if (sound) playAppSound(sound);
  };

  const selectModel = (model: string | null) => {
    setSelectedModel(model);
    setActiveFamilyKey(modelFamilies.find((family) => family.models.some((candidate) => candidate.id === model))?.key ?? null);
    const modelData = modelCatalog.find((candidate) => candidate.id === model);
    if (modelData && !modelData.supportedReasoningEfforts.includes(selectedEffort)) setSelectedEffort(modelData.defaultReasoningEffort ?? modelData.supportedReasoningEfforts[0] ?? DEFAULT_EFFORT);
    setModelMenuOpen(false);
    notify(model ? `Modell kiválasztva: ${modelData?.displayName ?? model}` : "Automatikus Codex-modell kiválasztva");
  };

  const toggleModelMenu = () => {
    const nextOpen = !modelMenuOpen;
    if (nextOpen) setActiveFamilyKey(selectedFamily?.key ?? modelFamilies[0]?.key ?? null);
    setModelMenuOpen(nextOpen);
  };

  const selectEffortIndex = (index: number) => {
    const effort = supportedEfforts[index];
    if (effort) setSelectedEffort(effort);
  };

  const handleMessageScroll = () => {
    const stream = messageStreamRef.current;
    if (!stream) return;
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
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
    const nextName = window.prompt("Projekt átnevezése", project.name)?.trim();
    if (!nextName || nextName === project.name) return;
    if (projects.some((candidate) => candidate.path !== project.path && candidate.name.toLowerCase() === nextName.toLowerCase())) {
      notify("Ez a projektnév már használatban van");
      return;
    }
    markProjectMutation();
    setProjects((current) => current.map((candidate) => candidate.path === project.path ? { ...candidate, name: nextName } : candidate));
    if (activeProject === project.name) setActiveProject(nextName);
    notify(`Projekt átnevezve: ${nextName}`);
  };

  const deleteProject = (project: Project) => {
    if (!window.confirm(`Biztosan törlöd a(z) „${project.name}” projektet és a beszélgetéseit?`)) return;
    markProjectMutation();
    if (isTauri) {
      setTombstones((current) => [
        ...current.filter((tombstone) => !(tombstone.entityType === "project" && tombstoneMatchesProject(tombstone, project))),
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
      if (!isTauri || !localStoreReady) {
        removeThreadMessages(key);
        removeThreadWorkItems(key);
      }
    });
    if (isTauri) {
      setLocalConversationCache((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${project.path}/`))));
    }
    setProjects((current) => current.filter((candidate) => (
      candidate.id !== project.id
      && projectIdentityKey(candidate) !== projectIdentityKey(project)
    )));
    setThreadIds((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${project.path}/`))));
    setOpenProjects((current) => {
      const next = { ...current };
      delete next[project.path];
      return next;
    });
    setOpenMenu(null);
    if (activeProject === project.name) {
      const nextProject = projects.find((candidate) => (
        candidate.id !== project.id
        && projectIdentityKey(candidate) !== projectIdentityKey(project)
      ));
      if (nextProject) {
        const nextThread = nextProject.threads[0] ?? "";
        setActiveProject(nextProject.name);
        setActiveThread(nextThread);
        setMessages(nextThread ? messagesForThread(`${nextProject.path}/${nextThread}`) : []);
        setCodeActivity(nextThread ? workItemsForThread(`${nextProject.path}/${nextThread}`) : []);
      } else {
        setActiveProject("");
        setActiveThread("");
        setMessages([]);
        setCodeActivity([]);
      }
    }
    notify(`Projekt törölve: ${project.name}`);
  };

  const renameThread = (project: Project, thread: string) => {
    const nextName = window.prompt("Beszélgetés átnevezése", thread)?.trim();
    if (!nextName || nextName === thread) return;
    if (project.threads.some((candidate) => candidate !== thread && candidate.toLowerCase() === nextName.toLowerCase())) {
      notify("Ez a beszélgetésnév már használatban van a projektben");
      return;
    }
    const oldKey = `${project.path}/${thread}`;
    const newKey = `${project.path}/${nextName}`;
    const messagesToMove = messagesForThread(oldKey);
    const workItemsToMove = workItemsForThread(oldKey);
    markProjectMutation();
    if (isTauri && localStoreReady) {
      setLocalConversationCache((current) => {
        const next = { ...current };
        if (next[oldKey]) next[newKey] = { ...next[oldKey], title: nextName };
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
    setProjects((current) => current.map((candidate) => candidate.path === project.path ? { ...candidate, threads: candidate.threads.map((candidateThread) => candidateThread === thread ? nextName : candidateThread) } : candidate));
    if (activeProject === project.name && activeThread === thread) setActiveThread(nextName);
    notify(`Beszélgetés átnevezve: ${nextName}`);
  };

  const deleteThread = (project: Project, thread: string) => {
    if (!window.confirm(`Biztosan törlöd a(z) „${thread}” beszélgetést?`)) return;
    const oldKey = `${project.path}/${thread}`;
    if (isTauri) {
      const conversation = localConversationCacheRef.current[oldKey];
      setTombstones((current) => [
        ...current.filter((tombstone) => !(
          tombstone.entityType === "conversation"
          && tombstone.title === thread
          && (tombstone.projectId === project.id || tombstone.relativePath === project.relativePath)
        )),
        {
          entityType: "conversation",
          entityId: conversation?.id ?? `legacy:${project.id}:${thread}`,
          archivedAt: new Date().toISOString(),
          projectId: project.id,
          title: thread,
          relativePath: project.relativePath,
          pathHint: project.path,
          reason: "Beszélgetés eltávolítva az alkalmazásból",
        },
      ]);
    }
    const remainingThreads = project.threads.filter((candidate) => candidate !== thread);
    const nextThreads = remainingThreads;
    markProjectMutation();
    if (isTauri && localStoreReady) {
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
    setProjects((current) => current.map((candidate) => candidate.id === project.id ? { ...candidate, threads: nextThreads } : candidate));
    setOpenMenu(null);
    if (activeProject === project.name && activeThread === thread) {
      const nextThread = nextThreads[0];
      setActiveThread(nextThread);
      setMessages(nextThread ? messagesForThread(`${project.path}/${nextThread}`) : []);
      setCodeActivity(nextThread ? workItemsForThread(`${project.path}/${nextThread}`) : []);
      setExpandedWorkLogs({});
    }
    notify(`Beszélgetés törölve: ${thread}`);
  };

  const changeProjectsRoot = async () => {
    if (!isTauri) return;
    try {
      const selected = await invoke<string | null>("pick_projects_root");
      if (!selected) return;
      const root = await invoke<string>("codex_set_projects_root", { path: selected });
      setWorkspaceRoot(root);
      setSyncWriteEnabled(false);
      setSyncReady(false);
      setSyncStatus("projektek-gyökér mentve · frissítés…");
      notify("A projektek-gyökér elmentve; a szinkron frissül.");
    } catch (error) {
      notify(`Nem sikerült elmenteni a projektek-gyökeret: ${String(error)}`);
    }
  };

  const addProject = async () => {
    if (!isTauri) {
      notify("Az új projekt a natív Tauri appban hozható létre");
      return;
    }
    try {
      const requestedName = window.prompt("Új projekt neve", "Új projekt")?.trim();
      if (!requestedName) return;
      const selectedPath = await invoke<string>("create_project_directory", { name: requestedName });
      const projectName = projectNameFromPath(selectedPath);
      markProjectMutation();
      setProjects((current) => [...current, projectFromPath(projectName, selectedPath)]);
      setActiveProject(projectName);
      setActiveThread("Új beszélgetés");
      setMessages([]);
      setCodeActivity([]);
      setCodeStatus("készen");
      setExpandedWorkLogs({});
      setOpenProjects((current) => ({ ...current, [selectedPath]: true }));
      notify(`Projektmappa létrehozva: ${projectName}`);
    } catch (error) {
      notify(`Nem sikerült létrehozni a projektmappát: ${String(error)}`);
    }
  };

  const addExistingProject = async () => {
    if (!isTauri) {
      notify("A meglévő projekt kiválasztása a natív Tauri appban érhető el");
      return;
    }
    try {
      const selectedPath = await invoke<string | null>("pick_project_directory");
      if (!selectedPath) return;
      const existing = projects.find((project) => normalizePath(project.path) === normalizePath(selectedPath));
      if (existing) {
        selectProject(existing);
        notify(`Már hozzáadva: ${existing.name}`);
        return;
      }
      const project = projectFromPath(projectNameFromPath(selectedPath), selectedPath);
      markProjectMutation();
      setProjects((current) => [...current, project]);
      setActiveProject(project.name);
      setActiveThread(project.threads[0]);
      setMessages(messagesForThread(`${project.path}/${project.threads[0]}`));
      setCodeActivity(workItemsForThread(`${project.path}/${project.threads[0]}`));
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
    setMessages(messagesForThread(`${project.path}/${thread}`));
    setCodeActivity(workItemsForThread(`${project.path}/${thread}`));
    setCodeStatus(workItemsForThread(`${project.path}/${thread}`).length > 0 ? "kész" : "készen");
    setExpandedWorkLogs({});
    notify(`Megnyitva: ${thread}`);
  };

  const createRequestId = () => typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const stopGeneration = async () => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || isCancelling) return;
    setIsCancelling(true);
    try {
      await invoke("codex_cancel", { requestId });
      notify("A válaszgenerálás leállítva");
    } catch (error) {
      setIsCancelling(false);
      notify(`Nem sikerült leállítani: ${String(error)}`, "notify");
    }
  };

  useEffect(() => {
    document.documentElement.classList.toggle("is-streaming", isStreaming);
    document.documentElement.classList.toggle("is-cancelling", isCancelling);
    document.querySelectorAll<HTMLButtonElement>(".send-button").forEach((button) => {
      button.setAttribute("aria-label", isStreaming ? "Gondolkodás leállítása" : "Üzenet küldése");
    });
    return () => {
      document.documentElement.classList.remove("is-streaming", "is-cancelling");
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
    if (!text || isStreaming) return;
    if (agentGuard?.applyAvailable) {
      notify("Előbb alkalmazd vagy vesd el a stage-elt agent-változásokat.");
      return;
    }
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
    const userSequence = nextTimelineSequence();
    const liveSequence = nextTimelineSequence();
    const liveMessage: Message = { id: createEntityId(), role: "assistant", time: "most", text: "", live: true, final: false, sequence: liveSequence };
    activeTurnIdRef.current = undefined;
    setMessages((current) => [...current, { id: createEntityId(), role: "user", time: "most", text, sequence: userSequence }, liveMessage]);
    setInput("");
    setIsStreaming(true);
    setIsCancelling(false);
    const requestId = createRequestId();
    activeRequestIdRef.current = requestId;

    if (!isTauri) {
      setIsStreaming(false);
      activeRequestIdRef.current = null;
      notify("A natív Tauri appban érhető el a Codex-kapcsolat");
      return;
    }
    if (!activeProjectData?.path) {
      setIsStreaming(false);
      activeRequestIdRef.current = null;
      notify("Előbb válassz vagy adj hozzá egy projektmappát");
      return;
    }

      setCodeStatus("dolgozik");
    try {
      const response = await invoke<CodexResponse>("codex_send", { request: {
        prompt: text,
        threadId: threadIds[threadKey] ?? null,
        conversationContext: conversationContextForRehydration(messages) || null,
        model: selectedModel,
        effort: effectiveEffort,
        cwd: activeProjectData.path,
        requestId,
      } });
      setAgentGuard(response.guard);
      setAgentDiffPreview(null);
      if (response.guard.changedFiles.length > 0 || response.guard.addedFiles.length > 0 || response.guard.removedFiles.length > 0) {
        void invoke<AgentDiffPreview>("codex_preview_snapshot", { snapshotId: response.guard.snapshotId })
          .then(setAgentDiffPreview)
          .catch((error) => notify(`Diff preview sikertelen: ${String(error)}`));
      }
      const responseEvents = Array.isArray(response.events) ? response.events : [];
      const replayDeltas = responseEvents
        .filter((event) => event.eventType === "item/agentMessage/delta")
        .map((event) => normalizeCodexDelta(event.payload))
        .filter((delta): delta is CodexDelta => Boolean(delta));
      if (replayDeltas.length > 0) {
        setMessages((current) => replayDeltas.reduce((messages, delta) => appendCodexDelta(messages, delta), current));
      }
      let replayTurnId: string | undefined = activeTurnIdRef.current;
      const replayActivities: CodeActivity[] = [];
      for (const event of responseEvents) {
        const params = asRecord(event.payload);
        const item = asRecord(params.item);
        const eventTurn = eventTurnId(event, params, item);
        if (event.eventType === "turn/started") replayTurnId = eventTurn;
        const isReplayable = event.eventType === "turn/started"
          || event.eventType === "turn/completed"
          || event.eventType === "item/started"
          || event.eventType === "item/completed"
          || /outputDelta|summaryTextDelta|error/i.test(event.eventType);
        if (!isReplayable) continue;
        const activity = summarizeCodexWorkEvent(event, nextTimelineSequence(), replayTurnId);
        if (activity) replayActivities.push(activity);
      }
      if (replayActivities.length > 0) {
        setCodeActivity((current) => replayActivities.reduce((items, activity) => mergeCodeActivity(items, activity), current));
      }
      setThreadIds((current) => ({ ...current, [threadKey]: response.threadId }));
      setMessages((current) => {
        let lastLiveIndex = -1;
        current.forEach((message, index) => {
          if (message.live && message.role === "assistant") lastLiveIndex = index;
        });
        return current.map((message, index) => index === lastLiveIndex
          ? { ...message, text: message.text || response.text, live: false, final: true }
          : message.live ? { ...message, live: false, final: false } : message);
      });
      for (const filePath of extractMentionedFilePaths(response.text)) {
        void invoke<string | null>("read_code_file", { cwd: activeProjectPathRef.current, path: filePath })
          .then((code) => {
            if (!code) return;
            const extension = filePath.split(/[\\/.]/).pop()?.toLowerCase();
            const activityId = nextTimelineSequence();
            setCodeActivity((current) => current.some((item) => item.detail === filePath && item.code)
              ? current
              : [{ id: activityId, turnId: activeTurnIdRef.current, kind: "file" as const, status: "done" as const, label: "Fájl tartalma", detail: filePath, eventType: "file/read", time: "most", code, language: extension }, ...current].slice(-80));
          })
          .catch(() => undefined);
      }
      setCodeStatus("kész");
      notify(response.threadRehydrated ? "Beszélgetés folytatva ezen a gépen" : "Codex válasz megérkezett", "complete");
    } catch (error) {
      const errorText = String(error);
      const wasCancelled = /megszakítva|leállítva|cancel/i.test(errorText);
      setMessages((current) => {
        let lastLiveIndex = -1;
        current.forEach((message, index) => {
          if (message.live && message.role === "assistant") lastLiveIndex = index;
        });
        return current.map((message, index) => index === lastLiveIndex
          ? { ...message, text: wasCancelled ? "A válasz megszakítva." : `Nem sikerült a Codex-kérés: ${errorText}`, live: false, final: true }
          : message.live ? { ...message, live: false, final: false } : message);
      });
      setCodeStatus(wasCancelled ? "kész" : "hiba");
      notify(wasCancelled ? "Codex-kérés megszakítva" : "Codex-kapcsolati hiba", wasCancelled ? undefined : "notify");
    } finally {
      setIsStreaming(false);
      setIsCancelling(false);
      if (activeRequestIdRef.current === requestId) activeRequestIdRef.current = null;
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey) {
      const textarea = event.currentTarget;
      const cursor = textarea.selectionStart;
      const beforeCursor = textarea.value.slice(0, cursor);
      const currentLine = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1);
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
    let title = baseTitle;
    let suffix = 2;
    while (project.threads.some((thread) => thread.toLowerCase() === title.toLowerCase())) title = `${baseTitle} ${suffix++}`;
    markProjectMutation();
    setProjects((current) => current.map((candidate) => candidate.id === project.id ? { ...candidate, threads: [...candidate.threads, title] } : candidate));
    setActiveProject(project.name);
    setActiveThread(title);
    if (isTauri && localStoreReady) {
      setLocalConversationCache((current) => ({
        ...current,
        [`${project.path}/${title}`]: {
          id: undefined,
          projectId: project.id,
          title,
          messages: [],
          workItems: [],
          threadId: null,
          updatedAt: new Date().toISOString(),
        },
      }));
    }
    setMessages([]);
    setCodeActivity([]);
    setCodeStatus("készen");
    shouldStickToBottom.current = true;
    setIsAtBottom(true);
    setExpandedWorkLogs({});
    setCommandsOpen(false);
    setOpenMenu(null);
    notify(`Új beszélgetés indult: ${title}`);
  };

  const newConversation = () => {
    const project = projects.find((candidate) => candidate.name === activeProject) ?? projects[0];
    if (!project) {
      notify("Előbb adj hozzá egy projektmappát");
      return;
    }
    newConversationForProject(project);
  };

  const selectProject = (project: Project) => {
    const thread = project.threads[0] ?? "";
    setActiveProject(project.name);
    setActiveThread(thread);
    setMessages(messagesForThread(`${project.path}/${thread}`));
    setCodeActivity(workItemsForThread(`${project.path}/${thread}`));
    setCodeStatus(workItemsForThread(`${project.path}/${thread}`).length > 0 ? "kész" : "készen");
    setExpandedWorkLogs({});
    setOpenProjects((current) => ({ ...current, [project.path]: true }));
  };

  const timelineContent = timelineEntries.map((entry) => {
    if (entry.kind === "message") {
      const nextMessage = messages[entry.messageIndex + 1];
      const isFinal = entry.message.final ?? (entry.message.role === "assistant" && entry.message.text.trim().length > 0 && (!nextMessage || nextMessage.role === "user"));
      const showAvatar = entry.message.role === "user" || messages[entry.messageIndex - 1]?.role !== "assistant";
      return <MessageRow key={entry.key} message={entry.message} isFinal={isFinal} showAvatar={showAvatar} />;
    }
    const isLatestGroup = entry.group.key === workLogGroups[workLogGroups.length - 1]?.key;
    return <CompactWorkFlowCard key={entry.key} expanded={expandedWorkLogs[entry.group.key] ?? false} activities={entry.group.activities} snippets={isLatestGroup ? codeSnippets : []} status={isLatestGroup ? codeStatus : "kész"} streaming={isStreaming && isLatestGroup} onToggle={() => setExpandedWorkLogs((current) => ({ ...current, [entry.group.key]: !(current[entry.group.key] ?? false) }))} />;
  });
  const hasPendingAssistant = messages.some((message) => message.role === "assistant" && !message.text.trim() && !message.final);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">m</div><span className="brand-name">min</span><span className="brand-status"><span className="status-dot" /> Codex · local</span></div>
        <div className="topbar-actions"><button className="icon-button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Sűrűség és szöveg beállításai">Aa</button><button className="icon-button" onClick={() => setCommandsOpen(true)} aria-label="Parancsok megnyitása">⌘K</button><button className="profile-button" aria-label="Profil">D</button></div>
        {settingsOpen && <div className="settings-popover"><div className="popover-heading"><span>Olvasási beállítások</span><span className="popover-hint">azonnal él</span></div><label className="range-row"><span>Betűméret</span><output>{fontSize}</output><input type="range" min="8" max="17" value={parseInt(fontSize, 10)} onChange={(event) => setFontSize(`${event.target.value}px`)} /></label><label className="range-row"><span>Sorköz</span><output>{lineHeight}</output><input type="range" min="100" max="180" value={Math.round(parseFloat(lineHeight) * 100)} onChange={(event) => setLineHeight((Number(event.target.value) / 100).toFixed(2))} /></label><button className="reset-button" onClick={() => { setFontSize("8px"); setLineHeight("1.00"); notify("Olvasási beállítások visszaállítva"); }}>Alapértékek visszaállítása</button></div>}
      </header>

      <div className="local-store-health" role="status" aria-live="polite">SQLite · {localStoreStatus}</div>

      {isTauri && <div className="workspace-root-control"><span title={workspaceRoot}>{workspaceRoot ? `Gyökér: ${workspaceRoot}` : "Nincs OneDrive-gyökér"}</span><button type="button" className="workspace-root-button" onClick={() => { void changeProjectsRoot(); }}>Módosítás</button></div>}

      <main className="workspace">
        <aside className="sidebar panel-edge"><div className="sidebar-heading"><span>Projektek</span><div className="new-project-wrap"><button className="new-button" onClick={() => setNewProjectMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={newProjectMenuOpen} title="Projekt hozzáadása">+</button>{newProjectMenuOpen && <div className="new-project-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setNewProjectMenuOpen(false); void addProject(); }}>New Project</button><button type="button" role="menuitem" onClick={() => { setNewProjectMenuOpen(false); void addExistingProject(); }}>Existing Project</button></div>}</div></div><div className="project-list">{projects.map((project) => { const isOpen = Boolean(openProjects[project.path]); return <section className={`project-group${isOpen ? " is-open" : ""}`} data-project={project.name} key={project.path}><div className="project-row-wrap"><button className="project-row" onClick={() => { selectProject(project); setOpenProjects((current) => ({ ...current, [project.path]: !isOpen })); }} aria-expanded={isOpen} title={project.path}><span className="chevron">{isOpen ? "⌄" : "›"}</span><span className="folder-icon">◫</span><span className="project-name">{project.name}</span><span className="project-count">{project.threads.length}</span></button><div className="overflow-menu-wrap"><button type="button" className="overflow-button" onClick={(event) => { event.stopPropagation(); setOpenMenu(openMenu?.kind === "project" && openMenu.key === project.id ? null : { kind: "project", key: project.id }); }} aria-haspopup="menu" aria-expanded={openMenu?.kind === "project" && openMenu.key === project.id} title="Projekt menüje">⋮</button>{openMenu?.kind === "project" && openMenu.key === project.id && <div className="overflow-menu" role="menu"><button type="button" onClick={() => { setOpenMenu(null); newConversationForProject(project); }}>Új beszélgetés</button><button type="button" onClick={() => { setOpenMenu(null); renameProject(project); }}>Átnevezés</button><button type="button" className="danger-action" onClick={() => deleteProject(project)}>Törlés</button></div>}</div></div><div className="conversation-list">{project.threads.map((thread) => { const menuKey = `${project.id}::${thread}`; return <div className="conversation-row-wrap" key={thread}><button className={`conversation-row${thread === activeThread && project.name === activeProject ? " is-active" : ""}`} onClick={() => selectThread(project, thread)} title={thread}><span className="conversation-dot" /><span>{thread}</span></button><div className="overflow-menu-wrap"><button type="button" className="overflow-button" onClick={(event) => { event.stopPropagation(); setOpenMenu(openMenu?.kind === "thread" && openMenu.key === menuKey ? null : { kind: "thread", key: menuKey }); }} aria-haspopup="menu" aria-expanded={openMenu?.kind === "thread" && openMenu.key === menuKey} title="Beszélgetés menüje">⋮</button>{openMenu?.kind === "thread" && openMenu.key === menuKey && <div className="overflow-menu" role="menu"><button type="button" onClick={() => { setOpenMenu(null); renameThread(project, thread); }}>Átnevezés</button><button type="button" className="danger-action" onClick={() => deleteThread(project, thread)}>Törlés</button></div>}</div></div>; })}</div></section>; })}</div><div className="sidebar-footer"><button type="button" className={`sync-health${syncWriteEnabled ? " is-ready" : " is-quarantine"}`} onClick={() => isTauri && setSyncHealthOpen((open) => !open)} aria-expanded={isTauri ? syncHealthOpen : undefined} aria-controls={isTauri ? "sync-health-panel" : undefined} title="Részletes Sync Health megnyitása"><span className="status-dot" /><span>Sync · {syncStatus}</span><span className="sync-health-chevron">{isTauri ? (syncHealthOpen ? "⌃" : "⌄") : ""}</span></button>{syncHealthOpen && <div id="sync-health-panel" className="sync-health-popover" role="dialog" aria-label="Sync Health"><div className="popover-heading"><span>Sync Health</span><span className="popover-hint">{syncHealth ? syncHealthStatusLabel(syncHealth.status) : "nincs adat"}</span></div>{syncHealth ? <><div className="sync-health-grid"><span>Utolsó ellenőrzés</span><strong>{formatSyncHealthTime(syncHealth.checkedAt)}</strong><span>Utolsó import</span><strong>{formatSyncHealthTime(syncHealth.lastImportAt)}</strong><span>Journal</span><strong>{syncHealth.scannedEvents} fájl · {syncHealth.acceptedEvents} valid</strong><span>Lokális SQLite</span><strong>{syncHealth.storedEvents} event</strong></div><div className="sync-health-path" title={syncHealth.journalPath}>Journal: {syncHealth.journalPath}</div><div className="sync-health-path" title={syncHealth.quarantinePath}>Quarantine: {syncHealth.quarantinePath}</div>{syncHealth.blockedDevices.length > 0 && <div className="sync-health-warning"><strong>Blokkolt eszközök</strong><ul>{syncHealth.blockedDevices.map((device) => <li key={device}>{device}</li>)}</ul></div>}{syncHealth.warnings.length > 0 && <div className="sync-health-warning"><strong>Figyelmeztetések</strong><ul>{syncHealth.warnings.slice(0, 3).map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>{syncHealth.warnings.length > 3 && <small>+{syncHealth.warnings.length - 3} további</small>}</div>}{tombstones.length > 0 && <section className="sync-recovery" aria-label="Recovery Center"><div className="sync-recovery-heading"><strong>Recovery Center</strong><span>{tombstones.length}</span></div><div className="sync-recovery-list">{tombstones.slice(0, 8).map((tombstone) => { const label = tombstone.title ?? tombstone.relativePath ?? tombstone.entityId; return <div className="sync-recovery-item" key={`${tombstone.entityType}:${tombstone.entityId}`}><div className="sync-recovery-main"><span className="sync-recovery-type">{syncTombstoneTypeLabel(tombstone.entityType)}</span><strong title={label}>{label}</strong><small>{formatSyncHealthTime(tombstone.archivedAt)}</small></div><button type="button" className="sync-recovery-restore" onClick={() => restoreTombstone(tombstone)} disabled={!syncWriteEnabled} title={syncWriteEnabled ? "Archivált entitás visszaállítása" : "A journal jelenleg csak olvasható"}>Visszaállítás</button></div>; })}</div>{tombstones.length > 8 && <small className="sync-recovery-more">+{tombstones.length - 8} további archivált elem</small>}</section>}<div className="sync-health-recovery">{syncHealth.recoveryAction}</div><div className="sync-health-actions"><button type="button" className="footer-action" onClick={refreshSync}><span>↻</span> Újraellenőrzés</button><button type="button" className="footer-action" onClick={() => setSyncHealthOpen(false)}><span>×</span> Bezárás</button></div></> : <div className="sync-health-empty">A v2 sync health még nem érkezett meg.</div>}</div>}<button className="footer-action"><span>⌕</span> Keresés</button><button className="footer-action" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}><span>⚙</span> Beállítások</button>{settingsOpen && <div className="settings-popover sidebar-settings-popover"><div className="popover-heading"><span>Olvasási beállítások</span><span className="popover-hint">azonnal él</span></div><label className="range-row"><span>Betűméret</span><output>{fontSize}</output><input type="range" min="8" max="17" value={parseInt(fontSize, 10)} onChange={(event) => setFontSize(`${event.target.value}px`)} /></label><label className="range-row"><span>Sorköz</span><output>{lineHeight}</output><input type="range" min="100" max="180" value={Math.round(parseFloat(lineHeight) * 100)} onChange={(event) => setLineHeight((Number(event.target.value) / 100).toFixed(2))} /></label><button className="reset-button" onClick={() => { setFontSize("8px"); setLineHeight("1.00"); notify("Olvasási beállítások visszaállítva"); }}>Alapértékek visszaállítása</button></div>}</div></aside>

        <section className="chat panel-edge">
          <div className="chat-header"><div><div className="eyebrow">{activeProjectData.name}</div><h1>{activeThread || "Nincs beszélgetés"}</h1></div><div className="chat-header-actions"><button className="header-icon" title="Keresés a beszélgetésben">⌕</button><button className="header-icon" title="Továbbiak">•••</button></div></div>
          <div className="message-stream" ref={messageStreamRef} onScroll={handleMessageScroll} onWheelCapture={handleMessageWheel}>
            {timelineContent}
            {isStreaming && !hasPendingAssistant && <div className="typing-row" aria-label="A min válaszol"><span /><span /><span /></div>}
            {isStreaming && !isAtBottom && <button type="button" className="jump-to-bottom" onClick={jumpToBottom}>↓ Legaljára</button>}
          </div>
          <form className="composer-wrap" onSubmit={submitMessage}><div className="composer"><textarea ref={inputRef} rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleInputKeyDown} placeholder="Írj egy üzenetet… (Enter küld, Shift+Enter új sor)" /><div className="composer-toolbar"><div className="composer-tools"><button type="button" className="tool-button" title="Fájl csatolása">＋</button><ModelPicker open={modelMenuOpen} loading={modelsLoading} activeLabel={activeLabel} selectedModel={selectedModel} modelFamilies={modelFamilies} activeFamily={activeFamily} activeEffortLabel={activeEffortLabel} supportedEfforts={supportedEfforts} activeEffortIndex={activeEffortIndex} onToggle={toggleModelMenu} onFamilyHover={setActiveFamilyKey} onSelectModel={selectModel} onSelectEffort={selectEffortIndex} /></div><button type="submit" className="send-button" aria-label="Üzenet küldése">↑</button></div></div></form>
        </section>

      </main>

      {isTauri && <section className="retention-dock" aria-label="Retention és purge ellenőrzés"><button type="button" className="retention-dock-toggle" onClick={refreshRetention}><span>↻</span> Retention ellenőrzése</button>{retentionPreview && <div className="retention-dock-result"><div className="popover-heading"><strong>Retention / purge</strong><span>{retentionPreview.eligibleCount} jelölt / {retentionPreview.retentionDays} nap</span></div><div className="retention-dock-status">{retentionPreview.protocolReady ? "ACK + backup gate kész · snapshot + purge indítható" : retentionPreview.purgeAllowed ? "Purge engedélyezve" : "Purge tiltva: gate vár"}</div><div className="retention-dock-digest" title={retentionPreview.currentJournalDigest}>Journal digest: <code>{retentionPreview.currentJournalDigest.slice(0, 16)}…</code></div><div className="retention-dock-actions"><button type="button" onClick={() => runRetentionAction("sync_v2_retention_ack", "Retention ACK elküldve a többi gép számára.")} disabled={!retentionPreview.health.canWrite}>Saját ACK</button><button type="button" onClick={() => runRetentionAction("sync_v2_retention_backup", "Lokális retention backup és ACK elkészült.")} disabled={!retentionPreview.health.canWrite}>Backup + ACK</button>{retentionPreview.purgeAllowed && <button type="button" onClick={() => runRetentionAction("sync_v2_retention_purge", "Compaction snapshot elkészült, a retention purge lefutott.")} disabled={!retentionPreview.health.canWrite}>Snapshot + purge</button>}</div><div className="retention-dock-devices">{retentionPreview.devices.map((device) => <div className="retention-dock-device" key={device.deviceId}><span title={device.deviceId}>{device.deviceId.slice(0, 8)}…</span><span>{device.ready ? "ACK rendben" : "ACK hiányzik"}</span><span>{device.backupVerified ? "backup rendben" : "nincs backup"}</span></div>)}</div>{retentionPreview.audit.length > 0 && <div className="retention-audit-log"><strong>Legutóbbi auditműveletek</strong><ul>{retentionPreview.audit.slice().reverse().slice(0, 8).map((entry) => <li key={entry.auditId}><span>{entry.action} · {entry.outcome} · {entry.deviceId.slice(0, 8)}…</span><small>{formatSyncHealthTime(entry.createdAt)}{entry.details ? ` · ${entry.details}` : ""}</small></li>)}</ul></div>}<ul>{retentionPreview.blockingReasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul></div>}</section>}

      {isTauri && retentionPreview && <section className="retention-audit-panel" aria-label="Részletes retention audit"><div className="retention-audit-heading"><strong>Retention audit</strong><span>{retentionSelection.length} / {retentionPreview.eligibleCount} kijelölve</span></div><div className="retention-audit-meta"><span>Journal: <code>{retentionPreview.currentEventCount} event</code></span><span>Digest: <code>{retentionPreview.currentJournalDigest.slice(0, 12)}…</code></span><span>Snapshot: <code>{retentionPreview.compactionSnapshotId ? `${retentionPreview.compactionSnapshotId.slice(0, 12)}…` : "nincs"}</code></span></div><div className="retention-audit-actions"><button type="button" onClick={selectAllEligibleRetention} disabled={!retentionPreview.purgeAllowed || retentionPreview.eligibleCount === 0}>Összes jelölt</button><button type="button" onClick={() => setRetentionSelection([])} disabled={retentionSelection.length === 0}>Kijelölés törlése</button><button type="button" className="is-danger" onClick={purgeSelectedRetention} disabled={!retentionPreview.purgeAllowed || retentionSelection.length === 0}>Kijelöltek purge</button></div><div className="retention-audit-list">{retentionPreview.candidates.map((candidate) => <label className={`retention-audit-item${candidate.eligible ? "" : " is-ineligible"}`} key={candidate.selectionKey}><input type="checkbox" checked={retentionSelection.includes(candidate.selectionKey)} disabled={!candidate.eligible || !retentionPreview.purgeAllowed} onChange={() => toggleRetentionSelection(candidate.selectionKey)} /><span className="retention-audit-copy"><strong title={candidate.entityId}>{syncTombstoneTypeLabel(candidate.entityType)} · {candidate.label}</strong><small>{candidate.ageDays === null ? "ismeretlen kor" : `${candidate.ageDays} napos`} · archiválva: {formatSyncHealthTime(candidate.archivedAt)}</small></span><em>{candidate.eligible ? "purge-jelölt" : candidate.reason}</em></label>)}</div>{retentionPreview.candidates.length === 0 && <div className="retention-audit-empty">Nincs archivált retention-jelölt.</div>}</section>}

      {isTauri && agentGuard && (agentGuard.changedFiles.length > 0 || agentGuard.addedFiles.length > 0 || agentGuard.removedFiles.length > 0) && <section className="agent-guard-dock" aria-label="Agent diff review"><div className="agent-guard-heading"><strong>{agentGuard.applyAvailable ? "Agent diff review" : "Agent rollback-pont"}</strong><span>{agentGuard.changedFiles.length + agentGuard.addedFiles.length + agentGuard.removedFiles.length} fájl</span></div><div className="agent-guard-summary">{agentGuard.applyAvailable ? "A változás stage-elve van; a canonical workspace base-állapotban maradt." : "A változás alkalmazva van; rollback kérhető."} Base-hash: <code>{agentGuard.baseHash.slice(0, 12)}…</code> · {agentGuard.isolationMode}{agentGuard.rebased ? " · 3-way rebased" : ""}</div><ul>{[...agentGuard.changedFiles.map((path) => `Módosult: ${path}`), ...agentGuard.addedFiles.map((path) => `Új: ${path}`), ...agentGuard.removedFiles.map((path) => `Törölt: ${path}`)].slice(0, 6).map((item) => <li key={item}>{item}</li>)}</ul>{agentGuard.applyAvailable ? <div className="agent-guard-actions"><button type="button" className="agent-guard-review" onClick={openAgentDiffPreview}>Diff megnyitása</button><button type="button" className="agent-guard-rebase" onClick={rebaseAgentSnapshot}>3-way merge</button><button type="button" className="agent-guard-discard" onClick={discardAgentSnapshot}>Elvetés</button><button type="button" className="agent-guard-apply" onClick={applyAgentSnapshot}>Alkalmazás</button></div> : <button type="button" className="agent-guard-rollback" onClick={rollbackAgentSnapshot} disabled={!agentGuard.rollbackAvailable}>Rollback az agent-turn előttre</button>}</section>}

      {isTauri && agentDiffPreview && <div className="agent-diff-overlay" role="dialog" aria-modal="true" aria-label="Agent diff preview"><div className="agent-diff-card"><div className="agent-diff-header"><div><span className="approval-eyebrow">Agent audit / diff</span><h2>Változások részletes nézete</h2></div><button type="button" className="agent-diff-close" onClick={() => setAgentDiffPreview(null)} aria-label="Diff bezárása">×</button></div><div className="agent-diff-meta"><span>Állapot: <strong>{agentDiffPreview.currentState}</strong></span><span>Akció: <strong>{agentDiffPreview.lastAction ?? "—"}</strong></span><span>Base: <code>{agentDiffPreview.baseHash.slice(0, 12)}…</code></span><span>Post: <code>{agentDiffPreview.postHash.slice(0, 12)}…</code></span></div><div className="agent-diff-files">{agentDiffPreview.files.map((file) => <section className="agent-diff-file" key={file.path}><div className="agent-diff-file-header"><strong>{file.path}</strong><span>{file.status}{file.binaryOrTruncated ? " · korlátozott" : ""}</span></div><pre>{file.lines.map((line, index) => <span className={`agent-diff-line ${line.kind}`} key={`${file.path}-${index}`}><b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : line.kind === "meta" ? "·" : " "}</b><code>{line.text || " "}</code></span>)}</pre></section>)}{agentDiffPreview.files.length === 0 && <div className="agent-diff-empty">Nincs fájlszintű eltérés.</div>}</div></div></div>}

      {isTauri && pendingApproval && <div className="approval-overlay" role="dialog" aria-modal="true" aria-label="Codex approval"><div className="approval-card"><div className="approval-card-header"><div><span className="approval-eyebrow">Codex approval</span><h2>{pendingApproval.kind === "fileChange" ? "Fájlmódosítás jóváhagyása" : "Parancs jóváhagyása"}</h2></div><span className="approval-badge">várakozik</span></div><p className="approval-reason">{pendingApproval.reason ?? "A Codex egy projektművelet folytatásához engedélyt kér."}</p>{pendingApproval.command && <pre className="approval-command">{pendingApproval.command}</pre>}{pendingApproval.cwd && <div className="approval-path" title={pendingApproval.cwd}>CWD: {pendingApproval.cwd}</div>}<div className="approval-actions"><button type="button" className="approval-decline" onClick={() => respondToApproval("decline")}>Elutasítom</button><button type="button" className="approval-cancel" onClick={() => respondToApproval("cancel")}>Mégse</button><button type="button" className="approval-accept-session" onClick={() => respondToApproval("acceptForSession")}>Elfogadom sessionre</button><button type="button" className="approval-accept" onClick={() => respondToApproval("accept")}>Elfogadom</button></div><small className="approval-hint">Döntés nélkül 5 perc után automatikusan elutasítás történik.</small></div></div>}

      {toast && <div className="toast is-visible" role="status">{toast}</div>}
      {commandsOpen && <div className="command-overlay" onClick={(event) => { if (event.target === event.currentTarget) setCommandsOpen(false); }}><div className="command-modal"><div className="command-search"><span>⌕</span><input autoFocus placeholder="Parancs keresése…" /></div><button onClick={newConversation}><kbd>N</kbd><span>Új beszélgetés</span></button><button onClick={() => { setCommandsOpen(false); notify("Projekt keresése hamarosan"); }}><kbd>P</kbd><span>Projekt keresése</span></button><button onClick={() => { setCommandsOpen(false); setSettingsOpen(true); }}><kbd>A</kbd><span>Olvasási beállítások</span></button><button onClick={() => { setCommandsOpen(false); const key = latestWorkLogKeyRef.current; if (key) setExpandedWorkLogs((current) => ({ ...current, [key]: true })); }}><kbd>G</kbd><span>Kódolási kártya megnyitása</span></button></div></div>}
    </div>
  );
}

export default App;
