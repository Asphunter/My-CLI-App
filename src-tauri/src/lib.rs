mod agent;
mod claude;
mod codex;
mod migration;
mod pipeline;
mod store;
mod sync;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(desktop)]
use tauri::Manager;

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
async fn agent_send(
    app: tauri::AppHandle,
    request: agent::AgentTurnRequest,
) -> Result<agent::AgentResponse, String> {
    run_agent_turn(app, request).await
}

/// The single place a turn is actually executed. `agent_send` is the frontend's
/// door into it; the pipeline runner walks in through the same door so a stage
/// is an ordinary turn in every respect — same store rows, same events, same
/// rollback guard.
async fn run_agent_turn(
    app: tauri::AppHandle,
    mut request: agent::AgentTurnRequest,
) -> Result<agent::AgentResponse, String> {
    let request_id = request.request_id.clone().unwrap_or_else(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        format!("agent-request-{stamp}")
    });
    request.request_id = Some(request_id.clone());
    store::record_agent_turn_start(&mut request)?;
    if request.provider == agent::AgentProvider::Codex
        && request.runtime == agent::AgentRuntimeKind::CodexAppServer
    {
        let codex_request = request.to_codex_request()?;
        let request_for_worker = request.clone();
        let cancellation = codex::begin_request(&request_id)?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            codex::send(app, codex_request, cancellation)
        })
        .await
        .map_err(|error| format!("Az agent hÃ¡ttÃ©rfeladat leÃ¡llt: {error}"))?;
        codex::end_request(&request_id);
        result
            .map(|response| {
                let response = agent::from_codex_response(&request_for_worker, response);
                let _ = store::record_agent_turn_terminal(&request, &response, "completed");
                let _ = store::record_agent_answer(&request, &response);
                response
            })
            .map_err(|error| {
                let _ = store::record_agent_turn_failure(&request, "failed");
                error
            })
    } else if request.provider == agent::AgentProvider::Anthropic
        && request.runtime == agent::AgentRuntimeKind::ClaudeAgentBridge
    {
        let request_for_worker = request.clone();
        let cancellation = claude::begin_request(&request_id)?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            claude::send(app, request_for_worker, cancellation)
        })
        .await
        .map_err(|error| format!("A Claude agent háttérfeladata leállt: {error}"))?;
        claude::end_request(&request_id);
        result
            .map(|response| {
                let _ = store::record_agent_turn_terminal(&request, &response, "completed");
                let _ = store::record_agent_answer(&request, &response);
                response
            })
            .map_err(|error| {
                let _ = store::record_agent_turn_failure(&request, "failed");
                error
            })
    } else {
        Err("Ismeretlen vagy nem támogatott provider/runtime páros.".to_string())
    }
}

#[tauri::command]
fn pipeline_recipes() -> Vec<pipeline::Recipe> {
    pipeline::recipes_for_frontend()
}

#[tauri::command(rename_all = "camelCase")]
async fn pipeline_send(
    app: tauri::AppHandle,
    request: pipeline::PipelineRunRequest,
) -> Result<pipeline::PipelineRunResult, String> {
    let mut recipe = pipeline::recipe_by_id(&request.recipe_id)
        .ok_or_else(|| format!("Ismeretlen recept: {}.", request.recipe_id))?;
    pipeline::apply_stage_overrides(&mut recipe, &request.stage_overrides);
    recipe.validate()?;
    if request.request_ids.len() != recipe.stages.len() {
        return Err(format!(
            "A recept {} szakaszához {} request id kell, {} érkezett.",
            recipe.label,
            recipe.stages.len(),
            request.request_ids.len()
        ));
    }

    let run_id = store::begin_pipeline_run(&request.conversation_id, &recipe)?;
    let stage_count = recipe.stages.len() as i64;
    let mut artifacts = Vec::<pipeline::StageArtifact>::new();
    let mut stages = Vec::<pipeline::PipelineStageResult>::new();
    // A stage of the same runtime continues the same session, so a model switch
    // inside one vendor keeps the context. Crossing runtimes starts fresh and
    // the artifact block in the prompt is what carries the work over.
    let mut session_by_runtime: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(session_id) = request.session_id.clone() {
        session_by_runtime.insert(
            format!("{:?}", agent::AgentRuntimeKind::ClaudeAgentBridge),
            session_id,
        );
    }
    let mut status = pipeline::RunStatus::Running;
    let mut run_error = None;

    for (index, stage) in recipe.stages.iter().enumerate() {
        let agent_label = pipeline::stage_agent_label(stage);
        let request_id = request.request_ids[index].clone();
        let runtime_key = format!("{:?}", stage.runtime);
        let progress =
            |phase: &'static str, status: pipeline::RunStatus| pipeline::PipelineProgress {
                run_id: run_id.clone(),
                conversation_id: request.conversation_id.clone(),
                stage_index: index as i64,
                stage_count,
                role: stage.role,
                agent_label: agent_label.clone(),
                request_id: request_id.clone(),
                phase,
                status,
            };
        let _ = codex::emit_main_window(&app, "pipeline-progress", &progress("started", status));

        store::update_pipeline_run_stage(&run_id, index as i64)?;
        let turn = agent::AgentTurnRequest {
            prompt: pipeline::stage_prompt(stage.role, &request.prompt, &artifacts),
            // Only the first stage carries the user's attachments; a later stage
            // reasons about the work, not about the original images again.
            images: if index == 0 {
                request.images.clone()
            } else {
                Vec::new()
            },
            provider: stage.provider,
            runtime: stage.runtime,
            conversation_id: Some(request.conversation_id.clone()),
            session_id: session_by_runtime.get(&runtime_key).cloned(),
            conversation_context: if index == 0 {
                request.conversation_context.clone()
            } else {
                None
            },
            model: stage.model.clone(),
            effort: stage.effort.clone(),
            cwd: request.cwd.clone(),
            request_id: Some(request_id.clone()),
            max_budget_usd: request.max_budget_usd,
            max_turns: stage.max_turns,
            tool_profile: Some(stage.role.tool_profile()),
        };

        let outcome = run_agent_turn(app.clone(), turn).await;
        let is_last = index + 1 == recipe.stages.len();
        let stage_result = match outcome {
            Ok(response) => {
                if let Some(session_id) = response.session_id.clone() {
                    session_by_runtime.insert(runtime_key, session_id);
                }
                let review = if stage.role == pipeline::StageRole::Review {
                    pipeline::parse_review_verdict(&response.text)
                } else {
                    None
                };
                artifacts.push(pipeline::artifact_from_response(
                    stage.role,
                    &response.text,
                    &response.guard,
                ));
                status = pipeline::status_after_stage(true, is_last);
                pipeline::PipelineStageResult {
                    index: index as i64,
                    role: stage.role,
                    agent_label: agent_label.clone(),
                    request_id: request_id.clone(),
                    succeeded: true,
                    text: response.text,
                    error: None,
                    review,
                    session_id: response.session_id,
                }
            }
            Err(error) => {
                status = pipeline::status_after_stage(false, is_last);
                run_error = Some(error.clone());
                pipeline::PipelineStageResult {
                    index: index as i64,
                    role: stage.role,
                    agent_label: agent_label.clone(),
                    request_id: request_id.clone(),
                    succeeded: false,
                    text: String::new(),
                    error: Some(error),
                    review: None,
                    session_id: None,
                }
            }
        };
        let failed = !stage_result.succeeded;
        // Label the answer this stage just stored, so the badge survives a
        // restart and reaches the other device on the message itself.
        if stage_result.succeeded {
            let _ = store::label_pipeline_stage_answer(
                &request.conversation_id,
                &request_id,
                &store::LocalMessagePipeline {
                    run_id: run_id.clone(),
                    stage_index: index as i64,
                    stage_count,
                    stage_role: format!("{:?}", stage.role).to_lowercase(),
                    stage_agent: agent_label.clone(),
                    verdict: stage_result
                        .review
                        .as_ref()
                        .map(|review| match review.verdict {
                            pipeline::ReviewVerdict::Accepted => "accepted".to_string(),
                            pipeline::ReviewVerdict::ChangesRequested => {
                                "changes_requested".to_string()
                            }
                        }),
                    verdict_summary: stage_result
                        .review
                        .as_ref()
                        .map(|review| review.summary.clone()),
                },
            );
        }
        let _ = codex::emit_main_window(
            &app,
            "pipeline-progress",
            &progress(if failed { "failed" } else { "finished" }, status),
        );
        stages.push(stage_result);
        if failed {
            break;
        }
    }

    store::finish_pipeline_run(&run_id, status.as_wire(), run_error.as_deref())?;
    Ok(pipeline::PipelineRunResult {
        run_id,
        recipe,
        status,
        stages,
        error: run_error,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn agent_conversation_status(
    conversation_id: String,
) -> Result<Option<store::AgentConversationStatus>, String> {
    store::agent_conversation_status(&conversation_id)
}

#[tauri::command(rename_all = "camelCase")]
fn agent_answer_checkpoint(
    conversation_id: String,
    request_id: String,
    text: String,
) -> Result<(), String> {
    store::record_agent_answer_text(&conversation_id, &request_id, &text)
}

#[tauri::command(rename_all = "camelCase")]
fn agent_cancel(provider: Option<agent::AgentProvider>, request_id: String) -> Result<(), String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => codex::cancel_request(&request_id),
        agent::AgentProvider::Anthropic => Err(
            "A Claude bridge megszakítása a live coding runtime bekötésével aktiválódik."
                .to_string(),
        ),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_approval_response(
    provider: Option<agent::AgentProvider>,
    approval_id: String,
    decision: String,
) -> Result<(), String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => codex::respond_approval(&approval_id, &decision),
        agent::AgentProvider::Anthropic => {
            Err("A Claude approval UI a live coding runtime bekötésével aktiválódik.".to_string())
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_question_response(
    provider: Option<agent::AgentProvider>,
    question_id: String,
    answer: serde_json::Value,
) -> Result<(), String> {
    let _ = (provider, question_id, answer);
    Err(
        "A provider question-kezelés a live Claude coding runtime fázisában aktiválódik."
            .to_string(),
    )
}

#[tauri::command(rename_all = "camelCase")]
fn claude_cancel(request_id: String) -> Result<(), String> {
    claude::cancel_request(&request_id)
}

#[tauri::command(rename_all = "camelCase")]
fn claude_approval_response(
    approval_id: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    claude::respond_approval(&approval_id, &decision, reason)
}

#[tauri::command(rename_all = "camelCase")]
fn claude_question_response(question_id: String, answer: serde_json::Value) -> Result<(), String> {
    claude::respond_question(&question_id, answer)
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_models(
    app: tauri::AppHandle,
    provider: Option<agent::AgentProvider>,
) -> Result<Vec<agent::AgentModelDescriptor>, String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => tauri::async_runtime::spawn_blocking(move || {
            codex::list_models(app).map(agent::codex_model_descriptors)
        })
        .await
        .map_err(|error| {
            format!("A provider modellkatalÃ³gus hÃ¡ttÃ©rfeladata leÃ¡llt: {error}")
        })?,
        agent::AgentProvider::Anthropic => Ok(agent::runtime_catalog()
            .into_iter()
            .find(|runtime| runtime.provider == agent::AgentProvider::Anthropic)
            .map(|runtime| runtime.models)
            .unwrap_or_default()),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_auth_status(
    provider: Option<agent::AgentProvider>,
) -> Result<agent::AgentAuthStatus, String> {
    match provider.unwrap_or(agent::AgentProvider::Anthropic) {
        agent::AgentProvider::Codex => Ok(agent::AgentAuthStatus {
            provider: agent::AgentProvider::Codex,
            configured: true,
            source: "codexAppServer".to_string(),
            preview: None,
        }),
        agent::AgentProvider::Anthropic => {
            let status = claude::auth_status()?;
            Ok(agent::AgentAuthStatus {
                provider: agent::AgentProvider::Anthropic,
                configured: status.configured,
                source: status.source,
                preview: status.preview,
            })
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_test_connection(
    provider: Option<agent::AgentProvider>,
    model: Option<String>,
    effort: Option<String>,
    max_budget_usd: Option<f64>,
    max_turns: Option<u32>,
    cwd: Option<String>,
) -> Result<agent::AgentConnectionResult, String> {
    match provider.unwrap_or(agent::AgentProvider::Anthropic) {
        agent::AgentProvider::Anthropic => tauri::async_runtime::spawn_blocking(move || {
            claude::test_connection(model, effort, max_budget_usd, max_turns, cwd)
                .map(agent::from_claude_connection)
        })
        .await
        .map_err(|error| format!("A provider kapcsolat-teszt hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?,
        agent::AgentProvider::Codex => {
            Err("A Codex kapcsolatát a meglévő app-server transport kezeli.".to_string())
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_shutdown(provider: Option<agent::AgentProvider>) -> Result<(), String> {
    let _ = provider;
    Ok(())
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
async fn agent_rollback_snapshot(
    snapshot_id: String,
) -> Result<codex::AgentRollbackResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::rollback_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("Az agent rollback háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_apply_snapshot(snapshot_id: String) -> Result<codex::AgentApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::apply_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("Az agent apply háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_discard_snapshot(snapshot_id: String) -> Result<codex::AgentDiscardResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::discard_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("Az agent snapshot elvetése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_preview_snapshot(snapshot_id: String) -> Result<codex::AgentDiffPreview, String> {
    tauri::async_runtime::spawn_blocking(move || codex::preview_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("Az agent diff preview háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_rebase_snapshot(snapshot_id: String) -> Result<codex::AgentRebaseResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex::rebase_agent_snapshot(&snapshot_id))
        .await
        .map_err(|error| format!("Az agent rebase háttérfeladata leállt: {error}"))?
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
fn agent_runtime_catalog() -> Vec<agent::AgentRuntimeDescriptor> {
    agent::runtime_catalog()
}

#[tauri::command]
fn claude_auth_status() -> Result<claude::ClaudeAuthStatus, String> {
    claude::auth_status()
}

#[tauri::command(rename_all = "camelCase")]
async fn claude_save_api_key(api_key: String) -> Result<claude::ClaudeAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || claude::save_api_key(&api_key))
        .await
        .map_err(|error| format!("A Claude API-kulcs mentési hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?
}

#[tauri::command]
async fn claude_delete_api_key() -> Result<claude::ClaudeAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(claude::delete_api_key)
        .await
        .map_err(|error| format!("A Claude API-kulcs tÃ¶rlési hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn claude_test_connection(
    model: Option<String>,
    effort: Option<String>,
    max_budget_usd: Option<f64>,
    max_turns: Option<u32>,
    cwd: Option<String>,
) -> Result<claude::ClaudeConnectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claude::test_connection(model, effort, max_budget_usd, max_turns, cwd)
    })
    .await
    .map_err(|error| format!("A Claude kapcsolat-teszt hÃ¡ttÃ©rfeladata leÃ¡llt: {error}"))?
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
        let _ = store::recover_orphaned_agent_turns();
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
    let builder = tauri::Builder::default();
    // Register this first: a second native process would own another WebView,
    // app-server and audio queue, producing offset completion sounds and
    // competing SQLite/sync writes for the same device identity.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .invoke_handler(tauri::generate_handler![
            codex_send,
            agent_send,
            pipeline_recipes,
            pipeline_send,
            agent_conversation_status,
            agent_answer_checkpoint,
            agent_cancel,
            agent_approval_response,
            agent_question_response,
            claude_cancel,
            claude_approval_response,
            claude_question_response,
            agent_models,
            agent_auth_status,
            agent_test_connection,
            agent_shutdown,
            codex_rollback_snapshot,
            codex_apply_snapshot,
            codex_discard_snapshot,
            codex_preview_snapshot,
            codex_rebase_snapshot,
            agent_rollback_snapshot,
            agent_apply_snapshot,
            agent_discard_snapshot,
            agent_preview_snapshot,
            agent_rebase_snapshot,
            codex_respond_approval,
            codex_cancel,
            read_code_file,
            run_project_file,
            open_project_folder,
            save_image_attachments,
            read_project_image,
            codex_models,
            agent_runtime_catalog,
            claude_auth_status,
            claude_save_api_key,
            claude_delete_api_key,
            claude_test_connection,
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
