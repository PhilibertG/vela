import type { Action, ArchivedTab, CommandBarMode, ExtensionInfo, OverlayAction, OverlayMessage, State, Suggestion, UiEvent } from '../shared/types'

export interface VelaApi {
  getState(): Promise<State>
  onState(cb: (state: State) => void): void
  onEvent(cb: (event: UiEvent) => void): void
  send(action: Action): void
  uiReady(): void
  suggest(query: string, mode: CommandBarMode): Promise<Suggestion[]>
  getExtensions(): Promise<ExtensionInfo[]>
  getArchive(): Promise<ArchivedTab[]>
  overlay(action: OverlayAction): void
  onOverlay(cb: (message: OverlayMessage) => void): void
}

declare global {
  interface Window {
    vela: VelaApi
  }
}
