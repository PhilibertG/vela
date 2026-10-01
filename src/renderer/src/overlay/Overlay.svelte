<script lang="ts">
  import { tick } from 'svelte'
  import type { CommandBarMode, Suggestion } from '../../../shared/types'
  import Favicon from '../lib/Favicon.svelte'
  import Icon from '../lib/Icon.svelte'
  import { hostOf } from '../lib/util'

  const vela = window.vela

  let view = $state<'none' | 'command' | 'find' | 'peek'>('none')
  let peek = $state<{ rect: { x: number; y: number; width: number; height: number }; url: string; title: string } | null>(null)
  let mode = $state<CommandBarMode>('new-tab')
  let query = $state('')
  let results = $state<Suggestion[]>([])
  let selected = $state(0)
  let input = $state<HTMLInputElement>()
  let openCount = $state(0)

  let findText = $state('')
  let findResult = $state<{ active: number; matches: number } | null>(null)
  let findInput = $state<HTMLInputElement>()

  // Numéro de la dernière requête, pour ignorer les réponses arrivées dans le désordre.
  let requestSeq = 0
  let resultsFor = ''

  const placeholders: Record<CommandBarMode, string> = {
    'new-tab': 'Rechercher, saisir une adresse ou une commande…',
    'edit-url': 'Saisir une adresse ou rechercher…',
    split: 'Ouvrir à côté : onglet, adresse ou recherche…'
  }

  async function refresh(): Promise<void> {
    const seq = ++requestSeq
    const q = query
    const list = await vela.suggest(q, mode)
    if (seq !== requestSeq) return
    results = list
    resultsFor = q
    selected = 0
  }

  /** Signale au processus principal que la barre est affichée (mesure du délai Ctrl+T). */
  function reportPainted(openedAt: number): void {
    requestAnimationFrame(() => requestAnimationFrame(() => vela.overlay({ type: 'painted', openedAt })))
  }

  vela.onOverlay(async (message) => {
    if (message.type === 'command-bar') {
      view = 'command'
      mode = message.open.mode
      query = message.open.initial
      results = []
      resultsFor = ''
      selected = 0
      openCount++
      await tick()
      input?.focus()
      input?.select()
      reportPainted(message.openedAt)
      void refresh()
    } else if (message.type === 'find-bar') {
      view = 'find'
      await tick()
      findInput?.focus()
      findInput?.select()
      if (findText) vela.overlay({ type: 'find', text: findText, forward: true, findNext: false })
    } else if (message.type === 'peek') {
      view = 'peek'
      peek = { rect: message.rect, url: message.url, title: message.title }
    } else if (message.type === 'peek-info') {
      if (peek) peek = { ...peek, url: message.url, title: message.title }
    } else if (message.type === 'find-result') {
      findResult = { active: message.active, matches: message.matches }
    }
  })

  function close(): void {
    view = 'none'
    vela.overlay({ type: 'close' })
  }

  function submit(index = selected): void {
    // Si l'utilisateur valide avant l'arrivée des suggestions, on utilise directement la saisie.
    const fresh = resultsFor === query
    const suggestion: Suggestion | undefined = fresh
      ? results[index]
      : query.trim()
        ? { kind: 'url', title: query, subtitle: '', value: query }
        : undefined
    if (!suggestion) return
    view = 'none'
    vela.overlay({ type: 'submit', mode, suggestion: $state.snapshot(suggestion) })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      selected = Math.min(results.length - 1, selected + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selected = Math.max(0, selected - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  function onFindKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      findResult = null
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      findNext(!e.shiftKey)
    }
  }

  function findNext(forward: boolean): void {
    if (findText) vela.overlay({ type: 'find', text: findText, forward, findNext: true })
  }

  const kindLabel: Record<Suggestion['kind'], string> = {
    tab: 'Onglet',
    history: 'Historique',
    search: 'Recherche',
    url: 'Adresse',
    command: 'Commande'
  }
</script>

{#if view === 'command'}
  <div class="scrim" role="presentation" onmousedown={close}></div>
  {#key openCount}
    <div class="panel" role="dialog" aria-label="Barre de commande">
      <div class="field">
        <span class="mode">
          {#if mode === 'split'}<Icon name="split" />{:else}<Icon name="plus" />{/if}
        </span>
        <input
          bind:this={input}
          bind:value={query}
          oninput={() => void refresh()}
          onkeydown={onKeydown}
          placeholder={placeholders[mode]}
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      {#if results.length > 0}
        <ul class="results" role="listbox">
          {#each results as r, i (r.kind + r.value)}
            <li
              role="option"
              aria-selected={i === selected}
              class:selected={i === selected}
              onmousemove={() => (selected = i)}
              onmousedown={(e) => {
                e.preventDefault()
                submit(i)
              }}
            >
              <span class="r-icon">
                {#if r.kind === 'tab' || r.kind === 'history'}
                  <Favicon src={r.favicon} url={r.kind === 'tab' ? r.subtitle : r.value} />
                {:else if r.kind === 'search'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>
                {:else if r.kind === 'url'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>
                {:else}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6" /></svg>
                {/if}
              </span>
              <span class="r-title">{r.title}</span>
              <span class="r-sub">{r.subtitle || kindLabel[r.kind]}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/key}
{:else if view === 'peek' && peek}
  <div class="scrim peek-scrim" role="presentation" onmousedown={() => vela.overlay({ type: 'peek-close' })}></div>
  <div
    class="peek-bar"
    style:left="{peek.rect.x}px"
    style:top="{peek.rect.y - 44}px"
    style:width="{peek.rect.width}px"
  >
    <Favicon url={peek.url} size={16} />
    <span class="peek-title">{peek.title || hostOf(peek.url)}</span>
    <span class="peek-host">{hostOf(peek.url)}</span>
    <button title="Ouvrir en onglet" onclick={() => vela.overlay({ type: 'peek-expand' })}><Icon name="expand" size={14} /><span>Ouvrir en onglet</span></button>
    <button title="Fermer (Échap)" onclick={() => vela.overlay({ type: 'peek-close' })}><Icon name="close" size={14} /></button>
  </div>
{:else if view === 'find'}
  <div class="find">
    <input
      bind:this={findInput}
      bind:value={findText}
      oninput={() => vela.overlay({ type: 'find', text: findText, forward: true, findNext: false })}
      onkeydown={onFindKeydown}
      placeholder="Rechercher dans la page"
      spellcheck="false"
    />
    <span class="count">{findText && findResult ? `${findResult.active}/${findResult.matches}` : ''}</span>
    <button title="Précédent (Maj+Entrée)" onclick={() => findNext(false)}><Icon name="back" size={14} /></button>
    <button title="Suivant (Entrée)" onclick={() => findNext(true)}><Icon name="forward" size={14} /></button>
    <button title="Fermer (Échap)" onclick={close}><Icon name="close" size={14} /></button>
  </div>
{/if}

<style>
  :global(html),
  :global(body) {
    background: transparent;
  }

  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    border-radius: 12px;
  }

  .peek-scrim {
    animation: fade 120ms ease-out;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  .peek-bar {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 6px 0 12px;
    border-radius: 10px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: 0 8px 24px hsl(0 0% 0% / 0.2);
    animation: fade 120ms ease-out;
  }

  .peek-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 500;
  }

  .peek-host {
    color: var(--fg-muted);
    font-size: 12px;
  }

  .peek-bar button {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    border-radius: 6px;
    color: var(--fg-muted);
    font-size: 12.5px;
  }

  .peek-bar button:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .panel {
    position: fixed;
    top: 16vh;
    left: 50%;
    width: min(680px, calc(100vw - 48px));
    transform: translateX(-50%);
    background: var(--panel);
    border: 1px solid var(--panel-line);
    border-radius: 14px;
    box-shadow:
      0 24px 60px hsl(0 0% 0% / 0.28),
      0 2px 8px hsl(0 0% 0% / 0.12);
    overflow: hidden;
    animation: enter 90ms ease-out;
  }

  @keyframes enter {
    from {
      opacity: 0;
      transform: translateX(-50%) scale(0.985);
    }
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    height: 54px;
  }

  .mode {
    display: grid;
    color: var(--fg-faint);
  }

  .field input {
    flex: 1;
    height: 100%;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 16px;
  }

  .field input::placeholder {
    color: var(--fg-faint);
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 6px;
    border-top: 1px solid var(--panel-line);
    max-height: 60vh;
    overflow-y: auto;
  }

  li {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 40px;
    padding: 0 12px;
    border-radius: 8px;
  }

  li.selected {
    background: hsl(var(--hue) 70% 50% / 0.14);
  }

  .r-icon {
    display: grid;
    place-items: center;
    width: 18px;
    color: var(--fg-muted);
  }

  .r-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .r-sub {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--fg-faint);
    font-size: 12px;
  }

  .find {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px 0 12px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    border-radius: 10px;
  }

  .find input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 13px;
  }

  .count {
    color: var(--fg-faint);
    font-size: 12px;
    min-width: 36px;
    text-align: right;
  }

  .find button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    color: var(--fg-muted);
  }

  .find button:hover {
    background: hsl(var(--hue) 20% 50% / 0.12);
    color: var(--fg);
  }
</style>
