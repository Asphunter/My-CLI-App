use crate::store::{
    self, LocalConversation, LocalMessage, LocalProject, LocalStore, LocalStoreSnapshot,
    LocalTombstone, LocalWorkItem, STORE_SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub(crate) const EVENT_SCHEMA_VERSION: i64 = 2;

const PROJECT_UPSERT: &str = "project.upsert";
const CONVERSATION_UPSERT: &str = "conversation.upsert";
const MESSAGE_UPSERT: &str = "message.upsert";
const WORK_ITEM_UPSERT: &str = "work_item.upsert";
const TOMBSTONE_UPSERT: &str = "entity.tombstone";
const ENTITY_RESTORE: &str = "entity.restore";
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
const TRANSIENT_EVENT_READ_RETRIES: usize = 4;
const TRANSIENT_EVENT_READ_DELAY_MS: u64 = 250;
const TOMBSTONE_RETENTION_DAYS: i64 = 30;
const MILLIS_PER_DAY: u64 = 86_400_000;
const RETENTION_SCHEMA_VERSION: i64 = 1;
const MAX_RETENTION_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_RETENTION_BACKUP_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COMPACTION_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RETENTION_AUDIT_ENTRIES: usize = 64;
const QUARANTINE_SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncEvent {
    pub schema_version: i64,
    pub event_id: String,
    pub device_id: String,
    pub device_sequence: u64,
    pub hlc: String,
    pub entity_id: String,
    pub event_type: String,
    pub payload: Value,
    pub payload_hash: String,
    pub previous_hash: Option<String>,
    pub event_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventHashInput<'a> {
    schema_version: i64,
    event_id: &'a str,
    device_id: &'a str,
    device_sequence: u64,
    hlc: &'a str,
    entity_id: &'a str,
    event_type: &'a str,
    payload_hash: &'a str,
    previous_hash: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationEventPayload {
    id: String,
    project_id: String,
    title: String,
    thread_id: Option<String>,
    updated_at: String,
    #[serde(default)]
    plan_history: BTreeMap<String, Value>,
    #[serde(default)]
    commentary: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageEventPayload {
    project_id: String,
    conversation_id: String,
    message: LocalMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkItemEventPayload {
    project_id: String,
    conversation_id: String,
    item: LocalWorkItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TombstoneEventPayload {
    entity_type: String,
    entity_id: String,
    archived_at: String,
    project_id: Option<String>,
    title: Option<String>,
    relative_path: Option<String>,
    path_hint: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncImportReport {
    pub scanned_events: usize,
    pub accepted_events: usize,
    pub imported_events: usize,
    pub blocked_devices: Vec<String>,
    pub warnings: Vec<String>,
    pub can_write: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncHealth {
    pub status: String,
    pub journal_path: String,
    pub quarantine_path: String,
    pub checked_at: String,
    pub last_import_at: Option<String>,
    pub scanned_events: usize,
    pub accepted_events: usize,
    pub imported_events: usize,
    pub stored_events: usize,
    pub blocked_devices: Vec<String>,
    pub warnings: Vec<String>,
    pub can_write: bool,
    pub recovery_action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncV2Result {
    pub device_id: String,
    pub snapshot: LocalStoreSnapshot,
    pub health: SyncHealth,
    pub imported_events: usize,
    pub written_events: usize,
    pub blocked_devices: Vec<String>,
    pub warnings: Vec<String>,
    pub can_write: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRestorePreview {
    pub entity_type: String,
    pub entity_id: String,
    pub label: String,
    pub archived_at: String,
    pub target_path: Option<String>,
    pub can_restore: bool,
    pub blocking_reason: Option<String>,
    pub warnings: Vec<String>,
    pub effects: Vec<String>,
    pub health: SyncHealth,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRetentionCandidate {
    pub selection_key: String,
    pub entity_type: String,
    pub entity_id: String,
    pub label: String,
    pub archived_at: String,
    pub age_days: Option<i64>,
    pub eligible: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRetentionPreview {
    pub snapshot: LocalStoreSnapshot,
    pub health: SyncHealth,
    pub retention_days: i64,
    pub candidates: Vec<SyncRetentionCandidate>,
    pub eligible_count: usize,
    pub protocol_ready: bool,
    pub current_event_count: u64,
    pub current_journal_digest: String,
    pub compaction_snapshot_id: Option<String>,
    pub compaction_created_at: Option<String>,
    pub devices: Vec<SyncRetentionDevice>,
    pub audit: Vec<SyncRetentionAuditEntry>,
    pub purge_allowed: bool,
    pub blocking_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRetentionDevice {
    pub device_id: String,
    pub acked_at: Option<String>,
    pub acked_event_count: u64,
    pub acked_journal_digest: Option<String>,
    pub backup_at: Option<String>,
    pub backup_event_count: u64,
    pub backup_journal_digest: Option<String>,
    pub backup_verified: bool,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRetentionAuditEntry {
    pub schema_version: i64,
    pub audit_id: String,
    pub device_id: String,
    pub created_at: String,
    pub action: String,
    pub outcome: String,
    pub event_count: u64,
    pub journal_digest: String,
    pub selected_count: usize,
    pub snapshot_id: Option<String>,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuarantineManifest {
    schema_version: i64,
    importer_device_id: String,
    source_device_id: String,
    observed_at: String,
    source_path: String,
    source_file: String,
    bytes: u64,
    content_sha256: Option<String>,
    copied_path: Option<String>,
    reason: String,
}

fn is_transient_event_read_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32) | Some(426))
        || error.kind() == std::io::ErrorKind::TimedOut
}

fn read_event_with_retry(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    let mut attempts = 0;
    loop {
        match fs::read(path) {
            Ok(bytes) => return Ok(bytes),
            Err(error)
                if is_transient_event_read_error(&error)
                    && attempts < TRANSIENT_EVENT_READ_RETRIES =>
            {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(TRANSIENT_EVENT_READ_DELAY_MS));
            }
            Err(error) => return Err(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetentionCursor {
    sequence: u64,
    event_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetentionAck {
    schema_version: i64,
    ack_id: String,
    device_id: String,
    created_at: String,
    event_count: u64,
    journal_digest: String,
    cursors: BTreeMap<String, RetentionCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetentionBackupManifest {
    schema_version: i64,
    backup_id: String,
    device_id: String,
    created_at: String,
    event_count: u64,
    #[serde(default)]
    bytes: u64,
    journal_digest: String,
    backup_path: String,
    verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactionSnapshot {
    schema_version: i64,
    snapshot_id: String,
    created_at: String,
    event_count: u64,
    journal_digest: String,
    cursors: BTreeMap<String, RetentionCursor>,
    state: LocalStoreSnapshot,
    snapshot_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactionSnapshotHashInput<'a> {
    schema_version: i64,
    snapshot_id: &'a str,
    created_at: &'a str,
    event_count: u64,
    journal_digest: &'a str,
    cursors: &'a BTreeMap<String, RetentionCursor>,
    state: &'a LocalStoreSnapshot,
}

#[derive(Debug, Clone)]
struct PendingEvent {
    entity_id: String,
    event_type: String,
    payload: Value,
}

#[derive(Debug, Default, Clone)]
struct JournalScan {
    accepted: Vec<SyncEvent>,
    scanned_events: usize,
    blocked_devices: HashSet<String>,
    warnings: Vec<String>,
    snapshot: Option<CompactionSnapshot>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct EventRank {
    hlc: String,
    device_id: String,
    sequence: u64,
}

impl Ord for EventRank {
    fn cmp(&self, other: &Self) -> Ordering {
        self.hlc
            .cmp(&other.hlc)
            .then_with(|| self.device_id.cmp(&other.device_id))
            .then_with(|| self.sequence.cmp(&other.sequence))
    }
}

impl PartialOrd for EventRank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug)]
struct ProjectAccumulator {
    value: LocalProject,
    rank: EventRank,
    threads: BTreeSet<String>,
}

#[derive(Debug)]
struct ConversationAccumulator {
    value: ConversationEventPayload,
    rank: EventRank,
    placeholder: bool,
    titles: BTreeSet<String>,
    messages: BTreeMap<String, (EventRank, LocalMessage)>,
    work_items: BTreeMap<String, (EventRank, LocalWorkItem)>,
}

fn append_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn now_text() -> String {
    now_millis().to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn stable_id(kind: &str, key: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("min:v2:{kind}:{key}").as_bytes(),
    )
    .to_string()
}

fn sync_root() -> Result<PathBuf, String> {
    Ok(crate::codex::require_projects_root()?
        .join(".min-sync")
        .join("v2"))
}

fn retention_root(root: &Path) -> PathBuf {
    root.join("retention")
}

fn local_retention_backup_root() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "A retention backup helye nem határozható meg.".to_string())?;
    Ok(PathBuf::from(base)
        .join("min")
        .join("sync-backups")
        .join("v2"))
}

fn retention_metadata_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("A retention metadata nem szerializálható: {error}"))?;
    if bytes.len() as u64 > MAX_RETENTION_METADATA_BYTES {
        return Err("A retention metadata túl nagy.".to_string());
    }
    Ok(bytes)
}

fn retention_record_newer(
    created_at: &str,
    record_id: &str,
    previous_created_at: &str,
    previous_id: &str,
) -> bool {
    created_at
        .parse::<u64>()
        .unwrap_or_default()
        .cmp(&previous_created_at.parse::<u64>().unwrap_or_default())
        .then_with(|| record_id.cmp(previous_id))
        .is_gt()
}

fn empty_journal_digest() -> String {
    sha256_hex(b"min:v2:journal:empty:v1")
}

fn extend_journal_digest(previous: &str, event: &SyncEvent) -> String {
    let canonical = format!(
        "min:v2:journal:v1:{previous}:{}:{}:{}\n",
        event.device_id, event.device_sequence, event.event_hash
    );
    sha256_hex(canonical.as_bytes())
}

#[cfg(test)]
fn journal_digest(events: &[SyncEvent]) -> String {
    let mut digest = empty_journal_digest();
    for event in events {
        digest = extend_journal_digest(&digest, event);
    }
    digest
}

fn journal_cursors_for_scan(scan: &JournalScan) -> BTreeMap<String, RetentionCursor> {
    let mut cursors = scan
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.cursors.clone())
        .unwrap_or_default();
    for event in &scan.accepted {
        cursors.insert(
            event.device_id.clone(),
            RetentionCursor {
                sequence: event.device_sequence,
                event_hash: event.event_hash.clone(),
            },
        );
    }
    cursors
}

fn journal_event_count_for_scan(scan: &JournalScan) -> u64 {
    scan.snapshot
        .as_ref()
        .map(|snapshot| snapshot.event_count)
        .unwrap_or_default()
        .saturating_add(scan.accepted.len() as u64)
}

fn journal_digest_for_scan(scan: &JournalScan) -> String {
    let mut digest = scan
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.journal_digest.clone())
        .unwrap_or_else(empty_journal_digest);
    for event in &scan.accepted {
        digest = extend_journal_digest(&digest, event);
    }
    digest
}

fn compaction_snapshot_hash(snapshot: &CompactionSnapshot) -> Result<String, String> {
    let input = CompactionSnapshotHashInput {
        schema_version: snapshot.schema_version,
        snapshot_id: &snapshot.snapshot_id,
        created_at: &snapshot.created_at,
        event_count: snapshot.event_count,
        journal_digest: &snapshot.journal_digest,
        cursors: &snapshot.cursors,
        state: &snapshot.state,
    };
    let bytes = serde_json::to_vec(&input).map_err(|error| {
        format!("A compaction snapshot hash-inputja nem szerializálható: {error}")
    })?;
    Ok(sha256_hex(&bytes))
}

fn validate_compaction_snapshot(snapshot: &CompactionSnapshot) -> Result<(), String> {
    if snapshot.schema_version != RETENTION_SCHEMA_VERSION
        || Uuid::parse_str(&snapshot.snapshot_id).is_err()
        || snapshot.created_at.parse::<u64>().is_err()
        || !is_sha256(&snapshot.journal_digest)
        || !is_sha256(&snapshot.snapshot_hash)
        || snapshot.state.schema_version > STORE_SCHEMA_VERSION
        || snapshot.cursors.len() > 100_000
        || snapshot.event_count > 100_000_000
    {
        return Err("A compaction snapshot fejléce hibás.".to_string());
    }
    for (device_id, cursor) in &snapshot.cursors {
        if Uuid::parse_str(device_id).is_err()
            || cursor.sequence == 0
            || !is_sha256(&cursor.event_hash)
        {
            return Err("A compaction snapshot cursorja hibás.".to_string());
        }
    }
    if compaction_snapshot_hash(snapshot)? != snapshot.snapshot_hash {
        return Err("A compaction snapshot hash-e nem egyezik.".to_string());
    }
    Ok(())
}

fn is_recoverable_compaction_snapshot_error(error: &str) -> bool {
    error == "A compaction snapshot hash-e nem egyezik."
}

fn read_latest_compaction_snapshot(root: &Path) -> Result<Option<CompactionSnapshot>, String> {
    let directory = retention_root(root).join("snapshots");
    let mut latest = None;
    for path in retention_json_files(&directory)? {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("A compaction snapshot státusza nem olvasható: {error}"))?;
        if metadata.len() > MAX_COMPACTION_SNAPSHOT_BYTES {
            return Err(format!(
                "A compaction snapshot túl nagy: {}.",
                path.display()
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("A compaction snapshot nem olvasható: {error}"))?;
        let snapshot = serde_json::from_slice::<CompactionSnapshot>(&bytes)
            .map_err(|error| format!("A compaction snapshot JSON-ja hibás: {error}"))?;
        if let Err(error) = validate_compaction_snapshot(&snapshot) {
            // Older clients serialized optional message fields differently.
            // The event journal remains the source of truth, so ignore only a
            // hash-incompatible compaction index and fall back to the newest
            // valid prefix instead of blocking the entire journal.
            if is_recoverable_compaction_snapshot_error(&error) {
                continue;
            }
            return Err(error);
        }
        let replace = latest
            .as_ref()
            .map(|previous: &CompactionSnapshot| {
                retention_record_newer(
                    &snapshot.created_at,
                    &snapshot.snapshot_id,
                    &previous.created_at,
                    &previous.snapshot_id,
                )
            })
            .unwrap_or(true);
        if replace {
            latest = Some(snapshot);
        }
    }
    Ok(latest)
}

fn validate_retention_ack(ack: &RetentionAck) -> Result<(), String> {
    if ack.schema_version != RETENTION_SCHEMA_VERSION
        || Uuid::parse_str(&ack.ack_id).is_err()
        || Uuid::parse_str(&ack.device_id).is_err()
        || ack.created_at.parse::<u64>().is_err()
        || !is_sha256(&ack.journal_digest)
    {
        return Err("A retention ACK schema-ja vagy azonosítója hibás.".to_string());
    }
    for (device_id, cursor) in &ack.cursors {
        if Uuid::parse_str(device_id).is_err()
            || cursor.sequence == 0
            || !is_sha256(&cursor.event_hash)
        {
            return Err("A retention ACK cursorja hibás.".to_string());
        }
    }
    Ok(())
}

fn validate_retention_backup(manifest: &RetentionBackupManifest) -> Result<(), String> {
    if manifest.schema_version != RETENTION_SCHEMA_VERSION
        || Uuid::parse_str(&manifest.backup_id).is_err()
        || Uuid::parse_str(&manifest.device_id).is_err()
        || manifest.created_at.parse::<u64>().is_err()
        || manifest.event_count > 10_000_000
        || manifest.bytes > MAX_RETENTION_BACKUP_BYTES
        || !is_sha256(&manifest.journal_digest)
        || !manifest.verified
        || !Path::new(&manifest.backup_path).is_absolute()
    {
        return Err("A retention backup manifestje hibás vagy nem igazolt.".to_string());
    }
    Ok(())
}

fn validate_retention_audit(entry: &SyncRetentionAuditEntry) -> Result<(), String> {
    let valid_action = matches!(entry.action.as_str(), "ack" | "backup" | "purge");
    let valid_outcome = matches!(entry.outcome.as_str(), "started" | "completed" | "failed");
    if entry.schema_version != RETENTION_SCHEMA_VERSION
        || Uuid::parse_str(&entry.audit_id).is_err()
        || Uuid::parse_str(&entry.device_id).is_err()
        || entry.created_at.parse::<u64>().is_err()
        || !is_sha256(&entry.journal_digest)
        || entry.event_count > 100_000_000
        || entry.selected_count > 100_000
        || !valid_action
        || !valid_outcome
        || entry
            .snapshot_id
            .as_deref()
            .is_some_and(|value| Uuid::parse_str(value).is_err())
        || entry
            .details
            .as_deref()
            .is_some_and(|value| value.len() > 4096)
    {
        return Err("A retention audit rekordja hibás.".to_string());
    }
    Ok(())
}

fn retention_json_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("A retention metadata mappája nem olvasható: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("A retention metadata bejegyzése nem olvasható: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("A retention metadata státusza nem olvasható: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "A retention metadata symlinket tartalmaz, ezért blokkolva: {}.",
                path.display()
            ));
        }
        if metadata.is_file() && path.extension().and_then(|value| value.to_str()) == Some("json") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn read_retention_audit(root: &Path) -> (Vec<SyncRetentionAuditEntry>, Vec<String>) {
    let directory = retention_root(root).join("audit");
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    if !directory.exists() {
        return (entries, warnings);
    }
    let device_directories = match fs::read_dir(&directory) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!("A retention audit mappa nem olvasható: {error}."));
            return (entries, warnings);
        }
    };
    for device_entry in device_directories {
        let device_entry = match device_entry {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!(
                    "Egy retention audit bejegyzés nem olvasható: {error}."
                ));
                continue;
            }
        };
        let device_directory = device_entry.path();
        let metadata = match fs::symlink_metadata(&device_directory) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!(
                    "A retention audit eszközmappája nem olvasható: {error}."
                ));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            warnings.push(format!(
                "A retention audit eszközmappája symlink, ezért blokkolva: {}.",
                device_directory.display()
            ));
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        let directory_device = device_entry.file_name().to_string_lossy().to_string();
        if Uuid::parse_str(&directory_device).is_err() {
            warnings.push(format!(
                "A retention audit eszközmappájának neve nem UUID: {directory_device}."
            ));
            continue;
        }
        let files = match retention_json_files(&device_directory) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        for path in files {
            let bytes = match fs::read(&path) {
                Ok(bytes) if (bytes.len() as u64) <= MAX_RETENTION_METADATA_BYTES => bytes,
                Ok(_) => {
                    warnings.push(format!(
                        "A retention audit rekordja túl nagy: {}.",
                        path.display()
                    ));
                    continue;
                }
                Err(error) => {
                    warnings.push(format!(
                        "A retention audit rekordja nem olvasható ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            let entry = match serde_json::from_slice::<SyncRetentionAuditEntry>(&bytes) {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(format!(
                        "A retention audit rekordja hibás JSON ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            if let Err(error) = validate_retention_audit(&entry) {
                warnings.push(format!("{error} ({})", path.display()));
                continue;
            }
            if entry.device_id != directory_device {
                warnings.push(format!(
                    "A retention audit eszközazonosítója nem egyezik a mappával: {}.",
                    path.display()
                ));
                continue;
            }
            entries.push(entry);
        }
    }
    entries.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.audit_id.cmp(&right.audit_id))
    });
    if entries.len() > MAX_RETENTION_AUDIT_ENTRIES {
        let keep_from = entries.len() - MAX_RETENTION_AUDIT_ENTRIES;
        entries.drain(..keep_from);
    }
    (entries, warnings)
}

fn read_retention_acks(root: &Path) -> (BTreeMap<String, RetentionAck>, Vec<String>) {
    let directory = retention_root(root).join("acks");
    let mut latest = BTreeMap::<String, RetentionAck>::new();
    let mut warnings = Vec::new();
    if !directory.exists() {
        return (latest, warnings);
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("A retention ACK mappa nem olvasható: {error}."));
            return (latest, warnings);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("Egy retention ACK mappa nem olvasható: {error}."));
                continue;
            }
        };
        let device_directory = entry.path();
        let device_metadata = match fs::symlink_metadata(&device_directory) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!(
                    "A retention ACK eszközmappája nem olvasható: {error}."
                ));
                continue;
            }
        };
        if device_metadata.file_type().is_symlink() {
            warnings.push(format!(
                "A retention ACK eszközmappája symlink, ezért blokkolva: {}.",
                device_directory.display()
            ));
            continue;
        }
        if !device_metadata.is_dir() {
            continue;
        }
        let directory_device = entry.file_name().to_string_lossy().to_string();
        let files = match retention_json_files(&device_directory) {
            Ok(files) => files,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        for path in files {
            let bytes = match fs::read(&path) {
                Ok(bytes) if (bytes.len() as u64) <= MAX_RETENTION_METADATA_BYTES => bytes,
                Ok(_) => {
                    warnings.push(format!("A retention ACK túl nagy: {}.", path.display()));
                    continue;
                }
                Err(error) => {
                    warnings.push(format!(
                        "A retention ACK nem olvasható ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            let ack = match serde_json::from_slice::<RetentionAck>(&bytes) {
                Ok(ack) => ack,
                Err(error) => {
                    warnings.push(format!(
                        "A retention ACK hibás JSON ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            if let Err(error) = validate_retention_ack(&ack) {
                warnings.push(format!(
                    "A retention ACK nem valid ({}): {error}.",
                    path.display()
                ));
                continue;
            }
            if ack.device_id != directory_device {
                warnings.push(format!(
                    "A retention ACK eszközazonosítója nem egyezik a mappával: {}.",
                    path.display()
                ));
                continue;
            }
            let replace = latest
                .get(&ack.device_id)
                .map(|previous| {
                    retention_record_newer(
                        &ack.created_at,
                        &ack.ack_id,
                        &previous.created_at,
                        &previous.ack_id,
                    )
                })
                .unwrap_or(true);
            if replace {
                latest.insert(ack.device_id.clone(), ack);
            }
        }
    }
    (latest, warnings)
}

fn read_retention_backups(root: &Path) -> (BTreeMap<String, RetentionBackupManifest>, Vec<String>) {
    let directory = retention_root(root).join("backups");
    let mut latest = BTreeMap::<String, RetentionBackupManifest>::new();
    let mut warnings = Vec::new();
    if !directory.exists() {
        return (latest, warnings);
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("A retention backup mappa nem olvasható: {error}."));
            return (latest, warnings);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!(
                    "Egy retention backup mappa nem olvasható: {error}."
                ));
                continue;
            }
        };
        let device_directory = entry.path();
        let device_metadata = match fs::symlink_metadata(&device_directory) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!(
                    "A retention backup eszközmappája nem olvasható: {error}."
                ));
                continue;
            }
        };
        if device_metadata.file_type().is_symlink() {
            warnings.push(format!(
                "A retention backup eszközmappája symlink, ezért blokkolva: {}.",
                device_directory.display()
            ));
            continue;
        }
        if !device_metadata.is_dir() {
            continue;
        }
        let directory_device = entry.file_name().to_string_lossy().to_string();
        let files = match retention_json_files(&device_directory) {
            Ok(files) => files,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        for path in files {
            let bytes = match fs::read(&path) {
                Ok(bytes) if (bytes.len() as u64) <= MAX_RETENTION_METADATA_BYTES => bytes,
                Ok(_) => {
                    warnings.push(format!(
                        "A retention backup manifestje túl nagy: {}.",
                        path.display()
                    ));
                    continue;
                }
                Err(error) => {
                    warnings.push(format!(
                        "A retention backup manifestje nem olvasható ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            let manifest = match serde_json::from_slice::<RetentionBackupManifest>(&bytes) {
                Ok(manifest) => manifest,
                Err(error) => {
                    warnings.push(format!(
                        "A retention backup manifestje hibás JSON ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            if let Err(error) = validate_retention_backup(&manifest) {
                warnings.push(format!(
                    "A retention backup manifestje nem valid ({}): {error}.",
                    path.display()
                ));
                continue;
            }
            if manifest.device_id != directory_device {
                warnings.push(format!(
                    "A retention backup eszközazonosítója nem egyezik a mappával: {}.",
                    path.display()
                ));
                continue;
            }
            let replace = latest
                .get(&manifest.device_id)
                .map(|previous| {
                    retention_record_newer(
                        &manifest.created_at,
                        &manifest.backup_id,
                        &previous.created_at,
                        &previous.backup_id,
                    )
                })
                .unwrap_or(true);
            if replace {
                latest.insert(manifest.device_id.clone(), manifest);
            }
        }
    }
    (latest, warnings)
}

fn local_device_id_path() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "A v2 sync eszközazonosító helye nem határozható meg.".to_string())?;
    Ok(PathBuf::from(base).join("min").join("sync-device-id"))
}

pub(crate) fn local_device_id() -> Result<String, String> {
    let path = local_device_id_path()?;
    if path.is_file() {
        let value = fs::read_to_string(&path)
            .map_err(|error| format!("A v2 sync eszközazonosítója nem olvasható: {error}"))?
            .trim()
            .to_string();
        if Uuid::parse_str(&value).is_err() {
            return Err(
                "A v2 sync eszközazonosító fájlja hibás; automatikus csere nincs engedélyezve."
                    .to_string(),
            );
        }
        return Ok(value);
    }

    let value = Uuid::new_v4().to_string();
    write_atomic(&path, value.as_bytes())?;
    Ok(value)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Az atomikus fájlírás szülőmappája nem határozható meg.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Az atomikus fájlírás mappája nem hozható létre: {error}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state");
    let temporary = parent.join(format!(".{name}.tmp-{}", Uuid::new_v4()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Az ideiglenes fájl nem írható: {error}"))?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Az atomikus fájlcsere sikertelen: {error}"));
    }
    Ok(())
}

fn copy_event_tree(source: &Path, target: &Path) -> Result<(usize, u64), String> {
    if !source.exists() {
        fs::create_dir_all(target)
            .map_err(|error| format!("A backup üres event-mappája nem hozható létre: {error}"))?;
        return Ok((0, 0));
    }
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("A backup forrásának státusza nem olvasható: {error}"))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("A backup event-forrása nem biztonságos könyvtár.".to_string());
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("A backup célmappája nem hozható létre: {error}"))?;
    let mut copied_files = 0_usize;
    let mut copied_bytes = 0_u64;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("A backup event-forrása nem olvasható: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("A backup event-bejegyzése nem olvasható: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("A backup event státusza nem olvasható: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "A backup event-forrása symlinket tartalmaz: {}.",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            let (files, bytes) = copy_event_tree(&source_path, &target_path)?;
            copied_files = copied_files
                .checked_add(files)
                .ok_or_else(|| "A backup fájlszámlálója túlcsordult.".to_string())?;
            copied_bytes = copied_bytes
                .checked_add(bytes)
                .ok_or_else(|| "A backup méretszámlálója túlcsordult.".to_string())?;
            if copied_bytes > MAX_RETENTION_BACKUP_BYTES {
                return Err(format!(
                    "A retention backup meghaladná a {} MiB méretkorlátot.",
                    MAX_RETENTION_BACKUP_BYTES / (1024 * 1024)
                ));
            }
        } else if metadata.is_file() {
            let bytes = metadata.len();
            copied_bytes = copied_bytes
                .checked_add(bytes)
                .ok_or_else(|| "A backup méretszámlálója túlcsordult.".to_string())?;
            if copied_bytes > MAX_RETENTION_BACKUP_BYTES {
                return Err(format!(
                    "A retention backup meghaladná a {} MiB méretkorlátot.",
                    MAX_RETENTION_BACKUP_BYTES / (1024 * 1024)
                ));
            }
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("A backup eventje nem másolható: {error}"))?;
            copied_files = copied_files
                .checked_add(1)
                .ok_or_else(|| "A backup fájlszámlálója túlcsordult.".to_string())?;
        } else {
            return Err(format!(
                "A backup event-forrása ismeretlen fájltípust tartalmaz: {}.",
                source_path.display()
            ));
        }
    }
    Ok((copied_files, copied_bytes))
}

fn write_retention_audit(
    root: &Path,
    device_id: &str,
    scan: &JournalScan,
    action: &str,
    outcome: &str,
    selected_count: usize,
    snapshot_id: Option<String>,
    details: Option<String>,
) -> Result<SyncRetentionAuditEntry, String> {
    let entry = SyncRetentionAuditEntry {
        schema_version: RETENTION_SCHEMA_VERSION,
        audit_id: Uuid::new_v4().to_string(),
        device_id: device_id.to_string(),
        created_at: now_text(),
        action: action.to_string(),
        outcome: outcome.to_string(),
        event_count: journal_event_count_for_scan(scan),
        journal_digest: journal_digest_for_scan(scan),
        selected_count,
        snapshot_id,
        details,
    };
    validate_retention_audit(&entry)?;
    let directory = retention_root(root).join("audit").join(device_id);
    let path = directory.join(format!("{}-{}.json", entry.created_at, entry.audit_id));
    write_atomic(&path, &retention_metadata_bytes(&entry)?)?;
    Ok(entry)
}

fn write_retention_ack_for_scan(
    root: &Path,
    device_id: &str,
    scan: &JournalScan,
) -> Result<RetentionAck, String> {
    let ack = RetentionAck {
        schema_version: RETENTION_SCHEMA_VERSION,
        ack_id: Uuid::new_v4().to_string(),
        device_id: device_id.to_string(),
        created_at: now_text(),
        event_count: journal_event_count_for_scan(scan),
        journal_digest: journal_digest_for_scan(scan),
        cursors: journal_cursors_for_scan(scan),
    };
    validate_retention_ack(&ack)?;
    let directory = retention_root(root).join("acks").join(device_id);
    let path = directory.join(format!("{}-{}.json", ack.created_at, ack.ack_id));
    write_atomic(&path, &retention_metadata_bytes(&ack)?)?;
    Ok(ack)
}

#[cfg(test)]
fn write_retention_ack_at(
    root: &Path,
    device_id: &str,
    events: &[SyncEvent],
) -> Result<RetentionAck, String> {
    write_retention_ack_for_scan(
        root,
        device_id,
        &JournalScan {
            accepted: events.to_vec(),
            scanned_events: events.len(),
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        },
    )
}

fn write_retention_backup_for_scan(
    root: &Path,
    device_id: &str,
    scan: &JournalScan,
) -> Result<RetentionBackupManifest, String> {
    let backup_id = Uuid::new_v4().to_string();
    let backup_root = local_retention_backup_root()?;
    fs::create_dir_all(&backup_root).map_err(|error| {
        format!("A lokális retention backup mappája nem hozható létre: {error}")
    })?;
    let temporary = backup_root.join(format!(".journal-{backup_id}.tmp"));
    let target = backup_root.join(format!("journal-{backup_id}"));
    if temporary.exists() || target.exists() {
        return Err("A retention backup célazonosítója ütközik.".to_string());
    }
    let copy_result = (|| {
        let (copied_event_files, copied_event_bytes) =
            copy_event_tree(&root.join("events"), &temporary.join("events"))?;
        let (copied_snapshot_files, copied_snapshot_bytes) = copy_event_tree(
            &retention_root(root).join("snapshots"),
            &temporary.join("retention").join("snapshots"),
        )?;
        let copied_files = copied_event_files.saturating_add(copied_snapshot_files);
        let copied_bytes = copied_event_bytes
            .checked_add(copied_snapshot_bytes)
            .ok_or_else(|| "A backup méretszámlálója túlcsordult.".to_string())?;
        if copied_bytes > MAX_RETENTION_BACKUP_BYTES {
            return Err(format!(
                "A retention backup meghaladná a {} MiB méretkorlátot.",
                MAX_RETENTION_BACKUP_BYTES / (1024 * 1024)
            ));
        }
        let verification = scan_journal(&temporary, device_id)?;
        if !verification.warnings.is_empty()
            || verification
                .blocked_devices
                .contains(&device_id.to_string())
            || journal_event_count_for_scan(&verification) != journal_event_count_for_scan(scan)
            || journal_digest_for_scan(&verification) != journal_digest_for_scan(scan)
        {
            return Err("A lokális retention backup ellenőrzése sikertelen.".to_string());
        }
        if copied_event_files < scan.accepted.len() {
            return Err("A lokális retention backupból event fájl hiányzik.".to_string());
        }
        Ok((copied_files, copied_bytes))
    })();
    let (copied_files, copied_bytes) = match copy_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&temporary);
            return Err(error);
        }
    };
    fs::rename(&temporary, &target)
        .map_err(|error| format!("A lokális retention backup lezárása sikertelen: {error}"))?;
    let manifest = RetentionBackupManifest {
        schema_version: RETENTION_SCHEMA_VERSION,
        backup_id,
        device_id: device_id.to_string(),
        created_at: now_text(),
        event_count: journal_event_count_for_scan(scan),
        bytes: copied_bytes,
        journal_digest: journal_digest_for_scan(scan),
        backup_path: target.to_string_lossy().to_string(),
        verified: copied_files >= scan.accepted.len(),
    };
    validate_retention_backup(&manifest)?;
    let directory = retention_root(root).join("backups").join(device_id);
    let path = directory.join(format!(
        "{}-{}.json",
        manifest.created_at, manifest.backup_id
    ));
    if let Err(error) = write_atomic(&path, &retention_metadata_bytes(&manifest)?) {
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }
    Ok(manifest)
}

fn parse_hlc(value: &str) -> Option<(u64, u32)> {
    let mut parts = value.split('-');
    let physical = parts.next()?;
    let logical = parts.next()?;
    if parts.next().is_some() || physical.len() != 20 || logical.len() != 8 {
        return None;
    }
    if !physical.chars().all(|character| character.is_ascii_digit())
        || !logical.chars().all(|character| character.is_ascii_digit())
    {
        return None;
    }
    Some((physical.parse().ok()?, logical.parse().ok()?))
}

fn next_hlc(last: Option<&str>) -> Result<String, String> {
    let physical_now = now_millis();
    let (physical, logical) = match last.and_then(parse_hlc) {
        Some((last_physical, last_logical)) if physical_now <= last_physical => (
            last_physical,
            last_logical
                .checked_add(1)
                .ok_or_else(|| "A HLC logikai számlálója túlcsordult.".to_string())?,
        ),
        Some(_) | None => (physical_now, 0),
    };
    Ok(format!("{physical:020}-{logical:08}"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn payload_bytes(payload: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(payload)
        .map_err(|error| format!("Az event payloadja nem szerializálható: {error}"))
}

fn event_hash(event: &SyncEvent) -> Result<String, String> {
    let input = EventHashInput {
        schema_version: event.schema_version,
        event_id: &event.event_id,
        device_id: &event.device_id,
        device_sequence: event.device_sequence,
        hlc: &event.hlc,
        entity_id: &event.entity_id,
        event_type: &event.event_type,
        payload_hash: &event.payload_hash,
        previous_hash: event.previous_hash.as_deref(),
    };
    let bytes = serde_json::to_vec(&input)
        .map_err(|error| format!("Az event hash-input nem szerializálható: {error}"))?;
    Ok(sha256_hex(&bytes))
}

fn validate_payload(event_type: &str, entity_id: &str, payload: &Value) -> Result<(), String> {
    match event_type {
        PROJECT_UPSERT => {
            let project: LocalProject = serde_json::from_value(payload.clone())
                .map_err(|error| format!("A project event payloadja hibás: {error}"))?;
            if project.id != entity_id || project.name.trim().is_empty() {
                return Err("A project event identityje vagy neve hibás.".to_string());
            }
        }
        CONVERSATION_UPSERT => {
            let conversation: ConversationEventPayload = serde_json::from_value(payload.clone())
                .map_err(|error| format!("A conversation event payloadja hibás: {error}"))?;
            if conversation.id != entity_id
                || conversation.project_id.trim().is_empty()
                || conversation.title.trim().is_empty()
            {
                return Err("A conversation event identityje vagy tartalma hibás.".to_string());
            }
        }
        MESSAGE_UPSERT => {
            let message: MessageEventPayload = serde_json::from_value(payload.clone())
                .map_err(|error| format!("A message event payloadja hibás: {error}"))?;
            if message.message.id.as_deref() != Some(entity_id)
                || message.project_id.trim().is_empty()
                || message.conversation_id.trim().is_empty()
            {
                return Err("A message event identityje vagy tartalma hibás.".to_string());
            }
        }
        WORK_ITEM_UPSERT => {
            let item: WorkItemEventPayload = serde_json::from_value(payload.clone())
                .map_err(|error| format!("A work item event payloadja hibás: {error}"))?;
            if item.project_id.trim().is_empty()
                || item.conversation_id.trim().is_empty()
                || item.item.label.trim().is_empty()
            {
                return Err("A work item event tartalma hibás.".to_string());
            }
        }
        TOMBSTONE_UPSERT | ENTITY_RESTORE => {
            let tombstone: TombstoneEventPayload = serde_json::from_value(payload.clone())
                .map_err(|error| format!("A tombstone/restore event payloadja hibás: {error}"))?;
            if tombstone.entity_id != entity_id
                || !matches!(tombstone.entity_type.as_str(), "project" | "conversation")
                || tombstone.archived_at.trim().is_empty()
            {
                return Err("A tombstone event identityje vagy típusa hibás.".to_string());
            }
            if tombstone.entity_type == "conversation"
                && tombstone
                    .project_id
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .is_empty()
            {
                return Err("A conversation tombstone projektazonosítója hiányzik.".to_string());
            }
        }
        _ => return Err(format!("Ismeretlen v2 event type: {event_type}")),
    }
    Ok(())
}

fn validate_event(event: &SyncEvent) -> Result<(), String> {
    if event.schema_version != EVENT_SCHEMA_VERSION {
        return Err(format!(
            "Nem támogatott v2 event schema: {}.",
            event.schema_version
        ));
    }
    if Uuid::parse_str(&event.event_id).is_err() || Uuid::parse_str(&event.device_id).is_err() {
        return Err("A v2 event azonosítója vagy eszközazonosítója nem UUID.".to_string());
    }
    if event.device_sequence == 0
        || event.entity_id.trim().is_empty()
        || event.event_type.trim().is_empty()
    {
        return Err("A v2 event kötelező identity mezője hiányzik.".to_string());
    }
    if parse_hlc(&event.hlc).is_none()
        || !is_sha256(&event.payload_hash)
        || !is_sha256(&event.event_hash)
    {
        return Err("A v2 event HLC-je vagy hash-e hibás.".to_string());
    }
    if let Some(previous_hash) = &event.previous_hash {
        if !is_sha256(previous_hash) {
            return Err("A v2 event előző hash-e hibás.".to_string());
        }
    }
    let bytes = payload_bytes(&event.payload)?;
    if bytes.len() > MAX_EVENT_BYTES {
        return Err("A v2 event payloadja túl nagy.".to_string());
    }
    if sha256_hex(&bytes) != event.payload_hash {
        return Err("A v2 event payload hash-e nem egyezik.".to_string());
    }
    if event_hash(event)? != event.event_hash {
        return Err("A v2 event hash-e nem egyezik.".to_string());
    }
    validate_payload(&event.event_type, &event.entity_id, &event.payload)
}

fn make_event(
    device_id: &str,
    sequence: u64,
    hlc: String,
    previous_hash: Option<String>,
    entity_id: String,
    event_type: String,
    payload: Value,
) -> Result<SyncEvent, String> {
    let bytes = payload_bytes(&payload)?;
    let mut event = SyncEvent {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: Uuid::new_v4().to_string(),
        device_id: device_id.to_string(),
        device_sequence: sequence,
        hlc,
        entity_id,
        event_type,
        payload,
        payload_hash: sha256_hex(&bytes),
        previous_hash,
        event_hash: String::new(),
    };
    event.event_hash = event_hash(&event)?;
    validate_event(&event)?;
    Ok(event)
}

fn quarantine_file(
    root: &Path,
    importer_id: &str,
    source_device: &str,
    path: &Path,
    reason: &str,
) -> Result<String, String> {
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| "A hibás event fájlneve nem határozható meg.".to_string())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("A quarantine forrás státusza nem olvasható: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("A hibás event symlink; automatikus másolása tiltva.".to_string());
    }
    if !metadata.is_file() {
        return Err("A hibás event forrása nem szabályos fájl.".to_string());
    }

    let target_dir = root
        .join("quarantine")
        .join(importer_id)
        .join(source_device);
    fs::create_dir_all(&target_dir)
        .map_err(|error| format!("A quarantine mappa nem hozható létre: {error}"))?;

    let bytes = metadata.len();
    let (content_sha256, copied_path, suffix) = if bytes <= MAX_EVENT_BYTES as u64 {
        let content = fs::read(path)
            .map_err(|error| format!("A hibás event quarantine-másolata nem olvasható: {error}"))?;
        let digest = sha256_hex(&content);
        let suffix = digest[..12].to_string();
        let target = target_dir.join(format!("{file_name}.quarantined-{suffix}"));
        if !target.exists() {
            write_atomic(&target, &content)?;
        }
        (
            Some(digest),
            Some(target.to_string_lossy().to_string()),
            suffix,
        )
    } else {
        // A méretkorlát feletti fájlt nem másoljuk memóriába; a manifest megőrzi
        // a bizonyítékot, miközben nem engedünk korlátlan quarantine-másolást.
        (None, None, format!("oversize-{bytes}"))
    };

    let manifest = QuarantineManifest {
        schema_version: QUARANTINE_SCHEMA_VERSION,
        importer_device_id: importer_id.to_string(),
        source_device_id: source_device.to_string(),
        observed_at: now_text(),
        source_path: path.to_string_lossy().to_string(),
        source_file: file_name.clone(),
        bytes,
        content_sha256,
        copied_path,
        reason: reason.to_string(),
    };
    let manifest_path = target_dir.join(format!("{file_name}.quarantine-{suffix}.json"));
    if !manifest_path.exists() {
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("A quarantine manifest nem szerializálható: {error}"))?;
        if manifest_bytes.len() as u64 > MAX_RETENTION_METADATA_BYTES {
            return Err("A quarantine manifest túl nagy.".to_string());
        }
        write_atomic(&manifest_path, &manifest_bytes)?;
    }
    Ok(manifest_path.to_string_lossy().to_string())
}

fn quarantine_and_warn(
    scan: &mut JournalScan,
    root: &Path,
    importer_id: &str,
    source_device: &str,
    path: &Path,
    reason: &str,
) {
    if let Err(error) = quarantine_file(root, importer_id, source_device, path, reason) {
        scan.warnings.push(format!(
            "A v2 event quarantine-manifestje nem készíthető el ({}): {error}.",
            path.display()
        ));
    }
}

fn scan_journal(root: &Path, importer_id: &str) -> Result<JournalScan, String> {
    let events_root = root.join("events");
    let compaction_snapshot = read_latest_compaction_snapshot(root)?;
    let mut scan = JournalScan {
        snapshot: compaction_snapshot.clone(),
        ..JournalScan::default()
    };
    if !events_root.exists() {
        return Ok(scan);
    }
    let mut device_events: BTreeMap<String, BTreeMap<u64, SyncEvent>> = BTreeMap::new();
    let mut event_ids = HashMap::<String, String>::new();

    for device_entry in fs::read_dir(&events_root)
        .map_err(|error| format!("A v2 eventmappa nem olvasható: {error}"))?
    {
        let device_entry = device_entry
            .map_err(|error| format!("A v2 event-eszközmappa nem olvasható: {error}"))?;
        let device_path = device_entry.path();
        if !device_path.is_dir() {
            continue;
        }
        let source_device = device_entry.file_name().to_string_lossy().to_string();
        if Uuid::parse_str(&source_device).is_err() {
            scan.blocked_devices.insert(source_device.clone());
            scan.warnings
                .push(format!("A v2 eventmappa neve nem UUID: {source_device}."));
            continue;
        }
        let entries = match fs::read_dir(&device_path) {
            Ok(entries) => entries,
            Err(error) => {
                scan.blocked_devices.insert(source_device.clone());
                scan.warnings.push(format!(
                    "A v2 event-eszközmappa nem olvasható ({source_device}): {error}."
                ));
                continue;
            }
        };
        for file_entry in entries {
            let file_entry = match file_entry {
                Ok(entry) => entry,
                Err(error) => {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 event fájllistája nem olvasható ({source_device}): {error}."
                    ));
                    continue;
                }
            };
            let path = file_entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    scan.scanned_events += 1;
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 event státusza nem olvasható és az írás blokkolva marad ({}): {error}.",
                        path.display()
                    ));
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                scan.scanned_events += 1;
                scan.blocked_devices.insert(source_device.clone());
                scan.warnings.push(format!(
                    "A v2 event symlink és ezért blokkolva van: {}.",
                    path.display()
                ));
                quarantine_and_warn(
                    &mut scan,
                    root,
                    importer_id,
                    &source_device,
                    &path,
                    "symlink event",
                );
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            scan.scanned_events += 1;
            let bytes = match read_event_with_retry(&path) {
                Ok(bytes) if bytes.len() <= MAX_EVENT_BYTES => bytes,
                Ok(_) => {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 event túl nagy és karanténba került: {}.",
                        path.display()
                    ));
                    quarantine_and_warn(
                        &mut scan,
                        root,
                        importer_id,
                        &source_device,
                        &path,
                        "event exceeds maximum size",
                    );
                    continue;
                }
                Err(error) => {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 event nem olvasható és karanténba került ({}): {error}.",
                        path.display()
                    ));
                    quarantine_and_warn(
                        &mut scan,
                        root,
                        importer_id,
                        &source_device,
                        &path,
                        &format!("event read failed: {error}"),
                    );
                    continue;
                }
            };
            let event = match serde_json::from_slice::<SyncEvent>(&bytes) {
                Ok(event) => event,
                Err(error) => {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 event JSON-ja hibás és karanténba került ({}): {error}.",
                        path.display()
                    ));
                    quarantine_and_warn(
                        &mut scan,
                        root,
                        importer_id,
                        &source_device,
                        &path,
                        &format!("invalid JSON: {error}"),
                    );
                    continue;
                }
            };
            if let Err(error) = validate_event(&event) {
                scan.blocked_devices.insert(source_device.clone());
                scan.warnings.push(format!(
                    "A v2 event validációja sikertelen és karanténba került ({}): {error}.",
                    path.display()
                ));
                quarantine_and_warn(
                    &mut scan,
                    root,
                    importer_id,
                    &source_device,
                    &path,
                    &format!("event validation failed: {error}"),
                );
                continue;
            }
            if event.device_id != source_device {
                scan.blocked_devices.insert(source_device.clone());
                scan.warnings.push(format!(
                    "A v2 event deviceId-je nem egyezik a mappával: {}.",
                    path.display()
                ));
                quarantine_and_warn(
                    &mut scan,
                    root,
                    importer_id,
                    &source_device,
                    &path,
                    "device id does not match source directory",
                );
                continue;
            }
            if let Some(existing_hash) = event_ids.get(&event.event_id) {
                if existing_hash != &event.event_hash {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 eventId több, eltérő tartalmú fájlban szerepel: {}.",
                        event.event_id
                    ));
                }
                continue;
            }
            event_ids.insert(event.event_id.clone(), event.event_hash.clone());
            let events = device_events.entry(source_device.clone()).or_default();
            if let Some(existing) = events.get(&event.device_sequence) {
                if existing.event_hash != event.event_hash {
                    scan.blocked_devices.insert(source_device.clone());
                    scan.warnings.push(format!(
                        "A v2 device sequence ütközik: {source_device}/{}.",
                        event.device_sequence
                    ));
                }
                continue;
            }
            events.insert(event.device_sequence, event);
        }
    }

    for (device_id, events) in device_events {
        let base_cursor = compaction_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cursors.get(&device_id));
        let events = events
            .into_iter()
            .filter(|(sequence, _)| {
                base_cursor
                    .map(|cursor| *sequence > cursor.sequence)
                    .unwrap_or(true)
            })
            .collect::<BTreeMap<_, _>>();
        if events.is_empty() {
            continue;
        }
        let first_sequence = events.keys().next().copied().unwrap_or_default();
        let (mut expected_sequence, mut previous_hash) = if first_sequence == 1
            && base_cursor.is_none()
        {
            (1_u64, None)
        } else if let Some(cursor) = base_cursor {
            (
                cursor.sequence.saturating_add(1),
                Some(cursor.event_hash.clone()),
            )
        } else {
            scan.blocked_devices.insert(device_id.clone());
            scan.warnings.push(format!(
                "A tömörített v2 eventlánc snapshot-prefix nélkül kezdődik: {device_id}/{first_sequence}."
            ));
            continue;
        };
        for (sequence, event) in events {
            if sequence != expected_sequence {
                scan.blocked_devices.insert(device_id.clone());
                scan.warnings.push(format!(
                    "Hiányzó v2 event sequence: {device_id}, várt {expected_sequence}, kapott {sequence}."
                ));
                break;
            }
            if event.previous_hash != previous_hash {
                scan.blocked_devices.insert(device_id.clone());
                scan.warnings.push(format!(
                    "A v2 hash-lánc megszakadt: {device_id}/{sequence}."
                ));
                break;
            }
            expected_sequence = expected_sequence.saturating_add(1);
            previous_hash = Some(event.event_hash.clone());
            scan.accepted.push(event);
        }
    }

    Ok(scan)
}

fn cursor_from_transaction(
    transaction: &Transaction<'_>,
    device_id: &str,
) -> Result<(u64, Option<String>), String> {
    transaction
        .query_row(
            "SELECT last_sequence, last_hash FROM sync_cursors WHERE source_device_id = ?1",
            params![device_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("A v2 sync cursor nem olvasható: {error}"))
        .map(|value| value.unwrap_or((0, None)))
}

fn apply_events(store: &mut LocalStore, scan: &JournalScan) -> Result<usize, String> {
    let mut accepted_by_device = BTreeMap::<String, Vec<SyncEvent>>::new();
    for event in &scan.accepted {
        if !scan.blocked_devices.contains(&event.device_id) {
            accepted_by_device
                .entry(event.device_id.clone())
                .or_default()
                .push(event.clone());
        }
    }
    let transaction = store
        .connection
        .transaction()
        .map_err(|error| format!("A v2 sync import tranzakciója nem indítható: {error}"))?;
    if let Some(snapshot) = &scan.snapshot {
        let snapshot_json = serde_json::to_string(snapshot).map_err(|error| {
            format!("A compaction snapshot nem menthető a lokális store-ba: {error}")
        })?;
        if snapshot_json.len() as u64 > MAX_COMPACTION_SNAPSHOT_BYTES {
            return Err("A compaction snapshot túl nagy a lokális store számára.".to_string());
        }
        transaction
            .execute(
                "INSERT INTO store_meta (key, value) VALUES ('sync_compaction_snapshot', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![snapshot_json],
            )
            .map_err(|error| {
                format!("A compaction snapshot lokális metaadata nem menthető: {error}")
            })?;
        for (device_id, cursor) in &snapshot.cursors {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO devices (id, name, last_hlc, created_at, updated_at)
                     VALUES (?1, ?2, NULL, ?3, ?3)",
                    params![device_id, format!("v2 sync · {device_id}"), now_text()],
                )
                .map_err(|error| format!("A snapshot eszközének mentése sikertelen: {error}"))?;
            let existing = cursor_from_transaction(&transaction, device_id)?;
            if existing.0 == cursor.sequence
                && existing.1.as_deref() != Some(cursor.event_hash.as_str())
            {
                return Err(format!(
                    "A lokális cursor hash-e nem egyezik a compaction snapshot-tal: {device_id}/{}.",
                    cursor.sequence
                ));
            }
            if existing.0 < cursor.sequence {
                transaction
                    .execute(
                        "INSERT INTO sync_cursors (source_device_id, last_sequence, last_hash, updated_at)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(source_device_id) DO UPDATE SET
                           last_sequence = excluded.last_sequence,
                           last_hash = excluded.last_hash,
                           updated_at = excluded.updated_at",
                        params![device_id, cursor.sequence as i64, cursor.event_hash, now_text()],
                    )
                    .map_err(|error| format!("A snapshot cursorának mentése sikertelen: {error}"))?;
            }
        }
    }
    let mut imported = 0_usize;
    for (device_id, mut events) in accepted_by_device {
        events.sort_by_key(|event| event.device_sequence);
        let (mut last_sequence, mut last_hash) = cursor_from_transaction(&transaction, &device_id)?;
        if last_sequence > 0 {
            let cursor_event = events
                .iter()
                .find(|event| event.device_sequence == last_sequence);
            let snapshot_cursor = scan
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.cursors.get(&device_id));
            let cursor_matches = cursor_event
                .map(|event| event.event_hash.as_str() == last_hash.as_deref().unwrap_or_default())
                .unwrap_or_else(|| {
                    snapshot_cursor
                        .map(|cursor| {
                            cursor.sequence == last_sequence
                                && Some(cursor.event_hash.as_str()) == last_hash.as_deref()
                        })
                        .unwrap_or(false)
                });
            if !cursor_matches {
                return Err(format!(
                    "A v2 sync cursor hash-e nem egyezik a journallal: {device_id}/{last_sequence}."
                ));
            }
        }
        for event in events {
            if event.device_sequence <= last_sequence {
                continue;
            }
            if event.device_sequence != last_sequence.saturating_add(1)
                || event.previous_hash != last_hash
            {
                return Err(format!(
                    "A v2 sync cursor nem folytatható: {device_id}/{}.",
                    event.device_sequence
                ));
            }
            transaction
                .execute(
                    "INSERT OR IGNORE INTO devices (id, name, last_hlc, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![device_id, format!("v2 sync · {device_id}"), event.hlc, now_text()],
                )
                .map_err(|error| format!("A v2 sync eszköz mentése sikertelen: {error}"))?;

            let existing_by_id: Option<String> = transaction
                .query_row(
                    "SELECT event_hash FROM sync_events WHERE event_id = ?1",
                    params![event.event_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| {
                    format!("A v2 event előzményének lekérdezése sikertelen: {error}")
                })?;
            if let Some(existing_hash) = existing_by_id {
                if existing_hash != event.event_hash {
                    return Err(format!(
                        "A v2 eventId tartalma megváltozott: {}.",
                        event.event_id
                    ));
                }
            } else {
                let payload_json = serde_json::to_string(&event.payload)
                    .map_err(|error| format!("A v2 event payloadja nem menthető: {error}"))?;
                transaction
                    .execute(
                        "INSERT INTO sync_events (event_id, device_id, device_sequence, hlc, entity_id, event_type, payload_json, payload_hash, event_hash, previous_hash, imported_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        params![
                            event.event_id,
                            event.device_id,
                            event.device_sequence as i64,
                            event.hlc,
                            event.entity_id,
                            event.event_type,
                            payload_json,
                            event.payload_hash,
                            event.event_hash,
                            event.previous_hash,
                            now_text(),
                        ],
                    )
                    .map_err(|error| format!("A v2 event mentése sikertelen: {error}"))?;
                imported += 1;
            }
            transaction
                .execute(
                    "INSERT INTO sync_cursors (source_device_id, last_sequence, last_hash, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(source_device_id) DO UPDATE SET
                       last_sequence = excluded.last_sequence,
                       last_hash = excluded.last_hash,
                       updated_at = excluded.updated_at",
                    params![device_id, event.device_sequence as i64, event.event_hash, now_text()],
                )
                .map_err(|error| format!("A v2 sync cursor mentése sikertelen: {error}"))?;
            last_sequence = event.device_sequence;
            last_hash = Some(event.event_hash);
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("A v2 sync import commitja sikertelen: {error}"))?;
    Ok(imported)
}

fn import_into_store(
    root: &Path,
    importer_id: &str,
    store: &mut LocalStore,
) -> Result<SyncImportReport, String> {
    let scan = scan_journal(root, importer_id)?;
    let accepted_events = scan.accepted.len();
    let imported_events = apply_events(store, &scan)?;
    let mut blocked_devices = scan.blocked_devices.into_iter().collect::<Vec<_>>();
    blocked_devices.sort();
    Ok(SyncImportReport {
        scanned_events: scan.scanned_events,
        accepted_events,
        imported_events,
        can_write: blocked_devices.is_empty() && scan.warnings.is_empty(),
        blocked_devices,
        warnings: scan.warnings,
    })
}

fn is_recoverable_cursor_mismatch(error: &str) -> bool {
    error.contains("sync cursor hash")
        || error.contains("sync cursor nem folytathat")
        || error.contains("cursor hash-e nem egyezik")
}

fn build_sync_health(
    root: &Path,
    connection: &Connection,
    report: &SyncImportReport,
) -> Result<SyncHealth, String> {
    let stored_events = connection
        .query_row("SELECT COUNT(*) FROM sync_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| format!("A v2 sync tárolt event-száma nem olvasható: {error}"))?
        as usize;
    let last_import_at = connection
        .query_row("SELECT MAX(updated_at) FROM sync_cursors", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|error| format!("A v2 sync utolsó importideje nem olvasható: {error}"))?;
    let quarantined = !report.can_write || !report.warnings.is_empty();
    let status = if quarantined {
        "quarantine"
    } else if report.scanned_events == 0 {
        "empty"
    } else {
        "healthy"
    };
    let recovery_action = if report
        .warnings
        .iter()
        .any(|warning| warning.contains("helyi sync cursor"))
    {
        "A OneDrive journal előzménye hiányzik vagy újraindult. A lokális SQLite snapshot megmaradt, de a távoli írás blokkolva van; a journal korábbi eventjeit vagy egy érvényes compaction snapshotot kell visszaállítani, majd újraellenőrizni."
    } else if quarantined {
        "Az írás tiltva marad. Ellenőrizd a warnings listát és a quarantine mappát; a hibás event javítása vagy eltávolítása után futtasd újra az importot."
    } else if report.scanned_events == 0 {
        "Nincs OneDrive-on elérhető v2 event. Az első mentés új journal eventeket fog létrehozni."
    } else {
        "Nincs teendő. A journal validált és írható."
    };
    Ok(SyncHealth {
        status: status.to_string(),
        journal_path: root.join("events").to_string_lossy().to_string(),
        quarantine_path: root.join("quarantine").to_string_lossy().to_string(),
        checked_at: now_text(),
        last_import_at,
        scanned_events: report.scanned_events,
        accepted_events: report.accepted_events,
        imported_events: report.imported_events,
        stored_events,
        blocked_devices: report.blocked_devices.clone(),
        warnings: report.warnings.clone(),
        can_write: report.can_write,
        recovery_action: recovery_action.to_string(),
    })
}

fn read_compaction_snapshot_from_connection(
    connection: &Connection,
) -> Result<Option<CompactionSnapshot>, String> {
    let has_store_meta: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_meta')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("A lokális store meta-táblája nem ellenőrizhető: {error}"))?;
    if !has_store_meta {
        return Ok(None);
    }
    let value = connection
        .query_row(
            "SELECT value FROM store_meta WHERE key = 'sync_compaction_snapshot'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("A lokális compaction snapshot nem olvasható: {error}"))?;
    match value {
        None => Ok(None),
        Some(value) => {
            let snapshot = serde_json::from_str::<CompactionSnapshot>(&value)
                .map_err(|error| format!("A lokális compaction snapshot JSON-ja hibás: {error}"))?;
            match validate_compaction_snapshot(&snapshot) {
                Ok(()) => Ok(Some(snapshot)),
                Err(error) if is_recoverable_compaction_snapshot_error(&error) => Ok(None),
                Err(error) => Err(error),
            }
        }
    }
}

fn read_events(connection: &Connection) -> Result<Vec<SyncEvent>, String> {
    let compaction_snapshot = read_compaction_snapshot_from_connection(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT event_id, device_id, device_sequence, hlc, entity_id, event_type, payload_json, payload_hash, event_hash, previous_hash
             FROM sync_events ORDER BY hlc, device_id, device_sequence",
        )
        .map_err(|error| format!("A v2 eventek lekérdezése sikertelen: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let payload_json: String = row.get(6)?;
            Ok(SyncEvent {
                schema_version: EVENT_SCHEMA_VERSION,
                event_id: row.get(0)?,
                device_id: row.get(1)?,
                device_sequence: row.get::<_, i64>(2)? as u64,
                hlc: row.get(3)?,
                entity_id: row.get(4)?,
                event_type: row.get(5)?,
                payload: serde_json::from_str(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        6,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                payload_hash: row.get(7)?,
                event_hash: row.get(8)?,
                previous_hash: row.get(9)?,
            })
        })
        .map_err(|error| format!("A v2 eventek bejárása sikertelen: {error}"))?;
    let mut events = Vec::new();
    for row in rows {
        let event = row.map_err(|error| format!("A v2 event rekordja hibás: {error}"))?;
        validate_event(&event)?;
        if compaction_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.cursors.get(&event.device_id))
            .is_some_and(|cursor| event.device_sequence <= cursor.sequence)
        {
            continue;
        }
        events.push(event);
    }
    Ok(events)
}

fn event_rank(event: &SyncEvent) -> EventRank {
    EventRank {
        hlc: event.hlc.clone(),
        device_id: event.device_id.clone(),
        sequence: event.device_sequence,
    }
}

fn compaction_baseline_rank() -> EventRank {
    EventRank {
        hlc: "00000000000000000000-00000000".to_string(),
        device_id: "00000000-0000-0000-0000-000000000000".to_string(),
        sequence: 0,
    }
}

fn seed_reducer_from_compaction_snapshot(
    snapshot: &CompactionSnapshot,
    projects: &mut BTreeMap<String, ProjectAccumulator>,
    conversations: &mut BTreeMap<String, ConversationAccumulator>,
    tombstones: &mut BTreeMap<(String, String), (EventRank, bool, TombstoneEventPayload)>,
) {
    let rank = compaction_baseline_rank();
    for project in &snapshot.state.projects {
        projects.insert(
            project.id.clone(),
            ProjectAccumulator {
                value: project.clone(),
                rank: rank.clone(),
                threads: project.threads.iter().cloned().collect(),
            },
        );
    }
    for conversation in snapshot.state.conversations.values() {
        let conversation_id = normalized_conversation_id(&conversation.project_id, conversation);
        let value = ConversationEventPayload {
            id: conversation_id.clone(),
            project_id: conversation.project_id.clone(),
            title: conversation.title.clone(),
            thread_id: conversation.thread_id.clone(),
            updated_at: conversation.updated_at.clone(),
            plan_history: conversation.plan_history.clone(),
            commentary: conversation.commentary.clone(),
        };
        let mut accumulator = ConversationAccumulator {
            value,
            rank: rank.clone(),
            placeholder: false,
            titles: [conversation.title.clone()].into_iter().collect(),
            messages: BTreeMap::new(),
            work_items: BTreeMap::new(),
        };
        for (index, message) in conversation.messages.iter().enumerate() {
            let message_id = normalized_message_id(&conversation_id, message, index);
            accumulator
                .messages
                .insert(message_id, (rank.clone(), message.clone()));
        }
        for (index, item) in conversation.work_items.iter().enumerate() {
            let item_id = normalized_work_item_id(&conversation_id, item, index);
            accumulator
                .work_items
                .insert(item_id, (rank.clone(), item.clone()));
        }
        conversations.insert(conversation_id, accumulator);
    }
    for tombstone in &snapshot.state.tombstones {
        let key = (tombstone.entity_type.clone(), tombstone.entity_id.clone());
        tombstones.insert(
            key,
            (
                rank.clone(),
                true,
                TombstoneEventPayload {
                    entity_type: tombstone.entity_type.clone(),
                    entity_id: tombstone.entity_id.clone(),
                    archived_at: tombstone.archived_at.clone(),
                    project_id: tombstone.project_id.clone(),
                    title: tombstone.title.clone(),
                    relative_path: tombstone.relative_path.clone(),
                    path_hint: tombstone.path_hint.clone(),
                    reason: tombstone.reason.clone(),
                },
            ),
        );
    }
}

fn reduce_snapshot(connection: &Connection) -> Result<LocalStoreSnapshot, String> {
    let events = read_events(connection)?;
    let mut projects = BTreeMap::<String, ProjectAccumulator>::new();
    let mut conversations = BTreeMap::<String, ConversationAccumulator>::new();
    let mut tombstones =
        BTreeMap::<(String, String), (EventRank, bool, TombstoneEventPayload)>::new();
    let project_aliases = events
        .iter()
        .filter(|event| event.event_type == PROJECT_UPSERT)
        .filter_map(|event| {
            serde_json::from_value::<LocalProject>(event.payload.clone())
                .ok()
                .map(|project| (project.id.clone(), normalized_project_id(&project)))
        })
        .collect::<HashMap<_, _>>();

    if let Some(snapshot) = read_compaction_snapshot_from_connection(connection)? {
        seed_reducer_from_compaction_snapshot(
            &snapshot,
            &mut projects,
            &mut conversations,
            &mut tombstones,
        );
    }

    for event in events {
        let rank = event_rank(&event);
        match event.event_type.as_str() {
            PROJECT_UPSERT => {
                let mut project: LocalProject = serde_json::from_value(event.payload)
                    .map_err(|error| format!("A project event nem redukálható: {error}"))?;
                project.id = project_aliases
                    .get(&project.id)
                    .cloned()
                    .unwrap_or_else(|| normalized_project_id(&project));
                let entry =
                    projects
                        .entry(project.id.clone())
                        .or_insert_with(|| ProjectAccumulator {
                            value: project.clone(),
                            rank: rank.clone(),
                            threads: BTreeSet::new(),
                        });
                entry.threads.extend(project.threads.iter().cloned());
                if rank > entry.rank {
                    entry.value = project;
                    entry.rank = rank;
                }
            }
            CONVERSATION_UPSERT => {
                let mut conversation: ConversationEventPayload =
                    serde_json::from_value(event.payload).map_err(|error| {
                        format!("A conversation event nem redukálható: {error}")
                    })?;
                if let Some(project_id) = project_aliases.get(&conversation.project_id) {
                    conversation.project_id = project_id.clone();
                }
                let entry = conversations
                    .entry(conversation.id.clone())
                    .or_insert_with(|| ConversationAccumulator {
                        value: conversation.clone(),
                        rank: rank.clone(),
                        placeholder: false,
                        titles: BTreeSet::new(),
                        messages: BTreeMap::new(),
                        work_items: BTreeMap::new(),
                    });
                entry.titles.insert(conversation.title.clone());
                if entry.placeholder || rank > entry.rank {
                    let mut plan_history = entry.value.plan_history.clone();
                    plan_history.extend(conversation.plan_history);
                    conversation.plan_history = plan_history;

                    let mut commentary = entry.value.commentary.clone();
                    for item in conversation.commentary.drain(..) {
                        let item_id = item.get("id").and_then(Value::as_str);
                        if let Some(item_id) = item_id {
                            if let Some(existing) = commentary.iter_mut().find(|existing| {
                                existing.get("id").and_then(Value::as_str) == Some(item_id)
                            }) {
                                *existing = item;
                                continue;
                            }
                        }
                        if !commentary.contains(&item) {
                            commentary.push(item);
                        }
                    }
                    conversation.commentary = commentary;
                    entry.value = conversation;
                    entry.rank = rank;
                    entry.placeholder = false;
                }
            }
            MESSAGE_UPSERT => {
                let mut message: MessageEventPayload = serde_json::from_value(event.payload)
                    .map_err(|error| format!("A message event nem redukálható: {error}"))?;
                if let Some(project_id) = project_aliases.get(&message.project_id) {
                    message.project_id = project_id.clone();
                }
                let entry = conversations
                    .entry(message.conversation_id.clone())
                    .or_insert_with(|| ConversationAccumulator {
                        value: ConversationEventPayload {
                            id: message.conversation_id.clone(),
                            project_id: message.project_id.clone(),
                            title: "Importált beszélgetés".to_string(),
                            thread_id: None,
                            updated_at: now_text(),
                            plan_history: BTreeMap::new(),
                            commentary: Vec::new(),
                        },
                        rank: rank.clone(),
                        placeholder: true,
                        titles: BTreeSet::new(),
                        messages: BTreeMap::new(),
                        work_items: BTreeMap::new(),
                    });
                let should_replace = entry
                    .messages
                    .get(&event.entity_id)
                    .map(|(existing_rank, _)| rank > *existing_rank)
                    .unwrap_or(true);
                if should_replace {
                    let mut normalized_message = message.message;
                    normalized_message.hlc = Some(event.hlc.clone());
                    normalized_message.origin_device_id = Some(event.device_id.clone());
                    entry
                        .messages
                        .insert(event.entity_id, (rank, normalized_message));
                }
            }
            WORK_ITEM_UPSERT => {
                let mut item: WorkItemEventPayload = serde_json::from_value(event.payload)
                    .map_err(|error| format!("A work item event nem redukálható: {error}"))?;
                if let Some(project_id) = project_aliases.get(&item.project_id) {
                    item.project_id = project_id.clone();
                }
                let entry = conversations
                    .entry(item.conversation_id.clone())
                    .or_insert_with(|| ConversationAccumulator {
                        value: ConversationEventPayload {
                            id: item.conversation_id.clone(),
                            project_id: item.project_id.clone(),
                            title: "Importált beszélgetés".to_string(),
                            thread_id: None,
                            updated_at: now_text(),
                            plan_history: BTreeMap::new(),
                            commentary: Vec::new(),
                        },
                        rank: rank.clone(),
                        placeholder: true,
                        titles: BTreeSet::new(),
                        messages: BTreeMap::new(),
                        work_items: BTreeMap::new(),
                    });
                let should_replace = entry
                    .work_items
                    .get(&event.entity_id)
                    .map(|(existing_rank, _)| rank > *existing_rank)
                    .unwrap_or(true);
                if should_replace {
                    let mut normalized_item = item.item;
                    normalized_item.hlc = Some(event.hlc.clone());
                    normalized_item.origin_device_id = Some(event.device_id.clone());
                    entry
                        .work_items
                        .insert(event.entity_id, (rank, normalized_item));
                }
            }
            TOMBSTONE_UPSERT | ENTITY_RESTORE => {
                let mut tombstone: TombstoneEventPayload = serde_json::from_value(event.payload)
                    .map_err(|error| {
                        format!("A tombstone/restore event nem redukálható: {error}")
                    })?;
                if tombstone.entity_type == "project" {
                    let identity = tombstone
                        .relative_path
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            tombstone
                                .path_hint
                                .as_deref()
                                .filter(|value| !value.trim().is_empty())
                        });
                    if let Some(identity) = identity {
                        tombstone.entity_id = stable_id("project", &identity.to_lowercase());
                    }
                }
                if let Some(project_id) = tombstone
                    .project_id
                    .as_ref()
                    .and_then(|project_id| project_aliases.get(project_id))
                {
                    tombstone.project_id = Some(project_id.clone());
                }
                let key = (tombstone.entity_type.clone(), tombstone.entity_id.clone());
                let should_replace = tombstones
                    .get(&key)
                    .map(|(existing_rank, _, _)| rank > *existing_rank)
                    .unwrap_or(true);
                if should_replace {
                    tombstones.insert(key, (rank, event.event_type == TOMBSTONE_UPSERT, tombstone));
                }
            }
            _ => {
                return Err(format!(
                    "Ismeretlen v2 event a reducerben: {}",
                    event.event_type
                ))
            }
        }
    }

    let mut project_threads = BTreeMap::<String, BTreeSet<String>>::new();
    for project in projects.values() {
        project_threads
            .entry(project.value.id.clone())
            .or_default()
            // Project snapshots are an add-only fallback for legacy events
            // without conversation identities. Keep their union so offline
            // devices converge; renamed conversation titles are removed below
            // using the stable conversation ID history.
            .extend(project.threads.iter().cloned());
    }
    let mut current_conversation_titles = BTreeMap::<String, BTreeSet<String>>::new();
    let mut retired_conversation_titles = BTreeMap::<String, BTreeSet<String>>::new();
    for conversation in conversations.values() {
        let project_archived = tombstones
            .get(&("project".to_string(), conversation.value.project_id.clone()))
            .map(|(_, archived, _)| *archived)
            .unwrap_or(false);
        let conversation_archived = tombstones
            .get(&("conversation".to_string(), conversation.value.id.clone()))
            .map(|(_, archived, _)| *archived)
            .unwrap_or(false);
        if project_archived || conversation_archived {
            continue;
        }
        current_conversation_titles
            .entry(conversation.value.project_id.clone())
            .or_default()
            .insert(conversation.value.title.clone());
        retired_conversation_titles
            .entry(conversation.value.project_id.clone())
            .or_default()
            .extend(
                conversation
                    .titles
                    .iter()
                    .filter(|title| *title != &conversation.value.title)
                    .cloned(),
            );
    }
    for (project_id, current_titles) in current_conversation_titles {
        let threads = project_threads.entry(project_id.clone()).or_default();
        if let Some(retired_titles) = retired_conversation_titles.get(&project_id) {
            // A retired name can legitimately be reused by another current
            // conversation, in which case it must remain visible.
            threads
                .retain(|title| !retired_titles.contains(title) || current_titles.contains(title));
        }
        threads.extend(current_titles);
    }

    let mut project_ids = BTreeSet::new();
    project_ids.extend(projects.keys().cloned());
    project_ids.extend(
        conversations
            .values()
            .map(|conversation| conversation.value.project_id.clone()),
    );

    let mut output_projects = Vec::new();
    let mut output_conversations = BTreeMap::new();
    for project_id in project_ids {
        if tombstones
            .get(&("project".to_string(), project_id.clone()))
            .map(|(_, archived, _)| *archived)
            .unwrap_or(false)
        {
            continue;
        }
        let mut project = projects
            .remove(&project_id)
            .map(|entry| entry.value)
            .unwrap_or_else(|| LocalProject {
                id: project_id.clone(),
                name: "Importált projekt".to_string(),
                relative_path: None,
                path_hint: String::new(),
                threads: Vec::new(),
            });
        let mut threads = project.threads.into_iter().collect::<BTreeSet<_>>();
        threads.extend(project_threads.remove(&project_id).unwrap_or_default());
        threads.retain(|thread| {
            !tombstones.values().any(|(_, archived, tombstone)| {
                *archived
                    && tombstone.entity_type == "conversation"
                    && tombstone.project_id.as_deref() == Some(project_id.as_str())
                    && tombstone.title.as_deref() == Some(thread.as_str())
            })
        });
        project.threads = threads.into_iter().collect();
        output_projects.push(project);

        for conversation in conversations.values().filter(|conversation| {
            conversation.value.project_id == project_id
                && !tombstones
                    .get(&("conversation".to_string(), conversation.value.id.clone()))
                    .map(|(_, archived, _)| *archived)
                    .unwrap_or(false)
        }) {
            let mut messages = conversation
                .messages
                .values()
                .map(|(_, message)| message.clone())
                .collect::<Vec<_>>();
            messages.sort_by(|left, right| {
                left.sequence
                    .unwrap_or(i64::MAX)
                    .cmp(&right.sequence.unwrap_or(i64::MAX))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let mut work_items = conversation
                .work_items
                .values()
                .map(|(_, item)| item.clone())
                .collect::<Vec<_>>();
            work_items.sort_by(|left, right| left.id.cmp(&right.id));
            let value = &conversation.value;
            output_conversations.insert(
                format!("{}::{}", value.project_id, value.title),
                LocalConversation {
                    id: Some(value.id.clone()),
                    project_id: value.project_id.clone(),
                    title: value.title.clone(),
                    messages,
                    work_items,
                    thread_id: value.thread_id.clone(),
                    updated_at: value.updated_at.clone(),
                    plan_history: value.plan_history.clone(),
                    commentary: value.commentary.clone(),
                },
            );
        }
    }

    let mut output_tombstones = tombstones
        .into_values()
        .filter(|(_, archived, _)| *archived)
        .map(|(_, _, tombstone)| LocalTombstone {
            entity_type: tombstone.entity_type,
            entity_id: tombstone.entity_id,
            archived_at: tombstone.archived_at,
            project_id: tombstone.project_id,
            title: tombstone.title,
            relative_path: tombstone.relative_path,
            path_hint: tombstone.path_hint,
            reason: tombstone.reason,
        })
        .collect::<Vec<_>>();
    output_tombstones.sort_by(|left, right| {
        left.entity_type
            .cmp(&right.entity_type)
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });

    Ok(LocalStoreSnapshot {
        schema_version: STORE_SCHEMA_VERSION,
        projects: output_projects,
        conversations: output_conversations,
        tombstones: output_tombstones,
    })
}

fn normalized_project_id(project: &LocalProject) -> String {
    let identity = project
        .relative_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| (!project.path_hint.trim().is_empty()).then_some(project.path_hint.as_str()));
    match identity {
        Some(identity) => {
            let canonical_id = stable_id("project", &identity.to_lowercase());
            let local_store_id = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("min:local:project:{}", identity).as_bytes(),
            )
            .to_string();
            if !Uuid::parse_str(&project.id).is_ok()
                || project.id == canonical_id
                || project.id == local_store_id
            {
                canonical_id
            } else {
                project.id.clone()
            }
        }
        None if Uuid::parse_str(&project.id).is_ok() => project.id.clone(),
        None => stable_id("project", &project.id.to_lowercase()),
    }
}

fn normalized_conversation_id(project_id: &str, conversation: &LocalConversation) -> String {
    conversation
        .id
        .as_deref()
        .filter(|value| Uuid::parse_str(value).is_ok())
        .map(str::to_string)
        .unwrap_or_else(|| {
            stable_id(
                "conversation",
                &format!("{project_id}:{}", conversation.title),
            )
        })
}

fn normalized_message_id(conversation_id: &str, message: &LocalMessage, index: usize) -> String {
    message
        .id
        .as_deref()
        .filter(|value| Uuid::parse_str(value).is_ok())
        .map(str::to_string)
        .unwrap_or_else(|| {
            stable_id(
                "message",
                &format!(
                    "{conversation_id}:{}:{}:{}:{}:{}",
                    message.sequence.unwrap_or(index as i64),
                    message.role,
                    message.time,
                    message.text,
                    index
                ),
            )
        })
}

fn normalized_work_item_id(conversation_id: &str, item: &LocalWorkItem, index: usize) -> String {
    let identity = item
        .item_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("{conversation_id}:item:{value}"))
        .unwrap_or_else(|| {
            format!(
                "{conversation_id}:{}:{}:{}:{}:{}",
                item.id, item.event_type, item.detail, item.time, index
            )
        });
    stable_id("work-item", &identity)
}

fn sanitized_work_item(item: &LocalWorkItem) -> LocalWorkItem {
    let mut sanitized = item.clone();
    sanitized.body = None;
    sanitized.code = None;
    sanitized.before_code = None;
    sanitized.after_code = None;
    if sanitized.detail.chars().count() > 2000 {
        sanitized.detail = sanitized.detail.chars().take(2000).collect();
        sanitized.detail.push('…');
    }
    sanitized
}

fn normalized_tombstone(
    tombstone: &LocalTombstone,
    project_ids: &HashMap<String, String>,
) -> Result<(String, TombstoneEventPayload), String> {
    if !matches!(tombstone.entity_type.as_str(), "project" | "conversation") {
        return Err(format!(
            "Ismeretlen tombstone entitástípus: {}.",
            tombstone.entity_type
        ));
    }
    let normalized_project_id = tombstone.project_id.as_deref().map(|project_id| {
        project_ids.get(project_id).cloned().unwrap_or_else(|| {
            if Uuid::parse_str(project_id).is_ok() {
                project_id.to_string()
            } else {
                stable_id("project", &project_id.to_lowercase())
            }
        })
    });
    let entity_id = if tombstone.entity_type == "project" {
        let identity = tombstone
            .relative_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                tombstone
                    .path_hint
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
            });
        match identity {
            Some(identity) => stable_id("project", &identity.to_lowercase()),
            None if Uuid::parse_str(&tombstone.entity_id).is_ok() => tombstone.entity_id.clone(),
            None => stable_id("project", &tombstone.entity_id.to_lowercase()),
        }
    } else if Uuid::parse_str(&tombstone.entity_id).is_ok() {
        tombstone.entity_id.clone()
    } else {
        let project_id = normalized_project_id
            .as_deref()
            .ok_or_else(|| "A conversation tombstone projektazonosítója hiányzik.".to_string())?;
        stable_id(
            "conversation",
            &format!(
                "{project_id}:{}",
                tombstone.title.as_deref().unwrap_or(&tombstone.entity_id)
            ),
        )
    };
    let payload = TombstoneEventPayload {
        entity_type: tombstone.entity_type.clone(),
        entity_id: entity_id.clone(),
        archived_at: if tombstone.archived_at.trim().is_empty() {
            now_text()
        } else {
            tombstone.archived_at.clone()
        },
        project_id: normalized_project_id,
        title: tombstone.title.clone(),
        relative_path: tombstone.relative_path.clone(),
        path_hint: tombstone.path_hint.clone(),
        reason: tombstone.reason.clone(),
    };
    Ok((entity_id, payload))
}

fn canonicalize_snapshot_for_compaction(
    snapshot: LocalStoreSnapshot,
) -> Result<LocalStoreSnapshot, String> {
    let mut project_ids = HashMap::<String, String>::new();
    let mut projects = Vec::with_capacity(snapshot.projects.len());
    for mut project in snapshot.projects {
        let original_id = project.id.clone();
        let canonical_id = normalized_project_id(&project);
        project.id = canonical_id.clone();
        project.threads = project
            .threads
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        project_ids.insert(original_id, canonical_id);
        projects.push(project);
    }

    let mut conversations = BTreeMap::new();
    let mut seen_conversation_ids = HashSet::new();
    for (_, mut conversation) in snapshot.conversations {
        let project_id = project_ids
            .get(&conversation.project_id)
            .cloned()
            .unwrap_or_else(|| conversation.project_id.clone());
        conversation.project_id = project_id.clone();
        let mut conversation_id = normalized_conversation_id(&project_id, &conversation);
        if !seen_conversation_ids.insert(conversation_id.clone()) {
            conversation_id = stable_id(
                "conversation",
                &format!("{}:{}", project_id, conversation.title),
            );
            if !seen_conversation_ids.insert(conversation_id.clone()) {
                return Err(format!(
                    "A compaction snapshotban ütköző conversation ID maradt: {}.",
                    conversation.title
                ));
            }
        }
        conversation.id = Some(conversation_id);
        conversations.insert(
            format!("{}::{}", conversation.project_id, conversation.title),
            conversation,
        );
    }

    let mut tombstones = Vec::with_capacity(snapshot.tombstones.len());
    for tombstone in snapshot.tombstones {
        let (entity_id, payload) = normalized_tombstone(&tombstone, &project_ids)?;
        tombstones.push(LocalTombstone {
            entity_type: payload.entity_type,
            entity_id,
            archived_at: payload.archived_at,
            project_id: payload.project_id,
            title: payload.title,
            relative_path: payload.relative_path,
            path_hint: payload.path_hint,
            reason: payload.reason,
        });
    }

    Ok(LocalStoreSnapshot {
        schema_version: STORE_SCHEMA_VERSION,
        projects,
        conversations,
        tombstones,
    })
}

fn tombstone_label(tombstone: &LocalTombstone) -> String {
    tombstone
        .title
        .clone()
        .or_else(|| tombstone.relative_path.clone())
        .or_else(|| tombstone.path_hint.clone())
        .unwrap_or_else(|| tombstone.entity_id.clone())
}

fn tombstone_target_path(tombstone: &LocalTombstone) -> Option<String> {
    tombstone
        .path_hint
        .clone()
        .or_else(|| tombstone.relative_path.clone())
}

fn current_tombstone(
    snapshot: &LocalStoreSnapshot,
    tombstone: &LocalTombstone,
    entity_id: &str,
) -> Option<LocalTombstone> {
    snapshot
        .tombstones
        .iter()
        .find(|candidate| {
            candidate.entity_type == tombstone.entity_type
                && (candidate.entity_id == entity_id
                    || normalized_tombstone(candidate, &HashMap::new())
                        .map(|(candidate_id, _)| candidate_id == entity_id)
                        .unwrap_or(false))
        })
        .cloned()
}

fn build_restore_preview(
    tombstone: &LocalTombstone,
    snapshot: &LocalStoreSnapshot,
    health: SyncHealth,
) -> Result<SyncRestorePreview, String> {
    let (entity_id, _) = normalized_tombstone(tombstone, &HashMap::new())?;
    let current = current_tombstone(snapshot, tombstone, &entity_id);
    let source = current.as_ref().unwrap_or(tombstone);
    let mut warnings = Vec::new();
    if source.path_hint.is_none() && source.relative_path.is_none() {
        warnings.push("Az eredeti útvonal nincs meg a recovery metadata-ban.".to_string());
    }
    warnings.push(
        "A restore a journal állapotát állítja vissza; a projektfájlokat nem módosítja és nem hozza létre."
            .to_string(),
    );
    let effects = vec![
        "Egy entity.restore event kerül a közös append-only journalba.".to_string(),
        "Az entitás újra látható lesz minden gépen, amelyik beolvassa ezt az eventet.".to_string(),
        "A korábbi üzenetek és work itemek megmaradnak a journalban.".to_string(),
    ];
    let blocking_reason = if !health.can_write {
        Some("A journal jelenleg karanténban van; restore event nem írható.".to_string())
    } else if current.is_none() {
        Some("Ez az entitás már nincs archivált állapotban; valószínűleg egy másik gép már visszaállította.".to_string())
    } else {
        None
    };
    Ok(SyncRestorePreview {
        entity_type: source.entity_type.clone(),
        entity_id,
        label: tombstone_label(source),
        archived_at: source.archived_at.clone(),
        target_path: tombstone_target_path(source),
        can_restore: blocking_reason.is_none(),
        blocking_reason,
        warnings,
        effects,
        health,
    })
}

fn retention_candidate(tombstone: &LocalTombstone, now: u64) -> SyncRetentionCandidate {
    let age_days = tombstone
        .archived_at
        .parse::<u64>()
        .ok()
        .map(|archived_at| now.saturating_sub(archived_at) / MILLIS_PER_DAY)
        .map(|days| days as i64);
    let eligible = age_days.is_some_and(|days| days >= TOMBSTONE_RETENTION_DAYS);
    let reason = match age_days {
        None => "Az archiválási időpont hibás; retention alapján nem purge-olható.".to_string(),
        Some(days) if days < TOMBSTONE_RETENTION_DAYS => format!(
            "A {} napos retention még nem telt le ({} nap).",
            TOMBSTONE_RETENTION_DAYS, days
        ),
        Some(_) => "A retention letelt, de a közös journal purge-je külön backup/ack protokoll nélkül tiltott.".to_string(),
    };
    SyncRetentionCandidate {
        selection_key: retention_selection_key(&tombstone.entity_type, &tombstone.entity_id),
        entity_type: tombstone.entity_type.clone(),
        entity_id: tombstone.entity_id.clone(),
        label: tombstone_label(tombstone),
        archived_at: tombstone.archived_at.clone(),
        age_days,
        eligible,
        reason,
    }
}

fn retention_selection_key(entity_type: &str, entity_id: &str) -> String {
    format!("{entity_type}:{entity_id}")
}

struct RetentionRuntime {
    device_id: String,
    root: PathBuf,
    report: SyncImportReport,
    health: SyncHealth,
    snapshot: LocalStoreSnapshot,
    scan: JournalScan,
}

fn load_retention_runtime() -> Result<RetentionRuntime, String> {
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;
    let report = import_into_store(&root, &device_id, &mut local_store)?;
    let health = build_sync_health(&root, &local_store.connection, &report)?;
    let snapshot = reduce_snapshot(&local_store.connection)?;
    let scan = scan_journal(&root, &device_id)?;
    Ok(RetentionRuntime {
        device_id,
        root,
        report,
        health,
        snapshot,
        scan,
    })
}

fn build_retention_preview(runtime: &RetentionRuntime) -> Result<SyncRetentionPreview, String> {
    let device_id = &runtime.device_id;
    let root = &runtime.root;
    let report = &runtime.report;
    let health = &runtime.health;
    let snapshot = &runtime.snapshot;
    let scan = &runtime.scan;
    let mut candidates = snapshot
        .tombstones
        .iter()
        .map(|tombstone| retention_candidate(tombstone, now_millis()))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .age_days
            .cmp(&left.age_days)
            .then_with(|| left.entity_type.cmp(&right.entity_type))
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    let eligible_count = candidates
        .iter()
        .filter(|candidate| candidate.eligible)
        .count();
    let current_journal_digest = journal_digest_for_scan(scan);
    let current_event_count = journal_event_count_for_scan(scan);
    let compaction_snapshot_id = scan
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.snapshot_id.clone());
    let compaction_created_at = scan
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.created_at.clone());
    let (acks, mut metadata_warnings) = read_retention_acks(&root);
    let (backups, backup_warnings) = read_retention_backups(&root);
    metadata_warnings.extend(backup_warnings);
    let (audit, audit_warnings) = read_retention_audit(&root);
    metadata_warnings.extend(audit_warnings);

    let mut known_devices = BTreeSet::new();
    known_devices.insert(device_id.clone());
    for event in &scan.accepted {
        known_devices.insert(event.device_id.clone());
    }
    known_devices.extend(acks.keys().cloned());
    known_devices.extend(backups.keys().cloned());

    let mut devices = Vec::new();
    let mut missing_acks = Vec::new();
    let mut backup_available = false;
    for known_device in known_devices {
        let ack = acks.get(&known_device);
        let backup = backups.get(&known_device);
        let ack_matches = ack.is_some_and(|ack| {
            ack.journal_digest == current_journal_digest && ack.event_count == current_event_count
        });
        let backup_matches = backup.is_some_and(|backup| {
            backup.verified
                && backup.journal_digest == current_journal_digest
                && backup.event_count == current_event_count
        });
        if !ack_matches {
            missing_acks.push(known_device.clone());
        }
        backup_available |= backup_matches;
        devices.push(SyncRetentionDevice {
            device_id: known_device,
            acked_at: ack.map(|value| value.created_at.clone()),
            acked_event_count: ack.map(|value| value.event_count).unwrap_or_default(),
            acked_journal_digest: ack.map(|value| value.journal_digest.clone()),
            backup_at: backup.map(|value| value.created_at.clone()),
            backup_event_count: backup.map(|value| value.event_count).unwrap_or_default(),
            backup_journal_digest: backup.map(|value| value.journal_digest.clone()),
            backup_verified: backup_matches,
            ready: ack_matches,
        });
    }
    devices.sort_by(|left, right| left.device_id.cmp(&right.device_id));
    missing_acks.sort();

    let mut blocking_reasons = Vec::new();
    if eligible_count == 0 {
        blocking_reasons.push(format!(
            "Nincs {} napnál régebbi archivált entitás.",
            TOMBSTONE_RETENTION_DAYS
        ));
    } else {
        if !health.can_write || !report.can_write {
            blocking_reasons.push(
                "A journal karanténban van vagy hiányos; retention művelet nem engedélyezhető."
                    .to_string(),
            );
        }
        if !missing_acks.is_empty() {
            blocking_reasons.push(format!(
                "Hiányzó vagy elavult ACK: {}.",
                missing_acks.join(", ")
            ));
        }
        if !backup_available {
            blocking_reasons.push(
                "A jelenlegi journal-digesthez nincs igazolt, külön backup-manifest.".to_string(),
            );
        }
    }
    for warning in metadata_warnings {
        blocking_reasons.push(format!("Retention metadata warning: {warning}"));
    }
    let protocol_ready = eligible_count > 0
        && health.can_write
        && report.can_write
        && missing_acks.is_empty()
        && backup_available
        && !blocking_reasons
            .iter()
            .any(|reason| reason.starts_with("Retention metadata warning:"));
    if protocol_ready {
        blocking_reasons.push(
            "Az ACK/backup gate teljesült; az explicit snapshot + purge művelet elindítható."
                .to_string(),
        );
    }

    Ok(SyncRetentionPreview {
        snapshot: snapshot.clone(),
        health: health.clone(),
        retention_days: TOMBSTONE_RETENTION_DAYS,
        candidates,
        eligible_count,
        protocol_ready,
        current_event_count,
        current_journal_digest,
        compaction_snapshot_id,
        compaction_created_at,
        devices,
        audit,
        purge_allowed: protocol_ready,
        blocking_reasons,
    })
}

fn prune_snapshot_for_compaction(
    snapshot: &LocalStoreSnapshot,
    candidates: &[SyncRetentionCandidate],
) -> LocalStoreSnapshot {
    prune_snapshot_for_compaction_selected(snapshot, candidates, None)
}

fn prune_snapshot_for_compaction_selected(
    snapshot: &LocalStoreSnapshot,
    candidates: &[SyncRetentionCandidate],
    selected: Option<&HashSet<String>>,
) -> LocalStoreSnapshot {
    let candidate_is_selected = |candidate: &SyncRetentionCandidate| {
        candidate.eligible
            && selected
                .map(|keys| keys.contains(&candidate.selection_key))
                .unwrap_or(true)
    };
    let purged_projects = candidates
        .iter()
        .filter(|candidate| candidate_is_selected(candidate) && candidate.entity_type == "project")
        .map(|candidate| candidate.entity_id.clone())
        .collect::<HashSet<_>>();
    let purged_conversations = candidates
        .iter()
        .filter(|candidate| {
            candidate_is_selected(candidate) && candidate.entity_type == "conversation"
        })
        .map(|candidate| candidate.entity_id.clone())
        .collect::<HashSet<_>>();
    let purged_conversation_titles = snapshot
        .tombstones
        .iter()
        .filter(|tombstone| {
            purged_conversations.contains(&tombstone.entity_id)
                || tombstone
                    .project_id
                    .as_ref()
                    .is_some_and(|project_id| purged_projects.contains(project_id))
        })
        .filter_map(|tombstone| tombstone.title.clone())
        .collect::<HashSet<_>>();

    let conversations = snapshot
        .conversations
        .iter()
        .filter(|(_, conversation)| {
            let conversation_id = conversation.id.as_deref().unwrap_or_default();
            !purged_projects.contains(&conversation.project_id)
                && !purged_conversations.contains(conversation_id)
        })
        .map(|(key, conversation)| (key.clone(), conversation.clone()))
        .collect::<BTreeMap<_, _>>();
    let retained_conversation_titles = conversations
        .values()
        .map(|conversation| conversation.title.clone())
        .collect::<HashSet<_>>();
    let projects = snapshot
        .projects
        .iter()
        .filter(|project| !purged_projects.contains(&project.id))
        .cloned()
        .map(|mut project| {
            project.threads.retain(|thread| {
                !purged_conversation_titles.contains(thread)
                    || retained_conversation_titles.contains(thread)
            });
            project
        })
        .collect::<Vec<_>>();
    let tombstones = snapshot
        .tombstones
        .iter()
        .filter(|tombstone| {
            !candidates.iter().any(|candidate| {
                candidate_is_selected(candidate)
                    && candidate.entity_type == tombstone.entity_type
                    && candidate.entity_id == tombstone.entity_id
            })
        })
        .cloned()
        .collect::<Vec<_>>();

    LocalStoreSnapshot {
        schema_version: snapshot.schema_version,
        projects,
        conversations,
        tombstones,
    }
}

fn compaction_snapshot_path(root: &Path, snapshot_id: &str, created_at: &str) -> PathBuf {
    retention_root(root)
        .join("snapshots")
        .join(format!("{created_at}-{snapshot_id}.json"))
}

fn strip_nonportable_thread_ids(snapshot: &mut LocalStoreSnapshot) {
    for conversation in snapshot.conversations.values_mut() {
        conversation.thread_id = None;
    }
}

fn write_compaction_snapshot(
    root: &Path,
    scan: &JournalScan,
    mut state: LocalStoreSnapshot,
) -> Result<(CompactionSnapshot, PathBuf), String> {
    strip_nonportable_thread_ids(&mut state);
    let mut snapshot = CompactionSnapshot {
        schema_version: RETENTION_SCHEMA_VERSION,
        snapshot_id: Uuid::new_v4().to_string(),
        created_at: now_text(),
        event_count: journal_event_count_for_scan(scan),
        journal_digest: journal_digest_for_scan(scan),
        cursors: journal_cursors_for_scan(scan),
        state,
        snapshot_hash: String::new(),
    };
    snapshot.snapshot_hash = compaction_snapshot_hash(&snapshot)?;
    validate_compaction_snapshot(&snapshot)?;
    let bytes = retention_metadata_bytes(&snapshot)?;
    if bytes.len() as u64 > MAX_COMPACTION_SNAPSHOT_BYTES {
        return Err("A compaction snapshot meghaladja a 64 MiB méretkorlátot.".to_string());
    }
    let path = compaction_snapshot_path(root, &snapshot.snapshot_id, &snapshot.created_at);
    write_atomic(&path, &bytes)?;
    Ok((snapshot, path))
}

fn purge_compacted_events(root: &Path, snapshot: &CompactionSnapshot) -> Result<(), String> {
    let events_root = root.join("events");
    if !events_root.exists() {
        return Ok(());
    }
    let trash_root = retention_root(root)
        .join("trash")
        .join(&snapshot.snapshot_id);
    if trash_root.exists() {
        return Err("Egy korábbi compaction trash-mappája megmaradt; purge blokkolva.".to_string());
    }
    let mut pending = Vec::<(PathBuf, PathBuf)>::new();
    for device_entry in fs::read_dir(&events_root)
        .map_err(|error| format!("A purge event-mappája nem olvasható: {error}"))?
    {
        let device_entry = device_entry
            .map_err(|error| format!("A purge event-eszközmappája nem olvasható: {error}"))?;
        let device_path = device_entry.path();
        let device_metadata = fs::symlink_metadata(&device_path).map_err(|error| {
            format!("A purge event-eszközmappájának státusza nem olvasható: {error}")
        })?;
        if device_metadata.file_type().is_symlink() {
            return Err(format!(
                "A purge event-eszközmappája symlink, ezért blokkolva: {}.",
                device_path.display()
            ));
        }
        if !device_metadata.is_dir() {
            continue;
        }
        let device_id = device_entry.file_name().to_string_lossy().to_string();
        let Some(cursor) = snapshot.cursors.get(&device_id) else {
            continue;
        };
        for file_entry in fs::read_dir(&device_path)
            .map_err(|error| format!("A purge event-fájllistája nem olvasható: {error}"))?
        {
            let file_entry = file_entry
                .map_err(|error| format!("A purge event-fájlja nem olvasható: {error}"))?;
            let path = file_entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("A purge event-fájl státusza nem olvasható: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!("A purge event-fájlja symlink: {}.", path.display()));
            }
            if !metadata.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let bytes = fs::read(&path)
                .map_err(|error| format!("A purge event-fájlja nem olvasható: {error}"))?;
            let event = serde_json::from_slice::<SyncEvent>(&bytes)
                .map_err(|error| format!("A purge event JSON-ja hibás: {error}"))?;
            validate_event(&event)?;
            if event.device_id != device_id {
                return Err(format!(
                    "A purge event deviceId-je nem egyezik a mappával: {}.",
                    path.display()
                ));
            }
            if event.device_sequence <= cursor.sequence {
                pending.push((
                    path,
                    trash_root.join(&device_id).join(file_entry.file_name()),
                ));
            }
        }
    }
    if pending.is_empty() {
        return Ok(());
    }
    let mut moved = Vec::new();
    for (source, target) in &pending {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("A compaction trash-mappa nem hozható létre: {error}"))?;
        }
        if let Err(error) = fs::rename(source, target) {
            for (moved_source, moved_target) in moved.iter().rev() {
                let _ = fs::rename(moved_target, moved_source);
            }
            let _ = fs::remove_dir_all(&trash_root);
            return Err(format!("A compaction event-mozgatása sikertelen: {error}"));
        }
        moved.push((source.clone(), target.clone()));
    }
    if let Err(error) = fs::remove_dir_all(&trash_root) {
        for (moved_source, moved_target) in moved.iter().rev() {
            let _ = fs::rename(moved_target, moved_source);
        }
        return Err(format!("A compaction trash törlése sikertelen: {error}"));
    }
    Ok(())
}

fn validate_retention_selection(
    preview: &SyncRetentionPreview,
    entity_keys: Vec<String>,
) -> Result<HashSet<String>, String> {
    let requested = entity_keys.into_iter().collect::<BTreeSet<_>>();
    if requested.is_empty() {
        return Err("Legalább egy retention jelöltet ki kell választani.".to_string());
    }
    let mut invalid = Vec::new();
    for key in &requested {
        match preview
            .candidates
            .iter()
            .find(|candidate| candidate.selection_key == *key)
        {
            Some(candidate) if candidate.eligible => {}
            Some(_) => invalid.push(format!("{key} (a retention még nem járt le)")),
            None => invalid.push(format!("{key} (nincs az aktuális előnézetben)")),
        }
    }
    if !invalid.is_empty() {
        return Err(format!(
            "A retention kijelölés elavult vagy nem purge-olható: {}.",
            invalid.join(", ")
        ));
    }
    Ok(requested.into_iter().collect())
}

fn execute_retention_purge(
    runtime: RetentionRuntime,
    preview: SyncRetentionPreview,
    selected: Option<&HashSet<String>>,
) -> Result<SyncRetentionPreview, String> {
    let selected_count = preview
        .candidates
        .iter()
        .filter(|candidate| {
            candidate.eligible
                && selected
                    .map(|keys| keys.contains(&candidate.selection_key))
                    .unwrap_or(true)
        })
        .count();
    write_retention_audit(
        &runtime.root,
        &runtime.device_id,
        &runtime.scan,
        "purge",
        "started",
        selected_count,
        None,
        None,
    )?;
    let pruned_state = match selected {
        Some(selected) => prune_snapshot_for_compaction_selected(
            &preview.snapshot,
            &preview.candidates,
            Some(selected),
        ),
        None => prune_snapshot_for_compaction(&preview.snapshot, &preview.candidates),
    };
    let (snapshot, snapshot_path) =
        match write_compaction_snapshot(&runtime.root, &runtime.scan, pruned_state) {
            Ok(value) => value,
            Err(error) => {
                let _ = write_retention_audit(
                    &runtime.root,
                    &runtime.device_id,
                    &runtime.scan,
                    "purge",
                    "failed",
                    selected_count,
                    None,
                    Some(error.clone()),
                );
                return Err(error);
            }
        };
    if let Err(error) = purge_compacted_events(&runtime.root, &snapshot) {
        let _ = fs::remove_file(&snapshot_path);
        let _ = write_retention_audit(
            &runtime.root,
            &runtime.device_id,
            &runtime.scan,
            "purge",
            "failed",
            selected_count,
            Some(snapshot.snapshot_id.clone()),
            Some(error.clone()),
        );
        return Err(error);
    }
    let audit_error = write_retention_audit(
        &runtime.root,
        &runtime.device_id,
        &runtime.scan,
        "purge",
        "completed",
        selected_count,
        Some(snapshot.snapshot_id.clone()),
        None,
    )
    .err();
    drop(runtime);
    let post_runtime = load_retention_runtime()?;
    let mut result = build_retention_preview(&post_runtime)?;
    if let Some(error) = audit_error {
        result.blocking_reasons.push(format!(
            "Retention audit warning: a purge lefutott, de a completed rekord nem írható: {error}."
        ));
        result.protocol_ready = false;
        result.purge_allowed = false;
    }
    Ok(result)
}

pub(crate) fn sync_v2_retention_purge() -> Result<SyncRetentionPreview, String> {
    let runtime = load_retention_runtime()?;
    let preview = build_retention_preview(&runtime)?;
    if !preview.purge_allowed {
        return Err(format!(
            "A retention purge gate blokkolva: {}",
            preview.blocking_reasons.join(" | ")
        ));
    }
    execute_retention_purge(runtime, preview, None)
}

pub(crate) fn sync_v2_retention_purge_selected(
    entity_keys: Vec<String>,
) -> Result<SyncRetentionPreview, String> {
    let runtime = load_retention_runtime()?;
    let preview = build_retention_preview(&runtime)?;
    if !preview.purge_allowed {
        return Err(format!(
            "A retention purge gate blokkolva: {}",
            preview.blocking_reasons.join(" | ")
        ));
    }
    let selected = validate_retention_selection(&preview, entity_keys)?;
    execute_retention_purge(runtime, preview, Some(&selected))
}

fn sync_path_key(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn project_is_tombstoned_for_publish(
    project: &LocalProject,
    normalized_id: &str,
    tombstones: &[LocalTombstone],
) -> bool {
    tombstones.iter().any(|tombstone| {
        tombstone.entity_type == "project"
            && (tombstone.entity_id == project.id
                || tombstone.entity_id == normalized_id
                || tombstone
                    .relative_path
                    .as_deref()
                    .zip(project.relative_path.as_deref())
                    .map(|(left, right)| sync_path_key(left) == sync_path_key(right))
                    .unwrap_or(false)
                || tombstone
                    .path_hint
                    .as_deref()
                    .map(sync_path_key)
                    .map(|path| path == sync_path_key(&project.path_hint))
                    .unwrap_or(false))
    })
}

fn pending_events(snapshot: &LocalStoreSnapshot) -> Result<Vec<PendingEvent>, String> {
    if snapshot.schema_version > STORE_SCHEMA_VERSION {
        return Err(format!(
            "A v2 sync nem támogatja ezt a lokális snapshot schema-verziót: {}.",
            snapshot.schema_version
        ));
    }
    let mut project_ids = HashMap::<String, String>::new();
    let mut pending = Vec::new();
    for project in &snapshot.projects {
        let project_id = normalized_project_id(project);
        if project_is_tombstoned_for_publish(project, &project_id, &snapshot.tombstones) {
            continue;
        }
        project_ids.insert(project.id.clone(), project_id.clone());
        let mut normalized = project.clone();
        normalized.id = project_id.clone();
        normalized.threads = project
            .threads
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        pending.push(PendingEvent {
            entity_id: project_id,
            event_type: PROJECT_UPSERT.to_string(),
            payload: serde_json::to_value(normalized)
                .map_err(|error| format!("A project event előkészítése sikertelen: {error}"))?,
        });
    }

    for conversation in snapshot.conversations.values() {
        let Some(project_id) = project_ids.get(&conversation.project_id).cloned() else {
            // A stale conversation must not resurrect a project that is
            // present only through a project tombstone.
            continue;
        };
        let conversation_id = normalized_conversation_id(&project_id, conversation);
        let metadata = ConversationEventPayload {
            id: conversation_id.clone(),
            project_id: project_id.clone(),
            title: conversation.title.clone(),
            // Codex rollout IDs are local to one machine's app-server. Keep the
            // field in the wire schema for backwards compatibility, but never
            // publish it as shared state.
            thread_id: None,
            updated_at: conversation.updated_at.clone(),
            plan_history: conversation.plan_history.clone(),
            commentary: conversation.commentary.clone(),
        };
        pending.push(PendingEvent {
            entity_id: conversation_id.clone(),
            event_type: CONVERSATION_UPSERT.to_string(),
            payload: serde_json::to_value(metadata).map_err(|error| {
                format!("A conversation event előkészítése sikertelen: {error}")
            })?,
        });

        for (index, message) in conversation.messages.iter().enumerate() {
            let mut normalized_message = message.clone();
            normalized_message.id = Some(normalized_message_id(&conversation_id, message, index));
            normalized_message.sequence = Some(message.sequence.unwrap_or(index as i64));
            normalized_message.live = Some(false);
            normalized_message.hlc = None;
            normalized_message.origin_device_id = None;
            let payload = MessageEventPayload {
                project_id: project_id.clone(),
                conversation_id: conversation_id.clone(),
                message: normalized_message.clone(),
            };
            pending.push(PendingEvent {
                entity_id: normalized_message.id.clone().unwrap_or_default(),
                event_type: MESSAGE_UPSERT.to_string(),
                payload: serde_json::to_value(payload)
                    .map_err(|error| format!("A message event előkészítése sikertelen: {error}"))?,
            });
        }

        for (index, item) in conversation.work_items.iter().enumerate() {
            let mut sanitized_item = sanitized_work_item(item);
            sanitized_item.hlc = None;
            sanitized_item.origin_device_id = None;
            let payload = WorkItemEventPayload {
                project_id: project_id.clone(),
                conversation_id: conversation_id.clone(),
                item: sanitized_item,
            };
            pending.push(PendingEvent {
                entity_id: normalized_work_item_id(&conversation_id, item, index),
                event_type: WORK_ITEM_UPSERT.to_string(),
                payload: serde_json::to_value(payload).map_err(|error| {
                    format!("A work item event előkészítése sikertelen: {error}")
                })?,
            });
        }
    }
    for tombstone in &snapshot.tombstones {
        let (entity_id, payload) = normalized_tombstone(tombstone, &project_ids)?;
        pending.push(PendingEvent {
            entity_id,
            event_type: TOMBSTONE_UPSERT.to_string(),
            payload: serde_json::to_value(payload)
                .map_err(|error| format!("A tombstone event előkészítése sikertelen: {error}"))?,
        });
    }
    pending.sort_by(|left, right| {
        left.event_type
            .cmp(&right.event_type)
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    Ok(pending)
}

fn event_exists(
    connection: &Connection,
    event_type: &str,
    entity_id: &str,
    payload_hash: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sync_events WHERE event_type = ?1 AND entity_id = ?2 AND payload_hash = ?3 LIMIT 1",
            params![event_type, entity_id, payload_hash],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("A v2 event duplikáció-ellenőrzése sikertelen: {error}"))
        .map(|value| value.is_some())
}

fn write_event(root: &Path, event: &SyncEvent) -> Result<(), String> {
    let directory = root.join("events").join(&event.device_id);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("A v2 eventmappa nem hozható létre: {error}"))?;
    let path = directory.join(format!(
        "{:020}-{}.json",
        event.device_sequence, event.event_id
    ));
    if path.exists() {
        return Err(format!("A v2 event fájl már létezik: {}.", path.display()));
    }
    let bytes = serde_json::to_vec_pretty(event)
        .map_err(|error| format!("A v2 event nem szerializálható: {error}"))?;
    if bytes.len() > MAX_EVENT_BYTES {
        return Err("A v2 event szerializált mérete túl nagy.".to_string());
    }
    write_atomic(&path, &bytes)
}

fn append_pending_events(
    root: &Path,
    device_id: &str,
    store: &LocalStore,
    pending_events: Vec<PendingEvent>,
) -> Result<usize, String> {
    let _guard = append_lock()
        .lock()
        .map_err(|_| "A v2 sync append lockja sérült.".to_string())?;
    let scan = scan_journal(root, device_id)?;
    if !scan.warnings.is_empty() {
        return Err(format!(
            "A v2 journal nem írható karantén vagy hiányzó sequence miatt: {}",
            scan.warnings.join(" | ")
        ));
    }
    let mut seen_payloads = scan
        .accepted
        .iter()
        .map(|event| {
            format!(
                "{}:{}:{}",
                event.event_type, event.entity_id, event.payload_hash
            )
        })
        .collect::<HashSet<_>>();
    let mut own_events = scan
        .accepted
        .into_iter()
        .filter(|event| event.device_id == device_id)
        .collect::<Vec<_>>();
    own_events.sort_by_key(|event| event.device_sequence);
    let snapshot_cursor = scan
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.cursors.get(device_id));
    let mut sequence = own_events
        .last()
        .map(|event| event.device_sequence)
        .or_else(|| snapshot_cursor.map(|cursor| cursor.sequence))
        .unwrap_or(0);
    let mut last_hlc = own_events.last().map(|event| event.hlc.clone());
    let mut previous_hash = own_events
        .last()
        .map(|event| event.event_hash.clone())
        .or_else(|| snapshot_cursor.map(|cursor| cursor.event_hash.clone()));
    let mut written = 0_usize;
    for pending in pending_events {
        let payload_hash = sha256_hex(&payload_bytes(&pending.payload)?);
        let duplicate_key = format!(
            "{}:{}:{}",
            pending.event_type, pending.entity_id, payload_hash
        );
        if !seen_payloads.insert(duplicate_key) {
            continue;
        }
        if event_exists(
            &store.connection,
            &pending.event_type,
            &pending.entity_id,
            &payload_hash,
        )? {
            continue;
        }
        sequence = sequence
            .checked_add(1)
            .ok_or_else(|| "A v2 device sequence túlcsordult.".to_string())?;
        let hlc = next_hlc(last_hlc.as_deref())?;
        let event = make_event(
            device_id,
            sequence,
            hlc.clone(),
            previous_hash.clone(),
            pending.entity_id,
            pending.event_type,
            pending.payload,
        )?;
        write_event(root, &event)?;
        previous_hash = Some(event.event_hash.clone());
        last_hlc = Some(hlc);
        written += 1;
    }
    Ok(written)
}

fn append_snapshot(
    root: &Path,
    device_id: &str,
    store: &LocalStore,
    snapshot: &LocalStoreSnapshot,
) -> Result<usize, String> {
    append_pending_events(root, device_id, store, pending_events(snapshot)?)
}

pub(crate) fn sync_v2_pull() -> Result<SyncV2Result, String> {
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;
    let mut local_snapshot_fallback = false;
    let report = match import_into_store(&root, &device_id, &mut local_store) {
        Ok(report) => report,
        Err(error) if is_recoverable_cursor_mismatch(&error) => {
            // The OneDrive journal may have been reset/purged while this
            // device still has a newer local cursor. Keep the local SQLite
            // snapshot usable and fail closed for remote writes instead of
            // dropping the UI back to an empty tree.
            let scan = scan_journal(&root, &device_id)?;
            local_snapshot_fallback = true;
            let mut warnings = scan.warnings;
            warnings.push(format!(
                "A helyi sync cursor nem illeszthető a jelenlegi OneDrive journalhoz ({error}). A lokális állapot megmaradt; a távoli írás ideiglenesen tiltva van."
            ));
            let blocked_devices = scan.blocked_devices.into_iter().collect::<Vec<_>>();
            SyncImportReport {
                scanned_events: scan.scanned_events,
                accepted_events: scan.accepted.len(),
                imported_events: 0,
                blocked_devices,
                can_write: false,
                warnings,
            }
        }
        Err(error) => return Err(error),
    };
    let health = build_sync_health(&root, &local_store.connection, &report)?;
    let snapshot = if local_snapshot_fallback {
        store::load_snapshot_from_connection(&local_store.connection)?
    } else {
        reduce_snapshot(&local_store.connection)?
    };
    Ok(SyncV2Result {
        device_id,
        snapshot,
        health,
        imported_events: report.imported_events,
        written_events: 0,
        blocked_devices: report.blocked_devices,
        warnings: report.warnings,
        can_write: report.can_write,
    })
}

pub(crate) fn sync_v2_rebuild_from_local() -> Result<SyncV2Result, String> {
    let _guard = append_lock()
        .lock()
        .map_err(|_| "A v2 sync append lockja sérült.".to_string())?;
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;

    // Pull and reduce the complete visible journal before creating a new
    // compaction snapshot. Rebuilding directly from the local SQL tables can
    // compact away a remote conversation that has already arrived on disk but
    // has not yet been reflected in those tables.
    let import_report = import_into_store(&root, &device_id, &mut local_store)?;
    if !import_report.can_write {
        return Err(format!(
            "A journal újraépítése blokkolva: a távoli állapot előbb nem importálható: {}",
            import_report.warnings.join(" | ")
        ));
    }
    let scan = scan_journal(&root, &device_id)?;
    if !scan.warnings.is_empty() {
        return Err(format!(
            "A journal újraépítése blokkolva: előbb a warnings listát kell javítani: {}",
            scan.warnings.join(" | ")
        ));
    }

    let local_snapshot =
        canonicalize_snapshot_for_compaction(reduce_snapshot(&local_store.connection)?)?;
    let local_cursors = {
        let mut statement = local_store
            .connection
            .prepare("SELECT source_device_id, last_sequence, last_hash FROM sync_cursors")
            .map_err(|error| format!("A lokális sync cursorok nem olvashatók: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    RetentionCursor {
                        sequence: row.get::<_, i64>(1)? as u64,
                        event_hash: row.get(2)?,
                    },
                ))
            })
            .map_err(|error| format!("A lokális sync cursorlista nem járható be: {error}"))?;
        rows.collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(|error| format!("A lokális sync cursoradat hibás: {error}"))?
    };
    let (mut compaction, snapshot_path) = write_compaction_snapshot(&root, &scan, local_snapshot)?;
    // Keep prefixes for other devices that are still represented in the local
    // store even if their OneDrive event directory is temporarily offline.
    // Never carry the current device's stale cursor across the reset.
    for (source_device_id, cursor) in local_cursors {
        if source_device_id != device_id {
            compaction.cursors.entry(source_device_id).or_insert(cursor);
        }
    }
    compaction.snapshot_hash = compaction_snapshot_hash(&compaction)?;
    validate_compaction_snapshot(&compaction)?;
    write_atomic(&snapshot_path, &retention_metadata_bytes(&compaction)?)?;
    let snapshot_json = serde_json::to_string(&compaction)
        .map_err(|error| format!("A compaction snapshot lokális mentése sikertelen: {error}"))?;

    // Keep the existing event files and make the new compaction snapshot the
    // authoritative prefix. Local stale events/cursors are replaced with the
    // currently visible journal prefix so the next pull can validate it.
    let transaction = local_store.connection.transaction().map_err(|error| {
        format!("A sync cursor helyreállítási tranzakciója nem indítható: {error}")
    })?;
    transaction
        .execute("DELETE FROM sync_events", [])
        .map_err(|error| format!("A régi sync eventek nem üríthetők: {error}"))?;
    transaction
        .execute("DELETE FROM sync_cursors", [])
        .map_err(|error| format!("A régi sync cursorok nem üríthetők: {error}"))?;
    for event in &scan.accepted {
        transaction
            .execute(
                "INSERT INTO devices (id, name, last_hlc, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET last_hlc = excluded.last_hlc, updated_at = excluded.updated_at",
                params![event.device_id, format!("v2 sync · {}", event.device_id), event.hlc, now_text()],
            )
            .map_err(|error| format!("A sync eszköz helyreállítása sikertelen: {error}"))?;
        let payload_json = serde_json::to_string(&event.payload)
            .map_err(|error| format!("A sync event helyreállítása nem szerializálható: {error}"))?;
        transaction
            .execute(
                "INSERT INTO sync_events (event_id, device_id, device_sequence, hlc, entity_id, event_type, payload_json, payload_hash, event_hash, previous_hash, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    event.event_id,
                    event.device_id,
                    event.device_sequence as i64,
                    event.hlc,
                    event.entity_id,
                    event.event_type,
                    payload_json,
                    event.payload_hash,
                    event.event_hash,
                    event.previous_hash,
                    now_text(),
                ],
            )
            .map_err(|error| format!("A sync event lokális helyreállítása sikertelen: {error}"))?;
    }
    for (source_device_id, cursor) in &compaction.cursors {
        transaction
            .execute(
                "INSERT INTO sync_cursors (source_device_id, last_sequence, last_hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    source_device_id,
                    cursor.sequence as i64,
                    cursor.event_hash,
                    now_text()
                ],
            )
            .map_err(|error| format!("A sync cursor helyreállítása sikertelen: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO store_meta (key, value) VALUES ('sync_compaction_snapshot', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![snapshot_json],
        )
        .map_err(|error| format!("A compaction snapshot lokális indexelése sikertelen: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("A sync cursor helyreállítása nem commitolható: {error}"))?;
    drop(local_store);
    sync_v2_pull()
}

pub(crate) fn sync_v2_publish_snapshot(
    snapshot: LocalStoreSnapshot,
) -> Result<SyncV2Result, String> {
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;
    let initial_report = import_into_store(&root, &device_id, &mut local_store)?;
    if !initial_report.can_write {
        return Err(format!(
            "A v2 journal karanténban van; nincs távoli írás: {}",
            initial_report.warnings.join(" | ")
        ));
    }
    let written_events = append_snapshot(&root, &device_id, &local_store, &snapshot)?;
    let final_report = import_into_store(&root, &device_id, &mut local_store)?;
    if !final_report.can_write {
        return Err(format!(
            "A v2 journal írás után nem validálható: {}",
            final_report.warnings.join(" | ")
        ));
    }
    let health = build_sync_health(&root, &local_store.connection, &final_report)?;
    let merged_snapshot = reduce_snapshot(&local_store.connection)?;
    Ok(SyncV2Result {
        device_id,
        snapshot: merged_snapshot,
        health,
        imported_events: final_report.imported_events,
        written_events,
        blocked_devices: final_report.blocked_devices,
        warnings: final_report.warnings,
        can_write: final_report.can_write,
    })
}

pub(crate) fn sync_v2_preview_restore_entity(
    tombstone: LocalTombstone,
) -> Result<SyncRestorePreview, String> {
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;
    let report = import_into_store(&root, &device_id, &mut local_store)?;
    let health = build_sync_health(&root, &local_store.connection, &report)?;
    let snapshot = reduce_snapshot(&local_store.connection)?;
    build_restore_preview(&tombstone, &snapshot, health)
}

pub(crate) fn sync_v2_retention_preview() -> Result<SyncRetentionPreview, String> {
    let runtime = load_retention_runtime()?;
    build_retention_preview(&runtime)
}

pub(crate) fn sync_v2_retention_ack() -> Result<SyncRetentionPreview, String> {
    let runtime = load_retention_runtime()?;
    if !runtime.report.can_write {
        return Err(format!(
            "A retention ACK nem írható karanténos journalhoz: {}",
            runtime.report.warnings.join(" | ")
        ));
    }
    write_retention_ack_for_scan(&runtime.root, &runtime.device_id, &runtime.scan)?;
    write_retention_audit(
        &runtime.root,
        &runtime.device_id,
        &runtime.scan,
        "ack",
        "completed",
        0,
        None,
        None,
    )?;
    build_retention_preview(&runtime)
}

pub(crate) fn sync_v2_retention_backup() -> Result<SyncRetentionPreview, String> {
    let runtime = load_retention_runtime()?;
    if !runtime.report.can_write {
        return Err(format!(
            "A retention backup nem készíthető karanténos journalból: {}",
            runtime.report.warnings.join(" | ")
        ));
    }
    let manifest =
        write_retention_backup_for_scan(&runtime.root, &runtime.device_id, &runtime.scan)?;
    write_retention_ack_for_scan(&runtime.root, &runtime.device_id, &runtime.scan)?;
    write_retention_audit(
        &runtime.root,
        &runtime.device_id,
        &runtime.scan,
        "backup",
        "completed",
        0,
        None,
        Some(format!("backupId={}", manifest.backup_id)),
    )?;
    build_retention_preview(&runtime)
}

pub(crate) fn sync_v2_restore_entity(tombstone: LocalTombstone) -> Result<SyncV2Result, String> {
    let device_id = local_device_id()?;
    let root = sync_root()?;
    let mut local_store = store::open_local_store()?;
    let initial_report = import_into_store(&root, &device_id, &mut local_store)?;
    if !initial_report.can_write {
        return Err(format!(
            "A v2 journal karanténban van; nincs restore írás: {}",
            initial_report.warnings.join(" | ")
        ));
    }
    let (entity_id, payload) = normalized_tombstone(&tombstone, &HashMap::new())?;
    let payload = serde_json::to_value(payload)
        .map_err(|error| format!("A restore event payloadja nem készíthető elő: {error}"))?;
    let written_events = append_pending_events(
        &root,
        &device_id,
        &local_store,
        vec![PendingEvent {
            entity_id,
            event_type: ENTITY_RESTORE.to_string(),
            payload,
        }],
    )?;
    let final_report = import_into_store(&root, &device_id, &mut local_store)?;
    if !final_report.can_write {
        return Err(format!(
            "A v2 restore írás után nem validálható: {}",
            final_report.warnings.join(" | ")
        ));
    }
    let health = build_sync_health(&root, &local_store.connection, &final_report)?;
    let snapshot = reduce_snapshot(&local_store.connection)?;
    Ok(SyncV2Result {
        device_id,
        snapshot,
        health,
        imported_events: final_report.imported_events,
        written_events,
        blocked_devices: final_report.blocked_devices,
        warnings: final_report.warnings,
        can_write: final_report.can_write,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use rusqlite::Connection;

    struct TestRng(u64);

    impl TestRng {
        fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }

        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0
        }

        fn shuffle<T>(&mut self, values: &mut [T]) {
            for index in (1..values.len()).rev() {
                let other = (self.next_u64() as usize) % (index + 1);
                values.swap(index, other);
            }
        }
    }

    fn test_root() -> PathBuf {
        env::temp_dir().join(format!("min-sync-v2-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn cursor_reset_is_reported_as_recoverable_local_snapshot_case() {
        assert!(is_recoverable_cursor_mismatch(
            "A v2 sync cursor hash-e nem egyezik a journallal: device/731."
        ));
        assert!(is_recoverable_cursor_mismatch(
            "A v2 sync cursor nem folytatható: device/1."
        ));
        assert!(!is_recoverable_cursor_mismatch(
            "A v2 event payloadja nem menthető."
        ));
    }

    fn test_event(device_id: &str, sequence: u64, previous_hash: Option<String>) -> SyncEvent {
        make_event(
            device_id,
            sequence,
            format!("{:020}-{:08}", sequence, 0),
            previous_hash,
            stable_id("project", "test-project"),
            PROJECT_UPSERT.to_string(),
            serde_json::json!({
                "id": stable_id("project", "test-project"),
                "name": "Test project",
                "relativePath": "my projects/test-project",
                "pathHint": "C:\\test-project",
                "threads": ["Thread"]
            }),
        )
        .expect("valid test event")
    }

    fn test_store() -> LocalStore {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE store_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                 CREATE TABLE devices (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, last_hlc TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                 CREATE TABLE sync_events (event_id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, device_sequence INTEGER NOT NULL, hlc TEXT NOT NULL, entity_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, event_hash TEXT NOT NULL, previous_hash TEXT, imported_at TEXT, UNIQUE(device_id, device_sequence));
                 CREATE TABLE sync_cursors (source_device_id TEXT PRIMARY KEY NOT NULL, last_sequence INTEGER NOT NULL, last_hash TEXT, updated_at TEXT NOT NULL);",
            )
            .expect("schema");
        LocalStore {
            path: PathBuf::from(":memory:"),
            connection,
        }
    }

    #[test]
    fn event_hash_round_trip_is_validated() {
        let device_id = Uuid::new_v4().to_string();
        let event = test_event(&device_id, 1, None);
        validate_event(&event).expect("event validates");
        let serialized = serde_json::to_vec(&event).expect("serialize event");
        let parsed: SyncEvent = serde_json::from_slice(&serialized).expect("parse event");
        validate_event(&parsed).expect("round trip validates");
    }

    #[test]
    fn missing_sequence_blocks_journal_write() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let event = test_event(&device_id, 2, None);
        write_event(&root, &event).expect("write event");
        let scan = scan_journal(&root, &Uuid::new_v4().to_string()).expect("scan journal");
        assert!(!scan.warnings.is_empty());
        assert!(scan.blocked_devices.contains(&device_id));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_snapshot_events_have_stable_entity_ids() {
        let project = LocalProject {
            id: "project-legacy".to_string(),
            name: "Test".to_string(),
            relative_path: Some("my projects/test".to_string()),
            path_hint: "C:\\test".to_string(),
            threads: vec!["Thread".to_string()],
        };
        let conversation = LocalConversation {
            id: None,
            project_id: project.id.clone(),
            title: "Thread".to_string(),
            messages: vec![LocalMessage {
                id: None,
                role: "user".to_string(),
                text: "hello".to_string(),
                time: "1".to_string(),
                code: Some(false),
                live: Some(false),
                final_message: Some(true),
                item_id: None,
                turn_id: Some("request:stable-turn".to_string()),
                sequence: Some(1),
                hlc: None,
                origin_device_id: None,
                images: Vec::new(),
            }],
            work_items: Vec::new(),
            thread_id: Some("foreign-machine-rollout".to_string()),
            updated_at: "1".to_string(),
            plan_history: BTreeMap::from([(
                "turn-1".to_string(),
                serde_json::json!({"steps": [{"id": "step-1"}]}),
            )]),
            commentary: vec![serde_json::json!({
                "id": "commentary-1",
                "body": "Thinking"
            })],
        };
        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: vec![project],
            conversations: BTreeMap::from([("legacy".to_string(), conversation)]),
            tombstones: Vec::new(),
        };
        let first = pending_events(&snapshot).expect("pending events");
        let second = pending_events(&snapshot).expect("pending events again");
        assert_eq!(
            first
                .iter()
                .map(|event| (&event.event_type, &event.entity_id))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|event| (&event.event_type, &event.entity_id))
                .collect::<Vec<_>>()
        );
        assert!(first.iter().any(|event| event.event_type == MESSAGE_UPSERT));
        let message_event = first
            .iter()
            .find(|event| event.event_type == MESSAGE_UPSERT)
            .expect("message event");
        let message_payload: MessageEventPayload =
            serde_json::from_value(message_event.payload.clone()).expect("message payload");
        assert_eq!(
            message_payload.message.turn_id.as_deref(),
            Some("request:stable-turn")
        );
        let conversation_event = first
            .iter()
            .find(|event| event.event_type == CONVERSATION_UPSERT)
            .expect("conversation event");
        let conversation_payload: ConversationEventPayload =
            serde_json::from_value(conversation_event.payload.clone())
                .expect("conversation payload");
        assert!(conversation_payload.thread_id.is_none());
        assert_eq!(conversation_payload.plan_history.len(), 1);
        assert_eq!(conversation_payload.commentary.len(), 1);
    }

    #[test]
    fn conversation_rename_does_not_resurrect_the_historical_thread_name() {
        let device_id = Uuid::new_v4().to_string();
        let project_id = stable_id("project", "my projects/rename-test");
        let conversation_id = Uuid::new_v4().to_string();
        let project_old = make_event(
            &device_id,
            1,
            format!("{:020}-{:08}", 1, 0),
            None,
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::json!({
                "id": project_id,
                "name": "Rename test",
                "relativePath": "my projects/rename-test",
                "pathHint": "C:\\rename-test",
                "threads": ["Old title"]
            }),
        )
        .expect("old project event");
        let conversation_old = make_event(
            &device_id,
            2,
            format!("{:020}-{:08}", 2, 0),
            Some(project_old.event_hash.clone()),
            conversation_id.clone(),
            CONVERSATION_UPSERT.to_string(),
            serde_json::json!({
                "id": conversation_id,
                "projectId": project_id,
                "title": "Old title",
                "threadId": null,
                "updatedAt": "2"
            }),
        )
        .expect("old conversation event");
        let project_new = make_event(
            &device_id,
            3,
            format!("{:020}-{:08}", 3, 0),
            Some(conversation_old.event_hash.clone()),
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::json!({
                "id": project_id,
                "name": "Rename test",
                "relativePath": "my projects/rename-test",
                "pathHint": "C:\\rename-test",
                "threads": ["New title"]
            }),
        )
        .expect("new project event");
        let conversation_new = make_event(
            &device_id,
            4,
            format!("{:020}-{:08}", 4, 0),
            Some(project_new.event_hash.clone()),
            conversation_id.clone(),
            CONVERSATION_UPSERT.to_string(),
            serde_json::json!({
                "id": conversation_id,
                "projectId": project_id,
                "title": "New title",
                "threadId": null,
                "updatedAt": "4"
            }),
        )
        .expect("new conversation event");
        let scan = JournalScan {
            accepted: vec![project_old, conversation_old, project_new, conversation_new],
            scanned_events: 4,
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        let mut store = test_store();
        apply_events(&mut store, &scan).expect("apply rename events");
        let snapshot = reduce_snapshot(&store.connection).expect("reduce rename events");
        assert_eq!(snapshot.projects.len(), 1);
        assert_eq!(snapshot.projects[0].threads, vec!["New title"]);
        assert!(snapshot
            .conversations
            .contains_key(&format!("{}::New title", snapshot.projects[0].id)));
    }

    #[test]
    fn project_tombstone_rekeys_local_uuid_to_canonical_sync_id() {
        let local_store_project_id = Uuid::new_v4().to_string();
        let tombstone = LocalTombstone {
            entity_type: "project".to_string(),
            entity_id: local_store_project_id,
            archived_at: "2".to_string(),
            project_id: None,
            title: Some("Test".to_string()),
            relative_path: Some("my projects/test".to_string()),
            path_hint: Some("C:\\test".to_string()),
            reason: Some("test archive".to_string()),
        };

        let (entity_id, payload) = normalized_tombstone(&tombstone, &HashMap::new())
            .expect("project tombstone normalizes");
        let expected = stable_id("project", "my projects/test");
        assert_eq!(entity_id, expected);
        assert_eq!(payload.entity_id, expected);
    }

    #[test]
    fn project_tombstone_suppresses_matching_project_upsert() {
        let local_store_project_id =
            Uuid::new_v5(&Uuid::NAMESPACE_OID, b"min:local:project:my projects/test").to_string();
        let project = LocalProject {
            id: local_store_project_id.clone(),
            name: "Test".to_string(),
            relative_path: Some("my projects/test".to_string()),
            path_hint: "C:\\test".to_string(),
            threads: Vec::new(),
        };
        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: vec![project],
            conversations: BTreeMap::new(),
            tombstones: vec![LocalTombstone {
                entity_type: "project".to_string(),
                entity_id: local_store_project_id,
                archived_at: "2".to_string(),
                project_id: None,
                title: Some("Test".to_string()),
                relative_path: Some("my projects/test".to_string()),
                path_hint: Some("C:\\test".to_string()),
                reason: Some("test archive".to_string()),
            }],
        };

        let events = pending_events(&snapshot).expect("pending events");
        assert!(!events
            .iter()
            .any(|event| event.event_type == PROJECT_UPSERT));
        let tombstone_id = events
            .iter()
            .find(|event| event.event_type == TOMBSTONE_UPSERT)
            .map(|event| event.entity_id.clone())
            .expect("tombstone event");
        assert_eq!(tombstone_id, stable_id("project", "my projects/test"));
    }

    #[test]
    fn reducer_hides_legacy_local_uuid_project_with_canonical_tombstone() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let importer = Uuid::new_v4().to_string();
        let local_store_project_id =
            Uuid::new_v5(&Uuid::NAMESPACE_OID, b"min:local:project:my projects/test").to_string();
        let project = make_event(
            &device_id,
            1,
            format!("{:020}-{:08}", 1, 0),
            None,
            local_store_project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::to_value(LocalProject {
                id: local_store_project_id.clone(),
                name: "Test".to_string(),
                relative_path: Some("my projects/test".to_string()),
                path_hint: "C:\\test".to_string(),
                threads: Vec::new(),
            })
            .expect("project payload"),
        )
        .expect("project event");
        let tombstone = make_event(
            &device_id,
            2,
            format!("{:020}-{:08}", 2, 0),
            Some(project.event_hash.clone()),
            local_store_project_id.clone(),
            TOMBSTONE_UPSERT.to_string(),
            serde_json::to_value(TombstoneEventPayload {
                entity_type: "project".to_string(),
                entity_id: local_store_project_id,
                archived_at: "2".to_string(),
                project_id: None,
                title: Some("Test".to_string()),
                relative_path: Some("my projects/test".to_string()),
                path_hint: Some("C:\\test".to_string()),
                reason: Some("test archive".to_string()),
            })
            .expect("tombstone payload"),
        )
        .expect("tombstone event");
        write_event(&root, &project).expect("write project");
        write_event(&root, &tombstone).expect("write tombstone");

        let scan = scan_journal(&root, &importer).expect("scan journal");
        let mut local_store = test_store();
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("import events"),
            2
        );
        let snapshot = reduce_snapshot(&local_store.connection).expect("reduce snapshot");
        assert!(snapshot.projects.is_empty());
        assert_eq!(snapshot.tombstones.len(), 1);
        assert_eq!(
            snapshot.tombstones[0].entity_id,
            stable_id("project", "my projects/test")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_device_journal_converges_deterministically() {
        let root = test_root();
        let device_a = Uuid::new_v4().to_string();
        let device_b = Uuid::new_v4().to_string();
        let importer = Uuid::new_v4().to_string();
        let project_id = stable_id("project", "shared-project");
        let conversation_id = stable_id("conversation", "shared-conversation");
        let message_id = stable_id("message", "shared-message");

        let project_a = make_event(
            &device_a,
            1,
            format!("{:020}-{:08}", 1, 0),
            None,
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::to_value(LocalProject {
                id: project_id.clone(),
                name: "Shared project".to_string(),
                relative_path: Some("shared".to_string()),
                path_hint: "C:\\shared".to_string(),
                threads: vec!["A thread".to_string()],
            })
            .expect("project A payload"),
        )
        .expect("project A event");
        let conversation_a = make_event(
            &device_a,
            2,
            format!("{:020}-{:08}", 3, 0),
            Some(project_a.event_hash.clone()),
            conversation_id.clone(),
            CONVERSATION_UPSERT.to_string(),
            serde_json::to_value(ConversationEventPayload {
                id: conversation_id.clone(),
                project_id: project_id.clone(),
                title: "Shared thread".to_string(),
                thread_id: Some("thread-a".to_string()),
                updated_at: "3".to_string(),
                plan_history: BTreeMap::new(),
                commentary: Vec::new(),
            })
            .expect("conversation payload"),
        )
        .expect("conversation event");
        let project_b = make_event(
            &device_b,
            1,
            format!("{:020}-{:08}", 2, 0),
            None,
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::to_value(LocalProject {
                id: project_id.clone(),
                name: "Shared project".to_string(),
                relative_path: Some("shared".to_string()),
                path_hint: "C:\\shared".to_string(),
                threads: vec!["B thread".to_string()],
            })
            .expect("project B payload"),
        )
        .expect("project B event");
        let message_b = make_event(
            &device_b,
            2,
            format!("{:020}-{:08}", 4, 0),
            Some(project_b.event_hash.clone()),
            message_id.clone(),
            MESSAGE_UPSERT.to_string(),
            serde_json::to_value(MessageEventPayload {
                project_id: project_id.clone(),
                conversation_id: conversation_id.clone(),
                message: LocalMessage {
                    id: Some(message_id),
                    role: "user".to_string(),
                    text: "offline from B".to_string(),
                    time: "4".to_string(),
                    code: Some(false),
                    live: Some(false),
                    final_message: Some(true),
                    item_id: None,
                    turn_id: None,
                    sequence: Some(1),
                    hlc: None,
                    origin_device_id: None,
                    images: Vec::new(),
                },
            })
            .expect("message payload"),
        )
        .expect("message event");

        write_event(&root, &message_b).expect("write B message");
        write_event(&root, &project_a).expect("write A project");
        write_event(&root, &conversation_a).expect("write A conversation");
        write_event(&root, &project_b).expect("write B project");

        let scan = scan_journal(&root, &importer).expect("scan two-device journal");
        assert_eq!(scan.scanned_events, 4);
        assert_eq!(scan.accepted.len(), 4);
        assert!(scan.blocked_devices.is_empty());
        assert!(scan.warnings.is_empty());

        let mut local_store = test_store();
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("import events"),
            4
        );
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("re-import events"),
            0
        );
        let snapshot = reduce_snapshot(&local_store.connection).expect("reduce snapshot");
        let project = snapshot
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .expect("merged project");
        assert!(project.threads.iter().any(|thread| thread == "A thread"));
        assert!(project.threads.iter().any(|thread| thread == "B thread"));
        let conversation = snapshot
            .conversations
            .values()
            .find(|conversation| conversation.id.as_deref() == Some(conversation_id.as_str()))
            .expect("merged conversation");
        assert_eq!(conversation.messages.len(), 1);
        assert_eq!(conversation.messages[0].text, "offline from B");
        assert_eq!(
            conversation.messages[0].hlc.as_deref(),
            Some("00000000000000000004-00000000")
        );
        assert_eq!(
            conversation.messages[0].origin_device_id.as_deref(),
            Some(device_b.as_str())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn filesystem_two_device_offline_reconnect_and_quarantine_recovery() {
        let root = test_root();
        let device_a = Uuid::new_v4().to_string();
        let device_b = Uuid::new_v4().to_string();
        let project_id = stable_id("project", "filesystem-two-device");
        let make_chain = |device_id: &str, device_index: u64| -> Vec<SyncEvent> {
            let mut previous_hash = None;
            (1..=6_u64)
                .map(|sequence| {
                    let event = make_event(
                        device_id,
                        sequence,
                        format!("{:020}-{:08}", sequence * 10 + device_index, device_index),
                        previous_hash.clone(),
                        project_id.clone(),
                        PROJECT_UPSERT.to_string(),
                        serde_json::to_value(LocalProject {
                            id: project_id.clone(),
                            name: format!("device-{device_index}-state-{sequence}"),
                            relative_path: Some("filesystem-two-device".to_string()),
                            path_hint: "C:\\filesystem-two-device".to_string(),
                            threads: vec![format!("device-{device_index}-thread-{sequence}")],
                        })
                        .expect("filesystem soak project payload"),
                    )
                    .expect("filesystem soak event");
                    previous_hash = Some(event.event_hash.clone());
                    event
                })
                .collect()
        };
        let chain_a = make_chain(&device_a, 0);
        let chain_b = make_chain(&device_b, 1);
        let write =
            |event: &SyncEvent| write_event(&root, event).expect("write filesystem soak event");

        // A remote device is visible with a sequence gap. Read is allowed, but
        // the journal must stay write-blocked until the missing prefix arrives.
        write(&chain_a[0]);
        write(&chain_a[1]);
        write(&chain_b[1]);
        let mut store_a = test_store();
        let mut store_b = test_store();
        let first_a =
            import_into_store(&root, &device_a, &mut store_a).expect("first device A pull");
        let first_b =
            import_into_store(&root, &device_b, &mut store_b).expect("first device B pull");
        for report in [&first_a, &first_b] {
            assert!(!report.can_write);
            assert!(report.blocked_devices.contains(&device_b));
            assert!(!report.warnings.is_empty());
        }

        // Reconnect the missing remote prefix and continue both chains. Both
        // local stores must recover without rebuilding or overwriting state.
        write(&chain_b[0]);
        write(&chain_b[2]);
        write(&chain_a[2]);
        let second_a =
            import_into_store(&root, &device_a, &mut store_a).expect("second device A pull");
        let second_b =
            import_into_store(&root, &device_b, &mut store_b).expect("second device B pull");
        assert!(second_a.can_write);
        assert!(second_b.can_write);

        // B publishes sequence 5 while sequence 4 is still offline. A sees
        // its own event, but remains fail-closed for the shared journal.
        write(&chain_a[3]);
        write(&chain_b[4]);
        let gap_a = import_into_store(&root, &device_a, &mut store_a).expect("gap device A pull");
        assert!(!gap_a.can_write);
        assert!(gap_a.blocked_devices.contains(&device_b));
        write(&chain_b[3]);
        write(&chain_a[4]);
        write(&chain_a[5]);
        write(&chain_b[5]);
        let final_a =
            import_into_store(&root, &device_a, &mut store_a).expect("final device A pull");
        let final_b =
            import_into_store(&root, &device_b, &mut store_b).expect("final device B pull");
        assert!(final_a.can_write);
        assert!(final_b.can_write);

        let healthy_a = reduce_snapshot(&store_a.connection).expect("reduce device A snapshot");
        let healthy_b = reduce_snapshot(&store_b.connection).expect("reduce device B snapshot");
        assert_eq!(
            serde_json::to_string(&healthy_a).expect("device A snapshot JSON"),
            serde_json::to_string(&healthy_b).expect("device B snapshot JSON")
        );
        assert_eq!(healthy_a.projects[0].threads.len(), 12);

        // A corrupt remote event keeps both devices read-only and creates one
        // deterministic quarantine manifest. Repairing the source event and
        // pulling again must clear the quarantine state without losing data.
        let event_a7 = make_event(
            &device_a,
            7,
            format!("{:020}-{:08}", 70, 0),
            Some(chain_a[5].event_hash.clone()),
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::to_value(LocalProject {
                id: project_id.clone(),
                name: "device-0-state-7".to_string(),
                relative_path: Some("filesystem-two-device".to_string()),
                path_hint: "C:\\filesystem-two-device".to_string(),
                threads: vec!["device-0-thread-7".to_string()],
            })
            .expect("corruptible event payload"),
        )
        .expect("corruptible event");
        write(&event_a7);
        let event_a7_path = root.join("events").join(&device_a).join(format!(
            "{:020}-{}.json",
            event_a7.device_sequence, event_a7.event_id
        ));
        fs::write(&event_a7_path, b"{not-json").expect("corrupt event");
        let corrupt_a =
            import_into_store(&root, &device_a, &mut store_a).expect("corrupt device A pull");
        let corrupt_b =
            import_into_store(&root, &device_b, &mut store_b).expect("corrupt device B pull");
        assert!(!corrupt_a.can_write);
        assert!(!corrupt_b.can_write);
        assert!(corrupt_a.blocked_devices.contains(&device_a));
        let corrupt_health =
            build_sync_health(&root, &store_a.connection, &corrupt_a).expect("corrupt sync health");
        assert_eq!(corrupt_health.status, "quarantine");
        assert!(!corrupt_health.can_write);
        let quarantine_directory = root.join("quarantine").join(&device_a).join(&device_a);
        let quarantine_manifests = fs::read_dir(&quarantine_directory)
            .expect("quarantine directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .count();
        assert_eq!(quarantine_manifests, 1);

        fs::remove_file(&event_a7_path).expect("remove corrupt event before repair");
        write(&event_a7);
        let repaired_a =
            import_into_store(&root, &device_a, &mut store_a).expect("repaired device A pull");
        let repaired_b =
            import_into_store(&root, &device_b, &mut store_b).expect("repaired device B pull");
        assert!(repaired_a.can_write);
        assert!(repaired_b.can_write);
        let repaired_snapshot_a =
            reduce_snapshot(&store_a.connection).expect("repaired A snapshot");
        let repaired_snapshot_b =
            reduce_snapshot(&store_b.connection).expect("repaired B snapshot");
        assert_eq!(
            serde_json::to_string(&repaired_snapshot_a).expect("repaired A snapshot JSON"),
            serde_json::to_string(&repaired_snapshot_b).expect("repaired B snapshot JSON")
        );
        assert!(repaired_snapshot_a.projects[0]
            .threads
            .iter()
            .any(|thread| thread == "device-0-thread-7"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sync_health_reports_journal_state() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let event = test_event(&device_id, 1, None);
        write_event(&root, &event).expect("write health event");
        let mut local_store = test_store();
        let report =
            import_into_store(&root, &device_id, &mut local_store).expect("import health event");
        let health =
            build_sync_health(&root, &local_store.connection, &report).expect("build health");
        assert_eq!(health.status, "healthy");
        assert_eq!(health.scanned_events, 1);
        assert_eq!(health.accepted_events, 1);
        assert_eq!(health.imported_events, 1);
        assert_eq!(health.stored_events, 1);
        assert!(health.last_import_at.is_some());
        assert!(health.can_write);
        assert!(health.recovery_action.contains("Nincs teendő"));
        let _ = fs::remove_dir_all(root);

        let quarantined_root = test_root();
        let quarantined_event = test_event(&device_id, 2, None);
        write_event(&quarantined_root, &quarantined_event).expect("write quarantined event");
        let mut quarantined_store = test_store();
        let quarantined_report =
            import_into_store(&quarantined_root, &device_id, &mut quarantined_store)
                .expect("import quarantined event");
        let quarantined_health = build_sync_health(
            &quarantined_root,
            &quarantined_store.connection,
            &quarantined_report,
        )
        .expect("build quarantined health");
        assert_eq!(quarantined_health.status, "quarantine");
        assert!(!quarantined_health.can_write);
        assert!(!quarantined_health.warnings.is_empty());
        let _ = fs::remove_dir_all(quarantined_root);
    }

    #[test]
    fn restore_preview_is_read_only_and_refuses_stale_archives() {
        let tombstone = LocalTombstone {
            entity_type: "conversation".to_string(),
            entity_id: stable_id("conversation", "preview-conversation"),
            archived_at: "123".to_string(),
            project_id: Some(stable_id("project", "preview-project")),
            title: Some("Preview me".to_string()),
            relative_path: Some("preview".to_string()),
            path_hint: Some("C:\\preview".to_string()),
            reason: Some("test".to_string()),
        };
        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: Vec::new(),
            conversations: BTreeMap::new(),
            tombstones: vec![tombstone.clone()],
        };
        let health = SyncHealth {
            status: "healthy".to_string(),
            journal_path: "journal".to_string(),
            quarantine_path: "quarantine".to_string(),
            checked_at: "123".to_string(),
            last_import_at: Some("123".to_string()),
            scanned_events: 1,
            accepted_events: 1,
            imported_events: 1,
            stored_events: 1,
            blocked_devices: Vec::new(),
            warnings: Vec::new(),
            can_write: true,
            recovery_action: "Nincs teendő".to_string(),
        };
        let preview = build_restore_preview(&tombstone, &snapshot, health.clone())
            .expect("build restore preview");
        assert!(preview.can_restore);
        assert_eq!(preview.label, "Preview me");
        assert_eq!(preview.target_path.as_deref(), Some("C:\\preview"));
        assert!(preview
            .effects
            .iter()
            .any(|effect| effect.contains("entity.restore")));

        let stale = build_restore_preview(
            &tombstone,
            &LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: Vec::new(),
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
            health,
        )
        .expect("build stale restore preview");
        assert!(!stale.can_restore);
        assert!(stale.blocking_reason.is_some());
    }

    #[test]
    fn retention_marks_old_entries_but_never_allows_shared_purge() {
        let old = LocalTombstone {
            entity_type: "project".to_string(),
            entity_id: stable_id("project", "old-retention"),
            archived_at: (now_millis() - (TOMBSTONE_RETENTION_DAYS as u64 + 1) * MILLIS_PER_DAY)
                .to_string(),
            project_id: None,
            title: Some("Old project".to_string()),
            relative_path: None,
            path_hint: None,
            reason: None,
        };
        let recent = LocalTombstone {
            archived_at: now_text(),
            title: Some("Recent project".to_string()),
            ..old.clone()
        };
        let old_candidate = retention_candidate(&old, now_millis());
        assert!(old_candidate.eligible);
        assert!(old_candidate.reason.contains("backup"));
        let recent_candidate = retention_candidate(&recent, now_millis());
        assert!(!recent_candidate.eligible);
        assert!(recent_candidate.reason.contains("retention"));
    }

    #[test]
    fn retention_selection_only_prunes_explicitly_selected_candidates() {
        let first = LocalTombstone {
            entity_type: "project".to_string(),
            entity_id: stable_id("project", "selected-retention"),
            archived_at: (now_millis() - (TOMBSTONE_RETENTION_DAYS as u64 + 1) * MILLIS_PER_DAY)
                .to_string(),
            project_id: None,
            title: Some("Selected project".to_string()),
            relative_path: None,
            path_hint: None,
            reason: None,
        };
        let second = LocalTombstone {
            entity_id: stable_id("project", "kept-retention"),
            title: Some("Kept project".to_string()),
            ..first.clone()
        };
        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: Vec::new(),
            conversations: BTreeMap::new(),
            tombstones: vec![first.clone(), second.clone()],
        };
        let candidates = vec![
            retention_candidate(&first, now_millis()),
            retention_candidate(&second, now_millis()),
        ];
        let selected = HashSet::from([candidates[0].selection_key.clone()]);
        let pruned =
            prune_snapshot_for_compaction_selected(&snapshot, &candidates, Some(&selected));
        assert_eq!(pruned.tombstones.len(), 1);
        assert_eq!(pruned.tombstones[0].entity_id, second.entity_id);
        assert!(validate_retention_selection(
            &SyncRetentionPreview {
                snapshot,
                health: SyncHealth {
                    status: "healthy".to_string(),
                    journal_path: "journal".to_string(),
                    quarantine_path: "quarantine".to_string(),
                    checked_at: now_text(),
                    last_import_at: None,
                    scanned_events: 0,
                    accepted_events: 0,
                    imported_events: 0,
                    stored_events: 0,
                    blocked_devices: Vec::new(),
                    warnings: Vec::new(),
                    can_write: true,
                    recovery_action: "Nincs teendő".to_string(),
                },
                retention_days: TOMBSTONE_RETENTION_DAYS,
                candidates,
                eligible_count: 2,
                protocol_ready: true,
                current_event_count: 0,
                current_journal_digest: empty_journal_digest(),
                compaction_snapshot_id: None,
                compaction_created_at: None,
                devices: Vec::new(),
                audit: Vec::new(),
                purge_allowed: true,
                blocking_reasons: Vec::new(),
            },
            vec!["unknown:selection".to_string()],
        )
        .is_err());
    }

    #[test]
    fn retention_ack_and_backup_gate_requires_current_digest() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let first = test_event(&device_id, 1, None);
        let second = test_event(&device_id, 2, Some(first.event_hash.clone()));
        let events = vec![first, second];
        let scan = JournalScan {
            accepted: events.clone(),
            scanned_events: events.len(),
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        let old = LocalTombstone {
            entity_type: "project".to_string(),
            entity_id: stable_id("project", "gate-project"),
            archived_at: (now_millis() - (TOMBSTONE_RETENTION_DAYS as u64 + 1) * MILLIS_PER_DAY)
                .to_string(),
            project_id: None,
            title: Some("Gate project".to_string()),
            relative_path: None,
            path_hint: None,
            reason: None,
        };
        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: Vec::new(),
            conversations: BTreeMap::new(),
            tombstones: vec![old],
        };
        let health = SyncHealth {
            status: "healthy".to_string(),
            journal_path: "journal".to_string(),
            quarantine_path: "quarantine".to_string(),
            checked_at: now_text(),
            last_import_at: Some(now_text()),
            scanned_events: events.len(),
            accepted_events: events.len(),
            imported_events: events.len(),
            stored_events: events.len(),
            blocked_devices: Vec::new(),
            warnings: Vec::new(),
            can_write: true,
            recovery_action: "Nincs teendő".to_string(),
        };
        let report = SyncImportReport {
            scanned_events: events.len(),
            accepted_events: events.len(),
            imported_events: events.len(),
            blocked_devices: Vec::new(),
            warnings: Vec::new(),
            can_write: true,
        };

        let before = build_retention_preview(&RetentionRuntime {
            device_id: device_id.clone(),
            root: root.clone(),
            report: report.clone(),
            health: health.clone(),
            snapshot: snapshot.clone(),
            scan: JournalScan {
                accepted: events.clone(),
                scanned_events: scan.scanned_events,
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            },
        })
        .expect("build gate preview before ack");
        assert!(!before.protocol_ready);
        assert!(before
            .blocking_reasons
            .iter()
            .any(|reason| reason.contains("ACK")));

        let ack = write_retention_ack_at(&root, &device_id, &events).expect("write retention ack");
        let manifest = RetentionBackupManifest {
            schema_version: RETENTION_SCHEMA_VERSION,
            backup_id: Uuid::new_v4().to_string(),
            device_id: device_id.clone(),
            created_at: now_text(),
            event_count: events.len() as u64,
            bytes: 1,
            journal_digest: journal_digest(&events),
            backup_path: "C:\\external-retention-backup".to_string(),
            verified: true,
        };
        let manifest_path = retention_root(&root)
            .join("backups")
            .join(&device_id)
            .join(format!(
                "{}-{}.json",
                manifest.created_at, manifest.backup_id
            ));
        write_atomic(
            &manifest_path,
            &retention_metadata_bytes(&manifest).expect("serialize retention manifest"),
        )
        .expect("write retention manifest");
        let after = build_retention_preview(&RetentionRuntime {
            device_id,
            root: root.clone(),
            report,
            health,
            snapshot,
            scan,
        })
        .expect("build gate preview after ack");
        assert!(after.protocol_ready);
        assert!(after.purge_allowed);
        assert_eq!(after.current_journal_digest, ack.journal_digest);
        assert!(after.devices.iter().all(|device| device.ready));
        assert!(after
            .blocking_reasons
            .iter()
            .any(|reason| reason.contains("snapshot")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retention_backup_copy_round_trips_the_validated_journal() {
        let source = test_root();
        let target = test_root();
        let device_id = Uuid::new_v4().to_string();
        let first = test_event(&device_id, 1, None);
        let second = test_event(&device_id, 2, Some(first.event_hash.clone()));
        write_event(&source, &first).expect("write first backup event");
        write_event(&source, &second).expect("write second backup event");
        let (copied, copied_bytes) =
            copy_event_tree(&source.join("events"), &target.join("events"))
                .expect("copy retention backup");
        let verification = scan_journal(&target, &Uuid::new_v4().to_string())
            .expect("scan copied retention backup");
        assert_eq!(copied, 2);
        assert!(copied_bytes > 0);
        assert!(verification.warnings.is_empty());
        assert_eq!(verification.accepted.len(), 2);
        assert_eq!(
            journal_digest(&verification.accepted),
            journal_digest(&[first, second])
        );
        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(target);
    }

    #[test]
    fn retention_audit_is_append_only_and_keeps_latest_entries() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let event = test_event(&device_id, 1, None);
        let scan = JournalScan {
            accepted: vec![event],
            scanned_events: 1,
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        write_retention_audit(&root, &device_id, &scan, "purge", "started", 1, None, None)
            .expect("write purge start audit");
        let completed = write_retention_audit(
            &root,
            &device_id,
            &scan,
            "purge",
            "completed",
            1,
            Some(Uuid::new_v4().to_string()),
            None,
        )
        .expect("write purge completion audit");

        let (entries, warnings) = read_retention_audit(&root);
        assert!(warnings.is_empty());
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries.last().map(|entry| entry.audit_id.as_str()),
            Some(completed.audit_id.as_str())
        );
        assert_eq!(
            entries.last().map(|entry| entry.outcome.as_str()),
            Some("completed")
        );

        let audit_files =
            retention_json_files(&retention_root(&root).join("audit").join(&device_id))
                .expect("list audit files");
        assert_eq!(audit_files.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn compaction_snapshot_is_hash_checked_and_survives_event_purge() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let project = test_event(&device_id, 1, None);
        let tombstone = make_event(
            &device_id,
            2,
            format!("{:020}-{:08}", 2, 0),
            Some(project.event_hash.clone()),
            stable_id("project", "test-project"),
            TOMBSTONE_UPSERT.to_string(),
            serde_json::to_value(TombstoneEventPayload {
                entity_type: "project".to_string(),
                entity_id: stable_id("project", "test-project"),
                archived_at: (now_millis()
                    - (TOMBSTONE_RETENTION_DAYS as u64 + 1) * MILLIS_PER_DAY)
                    .to_string(),
                project_id: None,
                title: Some("Test project".to_string()),
                relative_path: Some("test-project".to_string()),
                path_hint: Some("C:\\test-project".to_string()),
                reason: Some("compaction test".to_string()),
            })
            .expect("tombstone payload"),
        )
        .expect("tombstone event");
        write_event(&root, &project).expect("write compaction project");
        write_event(&root, &tombstone).expect("write compaction tombstone");
        let scan =
            scan_journal(&root, &Uuid::new_v4().to_string()).expect("scan compaction journal");
        let mut local_store = test_store();
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("import compaction source"),
            2
        );
        let current = reduce_snapshot(&local_store.connection).expect("reduce compaction source");
        assert_eq!(current.tombstones.len(), 1);
        let candidates = current
            .tombstones
            .iter()
            .map(|tombstone| retention_candidate(tombstone, now_millis()))
            .collect::<Vec<_>>();
        let pruned = prune_snapshot_for_compaction(&current, &candidates);
        assert!(pruned.tombstones.is_empty());

        let (snapshot, snapshot_path) = write_compaction_snapshot(&root, &scan, pruned.clone())
            .expect("write compaction snapshot");
        purge_compacted_events(&root, &snapshot).expect("purge compacted events");
        assert!(snapshot_path.is_file());
        let compacted_scan =
            scan_journal(&root, &Uuid::new_v4().to_string()).expect("scan compacted journal");
        assert!(compacted_scan.warnings.is_empty());
        assert!(compacted_scan.accepted.is_empty());
        assert!(compacted_scan.snapshot.is_some());

        let mut fresh_store = test_store();
        assert_eq!(
            apply_events(&mut fresh_store, &compacted_scan).expect("import snapshot base"),
            0
        );
        let fresh_snapshot =
            reduce_snapshot(&fresh_store.connection).expect("reduce snapshot base");
        assert_eq!(
            serde_json::to_string(&fresh_snapshot).expect("serialize fresh snapshot"),
            serde_json::to_string(&pruned).expect("serialize pruned snapshot")
        );

        let appended = append_pending_events(
            &root,
            &device_id,
            &fresh_store,
            vec![PendingEvent {
                entity_id: stable_id("project", "test-project"),
                event_type: PROJECT_UPSERT.to_string(),
                payload: serde_json::json!({
                    "id": stable_id("project", "test-project"),
                    "name": "Recreated after compaction",
                    "relativePath": "test-project",
                    "pathHint": "C:\\test-project",
                    "threads": []
                }),
            }],
        )
        .expect("append follow-up event after compaction");
        assert_eq!(appended, 1);
        let follow_up_scan =
            scan_journal(&root, &Uuid::new_v4().to_string()).expect("scan follow-up journal");
        assert_eq!(follow_up_scan.accepted.len(), 1);
        assert_eq!(
            apply_events(&mut fresh_store, &follow_up_scan).expect("import follow-up event"),
            1
        );
        let recreated = reduce_snapshot(&fresh_store.connection).expect("reduce follow-up event");
        assert_eq!(recreated.projects.len(), 1);
        assert_eq!(recreated.projects[0].name, "Recreated after compaction");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn twelve_hundred_event_two_device_interleaving_converges() {
        let device_a = Uuid::new_v4().to_string();
        let device_b = Uuid::new_v4().to_string();
        let project_id = stable_id("project", "interleaving-project");
        let mut previous_a = None;
        let mut previous_b = None;
        let mut accepted = Vec::with_capacity(1200);

        for sequence in 1..=600_u64 {
            let event_a = make_event(
                &device_a,
                sequence,
                format!("{:020}-{:08}", sequence * 2, 0),
                previous_a.clone(),
                project_id.clone(),
                PROJECT_UPSERT.to_string(),
                serde_json::to_value(LocalProject {
                    id: project_id.clone(),
                    name: format!("A-{sequence}"),
                    relative_path: Some("interleaving".to_string()),
                    path_hint: "C:\\interleaving".to_string(),
                    threads: vec![format!("a-thread-{sequence}")],
                })
                .expect("project A payload"),
            )
            .expect("project A event");
            previous_a = Some(event_a.event_hash.clone());
            accepted.push(event_a);

            let event_b = make_event(
                &device_b,
                sequence,
                format!("{:020}-{:08}", sequence * 2 + 1, 0),
                previous_b.clone(),
                project_id.clone(),
                PROJECT_UPSERT.to_string(),
                serde_json::to_value(LocalProject {
                    id: project_id.clone(),
                    name: format!("B-{sequence}"),
                    relative_path: Some("interleaving".to_string()),
                    path_hint: "C:\\interleaving".to_string(),
                    threads: vec![format!("b-thread-{sequence}")],
                })
                .expect("project B payload"),
            )
            .expect("project B event");
            previous_b = Some(event_b.event_hash.clone());
            accepted.push(event_b);
        }

        let forward_scan = JournalScan {
            accepted: accepted.clone(),
            scanned_events: accepted.len(),
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        let reverse_scan = JournalScan {
            accepted: accepted.into_iter().rev().collect(),
            scanned_events: forward_scan.scanned_events,
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        let mut forward_store = test_store();
        let mut reverse_store = test_store();
        assert_eq!(
            apply_events(&mut forward_store, &forward_scan).expect("forward import"),
            1200
        );
        assert_eq!(
            apply_events(&mut reverse_store, &reverse_scan).expect("reverse import"),
            1200
        );
        let forward_snapshot = reduce_snapshot(&forward_store.connection).expect("forward reduce");
        let reverse_snapshot = reduce_snapshot(&reverse_store.connection).expect("reverse reduce");
        assert_eq!(
            serde_json::to_string(&forward_snapshot).expect("forward snapshot json"),
            serde_json::to_string(&reverse_snapshot).expect("reverse snapshot json")
        );
        assert_eq!(forward_snapshot.projects.len(), 1);
        assert_eq!(forward_snapshot.projects[0].threads.len(), 1200);
    }

    #[test]
    fn generated_interleavings_converge_across_multiple_seeds() {
        for seed in 1..=24_u64 {
            let mut rng = TestRng::new(seed * 7919);
            let device_a = Uuid::new_v4().to_string();
            let device_b = Uuid::new_v4().to_string();
            let project_ids = (0..3)
                .map(|index| stable_id("project", &format!("generated-{seed}-{index}")))
                .collect::<Vec<_>>();
            let mut previous = [None, None];
            let mut accepted = Vec::with_capacity(160);

            for sequence in 1..=80_u64 {
                for (device_index, device_id) in [&device_a, &device_b].into_iter().enumerate() {
                    let project_index = (rng.next_u64() as usize) % project_ids.len();
                    let project_id = project_ids[project_index].clone();
                    let physical =
                        sequence * 1_000 + (device_index as u64) * 400 + rng.next_u64() % 100;
                    let event = make_event(
                        device_id,
                        sequence,
                        format!("{:020}-{:08}", physical, 0),
                        previous[device_index].clone(),
                        project_id.clone(),
                        PROJECT_UPSERT.to_string(),
                        serde_json::to_value(LocalProject {
                            id: project_id,
                            name: format!("seed-{seed}-device-{device_index}-{sequence}"),
                            relative_path: Some(format!("generated/{seed}")),
                            path_hint: format!("C:\\generated\\{seed}"),
                            threads: vec![format!("thread-{seed}-{device_index}-{sequence}")],
                        })
                        .expect("generated project payload"),
                    )
                    .expect("generated project event");
                    previous[device_index] = Some(event.event_hash.clone());
                    accepted.push(event);
                }
            }

            rng.shuffle(&mut accepted);
            let forward_scan = JournalScan {
                accepted: accepted.clone(),
                scanned_events: accepted.len(),
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            };
            rng.shuffle(&mut accepted);
            let shuffled_scan = JournalScan {
                accepted,
                scanned_events: forward_scan.scanned_events,
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            };
            let mut forward_store = test_store();
            let mut shuffled_store = test_store();
            assert_eq!(
                apply_events(&mut forward_store, &forward_scan).expect("generated forward import"),
                160
            );
            assert_eq!(
                apply_events(&mut shuffled_store, &shuffled_scan)
                    .expect("generated shuffled import"),
                160
            );
            let forward_snapshot =
                reduce_snapshot(&forward_store.connection).expect("generated forward reduce");
            let shuffled_snapshot =
                reduce_snapshot(&shuffled_store.connection).expect("generated shuffled reduce");
            assert_eq!(
                serde_json::to_string(&forward_snapshot).expect("generated forward json"),
                serde_json::to_string(&shuffled_snapshot).expect("generated shuffled json"),
                "seed {seed} diverged"
            );
            assert_eq!(forward_snapshot.projects.len(), project_ids.len());
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn property_interleaving_converges_for_generated_device_chains(
            cases in prop::collection::vec((0_u8..3, any::<u64>(), any::<u64>()), 2..=48)
        ) {
            let device_a = stable_id("device", "proptest-a");
            let device_b = stable_id("device", "proptest-b");
            let project_ids = (0..3)
                .map(|index| stable_id("project", &format!("proptest-project-{index}")))
                .collect::<Vec<_>>();
            let mut previous = [None, None];
            let mut accepted = Vec::with_capacity(cases.len() * 2);

            for (sequence_index, (project_index, order_a, order_b)) in cases.iter().enumerate() {
                let sequence = (sequence_index + 1) as u64;
                let project_id = project_ids[*project_index as usize].clone();
                for (device_index, (device_id, order)) in [
                    (&device_a, *order_a),
                    (&device_b, *order_b),
                ]
                .into_iter()
                .enumerate()
                {
                    let event = make_event(
                        device_id,
                        sequence,
                        format!("{:020}-{:08}", order, device_index),
                        previous[device_index].clone(),
                        project_id.clone(),
                        PROJECT_UPSERT.to_string(),
                        serde_json::to_value(LocalProject {
                            id: project_id.clone(),
                            name: format!("property-{device_index}-{sequence}"),
                            relative_path: Some("property".to_string()),
                            path_hint: "C:\\property".to_string(),
                            threads: vec![format!("property-thread-{device_index}-{sequence}")],
                        })
                        .expect("property project payload"),
                    )
                    .expect("property project event");
                    previous[device_index] = Some(event.event_hash.clone());
                    accepted.push(event);
                }
            }

            let canonical_scan = JournalScan {
                accepted: accepted.clone(),
                scanned_events: accepted.len(),
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            };
            let mut permutation = (0..accepted.len()).collect::<Vec<_>>();
            permutation.sort_by_key(|index| {
                let sequence_index = index / 2;
                if index % 2 == 0 {
                    cases[sequence_index].1
                } else {
                    cases[sequence_index].2
                }
            });
            let permuted_scan = JournalScan {
                accepted: permutation
                    .into_iter()
                    .map(|index| accepted[index].clone())
                    .collect(),
                scanned_events: accepted.len(),
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            };
            let mut canonical_store = test_store();
            let mut permuted_store = test_store();
            prop_assert_eq!(
                apply_events(&mut canonical_store, &canonical_scan)
                    .expect("property canonical import"),
                accepted.len()
            );
            prop_assert_eq!(
                apply_events(&mut permuted_store, &permuted_scan)
                    .expect("property permuted import"),
                accepted.len()
            );
            let canonical_snapshot = reduce_snapshot(&canonical_store.connection)
                .expect("property canonical reduce");
            let permuted_snapshot = reduce_snapshot(&permuted_store.connection)
                .expect("property permuted reduce");
            prop_assert_eq!(
                serde_json::to_string(&canonical_snapshot).expect("property canonical JSON"),
                serde_json::to_string(&permuted_snapshot).expect("property permuted JSON")
            );
            let used_project_count = cases
                .iter()
                .map(|(project_index, _, _)| *project_index)
                .collect::<BTreeSet<_>>()
                .len();
            prop_assert_eq!(canonical_snapshot.projects.len(), used_project_count);
        }
    }

    #[test]
    fn long_two_device_soak_converges_across_repeated_permutations() {
        for seed in 1..=4_u64 {
            let mut rng = TestRng::new(seed * 104_729);
            let device_a = Uuid::new_v4().to_string();
            let device_b = Uuid::new_v4().to_string();
            let project_ids = (0..5)
                .map(|index| stable_id("project", &format!("soak-{seed}-{index}")))
                .collect::<Vec<_>>();
            let mut previous = [None, None];
            let mut accepted = Vec::with_capacity(1_000);

            for sequence in 1..=500_u64 {
                for (device_index, device_id) in [&device_a, &device_b].into_iter().enumerate() {
                    let project_id =
                        project_ids[(rng.next_u64() as usize) % project_ids.len()].clone();
                    let physical =
                        sequence * 10_000 + (device_index as u64) * 4_000 + rng.next_u64() % 4_000;
                    let event = make_event(
                        device_id,
                        sequence,
                        format!("{:020}-{:08}", physical, 0),
                        previous[device_index].clone(),
                        project_id.clone(),
                        PROJECT_UPSERT.to_string(),
                        serde_json::to_value(LocalProject {
                            id: project_id,
                            name: format!("soak-{seed}-{device_index}-{sequence}"),
                            relative_path: Some(format!("soak/{seed}")),
                            path_hint: format!("C:\\soak\\{seed}"),
                            threads: vec![format!("soak-thread-{seed}-{device_index}-{sequence}")],
                        })
                        .expect("soak project payload"),
                    )
                    .expect("soak project event");
                    previous[device_index] = Some(event.event_hash.clone());
                    accepted.push(event);
                }
            }

            let canonical_scan = JournalScan {
                accepted: accepted.clone(),
                scanned_events: accepted.len(),
                blocked_devices: HashSet::new(),
                warnings: Vec::new(),
                snapshot: None,
            };
            let mut canonical_store = test_store();
            assert_eq!(
                apply_events(&mut canonical_store, &canonical_scan).expect("soak canonical import"),
                1_000
            );
            let canonical_snapshot =
                reduce_snapshot(&canonical_store.connection).expect("soak canonical reduce");

            for permutation in 0..4 {
                let mut shuffled = accepted.clone();
                rng.shuffle(&mut shuffled);
                let shuffled_scan = JournalScan {
                    accepted: shuffled,
                    scanned_events: accepted.len(),
                    blocked_devices: HashSet::new(),
                    warnings: Vec::new(),
                    snapshot: None,
                };
                let mut shuffled_store = test_store();
                assert_eq!(
                    apply_events(&mut shuffled_store, &shuffled_scan)
                        .expect("soak shuffled import"),
                    1_000,
                    "seed {seed}, permutation {permutation}"
                );
                let shuffled_snapshot =
                    reduce_snapshot(&shuffled_store.connection).expect("soak shuffled reduce");
                assert_eq!(
                    serde_json::to_string(&canonical_snapshot).expect("soak canonical json"),
                    serde_json::to_string(&shuffled_snapshot).expect("soak shuffled json"),
                    "seed {seed}, permutation {permutation} diverged"
                );
                assert_eq!(shuffled_snapshot.projects.len(), project_ids.len());
            }
        }
    }

    #[test]
    fn malformed_event_is_quarantined_and_blocks_writes() {
        let root = test_root();
        let importer = Uuid::new_v4().to_string();
        let device_id = Uuid::new_v4().to_string();
        let event = test_event(&device_id, 1, None);
        write_event(&root, &event).expect("write event fixture");
        let event_path = root.join("events").join(&device_id).join(format!(
            "{:020}-{}.json",
            event.device_sequence, event.event_id
        ));
        fs::write(&event_path, b"{not-json").expect("corrupt event fixture");

        let scan = scan_journal(&root, &importer).expect("scan corrupt journal");
        assert_eq!(scan.scanned_events, 1);
        assert!(scan.accepted.is_empty());
        assert!(scan.blocked_devices.contains(&device_id));
        assert!(!scan.warnings.is_empty());
        let quarantine_directory = root.join("quarantine").join(&importer).join(&device_id);
        let quarantine_manifest_path = fs::read_dir(&quarantine_directory)
            .expect("quarantine directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .expect("quarantine manifest");
        let quarantine_manifest: QuarantineManifest = serde_json::from_slice(
            &fs::read(&quarantine_manifest_path).expect("read quarantine manifest"),
        )
        .expect("parse quarantine manifest");
        assert_eq!(
            quarantine_manifest.source_file,
            event_path.file_name().unwrap().to_string_lossy()
        );
        assert!(quarantine_manifest.content_sha256.is_some());
        assert!(quarantine_manifest
            .copied_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file()));
        let mut local_store = test_store();
        let report = import_into_store(&root, &importer, &mut local_store)
            .expect("import corrupt journal report");
        assert!(!report.can_write);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tombstone_hides_conversation_but_keeps_recovery_metadata() {
        let root = test_root();
        let device_id = Uuid::new_v4().to_string();
        let importer = Uuid::new_v4().to_string();
        let project_id = stable_id("project", "tombstone-project");
        let conversation_id = stable_id("conversation", "tombstone-conversation");
        let project = make_event(
            &device_id,
            1,
            format!("{:020}-{:08}", 1, 0),
            None,
            project_id.clone(),
            PROJECT_UPSERT.to_string(),
            serde_json::to_value(LocalProject {
                id: project_id.clone(),
                name: "Tombstone project".to_string(),
                relative_path: Some("tombstone".to_string()),
                path_hint: "C:\\tombstone".to_string(),
                threads: vec!["Recoverable".to_string()],
            })
            .expect("project payload"),
        )
        .expect("project event");
        let conversation = make_event(
            &device_id,
            2,
            format!("{:020}-{:08}", 2, 0),
            Some(project.event_hash.clone()),
            conversation_id.clone(),
            CONVERSATION_UPSERT.to_string(),
            serde_json::to_value(ConversationEventPayload {
                id: conversation_id.clone(),
                project_id: project_id.clone(),
                title: "Recoverable".to_string(),
                thread_id: Some("thread-recoverable".to_string()),
                updated_at: "2".to_string(),
                plan_history: BTreeMap::new(),
                commentary: Vec::new(),
            })
            .expect("conversation payload"),
        )
        .expect("conversation event");
        let tombstone = make_event(
            &device_id,
            3,
            format!("{:020}-{:08}", 3, 0),
            Some(conversation.event_hash.clone()),
            conversation_id.clone(),
            TOMBSTONE_UPSERT.to_string(),
            serde_json::to_value(TombstoneEventPayload {
                entity_type: "conversation".to_string(),
                entity_id: conversation_id.clone(),
                archived_at: "3".to_string(),
                project_id: Some(project_id.clone()),
                title: Some("Recoverable".to_string()),
                relative_path: Some("tombstone".to_string()),
                path_hint: Some("C:\\tombstone".to_string()),
                reason: Some("test archive".to_string()),
            })
            .expect("tombstone payload"),
        )
        .expect("tombstone event");
        write_event(&root, &project).expect("write project");
        write_event(&root, &conversation).expect("write conversation");
        write_event(&root, &tombstone).expect("write tombstone");

        let scan = scan_journal(&root, &importer).expect("scan tombstone journal");
        let mut local_store = test_store();
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("import tombstone"),
            3
        );
        let snapshot = reduce_snapshot(&local_store.connection).expect("reduce tombstone");
        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.conversations.is_empty());
        assert_eq!(snapshot.tombstones.len(), 1);
        assert_eq!(snapshot.tombstones[0].entity_type, "conversation");
        assert_eq!(snapshot.tombstones[0].entity_id, conversation_id);
        assert_eq!(
            snapshot.tombstones[0].reason.as_deref(),
            Some("test archive")
        );

        let restore = make_event(
            &device_id,
            4,
            format!("{:020}-{:08}", 4, 0),
            Some(tombstone.event_hash.clone()),
            conversation_id.clone(),
            ENTITY_RESTORE.to_string(),
            serde_json::to_value(TombstoneEventPayload {
                entity_type: "conversation".to_string(),
                entity_id: conversation_id.clone(),
                archived_at: "3".to_string(),
                project_id: Some(project_id),
                title: Some("Recoverable".to_string()),
                relative_path: Some("tombstone".to_string()),
                path_hint: Some("C:\\tombstone".to_string()),
                reason: Some("test restore".to_string()),
            })
            .expect("restore payload"),
        )
        .expect("restore event");
        write_event(&root, &restore).expect("write restore");
        let restore_scan = scan_journal(&root, &importer).expect("scan restore journal");
        assert_eq!(
            apply_events(&mut local_store, &restore_scan).expect("import restore"),
            1
        );
        let restored_snapshot = reduce_snapshot(&local_store.connection).expect("reduce restore");
        assert_eq!(restored_snapshot.conversations.len(), 1);
        assert!(restored_snapshot.tombstones.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_events_is_idempotent() {
        let mut local_store = test_store();
        let device_id = Uuid::new_v4().to_string();
        let first = test_event(&device_id, 1, None);
        let second = test_event(&device_id, 2, Some(first.event_hash.clone()));
        let scan = JournalScan {
            accepted: vec![first, second],
            scanned_events: 2,
            blocked_devices: HashSet::new(),
            warnings: Vec::new(),
            snapshot: None,
        };
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("first import"),
            2
        );
        assert_eq!(
            apply_events(&mut local_store, &scan).expect("second import"),
            0
        );
        let count: i64 = local_store
            .connection
            .query_row("SELECT COUNT(*) FROM sync_events", [], |row| row.get(0))
            .expect("event count");
        assert_eq!(count, 2);
    }
}
