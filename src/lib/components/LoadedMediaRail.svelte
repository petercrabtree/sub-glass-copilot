<script lang="ts" generics="Item extends LoadedMediaChipItem">
  import LoadedMediaChip, { type LoadedMediaChipItem } from '$lib/components/LoadedMediaChip.svelte';

  let {
    items = [],
    currentIndex,
    titleForItem,
    ariaHidden = true,
    class: className = '',
  }: {
    items?: Item[];
    currentIndex: number;
    titleForItem?: (item: Item) => string;
    ariaHidden?: boolean;
    class?: string;
  } = $props();
</script>

<span class={`load-rail ${className}`} aria-hidden={ariaHidden}>
  {#each items as item (item.id)}
    <LoadedMediaChip
      {item}
      {currentIndex}
      title={titleForItem?.(item)}
    />
  {/each}
</span>

<style>
  .load-rail {
    display: inline-flex;
    align-items: center;
    flex: 1 1 auto;
    gap: 4px;
    min-width: 32px;
    overflow: hidden;
  }
</style>
