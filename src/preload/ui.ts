import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type { Action, CommandBarMode, ExtensionInfo, OverlayAction, OverlayMessage, State, Suggestion, UiEvent } from '../shared/types'
import type { VelaApi } from './api'

// Ajoute l'élément <browser-action-list> (boutons des extensions) dans la barre latérale.
injectBrowserAction()

const api: VelaApi = {
  getState: () => ipcRenderer.invoke('vela:get-state') as Promise<State>,
  onState: (cb) => {
    ipcRenderer.on('vela:state', (_e, state: State) => cb(state))
  },
  onEvent: (cb) => {
    ipcRenderer.on('vela:event', (_e, event: UiEvent) => cb(event))
  },
  send: (action: Action) => ipcRenderer.send('vela:action', action),
  uiReady: () => ipcRenderer.send('vela:ui-ready'),
  suggest: (query: string, mode: CommandBarMode) =>
    ipcRenderer.invoke('vela:suggest', query, mode) as Promise<Suggestion[]>,
  getExtensions: () => ipcRenderer.invoke('vela:extensions') as Promise<ExtensionInfo[]>,
  overlay: (action: OverlayAction) => ipcRenderer.send('vela:overlay', action),
  onOverlay: (cb) => {
    ipcRenderer.on('vela:overlay', (_e, message: OverlayMessage) => cb(message))
  }
}

contextBridge.exposeInMainWorld('vela', api)
