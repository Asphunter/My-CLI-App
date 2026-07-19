mod codex;
mod migration;
mod store;
mod sync;
use std::time::{SystemTime, UNIX_EPOCH};

#[tauri::command]
async fn codex_send(
    app: tauri::AppHandle,
    mut request: codex::CodexRequest,
) -> Result<codex::CodexResponse, String> {
    let request_id = request.request_id.clone().unwrap_or_else(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        format!("request-{stamp}")
    });
    request.request_id = Some(request_id.clone());
    let cancellation = codex::begin_request(&request_id)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || codex::send(app, request, cancellation))
            .await
            .map_err(|error| format!("A Codex-háttérfeladat leállt: {error}"))?;
    codex::end_request(&request_id);
    result
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_rollback_snapshot(
    snapshot_id: String,
) -> Result<codex::AgentRollbackResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::rollback_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("A Codex rollback háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_apply_snapshot(snapshot_id: String) -> Result<codex::AgentApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::apply_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("A Codex apply háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_discard_snapshot(snapshot_id: String) -> Result<codex::AgentDiscardResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::discard_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("A Codex staged snapshot törlése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_preview_snapshot(snapshot_id: String) -> Result<codex::AgentDiffPreview, String> {
    tauri::async_runtime::spawn_blocking(move || codex::preview_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("A Codex diff preview háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_rebase_snapshot(snapshot_id: String) -> Result<codex::AgentRebaseResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::rebase_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("A Codex 3-way merge háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
fn codex_respond_approval(approval_id: String, decision: String) -> Result<(), String> {
    codex::respond_approval(&approval_id, &decision)
}

#[tauri::command(rename_all = "camelCase")]
fn codex_cancel(request_id: String) -> Result<(), String> {
    codex::cancel_request(&request_id)
}

#[tauri::command]
async fn read_code_file(cwd: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || codex::read_code_file(&cwd, &path))
        .await
        .map_err(|error| format!("A kódfájl-beolvasás háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn run_project_file(cwd: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || codex::run_project_file(&cwd, &path))
        .await
        .map_err(|error| format!("A fÃ¡jl futtatÃ¡si hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn open_project_folder(cwd: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || codex::open_project_folder(&cwd, &path))
        .await
        .map_err(|error| format!("A mappanyitÃ¡si hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn save_image_attachments(
    cwd: String,
    images: Vec<codex::PendingImageUpload>,
) -> Result<Vec<codex::CodexImageAttachment>, String> {
    tauri::async_runtime::spawn_blocking(move || codex::save_image_uploads(&cwd, images))
        .await
        .map_err(|error| format!("A képcsatolmányok mentése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn read_project_image(cwd: String, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || codex::read_project_image(&cwd, &path))
        .await
        .map_err(|error| format!("A projektkép beolvasása leállt: {error}"))?
}

#[tauri::command]
async fn codex_models(app: tauri::AppHandle) -> Result<Vec<codex::CodexModel>, String> {
    tauri::async_runtime::spawn_blocking(move || codex::list_models(app))
        .await
        .map_err(|error| format!("A modellkatalógus-háttérfeladat leállt: {error}"))?
}

#[tauri::command]
async fn codex_workspace() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(codex::workspace_root_for_ui)
        .await
        .map_err(|error| format!("A projektek-gyökerének felderítése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn codex_set_projects_root(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || codex::set_projects_root(&path))
        .await
        .map_err(|error| format!("A projektek-gyökerének mentése leállt: {error}"))?
}

#[tauri::command]
async fn pick_project_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(codex::pick_project_directory)
        .await
        .map_err(|error| format!("A projektmappa-választó háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn pick_projects_root() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(codex::pick_projects_root)
        .await
        .map_err(|error| format!("A OneDrive-gyökér választó háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn create_project_directory(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || codex::create_project_directory(&name))
        .await
        .map_err(|error| format!("A projektmappa-letrehozas hatterfeladata leallt: {error}"))?
}

#[tauri::command]
async fn ensure_project_instructions(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || codex::ensure_project_instructions(&path))
        .await
        .map_err(|error| format!("A projektutasitasok hatterfeladata leallt: {error}"))?
}

#[tauri::command]
async fn sync_load() -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(codex::sync_load)
        .await
        .map_err(|error| format!("A szinkronbetöltés háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_save(state: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || codex::sync_save(state))
        .await
        .map_err(|error| format!("A szinkronmentés háttérfeladata leállt: {error}"))?
}

#[tauri::command]
fn local_store_health() -> Result<store::StoreHealth, String> {
    store::local_store_health()
}

#[tauri::command]
async fn local_store_initialize() -> Result<store::StoreHealth, String> {
    tauri::async_runtime::spawn_blocking(store::initialize_local_store)
        .await
        .map_err(|error| {
            format!("A lokális SQLite inicializálási háttérfeladata leállt: {error}")
        })?
}

#[tauri::command]
async fn local_store_import_v1() -> Result<Vec<migration::ImportReport>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let source_paths = codex::sync_state_paths();
        if source_paths.is_empty() {
            return Ok(Vec::new());
        }
        let mut store = store::open_local_store()?;
        source_paths
            .iter()
            .map(|path| migration::import_v1_state(&mut store, path))
            .collect()
    })
    .await
    .map_err(|error| format!("A v1 import háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn local_store_load() -> Result<store::LocalStoreSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let snapshot = store::load_snapshot()?;
        let (snapshot, recovered) = codex::recover_local_store_snapshot(snapshot)?;
        if recovered {
            // SQLite is the local startup source of truth. Persisting the
            // recovered text also prevents a later partial sync row from
            // hiding the answer again.
            let _ = store::save_snapshot(snapshot.clone());
        }
        Ok(snapshot)
    })
        .await
        .map_err(|error| format!("A lokÃ¡lis snapshot betÃ¶ltÃ©se leÃ¡llt: {error}"))?
}

#[tauri::command]
async fn local_store_save(
    snapshot: store::LocalStoreSnapshot,
) -> Result<store::LocalStoreSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || store::save_snapshot(snapshot))
        .await
        .map_err(|error| format!("A lokÃ¡lis snapshot mentÃ©se leÃ¡llt: {error}"))?
}

#[tauri::command]
async fn sync_v2_pull() -> Result<sync::SyncV2Result, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_pull)
        .await
        .map_err(|error| format!("A v2 sync import háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_rebuild_from_local() -> Result<sync::SyncV2Result, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_rebuild_from_local)
        .await
        .map_err(|error| {
            format!("A v2 sync journal helyreállítási háttérfeladata leállt: {error}")
        })?
}

#[tauri::command]
async fn sync_v2_publish_snapshot(
    snapshot: store::LocalStoreSnapshot,
) -> Result<sync::SyncV2Result, String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_v2_publish_snapshot(snapshot))
        .await
        .map_err(|error| format!("A v2 sync publish háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_preview_restore_entity(
    tombstone: store::LocalTombstone,
) -> Result<sync::SyncRestorePreview, String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_v2_preview_restore_entity(tombstone))
        .await
        .map_err(|error| format!("A v2 restore dry-run háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_retention_preview() -> Result<sync::SyncRetentionPreview, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_retention_preview)
        .await
        .map_err(|error| format!("A v2 retention dry-run háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_retention_ack() -> Result<sync::SyncRetentionPreview, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_retention_ack)
        .await
        .map_err(|error| format!("A v2 retention ACK háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_retention_backup() -> Result<sync::SyncRetentionPreview, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_retention_backup)
        .await
        .map_err(|error| format!("A v2 retention backup háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_retention_purge() -> Result<sync::SyncRetentionPreview, String> {
    tauri::async_runtime::spawn_blocking(sync::sync_v2_retention_purge)
        .await
        .map_err(|error| format!("A v2 retention purge háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn sync_v2_retention_purge_selected(
    entity_keys: Vec<String>,
) -> Result<sync::SyncRetentionPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sync::sync_v2_retention_purge_selected(entity_keys)
    })
    .await
    .map_err(|error| format!("A kijelölt retention purge háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn sync_v2_restore_entity(
    tombstone: store::LocalTombstone,
) -> Result<sync::SyncV2Result, String> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_v2_restore_entity(tombstone))
        .await
        .map_err(|error| format!("A v2 restore háttérfeladata leállt: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            codex_send,
            codex_rollback_snapshot,
            codex_apply_snapshot,
            codex_discard_snapshot,
            codex_preview_snapshot,
            codex_rebase_snapshot,
            codex_respond_approval,
            codex_cancel,
            read_code_file,
            run_project_file,
            open_project_folder,
            save_image_attachments,
            read_project_image,
            codex_models,
            codex_workspace,
            codex_set_projects_root,
            pick_project_directory,
            pick_projects_root,
            create_project_directory,
            ensure_project_instructions,
            sync_load,
            sync_save,
            local_store_health,
            local_store_initialize,
            local_store_import_v1,
            local_store_load,
            local_store_save,
            sync_v2_pull,
            sync_v2_rebuild_from_local,
            sync_v2_publish_snapshot,
            sync_v2_preview_restore_entity,
            sync_v2_retention_preview,
            sync_v2_retention_ack,
            sync_v2_retention_backup,
            sync_v2_retention_purge,
            sync_v2_retention_purge_selected,
            sync_v2_restore_entity
        ])
        .run(tauri::generate_context!())
        .expect("error while running min");
}
