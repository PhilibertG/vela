import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HistoryEntry, Settings, Space, State, Tab } from '../shared/types'

const STATE_FILE = 'vela-state.json'
const HISTORY_FILE = 'vela-history.json'
const HISTORY_LIMIT = 5000

const SPACE_HUES = [215, 340, 145, 30, 270, 185, 0, 95]

export const DEFAULT_SETTINGS: Settings = {
  sidebarWidth: 248,
  sidebarVisible: true,
  sidebarSide: 'left',
  disabledExtensions: [],
  searchUrl: 'https://www.google.com/search?q=%s',
  sleepAfterMinutes: 15
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

export function makeSpace(index: number, name?: string): Space {
  return {
    id: newId(),
    name: name ?? `Espace ${index + 1}`,
    hue: SPACE_HUES[index % SPACE_HUES.length],
    icon: '',
    pinned: [],
    today: [],
    activeTabId: null,
    split: null
  }
}

function defaultState(): State {
  const space = makeSpace(0, 'Perso')
  return { tabs: {}, spaces: [space], favorites: [], activeSpaceId: space.id, settings: { ...DEFAULT_SETTINGS } }
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
  const state: State = {
    tabs: saved.tabs ?? {},
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
  for (const space of state.spaces) {
    space.pinned = space.pinned.filter(exists)
    space.today = space.today.filter(exists)
    if (space.activeTabId && !exists(space.activeTabId)) space.activeTabId = null
    if (space.split && !(exists(space.split.left) && exists(space.split.right))) space.split = null
  }
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
