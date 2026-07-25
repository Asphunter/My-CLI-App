//! Provider-neutral contracts for coding-agent runtimes.
//!
//! The existing Codex app-server path remains the compatibility path for now.
//! These types give the frontend and the future Claude bridge one stable shape
//! without forcing a provider switch before the live Claude vertical slice is
//! ready.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentProvider {
    Codex,
    Anthropic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRuntimeKind {
    CodexAppServer,
    ClaudeAgentBridge,
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
    pub conversation_id: Option<String>,
    pub session_id: Option<String>,
    pub conversation_context: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub request_id: Option<String>,
    pub max_budget_usd: Option<f64>,
    pub max_turns: Option<u32>,
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
    pub configured: bool,
    pub source: String,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionResult {
    pub provider: AgentProvider,
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
    result: crate::claude::ClaudeConnectionResult,
) -> AgentConnectionResult {
    AgentConnectionResult {
        provider: AgentProvider::Anthropic,
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

fn now_timestamp() -> String {
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
            models: vec![AgentModelDescriptor {
                id: "claude-sonnet-5".to_string(),
                display_name: "Claude Sonnet 5".to_string(),
                description: "Balanced Claude coding model.".to_string(),
                supported_efforts: vec![
                    "low".to_string(),
                    "medium".to_string(),
                    "high".to_string(),
                ],
                default_effort: Some("low".to_string()),
            }],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_exposes_both_runtime_families() {
        let catalog = runtime_catalog();

        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].provider, AgentProvider::Codex);
        assert_eq!(catalog[1].provider, AgentProvider::Anthropic);
        assert_eq!(catalog[1].models[0].id, "claude-sonnet-5");
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
}
