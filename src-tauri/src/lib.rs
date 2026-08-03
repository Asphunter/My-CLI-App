mod agent;
mod claude;
mod codex;
mod migration;
mod pipeline;
mod store;
mod sync;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(desktop)]
use tauri::{Emitter, Manager, WindowEvent};

/// Native source of truth for work that must finish before the desktop window
/// can be closed. The React run table is intentionally not used here: the
/// native command may still be preparing/finalizing while the WebView has
/// already rendered the last provider event.
static ACTIVE_WORK: AtomicUsize = AtomicUsize::new(0);

fn active_work_count() -> usize {
    ACTIVE_WORK.load(Ordering::SeqCst)
}

#[cfg(desktop)]
fn set_taskbar_running(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_progress_bar(tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::Indeterminate),
            progress: None,
        });
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_overlay_icon(None);
        }
    }
}

#[cfg(desktop)]
fn set_taskbar_terminal(app: &tauri::AppHandle, success: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_progress_bar(tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::None),
            progress: None,
        });
        #[cfg(target_os = "windows")]
        {
            let overlay = success.then(success_overlay_icon);
            let _ = window.set_overlay_icon(overlay);
        }
    }
}

#[cfg(target_os = "windows")]
fn success_overlay_icon() -> tauri::image::Image<'static> {
    // A tiny green circle with a white check is rendered in RGBA so the
    // overlay works without adding an image decoding feature or a second
    // bundled asset. Windows scales the 16x16 image for the taskbar itself.
    const SIZE: usize = 16;
    let mut pixels = vec![0_u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as i32 - 7;
            let dy = y as i32 - 7;
            let in_circle = dx * dx + dy * dy <= 49;
            let check = (y == 10 && (x == 4 || x == 5))
                || (y == 9 && x == 6)
                || (y == 8 && x == 7)
                || (y == 7 && x == 8)
                || (y == 6 && x == 9)
                || (y == 5 && x == 10)
                || (y == 4 && x == 11);
            if in_circle || check {
                let at = (y * SIZE + x) * 4;
                if check {
                    pixels[at..at + 4].copy_from_slice(&[255, 255, 255, 255]);
                } else {
                    pixels[at..at + 4].copy_from_slice(&[46, 204, 113, 255]);
                }
            }
        }
    }
    tauri::image::Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

struct WorkActivity {
    app: tauri::AppHandle,
    completed: bool,
}

impl WorkActivity {
    fn new(app: &tauri::AppHandle) -> Self {
        if ACTIVE_WORK.fetch_add(1, Ordering::SeqCst) == 0 {
            #[cfg(desktop)]
            set_taskbar_running(app);
        }
        Self {
            app: app.clone(),
            completed: false,
        }
    }

    fn finish(&mut self, completed: bool) {
        self.completed = completed;
    }
}

impl Drop for WorkActivity {
    fn drop(&mut self) {
        let previous = ACTIVE_WORK.fetch_sub(1, Ordering::SeqCst);
        if previous <= 1 {
            #[cfg(desktop)]
            set_taskbar_terminal(&self.app, self.completed);
        }
    }
}

#[tauri::command]
async fn codex_send(
    app: tauri::AppHandle,
    mut request: codex::CodexRequest,
) -> Result<codex::CodexResponse, String> {
    let mut activity = WorkActivity::new(&app);
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
    activity.finish(result.is_ok());
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
    request: agent::AgentTurnRequest,
) -> Result<agent::AgentResponse, String> {
    run_agent_turn_inner(app, request, true).await
}

/// `claims_project` is false for a chain stage: the chain took the project for
/// the whole run, and a stage asking for it again would be told, correctly,
/// that the project is busy — by itself.
async fn run_agent_turn_inner(
    app: tauri::AppHandle,
    request: agent::AgentTurnRequest,
    claims_project: bool,
) -> Result<agent::AgentResponse, String> {
    let mut activity = WorkActivity::new(&app);
    let result = run_agent_turn_inner_impl(app, request, claims_project).await;
    activity.finish(result.is_ok());
    result
}

async fn run_agent_turn_inner_impl(
    app: tauri::AppHandle,
    mut request: agent::AgentTurnRequest,
    claims_project: bool,
) -> Result<agent::AgentResponse, String> {
    let request_id = request.request_id.clone().unwrap_or_else(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        format!("agent-request-{stamp}")
    });
    request.request_id = Some(request_id.clone());
    // Held for the whole turn and released by its guard on every exit path,
    // including the error ones.
    let _claim = if claims_project {
        claim_project(request.cwd.as_deref(), &request_id)?
    } else {
        None
    };
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
        .map_err(|error| format!("Az agent háttérfeladat leállt: {error}"))?;
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
    } else if matches!(
        request.provider,
        agent::AgentProvider::Anthropic
            | agent::AgentProvider::Kimi
            | agent::AgentProvider::DeepSeek
    ) && request.runtime == request.provider.default_runtime()
    {
        let request_for_worker = request.clone();
        let cancellation = claude::begin_request(&request_id)?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            claude::send(app, request_for_worker, cancellation)
        })
        .await
        .map_err(|error| {
            format!(
                "A {} agent háttérfeladata leállt: {error}",
                request.provider.display_name()
            )
        })?;
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

/// Runs the user asked to stop. A chain is cancelled between stages, so this is
/// a small set that empties itself when the run finishes.
fn cancelled_pipeline_runs() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static RUNS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// The runs this process is driving right now. The store is reloaded while a
/// chain is in flight, and the interrupted-run recovery must be able to tell
/// "nobody is driving this" from "it is running in the next room".
fn live_pipeline_runs() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static RUNS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Which project each running turn has claimed, keyed by canonical path.
///
/// Two turns in two different projects are independent — separate processes,
/// separate cancellation, separate stores — and the app is meant to let you
/// work in one while the other thinks. Two turns in the *same* project are
/// not: they would both take a workspace snapshot of the same tree, and the
/// second one's "before" would contain the first one's half-finished edits.
/// Whichever finished last would then hand back a rollback point that never
/// existed. This is the guarantee, not the frontend's disabled button.
fn live_project_locks(
) -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, ProjectLockState>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, ProjectLockState>>,
    > = std::sync::OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A foglalás felszabadulására várók ébresztője.
fn project_lock_released() -> &'static std::sync::Condvar {
    static RELEASED: std::sync::OnceLock<std::sync::Condvar> = std::sync::OnceLock::new();
    RELEASED.get_or_init(std::sync::Condvar::new)
}

/// Egy projektet foglaló turn állapota.
///
/// A `draining` az a különbség, ami miatt a megállított kör után nem hibaüzenet
/// jön: a megszakított turn már nem dolgozik, csak a lezárása fut (a
/// munkaterület visszaállítása, ami nagy fán tíz másodperceket is elvisz).
/// Arra érdemes várni. Egy *élő* turnra nem: az percekig futhat, és a csendben
/// várakozó második kérés rosszabb, mint egy világos mondat.
struct ProjectLockState {
    request_id: String,
    draining: bool,
}

/// Egy megszakított kör lezárására ennyit érdemes várni; utána a hiba
/// megnevezi, mi tart.
const PROJECT_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A megszakított turn foglalását lezárás alattira állítja.
///
/// Innentől a következő kérés megvárja a felszabadulást ahelyett, hogy
/// elutasításra kerülne. A stop után azonnal küldött prompt eddig pontosan
/// ezen hasalt el — a felhasználó szemszögéből ok nélkül.
fn mark_project_draining(request_id: &str) {
    if let Ok(mut locks) = live_project_locks().lock() {
        for state in locks.values_mut() {
            if state.request_id == request_id {
                state.draining = true;
            }
        }
    }
    project_lock_released().notify_all();
}

/// Claims a project for one turn. Returns the guard that frees it again.
///
/// A turn with no project (the general mode) claims nothing: there is no tree
/// to protect, and two of those may run side by side.
fn claim_project(cwd: Option<&str>, request_id: &str) -> Result<Option<ProjectClaim>, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let root = codex::requested_agent_cwd(Some(cwd))?;
    claim_project_root(root, request_id).map(Some)
}

/// A foglalás döntése, a már feloldott projektgyökérrel.
///
/// Külön a `claim_project`-től, mert az útvonal-ellenőrzés a beállított
/// projektgyökérhez köti a hívást — a döntés maga viszont enélkül is
/// megvizsgálható.
fn claim_project_root(
    root: std::path::PathBuf,
    request_id: &str,
) -> Result<ProjectClaim, String> {
    let mut locks = live_project_locks()
        .lock()
        .map_err(|_| "A projektzár állapota zárolva maradt.".to_string())?;
    if let Some(state) = locks.get(&root) {
        if !state.draining {
            return Err(
                "Ebben a projektben már fut egy kérés. Várd meg, vagy állítsd le, mielőtt újat indítasz."
                    .to_string(),
            );
        }
        // A megállított kör lezárása véges: megvárjuk, nem utasítjuk el.
        let (guard, timeout) = project_lock_released()
            .wait_timeout_while(locks, PROJECT_DRAIN_TIMEOUT, |locks| {
                locks.contains_key(&root)
            })
            .map_err(|_| "A projektzár állapota zárolva maradt.".to_string())?;
        if timeout.timed_out() {
            return Err(
                "A leállított kérés lezárása még tart ebben a projektben. Próbáld újra."
                    .to_string(),
            );
        }
        locks = guard;
    }
    locks.insert(
        root.clone(),
        ProjectLockState {
            request_id: request_id.to_string(),
            draining: false,
        },
    );
    Ok(ProjectClaim { root })
}

/// A terv-szakasz kimenetének kiírása a projekt alá.
///
/// Csak relatív, `..`-mentes utat fogad: a fájl a munkaterületen belül marad,
/// bárhonnan is jött a kérés.
fn write_plan_file(cwd: &str, plan_file: &str, text: &str) -> Result<(), String> {
    let relative = std::path::Path::new(plan_file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!("A terv-fájl útvonala nem megengedett: {plan_file}"));
    }
    let target = std::path::Path::new(cwd).join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("A tervek mappája nem hozható létre: {error}"))?;
    }
    std::fs::write(&target, text)
        .map_err(|error| format!("A terv-fájl nem írható: {error}"))
}

/// Hozzáír a terv-fájl végéhez, létrehozza, ha még nincs.
///
/// Egy kérdés = egy fájl: a terv után a bíráló kifogása kerül oda, egy újabb
/// körnél pedig annak a feladata és bírálata is. Ez napló — a modellek
/// továbbra is a promptból dolgoznak —, a haszna a gitben olvasható előzmény.
fn append_plan_file(cwd: &str, plan_file: &str, text: &str) -> Result<(), String> {
    use std::io::Write;
    let relative = std::path::Path::new(plan_file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!("A terv-fájl útvonala nem megengedett: {plan_file}"));
    }
    let target = std::path::Path::new(cwd).join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("A tervek mappája nem hozható létre: {error}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|error| format!("A terv-fájl nem nyitható hozzáírásra: {error}"))?;
    file.write_all(text.as_bytes())
        .map_err(|error| format!("A terv-fájl nem írható: {error}"))
}

/// A lezárult kör naplóbejegyzése: mit kért a bíráló, és mire jutott ez a kör.
fn plan_journal_entry(
    iteration: i64,
    retry_feedback: Option<&str>,
    stages: &[pipeline::PipelineStageResult],
) -> String {
    plan_journal_entry_with_comments(iteration, retry_feedback, None, stages)
}

fn plan_journal_entry_with_comments(
    iteration: i64,
    retry_feedback: Option<&str>,
    user_comments: Option<&str>,
    stages: &[pipeline::PipelineStageResult],
) -> String {
    let mut journal = String::new();
    // Az első kör feladata maga a terv, ami már a fájlban van; egy újabb körnek
    // viszont a kifogás a feladata, és csak itt marad meg írásban.
    if iteration > 1 {
        if let Some(feedback) = retry_feedback
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            journal.push_str(&format!("\n\n## v{iteration} feladat\n\n{feedback}\n"));
        }
        if let Some(comments) = user_comments
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            journal.push_str(&format!(
                "\n\n### v{iteration} felhasználói megjegyzés\n\n{comments}\n"
            ));
        }
    }
    if let Some(review) = stages
        .iter()
        .find(|stage| stage.role.is_review() && stage.succeeded)
    {
        let text = review.text.trim();
        if !text.is_empty() {
            let heading = if review.role == pipeline::StageRole::PlanReview {
                "tervbírálat"
            } else {
                "kódbírálat"
            };
            journal.push_str(&format!("\n\n## v{iteration} {heading}\n\n{text}\n"));
        }
    }
    journal
}

/// Frees the project when the turn ends, however it ends.
struct ProjectClaim {
    root: std::path::PathBuf,
}

impl Drop for ProjectClaim {
    fn drop(&mut self) {
        if let Ok(mut locks) = live_project_locks().lock() {
            locks.remove(&self.root);
        }
        project_lock_released().notify_all();
    }
}

fn live_pipeline_run_ids() -> Vec<String> {
    live_pipeline_runs()
        .lock()
        .map(|runs| runs.iter().cloned().collect())
        .unwrap_or_default()
}

fn pipeline_run_is_cancelled(run_id: &str) -> bool {
    cancelled_pipeline_runs()
        .lock()
        .map(|runs| runs.contains(run_id))
        .unwrap_or(false)
}

/// Every request id a running chain answers to, mapped to its run.
///
/// A chain is cancellable from the moment it is asked for, not from the moment
/// it first reports progress. The frontend allocates the ids before it calls
/// `pipeline_send` and knows nothing else about the run until a stage starts —
/// so stopping in the first seconds had nothing to name, and the run carried on
/// for as long as it liked. These ids are that name.
fn pipeline_runs_by_request() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, String>,
> {
    static RUNS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    RUNS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[derive(Debug, Clone)]
struct ActivePipelineStage {
    root_request_id: String,
    provider_request_id: String,
    provider: agent::AgentProvider,
    stage_index: i64,
    stage_role: String,
    stage_epoch: u64,
}

fn active_pipeline_stages() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, ActivePipelineStage>,
> {
    static STAGES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, ActivePipelineStage>>,
    > = std::sync::OnceLock::new();
    STAGES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn pipeline_run_inputs() -> &'static std::sync::Mutex<
    std::collections::HashMap<String, Vec<pipeline::PipelineRunInput>>,
> {
    static INPUTS: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<String, Vec<pipeline::PipelineRunInput>>,
        >,
    > = std::sync::OnceLock::new();
    INPUTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn record_accepted_pipeline_input(request: &agent::AgentSteerRequest) {
    let Some(run_id) = request.pipeline_run_id.as_deref() else {
        return;
    };
    let entry = pipeline::PipelineRunInput {
        input_id: request.input_id.clone(),
        accepted_at_stage: request.stage_index.unwrap_or_default(),
        accepted_at_role: request.stage_role.clone().unwrap_or_default(),
        text: request.text.clone(),
        accepted_at: agent::now_timestamp(),
        carried: false,
    };
    if let Ok(mut inputs) = pipeline_run_inputs().lock() {
        let journal = inputs.entry(run_id.to_string()).or_default();
        if !journal.iter().any(|item| item.input_id == entry.input_id) {
            journal.push(entry);
        }
    }
}

fn prompt_with_pipeline_inputs(
    run_id: &str,
    stage_index: usize,
    prompt: String,
) -> String {
    let entries = pipeline_run_inputs()
        .lock()
        .ok()
        .and_then(|inputs| inputs.get(run_id).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.carried || entry.accepted_at_stage < stage_index as i64)
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return prompt;
    }
    let instructions = entries
        .iter()
        .map(|entry| format!("- {}", entry.text.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{prompt}\n\n[A FUTÁS KÖZBEN HOZZÁADOTT FELHASZNÁLÓI UTASÍTÁSOK]\n{instructions}"
    )
}

fn set_active_pipeline_stage(run_id: &str, stage: ActivePipelineStage) {
    if let Ok(mut stages) = active_pipeline_stages().lock() {
        stages.insert(run_id.to_string(), stage);
    }
}

fn clear_active_pipeline_stage(run_id: &str, provider_request_id: &str) {
    if let Ok(mut stages) = active_pipeline_stages().lock() {
        if stages
            .get(run_id)
            .is_some_and(|stage| stage.provider_request_id == provider_request_id)
        {
            stages.remove(run_id);
        }
    }
}

fn validate_pipeline_steer_target(
    request: &agent::AgentSteerRequest,
) -> Result<(), agent::AgentSteerError> {
    use agent::{AgentInputErrorCode, AgentSteerError};
    let pipeline_run_id = request.pipeline_run_id.as_deref();
    if pipeline_run_id.is_none() {
        if pipeline_run_for_request(&request.provider_request_id).is_some() {
            return Err(AgentSteerError::new(
                AgentInputErrorCode::TargetChanged,
                "A célzott kérés közben pipeline-szakasszá vált.",
            ));
        }
        return Ok(());
    }
    let run_id = pipeline_run_id.unwrap_or_default();
    let stages = active_pipeline_stages().lock().map_err(|_| {
        AgentSteerError::new(
            AgentInputErrorCode::RuntimeFailed,
            "A pipeline célállapota zárolva maradt.",
        )
    })?;
    let active = stages.get(run_id).ok_or_else(|| {
        AgentSteerError::new(
            AgentInputErrorCode::TargetChanged,
            "A célzott pipeline-fázis már nem aktív.",
        )
    })?;
    if active.root_request_id != request.root_request_id
        || active.provider_request_id != request.provider_request_id
        || active.provider != request.provider
        || Some(active.stage_index) != request.stage_index
        || request.stage_role.as_deref() != Some(active.stage_role.as_str())
        || active.stage_epoch != request.expected_stage_epoch
    {
        return Err(AgentSteerError::new(
            AgentInputErrorCode::TargetChanged,
            "A pipeline közben másik fázisra váltott.",
        ));
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn agent_steer(
    app: tauri::AppHandle,
    request: agent::AgentSteerRequest,
) -> Result<agent::AgentSteerQueued, agent::AgentSteerError> {
    let result = validate_pipeline_steer_target(&request).and_then(|_| match request.provider {
        agent::AgentProvider::Codex => codex::steer(&app, request.clone()),
        agent::AgentProvider::Anthropic
        | agent::AgentProvider::Kimi
        | agent::AgentProvider::DeepSeek => claude::steer(&app, request.clone()),
    });
    if let Err(error) = &result {
        let _ = codex::emit_main_window(
            &app,
            "agent-input-status",
            &agent::AgentInputStatusEvent::rejected(
                &request,
                error.code,
                error.message.clone(),
            ),
        );
    }
    result
}

fn register_pipeline_request_ids(run_id: &str, request_ids: &[String]) {
    if let Ok(mut runs) = pipeline_runs_by_request().lock() {
        for request_id in request_ids {
            runs.insert(request_id.clone(), run_id.to_string());
        }
    }
}

fn forget_pipeline_request_ids(run_id: &str) {
    if let Ok(mut runs) = pipeline_runs_by_request().lock() {
        runs.retain(|_, value| value != run_id);
    }
}

/// Frees a run's request ids however the run ends.
struct PipelineRequestIds {
    run_id: String,
}

impl Drop for PipelineRequestIds {
    fn drop(&mut self) {
        forget_pipeline_request_ids(&self.run_id);
    }
}

fn pipeline_run_for_request(request_id: &str) -> Option<String> {
    pipeline_runs_by_request()
        .lock()
        .ok()
        .and_then(|runs| runs.get(request_id).cloned())
}

#[tauri::command(rename_all = "camelCase")]
fn pipeline_cancel(run_id: String) -> Result<(), String> {
    cancel_pipeline_run(&run_id)
}

/// Stops a chain named by any of its request ids.
///
/// Marks the run so no further stage starts, and tells whichever runtime is
/// mid-stage to stop now — a stage that has already been handed to a provider
/// is not torn out by a flag, and eight minutes of coding is a long time to
/// watch something you have already stopped.
#[tauri::command(rename_all = "camelCase")]
fn pipeline_cancel_request(request_id: String) -> Result<bool, String> {
    mark_project_draining(&request_id);
    let Some(run_id) = pipeline_run_for_request(&request_id) else {
        return Ok(false);
    };
    cancel_pipeline_run(&run_id)?;
    Ok(true)
}

fn cancel_pipeline_run(run_id: &str) -> Result<(), String> {
    cancelled_pipeline_runs()
        .lock()
        .map_err(|_| "A lánc megszakítási állapota zárolva maradt.".to_string())?
        .insert(run_id.to_string());
    // Whatever stage is in flight belongs to this run; cancelling a request no
    // runtime owns is a no-op, so this needs no bookkeeping of its own.
    let request_ids: Vec<String> = pipeline_runs_by_request()
        .lock()
        .map(|runs| {
            runs.iter()
                .filter(|(_, value)| value.as_str() == run_id)
                .map(|(key, _)| key.clone())
                .collect()
        })
        .unwrap_or_default();
    for request_id in request_ids {
        let _ = claude::cancel_request(&request_id);
        let _ = codex::cancel_request(&request_id);
    }
    Ok(())
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
    // A resumed chain still allocates an id per stage, so the ids stay indexed
    // by stage and the skipped ones simply go unused.
    let start_stage = request.start_stage.unwrap_or(0);
    if start_stage >= recipe.stages.len() {
        return Err(format!(
            "A(z) {start_stage}. szakasztól nincs mit futtatni: a recept {} szakaszból áll.",
            recipe.stages.len()
        ));
    }
    let iteration = request.iteration.unwrap_or(1).max(1);
    if iteration > pipeline::MAX_CHAIN_ITERATIONS {
        return Err(format!(
            "Egy kérdés legfeljebb {} kört futhat; a v{iteration} már nem indul.",
            pipeline::MAX_CHAIN_ITERATIONS
        ));
    }

    let mut activity = WorkActivity::new(&app);

    // The chain holds the project for its whole length, not stage by stage:
    // between two stages the tree is mid-work, and a turn starting there would
    // snapshot the coder's unfinished state as its own "before".
    let _claim = claim_project(
        request.cwd.as_deref(),
        request.request_ids.first().map_or("chain", String::as_str),
    )?;
    let run_id = store::begin_pipeline_run(&request.conversation_id, &recipe)?;
    if let Ok(mut inputs) = pipeline_run_inputs().lock() {
        inputs.insert(
            run_id.clone(),
            request
                .run_inputs
                .iter()
                .cloned()
                .map(|mut input| {
                    input.carried = true;
                    input
                })
                .collect(),
        );
    }
    // Registered before the first stage starts, so a stop pressed in the first
    // second has something to name. Includes the placeholder the frontend is
    // still showing as the active request at that point.
    let mut cancellable_ids = request.request_ids.clone();
    if let Some(placeholder) = request.placeholder_request_id.clone() {
        cancellable_ids.push(placeholder);
    }
    register_pipeline_request_ids(&run_id, &cancellable_ids);
    let _request_id_guard = PipelineRequestIds {
        run_id: run_id.clone(),
    };
    // The first run *is* the chain; every later one names the chain it belongs
    // to, which is what puts the iterations in one panel.
    let chain_id = request
        .chain_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&run_id)
        .to_string();
    if let Ok(mut runs) = live_pipeline_runs().lock() {
        runs.insert(run_id.clone());
    }
    // One snapshot for the whole chain. Each stage used to restore the tree at
    // the end of its own turn, which meant the reviewer looked at a workspace
    // the coder's work had just been rolled back out of -- it reported the fix
    // missing every single time, correctly and uselessly. The stages now leave
    // the tree alone and this snapshot does the restoring once, so the user
    // still decides afterwards whether to apply the chain's work.
    let run_guard = match request.cwd.as_deref() {
        Some(cwd) if !cwd.trim().is_empty() => Some(codex::begin_agent_workspace_snapshot(
            std::path::Path::new(cwd),
        )?),
        _ => None,
    };
    let stage_count = recipe.stages.len() as i64;
    // Everything with a side effect lives in this closure; `run_stages` owns the
    // chain logic itself and is tested without any of this.
    let outcome = {
        let app = app.clone();
        let request = &request;
        let run_id = run_id.clone();
        let cancel_run_id = run_id.clone();
        let chain_id = chain_id.clone();
        let recipe_id = recipe.id.clone();
        pipeline::run_stages_from(
            &recipe,
            &request.prompt,
            pipeline::RunStart {
                initial_session: request.session_id.clone(),
                user_comments: request.user_comments.clone(),
                start_index: start_stage,
                seed_artifacts: request
                    .seed_artifacts
                    .iter()
                    .cloned()
                    .map(Into::into)
                    .collect(),
                feedback: request.retry_feedback.clone(),
            },
            move || pipeline_run_is_cancelled(&cancel_run_id),
            move |execution| {
                let app = app.clone();
                let run_id = run_id.clone();
                let chain_id = chain_id.clone();
                let recipe_id = recipe_id.clone();
                let request_id = request.request_ids[execution.index].clone();
                let root_request_id = request
                    .placeholder_request_id
                    .clone()
                    .unwrap_or_else(|| request.request_ids[0].clone());
                let agent_label = pipeline::stage_agent_label(&execution.stage);
                async move {
                    let stage_epoch = execution.index as u64 + 1;
                    let progress = |phase: &'static str, status: pipeline::RunStatus| {
                        pipeline::PipelineProgress {
                            run_id: run_id.clone(),
                            conversation_id: request.conversation_id.clone(),
                            stage_index: execution.index as i64,
                            stage_count,
                            role: execution.stage.role,
                            agent_label: agent_label.clone(),
                            provider: execution.stage.provider,
                            request_id: request_id.clone(),
                            stage_epoch,
                            phase,
                            status,
                        }
                    };
                    set_active_pipeline_stage(
                        &run_id,
                        ActivePipelineStage {
                            root_request_id: root_request_id.clone(),
                            provider_request_id: request_id.clone(),
                            provider: execution.stage.provider,
                            stage_index: execution.index as i64,
                            stage_role: execution.stage.role.as_wire().to_string(),
                            stage_epoch,
                        },
                    );
                    let _ = codex::emit_main_window(
                        &app,
                        "pipeline-progress",
                        &progress("started", pipeline::RunStatus::Running),
                    );
                    if let Err(error) =
                        store::update_pipeline_run_stage(&run_id, execution.index as i64)
                    {
                        clear_active_pipeline_stage(&run_id, &request_id);
                        return Err(error);
                    }
                    let turn = agent::AgentTurnRequest {
                        prompt: prompt_with_pipeline_inputs(
                            &run_id,
                            execution.index,
                            execution.prompt,
                        ),
                        images: if execution.is_first {
                            request.images.clone()
                        } else {
                            Vec::new()
                        },
                        provider: execution.stage.provider,
                        runtime: execution.stage.runtime,
                        access_profile: execution.stage.access_profile,
                        conversation_id: Some(request.conversation_id.clone()),
                        session_id: execution.session_id,
                        conversation_context: if execution.is_first {
                            request.conversation_context.clone()
                        } else {
                            None
                        },
                        model: execution.stage.model.clone(),
                        effort: execution.stage.effort.clone(),
                        cwd: request.cwd.clone(),
                        request_id: Some(request_id.clone()),
                        replace_message_id: None,
                        replace_turn_id: None,
                        max_budget_usd: request.max_budget_usd,
                        max_turns: execution.stage.max_turns,
                        tool_profile: Some(execution.stage.role.tool_profile()),
                        keep_workspace: true,
                    };
                    let result = run_agent_turn_inner(app.clone(), turn, false).await;
                    clear_active_pipeline_stage(&run_id, &request_id);
                    let phase = if result.is_ok() { "finished" } else { "failed" };
                    let _ = codex::emit_main_window(
                        &app,
                        "pipeline-progress",
                        &progress(
                            phase,
                            if result.is_ok() {
                                pipeline::RunStatus::Running
                            } else {
                                pipeline::RunStatus::Failed
                            },
                        ),
                    );
                    let response = result?;
                    // A terv fájlként is megmarad: a projekt része, gitelhető,
                    // és a diffben is látszik. A tervező modell read-only —
                    // a fájlt itt, a futtató írja ki, a szakasz végén, egyben.
                    // A hiba nem-fatális: a lánc nem halhat bele abba, hogy a
                    // tervek mappája épp nem írható.
                    if execution.stage.role == pipeline::StageRole::Plan {
                        if let (Some(cwd), Some(plan_file)) =
                            (request.cwd.as_deref(), request.plan_file.as_deref())
                        {
                            if let Err(error) =
                                write_plan_file(cwd, plan_file, &response.text)
                            {
                                let _ = codex::emit_main_window(
                                    &app,
                                    "codex-transport",
                                    &serde_json::json!({
                                        "requestId": request_id,
                                        "stage": "plan-file-error",
                                        "detail": error,
                                        "threadId": null,
                                    }),
                                );
                            }
                        }
                    }
                    // Ne csak a teljes lánc végén kerüljön a fázis a
                    // v1/v2 panelhez. A következő fázis kérhet felhasználói
                    // választ, vagy az app bezárható/megszakadhat; ilyenkor az
                    // addig elkészült válaszoknak újraindítás után is a
                    // közös run panelben kell maradniuk. A lánc végi kör
                    // később ugyanazt a metaadatot a review verdikttel frissíti.
                    let _ = store::label_pipeline_stage_answer(
                        &request.conversation_id,
                        &request_id,
                        &store::LocalMessagePipeline {
                            run_id: run_id.clone(),
                            recipe_id: Some(recipe_id.clone()),
                            chain_id: chain_id.clone(),
                            iteration,
                            stage_index: execution.index as i64,
                            stage_count,
                            stage_role: execution.stage.role.as_wire().to_string(),
                            stage_agent: agent_label.clone(),
                            verdict: None,
                            verdict_summary: None,
                        },
                    );
                    let mut changed_files = response.guard.changed_files.clone();
                    changed_files.extend(response.guard.added_files.iter().cloned());
                    changed_files.extend(response.guard.removed_files.iter().cloned());
                    changed_files.sort();
                    changed_files.dedup();
                    Ok(pipeline::StageOutcome {
                        text: response.text,
                        session_id: response.session_id,
                        changed_files,
                    })
                }
            },
        )
        .await
    };

    // A fázis alapjelvénye már közvetlenül a válasza után tartósan elment.
    // Itt felülírjuk ugyanazt a metaadatot a már ismert review verdikttel.
    let mut stages = Vec::<pipeline::PipelineStageResult>::new();
    for stage_result in &outcome.stages {
        let stage = &recipe.stages[stage_result.index];
        let agent_label = pipeline::stage_agent_label(stage);
        // Deterministic: the frontend allocated one id per stage in order.
        let request_id = request.request_ids[stage_result.index].clone();
        let answer_message_id = if stage_result.succeeded {
            store::label_pipeline_stage_answer(
                &request.conversation_id,
                &request_id,
                &store::LocalMessagePipeline {
                    run_id: run_id.clone(),
                    recipe_id: Some(recipe.id.clone()),
                    chain_id: chain_id.clone(),
                    iteration,
                    stage_index: stage_result.index as i64,
                    stage_count,
                    stage_role: stage.role.as_wire().to_string(),
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
            )
            .ok()
            .flatten()
        } else {
            None
        };
        stages.push(pipeline::PipelineStageResult {
            index: stage_result.index as i64,
            role: stage_result.role,
            agent_label,
            request_id,
            succeeded: stage_result.succeeded,
            text: stage_result.text.clone(),
            error: stage_result.error.clone(),
            review: stage_result.review.clone(),
            session_id: stage_result.session_id.clone(),
            answer_message_id,
        });
    }
    let status = outcome.status;
    let run_error = outcome.error;

    // A kör lefolyása a terv mellé, ugyanabba a fájlba: a bírálat (és egy újabb
    // körnél az azt kiváltó kifogás) a terv szövege után olvasható. A hiba nem
    // fatális, ahogy a terv kiírásánál sem: a lánc nem halhat bele abba, hogy a
    // tervek mappája épp nem írható.
    if let (Some(cwd), Some(plan_file)) =
        (request.cwd.as_deref(), request.plan_file.as_deref())
    {
        let journal = plan_journal_entry_with_comments(
            iteration,
            request.retry_feedback.as_deref(),
            request.user_comments.as_deref(),
            &stages,
        );
        if !journal.is_empty() {
            if let Err(error) = append_plan_file(cwd, plan_file, &journal) {
                let _ = codex::emit_main_window(
                    &app,
                    "codex-transport",
                    &serde_json::json!({
                        "requestId": request.request_ids.first(),
                        "stage": "plan-file-error",
                        "detail": error,
                        "threadId": null,
                    }),
                );
            }
        }
    }

    if let Some(placeholder) = request.placeholder_request_id.as_deref() {
        let _ = store::forget_pipeline_placeholder_answer(&request.conversation_id, placeholder);
    }
    if let Ok(mut runs) = cancelled_pipeline_runs().lock() {
        runs.remove(&run_id);
    }
    if let Ok(mut runs) = live_pipeline_runs().lock() {
        runs.remove(&run_id);
    }
    let accepted_run_inputs = pipeline_run_inputs()
        .lock()
        .ok()
        .and_then(|mut inputs| inputs.remove(&run_id))
        .unwrap_or_default();
    // Whatever the chain wrote is now staged and the tree is back at its base,
    // exactly as a single turn leaves it. The staged report goes back to the
    // frontend, which applies it the same way it applies a single turn's —
    // without that hand-off the chain's edits stay parked in the snapshot
    // directory while the tree sits at base. A failure here is worth saying
    // out loud: it means the workspace still holds the chain's edits.
    let (chain_guard, guard_error) = match run_guard {
        Some(snapshot) => match codex::finalize_agent_workspace_snapshot(&snapshot)
            .and_then(|report| codex::stage_agent_workspace_snapshot(&snapshot, report))
        {
            Ok(mut report) => {
                report.isolation_mode = "nonGitSnapshot".to_string();
                (Some(report), None)
            }
            Err(error) => (
                None,
                Some(format!(
                    "A lánc változásainak elkülönítése nem sikerült: {error}"
                )),
            ),
        },
        None => (None, None),
    };
    let run_error = match (run_error, guard_error) {
        (Some(existing), Some(guard)) => Some(format!("{existing} {guard}")),
        (Some(existing), None) => Some(existing),
        (None, guard) => guard,
    };
    store::finish_pipeline_run(&run_id, status.as_wire(), run_error.as_deref())?;
    if let (Some(cwd), Some(plan_file)) =
        (request.cwd.as_deref(), request.plan_file.as_deref())
    {
        if !accepted_run_inputs.is_empty() {
            let body = accepted_run_inputs
                .iter()
                .map(|entry| {
                    format!(
                        "- [{} · {}] {}",
                        entry.accepted_at_role,
                        entry.accepted_at,
                        entry.text.trim()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let _ = append_plan_file(
                cwd,
                plan_file,
                &format!(
                    "\n\n## Futás közben hozzáadott felhasználói utasítások\n\n{body}\n"
                ),
            );
        }
    }
    activity.finish(status == pipeline::RunStatus::Completed);
    Ok(pipeline::PipelineRunResult {
        run_id,
        chain_id,
        iteration,
        recipe,
        status,
        stages,
        guard: chain_guard,
        error: run_error,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn agent_conversation_status(
    conversation_id: String,
) -> Result<Option<store::AgentConversationStatus>, String> {
    store::agent_conversation_status(&conversation_id)
}

/// The chain deletes this row when it finishes, but the frontend may still
/// flush a save that was queued while the outer bubble was on screen. The
/// frontend calls this once its own state has settled.
#[tauri::command(rename_all = "camelCase")]
fn pipeline_forget_placeholder(conversation_id: String, request_id: String) -> Result<(), String> {
    store::forget_pipeline_placeholder_answer(&conversation_id, &request_id).map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
fn agent_answer_checkpoint(
    conversation_id: String,
    request_id: String,
    text: String,
    replace_message_id: Option<String>,
    replace_turn_id: Option<String>,
) -> Result<(), String> {
    store::record_agent_answer_text_replacing(
        &conversation_id,
        &request_id,
        &text,
        replace_message_id.as_deref(),
        replace_turn_id.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
fn agent_cancel(provider: Option<agent::AgentProvider>, request_id: String) -> Result<(), String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => codex::cancel_request(&request_id),
        agent::AgentProvider::Anthropic
        | agent::AgentProvider::Kimi
        | agent::AgentProvider::DeepSeek => {
            mark_project_draining(&request_id);
            claude::cancel_request(&request_id)
        }
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
        agent::AgentProvider::Anthropic
        | agent::AgentProvider::Kimi
        | agent::AgentProvider::DeepSeek => {
            claude::respond_approval(&approval_id, &decision, None)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_question_response(
    provider: Option<agent::AgentProvider>,
    question_id: String,
    answer: serde_json::Value,
) -> Result<(), String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => {
            Err("A Codex app-server ezen az útvonalon nem kér strukturált választ.".to_string())
        }
        agent::AgentProvider::Anthropic
        | agent::AgentProvider::Kimi
        | agent::AgentProvider::DeepSeek => claude::respond_question(&question_id, answer),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn claude_cancel(request_id: String) -> Result<(), String> {
    mark_project_draining(&request_id);
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
    access_profile: Option<agent::AgentAccessProfile>,
) -> Result<Vec<agent::AgentModelDescriptor>, String> {
    match provider.unwrap_or(agent::AgentProvider::Codex) {
        agent::AgentProvider::Codex => tauri::async_runtime::spawn_blocking(move || {
            codex::list_models(app).map(agent::codex_model_descriptors)
        })
        .await
        .map_err(|error| {
            format!("A provider modellkatalógus háttérfeladata leállt: {error}")
        })?,
        selected_provider => {
            let mut models = Vec::new();
            for runtime in agent::runtime_catalog().into_iter().filter(|runtime| {
                runtime.provider == selected_provider
                    && access_profile
                        .map(|profile| runtime.access_profile == Some(profile))
                        .unwrap_or(true)
            }) {
                for model in runtime.models {
                    if !models
                        .iter()
                        .any(|existing: &agent::AgentModelDescriptor| existing.id == model.id)
                    {
                        models.push(model);
                    }
                }
            }
            Ok(models)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
fn agent_auth_status(
    provider: Option<agent::AgentProvider>,
    access_profile: Option<agent::AgentAccessProfile>,
) -> Result<agent::AgentAuthStatus, String> {
    claude::provider_auth_status(
        provider.unwrap_or(agent::AgentProvider::Anthropic),
        access_profile,
    )
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_save_api_key(
    provider: agent::AgentProvider,
    access_profile: Option<agent::AgentAccessProfile>,
    api_key: String,
) -> Result<agent::AgentAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claude::save_provider_api_key(provider, access_profile, &api_key)
    })
    .await
    .map_err(|error| format!("Az API-kulcs mentési háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_delete_api_key(
    provider: agent::AgentProvider,
    access_profile: Option<agent::AgentAccessProfile>,
) -> Result<agent::AgentAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        claude::delete_provider_api_key(provider, access_profile)
    })
    .await
    .map_err(|error| format!("Az API-kulcs törlési háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn agent_test_connection(
    provider: Option<agent::AgentProvider>,
    access_profile: Option<agent::AgentAccessProfile>,
    model: Option<String>,
    effort: Option<String>,
    max_budget_usd: Option<f64>,
    max_turns: Option<u32>,
    cwd: Option<String>,
) -> Result<agent::AgentConnectionResult, String> {
    let provider = provider.unwrap_or(agent::AgentProvider::Anthropic);
    match provider {
        agent::AgentProvider::Anthropic
        | agent::AgentProvider::Kimi
        | agent::AgentProvider::DeepSeek => tauri::async_runtime::spawn_blocking(move || {
            claude::test_connection(
                provider,
                access_profile,
                model,
                effort,
                max_budget_usd,
                max_turns,
                cwd,
            )
            .map(|result| agent::from_claude_connection(provider, access_profile, result))
        })
        .await
        .map_err(|error| format!("A provider kapcsolat-teszt háttérfeladata leállt: {error}"))?,
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

/// What returning to an earlier prompt would cost, before it is done.
#[tauri::command(rename_all = "camelCase")]
async fn conversation_revert_preview(
    conversation_id: String,
    message_id: String,
) -> Result<store::RevertPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::preview_conversation_revert(&conversation_id, &message_id)
    })
    .await
    .map_err(|error| format!("A visszaállítás előnézetének háttérfeladata leállt: {error}"))?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub removed_messages: i64,
    pub restored_files: usize,
    pub removed_files: usize,
    /// The snapshot of the state this revert replaced, so it can be undone.
    pub undo_snapshot_id: Option<String>,
    pub session_id: Option<String>,
}

/// Returns the conversation and the workspace to an earlier prompt.
///
/// Files first, history second, and a snapshot of the present state before
/// either: if the restore fails the conversation is untouched, and if it
/// succeeds the discarded state is still on disk. A half-done revert — files
/// back but the history still describing them, or the reverse — would be worse
/// than not offering the button at all.
#[tauri::command(rename_all = "camelCase")]
async fn conversation_revert_to(
    conversation_id: String,
    message_id: String,
    cwd: Option<String>,
) -> Result<RevertResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let preview = store::preview_conversation_revert(&conversation_id, &message_id)?;
        let mut restored_files = 0;
        let mut removed_files = 0;
        let mut undo_snapshot_id = None;
        if let Some(snapshot_id) = preview.snapshot_id.as_deref() {
            let root = cwd
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "A fájlok visszaállításához a projekt útvonala kell.".to_string()
                })?;
            let root = codex::requested_agent_cwd(Some(root))?;
            undo_snapshot_id = Some(codex::snapshot_workspace_now(&root)?);
            let restored = codex::restore_workspace_to_snapshot_base(snapshot_id)?;
            restored_files = restored.restored_files;
            removed_files = restored.removed_files;
        }
        let (removed_messages, session_id) =
            store::truncate_conversation_after(&conversation_id, &message_id)?;
        Ok::<_, String>(RevertResult {
            removed_messages,
            restored_files,
            removed_files,
            undo_snapshot_id,
            session_id,
        })
    })
    .await
    .map_err(|error| format!("A visszaállítás háttérfeladata leállt: {error}"))?
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
    mark_project_draining(&request_id);
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
        .map_err(|error| format!("A fájl futtatási háttérfeladata leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn open_project_folder(cwd: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || codex::open_project_folder(&cwd, &path))
        .await
        .map_err(|error| format!("A mappanyitási háttérfeladata leállt: {error}"))?
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
        .map_err(|error| format!("A Claude API-kulcs mentési háttérfeladata leállt: {error}"))?
}

#[tauri::command]
async fn claude_delete_api_key() -> Result<claude::ClaudeAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(claude::delete_api_key)
        .await
        .map_err(|error| format!("A Claude API-kulcs törlési háttérfeladata leállt: {error}"))?
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
        claude::test_connection(
            agent::AgentProvider::Anthropic,
            Some(agent::AgentAccessProfile::Claude),
            model,
            effort,
            max_budget_usd,
            max_turns,
            cwd,
        )
    })
    .await
    .map_err(|error| format!("A Claude kapcsolat-teszt háttérfeladata leállt: {error}"))?
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
        // Only the first load of a process can honestly find a run "interrupted
        // by a restart": every later load happens while this process is running
        // chains of its own. The store is reloaded whenever a sync pull lands,
        // and one of those landed 80 seconds into a live chain and declared it
        // dead. The live-run list below stays as a second line of defence.
        static RECOVERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !RECOVERED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let _ = store::recover_interrupted_pipeline_runs(&live_pipeline_run_ids());
        }
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
    .map_err(|error| format!("A lokális snapshot betöltése leállt: {error}"))?
}

#[tauri::command]
async fn local_store_save(
    snapshot: store::LocalStoreSnapshot,
) -> Result<store::LocalStoreSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || store::save_snapshot(snapshot))
        .await
        .map_err(|error| format!("A lokális snapshot mentése leállt: {error}"))?
}

#[tauri::command]
async fn pending_followups_list() -> Result<Vec<store::PendingFollowUp>, String> {
    tauri::async_runtime::spawn_blocking(store::list_pending_followups)
        .await
        .map_err(|error| format!("A follow-up queue betöltése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn pending_followup_upsert(
    follow_up: store::PendingFollowUp,
) -> Result<store::PendingFollowUp, String> {
    tauri::async_runtime::spawn_blocking(move || store::upsert_pending_followup(follow_up))
        .await
        .map_err(|error| format!("A follow-up mentése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn pending_followups_reorder(
    conversation_id: String,
    ids: Vec<String>,
) -> Result<Vec<store::PendingFollowUp>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        store::reorder_pending_followups(&conversation_id, ids)
    })
    .await
    .map_err(|error| format!("A follow-up átrendezése leállt: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
async fn pending_followup_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || store::delete_pending_followup(&id))
        .await
        .map_err(|error| format!("A follow-up törlése leállt: {error}"))?
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

#[tauri::command]
async fn sync_v2_permanently_delete_entity(
    tombstone: store::LocalTombstone,
) -> Result<sync::SyncV2Result, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sync::sync_v2_permanently_delete_entity(tombstone)
    })
    .await
    .map_err(|error| format!("A v2 végleges törlés háttérfeladata leállt: {error}"))?
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

    let builder = builder.setup(|app| {
        #[cfg(desktop)]
        if let Some(window) = app.get_webview_window("main") {
            let event_window = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if active_work_count() > 0 {
                        api.prevent_close();
                        let _ = event_window.emit(
                            "app-close-blocked",
                            serde_json::json!({
                                "message": "A futás még folyamatban van. Várd meg a végét vagy állítsd le, mielőtt bezárod az alkalmazást."
                            }),
                        );
                    }
                }
            });
            #[cfg(desktop)]
            set_taskbar_terminal(app.handle(), false);
        }
        Ok(())
    });

    builder
        .invoke_handler(tauri::generate_handler![
            codex_send,
            agent_send,
            pipeline_recipes,
            pipeline_send,
            pipeline_cancel,
            pipeline_cancel_request,
            pipeline_forget_placeholder,
            agent_conversation_status,
            agent_answer_checkpoint,
            agent_steer,
            agent_cancel,
            agent_approval_response,
            agent_question_response,
            claude_cancel,
            claude_approval_response,
            claude_question_response,
            agent_models,
            agent_auth_status,
            agent_save_api_key,
            agent_delete_api_key,
            agent_test_connection,
            agent_shutdown,
            codex_rollback_snapshot,
            codex_apply_snapshot,
            codex_discard_snapshot,
            codex_preview_snapshot,
            codex_rebase_snapshot,
            agent_rollback_snapshot,
            conversation_revert_preview,
            conversation_revert_to,
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
            pending_followups_list,
            pending_followup_upsert,
            pending_followups_reorder,
            pending_followup_delete,
            sync_v2_pull,
            sync_v2_rebuild_from_local,
            sync_v2_publish_snapshot,
            sync_v2_preview_restore_entity,
            sync_v2_retention_preview,
            sync_v2_retention_ack,
            sync_v2_retention_backup,
            sync_v2_retention_purge,
            sync_v2_retention_purge_selected,
            sync_v2_restore_entity,
            sync_v2_permanently_delete_entity
        ])
        .run(tauri::generate_context!())
        .expect("error while running min");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A terv-fájl a munkaterületen belül marad — kifelé mutató út nem írható.
    #[test]
    fn a_plan_file_stays_inside_the_workspace() {
        let root = std::env::temp_dir().join(format!("min-plan-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("plan file fixture");
        let cwd = root.to_string_lossy().to_string();

        write_plan_file(&cwd, "tervek/2026-07-29-smith-v1.md", "## Terv")
            .expect("relative plan file writes");
        assert_eq!(
            std::fs::read_to_string(root.join("tervek/2026-07-29-smith-v1.md"))
                .expect("plan file readable"),
            "## Terv"
        );

        assert!(write_plan_file(&cwd, "../kifele.md", "x").is_err());
        assert!(write_plan_file(&cwd, "C:/abszolut.md", "x").is_err());

        // A kör naplója ugyanannak a fájlnak a végére kerül, nem egy másolatba.
        append_plan_file(&cwd, "tervek/2026-07-29-smith-v1.md", "\n\n## v1 bírálat\n")
            .expect("relative plan file appends");
        assert_eq!(
            std::fs::read_to_string(root.join("tervek/2026-07-29-smith-v1.md"))
                .expect("plan file readable"),
            "## Terv\n\n## v1 bírálat\n"
        );
        assert!(append_plan_file(&cwd, "../kifele.md", "x").is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// A napló azt írja le, ami ebben a körben történt: az első körnek a terv a
    /// feladata (az már a fájlban van), egy újabb körnek a kifogás.
    #[test]
    fn the_plan_journal_records_the_objection_and_the_verdict_of_each_round() {
        let review = |text: &str| pipeline::PipelineStageResult {
            index: 2,
            role: pipeline::StageRole::Review,
            agent_label: "Codex".to_string(),
            request_id: "request-2".to_string(),
            succeeded: true,
            text: text.to_string(),
            error: None,
            review: None,
            session_id: None,
            answer_message_id: None,
        };

        let first = plan_journal_entry(1, None, &[review("VERDIKT: JAVÍTANDÓ — hiányzik a rács.")]);
        assert!(!first.contains("feladat"), "az első kör feladata maga a terv");
        assert!(first.contains("## v1 kódbírálat"));
        assert!(first.contains("hiányzik a rács"));

        let second = plan_journal_entry(
            2,
            Some("  a rács hiányzik  "),
            &[review("VERDIKT: ELFOGAD")],
        );
        let task = second.find("## v2 feladat").expect("a kör feladata");
        let verdict = second.find("## v2 kódbírálat").expect("a kör bírálata");
        assert!(task < verdict, "időrendben: előbb a feladat, utána a bírálat");
        assert!(second.contains("a rács hiányzik"));

        // Bírálat nélkül (megszakadt kör) nincs mit naplózni a verdiktről.
        assert_eq!(plan_journal_entry(1, None, &[]), "");
    }

    #[test]
    fn later_pipeline_stages_receive_only_accepted_or_carried_run_inputs() {
        let run_id = format!("pipeline-input-test-{}", uuid::Uuid::new_v4());
        pipeline_run_inputs().lock().unwrap().insert(
            run_id.clone(),
            vec![
                pipeline::PipelineRunInput {
                    input_id: "code-note".to_string(),
                    accepted_at_stage: 0,
                    accepted_at_role: "plan".to_string(),
                    text: "Use compact rows".to_string(),
                    accepted_at: "1".to_string(),
                    carried: false,
                },
                pipeline::PipelineRunInput {
                    input_id: "future-note".to_string(),
                    accepted_at_stage: 2,
                    accepted_at_role: "review".to_string(),
                    text: "Do not leak backwards".to_string(),
                    accepted_at: "2".to_string(),
                    carried: false,
                },
                pipeline::PipelineRunInput {
                    input_id: "carried-note".to_string(),
                    accepted_at_stage: 2,
                    accepted_at_role: "review".to_string(),
                    text: "Inherited from v1".to_string(),
                    accepted_at: "3".to_string(),
                    carried: true,
                },
            ],
        );

        let prompt = prompt_with_pipeline_inputs(&run_id, 1, "CODE".to_string());
        assert!(prompt.contains("Use compact rows"));
        assert!(prompt.contains("Inherited from v1"));
        assert!(!prompt.contains("Do not leak backwards"));
        assert!(prompt.contains("FUTÁS KÖZBEN HOZZÁADOTT"));

        pipeline_run_inputs().lock().unwrap().remove(&run_id);
    }

    /// A project may be claimed once at a time, and the claim frees itself.
    ///
    /// The frontend also refuses to send while a project is busy, but that is
    /// a courtesy: this is the rule, and it is what keeps two turns from
    /// snapshotting the same tree on top of one another.
    #[test]
    fn a_project_takes_one_turn_at_a_time_and_frees_itself() {
        let root = std::env::temp_dir().join("min-project-lock-test");
        std::fs::create_dir_all(&root).expect("test project directory");
        let canonical = root.canonicalize().expect("canonical test project");

        {
            let mut locks = live_project_locks().lock().expect("lock map");
            locks.insert(
                canonical.clone(),
                ProjectLockState {
                    request_id: "first-request".to_string(),
                    draining: false,
                },
            );
        }
        // A second turn in the same project is refused, and told why in a
        // sentence the user can act on.
        let busy = {
            let locks = live_project_locks().lock().expect("lock map");
            locks.contains_key(&canonical)
        };
        assert!(busy, "the first turn holds the project");

        {
            let claim = ProjectClaim {
                root: canonical.clone(),
            };
            drop(claim);
        }
        let freed = {
            let locks = live_project_locks().lock().expect("lock map");
            !locks.contains_key(&canonical)
        };
        assert!(
            freed,
            "the guard must free the project however the turn ended"
        );

        // A turn with no project claims nothing: two general-mode questions
        // have no tree to fight over.
        assert!(claim_project(None, "general").expect("no project").is_none());
        assert!(claim_project(Some("   "), "blank")
            .expect("blank project")
            .is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    /// A megállított kör lezárását meg kell várni, nem elutasítani.
    ///
    /// Ez volt a stop utáni gyors prompt hibája: a megszakított turn foglalása
    /// addig élt, amíg a lezárása (a munkaterület visszaállítása) tartott, és
    /// a következő kérés ezalatt „ebben a projektben már fut egy kérés"
    /// üzenettel bukott el — a felhasználó szemszögéből ok nélkül, hiszen ő
    /// épp az imént állította le azt a kört.
    #[test]
    fn a_stopped_turn_is_waited_out_instead_of_refusing_the_next_one() {
        let root = std::env::temp_dir().join(format!(
            "min-project-drain-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("drain test project");
        let canonical = root.canonicalize().expect("canonical drain project");
        {
            let mut locks = live_project_locks().lock().expect("lock map");
            locks.insert(
                canonical.clone(),
                ProjectLockState {
                    request_id: "stopped-request".to_string(),
                    draining: false,
                },
            );
        }

        // Amíg él a kör, a második kérés világos mondatot kap.
        let refused = match claim_project_root(canonical.clone(), "second-request") {
            Ok(_) => panic!("a live turn must still refuse the next one"),
            Err(error) => error,
        };
        assert!(refused.contains("már fut egy kérés"));

        // A leállítás után ugyanez a kérés megvárja a felszabadulást.
        mark_project_draining("stopped-request");
        let releaser = {
            let canonical = canonical.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let claim = ProjectClaim { root: canonical };
                drop(claim);
            })
        };
        let claim = match claim_project_root(canonical.clone(), "second-request") {
            Ok(claim) => claim,
            Err(error) => panic!("a drained project must be claimable: {error}"),
        };
        releaser.join().expect("releaser thread");
        drop(claim);

        std::fs::remove_dir_all(&root).ok();
    }

    /// A chain is stoppable by any of its request ids, from the moment it is
    /// registered — which is before the first stage reports itself.
    ///
    /// This is the gap that let a chain run for eleven minutes after the user
    /// pressed stop: the frontend could only name the run once a stage had
    /// started, so a stop pressed in the first second named nothing.
    #[test]
    fn a_chain_is_cancellable_before_its_first_stage_reports() {
        let run_id = "run-under-test";
        let request_ids = vec![
            "req-stage-0".to_string(),
            "req-stage-1".to_string(),
            "req-placeholder".to_string(),
        ];
        register_pipeline_request_ids(run_id, &request_ids);

        // The placeholder is what the frontend still calls "active" while the
        // chain is starting up, so it has to resolve like any stage id.
        assert_eq!(
            pipeline_run_for_request("req-placeholder").as_deref(),
            Some(run_id),
        );
        assert_eq!(
            pipeline_run_for_request("req-stage-1").as_deref(),
            Some(run_id),
        );
        assert!(pipeline_run_for_request("req-unknown").is_none());

        assert!(!pipeline_run_is_cancelled(run_id));
        assert!(
            pipeline_cancel_request("req-placeholder".to_string()).expect("cancel"),
            "a known request must report that it stopped something",
        );
        assert!(pipeline_run_is_cancelled(run_id));
        assert!(
            !pipeline_cancel_request("req-unknown".to_string()).expect("cancel"),
            "an unknown request stops nothing and must say so, so the caller can fall back",
        );

        forget_pipeline_request_ids(run_id);
        assert!(pipeline_run_for_request("req-stage-0").is_none());
        if let Ok(mut runs) = cancelled_pipeline_runs().lock() {
            runs.remove(run_id);
        }
    }
}
