use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRequest {
    pub prompt: String,
    pub thread_id: Option<String>,
    #[serde(default)]
    pub conversation_context: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

struct ActiveRequest {
    cancelled: Arc<AtomicBool>,
    pid: Option<u32>,
}

static ACTIVE_REQUESTS: OnceLock<Mutex<HashMap<String, ActiveRequest>>> = OnceLock::new();

struct PendingApproval {
    decision: Mutex<Option<String>>,
    resolved: Condvar,
}

static PENDING_APPROVALS: OnceLock<Mutex<HashMap<String, Arc<PendingApproval>>>> = OnceLock::new();

fn pending_approvals() -> &'static Mutex<HashMap<String, Arc<PendingApproval>>> {
    PENDING_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

const APPROVAL_WAIT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

fn active_requests() -> &'static Mutex<HashMap<String, ActiveRequest>> {
    ACTIVE_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn begin_request(request_id: &str) -> Result<Arc<AtomicBool>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut requests = active_requests()
        .lock()
        .map_err(|_| "A Codex-kérések állapota zárolva maradt.".to_string())?;
    requests.insert(
        request_id.to_string(),
        ActiveRequest {
            cancelled: cancelled.clone(),
            pid: None,
        },
    );
    Ok(cancelled)
}

pub fn attach_child_pid(request_id: &str, pid: u32) {
    if let Ok(mut requests) = active_requests().lock() {
        if let Some(request) = requests.get_mut(request_id) {
            request.pid = Some(pid);
            if request.cancelled.load(Ordering::Relaxed) {
                kill_process_tree(pid);
            }
        }
    }
}

pub fn cancel_request(request_id: &str) -> Result<(), String> {
    let (cancelled, pid) = {
        let requests = active_requests()
            .lock()
            .map_err(|_| "A Codex-kérések állapota zárolva maradt.".to_string())?;
        requests
            .get(request_id)
            .map(|request| (request.cancelled.clone(), request.pid))
            .ok_or_else(|| "A Codex-kérés már befejeződött.".to_string())?
    };
    cancelled.store(true, Ordering::Relaxed);
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    Ok(())
}

pub fn end_request(request_id: &str) {
    if let Ok(mut requests) = active_requests().lock() {
        requests.remove(request_id);
    }
}

fn valid_approval_decision(decision: &str) -> bool {
    matches!(
        decision,
        "accept" | "acceptForSession" | "decline" | "cancel"
    )
}

pub fn respond_approval(approval_id: &str, decision: &str) -> Result<(), String> {
    if !valid_approval_decision(decision) {
        return Err(format!(
            "Ismeretlen approval döntés: {decision}. Engedélyezett: accept, acceptForSession, decline, cancel."
        ));
    }
    let pending = pending_approvals()
        .lock()
        .map_err(|_| "Az approval-kérések állapota zárolva maradt.".to_string())?
        .get(approval_id)
        .cloned()
        .ok_or_else(|| "Az approval-kérés már lezárult vagy nem található.".to_string())?;
    let mut current = pending
        .decision
        .lock()
        .map_err(|_| "Az approval-kérés állapota zárolva maradt.".to_string())?;
    if current.is_some() {
        return Err("Az approval-kérésre már érkezett döntés.".to_string());
    }
    *current = Some(decision.to_string());
    pending.resolved.notify_all();
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexResponse {
    pub thread_id: String,
    pub text: String,
    pub events: Vec<CodexEvent>,
    pub guard: AgentGuardReport,
    pub thread_rehydrated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentGuardReport {
    pub snapshot_id: String,
    pub snapshot_path: String,
    pub base_hash: String,
    pub post_hash: Option<String>,
    pub changed_files: Vec<String>,
    pub added_files: Vec<String>,
    pub removed_files: Vec<String>,
    pub rollback_available: bool,
    pub apply_available: bool,
    pub apply_base_hash: Option<String>,
    pub rebased: bool,
    pub isolation_mode: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRollbackResult {
    pub snapshot_id: String,
    pub root: String,
    pub restored_files: usize,
    pub removed_files: usize,
    pub base_hash: String,
    pub resulting_hash: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentApplyResult {
    pub snapshot_id: String,
    pub root: String,
    pub applied_files: usize,
    pub removed_files: usize,
    pub base_hash: String,
    pub resulting_hash: String,
    pub rollback_available: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiscardResult {
    pub snapshot_id: String,
    pub root: String,
    pub base_hash: String,
    pub resulting_hash: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffLine {
    pub kind: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffFile {
    pub path: String,
    pub status: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub binary_or_truncated: bool,
    pub lines: Vec<AgentDiffLine>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDiffPreview {
    pub snapshot_id: String,
    pub root: String,
    pub base_hash: String,
    pub post_hash: String,
    pub current_hash: String,
    pub current_state: String,
    pub created_at: Option<String>,
    pub last_action: Option<String>,
    pub last_action_at: Option<String>,
    pub files: Vec<AgentDiffFile>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRebaseResult {
    pub snapshot_id: String,
    pub root: String,
    pub original_base_hash: String,
    pub apply_base_hash: String,
    pub merged_hash: String,
    pub merged_files: usize,
    pub rebased: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRequest {
    pub approval_id: String,
    pub request_id: Value,
    pub kind: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub reason: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GuardFile {
    relative_path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuardManifest {
    root: String,
    base_hash: String,
    base_files: Vec<GuardFile>,
    post_hash: Option<String>,
    post_files: Option<Vec<GuardFile>>,
    #[serde(default)]
    applied: bool,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    last_action: Option<String>,
    #[serde(default)]
    last_action_at: Option<String>,
    #[serde(default)]
    apply_base_hash: Option<String>,
    #[serde(default)]
    apply_base_files: Option<Vec<GuardFile>>,
    #[serde(default)]
    rebased: bool,
}

#[derive(Debug, Clone)]
struct AgentSnapshot {
    id: String,
    root: PathBuf,
    directory: PathBuf,
    manifest: GuardManifest,
}

struct GitShadowWorkspace {
    repository_root: PathBuf,
    worktree_root: PathBuf,
}

struct AgentExecutionWorkspace {
    cwd: PathBuf,
    git_shadow: Option<GitShadowWorkspace>,
}

const GUARD_MAX_FILES: usize = 10_000;
const GUARD_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const GUARD_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodexDelta {
    thread_id: String,
    delta: String,
    item_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexEvent {
    pub thread_id: String,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub supported_reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
}

const SETTINGS_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinSettings {
    schema_version: i64,
    #[serde(default)]
    projects_root: Option<String>,
}

fn local_min_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "A min helyi adatkönyvtára nem határozható meg.".to_string())?;
    Ok(PathBuf::from(base).join("min"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(local_min_root()?.join("settings.json"))
}

fn read_settings() -> Option<MinSettings> {
    let path = settings_path().ok()?;
    if !path.is_file() {
        return None;
    }
    let contents = fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<MinSettings>(&contents).ok()?;
    (settings.schema_version == SETTINGS_SCHEMA_VERSION).then_some(settings)
}

fn canonical_existing_directory(value: &str) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.is_dir() {
        return None;
    }
    Some(path.canonicalize().unwrap_or(path))
}

fn configured_projects_root() -> Option<PathBuf> {
    read_settings()?
        .projects_root
        .as_deref()
        .and_then(canonical_existing_directory)
}

fn write_settings(settings: &MinSettings) -> Result<(), String> {
    let path = settings_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "A min beállításfájljának szülőmappája nem határozható meg.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Nem hozható létre a min helyi adatkönyvtára: {error}"))?;

    let temporary = parent.join("settings.json.tmp");
    let backup = parent.join("settings.json.bak");
    let serialized = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("A min beállításai nem szerializálhatók: {error}"))?;
    fs::write(&temporary, serialized)
        .map_err(|error| format!("A min beállításai nem írhatók: {error}"))?;

    let had_existing = path.is_file();
    if had_existing {
        let _ = fs::remove_file(&backup);
        if let Err(error) = fs::copy(&path, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "A meglévő min beállításairól nem készíthető biztonsági másolat: {error}"
            ));
        }
        if let Err(error) = fs::remove_file(&path) {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&backup);
            return Err(format!("A meglévő min beállításai nem cserélhetők: {error}"));
        }
    }

    if let Err(error) = fs::rename(&temporary, &path) {
        if had_existing && backup.is_file() {
            let _ = fs::copy(&backup, &path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "A min beállításai nem cserélhetők atomikusan; az előző állapot megmaradt: {error}"
        ));
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

#[cfg(debug_assertions)]
fn projects_root_from_workspace(workspace: &Path) -> PathBuf {
    workspace
        .ancestors()
        .find(|ancestor| {
            ancestor
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case("my projects"))
                .unwrap_or(false)
        })
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.to_path_buf())
}

#[cfg(debug_assertions)]
fn development_workspace_cwd() -> Option<PathBuf> {
    if let Ok(current) = std::env::current_dir() {
        if current.join("package.json").is_file() {
            return Some(current);
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        for ancestor in executable.ancestors() {
            if ancestor.join("package.json").is_file() {
                return Some(ancestor.to_path_buf());
            }
        }
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_root.parent().map(PathBuf::from)
}

fn auto_detect_projects_roots() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        let Some(value) = std::env::var_os(variable) else {
            continue;
        };
        let base = PathBuf::from(value);
        let candidate = if base
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("my projects"))
            .unwrap_or(false)
        {
            base
        } else {
            base.join("my projects")
        };
        let Some(candidate) = canonical_existing_directory(&candidate.to_string_lossy()) else {
            continue;
        };
        if !candidates.iter().any(|existing: &PathBuf| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&candidate.to_string_lossy())
        }) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn discovered_projects_root() -> Option<PathBuf> {
    let candidates = auto_detect_projects_roots();
    if candidates.len() == 1 {
        return candidates.into_iter().next();
    }

    #[cfg(debug_assertions)]
    if candidates.is_empty() {
        return development_workspace_cwd().map(|workspace| projects_root_from_workspace(&workspace));
    }

    None
}

fn resolved_projects_root() -> Option<PathBuf> {
    configured_projects_root().or_else(discovered_projects_root)
}

pub fn workspace_root_for_ui() -> Result<Option<String>, String> {
    if let Some(root) = configured_projects_root() {
        return Ok(Some(root.to_string_lossy().to_string()));
    }

    let Some(root) = discovered_projects_root() else {
        return Ok(None);
    };
    let settings = MinSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        projects_root: Some(root.to_string_lossy().to_string()),
    };
    write_settings(&settings)?;
    Ok(Some(root.to_string_lossy().to_string()))
}

pub fn set_projects_root(value: &str) -> Result<String, String> {
    let root = canonical_existing_directory(value)
        .ok_or_else(|| "A kiválasztott projektek-gyökér nem abszolút, vagy nem létező mappa.".to_string())?;
    let settings = MinSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        projects_root: Some(root.to_string_lossy().to_string()),
    };
    write_settings(&settings)?;
    Ok(root.to_string_lossy().to_string())
}

fn codex_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("MIN_CODEX_BIN") {
        return Ok(PathBuf::from(path));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("codex.exe");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    #[cfg(debug_assertions)]
    {
        let workspace_binary = workspace_cwd()
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe");
        if workspace_binary.is_file() {
            return Ok(workspace_binary);
        }

        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let managed_binary = PathBuf::from(home)
                .join(".codex")
                .join("plugins")
                .join(".plugin-appserver")
                .join(if cfg!(windows) { "codex.exe" } else { "codex" });
            if managed_binary.is_file() {
                return Ok(managed_binary);
            }
        }

        return Ok(PathBuf::from("codex"));
    }

    #[cfg(not(debug_assertions))]
    {
        Err("A release Codex binárisa hiányzik a bundle resource könyvtárából (codex.exe).".to_string())
    }
}

pub fn workspace_cwd() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(workspace) = development_workspace_cwd() {
        return workspace;
    }

    resolved_projects_root().unwrap_or_default()
}

fn requested_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(workspace_cwd);
    if !path.is_dir() {
        return Err(format!(
            "A kiválasztott projektmappa nem található: {}",
            path.display()
        ));
    }
    let canonical = path.canonicalize().unwrap_or(path);
    let projects_root = require_projects_root()?;
    let projects_root = projects_root
        .canonicalize()
        .unwrap_or(projects_root);
    if !canonical.starts_with(&projects_root) {
        return Err(format!(
            "Az agent cwd-je a projektek gyökerén kívülre mutat: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn audit_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn set_manifest_action(manifest: &mut GuardManifest, action: &str) {
    manifest.last_action = Some(action.to_string());
    manifest.last_action_at = Some(audit_timestamp());
}

fn agent_snapshot_root() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "Az agent snapshot helye nem határozható meg.".to_string())?;
    Ok(PathBuf::from(base).join("min").join("agent-snapshots"))
}

fn is_guard_excluded_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".min-sync" | "node_modules" | "target" | "dist" | ".vite"
    )
}

fn guard_relative_path(path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(component, Component::Prefix(_) | Component::RootDir | Component::ParentDir)
        })
    {
        return Err(format!("A snapshot relatív útvonala nem biztonságos: {path}"));
    }
    Ok(relative)
}

fn collect_guard_files_inner(
    root: &Path,
    current: &Path,
    files: &mut Vec<GuardFile>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("Az agent snapshot könyvtára nem olvasható: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Az agent snapshot fájllistája hibás: {error}"))?;
        let path = entry.path();
        let file_type = fs::symlink_metadata(&path)
            .map_err(|error| format!("Az agent snapshot metaadata nem olvasható: {error}"))?
            .file_type();
        if entry
            .file_name()
            .to_str()
            .map(is_guard_excluded_directory)
            .unwrap_or(false)
        {
            continue;
        }
        if file_type.is_symlink() {
            return Err(format!(
                "Az agent snapshot symlinket talált, ezért fail-closed: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            collect_guard_files_inner(root, &path, files, total_bytes)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if files.len() >= GUARD_MAX_FILES {
            return Err(format!(
                "Az agent snapshot túl sok fájlt tartalmaz (limit: {}).",
                GUARD_MAX_FILES
            ));
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Az agent snapshot fájlmérete nem olvasható: {error}"))?;
        if metadata.len() > GUARD_MAX_FILE_BYTES {
            return Err(format!(
                "Az agent snapshot fájlja túl nagy (limit: {} bájt): {}.",
                GUARD_MAX_FILE_BYTES,
                path.display()
            ));
        }
        *total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "Az agent snapshot mérete túlcsordult.".to_string())?;
        if *total_bytes > GUARD_MAX_TOTAL_BYTES {
            return Err(format!(
                "Az agent snapshot túl nagy (limit: {} bájt).",
                GUARD_MAX_TOTAL_BYTES
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("Az agent snapshot fájlja nem olvasható: {error}"))?;
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("Az agent snapshot relatív útvonala nem képezhető: {error}"))?;
        let relative_path = relative.to_string_lossy().replace('\\', "/");
        files.push(GuardFile {
            relative_path,
            bytes: metadata.len(),
            sha256: sha256_hex(&bytes),
        });
    }
    Ok(())
}

fn collect_guard_files(root: &Path) -> Result<Vec<GuardFile>, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    collect_guard_files_inner(root, root, &mut files, &mut total_bytes)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn copy_guard_files(root: &Path, files: &[GuardFile], target_root: &Path) -> Result<(), String> {
    fs::create_dir_all(target_root)
        .map_err(|error| format!("Az agent snapshot post-mappája nem hozható létre: {error}"))?;
    for file in files {
        let relative = guard_relative_path(&file.relative_path)?;
        let source = root.join(&relative);
        let source_type = fs::symlink_metadata(&source)
            .map_err(|error| format!("Az agent snapshot forrás-metaadata nem olvasható: {error}"))?
            .file_type();
        if source_type.is_symlink() {
            return Err(format!(
                "Az agent snapshot symlinket tartalmaz, ezért fail-closed: {}",
                source.display()
            ));
        }
        let target = target_root.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Az agent snapshot almappája nem hozható létre: {error}"))?;
        }
        fs::copy(&source, &target)
            .map_err(|error| format!("Az agent snapshot fájlja nem másolható: {error}"))?;
    }
    Ok(())
}

fn guard_manifest_hash(files: &[GuardFile]) -> Result<String, String> {
    let bytes = serde_json::to_vec(files)
        .map_err(|error| format!("Az agent base manifest nem szerializálható: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn write_guard_manifest(directory: &Path, manifest: &GuardManifest) -> Result<(), String> {
    let path = directory.join("manifest.json");
    let temporary = directory.join(format!(".manifest.tmp-{}", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| format!("Az agent snapshot manifestje nem szerializálható: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Az agent snapshot manifestje nem írható: {error}"))?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Az agent snapshot manifestje nem cserélhető: {error}"))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Az agent snapshot manifestje nem cserélhető: {error}"))
}

fn create_agent_snapshot_at(root: &Path, snapshot_root: &Path) -> Result<AgentSnapshot, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Az agent snapshot gyökere nem canonicalizálható: {error}"))?;
    let files = collect_guard_files(&root)?;
    let base_hash = guard_manifest_hash(&files)?;
    let id = Uuid::new_v4().to_string();
    let directory = snapshot_root.join(&id);
    let files_directory = directory.join("files");
    fs::create_dir_all(&files_directory)
        .map_err(|error| format!("Az agent snapshot mappája nem hozható létre: {error}"))?;
    let copy_result = (|| {
        for file in &files {
            let relative = guard_relative_path(&file.relative_path)?;
            let source = root.join(&relative);
            let target = files_directory.join(&relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("Az agent snapshot almappája nem hozható létre: {error}")
                })?;
            }
            fs::copy(&source, &target)
                .map_err(|error| format!("Az agent snapshot fájlja nem másolható: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    let manifest = GuardManifest {
        root: root.to_string_lossy().to_string(),
        base_hash: base_hash.clone(),
        base_files: files.clone(),
        post_hash: None,
        post_files: None,
        applied: false,
        created_at: Some(audit_timestamp()),
        last_action: Some("created".to_string()),
        last_action_at: Some(audit_timestamp()),
        apply_base_hash: Some(base_hash.clone()),
        apply_base_files: Some(files.clone()),
        rebased: false,
    };
    write_guard_manifest(&directory, &manifest)?;
    Ok(AgentSnapshot {
        id,
        root,
        directory,
        manifest,
    })
}

fn create_agent_snapshot(root: &Path) -> Result<AgentSnapshot, String> {
    let snapshot_root = agent_snapshot_root()?;
    create_agent_snapshot_at(root, &snapshot_root)
}

fn run_git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("A Git parancs nem indítható: {error}"))
}

fn git_repository_root(root: &Path) -> Option<PathBuf> {
    let output = run_git(root, &["rev-parse", "--show-toplevel"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let candidate = PathBuf::from(text.trim());
    let canonical = candidate.canonicalize().ok()?;
    if canonical == root.canonicalize().ok()? {
        Some(canonical)
    } else {
        None
    }
}

fn prepare_git_shadow(root: &Path) -> Option<GitShadowWorkspace> {
    let repository_root = git_repository_root(root)?;
    let status = run_git(
        &repository_root,
        &["status", "--porcelain", "--untracked-files=all"],
    )
    .ok()?;
    if !status.status.success() || !status.stdout.is_empty() {
        return None;
    }
    for excluded in ["node_modules", "target", ".pnpm-store", ".venv", "venv"] {
        if root.join(excluded).exists() {
            return None;
        }
    }
    let preferred_base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|path| path.join("min").join("agent-worktrees"));
    let bases = preferred_base.into_iter().chain(std::iter::once(
        std::env::temp_dir().join("min").join("agent-worktrees"),
    ));
    for base in bases {
        if fs::create_dir_all(&base).is_err() {
            continue;
        }
        let worktree_root = base.join(Uuid::new_v4().to_string());
        let worktree_text = worktree_root.to_string_lossy().to_string();
        let Ok(output) = run_git(
            &repository_root,
            &["worktree", "add", "--detach", "--quiet", &worktree_text, "HEAD"],
        ) else {
            continue;
        };
        if output.status.success() {
            return Some(GitShadowWorkspace {
                repository_root,
                worktree_root,
            });
        }
        let _ = fs::remove_dir_all(&worktree_root);
    }
    None
}

fn prepare_agent_execution(root: &Path) -> AgentExecutionWorkspace {
    if let Some(git_shadow) = prepare_git_shadow(root) {
        return AgentExecutionWorkspace {
            cwd: git_shadow.worktree_root.clone(),
            git_shadow: Some(git_shadow),
        };
    }
    AgentExecutionWorkspace {
        cwd: root.to_path_buf(),
        git_shadow: None,
    }
}

fn cleanup_git_shadow(git_shadow: Option<&GitShadowWorkspace>) {
    let Some(git_shadow) = git_shadow else {
        return;
    };
    let worktree_text = git_shadow.worktree_root.to_string_lossy().to_string();
    let _ = run_git(
        &git_shadow.repository_root,
        &["worktree", "remove", "--force", &worktree_text],
    );
    let _ = fs::remove_dir_all(&git_shadow.worktree_root);
}

fn diff_guard_files(
    base_files: &[GuardFile],
    post_files: &[GuardFile],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let base = base_files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let post = post_files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut changed = Vec::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for (path, post_file) in &post {
        match base.get(path) {
            Some(base_file) if base_file.sha256 != post_file.sha256 => changed.push((*path).to_string()),
            Some(_) => {}
            None => added.push((*path).to_string()),
        }
    }
    for path in base.keys() {
        if !post.contains_key(path) {
            removed.push((*path).to_string());
        }
    }
    (changed, added, removed)
}

fn guard_report(snapshot: &AgentSnapshot, post_files: Option<&[GuardFile]>) -> AgentGuardReport {
    let (post_hash, changed_files, added_files, removed_files) = match post_files {
        Some(files) => {
            let post_hash = guard_manifest_hash(files).ok();
            let (changed, added, removed) = diff_guard_files(&snapshot.manifest.base_files, files);
            (post_hash, changed, added, removed)
        }
        None => (None, Vec::new(), Vec::new(), Vec::new()),
    };
    AgentGuardReport {
        snapshot_id: snapshot.id.clone(),
        snapshot_path: snapshot.directory.to_string_lossy().to_string(),
        base_hash: snapshot.manifest.base_hash.clone(),
        post_hash,
        changed_files,
        added_files,
        removed_files,
        rollback_available: snapshot.directory.is_dir(),
        apply_available: false,
        apply_base_hash: snapshot
            .manifest
            .apply_base_hash
            .clone()
            .or_else(|| Some(snapshot.manifest.base_hash.clone())),
        rebased: snapshot.manifest.rebased,
        isolation_mode: "nonGitSnapshot".to_string(),
    }
}

fn finalize_agent_snapshot_from_root(
    snapshot: &AgentSnapshot,
    source_root: &Path,
) -> Result<AgentGuardReport, String> {
    let post_files = collect_guard_files(source_root)?;
    let post_hash = guard_manifest_hash(&post_files)?;
    copy_guard_files(source_root, &post_files, &snapshot.directory.join("post-files"))?;
    let mut manifest = snapshot.manifest.clone();
    manifest.post_hash = Some(post_hash);
    manifest.post_files = Some(post_files.clone());
    manifest.applied = false;
    manifest.apply_base_hash = Some(manifest.base_hash.clone());
    manifest.apply_base_files = Some(manifest.base_files.clone());
    manifest.rebased = false;
    set_manifest_action(&mut manifest, "staged");
    write_guard_manifest(&snapshot.directory, &manifest)?;
    Ok(guard_report(snapshot, Some(&post_files)))
}

fn finalize_agent_snapshot(snapshot: &AgentSnapshot) -> Result<AgentGuardReport, String> {
    finalize_agent_snapshot_from_root(snapshot, &snapshot.root)
}

fn safe_guard_target(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = guard_relative_path(relative_path)?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(name) = component {
            cursor.push(name);
            if let Ok(metadata) = fs::symlink_metadata(&cursor) {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "A fájlművelet célja symlink, ezért blokkolva: {}",
                        cursor.display()
                    ));
                }
            }
        }
    }
    Ok(root.join(relative))
}

fn restore_guard_file_set(
    root: &Path,
    directory: &Path,
    source_directory: &str,
    target_files: &[GuardFile],
    current_files: &[GuardFile],
) -> Result<(usize, usize), String> {
    let target_paths = target_files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut restored_files = 0_usize;
    for file in target_files {
        let source = directory
            .join(source_directory)
            .join(guard_relative_path(&file.relative_path)?);
        let target = safe_guard_target(root, &file.relative_path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("A visszaállítás almappája nem hozható létre: {error}"))?;
        }
        fs::copy(&source, &target)
            .map_err(|error| format!("A visszaállítás fájlja nem állítható vissza: {error}"))?;
        restored_files += 1;
    }
    let mut removed_files = 0_usize;
    for file in current_files {
        if target_paths.contains(file.relative_path.as_str()) {
            continue;
        }
        let target = safe_guard_target(root, &file.relative_path)?;
        fs::remove_file(&target)
            .map_err(|error| format!("A visszaállítás új fájlja nem távolítható el: {error}"))?;
        removed_files += 1;
    }
    Ok((restored_files, removed_files))
}

fn restore_snapshot_base_files(
    root: &Path,
    directory: &Path,
    manifest: &GuardManifest,
    current_files: &[GuardFile],
) -> Result<(usize, usize), String> {
    restore_guard_file_set(root, directory, "files", &manifest.base_files, current_files)
}

fn read_guard_manifest(snapshot_root: &Path, snapshot_id: &str) -> Result<(PathBuf, GuardManifest), String> {
    Uuid::parse_str(snapshot_id)
        .map_err(|_| "Az agent snapshot azonosítója nem UUID.".to_string())?;
    let directory = snapshot_root.join(snapshot_id);
    let manifest_path = directory.join("manifest.json");
    let bytes = fs::read(&manifest_path)
        .map_err(|error| format!("Az agent snapshot manifestje nem olvasható: {error}"))?;
    let manifest = serde_json::from_slice::<GuardManifest>(&bytes)
        .map_err(|error| format!("Az agent snapshot manifestje hibás: {error}"))?;
    Ok((directory, manifest))
}

fn validate_guard_root(manifest: &GuardManifest, allowed_root: Option<&Path>) -> Result<PathBuf, String> {
    let root = PathBuf::from(&manifest.root)
        .canonicalize()
        .map_err(|error| format!("Az agent snapshot gyökere nem érhető el: {error}"))?;
    if let Some(allowed_root) = allowed_root {
        let allowed_root = allowed_root
            .canonicalize()
            .map_err(|error| format!("A projektek gyökere nem canonicalizálható: {error}"))?;
        if !root.starts_with(&allowed_root) {
            return Err("Az agent snapshot gyökere a projektek gyökerén kívülre mutat.".to_string());
        }
    }
    Ok(root)
}

const DIFF_MAX_SOURCE_LINES: usize = 600;
const DIFF_MAX_OUTPUT_LINES: usize = 400;
const DIFF_MAX_TEXT_BYTES: usize = 512 * 1024;
const DIFF_MAX_FILES: usize = 200;

fn bounded_line_diff(
    before_bytes: Option<&[u8]>,
    after_bytes: Option<&[u8]>,
) -> (Vec<AgentDiffLine>, bool) {
    let before_bytes = before_bytes.unwrap_or_default();
    let after_bytes = after_bytes.unwrap_or_default();
    if before_bytes.len() > DIFF_MAX_TEXT_BYTES || after_bytes.len() > DIFF_MAX_TEXT_BYTES {
        return (
            vec![AgentDiffLine {
                kind: "meta".to_string(),
                old_line: None,
                new_line: None,
                text: "[túl nagy fájl; csak hash-összevetés]".to_string(),
            }],
            true,
        );
    }
    let before_text = match std::str::from_utf8(before_bytes) {
        Ok(value) => value,
        Err(_) => {
            return (
                vec![AgentDiffLine {
                    kind: "meta".to_string(),
                    old_line: None,
                    new_line: None,
                    text: "[bináris fájl; csak hash-összevetés]".to_string(),
                }],
                true,
            )
        }
    };
    let after_text = match std::str::from_utf8(after_bytes) {
        Ok(value) => value,
        Err(_) => {
            return (
                vec![AgentDiffLine {
                    kind: "meta".to_string(),
                    old_line: None,
                    new_line: None,
                    text: "[bináris fájl; csak hash-összevetés]".to_string(),
                }],
                true,
            )
        }
    };
    let source_truncated = before_text.lines().count() > DIFF_MAX_SOURCE_LINES
        || after_text.lines().count() > DIFF_MAX_SOURCE_LINES;
    let before = before_text
        .lines()
        .take(DIFF_MAX_SOURCE_LINES)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let after = after_text
        .lines()
        .take(DIFF_MAX_SOURCE_LINES)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut lcs = vec![vec![0_u16; after.len() + 1]; before.len() + 1];
    for old in (0..before.len()).rev() {
        for new in (0..after.len()).rev() {
            lcs[old][new] = if before[old] == after[new] {
                lcs[old + 1][new + 1].saturating_add(1)
            } else {
                lcs[old + 1][new].max(lcs[old][new + 1])
            };
        }
    }
    let mut lines = Vec::new();
    let mut old = 0_usize;
    let mut new = 0_usize;
    let mut truncated = source_truncated;
    while old < before.len() || new < after.len() {
        if lines.len() >= DIFF_MAX_OUTPUT_LINES {
            truncated = true;
            break;
        }
        if old < before.len() && new < after.len() && before[old] == after[new] {
            lines.push(AgentDiffLine {
                kind: "context".to_string(),
                old_line: Some(old + 1),
                new_line: Some(new + 1),
                text: before[old].clone(),
            });
            old += 1;
            new += 1;
        } else if new >= after.len()
            || (old < before.len() && lcs[old + 1][new] >= lcs[old][new + 1])
        {
            lines.push(AgentDiffLine {
                kind: "removed".to_string(),
                old_line: Some(old + 1),
                new_line: None,
                text: before[old].clone(),
            });
            old += 1;
        } else {
            lines.push(AgentDiffLine {
                kind: "added".to_string(),
                old_line: None,
                new_line: Some(new + 1),
                text: after[new].clone(),
            });
            new += 1;
        }
    }
    if truncated {
        lines.push(AgentDiffLine {
            kind: "meta".to_string(),
            old_line: None,
            new_line: None,
            text: "[… a diff korlátozott nézet; a hash a teljes fájlra vonatkozik]".to_string(),
        });
    }
    (lines, truncated)
}

fn agent_diff_preview_at(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<AgentDiffPreview, String> {
    let (directory, manifest) = read_guard_manifest(snapshot_root, snapshot_id)?;
    let root = validate_guard_root(&manifest, allowed_root)?;
    let post_files = manifest
        .post_files
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs lezárt post-manifest.".to_string())?;
    let post_hash = manifest
        .post_hash
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs post-hash.".to_string())?
        .to_string();
    let current_files = collect_guard_files(&root)?;
    let current_hash = guard_manifest_hash(&current_files)?;
    let current_state = if current_hash == manifest.base_hash {
        "base"
    } else if current_hash == post_hash {
        "post"
    } else {
        "changed"
    };
    let mut files = BTreeMap::<String, (Option<GuardFile>, Option<GuardFile>)>::new();
    for file in &manifest.base_files {
        files.insert(file.relative_path.clone(), (Some(file.clone()), None));
    }
    for file in post_files {
        files
            .entry(file.relative_path.clone())
            .and_modify(|entry| entry.1 = Some(file.clone()))
            .or_insert_with(|| (None, Some(file.clone())));
    }
    let mut diff_files = Vec::new();
    for (path, (before, after)) in files {
        if before
            .as_ref()
            .zip(after.as_ref())
            .is_some_and(|(left, right)| left.sha256 == right.sha256)
        {
            continue;
        }
        if diff_files.len() >= DIFF_MAX_FILES {
            break;
        }
        let relative = guard_relative_path(&path)?;
        let before_bytes = if before.is_some() {
            Some(fs::read(directory.join("files").join(&relative)).map_err(|error| {
                format!("A diff base-fájlja nem olvasható: {error}")
            })?)
        } else {
            None
        };
        let after_bytes = if after.is_some() {
            Some(fs::read(directory.join("post-files").join(&relative)).map_err(|error| {
                format!("A diff post-fájlja nem olvasható: {error}")
            })?)
        } else {
            None
        };
        let (lines, binary_or_truncated) =
            bounded_line_diff(before_bytes.as_deref(), after_bytes.as_deref());
        let status = match (&before, &after) {
            (Some(_), Some(_)) => "modified",
            (None, Some(_)) => "added",
            (Some(_), None) => "removed",
            (None, None) => continue,
        };
        diff_files.push(AgentDiffFile {
            path,
            status: status.to_string(),
            before_hash: before.map(|file| file.sha256),
            after_hash: after.map(|file| file.sha256),
            binary_or_truncated,
            lines,
        });
    }
    Ok(AgentDiffPreview {
        snapshot_id: snapshot_id.to_string(),
        root: root.to_string_lossy().to_string(),
        base_hash: manifest.base_hash,
        post_hash,
        current_hash,
        current_state: current_state.to_string(),
        created_at: manifest.created_at,
        last_action: manifest.last_action,
        last_action_at: manifest.last_action_at,
        files: diff_files,
    })
}

#[derive(Debug, Clone)]
struct LineEdit {
    start: usize,
    end: usize,
    replacement: Vec<String>,
}

fn single_line_edit(base: &[String], variant: &[String]) -> Option<LineEdit> {
    if base == variant {
        return None;
    }
    let mut start = 0_usize;
    while start < base.len() && start < variant.len() && base[start] == variant[start] {
        start += 1;
    }
    let mut base_end = base.len();
    let mut variant_end = variant.len();
    while base_end > start
        && variant_end > start
        && base[base_end - 1] == variant[variant_end - 1]
    {
        base_end -= 1;
        variant_end -= 1;
    }
    Some(LineEdit {
        start,
        end: base_end,
        replacement: variant[start..variant_end].to_vec(),
    })
}

fn line_edits_overlap(left: &LineEdit, right: &LineEdit) -> bool {
    if left.start == left.end && right.start == right.end {
        return left.start == right.start;
    }
    left.start < right.end && right.start < left.end
}

fn merge_three_way_text(base: &[u8], agent: &[u8], current: &[u8]) -> Result<Vec<u8>, String> {
    if current == base || agent == current {
        return Ok(agent.to_vec());
    }
    if agent == base {
        return Ok(current.to_vec());
    }
    if base.len() > DIFF_MAX_TEXT_BYTES
        || agent.len() > DIFF_MAX_TEXT_BYTES
        || current.len() > DIFF_MAX_TEXT_BYTES
    {
        return Err("túl nagy szövegfájl".to_string());
    }
    let base_text = std::str::from_utf8(base).map_err(|_| "bináris base-fájl".to_string())?;
    let agent_text = std::str::from_utf8(agent).map_err(|_| "bináris agent-fájl".to_string())?;
    let current_text =
        std::str::from_utf8(current).map_err(|_| "bináris aktuális fájl".to_string())?;
    let base_lines = base_text.lines().map(str::to_string).collect::<Vec<_>>();
    let agent_lines = agent_text.lines().map(str::to_string).collect::<Vec<_>>();
    let current_lines = current_text.lines().map(str::to_string).collect::<Vec<_>>();
    let agent_edit = single_line_edit(&base_lines, &agent_lines)
        .ok_or_else(|| "az agent-változás üres".to_string())?;
    let current_edit = single_line_edit(&base_lines, &current_lines)
        .ok_or_else(|| "az aktuális változás üres".to_string())?;
    if line_edits_overlap(&agent_edit, &current_edit) {
        if agent_edit.start == current_edit.start
            && agent_edit.end == current_edit.end
            && agent_edit.replacement == current_edit.replacement
        {
            return Ok(agent.to_vec());
        }
        return Err(format!(
            "átfedő sorváltozás (base {}..{})",
            agent_edit.start + 1,
            agent_edit.end.max(agent_edit.start) + 1
        ));
    }
    let mut edits = vec![agent_edit, current_edit];
    edits.sort_by_key(|edit| (edit.start, edit.end));
    let mut merged = Vec::new();
    let mut cursor = 0_usize;
    for edit in edits {
        merged.extend_from_slice(&base_lines[cursor..edit.start]);
        merged.extend(edit.replacement);
        cursor = edit.end;
    }
    merged.extend_from_slice(&base_lines[cursor..]);
    let trailing_newline = if agent_text.ends_with('\n') && !base_text.ends_with('\n') {
        true
    } else if current_text.ends_with('\n') && !base_text.ends_with('\n') {
        true
    } else {
        base_text.ends_with('\n')
    };
    let mut bytes = merged.join("\n").into_bytes();
    if trailing_newline && !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    Ok(bytes)
}

fn guard_file_from_bytes(relative_path: &str, bytes: &[u8]) -> GuardFile {
    GuardFile {
        relative_path: relative_path.to_string(),
        bytes: bytes.len() as u64,
        sha256: sha256_hex(bytes),
    }
}

fn write_snapshot_bytes(
    directory: &Path,
    folder: &str,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), String> {
    let temporary = directory.join(format!(".{folder}.tmp-{}", Uuid::new_v4()));
    fs::create_dir_all(&temporary)
        .map_err(|error| format!("A snapshot ideiglenes mappája nem hozható létre: {error}"))?;
    let write_result = (|| {
        for (path, bytes) in files {
            let target = temporary.join(guard_relative_path(path)?);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("A snapshot diff almappája nem hozható létre: {error}")
                })?;
            }
            fs::write(&target, bytes)
                .map_err(|error| format!("A snapshot diff fájlja nem írható: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&temporary);
        return Err(error);
    }
    let target = directory.join(folder);
    if target.exists() {
        fs::remove_dir_all(&target)
            .map_err(|error| format!("A régi snapshot diff nem cserélhető: {error}"))?;
    }
    fs::rename(&temporary, &target)
        .map_err(|error| format!("Az új snapshot diff nem cserélhető: {error}"))
}

fn rebase_agent_snapshot_at(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<AgentRebaseResult, String> {
    let (directory, mut manifest) = read_guard_manifest(snapshot_root, snapshot_id)?;
    let root = validate_guard_root(&manifest, allowed_root)?;
    if matches!(manifest.last_action.as_deref(), Some("discarded") | Some("rolled_back")) {
        return Err("Ehhez a snapshothoz nincs pending 3-way merge.".to_string());
    }
    let post_files = manifest
        .post_files
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs lezárt post-manifest.".to_string())?;
    let current_files = collect_guard_files(&root)?;
    let current_hash = guard_manifest_hash(&current_files)?;
    let expected_apply_hash = manifest
        .apply_base_hash
        .as_deref()
        .unwrap_or(&manifest.base_hash);
    if current_hash == expected_apply_hash {
        return Err("A workspace már a staging base-állapotban van; nincs szükség 3-way merge-re.".to_string());
    }
    if current_hash == manifest.post_hash.clone().unwrap_or_default() {
        return Err("A post-state már alkalmazva van; 3-way merge nem szükséges.".to_string());
    }

    let base_map = manifest
        .base_files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect::<BTreeMap<_, _>>();
    let post_map = post_files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect::<BTreeMap<_, _>>();
    let current_map = current_files
        .iter()
        .map(|file| (file.relative_path.clone(), file.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut merged_bytes = BTreeMap::<String, Vec<u8>>::new();
    for file in &current_files {
        merged_bytes.insert(
            file.relative_path.clone(),
            fs::read(root.join(guard_relative_path(&file.relative_path)?))
                .map_err(|error| format!("Az aktuális merge-fájl nem olvasható: {error}"))?,
        );
    }
    let mut paths = base_map.keys().cloned().collect::<std::collections::BTreeSet<_>>();
    paths.extend(post_map.keys().cloned());
    let mut conflicts = Vec::new();
    for path in paths {
        let base = base_map.get(&path);
        let agent = post_map.get(&path);
        let current = current_map.get(&path);
        let base_bytes = if base.is_some() {
            Some(fs::read(directory.join("files").join(guard_relative_path(&path)?)).map_err(
                |error| format!("A merge base-fájlja nem olvasható: {error}"),
            )?)
        } else {
            None
        };
        let agent_bytes = if agent.is_some() {
            Some(fs::read(directory.join("post-files").join(guard_relative_path(&path)?)).map_err(
                |error| format!("A merge agent-fájlja nem olvasható: {error}"),
            )?)
        } else {
            None
        };
        let current_bytes = current
            .map(|_| merged_bytes.get(&path).cloned().unwrap_or_default());
        let merged = match (base_bytes.as_deref(), agent_bytes.as_deref(), current_bytes.as_deref()) {
            (Some(base), Some(agent), Some(current)) => {
                merge_three_way_text(base, agent, current).map(Some)
            }
            (Some(base), Some(agent), None) if base == agent => Ok(None),
            (Some(_), Some(_), None) => Err("az aktuális fájl törölve, miközben az agent írta".to_string()),
            (Some(base), None, Some(current)) if base == current => Ok(None),
            (Some(_), None, Some(_)) => Err("az agent törölte, miközben az aktuális fájl is módosult".to_string()),
            (Some(_), None, None) => Ok(None),
            (None, Some(agent), None) => Ok(Some(agent.to_vec())),
            (None, Some(agent), Some(current)) if agent == current => Ok(Some(current.to_vec())),
            (None, Some(_), Some(_)) => Err("az agent új fájlja ütközik egy aktuális fájllal".to_string()),
            (None, None, _) => Ok(None),
        };
        match merged {
            Ok(Some(bytes)) => {
                merged_bytes.insert(path, bytes);
            }
            Ok(None) => {
                merged_bytes.remove(&path);
            }
            Err(reason) => conflicts.push(format!("{path}: {reason}")),
        }
    }
    if !conflicts.is_empty() {
        return Err(format!(
            "3-way merge konfliktus ({} fájl): {}",
            conflicts.len(),
            conflicts.join("; ")
        ));
    }
    let merged_files = merged_bytes
        .iter()
        .map(|(path, bytes)| guard_file_from_bytes(path, bytes))
        .collect::<Vec<_>>();
    let merged_hash = guard_manifest_hash(&merged_files)?;
    copy_guard_files(&root, &current_files, &directory.join("apply-base-files"))?;
    write_snapshot_bytes(&directory, "post-files", &merged_bytes)?;
    manifest.apply_base_hash = Some(current_hash.clone());
    manifest.apply_base_files = Some(current_files);
    manifest.post_hash = Some(merged_hash.clone());
    manifest.post_files = Some(merged_files.clone());
    manifest.rebased = true;
    manifest.applied = false;
    set_manifest_action(&mut manifest, "rebased");
    write_guard_manifest(&directory, &manifest)?;
    Ok(AgentRebaseResult {
        snapshot_id: snapshot_id.to_string(),
        root: root.to_string_lossy().to_string(),
        original_base_hash: manifest.base_hash,
        apply_base_hash: current_hash,
        merged_hash,
        merged_files: merged_files.len(),
        rebased: true,
    })
}

fn restore_snapshot_base_preserving_manifest(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<bool, String> {
    let (directory, manifest) = read_guard_manifest(snapshot_root, snapshot_id)?;
    let root = validate_guard_root(&manifest, allowed_root)?;
    let current_files = collect_guard_files(&root)?;
    let current_hash = guard_manifest_hash(&current_files)?;
    if current_hash == manifest.base_hash {
        return Ok(false);
    }
    let expected_post_hash = manifest
        .post_hash
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs post-hash.".to_string())?;
    if current_hash != expected_post_hash {
        return Err("A projekt a snapshot lezárása óta megváltozott; az automatikus visszaállítás blokkolva.".to_string());
    }
    restore_snapshot_base_files(&root, &directory, &manifest, &current_files)?;
    let resulting_files = collect_guard_files(&root)?;
    let resulting_hash = guard_manifest_hash(&resulting_files)?;
    if resulting_hash != manifest.base_hash {
        return Err("Az agent-változás staging utáni base-hash nem egyezik; további írás blokkolva.".to_string());
    }
    Ok(true)
}

fn apply_agent_snapshot_at(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<AgentApplyResult, String> {
    let (directory, mut manifest) = read_guard_manifest(snapshot_root, snapshot_id)?;
    let root = validate_guard_root(&manifest, allowed_root)?;
    if matches!(manifest.last_action.as_deref(), Some("discarded") | Some("rolled_back")) {
        return Err("Ehhez a snapshothoz nincs pending apply.".to_string());
    }
    let post_files = manifest
        .post_files
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs lezárt post-manifest.".to_string())?;
    let expected_post_hash = manifest
        .post_hash
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs post-hash.".to_string())?
        .to_string();
    let expected_apply_hash = manifest
        .apply_base_hash
        .as_deref()
        .unwrap_or(&manifest.base_hash);
    let current_files = collect_guard_files(&root)?;
    let current_hash = guard_manifest_hash(&current_files)?;
    if current_hash != expected_apply_hash {
        return Err("A workspace nem a staging base-állapotban van; az apply blokkolva.".to_string());
    }
    let post_paths = post_files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<std::collections::HashSet<_>>();
    let apply_result = (|| {
        let mut applied_files = 0_usize;
        for file in post_files {
            let source = directory
                .join("post-files")
                .join(guard_relative_path(&file.relative_path)?);
            let target = safe_guard_target(&root, &file.relative_path)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Az apply almappája nem hozható létre: {error}"))?;
            }
            fs::copy(&source, &target)
                .map_err(|error| format!("Az apply fájlja nem írható: {error}"))?;
            applied_files += 1;
        }
        let mut removed_files = 0_usize;
        for file in &current_files {
            if post_paths.contains(file.relative_path.as_str()) {
                continue;
            }
            let target = safe_guard_target(&root, &file.relative_path)?;
            fs::remove_file(&target)
                .map_err(|error| format!("Az apply törölt fájlja nem távolítható el: {error}"))?;
            removed_files += 1;
        }
        let resulting_files = collect_guard_files(&root)?;
        let resulting_hash = guard_manifest_hash(&resulting_files)?;
        if resulting_hash != expected_post_hash {
            return Err("Az apply utáni post-hash nem egyezik; az apply blokkolva.".to_string());
        }
        Ok((applied_files, removed_files, resulting_hash))
    })();
    let (applied_files, removed_files, resulting_hash) = match apply_result {
        Ok(value) => value,
        Err(error) => {
            let rollback_attempt = collect_guard_files(&root).and_then(|files| {
                if manifest.rebased {
                    let apply_base_files = manifest
                        .apply_base_files
                        .as_deref()
                        .ok_or_else(|| "A 3-way apply base-manifestje hiányzik.".to_string())?;
                    restore_guard_file_set(
                        &root,
                        &directory,
                        "apply-base-files",
                        apply_base_files,
                        &files,
                    )
                } else {
                    restore_snapshot_base_files(&root, &directory, &manifest, &files)
                }
            });
            return match rollback_attempt {
                Ok(_) => Err(format!("{error} Az apply részleges írásait visszaállítottam.")),
                Err(rollback_error) => Err(format!(
                    "{error} Az apply részleges írásainak visszaállítása is sikertelen: {rollback_error}."
                )),
            };
        }
    };
    manifest.applied = true;
    set_manifest_action(&mut manifest, "applied");
    write_guard_manifest(&directory, &manifest)?;
    Ok(AgentApplyResult {
        snapshot_id: snapshot_id.to_string(),
        root: root.to_string_lossy().to_string(),
        applied_files,
        removed_files,
        base_hash: manifest.base_hash,
        resulting_hash,
        rollback_available: !manifest.rebased,
    })
}

fn discard_agent_snapshot_at(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<AgentDiscardResult, String> {
    let (directory, manifest) = read_guard_manifest(snapshot_root, snapshot_id)?;
    let root = validate_guard_root(&manifest, allowed_root)?;
    if matches!(manifest.last_action.as_deref(), Some("discarded") | Some("rolled_back")) {
        return Err("A staged snapshot már lezárt állapotban van.".to_string());
    }
    let expected_apply_hash = manifest
        .apply_base_hash
        .as_deref()
        .unwrap_or(&manifest.base_hash);
    let current_files = collect_guard_files(&root)?;
    let resulting_hash = guard_manifest_hash(&current_files)?;
    if resulting_hash != expected_apply_hash {
        return Err("A workspace közben megváltozott; a staged snapshot elvetése blokkolva.".to_string());
    }
    let mut manifest = manifest;
    set_manifest_action(&mut manifest, "discarded");
    write_guard_manifest(&directory, &manifest)?;
    Ok(AgentDiscardResult {
        snapshot_id: snapshot_id.to_string(),
        root: root.to_string_lossy().to_string(),
        base_hash: manifest.base_hash,
        resulting_hash,
    })
}

fn rollback_agent_snapshot_at(
    snapshot_root: &Path,
    snapshot_id: &str,
    allowed_root: Option<&Path>,
) -> Result<AgentRollbackResult, String> {
    Uuid::parse_str(snapshot_id)
        .map_err(|_| "Az agent snapshot azonosítója nem UUID.".to_string())?;
    let directory = snapshot_root.join(snapshot_id);
    let manifest_path = directory.join("manifest.json");
    let bytes = fs::read(&manifest_path)
        .map_err(|error| format!("Az agent snapshot manifestje nem olvasható: {error}"))?;
    let mut manifest: GuardManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Az agent snapshot manifestje hibás: {error}"))?;
    if manifest.rebased {
        return Err("3-way apply után a teljes rollback nem biztonságos, mert külső változás is része lett a workspace-nek.".to_string());
    }
    let root = PathBuf::from(&manifest.root)
        .canonicalize()
        .map_err(|error| format!("Az agent rollback gyökere nem érhető el: {error}"))?;
    if let Some(allowed_root) = allowed_root {
        let allowed_root = allowed_root
            .canonicalize()
            .map_err(|error| format!("A projektek gyökere nem canonicalizálható: {error}"))?;
        if !root.starts_with(&allowed_root) {
            return Err("Az agent rollback gyökere a projektek gyökerén kívülre mutat.".to_string());
        }
    }
    if manifest.post_files.is_none() {
        return Err("Az agent snapshothoz nincs lezárt post-manifest.".to_string());
    }
    let expected_post_hash = manifest
        .post_hash
        .as_deref()
        .ok_or_else(|| "Az agent snapshothoz nincs post-hash.".to_string())?;
    let current_files = collect_guard_files(&root)?;
    let current_hash = guard_manifest_hash(&current_files)?;
    if current_hash != expected_post_hash {
        return Err("A projekt a snapshot lezárása óta megváltozott; rollback blokkolva, hogy ne írjon felül új munkát.".to_string());
    }
    let base_paths = manifest
        .base_files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut restored_files = 0_usize;
    for file in &manifest.base_files {
        let relative = guard_relative_path(&file.relative_path)?;
        let source = directory.join("files").join(&relative);
        let target = root.join(&relative);
        if let Ok(file_type) = fs::symlink_metadata(&target).map(|metadata| metadata.file_type()) {
            if file_type.is_symlink() {
                return Err(format!("A rollback célja symlink, ezért blokkolva: {}", target.display()));
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("A rollback almappája nem hozható létre: {error}"))?;
        }
        fs::copy(&source, &target)
            .map_err(|error| format!("A rollback fájlja nem állítható vissza: {error}"))?;
        restored_files += 1;
    }
    let mut removed_files = 0_usize;
    for file in &current_files {
        if base_paths.contains(file.relative_path.as_str()) {
            continue;
        }
        let relative = guard_relative_path(&file.relative_path)?;
        let target = root.join(relative);
        fs::remove_file(&target)
            .map_err(|error| format!("A rollback új fájlja nem távolítható el: {error}"))?;
        removed_files += 1;
    }
    let resulting_files = collect_guard_files(&root)?;
    let resulting_hash = guard_manifest_hash(&resulting_files)?;
    if resulting_hash != manifest.base_hash {
        return Err("A rollback után a base-hash nem egyezik; további írás blokkolva.".to_string());
    }
    manifest.post_hash = Some(resulting_hash.clone());
    manifest.post_files = Some(resulting_files);
    manifest.applied = false;
    set_manifest_action(&mut manifest, "rolled_back");
    write_guard_manifest(&directory, &manifest)?;
    Ok(AgentRollbackResult {
        snapshot_id: snapshot_id.to_string(),
        root: root.to_string_lossy().to_string(),
        restored_files,
        removed_files,
        base_hash: manifest.base_hash,
        resulting_hash,
    })
}

pub fn rollback_agent_snapshot(snapshot_id: &str) -> Result<AgentRollbackResult, String> {
    let snapshot_root = agent_snapshot_root()?;
    let allowed_root = require_projects_root()?;
    rollback_agent_snapshot_at(&snapshot_root, snapshot_id, Some(&allowed_root))
}

pub fn apply_agent_snapshot(snapshot_id: &str) -> Result<AgentApplyResult, String> {
    let snapshot_root = agent_snapshot_root()?;
    let allowed_root = require_projects_root()?;
    apply_agent_snapshot_at(&snapshot_root, snapshot_id, Some(&allowed_root))
}

pub fn discard_agent_snapshot(snapshot_id: &str) -> Result<AgentDiscardResult, String> {
    let snapshot_root = agent_snapshot_root()?;
    let allowed_root = require_projects_root()?;
    discard_agent_snapshot_at(&snapshot_root, snapshot_id, Some(&allowed_root))
}

pub fn preview_agent_snapshot(snapshot_id: &str) -> Result<AgentDiffPreview, String> {
    let snapshot_root = agent_snapshot_root()?;
    let allowed_root = require_projects_root()?;
    agent_diff_preview_at(&snapshot_root, snapshot_id, Some(&allowed_root))
}

pub fn rebase_agent_snapshot(snapshot_id: &str) -> Result<AgentRebaseResult, String> {
    let snapshot_root = agent_snapshot_root()?;
    let allowed_root = require_projects_root()?;
    rebase_agent_snapshot_at(&snapshot_root, snapshot_id, Some(&allowed_root))
}

fn send_json(stdin: &mut ChildStdin, value: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, &value).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
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

fn approval_request(value: &Value) -> Option<CodexApprovalRequest> {
    let method = value.get("method")?.as_str()?;
    let kind = match method {
        "item/commandExecution/requestApproval" => "command",
        "item/fileChange/requestApproval" => "fileChange",
        _ => return None,
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .or_else(|| params.get("item").and_then(|item| item.get("id")).and_then(Value::as_str))
        .map(str::to_string);
    Some(CodexApprovalRequest {
        approval_id: Uuid::new_v4().to_string(),
        request_id: value.get("id").cloned().unwrap_or(Value::Null),
        kind: kind.to_string(),
        thread_id: params.get("threadId").and_then(Value::as_str).map(str::to_string),
        turn_id: params.get("turnId").and_then(Value::as_str).map(str::to_string),
        item_id,
        reason: params.get("reason").and_then(Value::as_str).map(str::to_string),
        command: params.get("command").and_then(|command| match command {
            Value::String(value) => Some(value.clone()),
            Value::Null => None,
            value => Some(value.to_string()),
        }),
        cwd: params.get("cwd").and_then(Value::as_str).map(str::to_string),
        params,
    })
}

fn wait_for_approval(
    pending: &Arc<PendingApproval>,
    cancellation: &AtomicBool,
) -> Result<String, String> {
    let deadline = Instant::now() + APPROVAL_WAIT_TIMEOUT;
    let mut decision = pending
        .decision
        .lock()
        .map_err(|_| "Az approval-kérés állapota zárolva maradt.".to_string())?;
    loop {
        if let Some(value) = decision.clone() {
            return Ok(value);
        }
        if cancellation.load(Ordering::Relaxed) {
            return Ok("cancel".to_string());
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok("decline".to_string());
        }
        let wait_for = (deadline - now).min(Duration::from_millis(250));
        let (next, _) = pending
            .resolved
            .wait_timeout(decision, wait_for)
            .map_err(|_| "Az approval-kérés állapota zárolva maradt.".to_string())?;
        decision = next;
    }
}

fn handle_server_request(
    app: &tauri::AppHandle,
    stdin: &mut ChildStdin,
    value: &Value,
    cancellation: &Arc<AtomicBool>,
) -> Result<(), String> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let request = approval_request(value).ok_or_else(|| {
        format!(
            "A Codex app-server nem támogatott szerver-kérést küldött: {method}."
        )
    })?;
    let approval_id = request.approval_id.clone();
    let pending = Arc::new(PendingApproval {
        decision: Mutex::new(None),
        resolved: Condvar::new(),
    });
    pending_approvals()
        .lock()
        .map_err(|_| "Az approval-kérések állapota zárolva maradt.".to_string())?
        .insert(approval_id.clone(), pending.clone());

    let emitted = emit_main_window(app, "codex-approval-request", &request);
    let decision = if emitted.is_ok() {
        wait_for_approval(&pending, cancellation)
    } else {
        Err(emitted.err().unwrap_or_else(|| "Az approval-kérés nem jeleníthető meg.".to_string()))
    };
    pending_approvals()
        .lock()
        .map_err(|_| "Az approval-kérések állapota zárolva maradt.".to_string())?
        .remove(&approval_id);
    let decision = decision?;
    send_json(
        stdin,
        json!({
            "id": request.request_id,
            "result": { "decision": decision }
        }),
    )
}

fn read_response(reader: &mut BufReader<ChildStdout>, id: u64) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("A Codex app-server lezárta a kapcsolatot.".to_string());
        }
        let value: Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("Érvénytelen Codex JSON: {error}"))?;
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = value.get("error") {
                return Err(format!("Codex app-server hiba: {error}"));
            }
            return Ok(value);
        }
    }
}

fn is_missing_rollout_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("no rollout found") || normalized.contains("rollout not found")
}

const MAX_REHYDRATION_CONTEXT_CHARS: usize = 24_000;

fn truncate_context(context: &str) -> String {
    let mut chars = context.chars();
    let truncated = chars
        .by_ref()
        .take(MAX_REHYDRATION_CONTEXT_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}\n[conversation context truncated]")
    } else {
        truncated
    }
}

fn prompt_for_rehydrated_thread(context: Option<&str>, prompt: &str) -> String {
    let context = context.map(str::trim).filter(|value| !value.is_empty());
    match context {
        Some(context) => format!(
            concat!(
                "The following is the existing conversation transcript from another device. ",
                "Use it as context and continue the conversation naturally. The current user ",
                "message is at the end.\n\n--- existing transcript ---\n{}\n",
                "--- end transcript ---\n\nCurrent user message:\n{}"
            ),
            truncate_context(context),
            prompt
        ),
        None => prompt.to_string(),
    }
}

fn terminate(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let mut command = Command::new("taskkill.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(not(windows))]
fn kill_process_tree(_pid: u32) {}

fn spawn_app_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let cwd = workspace_cwd();
    let binary = codex_binary(app)?;
    let mut command = Command::new(&binary);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .args(["app-server", "--stdio"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Nem indÃ­thatÃ³ a Codex app-server ({:?}): {error}", binary))
}

fn initialize_app_server(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
) -> Result<(), String> {
    send_json(
        stdin,
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": { "name": "min", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )?;
    read_response(reader, 1)?;
    send_json(stdin, json!({ "method": "initialized", "params": {} }))
}

fn stage_agent_snapshot(
    snapshot: &AgentSnapshot,
    mut report: AgentGuardReport,
) -> Result<AgentGuardReport, String> {
    let snapshot_root = snapshot
        .directory
        .parent()
        .ok_or_else(|| "Az agent snapshot gyökere nem határozható meg.".to_string())?;
    let allowed_root = require_projects_root()?;
    restore_snapshot_base_preserving_manifest(
        snapshot_root,
        &snapshot.id,
        Some(&allowed_root),
    )?;
    report.rollback_available = false;
    report.apply_available = !report.changed_files.is_empty()
        || !report.added_files.is_empty()
        || !report.removed_files.is_empty();
    Ok(report)
}

pub fn send(
    app: tauri::AppHandle,
    request: CodexRequest,
    cancellation: Arc<AtomicBool>,
) -> Result<CodexResponse, String> {
    if cancellation.load(Ordering::Relaxed) {
        return Err("A Codex-kérés megszakítva.".to_string());
    }
    let cwd = requested_cwd(request.cwd.as_deref())?;
    let guard_snapshot = create_agent_snapshot(&cwd)?;
    let execution = prepare_agent_execution(&cwd);
    let execution_cwd_string = execution.cwd.to_string_lossy().to_string();
    let binary = match codex_binary(&app) {
        Ok(binary) => binary,
        Err(error) => {
            cleanup_git_shadow(execution.git_shadow.as_ref());
            return Err(error);
        }
    };
    let mut command = Command::new(&binary);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = match command
        .args(["app-server", "--stdio"])
        .current_dir(&execution.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            cleanup_git_shadow(execution.git_shadow.as_ref());
            return Err(format!(
                "Nem indítható a Codex app-server ({:?}): {error}",
                binary
            ));
        }
    };

    if let Some(request_id) = request.request_id.as_deref() {
        attach_child_pid(request_id, child.id());
    }

    let result = (|| {
        if cancellation.load(Ordering::Relaxed) {
            return Err("A Codex-kérés megszakítva.".to_string());
        }
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "A Codex stdin nem érhető el.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "A Codex stdout nem érhető el.".to_string())?;
        let mut reader = BufReader::new(stdout);

        send_json(
            &mut stdin,
            json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "min", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }
            }),
        )?;
        read_response(&mut reader, 1)?;
        send_json(&mut stdin, json!({ "method": "initialized", "params": {} }))?;

        let start_params = json!({
            "cwd": execution_cwd_string,
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandbox": "workspace-write",
            "serviceName": "min"
        });
        let mut thread_rehydrated = false;
        let (thread_response, turn_request_id) = if let Some(thread_id) = request.thread_id.clone() {
            let resume_params = json!({
                "threadId": thread_id,
                "cwd": execution_cwd_string,
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandbox": "workspace-write"
            });
            send_json(
                &mut stdin,
                json!({ "id": 2, "method": "thread/resume", "params": resume_params }),
            )?;
            match read_response(&mut reader, 2) {
                Ok(response) => (response, 3),
                Err(error) if is_missing_rollout_error(&error) => {
                    thread_rehydrated = true;
                    send_json(
                        &mut stdin,
                        json!({ "id": 3, "method": "thread/start", "params": start_params }),
                    )?;
                    (read_response(&mut reader, 3)?, 4)
                }
                Err(error) => return Err(error),
            }
        } else {
            send_json(
                &mut stdin,
                json!({ "id": 2, "method": "thread/start", "params": start_params }),
            )?;
            (read_response(&mut reader, 2)?, 3)
        };
        let thread_id = thread_response["result"]["thread"]["id"]
            .as_str()
            .ok_or_else(|| "A Codex nem adott vissza thread azonosítót.".to_string())?
            .to_string();

        let prompt = if thread_rehydrated {
            prompt_for_rehydrated_thread(request.conversation_context.as_deref(), &request.prompt)
        } else {
            request.prompt.clone()
        };
        let mut turn_params = json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": prompt }]
        });
        if let Some(model) = request.model.as_deref() {
            turn_params["model"] = Value::String(model.to_string());
        }
        if let Some(effort) = request.effort.as_deref() {
            turn_params["effort"] = Value::String(effort.to_string());
        }

        send_json(
            &mut stdin,
            json!({
                "id": turn_request_id,
                "method": "turn/start",
                "params": turn_params
            }),
        )?;
        if cancellation.load(Ordering::Relaxed) {
            return Err("A Codex-kérés megszakítva.".to_string());
        }
        read_response(&mut reader, turn_request_id)?;

        let mut final_text = String::new();
        let mut events = Vec::new();
        let mut line = String::new();
        loop {
            if cancellation.load(Ordering::Relaxed) {
                return Err("A Codex-kérés megszakítva.".to_string());
            }
            line.clear();
            let read = reader
                .read_line(&mut line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            let value: Value = serde_json::from_str(line.trim())
                .map_err(|error| format!("Érvénytelen Codex esemény: {error}"))?;
            let method = value
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !method.is_empty() {
                let event = CodexEvent {
                    thread_id: thread_id.clone(),
                    event_type: method.to_string(),
                    payload: value.get("params").cloned().unwrap_or(Value::Null),
                };
                emit_main_window(&app, "codex-event", &event)?;
                events.push(event);
            }
            if !method.is_empty() && value.get("id").is_some() {
                handle_server_request(&app, &mut stdin, &value, &cancellation)?;
                continue;
            }
            if method == "item/agentMessage/delta" {
                if let Some(delta) = value["params"]["delta"].as_str() {
                    final_text.push_str(delta);
                    let item_id = value["params"]["itemId"]
                        .as_str()
                        .or_else(|| value["params"]["item"]["id"].as_str())
                        .map(str::to_string);
                    emit_main_window(
                        &app,
                        "codex-delta",
                        &CodexDelta {
                            thread_id: thread_id.clone(),
                            delta: delta.to_string(),
                            item_id,
                        },
                    )?;
                }
            } else if method == "item/completed"
                && value["params"]["item"]["type"].as_str() == Some("agentMessage")
            {
                if let Some(text) = value["params"]["item"]["text"].as_str() {
                    final_text = text.to_string();
                }
            } else if method == "turn/completed" {
                break;
            }
        }

        Ok(CodexResponse {
            thread_id,
            text: final_text,
            events,
            guard: guard_report(&guard_snapshot, None),
            thread_rehydrated,
        })
    })();

    terminate(child);
    let guard_result = if execution.git_shadow.is_some() {
        finalize_agent_snapshot_from_root(&guard_snapshot, &execution.cwd)
    } else {
        finalize_agent_snapshot(&guard_snapshot)
    };
    cleanup_git_shadow(execution.git_shadow.as_ref());
    match (result, guard_result) {
        (Ok(mut response), Ok(report)) if !cancellation.load(Ordering::Relaxed) => {
            let mut report = stage_agent_snapshot(&guard_snapshot, report).map_err(|error| {
                format!(
                    "A Codex-válasz stagingje sikertelen: {error}. A snapshot azonosítója: {}.",
                    guard_snapshot.id
                )
            })?;
            report.isolation_mode = if execution.git_shadow.is_some() {
                "gitWorktree".to_string()
            } else {
                "nonGitSnapshot".to_string()
            };
            response.guard = report;
            Ok(response)
        }
        (Ok(_), Ok(report)) => {
            let error = "A Codex-kérés megszakítva.".to_string();
            let restore = stage_agent_snapshot(&guard_snapshot, report);
            match restore {
                Ok(_) => Err(format!(
                    "{error} A részleges agent-változásokat elvetettem; a snapshot megmaradt: {}.",
                    guard_snapshot.directory.display()
                )),
                Err(restore_error) => Err(format!(
                    "{error} A részleges változások automatikus elvetése sikertelen: {restore_error}. A snapshot azonosítója: {}.",
                    guard_snapshot.id
                )),
            }
        }
        (Err(error), Ok(report)) => {
            let restore = stage_agent_snapshot(&guard_snapshot, report);
            match restore {
                Ok(_) => Err(format!(
                    "{error} A részleges agent-változásokat elvetettem; a snapshot megmaradt: {}.",
                    guard_snapshot.directory.display()
                )),
                Err(restore_error) => Err(format!(
                    "{error} A részleges változások automatikus elvetése sikertelen: {restore_error}. A snapshot azonosítója: {}.",
                    guard_snapshot.id
                )),
            }
        }
        (Ok(_), Err(guard_error)) => Err(format!(
            "A Codex-válasz után a base-hash ellenőrzése sikertelen: {guard_error}. A rollback-pont azonosítója: {}.",
            guard_snapshot.id
        )),
        (Err(error), Err(guard_error)) => Err(format!(
            "{error} A base-hash ellenőrzése is sikertelen: {guard_error}. A rollback-pont azonosítója: {}.",
            guard_snapshot.id
        )),
    }
}

pub fn read_code_file(cwd: &str, path: &str) -> Result<Option<String>, String> {
    let root = requested_cwd(Some(cwd))?;
    let requested = PathBuf::from(path);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    if !candidate.exists() {
        return Ok(None);
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Nem olvasható a kódfájl: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err("A kódfájl a projektmappán kívülre mutat.".to_string());
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("Nem olvasható a kódfájl: {error}"))?;
    if !metadata.is_file() || metadata.len() > 2_000_000 {
        return Ok(None);
    }
    let bytes =
        std::fs::read(&canonical).map_err(|error| format!("Nem olvasható a kódfájl: {error}"))?;
    Ok(String::from_utf8(bytes).ok())
}

fn pick_directory(description: &str) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let description = description.replace('\'', "''");
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '__MIN_DIALOG_DESCRIPTION__'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
}
"#
        .replace("__MIN_DIALOG_DESCRIPTION__", &description);
        let mut command = Command::new("powershell.exe");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .output()
            .map_err(|error| format!("Nem nyitható meg a projektmappa-választó: {error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                "A projektmappa-választó hibával állt le.".to_string()
            } else {
                error
            });
        }
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if selected.is_empty() {
            return Ok(None);
        }
        let path = PathBuf::from(selected);
        if !path.is_dir() {
            return Err("A kiválasztott projektmappa nem található.".to_string());
        }
        return Ok(Some(
            path.canonicalize()
                .unwrap_or(path)
                .to_string_lossy()
                .to_string(),
        ));
    }

    #[cfg(not(windows))]
    {
        Err("A projektmappa-választó jelenleg Windowson érhető el.".to_string())
    }
}

pub fn pick_project_directory() -> Result<Option<String>, String> {
    pick_directory("Projektmappa kiválasztása")
}

pub fn pick_projects_root() -> Result<Option<String>, String> {
    pick_directory("A OneDrive 'my projects' gyökerének kiválasztása")
}

pub(crate) fn projects_root() -> PathBuf {
    resolved_projects_root().unwrap_or_default()
}

pub(crate) fn require_projects_root() -> Result<PathBuf, String> {
    let root = projects_root();
    if root.as_os_str().is_empty() {
        Err("Nincs beállítva használható projektek-gyökér; válaszd ki a OneDrive my projects mappát.".to_string())
    } else {
        Ok(root)
    }
}

fn sync_state_path() -> Result<PathBuf, String> {
    Ok(require_projects_root()?
        .join(".min-sync")
        .join("state.json"))
}

fn legacy_sync_state_path() -> PathBuf {
    workspace_cwd().join(".min-sync").join("state.json")
}

pub(crate) fn sync_state_paths() -> Vec<PathBuf> {
    let Ok(canonical) = sync_state_path() else {
        return Vec::new();
    };
    let legacy = legacy_sync_state_path();
    [canonical.clone(), legacy]
        .into_iter()
        .filter(|path| path != &canonical || path.is_file())
        .filter(|path| path.exists())
        .collect()
}

fn sync_write_path() -> Result<PathBuf, String> {
    let canonical = sync_state_path()?;
    let legacy = legacy_sync_state_path();
    if !canonical.exists() && legacy != canonical && legacy.exists() {
        return Err(
            "Legacy szinkronállapot található, de a canonical állapot hiányzik; explicit migráció nélkül nincs távoli írás."
                .to_string(),
        );
    }
    Ok(canonical)
}

const SYNC_SCHEMA_VERSION: i64 = 1;

fn validate_sync_state(state: &Value, context: &str) -> Result<(), String> {
    let object = state
        .as_object()
        .ok_or_else(|| format!("{context}: objektumot vártam."))?;
    let schema_version = object
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{context}: hiányzó vagy hibás schemaVersion."))?;
    if schema_version != SYNC_SCHEMA_VERSION {
        return Err(format!(
            "{context}: nem támogatott schemaVersion ({schema_version}); az állapot karanténba került."
        ));
    }
    for field in ["deviceId", "updatedAt"] {
        let valid = object
            .get(field)
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        if !valid {
            return Err(format!("{context}: hiányzó vagy üres {field}."));
        }
    }
    if !object.get("projects").is_some_and(Value::is_array) {
        return Err(format!(
            "{context}: a projects mezőnek tömbnek kell lennie."
        ));
    }
    if !object.get("conversations").is_some_and(Value::is_object) {
        return Err(format!(
            "{context}: a conversations mezőnek objektumnak kell lennie."
        ));
    }
    Ok(())
}

fn validate_sync_write(existing: Option<&Value>, incoming: &Value) -> Result<(), String> {
    validate_sync_state(incoming, "Érvénytelen bejövő szinkronállapot")?;
    let Some(existing) = existing else {
        return Ok(());
    };
    validate_sync_state(
        existing,
        "A meglévő OneDrive-szinkron állapot nem biztonságos",
    )?;

    let existing_device = existing["deviceId"].as_str().unwrap_or_default();
    let incoming_device = incoming["deviceId"].as_str().unwrap_or_default();
    if existing_device != incoming_device {
        return Err(
            "A meglévő szinkronállapot másik eszközhöz tartozik; a fail-closed védelem nem írja felül."
                .to_string(),
        );
    }
    Ok(())
}

fn read_sync_state(path: &PathBuf) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("Nem olvasható a OneDrive-szinkron állapota: {error}"))?;
    let state = serde_json::from_str(&contents)
        .map_err(|error| format!("Sérült a OneDrive-szinkron állapota: {error}"))?;
    validate_sync_state(&state, "A OneDrive-szinkron állapota nem használható")?;
    Ok(Some(state))
}

pub fn sync_load() -> Result<Option<Value>, String> {
    let path = sync_state_path()?;
    if let Some(state) = read_sync_state(&path)? {
        return Ok(Some(state));
    }

    let legacy_path = legacy_sync_state_path();
    if legacy_path != path {
        return read_sync_state(&legacy_path);
    }
    Ok(None)
}

pub fn sync_save(state: Value) -> Result<(), String> {
    validate_sync_write(None, &state)?;
    let path = sync_write_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Nem határozható meg a szinkronmappa.".to_string())?;
    let existing = if path.exists() {
        let contents = std::fs::read_to_string(&path).map_err(|error| {
            format!("A meglévő OneDrive-szinkron állapot nem olvasható; nem írok rá: {error}")
        })?;
        let existing = serde_json::from_str::<Value>(&contents).map_err(|error| {
            format!("A meglévő OneDrive-szinkron állapot sérült; nem írok rá: {error}")
        })?;
        validate_sync_write(Some(&existing), &state)?;
        Some(existing)
    } else {
        None
    };
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Nem hozható létre a szinkronmappa: {error}"))?;

    let temporary = parent.join("state.json.tmp");
    let backup = parent.join("state.json.bak");
    let serialized = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Nem szerializálható a szinkronállapot: {error}"))?;
    std::fs::write(&temporary, serialized)
        .map_err(|error| format!("Nem írható a szinkronállapot: {error}"))?;
    if existing.is_some() {
        std::fs::copy(&path, &backup).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            format!("Nem készíthető biztonsági másolat a meglévő szinkronállapotról; az eredeti érintetlen maradt: {error}")
        })?;
        std::fs::remove_file(&path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            format!(
                "Nem cserélhető a meglévő szinkronállapot; az eredeti érintetlen maradt: {error}"
            )
        })?;
    }
    if let Err(error) = std::fs::rename(&temporary, &path) {
        if existing.is_some() && backup.exists() {
            let _ = std::fs::copy(&backup, &path);
        }
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Nem cserélhető atomikusan a szinkronállapot; visszaállítás megkísérelve: {error}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod sync_tests {
    use super::*;

    #[test]
    fn projects_root_resolution_is_independent_of_machine_absolute_path() {
        let pc_workspace = PathBuf::from(r"C:\Users\danis\OneDrive\my projects\my AI CLI app");
        let laptop_workspace = PathBuf::from(r"D:\Users\danis\OneDrive\my projects\my AI CLI app");

        assert_eq!(
            projects_root_from_workspace(&pc_workspace),
            PathBuf::from(r"C:\Users\danis\OneDrive\my projects")
        );
        assert_eq!(
            projects_root_from_workspace(&laptop_workspace),
            PathBuf::from(r"D:\Users\danis\OneDrive\my projects")
        );
    }

    #[test]
    fn projects_root_resolution_does_not_require_the_source_folder_name() {
        let pc_workspace = PathBuf::from(r"C:\Users\danis\OneDrive\my projects\midi");
        let laptop_workspace = PathBuf::from(r"D:\Work\OneDrive\my projects\python-tools");

        assert_eq!(
            projects_root_from_workspace(&pc_workspace),
            PathBuf::from(r"C:\Users\danis\OneDrive\my projects")
        );
        assert_eq!(
            projects_root_from_workspace(&laptop_workspace),
            PathBuf::from(r"D:\Work\OneDrive\my projects")
        );
    }

    #[test]
    fn missing_rollout_error_is_detected_for_cross_device_resume() {
        assert!(is_missing_rollout_error(
            "Codex app-server hiba: {\"code\":-32600,\"message\":\"no rollout found for thread id abc\"}"
        ));
        assert!(!is_missing_rollout_error("A Codex app-server lezárta a kapcsolatot."));
    }

    #[test]
    fn rehydrated_prompt_keeps_context_and_current_message() {
        let prompt = prompt_for_rehydrated_thread(Some("User:\nrégi kérdés"), "új kérdés");
        assert!(prompt.contains("régi kérdés"));
        assert!(prompt.contains("új kérdés"));
    }

    fn state(device_id: &str, updated_at: &str, message: &str) -> Value {
        json!({
            "schemaVersion": SYNC_SCHEMA_VERSION,
            "deviceId": device_id,
            "updatedAt": updated_at,
            "activeProjectId": null,
            "activeThread": null,
            "projects": [],
            "conversations": {
                "conversation": {
                    "messages": [{"role": "user", "text": message}]
                }
            }
        })
    }

    #[test]
    fn stale_last_writer_from_another_device_is_rejected_even_with_new_timestamp() {
        let existing = state("device-b", "2026-07-14T10:00:00Z", "B megtartandó üzenete");
        let incoming = state(
            "device-a",
            "2026-07-15T10:00:00Z",
            "A régi offline példánya",
        );

        let result = validate_sync_write(Some(&existing), &incoming);

        assert!(result.is_err());
        assert_eq!(
            existing["conversations"]["conversation"]["messages"][0]["text"],
            "B megtartandó üzenete"
        );
    }

    #[test]
    fn malformed_existing_state_is_rejected_before_write() {
        let existing = json!({"schemaVersion": SYNC_SCHEMA_VERSION, "projects": []});
        let incoming = state("device-a", "2026-07-15T10:00:00Z", "új adat");

        let result = validate_sync_write(Some(&existing), &incoming);

        assert!(result.is_err());
    }

    #[test]
    fn same_device_valid_state_can_still_update_during_phase_zero() {
        let existing = state("device-a", "2026-07-14T10:00:00Z", "régi adat");
        let incoming = state("device-a", "2026-07-15T10:00:00Z", "új adat");

        assert!(validate_sync_write(Some(&existing), &incoming).is_ok());
    }

    #[test]
    fn agent_cwd_outside_projects_root_is_rejected() {
        let outside = std::env::temp_dir().join(format!("min-agent-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).expect("outside cwd fixture");
        let outside_text = outside.to_string_lossy().to_string();
        let result = requested_cwd(Some(&outside_text));
        assert!(result.is_err());
        assert!(result
            .expect_err("outside cwd must be rejected")
            .contains("projektek gyökerén kívül"));
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn agent_snapshot_reports_changes_and_rolls_back_unchanged_post_state() {
        let root = std::env::temp_dir().join(format!("min-agent-root-{}", uuid::Uuid::new_v4()));
        let snapshot_root = std::env::temp_dir().join(format!("min-agent-snapshots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).expect("agent root fixture");
        std::fs::write(root.join("main.txt"), "before").expect("base file");
        std::fs::write(root.join("nested").join("keep.txt"), "keep").expect("nested base file");

        let snapshot = create_agent_snapshot_at(&root, &snapshot_root).expect("create agent snapshot");
        std::fs::write(root.join("main.txt"), "after").expect("changed file");
        std::fs::remove_file(root.join("nested").join("keep.txt")).expect("removed file");
        std::fs::write(root.join("new.txt"), "new").expect("added file");
        let report = finalize_agent_snapshot(&snapshot).expect("finalize agent snapshot");
        assert_eq!(report.changed_files, vec!["main.txt"]);
        assert_eq!(report.added_files, vec!["new.txt"]);
        assert_eq!(report.removed_files, vec!["nested/keep.txt"]);
        assert!(report.rollback_available);

        let rollback = rollback_agent_snapshot_at(&snapshot_root, &snapshot.id, None)
            .expect("rollback agent snapshot");
        assert_eq!(rollback.restored_files, 2);
        assert_eq!(rollback.removed_files, 1);
        assert_eq!(std::fs::read_to_string(root.join("main.txt")).expect("restored main"), "before");
        assert_eq!(
            std::fs::read_to_string(root.join("nested").join("keep.txt")).expect("restored nested"),
            "keep"
        );
        assert!(!root.join("new.txt").exists());

        std::fs::write(root.join("main.txt"), "new work").expect("post-rollback change");
        let blocked = rollback_agent_snapshot_at(&snapshot_root, &snapshot.id, None);
        assert!(blocked.is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(snapshot_root);
    }

    #[test]
    fn staged_snapshot_restores_base_and_applies_only_explicitly() {
        let root = std::env::temp_dir().join(format!("min-agent-stage-root-{}", uuid::Uuid::new_v4()));
        let snapshot_root = std::env::temp_dir().join(format!("min-agent-stage-snapshots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("stage root fixture");
        std::fs::write(root.join("main.txt"), "before").expect("stage base file");

        let snapshot = create_agent_snapshot_at(&root, &snapshot_root).expect("create staged snapshot");
        std::fs::write(root.join("main.txt"), "after").expect("stage changed file");
        std::fs::write(root.join("new.txt"), "new").expect("stage added file");
        let report = finalize_agent_snapshot(&snapshot).expect("finalize staged snapshot");
        assert!(report.apply_available == false);
        assert!(report.post_hash.is_some());

        restore_snapshot_base_preserving_manifest(&snapshot_root, &snapshot.id, None)
            .expect("restore staging base");
        assert_eq!(std::fs::read_to_string(root.join("main.txt")).expect("base after stage"), "before");
        assert!(!root.join("new.txt").exists());

        std::fs::write(root.join("external.txt"), "external").expect("external workspace change");
        assert!(apply_agent_snapshot_at(&snapshot_root, &snapshot.id, None).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("external.txt")).expect("external change survives"),
            "external"
        );
        std::fs::remove_file(root.join("external.txt")).expect("remove external change");

        let applied = apply_agent_snapshot_at(&snapshot_root, &snapshot.id, None)
            .expect("apply staged snapshot");
        assert_eq!(applied.applied_files, 2);
        assert_eq!(std::fs::read_to_string(root.join("main.txt")).expect("applied main"), "after");
        assert_eq!(std::fs::read_to_string(root.join("new.txt")).expect("applied new"), "new");

        let rollback = rollback_agent_snapshot_at(&snapshot_root, &snapshot.id, None)
            .expect("rollback applied snapshot");
        assert_eq!(rollback.resulting_hash, snapshot.manifest.base_hash);
        assert!(!root.join("new.txt").exists());

        let discard_snapshot = create_agent_snapshot_at(&root, &snapshot_root).expect("create discard snapshot");
        std::fs::write(root.join("main.txt"), "discarded").expect("discard changed file");
        finalize_agent_snapshot(&discard_snapshot).expect("finalize discard snapshot");
        restore_snapshot_base_preserving_manifest(&snapshot_root, &discard_snapshot.id, None)
            .expect("restore discard base");
        discard_agent_snapshot_at(&snapshot_root, &discard_snapshot.id, None)
            .expect("discard staged snapshot");
        assert!(discard_snapshot.directory.exists());
        let (_, discarded_manifest) =
            read_guard_manifest(&snapshot_root, &discard_snapshot.id).expect("discard audit");
        assert_eq!(discarded_manifest.last_action.as_deref(), Some("discarded"));

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(snapshot_root);
    }

    #[test]
    fn bounded_line_diff_exposes_added_and_removed_lines() {
        let (lines, truncated) = bounded_line_diff(Some(b"same\nold"), Some(b"same\nnew"));
        assert!(!truncated);
        assert!(lines.iter().any(|line| line.kind == "removed" && line.text == "old"));
        assert!(lines.iter().any(|line| line.kind == "added" && line.text == "new"));
    }

    #[test]
    fn three_way_merge_keeps_non_overlapping_changes_and_rejects_conflicts() {
        let merged = merge_three_way_text(b"a\nb\nc\n", b"a\nB\nc\n", b"A\nb\nc\n")
            .expect("non-overlapping merge");
        assert_eq!(merged, b"A\nB\nc\n");
        assert!(merge_three_way_text(b"a\nb\nc\n", b"a\nB\nc\n", b"a\nC\nc\n").is_err());
    }

    #[test]
    fn rebased_snapshot_preserves_external_change_and_disables_full_rollback() {
        let root = std::env::temp_dir().join(format!("min-agent-rebase-root-{}", uuid::Uuid::new_v4()));
        let snapshot_root = std::env::temp_dir().join(format!("min-agent-rebase-snapshots-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("rebase root fixture");
        std::fs::write(root.join("main.txt"), "a\nb\nc\n").expect("rebase base file");

        let snapshot = create_agent_snapshot_at(&root, &snapshot_root).expect("create rebase snapshot");
        std::fs::write(root.join("main.txt"), "a\nB\nc\n").expect("agent change");
        finalize_agent_snapshot(&snapshot).expect("finalize rebase snapshot");
        restore_snapshot_base_preserving_manifest(&snapshot_root, &snapshot.id, None)
            .expect("restore rebase base");
        std::fs::write(root.join("main.txt"), "A\nb\nc\n").expect("external change");

        let rebased = rebase_agent_snapshot_at(&snapshot_root, &snapshot.id, None)
            .expect("rebase snapshot");
        assert!(rebased.rebased);
        let applied = apply_agent_snapshot_at(&snapshot_root, &snapshot.id, None)
            .expect("apply rebased snapshot");
        assert!(!applied.rollback_available);
        assert_eq!(
            std::fs::read_to_string(root.join("main.txt")).expect("merged file"),
            "A\nB\nc\n"
        );
        assert!(rollback_agent_snapshot_at(&snapshot_root, &snapshot.id, None).is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(snapshot_root);
    }

    #[test]
    fn clean_git_repository_uses_shadow_and_dirty_repository_falls_back() {
        let root = std::env::temp_dir().join(format!("min-agent-git-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("git root fixture");
        std::fs::write(root.join("tracked.txt"), "before").expect("git tracked file");
        let initialized = run_git(&root, &["init", "--quiet"]);
        let Ok(initialized) = initialized else {
            let _ = std::fs::remove_dir_all(root);
            return;
        };
        if !initialized.status.success()
            || !run_git(&root, &["config", "user.email", "min@example.invalid"])
                .map(|output| output.status.success())
                .unwrap_or(false)
            || !run_git(&root, &["config", "user.name", "min-test"])
                .map(|output| output.status.success())
                .unwrap_or(false)
            || !run_git(&root, &["add", "tracked.txt"])
                .map(|output| output.status.success())
                .unwrap_or(false)
            || !run_git(&root, &["commit", "--quiet", "--no-gpg-sign", "-m", "fixture"])
                .map(|output| output.status.success())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir_all(root);
            return;
        }
        let clean_execution = prepare_agent_execution(&root);
        assert!(clean_execution.git_shadow.is_some());
        assert_eq!(
            std::fs::read_to_string(clean_execution.cwd.join("tracked.txt"))
                .expect("shadow tracked file"),
            "before"
        );
        cleanup_git_shadow(clean_execution.git_shadow.as_ref());

        std::fs::write(root.join("tracked.txt"), "dirty").expect("dirty git file");
        let dirty_execution = prepare_agent_execution(&root);
        assert!(dirty_execution.git_shadow.is_none());
        assert_eq!(dirty_execution.cwd, root);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn approval_response_accepts_only_supported_decisions() {
        assert!(valid_approval_decision("accept"));
        assert!(valid_approval_decision("acceptForSession"));
        assert!(valid_approval_decision("decline"));
        assert!(valid_approval_decision("cancel"));
        assert!(!valid_approval_decision("acceptAlways"));
    }

    #[test]
    fn approval_response_resolves_pending_request() {
        let approval_id = uuid::Uuid::new_v4().to_string();
        let pending = Arc::new(PendingApproval {
            decision: Mutex::new(None),
            resolved: Condvar::new(),
        });
        pending_approvals()
            .lock()
            .expect("approval registry")
            .insert(approval_id.clone(), pending.clone());

        respond_approval(&approval_id, "accept").expect("approval response");
        let decision = pending
            .decision
            .lock()
            .expect("approval decision")
            .clone();
        assert_eq!(decision.as_deref(), Some("accept"));
        assert!(respond_approval(&approval_id, "acceptAlways").is_err());
        pending_approvals()
            .lock()
            .expect("approval registry cleanup")
            .remove(&approval_id);
    }
}

pub fn create_project_directory(name: &str) -> Result<String, String> {
    let project_name = name.trim();
    if project_name.is_empty() {
        return Err("A projekt neve nem lehet üres.".to_string());
    }
    if project_name == "." || project_name == ".." {
        return Err("Ez a projektnev nem hasznalhato.".to_string());
    }
    if project_name.ends_with('.') || project_name.ends_with(' ') {
        return Err("A projekt neve nem vegzodhet ponttal vagy szokozzel.".to_string());
    }
    if project_name.chars().any(|character| {
        matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        )
    }) {
        return Err("A projekt neve ervenytelen karaktert tartalmaz.".to_string());
    }

    let root = require_projects_root()?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Nem hozhato letre a projektek mappaja: {error}"))?;
    let target = root.join(project_name);
    if target.exists() {
        return Err(format!(
            "Ez a projektmappa mar letezik: {}",
            target.display()
        ));
    }
    std::fs::create_dir(&target)
        .map_err(|error| format!("Nem hozhato letre a projektmappa: {error}"))?;
    seed_project_instructions(&target)?;
    Ok(target
        .canonicalize()
        .unwrap_or(target)
        .to_string_lossy()
        .to_string())
}

fn seed_project_instructions(target: &PathBuf) -> Result<bool, String> {
    if target.join("AGENTS.override.md").exists() || target.join("AGENTS.md").exists() {
        return Ok(false);
    }
    let template = require_projects_root()?.join("AGENTS.md");
    if !template.is_file() {
        return Ok(false);
    }
    std::fs::copy(&template, target.join("AGENTS.md"))
        .map_err(|error| format!("Nem masolhato a kozos AGENTS.md: {error}"))?;
    Ok(true)
}

pub fn ensure_project_instructions(path: &str) -> Result<bool, String> {
    let root = require_projects_root()?;
    let root = root.canonicalize().unwrap_or(root);
    let candidate = PathBuf::from(path);
    if !candidate.is_dir() {
        return Ok(false);
    }
    let target = candidate.canonicalize().unwrap_or(candidate);
    if !target.starts_with(&root) {
        return Ok(false);
    }
    seed_project_instructions(&target)
}

pub fn list_models(app: tauri::AppHandle) -> Result<Vec<CodexModel>, String> {
    let mut child = spawn_app_server(&app)?;

    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "A Codex stdin nem Ã©rhetÅ‘ el.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "A Codex stdout nem Ã©rhetÅ‘ el.".to_string())?;
        let mut reader = BufReader::new(stdout);

        initialize_app_server(&mut stdin, &mut reader)?;
        send_json(
            &mut stdin,
            json!({
                "id": 2,
                "method": "model/list",
                "params": {}
            }),
        )?;
        let response = read_response(&mut reader, 2)?;
        let data = response["result"]["data"]
            .as_array()
            .ok_or_else(|| "A Codex nem adott vissza modellkatalÃ³gust.".to_string())?;

        Ok(data
            .iter()
            .filter(|model| model["hidden"].as_bool() != Some(true))
            .filter_map(|model| {
                let id = model["id"].as_str()?.to_string();
                let display_name = model["displayName"].as_str().unwrap_or(&id).to_string();
                let description = model["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                let supported_reasoning_efforts = model["supportedReasoningEfforts"]
                    .as_array()
                    .map(|efforts| {
                        efforts
                            .iter()
                            .filter_map(|effort| {
                                effort["reasoningEffort"].as_str().map(String::from)
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let default_reasoning_effort =
                    model["defaultReasoningEffort"].as_str().map(String::from);
                Some(CodexModel {
                    id,
                    display_name,
                    description,
                    supported_reasoning_efforts,
                    default_reasoning_effort,
                })
            })
            .collect())
    })();

    terminate(child);
    result
}
