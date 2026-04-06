<script lang="ts">
  import { dev } from '$app/environment';
  import { onMount } from 'svelte';
  import { startDevErrorReporter } from '$lib/dev/error-reporter';
  import '../app.css';

  let { children } = $props();

  onMount(() => {
    if (!dev) return;
    return startDevErrorReporter();
  });
</script>

<div class="app">
  {@render children()}
</div>

<style>
  .app {
    background: #0a0a0a;
    min-height: 100vh;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
</style>
