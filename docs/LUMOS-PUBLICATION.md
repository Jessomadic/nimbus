# Explicit document publication (Phase B partial, not deployed)

## Continuation implementation
The earlier seam-only description below is historical. runtime/publication-brain.js now exports
createBrainPublicationAdapter({python,brainRoot,home}); its local Python helper calls existing
overlay_store.cited/records/write_link/replay and BrainData.evidence. No raw database writes.
Source identity resolves unique metadata.document_id plus source_sha256; exact locator quotes
come from real evidence items. Links record explicit attribution only, not factual authority.
Operator wiring after companion gates: construct createPythonPublicationAdapter with reviewed
trusted paths, construct createBrainPublicationAdapter, then pass publicationAdapter and
publicationCitations to registerDocumentRoutes. server.js intentionally supplies neither.

Reconcile now continues queued captures and committed link phases. An uncertain submitted link
is status-read only; absent receipt never triggers another write. A matching existing overlay
receipt is accepted before revalidating potentially changed sources. First writes revalidate.
Uncertain ingestion still requires matching companion status, never repeats ingestion.
Interrupted validating state remains conservatively blocked pending process inspection.

### Practical owner browser command
In the authenticated same-origin Nimbus browser console (never paste untrusted commands):
```js
const id = 'OWNER_DOCUMENT_UUID';
const get = async path => { const r = await fetch(path); if(!r.ok) throw Error(await r.text()); return r.json(); };
const base = '/api/documents/' + encodeURIComponent(id);
const preview = await get(base + '/publication-preview');
console.log(preview); // inspect exact Markdown, audience, revision and hash
// Only after explicit owner approval, not on preview or on draft save:
const request = {requestId:crypto.randomUUID(),ifRev:preview.rev,
 expectedPublishedRev:preview.expectedPublishedRev,sha256:preview.sha256,
 audience:preview.audience,citations:[]};
const r = await fetch(base+'/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
if(!r.ok) throw Error(await r.text());
console.log(await r.json()); // retain request.requestId; 202 is not success
const status = await get(base+'/publications/'+request.requestId);
console.log(status);
```
To reconcile use POST base+'/publications/'+request.requestId+'/reconcile' with the same owner
session. Agent/API clients follow the identical explicit confirmation protocol, not a draft hook.
No visual editor/publication UI has been implemented. The live 503 gate is intentional until
companion and deployment evidence pass.
Draft creation/operations and Markdown export never ingest. There is currently no document editor UI. The owner API below exposes exact preview and persisted status; this is NOT a claim of an enabled end-to-end workflow.

## Owner workflow
Use the existing authenticated Nimbus browser/session, same origin and HTTPS protections. Never embed a session token in a document. An agent needs an explicitly owner-authorized authenticated session; bot identity is not owner authority.
1. GET /api/documents/{id}/publication-preview. Show the returned full markdown, rev, sha256, audience and expectedPublishedRev to the owner.
2. After explicit approval, POST /api/documents/{id}/publish with JSON:
   {requestId: NEW_UUID, ifRev: preview.rev, expectedPublishedRev: preview.expectedPublishedRev, sha256: preview.sha256, audience: preview.audience, citations: []}
   Include only validated actual citations when supported. No caller paths, commands, identities or SQL are accepted.
3. GET /api/documents/{id}/publications/{requestId} for status. Polling never submits ingestion. 202 is acceptance only.
4. For an unknown outcome, POST /api/documents/{id}/publications/{requestId}/reconcile. This performs supported receipt readback only, not a publication retry.
   not_committed does not prove a process stopped. No automatic replay or force reset is offered.
5. A newer draft requires a fresh preview, explicit approval and new requestId. Same request/body returns its original frozen operation; changed payload conflicts.

Current server returns enabled:false in preview and 503 for publication: the deployment adapter is intentionally not wired in server.js. Drafts and previews remain usable. No hidden auto-publishing, background watcher or recurring job.

## State interpretation
queued/validating: durable snapshot; ingesting: durable pre-effect marker.
needs_reconciliation: unknown process/commit outcome, installation remains busy.
failed_precommit: source citation validation failed before invoking ingestion.
indexed_links_pending: matching committed receipt retained but links not complete.
indexed_retrieval_unverified: matching indexed receipt, not verified shared retrieval.
No path currently promotes anything to verified.
Full snapshot/Markdown, confirmed audience/hash, input hash, timestamps and receipt live in Nimbus additive tables independently of document revision pruning. Private owner-only status includes these exact captures.

## Supported adapter preparation
runtime/publication-python.js exports createPythonPublicationAdapter with operator-supplied trusted absolute local python/cwd/db/inputRoot/archiveRoot paths. The operator must review/install companion kb.publication_cli first. Exact existing callable interface:
python -m kb.publication_cli --db DB --input-root INPUT --archive-root ARCHIVE publish-nimbus --request MANIFEST
and publication-status --request-id UUID.
No shell. Hidden window; bounded stdout; 120s wait limit does not kill a possibly committing process.
Immutable generated request Markdown and JSON are fsynced before invocation. Input/archive directories must already exist, local and not links/junctions.
There are NO default live paths and no client configuration surface. Server wiring requires a separately reviewed change after companion gates pass.
Citation dependency is an injected trusted interface validate/prepare/write, NOT a functioning production Brain connector. prepare must resolve real KB id/hash to actual Brain identity/evidence; no title or fabricated fingerprint lookup. Deterministic link payload/id is saved before write; uncertain links are retained pending and are never blindly replayed. Production validation, returned-link verification, link receipt reconciliation and shared retrieval remain gates.
