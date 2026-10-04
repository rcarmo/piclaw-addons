# Authentication failures stop delegation

Delegate0.2.16 stops the automatic attempt chain when the child reports an
authentication failure. Expiry, revocation, logout or missing keys must not
switch to another approved account/provider.

Unavailable-model and provider-setup failures still use the existing approved,
tier-capped fallback chain. Exact explicit model requests never fall back.
Approval lists, model classification, tier/image gates, deadlines and child
process-tree cancellation are unchanged.

Authentication classification runs before setup/model classification over the
combined structured child error and stderr. It recognises Pi's `No API key
found for "provider"` and `No API key for provider/model`, invalid key/token,
expiry/revocation and logged-out forms. A mixed unavailable-model error plus
missing-key stderr is an authentication failure, not a fallback opportunity.

## Qualification

A mutation-style taxonomy test failed before changing the policy, then passed.
Focused Delegate selection/process/new-model tests passed54tests/513assertions.
A synthetic cross-provider child fixture reports an unavailable-model structured
error and Pi missing-key stderr; the attempt marker contains only the first
provider even though a second provider is approved. Separate synthetic
unavailable-model cases still prove the permitted fallback path.

Independent source and judge review cleared the corrected classifier and mixed-
error negative. Final compatibility passed271tests/12opt-in skips/zerofailures,
1,596assertions in26.61seconds; five compatibility type projects, catalogue and
package checks passed. The changed Delegate standalone import passed1/1.
The earlier all-add-on standalone command timed out and is retained as incomplete
coverage; hosted whole-repository validation must pass before merge.
Only synthetic child programs ran. No provider request, production credential
read, model approval change or environment credential bridge is introduced.

The remaining parent#160 credential/profile/environment, selected-engine and
budget/cancellation acceptance stays separate. In particular, this policy fix
does not remove the existing ambient child environment inheritance.
