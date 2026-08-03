//! Provider-neutral contracts for coding-agent runtimes.
//!
//! Codex keeps its app-server path, while Claude, Kimi and DeepSeek use a
//! common bridge contract. These types keep provider, runtime and access
//! profile separate so compatible wire formats never make one vendor look
//! like another.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentProvider {
    Codex,
    Anthropic,
    Kimi,
    #[serde(rename = "deepseek")]
    DeepSeek,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRuntimeKind {
    CodexAppServer,
    ClaudeAgentBridge,
    CompatibleAgentBridge,
}

/// Billing/authentication route for providers that expose more than one API
/// product. Provider identity deliberately stays separate from wire protocol:
/// Kimi and DeepSeek are never labelled as Claude just because their endpoint
/// can understand Anthropic Messages.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AgentAccessProfile {
    Claude,
    KimiCode,
    KimiOpenPlatform,
    #[serde(rename = "deepseekApi")]
    DeepSeekApi,
}

impl AgentProvider {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "ChatGPT",
            Self::Anthropic => "Claude",
            Self::Kimi => "Kimi",
            Self::DeepSeek => "DeepSeek",
        }
    }

    pub fn default_runtime(self) -> AgentRuntimeKind {
        match self {
            Self::Codex => AgentRuntimeKind::CodexAppServer,
            Self::Anthropic => AgentRuntimeKind::ClaudeAgentBridge,
            Self::Kimi | Self::DeepSeek => AgentRuntimeKind::CompatibleAgentBridge,
        }
    }

}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentInputErrorCode {
    NoActiveRun,
    NoActiveTurn,
    TargetChanged,
    TransportClosed,
    ProviderRejected,
    UnsupportedPayload,
    DuplicateInput,
    RunCancelled,
    RuntimeFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInputTarget {
    pub conversation_id: String,
    pub root_request_id: String,
    pub provider_request_id: String,
    pub provider: AgentProvider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_role: Option<String>,
    pub stage_epoch: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerRequest {
    pub input_id: String,
    pub conversation_id: String,
    pub root_request_id: String,
    pub provider_request_id: String,
    pub provider: AgentProvider,
    pub expected_provider_turn_id: String,
    pub expected_stage_epoch: u64,
    pub text: String,
    #[serde(default)]
    pub pipeline_run_id: Option<String>,
    #[serde(default)]
    pub stage_index: Option<i64>,
    #[serde(default)]
    pub stage_role: Option<String>,
}

impl AgentSteerRequest {
    pub fn target(
        &self,
        provider_thread_id: Option<String>,
        provider_turn_id: Option<String>,
    ) -> AgentInputTarget {
        AgentInputTarget {
            conversation_id: self.conversation_id.clone(),
            root_request_id: self.root_request_id.clone(),
            provider_request_id: self.provider_request_id.clone(),
            provider: self.provider,
            provider_thread_id,
            provider_turn_id,
            pipeline_run_id: self.pipeline_run_id.clone(),
            stage_index: self.stage_index,
            stage_role: self.stage_role.clone(),
            stage_epoch: self.expected_stage_epoch,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerQueued {
    pub input_id: String,
    pub queued_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerError {
    pub code: AgentInputErrorCode,
    pub message: String,
}

impl AgentSteerError {
    pub fn new(code: AgentInputErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentInputStatus {
    Sending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInputStatusEvent {
    pub input_id: String,
    pub conversation_id: String,
    pub root_request_id: String,
    pub provider_request_id: String,
    pub status: AgentInputStatus,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<AgentInputErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_target: Option<AgentInputTarget>,
}

impl AgentInputStatusEvent {
    pub fn sending(request: &AgentSteerRequest) -> Self {
        Self {
            input_id: request.input_id.clone(),
            conversation_id: request.conversation_id.clone(),
            root_request_id: request.root_request_id.clone(),
            provider_request_id: request.provider_request_id.clone(),
            status: AgentInputStatus::Sending,
            timestamp: now_timestamp(),
            code: None,
            message: None,
            accepted_target: None,
        }
    }

    pub fn accepted(request: &AgentSteerRequest, target: AgentInputTarget) -> Self {
        Self {
            input_id: request.input_id.clone(),
            conversation_id: request.conversation_id.clone(),
            root_request_id: request.root_request_id.clone(),
            provider_request_id: request.provider_request_id.clone(),
            status: AgentInputStatus::Accepted,
            timestamp: now_timestamp(),
            code: None,
            message: None,
            accepted_target: Some(target),
        }
    }

    pub fn rejected(
        request: &AgentSteerRequest,
        code: AgentInputErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            input_id: request.input_id.clone(),
            conversation_id: request.conversation_id.clone(),
            root_request_id: request.root_request_id.clone(),
            provider_request_id: request.provider_request_id.clone(),
            status: AgentInputStatus::Rejected,
            timestamp: now_timestamp(),
            code: Some(code),
            message: Some(message.into()),
            accepted_target: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub streaming: bool,
    pub tools: bool,
    pub approvals: bool,
    pub questions: bool,
    pub sessions: bool,
    pub images: bool,
    pub cancellation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelDescriptor {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeDescriptor {
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_profile: Option<AgentAccessProfile>,
    pub display_name: String,
    pub capabilities: AgentCapabilities,
    pub models: Vec<AgentModelDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentImageAttachment {
    pub path: String,
    pub name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub prompt: String,
    #[serde(default)]
    pub images: Vec<AgentImageAttachment>,
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_profile: Option<AgentAccessProfile>,
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
    pub conversation_context: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub request_id: Option<String>,
    /// Regeneration replaces this durable assistant row instead of appending
    /// another answer after the same user prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_turn_id: Option<String>,
    pub max_budget_usd: Option<f64>,
    pub max_turns: Option<u32>,
    /// Which tools this turn may use. A planning or reviewing stage must be
    /// unable to edit files, and asking it not to in the prompt is a hope, not
    /// a guarantee -- the guarantee is not handing it the tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_profile: Option<StageToolProfile>,
    /// Leave the working tree as this turn left it instead of restoring the
    /// pre-turn base. A single turn always restores, because the user decides
    /// afterwards whether to apply it. A chain must not: the reviewer runs in
    /// the same tree a moment later, and reviewing a tree the coder's work was
    /// just rolled back out of is reviewing the wrong code. The chain takes
    /// over the restoring, once, when every stage is done.
    #[serde(default)]
    pub keep_workspace: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageToolProfile {
    /// Everything, which is what an ordinary turn and a coding stage get.
    Full,
    /// No writes and no commands: a planning stage reads and thinks.
    ReadOnly,
    /// No writes, but commands are allowed so a review can run the tests
    /// instead of speculating about them.
    Reviewer,
}

impl StageToolProfile {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::ReadOnly => "read_only",
            Self::Reviewer => "reviewer",
        }
    }

    /// Codex exposes a whole-sandbox switch rather than a tool list, so both
    /// non-writing profiles collapse onto its read-only sandbox. A Codex
    /// reviewer therefore cannot run the tests itself; the coding stage's own
    /// test output travels in the artifact instead.
    pub fn allows_workspace_writes(self) -> bool {
        matches!(self, Self::Full)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    pub thread_id: Option<String>,
    pub session_id: Option<String>,
    pub text: String,
    pub events: Vec<AgentEventEnvelope>,
    pub guard: crate::codex::AgentGuardReport,
    pub thread_rehydrated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthStatus {
    pub provider: AgentProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_profile: Option<AgentAccessProfile>,
    pub configured: bool,
    pub source: String,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionResult {
    pub provider: AgentProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_profile: Option<AgentAccessProfile>,
    pub success: bool,
    pub model: String,
    pub effort: String,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub request_id: String,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub protocol_version: u32,
    pub message_id: String,
    pub request_id: String,
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_event_id: Option<String>,
    pub sequence: u64,
    pub timestamp: String,
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    pub event_type: String,
    pub payload: Value,
}

impl AgentTurnRequest {
    pub fn to_codex_request(&self) -> Result<crate::codex::CodexRequest, String> {
        if self.provider != AgentProvider::Codex || self.runtime != AgentRuntimeKind::CodexAppServer
        {
            return Err(
                "Ez a provider/runtime pár nem a Codex app-server adapterhez tartozik.".to_string(),
            );
        }

        Ok(crate::codex::CodexRequest {
            prompt: self.prompt.clone(),
            images: self
                .images
                .iter()
                .map(|image| crate::codex::CodexImageAttachment {
                    path: image.path.clone(),
                    name: image.name.clone(),
                    mime_type: image.mime_type.clone(),
                })
                .collect(),
            thread_id: self.session_id.clone(),
            conversation_context: self.conversation_context.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            cwd: self.cwd.clone(),
            request_id: self.request_id.clone(),
            keep_workspace: self.keep_workspace,
            allow_workspace_writes: Some(
                self.tool_profile
                    .map(StageToolProfile::allows_workspace_writes)
                    .unwrap_or(true),
            ),
        })
    }
}

pub fn from_codex_response(
    request: &AgentTurnRequest,
    response: crate::codex::CodexResponse,
) -> AgentResponse {
    let events = response
        .events
        .into_iter()
        .map(|event| {
            let request_id = event
                .request_id
                .or_else(|| request.request_id.clone())
                .unwrap_or_else(|| "unknown".to_string());
            let provider_turn_id = provider_turn_id_from_payload(&event.payload)
                .or_else(|| Some(event.thread_id.clone()));
            let event_type = normalize_event_type(&event.event_type, &event.payload);
            AgentEventEnvelope {
                protocol_version: 1,
                message_id: format!("codex-{}-{}", event.thread_id, event.sequence),
                request_id: request_id.clone(),
                conversation_id: request.conversation_id.clone(),
                session_id: Some(event.thread_id.clone()),
                model: request.model.clone(),
                provider_turn_id: provider_turn_id.clone(),
                terminal_event_id: terminal_event_id(
                    &request_id,
                    provider_turn_id.as_deref(),
                    &event_type,
                ),
                sequence: event.sequence,
                timestamp: now_timestamp(),
                provider: AgentProvider::Codex,
                runtime: AgentRuntimeKind::CodexAppServer,
                event_type,
                payload: event.payload,
            }
        })
        .collect();

    AgentResponse {
        provider: AgentProvider::Codex,
        runtime: AgentRuntimeKind::CodexAppServer,
        thread_id: Some(response.thread_id.clone()),
        session_id: Some(response.thread_id),
        text: response.text,
        events,
        guard: response.guard,
        thread_rehydrated: response.thread_rehydrated,
    }
}

pub fn from_claude_connection(
    provider: AgentProvider,
    access_profile: Option<AgentAccessProfile>,
    result: crate::claude::ClaudeConnectionResult,
) -> AgentConnectionResult {
    AgentConnectionResult {
        provider,
        access_profile,
        success: result.success,
        model: result.model,
        effort: result.effort,
        text: result.text,
        session_id: result.session_id,
        total_cost_usd: result.total_cost_usd,
        request_id: result.request_id,
        error_code: result.error_code,
        error: result.error,
    }
}

pub fn codex_model_descriptors(models: Vec<crate::codex::CodexModel>) -> Vec<AgentModelDescriptor> {
    models
        .into_iter()
        .map(|model| AgentModelDescriptor {
            id: model.id,
            display_name: model.display_name,
            description: model.description,
            supported_efforts: model.supported_reasoning_efforts,
            default_effort: model.default_reasoning_effort,
        })
        .collect()
}

pub(crate) fn now_timestamp() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    stamp.to_string()
}

pub fn normalize_event_type(event_type: &str, payload: &Value) -> String {
    match event_type {
        "session/started" | "turn/started" => "agent/turn_started".to_string(),
        "item/agentMessage/delta"
            if payload.get("phase").and_then(Value::as_str) == Some("commentary") =>
        {
            "assistant/reasoning_delta".to_string()
        }
        "item/agentMessage/delta" => "assistant/text_delta".to_string(),
        "item/tool/started" | "item/commandExecution/started" => "tool/started".to_string(),
        "item/tool/progress" => "tool/progress".to_string(),
        "item/tool/denied" => "tool/failed".to_string(),
        "approval_requested" => "approval/requested".to_string(),
        "question_requested" => "question/requested".to_string(),
        "usage/updated" => "usage/updated".to_string(),
        "turn/completed" => "agent/turn_completed".to_string(),
        "turn/failed" => "agent/turn_failed".to_string(),
        "turn/cancelled" => "agent/turn_cancelled".to_string(),
        other => other.to_string(),
    }
}

pub fn provider_turn_id_from_payload(payload: &Value) -> Option<String> {
    ["providerTurnId", "turnId", "turn_id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

pub fn terminal_event_id(
    request_id: &str,
    provider_turn_id: Option<&str>,
    event_type: &str,
) -> Option<String> {
    if !is_terminal_event_type(event_type) {
        return None;
    }
    let terminal_kind = event_type.strip_prefix("agent/turn_").unwrap_or(event_type);
    Some(format!(
        "{request_id}:{}:{terminal_kind}",
        provider_turn_id.unwrap_or(request_id)
    ))
}

pub fn is_terminal_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "agent/turn_completed" | "agent/turn_failed" | "agent/turn_cancelled"
    )
}

pub fn runtime_catalog() -> Vec<AgentRuntimeDescriptor> {
    vec![
        AgentRuntimeDescriptor {
            provider: AgentProvider::Codex,
            runtime: AgentRuntimeKind::CodexAppServer,
            access_profile: None,
            display_name: "Codex app-server".to_string(),
            capabilities: AgentCapabilities {
                streaming: true,
                tools: true,
                approvals: true,
                questions: false,
                sessions: true,
                images: true,
                cancellation: true,
            },
            models: Vec::new(),
        },
        AgentRuntimeDescriptor {
            provider: AgentProvider::Anthropic,
            runtime: AgentRuntimeKind::ClaudeAgentBridge,
            access_profile: Some(AgentAccessProfile::Claude),
            display_name: "Claude Agent SDK bridge".to_string(),
            capabilities: AgentCapabilities {
                streaming: true,
                tools: true,
                approvals: true,
                questions: true,
                sessions: true,
                images: true,
                cancellation: true,
            },
            models: [
                (
                    "claude-opus-5",
                    "Claude Opus 5",
                    "The strongest Claude coding model.",
                ),
                (
                    "claude-opus-4-8",
                    "Claude Opus 4.8",
                    "Claude Opus 4.8 coding model.",
                ),
                (
                    "claude-opus-4-7",
                    "Claude Opus 4.7",
                    "Claude Opus 4.7 coding model.",
                ),
                (
                    "claude-opus-4-6",
                    "Claude Opus 4.6",
                    "Claude Opus 4.6 coding model.",
                ),
                ("claude-fable-5", "Claude Fable 5", "Fast Claude coding model."),
            ]
            .into_iter()
            .map(|(id, display_name, description)| AgentModelDescriptor {
                id: id.to_string(),
                display_name: display_name.to_string(),
                description: description.to_string(),
                supported_efforts: ["low", "medium", "high", "xhigh", "max"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                default_effort: Some("low".to_string()),
            })
            .collect(),
        },
        AgentRuntimeDescriptor {
            provider: AgentProvider::Kimi,
            runtime: AgentRuntimeKind::CompatibleAgentBridge,
            access_profile: Some(AgentAccessProfile::KimiOpenPlatform),
            display_name: "Kimi Open Platform · raw API".to_string(),
            capabilities: AgentCapabilities {
                streaming: true,
                tools: true,
                approvals: true,
                questions: true,
                sessions: true,
                images: true,
                cancellation: true,
            },
            models: vec![AgentModelDescriptor {
                id: "kimi-k3".to_string(),
                display_name: "Kimi K3 · API".to_string(),
                description: "Kimi K3 a közvetlen, használatalapú Open Platform API-n.".to_string(),
                supported_efforts: ["low", "high", "max"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                default_effort: Some("high".to_string()),
            }],
        },
        AgentRuntimeDescriptor {
            provider: AgentProvider::Kimi,
            runtime: AgentRuntimeKind::CompatibleAgentBridge,
            access_profile: Some(AgentAccessProfile::KimiCode),
            display_name: "Kimi Code · előfizetés".to_string(),
            capabilities: AgentCapabilities {
                streaming: true,
                tools: true,
                approvals: true,
                questions: true,
                sessions: true,
                // The subscription route's image behavior is not documented
                // consistently enough to promise it before a live probe.
                images: false,
                cancellation: true,
            },
            models: [
                (
                    "k3",
                    "Kimi K3 · Code",
                    "Kimi K3 a Kimi Code előfizetéses keretén.",
                ),
                (
                    "k3-256k",
                    "Kimi K3 256K · Code",
                    "Kimi K3 kisebb, takarékosabb Kimi Code kontextussal.",
                ),
            ]
            .into_iter()
            .map(|(id, display_name, description)| AgentModelDescriptor {
                id: id.to_string(),
                display_name: display_name.to_string(),
                description: description.to_string(),
                supported_efforts: ["low", "high", "max"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                default_effort: Some("high".to_string()),
            })
            .collect(),
        },
        AgentRuntimeDescriptor {
            provider: AgentProvider::DeepSeek,
            runtime: AgentRuntimeKind::CompatibleAgentBridge,
            access_profile: Some(AgentAccessProfile::DeepSeekApi),
            display_name: "DeepSeek API".to_string(),
            capabilities: AgentCapabilities {
                streaming: true,
                tools: true,
                approvals: true,
                questions: true,
                sessions: true,
                // The documented Anthropic-compatible route does not accept
                // image content. Keep the UI honest until a raw-route probe
                // proves otherwise.
                images: false,
                cancellation: true,
            },
            models: vec![AgentModelDescriptor {
                id: "deepseek-v4-flash".to_string(),
                display_name: "DeepSeek V4 Flash".to_string(),
                description: "Gyors, 1M kontextusú DeepSeek coding modell.".to_string(),
                supported_efforts: ["none", "high", "max"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                default_effort: Some("high".to_string()),
            }],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chain_stage_tells_the_codex_runtime_to_leave_the_tree_alone() {
        // The reviewer runs in the tree the coder just wrote to. If this flag
        // does not survive the conversion, the coder's work is rolled back
        // before anyone can review it.
        let mut request = AgentTurnRequest {
            prompt: "feladat".to_string(),
            images: Vec::new(),
            provider: AgentProvider::Codex,
            runtime: AgentRuntimeKind::CodexAppServer,
            access_profile: None,
            conversation_id: None,
            session_id: None,
            conversation_context: None,
            model: None,
            effort: None,
            cwd: None,
            request_id: None,
            replace_message_id: None,
            replace_turn_id: None,
            max_budget_usd: None,
            max_turns: None,
            tool_profile: None,
            keep_workspace: true,
        };
        assert!(
            request
                .to_codex_request()
                .expect("codex request")
                .keep_workspace
        );
        request.keep_workspace = false;
        assert!(
            !request
                .to_codex_request()
                .expect("codex request")
                .keep_workspace,
            "an ordinary turn must keep restoring, so the user decides what to apply"
        );
    }

    #[test]
    fn catalog_exposes_all_provider_routes() {
        let catalog = runtime_catalog();

        assert_eq!(catalog.len(), 5);
        assert_eq!(catalog[0].provider, AgentProvider::Codex);
        assert_eq!(catalog[1].provider, AgentProvider::Anthropic);
        assert!(catalog[0].capabilities.images);
        assert!(catalog[1].capabilities.images);
        assert!(catalog[2].capabilities.images);
        assert!(!catalog[3].capabilities.images);
        assert!(!catalog[4].capabilities.images);
        assert_eq!(
            catalog[1]
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "claude-opus-5",
                "claude-opus-4-8",
                "claude-opus-4-7",
                "claude-opus-4-6",
                "claude-fable-5",
            ]
        );
        assert!(catalog[1].models.iter().all(|model| {
            model.supported_efforts == ["low", "medium", "high", "xhigh", "max"]
                && model.default_effort.as_deref() == Some("low")
        }));
        assert_eq!(catalog[2].provider, AgentProvider::Kimi);
        assert_eq!(
            catalog[2].access_profile,
            Some(AgentAccessProfile::KimiOpenPlatform)
        );
        assert_eq!(catalog[2].models[0].id, "kimi-k3");
        assert_eq!(catalog[3].provider, AgentProvider::Kimi);
        assert_eq!(catalog[4].provider, AgentProvider::DeepSeek);
        assert_eq!(
            catalog[4].models[0].supported_efforts,
            ["none", "high", "max"]
        );
    }

    #[test]
    fn runtime_contract_serializes_camel_case_fields() {
        let descriptor = runtime_catalog()
            .into_iter()
            .find(|item| item.provider == AgentProvider::Anthropic)
            .expect("Anthropic runtime is present");
        let value = serde_json::to_value(descriptor).expect("descriptor serializes");

        assert!(value.get("displayName").is_some());
        assert!(value.get("capabilities").is_some());
        assert!(value["capabilities"].get("maxTurns").is_none());
    }

    #[test]
    fn terminal_event_identity_is_stable_and_provider_neutral() {
        let event_type = normalize_event_type("turn/completed", &serde_json::json!({}));
        assert_eq!(event_type, "agent/turn_completed");
        assert_eq!(
            terminal_event_id("request-1", Some("provider-turn-7"), &event_type),
            Some("request-1:provider-turn-7:completed".to_string())
        );
        assert!(is_terminal_event_type(&event_type));
        assert!(!is_terminal_event_type("assistant/text_delta"));
    }

    #[test]
    fn commentary_delta_normalizes_to_reasoning_without_changing_compat_payload() {
        assert_eq!(
            normalize_event_type(
                "item/agentMessage/delta",
                &serde_json::json!({"phase": "commentary"})
            ),
            "assistant/reasoning_delta"
        );
        assert_eq!(
            provider_turn_id_from_payload(&serde_json::json!({"turnId": "t-1"})),
            Some("t-1".to_string())
        );
    }

    fn codex_request_with(profile: Option<StageToolProfile>) -> crate::codex::CodexRequest {
        AgentTurnRequest {
            prompt: "feladat".to_string(),
            images: Vec::new(),
            provider: AgentProvider::Codex,
            runtime: AgentRuntimeKind::CodexAppServer,
            access_profile: None,
            conversation_id: Some("conversation".to_string()),
            session_id: None,
            conversation_context: None,
            model: None,
            effort: None,
            cwd: None,
            request_id: Some("request".to_string()),
            replace_message_id: None,
            replace_turn_id: None,
            max_budget_usd: None,
            max_turns: None,
            tool_profile: profile,
            keep_workspace: false,
        }
        .to_codex_request()
        .expect("codex request")
    }

    #[test]
    fn a_non_writing_stage_reaches_codex_as_a_read_only_sandbox() {
        // Codex has no per-tool switch, so both non-writing roles collapse onto
        // its read-only sandbox -- the app-server refuses the write instead of
        // the prompt asking it not to.
        assert_eq!(
            codex_request_with(Some(StageToolProfile::ReadOnly)).allow_workspace_writes,
            Some(false)
        );
        assert_eq!(
            codex_request_with(Some(StageToolProfile::Reviewer)).allow_workspace_writes,
            Some(false)
        );
        assert_eq!(
            codex_request_with(Some(StageToolProfile::Full)).allow_workspace_writes,
            Some(true)
        );
        // An ordinary turn carries no profile and must keep writing.
        assert_eq!(
            codex_request_with(None).allow_workspace_writes,
            Some(true),
            "a turn without a stage role is a normal turn and must stay writable"
        );
    }

    #[test]
    fn the_profile_wire_names_match_what_the_bridge_understands() {
        assert_eq!(StageToolProfile::Full.as_wire(), "full");
        assert_eq!(StageToolProfile::ReadOnly.as_wire(), "read_only");
        assert_eq!(StageToolProfile::Reviewer.as_wire(), "reviewer");

        assert_eq!(
            serde_json::to_string(&AgentProvider::DeepSeek).unwrap(),
            "\"deepseek\""
        );
        assert_eq!(
            serde_json::from_str::<AgentProvider>("\"deepseek\"").unwrap(),
            AgentProvider::DeepSeek
        );
        assert_eq!(
            serde_json::to_string(&AgentAccessProfile::DeepSeekApi).unwrap(),
            "\"deepseekApi\""
        );
        assert_eq!(
            serde_json::from_str::<AgentAccessProfile>("\"deepseekApi\"").unwrap(),
            AgentAccessProfile::DeepSeekApi
        );
    }
}
