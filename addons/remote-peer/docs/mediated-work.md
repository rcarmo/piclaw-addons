# Mediated work over Iroh

`work_send` records a proposal or execute-labelled request and sends it to a paired peer. Both types appear in the recipient's review queue. Neither invokes tools automatically.

`work_review` supplies an approved/rejected result. Approved capability labels must be a subset of those requested. The response returns over Iroh and is stored at the sender. If an origin chat was supplied, Piclaw queues a local notification there.

A failed result send leaves `response-pending` at the reviewer for explicit retry. No HTTP callbacks are used. Request/result records belong only to fresh Iroh state; old work ledgers are not imported.
