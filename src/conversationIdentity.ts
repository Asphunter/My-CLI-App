export const ensureCanonicalConversationId = (
  existingId: string | null | undefined,
  createId: () => string,
) => {
  const normalized = existingId?.trim();
  return normalized || createId();
};
