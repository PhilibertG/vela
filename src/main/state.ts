import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArchivedTab, Folder, HistoryEntry, Settings, Space, State, Tab } from '../shared/types'

const STATE_FILE = 'vela-state.json'
/** 1: before folders (no version field). 2: pinned section can hold folders. 3: favorites per own-profile Space. */
const STATE_VERSION = 3
const HISTORY_FILE = 'vela-history.json'
const ARCHIVE_FILE = 'vela-archive.json'
const ARCHIVE_KEEP_MS = 30 * 24 * 3600_000
const ARCHIVE_LIMIT = 2000
const HISTORY_LIMIT = 5000

const SPACE_HUES = [215, 340, 145, 30, 270, 185, 0, 95]

export const DEFAULT_SETTINGS: Settings = {
  sidebarWidth: 248,
  sidebarVisible: true,
  sidebarSide: 'left',
  disabledExtensions: [],
  searchUrl: 'https://www.google.com/search?q=%s',
  sleepAfterMinutes: 15,
  archiveAfterHours: 12
}

export function newId(): string {
  return randomUUID().slice(0, 8)
}

export function makeTab(url: string, title = ''): Tab {
  return {
    id: newId(),
    url,
    title: title || url,
    lastActive: Date.now(),
    asleep: true,
    loading: false,
    canGoBack: false,
    canGoForward: false
  }
}

export function makeFolder(name = 'Nouveau dossier'): Folder {
  return { id: newId(), name, open: true, items: [] }
}

export function makeSpace(index: number, name?: string): Space {
  return {
    id: newId(),
    name: name ?? `Espace ${index + 1}`,
    hue: SPACE_HUES[index % SPACE_HUES.length],
    icon: '',
    pinned: [],
    today: [],
    activeTabId: null,
    split: null,
    profile: 'shared',
    favorites: []
  }
}

function defaultState(): State {
  const space = makeSpace(0, 'Perso')
  return {
    version: STATE_VERSION,
    tabs: {},
    folders: {},
    spaces: [space],
    favorites: [],
    activeSpaceId: space.id,
    settings: { ...DEFAULT_SETTINGS }
  }
}

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath(name), 'utf8')) as T
  } catch {
    return null
  }
}

/** Écriture atomique : fichier temporaire puis renommage. */
function writeJson(name: string, data: unknown): void {
  const target = filePath(name)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, target)
}

export function loadState(): State {
  const saved = readJson<State>(STATE_FILE)
  if (!saved || !Array.isArray(saved.spaces) || saved.spaces.length === 0) return defaultState()
  // Keeps the file as it was before its format changes, once per old version.
  const savedVersion = typeof saved.version === 'number' ? saved.version : 1
  if (savedVersion < STATE_VERSION) {
    const backup = filePath(`vela-state.v${savedVersion}.backup.json`)
    if (!existsSync(backup)) copyFileSync(filePath(STATE_FILE), backup)
  }
  const state: State = {
    version: STATE_VERSION,
    tabs: saved.tabs ?? {},
    folders: saved.folders && typeof saved.folders === 'object' ? saved.folders : {},
    spaces: saved.spaces,
    favorites: saved.favorites ?? [],
    activeSpaceId: saved.activeSpaceId,
    settings: { ...DEFAULT_SETTINGS, ...saved.settings }
  }
  // Settings saved by an older version (or edited by hand) may lack fields or hold bad values.
  if (state.settings.sidebarSide !== 'left' && state.settings.sidebarSide !== 'right') state.settings.sidebarSide = 'left'
  if (!Array.isArray(state.settings.disabledExtensions)) state.settings.disabledExtensions = []
  // Au démarrage, aucune vue n'existe : tous les onglets sont en veille.
  for (const tab of Object.values(state.tabs)) {
    tab.asleep = true
    tab.loading = false
    tab.audible = false
  }
  // Retire les références vers des onglets absents (fichier modifié à la main, crash...).
  const exists = (id: string): boolean => id in state.tabs
  state.favorites = state.favorites.filter(exists)
  // Pinned tree: drops missing ids, duplicates and loops; a folder nobody points to is removed.
  const placed = new Set<string>()
  const cleanTree = (ids: string[]): string[] =>
    ids.filter((id) => {
      if (placed.has(id) || !(exists(id) || id in state.folders)) return false
      placed.add(id)
      const folder = state.folders[id]
      if (folder) {
        if (typeof folder.name !== 'string') folder.name = 'Dossier'
        folder.open = folder.open !== false
        folder.items = cleanTree(Array.isArray(folder.items) ? folder.items : [])
      }
      return true
    })
  for (const space of state.spaces) {
    if (space.profile !== 'own') space.profile = 'shared'
    space.pinned = cleanTree(space.pinned)
    space.favorites = Array.isArray(space.favorites) ? space.favorites.filter((id) => exists(id) && !placed.has(id)) : []
    for (const id of space.favorites) placed.add(id)
    // Own favorites of a Space that went back to the shared profile: kept as pinned tabs.
    if (space.profile === 'shared' && space.favorites.length > 0) {
      space.pinned.push(...space.favorites)
      space.favorites = []
    }
    space.today = space.today.filter(exists)
    if (space.activeTabId && !exists(space.activeTabId)) space.activeTabId = null
    if (space.split && !(exists(space.split.left) && exists(space.split.right))) space.split = null
  }
  for (const id of Object.keys(state.folders)) if (!placed.has(id)) delete state.folders[id]
  if (!state.spaces.some((s) => s.id === state.activeSpaceId)) state.activeSpaceId = state.spaces[0].id
  return state
}

let saveTimer: NodeJS.Timeout | null = null

export function scheduleSave(state: State): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeJson(STATE_FILE, state)
  }, 500)
}

export function saveNow(state: State): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  writeJson(STATE_FILE, state)
}

/** Archived today tabs, newest first. Kept 30 days, in their own file. */
export class Archive {
  private entries: ArchivedTab[] = []
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    const saved = readJson<ArchivedTab[]>(ARCHIVE_FILE)
    if (Array.isArray(saved)) this.entries = saved.filter((e) => e && typeof e.url === 'string' && typeof e.id === 'string')
    this.prune()
  }

  all(): ArchivedTab[] {
    return this.entries
  }

  add(entry: Omit<ArchivedTab, 'id' | 'archivedAt'>): void {
    this.entries.unshift({ ...entry, id: newId(), archivedAt: Date.now() })
    this.prune()
    this.scheduleSave()
  }

  take(id: string): ArchivedTab | undefined {
    const entry = this.entries.find((e) => e.id === id)
    if (entry) this.remove(id)
    return entry
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.scheduleSave()
  }

  clear(): void {
    this.entries = []
    this.scheduleSave()
  }

  /** Drops entries older than 30 days, and the oldest beyond the size limit. */
  prune(): boolean {
    const before = this.entries.length
    const limit = Date.now() - ARCHIVE_KEEP_MS
    this.entries = this.entries.filter((e) => e.archivedAt >= limit).slice(0, ARCHIVE_LIMIT)
    if (this.entries.length !== before) this.scheduleSave()
    return this.entries.length !== before
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 1000)
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    writeJson(ARCHIVE_FILE, this.entries)
  }
}

/** Historique de navigation, indexé par URL. */
export class History {
  private entries = new Map<string, HistoryEntry>()
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    const saved = readJson<HistoryEntry[]>(HISTORY_FILE)
    if (Array.isArray(saved)) for (const e of saved) this.entries.set(e.url, e)
  }

  visit(url: string, title: string): void {
    if (!/^https?:/.test(url)) return
    const entry = this.entries.get(url)
    if (entry) {
      entry.visits++
      entry.lastVisit = Date.now()
      if (title) entry.title = title
    } else {
      this.entries.set(url, { url, title: title || url, visits: 1, lastVisit: Date.now() })
    }
    this.scheduleSave()
  }

  setTitle(url: string, title: string): void {
    const entry = this.entries.get(url)
    if (entry && title && entry.title !== title) {
      entry.title = title
      this.scheduleSave()
    }
  }

  all(): HistoryEntry[] {
    return [...this.entries.values()]
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 2000)
  }

  flush(): void {
    let list = this.all()
    if (list.length > HISTORY_LIMIT) {
      list = list.sort((a, b) => b.lastVisit - a.lastVisit).slice(0, HISTORY_LIMIT)
      this.entries = new Map(list.map((e) => [e.url, e]))
    }
    writeJson(HISTORY_FILE, list)
  }
}
