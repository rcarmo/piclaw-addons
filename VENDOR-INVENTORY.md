# Tracked add-on vendor inventory

`vendor-inventory.json` records SHA256, size and add-on ownership for tracked vendor directories, fonts and WASM. Required metadata validation checks it before publication. Generation changes no vendor payloads.

```sh
bun scripts/vendor-inventory.ts --write
bun run check:vendor-inventory
bun test vendor-inventory.test.ts
bun scripts/vendor-inventory.ts --compare-core /path/to/piclaw/runtime/vendor-manifests/inventory.json
```

Stage newly added assets before regeneration so Git's tracked list includes them. Generation is sorted and deterministic. The comparison command takes an explicitly supplied core inventory; it does not depend on an adjacent checkout or moving remote branch. SHA256 matches identify identical payloads, not common licence/provenance or safe removals. Keep the source revisions of both inventories alongside an audit report.

The initial inventory has 2,821 files and 172 duplicate groups. Comparison against core's initial 107-file inventory finds 15 matching add-on files. Every payload's upstream provenance/licence/advisory status remains unverified by this script. Root `package.json` excludes this inventory from published packages; the committed source and required validation retain it for auditing.

This continues core issue #1190. It does not close upstream/version/licence/reproducibility or packed/container acceptance. Vendored repositories, generated fonts and draw.io copies account for much of the scope. Package-specific source-of-truth and removal decisions need separate review. Files outside vendor directories/fonts/WASM may need explicit inclusion during the broader audit. No vendor updates/removals or runtime changes are made here.
