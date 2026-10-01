<script lang="ts">
  import type { Action, ExtensionInfo, Settings } from '../../../shared/types'
  import Icon from '../lib/Icon.svelte'

  /** extensionsVersion changes each time extensions are loaded, unloaded or removed. */
  let { settings, extensionsVersion }: { settings: Settings; extensionsVersion: number } = $props()

  const vela = window.vela
  const send = (action: Action): void => vela.send(action)
  const update = (patch: Partial<Settings>): void => send({ type: 'update-settings', settings: patch })

  const SEARCH_ENGINES = [
    { name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
    { name: 'Qwant', url: 'https://www.qwant.com/?q=%s' },
    { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
    { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' }
  ]
  const SLEEP_CHOICES = [
    { minutes: 5, label: '5 minutes' },
    { minutes: 15, label: '15 minutes' },
    { minutes: 30, label: '30 minutes' },
    { minutes: 60, label: '1 heure' },
    { minutes: 240, label: '4 heures' }
  ]
  const WEB_STORE_URL = 'https://chromewebstore.google.com/'

  let extensions = $state<ExtensionInfo[]>([])
  $effect(() => {
    void extensionsVersion
    void vela.getExtensions().then((list) => (extensions = list))
  })

  const knownEngine = $derived(SEARCH_ENGINES.some((e) => e.url === settings.searchUrl))
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && send({ type: 'close-settings' })} />

<div class="panel">
  <header>
    <h1>Réglages</h1>
    <button class="close" title="Fermer (Échap)" onclick={() => send({ type: 'close-settings' })}><Icon name="close" /></button>
  </header>

  <section>
    <h2>Disposition</h2>
    <div class="row">
      <span>Position de la barre latérale</span>
      <div class="segmented">
        <button class:on={settings.sidebarSide === 'left'} onclick={() => update({ sidebarSide: 'left' })}>À gauche</button>
        <button class:on={settings.sidebarSide === 'right'} onclick={() => update({ sidebarSide: 'right' })}>À droite</button>
      </div>
    </div>
    <div class="row">
      <span>Largeur de la barre latérale</span>
      <input
        type="range"
        min="180"
        max="420"
        step="4"
        value={settings.sidebarWidth}
        oninput={(e) => update({ sidebarWidth: Number(e.currentTarget.value) })}
      />
    </div>
  </section>

  <section>
    <h2>Recherche</h2>
    <div class="row">
      <span>Moteur de recherche de la barre de commande</span>
      <select value={settings.searchUrl} onchange={(e) => update({ searchUrl: e.currentTarget.value })}>
        {#each SEARCH_ENGINES as engine (engine.url)}
          <option value={engine.url}>{engine.name}</option>
        {/each}
        {#if !knownEngine}<option value={settings.searchUrl}>Personnalisé</option>{/if}
      </select>
    </div>
  </section>

  <section>
    <h2>Mise en veille</h2>
    <div class="row">
      <span>Mettre en veille un onglet inactif après</span>
      <select
        value={settings.sleepAfterMinutes}
        onchange={(e) => update({ sleepAfterMinutes: Number(e.currentTarget.value) })}
      >
        {#each SLEEP_CHOICES as choice (choice.minutes)}
          <option value={choice.minutes}>{choice.label}</option>
        {/each}
      </select>
    </div>
    <p class="note">Un onglet en veille libère sa mémoire. Il se recharge quand vous y revenez.</p>
  </section>

  <section>
    <h2>Extensions</h2>
    {#if extensions.length === 0}
      <p class="note">Aucune extension installée.</p>
    {/if}
    {#each extensions as ext (ext.id)}
      <div class="ext" class:off={!ext.enabled}>
        {#if ext.icon}<img src={ext.icon} alt="" width="24" height="24" />{:else}<span class="ext-icon"><Icon name="puzzle" size={16} /></span>{/if}
        <div class="ext-name">
          <span>{ext.name}</span>
          <small>{ext.version}{ext.enabled ? '' : ' · désactivée'}</small>
        </div>
        {#if ext.hasOptions}
          <button class="link" onclick={() => send({ type: 'extension-options', id: ext.id })}>Options</button>
        {/if}
        <button class="link danger" onclick={() => send({ type: 'extension-uninstall', id: ext.id })}>Désinstaller</button>
        <label class="switch" title={ext.enabled ? 'Désactiver' : 'Activer'}>
          <input
            type="checkbox"
            checked={ext.enabled}
            onchange={(e) => send({ type: 'extension-toggle', id: ext.id, enabled: e.currentTarget.checked })}
          />
          <span></span>
        </label>
      </div>
    {/each}
    <button class="link add" onclick={() => send({ type: 'new-tab', url: WEB_STORE_URL })}>Ajouter des extensions depuis le Chrome Web Store</button>
  </section>
</div>

<style>
  .panel {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    padding: 28px max(32px, calc((100% - 640px) / 2));
    text-align: left;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }

  section {
    padding: 16px 0;
    border-top: 1px solid var(--line);
  }

  .close {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 6px;
    color: var(--fg-muted);
  }

  .close:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 36px;
  }

  .segmented {
    display: flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--item-hover);
  }

  .segmented button {
    padding: 5px 12px;
    border-radius: 6px;
    color: var(--fg-muted);
  }

  .segmented button.on {
    background: var(--item-active);
    color: var(--fg);
    box-shadow: var(--item-active-shadow);
  }

  select {
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--item-hover);
    color: var(--fg);
    font: inherit;
  }

  /* The dropdown list is drawn by the system: without explicit colors, light text lands on a white background. */
  option {
    background-color: var(--panel);
    color: var(--fg);
  }

  input[type='range'] {
    width: 180px;
    accent-color: var(--accent);
  }

  .note {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--fg-faint);
  }

  .ext {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
  }

  .ext.off img,
  .ext.off .ext-icon {
    opacity: 0.4;
  }

  .ext-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--fg-muted);
  }

  .ext-name {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .ext-name span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .ext-name small {
    color: var(--fg-faint);
  }

  .link {
    padding: 4px 8px;
    border-radius: 6px;
    color: var(--accent);
    font-size: 12.5px;
  }

  .link:hover {
    background: var(--item-hover);
  }

  .link.add {
    margin: 4px 0 0 -8px;
  }

  .link.danger {
    color: hsl(0 70% 55%);
  }

  .switch {
    position: relative;
    width: 34px;
    height: 20px;
    flex: none;
  }

  .switch input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }

  .switch span {
    position: absolute;
    inset: 0;
    border-radius: 10px;
    background: var(--line);
    pointer-events: none;
    transition: background-color 120ms ease;
  }

  .switch span::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    transition: transform 120ms ease;
  }

  .switch input:checked + span {
    background: var(--accent);
  }

  .switch input:checked + span::after {
    transform: translateX(14px);
  }
</style>
