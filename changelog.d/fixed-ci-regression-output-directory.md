- Keep PR release-comparison output in a per-run runner-temporary directory,
  outside the restored Rust build cache, and upload evidence from that same
  directory. Preserve the runner's refusal to overwrite existing reports.
