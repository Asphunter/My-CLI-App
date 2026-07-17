use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub const STORE_SCHEMA_VERSION: i64 = 8;

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
    code INTEGER NOT NULL DEFAULT 0,
    live INTEGER NOT NULL DEFAULT 0,
    final INTEGER NOT NULL DEFAULT 0,
    origin_device_id TEXT REFERENCES devices(id),
    attachments_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
    ON messages(conversation_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conversation_sequence
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConversation {
    pub id: Option<String>,
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
    pub sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hlc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<LocalImageAttachment>,
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
                 WHERE archived_at IS NULL AND local_available = 1
                 ORDER BY created_at, id",
            )
            .map_err(|error| format!("A lokális projektek lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| {
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
                "SELECT id, project_id, title, codex_thread_id, updated_at,
                        plan_history_json, commentary_json
                 FROM conversations
                 WHERE archived_at IS NULL
                   AND project_id IN (
                       SELECT id FROM projects
                       WHERE archived_at IS NULL AND local_available = 1
                   )
                 ORDER BY created_at, id",
            )
            .map_err(|error| format!("A lokális beszélgetések lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
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
                    "SELECT id, role, body, created_at, code, live, \"final\", item_id, sequence,
                            hlc, origin_device_id, attachments_json
                     FROM messages
                     WHERE conversation_id = ?1
                     ORDER BY COALESCE(hlc, printf('%020d', sequence)),
                              COALESCE(origin_device_id, ''), sequence, id",
                )
                .map_err(|error| format!("A lokális üzenetek lekérdezése sikertelen: {error}"))?;
            let rows = statement
                .query_map(params![conversation_id], |row| {
                    Ok(LocalMessage {
                        id: row.get(0)?,
                        role: row.get(1)?,
                        text: row.get(2)?,
                        time: row.get(3)?,
                        code: Some(row.get::<_, i64>(4)? != 0),
                        live: Some(row.get::<_, i64>(5)? != 0),
                        final_message: Some(row.get::<_, i64>(6)? != 0),
                        item_id: row.get(7)?,
                        sequence: Some(row.get(8)?),
                        hlc: row.get(9)?,
                        origin_device_id: row.get(10)?,
                        images: serde_json::from_str(&row.get::<_, String>(11)?)
                            .unwrap_or_default(),
                    })
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

        let key = format!("{project_id}::{title}");
        conversations.insert(
            key,
            LocalConversation {
                id: Some(conversation_id),
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
    conversations.retain(|_, conversation| active_project_ids.contains(&conversation.project_id));
    for project in &mut projects {
        project.threads.clear();
    }
    let project_indexes = projects
        .iter()
        .enumerate()
        .map(|(index, project)| (project.id.clone(), index))
        .collect::<HashMap<_, _>>();
    for conversation in conversations.values() {
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

fn save_snapshot_in_connection(
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
        .filter(|(_, conversation)| project_ids.contains(&conversation.project_id))
        .collect::<BTreeMap<_, _>>();
    let snapshot = LocalStoreSnapshot {
        schema_version,
        projects,
        conversations,
        tombstones,
    };
    let now = now_millis();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("A lokális snapshot tranzakciója nem indítható: {error}"))?;
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

    let mut conversation_by_slot = HashMap::<(String, String), LocalConversation>::new();
    for conversation in snapshot.conversations.values() {
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
        let local_project_id = project_ids
            .get(&conversation.project_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "A lokális beszélgetés projektje nem található: {}",
                    conversation.project_id
                )
            })?;
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
                "INSERT INTO conversations (id, project_id, title, codex_thread_id, archived_at, created_at, updated_at, plan_history_json, commentary_json)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     project_id = excluded.project_id,
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

        let mut message_sequences = HashSet::new();
        let mut message_ids = HashSet::new();
        for (index, message) in conversation.messages.iter().enumerate() {
            if message.role != "user" && message.role != "assistant" {
                return Err(format!("Ismeretlen lokális üzenetszerep: {}", message.role));
            }
            let sequence = unique_sequence(
                message.sequence.unwrap_or(index as i64),
                index,
                &mut message_sequences,
            );
            let message_id = message
                .id
                .as_deref()
                .filter(|value| Uuid::parse_str(value).is_ok())
                .filter(|value| !message_ids.contains(*value))
                .map(str::to_string)
                .unwrap_or_else(|| stable_id("message", &format!("{conversation_id}:{sequence}")));
            message_ids.insert(message_id.clone());
            let message_time = if message.time.trim().is_empty() {
                now.clone()
            } else {
                message.time.clone()
            };
            let attachments_json = serde_json::to_string(&message.images)
                .map_err(|error| format!("A képcsatolmányok nem szerializálhatók: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO messages (id, conversation_id, role, body, sequence, hlc, item_id, code, live, \"final\", origin_device_id, attachments_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                     ON CONFLICT DO UPDATE SET
                         conversation_id = excluded.conversation_id,
                         role = excluded.role,
                         body = CASE
                             WHEN length(excluded.body) >= length(messages.body) THEN excluded.body
                             ELSE messages.body
                         END,
                         sequence = excluded.sequence,
                         hlc = COALESCE(excluded.hlc, messages.hlc),
                         item_id = COALESCE(excluded.item_id, messages.item_id),
                         code = MAX(messages.code, excluded.code),
                         live = CASE
                             WHEN messages.\"final\" = 1 OR excluded.\"final\" = 1 THEN 0
                             ELSE MAX(messages.live, excluded.live)
                         END,
                         \"final\" = MAX(messages.\"final\", excluded.\"final\"),
                         origin_device_id = COALESCE(excluded.origin_device_id, messages.origin_device_id),
                         attachments_json = CASE
                             WHEN excluded.attachments_json <> '[]' THEN excluded.attachments_json
                             ELSE messages.attachments_json
                         END",
                    params![
                        message_id,
                        conversation_id,
                        message.role,
                        message.text,
                        sequence,
                        message.hlc,
                        message.item_id,
                        if message.code.unwrap_or(false) { 1 } else { 0 },
                        if message.live.unwrap_or(false) { 1 } else { 0 },
                        if message.final_message.unwrap_or(false) { 1 } else { 0 },
                        message.origin_device_id,
                        attachments_json,
                        message_time,
                    ],
                )
                .map_err(|error| format!("A lokális üzenet mentése sikertelen: {error}"))?;
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
            .prepare("SELECT id FROM conversations WHERE archived_at IS NULL")
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
            .prepare("SELECT id FROM projects WHERE archived_at IS NULL AND local_available = 1")
            .map_err(|error| format!("A régi projektek lekérdezése sikertelen: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
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
        assert_eq!(read_schema_version(&connection).expect("schema version"), 8);
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
    }

    fn test_snapshot() -> LocalStoreSnapshot {
        let project_id = "legacy-project".to_string();
        let title = "Thread".to_string();
        let conversation = LocalConversation {
            id: None,
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
                sequence: Some(10),
                hlc: Some("00000000000000000010-00000000".to_string()),
                origin_device_id: None,
                images: vec![LocalImageAttachment {
                    path: "Screenshots/8.png".to_string(),
                    name: "clipboard.png".to_string(),
                    mime_type: "image/png".to_string(),
                }],
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
