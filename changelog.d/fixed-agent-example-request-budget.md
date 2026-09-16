- Give the JavaScript agent example's write and recall calls an explicit
  660-second request budget so sequential optional-model requests are not cut
  off by the SDK's 60-second default. Preserve provider timeouts and failure
  handling without automatic write retries, and align the integration guide.
- Add isolated CLI regressions for both tool calls without requiring a server,
  model, or installed example dependencies.
