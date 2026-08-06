//! Provider-specific reasoning controls kept pure so latency-sensitive presets
//! can be regression-tested without starting an agent process.

export function reasoningOptionsForProvider(provider, effort) {
  if (provider === "deepseek") {
    if (effort === "none" || effort === "off") {
      return { thinking: { type: "disabled" } };
    }
    const normalized = effort === "max" ? "max" : "high";
    return {
      effort: normalized,
      thinking: {
        type: "enabled",
        // V4 Flash used the full 8k allowance for roughly six silent minutes
        // before the first coding action. High keeps a useful reasoning pass
        // while remaining interactive; Max is still the explicit deep ceiling.
        budgetTokens: normalized === "max" ? 32_768 : 4_096,
      },
    };
  }
  if (provider === "kimi") {
    const normalized = ["low", "high", "max"].includes(effort) ? effort : "high";
    return {
      effort: normalized,
      // K3 is an always-thinking model. Fixed budgets serialize cleanly on
      // Anthropic-compatible routes; the raw adapter maps the selected effort
      // to Kimi's native top-level reasoning_effort.
      thinking: {
        type: "enabled",
        budgetTokens: normalized === "low" ? 4_096 : normalized === "max" ? 32_768 : 16_384,
      },
    };
  }
  return { effort, thinking: { type: "adaptive" } };
}
