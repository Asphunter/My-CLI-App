export type RunInputMode = "steer" | "follow_up";

export type RunInputProvider = "codex" | "anthropic" | "kimi" | "deepseek";

export type RunInputAccessProfile =
  | "claude"
  | "kimiCode"
  | "kimiOpenPlatform"
  | "deepseekApi";

export type RunInputStageRole = "plan" | "plan_review" | "code" | "review";

export type RunInputErrorCode =
  | "no_active_run"
  | "no_active_turn"
  | "target_changed"
  | "transport_closed"
  | "provider_rejected"
  | "unsupported_payload"
  | "duplicate_input"
  | "run_cancelled"
  | "runtime_failed";

export type RunInputTarget = {
  conversationId: string;
  rootRequestId: string;
  providerRequestId: string;
  provider: RunInputProvider;
  providerThreadId?: string;
  providerTurnId?: string;
  pipelineRunId?: string;
  stageIndex?: number;
  stageRole?: RunInputStageRole;
  stageEpoch: number;
};

export type RunInputQuoteReference = {
  id: string;
  text: string;
  instruction: string;
  anchorId: string;
};

export type RunInputPendingImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type RunInputPayload = {
  inputId: string;
  mode: RunInputMode;
  text: string;
  modelPrompt: string;
  quoteRefs: RunInputQuoteReference[];
  images: RunInputPendingImage[];
  target?: RunInputTarget;
  createdAt: string;
};

export type RunInputDelivery =
  | { status: "draft" }
  | { status: "sending"; sentAt: string }
  | { status: "accepted"; acceptedAt: string; target: RunInputTarget }
  | {
      status: "failed";
      code: RunInputErrorCode;
      message: string;
      failedAt: string;
    };

export type RuntimeInput = {
  payload: RunInputPayload;
  delivery: RunInputDelivery;
};

export type FollowUpRequestSettings = {
  mode: "general" | "coding";
  provider: RunInputProvider;
  projectId?: string | null;
  projectPath?: string | null;
  conversationKey?: string | null;
  model?: string | null;
  effort?: string | null;
  accessProfile?: RunInputAccessProfile | null;
  detailed: boolean;
  pipelineRecipeId?: string | null;
  pipelineEnabled: boolean;
  maxBudgetUsd?: number | null;
  maxTurns?: number | null;
  pipelineStageOverrides?: Array<{
    model?: string;
    effort?: string;
    provider?: RunInputProvider;
    accessProfile?: RunInputAccessProfile;
  }>;
};

export type QueuedFollowUp = {
  id: string;
  conversationId: string;
  position: number;
  body: string;
  modelPrompt: string;
  quoteRefs: RunInputQuoteReference[];
  attachments: RunInputPendingImage[];
  requestSettings: FollowUpRequestSettings;
  createdAt: string;
  updatedAt: string;
};

export type RunInputState = {
  inputs: Record<string, RuntimeInput>;
  inputOrder: string[];
  followUps: QueuedFollowUp[];
};

export const EMPTY_RUN_INPUT_STATE: RunInputState = {
  inputs: {},
  inputOrder: [],
  followUps: [],
};

export type RunInputAction =
  | { type: "send_started"; payload: RunInputPayload; sentAt: string }
  | {
      type: "accepted";
      inputId: string;
      acceptedAt: string;
      target: RunInputTarget;
    }
  | {
      type: "failed";
      inputId: string;
      code: RunInputErrorCode;
      message: string;
      failedAt: string;
    }
  | { type: "remove_input"; inputId: string }
  | { type: "hydrate_follow_ups"; followUps: QueuedFollowUp[] }
  | { type: "enqueue_follow_up"; followUp: QueuedFollowUp }
  | { type: "update_follow_up"; followUp: QueuedFollowUp }
  | { type: "delete_follow_up"; id: string }
  | { type: "move_follow_up"; id: string; direction: -1 | 1 };

const normalizeFollowUpOrder = (followUps: QueuedFollowUp[]) =>
  [...followUps]
    .sort(
      (left, right) =>
        left.conversationId.localeCompare(right.conversationId) ||
        left.position - right.position ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((followUp, index, all) => {
      const peersBefore = all
        .slice(0, index)
        .filter((candidate) => candidate.conversationId === followUp.conversationId)
        .length;
      return { ...followUp, position: peersBefore };
    });

export const runInputReducer = (
  state: RunInputState,
  action: RunInputAction,
): RunInputState => {
  switch (action.type) {
    case "send_started": {
      const exists = Boolean(state.inputs[action.payload.inputId]);
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [action.payload.inputId]: {
            payload: action.payload,
            delivery: { status: "sending", sentAt: action.sentAt },
          },
        },
        inputOrder: exists
          ? state.inputOrder
          : [...state.inputOrder, action.payload.inputId],
      };
    }
    case "accepted": {
      const current = state.inputs[action.inputId];
      if (!current || current.delivery.status === "accepted") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [action.inputId]: {
            payload: { ...current.payload, target: action.target },
            delivery: {
              status: "accepted",
              acceptedAt: action.acceptedAt,
              target: action.target,
            },
          },
        },
      };
    }
    case "failed": {
      const current = state.inputs[action.inputId];
      if (!current || current.delivery.status === "accepted") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [action.inputId]: {
            ...current,
            delivery: {
              status: "failed",
              code: action.code,
              message: action.message,
              failedAt: action.failedAt,
            },
          },
        },
      };
    }
    case "remove_input": {
      if (!state.inputs[action.inputId]) return state;
      const inputs = { ...state.inputs };
      delete inputs[action.inputId];
      return {
        ...state,
        inputs,
        inputOrder: state.inputOrder.filter((id) => id !== action.inputId),
      };
    }
    case "hydrate_follow_ups":
      return { ...state, followUps: normalizeFollowUpOrder(action.followUps) };
    case "enqueue_follow_up":
      return {
        ...state,
        followUps: normalizeFollowUpOrder([
          ...state.followUps.filter((item) => item.id !== action.followUp.id),
          action.followUp,
        ]),
      };
    case "update_follow_up":
      return {
        ...state,
        followUps: normalizeFollowUpOrder(
          state.followUps.map((item) =>
            item.id === action.followUp.id ? action.followUp : item,
          ),
        ),
      };
    case "delete_follow_up":
      return {
        ...state,
        followUps: normalizeFollowUpOrder(
          state.followUps.filter((item) => item.id !== action.id),
        ),
      };
    case "move_follow_up": {
      const followUps = [...state.followUps];
      const index = followUps.findIndex((item) => item.id === action.id);
      if (index < 0) return state;
      const peerIndexes = followUps
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter(
          ({ item }) =>
            item.conversationId === followUps[index].conversationId,
        )
        .map(({ itemIndex }) => itemIndex);
      const peerIndex = peerIndexes.indexOf(index);
      const swapPeerIndex = peerIndex + action.direction;
      if (swapPeerIndex < 0 || swapPeerIndex >= peerIndexes.length) return state;
      const swapIndex = peerIndexes[swapPeerIndex];
      [followUps[index], followUps[swapIndex]] = [
        followUps[swapIndex],
        followUps[index],
      ];
      let nextPosition = 0;
      const reordered = followUps.map((item) =>
        item.conversationId === followUps[index].conversationId
          ? { ...item, position: nextPosition++ }
          : item,
      );
      return { ...state, followUps: normalizeFollowUpOrder(reordered) };
    }
    default:
      return state;
  }
};

export type RunInputRunLike = {
  requestId: string;
  ownerConversationId: string;
  provider: RunInputProvider;
  threadId?: string;
  providerTurnId?: string;
  stageEpoch: number;
  status: "preparing" | "streaming" | "finalizing" | "done";
  turnCompleted: boolean;
};

export type RunInputPipelineProgressLike = {
  runId: string;
  requestId: string;
  stageIndex: number;
  role: RunInputStageRole;
  stageEpoch: number;
  phase: "started" | "finished" | "failed";
};

export const resolveRunInputTarget = (
  conversationId: string | null | undefined,
  runs: Iterable<RunInputRunLike>,
  pipelineProgress?: RunInputPipelineProgressLike | null,
): RunInputTarget | null => {
  const owner = conversationId?.trim();
  if (!owner) return null;
  const run = [...runs].find(
    (candidate) => candidate.ownerConversationId === owner,
  );
  if (
    !run ||
    run.status !== "streaming" ||
    run.turnCompleted ||
    !run.providerTurnId?.trim()
  )
    return null;

  const stageActive =
    pipelineProgress?.phase === "started" &&
    pipelineProgress.requestId.trim().length > 0;
  return {
    conversationId: owner,
    rootRequestId: run.requestId,
    providerRequestId: stageActive
      ? pipelineProgress.requestId
      : run.requestId,
    provider: run.provider,
    providerThreadId: run.threadId,
    providerTurnId: run.providerTurnId,
    pipelineRunId: stageActive ? pipelineProgress.runId : undefined,
    stageIndex: stageActive ? pipelineProgress.stageIndex : undefined,
    stageRole: stageActive ? pipelineProgress.role : undefined,
    stageEpoch: stageActive
      ? pipelineProgress.stageEpoch
      : run.stageEpoch,
  };
};

export const followUpsForConversation = (
  state: RunInputState,
  conversationId: string | null | undefined,
) =>
  conversationId
    ? state.followUps
        .filter((item) => item.conversationId === conversationId)
        .sort((left, right) => left.position - right.position)
    : [];

export const runtimeInputsForConversation = (
  state: RunInputState,
  conversationId: string | null | undefined,
) =>
  conversationId
    ? state.inputOrder
        .map((id) => state.inputs[id])
        .filter(
          (input): input is RuntimeInput =>
            Boolean(input) &&
            input.payload.target?.conversationId === conversationId,
        )
    : [];

export const describeRunInputError = (code: RunInputErrorCode) => {
  switch (code) {
    case "no_active_run":
      return "Ehhez a beszélgetéshez már nem fut válasz.";
    case "no_active_turn":
      return "A provider turnje már lezárult; az üzenet következőként küldhető.";
    case "target_changed":
      return "Közben másik fázis indult; válaszd ki újra a célját.";
    case "transport_closed":
      return "A provider kapcsolata közben lezárult.";
    case "provider_rejected":
      return "A provider nem fogadta el a menet közbeni üzenetet.";
    case "unsupported_payload":
      return "Ez a tartalom menet közben még nem küldhető.";
    case "duplicate_input":
      return "Ezt az üzenetet a futás már feldolgozta.";
    case "run_cancelled":
      return "A futást az üzenet elfogadása előtt leállították.";
    case "runtime_failed":
      return "A provider futtatója hibával leállt.";
  }
};
