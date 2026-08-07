export type RegenerationRequestSettings<
  Provider extends string,
  AccessProfile extends string,
> = {
  provider: Provider;
  accessProfile: AccessProfile | null;
  model: string | null;
  effort: string;
};

/**
 * Részletes válasznál a felhasználó a fázis railjén vált modellt. Egy sima
 * újragenerálás viszont már egyetlen agent-turn, ezért külön snapshotban kell
 * áthoznunk a látható fázis választását a kompakt futásba.
 */
export const resolveRegenerationRequestSettings = <
  Provider extends string,
  AccessProfile extends string,
>(
  compact: RegenerationRequestSettings<Provider, AccessProfile>,
  visibleStage?: RegenerationRequestSettings<Provider, AccessProfile>,
) => visibleStage ?? compact;
