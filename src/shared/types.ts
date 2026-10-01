// Types partagés entre le processus principal, le preload et l'interface.

export interface Tab {
  id: string
  url: string
  title: string
  favicon?: string
  /** URL d'origine d'un onglet épinglé ou favori, pour pouvoir y revenir. */
  homeUrl?: string
  lastActive: number
  /** Vrai quand la vue n'existe pas (onglet en veille ou jamais chargé). */
  asleep: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible?: boolean
}

export interface Split {
  left: string
  right: string
  /** Part de largeur du panneau gauche, entre 0.2 et 0.8. */
  ratio: number
}

export interface Space {
  id: string
  name: string
  /** Teinte HSL (0-360) utilisée pour la couleur de l'espace. */
  hue: number
  icon: string
  /** Top level of the pinned section: ids of tabs and folders, in display order. */
  pinned: string[]
  today: string[]
  activeTabId: string | null
  split: Split | null
}

/** Folder of the pinned section. Can hold tabs and other folders. */
export interface Folder {
  id: string
  name: string
  open: boolean
  /** Ids of tabs and folders, in display order. */
  items: string[]
}

export type SidebarSide = 'left' | 'right'

export interface Settings {
  sidebarWidth: number
  sidebarVisible: boolean
  sidebarSide: SidebarSide
  /** Extensions installed but turned off (not loaded). */
  disabledExtensions: string[]
  searchUrl: string
  sleepAfterMinutes: number
  /** Today tabs unused for this long are archived. 0 = never. */
  archiveAfterHours: number
}

export interface State {
  /** Format of the saved file. Bumped when the format changes (a backup of the old file is kept). */
  version: number
  tabs: Record<string, Tab>
  folders: Record<string, Folder>
  spaces: Space[]
  favorites: string[]
  activeSpaceId: string
  settings: Settings
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisit: number
}

export interface Metrics {
  startupMs: number | null
  commandBarMs: number[]
}

export type CommandBarMode = 'new-tab' | 'edit-url' | 'split'

export interface CommandBarOpen {
  mode: CommandBarMode
  initial: string
}

export interface Suggestion {
  kind: 'tab' | 'history' | 'search' | 'url' | 'command'
  title: string
  subtitle: string
  /** URL à ouvrir, identifiant d'onglet ou identifiant de commande. */
  value: string
  favicon?: string
}

export type Action =
  | { type: 'select-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'new-tab'; url?: string }
  | { type: 'navigate'; url: string }
  | { type: 'go-back' }
  | { type: 'go-forward' }
  | { type: 'reload' }
  | { type: 'reset-tab'; tabId: string }
  | { type: 'select-space'; spaceId: string }
  | { type: 'new-space' }
  | { type: 'rename-space'; spaceId: string; name: string }
  | {
      type: 'move-tab'
      tabId: string
      to: 'favorites' | 'pinned' | 'today'
      spaceId?: string
      /** Pinned only: folder to drop into (top level of the pinned section when absent). */
      folderId?: string
      index: number
    }
  | { type: 'new-folder'; spaceId?: string; parentId?: string }
  | { type: 'rename-folder'; id: string; name: string }
  | { type: 'toggle-folder'; id: string }
  | { type: 'move-folder'; id: string; parentId: string | null; spaceId?: string; index: number }
  | { type: 'folder-menu'; id: string }
  | { type: 'set-split-ratio'; ratio: number }
  | { type: 'close-split' }
  | { type: 'clear-today' }
  | { type: 'set-sidebar-width'; width: number }
  | { type: 'toggle-sidebar' }
  | { type: 'tab-menu'; tabId: string }
  | { type: 'space-menu'; spaceId: string }
  | { type: 'open-command-bar'; mode: CommandBarMode }
  | { type: 'window'; command: 'minimize' | 'maximize' | 'close' }
  | { type: 'manage-extensions' }
  | { type: 'open-panel'; panel: Panel }
  | { type: 'close-panel' }
  | { type: 'archive-restore'; id: string }
  | { type: 'archive-remove'; id: string }
  | { type: 'archive-clear' }
  | { type: 'update-settings'; settings: Partial<Settings> }
  | { type: 'extension-options'; id: string }
  | { type: 'extension-toggle'; id: string; enabled: boolean }
  | { type: 'extension-uninstall'; id: string }

/** Full-size panels drawn by the interface in place of the pages. */
export type Panel = 'settings' | 'archive'

/** Today tab archived after a period without use. */
export interface ArchivedTab {
  id: string
  url: string
  title: string
  favicon?: string
  spaceId: string
  spaceName: string
  archivedAt: number
}

/** Installed extension, as shown in the settings panel. */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  hasOptions: boolean
  /** data: URL, absent when the extension has no icon. */
  icon?: string
}

export type OverlayAction =
  | { type: 'submit'; mode: CommandBarMode; suggestion: Suggestion }
  | { type: 'close' }
  | { type: 'painted'; openedAt: number }
  | { type: 'find'; text: string; forward: boolean; findNext: boolean }
  | { type: 'peek-close' }
  | { type: 'peek-expand' }

/** Messages envoyés par le processus principal à la vue superposée. */
export type OverlayMessage =
  | { type: 'command-bar'; open: CommandBarOpen; openedAt: number }
  | { type: 'find-bar'; openedAt: number }
  | { type: 'find-result'; active: number; matches: number }
  /** rect: where the Peek page sits, in window coordinates. */
  | { type: 'peek'; rect: { x: number; y: number; width: number; height: number }; url: string; title: string }
  | { type: 'peek-info'; url: string; title: string }

/** Messages ponctuels envoyés à la barre latérale. */
export type UiEvent =
  | { type: 'edit-space-name'; spaceId: string }
  | { type: 'edit-folder-name'; id: string }
  | { type: 'window-state'; maximized: boolean }
  | { type: 'panel'; panel: Panel | null }
  | { type: 'archive-changed' }
  | { type: 'extensions-changed' }
