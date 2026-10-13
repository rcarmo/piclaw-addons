# Delegate 0.2.20 qualification

Target: shipping parent-owned subprocesses on Pi 1.1.0. This is not a worker framework or a new confinement boundary.

## Tested offline

- Explicit built-in tool lists do not load an MCP adapter. Named profiles retain their existing adapter default; explicit MCP without an installed adapter fails closed.
- Model discovery disables default extensions, matching child execution.
- Invalid, expired, revoked and refresh-failed credentials stop fallback, including errors that also contain retryable setup wording.
- Approved-model selection and exclusions remain enforced. Every fallback inherits parent thinking.
- Deadline and abort checks immediately before launch prevent expired requests from starting another attempt.
- A packaged Pi 1.1.0 child starts with extensions disabled, parses JSON events, does not create a session, and leaves no workspace artifacts. This fixture does not perform provider inference.
- Existing descendant tests cover POSIX group ownership after parent exit, natural exit status, timeout, abort and pre-abort.

Qualification: 102 Delegate tests passed, 7 skipped, 732 assertions. The compatibility suite passed 307 tests with 15 skips and 1,807 assertions. Compatibility TypeScript checks passed.

## Not established

Authenticated provider parity, real OAuth/keychain refresh and a live selected-MCP-engine run are not established by these fixtures. The subprocess inherits its parent's environment/profile resolution; this change does not claim per-child secret isolation. Escaped POSIX process groups and equivalent Windows descendant cleanup are outside the tested ownership boundary.

Issue #160 remains open for its remaining real-provider/auth acceptance. These scoped fixes can merge independently. No live credentials, settings, installation or service state were changed during qualification.
