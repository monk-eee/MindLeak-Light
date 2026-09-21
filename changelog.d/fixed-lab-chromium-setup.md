- Install missing pinned Playwright Chromium and verify a headless launch before
  Lab 1 or shared-dashboard provider startup. Add a standalone `setup:browser`
  command, preserve explicit browser paths, and stop on download or launch failure.
- Document fresh lab hosts, Windows commands, Linux dependencies, offline caches,
  viewer-only computers and the manual browser setup required by older releases.
- Make the default Lab 3 plan preview match the Learning schedule used at startup.
  Require only Lab 3's actual model and offer model-free storage once.
- Check local prerequisites before opening agent providers. Close acquired
  providers after startup failures, and release listeners and signal handlers
  through one shared shutdown operation.
