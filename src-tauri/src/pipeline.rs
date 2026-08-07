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

use crate::agent::{
    AgentAccessProfile, AgentProvider, AgentRuntimeKind, StageToolProfile,
};
use serde::{Deserialize, Serialize};

/// Per-artifact budget for the prompt handed to a stage. The existing
/// rehydration path uses the same order of magnitude for the same reason: a
/// prompt that carries the whole history crowds out the actual task.
const MAX_ARTIFACT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageRole {
    Plan,
    PlanReview,
    Code,
    Review,
}

impl StageRole {
    /// Stable value sent to the frontend/store. `Debug` formatting is not a
    /// wire format for compound roles (`PlanReview` would become `planreview`).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::PlanReview => "plan_review",
            Self::Code => "code",
            Self::Review => "review",
        }
    }

    pub fn is_review(self) -> bool {
        matches!(self, Self::PlanReview | Self::Review)
    }

    pub fn starts_fresh_session(self) -> bool {
        self.is_review()
    }

    pub fn tool_profile(self) -> StageToolProfile {
        match self {
            Self::Plan => StageToolProfile::ReadOnly,
            Self::PlanReview => StageToolProfile::ReadOnly,
            Self::Code => StageToolProfile::Full,
            Self::Review => StageToolProfile::Reviewer,
        }
    }

    /// Shown on the stage card, so it is deliberately short.
    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "TERV",
            Self::PlanReview => "TERV REVIEW",
            Self::Code => "KÓD",
            Self::Review => "REVIEW",
        }
    }

    fn artifact_heading(self) -> &'static str {
        match self {
            Self::Plan => "A tervező terve",
            Self::PlanReview => "A terv bírálata",
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
                 fájlt és azt, hogy mi változik. A pontok számát te határozd meg a \
                 feladat érdemi bontása alapján; egy pont egy összefüggő munkaegység \
                 legyen, ne bontsd apró részlépésekre. \
                 Mindig adj legalább egy számozott tervlépést, egyszerű ellenőrző vagy \
                 kérdező feladatnál is; ebben a szerepben ne a végső választ add meg a terv helyett. \
                 A válasz legelső nem üres sora kötelezően `1. <konkrét lépéscím> — ...` \
                 alakú legyen: ne írj elé bevezetőt vagy címsort. Akkor se hajtsd végre itt az \
                 eredeti feladatot, ha az azonnali végrehajtást vagy pontos végső választ kér; \
                 ezt majd a KÓD szakasz teljesíti. \
                 Az eredeti feladat számszerű követelményeit (tartományok, mértékegységek, \
                 darabszámok, nevesített értékek) szó szerint tartsd meg, és a tervben is \
                 ugyanabban a mennyiségben és egységben nevezd meg őket, ahogy a feladat \
                 kimondta — átváltani szabad, de a feladat szerinti alakot is írd ki. \
                 Ha bármelyiket mégis átértelmezed, azt `## Eltérés a feladattól` cím alatt, \
                 tételesen és indoklással írd le. A végén sorold fel a kockázatokat. \
                 A lépéscímekben a felhasználó saját terminológiáját használd; ne alkoss \
                 új magyar címkét egy egyszerű `MOST`, `KÖV. FÁZIS` vagy `UTÁNA` kérésre. \
                 Ne írd meg a kódot, csak a tervet."
            }
            Self::PlanReview => {
                "Te vagy a független műszaki tervbíráló. A TERV-et nem te írtad. Fájlt NEM módosíthatsz és parancsot NEM futtathatsz; csak olvasó és webes forráskereső eszközöket kaptál. ELŐSZÖR az EREDETI FELADAT ellenőrizd, utána a tervet. Ellenőrizd a követelmények teljes lefedését, a számszerű értékeket és mértékegységeket, a feltételezéseket, az architektúrát és interfészeket, a mérési/kalibrációs/verifikációs stratégiát, a hibautakat és kockázatokat, valamint külső forrásoknál a forrásminőséget és licencet. A blokkoló hibákat különítsd el az ajánlásoktól, és minden megállapítást bizonyítékkal támassz alá. A végén pontosan `VERDIKT: ELFOGAD` vagy `VERDIKT: JAVÍTANDÓ` sort adj, utána egyetlen mondat indoklással."
            }
            Self::Code => {
                "Te vagy a kódoló. Hajtsd végre a fenti tervet. Mielőtt bármihez nyúlnál, \
                 vedd fel a terv számozott lépéseit todo-listaként — az elemek szövege \
                 szó szerint a terv lépéseinek címe legyen, ne a saját munkafolyamatod \
                 fázisai —, és munka közben \
                 tartsd karban: mindig az a lépés legyen folyamatban, amin dolgozol, \
                 a befejezettet jelöld késznek — a felület ebből mutatja a \
                 felhasználónak, hol tartasz. Ha a terv egy lépése hibás \
                 vagy megvalósíthatatlan, térj el tőle, és a végén írd meg, miben és miért. \
                 A checklistet mindig az ebben a promptban kapott aktuális tervből építsd fel; \
                 korábbi menetből megmaradt todo-listát ne folytass. \
                 Az eredeti feladat és a futás közben elfogadott üzenetek minden pontos \
                 literálját tartsd be: fájlnév, fájltartalom, parancs, kötelező első sor és \
                 kért ellenőrző token karakterpontosan teljesüljön. \
                 Futtasd le az érintett teszteket, és az eredményt írd bele az \
                 összefoglalóba. A saját változtatásaidból származó elkerülhető warningot, \
                 hibás karakterkódolást vagy generált cache-fájlt ne hagyd kész állapotban. \
                 A végén röviden foglald össze, mit változtattál."
            }
            Self::Review => {
                "Te vagy a bíráló, és NEM te írtad ezt a kódot. Fájlt nem módosíthatsz. \
                 A munkádat vedd fel todo-listaként (3-5 pont: az eredeti feladat \
                 követelményeinek ellenőrzése, változások átnézése, tesztek futtatása, \
                 hibautak vizsgálata, verdikt), és munka közben tartsd karban — a felület \
                 ebből mutatja, hol tartasz. \
                 ELŐSZÖR az EREDETI FELADAT ellen ellenőrizz, és csak utána a terv ellen: \
                 vedd sorra a feladat számszerű követelményeit (tartományok, \
                 mértékegységek, darabszámok, nevesített értékek), és mindegyiket vesd \
                 össze azzal, ami ténylegesen megvalósult. Ha a terv tér el a feladattól, \
                 az is hiba — a terv nem menti fel a megvalósítást. \
                 Ezután a diff és a tesztek alapján vizsgáld: helyes-e, megvalósult-e \
                 minden tervezett lépés, van-e nem kezelt hibaút vagy mellékhatás, és \
                 szerepel-e ugyanez a hiba máshol is. Ha tudsz parancsot futtatni, \
                 ellenőrizd a teszteket magad, és a megállapításaidat bizonyítékra \
                 alapozd, ne feltételezésre. Az elkerülhető teszt/compiler warning, \
                 felhasználói kimenetben látható hibás karakterkódolás és véletlenül \
                 bekerült cache/build artifact valódi minőségi hiba; ne nevezd a futást \
                 fenntartás nélkül zöldnek, amíg ilyen maradt. Ha a felhasználó pontos \
                 első sort, checklist-elemet vagy PASS/FAIL tokent kért, azt az előírt \
                 helyen karakterpontosan add vissza, és a verdikt indoklásában is nevezd meg. \
                 Az utolsó sorod pontosan ez legyen: \
                 `VERDIKT: ELFOGAD` vagy `VERDIKT: JAVÍTANDÓ`, utána egyetlen mondat \
                 indoklás."
            }
        }
    }
}

/// The stage whose artifact is the user-facing output of a recipe, and the
/// stage from which a rejected review can be resumed. These are deliberately
/// separate from `StageRole`: a recipe may have a plan review without ever
/// having a coding stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipeBoundaryRole {
    Plan,
    Code,
}

impl Default for RecipeBoundaryRole {
    fn default() -> Self {
        Self::Code
    }
}

impl RecipeBoundaryRole {
    fn stage_role(self) -> StageRole {
        match self {
            Self::Plan => StageRole::Plan,
            Self::Code => StageRole::Code,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipeReviewTarget {
    Plan,
    Implementation,
}

impl Default for RecipeReviewTarget {
    fn default() -> Self {
        Self::Implementation
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeStage {
    pub role: StageRole,
    pub provider: AgentProvider,
    pub runtime: AgentRuntimeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_profile: Option<AgentAccessProfile>,
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
    /// Which artifact the VÁLASZ tab and file summary should foreground.
    #[serde(default)]
    pub output_role: RecipeBoundaryRole,
    /// Which stage a rejected review reruns first.
    #[serde(default)]
    pub retry_from_role: RecipeBoundaryRole,
    /// Whether the final verdict evaluates the plan or the implementation.
    #[serde(default)]
    pub review_target: RecipeReviewTarget,
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
        if !self
            .stages
            .iter()
            .any(|stage| stage.role == self.output_role.stage_role())
        {
            return Err("A recept kimeneti szerepe nincs benne a szakaszokban.".to_string());
        }
        if !self
            .stages
            .iter()
            .any(|stage| stage.role == self.retry_from_role.stage_role())
        {
            return Err("A recept újrafuttatási szerepe nincs benne a szakaszokban.".to_string());
        }
        let review_role = match self.review_target {
            RecipeReviewTarget::Plan => StageRole::PlanReview,
            RecipeReviewTarget::Implementation => StageRole::Review,
        };
        if !self.stages.iter().any(|stage| stage.role == review_role) {
            return Err("A recept bírálati céljához nincs megfelelő review szakasz.".to_string());
        }
        for (index, stage) in self.stages.iter().enumerate() {
            match stage.role {
                StageRole::PlanReview
                    if !self.stages[..index]
                        .iter()
                        .any(|s| s.role == StageRole::Plan) =>
                {
                    return Err("A TERV REVIEW csak TERV után állhat.".to_string());
                }
                StageRole::Review
                    if !self.stages[..index]
                        .iter()
                        .any(|s| s.role == StageRole::Code) =>
                {
                    return Err("A kód REVIEW csak KÓD után állhat.".to_string());
                }
                _ => {}
            }
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
        access_profile: Some(AgentAccessProfile::Claude),
        model: Some(model.to_string()),
        effort: Some(effort.to_string()),
        max_turns: Some(max_turns),
    };
    let codex = |role: StageRole, model: &str, effort: &str, max_turns: u32| RecipeStage {
        role,
        provider: AgentProvider::Codex,
        runtime: AgentRuntimeKind::CodexAppServer,
        access_profile: None,
        model: Some(model.to_string()),
        effort: Some(effort.to_string()),
        max_turns: Some(max_turns),
    };
    vec![
        Recipe {
            id: "plan_code_review".to_string(),
            label: "Terv → Kód → Review".to_string(),
            stages: vec![
                // Medium on both working stages: `max` on the planner bought
                // deliberation the plan rarely needed and paid for it in minutes
                // per run, and the two stages that produce the work should reason
                // at the same level rather than one straining while the other
                // coasts.
                claude(StageRole::Plan, "claude-opus-5", "medium", 15),
                // A kódoló körönként eszközt hív: a lépéskövetés (TaskUpdate a
                // lépés előtt és után) minden tervpontnál új köröket jelent, mellé az
                // olvasás, szerkesztés, tesztfuttatás. A 40 valódi feladaton
                // rendre elfogyott — a szakasz „Reached maximum number of turns"
                // hibával halt meg, és a kész munka visszagördült. A 120 továbbra
                // is elszabadulás-védelem, nem munkaplafon.
                claude(StageRole::Code, "claude-opus-5", "medium", 120),
                // A bíráló ugyanúgy checklistet vezet (TaskCreate/TaskUpdate), és
                // fájlt olvas, tesztet futtat — a 15 kör a könyvelésre is kevés
                // volt, és a szakasz „Reached maximum number of turns (15)"-tel
                // halt meg. A limit itt is elszabadulás-védelem, nem munkaplafon.
                codex(StageRole::Review, "gpt-5.6-sol", "medium", 120),
            ],
            output_role: RecipeBoundaryRole::Code,
            retry_from_role: RecipeBoundaryRole::Code,
            review_target: RecipeReviewTarget::Implementation,
        },
        Recipe {
            id: "plan_review".to_string(),
            label: "Terv → Terv review".to_string(),
            stages: vec![
                claude(StageRole::Plan, "claude-opus-5", "medium", 15),
                codex(StageRole::PlanReview, "gpt-5.6-sol", "medium", 120),
            ],
            output_role: RecipeBoundaryRole::Plan,
            retry_from_role: RecipeBoundaryRole::Plan,
            review_target: RecipeReviewTarget::Plan,
        },
    ]
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
    stage_prompt_with_comments(role, original_prompt, artifacts, feedback, None)
}

/// Builds a retry prompt while keeping the reviewer objection and the user's
/// own notes in separate, explicit blocks. Both are delivered only to the
/// first stage of the resumed chain; the later reviewer inspects the produced
/// result rather than being anchored by the user's wording.
pub fn stage_prompt_with_comments(
    role: StageRole,
    original_prompt: &str,
    artifacts: &[StageArtifact],
    feedback: Option<&str>,
    user_comments: Option<&str>,
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

    if let Some(comments) = user_comments.map(str::trim).filter(|value| !value.is_empty()) {
        prompt.push_str("\n[FELHASZNÁLÓI MEGJEGYZÉSEK]\n");
        prompt.push_str(
            "A felhasználó az újrafuttatáshoz ezeket a kiegészítő szempontokat adta. Vedd figyelembe őket, de ne tekintsd őket a bíráló verdiktjének:\n",
        );
        prompt.push_str(&truncated(comments, MAX_ARTIFACT_CHARS));
        prompt.push('\n');
    }

    prompt.push_str("[SZEREP]\n");
    prompt.push_str(role.instruction());
    prompt.push_str(
        "\n\n[NYELV ÉS STÍLUS]\n\
         A felhasználó nyelvén válaszolj. Magyar kérésnél természetes, műszaki magyar \
         megfogalmazást használj; ne találj ki szó szerinti, idegenül hangzó magyar \
         címkéket belső angol fogalmak fordítására. Legyél tömör, de a bizonyítékokat \
         és a szükséges mérnöki részleteket ne hagyd el. Küldés előtt olvasd át a \
         felhasználónak szánt szöveget elütések, értelmetlen szóösszetételek és \
         fölösleges ismétlés szempontjából.",
    );
    prompt.push_str("\n\n[STRICT STEP TRACKING PROTOCOL]\n");
    match role {
        StageRole::Code => prompt.push_str(
            "Before the first workspace action, create the complete checklist from the numbered plan. ",
        ),
        StageRole::Review => prompt.push_str(
            "Create the complete review checklist before the first inspection. Keep exactly one item in_progress at a time, "
        ),
        StageRole::PlanReview => prompt.push_str(
            "Create the complete plan-review checklist before the first inspection. Keep exactly one item in_progress at a time, "
        ),
        StageRole::Plan => prompt.push_str(
            "Do not present internal work as completed plan steps; the numbered plan is the output, not a progress claim. "
        ),
    }
    if matches!(role, StageRole::Code | StageRole::PlanReview | StageRole::Review) {
        prompt.push_str(
            "then update that same item before moving to the next one. Do not jump ahead, go back, or replace the checklist with a different set of work phases. ",
        );
        prompt.push_str(
            "Set exactly one item in_progress before its first tool call; mark it completed immediately after its work; only then set the next item in_progress. The item text must remain the exact plan/review title so the UI can correlate it. ",
        );
    }
    // A felület KaTeX-szel renderel, de csak TeX-jelölést ismer fel. A Codex
    // magától is `\(...\)`-t ír; a Claude Unicode-képleteket adott
    // (`Γ_L·e^(−2j·EL)`), és azok nyers szövegként jelentek meg a
    // GONDOLKODÁS MENETE panelen. Ez a szabály minden szerepre szól, mert a
    // narráció és az összefoglaló is képleteket hordozhat.
    prompt.push_str(
        "\n\n[KÉPLETEK]\n\
         Minden matematikai képletet TeX-jelöléssel írj: szövegközben \\( ... \\), \
         kiemelten önálló sorban \\[ ... \\]. Unicode-képletet ne írj \
         (rossz: Γ_L·e^(−2j·EL), jó: \\( \\Gamma_L e^{-j2\\theta} \\)). \
         A hosszú törteket és a többtagú kifejezéseket \\[ ... \\] blokkba tedd, \
         ne zsúfold őket szövegközi képletbe.",
    );
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
        AgentProvider::Kimi => "Kimi",
        AgentProvider::DeepSeek => "DeepSeek",
    };
    let Some(model) = stage.model.as_deref() else {
        return vendor.to_string();
    };
    let pretty = match model {
        "claude-opus-5" => "Opus 5",
        "claude-opus-4-8" => "Opus 4.8",
        "claude-opus-4-7" => "Opus 4.7",
        "claude-opus-4-6" => "Opus 4.6",
        "claude-fable-5" => "Fable 5",
        "claude-sonnet-5" => "Sonnet 5",
        "kimi-k3" | "k3" => "K3",
        "k3-256k" => "K3 256K",
        "deepseek-v4-flash" => "V4 Flash",
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
    /// Hova írja a futtató a terv-szakasz kimenetét (relatív út a cwd alatt).
    /// A frontend nevezi el (dátum + beszélgetéscím + kör); a tervező modell
    /// maga read-only marad — a fájlt a futtató materializálja.
    #[serde(default)]
    pub plan_file: Option<String>,
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
    /// Regeneration may turn an earlier single answer into a full chain. The
    /// first stage replaces that answer in place; later stages append normally.
    #[serde(default)]
    pub replace_message_id: Option<String>,
    #[serde(default)]
    pub replace_turn_id: Option<String>,
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
    /// Optional notes the user added beside the v2 retry action. Kept separate
    /// from the reviewer's objection so the model can distinguish authority
    /// from additional context.
    #[serde(default)]
    pub user_comments: Option<String>,
    /// Ties the iterations of one question together. The first run leaves this
    /// empty and becomes the chain; every re-run names it.
    #[serde(default)]
    pub chain_id: Option<String>,
    /// 1-based. v1 is the original run, v2 and v3 are the re-runs.
    #[serde(default)]
    pub iteration: Option<i64>,
    /// Accepted mid-run user instructions carried into a resumed/retried run.
    #[serde(default)]
    pub run_inputs: Vec<PipelineRunInput>,
}

/// A planner response is an artifact for the coder, not an ordinary answer.
/// Accept both `1. ...` and markdown-heading `### 1. ...` forms, but never let
/// a direct answer or an inherited old todo-list drive the coding stage.
fn has_numbered_plan_step(text: &str) -> bool {
    text.lines().any(|line| {
        let candidate = line.trim().trim_start_matches('#').trim_start();
        let digit_count = candidate
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .count();
        if digit_count == 0 {
            return false;
        }
        let remainder = &candidate[digit_count..];
        let Some(marker) = remainder.chars().next() else {
            return false;
        };
        if marker != '.' && marker != ')' {
            return false;
        }
        remainder[marker.len_utf8()..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunInput {
    pub input_id: String,
    pub accepted_at_stage: i64,
    pub accepted_at_role: String,
    pub text: String,
    pub accepted_at: String,
    #[serde(default)]
    pub carried: bool,
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
    /// Switching the provider switches the runtime with it; model IDs are not
    /// portable between Codex, Claude, Kimi and DeepSeek.
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub access_profile: Option<AgentAccessProfile>,
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
                stage.access_profile = Some(AgentAccessProfile::Claude);
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
                stage.access_profile = None;
                if stage
                    .model
                    .as_deref()
                    .is_some_and(|model| model.starts_with("claude-"))
                {
                    stage.model = None;
                }
            }
            Some("kimi") => {
                stage.provider = AgentProvider::Kimi;
                stage.runtime = AgentRuntimeKind::CompatibleAgentBridge;
                stage.access_profile = over.access_profile.or_else(|| {
                    if over.model.as_deref() == Some("kimi-k3") {
                        Some(AgentAccessProfile::KimiOpenPlatform)
                    } else {
                        Some(AgentAccessProfile::KimiCode)
                    }
                });
                if stage.model.as_deref().is_some_and(|model| {
                    !matches!(model, "kimi-k3" | "k3" | "k3-256k")
                }) {
                    stage.model = None;
                }
            }
            Some("deepseek") | Some("deepSeek") => {
                stage.provider = AgentProvider::DeepSeek;
                stage.runtime = AgentRuntimeKind::CompatibleAgentBridge;
                stage.access_profile = Some(AgentAccessProfile::DeepSeekApi);
                if stage.model.as_deref() != Some("deepseek-v4-flash") {
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
    pub provider: AgentProvider,
    pub request_id: String,
    pub stage_epoch: u64,
    /// The accepted plan that the coding stage is about to execute. Carrying
    /// it on the progress event avoids a UI race with the separately stored
    /// plan message, especially for valid one-step plans.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_text: Option<String>,
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
    /// The newest plan artifact, when this is the coding stage. This is kept
    /// separate from the composed prompt so the UI does not have to parse an
    /// internal prompt envelope to render the carried plan.
    pub carried_plan: Option<String>,
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
    /// Optional user notes, handed to the same first resumed stage only.
    pub user_comments: Option<String>,
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
        user_comments,
    } = start;
    let mut artifacts = seed_artifacts;
    let mut stages = Vec::<StageRunResult>::new();
    // Keyed by provider, runtime and billing/auth route. Two providers may use
    // the same protocol bridge, but their sessions must never meet; Kimi Code
    // and Kimi Open Platform are separate products as well.
    let mut session_by_runtime = std::collections::HashMap::<String, String>::new();
    if let Some(session) = initial_session {
        if let Some(stage) = recipe.stages.get(start_index) {
            session_by_runtime.insert(
                format!(
                    "{:?}:{:?}:{:?}",
                    stage.provider, stage.runtime, stage.access_profile
                ),
                session,
            );
        }
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
        let runtime_key = format!(
            "{:?}:{:?}:{:?}",
            stage.provider, stage.runtime, stage.access_profile
        );
        let carried_plan = (stage.role == StageRole::Code)
            .then(|| {
                artifacts
                    .iter()
                    .rev()
                    .find(|artifact| artifact.role == StageRole::Plan)
                    .map(|artifact| artifact.text.clone())
            })
            .flatten();
        let execution = StageExecution {
            index,
            stage: stage.clone(),
            prompt: stage_prompt_with_comments(
                stage.role,
                original_prompt,
                &artifacts,
                (index == start_index).then_some(feedback.as_deref()).flatten(),
                (index == start_index)
                    .then_some(user_comments.as_deref())
                    .flatten(),
            ),
            carried_plan,
            // A bíráló nem folytatja a kódoló menetét. Két okból: aki a kódot
            // írta, annak a session-je nem független szem, a bírálandó munkát
            // pedig az artifact-blokk amúgy is átadja. Mellékhatásként a
            // szakasz nem várja meg a kódoló megnőtt session-jének betöltését
            // sem — a Claude-hídnál ez percenkénti nagyságrendű állás volt.
            session_id: (!stage.role.starts_fresh_session())
                .then(|| session_by_runtime.get(&runtime_key).cloned())
                .flatten(),
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
            // Az üzenet megnevezi a szakasz modelljét: „ellenőrizd a modellt"
            // önmagában nem mondja meg, melyiket — a láncban három is van.
            Ok(outcome) if outcome.text.trim().is_empty() => Err(format!(
                "A(z) {} szakasz ({}) üres választ adott. Ellenőrizd a szakaszhoz választott modellt és a provider keretét.",
                stage.role.label(),
                stage.model.as_deref().unwrap_or("nincs megadva modell")
            )),
            Ok(outcome)
                if stage.role == StageRole::Plan
                    && !has_numbered_plan_step(&outcome.text) =>
            {
                Err("A TERV szakasz nem adott számozott tervlépést; a KÓD nem indulhat el megbízható terv nélkül.".to_string())
            }
            other => other,
        };
        match outcome {
            Ok(outcome) => {
                if let Some(session) = outcome.session_id.clone() {
                    session_by_runtime.insert(runtime_key, session);
                }
                let review = stage.role.is_review()
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
        assert_eq!(StageRole::PlanReview.tool_profile(), StageToolProfile::ReadOnly);
        assert_eq!(StageRole::PlanReview.as_wire(), "plan_review");
        assert_eq!(StageRole::Code.tool_profile(), StageToolProfile::Full);
        assert_eq!(
            StageRole::Review.tool_profile(),
            StageToolProfile::Reviewer,
            "the reviewer must be able to run the tests but not to edit"
        );
    }

    #[test]
    fn every_stage_prompt_demands_tex_notation_for_formulas() {
        // A GONDOLKODÁS MENETE KaTeX-szel renderel, és csak TeX-jelölést
        // ismer fel — a Claude e szabály nélkül Unicode-képleteket írt.
        for role in [
            StageRole::Plan,
            StageRole::PlanReview,
            StageRole::Code,
            StageRole::Review,
        ] {
            let prompt = stage_prompt(role, "Feladat.", &[]);
            assert!(prompt.contains("[KÉPLETEK]"));
            assert!(prompt.contains("\\( ... \\)"));
            assert!(prompt.contains("\\[ ... \\]"));
        }
    }

    #[test]
    fn planner_prompt_requires_a_real_numbered_plan_in_natural_user_language() {
        let prompt = stage_prompt(StageRole::Plan, "Ellenőrizd a fájlt.", &[]);
        assert!(prompt.contains("legalább egy számozott tervlépést"));
        assert!(prompt.contains("természetes, műszaki magyar"));
        assert!(prompt.contains("ne a végső választ add meg a terv helyett"));
        assert!(prompt.contains("legelső nem üres sora"));
        assert!(prompt.contains("azonnali végrehajtást"));
    }

    #[test]
    fn numbered_plan_detection_accepts_plain_and_markdown_heading_steps() {
        assert!(has_numbered_plan_step("1. Első lépés"));
        assert!(has_numbered_plan_step("### 1. Első lépés"));
        assert!(has_numbered_plan_step("2) Második lépés"));
        assert!(!has_numbered_plan_step("FOLLOW-UP-MISSING"));
        assert!(!has_numbered_plan_step("## Kockázatok"));
    }

    #[test]
    fn coding_and_review_prompts_require_ordered_explicit_step_tracking() {
        let code = stage_prompt(StageRole::Code, "Feladat.", &[]);
        let plan_review = stage_prompt(StageRole::PlanReview, "Feladat.", &[]);
        let review = stage_prompt(StageRole::Review, "Feladat.", &[]);
        for prompt in [code, plan_review, review] {
            assert!(prompt.contains("STRICT STEP TRACKING PROTOCOL"));
            assert!(prompt.contains("exact plan/review title"));
            assert!(prompt.contains("one item in_progress at a time") || prompt.contains("complete checklist"));
        }
    }

    #[test]
    fn v4_stage_prompts_protect_literal_outputs_and_release_quality() {
        let plan = stage_prompt(StageRole::Plan, "UTÁNA hozz létre egy markert.", &[]);
        assert!(plan.contains("felhasználó saját terminológiáját"));
        assert!(plan.contains("`MOST`, `KÖV. FÁZIS` vagy `UTÁNA`"));

        let code = stage_prompt(StageRole::Code, "A fájl tartalma pontosan OK legyen.", &[]);
        assert!(code.contains("karakterpontosan teljesüljön"));
        assert!(code.contains("elkerülhető warningot"));

        let review = stage_prompt(StageRole::Review, "Az első sor legyen PASS.", &[]);
        assert!(review.contains("PASS/FAIL tokent"));
        assert!(review.contains("hibás karakterkódolás"));
        assert!(review.contains("értelmetlen szóösszetételek"));
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
    fn opus_4_variants_have_the_same_short_labels_as_the_picker() {
        let mut stage = recipe_by_id("plan_code_review")
            .expect("preset")
            .stages
            .remove(0);
        for (model, label) in [
            ("claude-opus-4-8", "Claude · Opus 4.8 · medium"),
            ("claude-opus-4-7", "Claude · Opus 4.7 · medium"),
            ("claude-opus-4-6", "Claude · Opus 4.6 · medium"),
        ] {
            stage.model = Some(model.to_string());
            assert_eq!(stage_agent_label(&stage), label);
        }
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
    fn plan_review_recipe_runs_the_plan_then_a_fresh_plan_review() {
        let recipe = recipe_by_id("plan_review").expect("preset");
        recipe.validate().expect("valid plan review recipe");
        assert_eq!(recipe.stages.len(), 2);
        assert_eq!(recipe.stages[0].role, StageRole::Plan);
        assert_eq!(recipe.stages[1].role, StageRole::PlanReview);
        let recorder = Recorder::with(vec![
            ok("1. Ellenőrizd a követelményeket.", Some("author-session")),
            ok("VERDIKT: ELFOGAD - a terv teljes.", Some("review-session")),
        ]);
        let outcome = recorder.run(&recipe, "Készíts tervet.", None);
        let seen = recorder.seen.borrow();
        assert_eq!(seen.iter().map(|run| run.index).collect::<Vec<_>>(), vec![0, 1]);
        assert!(seen[1].prompt.contains("A tervező terve"));
        assert_eq!(seen[1].session_id, None, "the plan review starts fresh");
        assert_eq!(outcome.stages[1].role, StageRole::PlanReview);
        assert_eq!(
            outcome.stages[1]
                .review
                .as_ref()
                .expect("plan verdict")
                .verdict,
            ReviewVerdict::Accepted
        );
    }

    #[test]
    fn recipe_behavior_metadata_is_stable_on_the_frontend_wire() {
        let full = recipe_by_id("plan_code_review").expect("full preset");
        let plan = recipe_by_id("plan_review").expect("plan review preset");
        assert_eq!(full.output_role, RecipeBoundaryRole::Code);
        assert_eq!(full.retry_from_role, RecipeBoundaryRole::Code);
        assert_eq!(full.review_target, RecipeReviewTarget::Implementation);
        assert_eq!(plan.output_role, RecipeBoundaryRole::Plan);
        assert_eq!(plan.retry_from_role, RecipeBoundaryRole::Plan);
        assert_eq!(plan.review_target, RecipeReviewTarget::Plan);
        let full_json = serde_json::to_value(full).expect("full recipe json");
        let plan_json = serde_json::to_value(plan).expect("plan recipe json");
        assert_eq!(full_json["outputRole"], "code");
        assert_eq!(full_json["retryFromRole"], "code");
        assert_eq!(full_json["reviewTarget"], "implementation");
        assert_eq!(plan_json["outputRole"], "plan");
        assert_eq!(plan_json["retryFromRole"], "plan");
        assert_eq!(plan_json["reviewTarget"], "plan");
    }

    #[test]
    fn user_comments_are_separate_and_only_reach_the_first_retry_stage() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let seen = std::cell::RefCell::new(Vec::<StageExecution>::new());
        let _ = tauri::async_runtime::block_on(run_stages_from(
            &recipe,
            "Feladat.",
            RunStart {
                start_index: 1,
                seed_artifacts: vec![artifact(StageRole::Plan, "A terv.")],
                feedback: Some("A bíráló kifogása.".to_string()),
                user_comments: Some("A felhasználó kiegészítése.".to_string()),
                ..RunStart::default()
            },
            || false,
            |execution| {
                seen.borrow_mut().push(execution);
                async { ok("Kész.", None) }
            },
        ));
        let seen = seen.borrow();
        assert!(seen[0].prompt.contains("[MIÉRT FUTSZ ÚJRA]"));
        assert!(seen[0].prompt.contains("[FELHASZNÁLÓI MEGJEGYZÉSEK]"));
        assert!(seen[0].prompt.contains("A felhasználó kiegészítése."));
        assert!(!seen[1].prompt.contains("[FELHASZNÁLÓI MEGJEGYZÉSEK]"));
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
    fn coding_execution_carries_even_a_one_step_plan_as_ui_data() {
        let mut recipe = recipe_by_id("plan_code_review").expect("preset");
        recipe.stages.truncate(2);
        let recorder = Recorder::with(vec![
            ok("1. Hordozott tervlepes", Some("plan-session")),
            ok("KÃ©sz.", Some("code-session")),
        ]);

        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();

        assert_eq!(seen[0].carried_plan, None);
        assert_eq!(
            seen[1].carried_plan.as_deref(),
            Some("1. Hordozott tervlepes")
        );
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
            ok("1. terv", Some("claude-session-1")),
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
    fn a_kimi_open_session_never_leaks_into_kimi_code() {
        let recipe = {
            let mut recipe = recipe_by_id("plan_code_review").expect("preset");
            recipe.stages.truncate(2);
            recipe.stages[0].provider = AgentProvider::Kimi;
            recipe.stages[0].runtime = AgentRuntimeKind::CompatibleAgentBridge;
            recipe.stages[0].access_profile = Some(AgentAccessProfile::KimiOpenPlatform);
            recipe.stages[0].model = Some("kimi-k3".to_string());
            recipe.stages[1].provider = AgentProvider::Kimi;
            recipe.stages[1].runtime = AgentRuntimeKind::CompatibleAgentBridge;
            recipe.stages[1].access_profile = Some(AgentAccessProfile::KimiCode);
            recipe.stages[1].model = Some("k3".to_string());
            recipe
        };
        let recorder = Recorder::with(vec![
            ok("1. terv", Some("kimi-open-session")),
            ok("kod", Some("kimi-code-session")),
        ]);

        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();

        assert_eq!(seen[0].session_id, None);
        assert_eq!(
            seen[1].session_id, None,
            "the two Kimi products use different credentials and session stores"
        );
    }

    /// Ugyanazon a futtatón is friss szemmel bírálunk: a kódoló session-jének
    /// folytatása nem független ellenőrzés, és a bírálandó munkát az
    /// artifact-blokk amúgy is átadja.
    #[test]
    fn u1c_the_reviewer_starts_a_fresh_session_even_on_its_own_runtime() {
        let recipe = {
            let mut recipe = recipe_by_id("plan_code_review").expect("preset");
            // Mindhárom szakasz ugyanazon a futtatón: enélkül a bíráló azért
            // nem örökölne session-t, mert más a vendor.
            recipe.stages[2].provider = recipe.stages[1].provider;
            recipe.stages[2].runtime = recipe.stages[1].runtime;
            recipe.stages[2].model = recipe.stages[1].model.clone();
            recipe
        };
        let recorder = Recorder::with(vec![
            ok("1. terv", Some("claude-session-1")),
            ok("kod", Some("claude-session-1")),
            ok("VERDIKT: ELFOGAD - rendben.", Some("claude-session-1")),
        ]);
        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();

        assert_eq!(
            seen[1].session_id.as_deref(),
            Some("claude-session-1"),
            "a kódoló folytatja a tervező menetét"
        );
        assert_eq!(
            seen[2].session_id, None,
            "a bíráló friss session-nel indul, akkor is, ha ugyanaz a futtató"
        );
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
            ok("1. A TERVEM: olvasd a math.js-t", None),
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
            ok("1. terv", None),
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
        assert!(outcome.stages[0].succeeded && outcome.stages[0].text == "1. terv");
        assert!(!outcome.stages[1].succeeded);
    }

    #[test]
    fn a_direct_planner_answer_cannot_launch_the_coding_stage() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![
            ok("FOLLOW-UP-MISSING", None),
            ok("ez nem futhat le", None),
        ]);
        let outcome = recorder.run(&recipe, "Ellenőrizd a markerfájlt.", None);

        assert_eq!(recorder.seen.borrow().len(), 1);
        assert_eq!(outcome.status, RunStatus::Failed);
        assert_eq!(outcome.stages.len(), 1);
        assert!(!outcome.stages[0].succeeded);
        assert!(
            outcome
                .error
                .as_deref()
                .is_some_and(|message| message.contains("nem adott számozott tervlépést")),
        );
    }

    #[test]
    fn u6_only_the_first_stage_carries_the_original_attachments() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        // Every stage has to answer something, or the chain stops before the
        // later stages this test is about.
        let recorder = Recorder::with(vec![ok("1. terv", None), ok("kod", None), ok("review", None)]);
        recorder.run(&recipe, "Feladat.", None);
        let seen = recorder.seen.borrow();
        assert!(seen[0].is_first);
        assert!(!seen[1].is_first && !seen[2].is_first);
    }

    #[test]
    fn u7_a_review_asking_for_changes_still_completes_the_run() {
        let recipe = recipe_by_id("plan_code_review").expect("preset");
        let recorder = Recorder::with(vec![
            ok("1. terv", None),
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
            ok("1. terv", None),
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
            ok("1. terv", None),
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
        let recorder = Recorder::with(vec![ok("1. terv", None), ok("kod", None)]);
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
                    access_profile: None,
                },
                StageOverride::default(),
                StageOverride {
                    model: None,
                    effort: None,
                    provider: Some("anthropic".to_string()),
                    access_profile: None,
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
                access_profile: None,
            }],
        );
        assert_eq!(recipe.stages[0].provider, AgentProvider::Codex);
        assert_eq!(
            recipe.stages[0].model, None,
            "a Claude model id would fail on the Codex app-server at send time"
        );
    }

    #[test]
    fn provider_overrides_select_the_matching_external_profile() {
        let mut recipe = recipe_by_id("plan_code_review").expect("preset");
        apply_stage_overrides(
            &mut recipe,
            &[
                StageOverride {
                    model: Some("kimi-k3".to_string()),
                    effort: Some("max".to_string()),
                    provider: Some("kimi".to_string()),
                    access_profile: Some(AgentAccessProfile::KimiOpenPlatform),
                },
                StageOverride {
                    model: Some("deepseek-v4-flash".to_string()),
                    effort: Some("high".to_string()),
                    provider: Some("deepseek".to_string()),
                    access_profile: Some(AgentAccessProfile::DeepSeekApi),
                },
            ],
        );

        assert_eq!(recipe.stages[0].provider, AgentProvider::Kimi);
        assert_eq!(
            recipe.stages[0].access_profile,
            Some(AgentAccessProfile::KimiOpenPlatform)
        );
        assert_eq!(recipe.stages[0].model.as_deref(), Some("kimi-k3"));
        assert_eq!(recipe.stages[0].effort.as_deref(), Some("max"));
        assert_eq!(recipe.stages[1].provider, AgentProvider::DeepSeek);
        assert_eq!(
            recipe.stages[1].access_profile,
            Some(AgentAccessProfile::DeepSeekApi)
        );
        assert_eq!(
            recipe.stages[1].runtime,
            AgentRuntimeKind::CompatibleAgentBridge
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
            output_role: RecipeBoundaryRole::Code,
            retry_from_role: RecipeBoundaryRole::Code,
            review_target: RecipeReviewTarget::Implementation,
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
                user_comments: None,
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
