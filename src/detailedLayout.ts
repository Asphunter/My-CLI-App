export const DETAILED_ANSWER_MIN_HEIGHT = 140;
export const DETAILED_ANSWER_MAX_HEIGHT = 320;

/** Grow with the answer, but keep the established detailed-panel ceiling. */
export const detailedAnswerPanelHeight = (
  contentHeight: number,
  verticalPadding: number,
) =>
  Math.min(
    DETAILED_ANSWER_MAX_HEIGHT,
    Math.max(
      DETAILED_ANSWER_MIN_HEIGHT,
      Math.ceil(
        (Number.isFinite(contentHeight) ? Math.max(0, contentHeight) : 0) +
          (Number.isFinite(verticalPadding) ? Math.max(0, verticalPadding) : 0),
      ),
    ),
  );
