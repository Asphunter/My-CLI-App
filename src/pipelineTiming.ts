export type PipelineStageTiming = {
  startedAt?: number;
  completedAt?: number;
};

const finiteTimestamp = (value: number | undefined): value is number =>
  Number.isFinite(value);

/** Preserve the widest known interval when local, journal, and sync rows meet. */
export const mergePipelineStageTiming = (
  left: PipelineStageTiming = {},
  right: PipelineStageTiming = {},
): PipelineStageTiming => {
  const starts = [left.startedAt, right.startedAt].filter(finiteTimestamp);
  const ends = [left.completedAt, right.completedAt].filter(finiteTimestamp);
  return {
    startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
    completedAt: ends.length > 0 ? Math.max(...ends) : undefined,
  };
};

/**
 * Exact chain bounds only. Historical rows without a completion timestamp must
 * stay unknown: inventing an end from message order made old runs read 0:00.
 */
export const pipelineChainTimingBounds = (
  stages: PipelineStageTiming[],
): PipelineStageTiming => {
  const starts = stages.map((stage) => stage.startedAt).filter(finiteTimestamp);
  const ends = stages.map((stage) => stage.completedAt).filter(finiteTimestamp);
  return {
    startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
    completedAt: ends.length > 0 ? Math.max(...ends) : undefined,
  };
};
