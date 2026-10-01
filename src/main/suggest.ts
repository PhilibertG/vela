import type { CommandBarMode, HistoryEntry, State, Suggestion } from '../shared/types'

const COMMANDS: { id: string; title: string; keywords: string; shortcut?: string }[] = [
  { id: 'new-space', title: 'Nouvel espace', keywords: 'space espace créer new' },
  { id: 'toggle-sidebar', title: 'Afficher / masquer la barre latérale', keywords: 'sidebar barre latérale', shortcut: 'Ctrl+S' },
  { id: 'split', title: 'Vue partagée avec…', keywords: 'split vue partagée côte', shortcut: 'Ctrl+Shift+=' },
  { id: 'close-split', title: 'Fermer la vue partagée', keywords: 'split vue partagée fermer' },
  { id: 'web-store', title: 'Installer des extensions (Chrome Web Store)', keywords: 'extensions web store chrome installer' },
  { id: 'extensions', title: 'Gérer les extensions', keywords: 'extensions gérer désinstaller options' },
  { id: 'copy-url', title: "Copier l'URL", keywords: 'copier url lien copy' },
  { id: 'pin', title: "Épingler / désépingler l'onglet", keywords: 'pin épingler', shortcut: 'Ctrl+D' },
  { id: 'find', title: 'Rechercher dans la page', keywords: 'find rechercher page', shortcut: 'Ctrl+F' },
  { id: 'reopen', title: 'Rouvrir le dernier onglet fermé', keywords: 'rouvrir fermé reopen', shortcut: 'Ctrl+Shift+T' },
  { id: 'devtools', title: 'Outils de développement', keywords: 'devtools inspecter console', shortcut: 'F12' },
  { id: 'perf', title: 'Performances de Vela', keywords: 'performances mémoire stats perf' }
]

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i
const DOMAIN = /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i

/** Vrai si le texte saisi ressemble à une adresse plutôt qu'à une recherche. */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  if (/^(https?|file|chrome-extension|about|data):/i.test(text)) return true
  return LOCAL.test(text) || DOMAIN.test(text)
}

/** Transforme la saisie en URL : adresse complétée ou recherche. */
export function toUrl(input: string, searchUrl: string): string {
  const text = input.trim()
  if (looksLikeUrl(text)) {
    if (SCHEME.test(text) && !/^[^:]+:\d/.test(text)) return text
    return LOCAL.test(text) ? `http://${text}` : `https://${text}`
  }
  return searchUrl.replace('%s', encodeURIComponent(text))
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Score simple : tous les mots doivent être trouvés ; bonus si le domaine commence par la saisie. */
function matchScore(query: string, title: string, url: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const t = title.toLowerCase()
  const u = url.toLowerCase()
  let score = 0
  for (const w of words) {
    const inTitle = t.includes(w)
    const inUrl = u.includes(w)
    if (!inTitle && !inUrl) return 0
    score += (inTitle ? 2 : 0) + (inUrl ? 1 : 0)
  }
  if (hostOf(url).startsWith(words[0] ?? '')) score += 6
  return score
}

export function suggest(query: string, mode: CommandBarMode, state: State, history: HistoryEntry[]): Suggestion[] {
  const q = query.trim()
  const results: Suggestion[] = []
  const openUrls = new Set<string>()

  const tabs = Object.values(state.tabs)
  for (const tab of tabs) openUrls.add(tab.url)

  if (!q) {
    // Sans saisie : les onglets récents, pour basculer rapidement.
    return tabs
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, 8)
      .map((tab) => ({ kind: 'tab', title: tab.title, subtitle: hostOf(tab.url), value: tab.id, favicon: tab.favicon }))
  }

  const url = toUrl(q, state.settings.searchUrl)
  if (looksLikeUrl(q)) results.push({ kind: 'url', title: q, subtitle: 'Ouvrir cette adresse', value: url })
  else results.push({ kind: 'search', title: q, subtitle: 'Rechercher sur le web', value: url })

  if (mode !== 'split') {
    const commands = COMMANDS.map((c) => ({ c, s: matchScore(q, `${c.title} ${c.keywords}`, '') }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
    for (const { c } of commands) {
      results.push({ kind: 'command', title: c.title, subtitle: c.shortcut ?? 'Commande', value: c.id })
    }
  }

  const tabMatches = tabs
    .map((tab) => ({ tab, s: matchScore(q, tab.title, tab.url) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.tab.lastActive - a.tab.lastActive)
    .slice(0, 4)
  for (const { tab } of tabMatches) {
    const space = state.spaces.find((s) => s.pinned.includes(tab.id) || s.today.includes(tab.id))
    results.push({
      kind: 'tab',
      title: tab.title,
      subtitle: `Aller à l'onglet · ${space?.name ?? 'Favoris'}`,
      value: tab.id,
      favicon: tab.favicon
    })
  }

  const now = Date.now()
  const historyMatches = history
    .filter((e) => !openUrls.has(e.url))
    .map((e) => {
      const s = matchScore(q, e.title, e.url)
      const ageDays = (now - e.lastVisit) / 86_400_000
      return { e, s: s === 0 ? 0 : s + Math.log2(1 + e.visits) - Math.min(ageDays / 7, 3) }
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
  for (const { e } of historyMatches) {
    results.push({ kind: 'history', title: e.title, subtitle: hostOf(e.url), value: e.url })
  }

  return results
}
