<script lang="ts">
  import type { Action, ArchivedTab } from '../../../shared/types'
  import Icon from '../lib/Icon.svelte'
  import Favicon from '../lib/Favicon.svelte'
  import { hostOf } from '../lib/util'

  /** archiveVersion changes each time the archive changes. */
  let { archiveVersion }: { archiveVersion: number } = $props()

  const vela = window.vela
  const send = (action: Action): void => vela.send(action)

  let entries = $state<ArchivedTab[]>([])
  let query = $state('')

  $effect(() => {
    void archiveVersion
    void vela.getArchive().then((list) => (entries = list))
  })

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => `${e.title} ${e.url} ${e.spaceName}`.toLowerCase().includes(q))
  })

  /** Groups entries by day, newest first (entries are already sorted). */
  const groups = $derived.by(() => {
    const out: { label: string; items: ArchivedTab[] }[] = []
    for (const entry of filtered) {
      const label = dayLabel(entry.archivedAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(entry)
      else out.push({ label, items: [entry] })
    }
    return out
  })

  function dayLabel(time: number): string {
    const day = new Date(time)
    day.setHours(0, 0, 0, 0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000)
    if (diff === 0) return "Aujourd'hui"
    if (diff === 1) return 'Hier'
    return day.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  }

  function timeLabel(time: number): string {
    return new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  }

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && send({ type: 'close-panel' })} />

<div class="panel">
  <header>
    <h1>Archive</h1>
    <button class="close" title="Fermer (Échap)" onclick={() => send({ type: 'close-panel' })}><Icon name="close" /></button>
  </header>

  <div class="search">
    <Icon name="search" size={14} />
    <input placeholder="Rechercher dans l'archive" bind:value={query} use:focusOnMount />
  </div>

  {#if entries.length === 0}
    <p class="note">
      Aucun onglet archivé. Les onglets du jour inutilisés depuis le délai choisi dans les réglages arrivent ici.
    </p>
  {:else if filtered.length === 0}
    <p class="note">Aucun résultat.</p>
  {/if}

  {#each groups as group (group.label)}
    <section>
      <h2>{group.label}</h2>
      {#each group.items as entry (entry.id)}
        <div class="entry" role="button" tabindex="0" title="Rouvrir {entry.url}"
          onclick={() => send({ type: 'archive-restore', id: entry.id })}
          onkeydown={(e) => e.key === 'Enter' && send({ type: 'archive-restore', id: entry.id })}
        >
          <Favicon src={entry.favicon} url={entry.url} />
          <div class="text">
            <span class="title">{entry.title || hostOf(entry.url)}</span>
            <small>{hostOf(entry.url)} · {entry.spaceName} · {timeLabel(entry.archivedAt)}</small>
          </div>
          <button
            class="remove"
            title="Retirer de l'archive"
            onclick={(e) => {
              e.stopPropagation()
              send({ type: 'archive-remove', id: entry.id })
            }}><Icon name="close" size={13} /></button
          >
        </div>
      {/each}
    </section>
  {/each}

  {#if entries.length > 0}
    <button class="clear" onclick={() => send({ type: 'archive-clear' })}>Vider l'archive</button>
  {/if}
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
    margin-bottom: 16px;
  }

  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }

  h2::first-letter {
    text-transform: uppercase;
  }

  section {
    padding: 14px 0 6px;
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

  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 12px;
    border-radius: var(--radius);
    background: var(--item-hover);
    color: var(--fg-muted);
  }

  .search input {
    flex: 1;
    border: none;
    outline: none;
    background: none;
    color: var(--fg);
    font: inherit;
  }

  .note {
    margin: 16px 0 0;
    font-size: 12.5px;
    color: var(--fg-faint);
  }

  .entry {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 8px;
    margin: 0 -8px;
    border-radius: var(--radius);
    cursor: default;
  }

  .entry:hover {
    background: var(--item-hover);
  }

  .text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .text span,
  .text small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .text small {
    color: var(--fg-faint);
  }

  .remove {
    display: none;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 5px;
    color: var(--fg-muted);
  }

  .entry:hover .remove {
    display: grid;
  }

  .remove:hover {
    background: var(--item-active);
    color: var(--fg);
  }

  .clear {
    margin: 18px 0 0 -8px;
    padding: 4px 8px;
    border-radius: 6px;
    color: hsl(0 70% 55%);
    font-size: 12.5px;
  }

  .clear:hover {
    background: var(--item-hover);
  }
</style>
