export const DETAILED_ANSWER_MIN_HEIGHT = 140;
export const DETAILED_ANSWER_MAX_HEIGHT = 320;
/** A húzókák alsó korlátai — ugyanaz a két szám, mint a Nem-Részletes kártyán. */
export const DETAILED_ANSWER_MIN_WIDTH = 260;
export const DETAILED_STEPS_MIN_WIDTH = 240;

/**
 * How tall the grid row must be for this answer — its `min-height`, not the
 * answer lane's ceiling. The cap says how much the answer may demand *on its
 * own*; when the steps or files lane is taller, the answer lane follows the
 * row (`height: 100%`) and uses all of it. Capping the lane itself left the
 * answer scrolling at 320px with dead space below it in a 420px row.
 */
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
