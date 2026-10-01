// Script chargé dans chaque page des onglets. Il ne fait quelque chose que sur le Chrome Web Store :
// il masque les invitations « Passer à Chrome », qui ne servent à rien dans Vela
// (l'installation des extensions fonctionne déjà).

const PROMO_TEXT = /^(Switch to Chrome|Passer à Chrome|Utiliser Chrome|Installer Chrome)/i

function hidePromos(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? ''
    if (!PROMO_TEXT.test(text)) continue
    const el = node.parentElement
    // Le popup est une boîte de dialogue ; le bandeau est le plus proche bloc piloté par un contrôleur.
    const target = el?.closest('[role="dialog"]') ?? el?.closest('[jscontroller]')
    if (target instanceof HTMLElement && target.tagName !== 'BODY' && target.style.display !== 'none') {
      target.style.setProperty('display', 'none', 'important')
    }
  }
}

if (location.hostname === 'chromewebstore.google.com') {
  const start = (): void => {
    hidePromos(document.body)
    let scheduled = false
    new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        hidePromos(document.body)
      })
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}
