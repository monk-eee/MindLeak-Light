- Add native `local setup`, `configure`, `connect`, and `status` commands for
  credential-free Docker/stdio trials with pinned container identity, persistent
  database checks, secret-safe diagnostics and preserving VS Code configuration.
  Serialize Windows/UNC launcher paths correctly and validate the generated
  JSONC before replacing an existing configuration.
- Add an explicit host-loopback HTTP bridge on native macOS/Windows; Linux and
  container builds refuse the unauthenticated opt-out. Shared/network HTTP stays
  authenticated and requires TLS at network ingress.
- Lead setup with a tested VS Code write/recall and restart path. Document
  durable advanced token storage, scoped cached-input recovery and rotation;
  add fixed 401 recovery semantics without claiming to prevent client OAuth fallback.
