<script lang="ts">
  import { tick } from 'svelte'
  import { Tween } from 'svelte/motion'
  import type { Action, Folder, Panel, Space, State, Tab } from '../../../shared/types'
  import { folderAndDescendants } from '../../../shared/folders'
  import {
    MARGIN,
    SIDEBAR_ANIMATION_MS,
    SPLIT_GAP,
    TOPBAR_HEIGHT,
    contentRect,
    easeOutCubic
  } from '../../../shared/layout'
  import Icon from '../lib/Icon.svelte'
  import Favicon from '../lib/Favicon.svelte'
  import SettingsPanel from './SettingsPanel.svelte'
  import ArchivePanel from './ArchivePanel.svelte'
  import { hostOf } from '../lib/util'

  type ListName = 'favorites' | 'pinned' | 'today'

  const vela = window.vela
  const send = (action: Action): void => vela.send(action)

  let app = $state<State | null>(null)
  let editingSpace = $state<string | null>(null)
  let editingFolder = $state<string | null>(null)
  let maximized = $state(false)
  let panel = $state<Panel | null>(null)
  let extensionsVersion = $state(0)
  let archiveVersion = $state(0)
  let winWidth = $state(window.innerWidth)
  let winHeight = $state(window.innerHeight)

  // Glisser-déposer des onglets.
  let dragId = $state<string | null>(null)
  /** folderId: container in the pinned tree (null = top level). into: dropping onto a folder row. */
  let dropHint = $state<{
    list: ListName
    spaceId?: string
    folderId?: string | null
    beforeId: string | null
    into?: boolean
  } | null>(null)
  const draggingFolder = $derived(!!(dragId && app?.folders[dragId]))

  vela.getState().then(async (s) => {
    app = s
    // La fenêtre est encore masquée (pas de requestAnimationFrame possible) :
    // on prévient le processus principal dès que le DOM est construit.
    await tick()
    vela.uiReady()
  })
  vela.onState((s) => (app = s))
  vela.onEvent((e) => {
    if (e.type === 'edit-space-name') editingSpace = e.spaceId
    if (e.type === 'edit-folder-name') editingFolder = e.id
    if (e.type === 'window-state') maximized = e.maximized
    if (e.type === 'panel') panel = e.panel
    if (e.type === 'extensions-changed') extensionsVersion++
    if (e.type === 'archive-changed') archiveVersion++
  })

  const space = $derived<Space | null>(
    app ? (app.spaces.find((s) => s.id === app!.activeSpaceId) ?? app.spaces[0]) : null
  )
  const activeId = $derived(space?.activeTabId ?? null)
  const activeTab = $derived<Tab | null>(app && activeId ? (app.tabs[activeId] ?? null) : null)
  const settings = $derived(app?.settings)
  const splitShown = $derived(
    !!space?.split && (space.split.left === activeId || space.split.right === activeId)
  )

  $effect(() => {
    document.documentElement.style.setProperty('--hue', String(space?.hue ?? 215))
  })

  // Sidebar show/hide: same duration and curve as the page views moved by shell.ts.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const reveal = new Tween(1, { duration: reducedMotion ? 0 : SIDEBAR_ANIMATION_MS, easing: easeOutCubic })
  let revealReady = false
  $effect(() => {
    if (!settings) return
    const target = settings.sidebarVisible ? 1 : 0
    // First state received: no animation at startup.
    if (!revealReady) {
      revealReady = true
      void reveal.set(target, { duration: 0 })
    } else {
      reveal.target = target
    }
  })
  const sidebarShown = $derived(reveal.current > 0.001)
  const sidebarSettled = $derived(reveal.current === 1 && !!settings?.sidebarVisible)

  // Zone occupée par les pages, identique au calcul de shell.ts.
  const content = $derived(
    settings ? contentRect(winWidth, winHeight, settings, reveal.current) : { x: 0, y: 0, width: 0, height: 0 }
  )
  const onRight = $derived(settings?.sidebarSide === 'right')
  const secure = $derived(activeTab ? activeTab.url.startsWith('https:') : false)

  function tabsOf(list: string[]): Tab[] {
    return app ? list.map((id) => app!.tabs[id]).filter(Boolean) : []
  }

  // ------------------------------------------------------------ Glisser-déposer

  function onDragStart(e: DragEvent, id: string): void {
    dragId = id
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function onDragEnd(): void {
    dragId = null
    dropHint = null
  }

  function listIds(list: ListName, spaceId?: string, folderId?: string | null): string[] {
    if (!app) return []
    if (list === 'pinned' && folderId) return app.folders[folderId]?.items ?? []
    if (list === 'favorites') return app.favorites
    const s = app.spaces.find((x) => x.id === (spaceId ?? app!.activeSpaceId))
    return s ? s[list] : []
  }

  /** Folders only go in the pinned section, and never inside themselves. */
  function canDrop(list: ListName, folderId: string | null): boolean {
    if (!app || !dragId || !draggingFolder) return true
    if (list !== 'pinned') return false
    return !folderId || !folderAndDescendants(app.folders, dragId).has(folderId)
  }

  /** Survol d'un onglet : on insère avant lui, ou après si la souris est dans sa moitié basse/droite. */
  function onDragOverItem(e: DragEvent, list: ListName, id: string, horizontal = false, folderId: string | null = null): void {
    if (!dragId) return
    e.stopPropagation()
    if (!canDrop(list, folderId)) return
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = horizontal ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2
    const ids = listIds(list, undefined, folderId)
    const index = ids.indexOf(id) + (after ? 1 : 0)
    dropHint = { list, folderId, beforeId: ids[index] ?? null }
  }

  /** Over a folder row: top quarter inserts before it, the rest drops into it. */
  function onDragOverFolder(e: DragEvent, folder: Folder, parentId: string | null): void {
    if (!dragId) return
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 4
    if (before) {
      if (!canDrop('pinned', parentId) || dragId === folder.id) return
      e.preventDefault()
      dropHint = { list: 'pinned', folderId: parentId, beforeId: folder.id }
    } else {
      if (!canDrop('pinned', folder.id)) return
      e.preventDefault()
      dropHint = { list: 'pinned', folderId: folder.id, beforeId: null, into: true }
    }
  }

  function onDragOverList(e: DragEvent, list: ListName, spaceId?: string): void {
    if (!dragId || !canDrop(list, null)) return
    e.preventDefault()
    if (!dropHint || dropHint.list !== list || dropHint.spaceId !== spaceId || dropHint.folderId) {
      dropHint = { list, spaceId, beforeId: null }
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const id = dragId
    const hint = dropHint
    const isFolder = draggingFolder
    onDragEnd()
    if (!id || !hint) return
    const ids = listIds(hint.list, hint.spaceId, hint.folderId).filter((x) => x !== id)
    let index = hint.beforeId ? ids.indexOf(hint.beforeId) : ids.length
    if (index < 0) index = ids.length
    if (isFolder) {
      send({ type: 'move-folder', id, parentId: hint.folderId ?? null, spaceId: hint.spaceId, index })
    } else {
      const folderId = hint.folderId ?? undefined
      send({ type: 'move-tab', tabId: id, to: hint.list, spaceId: hint.spaceId, folderId, index })
    }
  }

  function finishFolderRename(id: string, value: string): void {
    editingFolder = null
    send({ type: 'rename-folder', id, name: value })
  }

  // ------------------------------------------------------------ Redimensionnement

  function startResize(e: PointerEvent, kind: 'sidebar' | 'split'): void {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let frame = 0
    const move = (ev: PointerEvent): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (kind === 'sidebar') {
          const width = onRight ? winWidth - ev.clientX : ev.clientX
          send({ type: 'set-sidebar-width', width: width + MARGIN / 2 })
        }
        else send({ type: 'set-split-ratio', ratio: (ev.clientX - content.x - SPLIT_GAP / 2) / (content.width - SPLIT_GAP) })
      })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  // ------------------------------------------------------------ Swipe between Spaces

  // Two-finger horizontal swipe on the sidebar switches Space, like Arc.
  // Trackpads report it as horizontal wheel events; small movements add up until the threshold.
  const SWIPE_THRESHOLD = 120
  const SWIPE_COOLDOWN_MS = 450
  let swipeDelta = 0
  let swipeLockedUntil = 0
  let swipeReset: ReturnType<typeof setTimeout> | undefined

  function onSidebarWheel(e: WheelEvent): void {
    if (!app || !space || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    if (performance.now() < swipeLockedUntil) return
    swipeDelta += e.deltaX
    clearTimeout(swipeReset)
    swipeReset = setTimeout(() => (swipeDelta = 0), 200)
    if (Math.abs(swipeDelta) < SWIPE_THRESHOLD) return
    const index = app.spaces.indexOf(space) + (swipeDelta > 0 ? 1 : -1)
    swipeDelta = 0
    swipeLockedUntil = performance.now() + SWIPE_COOLDOWN_MS
    const target = app.spaces[index]
    if (target) send({ type: 'select-space', spaceId: target.id })
  }

  function finishRename(spaceId: string, value: string): void {
    editingSpace = null
    send({ type: 'rename-space', spaceId, name: value })
  }

  function focusSelect(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

<svelte:window
  onresize={() => {
    winWidth = window.innerWidth
    winHeight = window.innerHeight
  }}
/>

{#snippet tabRow(tab: Tab, list: ListName, parentId: string | null = null, depth = 0)}
  <div
    class="tab"
    class:active={tab.id === activeId}
    class:asleep={tab.asleep}
    class:drop-before={dropHint?.list === list &&
      dropHint.beforeId === tab.id &&
      (dropHint.folderId ?? null) === parentId &&
      dragId !== tab.id}
    style:padding-left="{10 + depth * 14}px"
    draggable="true"
    role="button"
    tabindex="-1"
    title={tab.url}
    ondragstart={(e) => onDragStart(e, tab.id)}
    ondragend={onDragEnd}
    ondragover={(e) => onDragOverItem(e, list, tab.id, false, parentId)}
    ondrop={onDrop}
    onmousedown={(e) => {
      if (e.button === 0) send({ type: 'select-tab', tabId: tab.id })
      if (e.button === 1) send({ type: 'close-tab', tabId: tab.id })
    }}
    oncontextmenu={(e) => {
      e.preventDefault()
      send({ type: 'tab-menu', tabId: tab.id })
    }}
  >
    <span class="icon" class:loading={tab.loading}><Favicon src={tab.favicon} url={tab.url} /></span>
    <span class="label">{tab.title || hostOf(tab.url)}</span>
    {#if tab.audible}<span class="badge"><Icon name="sound" size={13} /></span>{/if}
    {#if space?.split && (space.split.left === tab.id || space.split.right === tab.id)}
      <span class="badge"><Icon name="split" size={13} /></span>
    {/if}
    {#if list !== 'today' && tab.homeUrl && tab.homeUrl !== tab.url}
      <button
        class="row-btn"
        title="Revenir à l'URL d'origine"
        onmousedown={(e) => e.stopPropagation()}
        onclick={() => send({ type: 'reset-tab', tabId: tab.id })}><Icon name="reset" size={13} /></button
      >
    {/if}
    <button
      class="row-btn close"
      title={list === 'today' ? 'Fermer' : 'Décharger'}
      onmousedown={(e) => e.stopPropagation()}
      onclick={() => send({ type: 'close-tab', tabId: tab.id })}><Icon name="close" size={13} /></button
    >
  </div>
{/snippet}

{#snippet pinnedItems(ids: string[], parentId: string | null, depth: number)}
  {#each ids as id (id)}
    {#if app?.folders[id]}
      {@render folderRow(app.folders[id], parentId, depth)}
    {:else if app?.tabs[id]}
      {@render tabRow(app.tabs[id], 'pinned', parentId, depth)}
    {/if}
  {/each}
{/snippet}

{#snippet folderRow(folder: Folder, parentId: string | null, depth: number)}
  <div
    class="tab folder"
    class:drop-before={dropHint?.list === 'pinned' &&
      !dropHint.into &&
      dropHint.beforeId === folder.id &&
      (dropHint.folderId ?? null) === parentId}
    class:drop-into={dropHint?.into && dropHint.folderId === folder.id}
    style:padding-left="{10 + depth * 14}px"
    draggable={editingFolder !== folder.id}
    role="button"
    tabindex="-1"
    ondragstart={(e) => onDragStart(e, folder.id)}
    ondragend={onDragEnd}
    ondragover={(e) => onDragOverFolder(e, folder, parentId)}
    ondrop={onDrop}
    onclick={() => editingFolder !== folder.id && send({ type: 'toggle-folder', id: folder.id })}
    onkeydown={() => {}}
    oncontextmenu={(e) => {
      e.preventDefault()
      send({ type: 'folder-menu', id: folder.id })
    }}
  >
    <span class="chevron" class:open={folder.open}><Icon name="chevron" size={12} /></span>
    <span class="icon"><Icon name="folder" size={15} /></span>
    {#if editingFolder === folder.id}
      <input
        class="folder-name"
        value={folder.name}
        use:focusSelect
        onclick={(e) => e.stopPropagation()}
        onblur={(e) => finishFolderRename(folder.id, e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') editingFolder = null
        }}
      />
    {:else}
      <span class="label" ondblclick={(e) => { e.stopPropagation(); editingFolder = folder.id }} role="textbox" tabindex="-1">{folder.name}</span>
    {/if}
  </div>
  {#if folder.open}
    {@render pinnedItems(folder.items, folder.id, depth + 1)}
    {#if folder.items.length === 0}
      <div class="hint folder-empty" style:padding-left="{24 + (depth + 1) * 14}px">Dossier vide</div>
    {/if}
  {/if}
{/snippet}

{#if app && space && settings}
  <div class="backdrop" class:rounded={!maximized}></div>

  <header class="topbar" style:height="{TOPBAR_HEIGHT}px">
    <div class="group">
      <button title="{settings.sidebarVisible ? 'Masquer' : 'Afficher'} la barre latérale (Ctrl+S)" onclick={() => send({ type: 'toggle-sidebar' })}><Icon name="sidebar" /></button>
      <button title="Précédent (Alt+←)" disabled={!activeTab?.canGoBack} onclick={() => send({ type: 'go-back' })}><Icon name="back" /></button>
      <button title="Suivant (Alt+→)" disabled={!activeTab?.canGoForward} onclick={() => send({ type: 'go-forward' })}><Icon name="forward" /></button>
      <button title="Actualiser (Ctrl+R)" disabled={!activeTab} onclick={() => send({ type: 'reload' })}><Icon name="reload" /></button>
    </div>

    <button class="urlbar" title="Modifier l'adresse (Ctrl+L)" onclick={() => send({ type: 'open-command-bar', mode: 'edit-url' })}>
      {#if activeTab}
        <span class="lock" class:insecure={!secure} title={secure ? 'Connexion chiffrée (HTTPS)' : 'Connexion non chiffrée'}>
          <Icon name={secure ? 'lock' : 'unlock'} size={13} />
        </span>
        <span class="host">{hostOf(activeTab.url)}</span>
        {#if activeTab.loading}<span class="spinner"></span>{/if}
      {:else}
        <span class="placeholder">Rechercher ou saisir une adresse</span>
      {/if}
    </button>

    <div class="group">
      <div class="extensions">
        <browser-action-list partition="persist:vela" alignment="bottom left"></browser-action-list>
      </div>
      <button title="Extensions" onclick={() => send({ type: 'manage-extensions' })}><Icon name="puzzle" size={15} /></button>
      <button title="Archive" onclick={() => send({ type: 'open-panel', panel: 'archive' })}><Icon name="archive" size={15} /></button>
      <button title="Réglages (Ctrl+,)" onclick={() => send({ type: 'open-panel', panel: 'settings' })}><Icon name="gear" size={15} /></button>
      <span class="sep"></span>
      <button title="Réduire" onclick={() => send({ type: 'window', command: 'minimize' })}><Icon name="minimize" size={14} /></button>
      <button title={maximized ? 'Restaurer' : 'Agrandir'} onclick={() => send({ type: 'window', command: 'maximize' })}><Icon name="maximize" size={13} /></button>
      <button class="quit" title="Fermer" onclick={() => send({ type: 'window', command: 'close' })}><Icon name="close" size={14} /></button>
    </div>
  </header>

  {#if sidebarShown}
    <aside
      class="sidebar"
      class:right={onRight}
      style:top="{TOPBAR_HEIGHT}px"
      style:width="{settings.sidebarWidth - MARGIN}px"
      style:transform="translateX({(onRight ? 1 : -1) * (1 - reveal.current) * settings.sidebarWidth}px)"
      style:opacity={0.4 + 0.6 * reveal.current}
      onwheel={onSidebarWheel}
    >
      <section
        class="favorites"
        class:empty={app.favorites.length === 0}
        class:drop-end={dropHint?.list === 'favorites' && dropHint.beforeId === null}
        role="list"
        ondragover={(e) => onDragOverList(e, 'favorites')}
        ondrop={onDrop}
      >
        {#each tabsOf(app.favorites) as tab (tab.id)}
          <div
            class="fav"
            class:active={tab.id === activeId}
            class:asleep={tab.asleep}
            class:drop-before={dropHint?.list === 'favorites' && dropHint.beforeId === tab.id && dragId !== tab.id}
            role="button"
            tabindex="-1"
            title={tab.title}
            draggable="true"
            ondragstart={(e) => onDragStart(e, tab.id)}
            ondragend={onDragEnd}
            ondragover={(e) => onDragOverItem(e, 'favorites', tab.id, true)}
            ondrop={onDrop}
            onmousedown={(e) => e.button === 0 && send({ type: 'select-tab', tabId: tab.id })}
            oncontextmenu={(e) => {
              e.preventDefault()
              send({ type: 'tab-menu', tabId: tab.id })
            }}
          >
            <Favicon src={tab.favicon} url={tab.url} size={20} />
          </div>
        {/each}
        {#if app.favorites.length === 0}
          <span class="hint">Glissez un onglet ici pour l'ajouter aux favoris</span>
        {/if}
      </section>

      <div class="space-title" role="heading" aria-level="2" oncontextmenu={(e) => { e.preventDefault(); send({ type: 'space-menu', spaceId: space!.id }) }}>
        {#if editingSpace === space.id}
          <input
            value={space.name}
            use:focusSelect
            onblur={(e) => finishRename(space!.id, e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') editingSpace = null
            }}
          />
        {:else}
          <span ondblclick={() => (editingSpace = space!.id)} role="textbox" tabindex="-1">{space.name}</span>
          <button class="title-btn" title="Nouveau dossier" onclick={() => send({ type: 'new-folder', spaceId: space!.id })}><Icon name="folder-plus" size={14} /></button>
        {/if}
      </div>

      <div class="scroll">
        <section
          class="list pinned"
          class:drop-end={dropHint?.list === 'pinned' && dropHint.beforeId === null}
          role="list"
          ondragover={(e) => onDragOverList(e, 'pinned')}
          ondrop={onDrop}
        >
          {@render pinnedItems(space.pinned, null, 0)}
          {#if space.pinned.length === 0}
            <div class="hint">Glissez un onglet ici pour l'épingler</div>
          {/if}
        </section>

        <div class="divider">
          <span></span>
          {#if space.today.length > 0}
            <button class="clear" onclick={() => send({ type: 'clear-today' })}>Effacer</button>
          {/if}
        </div>

        <button class="new-tab" onclick={() => send({ type: 'open-command-bar', mode: 'new-tab' })}>
          <Icon name="plus" size={15} /><span>Nouvel onglet</span><kbd>Ctrl T</kbd>
        </button>

        {#if splitShown}
          <div class="split-info">
            <Icon name="split" size={13} /><span>Vue partagée</span>
            <button onclick={() => send({ type: 'close-split' })}>Fermer</button>
          </div>
        {/if}

        <section
          class="list today"
          class:drop-end={dropHint?.list === 'today' && dropHint.beforeId === null}
          role="list"
          ondragover={(e) => onDragOverList(e, 'today')}
          ondrop={onDrop}
        >
          {#each tabsOf(space.today) as tab (tab.id)}
            {@render tabRow(tab, 'today')}
          {/each}
        </section>
      </div>

      <footer class="spaces">
        {#each app.spaces as s, i (s.id)}
          <button
            class="space-dot"
            class:active={s.id === space.id}
            class:drop-target={dropHint?.list === 'today' && dropHint.spaceId === s.id}
            style:--dot-hue={s.hue}
            title="{s.name} (Ctrl+{i + 1})"
            onclick={() => send({ type: 'select-space', spaceId: s.id })}
            oncontextmenu={(e) => {
              e.preventDefault()
              send({ type: 'space-menu', spaceId: s.id })
            }}
            ondragover={(e) => s.id !== space!.id && onDragOverList(e, 'today', s.id)}
            ondrop={onDrop}>{s.name.slice(0, 1).toUpperCase()}</button
          >
        {/each}
        <button class="space-add" title="Nouvel espace" onclick={() => send({ type: 'new-space' })}><Icon name="plus" size={14} /></button>
      </footer>
    </aside>

    {#if sidebarSettled}
    <div
      class="resize-handle"
      style:left="{onRight ? winWidth - settings.sidebarWidth : settings.sidebarWidth - MARGIN}px"
      style:top="{TOPBAR_HEIGHT}px"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={(e) => startResize(e, 'sidebar')}
    ></div>
    {/if}
  {/if}
  {#if !settings.sidebarVisible}
    <button class="reveal" class:right={onRight} style:top="{TOPBAR_HEIGHT}px" title="Afficher la barre latérale (Ctrl+S)" onclick={() => send({ type: 'toggle-sidebar' })}></button>
  {/if}

  <!-- Zone des pages : visible seulement quand aucun onglet ne la recouvre. -->
  <div
    class="content"
    style:left="{content.x}px"
    style:top="{content.y}px"
    style:width="{content.width}px"
    style:height="{content.height}px"
  >
    {#if panel === 'settings'}
      <SettingsPanel {settings} {extensionsVersion} />
    {:else if panel === 'archive'}
      <ArchivePanel {archiveVersion} />
    {:else if !activeTab}
      <div class="empty">
        <p class="empty-title">{space.name}</p>
        <p>
          <kbd>Ctrl T</kbd> pour ouvrir un site · <kbd>Ctrl {app.spaces.indexOf(space) + 1}</kbd> pour revenir ici
        </p>
      </div>
    {:else if activeTab.asleep}
      <div class="empty"><span class="spinner big"></span></div>
    {/if}
  </div>

  {#if splitShown && space.split && !panel}
    <div
      class="split-handle"
      role="separator"
      aria-orientation="vertical"
      style:left="{content.x + Math.round((content.width - SPLIT_GAP) * space.split.ratio)}px"
      style:top="{content.y}px"
      style:width="{SPLIT_GAP}px"
      style:height="{content.height}px"
      onpointerdown={(e) => startResize(e, 'split')}
    ></div>
  {/if}
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: linear-gradient(160deg, var(--bg-a), var(--bg-b));
    z-index: -1;
  }

  /* Coins arrondis de la fenêtre (Linux : la fenêtre est transparente autour). */
  .backdrop.rounded {
    border-radius: 12px;
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .sidebar {
    position: fixed;
    left: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 4px 8px 10px;
  }

  .sidebar.right {
    left: auto;
    right: 0;
    padding: 0 10px 8px 4px;
  }

  .topbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 8px;
    -webkit-app-region: drag;
  }

  .topbar button {
    -webkit-app-region: no-drag;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .group > button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: var(--fg-muted);
  }

  .group > button:hover:not(:disabled) {
    background: var(--item-hover);
    color: var(--fg);
  }

  .group > button:disabled {
    opacity: 0.35;
  }

  .group .quit:hover {
    background: hsl(0 75% 52%) !important;
    color: white !important;
  }

  .sep {
    width: 1px;
    height: 16px;
    margin: 0 6px;
    background: var(--line);
  }

  .urlbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    max-width: 560px;
    height: 28px;
    margin: 0 auto;
    padding: 0 12px;
    border-radius: var(--radius);
    background: var(--item-hover);
    text-align: left;
    transition: background-color 120ms ease;
  }

  .urlbar:hover {
    background: var(--item-active);
  }

  .urlbar .lock {
    display: grid;
    color: var(--fg-muted);
  }

  .urlbar .lock.insecure {
    color: hsl(0 70% 55%);
  }

  .urlbar .host {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 500;
  }

  .urlbar .placeholder {
    color: var(--fg-muted);
  }

  .extensions {
    display: flex;
    align-items: center;
    -webkit-app-region: no-drag;
  }

  .extensions browser-action-list {
    display: flex;
  }

  .favorites {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
    gap: 6px;
    min-height: 44px;
    border-radius: var(--radius);
  }

  .favorites.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--line);
  }

  .fav {
    display: grid;
    place-items: center;
    height: 44px;
    border-radius: var(--radius);
    background: var(--item-hover);
    transition: background-color 120ms ease;
  }

  .fav:hover {
    background: var(--item-active);
  }

  .fav.active {
    background: var(--item-active);
    box-shadow: var(--item-active-shadow), inset 0 0 0 1.5px var(--accent);
  }

  .fav.asleep :global(img) {
    opacity: 0.55;
  }

  .fav.drop-before {
    box-shadow: -3px 0 0 var(--accent);
  }

  .space-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 26px;
    padding: 8px 4px 2px 8px;
    font-weight: 600;
    color: var(--fg-muted);
    font-size: 12px;
  }

  .title-btn {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--fg-muted);
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .space-title:hover .title-btn {
    opacity: 1;
  }

  .title-btn:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .folder .chevron {
    display: grid;
    margin-right: -4px;
    color: var(--fg-muted);
    transition: transform 120ms ease;
  }

  .folder .chevron.open {
    transform: rotate(90deg);
  }

  .folder .icon {
    color: var(--fg-muted);
  }

  .folder.drop-into {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }

  .folder-name {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--item-active);
    outline: none;
  }

  .hint.folder-empty {
    padding-top: 4px;
    padding-bottom: 4px;
    text-align: left;
  }

  .space-title input {
    width: 100%;
    padding: 2px 4px;
    margin: -3px -5px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--item-active);
    outline: none;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    margin-right: -4px;
    padding-right: 4px;
  }

  .scroll::-webkit-scrollbar {
    width: 6px;
  }

  .scroll::-webkit-scrollbar-thumb {
    background: var(--line);
    border-radius: 3px;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: var(--radius);
  }

  .list.today {
    min-height: 60px;
  }

  .list.drop-end,
  .favorites.drop-end {
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  .hint {
    padding: 8px;
    color: var(--fg-faint);
    font-size: 11.5px;
    text-align: center;
  }

  .tab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 34px;
    padding: 0 6px 0 10px;
    border-radius: var(--radius);
    transition: background-color 100ms ease;
  }

  .tab:hover {
    background: var(--item-hover);
  }

  .tab.active {
    background: var(--item-active);
    box-shadow: var(--item-active-shadow);
  }

  .tab.drop-before::before {
    content: '';
    position: absolute;
    top: -1px;
    left: 6px;
    right: 6px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  .tab.asleep:not(.active) .label {
    color: var(--fg-muted);
  }

  .tab .icon {
    position: relative;
    display: grid;
    place-items: center;
  }

  .tab .icon.loading::after {
    content: '';
    position: absolute;
    inset: -3px;
    border: 1.5px solid transparent;
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .badge {
    display: grid;
    color: var(--fg-muted);
  }

  .row-btn {
    display: none;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--fg-muted);
  }

  .tab:hover .row-btn {
    display: grid;
  }

  .row-btn:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 4px 4px 8px;
    height: 18px;
  }

  .divider span {
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  .divider .clear {
    font-size: 11px;
    color: var(--fg-faint);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .divider .clear:hover {
    color: var(--fg);
    background: var(--item-hover);
  }

  .new-tab {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--radius);
    color: var(--fg-muted);
  }

  .new-tab:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .new-tab span {
    flex: 1;
    text-align: left;
  }

  kbd {
    font-family: inherit;
    font-size: 10.5px;
    color: var(--fg-faint);
    padding: 1px 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
  }

  .split-info {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0 4px;
    padding: 4px 10px;
    font-size: 11.5px;
    color: var(--fg-muted);
  }

  .split-info span {
    flex: 1;
  }

  .split-info button {
    color: var(--accent);
    font-size: 11.5px;
  }

  .spaces {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-top: 6px;
    flex-wrap: wrap;
  }

  .space-dot {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    color: hsl(var(--dot-hue) 50% 30%);
    background: hsl(var(--dot-hue) 60% 75% / 0.6);
    transition: transform 120ms ease;
  }

  .space-dot:hover {
    transform: scale(1.08);
  }

  .space-dot.active {
    background: hsl(var(--dot-hue) 65% 55%);
    color: white;
  }

  .space-dot.drop-target {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .space-add {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: var(--fg-muted);
  }

  .space-add:hover {
    background: var(--item-hover);
    color: var(--fg);
  }

  .resize-handle {
    position: fixed;
    bottom: 0;
    width: 8px;
    cursor: col-resize;
  }

  .reveal {
    position: fixed;
    left: 0;
    bottom: 0;
    width: 8px;
  }

  .reveal.right {
    left: auto;
    right: 0;
  }

  .reveal:hover {
    background: var(--accent);
    opacity: 0.4;
  }

  .content {
    position: fixed;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: var(--panel);
    box-shadow: 0 1px 3px hsl(0 0% 0% / 0.08);
  }

  .empty {
    text-align: center;
    color: var(--fg-muted);
  }

  .empty-title {
    font-size: 22px;
    font-weight: 600;
    color: var(--fg);
    margin: 0 0 8px;
  }

  .split-handle {
    position: fixed;
    cursor: col-resize;
    border-radius: 4px;
  }

  .split-handle:hover {
    background: var(--item-hover);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  .spinner.big {
    display: block;
    width: 22px;
    height: 22px;
    border-width: 2px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
