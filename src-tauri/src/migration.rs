use crate::store::LocalStore;
use hex::encode as hex_encode;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct V1State {
    #[serde(rename = "schemaVersion")]
    schema_version: i64,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(default)]
    projects: Vec<V1Project>,
    #[serde(default)]
    conversations: BTreeMap<String, V1Conversation>,
}

#[derive(Debug, Deserialize)]
struct V1Project {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(rename = "relativePath", default)]
    relative_path: Option<String>,
    #[serde(rename = "pathHint", default)]
    path_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct V1Conversation {
    #[serde(rename = "projectId", default)]
    project_id: Option<String>,
    title: String,
    #[serde(default)]
    messages: Vec<V1Message>,
    #[serde(rename = "workItems", default)]
    work_items: Vec<V1WorkItem>,
    #[serde(rename = "threadId", default)]
    thread_id: Option<String>,
    #[serde(rename = "updatedAt", default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct V1Message {
    role: String,
    text: String,
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    sequence: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct V1WorkItem {
    #[serde(default)]
    id: Option<i64>,
    #[serde(rename = "itemId", default)]
    item_id: Option<String>,
    #[serde(rename = "turnId", default)]
    turn_id: Option<String>,
    kind: String,
    status: String,
    label: String,
    detail: String,
    #[serde(rename = "eventType")]
    event_type: String,
    #[serde(default)]
    time: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportReport {
    pub source_path: String,
    pub source_sha256: String,
    pub projects_seen: usize,
    pub conversations_seen: usize,
    pub messages_seen: usize,
    pub work_items_seen: usize,
    pub inserted_projects: usize,
    pub inserted_conversations: usize,
    pub inserted_messages: usize,
    pub inserted_work_items: usize,
    pub already_imported: bool,
}

fn now_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn stable_id(kind: &str, key: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("min:v1:{kind}:{key}").as_bytes(),
    )
    .to_string()
}

fn source_hash(bytes: &[u8]) -> String {
    hex_encode(Sha256::digest(bytes))
}

fn parse_state(bytes: &[u8]) -> Result<V1State, String> {
    let state: V1State = serde_json::from_slice(bytes)
        .map_err(|error| format!("A v1 state.json nem olvasható: {error}"))?;
    if state.schema_version != 1 {
        return Err(format!(
            "A v1 import csak schemaVersion=1 állapotot fogad el, nem {}-et.",
            state.schema_version
        ));
    }
    if state.device_id.trim().is_empty() || state.updated_at.trim().is_empty() {
        return Err("A v1 state.json deviceId vagy updatedAt mezője hiányzik.".to_string());
    }
    Ok(state)
}

fn insert_import_record(
    transaction: &Transaction<'_>,
    source_sha256: &str,
    source_key: &str,
    entity_type: &str,
    entity_id: &str,
    imported_at: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO import_records (source_sha256, source_key, entity_type, entity_id, imported_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![source_sha256, source_key, entity_type, entity_id, imported_at],
        )
        .map_err(|error| format!("A v1 import provenance mentése sikertelen: {error}"))?;
    Ok(())
}

pub(crate) fn import_v1_state(
    store: &mut LocalStore,
    source_path: &Path,
) -> Result<ImportReport, String> {
    let bytes =
        fs::read(source_path).map_err(|error| format!("A v1 state.json nem olvasható: {error}"))?;
    let source_sha256 = source_hash(&bytes);
    let state = parse_state(&bytes)?;
    let imported_at = now_millis();
    let transaction = store
        .connection
        .transaction()
        .map_err(|error| format!("A v1 import tranzakciója nem indítható: {error}"))?;
    let already_imported = transaction
        .query_row(
            "SELECT 1 FROM import_records WHERE source_sha256 = ?1 LIMIT 1",
            params![source_sha256],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("A v1 import előzményének lekérdezése sikertelen: {error}"))?
        .is_some();

    let device_id = stable_id("device", &state.device_id);
    transaction
        .execute(
            "INSERT OR IGNORE INTO devices (id, name, last_hlc, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![device_id, format!("v1 import · {}", state.device_id), state.updated_at, imported_at],
        )
        .map_err(|error| format!("A v1 import device mentése sikertelen: {error}"))?;

    let mut project_ids = BTreeMap::new();
    let mut inserted_projects = 0;
    for project in &state.projects {
        let legacy_key = project
            .id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(project.relative_path.as_deref())
            .or(project.path_hint.as_deref())
            .unwrap_or(&project.name);
        let project_id = stable_id("project", legacy_key);
        if let Some(legacy_id) = project.id.as_deref() {
            project_ids.insert(legacy_id.to_string(), project_id.clone());
        }
        if let Some(relative_path) = project.relative_path.as_deref() {
            project_ids.insert(relative_path.to_string(), project_id.clone());
        }
        let changed = transaction
            .execute(
                "INSERT OR IGNORE INTO projects (id, name, canonical_path, relative_path, local_available, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                params![project_id, project.name, project.path_hint.as_deref().unwrap_or_default(), project.relative_path, imported_at],
            )
            .map_err(|error| format!("A v1 import projekt mentése sikertelen: {error}"))?;
        inserted_projects += changed as usize;
        insert_import_record(
            &transaction,
            &source_sha256,
            &format!("project:{legacy_key}"),
            "project",
            &project_id,
            &imported_at,
        )?;
    }

    let mut inserted_conversations = 0;
    let mut inserted_messages = 0;
    let mut inserted_work_items = 0;
    for (conversation_key, conversation) in &state.conversations {
        let project_id = match conversation
            .project_id
            .as_deref()
            .and_then(|legacy_id| project_ids.get(legacy_id))
            .cloned()
        {
            Some(project_id) => project_id,
            None => {
                let legacy_key = conversation.project_id.as_deref().unwrap_or("unassigned");
                let project_id = stable_id("project", legacy_key);
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO projects (id, name, canonical_path, local_available, created_at, updated_at) VALUES (?1, 'Importált projekt', '', 0, ?2, ?2)",
                        params![project_id, imported_at],
                    )
                    .map_err(|error| format!("A v1 import placeholder projektje nem menthető: {error}"))?;
                insert_import_record(
                    &transaction,
                    &source_sha256,
                    &format!("project:placeholder:{legacy_key}"),
                    "project",
                    &project_id,
                    &imported_at,
                )?;
                project_id
            }
        };
        let conversation_id = stable_id(
            "conversation",
            &format!("{project_id}:{}", conversation.title),
        );
        let changed = transaction
            .execute(
                "INSERT OR IGNORE INTO conversations (id, project_id, title, codex_thread_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![conversation_id, project_id, conversation.title, conversation.thread_id, imported_at, conversation.updated_at.as_deref().unwrap_or(&state.updated_at)],
            )
            .map_err(|error| format!("A v1 import beszélgetés mentése sikertelen: {error}"))?;
        inserted_conversations += changed as usize;
        insert_import_record(
            &transaction,
            &source_sha256,
            &format!("conversation:{conversation_key}"),
            "conversation",
            &conversation_id,
            &imported_at,
        )?;

        let mut turn_ids = BTreeMap::new();
        for work_item in &conversation.work_items {
            if let Some(turn_id) = work_item
                .turn_id
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                let local_turn_id = stable_id("turn", &format!("{conversation_id}:{turn_id}"));
                turn_ids.insert(turn_id.to_string(), local_turn_id.clone());
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO turns (id, conversation_id, codex_thread_id, codex_turn_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'imported', ?5, ?5)",
                        params![local_turn_id, conversation_id, conversation.thread_id, turn_id, imported_at],
                    )
                    .map_err(|error| format!("A v1 import turn mentése sikertelen: {error}"))?;
            }
        }

        for (index, message) in conversation.messages.iter().enumerate() {
            let sequence = message.sequence.unwrap_or(index as i64);
            let message_id = stable_id(
                "message",
                &format!(
                    "{conversation_id}:{index}:{sequence}:{}:{}",
                    message.role, message.text
                ),
            );
            let changed = transaction
                .execute(
                    "INSERT OR IGNORE INTO messages (id, conversation_id, role, body, sequence, item_id, code, live, \"final\", origin_device_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, 0, ?6, ?7)",
                    params![message_id, conversation_id, message.role, message.text, sequence, device_id, message.time.as_deref().unwrap_or(&imported_at)],
                )
                .map_err(|error| format!("A v1 import üzenet mentése sikertelen: {error}"))?;
            inserted_messages += changed as usize;
            insert_import_record(
                &transaction,
                &source_sha256,
                &format!("message:{conversation_key}:{index}"),
                "message",
                &message_id,
                &imported_at,
            )?;
        }

        for (index, work_item) in conversation.work_items.iter().enumerate() {
            let work_item_key = work_item
                .item_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| work_item.id.map(|id| id.to_string()))
                .unwrap_or_else(|| index.to_string());
            let work_item_id = stable_id(
                "work-item",
                &format!(
                    "{conversation_id}:{work_item_key}:{}:{}",
                    work_item.event_type, work_item.detail
                ),
            );
            let local_turn_id = work_item
                .turn_id
                .as_deref()
                .and_then(|turn_id| turn_ids.get(turn_id));
            let changed = transaction
                .execute(
                    "INSERT OR IGNORE INTO work_items (id, conversation_id, turn_id, item_id, kind, status, label, detail, event_type, body, code, language, sequence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![work_item_id, conversation_id, local_turn_id, work_item.item_id, work_item.kind, work_item.status, work_item.label, work_item.detail, work_item.event_type, work_item.body, work_item.code, work_item.language, index as i64, work_item.time.as_deref().unwrap_or(&imported_at)],
                )
                .map_err(|error| format!("A v1 import work item mentése sikertelen: {error}"))?;
            inserted_work_items += changed as usize;
            insert_import_record(
                &transaction,
                &source_sha256,
                &format!("work-item:{conversation_key}:{index}"),
                "work_item",
                &work_item_id,
                &imported_at,
            )?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("A v1 import commitja sikertelen: {error}"))?;

    Ok(ImportReport {
        source_path: source_path.to_string_lossy().to_string(),
        source_sha256,
        projects_seen: state.projects.len(),
        conversations_seen: state.conversations.len(),
        messages_seen: state
            .conversations
            .values()
            .map(|conversation| conversation.messages.len())
            .sum(),
        work_items_seen: state
            .conversations
            .values()
            .map(|conversation| conversation.work_items.len())
            .sum(),
        inserted_projects,
        inserted_conversations,
        inserted_messages,
        inserted_work_items,
        already_imported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::initialize_connection;
    use rusqlite::Connection;

    fn fixture() -> &'static str {
        r#"{
          "schemaVersion": 1,
          "deviceId": "device-v1",
          "updatedAt": "2026-07-13T00:00:00Z",
          "projects": [{
            "id": "project-v1",
            "name": "Import fixture",
            "relativePath": "fixture/import",
            "pathHint": "C:\\fixture\\import",
            "threads": ["Első"]
          }],
          "conversations": {
            "project-v1::Első": {
              "projectId": "project-v1",
              "title": "Első",
              "threadId": "thread-v1",
              "updatedAt": "2026-07-13T00:00:00Z",
              "messages": [
                {"role": "user", "text": "Őrizd meg ezt.", "time": "2026-07-13T00:00:01Z", "sequence": 1},
                {"role": "assistant", "text": "Megőrizve.", "time": "2026-07-13T00:00:02Z", "sequence": 2}
              ],
              "workItems": [{
                "id": 1,
                "itemId": "item-v1",
                "turnId": "turn-v1",
                "kind": "file",
                "status": "done",
                "label": "Fájl",
                "detail": "README.md",
                "eventType": "file/change",
                "time": "2026-07-13T00:00:03Z"
              }]
            }
          }
        }"#
    }

    #[test]
    fn v1_import_is_copy_only_and_idempotent() {
        let directory = std::env::temp_dir().join(format!("min-v1-import-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("fixture directory");
        let source_path = directory.join("state.json");
        fs::write(&source_path, fixture()).expect("fixture state");
        let before = fs::read(&source_path).expect("read fixture before import");

        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        initialize_connection(&mut connection).expect("initialize schema");
        let mut store = LocalStore {
            path: directory.join("min.db"),
            connection,
        };

        let first = import_v1_state(&mut store, &source_path).expect("first import");
        let second = import_v1_state(&mut store, &source_path).expect("second import");
        let after = fs::read(&source_path).expect("read fixture after import");

        assert_eq!(first.projects_seen, 1);
        assert_eq!(first.messages_seen, 2);
        assert_eq!(first.work_items_seen, 1);
        assert_eq!(first.inserted_projects, 1);
        assert_eq!(first.inserted_messages, 2);
        assert_eq!(first.inserted_work_items, 1);
        assert!(second.already_imported);
        assert_eq!(second.inserted_projects, 0);
        assert_eq!(second.inserted_messages, 0);
        assert_eq!(second.inserted_work_items, 0);
        assert_eq!(before, after);

        let project_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .expect("project count");
        let message_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("message count");
        let provenance_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM import_records", [], |row| row.get(0))
            .expect("provenance count");
        assert_eq!(project_count, 1);
        assert_eq!(message_count, 2);
        assert_eq!(provenance_count, 5);

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn unsupported_schema_is_rejected_without_database_write() {
        let directory = std::env::temp_dir().join(format!("min-v1-invalid-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("fixture directory");
        let source_path = directory.join("state.json");
        fs::write(&source_path, r#"{"schemaVersion":99,"deviceId":"x","updatedAt":"y","projects":[],"conversations":{}}"#).expect("invalid fixture");
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite");
        initialize_connection(&mut connection).expect("initialize schema");
        let mut store = LocalStore {
            path: directory.join("min.db"),
            connection,
        };

        let result = import_v1_state(&mut store, &source_path);

        assert!(result.is_err());
        let project_count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .expect("project count");
        assert_eq!(project_count, 0);
        let _ = fs::remove_dir_all(directory);
    }
}
