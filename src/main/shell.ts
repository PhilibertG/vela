import {
  BaseWindow,
  Menu,
  MenuItem,
  WebContentsView,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  systemPreferences,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents
} from 'electron'
import { join } from 'node:path'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { uninstallExtension } from 'electron-chrome-web-store'
import type {
  Action,
  CommandBarMode,
  ExtensionInfo,
  Metrics,
  OverlayAction,
  OverlayMessage,
  Panel,
  Settings,
  Space,
  State,
  Suggestion,
  Tab,
  UiEvent
} from '../shared/types'
import { SIDEBAR_ANIMATION_MS, SPLIT_GAP, contentRect, easeOutCubic } from '../shared/layout'
import { folderAndDescendants, pinnedHas, pinnedTabIds } from '../shared/folders'
import { Archive, History, loadState, makeFolder, makeSpace, makeTab, saveNow, scheduleSave } from './state'
import { suggest, toUrl } from './suggest'

const RADIUS = 10
const FIND_BAR = { width: 360, height: 56 }
const WEB_STORE_URL = 'https://chromewebstore.google.com/'
const SLEEP_CHOICES = [5, 15, 30, 60, 240]
const ARCHIVE_CHOICES = [0, 12, 24, 168, 720]

interface DisabledExtension {
  name: string
  version: string
  path: string
  icon?: string
}

function extensionIcon(ext: Electron.Extension): string | undefined {
  const icons = (ext.manifest as chrome.runtime.Manifest).icons
  if (!icons) return undefined
  const sizes = Object.keys(icons).map(Number).sort((a, b) => a - b)
  const size = sizes.find((n) => n >= 32) ?? sizes[sizes.length - 1]
  const image = nativeImage.createFromPath(join(ext.path, icons[size]))
  return image.isEmpty() ? undefined : image.resize({ width: 32, height: 32 }).toDataURL()
}

/** Keeps only valid values: the renderer is trusted, but the saved file may be edited by hand. */
function sanitizeSettings(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (patch.sidebarSide === 'left' || patch.sidebarSide === 'right') out.sidebarSide = patch.sidebarSide
  if (typeof patch.sidebarWidth === 'number' && Number.isFinite(patch.sidebarWidth)) {
    out.sidebarWidth = Math.min(420, Math.max(180, Math.round(patch.sidebarWidth)))
  }
  if (typeof patch.searchUrl === 'string' && /^https:\/\/\S+$/.test(patch.searchUrl) && patch.searchUrl.includes('%s')) {
    out.searchUrl = patch.searchUrl
  }
  if (typeof patch.sleepAfterMinutes === 'number' && SLEEP_CHOICES.includes(patch.sleepAfterMinutes)) {
    out.sleepAfterMinutes = patch.sleepAfterMinutes
  }
  if (typeof patch.archiveAfterHours === 'number' && ARCHIVE_CHOICES.includes(patch.archiveAfterHours)) {
    out.archiveAfterHours = patch.archiveAfterHours
  }
  return out
}

interface ClosedTab {
  tab: Tab
  spaceId: string
}

type OverlayState = 'hidden' | 'command' | 'find' | 'peek'

/** Approximate site of a URL: last two labels of the host (three for co.uk-like endings). */
function siteOf(url: string): string {
  try {
    const labels = new URL(url).hostname.split('.')
    const n = labels.length > 2 && labels[labels.length - 2].length <= 3 && labels[labels.length - 1].length === 2 ? 3 : 2
    return labels.slice(-n).join('.')
  } catch {
    return ''
  }
}

function rendererUrl(page: 'index' | 'overlay'): { url?: string; file?: string } {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) return { url: `${dev}/${page}.html` }
  return { file: join(__dirname, `../renderer/${page}.html`) }
}

function loadPage(view: WebContentsView, page: 'index' | 'overlay'): void {
  const target = rendererUrl(page)
  if (target.url) void view.webContents.loadURL(target.url)
  else void view.webContents.loadFile(target.file!)
}

export class Shell {
  readonly win: BaseWindow
  private readonly ui: WebContentsView
  private readonly overlay: WebContentsView
  private readonly views = new Map<string, WebContentsView>()
  private readonly tabByWc = new Map<number, string>()
  private readonly state: State
  private readonly history = new History()
  private readonly archive = new Archive()
  private readonly closed: ClosedTab[] = []
  private overlayState: OverlayState = 'hidden'
  /** Page shown in Peek, above the dimmed tabs. */
  private peekView: WebContentsView | null = null
  private emitScheduled = false
  private extensionsReady = false
  private extensions: ElectronChromeExtensions | null = null
  /** Vrai pendant la fermeture : les pages détruites ne doivent pas être retirées de l'état. */
  private closing = false
  /** Panel shown in place of the pages, if any. */
  private panel: Panel | null = null
  /** 0 = sidebar hidden, 1 = shown. Animated between the two. */
  private sidebarReveal = 1
  private sidebarAnimation: NodeJS.Timeout | null = null
  /** Extensions turned off in settings: unloaded, but kept on disk so they can be turned back on. */
  private readonly disabledExtensions = new Map<string, DisabledExtension>()
  readonly metrics: Metrics = { startupMs: null, commandBarMs: [] }

  constructor(private readonly tabSession: Session) {
    this.state = loadState()
    this.sidebarReveal = this.state.settings.sidebarVisible ? 1 : 0

    this.win = new BaseWindow({
      width: 1320,
      height: 860,
      minWidth: 640,
      minHeight: 420,
      frame: false,
      show: false,
      // Sous Linux, la fenêtre est transparente pour que l'interface dessine des coins arrondis.
      // Sous Windows 11, le système arrondit lui-même les fenêtres sans cadre.
      transparent: process.platform === 'linux',
      backgroundColor: process.platform === 'linux' ? '#00000000' : '#1d1f24',
      title: 'Vela'
    })

    const preload = join(__dirname, '../preload/ui.js')

    this.ui = new WebContentsView({
      webPreferences: { preload, sandbox: false, contextIsolation: true }
    })
    this.ui.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.ui)

    // La barre de commande est chargée dès le démarrage puis masquée :
    // Ctrl+T n'a qu'à l'afficher, sans attendre de chargement.
    this.overlay = new WebContentsView({
      webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false }
    })
    this.overlay.setBackgroundColor('#00000000')
    this.overlay.setVisible(false)
    this.win.contentView.addChildView(this.overlay)

    this.registerShortcuts(this.ui.webContents)
    this.registerShortcuts(this.overlay.webContents)
    loadPage(this.ui, 'index')
    loadPage(this.overlay, 'overlay')

    this.win.on('resize', () => this.layout())
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      this.win.on(event as 'maximize', () => {
        this.layout()
        this.sendWindowState()
      })
    }
    this.win.on('close', () => {
      this.closing = true
      saveNow(this.state)
      this.history.flush()
      this.archive.flush()
    })
    // Les extensions gardent des processus actifs : on quitte explicitement.
    this.win.on('closed', () => app.quit())

    this.registerIpc()
    const notifyExtensions = (): void => this.sendUiEvent({ type: 'extensions-changed' })
    this.tabSession.extensions.on('extension-loaded', notifyExtensions)
    this.tabSession.extensions.on('extension-unloaded', notifyExtensions)
    this.layout()

    // Met en veille les onglets inactifs pour libérer de la mémoire.
    setInterval(() => {
      this.sleepIdleTabs()
      this.archiveIdleTabs()
    }, 60_000)
  }

  // ---------------------------------------------------------------- Démarrage

  attachExtensions(extensions: ElectronChromeExtensions): void {
    this.extensions = extensions
  }

  /** Appelé une fois les extensions chargées : on peut créer les vues des onglets. */
  onExtensionsReady(): void {
    this.extensionsReady = true
    this.unloadDisabledExtensions()
    this.archiveIdleTabs()
    const space = this.activeSpace()
    if (!space.activeTabId) space.activeTabId = this.pinnedTabs(space)[0] ?? space.today[0] ?? null
    this.showActive()
  }

  private registerIpc(): void {
    ipcMain.handle('vela:get-state', () => this.state)
    ipcMain.on('vela:action', (_e, action: Action) => this.handleAction(action))
    ipcMain.on('vela:ui-ready', () => {
      if (this.metrics.startupMs === null) {
        this.metrics.startupMs = Math.round(performance.now())
        console.log(`[vela] interface affichée ${this.metrics.startupMs} ms après le lancement`)
      }
      this.sendWindowState()
      this.win.show()
    })
    ipcMain.handle('vela:suggest', (_e, query: string, mode: CommandBarMode) =>
      suggest(query, mode, this.state, this.history.all())
    )
    ipcMain.on('vela:overlay', (_e, action: OverlayAction) => this.handleOverlayAction(action))
    ipcMain.handle('vela:extensions', () => this.listExtensions())
    ipcMain.handle('vela:archive', () => this.archive.all())
    // Link clicks reported by the tab preload. Synchronous: the page must know right away whether to follow the link.
    ipcMain.on('vela:link-click', (e, url: unknown, shift: unknown) => {
      e.returnValue = this.handleLinkClick(e.sender, url, shift === true)
    })
  }

  // ---------------------------------------------------------------- État

  private activeSpace(): Space {
    return this.state.spaces.find((s) => s.id === this.state.activeSpaceId) ?? this.state.spaces[0]
  }

  private pinnedTabs(space: Space): string[] {
    return pinnedTabIds(this.state.folders, space)
  }

  /** Space holding this tab (pinned, in any folder, or today) or this folder. */
  private spaceOf(id: string): Space | undefined {
    return this.state.spaces.find((s) => s.today.includes(id) || pinnedHas(this.state.folders, s, id))
  }

  private isKept(tabId: string): boolean {
    return this.state.favorites.includes(tabId) || this.state.spaces.some((s) => pinnedHas(this.state.folders, s, tabId))
  }

  /** Removes a tab or folder id from the pinned tree of every Space. */
  private detachPinned(id: string): void {
    for (const s of this.state.spaces) s.pinned = s.pinned.filter((x) => x !== id)
    for (const f of Object.values(this.state.folders)) f.items = f.items.filter((x) => x !== id)
  }

  private activeTabId(): string | null {
    return this.activeSpace().activeTabId
  }

  activeWebContents(): WebContents | null {
    const id = this.activeTabId()
    return id ? (this.views.get(id)?.webContents ?? null) : null
  }

  /** Envoie l'état à la barre latérale, au plus une fois par frame, et le sauvegarde. */
  private emit(): void {
    if (this.emitScheduled) return
    this.emitScheduled = true
    setTimeout(() => {
      this.emitScheduled = false
      if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send('vela:state', this.state)
      scheduleSave(this.state)
    }, 16)
  }

  private sendUiEvent(event: UiEvent): void {
    this.ui.webContents.send('vela:event', event)
  }

  private sendWindowState(): void {
    this.sendUiEvent({ type: 'window-state', maximized: this.win.isMaximized() || this.win.isFullScreen() })
  }

  private sendOverlay(message: OverlayMessage): void {
    this.overlay.webContents.send('vela:overlay', message)
  }

  // ---------------------------------------------------------------- Disposition

  private contentRect(): Electron.Rectangle {
    const [width, height] = this.win.getContentSize()
    return contentRect(width, height, this.state.settings, this.sidebarReveal)
  }

  /** Onglets à afficher : l'onglet actif, ou les deux panneaux de la vue partagée. */
  private visibleTabIds(): string[] {
    const space = this.activeSpace()
    const active = space.activeTabId
    if (!active) return []
    const split = space.split
    if (split && (split.left === active || split.right === active)) return [split.left, split.right]
    return [active]
  }

  private layout(): void {
    if (this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    this.ui.setBounds({ x: 0, y: 0, width, height })

    const rect = this.contentRect()
    // The settings panel is drawn by the interface, in place of the pages.
    const visible = this.panel ? [] : this.visibleTabIds()
    const bounds = new Map<string, Electron.Rectangle>()
    if (visible.length === 2) {
      const ratio = this.activeSpace().split!.ratio
      const leftWidth = Math.round((rect.width - SPLIT_GAP) * ratio)
      bounds.set(visible[0], { ...rect, width: leftWidth })
      bounds.set(visible[1], {
        ...rect,
        x: rect.x + leftWidth + SPLIT_GAP,
        width: rect.width - leftWidth - SPLIT_GAP
      })
    } else if (visible.length === 1) {
      bounds.set(visible[0], rect)
    }

    for (const [id, view] of this.views) {
      const b = bounds.get(id)
      if (b) {
        view.setBounds(b)
        view.setVisible(true)
      } else {
        view.setVisible(false)
      }
    }

    if (this.overlayState === 'command' || this.overlayState === 'peek') {
      this.overlay.setBounds({ x: 0, y: 0, width, height })
      if (this.peekView) {
        const peekRect = this.peekRect()
        this.peekView.setBounds(peekRect)
        const wc = this.peekView.webContents
        if (wc.getURL()) this.sendOverlay({ type: 'peek', rect: peekRect, url: wc.getURL(), title: wc.getTitle() })
      }
    } else if (this.overlayState === 'find') {
      this.overlay.setBounds({
        x: rect.x + rect.width - FIND_BAR.width - 12,
        y: rect.y + 12,
        width: FIND_BAR.width,
        height: FIND_BAR.height
      })
    }
  }

  // ---------------------------------------------------------------- Vues des onglets

  ensureView(tabId: string): WebContentsView {
    const existing = this.views.get(tabId)
    if (existing) return existing
    const tab = this.state.tabs[tabId]

    const view = new WebContentsView({
      webPreferences: { session: this.tabSession, sandbox: true, contextIsolation: true }
    })
    view.setBorderRadius(RADIUS)
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    // La vue superposée doit rester au-dessus des onglets.
    this.win.contentView.addChildView(this.overlay)
    if (this.peekView) this.win.contentView.addChildView(this.peekView)

    const wc = view.webContents
    this.views.set(tabId, view)
    this.tabByWc.set(wc.id, tabId)
    this.wireTab(tabId, wc)
    this.extensions?.addTab(wc, this.win)

    tab.asleep = false
    void wc.loadURL(tab.url).catch(() => {
      // Les erreurs de chargement sont affichées par la page d'erreur de Chromium.
    })
    return view
  }

  private wireTab(tabId: string, wc: WebContents): void {
    const tab = (): Tab | undefined => this.state.tabs[tabId]
    const syncNav = (): void => {
      const t = tab()
      if (!t) return
      t.canGoBack = wc.navigationHistory.canGoBack()
      t.canGoForward = wc.navigationHistory.canGoForward()
    }

    wc.on('did-start-loading', () => {
      const t = tab()
      if (t) t.loading = true
      this.emit()
    })
    wc.on('did-stop-loading', () => {
      const t = tab()
      if (t) t.loading = false
      syncNav()
      this.emit()
    })
    wc.on('did-navigate', (_e, url) => {
      const t = tab()
      if (!t) return
      t.url = url
      syncNav()
      this.history.visit(url, wc.getTitle())
      this.emit()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      const t = tab()
      if (!t || !isMainFrame) return
      t.url = url
      syncNav()
      this.history.visit(url, wc.getTitle())
      this.emit()
    })
    wc.on('page-title-updated', (_e, title) => {
      const t = tab()
      if (!t) return
      t.title = title
      this.history.setTitle(t.url, title)
      this.emit()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      const t = tab()
      if (!t || favicons.length === 0) return
      t.favicon = favicons[0]
      this.emit()
    })
    wc.on('audio-state-changed', (e) => {
      const t = tab()
      if (!t) return
      t.audible = e.audible
      this.emit()
    })
    wc.on('focus', () => {
      // Dans une vue partagée, le panneau cliqué devient l'onglet actif.
      const space = this.activeSpace()
      if (space.split && space.activeTabId !== tabId && this.visibleTabIds().includes(tabId)) {
        space.activeTabId = tabId
        this.extensions?.selectTab(wc)
        this.emit()
      }
    })
    wc.on('found-in-page', (_e, result) => {
      this.sendOverlay({ type: 'find-result', active: result.activeMatchOrdinal, matches: result.matches })
    })
    wc.on('render-process-gone', (_e, details) => {
      // À la fermeture de la fenêtre, les pages s'arrêtent aussi : rien à faire.
      if (this.win.isDestroyed() || details.reason === 'clean-exit') return
      // La page a planté : on supprime la vue, elle sera recréée au prochain clic.
      this.destroyView(tabId)
      this.layout()
      this.emit()
    })
    wc.on('context-menu', (_e, params) => this.showPageMenu(wc, params))
    wc.setWindowOpenHandler((details) => {
      // Les vraies fenêtres popup (connexion OAuth, etc.) gardent leur lien avec la page.
      if (details.disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true }
        }
      }
      this.newTab(details.url, { background: details.disposition === 'background-tab' })
      return { action: 'deny' }
    })
    this.registerShortcuts(wc)
  }

  private destroyView(tabId: string): void {
    const view = this.views.get(tabId)
    if (!view) return
    this.views.delete(tabId)
    // On retire l'onglet des correspondances avant tout : la bibliothèque d'extensions
    // rappelle closeTabByWc pendant removeTab(), qui ne doit alors rien trouver.
    for (const [wcId, id] of this.tabByWc) if (id === tabId) this.tabByWc.delete(wcId)
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    // webContents est indéfini si la page a déjà été détruite (window.close(), fermeture...).
    const wc = view.webContents as WebContents | undefined
    if (wc && !wc.isDestroyed()) {
      this.extensions?.removeTab(wc)
      wc.close()
    }
    const tab = this.state.tabs[tabId]
    if (tab) {
      tab.asleep = true
      tab.loading = false
      tab.audible = false
    }
  }

  private sleepIdleTabs(): void {
    if (this.win.isDestroyed()) return
    const limit = this.state.settings.sleepAfterMinutes * 60_000
    const visible = new Set(this.visibleTabIds())
    const now = Date.now()
    for (const id of [...this.views.keys()]) {
      const tab = this.state.tabs[id]
      if (!tab || visible.has(id) || tab.audible) continue
      if (now - tab.lastActive > limit) this.destroyView(id)
    }
    this.emit()
  }

  /** Crée les vues visibles, les place et donne le focus à l'onglet actif. */
  private showActive(): void {
    if (this.panel) this.setPanel(null)
    if (this.overlayState === 'peek') this.hideOverlay()
    if (this.extensionsReady) {
      for (const id of this.visibleTabIds()) {
        this.ensureView(id)
        this.state.tabs[id].lastActive = Date.now()
      }
    }
    this.layout()
    const wc = this.activeWebContents()
    if (wc) {
      if (this.overlayState !== 'command') wc.focus()
      this.extensions?.selectTab(wc)
    } else if (this.overlayState !== 'command') {
      // No page shown (empty Space): without this, the keyboard stays on a hidden page and shortcuts stop working.
      this.ui.webContents.focus()
    }
    this.emit()
  }

  // ---------------------------------------------------------------- Onglets

  selectTab(tabId: string): void {
    if (!this.state.tabs[tabId]) return
    const owner = this.spaceOf(tabId)
    if (owner) this.state.activeSpaceId = owner.id
    this.activeSpace().activeTabId = tabId
    this.showActive()
  }

  selectTabByWc(wc: WebContents): void {
    const id = this.tabByWc.get(wc.id)
    if (id) this.selectTab(id)
  }

  /**
   * Appelé par la bibliothèque d'extensions quand un onglet disparaît :
   * chrome.tabs.remove, ou page qui se ferme elle-même (window.close()).
   */
  closeTabByWc(wc: WebContents): void {
    if (this.closing) return
    const id = this.tabByWc.get(wc.id)
    if (id) this.closeTab(id)
  }

  newTab(url: string, opts: { background?: boolean } = {}): string {
    const tab = makeTab(url)
    this.state.tabs[tab.id] = tab
    this.activeSpace().today.unshift(tab.id)
    if (opts.background) {
      if (this.extensionsReady) this.ensureView(tab.id)
      this.layout()
      this.emit()
    } else {
      this.selectTab(tab.id)
    }
    return tab.id
  }

  /** Liste des onglets de l'espace dans l'ordre d'affichage de la barre latérale. */
  private orderedTabs(space: Space): string[] {
    return [...this.state.favorites, ...this.pinnedTabs(space), ...space.today]
  }

  private neighbourOf(tabId: string, space: Space): string | null {
    const list = this.orderedTabs(space).filter((id) => id !== tabId)
    const before = this.orderedTabs(space).indexOf(tabId)
    if (list.length === 0) return null
    return list[Math.min(before, list.length - 1)] ?? null
  }

  closeTab(tabId: string): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const space = this.spaceOf(tabId) ?? this.activeSpace()
    const wasActive = space.activeTabId === tabId

    if (this.isKept(tabId)) {
      // Un onglet épinglé ou favori n'est pas supprimé : il est déchargé
      // et revient à son URL d'origine.
      this.destroyView(tabId)
      if (tab.homeUrl) tab.url = tab.homeUrl
    } else {
      this.closed.push({ tab: { ...tab }, spaceId: space.id })
      if (this.closed.length > 30) this.closed.shift()
      this.destroyView(tabId)
      space.today = space.today.filter((id) => id !== tabId)
      delete this.state.tabs[tabId]
    }

    for (const s of this.state.spaces) {
      if (s.split && (s.split.left === tabId || s.split.right === tabId)) {
        const other = s.split.left === tabId ? s.split.right : s.split.left
        s.split = null
        if (wasActive && s === space) s.activeTabId = other
      }
    }

    if (space.activeTabId === tabId) {
      // Choisit un onglet voisin non déchargé de préférence.
      const next = this.neighbourOf(tabId, space)
      space.activeTabId = next && !this.isKept(tabId) ? next : (space.today[0] ?? next)
      if (space.activeTabId === tabId) space.activeTabId = null
    }
    this.showActive()
  }

  /** Ferme tous les onglets non épinglés de l'espace actif. */
  private clearToday(): void {
    const space = this.activeSpace()
    for (const id of space.today) {
      this.closed.push({ tab: { ...this.state.tabs[id] }, spaceId: space.id })
      this.destroyView(id)
      delete this.state.tabs[id]
    }
    if (this.closed.length > 30) this.closed.splice(0, this.closed.length - 30)
    const removed = new Set(space.today)
    space.today = []
    if (space.split && (removed.has(space.split.left) || removed.has(space.split.right))) space.split = null
    if (space.activeTabId && removed.has(space.activeTabId)) space.activeTabId = null
    this.showActive()
  }

  reopenClosedTab(): void {
    const entry = this.closed.pop()
    if (!entry) return
    const space = this.state.spaces.find((s) => s.id === entry.spaceId) ?? this.activeSpace()
    const tab: Tab = { ...entry.tab, asleep: true, loading: false }
    this.state.tabs[tab.id] = tab
    space.today.unshift(tab.id)
    this.selectTab(tab.id)
  }

  private navigate(input: string): void {
    const wc = this.activeWebContents()
    const url = toUrl(input, this.state.settings.searchUrl)
    if (!wc) {
      this.newTab(url)
      return
    }
    void wc.loadURL(url).catch(() => {})
    wc.focus()
  }

  private moveTab(
    tabId: string,
    to: 'favorites' | 'pinned' | 'today',
    index: number,
    spaceId?: string,
    folderId?: string
  ): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const source = this.spaceOf(tabId)
    const folder = to === 'pinned' && folderId ? this.state.folders[folderId] : undefined
    this.state.favorites = this.state.favorites.filter((id) => id !== tabId)
    this.detachPinned(tabId)
    for (const s of this.state.spaces) s.today = s.today.filter((id) => id !== tabId)
    // A folder belongs to one Space: dropping into it moves the tab to that Space.
    const target =
      (folder && this.spaceOf(folder.id)) ?? this.state.spaces.find((s) => s.id === spaceId) ?? this.activeSpace()
    const list =
      to === 'favorites' ? this.state.favorites : to === 'pinned' ? (folder?.items ?? target.pinned) : target.today
    list.splice(Math.max(0, Math.min(index, list.length)), 0, tabId)

    if (to === 'today') tab.homeUrl = undefined
    else if (!tab.homeUrl) tab.homeUrl = tab.url

    // Un onglet déplacé vers un autre espace n'y est plus actif.
    if (source && source !== target && source.activeTabId === tabId && to !== 'favorites') {
      source.activeTabId = this.neighbourOf(tabId, source)
      this.showActive()
      return
    }
    this.layout()
    this.emit()
  }

  private togglePin(tabId: string): void {
    const space = this.spaceOf(tabId) ?? this.activeSpace()
    if (pinnedHas(this.state.folders, space, tabId)) this.moveTab(tabId, 'today', 0, space.id)
    else this.moveTab(tabId, 'pinned', space.pinned.length, space.id)
  }

  // ---------------------------------------------------------------- Folders

  private newFolder(spaceId?: string, parentId?: string): void {
    const parent = parentId ? this.state.folders[parentId] : undefined
    const space = (parent && this.spaceOf(parent.id)) ?? this.state.spaces.find((s) => s.id === spaceId) ?? this.activeSpace()
    const folder = makeFolder()
    this.state.folders[folder.id] = folder
    if (parent) {
      parent.items.push(folder.id)
      parent.open = true
    } else {
      space.pinned.push(folder.id)
    }
    if (space.id !== this.state.activeSpaceId) this.selectSpace(space.id)
    this.emit()
    this.sendUiEvent({ type: 'edit-folder-name', id: folder.id })
  }

  private moveFolder(id: string, parentId: string | null, index: number, spaceId?: string): void {
    const folder = this.state.folders[id]
    if (!folder) return
    const parent = parentId ? this.state.folders[parentId] : undefined
    if (parentId && !parent) return
    // A folder cannot go inside itself or one of its subfolders.
    if (parentId && folderAndDescendants(this.state.folders, id).has(parentId)) return
    const target = (parent && this.spaceOf(parent.id)) ?? this.state.spaces.find((s) => s.id === spaceId) ?? this.spaceOf(id)
    if (!target) return
    const movedTabs = pinnedTabIds(this.state.folders, { ...target, pinned: [id] })
    const source = this.spaceOf(id)
    this.detachPinned(id)
    const list = parent?.items ?? target.pinned
    list.splice(Math.max(0, Math.min(index, list.length)), 0, id)
    // Moving a folder to another Space takes its tabs along: the source Space must not keep one active.
    if (source && source !== target && source.activeTabId && movedTabs.includes(source.activeTabId)) {
      source.activeTabId = this.pinnedTabs(source)[0] ?? source.today[0] ?? null
      this.showActive()
      return
    }
    this.emit()
  }

  /** Deletes the folder only: its tabs and subfolders move up to where the folder was. */
  private deleteFolder(id: string): void {
    const folder = this.state.folders[id]
    if (!folder) return
    const space = this.spaceOf(id)
    const parent = Object.values(this.state.folders).find((f) => f.items.includes(id))
    const list = parent?.items ?? space?.pinned
    const index = list ? list.indexOf(id) : -1
    if (!list || index < 0) return
    list.splice(index, 1, ...folder.items)
    delete this.state.folders[id]
    this.emit()
  }

  private showFolderMenu(id: string): void {
    const folder = this.state.folders[id]
    if (!folder) return
    Menu.buildFromTemplate([
      { label: 'Renommer', click: () => this.sendUiEvent({ type: 'edit-folder-name', id }) },
      { label: 'Nouveau sous-dossier', click: () => this.newFolder(undefined, id) },
      { type: 'separator' },
      { label: 'Supprimer le dossier (garder les onglets)', click: () => this.deleteFolder(id) }
    ]).popup({ window: this.win })
  }

  private resetTab(tabId: string): void {
    const tab = this.state.tabs[tabId]
    if (!tab?.homeUrl) return
    const view = this.views.get(tabId)
    if (view) void view.webContents.loadURL(tab.homeUrl).catch(() => {})
    else tab.url = tab.homeUrl
    this.emit()
  }

  private cycleTab(direction: 1 | -1): void {
    const space = this.activeSpace()
    const list = this.orderedTabs(space)
    if (list.length === 0) return
    const current = space.activeTabId ? list.indexOf(space.activeTabId) : -1
    const next = list[(current + direction + list.length) % list.length]
    this.selectTab(next)
  }

  // ---------------------------------------------------------------- Vue partagée

  openSplit(otherTabId: string): void {
    const space = this.activeSpace()
    const current = space.activeTabId
    if (!current || current === otherTabId) {
      this.selectTab(otherTabId)
      return
    }
    space.split = { left: current, right: otherTabId, ratio: 0.5 }
    space.activeTabId = otherTabId
    this.showActive()
  }

  private closeSplit(): void {
    const space = this.activeSpace()
    space.split = null
    this.showActive()
  }

  // ---------------------------------------------------------------- Espaces

  selectSpace(spaceId: string): void {
    const space = this.state.spaces.find((s) => s.id === spaceId)
    if (!space) return
    this.state.activeSpaceId = space.id
    if (!space.activeTabId) space.activeTabId = this.pinnedTabs(space)[0] ?? space.today[0] ?? null
    this.showActive()
  }

  private newSpace(): void {
    const space = makeSpace(this.state.spaces.length)
    this.state.spaces.push(space)
    this.selectSpace(space.id)
    this.sendUiEvent({ type: 'edit-space-name', spaceId: space.id })
  }

  private async deleteSpace(spaceId: string): Promise<void> {
    if (this.state.spaces.length <= 1) return
    const space = this.state.spaces.find((s) => s.id === spaceId)
    if (!space) return
    const tabIds = [...this.pinnedTabs(space), ...space.today]
    const count = tabIds.length
    if (count > 0) {
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'warning',
        buttons: ['Supprimer', 'Annuler'],
        defaultId: 1,
        cancelId: 1,
        message: `Supprimer l'espace « ${space.name} » ?`,
        detail: `Ses ${count} onglets seront fermés.`
      })
      if (response !== 0) return
    }
    for (const id of tabIds) {
      this.destroyView(id)
      delete this.state.tabs[id]
    }
    for (const id of Object.keys(this.state.folders)) {
      if (pinnedHas(this.state.folders, space, id)) delete this.state.folders[id]
    }
    this.state.spaces = this.state.spaces.filter((s) => s.id !== spaceId)
    if (this.state.activeSpaceId === spaceId) this.state.activeSpaceId = this.state.spaces[0].id
    this.showActive()
  }

  // ---------------------------------------------------------------- Barre de commande et recherche

  openCommandBar(mode: CommandBarMode): void {
    if (this.overlayState === 'peek') this.closePeek()
    const openedAt = Date.now()
    const tab = this.activeTabId() ? this.state.tabs[this.activeTabId()!] : null
    const initial = mode === 'edit-url' && tab ? tab.url : ''
    this.overlayState = 'command'
    this.layout()
    this.sendOverlay({ type: 'command-bar', open: { mode, initial }, openedAt })
    this.overlay.setVisible(true)
    this.overlay.webContents.focus()
  }

  openFindBar(): void {
    if (this.overlayState === 'peek') return
    if (!this.activeWebContents()) return
    this.overlayState = 'find'
    this.layout()
    this.sendOverlay({ type: 'find-bar', openedAt: Date.now() })
    this.overlay.setVisible(true)
    this.overlay.webContents.focus()
  }

  private hideOverlay(): void {
    if (this.overlayState === 'find') this.activeWebContents()?.stopFindInPage('clearSelection')
    if (this.overlayState === 'peek') this.closePeek()
    this.overlayState = 'hidden'
    this.overlay.setVisible(false)
    const wc = this.activeWebContents()
    if (wc) wc.focus()
    else this.ui.webContents.focus()
  }

  private handleOverlayAction(action: OverlayAction): void {
    switch (action.type) {
      case 'close':
      case 'peek-close':
        this.hideOverlay()
        break
      case 'peek-expand': {
        const url = this.peekView?.webContents.getURL()
        this.hideOverlay()
        if (url) this.newTab(url)
        break
      }
      case 'painted': {
        const ms = Date.now() - action.openedAt
        this.metrics.commandBarMs.push(ms)
        if (this.metrics.commandBarMs.length > 50) this.metrics.commandBarMs.shift()
        console.log(`[vela] barre affichée en ${ms} ms`)
        break
      }
      case 'find': {
        const wc = this.activeWebContents()
        if (!wc) break
        if (action.text) wc.findInPage(action.text, { forward: action.forward, findNext: action.findNext })
        else wc.stopFindInPage('clearSelection')
        break
      }
      case 'submit':
        this.hideOverlay()
        this.submitSuggestion(action.mode, action.suggestion)
        break
    }
  }

  private submitSuggestion(mode: CommandBarMode, s: Suggestion): void {
    if (s.kind === 'command') {
      this.runCommand(s.value)
      return
    }
    // La barre peut envoyer la saisie brute si l'utilisateur valide avant les suggestions.
    const url = s.kind === 'tab' ? s.value : toUrl(s.value, this.state.settings.searchUrl)
    if (mode === 'split') {
      const id = s.kind === 'tab' ? s.value : this.newTab(url, { background: true })
      this.openSplit(id)
      return
    }
    if (s.kind === 'tab') {
      this.selectTab(s.value)
      return
    }
    if (mode === 'edit-url') this.navigate(url)
    else this.newTab(url)
  }

  runCommand(id: string): void {
    const activeId = this.activeTabId()
    switch (id) {
      case 'new-space':
        this.newSpace()
        break
      case 'toggle-sidebar':
        this.toggleSidebar()
        break
      case 'web-store':
        this.newTab(WEB_STORE_URL)
        break
      case 'extensions':
        this.showExtensionsMenu()
        break
      case 'split':
        setTimeout(() => this.openCommandBar('split'), 0)
        break
      case 'close-split':
        this.closeSplit()
        break
      case 'copy-url':
        if (activeId) clipboard.writeText(this.state.tabs[activeId].url)
        break
      case 'devtools':
        this.activeWebContents()?.openDevTools({ mode: 'detach' })
        break
      case 'find':
        setTimeout(() => this.openFindBar(), 0)
        break
      case 'reopen':
        this.reopenClosedTab()
        break
      case 'pin':
        if (activeId) this.togglePin(activeId)
        break
      case 'perf':
        void this.showMetrics()
        break
      case 'settings':
        this.setPanel('settings')
        break
      case 'archive':
        this.setPanel('archive')
        break
    }
  }

  private toggleSidebar(): void {
    this.state.settings.sidebarVisible = !this.state.settings.sidebarVisible
    this.animateSidebar()
    this.emit()
  }

  /** Moves the page views along with the sidebar animation drawn by the interface. */
  private animateSidebar(): void {
    const target = this.state.settings.sidebarVisible ? 1 : 0
    const from = this.sidebarReveal
    if (this.sidebarAnimation) clearInterval(this.sidebarAnimation)
    this.sidebarAnimation = null
    if (from === target || systemPreferences.getAnimationSettings().prefersReducedMotion) {
      this.sidebarReveal = target
      this.layout()
      return
    }
    const start = performance.now()
    this.sidebarAnimation = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / SIDEBAR_ANIMATION_MS)
      this.sidebarReveal = from + (target - from) * easeOutCubic(t)
      this.layout()
      if (t === 1 && this.sidebarAnimation) {
        clearInterval(this.sidebarAnimation)
        this.sidebarAnimation = null
      }
    }, 16)
  }

  private async showMetrics(): Promise<void> {
    const samples = [...this.metrics.commandBarMs].sort((a, b) => a - b)
    const median = samples.length ? samples[Math.floor(samples.length / 2)] : null
    const memoryKb = app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0)
    await dialog.showMessageBox(this.win, {
      type: 'info',
      message: 'Performances de Vela',
      detail: [
        `Démarrage (lancement → interface visible) : ${this.metrics.startupMs ?? '?'} ms`,
        `Ouverture de la barre de commande (médiane sur ${samples.length}) : ${median ?? '?'} ms`,
        `Onglets chargés : ${this.views.size} / ${Object.keys(this.state.tabs).length}`,
        `Mémoire totale (tous les processus) : ${Math.round(memoryKb / 1024)} Mo`
      ].join('\n')
    })
  }

  // ---------------------------------------------------------------- Menus

  private showPageMenu(wc: WebContents, params: Electron.ContextMenuParams): void {
    const items: MenuItemConstructorOptions[] = []
    if (params.linkURL) {
      items.push(
        { label: 'Ouvrir le lien dans un nouvel onglet', click: () => this.newTab(params.linkURL, { background: true }) },
        {
          label: 'Ouvrir le lien en vue partagée',
          click: () => this.openSplit(this.newTab(params.linkURL, { background: true }))
        },
        { label: 'Ouvrir dans Peek (Maj+clic)', click: () => this.openPeek(params.linkURL) },
        { label: "Copier l'adresse du lien", click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: "Ouvrir l'image dans un nouvel onglet", click: () => this.newTab(params.srcURL, { background: true }) },
        { label: "Copier l'image", click: () => wc.copyImageAt(params.x, params.y) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      items.push(
        { label: 'Couper', enabled: params.editFlags.canCut, click: () => wc.cut() },
        { label: 'Copier', enabled: params.editFlags.canCopy, click: () => wc.copy() },
        { label: 'Coller', enabled: params.editFlags.canPaste, click: () => wc.paste() },
        { type: 'separator' }
      )
    } else if (params.selectionText) {
      const text = params.selectionText.trim()
      const short = text.length > 30 ? `${text.slice(0, 30)}…` : text
      items.push(
        { label: 'Copier', click: () => wc.copy() },
        { label: `Rechercher « ${short} »`, click: () => this.newTab(toUrl(text, this.state.settings.searchUrl)) },
        { type: 'separator' }
      )
    }
    items.push(
      { label: 'Précédent', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Suivant', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Actualiser', click: () => wc.reload() }
    )
    const extensionItems = this.extensions?.getContextMenuItems(wc, params) ?? []
    if (extensionItems.length) items.push({ type: 'separator' })
    const menu = Menu.buildFromTemplate(items)
    for (const item of extensionItems) menu.append(item)
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(new MenuItem({ label: "Inspecter l'élément", click: () => wc.inspectElement(params.x, params.y) }))
    menu.popup({ window: this.win })
  }

  private showTabMenu(tabId: string): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const space = this.spaceOf(tabId)
    const isFavorite = this.state.favorites.includes(tabId)
    const isPinned = !!space && pinnedHas(this.state.folders, space, tabId)
    const others = this.state.spaces.filter((s) => s !== space)
    const items: MenuItemConstructorOptions[] = [
      isFavorite
        ? { label: 'Retirer des favoris', click: () => this.moveTab(tabId, 'pinned', 0) }
        : { label: 'Ajouter aux favoris', click: () => this.moveTab(tabId, 'favorites', this.state.favorites.length) },
      { label: isPinned ? 'Désépingler' : 'Épingler', visible: !isFavorite, click: () => this.togglePin(tabId) },
      { label: "Revenir à l'URL d'origine", visible: !!tab.homeUrl && tab.homeUrl !== tab.url, click: () => this.resetTab(tabId) },
      { type: 'separator' },
      {
        label: "Ouvrir en vue partagée avec l'onglet actif",
        enabled: this.activeTabId() !== null && this.activeTabId() !== tabId,
        click: () => this.openSplit(tabId)
      },
      { label: 'Dupliquer', click: () => this.newTab(tab.url) },
      { label: "Copier l'URL", click: () => clipboard.writeText(tab.url) },
      {
        label: 'Déplacer vers',
        enabled: others.length > 0 && !isFavorite,
        submenu: others.map((s) => ({ label: s.name, click: () => this.moveTab(tabId, 'today', 0, s.id) }))
      },
      { type: 'separator' },
      { label: 'Mettre en veille', enabled: !tab.asleep && !this.visibleTabIds().includes(tabId), click: () => { this.destroyView(tabId); this.emit() } },
      { label: isPinned || isFavorite ? 'Décharger' : "Fermer l'onglet", click: () => this.closeTab(tabId) }
    ]
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  private showSpaceMenu(spaceId: string): void {
    const space = this.state.spaces.find((s) => s.id === spaceId)
    if (!space) return
    const colors: [string, number][] = [
      ['Bleu', 215], ['Rose', 340], ['Vert', 145], ['Orange', 30],
      ['Violet', 270], ['Turquoise', 185], ['Rouge', 0], ['Olive', 95]
    ]
    Menu.buildFromTemplate([
      { label: 'Renommer', click: () => this.sendUiEvent({ type: 'edit-space-name', spaceId }) },
      { label: 'Nouveau dossier', click: () => this.newFolder(spaceId) },
      {
        label: 'Couleur',
        submenu: colors.map(([label, hue]) => ({
          label,
          type: 'radio' as const,
          checked: space.hue === hue,
          click: () => {
            space.hue = hue
            this.emit()
          }
        }))
      },
      { type: 'separator' },
      { label: "Supprimer l'espace", enabled: this.state.spaces.length > 1, click: () => void this.deleteSpace(spaceId) }
    ]).popup({ window: this.win })
  }

  // ---------------------------------------------------------------- Settings

  private setPanel(panel: Panel | null): void {
    if (this.panel === panel) return
    this.panel = panel
    if (panel && this.overlayState !== 'hidden') this.hideOverlay()
    this.layout()
    this.sendUiEvent({ type: 'panel', panel })
    const wc = this.activeWebContents()
    if (!panel && wc) wc.focus()
    else this.ui.webContents.focus()
  }

  // ---------------------------------------------------------------- Peek

  /**
   * Shift+click on any link, or a click from a pinned tab or favorite to another site, opens Peek.
   * Returns true when the page must not follow the link itself.
   */
  private handleLinkClick(sender: WebContents, url: unknown, shift: boolean): boolean {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
    const tabId = this.tabByWc.get(sender.id)
    if (!tabId) return false // Peek's own page and other views follow links normally.
    const toOtherSite = siteOf(url) !== siteOf(sender.getURL())
    if (!shift && !(this.isKept(tabId) && toOtherSite)) return false
    setImmediate(() => this.openPeek(url))
    return true
  }

  /** Peek page area: inside the page area, leaving room above for its toolbar. */
  private peekRect(): Electron.Rectangle {
    const rect = this.contentRect()
    const side = Math.max(32, Math.round((rect.width - 1200) / 2))
    return {
      x: rect.x + side,
      y: rect.y + 52,
      width: Math.max(200, rect.width - 2 * side),
      height: Math.max(200, rect.height - 52 - 24)
    }
  }

  private openPeek(url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    if (this.panel) this.setPanel(null)
    if (this.overlayState === 'command' || this.overlayState === 'find') this.hideOverlay()
    if (!this.peekView) {
      const view = new WebContentsView({
        webPreferences: { session: this.tabSession, sandbox: true, contextIsolation: true }
      })
      view.setBorderRadius(RADIUS)
      view.setBackgroundColor('#ffffff')
      const wc = view.webContents
      const sendInfo = (): void => this.sendOverlay({ type: 'peek-info', url: wc.getURL(), title: wc.getTitle() })
      wc.on('page-title-updated', sendInfo)
      wc.on('did-navigate', sendInfo)
      wc.on('did-navigate-in-page', sendInfo)
      wc.setWindowOpenHandler((details) => {
        if (details.disposition === 'new-window') {
          return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true } }
        }
        void wc.loadURL(details.url).catch(() => {})
        return { action: 'deny' }
      })
      this.registerShortcuts(wc)
      this.peekView = view
    }
    this.overlayState = 'peek'
    this.overlay.setVisible(true)
    this.win.contentView.addChildView(this.overlay)
    this.win.contentView.addChildView(this.peekView)
    void this.peekView.webContents.loadURL(url).catch(() => {})
    this.layout()
    this.sendOverlay({ type: 'peek', rect: this.peekRect(), url, title: url })
    this.peekView.webContents.focus()
  }

  private closePeek(): void {
    const view = this.peekView
    this.peekView = null
    if (!view) return
    this.win.contentView.removeChildView(view)
    view.webContents.close()
  }

  // ---------------------------------------------------------------- Archive

  /** Today tabs not used for the chosen delay leave the sidebar and go to the archive. */
  private archiveIdleTabs(): void {
    const hours = this.state.settings.archiveAfterHours
    let changed = this.archive.prune()
    if (hours > 0) {
      const limit = Date.now() - hours * 3600_000
      const visible = new Set(this.visibleTabIds())
      for (const space of this.state.spaces) {
        for (const id of [...space.today]) {
          const tab = this.state.tabs[id]
          if (!tab || tab.lastActive > limit || tab.audible || visible.has(id) || id === space.activeTabId) continue
          if (space.split && (space.split.left === id || space.split.right === id)) continue
          if (/^https?:/.test(tab.url)) {
            this.archive.add({ url: tab.url, title: tab.title, favicon: tab.favicon, spaceId: space.id, spaceName: space.name })
          }
          this.destroyView(id)
          space.today = space.today.filter((x) => x !== id)
          delete this.state.tabs[id]
          changed = true
        }
      }
    }
    if (changed) {
      this.emit()
      this.sendUiEvent({ type: 'archive-changed' })
    }
  }

  private restoreArchived(id: string): void {
    const entry = this.archive.take(id)
    if (!entry) return
    const space = this.state.spaces.find((s) => s.id === entry.spaceId)
    if (space) this.state.activeSpaceId = space.id
    this.newTab(entry.url)
    this.sendUiEvent({ type: 'archive-changed' })
  }

  private async confirmClearArchive(): Promise<void> {
    const count = this.archive.all().length
    if (count === 0) return
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ["Vider l'archive", 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: `Supprimer les ${count} onglets archivés ?`,
      detail: "L'historique de navigation n'est pas touché."
    })
    if (response !== 0) return
    this.archive.clear()
    this.sendUiEvent({ type: 'archive-changed' })
  }

  private listExtensions(): ExtensionInfo[] {
    const loaded = this.tabSession.extensions.getAllExtensions().map((ext) => {
      const manifest = ext.manifest as chrome.runtime.Manifest
      return {
        id: ext.id,
        name: ext.name,
        version: ext.version,
        enabled: true,
        hasOptions: !!(manifest.options_ui?.page ?? manifest.options_page),
        icon: extensionIcon(ext)
      }
    })
    const disabled = [...this.disabledExtensions].map(([id, ext]) => ({
      id,
      name: ext.name,
      version: ext.version,
      enabled: false,
      hasOptions: false,
      icon: ext.icon
    }))
    return [...loaded, ...disabled].sort((a, b) => a.name.localeCompare(b.name))
  }

  private unloadDisabledExtensions(): void {
    const kept: string[] = []
    for (const id of this.state.settings.disabledExtensions) {
      const ext = this.tabSession.extensions.getExtension(id)
      if (!ext) continue // Uninstalled meanwhile.
      this.disabledExtensions.set(id, { name: ext.name, version: ext.version, path: ext.path, icon: extensionIcon(ext) })
      this.tabSession.extensions.removeExtension(id)
      kept.push(id)
    }
    this.state.settings.disabledExtensions = kept
  }

  private async setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
    if (enabled) {
      const ext = this.disabledExtensions.get(id)
      if (!ext) return
      try {
        await this.tabSession.extensions.loadExtension(ext.path)
      } catch (err) {
        console.error('[vela] extension reload failed', err)
        return
      }
      this.disabledExtensions.delete(id)
      this.state.settings.disabledExtensions = this.state.settings.disabledExtensions.filter((x) => x !== id)
    } else {
      const ext = this.tabSession.extensions.getExtension(id)
      if (!ext) return
      this.disabledExtensions.set(id, { name: ext.name, version: ext.version, path: ext.path, icon: extensionIcon(ext) })
      this.tabSession.extensions.removeExtension(id)
      if (!this.state.settings.disabledExtensions.includes(id)) this.state.settings.disabledExtensions.push(id)
    }
    this.emit()
    this.sendUiEvent({ type: 'extensions-changed' })
  }

  private openExtensionOptions(id: string): void {
    const ext = this.tabSession.extensions.getExtension(id)
    if (!ext) return
    const manifest = ext.manifest as chrome.runtime.Manifest
    const page = manifest.options_ui?.page ?? manifest.options_page
    if (page) this.newTab(`${ext.url}${page}`)
  }

  private async confirmUninstall(id: string): Promise<void> {
    const name = this.tabSession.extensions.getExtension(id)?.name ?? this.disabledExtensions.get(id)?.name
    if (!name) return
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Désinstaller', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      message: `Désinstaller « ${name} » ?`,
      detail: "L'extension et ses données seront supprimées."
    })
    if (response !== 0) return
    await uninstallExtension(id, { session: this.tabSession })
    this.disabledExtensions.delete(id)
    this.state.settings.disabledExtensions = this.state.settings.disabledExtensions.filter((x) => x !== id)
    this.emit()
    this.sendUiEvent({ type: 'extensions-changed' })
  }

  private showExtensionsMenu(): void {
    const extensions = this.tabSession.extensions.getAllExtensions()
    const items: MenuItemConstructorOptions[] = extensions.map((ext) => {
      const manifest = ext.manifest as chrome.runtime.Manifest
      const optionsPage = manifest.options_ui?.page ?? manifest.options_page
      return {
        label: `${ext.name} ${ext.version}`,
        submenu: [
          { label: 'Options', enabled: !!optionsPage, click: () => this.newTab(`${ext.url}${optionsPage}`) },
          {
            label: 'Désinstaller',
            click: () => {
              void uninstallExtension(ext.id, { session: this.tabSession })
            }
          }
        ]
      }
    })
    if (items.length === 0) items.push({ label: 'Aucune extension installée', enabled: false })
    items.push({ type: 'separator' }, { label: 'Ouvrir le Chrome Web Store', click: () => this.newTab(WEB_STORE_URL) })
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  // ---------------------------------------------------------------- Actions de la barre latérale

  private handleAction(action: Action): void {
    switch (action.type) {
      case 'select-tab':
        this.selectTab(action.tabId)
        break
      case 'close-tab':
        this.closeTab(action.tabId)
        break
      case 'new-tab':
        if (action.url) this.newTab(action.url)
        else this.openCommandBar('new-tab')
        break
      case 'navigate':
        this.navigate(action.url)
        break
      case 'go-back':
        this.activeWebContents()?.navigationHistory.goBack()
        break
      case 'go-forward':
        this.activeWebContents()?.navigationHistory.goForward()
        break
      case 'reload':
        this.activeWebContents()?.reload()
        break
      case 'reset-tab':
        this.resetTab(action.tabId)
        break
      case 'select-space':
        this.selectSpace(action.spaceId)
        break
      case 'new-space':
        this.newSpace()
        break
      case 'rename-space': {
        const space = this.state.spaces.find((s) => s.id === action.spaceId)
        if (space && action.name.trim()) space.name = action.name.trim()
        this.emit()
        break
      }
      case 'new-folder':
        this.newFolder(action.spaceId, action.parentId)
        break
      case 'rename-folder': {
        const folder = this.state.folders[action.id]
        const name = action.name.trim()
        if (folder && name) folder.name = name.slice(0, 80)
        this.emit()
        break
      }
      case 'toggle-folder': {
        const folder = this.state.folders[action.id]
        if (folder) folder.open = !folder.open
        this.emit()
        break
      }
      case 'move-folder':
        this.moveFolder(action.id, action.parentId, action.index, action.spaceId)
        break
      case 'folder-menu':
        this.showFolderMenu(action.id)
        break
      case 'move-tab':
        this.moveTab(action.tabId, action.to, action.index, action.spaceId, action.folderId)
        break
      case 'set-split-ratio': {
        const split = this.activeSpace().split
        if (split) split.ratio = Math.min(0.8, Math.max(0.2, action.ratio))
        this.layout()
        this.emit()
        break
      }
      case 'close-split':
        this.closeSplit()
        break
      case 'clear-today':
        this.clearToday()
        break
      case 'set-sidebar-width':
        this.state.settings.sidebarWidth = Math.min(420, Math.max(180, Math.round(action.width)))
        this.layout()
        this.emit()
        break
      case 'toggle-sidebar':
        this.toggleSidebar()
        break
      case 'tab-menu':
        this.showTabMenu(action.tabId)
        break
      case 'space-menu':
        this.showSpaceMenu(action.spaceId)
        break
      case 'open-command-bar':
        this.openCommandBar(action.mode)
        break
      case 'window':
        if (action.command === 'minimize') this.win.minimize()
        else if (action.command === 'maximize') {
          if (this.win.isMaximized()) this.win.unmaximize()
          else this.win.maximize()
        } else this.win.close()
        break
      case 'manage-extensions':
        this.showExtensionsMenu()
        break
      case 'open-panel':
        this.setPanel(action.panel)
        break
      case 'close-panel':
        this.setPanel(null)
        break
      case 'archive-restore':
        this.restoreArchived(action.id)
        break
      case 'archive-remove':
        this.archive.remove(action.id)
        this.sendUiEvent({ type: 'archive-changed' })
        break
      case 'archive-clear':
        void this.confirmClearArchive()
        break
      case 'update-settings':
        Object.assign(this.state.settings, sanitizeSettings(action.settings))
        this.layout()
        this.emit()
        break
      case 'extension-options':
        this.openExtensionOptions(action.id)
        break
      case 'extension-toggle':
        void this.setExtensionEnabled(action.id, action.enabled)
        break
      case 'extension-uninstall':
        void this.confirmUninstall(action.id)
        break
    }
  }

  // ---------------------------------------------------------------- Raccourcis clavier

  /**
   * Les raccourcis sont interceptés sur chaque webContents (onglets, barre latérale,
   * barre de commande), car le focus clavier est dans la vue qui a été cliquée.
   */
  private registerShortcuts(wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()
      let handled = true

      if (ctrl && input.shift && key === 't') this.reopenClosedTab()
      else if (ctrl && input.shift && input.code === 'Equal') this.openCommandBar('split')
      else if (ctrl && input.shift && key === 'r') this.activeWebContents()?.reloadIgnoringCache()
      else if ((ctrl && input.shift && key === 'i') || key === 'f12') this.runCommand('devtools')
      else if (ctrl && !input.shift && key === 't') this.openCommandBar('new-tab')
      else if (ctrl && !input.shift && key === 'l') this.openCommandBar('edit-url')
      else if (ctrl && !input.shift && key === 'w') {
        const id = this.activeTabId()
        if (id) this.closeTab(id)
      } else if ((ctrl && !input.shift && key === 'r') || key === 'f5') this.activeWebContents()?.reload()
      else if (ctrl && !input.shift && key === 's') this.toggleSidebar()
      else if (ctrl && !input.shift && key === 'd') this.runCommand('pin')
      else if (ctrl && !input.shift && key === 'f') this.openFindBar()
      else if (key === 'escape' && this.overlayState === 'peek') this.hideOverlay()
      else if (ctrl && !input.shift && key === ',') this.setPanel(this.panel === 'settings' ? null : 'settings')
      else if (ctrl && key === 'tab') this.cycleTab(input.shift ? -1 : 1)
      // Physical key (code), not the character: on AZERTY the "1" key types "&" without Shift.
      else if (ctrl && /^(Digit|Numpad)[1-9]$/.test(input.code)) {
        const space = this.state.spaces[Number(input.code.slice(-1)) - 1]
        if (space) this.selectSpace(space.id)
      } else if (input.alt && key === 'arrowleft') this.activeWebContents()?.navigationHistory.goBack()
      else if (input.alt && key === 'arrowright') this.activeWebContents()?.navigationHistory.goForward()
      else if (ctrl && (key === '=' || key === '+')) this.zoom(0.5)
      else if (ctrl && key === '-') this.zoom(-0.5)
      else if (ctrl && key === '0') this.zoom(0)
      else handled = false

      if (handled) event.preventDefault()
    })
  }

  private zoom(step: number): void {
    const wc = this.activeWebContents()
    if (!wc) return
    wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step)
  }

  /** Utilisé par chrome.windows.create : on ouvre les URL dans des onglets de la fenêtre principale. */
  openUrls(urls: string[]): BaseWindow {
    for (const url of urls) this.newTab(url)
    return this.win
  }
}
