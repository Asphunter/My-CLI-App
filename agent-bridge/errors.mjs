export function classifyConnectionError(message) {
  const text = String(message ?? "").toLowerCase();
  if (
    /missing.*(?:api.?key|key)|(?:api.?key|anthropic_api_key).*(?:missing|not set|not configured)|nincs.*api.?kulcs/.test(
      text,
    )
  ) {
    return "missing_api_key";
  }
  if (/401|unauthori[sz]ed|invalid x-api-key|invalid api key|authentication/.test(text)) {
    return "unauthorized";
  }
  if (/402|payment|billing|credit|balance/.test(text)) return "billing";
  if (/429|rate.?limit|too many requests/.test(text)) return "rate_limited";
  if (/max[_ -]?budget|budget.?exceed|budget/.test(text)) return "budget_exceeded";
  if (/max[_ -]?turns|turns?\s+(?:limit|max)|turn[_ -]?limit/.test(text)) {
    return "turn_limit";
  }
  if (/timeout|timed out|time.?out|idle|id.{0,4}t.{0,6}ll/.test(text)) return "timeout";
  if (/cancel|abort|megszak/.test(text)) return "cancelled";
  if (/bridge.*(?:closed|crash|exit|lez)|connection.*closed|eof|epipe/.test(text)) {
    return "bridge_crashed";
  }
  if (/\b5\d{2}\b|service unavailable|internal server/.test(text)) {
    return "server_error";
  }
  return "connection_failed";
}
