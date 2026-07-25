export function isMissingRemoteSessionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no conversation found with session id/i.test(message);
}

export function shouldStartFreshSession(resumeSessionId, error) {
  return Boolean(resumeSessionId && isMissingRemoteSessionError(error));
}
