// Pinned section of a Space: a tree of tabs and folders.
import type { Folder, Space } from './types'

type Folders = Record<string, Folder>

/** Visits the pinned tree depth-first, in display order. Each id is visited once, even if the data is corrupt. */
export function walkPinned(
  folders: Folders,
  space: Space,
  visit: (id: string, depth: number, parentId: string | null) => void
): void {
  const seen = new Set<string>()
  const walk = (ids: string[], depth: number, parentId: string | null): void => {
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      visit(id, depth, parentId)
      const folder = folders[id]
      if (folder) walk(folder.items, depth + 1, id)
    }
  }
  walk(space.pinned, 0, null)
}

/** Tab ids of the pinned section, folders included, in display order. */
export function pinnedTabIds(folders: Folders, space: Space): string[] {
  const ids: string[] = []
  walkPinned(folders, space, (id) => {
    if (!folders[id]) ids.push(id)
  })
  return ids
}

/** True if the pinned tree of the Space holds this tab or folder, at any depth. */
export function pinnedHas(folders: Folders, space: Space, id: string): boolean {
  let found = false
  walkPinned(folders, space, (x) => {
    if (x === id) found = true
  })
  return found
}

/** The folder itself and every folder below it. */
export function folderAndDescendants(folders: Folders, folderId: string): Set<string> {
  const out = new Set<string>()
  const walk = (id: string): void => {
    if (out.has(id) || !folders[id]) return
    out.add(id)
    for (const child of folders[id].items) walk(child)
  }
  walk(folderId)
  return out
}
