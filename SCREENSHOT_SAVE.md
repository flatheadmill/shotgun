# Screenshot save

`screenshot_save` is an additional Shotgun tool. The existing `screenshot` tool
continues returning its conversational JPEG image content blocks. Saving uses
Shotgun's existing debugger attachment and CDP, without another extension.

## Public call

Every call requires `operation_id` and `action`:

- `capture`: a deliberate new save using a fresh caller-chosen operation ID.
  Also requires `destination` and `mode` (`viewport` or `full_page`).
- `retry`: query status, then retransmit only exact bytes retained in this
  service-worker lifetime. Retransmission requires the original `destination`
  in the tool arguments. It never captures again.
- `status`: query the operation; never capture or retransmit.
- `abandon`: query status, then explicitly discard any PNG retained by this
  worker. An unknown remote operation becomes `abandoned`; a receiving remote
  operation is cancelled through Wicket and returns that authoritative outcome.

`tabId` is optional and explicit when supplied. Otherwise, selection uses this
call's slug group, followed by the existing active-tab fallback. Concurrent calls
to the same unattached tab share its pending debugger attachment; a rejected
attachment clears that pending entry so later calls can try again. Browser checks
for this collaboration use the shared `easement` slug. `where` is optional and
supports only `localhost` in this version.

`operation_id` uses the wire spelling because Easement binds it before dispatch.
The earlier design's optional `operationId` and `path` fields do not match that
boundary; the implemented names are `operation_id` and `destination`. Identity
strings use one to 128 ASCII letters, digits, hyphens or underscores. A
destination must be absolute, contain no dot/parent components, and name a file.
Wicket alone establishes that its parent exists and is allowed for this slug.

All actions query status first. An existing terminal outcome returns its
immutable receipt. `capture` proceeds only from `unknown` and only if this
worker does not already hold that operation. After a worker restart, `retry`
without bytes returns `unknown` or `receiving` as observed, without recapture or
cancellation. `abandon` is the deliberate escape from retained-operation and
byte capacity; nothing is silently evicted. `unknown` is not proof that this ID
was never used: pre-acceptance state can disappear. Choosing a fresh ID for
`capture` is a caller obligation.

The result is the exact relayed Wicket/Easement packet serialized as ordinary
tool text. It has the current call/operation/attempt identity; a recovered
receipt keeps its original attempt and event identity. `stored`, and a completed
explicit abandonment (`abandoned` or `aborted`), use exit code zero. Easement's
existing MCP text wrapper appends `[exit code: 1]` to other outcomes, including
nonterminal status observations.

## Capture and memory

Viewport capture requests PNG from the surface, without a clip or quality
setting. Full-page capture converts the measured `cssContentSize` rectangle
from CSS pixels to device-independent pixels using `cssVisualViewport.zoom`,
with `captureBeyondViewport: true` and clip scale one. Missing or invalid
browser zoom rejects full-page capture before requesting pixels. No canvas, resize, scroll,
stitching, or JPEG fallback participates in saving. DPR is recorded and used
only for conservative allocation preflight, not a guessed clip multiplier.
Loaded observations must establish native output dimensions; passing boundary
doubles is not evidence about Chrome scaling.

CDP returns the complete base64 PNG in memory. Shotgun bounds encoded length
before decoding, checks canonical base64, PNG framing and CRCs, dimensions and
SHA-256, then uses a temporary bitmap to verify decoding without re-encoding.
Wicket independently checks the complete PNG again before acceptance. These
limits apply: 32 MiB PNG, 32,768 per dimension, 64 million pixels (64 * 1024 *
1024), four active calls/retained operations, and 64 MiB reserved capture/retained
PNG bytes. Each pending capture reserves the full 32 MiB until it settles.
Base64 strings and browser decoder allocations add overhead to those PNG-byte
budgets; the budgets do not describe total process RSS.

Bytes live only in service-worker memory. There is no IndexedDB spool, new
permission, or `unlimitedStorage`. Unresolved bytes are retained and are not
silently evicted to admit another capture. Terminal receipts and explicit
abandonment release bytes. A capacity refusal is routed as `rejected` rather
than being masked by the preceding status observation.
Chrome has no capture-cancel primitive: when a route is lost, its call can end
promptly but a still-running capture keeps its reservation until it settles.
A settled capture may then support an explicit same-worker retry. A capture
that never settles can occupy bounded capacity until worker restart.

## Transfer and truth

A new attempt ID is generated per call. The sequence is status, begin, ready,
then one decoded chunk of at most 64 KiB followed by its exact offset ack, then
finish. No next chunk is sent while its predecessor is unacknowledged. All
waiters bind to the original socket and call, operation and attempt IDs. An old
call never sends its ordinary response on a replacement socket.

Ready/ack mean temporary receiving. Only Wicket establishes durable acceptance
inside finish. A timeout, disconnect, or receipt mismatch never becomes failed
publication or aborted cancellation. Retry begins with status under the same
operation ID. Stored, failed, aborted and published-with-unconfirmed-durability
remain distinct dispositions.

Receipt validation checks schema, slug/caller/operation, the deterministic
terminal event identity, requested intent, byte count, SHA-256, verified PNG
dimensions, and outcome shape. Historical attempt IDs are allowed. Wicket's
canonical destination may differ in its parent path after filesystem
canonicalization; Shotgun compares the original requested destination and
filename and relies on the selected Wicket for that canonical parent.

Socket identities are still self-declared. These checks enforce connection and
operation ownership, not authentication. Screenshot-family packets bypass raw
logging. Capture/failure and ordinary tool response observations include IDs
without image data; Shotgun never emits an artifact `store` fact.

## Verification

No npm dependencies or install step are needed (tested with Node 24):

```sh
npm test
node --check service-worker.js
```

The tests cover validation, exact bytes, chunk credit/offsets, immutable receipt
matching, retries and lost memory, pending capture/disconnect reservations,
concurrent slug selection, and the actual worker loaded with browser boundary
doubles. Those doubles are explicitly not loaded-Chrome checks.

A separate integration test requires adjacent built Easement and Wicket
checkouts, both with the screenshot implementation and Easement's status-only
wrapper correction:

```sh
node --test integration/screenshot-socket.test.js
```

It starts disposable localhost processes with a temporary home, runs the actual
Shotgun producer against the actual router/writer, checks exact disk bytes,
no-clobber, immutable lookup after producer memory loss, and log contents.
`EASEMENT_TEST_BIN` and `WICKET_TEST_BIN` can select the test binaries. It does
not restart the shared bus or use the operator's journals.

For loaded-extension checks, `node test/serve-fixture.js` prints a localhost
fixture URL. Reload the existing unpacked Shotgun extension, verify that tools
discovery advertises `screenshot_save`, and use new operation IDs/destinations
for viewport and full-page captures. Record page/visual viewport CSS dimensions,
DPR, PNG dimensions, byte count, and receipt-versus-file SHA-256. Repeat status
with the same operation after worker restart; never use capture as a restart
recovery mechanism.

## Loaded verification

Loaded Chrome checks cover viewport and full-page captures at native DPR 2 and
effective DPR 1. The disk files match the sender manifest and Wicket receipt for
dimensions, byte count and SHA-256. Full-page images include content beyond the
viewport without scrolling or adding blank canvas.

CDP clip geometry is expressed in device-independent pixels while layout
metrics report CSS pixels. The full-page plan therefore multiplies the content
rectangle by `cssVisualViewport.zoom`, preserves fractional coordinates and
keeps clip scale one. It does not infer browser zoom from display density or
pinch scale. The [CDP Page definition](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl),
[Blink layout metrics implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_page_agent.cc),
and [Chromium capture handler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc)
describe those coordinate systems.

Status and retry return immutable receipts without recapture. Losing the caller
response after publication is reconciled by operation ID. Existing destinations
fail without clobbering the original file. Shared logs contain one Wicket store
fact per saved artifact, no duplicate publication facts from lookup and no PNG
payloads. The existing conversational JPEG capture remains unchanged.

The automated suite covers native and zoomed clip geometry, missing or invalid
browser zoom, concurrent debugger attachment, exact transfer, no-clobber,
worker-memory loss and quiet logging. Effective DPR 1 was verified through
browser zoom; that does not claim coverage of a physical non-Retina display.

The disposable three-component test fixture is separately 1 by 1 pixels,
70,082 bytes, SHA-256
`41e1c3e8b3faf5ac4b82eaf2a25e33539355d8d258fdf54c6c0cc760f67bda61`.
That synthetic fixture exercises two chunks and is not a CDP capture.
