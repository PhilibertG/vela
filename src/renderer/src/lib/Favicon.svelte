<script lang="ts">
  import { initialOf } from './util'

  let { src, url, size = 16 }: { src?: string; url: string; size?: number } = $props()
  let failed = $state(false)

  $effect(() => {
    // Nouvelle icône : on retente l'affichage.
    void src
    failed = false
  })
</script>

{#if src && !failed}
  <img {src} width={size} height={size} alt="" onerror={() => (failed = true)} draggable="false" />
{:else}
  <span class="fallback" style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.62}px">{initialOf(url)}</span>
{/if}

<style>
  img {
    display: block;
    border-radius: 3px;
    flex: none;
  }
  .fallback {
    display: grid;
    place-items: center;
    flex: none;
    border-radius: 4px;
    background: var(--fg-faint);
    color: var(--bg-solid);
    font-weight: 700;
  }
</style>
