export type AgentErrorCode =
  | "missing_api_key"
  | "unauthorized"
  | "billing"
  | "rate_limited"
  | "server_error"
  | "budget_exceeded"
  | "turn_limit"
  | "timeout"
  | "cancelled"
  | "bridge_crashed"
  | "workspace_busy"
  | "connection_failed"
  | "unknown";

export type AgentErrorDescription = {
  code: AgentErrorCode;
  detail: string;
  userMessage: string;
  notification: string;
};

const knownCodes = new Set<AgentErrorCode>([
  "missing_api_key",
  "unauthorized",
  "billing",
  "rate_limited",
  "server_error",
  "budget_exceeded",
  "turn_limit",
  "timeout",
  "cancelled",
  "bridge_crashed",
  "workspace_busy",
  "connection_failed",
  "unknown",
]);

const safeDetail = (value: unknown) =>
  String(value ?? "")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(anthropic_api_key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1200);

const normalizeCode = (value: unknown): AgentErrorCode | undefined => {
  const code = String(value ?? "").trim().toLowerCase() as AgentErrorCode;
  return knownCodes.has(code) ? code : undefined;
};

const codeFromErrorText = (text: string): AgentErrorCode => {
  const lower = text.toLowerCase();
  if (/missing.*(?:api.?key|key)|api.?key.*(?:missing|not set|not configured)/.test(lower))
    return "missing_api_key";
  if (/401|unauthori[sz]ed|invalid x-api-key|invalid api key|authentication/.test(lower))
    return "unauthorized";
  if (/402|payment|billing|credit|balance/.test(lower)) return "billing";
  if (/429|rate.?limit|too many requests/.test(lower)) return "rate_limited";
  if (/max[_ -]?budget|budget.?exceed|budget/.test(lower)) return "budget_exceeded";
  if (/max[_ -]?turns|turns?\s+(?:limit|max)|turn[_ -]?limit/.test(lower))
    return "turn_limit";
  if (/timeout|timed out|time.?out|idle/.test(lower)) return "timeout";
  if (/cancel|abort|megszak/.test(lower)) return "cancelled";
  // Szűken csak a foglaltság: egy előző futás lezárása még dolgozik a
  // projekten. A teendő is más — várni kell, nem újraindítani. Minden más
  // guard-hiba (hiányzó fájl, hash-eltérés) marad a maga saját üzenetével,
  // mert azokra a „várj egy kicsit" tanács hazugság lenne.
  if (/munkaterület(?:én)?\s+még|workspace\s+is\s+busy|lezárása dolgozik/.test(lower))
    return "workspace_busy";
  if (/bridge.*(?:closed|crash|exit)|connection.*closed|eof|epipe/.test(lower))
    return "bridge_crashed";
  if (/\b5\d{2}\b|service unavailable|internal server/.test(lower))
    return "server_error";
  return "connection_failed";
};

const labelFor = (code: AgentErrorCode, provider: string) => {
  const name = provider.trim() || "agent";
  switch (code) {
    case "missing_api_key":
      return `${name} API-kulcs nincs beállítva.`;
    case "unauthorized":
      return `${name} API-kulcsa hibás vagy vissza lett vonva.`;
    case "billing":
      return `${name} fiókjának kreditje vagy számlázása nem engedi a kérést.`;
    case "rate_limited":
      return `${name} rate limitet jelzett; próbáld újra később.`;
    case "server_error":
      return `${name} szolgáltatása átmenetileg nem elérhető.`;
    case "budget_exceeded":
      return `A ${name}-turn elérte a beállított költségkeretet.`;
    case "turn_limit":
      return `A ${name}-turn elérte a maximális lépésszámot.`;
    case "timeout":
      return `A ${name}-kérés időtúllépés miatt leállt.`;
    case "cancelled":
      return `A ${name}-kérés megszakadt.`;
    case "bridge_crashed":
      return `A ${name}-bridge leállt; indítsd újra a kérést.`;
    case "workspace_busy":
      return "A projekt munkaterületén még egy előző futás lezárása dolgozik.";
    case "connection_failed":
      return `A ${name}-kérés nem sikerült.`;
    case "unknown":
      return `Ismeretlen ${name}-hiba történt.`;
  }
};

export const describeAgentError = (
  code: unknown,
  detail: unknown,
  provider = "Claude",
): AgentErrorDescription => {
  const safe = safeDetail(detail);
  const normalized = normalizeCode(code) ?? codeFromErrorText(safe);
  const label = labelFor(normalized, provider);
  // Ha a hibát nem ismertük fel, a címke semmit nem mond ("a kérés nem
  // sikerült"), és az egyetlen kapaszkodó — a natív üzenet — pont elveszne.
  // Ilyenkor az kerül a felhasználó elé is.
  const unrecognized = normalized === "connection_failed" || normalized === "unknown";
  const userMessage = unrecognized && safe ? `${label} ${safe}` : label;
  return {
    code: normalized,
    detail: safe || label,
    userMessage,
    notification: `${provider}: ${userMessage}`,
  };
};

export const describeThrownAgentError = (
  error: unknown,
  provider = "Claude",
) => {
  const detail = safeDetail(error);
  const code = detail.match(/\[([a-z0-9_-]+)\]/i)?.[1];
  return describeAgentError(code, detail, provider);
};
