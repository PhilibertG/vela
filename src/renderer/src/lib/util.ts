export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

/** Initiale affichée quand un site n'a pas de favicon. */
export function initialOf(text: string): string {
  return (hostOf(text).match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase()
}
