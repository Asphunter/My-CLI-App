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
                "Te vagy a kódoló. Hajtsd végre a fenti tervet. Ha a terv egy lépése hibás \
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
            claude(StageRole::Plan, "claude-fable-5", "max", 15),
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
pub fn stage_prompt(role: StageRole, original_prompt: &str, artifacts: &[StageArtifact]) -> String {
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
    format!("{vendor} · {pretty}")
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
}

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunResult {
    pub run_id: String,
    pub recipe: Recipe,
    pub status: RunStatus,
    pub stages: Vec<PipelineStageResult>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_ne!(recommended.stages[0].model, recommended.stages[1].model);

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
}
