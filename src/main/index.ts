import { Menu, app, dialog, session, type Session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, updateExtensions } from 'electron-chrome-web-store'
import { join } from 'node:path'
import { SHARED_PARTITION } from '../shared/profiles'
import { Shell } from './shell'

app.setName('Vela')

/** Retire « Electron » et le nom de l'app de l'user agent : certains sites (Google) refusent sinon. */
function cleanUserAgent(ua: string): string {
  return ua.replace(/\s(Electron|Vela|vela)\/\S+/g, '')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(start)
}

/** User agent and tab preload: same setup for the shared profile and each Space's own profile. */
function prepareSession(target: Session): void {
  target.setUserAgent(cleanUserAgent(target.getUserAgent()))
  target.registerPreloadScript({ id: 'vela-tab', type: 'frame', filePath: join(__dirname, '../preload/tab.js') })
}

/** Chrome extension APIs for the tabs of one session. */
function attachExtensions(target: Session, shell: Shell): void {
  new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: target,
    async createTab(details) {
      const id = shell.newTab(details.url ?? 'about:blank', { background: details.active === false })
      return [shell.ensureView(id).webContents, shell.win]
    },
    selectTab(wc) {
      shell.selectTabByWc(wc)
    },
    removeTab(wc) {
      shell.closeTabByWc(wc)
    },
    async createWindow(details) {
      const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : []
      return shell.openUrls(urls)
    }
  })
}

/** Loads the installed extensions into the session and lets it install from the Chrome Web Store. */
async function installWebStore(target: Session, shell: Shell, isShared: boolean): Promise<void> {
  await installChromeWebStore({
    session: target,
    // Own profiles get their extensions from the shared one (see Shell.sessionForSpace).
    loadExtensions: isShared,
    autoUpdate: isShared,
    // Demande confirmation avant d'installer, comme Chrome.
    async beforeInstall(details) {
      const permissions = [...(details.manifest.permissions ?? []), ...(details.manifest.host_permissions ?? [])]
      const { response } = await dialog.showMessageBox(shell.win, {
        type: 'question',
        icon: details.icon,
        buttons: ["Ajouter l'extension", 'Annuler'],
        defaultId: 0,
        cancelId: 1,
        message: `Ajouter « ${details.localizedName} » ?`,
        detail: permissions.length ? `Autorisations demandées :\n${permissions.join('\n')}` : undefined
      })
      return { action: response === 0 ? 'allow' : 'deny' }
    }
  })
}

async function start(): Promise<void> {
  // Pas de menu applicatif : ses raccourcis par défaut (Ctrl+W ferme la fenêtre...) gêneraient les nôtres.
  Menu.setApplicationMenu(null)
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback)

  const tabSession = session.fromPartition(SHARED_PARTITION)
  prepareSession(tabSession)

  // L'interface s'affiche tout de suite ; les extensions se chargent en parallèle.
  const shell = new Shell(tabSession)
  attachExtensions(tabSession, shell)
  // Les icônes d'extensions sont affichées dans la barre du haut (session par défaut).
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  // A Space's own profile gets the same setup the first time it is used.
  // Only the shared profile checks for extension updates: all profiles load the same files.
  shell.setProfileSetup((profile) => {
    prepareSession(profile)
    attachExtensions(profile, shell)
    installWebStore(profile, shell, false).catch((err) => console.error('[vela] profile extensions failed', err))
  })

  const started = performance.now()
  try {
    await installWebStore(tabSession, shell, true)
  } catch (err) {
    console.error('[vela] chargement des extensions impossible', err)
  }
  console.log(`[vela] extensions chargées en ${Math.round(performance.now() - started)} ms`)
  shell.onExtensionsReady()

  // Mise à jour des extensions en arrière-plan, sans bloquer le démarrage.
  setTimeout(() => void updateExtensions(tabSession).catch(() => {}), 30_000)

  app.on('second-instance', () => {
    if (shell.win.isMinimized()) shell.win.restore()
    shell.win.focus()
  })
}

app.on('window-all-closed', () => app.quit())
