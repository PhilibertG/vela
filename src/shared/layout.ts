// Dimensions partagées entre le placement des vues (main) et le dessin de l'interface.
import type { Settings } from './types'

export const MARGIN = 8
export const SPLIT_GAP = 8
/** Bar across the top of the window: drag area, navigation, address, extensions, window controls. */
export const TOPBAR_HEIGHT = 40
/** Sidebar show/hide animation. Main (page views) and renderer (sidebar) use the same timing. */
export const SIDEBAR_ANIMATION_MS = 180

export function easeOutCubic(t: number): number {
  const f = t - 1
  return f * f * f + 1
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Area where web pages are shown. Single source of truth for main (views) and renderer (drawing).
 * reveal: 0 = sidebar hidden, 1 = shown; values in between during the animation.
 */
export function contentRect(
  winWidth: number,
  winHeight: number,
  settings: Settings,
  reveal = settings.sidebarVisible ? 1 : 0
): Rect {
  const sidebar = Math.round(MARGIN + (settings.sidebarWidth - MARGIN) * reveal)
  const onRight = settings.sidebarSide === 'right'
  const x = onRight ? MARGIN : sidebar
  return {
    x,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, winWidth - sidebar - MARGIN),
    height: Math.max(0, winHeight - TOPBAR_HEIGHT - MARGIN)
  }
}
