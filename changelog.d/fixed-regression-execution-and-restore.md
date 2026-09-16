- Terminate the owned benchmark process group/tree and remove child-created
  temporary executables on deadlines, cancellation, and output overflow.
- Enforce a shared whole-run regression deadline with CI time reserved for
  cleanup and failure-report uploads; write success only after cleanup.
- Verify fresh writes, combined text/source indexing, exact inspection, and
  duplicate-free receipt replay after restoring a backup and restarting again.
