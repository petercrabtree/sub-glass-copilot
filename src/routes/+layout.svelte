<script lang="ts">
  import { dev } from '$app/environment';
  import { onMount } from 'svelte';
  import { startDevErrorReporter } from '$lib/dev/error-reporter';
  import { registerServiceWorker } from '$lib/service-worker/register';
  import '../app.css';

  let { children } = $props();

  onMount(() => {
    const stopDevErrorReporter = dev ? startDevErrorReporter() : undefined;

    registerServiceWorker();

    return () => stopDevErrorReporter?.();
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
