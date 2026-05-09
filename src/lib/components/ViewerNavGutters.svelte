<script lang="ts" module>
  export type ViewerNavAction = 'retreat' | 'advance' | 'gallery_back' | 'gallery_forward' | 'none';
  export type ViewerNavZone = {
    id: string;
    className: string;
    glyph: string;
    action: ViewerNavAction;
    title?: string;
    label: string;
  };
</script>

<script lang="ts">
  type ViewerUiMode = 'full' | 'mini' | 'hidden';

  let {
    zones,
    uiMode = 'full',
    onactivate,
    oncontrolenter,
  }: {
    zones: ViewerNavZone[];
    uiMode?: ViewerUiMode;
    onactivate?: (action: ViewerNavAction) => void;
    oncontrolenter?: () => void;
  } = $props();

  let activeZoneId = $state<string | null>(null);

  $effect(() => {
    void zones;
    activeZoneId = null;
  });
</script>

<div class="nav-grid" class:hidden={uiMode === 'hidden'} data-ui-mode={uiMode} role="group" aria-label="Overlay navigation">
  {#each zones as zone (zone.id)}
    <button
      type="button"
      class={`nav-zone ${zone.className}`}
      data-action={zone.action}
      data-active={zone.id === activeZoneId}
      disabled={zone.action === 'none'}
      aria-label={zone.label}
      title={zone.title}
      onclick={() => onactivate?.(zone.action)}
      onpointerenter={() => {
        activeZoneId = zone.id;
        oncontrolenter?.();
      }}
      onpointerleave={() => {
        if (activeZoneId === zone.id) {
          activeZoneId = null;
        }
      }}
      onfocus={() => {
        activeZoneId = zone.id;
        oncontrolenter?.();
      }}
      onblur={() => {
        activeZoneId = null;
      }}
    >
      <span class="zone-glyph" aria-hidden="true">{zone.glyph}</span>
    </button>
  {/each}
</div>

<style>
  .nav-grid {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(132px, 22vw) 1fr minmax(132px, 22vw);
    grid-template-rows: minmax(96px, 18vh) 1fr minmax(96px, 18vh);
    grid-template-areas:
      '. top .'
      'left . right'
      '. bottom .';
    z-index: 1;
    pointer-events: none;
  }

  .nav-grid.hidden {
    opacity: 0;
    pointer-events: none;
  }

  .nav-zone {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    margin: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    backdrop-filter: none;
    box-shadow: none;
    opacity: 0;
    pointer-events: auto;
    color: inherit;
    transform: none;
    transition:
      background 0.18s ease,
      border-color 0.18s ease,
      box-shadow 0.18s ease,
      transform 0.18s ease;
  }

  .nav-zone:disabled {
    display: none;
  }

  .nav-zone.top {
    grid-area: top;
    place-self: stretch;
  }

  .nav-zone.left {
    grid-area: left;
    place-self: stretch;
  }

  .nav-zone.right {
    grid-area: right;
    place-self: stretch;
  }

  .nav-zone.bottom {
    grid-area: bottom;
    place-self: stretch;
  }

  .nav-zone[data-active='true'],
  .nav-zone:hover,
  .nav-zone:focus-visible {
    border-color: transparent;
    box-shadow: none;
    transform: none;
  }

  .nav-zone.left:not(:disabled):hover,
  .nav-zone.left:not(:disabled):focus-visible {
    opacity: 1;
    background: linear-gradient(90deg, rgba(140, 199, 239, 0.12), transparent);
  }

  .nav-zone.right:not(:disabled):hover,
  .nav-zone.right:not(:disabled):focus-visible {
    opacity: 1;
    background: linear-gradient(270deg, rgba(140, 199, 239, 0.12), transparent);
  }

  .nav-zone.top:not(:disabled):hover,
  .nav-zone.top:not(:disabled):focus-visible {
    opacity: 1;
    background: linear-gradient(180deg, rgba(140, 199, 239, 0.1), transparent);
  }

  .nav-zone.bottom:not(:disabled):hover,
  .nav-zone.bottom:not(:disabled):focus-visible {
    opacity: 1;
    background: linear-gradient(0deg, rgba(140, 199, 239, 0.1), transparent);
  }

  .zone-glyph {
    min-width: 32px;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: rgba(233, 233, 233, 0.78);
    font-size: 1.45rem;
    line-height: 1;
    opacity: 0;
    transition:
      color 0.18s ease,
      transform 0.18s ease;
  }

  .nav-zone:not(:disabled):hover .zone-glyph,
  .nav-zone:not(:disabled):focus-visible .zone-glyph {
    color: rgba(246, 250, 255, 0.98);
    opacity: 0.42;
    transform: scale(1.06);
  }

  .nav-grid[data-ui-mode='mini'] .nav-zone {
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
  }

  .nav-grid[data-ui-mode='mini'] .nav-zone:not(:disabled):hover,
  .nav-grid[data-ui-mode='mini'] .nav-zone:not(:disabled):focus-visible {
    opacity: 1;
  }

  .nav-grid[data-ui-mode='mini'] .zone-glyph {
    font-size: 1.12rem;
  }

  @media (max-width: 720px) {
    .nav-grid {
      grid-template-columns: minmax(76px, 24vw) 1fr minmax(76px, 24vw);
      grid-template-rows: minmax(74px, 16vh) 1fr minmax(74px, 16vh);
    }

    .nav-grid.hidden {
      display: none;
    }
  }
</style>
