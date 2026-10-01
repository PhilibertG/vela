// Script loaded in every tab page (isolated from the page's own scripts). Two jobs:
// - on the Chrome Web Store, hide the "Switch to Chrome" prompts (installing extensions already works in Vela);
// - report link clicks so Vela can open them in Peek.
import { ipcRenderer } from 'electron'

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

// Link clicks are reported to Vela, which decides whether they open in Peek (Shift+click, or a pinned
// tab linking to another site). Only the URL of the clicked link is sent; the page gets no access to Vela.
document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
    const link = (e.target as Element | null)?.closest?.('a[href]')
    if (!(link instanceof HTMLAnchorElement) || !/^https?:$/.test(link.protocol)) return
    if (ipcRenderer.sendSync('vela:link-click', link.href, e.shiftKey) === true) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  },
  true
)
