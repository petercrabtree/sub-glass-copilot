<script lang="ts">
  import '../app.css';
  let { children } = $props();
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
