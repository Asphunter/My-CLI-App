use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub const STORE_SCHEMA_VERSION: i64 = 19;
// The public snapshot and sync contracts represent GENERAL with
// projectId = null. SQLite keeps this hidden FK target only because the
// existing conversations.project_id column is intentionally NOT NULL and
// changing that live table would put legacy Coding data at unnecessary risk.
pub const GENERAL_PROJECT_ID: &str = "system-general-scope-v1";
pub const GENERAL_SCOPE: &str = "general";
pub const CODING_SCOPE: &str = "coding";

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    last_hlc TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    relative_path TEXT,
    local_available INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    scope TEXT NOT NULL DEFAULT 'coding',
    title TEXT NOT NULL,
    codex_thread_id TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    plan_history_json TEXT NOT NULL DEFAULT '{}',
    commentary_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    body TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hlc TEXT,
    item_id TEXT,
    turn_id TEXT,
    code INTEGER NOT NULL DEFAULT 0,
    live INTEGER NOT NULL DEFAULT 0,
    final INTEGER NOT NULL DEFAULT 0,
    origin_device_id TEXT REFERENCES devices(id),
    attachments_json TEXT NOT NULL DEFAULT '[]',
    quote_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
    ON messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT,
    codex_thread_id TEXT,
    codex_turn_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
    item_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL,
    event_type TEXT NOT NULL,
    body TEXT,
    code TEXT,
    plan_step_id TEXT,
    before_code TEXT,
    after_code TEXT,
    language TEXT,
    sequence INTEGER NOT NULL,
    hlc TEXT,
    origin_device_id TEXT REFERENCES devices(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_conversation_sequence
    ON work_items(conversation_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_items_conversation_sequence
    ON work_items(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS sync_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id),
    device_sequence INTEGER NOT NULL,
    hlc TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    previous_hash TEXT,
    imported_at TEXT,
    UNIQUE(device_id, device_sequence)
);

CREATE INDEX IF NOT EXISTS idx_sync_events_entity
    ON sync_events(event_type, entity_id, payload_hash);

CREATE TABLE IF NOT EXISTS sync_cursors (
    source_device_id TEXT PRIMARY KEY NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    last_hash TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    project_id TEXT,
    title TEXT,
    relative_path TEXT,
    path_hint TEXT,
    reason TEXT,
    PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    action_kind TEXT NOT NULL,
    target TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    retention_class TEXT NOT NULL,
    restore_status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_records (
    source_sha256 TEXT NOT NULL,
    source_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY(source_sha256, source_key, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_import_records_entity
    ON import_records(entity_type, entity_id);
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreHealth {
    pub path: String,
    pub status: String,
    pub schema_version: Option<i64>,
    pub integrity: String,
    pub recovery_required: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStoreSnapshot {
    pub schema_version: i64,
    pub projects: Vec<LocalProject>,
    pub conversations: BTreeMap<String, LocalConversation>,
    #[serde(default)]
    pub tombstones: Vec<LocalTombstone>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub name: String,
    pub relative_path: Option<String>,
    pub path_hint: String,
    pub threads: Vec<String>,
}

fn default_coding_scope() -> String {
    CODING_SCOPE.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversation {
    pub id: Option<String>,
    #[serde(default = "default_coding_scope")]
    pub scope: String,
    pub project_id: String,
    pub title: String,
    pub messages: Vec<LocalMessage>,
    pub work_items: Vec<LocalWorkItem>,
    pub thread_id: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub plan_history: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub commentary: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTombstone {
    pub entity_type: String,
    pub entity_id: String,
    pub archived_at: String,
    pub project_id: Option<String>,
    pub title: Option<String>,
    pub relative_path: Option<String>,
    pub path_hint: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMessage {
    pub id: Option<String>,
    pub role: String,
    pub text: String,
    pub time: String,
    pub code: Option<bool>,
    pub live: Option<bool>,
    #[serde(rename = "final")]
    pub final_message: Option<bool>,
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hlc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<LocalImageAttachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quote_refs: Vec<LocalQuoteReference>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessageEventPayload {
    conversation_id: String,
    message: LocalMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalQuoteReference {
    pub id: String,
    pub text: String,
    pub instruction: String,
    pub anchor_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageAttachment {
    pub path: String,
    pub name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkItem {
    pub id: i64,
    pub item_id: Option<String>,
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_step_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub label: String,
    pub detail: String,
    pub event_type: String,
    pub time: String,
    pub body: Option<String>,
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_code: Option<String>,
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hlc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_device_id: Option<String>,
}

pub struct LocalStore {
    pub path: PathBuf,
    pub connection: Connection,
}

pub fn local_store_path() -> Result<PathBuf, String> {
    let base = env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "A lokális min-adattár helye nem határozható meg.".to_string())?;
    Ok(PathBuf::from(base).join("min").join("min.db"))
}

fn read_schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("A lokális SQLite schema-verziója nem olvasható: {error}"))
}

fn check_integrity(connection: &Connection) -> Result<String, String> {
    let result: String = connection
        .query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))
        .map_err(|error| {
            format!("A lokális SQLite integrity_check futtatása sikertelen: {error}")
        })?;
    if result != "ok" {
        return Err(format!("A lokális SQLite-adatbázis nem ép: {result}"));
    }
    Ok(result)
}

fn verify_existing_database(path: &Path) -> Result<(), String> {
    if !path.is_file()
        || fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
            == 0
    {
        return Ok(());
    }
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            format!("A lokális SQLite csak olvasható ellenőrzése sikertelen: {error}")
        })?;
    check_integrity(&connection).map(|_| ())
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("A lokális SQLite foreign key módja nem állítható be: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("A lokális SQLite timeoutja nem állítható be: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("A lokális SQLite WAL módja nem állítható be: {error}"))?;
    Ok(())
}

fn restore_first_written_user_payloads(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<usize, String> {
    // message.upsert is append-only. The first event for one user message is
    // the submitted payload; later events may enrich metadata but must never
    // rewrite the question. v14 uses that journal as the repair authority for
    // databases damaged by the former "longer text wins" merge.
    let has_sync_events: bool = transaction
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'sync_events'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("A v14 sync schema nem ellenőrizhető: {error}"))?;
    if !has_sync_events {
        return Ok(0);
    }
    let payloads = {
        let mut statement = transaction
            .prepare(
                "SELECT payload_json
                 FROM sync_events
                 WHERE event_type = 'message.upsert'
                 ORDER BY hlc, device_id, device_sequence, event_id",
            )
            .map_err(|error| format!("A v14 user-journal nem olvasható: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("A v14 user-journal nem járható be: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A v14 user-journal sora hibás: {error}"))?;
        rows
    };

    let mut first_written = BTreeMap::<(String, String), LocalMessage>::new();
    for payload_json in payloads {
        let Ok(payload) = serde_json::from_str::<StoredMessageEventPayload>(&payload_json) else {
            continue;
        };
        if payload.message.role != "user" {
            continue;
        }
        let Some(message_id) = payload
            .message
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        first_written
            .entry((payload.conversation_id, message_id.to_string()))
            .or_insert(payload.message);
    }

    let mut repaired = 0usize;
    for ((conversation_id, message_id), message) in first_written {
        let attachments_json = serde_json::to_string(&message.images)
            .map_err(|error| format!("A v14 user-csatolmány nem írható: {error}"))?;
        let quote_refs_json = serde_json::to_string(&message.quote_refs)
            .map_err(|error| format!("A v14 user-idézet nem írható: {error}"))?;
        repaired += transaction
            .execute(
                "UPDATE messages
                 SET body = ?1,
                     sequence = COALESCE(?2, sequence),
                     created_at = CASE WHEN trim(?3) <> '' THEN ?3 ELSE created_at END,
                     attachments_json = ?4,
                     quote_refs_json = ?5,
                     item_id = COALESCE(item_id, ?6),
                     turn_id = COALESCE(turn_id, ?7)
                 WHERE id = ?8 AND conversation_id = ?9 AND role = 'user'",
                params![
                    message.text,
                    message.sequence,
                    message.time,
                    attachments_json,
                    quote_refs_json,
                    message.item_id,
                    message.turn_id,
                    message_id,
                    conversation_id,
                ],
            )
            .map_err(|error| format!("A v14 user-input javítása sikertelen: {error}"))?;
    }
    Ok(repaired)
}

fn same_user_payload(left: &LocalMessage, right: &LocalMessage) -> bool {
    left.role == "user"
        && right.role == "user"
        && left.text == right.text
        && left.images == right.images
}

fn collapse_abandoned_regeneration_retries(messages: &[LocalMessage]) -> Vec<LocalMessage> {
    let mut output = Vec::<LocalMessage>::new();
    let answered_users = messages
        .windows(2)
        .filter(|pair| {
            pair[0].role == "user" && pair[1].role == "assistant" && !pair[1].text.trim().is_empty()
        })
        .map(|pair| &pair[0])
        .collect::<Vec<_>>();
    let mut index = 0usize;
    while index < messages.len() {
        let retry_user = &messages[index];
        let retry_answer = messages.get(index + 1);
        let abandoned = matches!(
            retry_answer,
            Some(retry_answer)
                if retry_answer.role == "assistant"
                    && retry_answer.text.trim().is_empty()
                    && !retry_answer.live.unwrap_or(false)
                    && !retry_answer.final_message.unwrap_or(false)
                    && retry_user.turn_id.is_some()
                    && retry_user.turn_id == retry_answer.turn_id
                    && answered_users.iter().any(|answered_user| {
                        !std::ptr::eq(*answered_user, retry_user)
                            && same_user_payload(answered_user, retry_user)
                    })
        );
        if abandoned {
            index += 2;
            continue;
        }
        output.push(messages[index].clone());
        index += 1;
    }
    output
}

pub fn initialize_connection(connection: &mut Connection) -> Result<(), String> {
    let version = read_schema_version(connection)?;
    if version > STORE_SCHEMA_VERSION {
        return Err(format!(
            "A lokális SQLite schema újabb, mint amit ez a verzió támogat ({version} > {STORE_SCHEMA_VERSION}); recovery szükséges."
        ));
    }
    if version == 0 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(SCHEMA_SQL)
            .map_err(|error| format!("A lokális SQLite schema létrehozása sikertelen: {error}"))?;
        transaction
            .pragma_update(None, "user_version", STORE_SCHEMA_VERSION)
            .map_err(|error| {
                format!("A lokális SQLite schema-verzió mentése sikertelen: {error}")
            })?;
        transaction
            .commit()
            .map_err(|error| format!("A lokális SQLite migráció commitja sikertelen: {error}"))?;
    } else if version == 1 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v2 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE messages ADD COLUMN item_id TEXT;
                 ALTER TABLE messages ADD COLUMN code INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE messages ADD COLUMN live INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE messages ADD COLUMN final INTEGER NOT NULL DEFAULT 0;
                 CREATE UNIQUE INDEX uq_messages_conversation_sequence ON messages(conversation_id, sequence);
                 CREATE UNIQUE INDEX uq_work_items_conversation_sequence ON work_items(conversation_id, sequence);
                 ALTER TABLE sync_events ADD COLUMN entity_id TEXT NOT NULL DEFAULT '';
                 ALTER TABLE sync_events ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';
                 CREATE INDEX IF NOT EXISTS idx_sync_events_entity
                     ON sync_events(event_type, entity_id, payload_hash);
                 CREATE TABLE IF NOT EXISTS sync_tombstones (
                     entity_type TEXT NOT NULL,
                     entity_id TEXT NOT NULL,
                     archived_at TEXT NOT NULL,
                     project_id TEXT,
                     title TEXT,
                     relative_path TEXT,
                     path_hint TEXT,
                     reason TEXT,
                     PRIMARY KEY(entity_type, entity_id)
                 );
                  ALTER TABLE work_items ADD COLUMN hlc TEXT;
                  ALTER TABLE work_items ADD COLUMN origin_device_id TEXT REFERENCES devices(id);
                  PRAGMA user_version = 5;",
            )
            .map_err(|error| format!("A lokális SQLite v2 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v2 migráció commitja sikertelen: {error}")
        })?;
    } else if version == 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v3 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE sync_events ADD COLUMN entity_id TEXT NOT NULL DEFAULT '';\n                 ALTER TABLE sync_events ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';\n                 CREATE INDEX IF NOT EXISTS idx_sync_events_entity\n                     ON sync_events(event_type, entity_id, payload_hash);\n                 CREATE TABLE IF NOT EXISTS sync_tombstones (\n                     entity_type TEXT NOT NULL,\n                     entity_id TEXT NOT NULL,\n                     archived_at TEXT NOT NULL,\n                     project_id TEXT,\n                     title TEXT,\n                     relative_path TEXT,\n                     path_hint TEXT,\n                     reason TEXT,\n                     PRIMARY KEY(entity_type, entity_id)\n                 );\n                 ALTER TABLE work_items ADD COLUMN hlc TEXT;\n                 ALTER TABLE work_items ADD COLUMN origin_device_id TEXT REFERENCES devices(id);\n                 PRAGMA user_version = 5;",
            )
            .map_err(|error| format!("A lokális SQLite v3 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v3 migráció commitja sikertelen: {error}")
        })?;
    } else if version == 3 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v4 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS sync_tombstones (
                     entity_type TEXT NOT NULL,
                     entity_id TEXT NOT NULL,
                     archived_at TEXT NOT NULL,
                     project_id TEXT,
                     title TEXT,
                     relative_path TEXT,
                     path_hint TEXT,
                     reason TEXT,
                     PRIMARY KEY(entity_type, entity_id)
                 );
                 ALTER TABLE work_items ADD COLUMN hlc TEXT;\n                 ALTER TABLE work_items ADD COLUMN origin_device_id TEXT REFERENCES devices(id);\n                 PRAGMA user_version = 5;",
            )
            .map_err(|error| format!("A lokális SQLite v4 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v4 migráció commitja sikertelen: {error}")
        })?;
    } else if version == 4 {
        let transaction = connection.transaction().map_err(|error| {
            format!("A lokÃ¡lis SQLite v5 migrÃ¡ciÃ³ nem indÃ­thatÃ³ el: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE work_items ADD COLUMN hlc TEXT;
                 ALTER TABLE work_items ADD COLUMN origin_device_id TEXT REFERENCES devices(id);
                 PRAGMA user_version = 5;",
            )
            .map_err(|error| format!("A lokÃ¡lis SQLite v5 migrÃ¡ciÃ³ sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokÃ¡lis SQLite v5 migrÃ¡ciÃ³ commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 5 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v6 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE work_items ADD COLUMN plan_step_id TEXT;
                 ALTER TABLE work_items ADD COLUMN before_code TEXT;
                 ALTER TABLE work_items ADD COLUMN after_code TEXT;
                 PRAGMA user_version = 6;",
            )
            .map_err(|error| format!("A lokális SQLite v6 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v6 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 6 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v7 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 7;",
            )
            .map_err(|error| format!("A lokális SQLite v7 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v7 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 7 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v8 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE conversations ADD COLUMN plan_history_json TEXT NOT NULL DEFAULT '{}';
                 ALTER TABLE conversations ADD COLUMN commentary_json TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 8;",
            )
            .map_err(|error| format!("A lokális SQLite v8 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v8 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 8 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v9 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE messages ADD COLUMN turn_id TEXT;
                 PRAGMA user_version = 9;",
            )
            .map_err(|error| format!("A lokális SQLite v9 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v9 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 9 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v10 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE messages ADD COLUMN quote_refs_json TEXT NOT NULL DEFAULT '[]';
                 PRAGMA user_version = 10;",
            )
            .map_err(|error| format!("A lokális SQLite v10 migráció sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v10 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 10 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v11 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A messages schema olvasása sikertelen: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A messages oszlopok bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A messages schema hibás: {error}"))?;
            columns
        };
        if message_columns.iter().any(|column| column == "role")
            && message_columns.iter().any(|column| column == "body")
        {
            let rows = {
                let mut statement = transaction
                    .prepare("SELECT id, role, body FROM messages WHERE role = 'assistant'")
                    .map_err(|error| {
                        format!("A sérült válaszok felderítése sikertelen: {error}")
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|error| format!("A sérült válaszok bejárása sikertelen: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("A sérült válaszadat hibás: {error}"))?;
                rows
            };
            for (id, role, body) in rows {
                let repaired = collapse_repeated_assistant_text(&role, &body);
                if repaired != body {
                    transaction
                        .execute(
                            "UPDATE messages SET body = ?1 WHERE id = ?2",
                            params![repaired, id],
                        )
                        .map_err(|error| {
                            format!("A duplikált válasz javítása sikertelen: {error}")
                        })?;
                }
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 11;")
            .map_err(|error| format!("A lokális SQLite v11 verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v11 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 11 {
        // v11's detector was bounded to 64 exact copies. Re-run the repair
        // with the unbounded linear detector for already-migrated 100+ copy
        // rows. Identities and timeline order remain untouched.
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v12 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v12 messages schema olvasása sikertelen: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v12 messages oszlopok bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A v12 messages schema hibás: {error}"))?;
            columns
        };
        if message_columns.iter().any(|column| column == "role")
            && message_columns.iter().any(|column| column == "body")
        {
            let rows = {
                let mut statement = transaction
                    .prepare("SELECT id, role, body FROM messages WHERE role = 'assistant'")
                    .map_err(|error| {
                        format!("A v12 sérült válaszainak felderítése sikertelen: {error}")
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|error| {
                        format!("A v12 sérült válaszainak bejárása sikertelen: {error}")
                    })?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("A v12 sérült válaszadata hibás: {error}"))?;
                rows
            };
            for (id, role, body) in rows {
                let repaired = collapse_repeated_assistant_text(&role, &body);
                if repaired != body {
                    transaction
                        .execute(
                            "UPDATE messages SET body = ?1 WHERE id = ?2",
                            params![repaired, id],
                        )
                        .map_err(|error| {
                            format!("A v12 duplikált válasz javítása sikertelen: {error}")
                        })?;
                }
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 12;")
            .map_err(|error| format!("A lokális SQLite v12 verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v12 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 12 {
        // v12 deliberately required three copies, but the original
        // two-listener failure persisted many rows as answer+answer. Repair
        // exact two-copy assistant bodies without touching row identity/order.
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v13 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v13 messages schema olvasása sikertelen: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v13 messages oszlopok bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A v13 messages schema hibás: {error}"))?;
            columns
        };
        if message_columns.iter().any(|column| column == "role")
            && message_columns.iter().any(|column| column == "body")
        {
            let rows = {
                let mut statement = transaction
                    .prepare("SELECT id, role, body FROM messages WHERE role = 'assistant'")
                    .map_err(|error| {
                        format!("A v13 sérült válaszainak felderítése sikertelen: {error}")
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|error| {
                        format!("A v13 sérült válaszainak bejárása sikertelen: {error}")
                    })?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("A v13 sérült válaszadata hibás: {error}"))?;
                rows
            };
            for (id, role, body) in rows {
                let repaired = collapse_repeated_assistant_text(&role, &body);
                if repaired != body {
                    transaction
                        .execute(
                            "UPDATE messages SET body = ?1 WHERE id = ?2",
                            params![repaired, id],
                        )
                        .map_err(|error| {
                            format!("A v13 duplikált válasz javítása sikertelen: {error}")
                        })?;
                }
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 13;")
            .map_err(|error| format!("A lokális SQLite v13 verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v13 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 13 {
        // Sequence is an immutable ordering hint, not a globally unique row
        // identity: two offline devices can allocate the same millisecond.
        // Restore already-corrupted user payloads from their first append-only
        // journal event before applying the narrow legacy retry cleanup.
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v14 migráció nem indítható el: {error}"))?;
        transaction
            .execute_batch("DROP INDEX IF EXISTS uq_messages_conversation_sequence;")
            .map_err(|error| format!("A v14 message-index migráció sikertelen: {error}"))?;
        restore_first_written_user_payloads(&transaction)?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v14 messages schema nem olvasható: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v14 messages schema nem járható be: {error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("A v14 messages schema hibás: {error}"))?;
            rows
        };
        let required_columns = [
            "id",
            "conversation_id",
            "role",
            "body",
            "created_at",
            "code",
            "live",
            "final",
            "item_id",
            "turn_id",
            "sequence",
            "hlc",
            "origin_device_id",
            "attachments_json",
            "quote_refs_json",
        ];
        let rows = if required_columns
            .iter()
            .all(|column| message_columns.contains(*column))
        {
            let mut statement = transaction
                .prepare(
                    "SELECT id, conversation_id, role, body, created_at, code, live, \"final\",
                            item_id, turn_id, sequence, hlc, origin_device_id,
                            attachments_json, quote_refs_json
                     FROM messages
                     ORDER BY conversation_id, sequence, id",
                )
                .map_err(|error| {
                    format!("A v14 regenerálási sorok felderítése sikertelen: {error}")
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(1)?,
                        LocalMessage {
                            id: Some(row.get(0)?),
                            role: row.get(2)?,
                            text: row.get(3)?,
                            time: row.get(4)?,
                            code: Some(row.get::<_, i64>(5)? != 0),
                            live: Some(row.get::<_, i64>(6)? != 0),
                            final_message: Some(row.get::<_, i64>(7)? != 0),
                            item_id: row.get(8)?,
                            turn_id: row.get(9)?,
                            sequence: Some(row.get(10)?),
                            hlc: row.get(11)?,
                            origin_device_id: row.get(12)?,
                            images: serde_json::from_str(&row.get::<_, String>(13)?)
                                .unwrap_or_default(),
                            quote_refs: serde_json::from_str(&row.get::<_, String>(14)?)
                                .unwrap_or_default(),
                        },
                    ))
                })
                .map_err(|error| format!("A v14 regenerálási sorok bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A v14 regenerálási soradata hibás: {error}"))?;
            rows
        } else {
            Vec::new()
        };
        let mut by_conversation = BTreeMap::<String, Vec<LocalMessage>>::new();
        for (conversation_id, message) in rows {
            by_conversation
                .entry(conversation_id)
                .or_default()
                .push(message);
        }
        for messages in by_conversation.into_values() {
            let kept_ids = collapse_abandoned_regeneration_retries(&messages)
                .into_iter()
                .filter_map(|message| message.id)
                .collect::<HashSet<_>>();
            for id in messages.into_iter().filter_map(|message| message.id) {
                if !kept_ids.contains(&id) {
                    transaction
                        .execute("DELETE FROM messages WHERE id = ?1", params![id])
                        .map_err(|error| {
                            format!("A v14 duplikált regenerálási sor javítása sikertelen: {error}")
                        })?;
                }
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 14;")
            .map_err(|error| format!("A lokális SQLite v14 verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v14 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 14 {
        // Remove only provable aliases left by old checkpoint/reducer ids.
        // Distinct user UUIDs with the same sequence remain intact.
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v15 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v15 messages schema nem olvasható: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v15 messages schema nem járható be: {error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("A v15 messages schema hibás: {error}"))?;
            rows
        };
        if [
            "id",
            "conversation_id",
            "role",
            "body",
            "sequence",
            "hlc",
            "turn_id",
            "item_id",
        ]
        .iter()
        .all(|column| message_columns.contains(*column))
        {
            transaction
                .execute_batch(
                    "DELETE FROM messages WHERE id IN (
                     SELECT id FROM (
                         SELECT id,
                                ROW_NUMBER() OVER (
                                    PARTITION BY conversation_id, role, turn_id
                                    ORDER BY COALESCE(hlc, ''), sequence, id
                                ) AS alias_rank
                         FROM messages
                         WHERE turn_id IS NOT NULL AND trim(turn_id) <> ''
                     ) WHERE alias_rank > 1
                 );
                 DELETE FROM messages WHERE id IN (
                     SELECT id FROM (
                         SELECT id,
                                ROW_NUMBER() OVER (
                                    PARTITION BY conversation_id, role, item_id
                                    ORDER BY COALESCE(hlc, ''), sequence, id
                                ) AS alias_rank
                         FROM messages
                         WHERE item_id IS NOT NULL AND trim(item_id) <> ''
                     ) WHERE alias_rank > 1
                 );
                 DELETE FROM messages WHERE id IN (
                     SELECT id FROM (
                         SELECT id,
                                ROW_NUMBER() OVER (
                                    PARTITION BY conversation_id, sequence, body
                                    ORDER BY COALESCE(hlc, ''), id
                                ) AS alias_rank
                         FROM messages
                         WHERE role = 'assistant'
                           AND (turn_id IS NULL OR trim(turn_id) = '')
                           AND (item_id IS NULL OR trim(item_id) = '')
                     ) WHERE alias_rank > 1
                 );",
                )
                .map_err(|error| format!("A v15 message-alias migráció sikertelen: {error}"))?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 15;")
            .map_err(|error| format!("A v15 schema-verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v15 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 15 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v16 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v16 messages schema nem olvasható: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v16 messages schema nem járható be: {error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("A v16 messages schema hibás: {error}"))?;
            rows
        };
        if [
            "id",
            "conversation_id",
            "role",
            "body",
            "sequence",
            "turn_id",
            "live",
            "final",
            "attachments_json",
            "quote_refs_json",
        ]
        .iter()
        .all(|column| message_columns.contains(*column))
        {
            transaction
                .execute_batch(
                    "CREATE TEMP TABLE abandoned_regeneration_rows (id TEXT PRIMARY KEY);
                 INSERT OR IGNORE INTO abandoned_regeneration_rows (id)
                 SELECT retry_user.id
                 FROM messages retry_user
                 JOIN messages retry_answer
                   ON retry_answer.conversation_id = retry_user.conversation_id
                  AND retry_answer.role = 'assistant'
                  AND retry_answer.turn_id = retry_user.turn_id
                 WHERE retry_user.role = 'user'
                   AND retry_user.turn_id IS NOT NULL
                   AND trim(retry_user.turn_id) <> ''
                   AND trim(retry_answer.body) = ''
                   AND retry_answer.[final] = 0
                   AND EXISTS (
                       SELECT 1
                       FROM messages answered_user
                       JOIN messages answered_assistant
                         ON answered_assistant.conversation_id = answered_user.conversation_id
                        AND answered_assistant.role = 'assistant'
                        AND answered_assistant.sequence > answered_user.sequence
                       WHERE answered_user.conversation_id = retry_user.conversation_id
                         AND answered_user.role = 'user'
                         AND answered_user.id <> retry_user.id
                         AND answered_user.body = retry_user.body
                         AND answered_user.attachments_json = retry_user.attachments_json
                         AND trim(answered_assistant.body) <> ''
                   );
                 INSERT OR IGNORE INTO abandoned_regeneration_rows (id)
                 SELECT retry_answer.id
                 FROM messages retry_answer
                 JOIN messages retry_user
                   ON retry_user.conversation_id = retry_answer.conversation_id
                  AND retry_user.role = 'user'
                  AND retry_user.turn_id = retry_answer.turn_id
                 JOIN abandoned_regeneration_rows abandoned
                   ON abandoned.id = retry_user.id
                 WHERE retry_answer.role = 'assistant'
                   AND trim(retry_answer.body) = ''
                   AND retry_answer.[final] = 0;
                 DELETE FROM messages
                 WHERE id IN (SELECT id FROM abandoned_regeneration_rows);
                 DROP TABLE abandoned_regeneration_rows;",
                )
                .map_err(|error| {
                    format!("A v16 félbehagyott regenerálás javítása sikertelen: {error}")
                })?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 16;")
            .map_err(|error| format!("A v16 schema-verzió mentése sikertelen: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v16 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 16 || migrated_version == 17 {
        // A restarted legacy placeholder can remain live=1 even though no
        // native request exists anymore. The answered identical source turn
        // still proves that this empty pair is an abandoned regeneration.
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v18 migráció nem indítható el: {error}"))?;
        let message_columns = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(messages)")
                .map_err(|error| format!("A v18 messages schema nem olvasható: {error}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v18 messages schema nem járható be: {error}"))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|error| format!("A v18 messages schema hibás: {error}"))?;
            rows
        };
        let can_cleanup = [
            "id",
            "conversation_id",
            "role",
            "body",
            "sequence",
            "turn_id",
            "final",
            "attachments_json",
        ]
        .iter()
        .all(|column| message_columns.contains(*column));
        if can_cleanup {
            transaction
                .execute_batch(
                    "WITH abandoned AS (
                     SELECT retry_user.id AS user_id, retry_answer.id AS answer_id
                     FROM messages retry_user
                     JOIN messages retry_answer
                       ON retry_answer.conversation_id = retry_user.conversation_id
                      AND retry_answer.role = 'assistant'
                      AND retry_answer.turn_id = retry_user.turn_id
                     WHERE retry_user.role = 'user'
                       AND retry_user.turn_id IS NOT NULL
                       AND trim(retry_user.turn_id) <> ''
                       AND trim(retry_answer.body) = ''
                       AND retry_answer.[final] = 0
                       AND EXISTS (
                           SELECT 1
                           FROM messages answered_user
                           JOIN messages answered_assistant
                             ON answered_assistant.conversation_id = answered_user.conversation_id
                            AND answered_assistant.role = 'assistant'
                            AND answered_assistant.sequence > answered_user.sequence
                           WHERE answered_user.conversation_id = retry_user.conversation_id
                             AND answered_user.role = 'user'
                             AND answered_user.id <> retry_user.id
                             AND answered_user.body = retry_user.body
                             AND answered_user.attachments_json = retry_user.attachments_json
                             AND trim(answered_assistant.body) <> ''
                       )
                 )
                 DELETE FROM messages
                 WHERE id IN (
                     SELECT user_id FROM abandoned
                     UNION SELECT answer_id FROM abandoned
                 );
                 PRAGMA user_version = 18;",
                )
                .map_err(|error| {
                    format!("A v18 félbehagyott regenerálás javítása sikertelen: {error}")
                })?;
        } else {
            transaction
                .execute_batch("PRAGMA user_version = 18;")
                .map_err(|error| format!("A v18 schema-verzió mentése sikertelen: {error}"))?;
        }
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v18 migráció commitja sikertelen: {error}")
        })?;
    }
    let migrated_version = read_schema_version(connection)?;
    if migrated_version == 18 {
        let has_scope_column = {
            let mut statement = connection
                .prepare("PRAGMA table_info(conversations)")
                .map_err(|error| format!("A v19 schema oszlopai nem ellenőrizhetők: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("A v19 schema oszloplista nem olvasható: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A v19 schema oszloplista hibás: {error}"))?;
            columns.iter().any(|column| column == "scope")
        };
        let transaction = connection
            .transaction()
            .map_err(|error| format!("A lokális SQLite v19 migráció nem indítható el: {error}"))?;
        if !has_scope_column {
            transaction
                .execute_batch(
                    "ALTER TABLE conversations ADD COLUMN scope TEXT NOT NULL DEFAULT 'coding';",
                )
                .map_err(|error| format!("A lokális SQLite v19 migráció sikertelen: {error}"))?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 19;")
            .map_err(|error| {
                format!("A lokális SQLite v19 schema-verziója nem menthető: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("A lokális SQLite v19 migráció commitja sikertelen: {error}")
        })?;
    }
    Ok(())
}

pub fn open_local_store() -> Result<LocalStore, String> {
    let path = local_store_path()?;
    verify_existing_database(&path).map_err(|error| {
        format!("A lokális adatbázis karanténban van; automatikus írás nincs engedélyezve. {error}")
    })?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("A lokális min-adattár nem hozható létre: {error}"))?;
    }
    let connection = Connection::open(&path)
        .map_err(|error| format!("A lokális SQLite-adatbázis nem nyitható meg: {error}"))?;
    configure_connection(&connection)?;
    let mut store = LocalStore { path, connection };
    initialize_connection(&mut store.connection)?;
    check_integrity(&store.connection)?;
    Ok(store)
}

pub fn initialize_local_store() -> Result<StoreHealth, String> {
    let store = open_local_store()?;
    health_for_connection(&store.path, &store.connection)
}

fn health_for_connection(path: &Path, connection: &Connection) -> Result<StoreHealth, String> {
    let schema_version = read_schema_version(connection)?;
    let integrity = check_integrity(connection)?;
    let status = if schema_version == STORE_SCHEMA_VERSION {
        "ready"
    } else {
        "needs_migration"
    };
    Ok(StoreHealth {
        path: path.to_string_lossy().to_string(),
        status: status.to_string(),
        schema_version: Some(schema_version),
        integrity,
        recovery_required: false,
        message: None,
    })
}

pub fn local_store_health() -> Result<StoreHealth, String> {
    let path = local_store_path()?;
    if !path.exists() {
        return Ok(StoreHealth {
            path: path.to_string_lossy().to_string(),
            status: "not_initialized".to_string(),
            schema_version: None,
            integrity: "not_checked".to_string(),
            recovery_required: false,
            message: None,
        });
    }

    let connection = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => connection,
        Err(error) => {
            return Ok(StoreHealth {
                path: path.to_string_lossy().to_string(),
                status: "recovery_required".to_string(),
                schema_version: None,
                integrity: "unavailable".to_string(),
                recovery_required: true,
                message: Some(error.to_string()),
            });
        }
    };
    match health_for_connection(&path, &connection) {
        Ok(mut health) => {
            if health.schema_version.unwrap_or_default() > STORE_SCHEMA_VERSION {
                health.status = "recovery_required".to_string();
                health.recovery_required = true;
                health.message = Some("Az adatbázis újabb schema-verziót használ.".to_string());
            }
            Ok(health)
        }
        Err(error) => Ok(StoreHealth {
            path: path.to_string_lossy().to_string(),
            status: "recovery_required".to_string(),
            schema_version: None,
            integrity: "failed".to_string(),
            recovery_required: true,
            message: Some(error),
        }),
    }
}

fn now_millis() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn stable_id(kind: &str, key: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("min:local:{kind}:{key}").as_bytes(),
    )
    .to_string()
}

fn message_identity_keys(message: &LocalMessage) -> Vec<String> {
    let mut keys = Vec::new();
    let turn_id = message
        .turn_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let item_id = message
        .item_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let id = message
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(turn_id) = turn_id {
        keys.push(format!("turn:{turn_id}:{}", message.role));
    }
    if let Some(item_id) = item_id {
        keys.push(format!("item:{item_id}:{}", message.role));
    }
    if let Some(id) = id {
        keys.push(format!("id:{id}"));
    }
    if message.role == "assistant" && turn_id.is_none() && item_id.is_none() {
        if let Some(sequence) = message.sequence {
            keys.push(stable_id(
                "legacy-assistant-alias",
                &format!("{sequence}:{}", message.text),
            ));
        }
    }
    if turn_id.is_none() && item_id.is_none() && id.is_none() {
        if let Some(sequence) = message.sequence {
            keys.push(stable_id(
                "legacy-message-alias",
                &format!("{}:{sequence}:{}", message.role, message.text),
            ));
        }
    }
    keys
}

fn exact_repeated_unit(text: &str) -> Option<String> {
    let characters = text.chars().collect::<Vec<_>>();
    if characters.len() < 6 {
        return None;
    }

    // KMP prefix table finds the smallest exact period in linear time and has
    // no repetition cap. A real legacy row had already grown to 166 copies.
    let mut prefix = vec![0usize; characters.len()];
    let mut matched = 0usize;
    for index in 1..characters.len() {
        while matched > 0 && characters[index] != characters[matched] {
            matched = prefix[matched - 1];
        }
        if characters[index] == characters[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }

    let period_length = characters.len() - prefix[characters.len() - 1];
    if period_length < 3
        || period_length >= characters.len()
        || characters.len() % period_length != 0
        || characters.len() / period_length < 2
    {
        return None;
    }
    Some(characters[..period_length].iter().collect())
}

/// Repairs the historical stream-listener corruption where one completed
/// assistant answer was appended once per duplicate listener. User text is
/// intentionally left untouched because repeating a prompt is valid history.
pub(crate) fn collapse_repeated_assistant_text(role: &str, text: &str) -> String {
    if role != "assistant" || text.chars().count() < 6 {
        return text.to_string();
    }
    if let Some(unit) = exact_repeated_unit(text) {
        return unit;
    }

    // Interrupted legacy streams inserted this marker into only some copies.
    // Strip it only for period detection and preserve one terminal marker.
    let without_markers = text
        .replace("\r\n\r\nA válasz megszakítva.", "")
        .replace("\r\n\r\nA válasz megszakítva", "")
        .replace("\n\nA válasz megszakítva.", "")
        .replace("\n\nA válasz megszakítva", "");
    if without_markers != text {
        if let Some(unit) = exact_repeated_unit(&without_markers) {
            return format!("{}\n\nA válasz megszakítva.", unit.trim_end());
        }
    }
    text.to_string()
}

fn unavailable_assistant_message(message: &LocalMessage) -> bool {
    if message.role != "assistant" {
        return false;
    }
    let text = message.text.trim().to_lowercase();
    text.is_empty()
        || text.starts_with("a v\u{00e1}lasz megszak\u{00ed}tva")
        || text.starts_with("nem siker\u{00fc}lt a codex-k\u{00e9}r\u{00e9}s:")
}

fn merge_snapshot_message_versions(
    existing: &LocalMessage,
    mut incoming: LocalMessage,
) -> LocalMessage {
    if existing.role != incoming.role {
        return existing.clone();
    }
    if existing.role == "user" {
        // Submitted user content and its position are write-once. Only enrich
        // identity/provenance fields from later cache or sync copies.
        incoming.id = existing.id.clone().or(incoming.id);
        incoming.role = existing.role.clone();
        incoming.text = existing.text.clone();
        incoming.time = existing.time.clone();
        incoming.code = existing.code.or(incoming.code);
        incoming.live = Some(false);
        incoming.final_message = existing.final_message.or(incoming.final_message);
        incoming.sequence = existing.sequence.or(incoming.sequence);
        incoming.images = existing.images.clone();
        incoming.quote_refs = existing.quote_refs.clone();
        incoming.item_id = existing.item_id.clone().or(incoming.item_id);
        incoming.turn_id = existing.turn_id.clone().or(incoming.turn_id);
        incoming.hlc = existing.hlc.clone().or(incoming.hlc);
        incoming.origin_device_id = existing
            .origin_device_id
            .clone()
            .or(incoming.origin_device_id);
        return incoming;
    }
    incoming.id = existing.id.clone().or(incoming.id);
    let existing_unavailable = unavailable_assistant_message(existing);
    let incoming_unavailable = unavailable_assistant_message(&incoming);
    if (incoming_unavailable && !existing_unavailable)
        || (incoming_unavailable == existing_unavailable
            && existing.text.trim().len() > incoming.text.trim().len())
    {
        incoming.text = existing.text.clone();
    }
    let final_message =
        existing.final_message.unwrap_or(false) || incoming.final_message.unwrap_or(false);
    incoming.final_message = Some(final_message);
    incoming.live = Some(if final_message {
        false
    } else {
        existing.live.unwrap_or(false) || incoming.live.unwrap_or(false)
    });
    incoming.code = Some(existing.code.unwrap_or(false) || incoming.code.unwrap_or(false));
    if incoming.id.is_none() {
        incoming.id = existing.id.clone();
    }
    if incoming.item_id.is_none() {
        incoming.item_id = existing.item_id.clone();
    }
    if incoming.turn_id.is_none() {
        incoming.turn_id = existing.turn_id.clone();
    }
    if incoming.sequence.is_none() {
        incoming.sequence = existing.sequence;
    }
    if incoming.time.trim().is_empty()
        || (incoming.time == "most" && !existing.time.trim().is_empty() && existing.time != "most")
    {
        incoming.time = existing.time.clone();
    }
    if incoming.images.is_empty() {
        incoming.images = existing.images.clone();
    }
    if incoming.quote_refs.is_empty() {
        incoming.quote_refs = existing.quote_refs.clone();
    }
    if incoming.hlc.is_none() {
        incoming.hlc = existing.hlc.clone();
    }
    if incoming.origin_device_id.is_none() {
        incoming.origin_device_id = existing.origin_device_id.clone();
    }
    incoming
}

fn coalesce_snapshot_messages(messages: &[LocalMessage]) -> Vec<LocalMessage> {
    let mut merged = Vec::<LocalMessage>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for original in messages {
        let mut message = original.clone();
        message.text = collapse_repeated_assistant_text(&message.role, &message.text);
        let keys = message_identity_keys(&message);
        let existing_index = keys.iter().find_map(|key| indexes.get(key).copied());
        if let Some(existing_index) = existing_index {
            merged[existing_index] =
                merge_snapshot_message_versions(&merged[existing_index], message.clone());
            for key in message_identity_keys(&merged[existing_index])
                .into_iter()
                .chain(keys)
            {
                indexes.insert(key, existing_index);
            }
        } else {
            let index = merged.len();
            merged.push(message.clone());
            for key in keys {
                indexes.insert(key, index);
            }
        }
    }
    merged
}

fn normalized_project_id(project: &LocalProject) -> String {
    let identity = project
        .relative_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if project.path_hint.trim().is_empty() {
                &project.id
            } else {
                &project.path_hint
            }
        });
    let local_id = stable_id("project", identity);
    let sync_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("min:v2:project:{}", identity.to_lowercase()).as_bytes(),
    )
    .to_string();
    if project.id == sync_id {
        return local_id;
    }
    if Uuid::parse_str(&project.id).is_ok() {
        return project.id.clone();
    }
    local_id
}

fn canonical_sync_project_id(project: &LocalProject) -> String {
    let identity = project
        .relative_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if project.path_hint.trim().is_empty() {
                &project.id
            } else {
                &project.path_hint
            }
        });
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("min:v2:project:{}", identity.to_lowercase()).as_bytes(),
    )
    .to_string()
}

fn project_path_key(value: &str) -> String {
    value
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn project_matches_tombstone(project: &LocalProject, tombstone: &LocalTombstone) -> bool {
    if tombstone.entity_type != "project" {
        return false;
    }
    if tombstone.entity_id == project.id
        || tombstone.entity_id == normalized_project_id(project)
        || tombstone.entity_id == canonical_sync_project_id(project)
    {
        return true;
    }
    if let (Some(left), Some(right)) = (
        tombstone.relative_path.as_deref(),
        project.relative_path.as_deref(),
    ) {
        if project_path_key(left) == project_path_key(right) {
            return true;
        }
    }
    tombstone
        .path_hint
        .as_deref()
        .map(project_path_key)
        .map(|path| path == project_path_key(&project.path_hint))
        .unwrap_or(false)
}

fn conversation_matches_tombstone(
    conversation: &LocalConversation,
    tombstone: &LocalTombstone,
) -> bool {
    if tombstone.entity_type != "conversation" {
        return false;
    }

    // GENERAL conversations have an explicit, title-independent identity. A
    // later General chat may legitimately reuse the same title, so title-only
    // matching must never hide it.
    let conversation_id = conversation
        .id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            stable_id(
                "conversation",
                &format!("{}:{}", conversation.project_id, conversation.title),
            )
        });
    if tombstone.entity_id == conversation_id {
        return true;
    }
    if conversation.scope == GENERAL_SCOPE {
        return false;
    }

    // Coding keeps the legacy title/project fallback for rows whose local
    // UUID was canonicalized between two snapshots.
    tombstone.title.as_deref() == Some(conversation.title.as_str())
        && tombstone.project_id.as_deref() == Some(conversation.project_id.as_str())
}

fn unique_sequence(candidate: i64, index: usize, used: &mut HashSet<i64>) -> i64 {
    if used.insert(candidate) {
        return candidate;
    }
    let mut fallback = index as i64;
    while !used.insert(fallback) {
        fallback += 1;
    }
    fallback
}

pub(crate) fn load_snapshot_from_connection(
    connection: &Connection,
) -> Result<LocalStoreSnapshot, String> {
    let project_rows = {
        let mut statement = connection
            .prepare(
                "SELECT id, name, relative_path, canonical_path
                 FROM projects
                 WHERE archived_at IS NULL AND local_available = 1 AND id <> ?1
                 ORDER BY created_at, id",
            )
            .map_err(|error| format!("A lokális projektek lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map(params![GENERAL_PROJECT_ID], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("A lokális projektlista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A lokális projektadat hibás: {error}"))?;
        rows
    };

    let mut projects = project_rows
        .into_iter()
        .map(|(id, name, relative_path, path_hint)| LocalProject {
            id,
            name,
            relative_path,
            path_hint,
            threads: Vec::new(),
        })
        .collect::<Vec<_>>();
    let project_indexes = projects
        .iter()
        .enumerate()
        .map(|(index, project)| (project.id.clone(), index))
        .collect::<HashMap<_, _>>();

    let conversation_rows = {
        let mut statement = connection
            .prepare(
                "SELECT id, project_id, scope, title, codex_thread_id, updated_at,
                        plan_history_json, commentary_json
                 FROM conversations
                 WHERE archived_at IS NULL
                   AND (scope = 'general' OR project_id IN (
                       SELECT id FROM projects
                       WHERE archived_at IS NULL AND local_available = 1
                   ))
                 ORDER BY created_at, id",
            )
            .map_err(|error| format!("A lokális beszélgetések lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|error| format!("A lokális beszélgetéslista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A lokális beszélgetésadat hibás: {error}"))?;
        rows
    };

    let mut conversations = BTreeMap::new();
    for (
        conversation_id,
        project_id,
        row_scope,
        title,
        thread_id,
        updated_at,
        plan_history_json,
        commentary_json,
    ) in conversation_rows
    {
        let plan_history: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(&plan_history_json).unwrap_or_default();
        let commentary: Vec<serde_json::Value> =
            serde_json::from_str(&commentary_json).unwrap_or_default();
        let messages = {
            let mut statement = connection
                .prepare(
                    "SELECT id, role, body, created_at, code, live, \"final\", item_id, turn_id,
                            sequence, hlc, origin_device_id, attachments_json, quote_refs_json
                     FROM messages
                     WHERE conversation_id = ?1
                     ORDER BY sequence, COALESCE(origin_device_id, ''), id",
                )
                .map_err(|error| format!("A lokális üzenetek lekérdezése sikertelen: {error}"))?;
            let rows = statement
                .query_map(params![conversation_id], |row| {
                    let mut message = LocalMessage {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        text: row.get(2)?,
                        time: row.get(3)?,
                        code: Some(row.get::<_, i64>(4)? != 0),
                        live: Some(row.get::<_, i64>(5)? != 0),
                        final_message: Some(row.get::<_, i64>(6)? != 0),
                        item_id: row.get(7)?,
                        turn_id: row.get(8)?,
                        sequence: Some(row.get(9)?),
                        hlc: row.get(10)?,
                        origin_device_id: row.get(11)?,
                        images: serde_json::from_str(&row.get::<_, String>(12)?)
                            .unwrap_or_default(),
                        quote_refs: serde_json::from_str(&row.get::<_, String>(13)?)
                            .unwrap_or_default(),
                    };
                    message.text = collapse_repeated_assistant_text(&message.role, &message.text);
                    Ok(message)
                })
                .map_err(|error| format!("A lokális üzenetlista bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A lokális üzenetadat hibás: {error}"))?;
            rows
        };

        let work_items = {
            let mut statement = connection
                .prepare(
                    "SELECT w.sequence, w.item_id, t.codex_turn_id, w.plan_step_id, w.kind, w.status,
                            w.label, w.detail, w.event_type, w.created_at, w.body,
                            w.code, w.before_code, w.after_code, w.language, w.hlc, w.origin_device_id
                     FROM work_items w
                     LEFT JOIN turns t ON t.id = w.turn_id
                     WHERE w.conversation_id = ?1
                     ORDER BY COALESCE(w.hlc, printf('%020d', w.sequence)),
                              COALESCE(w.origin_device_id, ''), w.sequence, w.id",
                )
                .map_err(|error| {
                    format!("A lokális work itemek lekérdezése sikertelen: {error}")
                })?;
            let rows = statement
                .query_map(params![conversation_id], |row| {
                    Ok(LocalWorkItem {
                        id: row.get(0)?,
                        item_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        plan_step_id: row.get(3)?,
                        kind: row.get(4)?,
                        status: row.get(5)?,
                        label: row.get(6)?,
                        detail: row.get(7)?,
                        event_type: row.get(8)?,
                        time: row.get(9)?,
                        body: row.get(10)?,
                        code: row.get(11)?,
                        before_code: row.get(12)?,
                        after_code: row.get(13)?,
                        language: row.get(14)?,
                        hlc: row.get(15)?,
                        origin_device_id: row.get(16)?,
                    })
                })
                .map_err(|error| format!("A lokális work item lista bejárása sikertelen: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("A lokális work item adat hibás: {error}"))?;
            rows
        };

        let row_scope = if row_scope == GENERAL_SCOPE {
            GENERAL_SCOPE.to_string()
        } else {
            CODING_SCOPE.to_string()
        };
        let key = if row_scope == GENERAL_SCOPE {
            format!("general::{conversation_id}")
        } else {
            format!("{project_id}::{title}")
        };
        conversations.insert(
            key,
            LocalConversation {
                id: Some(conversation_id),
                scope: row_scope.clone(),
                project_id: project_id.clone(),
                title: title.clone(),
                messages,
                work_items,
                thread_id,
                updated_at,
                plan_history,
                commentary,
            },
        );
        if row_scope == CODING_SCOPE {
            if let Some(project_index) = project_indexes.get(&project_id) {
                if !projects[*project_index]
                    .threads
                    .iter()
                    .any(|item| item == &title)
                {
                    projects[*project_index].threads.push(title);
                }
            }
        }
    }

    let tombstones = {
        let mut statement = connection
            .prepare(
                "SELECT entity_type, entity_id, archived_at, project_id, title,
                        relative_path, path_hint, reason
                 FROM sync_tombstones
                 ORDER BY archived_at, entity_type, entity_id",
            )
            .map_err(|error| format!("A lokális tombstone-ok lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(LocalTombstone {
                    entity_type: row.get(0)?,
                    entity_id: row.get(1)?,
                    archived_at: row.get(2)?,
                    project_id: row.get(3)?,
                    title: row.get(4)?,
                    relative_path: row.get(5)?,
                    path_hint: row.get(6)?,
                    reason: row.get(7)?,
                })
            })
            .map_err(|error| format!("A lokális tombstone-lista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A lokális tombstone-adat hibás: {error}"))?;
        rows
    };

    // A journal tombstone is authoritative even if an older local project row
    // was not archived yet (for example after the project ID was canonicalized
    // by v2 sync). Do not hydrate such rows back into the UI.
    projects.retain(|project| {
        !tombstones
            .iter()
            .any(|tombstone| project_matches_tombstone(project, tombstone))
    });
    let active_project_ids = projects
        .iter()
        .map(|project| project.id.clone())
        .collect::<HashSet<_>>();
    conversations.retain(|_, conversation| {
        !tombstones
            .iter()
            .any(|tombstone| conversation_matches_tombstone(conversation, tombstone))
            && (conversation.scope == GENERAL_SCOPE
                || active_project_ids.contains(&conversation.project_id))
    });
    for project in &mut projects {
        project.threads.clear();
    }
    let project_indexes = projects
        .iter()
        .enumerate()
        .map(|(index, project)| (project.id.clone(), index))
        .collect::<HashMap<_, _>>();
    for conversation in conversations.values() {
        if conversation.scope == GENERAL_SCOPE {
            continue;
        }
        if let Some(project_index) = project_indexes.get(&conversation.project_id) {
            if !projects[*project_index]
                .threads
                .iter()
                .any(|item| item == &conversation.title)
            {
                projects[*project_index]
                    .threads
                    .push(conversation.title.clone());
            }
        }
    }

    Ok(LocalStoreSnapshot {
        schema_version: STORE_SCHEMA_VERSION,
        projects,
        conversations,
        tombstones,
    })
}

pub fn load_snapshot() -> Result<LocalStoreSnapshot, String> {
    let store = open_local_store()?;
    load_snapshot_from_connection(&store.connection)
}

pub(crate) fn save_snapshot_in_connection(
    connection: &mut Connection,
    snapshot: LocalStoreSnapshot,
) -> Result<(), String> {
    if snapshot.schema_version > STORE_SCHEMA_VERSION {
        return Err(format!(
            "A lokális snapshot újabb schema-verziót használ ({} > {}).",
            snapshot.schema_version, STORE_SCHEMA_VERSION
        ));
    }

    let LocalStoreSnapshot {
        schema_version,
        projects,
        conversations,
        tombstones,
    } = snapshot;
    let projects = projects
        .into_iter()
        .filter(|project| {
            !tombstones
                .iter()
                .any(|tombstone| project_matches_tombstone(project, tombstone))
        })
        .collect::<Vec<_>>();
    let project_ids = projects
        .iter()
        .map(|project| project.id.clone())
        .collect::<HashSet<_>>();
    let conversations = conversations
        .into_iter()
        .filter(|(_, conversation)| {
            !tombstones
                .iter()
                .any(|tombstone| conversation_matches_tombstone(conversation, tombstone))
                && (conversation.scope == GENERAL_SCOPE
                    || project_ids.contains(&conversation.project_id))
        })
        .collect::<BTreeMap<_, _>>();
    let snapshot = LocalStoreSnapshot {
        schema_version,
        projects,
        conversations,
        tombstones,
    };
    let has_general_conversations = snapshot
        .conversations
        .values()
        .any(|conversation| conversation.scope == GENERAL_SCOPE);
    let now = now_millis();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("A lokális snapshot tranzakciója nem indítható: {error}"))?;
    if has_general_conversations {
        transaction
            .execute(
                "INSERT OR IGNORE INTO projects
                    (id, name, canonical_path, relative_path, local_available, archived_at, created_at, updated_at)
                 VALUES (?1, 'GENERAL', '', NULL, 1, NULL, ?2, ?2)",
                params![GENERAL_PROJECT_ID, now],
            )
            .map_err(|error| format!("A GENERAL storage scope nem hozható létre: {error}"))?;
    }
    for tombstone in &snapshot.tombstones {
        transaction
            .execute(
                "INSERT INTO sync_tombstones (entity_type, entity_id, archived_at, project_id, title, relative_path, path_hint, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                   archived_at = excluded.archived_at,
                   project_id = excluded.project_id,
                   title = excluded.title,
                   relative_path = excluded.relative_path,
                   path_hint = excluded.path_hint,
                   reason = excluded.reason",
                params![
                    tombstone.entity_type,
                    tombstone.entity_id,
                    tombstone.archived_at,
                    tombstone.project_id,
                    tombstone.title,
                    tombstone.relative_path,
                    tombstone.path_hint,
                    tombstone.reason,
                ],
            )
            .map_err(|error| format!("A lokális tombstone mentése sikertelen: {error}"))?;
    }
    for tombstone in &snapshot.tombstones {
        if tombstone.entity_type != "conversation" {
            continue;
        }
        transaction
            .execute(
                "UPDATE conversations SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, tombstone.entity_id],
            )
            .map_err(|error| format!("A tombstoned conversation archive failed: {error}"))?;
    }
    let incoming_tombstones = snapshot
        .tombstones
        .iter()
        .map(|tombstone| (tombstone.entity_type.clone(), tombstone.entity_id.clone()))
        .collect::<HashSet<_>>();
    let stale_tombstones = {
        let mut statement = transaction
            .prepare("SELECT entity_type, entity_id FROM sync_tombstones")
            .map_err(|error| format!("A régi tombstone-ok lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("A régi tombstone-lista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A régi tombstone-azonosító hibás: {error}"))?;
        rows.into_iter()
            .filter(|key| !incoming_tombstones.contains(key))
            .collect::<Vec<_>>()
    };
    for (entity_type, entity_id) in stale_tombstones {
        transaction
            .execute(
                "DELETE FROM sync_tombstones WHERE entity_type = ?1 AND entity_id = ?2",
                params![entity_type, entity_id],
            )
            .map_err(|error| format!("A feloldott tombstone törlése sikertelen: {error}"))?;
    }
    let active_projects = snapshot
        .projects
        .iter()
        .filter(|project| {
            !snapshot
                .tombstones
                .iter()
                .any(|tombstone| project_matches_tombstone(project, tombstone))
        })
        .collect::<Vec<_>>();
    let mut project_ids = HashMap::new();
    let mut seen_project_ids = HashSet::new();

    for project in &active_projects {
        let local_project_id = normalized_project_id(project);
        let canonical_path = if project.path_hint.trim().is_empty() {
            project.relative_path.clone().unwrap_or_default()
        } else {
            project.path_hint.clone()
        };
        transaction
            .execute(
                "INSERT INTO projects (id, name, canonical_path, relative_path, local_available, archived_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, NULL, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     canonical_path = excluded.canonical_path,
                     relative_path = excluded.relative_path,
                     local_available = 1,
                     archived_at = NULL,
                     updated_at = excluded.updated_at",
                params![
                    local_project_id,
                    project.name,
                    canonical_path,
                    project.relative_path,
                    now,
                ],
            )
            .map_err(|error| format!("A lokális projekt mentése sikertelen: {error}"))?;
        project_ids.insert(project.id.clone(), local_project_id.clone());
        project_ids.insert(local_project_id.clone(), local_project_id.clone());
        seen_project_ids.insert(local_project_id);
    }
    // GENERAL is a database-only storage scope, never a visible project.
    seen_project_ids.insert(GENERAL_PROJECT_ID.to_string());

    let mut conversation_by_slot = HashMap::<(String, String), LocalConversation>::new();
    for conversation in snapshot.conversations.values() {
        if conversation.scope == GENERAL_SCOPE {
            continue;
        }
        conversation_by_slot.insert(
            (conversation.project_id.clone(), conversation.title.clone()),
            conversation.clone(),
        );
    }

    let mut conversation_inputs = Vec::<(String, LocalConversation)>::new();
    let mut seen_slots = HashSet::new();
    for project in &active_projects {
        let local_project_id = project_ids
            .get(&project.id)
            .cloned()
            .ok_or_else(|| "A lokális projektazonosító nem képezhető le.".to_string())?;
        for title in &project.threads {
            let conversation = conversation_by_slot
                .get(&(project.id.clone(), title.clone()))
                .or_else(|| conversation_by_slot.get(&(local_project_id.clone(), title.clone())))
                .cloned()
                .unwrap_or_else(|| LocalConversation {
                    id: None,
                    scope: CODING_SCOPE.to_string(),
                    project_id: project.id.clone(),
                    title: title.clone(),
                    messages: Vec::new(),
                    work_items: Vec::new(),
                    thread_id: None,
                    updated_at: now.clone(),
                    plan_history: BTreeMap::new(),
                    commentary: Vec::new(),
                });
            let slot = (local_project_id.clone(), title.clone());
            if seen_slots.insert(slot) {
                conversation_inputs.push((local_project_id.clone(), conversation));
            }
        }
    }

    for conversation in snapshot.conversations.values() {
        let local_project_id = if conversation.scope == GENERAL_SCOPE {
            GENERAL_PROJECT_ID.to_string()
        } else {
            project_ids
                .get(&conversation.project_id)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "A lokális beszélgetés projektje nem található: {}",
                        conversation.project_id
                    )
                })?
        };
        let slot = (local_project_id.clone(), conversation.title.clone());
        if seen_slots.insert(slot) {
            conversation_inputs.push((local_project_id, conversation.clone()));
        }
    }

    let mut seen_conversation_ids = HashSet::new();
    for (local_project_id, conversation) in conversation_inputs {
        if conversation.title.trim().is_empty() {
            return Err("A lokális beszélgetés neve nem lehet üres.".to_string());
        }
        let requested_conversation_id = conversation
            .id
            .as_deref()
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string)
            .unwrap_or_else(|| {
                stable_id(
                    "conversation",
                    &format!("{local_project_id}:{}", conversation.title),
                )
            });
        // A stale frontend cache can accidentally carry one UUID for two
        // different title slots. Never let the second slot overwrite the
        // first SQLite row; use the deterministic slot identity instead.
        let conversation_id = if seen_conversation_ids.contains(&requested_conversation_id) {
            let base = stable_id(
                "conversation",
                &format!("{local_project_id}:{}", conversation.title),
            );
            let mut replacement = base.clone();
            let mut suffix = 2_usize;
            while seen_conversation_ids.contains(&replacement) {
                replacement = stable_id(
                    "conversation",
                    &format!("{local_project_id}:{}:{suffix}", conversation.title),
                );
                suffix += 1;
            }
            replacement
        } else {
            requested_conversation_id
        };
        let updated_at = if conversation.updated_at.trim().is_empty() {
            now.clone()
        } else {
            conversation.updated_at.clone()
        };
        let plan_history_json = serde_json::to_string(&conversation.plan_history)
            .map_err(|error| format!("A tervelőzmény nem szerializálható: {error}"))?;
        let commentary_json = serde_json::to_string(&conversation.commentary)
            .map_err(|error| format!("A commentary nem szerializálható: {error}"))?;
        transaction
            .execute(
                "INSERT INTO conversations (id, project_id, scope, title, codex_thread_id, archived_at, created_at, updated_at, plan_history_json, commentary_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                     project_id = excluded.project_id,
                     scope = excluded.scope,
                     title = excluded.title,
                     codex_thread_id = excluded.codex_thread_id,
                     archived_at = NULL,
                     updated_at = excluded.updated_at,
                     plan_history_json = CASE
                         WHEN excluded.plan_history_json <> '{}' THEN excluded.plan_history_json
                         ELSE conversations.plan_history_json
                     END,
                     commentary_json = CASE
                         WHEN excluded.commentary_json <> '[]' THEN excluded.commentary_json
                         ELSE conversations.commentary_json
                     END",
                params![
                    conversation_id,
                    local_project_id,
                    if conversation.scope == GENERAL_SCOPE {
                        GENERAL_SCOPE
                    } else {
                        CODING_SCOPE
                    },
                    conversation.title,
                    conversation.thread_id,
                    updated_at,
                    plan_history_json,
                    commentary_json,
                ],
            )
            .map_err(|error| format!("A lokális beszélgetés mentése sikertelen: {error}"))?;
        seen_conversation_ids.insert(conversation_id.clone());

        // Conversation content is append-only at this layer. A frontend
        // snapshot may be temporarily incomplete while hydration or a sync
        // pull races a new request; absence must never mean deletion.
        // Restart recovery rows therefore survive the next partial save too.
        // Conversation/project tombstones remain the explicit removal path.

        let conversation_messages = coalesce_snapshot_messages(&conversation.messages);
        let mut message_ids = HashSet::new();
        for (index, raw_message) in conversation_messages.iter().enumerate() {
            let mut message = raw_message.clone();
            message.text = collapse_repeated_assistant_text(&message.role, &message.text);
            if message.role != "user" && message.role != "assistant" {
                return Err(format!("Ismeretlen lokális üzenetszerep: {}", message.role));
            }
            let sequence = message.sequence.unwrap_or(index as i64);
            let message_id = message
                .id
                .as_deref()
                .filter(|value| Uuid::parse_str(value).is_ok())
                .filter(|value| !message_ids.contains(*value))
                .map(str::to_string)
                .unwrap_or_else(|| {
                    stable_id(
                        "message",
                        &format!(
                            "{conversation_id}:{sequence}:{}:{}:{}:{index}",
                            message.role, message.time, message.text
                        ),
                    )
                });
            message_ids.insert(message_id.clone());
            let message_time = if message.time.trim().is_empty() {
                now.clone()
            } else {
                message.time.clone()
            };
            let attachments_json = serde_json::to_string(&message.images)
                .map_err(|error| format!("A képcsatolmányok nem szerializálhatók: {error}"))?;
            let quote_refs_json = serde_json::to_string(&message.quote_refs)
                .map_err(|error| format!("Az idézet-hivatkozások nem szerializálhatók: {error}"))?;
            let identity_role = message.role.clone();
            let identity_turn_id = message
                .turn_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let identity_item_id = message
                .item_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            transaction
                .execute(
                    "INSERT INTO messages (id, conversation_id, role, body, sequence, hlc, item_id, turn_id, code, live, \"final\", origin_device_id, attachments_json, quote_refs_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                     ON CONFLICT(id) DO UPDATE SET
                         body = CASE
                             WHEN messages.role = 'user' THEN messages.body
                             WHEN length(excluded.body) >= length(messages.body) THEN excluded.body
                             ELSE messages.body
                         END,
                         sequence = messages.sequence,
                         hlc = COALESCE(excluded.hlc, messages.hlc),
                         item_id = COALESCE(excluded.item_id, messages.item_id),
                         turn_id = COALESCE(excluded.turn_id, messages.turn_id),
                         code = MAX(messages.code, excluded.code),
                         live = CASE
                             WHEN messages.\"final\" = 1 OR excluded.\"final\" = 1 THEN 0
                             ELSE MAX(messages.live, excluded.live)
                         END,
                         \"final\" = MAX(messages.\"final\", excluded.\"final\"),
                         origin_device_id = COALESCE(excluded.origin_device_id, messages.origin_device_id),
                         attachments_json = CASE
                             WHEN messages.role = 'user' THEN messages.attachments_json
                             WHEN excluded.attachments_json <> '[]' THEN excluded.attachments_json
                             ELSE messages.attachments_json
                         END,
                         quote_refs_json = CASE
                             WHEN messages.role = 'user' THEN messages.quote_refs_json
                             WHEN excluded.quote_refs_json <> '[]' THEN excluded.quote_refs_json
                             ELSE messages.quote_refs_json
                         END",
                    params![
                        message_id,
                        conversation_id,
                        message.role,
                        message.text,
                        sequence,
                        message.hlc,
                        message.item_id,
                        message.turn_id,
                        if message.code.unwrap_or(false) { 1 } else { 0 },
                        if message.live.unwrap_or(false) { 1 } else { 0 },
                        if message.final_message.unwrap_or(false) { 1 } else { 0 },
                        message.origin_device_id,
                        attachments_json,
                        quote_refs_json,
                        message_time,
                    ],
                )
                .map_err(|error| format!("A lokális üzenet mentése sikertelen: {error}"))?;
            if let Some(turn_id) = identity_turn_id.as_deref() {
                transaction
                    .execute(
                        "DELETE FROM messages
                         WHERE conversation_id = ?1 AND role = ?2 AND turn_id = ?3 AND id <> ?4",
                        params![conversation_id, identity_role, turn_id, message_id],
                    )
                    .map_err(|error| format!("A turn message-alias törlése sikertelen: {error}"))?;
            }
            if let Some(item_id) = identity_item_id.as_deref() {
                transaction
                    .execute(
                        "DELETE FROM messages
                         WHERE conversation_id = ?1 AND role = ?2 AND item_id = ?3 AND id <> ?4",
                        params![conversation_id, identity_role, item_id, message_id],
                    )
                    .map_err(|error| {
                        format!("Az item message-alias törlése sikertelen: {error}")
                    })?;
            }
            if identity_role == "assistant"
                && identity_turn_id.is_none()
                && identity_item_id.is_none()
            {
                transaction
                    .execute(
                        "DELETE FROM messages
                         WHERE conversation_id = ?1 AND role = 'assistant'
                           AND sequence = ?2 AND body = ?3 AND id <> ?4
                           AND (turn_id IS NULL OR trim(turn_id) = '')
                           AND (item_id IS NULL OR trim(item_id) = '')",
                        params![conversation_id, sequence, message.text, message_id],
                    )
                    .map_err(|error| {
                        format!("A legacy assistant message-alias törlése sikertelen: {error}")
                    })?;
            }
        }

        let mut work_item_sequences = HashSet::new();
        for (index, work_item) in conversation.work_items.iter().enumerate() {
            let sequence = unique_sequence(work_item.id, index, &mut work_item_sequences);
            let local_turn_id = if let Some(turn_id) = work_item
                .turn_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let local_turn_id = stable_id("turn", &format!("{conversation_id}:{turn_id}"));
                transaction
                    .execute(
                        "INSERT INTO turns (id, conversation_id, codex_turn_id, status, created_at, updated_at)
                         VALUES (?1, ?2, ?3, 'local', ?4, ?4)
                         ON CONFLICT(id) DO UPDATE SET
                             conversation_id = excluded.conversation_id,
                             codex_turn_id = excluded.codex_turn_id,
                             updated_at = excluded.updated_at",
                        params![local_turn_id, conversation_id, turn_id, now],
                    )
                    .map_err(|error| format!("A lokális turn mentése sikertelen: {error}"))?;
                Some(local_turn_id)
            } else {
                None
            };
            let work_item_id = stable_id("work-item", &format!("{conversation_id}:{sequence}"));
            let work_item_time = if work_item.time.trim().is_empty() {
                now.clone()
            } else {
                work_item.time.clone()
            };
            transaction
                .execute(
                    "INSERT INTO work_items (id, conversation_id, turn_id, item_id, plan_step_id, kind, status, label, detail, event_type, body, code, before_code, after_code, language, sequence, hlc, origin_device_id, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                     ON CONFLICT DO UPDATE SET
                         conversation_id = excluded.conversation_id,
                         turn_id = COALESCE(excluded.turn_id, work_items.turn_id),
                         item_id = COALESCE(excluded.item_id, work_items.item_id),
                         plan_step_id = COALESCE(excluded.plan_step_id, work_items.plan_step_id),
                         kind = excluded.kind,
                         status = CASE
                             WHEN work_items.status IN ('done', 'error') AND excluded.status = 'running'
                                 THEN work_items.status
                             ELSE excluded.status
                         END,
                         label = excluded.label,
                         detail = excluded.detail,
                         event_type = excluded.event_type,
                         body = CASE
                             WHEN length(COALESCE(excluded.body, '')) >= length(COALESCE(work_items.body, ''))
                                 THEN COALESCE(excluded.body, work_items.body)
                             ELSE work_items.body
                         END,
                         code = COALESCE(excluded.code, work_items.code),
                         before_code = COALESCE(excluded.before_code, work_items.before_code),
                         after_code = COALESCE(excluded.after_code, work_items.after_code),
                         language = COALESCE(excluded.language, work_items.language),
                         sequence = excluded.sequence,
                         hlc = COALESCE(excluded.hlc, work_items.hlc),
                         origin_device_id = COALESCE(excluded.origin_device_id, work_items.origin_device_id)",
                    params![
                        work_item_id,
                        conversation_id,
                        local_turn_id,
                        work_item.item_id,
                        work_item.plan_step_id,
                        work_item.kind,
                        work_item.status,
                        work_item.label,
                        work_item.detail,
                        work_item.event_type,
                        work_item.body,
                        work_item.code,
                        work_item.before_code,
                        work_item.after_code,
                        work_item.language,
                        sequence,
                        work_item.hlc,
                        work_item.origin_device_id,
                        work_item_time,
                    ],
                )
                .map_err(|error| format!("A lokális work item mentése sikertelen: {error}"))?;
        }
    }

    let stale_conversations = {
        let mut statement = transaction
            .prepare(
                "SELECT id, scope FROM conversations
                 WHERE archived_at IS NULL AND scope <> 'general'",
            )
            .map_err(|error| format!("A régi beszélgetések lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("A régi beszélgetéslista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A régi beszélgetésazonosító hibás: {error}"))?;
        rows.into_iter()
            .filter(|id| !seen_conversation_ids.contains(id))
            .collect::<Vec<_>>()
    };
    for conversation_id in stale_conversations {
        transaction
            .execute(
                "UPDATE conversations SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, conversation_id],
            )
            .map_err(|error| format!("A régi beszélgetés archiválása sikertelen: {error}"))?;
    }

    let stale_projects = {
        let mut statement = transaction
            .prepare(
                "SELECT id FROM projects
                 WHERE archived_at IS NULL AND local_available = 1 AND id <> ?1",
            )
            .map_err(|error| format!("A régi projektek lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map(params![GENERAL_PROJECT_ID], |row| row.get::<_, String>(0))
            .map_err(|error| format!("A régi projektlista bejárása sikertelen: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("A régi projektazonosító hibás: {error}"))?;
        rows.into_iter()
            .filter(|id| !seen_project_ids.contains(id))
            .collect::<Vec<_>>()
    };
    for project_id in stale_projects {
        transaction
            .execute(
                "UPDATE projects SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, project_id],
            )
            .map_err(|error| format!("A régi projekt archiválása sikertelen: {error}"))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("A lokális snapshot commitja sikertelen: {error}"))?;
    Ok(())
}

pub fn save_snapshot(snapshot: LocalStoreSnapshot) -> Result<LocalStoreSnapshot, String> {
    let mut store = open_local_store()?;
    let tombstones = snapshot.tombstones.clone();
    save_snapshot_in_connection(&mut store.connection, snapshot)?;
    let mut loaded = load_snapshot_from_connection(&store.connection)?;
    loaded.tombstones = tombstones;
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_initializes_with_foreign_keys_and_wal() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        assert_eq!(
            read_schema_version(&connection).expect("schema version"),
            STORE_SCHEMA_VERSION
        );
        assert_eq!(check_integrity(&connection).expect("integrity"), "ok");
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn historical_repeated_assistant_stream_output_is_collapsed() {
        let answer = "Értettem:\n\nKonkrét végrehajtandó feladat nincs megadva.";
        assert_eq!(
            collapse_repeated_assistant_text("assistant", &answer.repeat(2)),
            answer
        );
        assert_eq!(
            collapse_repeated_assistant_text("assistant", &answer.repeat(17)),
            answer
        );
        assert_eq!(
            collapse_repeated_assistant_text("assistant", &answer.repeat(166)),
            answer
        );
        assert_eq!(
            collapse_repeated_assistant_text("user", &answer.repeat(17)),
            answer.repeat(17)
        );
        assert_eq!(
            collapse_repeated_assistant_text("assistant", "K-1K-1"),
            "K-1"
        );
        assert_eq!(
            collapse_repeated_assistant_text("assistant", "abcabcabc"),
            "abc"
        );
        assert_eq!(
            collapse_repeated_assistant_text("assistant", "abcabca"),
            "abcabca"
        );
    }

    #[test]
    fn historical_repeated_interruption_markers_collapse_to_one_marker() {
        let answer = "Igen, most mar futtathato.";
        let marker = "\n\nA válasz megszakítva.";
        let corrupted = format!("{answer}{marker}{}{answer}{marker}", answer.repeat(164));
        assert_eq!(
            collapse_repeated_assistant_text("assistant", &corrupted),
            format!("{answer}{marker}")
        );
    }

    #[test]
    fn schema_v12_migration_repairs_unbounded_repeated_answer() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize current schema");
        connection
            .execute(
                "INSERT INTO projects (id, name, canonical_path, created_at, updated_at)
                 VALUES ('project', 'Project', 'C:\\Project', 'now', 'now')",
                [],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO conversations (id, project_id, title, created_at, updated_at)
                 VALUES ('conversation', 'project', 'Work 2', 'now', 'now')",
                [],
            )
            .expect("insert conversation");
        let answer = "Igen, most mar futtathato.";
        let marker = "\n\nA válasz megszakítva.";
        let corrupted = format!("{answer}{marker}{}{answer}{marker}", answer.repeat(164));
        connection
            .execute(
                "INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES ('message', 'conversation', 'assistant', ?1, 1, 'now')",
                params![corrupted],
            )
            .expect("insert corrupted answer");
        connection
            .pragma_update(None, "user_version", 11)
            .expect("rewind schema version");

        initialize_connection(&mut connection).expect("run v12 migration");

        let repaired: String = connection
            .query_row(
                "SELECT body FROM messages WHERE id = 'message'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired answer");
        assert_eq!(repaired, format!("{answer}{marker}"));
        assert_eq!(
            read_schema_version(&connection).expect("schema version"),
            STORE_SCHEMA_VERSION
        );
    }

    #[test]
    fn schema_v13_migration_repairs_exact_two_copy_answer() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize current schema");
        connection
            .execute(
                "INSERT INTO projects (id, name, canonical_path, created_at, updated_at)
                 VALUES ('project', 'Project', 'C:\\Project', 'now', 'now')",
                [],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO conversations (id, project_id, title, created_at, updated_at)
                 VALUES ('conversation', 'project', 'Work', 'now', 'now')",
                [],
            )
            .expect("insert conversation");
        let answer = "K-1";
        connection
            .execute(
                "INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES ('message', 'conversation', 'assistant', ?1, 1, 'now')",
                params![answer.repeat(2)],
            )
            .expect("insert two-copy answer");
        connection
            .pragma_update(None, "user_version", 12)
            .expect("rewind schema version");

        initialize_connection(&mut connection).expect("run v13 migration");

        let repaired: String = connection
            .query_row(
                "SELECT body FROM messages WHERE id = 'message'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired answer");
        assert_eq!(repaired, answer);
        assert_eq!(
            read_schema_version(&connection).expect("schema version"),
            STORE_SCHEMA_VERSION
        );
    }

    #[test]
    fn schema_v14_restores_first_user_event_and_allows_sequence_collisions() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize current schema");
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, canonical_path, created_at, updated_at)
                 VALUES ('project', 'Project', 'C:\\Project', 'now', 'now');
                 INSERT INTO conversations (id, project_id, title, created_at, updated_at)
                 VALUES ('conversation', 'project', 'Work', 'now', 'now');
                 INSERT INTO devices (id, name, created_at, updated_at)
                 VALUES ('device', 'Device', 'now', 'now');
                 INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES ('message', 'conversation', 'user', 'HOSSZABB IDEGEN KERDES', 7, 'later');
                 CREATE UNIQUE INDEX uq_messages_conversation_sequence
                     ON messages(conversation_id, sequence);",
            )
            .expect("insert v13 fixture");
        let original = serde_json::json!({
            "projectId": "project",
            "conversationId": "conversation",
            "message": {
                "id": "message",
                "role": "user",
                "text": "Eredeti kérdés",
                "time": "first",
                "sequence": 7
            }
        });
        let corrupted = serde_json::json!({
            "projectId": "project",
            "conversationId": "conversation",
            "message": {
                "id": "message",
                "role": "user",
                "text": "HOSSZABB IDEGEN KERDES",
                "time": "later",
                "sequence": 7
            }
        });
        for (sequence, hlc, payload) in [(1, "0001", original), (2, "0002", corrupted)] {
            connection
                .execute(
                    "INSERT INTO sync_events
                     (event_id, device_id, device_sequence, hlc, entity_id, event_type,
                      payload_json, payload_hash, event_hash, imported_at)
                     VALUES (?1, 'device', ?2, ?3, 'message', 'message.upsert', ?4, 'payload', ?1, 'now')",
                    params![format!("event-{sequence}"), sequence, hlc, payload.to_string()],
                )
                .expect("insert message event");
        }
        connection
            .pragma_update(None, "user_version", 13)
            .expect("rewind schema version");

        initialize_connection(&mut connection).expect("run v14 migration");

        let repaired: (String, String) = connection
            .query_row(
                "SELECT body, created_at FROM messages WHERE id = 'message'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read repaired user");
        assert_eq!(
            repaired,
            ("Eredeti kérdés".to_string(), "first".to_string())
        );
        connection
            .execute(
                "INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES ('message-2', 'conversation', 'user', 'Másik gép', 7, 'now')",
                [],
            )
            .expect("same sequence is not a row identity");
    }

    #[test]
    fn schema_v15_removes_only_provable_message_aliases() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize current schema");
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, canonical_path, created_at, updated_at)
                 VALUES ('project', 'Project', 'C:\\Project', 'now', 'now');
                 INSERT INTO conversations (id, project_id, title, created_at, updated_at)
                 VALUES ('conversation', 'project', 'Work', 'now', 'now');
                 INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES
                   ('user-a', 'conversation', 'user', 'Első', 7, 'now'),
                   ('user-b', 'conversation', 'user', 'Második', 7, 'now'),
                   ('answer-a', 'conversation', 'assistant', 'Kész', 8, 'now'),
                   ('answer-b', 'conversation', 'assistant', 'Kész', 8, 'now');
                 INSERT INTO messages
                   (id, conversation_id, role, body, sequence, turn_id, created_at)
                 VALUES
                   ('turn-answer-a', 'conversation', 'assistant', 'Kész', 9, 'turn-1', 'now'),
                   ('turn-answer-b', 'conversation', 'assistant', 'Kész', 9, 'turn-1', 'now');
                 PRAGMA user_version = 14;",
            )
            .expect("insert v14 aliases");

        initialize_connection(&mut connection).expect("run v15 migration");

        let users: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE role = 'user'",
                [],
                |row| row.get(0),
            )
            .expect("user count");
        let assistants: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE role = 'assistant'",
                [],
                |row| row.get(0),
            )
            .expect("assistant count");
        assert_eq!(users, 2);
        assert_eq!(assistants, 2);
    }

    #[test]
    fn schema_v16_removes_an_abandoned_non_adjacent_regeneration_pair() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize current schema");
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, canonical_path, created_at, updated_at)
                 VALUES ('project', 'Project', 'C:\\Project', 'now', 'now');
                 INSERT INTO conversations (id, project_id, title, created_at, updated_at)
                 VALUES ('conversation', 'project', 'Work', 'now', 'now');
                 INSERT INTO messages (id, conversation_id, role, body, sequence, created_at)
                 VALUES
                   ('source-user', 'conversation', 'user', 'Azonos kérdés', 1, 'now'),
                   ('source-answer', 'conversation', 'assistant', 'Meglévő válasz', 2, 'now'),
                   ('other-user', 'conversation', 'user', 'Másik kérdés', 3, 'now'),
                   ('other-answer', 'conversation', 'assistant', 'Másik válasz', 4, 'now');
                 INSERT INTO messages
                   (id, conversation_id, role, body, sequence, turn_id, live, [final], created_at)
                 VALUES
                   ('retry-user', 'conversation', 'user', 'Azonos kérdés', 5, 'retry-turn', 0, 0, 'now'),
                   ('retry-answer', 'conversation', 'assistant', '', 6, 'retry-turn', 0, 0, 'now');
                 UPDATE messages SET quote_refs_json = 'legacy-context'
                 WHERE id = 'retry-user';
                 PRAGMA user_version = 15;",
            )
            .expect("insert abandoned retry");

        initialize_connection(&mut connection).expect("run v16 migration");

        let ids = connection
            .prepare("SELECT id FROM messages ORDER BY sequence")
            .expect("prepare ids")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("read ids")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect ids");
        assert_eq!(
            ids,
            vec!["source-user", "source-answer", "other-user", "other-answer"]
        );
    }

    #[test]
    fn schema_v4_migration_adds_timeline_provenance() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        connection
            .execute_batch(
                "CREATE TABLE devices (
                     id TEXT PRIMARY KEY NOT NULL,
                     name TEXT NOT NULL,
                     last_hlc TEXT,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 CREATE TABLE work_items (
                     id TEXT PRIMARY KEY NOT NULL,
                     sequence INTEGER NOT NULL,
                     created_at TEXT NOT NULL
                 );
                 CREATE TABLE messages (
                     id TEXT PRIMARY KEY NOT NULL
                 );
                 CREATE TABLE conversations (
                     id TEXT PRIMARY KEY NOT NULL,
                     project_id TEXT NOT NULL,
                     title TEXT NOT NULL,
                     codex_thread_id TEXT,
                     archived_at TEXT,
                     created_at TEXT NOT NULL,
                     updated_at TEXT NOT NULL
                 );
                 PRAGMA user_version = 4;",
            )
            .expect("create v4 fixture");

        initialize_connection(&mut connection).expect("migrate v4 schema");
        assert_eq!(
            read_schema_version(&connection).expect("schema version"),
            STORE_SCHEMA_VERSION
        );
        let mut statement = connection
            .prepare("PRAGMA table_info(work_items)")
            .expect("work item columns");
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read work item columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect work item columns");
        assert!(columns.iter().any(|column| column == "hlc"));
        assert!(columns.iter().any(|column| column == "origin_device_id"));
        assert!(columns.iter().any(|column| column == "plan_step_id"));
        assert!(columns.iter().any(|column| column == "before_code"));
        assert!(columns.iter().any(|column| column == "after_code"));
        let mut statement = connection
            .prepare("PRAGMA table_info(messages)")
            .expect("message columns");
        let message_columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("read message columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect message columns");
        assert!(message_columns
            .iter()
            .any(|column| column == "attachments_json"));
        assert!(message_columns.iter().any(|column| column == "turn_id"));
        assert!(message_columns
            .iter()
            .any(|column| column == "quote_refs_json"));
    }

    fn test_snapshot() -> LocalStoreSnapshot {
        let project_id = "legacy-project".to_string();
        let title = "Thread".to_string();
        let conversation = LocalConversation {
            id: None,
            scope: CODING_SCOPE.to_string(),
            project_id: project_id.clone(),
            title: title.clone(),
            messages: vec![LocalMessage {
                id: None,
                role: "user".to_string(),
                text: "Hello".to_string(),
                time: "1".to_string(),
                code: Some(false),
                live: Some(false),
                final_message: Some(true),
                item_id: None,
                turn_id: Some("turn-1".to_string()),
                sequence: Some(10),
                hlc: Some("00000000000000000010-00000000".to_string()),
                origin_device_id: None,
                images: vec![LocalImageAttachment {
                    path: "Screenshots/8.png".to_string(),
                    name: "clipboard.png".to_string(),
                    mime_type: "image/png".to_string(),
                }],
                quote_refs: Vec::new(),
            }],
            work_items: vec![LocalWorkItem {
                id: 11,
                item_id: Some("item-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                plan_step_id: Some("step-1".to_string()),
                kind: "command".to_string(),
                status: "done".to_string(),
                label: "Command".to_string(),
                detail: "echo".to_string(),
                event_type: "command/completed".to_string(),
                time: "2".to_string(),
                body: Some("ok".to_string()),
                code: None,
                before_code: Some("before".to_string()),
                after_code: Some("after".to_string()),
                language: None,
                hlc: Some("00000000000000000011-00000000".to_string()),
                origin_device_id: None,
            }],
            thread_id: Some("thread-1".to_string()),
            updated_at: "3".to_string(),
            plan_history: BTreeMap::from([(
                "turn-1".to_string(),
                serde_json::json!({"steps": [{"id": "step-1", "step": "Step 1"}]}),
            )]),
            commentary: vec![serde_json::json!({
                "id": "commentary-1",
                "body": "Thinking",
                "status": "done"
            })],
        };
        LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: vec![LocalProject {
                id: project_id.clone(),
                name: "Project".to_string(),
                relative_path: Some("projects/project".to_string()),
                path_hint: "C:\\projects\\project".to_string(),
                threads: vec![title.clone()],
            }],
            conversations: BTreeMap::from([(format!("{project_id}::{title}"), conversation)]),
            tombstones: vec![LocalTombstone {
                entity_type: "conversation".to_string(),
                entity_id: "archived-conversation".to_string(),
                archived_at: "4".to_string(),
                project_id: Some(project_id.clone()),
                title: Some("Archived".to_string()),
                relative_path: Some("projects/project".to_string()),
                path_hint: Some("C:\\projects\\project".to_string()),
                reason: Some("test".to_string()),
            }],
        }
    }

    #[test]
    fn repeated_save_cannot_rewrite_an_existing_user_payload() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");
        let message_id = Uuid::new_v4().to_string();
        let mut original = test_snapshot();
        let original_message = &mut original
            .conversations
            .values_mut()
            .next()
            .expect("conversation")
            .messages[0];
        original_message.id = Some(message_id.clone());
        save_snapshot_in_connection(&mut connection, original.clone()).expect("save original");

        let changed_message = &mut original
            .conversations
            .values_mut()
            .next()
            .expect("conversation")
            .messages[0];
        changed_message.text = "Egy teljesen más, hosszabb user input".to_string();
        changed_message.time = "later".to_string();
        changed_message.images.clear();
        save_snapshot_in_connection(&mut connection, original).expect("save stale rewrite");

        let stored: (String, String, String) = connection
            .query_row(
                "SELECT body, created_at, attachments_json FROM messages WHERE id = ?1",
                params![message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("stored user");
        assert_eq!(stored.0, "Hello");
        assert_eq!(stored.1, "1");
        assert_ne!(stored.2, "[]");
    }

    #[test]
    fn snapshot_round_trip_is_idempotent_and_archives_missing_rows() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let snapshot = test_snapshot();
        save_snapshot_in_connection(&mut connection, snapshot.clone()).expect("save snapshot");
        let loaded = load_snapshot_from_connection(&connection).expect("load snapshot");
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].threads, vec!["Thread"]);
        let conversation = loaded.conversations.values().next().expect("conversation");
        assert_eq!(conversation.messages[0].text, "Hello");
        assert_eq!(conversation.messages[0].final_message, Some(true));
        assert_eq!(conversation.messages[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(conversation.messages[0].images[0].path, "Screenshots/8.png");
        assert_eq!(
            conversation.messages[0].hlc.as_deref(),
            Some("00000000000000000010-00000000")
        );
        assert_eq!(conversation.work_items[0].detail, "echo");
        assert_eq!(
            conversation.work_items[0].plan_step_id.as_deref(),
            Some("step-1")
        );
        assert_eq!(
            conversation.work_items[0].before_code.as_deref(),
            Some("before")
        );
        assert_eq!(
            conversation.work_items[0].after_code.as_deref(),
            Some("after")
        );
        assert_eq!(conversation.plan_history.len(), 1);
        assert_eq!(conversation.commentary.len(), 1);
        assert_eq!(
            conversation.work_items[0].hlc.as_deref(),
            Some("00000000000000000011-00000000")
        );
        assert_eq!(
            conversation.work_items[0].turn_id.as_deref(),
            Some("turn-1")
        );
        assert_eq!(loaded.tombstones.len(), 1);
        assert_eq!(loaded.tombstones[0].entity_type, "conversation");

        save_snapshot_in_connection(&mut connection, snapshot).expect("save snapshot twice");
        for (table, expected) in [
            ("projects", 1_i64),
            ("conversations", 1),
            ("messages", 1),
            ("work_items", 1),
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count rows");
            assert_eq!(count, expected, "unexpected row count in {table}");
        }

        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: Vec::new(),
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("archive missing rows");
        let archived_projects: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count archived projects");
        let archived_conversations: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE archived_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count archived conversations");
        assert_eq!(archived_projects, 1);
        assert_eq!(archived_conversations, 1);
        assert!(load_snapshot_from_connection(&connection)
            .expect("load archived snapshot")
            .projects
            .is_empty());
    }

    #[test]
    fn general_snapshot_round_trip_keeps_the_hidden_storage_scope_out_of_the_ui() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let mut snapshot = test_snapshot();
        snapshot.projects.clear();
        let mut conversation = snapshot
            .conversations
            .into_values()
            .next()
            .expect("conversation fixture");
        conversation.id = Some("123e4567-e89b-12d3-a456-426614174000".to_string());
        conversation.scope = GENERAL_SCOPE.to_string();
        conversation.project_id = GENERAL_PROJECT_ID.to_string();
        conversation.title = "Tell me a joke".to_string();
        conversation.thread_id = None;
        snapshot.conversations = BTreeMap::from([(
            "general::123e4567-e89b-12d3-a456-426614174000".to_string(),
            conversation,
        )]);
        snapshot.tombstones.clear();

        save_snapshot_in_connection(&mut connection, snapshot).expect("save General snapshot");
        let loaded = load_snapshot_from_connection(&connection).expect("load General snapshot");

        assert!(loaded.projects.is_empty());
        let general = loaded
            .conversations
            .get("general::123e4567-e89b-12d3-a456-426614174000")
            .expect("General conversation");
        assert_eq!(general.scope, GENERAL_SCOPE);
        assert_eq!(general.project_id, GENERAL_PROJECT_ID);
        assert_eq!(general.title, "Tell me a joke");
        assert_eq!(general.messages[0].text, "Hello");

        let stored_projects: i64 = connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .expect("count storage projects");
        assert_eq!(stored_projects, 1);
    }

    #[test]
    fn snapshot_save_coalesces_duplicate_message_aliases() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let mut snapshot = test_snapshot();
        let conversation = snapshot
            .conversations
            .values_mut()
            .next()
            .expect("conversation");
        let placeholder = LocalMessage {
            id: Some(Uuid::new_v4().to_string()),
            role: "assistant".to_string(),
            text: String::new(),
            time: "most".to_string(),
            code: Some(false),
            live: Some(true),
            final_message: Some(false),
            item_id: None,
            turn_id: Some("request:duplicate".to_string()),
            sequence: Some(11),
            hlc: None,
            origin_device_id: None,
            images: Vec::new(),
            quote_refs: Vec::new(),
        };
        let mut completed = placeholder.clone();
        completed.id = Some(Uuid::new_v4().to_string());
        completed.text = "final answer".to_string();
        completed.live = Some(false);
        completed.final_message = Some(true);
        conversation.messages.extend([placeholder, completed]);

        save_snapshot_in_connection(&mut connection, snapshot).expect("save snapshot");
        let loaded = load_snapshot_from_connection(&connection).expect("load snapshot");
        let messages = &loaded
            .conversations
            .values()
            .next()
            .expect("conversation")
            .messages;

        assert_eq!(messages.len(), 2);
        let answer = messages
            .iter()
            .find(|message| message.role == "assistant")
            .expect("answer");
        assert_eq!(answer.text, "final answer");
        assert_eq!(answer.live, Some(false));
        assert_eq!(answer.final_message, Some(true));
    }

    #[test]
    fn partial_conversation_snapshot_preserves_existing_history() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let snapshot = test_snapshot();
        save_snapshot_in_connection(&mut connection, snapshot.clone())
            .expect("save complete conversation");

        let mut partial = snapshot;
        let conversation = partial
            .conversations
            .values_mut()
            .next()
            .expect("partial conversation");
        conversation.messages.clear();
        conversation.work_items.clear();
        save_snapshot_in_connection(&mut connection, partial).expect("save partial conversation");

        let loaded =
            load_snapshot_from_connection(&connection).expect("load preserved conversation");
        let conversation = loaded
            .conversations
            .values()
            .next()
            .expect("preserved conversation");
        assert_eq!(conversation.messages.len(), 1);
        assert_eq!(conversation.messages[0].text, "Hello");
        assert_eq!(conversation.work_items.len(), 1);
        assert_eq!(conversation.work_items[0].detail, "echo");
    }

    #[test]
    fn duplicate_conversation_uuid_is_reassigned_per_title_slot() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let mut snapshot = test_snapshot();
        let project_id = snapshot.projects[0].id.clone();
        let first = snapshot
            .conversations
            .values()
            .next()
            .cloned()
            .expect("first conversation");
        let mut second = first.clone();
        second.title = "Other".to_string();
        snapshot.projects[0].threads.push(second.title.clone());
        snapshot
            .conversations
            .insert(format!("{project_id}::Other"), second);

        save_snapshot_in_connection(&mut connection, snapshot).expect("save duplicate fixture");
        let active: Vec<String> = connection
            .prepare("SELECT id FROM conversations WHERE archived_at IS NULL ORDER BY title")
            .expect("prepare conversation ids")
            .query_map([], |row| row.get(0))
            .expect("read conversation ids")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect conversation ids");
        assert_eq!(active.len(), 2);
        assert_ne!(active[0], active[1]);
    }

    #[test]
    fn stale_canonical_project_id_does_not_create_a_second_local_row() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let relative_path = "my projects/test".to_string();
        let local_project = LocalProject {
            id: "legacy-project".to_string(),
            name: "Test".to_string(),
            relative_path: Some(relative_path.clone()),
            path_hint: "C:\\test".to_string(),
            threads: Vec::new(),
        };
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![local_project.clone()],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("save local project");

        let canonical_id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("min:v2:project:{}", relative_path).as_bytes(),
        )
        .to_string();
        let mut canonical_project = local_project;
        canonical_project.id = canonical_id;
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![canonical_project],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("save canonical project");

        let active_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count active projects");
        assert_eq!(active_rows, 1);
    }

    #[test]
    fn matching_project_tombstone_hides_and_archives_project() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let project = LocalProject {
            id: "legacy-project".to_string(),
            name: "Test".to_string(),
            relative_path: Some("my projects/test".to_string()),
            path_hint: "C:\\test".to_string(),
            threads: vec!["Thread".to_string()],
        };
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![project.clone()],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("save project");
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![project],
                conversations: BTreeMap::new(),
                tombstones: vec![LocalTombstone {
                    entity_type: "project".to_string(),
                    entity_id: "legacy-project".to_string(),
                    archived_at: "2".to_string(),
                    project_id: None,
                    title: Some("Test".to_string()),
                    relative_path: Some("my projects/test".to_string()),
                    path_hint: Some("C:\\test".to_string()),
                    reason: Some("deleted".to_string()),
                }],
            },
        )
        .expect("save project tombstone");

        let loaded = load_snapshot_from_connection(&connection).expect("load snapshot");
        assert!(loaded.projects.is_empty());
        let active_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count active projects");
        assert_eq!(active_rows, 0);
    }

    #[test]
    fn general_conversation_tombstone_survives_stale_local_saves() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let conversation_id = Uuid::new_v4().to_string();
        let mut conversation = test_snapshot()
            .conversations
            .into_values()
            .next()
            .expect("conversation fixture");
        conversation.id = Some(conversation_id.clone());
        conversation.scope = GENERAL_SCOPE.to_string();
        conversation.project_id = GENERAL_PROJECT_ID.to_string();
        conversation.title = "Tell me a joke".to_string();
        conversation.thread_id = None;

        let snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: Vec::new(),
            conversations: BTreeMap::from([(
                format!("general::{conversation_id}"),
                conversation.clone(),
            )]),
            tombstones: Vec::new(),
        };
        save_snapshot_in_connection(&mut connection, snapshot).expect("save General conversation");

        let tombstone = LocalTombstone {
            entity_type: "conversation".to_string(),
            entity_id: conversation_id.clone(),
            archived_at: "2".to_string(),
            project_id: None,
            title: Some(conversation.title.clone()),
            relative_path: None,
            path_hint: None,
            reason: Some("deleted from General".to_string()),
        };
        let stale_snapshot = LocalStoreSnapshot {
            schema_version: STORE_SCHEMA_VERSION,
            projects: Vec::new(),
            // Model the stale UI snapshot that still contains the row that
            // was deleted just before the save/sync boundary.
            conversations: BTreeMap::from([(
                format!("general::{conversation_id}"),
                conversation.clone(),
            )]),
            tombstones: vec![tombstone.clone()],
        };
        save_snapshot_in_connection(&mut connection, stale_snapshot.clone())
            .expect("save General tombstone");

        let after_delete = load_snapshot_from_connection(&connection).expect("load after delete");
        assert!(!after_delete.conversations.values().any(|candidate| {
            candidate.id.as_deref() == Some(conversation_id.as_str())
        }));
        let active_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE scope = 'general' AND archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count active General conversations");
        assert_eq!(active_rows, 0);

        // Repeating the stale snapshot must not resurrect the deleted General
        // row, exactly like a later sync poll or restart-time hydration.
        save_snapshot_in_connection(&mut connection, stale_snapshot)
            .expect("repeat stale General snapshot");
        let after_repeat = load_snapshot_from_connection(&connection).expect("load repeated snapshot");
        assert!(!after_repeat.conversations.values().any(|candidate| {
            candidate.id.as_deref() == Some(conversation_id.as_str())
        }));

        // Removing the tombstone is the explicit restore path.
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: Vec::new(),
                conversations: BTreeMap::from([(
                    format!("general::{conversation_id}"),
                    conversation,
                )]),
                tombstones: Vec::new(),
            },
        )
        .expect("restore General conversation");
        let restored = load_snapshot_from_connection(&connection).expect("load restored General");
        assert!(restored.conversations.values().any(|candidate| {
            candidate.id.as_deref() == Some(conversation_id.as_str())
        }));
    }

    #[test]
    fn project_stays_hidden_by_path_until_the_tombstone_is_restored() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let project = LocalProject {
            id: "recreated-project".to_string(),
            name: "MIDI synth player".to_string(),
            relative_path: Some("my projects/MIDI synth player".to_string()),
            path_hint: "C:\\Users\\danis\\OneDrive\\my projects\\MIDI synth player".to_string(),
            threads: vec!["Új beszélgetés 2".to_string()],
        };
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![project.clone()],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("save recreated project");
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![project.clone()],
                conversations: BTreeMap::new(),
                tombstones: vec![LocalTombstone {
                    entity_type: "project".to_string(),
                    entity_id: "old-project-id".to_string(),
                    archived_at: "2".to_string(),
                    project_id: None,
                    title: Some("MIDI synth player".to_string()),
                    relative_path: Some("my projects/MIDI synth player".to_string()),
                    path_hint: Some(
                        "C:\\Users\\danis\\OneDrive\\my projects\\MIDI synth player".to_string(),
                    ),
                    reason: Some("old deletion marker".to_string()),
                }],
            },
        )
        .expect("save stale tombstone");

        let loaded = load_snapshot_from_connection(&connection).expect("load tombstoned project");
        assert!(loaded.projects.is_empty());
        let active_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count hidden projects");
        assert_eq!(active_rows, 0);

        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![project],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("restore project by removing its tombstone");

        let loaded = load_snapshot_from_connection(&connection).expect("load restored project");
        assert_eq!(loaded.projects.len(), 1);
        assert_eq!(loaded.projects[0].name, "MIDI synth player");
        let active_rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count active restored projects");
        assert_eq!(active_rows, 1);
        let tombstone_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_tombstones", [], |row| row.get(0))
            .expect("count restored tombstones");
        assert_eq!(tombstone_rows, 0);
    }

    #[test]
    fn project_tree_lifecycle_matrix_preserves_other_projects_and_the_filesystem() {
        let directory = std::env::temp_dir().join(format!("min-tree-lifecycle-{}", Uuid::new_v4()));
        let legacy_directory = directory.join("MIDI synth player");
        let new_directory = directory.join("New project");
        fs::create_dir_all(&legacy_directory).expect("legacy project directory");
        fs::create_dir_all(&new_directory).expect("new project directory");
        let legacy_marker = legacy_directory.join("created-by-codex.txt");
        let new_marker = new_directory.join("new-project.txt");
        fs::write(&legacy_marker, b"legacy").expect("legacy marker");
        fs::write(&new_marker, b"new").expect("new marker");

        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        configure_connection(&connection).expect("configure SQLite");
        initialize_connection(&mut connection).expect("initialize schema");

        let legacy_project = LocalProject {
            // This is the UUID shape produced by the old Codex/v1 importer.
            id: Uuid::new_v5(&Uuid::NAMESPACE_OID, b"legacy-codex-project").to_string(),
            name: "MIDI synth player".to_string(),
            relative_path: Some("my projects/MIDI synth player".to_string()),
            path_hint: legacy_directory.to_string_lossy().to_string(),
            threads: vec!["Imported conversation".to_string()],
        };
        let new_project = LocalProject {
            // The React client initially assigns a non-UUID project-* ID.
            id: "project-new-fixture".to_string(),
            name: "New project".to_string(),
            relative_path: Some("my projects/New project".to_string()),
            path_hint: new_directory.to_string_lossy().to_string(),
            threads: vec!["Új beszélgetés".to_string()],
        };

        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![legacy_project.clone(), new_project.clone()],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("seed mixed project identities");
        let seeded = load_snapshot_from_connection(&connection).expect("load seeded projects");
        assert_eq!(seeded.projects.len(), 2);

        let canonical_legacy_id = canonical_sync_project_id(&legacy_project);
        let legacy_tombstone = LocalTombstone {
            entity_type: "project".to_string(),
            entity_id: canonical_legacy_id,
            archived_at: "2".to_string(),
            project_id: None,
            title: Some(legacy_project.name.clone()),
            // Exercise casing and the extended Windows path prefix seen in the app.
            relative_path: Some("MY PROJECTS/midi SYNTH PLAYER".to_string()),
            path_hint: Some(format!(r"\\?\{}", legacy_directory.to_string_lossy())),
            reason: Some("remove from tree".to_string()),
        };
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                // A stale UI snapshot may still contain the deleted project.
                projects: vec![legacy_project.clone(), new_project.clone()],
                conversations: BTreeMap::new(),
                tombstones: vec![legacy_tombstone.clone()],
            },
        )
        .expect("delete imported project from tree");

        let after_delete = load_snapshot_from_connection(&connection).expect("load after delete");
        assert_eq!(after_delete.projects.len(), 1);
        assert_eq!(after_delete.projects[0].name, new_project.name);
        assert!(legacy_marker.is_file());
        assert_eq!(
            fs::read(&legacy_marker).expect("legacy marker survives"),
            b"legacy"
        );
        assert!(new_marker.is_file());

        // Repeating the same stale save models a sync poll/restart race. It must
        // not resurrect the imported project while the tombstone exists.
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![legacy_project.clone(), new_project.clone()],
                conversations: BTreeMap::new(),
                tombstones: vec![legacy_tombstone],
            },
        )
        .expect("repeat stale snapshot");
        let after_repeat =
            load_snapshot_from_connection(&connection).expect("load repeated snapshot");
        assert_eq!(after_repeat.projects.len(), 1);
        assert_eq!(after_repeat.projects[0].name, new_project.name);

        // Explicitly opening the folder removes the project tombstone and is
        // the only operation in this lifecycle that may add it back.
        save_snapshot_in_connection(
            &mut connection,
            LocalStoreSnapshot {
                schema_version: STORE_SCHEMA_VERSION,
                projects: vec![legacy_project.clone(), new_project],
                conversations: BTreeMap::new(),
                tombstones: Vec::new(),
            },
        )
        .expect("explicitly reopen project");
        let reopened = load_snapshot_from_connection(&connection).expect("load reopened projects");
        assert_eq!(reopened.projects.len(), 2);
        assert!(reopened
            .projects
            .iter()
            .any(|project| project.name == legacy_project.name));
        assert!(legacy_marker.is_file());

        fs::remove_dir_all(directory).expect("remove test fixture");
    }
}
