//! Answer shaping for the Claude `AskUserQuestion` tool.
//!
//! The Agent SDK requires the `answers` record to be keyed by each question's
//! full `question` text, with the selected option's `label` as the value. A
//! record keyed by anything else (the short `header`, for example) is silently
//! ignored and the model is told "no answer provided" — the user's selection
//! disappears with no error anywhere. This module normalizes whatever the client
//! sent into the shape the SDK actually reads, so a key mismatch degrades into a
//! correct answer instead of a lost one.

function questionList(input) {
  const questions = input?.questions;
  return Array.isArray(questions) ? questions : [];
}

function isUsableAnswer(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

/**
 * Builds the SDK-shaped `answers` record.
 *
 * Lookup order per question: the exact `question` text, then the `header`, then
 * — when the client sent exactly one answer for exactly one question — the sole
 * value regardless of its key.
 *
 * @returns {{answers: Record<string, unknown>, response?: string}}
 */
export function normalizeQuestionAnswers(input, clientAnswer) {
  const questions = questionList(input);
  const source = clientAnswer && typeof clientAnswer === "object" && !Array.isArray(clientAnswer) ? clientAnswer : {};

  // A freeform reply that answers no specific question is a separate SDK field.
  const response = typeof source.response === "string" && source.response.trim() ? source.response.trim() : null;

  const keys = Object.keys(source).filter((key) => key !== "response");
  const answers = {};

  for (const question of questions) {
    const text = typeof question?.question === "string" ? question.question : null;
    if (!text) continue;
    const header = typeof question?.header === "string" ? question.header : null;

    let value;
    if (isUsableAnswer(source[text])) {
      value = source[text];
    } else if (header && isUsableAnswer(source[header])) {
      value = source[header];
    } else if (questions.length === 1 && keys.length === 1 && isUsableAnswer(source[keys[0]])) {
      // Single question, single answer: the key cannot be ambiguous.
      value = source[keys[0]];
    }

    if (value === undefined) continue;
    // Multi-select answers travel as a comma-joined string, per the SDK docs.
    answers[text] = Array.isArray(value) ? value.join(", ") : value;
  }

  return response ? { answers, response } : { answers };
}

/**
 * True when the normalized result carries something the model can act on.
 * An empty record means the turn should be denied rather than resumed with a
 * silently blank answer.
 */
export function hasAnswer({ answers, response }) {
  if (typeof response === "string" && response.trim()) return true;
  return Boolean(answers) && Object.keys(answers).length > 0;
}
