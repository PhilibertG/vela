// Dimensions partagées entre le placement des vues (main) et le dessin de l'interface.
import type { Settings } from './types'

export const MARGIN = 8
export const SPLIT_GAP = 8
/** Bar across the top of the window: drag area, navigation, address, extensions, window controls. */
export const TOPBAR_HEIGHT = 40

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Area where web pages are shown. Single source of truth for main (views) and renderer (drawing). */
export function contentRect(winWidth: number, winHeight: number, settings: Settings): Rect {
  const sidebar = settings.sidebarVisible ? settings.sidebarWidth : MARGIN
  const onRight = settings.sidebarSide === 'right'
  const x = onRight ? MARGIN : sidebar
  return {
    x,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, winWidth - sidebar - MARGIN),
    height: Math.max(0, winHeight - TOPBAR_HEIGHT - MARGIN)
  }
}
