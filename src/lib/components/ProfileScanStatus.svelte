<script lang="ts">
  import { profileScanManager } from '$lib/discovery/profile-scan-manager.svelte.js';

  let { class: className = '' } = $props<{ class?: string }>();
</script>

<span
  class={`profile-scan-status ${className}`}
  class:active={profileScanManager.active}
  class:paused={profileScanManager.paused}
  class:waiting={profileScanManager.rateLimitRemainingMs > 0}
  title={profileScanManager.detailText}
  aria-label={profileScanManager.detailText}
>
  <span class="scan-dot" aria-hidden="true"></span>
  <span class="scan-copy">{profileScanManager.shortText}</span>
</span>

<style>
  .profile-scan-status {
    display: inline-flex;
    min-height: 28px;
    max-width: min(220px, 34vw);
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 9px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.04);
    color: rgba(210, 222, 232, 0.82);
    font-size: 0.72rem;
    line-height: 1;
    white-space: nowrap;
  }

  .scan-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: rgba(156, 170, 182, 0.72);
  }

  .scan-copy {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .profile-scan-status.active {
    color: rgba(220, 244, 232, 0.92);
    background: rgba(95, 181, 127, 0.12);
    border-color: rgba(117, 217, 156, 0.22);
  }

  .profile-scan-status.active .scan-dot {
    background: #72d892;
    box-shadow: 0 0 0 4px rgba(114, 216, 146, 0.12);
  }

  .profile-scan-status.paused {
    color: rgba(235, 205, 150, 0.9);
    background: rgba(214, 176, 103, 0.1);
    border-color: rgba(214, 176, 103, 0.2);
  }

  .profile-scan-status.waiting {
    color: rgba(238, 183, 183, 0.92);
    background: rgba(190, 101, 101, 0.12);
    border-color: rgba(190, 101, 101, 0.24);
  }

  .profile-scan-status.waiting .scan-dot {
    background: #e18a8a;
  }
</style>
