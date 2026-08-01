//! Claude credential storage and the provider-neutral live coding bridge.
//!
//! Two authentication sources are supported and resolved in this order:
//!
//! 1. the local Claude Code subscription login (`~/.claude/.credentials.json`),
//!    which the bundled Agent SDK binary reads by itself, and
//! 2. a pay-per-token API key kept in Windows Credential Manager.
//!
//! Subscription mode wins when a login is present, because `ANTHROPIC_API_KEY`
//! overrides the subscription whenever it is set. Neither the API key nor the
//! OAuth tokens ever enter a Tauri payload, a command-line argument or a log
//! line; the key is passed only to the short-lived Node bridge environment and
//! the OAuth tokens are never read by us at all. The bridge never receives the
//! workspace snapshot; it receives only the selected cwd and the user turn.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const KEYRING_SERVICE: &str = "min-local-ai-workspace";
const KEYRING_USER: &str = "claude-api-key";
const DEFAULT_MODEL: &str = "claude-sonnet-5";
const DEFAULT_MAX_BUDGET_USD: f64 = 0.05;
/// A tool-using coding turn needs several agent turns (read, edit, run the
/// test, answer), so a limit of 1 cannot complete real work. Kept generous
/// because in subscription mode this is the only guard on a runaway turn.
const DEFAULT_MAX_TURNS: u32 = 40;
const MAX_TURNS_CEILING: u32 = 200;
const MAX_API_KEY_LENGTH: usize = 4096;
const BRIDGE_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthStatus {
    pub configured: bool,
    pub source: String,
    pub preview: Option<String>,
    pub api_key_configured: bool,
    pub subscription_configured: bool,
    pub subscription_plan: Option<String>,
}

/// Which credential the bridge child process will authenticate with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthMode {
    /// The local Claude Code subscription login; the bridge must not receive
    /// `ANTHROPIC_API_KEY`, otherwise the key overrides the subscription.
    Subscription,
    /// A pay-per-token API key from Windows Credential Manager.
    ApiKey,
}

/// The resolved credential for one bridge invocation.
struct ResolvedAuth {
    mode: AuthMode,
    api_key: Option<String>,
}

impl ResolvedAuth {
    fn apply(&self, command: &mut Command) {
        match self.mode {
            AuthMode::Subscription => {
                // An inherited key would silently take precedence over the
                // subscription, so both header variables are cleared.
                command.env_remove("ANTHROPIC_API_KEY");
                command.env_remove("ANTHROPIC_AUTH_TOKEN");
                command.env("MIN_AGENT_AUTH_MODE", "subscription");
            }
            AuthMode::ApiKey => {
                if let Some(key) = self.api_key.as_deref() {
                    command.env("ANTHROPIC_API_KEY", key);
                }
                command.env("MIN_AGENT_AUTH_MODE", "apiKey");
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeConnectionResult {
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeApprovalRequest {
    pub approval_id: String,
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub title: Option<String>,
    pub reason: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuestionRequest {
    pub question_id: String,
    pub request_id: String,
    pub questions: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeMessage {
    #[serde(rename = "type")]
    #[serde(default)]
    message_type: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    sequence: Option<u64>,
    #[serde(default)]
    payload: Value,
}

struct ActiveClaudeRequest {
    cancelled: Arc<AtomicBool>,
    pid: Option<u32>,
    writer: Arc<Mutex<Option<ChildStdin>>>,
    provider_turn_id: Option<String>,
    turn_open: bool,
    pending_steers: HashMap<String, crate::agent::AgentSteerRequest>,
    accepted_inputs: HashSet<String>,
}

static ACTIVE_REQUESTS: OnceLock<Mutex<HashMap<String, ActiveClaudeRequest>>> = OnceLock::new();
static PENDING_APPROVALS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PENDING_QUESTIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn active_requests() -> &'static Mutex<HashMap<String, ActiveClaudeRequest>> {
    ACTIVE_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_approvals() -> &'static Mutex<HashMap<String, String>> {
    PENDING_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True while this turn has an approval or a question the user has not answered.
#[cfg(test)]
fn waiting_for_user(request_id: &str) -> bool {
    let approval = pending_approvals()
        .lock()
        .map(|pending| pending.values().any(|value| value == request_id))
        .unwrap_or(false);
    let question = pending_questions()
        .lock()
        .map(|pending| pending.values().any(|value| value == request_id))
        .unwrap_or(false);
    approval || question
}

fn pending_questions() -> &'static Mutex<HashMap<String, String>> {
    PENDING_QUESTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn begin_request(request_id: &str) -> Result<Arc<AtomicBool>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut requests = active_requests()
        .lock()
        .map_err(|_| "A Claude-kérések állapota zárolva maradt.".to_string())?;
    if requests.contains_key(request_id) {
        return Err("Ehhez a Claude-kéréshez már tartozik futó folyamat.".to_string());
    }
    requests.insert(
        request_id.to_string(),
        ActiveClaudeRequest {
            cancelled: cancelled.clone(),
            pid: None,
            writer: Arc::new(Mutex::new(None)),
            provider_turn_id: None,
            turn_open: false,
            pending_steers: HashMap::new(),
            accepted_inputs: HashSet::new(),
        },
    );
    Ok(cancelled)
}

fn attach_process(
    request_id: &str,
    pid: u32,
    writer: Arc<Mutex<Option<ChildStdin>>>,
    provider_turn_id: Option<String>,
) {
    if let Ok(mut requests) = active_requests().lock() {
        if let Some(request) = requests.get_mut(request_id) {
            request.pid = Some(pid);
            request.writer = writer;
            request.provider_turn_id = provider_turn_id.or_else(|| Some(request_id.to_string()));
            request.turn_open = true;
            if request.cancelled.load(Ordering::Relaxed) {
                kill_process_tree(pid);
            }
        }
    }
}

fn update_provider_turn_id(request_id: &str, provider_turn_id: Option<&str>) {
    let Some(provider_turn_id) = provider_turn_id.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    if let Ok(mut requests) = active_requests().lock() {
        if let Some(request) = requests.get_mut(request_id) {
            request.provider_turn_id = Some(provider_turn_id.to_string());
        }
    }
}

fn emit_input_status(
    app: &tauri::AppHandle,
    event: &crate::agent::AgentInputStatusEvent,
) -> Result<(), String> {
    emit_main_window(app, "agent-input-status", event)
}

fn close_steer_gate(
    app: &tauri::AppHandle,
    request_id: &str,
    code: crate::agent::AgentInputErrorCode,
    message: &str,
) {
    let pending = active_requests()
        .lock()
        .ok()
        .and_then(|mut requests| {
            requests.get_mut(request_id).map(|active| {
                active.turn_open = false;
                active
                    .pending_steers
                    .drain()
                    .map(|(_, request)| request)
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    for request in pending {
        let _ = emit_input_status(
            app,
            &crate::agent::AgentInputStatusEvent::rejected(
                &request,
                code,
                message.to_string(),
            ),
        );
    }
}

fn handle_steer_status(
    app: &tauri::AppHandle,
    request_id: &str,
    accepted: bool,
    payload: &Value,
) -> Result<(), String> {
    let input_id = payload
        .get("inputId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (pending, provider_turn_id) = {
        let mut requests = active_requests()
            .lock()
            .map_err(|_| "A Claude-kérések állapota zárolva maradt.".to_string())?;
        let Some(active) = requests.get_mut(request_id) else {
            return Ok(());
        };
        let Some(pending) = active.pending_steers.remove(input_id) else {
            return Ok(());
        };
        if accepted {
            active.accepted_inputs.insert(input_id.to_string());
        }
        (pending, active.provider_turn_id.clone())
    };
    if accepted {
        let target = pending.target(provider_turn_id.clone(), provider_turn_id);
        crate::record_accepted_pipeline_input(&pending);
        emit_input_status(
            app,
            &crate::agent::AgentInputStatusEvent::accepted(&pending, target),
        )
    } else {
        let code = match payload.get("code").and_then(Value::as_str) {
            Some("target_changed") => crate::agent::AgentInputErrorCode::TargetChanged,
            Some("duplicate_input") => crate::agent::AgentInputErrorCode::DuplicateInput,
            Some("run_cancelled") => crate::agent::AgentInputErrorCode::RunCancelled,
            Some("transport_closed") => crate::agent::AgentInputErrorCode::TransportClosed,
            Some("runtime_failed") => crate::agent::AgentInputErrorCode::RuntimeFailed,
            Some("unsupported_payload") => crate::agent::AgentInputErrorCode::UnsupportedPayload,
            Some("no_active_run") => crate::agent::AgentInputErrorCode::NoActiveRun,
            _ => crate::agent::AgentInputErrorCode::NoActiveTurn,
        };
        emit_input_status(
            app,
            &crate::agent::AgentInputStatusEvent::rejected(
                &pending,
                code,
                payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("A Claude nem fogadta el a menet közbeni üzenetet."),
            ),
        )
    }
}

pub fn steer(
    app: &tauri::AppHandle,
    request: crate::agent::AgentSteerRequest,
) -> Result<crate::agent::AgentSteerQueued, crate::agent::AgentSteerError> {
    use crate::agent::{AgentInputErrorCode, AgentProvider, AgentSteerError};

    if request.provider != AgentProvider::Anthropic {
        return Err(AgentSteerError::new(
            AgentInputErrorCode::TargetChanged,
            "A célzott futás nem Claude providerhez tartozik.",
        ));
    }
    if request.text.trim().is_empty() {
        return Err(AgentSteerError::new(
            AgentInputErrorCode::UnsupportedPayload,
            "Üres menet közbeni üzenet nem küldhető.",
        ));
    }
    let writer = {
        let mut requests = active_requests().lock().map_err(|_| {
            AgentSteerError::new(
                AgentInputErrorCode::RuntimeFailed,
                "A Claude-kérések állapota zárolva maradt.",
            )
        })?;
        let active = requests.get_mut(&request.provider_request_id).ok_or_else(|| {
            AgentSteerError::new(
                AgentInputErrorCode::NoActiveRun,
                "A célzott Claude-kérés már nem aktív.",
            )
        })?;
        if active.cancelled.load(Ordering::Acquire) {
            return Err(AgentSteerError::new(
                AgentInputErrorCode::RunCancelled,
                "A célzott Claude-kérést leállították.",
            ));
        }
        if active.accepted_inputs.contains(&request.input_id)
            || active.pending_steers.contains_key(&request.input_id)
        {
            return Err(AgentSteerError::new(
                AgentInputErrorCode::DuplicateInput,
                "Ezt a menet közbeni üzenetet a Claude futás már megkapta.",
            ));
        }
        if !active.turn_open {
            return Err(AgentSteerError::new(
                AgentInputErrorCode::NoActiveTurn,
                "A Claude provider turnje már nem fogad inputot.",
            ));
        }
        let active_turn_id = active.provider_turn_id.as_deref().unwrap_or(request.provider_request_id.as_str());
        if active_turn_id != request.expected_provider_turn_id {
            return Err(AgentSteerError::new(
                AgentInputErrorCode::TargetChanged,
                "A célzott Claude turn közben megváltozott.",
            ));
        }
        active
            .pending_steers
            .insert(request.input_id.clone(), request.clone());
        active.writer.clone()
    };

    let _ = emit_input_status(app, &crate::agent::AgentInputStatusEvent::sending(&request));
    let write_result = writer
        .lock()
        .map_err(|_| "A Claude bridge bemenete zárolva maradt.".to_string())
        .and_then(|mut stdin| {
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| "A Claude bridge bemenete már lezárult.".to_string())?;
            write_bridge_request(
                stdin,
                bridge_request_with_context(
                    &request.provider_request_id,
                    Some(&request.conversation_id),
                    Some(&request.expected_provider_turn_id),
                    "steer_turn",
                    json!({
                        "inputId": request.input_id,
                        "conversationId": request.conversation_id,
                        "rootRequestId": request.root_request_id,
                        "expectedProviderTurnId": request.expected_provider_turn_id,
                        "stageEpoch": request.expected_stage_epoch,
                        "pipelineRunId": request.pipeline_run_id,
                        "stageIndex": request.stage_index,
                        "stageRole": request.stage_role,
                        "text": request.text,
                    }),
                ),
            )
        });
    if let Err(message) = write_result {
        if let Ok(mut requests) = active_requests().lock() {
            if let Some(active) = requests.get_mut(&request.provider_request_id) {
                active.pending_steers.remove(&request.input_id);
            }
        }
        return Err(AgentSteerError::new(
            AgentInputErrorCode::TransportClosed,
            message,
        ));
    }
    let queued_at = crate::agent::AgentInputStatusEvent::sending(&request).timestamp;
    Ok(crate::agent::AgentSteerQueued {
        input_id: request.input_id,
        queued_at,
    })
}

pub fn cancel_request(request_id: &str) -> Result<(), String> {
    let (cancelled, pid, writer) = {
        let requests = active_requests()
            .lock()
            .map_err(|_| "A Claude-kérések állapota zárolva maradt.".to_string())?;
        let request = requests
            .get(request_id)
            .ok_or_else(|| "A Claude-kérés már befejeződött.".to_string())?;
        (
            request.cancelled.clone(),
            request.pid,
            request.writer.clone(),
        )
    };
    cancelled.store(true, Ordering::Release);
    if let Ok(mut stdin) = writer.lock() {
        stdin.take();
    }
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    Ok(())
}

pub fn end_request(request_id: &str) {
    if let Ok(mut requests) = active_requests().lock() {
        requests.remove(request_id);
    }
    if let Ok(mut pending) = pending_approvals().lock() {
        pending.retain(|_, value| value != request_id);
    }
    if let Ok(mut pending) = pending_questions().lock() {
        pending.retain(|_, value| value != request_id);
    }
}

fn send_to_request(request_id: &str, message_type: &str, payload: Value) -> Result<(), String> {
    let writer = active_requests()
        .lock()
        .map_err(|_| "A Claude-kérések állapota zárolva maradt.".to_string())?
        .get(request_id)
        .map(|request| request.writer.clone())
        .ok_or_else(|| "A Claude-kérés már befejeződött.".to_string())?;
    let mut stdin = writer
        .lock()
        .map_err(|_| "A Claude bridge bemenete zárolva maradt.".to_string())?;
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| "A Claude bridge bemenete már lezárult.".to_string())?;
    write_bridge_request(
        stdin,
        bridge_request_with_context(request_id, None, None, message_type, payload),
    )
}

pub fn respond_approval(
    approval_id: &str,
    decision: &str,
    reason: Option<String>,
) -> Result<(), String> {
    let request_id = pending_approvals()
        .lock()
        .map_err(|_| "A Claude approval-állapota zárolva maradt.".to_string())?
        .remove(approval_id)
        .ok_or_else(|| "Az approval-kérés már lezárult vagy nem található.".to_string())?;
    send_to_request(
        &request_id,
        "approval_response",
        json!({
            "approvalId": approval_id,
            "decision": decision,
            "reason": reason,
        }),
    )
}

pub fn respond_question(question_id: &str, answer: Value) -> Result<(), String> {
    let request_id = pending_questions()
        .lock()
        .map_err(|_| "A Claude kérdés-állapota zárolva maradt.".to_string())?
        .remove(question_id)
        .ok_or_else(|| "A kérdés már lezárult vagy nem található.".to_string())?;
    send_to_request(
        &request_id,
        "question_response",
        json!({ "questionId": question_id, "answer": answer }),
    )
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("Nem sikerült a Windows Credential Manager elérése: {error}"))
}

fn load_api_key() -> Result<Option<String>, String> {
    match keyring_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Nem sikerült a Claude API-kulcs olvasása a Windows Credential Managerből: {error}"
        )),
    }
}

/// Path of the Claude Code subscription login on this machine.
///
/// Overridable so the tests never touch the developer's real login.
fn subscription_credentials_path() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("MIN_CLAUDE_CREDENTIALS_PATH") {
        if value.trim().is_empty() {
            return None;
        }
        return Some(PathBuf::from(value));
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    Some(
        PathBuf::from(home)
            .join(".claude")
            .join(".credentials.json"),
    )
}

/// Reads only the plan label out of the Claude Code login.
///
/// The access and refresh tokens are deliberately never returned: the bundled
/// Agent SDK binary reads them itself, so we only need to know that a login
/// exists and which plan it is, for the settings display.
fn subscription_plan() -> Option<String> {
    read_plan_from(&subscription_credentials_path()?)
}

fn read_plan_from(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let oauth = parsed.get("claudeAiOauth")?;
    if !oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .is_some_and(|token| !token.trim().is_empty())
    {
        return None;
    }
    let plan = oauth
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("claude.ai");
    Some(plan.to_string())
}

pub fn auth_status() -> Result<ClaudeAuthStatus, String> {
    let key = load_api_key()?;
    let plan = subscription_plan();
    let (source, preview) = match (plan.as_deref(), key.as_deref()) {
        (Some(plan), _) => (
            "subscription".to_string(),
            Some(format!("{} előfizetés", plan_label(plan))),
        ),
        (None, Some(key)) => ("apiKey".to_string(), Some(api_key_preview(key))),
        (None, None) => ("none".to_string(), None),
    };
    Ok(ClaudeAuthStatus {
        configured: plan.is_some() || key.is_some(),
        source,
        preview,
        api_key_configured: key.is_some(),
        subscription_configured: plan.is_some(),
        subscription_plan: plan,
    })
}

fn plan_label(plan: &str) -> String {
    match plan.trim().to_ascii_lowercase().as_str() {
        "max" => "Claude Max".to_string(),
        "pro" => "Claude Pro".to_string(),
        "team" => "Claude Team".to_string(),
        "enterprise" => "Claude Enterprise".to_string(),
        other if other.is_empty() => "Claude".to_string(),
        _ => format!("Claude {}", plan.trim()),
    }
}

/// Resolves the credential for one bridge invocation.
///
/// The subscription login wins when present: `ANTHROPIC_API_KEY` would
/// otherwise override it even though the user is logged in.
fn resolve_auth() -> Result<ResolvedAuth, String> {
    if subscription_plan().is_some() {
        return Ok(ResolvedAuth {
            mode: AuthMode::Subscription,
            api_key: None,
        });
    }
    match load_api_key()? {
        Some(api_key) => Ok(ResolvedAuth {
            mode: AuthMode::ApiKey,
            api_key: Some(api_key),
        }),
        None => Err(
            "Nincs Claude hitelesítés. Jelentkezz be a Claude Code előfizetéssel, vagy mentsd el az API-kulcsot a Beállításokban."
                .to_string(),
        ),
    }
}

pub fn save_api_key(api_key: &str) -> Result<ClaudeAuthStatus, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("A Claude API-kulcs nem lehet üres.".to_string());
    }
    if api_key.len() > MAX_API_KEY_LENGTH {
        return Err("A Claude API-kulcs túl hosszú.".to_string());
    }
    if api_key
        .chars()
        .any(|character| character == '\r' || character == '\n')
    {
        return Err("A Claude API-kulcs nem tartalmazhat sortörést.".to_string());
    }

    keyring_entry()?
        .set_password(api_key)
        .map_err(|error| format!("Nem sikerült a Claude API-kulcs mentése: {error}"))?;
    auth_status()
}

pub fn delete_api_key() -> Result<ClaudeAuthStatus, String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => auth_status(),
        Err(error) => Err(format!("Nem sikerült a Claude API-kulcs törlése: {error}")),
    }
}

fn api_key_preview(value: &str) -> String {
    let character_count = value.chars().count();
    if character_count <= 8 {
        return "••••••••".to_string();
    }

    let prefix: String = value.chars().take(7).collect();
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{prefix}…{suffix}")
}

fn bridge_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("MIN_AGENT_BRIDGE_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let source_candidate = source_root
        .parent()
        .unwrap_or(source_root.as_path())
        .join("agent-bridge")
        .join("main.mjs");
    if source_candidate.is_file() {
        return Ok(source_candidate);
    }

    let executable_candidate = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .map(|directory| directory.join("agent-bridge").join("main.mjs"));
    if let Some(path) = executable_candidate.filter(|path| path.is_file()) {
        return Ok(path);
    }

    Err(format!(
        "A Claude bridge nem található. Keresett fájl: {}",
        source_candidate.display()
    ))
}

/// Where the bridge remembers a tool the user granted for a workspace.
///
/// Next to the local store rather than inside the project: a grant is a
/// decision about this machine, and it has no business travelling in the
/// user's repository or in the sync journal.
fn approvals_path() -> PathBuf {
    crate::store::local_store_path()
        .map(|path| {
            path.parent()
                .map(|directory| directory.join("approved-tools.json"))
                .unwrap_or_else(|| PathBuf::from("approved-tools.json"))
        })
        .unwrap_or_else(|_| PathBuf::from("approved-tools.json"))
}

/// Ezredmásodperc az epoch óta — a napló sorai így a híd időbélyegeivel
/// összefésülhetők.
fn epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

/// A híd diagnosztikai naplója. A stderr a null-eszközre megy, tehát enélkül
/// egy turn közbeni elakadásról — mint a SessionStore-timeout — semmilyen nyom
/// nem marad. A fájl append-only és csak rövid, kulcs-érték sorokat kap.
fn bridge_log_path() -> PathBuf {
    crate::store::local_store_path()
        .map(|path| {
            path.parent()
                .map(|directory| directory.join("claude-bridge.log"))
                .unwrap_or_else(|| PathBuf::from("claude-bridge.log"))
        })
        .unwrap_or_else(|_| PathBuf::from("claude-bridge.log"))
}

fn bridge_cwd(requested: Option<String>) -> Result<PathBuf, String> {
    let requested = requested.filter(|value| !value.trim().is_empty());
    let path = crate::codex::requested_agent_cwd(requested.as_deref())?;
    Ok(path)
}

fn session_project_key(cwd: &Path) -> String {
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let root = crate::codex::projects_root()
        .canonicalize()
        .unwrap_or_else(|_| crate::codex::projects_root());
    if let Ok(relative) = canonical_cwd.strip_prefix(&root) {
        return format!(
            "workspace:{}",
            relative.to_string_lossy().replace('\\', "/").to_lowercase()
        );
    }
    format!(
        "absolute:{}",
        canonical_cwd
            .to_string_lossy()
            .replace('\\', "/")
            .to_lowercase()
    )
}

fn bridge_request(request_id: &str, message_type: &str, payload: Value) -> Value {
    bridge_request_with_context(request_id, None, None, message_type, payload)
}

fn bridge_request_with_context(
    request_id: &str,
    conversation_id: Option<&str>,
    session_id: Option<&str>,
    message_type: &str,
    payload: Value,
) -> Value {
    json!({
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "messageId": Uuid::new_v4().to_string(),
        "requestId": request_id,
        "conversationId": conversation_id,
        "sessionId": session_id,
        "sequence": 0,
        "timestamp": now_timestamp(),
        "type": message_type,
        "payload": payload,
    })
}

fn now_timestamp() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    stamp.to_string()
}

fn write_bridge_request(writer: &mut impl Write, request: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, &request)
        .map_err(|error| format!("A Claude bridge-kérés szerializálása sikertelen: {error}"))?;
    writer
        .write_all(b"\n")
        .map_err(|error| format!("A Claude bridge-kérés elküldése sikertelen: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("A Claude bridge bemenetének flush-a sikertelen: {error}"))
}

fn parse_bridge_message(line: &str) -> Result<BridgeMessage, String> {
    serde_json::from_str(line)
        .map_err(|error| format!("A Claude bridge hibás JSONL választ küldött: {error}"))
}

fn emit_main_window<T: Serialize>(
    app: &tauri::AppHandle,
    event: &str,
    payload: &T,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .emit(event, payload)
            .map_err(|error| error.to_string())
    } else {
        app.emit(event, payload).map_err(|error| error.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTransportStatus {
    request_id: Option<String>,
    stage: String,
    detail: String,
    session_id: Option<String>,
}

fn emit_compat_event(
    app: &tauri::AppHandle,
    request: &crate::agent::AgentTurnRequest,
    message: &BridgeMessage,
    event_type: String,
    mut payload: Value,
    session_id: Option<String>,
) -> Result<crate::agent::AgentEventEnvelope, String> {
    let request_id = request
        .request_id
        .clone()
        .or_else(|| message.request_id.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let session_id = session_id
        .or_else(|| message.session_id.clone())
        .or_else(|| request.session_id.clone());
    if event_type == "turn/completed" {
        if let Some(final_text) = payload.get("finalText").cloned() {
            if let Some(object) = payload.as_object_mut() {
                object.insert("finalText".to_string(), final_text);
            }
        }
    }
    let normalized_event_type = crate::agent::normalize_event_type(&event_type, &payload);
    // Mirrors the bridge's MIN_AGENT_BRIDGE_LOG: which events actually cross
    // the Rust boundary, and under which normalized name.
    if let Ok(log_path) = std::env::var("MIN_AGENT_EVENT_LOG") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = writeln!(file, "{event_type} -> {normalized_event_type}");
        }
    }
    let provider_turn_id =
        crate::agent::provider_turn_id_from_payload(&payload).or_else(|| session_id.clone());
    let event = crate::agent::AgentEventEnvelope {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        message_id: message
            .message_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        request_id: request_id.clone(),
        conversation_id: request.conversation_id.clone(),
        session_id: session_id.clone(),
        model: request.model.clone(),
        provider_turn_id: provider_turn_id.clone(),
        terminal_event_id: crate::agent::terminal_event_id(
            &request_id,
            provider_turn_id.as_deref(),
            &normalized_event_type,
        ),
        sequence: message.sequence.unwrap_or_default(),
        timestamp: now_timestamp(),
        provider: crate::agent::AgentProvider::Anthropic,
        runtime: crate::agent::AgentRuntimeKind::ClaudeAgentBridge,
        event_type: normalized_event_type,
        payload: payload.clone(),
    };
    emit_main_window(app, "agent-event", &event)?;
    let compat = crate::codex::CodexEvent {
        request_id: Some(event.request_id.clone()),
        sequence: event.sequence,
        thread_id: session_id.unwrap_or_else(|| event.request_id.clone()),
        event_type,
        payload,
    };
    emit_main_window(app, "codex-event", &compat)?;
    Ok(event)
}

fn emit_approval(app: &tauri::AppHandle, request_id: &str, payload: &Value) -> Result<(), String> {
    let approval_id = payload
        .get("approvalId")
        .and_then(Value::as_str)
        .ok_or_else(|| "A Claude approval azonosítója hiányzik.".to_string())?;
    pending_approvals()
        .lock()
        .map_err(|_| "A Claude approval-állapota zárolva maradt.".to_string())?
        .insert(approval_id.to_string(), request_id.to_string());
    let approval = ClaudeApprovalRequest {
        approval_id: approval_id.to_string(),
        request_id: request_id.to_string(),
        tool_name: payload
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        input: payload.get("input").cloned().unwrap_or(Value::Null),
        title: payload
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
        reason: payload
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        display_name: payload
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::to_string),
        description: payload
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    emit_main_window(app, "agent-approval", &approval)
}

fn emit_question(app: &tauri::AppHandle, request_id: &str, payload: &Value) -> Result<(), String> {
    let question_id = payload
        .get("questionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "A Claude kérdés azonosítója hiányzik.".to_string())?;
    pending_questions()
        .lock()
        .map_err(|_| "A Claude kérdés-állapota zárolva maradt.".to_string())?
        .insert(question_id.to_string(), request_id.to_string());
    let question = ClaudeQuestionRequest {
        question_id: question_id.to_string(),
        request_id: request_id.to_string(),
        questions: payload
            .get("questions")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    };
    emit_main_window(app, "agent-question", &question)
}

fn append_agent_text_delta(buffer: &mut String, delta: &str) {
    if delta.is_empty() || delta == buffer {
        return;
    }
    // Some Claude stream variants send cumulative text while others send
    // incremental chunks. Accept both without producing PPHASE... duplicates.
    if !buffer.is_empty() && delta.starts_with(buffer.as_str()) {
        *buffer = delta.to_string();
    } else {
        buffer.push_str(delta);
    }
}

pub fn send(
    app: tauri::AppHandle,
    request: crate::agent::AgentTurnRequest,
    cancellation: Arc<AtomicBool>,
) -> Result<crate::agent::AgentResponse, String> {
    if cancellation.load(Ordering::Acquire) {
        return Err("A Claude-kérés megszakítva.".to_string());
    }
    let request_id = request
        .request_id
        .clone()
        .ok_or_else(|| "A Claude-kérés azonosítója hiányzik.".to_string())?;
    let auth = resolve_auth()?;
    let cwd = bridge_cwd(request.cwd.clone())?;
    let bridge = bridge_path()?;
    let model = request
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let effort = request
        .effort
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "low".to_string());
    let max_budget_usd = request.max_budget_usd.unwrap_or(DEFAULT_MAX_BUDGET_USD);
    if !max_budget_usd.is_finite() || !(0.01..=5.0).contains(&max_budget_usd) {
        return Err("A Claude coding budgetje 0.01 és 5.00 USD közé essen.".to_string());
    }
    let max_turns = request
        .max_turns
        .unwrap_or(DEFAULT_MAX_TURNS)
        .clamp(1, MAX_TURNS_CEILING);
    let guard_snapshot = crate::codex::begin_agent_workspace_snapshot(&cwd)?;
    let keep_workspace = request.keep_workspace;
    let mut child: Option<Child> = None;
    let turn_completed = Arc::new(AtomicBool::new(false));
    let result = (|| {
        let mut command = Command::new("node");
        command
            .arg(&bridge)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env(
                "MIN_AGENT_BRIDGE_PROTOCOL",
                BRIDGE_PROTOCOL_VERSION.to_string(),
            )
            // Where a granted tool is remembered. The bridge is a fresh process
            // per turn, so a grant kept only in its memory is forgotten before
            // the next command -- which is why "allow for this session" asked
            // again every single time.
            .env("MIN_AGENT_APPROVALS_PATH", approvals_path())
            .env("MIN_AGENT_BRIDGE_LOG", bridge_log_path());
        auth.apply(&mut command);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);

        let mut spawned = command
            .spawn()
            .map_err(|error| format!("A Claude bridge indítása sikertelen: {error}"))?;
        let stdin = spawned
            .stdin
            .take()
            .ok_or_else(|| "A Claude bridge stdin csatornája nem nyitható meg.".to_string())?;
        let stdout = spawned
            .stdout
            .take()
            .ok_or_else(|| "A Claude bridge stdout csatornája nem nyitható meg.".to_string())?;
        let writer = Arc::new(Mutex::new(Some(stdin)));
        attach_process(
            &request_id,
            spawned.id(),
            writer.clone(),
            request.session_id.clone(),
        );
        child = Some(spawned);

        emit_main_window(
            &app,
            "codex-transport",
            &ClaudeTransportStatus {
                request_id: Some(request_id.clone()),
                stage: "server-starting".to_string(),
                detail: "A Claude coding bridge elindult.".to_string(),
                session_id: request.session_id.clone(),
            },
        )?;
        {
            let mut stdin = writer
                .lock()
                .map_err(|_| "A Claude bridge bemenete zárolva maradt.".to_string())?;
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| "A Claude bridge bemenete lezárult.".to_string())?;
            write_bridge_request(
                stdin,
                bridge_request_with_context(
                    &request_id,
                    request.conversation_id.as_deref(),
                    request.session_id.as_deref(),
                    "initialize",
                    json!({ "cwd": cwd.to_string_lossy(), "client": "min", "provider": "anthropic" }),
                ),
            )?;
            write_bridge_request(
                stdin,
                bridge_request_with_context(
                    &request_id,
                    request.conversation_id.as_deref(),
                    request.session_id.as_deref(),
                    if request.session_id.is_some() {
                        "resume_turn"
                    } else {
                        "start_turn"
                    },
                    json!({
                        "prompt": request.prompt,
                        "conversationContext": request.conversation_context,
                        "sessionId": request.session_id,
                        "conversationId": request.conversation_id,
                        "model": model,
                        "effort": effort,
                        "maxBudgetUsd": max_budget_usd,
                        "maxTurns": max_turns,
                        "cwd": cwd.to_string_lossy(),
                        "projectKey": session_project_key(&cwd),
                        "images": request.images,
                        "toolProfile": request
                            .tool_profile
                            .map(crate::agent::StageToolProfile::as_wire),
                    }),
                ),
            )?;
        }

        let reader = CancellableLineReader::new(stdout);
        let mut events = Vec::new();
        let mut final_text = String::new();
        let mut session_id = request.session_id.clone();
        let total_cost_usd: Option<f64>;
        loop {
            let line = reader
                .next_waiting_for_user(&cancellation, &request_id)?
                .ok_or_else(|| "A Claude bridge lezárta a kapcsolatot.".to_string())?;
            let message = parse_bridge_message(line.trim_end())?;
            if message.request_id.as_deref() != Some(request_id.as_str()) {
                continue;
            }
            if message.session_id.is_some() {
                session_id = message.session_id.clone();
                update_provider_turn_id(&request_id, session_id.as_deref());
            }
            match message.message_type.as_deref() {
                Some("session_store_request") => {
                    let operation_id = message
                        .payload
                        .get("operationId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let rpc_started = std::time::Instant::now();
                    let storage_result = crate::store::agent_session_store_rpc(
                        request.conversation_id.as_deref(),
                        &message.payload,
                    );
                    let rpc_elapsed = rpc_started.elapsed();
                    let response_payload = match storage_result {
                        Ok(result) => json!({
                            "operationId": operation_id,
                            "ok": true,
                            "result": result,
                        }),
                        Err(error) => json!({
                            "operationId": operation_id,
                            "ok": false,
                            "error": error,
                        }),
                    };
                    let response_bytes = response_payload.to_string().len();
                    let write_started = std::time::Instant::now();
                    {
                        let mut stdin = writer
                            .lock()
                            .map_err(|_| "A Claude bridge bemenete zárolva maradt.".to_string())?;
                        let stdin = stdin
                            .as_mut()
                            .ok_or_else(|| "A Claude bridge bemenete lezárult.".to_string())?;
                        write_bridge_request(
                            stdin,
                            bridge_request_with_context(
                                &request_id,
                                request.conversation_id.as_deref(),
                                session_id.as_deref(),
                                "session_store_response",
                                response_payload,
                            ),
                        )?;
                    }
                    // A híd naplójának másik fele. Ha ott timeout áll, innen
                    // derül ki, melyik szakaszon: a lekérdezés tartott sokáig,
                    // vagy a (több megabájtos) válasz kiírása a híd bemenetére.
                    // Csak a lassú eset kerül fájlba, a mérete is.
                    let write_elapsed = write_started.elapsed();
                    let slow = std::time::Duration::from_millis(500);
                    if rpc_elapsed > slow || write_elapsed > slow {
                        use std::io::Write;
                        if let Ok(mut file) = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(bridge_log_path())
                        {
                            let _ = writeln!(
                                file,
                                "{} [rust] slow session_store op={} queryMs={} writeMs={} bytes={}",
                                epoch_millis(),
                                message
                                    .payload
                                    .get("operation")
                                    .and_then(Value::as_str)
                                    .unwrap_or("?"),
                                rpc_elapsed.as_millis(),
                                write_elapsed.as_millis(),
                                response_bytes,
                            );
                        }
                    }
                }
                Some("ready") => {}
                Some("session_started") => {
                    let payload = json!({
                        "turnId": session_id.clone().unwrap_or_else(|| request_id.clone()),
                        "item": { "type": "turn", "status": "started" },
                    });
                    events.push(emit_compat_event(
                        &app,
                        &request,
                        &message,
                        "turn/started".to_string(),
                        payload,
                        session_id.clone(),
                    )?);
                }
                Some("agent_event") => {
                    let event_type = message
                        .payload
                        .get("eventType")
                        .and_then(Value::as_str)
                        .unwrap_or("agent/event")
                        .to_string();
                    let payload = message.payload.clone();
                    if event_type == "turn/completed" {
                        if let Some(payload_text) = payload.get("finalText").and_then(Value::as_str)
                        {
                            // The bridge's finalText is the answer alone; the
                            // accumulated deltas may still carry the model's
                            // between-tools narration glued on. "Longer wins"
                            // kept exactly that junk, so the clean text wins
                            // whenever the bridge produced one.
                            if !payload_text.trim().is_empty() {
                                final_text = payload_text.to_string();
                            }
                        }
                        // The bridge emits this normalized event and then a
                        // terminal turn_completed frame. The latter is the
                        // single compatibility terminal boundary; forwarding
                        // both would make one turn look completed twice.
                        continue;
                    }
                    let normalized_event_type =
                        crate::agent::normalize_event_type(&event_type, &payload);
                    let final_answer_delta = normalized_event_type == "assistant/text_delta"
                        && payload
                            .get("phase")
                            .and_then(Value::as_str)
                            .map(|phase| phase != "commentary")
                            .unwrap_or(true);
                    if final_answer_delta {
                        if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                            append_agent_text_delta(&mut final_text, delta);
                        }
                    }
                    events.push(emit_compat_event(
                        &app,
                        &request,
                        &message,
                        event_type,
                        payload,
                        session_id.clone(),
                    )?);
                }
                Some("approval_requested") => {
                    emit_approval(&app, &request_id, &message.payload)?;
                }
                Some("question_requested") => {
                    emit_question(&app, &request_id, &message.payload)?;
                }
                Some("steer_accepted") => {
                    handle_steer_status(&app, &request_id, true, &message.payload)?;
                }
                Some("steer_rejected") => {
                    handle_steer_status(&app, &request_id, false, &message.payload)?;
                }
                Some("turn_completed") => {
                    turn_completed.store(true, Ordering::Release);
                    close_steer_gate(
                        &app,
                        &request_id,
                        crate::agent::AgentInputErrorCode::NoActiveTurn,
                        "A Claude turn lezárult az input elfogadása előtt.",
                    );
                    let payload_text = message
                        .payload
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| message.payload.get("finalText").and_then(Value::as_str))
                        .unwrap_or_default();
                    if payload_text.len() > final_text.len() {
                        final_text = payload_text.to_string();
                    }
                    total_cost_usd = message.payload.get("totalCostUsd").and_then(Value::as_f64);
                    events.push(emit_compat_event(
                        &app,
                        &request,
                        &message,
                        "turn/completed".to_string(),
                        json!({
                            "finalText": final_text,
                            "turnId": session_id.clone().unwrap_or_else(|| request_id.clone()),
                            "totalCostUsd": total_cost_usd,
                        }),
                        session_id.clone(),
                    )?);
                    emit_main_window(
                        &app,
                        "codex-transport",
                        &ClaudeTransportStatus {
                            request_id: Some(request_id.clone()),
                            stage: "turn-completed".to_string(),
                            detail: "A Claude coding-turn lezárult.".to_string(),
                            session_id: session_id.clone(),
                        },
                    )?;
                    break;
                }
                Some("turn_failed") => {
                    let message_text = message
                        .payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("A Claude coding-turn sikertelen.");
                    let error_code = message
                        .payload
                        .get("errorCode")
                        .and_then(Value::as_str)
                        .unwrap_or("turn_failed");
                    close_steer_gate(
                        &app,
                        &request_id,
                        if error_code == "cancelled" {
                            crate::agent::AgentInputErrorCode::RunCancelled
                        } else {
                            crate::agent::AgentInputErrorCode::RuntimeFailed
                        },
                        if error_code == "cancelled" {
                            "A Claude futást az input elfogadása előtt leállították."
                        } else {
                            "A Claude runtime az input elfogadása előtt leállt."
                        },
                    );
                    return Err(format!("Claude [{error_code}]: {message_text}"));
                }
                Some(other) => {
                    return Err(format!("Ismeretlen Claude bridge válasz: {other}"));
                }
                None => {}
            }
        }

        Ok(crate::agent::AgentResponse {
            provider: crate::agent::AgentProvider::Anthropic,
            runtime: crate::agent::AgentRuntimeKind::ClaudeAgentBridge,
            thread_id: session_id.clone(),
            session_id,
            text: crate::store::collapse_repeated_assistant_text("assistant", &final_text),
            events,
            guard: crate::codex::AgentGuardReport {
                snapshot_id: crate::codex::agent_workspace_snapshot_id(&guard_snapshot).to_string(),
                snapshot_path: String::new(),
                base_hash: String::new(),
                post_hash: None,
                changed_files: Vec::new(),
                added_files: Vec::new(),
                removed_files: Vec::new(),
                rollback_available: false,
                apply_available: false,
                apply_base_hash: None,
                rebased: false,
                isolation_mode: "nonGitSnapshot".to_string(),
            },
            thread_rehydrated: request.session_id.is_some(),
        })
    })();

    if !turn_completed.load(Ordering::Acquire) {
        close_steer_gate(
            &app,
            &request_id,
            if cancellation.load(Ordering::Acquire) {
                crate::agent::AgentInputErrorCode::RunCancelled
            } else {
                crate::agent::AgentInputErrorCode::RuntimeFailed
            },
            if cancellation.load(Ordering::Acquire) {
                "A Claude futást az input elfogadása előtt leállították."
            } else {
                "A Claude runtime az input elfogadása előtt leállt."
            },
        );
    }

    if let Some(mut child) = child {
        // The bridge is a persistent JSONL worker, but one `agent_send`
        // owns exactly one turn. Once the terminal bridge message has been
        // consumed, terminate the worker before waiting for it; otherwise
        // `wait()` blocks forever while the bridge waits for the next request.
        let _ = child.kill();
        let _ = child.wait();
    }

    let guard_result = crate::codex::finalize_agent_workspace_snapshot(&guard_snapshot);
    let cancelled_before_turn_completion =
        cancellation.load(Ordering::Acquire) && !turn_completed.load(Ordering::Acquire);
    match (result, guard_result) {
        (Ok(mut response), Ok(report)) if !cancelled_before_turn_completion && keep_workspace => {
            // A chain stage hands its work to the next stage through the
            // working tree itself, so this turn does not roll back. The chain
            // stages its own snapshot once the last stage is done.
            let mut report = report;
            report.isolation_mode = "nonGitSnapshot".to_string();
            response.guard = report;
            Ok(response)
        }
        (Ok(mut response), Ok(report)) if !cancelled_before_turn_completion => {
            let mut report = crate::codex::stage_agent_workspace_snapshot(&guard_snapshot, report)
                .map_err(|error| {
                    format!(
                        "A Claude-válasz stagingje sikertelen: {error}. A snapshot azonosítója: {}.",
                        crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
                    )
                })?;
            report.isolation_mode = "nonGitSnapshot".to_string();
            response.guard = report;
            Ok(response)
        }
        (Ok(_), Ok(report)) => {
            let error = "A Claude-kérés megszakítva.".to_string();
            match crate::codex::stage_agent_workspace_snapshot(&guard_snapshot, report) {
                Ok(_) => Err(format!(
                    "{error} A részleges agent-változásokat elvetettem; a snapshot megmaradt: {}.",
                    crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
                )),
                Err(restore_error) => Err(format!(
                    "{error} A részleges változások automatikus elvetése sikertelen: {restore_error}. A snapshot azonosítója: {}.",
                    crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
                )),
            }
        }
        (Err(error), Ok(report)) => match crate::codex::stage_agent_workspace_snapshot(&guard_snapshot, report) {
            Ok(_) => Err(format!(
                "{error} A részleges agent-változásokat elvetettem; a snapshot megmaradt: {}.",
                crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
            )),
            Err(restore_error) => Err(format!(
                "{error} A részleges változások automatikus elvetése sikertelen: {restore_error}. A snapshot azonosítója: {}.",
                crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
            )),
        },
        (Ok(_), Err(guard_error)) => Err(format!(
            "A Claude-válasz után a workspace guard lezárása sikertelen: {guard_error}. A snapshot azonosítója: {}.",
            crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
        )),
        (Err(error), Err(guard_error)) => Err(format!(
            "{error} A workspace guard lezárása is sikertelen: {guard_error}. A snapshot azonosítója: {}.",
            crate::codex::agent_workspace_snapshot_id(&guard_snapshot)
        )),
    }
}

pub fn test_connection(
    model: Option<String>,
    effort: Option<String>,
    max_budget_usd: Option<f64>,
    max_turns: Option<u32>,
    cwd: Option<String>,
) -> Result<ClaudeConnectionResult, String> {
    let auth = resolve_auth()?;
    let model = model
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let effort = effort
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "low".to_string());
    let max_budget_usd = max_budget_usd.unwrap_or(DEFAULT_MAX_BUDGET_USD);
    if !max_budget_usd.is_finite() || !(0.01..=5.0).contains(&max_budget_usd) {
        return Err("A connection test budgetje 0.01 és 5.00 USD közé essen.".to_string());
    }
    let max_turns = max_turns
        .unwrap_or(DEFAULT_MAX_TURNS)
        .clamp(1, MAX_TURNS_CEILING);
    let cwd = bridge_cwd(cwd)?;
    let bridge = bridge_path()?;
    let request_id = format!("claude-connection-{}", Uuid::new_v4());

    let mut command = Command::new("node");
    command
        .arg(&bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env(
            "MIN_AGENT_BRIDGE_PROTOCOL",
            BRIDGE_PROTOCOL_VERSION.to_string(),
        );
    auth.apply(&mut command);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("A Claude bridge indítása sikertelen: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "A Claude bridge stdin csatornája nem nyitható meg.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "A Claude bridge stdout csatornája nem nyitható meg.".to_string())?;
    let mut reader = BufReader::new(stdout);

    write_bridge_request(
        &mut stdin,
        bridge_request(
            &request_id,
            "initialize",
            json!({ "cwd": cwd.to_string_lossy(), "client": "min" }),
        ),
    )?;
    write_bridge_request(
        &mut stdin,
        bridge_request(
            &request_id,
            "test_connection",
            json!({
                "model": model,
                "effort": effort,
                "maxBudgetUsd": max_budget_usd,
                "maxTurns": max_turns,
                "cwd": cwd.to_string_lossy(),
            }),
        ),
    )?;
    drop(stdin);

    let mut line = String::new();
    let mut connection_result: Option<ClaudeConnectionResult> = None;
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("A Claude bridge válaszának olvasása sikertelen: {error}"))?;
        if bytes == 0 {
            break;
        }
        let message = parse_bridge_message(line.trim_end())?;
        let _ = (
            message.message_id.as_deref(),
            message.conversation_id.as_deref(),
            message.session_id.as_deref(),
            message.sequence,
        );
        if message.request_id.as_deref() != Some(request_id.as_str()) {
            continue;
        }
        if message.message_type.as_deref() != Some("connection_result") {
            continue;
        }

        let payload = message.payload;
        connection_result = Some(ClaudeConnectionResult {
            success: payload
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            model: payload
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or(&model)
                .to_string(),
            effort: payload
                .get("effort")
                .and_then(Value::as_str)
                .unwrap_or(&effort)
                .to_string(),
            text: payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string),
            session_id: payload
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            total_cost_usd: payload.get("totalCostUsd").and_then(Value::as_f64),
            request_id: request_id.clone(),
            error_code: payload
                .get("errorCode")
                .and_then(Value::as_str)
                .map(str::to_string),
            error: payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
        break;
    }

    let _ = child.kill();
    let _ = child.wait();
    connection_result.ok_or_else(|| {
        "A Claude bridge a kapcsolat-teszt előtt leállt, eredmény nélkül.".to_string()
    })
}

struct CancellableLineReader {
    lines: mpsc::Receiver<Result<Option<String>, String>>,
}

impl CancellableLineReader {
    fn new(stdout: ChildStdout) -> Self {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        let _ = sender.send(Ok(None));
                        break;
                    }
                    Ok(_) => {
                        if sender.send(Ok(Some(line))).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        Self { lines: receiver }
    }

    /// Wait for the next bridge event without imposing a wall-clock deadline on
    /// the turn. The short receive poll keeps user cancellation responsive; an
    /// actual EOF still reports a closed bridge immediately.
    fn next(&self, cancellation: &AtomicBool) -> Result<Option<String>, String> {
        loop {
            if cancellation.load(Ordering::Acquire) {
                return Err("A Claude-kérés megszakítva.".to_string());
            }
            match self.lines.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(line) => return line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("A Claude bridge lezárta a kapcsolatot.".to_string())
                }
            }
        }
    }

    /// User approvals/questions may leave the bridge silent for an arbitrary
    /// amount of time. They are still ordinary events from the reader's point
    /// of view, so they follow the same no-deadline path as every other event.
    fn next_waiting_for_user(
        &self,
        cancellation: &AtomicBool,
        _request_id: &str,
    ) -> Result<Option<String>, String> {
        self.next(cancellation)
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Subscription detection must read a login without ever surfacing tokens.
    #[test]
    fn subscription_plan_reads_only_the_plan_label() {
        let directory = std::env::temp_dir().join(format!("min-claude-auth-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("temp dir");
        let path = directory.join(".credentials.json");
        std::fs::write(
            &path,
            r#"{"claudeAiOauth":{"accessToken":"oat-secret-value","refreshToken":"ref-secret-value","subscriptionType":"max","rateLimitTier":"default_max_20x"}}"#,
        )
        .expect("write credentials");

        let plan = read_plan_from(&path);

        assert_eq!(plan.as_deref(), Some("max"));
        assert_eq!(plan_label("max"), "Claude Max");
        // The label shown in the GUI must never carry a token fragment.
        assert!(!plan_label("max").contains("oat-"));
        std::fs::remove_dir_all(&directory).ok();
    }

    /// A logged-out or malformed credential file must not claim a subscription.
    #[test]
    fn subscription_plan_rejects_a_login_without_an_access_token() {
        let directory = std::env::temp_dir().join(format!("min-claude-auth-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("temp dir");

        let empty_token = directory.join("empty.json");
        std::fs::write(&empty_token, r#"{"claudeAiOauth":{"accessToken":"  "}}"#)
            .expect("write credentials");
        assert_eq!(read_plan_from(&empty_token), None);

        let other_shape = directory.join("other.json");
        std::fs::write(&other_shape, r#"{"someOtherKey":{"accessToken":"x"}}"#)
            .expect("write credentials");
        assert_eq!(read_plan_from(&other_shape), None);

        let broken = directory.join("broken.json");
        std::fs::write(&broken, "not json").expect("write credentials");
        assert_eq!(read_plan_from(&broken), None);

        assert_eq!(read_plan_from(&directory.join("missing.json")), None);
        std::fs::remove_dir_all(&directory).ok();
    }

    /// In subscription mode an inherited API key must be cleared, because the
    /// key overrides the Claude Code login even when the user is signed in.
    #[test]
    fn subscription_mode_never_forwards_an_api_key() {
        let subscription = ResolvedAuth {
            mode: AuthMode::Subscription,
            api_key: Some("sk-ant-should-not-be-used".to_string()),
        };
        let mut command = Command::new("node");
        command.env("ANTHROPIC_API_KEY", "sk-ant-inherited");
        command.env("ANTHROPIC_AUTH_TOKEN", "inherited-bearer");
        subscription.apply(&mut command);

        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect();
        let lookup = |name: &str| {
            envs.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };

        // `None` is the removal marker, so the child sees neither header.
        assert_eq!(lookup("ANTHROPIC_API_KEY"), Some(None));
        assert_eq!(lookup("ANTHROPIC_AUTH_TOKEN"), Some(None));
        assert_eq!(
            lookup("MIN_AGENT_AUTH_MODE"),
            Some(Some("subscription".to_string()))
        );
    }

    /// The pay-per-token fallback still injects the key for release scenarios
    /// where a claude.ai login must not be used.
    #[test]
    fn api_key_mode_forwards_the_key_to_the_bridge() {
        let api_key_auth = ResolvedAuth {
            mode: AuthMode::ApiKey,
            api_key: Some("sk-ant-live-key".to_string()),
        };
        let mut command = Command::new("node");
        api_key_auth.apply(&mut command);

        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect();
        assert!(envs.contains(&(
            "ANTHROPIC_API_KEY".to_string(),
            Some("sk-ant-live-key".to_string())
        )));
        assert!(envs.contains(&(
            "MIN_AGENT_AUTH_MODE".to_string(),
            Some("apiKey".to_string())
        )));
    }

    #[test]
    fn api_key_preview_never_contains_the_full_key() {
        let preview = api_key_preview("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");

        assert!(preview.starts_with("sk-ant-"));
        assert!(preview.ends_with("wxyz"));
        assert!(!preview.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn bridge_request_contains_protocol_metadata() {
        let request = bridge_request("request-1", "initialize", json!({ "client": "test" }));

        assert_eq!(request["protocolVersion"], BRIDGE_PROTOCOL_VERSION);
        assert_eq!(request["requestId"], "request-1");
        assert_eq!(request["type"], "initialize");
    }

    #[test]
    fn bridge_reader_waits_without_a_wall_clock_timeout_until_cancelled() {
        let (_sender, receiver) = mpsc::channel();
        let reader = CancellableLineReader { lines: receiver };
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_for_reader = Arc::clone(&cancellation);

        let handle = thread::spawn(move || reader.next(&cancellation_for_reader));
        thread::sleep(std::time::Duration::from_millis(10));
        cancellation.store(true, Ordering::Release);

        let error = handle
            .join()
            .expect("the bridge reader thread must finish after cancellation")
            .expect_err("an idle bridge must wait until it is cancelled");
        assert!(error.contains("megszakítva"));
    }

    #[test]
    fn a_turn_waiting_on_the_user_is_not_treated_as_a_dead_bridge() {
        let request_id = format!("request-{}", uuid::Uuid::new_v4());
        let approval_id = format!("approval-{}", uuid::Uuid::new_v4());

        assert!(
            !waiting_for_user(&request_id),
            "a turn nobody was asked about is not waiting"
        );

        pending_approvals()
            .lock()
            .expect("approval registry")
            .insert(approval_id.clone(), request_id.clone());
        assert!(
            waiting_for_user(&request_id),
            "an unanswered approval means the silence is the user's, not the bridge's"
        );

        // Answering it hands the turn back to the bridge, and the idle clock
        // becomes meaningful again.
        pending_approvals()
            .lock()
            .expect("approval registry")
            .remove(&approval_id);
        assert!(!waiting_for_user(&request_id));

        // A question blocks the turn the same way an approval does.
        let question_id = format!("question-{}", uuid::Uuid::new_v4());
        pending_questions()
            .lock()
            .expect("question registry")
            .insert(question_id.clone(), request_id.clone());
        assert!(waiting_for_user(&request_id));
        pending_questions()
            .lock()
            .expect("question registry")
            .remove(&question_id);
    }
}
