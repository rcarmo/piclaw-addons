# Add-on publication gates

Pages and public tarballs publish only after the same source passes reusable metadata, compatibility, import, Regrets and Code Review validation, catalog checks and required add-on UX tests. Pull requests run these checks without publishing. The UX fixture uses Piclaw v3.3.0 at `e4c2b9a3536eb64361da86237a4dfc970d772682`.

Failed or cancelled validation blocks publication. A missing or skipped required UX gate also blocks publication. Reports and fixture cleanup still run after failures. Successful Pages builds include `publication-source.txt` with the validated add-on commit.

Archival GitHub Packages publication follows a successful main-branch Pages workflow from this repository. It checks out and verifies that workflow's exact commit; failed, cancelled and pull-request runs cannot publish. Runtime installs continue to use public zero-auth Pages tarballs.

## Recovery

Read the failed job and its `publication-failure-diagnostics` or UX report artifacts. Fix the cause in a pull request. After merging, the new main commit reruns validation before publication. For a transient failure, rerun the failed main workflow; it retains the original commit. A manual build is allowed only on main and repeats all validation. There is no bypass publication dispatch.

Run local contracts with `bun test publication.test.ts`. These test workflow conditions, required gate outcomes and source binding; hosted browser and platform checks still run in CI. Changed-add-on routing and superseded-run cancellation are separate issues.
