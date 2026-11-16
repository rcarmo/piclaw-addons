# Add-on publication gates

Pages and public tarballs publish only after the same source passes reusable metadata, compatibility, import, Regrets and Code Review validation, catalog checks and required add-on UX tests. Pull requests run these checks without publishing. The UX fixture uses Piclaw v3.3.0 at `e4c2b9a3536eb64361da86237a4dfc970d772682`.

Failed or cancelled validation blocks publication. A missing or skipped required UX gate also blocks publication. Reports and fixture cleanup still run after failures. Successful Pages builds include `publication-source.txt` with the validated add-on commit.

Archival GitHub Packages publication follows a successful main-branch Pages workflow from this repository. It checks out and verifies that workflow's exact commit; failed, cancelled and pull-request runs cannot publish. Runtime installs continue to use public zero-auth Pages tarballs.

## Immutable public archives

Before building on main, the workflow checks out the current `gh-pages` branch into `.published-site`. The build requires `PICLAW_PUBLISHED_PACKAGES_DIR` to point at that checkout's `packages` directory. A missing baseline stops the build; the output directory cannot serve as its own baseline.

All previously published `.tgz` files are carried forward byte-for-byte, including historical versions absent from the current catalogue. Existing versions are never repacked. A final byte comparison rejects any overwritten or missing archive before deployment. Deprecated releases retain their additional pinned SHA256 check.

Only new versions are packed. Packaging uses a temporary source tree without local `node_modules`, `.tmp` or generated `tests/reports`; production `files` allowlists still apply. The source directory is unchanged. To ship changed add-on code, publish a new version. Dependency-only updates and regenerated UX reports cannot replace a released archive.

`publication-packages-source.txt` records the exact published-branch baseline commit alongside the validated source commit. For a local build, supply an explicit separate published checkout, for example `PICLAW_PUBLISHED_PACKAGES_DIR=/path/to/published/packages bun run build.ts`.

## Recovery

Read the failed job and its `publication-failure-diagnostics` or UX report artifacts. Fix the cause in a pull request. After merging, the new main commit reruns validation before publication. For a transient failure, rerun the failed main workflow; it retains the original commit. A manual build is allowed only on main and repeats all validation. There is no bypass publication dispatch.

Run local contracts with `bun test publication.test.ts`. These test workflow conditions, required gate outcomes and source binding; hosted browser and platform checks still run in CI. Changed-add-on routing and superseded-run cancellation are separate issues.
