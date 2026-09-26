# Recovery and scheduler migration

Keep the repository encryption password, backend credentials and Piclaw decryption
key offline or in an independent password manager. A backup must not be their only
copy. Record the repository locator, Restic version, source-root map, stable instance
ID/tag and staging path from the Settings status/configuration. Preserve a copy of
the add-on `state.json`/`config.json` separately; the active job-state directory is
excluded from staged backups.

## Existing setup inventory

Before changing anything, record (without secret values):

- selected executable and version (use Install verified Restic for the managed build);
- repository URL/backend, source roots and exclusions;
- schedule, timezone, enabled timers/services and legacy loops;
- hourly/daily/weekly/monthly retention;
- keychain names or credential-file locations and required offline recovery keys.

Do not source an old `env.sh` to parse it. Import credentials through the host
keychain UI, then enter reference names in Restic Settings. Defaults reproduce the
old retention counts and expose the old hours preset; timezone and exclusions
still need explicit review. Existing snapshots are never imported into the new
instance scope or silently pruned.

## Controlled migration

1. Save the disabled add-on configuration. Test connection; do not initialise an
   existing repository. Keep retention disabled.
2. With explicit operator approval, **pause** the previous timer/loop and wait for
   its active backup/prune process to finish. Do not enable the new scheduler yet.
3. Run one manual add-on backup. Require `success`, list its snapshot, check the
   repository metadata, and restore it into a new empty directory.
4. Validate file hashes and SQLite integrity. Inspect recovered representative
   files and database contents. An incomplete backup (Restic exit 3) does not pass.
5. Confirm no old timer/loop remains active, acknowledge migration, then enable
   the add-on schedule. Only now transfer permanent scheduler ownership.
6. Keep the original scripts, exclusion list and old snapshot history for rollback.
   Retention previews cover only the new instance's exact host/tag/path identity.

If the manual backup/drill fails, leave the add-on disabled and resume the previous
scheduler. Never enable both. The add-on cannot stop arbitrary cron/remote jobs;
operator confirmation is required even when Linux legacy detection is clear.

## Restore and manual cutover

Use Restore in Settings with an exact listed snapshot and a **new empty directory**.
The restored tree contains the original staging path, a `.restic-manifest.json`, and
one directory per source name. The API returns the resolved restored directory and
integrity counts. Refresh status for background completion.

If the original instance is unavailable, use Install verified Restic on a replacement
Piclaw or obtain the upstream pinned 0.18.1 executable with the archive and binary
hashes recorded in `binary.ts`. Reject incomplete distribution builds. Supply
backend credentials and the encryption password through a protected environment or
private files, and use `restic snapshots` / `restic restore <id> --target <empty-dir>`.
Do not put secrets in shell history or command arguments. Verify the staged tree with
this package's `verifyRestore()` before copying any files into the replacement
instance. Source paths in the manifest are informational; never execute them.

Stop the target application before cutover. Map source directories to the intended
new workspace/store/data/profile roots, preserve permissions, and retain the previous
data until the recovered application starts successfully. Supply the independent
Piclaw decryption material. Do not overwrite a running messages database or remove
its WAL files. A simultaneous application-wide consistency point requires quiescing
writers; per-database snapshots alone do not establish cross-database transactions.

## Interrupted jobs and rollback

After a hard kill, first confirm **all** Restic/SSH children for this job have exited.
Inspect the add-on `job.lock`, private staging and credential directory. Remove only
that verified abandoned job's files; the add-on deliberately refuses stale lock or
staging reuse. Restic repository locks are separate: investigate with Restic's
standard recovery procedure; this add-on never force-unlocks automatically.

To return scheduler ownership: disable the add-on and wait for/cancel its running
job, confirm the disabled config is persisted, then resume the previous scheduler.
The migration regression tests exercise this state sequence without touching any
real systemd unit or repository. Existing snapshots and original scripts remain.
