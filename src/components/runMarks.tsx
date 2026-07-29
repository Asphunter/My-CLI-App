/**
 * A futás jelölése a felületen: pörgő pontok, illetve „mentés" pötty.
 *
 * A fa sorai és a szerkesztő sorbaállítás-jelzője egyaránt ezt használja,
 * ezért egyikükhöz sem tartozhat.
 */
export const TreeRunMark = ({
  state,
  idleClassName,
}: {
  state: "thinking" | "saving" | null;
  idleClassName: string;
}) => {
  if (state === "thinking")
    return <ThinkingDots label="Ebben a beszélgetésben épp fut egy válasz" />;
  if (state === "saving")
    return (
      <span
        className="saving-mark"
        role="status"
        aria-label="A munkaterület mentése folyik"
        title="A válasz kész; a munkaterület mentése folyik"
      />
    );
  return <span className={idleClassName} />;
};

/** „Gondolkodik" jelzés a fában — a pont helyén, ugyanakkora helyen. */
export const ThinkingDots = ({ label }: { label: string }) => (
  <span className="thinking-dots" role="status" aria-label={label} title={label}>
    <span />
    <span />
    <span />
  </span>
);
