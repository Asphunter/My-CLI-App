//! Credential-mode helpers for the Claude bridge.
//!
//! Rust decides the mode and signals it with `MIN_AGENT_AUTH_MODE`. In
//! subscription mode it deliberately withholds `ANTHROPIC_API_KEY`, because a
//! set key overrides the Claude Code login even when the user is signed in; the
//! bundled Agent SDK binary reads that login itself. An absent key is therefore
//! correct in that mode and must not fail the turn.

export const MISSING_CREDENTIALS_MESSAGE =
  "Nincs Claude hitelesítés a bridge környezetében: sem előfizetéses bejelentkezés, sem ANTHROPIC_API_KEY.";

export function isSubscriptionAuth(env = process.env) {
  return env?.MIN_AGENT_AUTH_MODE === "subscription";
}

export function hasCredentials(env = process.env) {
  return isSubscriptionAuth(env) || Boolean(env?.ANTHROPIC_API_KEY);
}

/**
 * Subscription turns are not billed per token, so a USD ceiling has nothing to
 * meter and would only risk stopping a turn on a notional cost. `maxTurns`
 * stays the guard in that mode.
 */
export function budgetOption(maxBudgetUsd, env = process.env) {
  return isSubscriptionAuth(env) ? {} : { maxBudgetUsd };
}
