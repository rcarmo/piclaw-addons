# Earendil 0.87.1 compatibility

Delegate 0.2.11 recognises the exact new model IDs in the pinned Earendil 0.87.1
catalogue while preserving the existing operator-approval boundary. This does not
approve a provider or make a runtime-only model executable.

## Policy

- `gpt-6-sol`, `gpt-6-luna`: tier 3, general-purpose GPT family, with preferences
  53/54 following Astra's 52. Exact normalised direct IDs; no inferred publisher namespace,
  `-pro`, `-mini`, `-preview`, `:batch` or dated variants.
- `grok-4.7`: tier 3, general-purpose Grok family, preference 65. Other Grok 4.x IDs
  remain unclassified unless an existing independent rule covers them.
- `claude-opus-5.5` and `claude-opus-5-5`: existing tier-5 Opus classification;
  no broadening of that rule in this patch.

These assignments are local selection policy, not model benchmarks. Automatic
selection and fallback stay at or below the current model and category target.
Explicit selection bypasses only tier targeting, never provider approval, exact
child catalogue presence, exclusions, image capability or response-model checks.
Judge tasks prefer another family only inside that same approved tier-safe set.
Unknown variants fail closed. Unset provider approval still approves nothing.
Existing dot/underscore normalisation applies to classification. It does not add
executable IDs: approval and launch still require the exact child-catalogue row.

Disclosed assistant and response models now pass the request-specific eligibility
check, closing a pre-existing gap that accepted globally approved reroutes above
the automatic tier cap or without image capability. Explicit requests still bypass
tier targeting. Eligible disclosed reroutes remain accepted; ineligible ones fail
without fallback.

## Fixtures and provenance

`fixtures/cli-models-earendil-0.87.1.txt` contains ten selected rows captured from
an actual packaged `pi --no-session --no-extensions --list-models`. The profile,
workspace and home were newly created disposable directories. Synthetic API/OAuth
credentials exposed the offline catalogue; global fetch was blocked. No operator
credentials were copied and no model/provider was called. These are catalogue
presence receipts, not live authentication or account-entitlement evidence.

`fixtures/earendil-0.87.1-provenance.json` records exact IDs, capabilities, CLI/file
hashes and registry tarball SHA-512 integrity for `pi-ai` and `pi-coding-agent` at
upstream `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`. Both published tarball bytes
were downloaded with TLS verification and their registry integrity values checked.
The receipt also records SHA-256 for 15 package files byte-compared against those
archives, including CLI entrypoint, catalogue loaders and all five provider JSON
data files. The ten model metadata records match those verified JSON files.

The new fixture sits beside historical captures rather than rewriting their
provenance. The optional test recaptures these ten rows from an explicitly supplied
0.87.1 package directory and compares them exactly.

## JSON/no-session qualification

`cli-0871.test.ts` launches the actual packaged CLI with a fixture-only custom
provider and a deterministic loopback HTTP stream. A fetch guard rejects requests
outside that one server. The child receives an allowlisted environment, fresh
profile and no extensions/skills/templates/themes/tools.

- `--mode json --no-session` yields parseable final text, model/provider identity,
  usage and successful stop reason.
- Omitting JSON mode produces text that Delegate rejects as a protocol failure.
- An invalid mode fails without a model request or automatic fallback.
- No persistent `.jsonl` session is created.
- Unit fixtures reject malformed JSON, empty structured output and error/aborted
  assistant results even when the child process exits zero.

Normal Delegate still uses its existing child arguments and adapter. No provider,
transport, configuration or environment mutation is introduced by the model rules.

## Reproduce

Run from the repository root, with the test-isolation preload intact:

```sh
bun test addons/delegate/index.test.ts addons/delegate/earendil-0871.test.ts addons/delegate/cli-0871.test.ts
PICLAW_E2E_DISPOSABLE=1 \
PICLAW_DELEGATE_0871_PACKAGES=/absolute/path/to/node_modules/@earendil-works \
  bun test --timeout 60000 addons/delegate/cli-0871.test.ts
```

The first command skips only the two explicit real-CLI integrations when no
package directory is supplied. The second requires `pi-ai` and `pi-coding-agent`
package versions exactly `0.87.1`; it never finds or invokes the live CLI implicitly.
Other tests cover new-family actual tool execution through a fake child,
provider/exclusion/image rejection before spawn, restricted auth fallback,
explicit no-fallback, runtime-only rows and disclosed-model rejection.

## Release boundary

Keep the previous 0.2.10 archive available. Piclaw issue #1381 must pin the public
published successor tarball and verify its bytes against the final release receipt
(version, URL, SHA-256, SHA-512 integrity and source commit). Package contents and
publication checks must pass before that receipt is issued. Live installation,
provider calls, approvals and restarts are separate operator actions.
