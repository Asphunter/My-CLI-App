export type TimelineMessageLike = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  live?: boolean;
  final?: boolean;
  sequence?: number;
  turnId?: string;
  hlc?: string;
  originDeviceId?: string;
  /** Set on every answer a chain produced, one per stage. */
  pipeline?: { runId: string; stageIndex: number };
  interaction?: {
    kind: "steer";
    inputId: string;
    parentTurnId: string;
    targetRequestId?: string;
    pipelineRunId?: string;
    stageIndex?: number;
  };
};

export type TimelineActivityLike = {
  id: number;
  turnId?: string;
  hlc?: string;
  originDeviceId?: string;
};

export type TimelinePlanLike = {
  turnId: string | null;
  steps: Array<{ id: string; status: string }>;
  startedAt?: number;
  completedAt?: number;
  stepTimes?: Record<
    string,
    { startedAt?: number; completedAt?: number }
  >;
};

export type TimelineCommentaryLike = {
  turnId?: string;
  sequence?: number;
};

export type WorkLogGroup<
  Activity extends TimelineActivityLike = TimelineActivityLike,
> = {
  key: string;
  /** Raw turn ids folded into this one visual session. */
  turnKeys?: string[];
  /** Stable user-message bucket used to keep a session in place. */
  userMessageKey?: string;
  activities: Activity[];
  sequence: number;
  hlc?: string;
  originDeviceId?: string;
};

type GroupEvidence = {
  sequence: number;
  hlc?: string;
  originDeviceId?: string;
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const messageSequence = (message: TimelineMessageLike, index: number) =>
  finiteNumber(message.sequence) ? message.sequence : index;

export const isSteerTimelineMessage = (message: TimelineMessageLike) =>
  message.role === "user" && message.interaction?.kind === "steer";

const findLastMessageIndex = <Message extends TimelineMessageLike>(
  messages: Message[],
  matches: (message: Message) => boolean,
) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (matches(messages[index])) return index;
  }
  return -1;
};

export const userMessageKeyAtIndex = (
  messages: TimelineMessageLike[],
  index: number,
) => {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message?.role === "user" && !isSteerTimelineMessage(message))
      return message.id ?? `user:${messageSequence(message, cursor)}`;
  }
  return undefined;
};

export const workGroupTurnKeys = (group: WorkLogGroup) =>
  [group.key, ...(group.turnKeys ?? [])].filter(
    (key, index, values): key is string =>
      Boolean(key) && values.indexOf(key) === index,
  );

const planSequence = (plan: TimelinePlanLike) => {
  const stepTimes = Object.values(plan.stepTimes ?? {});
  const candidates = [
    plan.startedAt,
    ...stepTimes.map((timing) => timing.startedAt),
    plan.completedAt,
    ...stepTimes.map((timing) => timing.completedAt),
  ].filter(finiteNumber);
  return candidates.length > 0 ? Math.min(...candidates) : undefined;
};

export const buildWorkLogGroups = <
  Message extends TimelineMessageLike,
  Activity extends TimelineActivityLike,
  Plan extends TimelinePlanLike,
  Commentary extends TimelineCommentaryLike,
>({
  messages,
  activities,
  planHistory,
  commentary,
  activeTurnKey,
  compareActivities,
}: {
  messages: Message[];
  activities: Activity[];
  planHistory: Record<string, Plan>;
  commentary: Commentary[];
  activeTurnKey?: string;
  compareActivities?: (left: Activity, right: Activity) => number;
}): WorkLogGroup<Activity>[] => {
  const userMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.role === "user" && !isSteerTimelineMessage(message),
    )
    .map(({ message, index }) => ({
      key: message.id ?? `user:${messageSequence(message, index)}`,
      sequence: messageSequence(message, index),
    }))
    .sort((left, right) => left.sequence - right.sequence);
  const userSequenceByKey = new Map(
    userMessages.map((message) => [message.key, message.sequence]),
  );
  const precedingUserBucket = (sequence: number) => {
    let bucket: (typeof userMessages)[number] | undefined;
    for (const message of userMessages) {
      if (message.sequence <= sequence) bucket = message;
      else break;
    }
    return bucket?.key ?? "before-first-user";
  };

  // A chain's stages all follow one prompt, so bucketing by the preceding user
  // message folded the whole run into a single card. That card then showed only
  // its last answer -- the review -- and the plan and the coding answer fell out
  // as plain rows below it, which is why a run read back to front. Each stage
  // gets its own bucket instead, and therefore its own card, steps and diff.
  const stageBucketByTurn = new Map<string, string>();
  const stageUserKeyByBucket = new Map<string, string>();
  const stageBoundsByUserKey = new Map<
    string,
    Array<{ sequence: number; bucket: string }>
  >();
  messages.forEach((message, index) => {
    const stage = message.pipeline;
    if (message.role !== "assistant" || !stage || !message.turnId) return;
    const sequence = messageSequence(message, index);
    const userKey =
      userMessageKeyAtIndex(messages, index) ?? precedingUserBucket(sequence);
    const bucket = `${userKey}::run:${stage.runId}#${stage.stageIndex}`;
    stageBucketByTurn.set(message.turnId, bucket);
    stageUserKeyByBucket.set(bucket, userKey);
    const bounds = stageBoundsByUserKey.get(userKey) ?? [];
    bounds.push({ sequence, bucket });
    bounds.sort((left, right) => left.sequence - right.sequence);
    stageBoundsByUserKey.set(userKey, bounds);
  });
  const stageBucket = (turnKey: string | undefined) =>
    turnKey ? stageBucketByTurn.get(turnKey) : undefined;
  // Work items are recorded against the provider's own thread id, which never
  // matches the request id an answer carries, so a stage's steps could not be
  // found by id. The stages of a chain run strictly one after another, so the
  // clock settles it: a step belongs to the first stage that had not answered
  // yet when the step happened.
  const stageBucketAt = (userKey: string, sequence: number) => {
    const bounds = stageBoundsByUserKey.get(userKey);
    if (!bounds?.length) return undefined;
    return (bounds.find((stage) => sequence <= stage.sequence) ?? bounds[bounds.length - 1])
      .bucket;
  };

  type MutableGroup = WorkLogGroup<Activity> & {
    turnKeySet: Set<string>;
  };
  const groups = new Map<string, MutableGroup>();
  const turnBucketHints = new Map<string, Set<string>>();
  const rememberTurnBucket = (turnKey: string, bucket: string) => {
    if (!turnKey) return;
    const buckets = turnBucketHints.get(turnKey) ?? new Set<string>();
    buckets.add(bucket);
    turnBucketHints.set(turnKey, buckets);
  };
  const bucketHint = (turnKey: string) => {
    const buckets = turnBucketHints.get(turnKey);
    return buckets?.size === 1 ? [...buckets][0] : undefined;
  };
  const ensureGroup = (
    bucket: string,
    turnKey: string | undefined,
    evidence: GroupEvidence,
  ) => {
    const key = `session:${bucket}`;
    // A fázis-bucket `userKey::run:<id>#<n>` alakú, a padló viszont user-kulcsra
    // van indexelve: a nyers `bucket`-tel a lekérdezés mindig elvétett, így a
    // csoport padló nélkül maradt. Egyetlen régebbi bizonyíték (a 244. sori
    // minimum-szabály miatt) ilyenkor lerántotta a csoportot a saját kérdése
    // elé — innen ugrott fel a legutolsó válasz kártyája fázisváltáskor.
    const floor = userSequenceByKey.get(
      stageUserKeyByBucket.get(bucket) ?? bucket,
    );
    const sequence = finiteNumber(floor)
      // A trace card owns the answer for this user turn, so it must never
      // sort before the user row. Older plan/activity metadata can have the
      // exact same (or an earlier) timestamp as the submitted prompt; using
      // the prompt sequence verbatim then lets HLC/tie-breakers put the whole
      // answer card above its question after a restart. A fractional local
      // anchor preserves the immutable integer message positions while
      // placing such a card strictly after its user.
      ? Math.max(floor + 0.5, evidence.sequence)
      : evidence.sequence;
    let group = groups.get(bucket);
    if (!group) {
      group = {
        key,
        turnKeys: [],
        turnKeySet: new Set<string>(),
        userMessageKey:
          bucket === "before-first-user"
            ? undefined
            : (stageUserKeyByBucket.get(bucket) ?? bucket),
        activities: [],
        sequence,
        hlc: evidence.hlc,
        originDeviceId: evidence.originDeviceId,
      };
      groups.set(bucket, group);
    } else if (sequence < group.sequence) {
      group.sequence = sequence;
      group.hlc = evidence.hlc ?? group.hlc;
      group.originDeviceId =
        evidence.originDeviceId ?? group.originDeviceId;
    }
    if (turnKey) {
      group.turnKeySet.add(turnKey);
      group.turnKeys = [...group.turnKeySet];
      rememberTurnBucket(turnKey, bucket);
    }
    return group;
  };

  // Bucket each activity independently. A server/thread fallback turn id can
  // repeat across requests; grouping by turn id first would collapse history.
  for (const activity of activities) {
    const bucket = precedingUserBucket(activity.id);
    const group = ensureGroup(
      stageBucket(activity.turnId) ?? stageBucketAt(bucket, activity.id) ?? bucket,
      activity.turnId ?? "legacy",
      {
        sequence: activity.id,
        hlc: activity.hlc,
        originDeviceId: activity.originDeviceId,
      },
    );
    group.activities.push(activity);
  }

  for (const entry of commentary) {
    if (!entry.turnId || !finiteNumber(entry.sequence)) continue;
    const bucket = precedingUserBucket(entry.sequence);
    ensureGroup(
      stageBucket(entry.turnId) ?? stageBucketAt(bucket, entry.sequence) ?? bucket,
      entry.turnId,
      { sequence: entry.sequence },
    );
  }

  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.turnId) return;
    const sequence = messageSequence(message, index);
    const bucket =
      userMessageKeyAtIndex(messages, index) ?? precedingUserBucket(sequence);
    ensureGroup(stageBucket(message.turnId) ?? bucket, message.turnId, {
      sequence,
      hlc: message.hlc,
      originDeviceId: message.originDeviceId,
    });
  });

  for (const [historyKey, plan] of Object.entries(planHistory)) {
    const turnKey = plan.turnId ?? historyKey;
    const sequence = planSequence(plan);
    const hintedBucket = bucketHint(turnKey);
    const bucket =
      hintedBucket ??
      (finiteNumber(sequence)
        ? precedingUserBucket(sequence)
        : "before-first-user");
    ensureGroup(bucket, historyKey, {
      sequence:
        sequence ??
        userSequenceByKey.get(bucket) ??
        Number.MAX_SAFE_INTEGER,
    });
    if (turnKey !== historyKey)
      ensureGroup(bucket, turnKey, {
        sequence:
          sequence ??
          userSequenceByKey.get(bucket) ??
          Number.MAX_SAFE_INTEGER,
      });
  }

  const pendingAssistantIndex = findLastMessageIndex(
    messages,
    (message) =>
      message.role === "assistant" && Boolean(message.live) && !message.final,
  );
  if (pendingAssistantIndex >= 0) {
    const pendingAssistant = messages[pendingAssistantIndex];
    const sequence = messageSequence(pendingAssistant, pendingAssistantIndex);
    const bucket =
      userMessageKeyAtIndex(messages, pendingAssistantIndex) ??
      precedingUserBucket(sequence);
    const pendingKey = pendingAssistant.id
      ? `pending:${pendingAssistant.id}`
      : undefined;
    ensureGroup(bucket, pendingKey, {
      sequence,
      hlc: pendingAssistant.hlc,
      originDeviceId: pendingAssistant.originDeviceId,
    });
    ensureGroup(bucket, activeTurnKey, {
      sequence,
      hlc: pendingAssistant.hlc,
      originDeviceId: pendingAssistant.originDeviceId,
    });
  }

  return [...groups.values()]
    .map(({ turnKeySet: _turnKeySet, ...group }) => ({
      ...group,
      activities: compareActivities
        ? [...group.activities].sort(compareActivities)
        : [...group.activities].sort((left, right) => left.id - right.id),
    }))
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.key.localeCompare(right.key),
    );
};

export const findActiveWorkGroup = <
  Message extends TimelineMessageLike,
  Activity extends TimelineActivityLike,
>(
  groups: WorkLogGroup<Activity>[],
  messages: Message[],
  activeTurnKey?: string,
) => {
  const pendingIndex = findLastMessageIndex(
    messages,
    (message) =>
      message.role === "assistant" && Boolean(message.live) && !message.final,
  );
  if (pendingIndex < 0) return undefined;
  const pending = messages[pendingIndex];
  const pendingKey = pending.id ? `pending:${pending.id}` : undefined;
  const userKey = userMessageKeyAtIndex(messages, pendingIndex);
  const candidates = userKey
    ? groups.filter((group) => group.userMessageKey === userKey)
    : groups;
  return (
    candidates.find(
      (group) =>
        Boolean(activeTurnKey) &&
        workGroupTurnKeys(group).includes(activeTurnKey!),
    ) ??
    candidates.find(
      (group) =>
        Boolean(pendingKey) && workGroupTurnKeys(group).includes(pendingKey!),
    ) ??
    candidates[0]
  );
};

export const messageBelongsToWorkGroup = (
  messages: TimelineMessageLike[],
  messageIndex: number,
  group: WorkLogGroup,
) => {
  const message = messages[messageIndex];
  if (!message) return false;
  const turnKeys = new Set(workGroupTurnKeys(group));
  if (isSteerTimelineMessage(message)) {
    const interaction = message.interaction!;
    if (
      interaction.stageIndex !== undefined &&
      (interaction.pipelineRunId
        ? group.key.includes(
            `::run:${interaction.pipelineRunId}#${interaction.stageIndex}`,
          )
        : group.key.endsWith(`#${interaction.stageIndex}`))
    )
      return true;
    if (turnKeys.has(interaction.parentTurnId)) return true;
    const parent = messages.find(
      (candidate) =>
        candidate.role === "user" &&
        !isSteerTimelineMessage(candidate) &&
        candidate.turnId === interaction.parentTurnId,
    );
    const parentKey = parent?.id;
    return Boolean(parentKey && group.userMessageKey === parentKey);
  }
  // A provider session id is not necessarily a turn id. DeepSeek reuses the
  // same session id for consecutive requests, so that id can legitimately be
  // present in more than one visual group. The user bucket is the per-request
  // boundary: require it as well whenever both sides have one. Without this,
  // the newest answer matched every older group carrying the same session id
  // and was rendered in all of their VÁLASZ panels.
  if (message.turnId) {
    if (!turnKeys.has(message.turnId)) return false;
    const messageUserKey = userMessageKeyAtIndex(messages, messageIndex);
    if (
      group.userMessageKey &&
      messageUserKey &&
      messageUserKey !== group.userMessageKey
    )
      return false;
    return true;
  }
  return Boolean(
    group.userMessageKey &&
      userMessageKeyAtIndex(messages, messageIndex) === group.userMessageKey,
  );
};

const planTimestamp = (plan: TimelinePlanLike) =>
  Math.max(
    plan.completedAt ?? 0,
    plan.startedAt ?? 0,
    ...Object.values(plan.stepTimes ?? {}).map(
      (timing) => timing.completedAt ?? timing.startedAt ?? 0,
    ),
  );

const planRank = (plan: TimelinePlanLike) => [
  plan.completedAt !== undefined ? 1 : 0,
  planTimestamp(plan),
  plan.steps.filter((step) => step.status === "completed").length,
  plan.steps.length,
];

const comparePlanRank = (left: TimelinePlanLike, right: TimelinePlanLike) => {
  const leftRank = planRank(left);
  const rightRank = planRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index])
      return leftRank[index] - rightRank[index];
  }
  return 0;
};

export const mergePlanHistoryRecords = <Plan extends TimelinePlanLike>(
  primary: Record<string, Plan> = {},
  secondary: Record<string, Plan> = {},
) => {
  const merged = { ...primary };
  for (const [key, candidate] of Object.entries(secondary)) {
    const existing = merged[key];
    if (!existing || comparePlanRank(existing, candidate) <= 0)
      merged[key] = candidate;
  }
  return merged;
};

// Once a request is no longer streaming, an in-progress step can only be a
// persisted remnant of an interrupted process. Render it as interrupted
// instead of showing an immortal loading spinner after restart.
export const settleHistoricalPlan = <Plan extends TimelinePlanLike>(
  plan: Plan,
): Plan => {
  const interruptedStepIds = new Set(
    plan.steps
      .filter((step) => step.status === "inProgress")
      .map((step) => step.id),
  );
  if (interruptedStepIds.size === 0) return plan;

  const settledAt = (plan.completedAt ?? planTimestamp(plan)) || undefined;
  const stepTimes = { ...(plan.stepTimes ?? {}) };
  for (const stepId of interruptedStepIds) {
    stepTimes[stepId] = {
      ...(stepTimes[stepId] ?? {}),
      completedAt: stepTimes[stepId]?.completedAt ?? settledAt,
    };
  }

  return {
    ...plan,
    completedAt: settledAt,
    steps: plan.steps.map((step) =>
      interruptedStepIds.has(step.id) ? { ...step, status: "error" } : step,
    ),
    stepTimes,
  } as Plan;
};
