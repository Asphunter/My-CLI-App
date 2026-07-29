/**
 * Az oldalsáv: projektfa, GENERAL előzmények, sync-lábléc, beállítások.
 *
 * Sok bemenete van, mert tényleg sok mindent mutat — de mind névvel érkezik.
 * A fa nem éri el sem a beszélgetés-cache-t, sem a futás-táblát: amit tudnia
 * kell (fut-e egy sor, gondolkodik-e egy projekt), függvényként kapja.
 */
import { SidebarSettingsPanel } from "./SettingsPanel";
import { ThinkingDots, TreeRunMark } from "./runMarks";
import {
  formatSyncHealthTime,
  syncHealthStatusLabel,
  syncTombstoneProjectContext,
  syncTombstoneTypeLabel,
} from "../syncFormat";
import type { AppMode } from "../conversationScope";

/** A fa rendezési módjai; a hívó ugyanezt a szűk halmazt használja. */
export type SidebarSortMode = "modified" | "time";

export type SidebarProject = {
  id: string;
  name: string;
  path: string;
  relativePath: string | null;
  threads: string[];
};

/**
 * Amennyit az előzménylista a beszélgetésből mutat. A műveletek visszaadják
 * ugyanezt az objektumot, ezért generikus: a hívó a saját, teljesebb
 * rekordját kapja vissza.
 */
export type SidebarConversation = {
  id?: string;
  title: string;
  updatedAt: string;
};

export type SidebarMenu = { kind: "project" | "thread" | "general"; key: string } | null;

export type SidebarTombstone = {
  entityType: string;
  entityId: string;
  archivedAt: string;
  projectId?: string | null;
  title?: string | null;
  relativePath?: string | null;
  pathHint?: string | null;
};

/** Amennyit a lábléc a sync egészségéből megmutat. */
export type SidebarSyncHealth = {
  status: string;
  journalPath: string;
  quarantinePath: string;
  checkedAt: string;
  lastImportAt: string | null;
  scannedEvents: number;
  acceptedEvents: number;
  importedEvents: number;
  storedEvents: number;
  blockedDevices: string[];
  warnings: string[];
  canWrite: boolean;
  recoveryAction: string;
} | null;

export type SidebarProps<Conversation extends SidebarConversation = SidebarConversation> = {
  activeMode: AppMode;
  isTauri: boolean;
  projects: SidebarProject[];
  openProjects: Record<string, boolean>;
  activeProject: string;
  activeThread: string;
  generalConversations: Array<{ conversation: Conversation }>;
  activeGeneralConversationId: string | null;
  historyHydrating: boolean;
  tombstones: SidebarTombstone[];
  restoreBusyKey: string | null;
  treeSortMode: SidebarSortMode;
  treeSortMenuOpen: boolean;
  newProjectMenuOpen: boolean;
  openMenu: SidebarMenu;
  settingsOpen: boolean;
  readingSettingsOpen: boolean;
  fontSize: string;
  lineHeight: string;
  syncStatus: string;
  syncHealth: SidebarSyncHealth;
  syncHealthOpen: boolean;
  syncWriteEnabled: boolean;
  /** Fut-e (vagy ment-e) az adott beszélgetés — a pötty ebből lesz. */
  conversationRunState: (key: string) => "thinking" | "saving" | null;
  projectIsThinking: (project: SidebarProject) => boolean;
  generalConversationCacheKey: (conversationId: string) => string;
  onSelectAppMode: (mode: AppMode) => void;
  onSelectProject: (project: SidebarProject) => void;
  onSelectThread: (project: SidebarProject, thread: string) => void;
  onSelectGeneralConversation: (conversationId: string) => void;
  onToggleProjectOpen: (
    update: (current: Record<string, boolean>) => Record<string, boolean>,
  ) => void;
  onOpenMenu: (update: SidebarMenu) => void;
  onNewConversationForProject: (project: SidebarProject) => void;
  onNewGeneralConversation: () => void;
  onRenameProject: (project: SidebarProject) => void;
  onDeleteProject: (project: SidebarProject) => void;
  onRenameThread: (project: SidebarProject, thread: string) => void;
  onDeleteThread: (project: SidebarProject, thread: string) => void;
  onRenameGeneralConversation: (conversation: Conversation) => void;
  onDeleteGeneralConversation: (conversation: Conversation) => void;
  onRestoreTombstone: (tombstone: SidebarTombstone) => void;
  onAddProject: () => void;
  onAddExistingProject: () => void;
  onChangeProjectsRoot: () => void;
  onRefreshSync: () => void;
  onSetTreeSortMode: (mode: SidebarSortMode) => void;
  onSetTreeSortMenuOpen: (open: boolean) => void;
  onSetNewProjectMenuOpen: (open: boolean) => void;
  onSetSettingsOpen: (update: (open: boolean) => boolean) => void;
  onSetReadingSettingsOpen: (update: (open: boolean) => boolean) => void;
  onSetSyncHealthOpen: (update: (open: boolean) => boolean) => void;
  onFontSizeChange: (value: string) => void;
  onLineHeightChange: (value: string) => void;
  onNotify: (message: string) => void;
};

export function Sidebar<Conversation extends SidebarConversation>({
  activeMode,
  isTauri,
  projects,
  openProjects,
  activeProject,
  activeThread,
  generalConversations,
  activeGeneralConversationId,
  historyHydrating,
  tombstones,
  restoreBusyKey,
  treeSortMode,
  treeSortMenuOpen,
  newProjectMenuOpen,
  openMenu,
  settingsOpen,
  readingSettingsOpen,
  fontSize,
  lineHeight,
  syncStatus,
  syncHealth,
  syncHealthOpen,
  syncWriteEnabled,
  conversationRunState,
  projectIsThinking,
  generalConversationCacheKey,
  onSelectAppMode,
  onSelectProject,
  onSelectThread,
  onSelectGeneralConversation,
  onToggleProjectOpen,
  onOpenMenu,
  onNewConversationForProject,
  onNewGeneralConversation,
  onRenameProject,
  onDeleteProject,
  onRenameThread,
  onDeleteThread,
  onRenameGeneralConversation,
  onDeleteGeneralConversation,
  onRestoreTombstone,
  onAddProject,
  onAddExistingProject,
  onChangeProjectsRoot,
  onRefreshSync,
  onSetTreeSortMode,
  onSetTreeSortMenuOpen,
  onSetNewProjectMenuOpen,
  onSetSettingsOpen,
  onSetReadingSettingsOpen,
  onSetSyncHealthOpen,
  onFontSizeChange,
  onLineHeightChange,
  onNotify,
}: SidebarProps<Conversation>) {
  return (
    <aside
      className={`sidebar panel-edge${activeMode === "general" ? " is-general" : ""}`}
    >
      <div className="sidebar-heading">
        <span>Projektek</span>
        <div className="sidebar-heading-actions">
          <div className="tree-sort-wrap">
            <button
              type="button"
              className="tree-sort-button"
              onClick={() => onSetTreeSortMenuOpen(!treeSortMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={treeSortMenuOpen}
              aria-label="Tree rendezése"
              title={`Rendezés: ${treeSortMode === "modified" ? "módosítás szerint" : "idő szerint"}`}
            >
              ↕
            </button>
            {treeSortMenuOpen && (
              <div className="tree-sort-menu" role="menu">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={treeSortMode === "modified"}
                  className={treeSortMode === "modified" ? "is-selected" : ""}
                  onClick={() => {
                    onSetTreeSortMode("modified");
                    onSetTreeSortMenuOpen(false);
                  }}
                >
                  Módosítás szerint
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={treeSortMode === "time"}
                  className={treeSortMode === "time" ? "is-selected" : ""}
                  onClick={() => {
                    onSetTreeSortMode("time");
                    onSetTreeSortMenuOpen(false);
                  }}
                >
                  Idő szerint
                </button>
              </div>
            )}
          </div>
          {activeMode === "general" ? (
          <button
            type="button"
            className="new-button"
            onClick={onNewGeneralConversation}
            aria-label="Új beszélgetés"
            title="Új beszélgetés"
          >
            +
          </button>
        ) : (
          <div className="new-project-wrap">
          <button
            type="button"
            className="new-button"
            onClick={() => onSetNewProjectMenuOpen(!newProjectMenuOpen)}
            aria-haspopup="menu"
            aria-expanded={newProjectMenuOpen}
            title="Projekt hozzáadása"
          >
            +
          </button>
          {newProjectMenuOpen && (
            <div className="new-project-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSetNewProjectMenuOpen(false);
                  onAddProject();
                }}
              >
                Új projekt
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSetNewProjectMenuOpen(false);
                  onAddExistingProject();
                }}
              >
                Meglévő projekt
              </button>
            </div>
          )}
          </div>
        )}
        </div>
      </div>
      <div className="mode-switch" role="tablist" aria-label="Alkalmazasi mod">
        <button
          type="button"
          role="tab"
          aria-selected={activeMode === "coding"}
          className={activeMode === "coding" ? "is-active" : ""}
          onClick={() => onSelectAppMode("coding")}
        >
          CODING
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeMode === "general"}
          className={activeMode === "general" ? "is-active" : ""}
          onClick={() => onSelectAppMode("general")}
        >
          GENERAL
        </button>
      </div>
      <div className="project-list">
        {historyHydrating && (
          <div className="project-list-loading" role="status">
            Helyi előzmények betöltése…
          </div>
        )}
        {projects.map((project) => {
          const isOpen = Boolean(openProjects[project.path]);
          return (
            <section
              className={`project-group${isOpen ? " is-open" : ""}`}
              data-project={project.name}
              key={project.path}
            >
              <div className="project-row-wrap">
                <button
                  className="project-row"
                  onClick={() => {
                    onSelectProject(project);
                    onToggleProjectOpen((current) => ({
                      ...current,
                      [project.path]: !isOpen,
                    }));
                  }}
                  aria-expanded={isOpen}
                  title={project.path}
                >
                  <span className="chevron">{isOpen ? "⌄" : "›"}</span>
                  <span className="folder-icon">◫</span>
                  <span className="project-name">{project.name}</span>
                  {projectIsThinking(project) && !isOpen && (
                    <ThinkingDots label="Ebben a projektben épp fut egy válasz vagy mentés" />
                  )}
                  <span className="project-count">
                    {project.threads.length}
                  </span>
                </button>
                <div className="overflow-menu-wrap">
                  <button
                    type="button"
                    className="overflow-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenMenu(
                        openMenu?.kind === "project" &&
                          openMenu.key === project.id
                          ? null
                          : { kind: "project", key: project.id },
                      );
                    }}
                    aria-haspopup="menu"
                    aria-expanded={
                      openMenu?.kind === "project" &&
                      openMenu.key === project.id
                    }
                    title="Projekt menüje"
                  >
                    ⋮
                  </button>
                  {openMenu?.kind === "project" &&
                    openMenu.key === project.id && (
                      <div className="overflow-menu" role="menu">
                        <button
                          type="button"
                          onClick={() => {
                            onOpenMenu(null);
                            onNewConversationForProject(project);
                          }}
                        >
                          Új beszélgetés
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenMenu(null);
                            onRenameProject(project);
                          }}
                        >
                          Átnevezés
                        </button>
                        <button
                          type="button"
                          className="danger-action"
                          onClick={() => onDeleteProject(project)}
                        >
                          Törlés
                        </button>
                      </div>
                    )}
                </div>
              </div>
              <div className="conversation-list">
                {project.threads.map((thread) => {
                  const menuKey = `${project.id}::${thread}`;
                  return (
                    <div className="conversation-row-wrap" key={thread}>
                      <button
                        className={`conversation-row${thread === activeThread && project.name === activeProject ? " is-active" : ""}`}
                        onClick={() => onSelectThread(project, thread)}
                        title={thread}
                      >
                        <TreeRunMark
                          state={conversationRunState(
                            `${project.path}/${thread}`,
                          )}
                          idleClassName="conversation-dot"
                        />
                        <span>{thread}</span>
                      </button>
                      <div className="overflow-menu-wrap">
                        <button
                          type="button"
                          className="overflow-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenMenu(
                              openMenu?.kind === "thread" &&
                                openMenu.key === menuKey
                                ? null
                                : { kind: "thread", key: menuKey },
                            );
                          }}
                          aria-haspopup="menu"
                          aria-expanded={
                            openMenu?.kind === "thread" &&
                            openMenu.key === menuKey
                          }
                          title="Beszélgetés menüje"
                        >
                          ⋮
                        </button>
                        {openMenu?.kind === "thread" &&
                          openMenu.key === menuKey && (
                            <div className="overflow-menu" role="menu">
                              <button
                                type="button"
                                onClick={() => {
                                  onOpenMenu(null);
                                  onRenameThread(project, thread);
                                }}
                              >
                                Átnevezés
                              </button>
                              <button
                                type="button"
                                className="danger-action"
                                onClick={() =>
                                  onDeleteThread(project, thread)
                                }
                              >
                                Törlés
                              </button>
                            </div>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className="general-history" aria-label="General beszélgetések">
        {generalConversations.length === 0 ? (
          <div className="general-history-empty">
            A korábbi GENERAL beszélgetések itt jelennek meg.
          </div>
        ) : (
          generalConversations.map(({ conversation }) => {
            const id = conversation.id ?? "";
            return (
              <div className="general-history-row-wrap" key={id}>
                <button
                  type="button"
                  className={`general-history-row${id === activeGeneralConversationId ? " is-active" : ""}`}
                  onClick={() => onSelectGeneralConversation(id)}
                  title={conversation.title}
                >
                  <TreeRunMark
                    state={conversationRunState(
                      generalConversationCacheKey(id),
                    )}
                    idleClassName="general-history-dot"
                  />
                  <span>{conversation.title}</span>
                </button>
                <div className="overflow-menu-wrap">
                  <button
                    type="button"
                    className="overflow-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenMenu(
                        openMenu?.kind === "general" &&
                          openMenu.key === id
                          ? null
                          : { kind: "general", key: id },
                      );
                    }}
                    aria-haspopup="menu"
                    aria-expanded={
                      openMenu?.kind === "general" && openMenu.key === id
                    }
                    title="Beszélgetés menüje"
                  >
                    ⋮
                  </button>
                  {openMenu?.kind === "general" &&
                    openMenu.key === id && (
                      <div className="overflow-menu" role="menu">
                        <button
                          type="button"
                          onClick={() => {
                            onOpenMenu(null);
                            onRenameGeneralConversation(conversation);
                          }}
                        >
                          Átnevezés
                        </button>
                        <button
                          type="button"
                          className="danger-action"
                          onClick={() => onDeleteGeneralConversation(conversation)}
                        >
                          Törlés
                        </button>
                      </div>
                    )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="sidebar-footer">
        <button
          type="button"
          className={`sync-health${syncWriteEnabled ? " is-ready" : " is-quarantine"}`}
          onClick={() => isTauri && onSetSyncHealthOpen((open) => !open)}
          aria-expanded={isTauri ? syncHealthOpen : undefined}
          aria-controls={isTauri ? "sync-health-panel" : undefined}
          title="Részletes Sync Health megnyitása"
        >
          <span className="status-dot" />
          <span>Sync · {syncStatus}</span>
          <span className="sync-health-chevron">
            {isTauri ? (syncHealthOpen ? "⌃" : "⌄") : ""}
          </span>
        </button>
        {syncHealthOpen && (
          <div
            id="sync-health-panel"
            className="sync-health-popover"
            role="dialog"
            aria-label="Sync Health"
          >
            <div className="popover-heading">
              <span>Sync Health</span>
              <span className="popover-hint">
                {syncHealth
                  ? syncHealthStatusLabel(syncHealth.status)
                  : "nincs adat"}
              </span>
            </div>
            {syncHealth ? (
              <>
                <div className="sync-health-grid">
                  <span>Utolsó ellenőrzés</span>
                  <strong>
                    {formatSyncHealthTime(syncHealth.checkedAt)}
                  </strong>
                  <span>Utolsó import</span>
                  <strong>
                    {formatSyncHealthTime(syncHealth.lastImportAt)}
                  </strong>
                  <span>Journal</span>
                  <strong>
                    {syncHealth.scannedEvents} fájl ·{" "}
                    {syncHealth.acceptedEvents} valid
                  </strong>
                  <span>Lokális SQLite</span>
                  <strong>{syncHealth.storedEvents} event</strong>
                </div>
                <div
                  className="sync-health-path"
                  title={syncHealth.journalPath}
                >
                  Journal: {syncHealth.journalPath}
                </div>
                <div
                  className="sync-health-path"
                  title={syncHealth.quarantinePath}
                >
                  Quarantine: {syncHealth.quarantinePath}
                </div>
                {syncHealth.blockedDevices.length > 0 && (
                  <div className="sync-health-warning">
                    <strong>Blokkolt eszközök</strong>
                    <ul>
                      {syncHealth.blockedDevices.map((device) => (
                        <li key={device}>{device}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {syncHealth.warnings.length > 0 && (
                  <div className="sync-health-warning">
                    <strong>Figyelmeztetések</strong>
                    <ul>
                      {syncHealth.warnings
                        .slice(0, 3)
                        .map((warning, index) => (
                          <li key={`${warning}-${index}`}>{warning}</li>
                        ))}
                    </ul>
                    {syncHealth.warnings.length > 3 && (
                      <small>
                        +{syncHealth.warnings.length - 3} további
                      </small>
                    )}
                  </div>
                )}
                {tombstones.length > 0 && (
                  <section
                    className="sync-recovery"
                    aria-label="Recovery Center"
                  >
                    <div className="sync-recovery-heading">
                      <strong>Recovery Center</strong>
                      <span>{tombstones.length}</span>
                    </div>
                    <div className="sync-recovery-list">
                      {[...tombstones]
                        .sort(
                          (left, right) =>
                            Date.parse(right.archivedAt) -
                            Date.parse(left.archivedAt),
                        )
                        .slice(0, 8)
                        .map((tombstone) => {
                          const label =
                            tombstone.title ??
                            tombstone.relativePath ??
                            tombstone.entityId;
                          const context =
                            syncTombstoneProjectContext(tombstone);
                          const itemBusyKey = `${tombstone.entityType}:${tombstone.entityId}`;
                          const isThisRestoreBusy =
                            restoreBusyKey === itemBusyKey;
                          return (
                            <div
                              className="sync-recovery-item"
                              key={`${tombstone.entityType}:${tombstone.entityId}`}
                            >
                              <div className="sync-recovery-main">
                                <span className="sync-recovery-type">
                                  {syncTombstoneTypeLabel(
                                    tombstone.entityType,
                                  )}
                                </span>
                                <strong title={label}>{label}</strong>
                                <small>
                                  {context ? `${context} · ` : ""}
                                  {formatSyncHealthTime(
                                    tombstone.archivedAt,
                                  )}
                                </small>
                              </div>
                              <button
                                type="button"
                                className="sync-recovery-restore"
                                onClick={() => onRestoreTombstone(tombstone)}
                                disabled={
                                  !syncWriteEnabled ||
                                  restoreBusyKey !== null
                                }
                                title={
                                  isThisRestoreBusy
                                    ? "A visszaállítás folyamatban van"
                                    : syncWriteEnabled
                                      ? "Archivált entitás visszaállítása"
                                      : "A journal jelenleg csak olvasható"
                                }
                              >
                                {isThisRestoreBusy
                                  ? "Visszaállítás…"
                                  : "Visszaállítás"}
                              </button>
                            </div>
                          );
                        })}
                    </div>
                    {tombstones.length > 8 && (
                      <small className="sync-recovery-more">
                        +{tombstones.length - 8} további archivált elem
                      </small>
                    )}
                  </section>
                )}
                <div className="sync-health-recovery">
                  {syncHealth.recoveryAction}
                </div>
                <div className="sync-health-actions">
                  <button
                    type="button"
                    className="footer-action"
                    onClick={onRefreshSync}
                  >
                    <span>↻</span> Újraellenőrzés
                  </button>
                  <button
                    type="button"
                    className="footer-action"
                    onClick={() => onSetSyncHealthOpen(() => false)}
                  >
                    <span>×</span> Bezárás
                  </button>
                </div>
              </>
            ) : (
              <div className="sync-health-empty">
                A v2 sync health még nem érkezett meg.
              </div>
            )}
          </div>
        )}
        <button
          className="footer-action"
          onClick={() => {
            if (settingsOpen) {
              onSetReadingSettingsOpen(() => false);
            }
            onSetSettingsOpen((open) => !open);
          }}
          aria-expanded={settingsOpen}
        >
          <span>⚙</span> Beállítások
        </button>
        {settingsOpen && (
          <SidebarSettingsPanel
            fontSize={fontSize}
            lineHeight={lineHeight}
            readingSettingsOpen={readingSettingsOpen}
            canChangeProjectsRoot={isTauri}
            onToggleReadingSettings={() =>
              onSetReadingSettingsOpen((open) => !open)
            }
            onFontSizeChange={onFontSizeChange}
            onLineHeightChange={onLineHeightChange}
            onChangeProjectsRoot={() => onChangeProjectsRoot()}
            onNotify={onNotify}
          />
        )}
      </div>
    </aside>
  );
}
