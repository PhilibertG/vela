<script lang="ts">
  // Icônes au trait (24x24), dessinées à la main pour ne pas dépendre d'une bibliothèque.
  const paths = {
    back: 'M15 18l-6-6 6-6',
    forward: 'M9 18l6-6-6-6',
    reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    plus: 'M12 5v14M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    sidebar: 'M4 5h16v14H4zM9 5v14',
    split: 'M4 5h16v14H4zM12 5v14',
    puzzle: 'M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z',
    minimize: 'M6 12h12',
    maximize: 'M7 7h10v10H7z',
    sound: 'M5 10v4h3l4 4V6L8 10zM16 9a4 4 0 0 1 0 6',
    reset: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
    moon: 'M12 3a7 7 0 1 0 9 9 9 9 0 1 1-9-9z',
    lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
    unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
    gear: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4'
  }
  let { name, size = 16 }: { name: keyof typeof paths; size?: number } = $props()
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name]} />
</svg>
