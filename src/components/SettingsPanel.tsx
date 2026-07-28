/**
 * Oldalsáv-beállítások: betűméret, sorköz, projektgyökér.
 *
 * A panel semmit nem tud az alkalmazásról — értékeket kap és visszahívásokat
 * hív. (A `RetentionSettingsSection` szándékosan maradt az App.tsx-ben: ma
 * nincs bekötve sehová, és a sync-típusfa fele kellene hozzá.)
 */
export function SidebarSettingsPanel({
  fontSize,
  lineHeight,
  readingSettingsOpen,
  canChangeProjectsRoot,
  onToggleReadingSettings,
  onFontSizeChange,
  onLineHeightChange,
  onChangeProjectsRoot,
  onNotify,
}: {
  fontSize: string;
  lineHeight: string;
  readingSettingsOpen: boolean;
  canChangeProjectsRoot: boolean;
  onToggleReadingSettings: () => void;
  onFontSizeChange: (value: string) => void;
  onLineHeightChange: (value: string) => void;
  onChangeProjectsRoot: () => void;
  onNotify: (message: string) => void;
}) {
  return (
    <div className="settings-popover sidebar-settings-popover">
      <button
        type="button"
        className="settings-option"
        aria-expanded={readingSettingsOpen}
        onClick={() => onToggleReadingSettings()}
      >
        <span>
          <strong>Megjelenítés</strong>
        </span>
        <span aria-hidden="true">
          {readingSettingsOpen ? "⌃" : "⌄"}
        </span>
      </button>
      {readingSettingsOpen && (
        <div className="settings-subpanel">
          <label className="range-row">
            <span>Betűméret</span>
            <output>{fontSize}</output>
            <input
              type="range"
              min="8"
              max="17"
              value={parseInt(fontSize, 10)}
              onChange={(event) =>
                onFontSizeChange(`${event.target.value}px`)
              }
            />
          </label>
          <label className="range-row">
            <span>Sorköz</span>
            <output>{lineHeight}</output>
            <input
              type="range"
              min="100"
              max="180"
              value={Math.round(parseFloat(lineHeight) * 100)}
              onChange={(event) =>
                onLineHeightChange(
                  (Number(event.target.value) / 100).toFixed(2),
                )
              }
            />
          </label>
          <button
            type="button"
            className="reset-button"
            onClick={() => {
              onFontSizeChange("10px");
              onLineHeightChange("1.00");
              onNotify("Olvasási beállítások visszaállítva");
            }}
          >
            Alapértékek visszaállítása
          </button>
        </div>
      )}
      <button
        type="button"
        className="settings-option"
        disabled={!canChangeProjectsRoot}
        onClick={onChangeProjectsRoot}
      >
        <span>
          <strong>Mappa</strong>
        </span>
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
