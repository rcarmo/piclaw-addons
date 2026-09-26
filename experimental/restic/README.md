# Restic backup add-on — implementation in progress

Issue [#143](https://github.com/rcarmo/piclaw-addons/issues/143) covers one repository,
one backup job and four native destinations: local/NAS, SFTP, S3-compatible and Azure Blob.

The first increment implements validated configuration and repository plans. It stores
keychain references only, disables backup and retention by default, rejects unknown
fields, requires HTTPS for S3, and requires an SSH key plus verified known-hosts reference.
Local source/repository/cache/staging overlap checks resolve existing symlink ancestors.

There is no registered extension, published package, scheduler, process runner or Settings
pane yet. Nothing in this directory reads credentials, starts Restic, changes live backup
scripts or migrates scheduler ownership. SFTP plans are not executable until the runner
creates private credential files and enforces strict host-key checking. Mount identity
needs an execution-time check. Cloud backends have contract tests only.

## Next increments

1. Bounded, cancellable argument-array runner; explicit binary/version; allowlisted child
   environment and keychain resolution; separate backup/maintenance results.
2. Resolve authoritative workspace/store/data/profile roots. Prove consistent SQLite
   snapshots with live WAL fixtures. Do not copy active databases and call them consistent.
   Investigate supported SQLite online backup rather than assuming core hooks are required.
3. Disposable local repository backup → list → check → restore to an empty directory;
   validate restored database integrity and representative contents.
4. Direct authenticated Settings API and Classic/Visual pane; instance-scoped locking,
   durable scheduling and single missed-run catch-up. Determine available host scheduler
   hooks before adding timers. Add only necessary generic host hooks separately.
5. Exact-ID scoped retention previews and opt-in maintenance; no automatic force-unlock,
   no maintenance after incomplete backup, no live-directory restore.
6. Disposable remote backend integration tests and explicit migration/rollback runbook.

The schedule/timezone, source roots, exclusions and stable instance identity are not
configuration fields yet. Existing Azure backups and their systemd timer remain untouched.
Repository encryption and backend credentials must remain available outside the backup;
recovery must also account for Piclaw's encrypted keychain state.

Run the foundation tests from the repository root:

```sh
bun test experimental/restic
```
