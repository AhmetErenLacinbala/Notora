# Notora private R2 gateway

`notora-storage` is the only application route to the private Standard-class
`notora-documents` bucket. Set `GATEWAY_SECRET` as a Wrangler secret and give its
value only to the backend. Keep the Worker name, `StorageQuota` binding, and
singleton name in `index.ts` stable: changing them would create an empty quota
ledger while the bucket still holds objects.

The SQLite Durable Object counts committed and reserved bytes against exactly
9,000,000,000 bytes. It charges every R2 call before execution, including
failed calls, retries, reads, listing, deletion, and abort. Persistent caps are
800,000 Class A and 8,000,000 Class B per UTC month, plus 20,000 Class A and
200,000 Class B per UTC day. Configured lower caps stay lowered across deploys;
higher values are rejected. The daily caps provide room when Cloudflare's
billing period does not align with a UTC month. Provider Free limits or a
gateway cap can temporarily reject requests; the gateway fails closed.

An interrupted write keeps its byte reservation. Ambiguous multipart-part
retries reserve another part-sized allowance until completion or confirmed
abort, so repeated failures can reach the byte cap before 9 GB is committed.
Use the authenticated `/v1/pending?prefix=notora/<document-id>/` route to find
ledger entries for document cleanup, retry multipart aborts by `uploadId`, and
delete remaining keys. Cleanup must finish before discarding the local recovery
copy. The gateway only controls this bucket and its own operations; account-wide
R2 usage and billing settings require separate verification.
