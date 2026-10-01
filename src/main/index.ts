import { Menu, app, dialog, session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, updateExtensions } from 'electron-chrome-web-store'
import { join } from 'node:path'
import { Shell } from './shell'

const TAB_PARTITION = 'persist:vela'

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

async function start(): Promise<void> {
  // Pas de menu applicatif : ses raccourcis par défaut (Ctrl+W ferme la fenêtre...) gêneraient les nôtres.
  Menu.setApplicationMenu(null)
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback)

  const tabSession = session.fromPartition(TAB_PARTITION)
  tabSession.setUserAgent(cleanUserAgent(tabSession.getUserAgent()))
  tabSession.registerPreloadScript({ id: 'vela-tab', type: 'frame', filePath: join(__dirname, '../preload/tab.js') })

  // L'interface s'affiche tout de suite ; les extensions se chargent en parallèle.
  const shell = new Shell(tabSession)

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: tabSession,
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
  // Les icônes d'extensions sont affichées dans la barre latérale (session par défaut).
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  shell.attachExtensions(extensions)

  const started = performance.now()
  try {
    await installChromeWebStore({
      session: tabSession,
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
