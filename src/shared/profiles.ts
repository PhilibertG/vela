// Browsing profiles: the shared one, and one per Space that asks for its own.
import type { Space, State } from './types'

export const SHARED_PARTITION = 'persist:vela'

/** Session partition holding the cookies and site data of a Space. */
export function partitionOf(space: Pick<Space, 'id' | 'profile'>): string {
  return space.profile === 'own' ? `persist:vela-space-${space.id}` : SHARED_PARTITION
}

/** Favorites shown in a Space: its own list with its own profile, the shared list otherwise. */
export function favoritesOf(state: Pick<State, 'favorites'>, space: Space): string[] {
  return space.profile === 'own' ? space.favorites : state.favorites
}
