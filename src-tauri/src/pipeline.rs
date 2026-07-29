//! Running one prompt as a chain of roles.
//!
//! A stage is an ordinary turn: it gets its own request id, its own row in
//! `turns`, and therefore the existing trace, diff, rollback and sync paths for
//! free. What this module owns is the part that is not a turn — the recipe, the
//! prompt each stage is handed, and how a stage's result becomes the next
//! stage's input.
//!
//! Two rules shape the design. A stage that plans or reviews must be unable to
//! write, which `StageToolProfile` enforces rather than the prompt. And the
//! chain must be deterministic: a stage is told everything it needs in its
//! prompt instead of relying on a session it may not share, because only
//! same-runtime stages continue the same session — across runtimes the text is
//! all that survives.

use crate::agent::{AgentProvider, AgentRuntimeKind, StageToolProfile};
use serde::{Deserialize, Serialize};

/// Per-artifact budget for the prompt handed to a stage. The existing
/// rehydration path uses the same order of magnitude for the same reason: a
/// prompt that carries the whole history crowds out the actual task.
const MAX_ARTIFACT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageRole {
    Plan,
    Code,
    Review,
}

impl StageRole {
    pub fn tool_profile(self) -> StageToolProfile {
        match self {
            Self::Plan => StageToolProfile::ReadOnly,
            Self::Code => StageToolProfile::Full,
            Self::Review => StageToolProfile::Reviewer,
        }
    }

    /// Shown on the stage card, so it is deliberately short.
    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "TERV",
            Self::Code => "KÓD",
            Self::Review => "REVIEW",
        }
    }

    fn artifact_heading(self) -> &'static str {
        match self {
            Self::Plan => "A tervező terve",
            Self::Code => "A kódoló összefoglalója",
            Self::Review => "A korábbi review",
        }
    }

    fn instruction(self) -> &'static str {
        match self {
            Self::Plan => {
                "Te vagy a tervező. Fájlt NEM módosíthatsz és parancsot NEM futtathatsz; \
                 a szerkesztő eszközöket meg sem kaptad. Olvasd el, ami a feladathoz kell, \
                 majd adj számozott lépéslistát: minden lépésnél nevezd meg az érintett \
                 fájlt és azt, hogy mi változik. A végén sorold fel a kockázatokat. \
                 Ne írd meg a kódot, csak a tervet."
            }
            Self::Code => {
                "Te vagy a kódoló. Hajtsd végre a fenti tervet. Mielőtt bármihez nyúlnál, \
                 vedd fel a terv számozott lépéseit todo-listaként, és munka közben \
                 tartsd karban: mindig az a lépés legyen folyamatban, amin dolgozol, \
                 a befejezettet jelöld késznek — a felület ebből mutatja a \
                 felhasználónak, hol tartasz. Ha a terv egy lépése hibás \
                 vagy megvalósíthatatlan, térj el tőle, és a végén írd meg, miben és miért. \
                 Futtasd le az érintett teszteket, és az eredményt írd bele az \
                 összefoglalóba. A végén röviden foglald össze, mit változtattál."
            }
            Self::Review => {
                "Te vagy a bíráló, és NEM te írtad ezt a kódot. Fájlt nem módosíthatsz. \
                 A diff és a tesztek alapján vizsgáld: helyes-e, megvalósult-e minden \
                 tervezett lépés, van-e nem kezelt hibaút vagy mellékhatás, és szerepel-e \
                 ugyanez a hiba máshol is. Ha tudsz parancsot futtatni, ellenőrizd a \
                 teszteket magad, és a megállapításaidat bizonyítékra alapozd, ne \
                 feltételezésre. Az utolsó sorod pontosan ez legyen: `VERDIKT: ELFOGAD` \
                 vagy `VERDIKT: JAVÍTANDÓ`, utána egyetlen mondat indoklás."
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeStage {
    pub role: StageRole,
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub label: String,
    pub stages: Vec<RecipeStage>,
}

impl Recipe {
    pub fn validate(&self) -> Result<(), String> {
        if self.stages.is_empty() {
            return Err("A recept legalább egy szakaszt tartalmazzon.".to_string());
        }
        if self.stages.len() > 6 {
            return Err("A recept legfeljebb hat szakaszt tartalmazhat.".to_string());
        }
        if self
            .stages
            .iter()
            .filter(|stage| stage.role == StageRole::Code)
            .count()
            > 1
        {
            // Two coding stages would both claim the same working tree and the
            // rollback guard could no longer attribute a change to one turn.
            return Err("Egy receptben legfeljebb egy kódoló szakasz lehet.".to_string());
        }
        Ok(())
    }
}

/// The chain the GUI runs. There is deliberately one: the detailed mode already
/// means "show me the plan", so a variant without a planning stage would
/// contradict the tick that turned it on. The authoring side stays inside one
/// Claude session, where a model switch keeps the context, and only the
/// reviewer is a different vendor -- that is where independence is worth the
/// lossy hand-off.
pub fn builtin_recipes() -> Vec<Recipe> {
    // Every stage names a real reasoning level. Leaving it empty made the GUI
    // show an "alap" cell that was not one of the values it could cycle to, so
    // clicking once dropped an option that could never be reached again.
    let claude = |role: StageRole, model: &str, effort: &str, max_turns: u32| RecipeStage {
        role,
        provider: AgentProvider::Anthropic,
        runtime: AgentRuntimeKind::ClaudeAgentBridge,
        model: Some(model.to_string()),
        effort: Some(effort.to_string()),
        max_turns: Some(max_turns),
    };
    let codex = |role: StageRole, model: &str, effort: &str, max_turns: u32| RecipeStage {
        role,
        provider: AgentProvider::Codex,
        runtime: AgentRuntimeKind::CodexAppServer,
        model: Some(model.to_string()),
        effort: Some(effort.to_string()),
        max_turns: Some(max_turns),
    };
    vec![Recipe {
        id: "plan_code_review".to_string(),
        label: "Terv → Kód → Review".to_string(),
        stages: vec![
            // Medium on both working stages: `max` on the planner bought
            // deliberation the plan rarely needed and paid for it in minutes
            // per run, and the two stages that produce the work should reason
            // at the same level rather than one straining while the other
            // coasts.
            claude(StageRole::Plan, "claude-opus-5", "medium", 15),
            claude(StageRole::Code, "claude-opus-5", "medium", 40),
            codex(StageRole::Review, "gpt-5.6-sol", "medium", 15),
        ],
    }]
}

pub fn recipe_by_id(id: &str) -> Option<Recipe> {
    builtin_recipes().into_iter().find(|recipe| recipe.id == id)
}

/// What a finished stage passes on. Deliberately not the whole transcript: the
/// summary plus the shape of the change is what the next role has to reason
/// about, and the raw tool output would crowd out the task itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageArtifact {
    pub role: StageRole,
    pub text: String,
    pub changed_files: Vec<String>,
    pub diff: Option<String>,
}

fn truncated(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let kept = value.chars().take(limit).collect::<String>();
    format!("{kept}\n… (levágva)")
}

/// Builds the prompt for one stage.
///
/// The original task always goes in verbatim and first: a stage that only sees
/// the previous stage's output drifts away from what was actually asked.
///
/// `feedback` is what the reviewer objected to on the previous pass, and only a
/// re-run has any. A re-run hands the coder the very artifacts it already
/// produced, so without this block the strongest signal in the prompt is its own
/// earlier summary and the obvious move is to write it again; stating the
/// objection as the reason this stage is running at all is what prevents that.
pub fn stage_prompt(
    role: StageRole,
    original_prompt: &str,
    artifacts: &[StageArtifact],
    feedback: Option<&str>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("[EREDETI FELADAT]\n");
    prompt.push_str(original_prompt.trim());
    prompt.push('\n');

    if !artifacts.is_empty() {
        prompt.push_str("\n[ELŐZMÉNY]\n");
        for artifact in artifacts {
            prompt.push_str(artifact.role.artifact_heading());
            prompt.push_str(":\n");
            prompt.push_str(&truncated(artifact.text.trim(), MAX_ARTIFACT_CHARS));
            prompt.push('\n');
            if !artifact.changed_files.is_empty() {
                prompt.push_str("Változott fájlok:\n");
                for file in &artifact.changed_files {
                    prompt.push_str("  ");
                    prompt.push_str(file);
                    prompt.push('\n');
                }
            }
            if let Some(diff) = artifact.diff.as_deref().map(str::trim) {
                if !diff.is_empty() {
                    prompt.push_str("Diff:\n");
                    prompt.push_str(&truncated(diff, MAX_ARTIFACT_CHARS));
                    prompt.push('\n');
                }
            }
            prompt.push('\n');
        }
    }

    if let Some(feedback) = feedback.map(str::trim).filter(|value| !value.is_empty()) {
        prompt.push_str("\n[MIÉRT FUTSZ ÚJRA]\n");
        prompt.push_str(
            "A bíráló az előző körben javítást kért. A kifogása:\n",
        );
        prompt.push_str(&truncated(feedback, MAX_ARTIFACT_CHARS));
        prompt.push_str(
            "\nEzt kell orvosolnod. A tervtől csak annyiban térj el, amennyiben a \
             kifogás megköveteli, és ne írd újra azt, ami már jó volt.\n",
        );
    }

    prompt.push_str("[SZEREP]\n");
    prompt.push_str(role.instruction());
    prompt
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Accepted,
    ChangesRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcome {
    pub verdict: ReviewVerdict,
    /// The single sentence shown on the collapsed card. Three stages already
    /// triple how much there is to read, so the card starts as one line.
    pub summary: String,
}

/// Finds the verdict line anywhere in the answer, scanning from the end.
///
/// Models put it on the last line when asked, but not reliably: a trailing
/// sign-off or a stray blank line is common, and the marker sometimes ends up
/// bolded. Treating "no recognizable verdict" as a hard failure would fail a
/// review that is otherwise perfectly usable, so this returns None and the
/// caller shows the answer without a badge.
pub fn parse_review_verdict(answer: &str) -> Option<ReviewOutcome> {
    for line in answer.lines().rev() {
        let cleaned = line
            .trim()
            .trim_start_matches(['#', '*', '_', '-', '>', ' '])
            .trim_end_matches(['*', '_', ' ']);
        let upper = cleaned.to_uppercase();
        let Some(rest) = upper.strip_prefix("VERDIKT:") else {
            continue;
        };
        let rest = rest.trim_start();
        let verdict = if rest.starts_with("ELFOGAD") {
            ReviewVerdict::Accepted
        } else if rest.starts_with("JAVÍTANDÓ") || rest.starts_with("JAVITANDO") {
            ReviewVerdict::ChangesRequested
        } else {
            continue;
        };
        // Keep the model's own wording for the summary rather than the
        // upper-cased copy used for matching.
        let original = cleaned
            .split_once(':')
            .map(|(_, rest)| rest.trim())
            .unwrap_or(cleaned);
        let summary = original
            .splitn(2, |character: char| character == '—' || character == '-')
            .nth(1)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(original)
            .to_string();
        return Some(ReviewOutcome { verdict, summary });
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A stage failing ends the run: the later roles were going to reason about an
/// artifact that does not exist. A review asking for changes is *not* a
/// failure — the chain did its job and the verdict is the result.
pub fn status_after_stage(stage_succeeded: bool, is_last_stage: bool) -> RunStatus {
    match (stage_succeeded, is_last_stage) {
        (false, _) => RunStatus::Failed,
        (true, true) => RunStatus::Completed,
        (true, false) => RunStatus::Running,
    }
}

/// Badge text for a stage, e.g. `Claude · Opus 5` or `Codex`.
pub fn stage_agent_label(stage: &RecipeStage) -> String {
    let vendor = match stage.provider {
        AgentProvider::Anthropic => "Claude",
        AgentProvider::Codex => "Codex",
    };
    let Some(model) = stage.model.as_deref() else {
        return vendor.to_string();
    };
    let pretty = match model {
        "claude-opus-5" => "Opus 5",
        "claude-fable-5" => "Fable 5",
        "claude-sonnet-5" => "Sonnet 5",
        other => other,
    };
    // The card names the stage already, so the badge only has to answer "who
    // ran this, and how hard did it think".
    match stage.effort.as_deref() {
        Some(effort) if !effort.is_empty() => format!("{vendor} · {pretty} · {effort}"),
        _ => format!("{vendor} · {pretty}"),
    }
}

/// Turns a finished stage into what the next one is told about it.
pub fn artifact_from_response(
    role: StageRole,
    text: &str,
    guard: &crate::codex::AgentGuardReport,
) -> StageArtifact {
    let mut changed_files = guard.changed_files.clone();
    changed_files.extend(guard.added_files.iter().cloned());
    changed_files.extend(guard.removed_files.iter().cloned());
    changed_files.sort();
    changed_files.dedup();
    StageArtifact {
        role,
        text: text.to_string(),
        changed_files,
        // The diff itself lives in the work items the coding stage produced; the
        // reviewer reads them from the workspace it can already see, so the
        // prompt carries the file list rather than a second copy of the patch.
        diff: None,
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunRequest {
    pub recipe_id: String,
    pub prompt: String,
    pub conversation_id: String,
    /// One request id per stage, allocated by the frontend so it can attribute
    /// the live events of a stage before that stage has finished.
    pub request_ids: Vec<String>,
    #[serde(default)]
    pub images: Vec<crate::agent::AgentImageAttachment>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_context: Option<String>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    /// Per-stage model and reasoning chosen in the GUI. Indexed by stage, and
    /// only the fields the user actually set override the preset -- a stage
    /// left alone keeps what the recipe recommends.
    #[serde(default)]
    pub stage_overrides: Vec<StageOverride>,
    /// The request the user's submit created. It runs no turn of its own, but
    /// its live bubble is filled by the first stage and would be saved as a
    /// second copy of that answer.
    #[serde(default)]
    pub placeholder_request_id: Option<String>,
    /// Where the chain starts. A re-run after a rejected review resumes at the
    /// coding stage: the plan was already accepted, and re-planning costs a
    /// model call only to risk drifting away from what the reviewer agreed to.
    #[serde(default)]
    pub start_stage: Option<usize>,
    /// What the skipped stages produced, so the resumed chain still has the
    /// history its prompts are built from.
    #[serde(default)]
    pub seed_artifacts: Vec<SeedArtifact>,
    /// The reviewer's objection, handed to the first stage of a re-run.
    #[serde(default)]
    pub retry_feedback: Option<String>,
    /// Ties the iterations of one question together. The first run leaves this
    /// empty and becomes the chain; every re-run names it.
    #[serde(default)]
    pub chain_id: Option<String>,
    /// 1-based. v1 is the original run, v2 and v3 are the re-runs.
    #[serde(default)]
    pub iteration: Option<i64>,
}

/// A stage the caller already has an answer for. The wire form of
/// [`StageArtifact`], which is internal and not deserializable.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedArtifact {
    pub role: StageRole,
    pub text: String,
    #[serde(default)]
    pub changed_files: Vec<String>,
}

impl From<SeedArtifact> for StageArtifact {
    fn from(seed: SeedArtifact) -> Self {
        Self {
            role: seed.role,
            text: seed.text,
            changed_files: seed.changed_files,
            diff: None,
        }
    }
}

/// How many times one question may go round the chain. Past this the two sides
/// are not converging, and another pass only costs money.
pub const MAX_CHAIN_ITERATIONS: i64 = 3;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOverride {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// `anthropic` or `codex`. Switching the vendor switches the runtime with
    /// it, since a Claude model cannot run on the Codex app-server.
    #[serde(default)]
    pub provider: Option<String>,
}

/// Applies the GUI's per-stage choices onto the preset.
pub fn apply_stage_overrides(recipe: &mut Recipe, overrides: &[StageOverride]) {
    for (stage, over) in recipe.stages.iter_mut().zip(overrides.iter()) {
        // The vendor decides the runtime with it: a Claude model cannot run on
        // the Codex app-server, so a stale id from the previous vendor has to go
        // rather than fail at send time.
        match over.provider.as_deref() {
            Some("anthropic") => {
                stage.provider = AgentProvider::Anthropic;
                stage.runtime = AgentRuntimeKind::ClaudeAgentBridge;
                if stage
                    .model
                    .as_deref()
                    .is_some_and(|model| !model.starts_with("claude-"))
                {
                    stage.model = None;
                }
            }
            Some("codex") => {
                stage.provider = AgentProvider::Codex;
                stage.runtime = AgentRuntimeKind::CodexAppServer;
                if stage
                    .model
                    .as_deref()
                    .is_some_and(|model| model.starts_with("claude-"))
                {
                    stage.model = None;
                }
            }
            _ => {}
        }
        if let Some(model) = over
            .model
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            stage.model = Some(model.to_string());
        }
        if let Some(effort) = over
            .effort
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            stage.effort = Some(effort.to_string());
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageResult {
    pub index: i64,
    pub role: StageRole,
    pub agent_label: String,
    pub request_id: String,
    pub succeeded: bool,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Id of the answer row this stage stored, so the UI shows that row rather
    /// than adding a second one of its own for the same answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunResult {
    pub run_id: String,
    /// Shared by every iteration of one question; equals `run_id` on the first.
    pub chain_id: String,
    pub iteration: i64,
    pub recipe: Recipe,
    pub status: RunStatus,
    pub stages: Vec<PipelineStageResult>,
    /// The chain's staged workspace changes. Staging restores the tree to its
    /// base, so without this report reaching the frontend nothing would ever
    /// apply the chain's work back to disk — the coder's edits would sit in the
    /// snapshot directory forever while the answer claimed they exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guard: Option<crate::codex::AgentGuardReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Emitted before and after every stage so the UI can follow a run that takes
/// minutes, instead of showing nothing until the whole chain finishes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgress {
    pub run_id: String,
    pub conversation_id: String,
    pub stage_index: i64,
    pub stage_count: i64,
    pub role: StageRole,
    pub agent_label: String,
    pub request_id: String,
    pub phase: &'static str,
    pub status: RunStatus,
}

pub fn recipes_for_frontend() -> Vec<Recipe> {
    builtin_recipes()
}

/// What the runner hands to whoever actually executes a stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageExecution {
    pub index: usize,
    pub stage: RecipeStage,
    pub prompt: String,
    /// The session this stage should continue, if one of its runtime is open.
    pub session_id: Option<String>,
    /// Only the first stage carries the user's attachments and context.
    pub is_first: bool,
}

/// What executing a stage produced, reduced to what the chain reasons about.
/// Deliberately not `AgentResponse`: the chain does not care how the answer was
/// obtained, and a test should not have to build a whole transport response.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StageOutcome {
    pub text: String,
    pub session_id: Option<String>,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageRunResult {
    pub index: usize,
    pub role: StageRole,
    pub succeeded: bool,
    pub text: String,
    pub error: Option<String>,
    pub review: Option<ReviewOutcome>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineOutcome {
    pub status: RunStatus,
    pub stages: Vec<StageRunResult>,
    pub error: Option<String>,
}

/// Where a walk of the chain begins and what it already knows.
#[derive(Debug, Clone, Default)]
pub struct RunStart {
    pub initial_session: Option<String>,
    /// Index of the first stage to run. Everything before it is expected to
    /// arrive as a seed artifact instead.
    pub start_index: usize,
    pub seed_artifacts: Vec<StageArtifact>,
    /// Handed to the first stage that actually runs, and to that one only: the
    /// stages after it read the objection out of the review artifact anyway.
    pub feedback: Option<String>,
}

/// Walks the chain, possibly from partway through it.
///
/// Everything with a side effect -- running the turn, writing to the store,
/// emitting progress -- happens inside `execute`, so what remains here is the
/// part worth testing on its own: which prompt each stage is handed, which
/// session it continues, what a failure does to the rest of the chain.
pub async fn run_stages_from<F, Fut, S>(
    recipe: &Recipe,
    original_prompt: &str,
    start: RunStart,
    should_stop: S,
    mut execute: F,
) -> PipelineOutcome
where
    F: FnMut(StageExecution) -> Fut,
    Fut: std::future::Future<Output = Result<StageOutcome, String>>,
    S: Fn() -> bool,
{
    let RunStart {
        initial_session,
        start_index,
        seed_artifacts,
        feedback,
    } = start;
    let mut artifacts = seed_artifacts;
    let mut stages = Vec::<StageRunResult>::new();
    // Keyed by runtime: a stage continues the session of its own runtime, which
    // is what lets a model switch inside one vendor keep the context while a
    // vendor switch starts fresh and relies on the artifact block instead.
    let mut session_by_runtime = std::collections::HashMap::<String, String>::new();
    if let Some(session) = initial_session {
        session_by_runtime.insert(
            format!("{:?}", AgentRuntimeKind::ClaudeAgentBridge),
            session,
        );
    }
    let mut status = RunStatus::Running;
    let mut error = None;

    for (index, stage) in recipe.stages.iter().enumerate().skip(start_index) {
        // Checked between stages rather than inside one: a stage cannot be torn
        // out of the provider mid-turn today, so the honest promise is that no
        // further stage starts. Whatever already ran keeps its answer.
        if should_stop() {
            status = RunStatus::Cancelled;
            break;
        }
        let runtime_key = format!("{:?}", stage.runtime);
        let execution = StageExecution {
            index,
            stage: stage.clone(),
            prompt: stage_prompt(
                stage.role,
                original_prompt,
                &artifacts,
                (index == start_index).then_some(feedback.as_deref()).flatten(),
            ),
            session_id: session_by_runtime.get(&runtime_key).cloned(),
            // The user's attachments and conversation context belong to the
            // stage that opens the chain, and a re-run opens nothing: stage 0
            // already carried them on the first pass.
            is_first: index == 0,
        };
        let is_last = index + 1 == recipe.stages.len();
        // A provider can hand back a turn that simply says nothing -- an
        // unknown model name produced exactly that, with no error anywhere.
        // Passing it on would let the chain report success while the next role
        // reasons about an artifact that is not there, and leave the user an
        // empty bubble where the answer belongs.
        let outcome = match execute(execution).await {
            Ok(outcome) if outcome.text.trim().is_empty() => Err(format!(
                "A(z) {} szakasz üres választ adott. Ellenőrizd a szakaszhoz választott modellt.",
                stage.role.label()
            )),
            other => other,
        };
        match outcome {
            Ok(outcome) => {
                if let Some(session) = outcome.session_id.clone() {
                    session_by_runtime.insert(runtime_key, session);
                }
                let review = (stage.role == StageRole::Review)
                    .then(|| parse_review_verdict(&outcome.text))
                    .flatten();
                artifacts.push(StageArtifact {
                    role: stage.role,
                    text: outcome.text.clone(),
                    changed_files: outcome.changed_files,
                    diff: None,
                });
                status = status_after_stage(true, is_last);
                stages.push(StageRunResult {
                    index,
                    role: stage.role,
                    succeeded: true,
                    text: outcome.text,
                    error: None,
                    review,
                    session_id: outcome.session_id,
                });
            }
            Err(message) => {
                // Stopping on purpose reaches the provider as a cancelled
                // request, so the stage reports an error. Calling that a
                // failure would blame the user for pressing stop.
                let stopped = should_stop();
                status = if stopped {
                    RunStatus::Cancelled
                } else {
                    status_after_stage(false, is_last)
                };
                error = (!stopped).then(|| message.clone());
                stages.push(StageRunResult {
                    index,
                    role: stage.role,
                    succeeded: false,
                    text: String::new(),
                    error: Some(message),
                    review: None,
                    session_id: None,
                });
                // The remaining roles would reason about an artifact that does
                // not exist, so the chain stops here.
                break;
            }
        }
    }

    PipelineOutcome {
        status,
        stages,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prompt of a stage that is running for the first time, which is what
    /// every case below except the re-run one is about.
    fn stage_prompt(
        role: StageRole,
        original_prompt: &str,
        artifacts: &[StageArtifact],
    ) -> String {
        super::stage_prompt(role, original_prompt, artifacts, None)
    }

    fn artifact(role: StageRole, text: &str) -> StageArtifact {
        StageArtifact {
            role,
            text: text.to_string(),
            changed_files: Vec::new(),
            diff: None,
        }
    }

    #[test]
    fn every_role_gets_the_tool_profile_its_job_requires() {
        assert_eq!(
            StageRole::Plan.tool_profile(),
            StageToolProfile::ReadOnly,
            "a planner that can edit files is not a planner"
        );
        assert_eq!(StageRole::Code.tool_profile(), StageToolProfile::Full);
        assert_eq!(
            StageRole::Review.tool_profile(),
            StageToolProfile::Reviewer,
            "the reviewer must be able to run the tests but not to edit"
        );
    }

    #[test]
    fn the_original_task_is_always_first_and_verbatim() {
        let prompt = stage_prompt(
            StageRole::Review,
            "  A math.js-ben a multiply összead. Javítsd.  ",
            &[artifact(StageRole::Code, "Kijavítottam.")],
        );
        let task_at = prompt
            .find("A math.js-ben a multiply összead. Javítsd.")
            .expect("the original task must be present verbatim");
        let history_at = prompt.find("[ELŐZMÉNY]").expect("history section");
        assert!(
            task_at < history_at,
            "a stage that reads the previous output first drifts from the actual request"
        );
        assert!(prompt.contains("VERDIKT: ELFOGAD"));
    }

    #[test]
    fn a_coding_stage_hands_the_reviewer_the_change_itself() {
        let prompt = stage_prompt(
            StageRole::Review,
            "Javítsd a hibát.",
            &[StageArtifact {
                role: StageRole::Code,
                text: "Kijavítottam, a + b → a * b. A tesztek zöldek.".to_string(),
                changed_files: vec!["math.js  +1 −1".to_string()],
                diff: Some("- a + b\n+ a * b".to_string()),
            }],
        );
        assert!(prompt.contains("Változott fájlok:"));
        assert!(prompt.contains("math.js  +1 −1"));
        assert!(prompt.contains("+ a * b"));
    }

    #[test]
    fn an_oversized_artifact_is_cut_instead_of_crowding_out_the_task() {
        let huge = "x".repeat(MAX_ARTIFACT_CHARS * 2);
        let prompt = stage_prompt(
            StageRole::Review,
            "Feladat.",
            &[artifact(StageRole::Code, &huge)],
        );
        assert!(prompt.contains("… (levágva)"));
        assert!(
            prompt.chars().count() < MAX_ARTIFACT_CHARS * 2,
            "the whole artifact must not reach the prompt"
        );
        assert!(prompt.contains("Feladat."));
    }

    #[test]
    fn the_verdict_survives_the_ways_a_model_actually_writes_it() {
        let accepted = parse_review_verdict("Rendben van.\n\nVERDIKT: ELFOGAD — a javítás helyes.")
            .expect("verdict");
        assert_eq!(accepted.verdict, ReviewVerdict::Accepted);
        assert_eq!(accepted.summary, "a javítás helyes.");

        // Bolded, with a trailing blank line, and the accent dropped.
        let bolded = parse_review_verdict("**VERDIKT: JAVITANDO — a teszt nem futott le.**\n\n")
            .expect("verdict");
        assert_eq!(bolded.verdict, ReviewVerdict::ChangesRequested);
        assert_eq!(bolded.summary, "a teszt nem futott le.");

        // The line is not last: a sign-off follows it.
        let midway = parse_review_verdict(
            "VERDIKT: JAVÍTANDÓ — a divide függvényben ugyanez a hiba.\n\nSzólj, ha javítom.",
        )
        .expect("verdict");
        assert_eq!(midway.verdict, ReviewVerdict::ChangesRequested);
    }

    #[test]
    fn a_missing_verdict_is_not_an_error() {
        assert!(parse_review_verdict("Szerintem jó lett.").is_none());
        assert!(parse_review_verdict("VERDIKT: talán").is_none());
    }

    #[test]
    fn a_review_asking_for_changes_still_completes_the_run() {
        assert_eq!(status_after_stage(true, true), RunStatus::Completed);
        assert_eq!(status_after_stage(true, false), RunStatus::Running);
        assert_eq!(
            status_after_stage(false, false),
            RunStatus::Failed,
            "the later roles would reason about an artifact that does not exist"
        );
    }

    /// Records what each stage was handed, so a test asserts on the chain
    /// itself rather than on whatever the executor happened to return.
    struct Recorder {
        seen: std::cell::RefCell<Vec<StageExecution>>,
        outcomes: std::cell::RefCell<Vec<Result<StageOutcome, String>>>,
        /// Stop the chain once this many stages have run, standing in for the
        /// user pressing the stop button mid-run.
        stop_after: std::cell::Cell<Option<usize>>,
    }

    impl Recorder {
        fn with(outcomes: Vec<Result<StageOutcome, String>>) -> Self {
            Self {
                seen: std::cell::RefCell::new(Vec::new()),
                outcomes: std::cell::RefCell::new(outcomes),
                stop_after: std::cell::Cell::new(None),
            }
        }

        fn run(&self, recipe: &Recipe, prompt: &str, session: Option<String>) -> PipelineOutcome {
            tauri::async_runtime::block_on(run_stages_from(
                recipe,
                prompt,
                RunStart {
                    initial_session: session,
                    ..RunStart::default()
                },
                || {
                    self.stop_after
                        .get()
                        .is_some_and(|at| self.seen.borrow().len() >= at)
                },
                |execution| {
                    self.seen.borrow_mut().push(execution);
                    let next = if self.outcomes.borrow().is_empty() {
                        Ok(StageOutcome::default())
                    } else {
                        self.outcomes.borrow_mut().remove(0)
                    };
                    async move { next }
                },
            ))
        }
    }

    fn ok(text: &str, session: Option<&str>) -> Result<StageOutcome, String> {
        Ok(StageOutcome {
            text: text.to_string(),
            session_id: session.map(str::to_string),
            changed_files: Vec::new(),
        })
    }

    #[test]
    fn u1_a_model_switch_inside_one_vendor_continues_the_same_session() {
        // Its own recipe rather than the preset: the preset may well run the
        // same model on both authoring stages — it does today — and then it
        // could not carry the case this test is named after.
        let recipe = {
            let mut recipe = recipe_by_id("plan_code_review").expect("preset");
            recipe.stages[0].model = Some("claude-fable-5".to_string());
            recipe.stages[1].model = Some("claude-opus-5".to_string());
            recipe
        };
        let recorder = Recorder::with(vec![
            ok("terv", Some("claude-session-1")),
            ok("kod", Some("claude-session-1")),
            ok("VERDIKT: ELFOGAD - rendben.", Some("codex-session-9")),
        ]);
        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();

        assert_eq!(
            seen[0].session_id, None,
            "the first stage opens the session"
        );
        assert_eq!(
            seen[1].session_id.as_deref(),
            Some("claude-session-1"),
            "planning on one model and coding on another must continue one session"
        );
        assert_eq!(
            seen[2].session_id, None,
            "the reviewer is another runtime and must never inherit the Claude session"
        );
        assert_ne!(seen[0].stage.model, seen[1].stage.model);
    }

    #[test]
    fn u1b_an_existing_conversation_session_reaches_the_first_claude_stage() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(Vec::new());
        recorder.run(&recipe, "Feladat.", Some("resumed-session".to_string()));
        assert_eq!(
            recorder.seen.borrow()[0].session_id.as_deref(),
            Some("resumed-session")
        );
    }

    #[test]
    fn u2_each_stage_sees_the_task_and_everything_produced_before_it() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![
            ok("A TERVEM: olvasd a math.js-t", None),
            ok("A KODOM: kijavitottam", None),
            ok("VERDIKT: ELFOGAD - jo.", None),
        ]);
        recorder.run(&recipe, "EREDETI KERES", None);
        let seen = recorder.seen.borrow();

        assert!(
            !seen[0].prompt.contains("A TERVEM"),
            "nothing precedes the first stage"
        );
        assert!(seen[1].prompt.contains("A TERVEM"));
        assert!(seen[2].prompt.contains("A TERVEM") && seen[2].prompt.contains("A KODOM"));
        for execution in seen.iter() {
            assert!(
                execution.prompt.starts_with("[EREDETI FELADAT]"),
                "a stage that reads the previous output first drifts from the request"
            );
            assert!(execution.prompt.contains("EREDETI KERES"));
        }
    }

    #[test]
    fn u3_a_failed_stage_stops_the_chain_and_keeps_what_came_before() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![
            ok("terv", None),
            Err("A kodolo elhasalt.".to_string()),
            ok("ez sosem fut", None),
        ]);
        let outcome = recorder.run(&recipe, "Feladat.", None);

        assert_eq!(
            recorder.seen.borrow().len(),
            2,
            "the reviewer would reason about an artifact that does not exist"
        );
        assert_eq!(outcome.status, RunStatus::Failed);
        assert_eq!(outcome.error.as_deref(), Some("A kodolo elhasalt."));
        assert_eq!(outcome.stages.len(), 2);
        assert!(outcome.stages[0].succeeded && outcome.stages[0].text == "terv");
        assert!(!outcome.stages[1].succeeded);
    }

    #[test]
    fn u6_only_the_first_stage_carries_the_original_attachments() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        // Every stage has to answer something, or the chain stops before the
        // later stages this test is about.
        let recorder = Recorder::with(vec![ok("terv", None), ok("kod", None), ok("review", None)]);
        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();
        assert!(seen[0].is_first);
        assert!(!seen[1].is_first && !seen[2].is_first);
    }

    #[test]
    fn u7_a_review_asking_for_changes_still_completes_the_run() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![
            ok("terv", None),
            ok("kod", None),
            ok("VERDIKT: JAVÍTANDÓ - a teszt nem futott le.", None),
        ]);
        let outcome = recorder.run(&recipe, "Feladat.", None);

        assert_eq!(
            outcome.status,
            RunStatus::Completed,
            "the verdict is the result of the chain, not a failure of it"
        );
        let review = outcome.stages[2].review.as_ref().expect("verdict");
        assert_eq!(review.verdict, ReviewVerdict::ChangesRequested);
        assert_eq!(review.summary, "a teszt nem futott le.");
        assert!(
            outcome.stages[0].review.is_none() && outcome.stages[1].review.is_none(),
            "only a review stage carries a verdict"
        );
    }

    #[test]
    fn l5_a_stage_that_answers_nothing_stops_the_chain() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        // What an unknown model name actually did: a turn that ended cleanly
        // and said nothing at all.
        let recorder = Recorder::with(vec![
            ok("terv", None),
            ok(
                "   
  ", None,
            ),
        ]);
        let outcome = recorder.run(&recipe, "Feladat.", None);

        assert_eq!(recorder.seen.borrow().len(), 2, "the review must not start");
        assert_eq!(outcome.status, RunStatus::Failed);
        assert!(!outcome.stages[1].succeeded);
        let reason = outcome.error.clone().unwrap_or_default();
        assert!(
            reason.contains("üres választ") && reason.contains("KÓD"),
            "the reason must name the stage and say what happened, got: {reason}"
        );
    }

    #[test]
    fn l7b_a_stage_cut_short_by_the_stop_button_is_not_a_failure() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        // Pressing stop cancels the provider request, so the stage comes back
        // with an error. That is the user's doing, not a broken run.
        let recorder = Recorder::with(vec![
            ok("terv", None),
            Err("A Claude-kérés megszakítva.".to_string()),
        ]);
        recorder.stop_after.set(Some(2));
        let outcome = recorder.run(&recipe, "Feladat.", None);

        assert_eq!(outcome.status, RunStatus::Cancelled);
        assert!(
            outcome.error.is_none(),
            "a stopped run must not report a failure reason to the user"
        );
        assert_eq!(outcome.stages.len(), 2);
        assert!(
            !outcome.stages[1].succeeded,
            "the stage itself did not finish"
        );
    }

    #[test]
    fn l7_stopping_a_chain_starts_no_further_stage() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![ok("terv", None), ok("kod", None)]);
        // A provider turn cannot be torn out mid-flight today, so the promise
        // is that nothing further starts once the user has said stop.
        recorder.stop_after.set(Some(2));
        let outcome = recorder.run(&recipe, "Feladat.", None);

        assert_eq!(recorder.seen.borrow().len(), 2, "the review must not start");
        assert_eq!(outcome.status, RunStatus::Cancelled);
        assert_eq!(outcome.stages.len(), 2, "what already ran keeps its answer");
        assert!(outcome.stages.iter().all(|stage| stage.succeeded));
        assert!(
            outcome.error.is_none(),
            "stopping on purpose is not an error"
        );
    }

    #[test]
    fn u4_the_gui_choices_override_the_preset() {
        let mut recipe = recipe_by_id("plan_code_review").expect("preset");
        apply_stage_overrides(
            &mut recipe,
            &[
                StageOverride {
                    model: Some("claude-opus-5".to_string()),
                    effort: Some("high".to_string()),
                    provider: None,
                },
                StageOverride::default(),
                StageOverride {
                    model: None,
                    effort: None,
                    provider: Some("anthropic".to_string()),
                },
            ],
        );

        assert_eq!(recipe.stages[0].model.as_deref(), Some("claude-opus-5"));
        assert_eq!(recipe.stages[0].effort.as_deref(), Some("high"));
        assert_eq!(
            recipe.stages[1].model.as_deref(),
            Some("claude-opus-5"),
            "a stage left alone keeps what the preset recommends"
        );
        assert_eq!(recipe.stages[2].provider, AgentProvider::Anthropic);
        assert_eq!(
            recipe.stages[2].runtime,
            AgentRuntimeKind::ClaudeAgentBridge,
            "switching the vendor must switch the runtime with it"
        );
    }

    #[test]
    fn u4b_switching_a_stage_to_codex_drops_the_claude_model() {
        let mut recipe = recipe_by_id("plan_code_review").expect("preset");
        apply_stage_overrides(
            &mut recipe,
            &[StageOverride {
                model: None,
                effort: None,
                provider: Some("codex".to_string()),
            }],
        );
        assert_eq!(recipe.stages[0].provider, AgentProvider::Codex);
        assert_eq!(
            recipe.stages[0].model, None,
            "a Claude model id would fail on the Codex app-server at send time"
        );
    }

    #[test]
    fn the_presets_are_valid_and_never_have_two_writers() {
        for recipe in builtin_recipes() {
            recipe
                .validate()
                .unwrap_or_else(|error| panic!("{} invalid: {error}", recipe.id));
        }
        let recommended = recipe_by_id("plan_code_review").expect("preset");
        // The authoring side stays in one Claude session so the model switch
        // keeps the context; only the reviewer is a different vendor.
        assert_eq!(recommended.stages[0].provider, AgentProvider::Anthropic);
        assert_eq!(recommended.stages[1].provider, AgentProvider::Anthropic);
        assert_eq!(recommended.stages[2].provider, AgentProvider::Codex);
        // Which Claude model each authoring stage runs is a matter of taste and
        // changes with it; that a model switch survives the session is the
        // invariant, and `u1_…` tests it on a recipe of its own.

        let two_writers = Recipe {
            id: "bad".to_string(),
            label: "Két kódoló".to_string(),
            stages: vec![recommended.stages[1].clone(), recommended.stages[1].clone()],
        };
        assert!(
            two_writers.validate().is_err(),
            "two coding stages would both claim the working tree and break rollback attribution"
        );
    }

    #[test]
    fn a_rejected_review_reruns_from_the_coder_and_says_why() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let seen = std::cell::RefCell::new(Vec::<StageExecution>::new());
        let outcome = tauri::async_runtime::block_on(run_stages_from(
            &recipe,
            "Feladat.",
            RunStart {
                initial_session: None,
                start_index: 1,
                seed_artifacts: vec![artifact(StageRole::Plan, "1. lépés: írd át a szorzást.")],
                feedback: Some("a szorzás helyett összeadás maradt.".to_string()),
            },
            || false,
            |execution| {
                seen.borrow_mut().push(execution);
                async { ok("kész.", None) }
            },
        ));
        let seen = seen.borrow();

        assert_eq!(
            seen.iter().map(|run| run.index).collect::<Vec<_>>(),
            vec![1, 2],
            "the accepted plan does not get re-planned"
        );
        assert!(
            seen[0].prompt.contains("1. lépés: írd át a szorzást."),
            "the resumed coder still needs the plan it is executing"
        );
        assert!(
            seen[0]
                .prompt
                .contains("a szorzás helyett összeadás maradt."),
            "without the objection the coder's strongest cue is its own earlier summary"
        );
        assert!(
            !seen[1].prompt.contains("[MIÉRT FUTSZ ÚJRA]"),
            "the reviewer reads the objection out of the artifacts, and re-stating it invites anchoring"
        );
        assert!(
            !seen[0].is_first,
            "a re-run opens nothing: the attachments and context went with stage 0 on the first pass"
        );
        assert_eq!(
            outcome.status,
            RunStatus::Completed,
            "reaching the last stage completes the run whatever the verdict says"
        );
        assert_eq!(outcome.stages.len(), 2);
    }

    #[test]
    fn a_chain_cannot_iterate_forever() {
        assert_eq!(
            MAX_CHAIN_ITERATIONS, 3,
            "v1 plus two re-runs; past that the two sides are not converging"
        );
    }
}
