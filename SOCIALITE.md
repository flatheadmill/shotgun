# Socialite browser helper

Shotgun can explicitly arm one passive X Bookmarks review and send complete
response and eligible photo/poster bytes to the standing Socialite companion.
`socialite.js` owns recognition, bounded media eligibility and acquisition.
`companion-ingress.js` owns the small byte producer. `service-worker.js` wires
them to the existing debugger, socket lifecycle and one `socialite` tool.

The companion's receipt confirms durable mechanical acceptance. Canonical post
extraction and indexing remain companion work. A delivered response records what
X returned during the review; it does not establish attention or viewport entry.

## Tool and lifecycle

| Action | Arguments and behavior |
| --- | --- |
| `start` | Requires an explicit positive `tabId` whose current URL has origin `https://x.com`, one available companion, no Firehose Network ownership, and no unresolved retained cargo. |
| `status` | Reports acquisition state, fixed limits, lifetime disposition counters, native reservations, queue sizes, retained operations, tombstones and recent stored summaries. Does not return source bodies, URLs or private manifests. |
| `stop` | Closes acquisition, drops candidate/eligibility/completion metadata and requests `Network.disable`. Already retained transfers may finish. Pending native calls retain their reservations until settlement, then discard obsolete results. |
| `lookup` | Requires a locally retained `operation_id` or abandonment tombstone. Sends a fresh receipt query with the complete original manifest. Returns a checked outcome and public operation summary; it grants no transfer credit. |
| `abandon` | Requires a retained `operation_id`. Explicitly discards cargo and keeps the full immutable manifest in a bounded same-worker tombstone. Remote acceptance remains unknown. |

Start first checks the tab, then performs the route-free `probe`, attaches the
debugger and enables Network. Admission begins only after the enable
acknowledgement. Missing and ambiguous companions are separate refusals. Probe
proves presence at that instant; it reserves no transfer slot or receiver lease.
Begin independently selects its companion again.

Socialite and Firehose exclude one another during collection and unresolved
Network transitions, including a failed disable. A confirmed detach/removal
clears that guard. Ordinary stop keeps the shared debugger attached so screenshot
tools continue to use the existing attachment. Same-origin navigation continues
the armed review; leaving X, tab removal, debugger detach or source socket loss
closes acquisition. Child CDP sessions are not acquired.

Async start, native body and hash continuations are fenced by their review or
transition identity. Transfer and tool replies also belong to their physical
socket. Reconnection does not rearm, replay or retry. A later explicit review is
allowed after cargo resolves or is abandoned; tombstones remain queryable.
Worker death loses cargo, tombstones and all other helper state. There is no
browser persistence, synthetic request, scroll loop, hidden resume or abandonment
timer.

## Evidence selection

Bookmarks recognition is the exact origin `https://x.com` and path
`/i/api/graphql/<one-segment-operation-hash>/Bookmarks`. The observed hash is
recorded, not pinned. Query strings and fragments are omitted from recorded
Bookmarks request/response URLs. The bounded armed page URL is in the private
manifest. No request or response headers are retained.

After `Network.loadingFinished`, a selected response can obtain one
`Network.getResponseBody` result. A response requires `base64Encoded: false` and
a complete string within the response byte allowance. That decoded string is
UTF-8 encoded unchanged, hashed and sent. JSON is never reserialized for ingress.
Empty, invalid or unfamiliar JSON can still be mechanically stored; eligibility
parser dispositions separately describe it.

The bounded parser visits only
`data.bookmark_timeline_v2.timeline.instructions`, `TimelineAddEntries`,
`TimelineTimelineItem`, and `content.itemContent.tweet_results.result`. It accepts
ordinary `Tweet` and the observed `TweetWithVisibilityResults.tweet` wrapper,
checks decimal `rest_id` and any supplied `legacy.id_str` for agreement, and reads
`legacy.extended_entities.media`. One explicit `quoted_status_result.result`
level is visited. It does not recursively search for posts or project post text.

Photo descriptors and video/animated-GIF poster descriptors use `media_url_https`.
The accepted host is exactly `https://pbs.twimg.com`, with the observed `/media/`,
`/ext_tw_video_thumb/` and `/amplify_video_thumb/` path families. A descriptor's
final `.jpg` or `.png` is removed only to form a comparison key. An actual
extensionless request path with `format=jpg` or `format=png` can match that key.
The actual request URL, including its variant query, and the declared descriptor
are recorded separately. No image URL is constructed or fetched. Video variant
bytes and profile images are excluded.

Eligibility must exist when an image completes. A candidate seen earlier can
become eligible before completion; a completed image discarded before eligibility
is never looked up later. A review retains the first bounded reference for a key.
Each image records that reference and its parent response operation ID, plus
bounded request/response, timing, status, MIME and supplied cache facts. Eligibility
is learned before asynchronous hashing/transfer, so the parent receipt is not a
prerequisite. A failed or unconfirmed parent operation can leave independently
accepted image evidence; the parent ID preserves that relationship.

Image bodies require `base64Encoded: true`, canonical padded base64, valid padding
bits, nonempty decoded bytes and the image byte allowance. Decode preserves the
bytes; no resizing or re-encoding occurs. Invalid encoding, explicit clipping,
oversize and unexpected representation each have visible dispositions. CDP's
completed-body contract supplies completeness: this helper does not independently
parse image codecs or detect a truncated image that still has valid base64 and
no clipping indicator. Encoded network length is recorded, never substituted for
decoded byte count, particularly for cache hits.

## Provisional bounds and pressure

All values below are exposed through status. Byte limits use UTF-8 serialized
metadata or decoded artifact bytes as appropriate, not JavaScript object sizes.

| Resource | Bound |
| --- | --- |
| Response cargo | 512 KiB |
| Image cargo / outer protocol object cap | 2 MiB |
| Retained cargo operations | 2 total, at most 1 response and 1 image (2.5 MiB combined cargo) |
| Native acquisition/hash work | 1 slot per kind; old promises keep their slot until settlement |
| Candidate metadata | 128 entries, 256 KiB total, 4 KiB per entry |
| Eligibility table and parser output | 256 references, 128 KiB; review entries additionally include the parent operation ID |
| Waiting response completions | 2 descriptors, 16 KiB total |
| Waiting image completions | 64 descriptors, 128 KiB total |
| Known representation/copy reservation | 4 MiB response + 16 MiB image = 20 MiB |
| URL input / retained URL | 8 KiB / 1 KiB |
| Request and operation-hash metadata strings | 128 bytes |
| Parser visits per response | 8 instructions, 128 entries, 8 media per post, one quote level; post IDs at most 32 decimal digits |
| Immutable manifest | 8 KiB |
| Transfer chunk / packet | 64 KiB raw / 96 KiB serialized |
| Socket buffered bytes at send admission | 256 KiB including the proposed packet |
| Concurrent control contexts | 2, independent of the 2 transfer contexts |
| Reply deadline | 25 seconds per exchange; timeout retains cargo |
| Abandonment tombstones | 32 and 256 KiB of full manifests; never silently evicted |
| Stored summary history | 16; older summaries explicitly counted as evicted |
| Tool result | 64 KiB serialized |

The observed relevant burst was 56 image responses: 41 photos and 15 posters.
One image native slot plus 64 waiting descriptors is a provisional accommodation
for that specimen. Waiting entries contain metadata only. Body retrieval happens
when the kind's native slot and retained-cargo allowance both become available.
That is the first body request, not a retry. Chrome may no longer have the body;
the helper reports unavailability and moves on.

Count/byte pressure sheds the newest candidate, reference or waiting completion
and increments its named disposition. An unresolved response occupies only the
response allowance; an unresolved image occupies only the image allowance.
No timer sheds retained cargo. Tombstone pressure refuses abandonment and leaves
the cargo intact. Successful receipt lookup removes that tombstone; an unknown or
receiving outcome keeps it.

The 20-MiB work reservation accounts conservatively for known strings, decoded
buffers, hashing copies and chunk encoding. At the 2-MiB image limit the base64
string is up to 2,796,204 characters, before its decoded string and byte buffer.
Reservations prevent additional native work from accumulating behind stalled
promises. They are **not a hard heap or browser-memory limit**: Chrome allocates
the native result before JavaScript can reject it, engine string/object overhead
and JSON parse allocation have not been measured, and generic WebSocket parsing
precedes the producer's packet validation. Candidate/table/queue byte counts also
exclude engine overhead. `Network.enable` uses only `maxPostDataSize: 0`; browser
body buffering/cache defaults remain unchanged.

`DISPOSITIONS` in `socialite.js` lists every acquisition/parser counter; status
initializes them all to zero. It distinguishes representation, clipping, oversize,
unavailable, stale completion, hash failure, manifest/admission failure, unknown
shapes, parser limits and each table/queue pressure. The producer separately
reports retained state and fixed failure codes. Counters are worker-lifetime,
not reset per review.

## Transfer and uncertainty

The wire contract is [Easement companion ingress](../easement/COMPANION_INGRESS.md).
Begin sends the full immutable manifest. Ready grants offset zero. Each chunk
waits for exactly its next raw offset, then finish requests acceptance. Empty
response cargo proceeds directly from ready to finish. Binding, operation,
attempt, physical socket and full receipt manifest must match before acceptance.

Any transfer error, disconnect, deadline or invalid receipt leaves bytes and the
original manifest retained and marks the operation unconfirmed. An explicit
lookup uses a new attempt and the same manifest. Unknown/receiving is not evidence
of loss and never initiates retransmission. Stored frees cargo and retains only
the bounded public summary; subsequent lookup requires a still-retained operation
or tombstone. The companion holds the durable receipt.

Abandon sends one best-effort abort if the current route binding is already known,
then releases local cargo and retains the immutable manifest. Before ready there
is no binding to abort; that remote attempt may occupy capacity until its own
deadline. An available probe therefore does not guarantee immediate begin
capacity. Abort cannot revoke a committed receipt, and late old transfer replies
cannot overwrite the tombstone.

Bodies, base64, private manifests and peer/CDP error text do not go into normal
logs. The packet family is intercepted before ordinary worker dispatch logging.
Tool logs carry call identity and exit disposition; socket close logs carry its
numeric code. Status uses bounded summaries and fixed error codes.

## Verification boundary

`npm test` runs pure producer/parser/lifecycle tests and actual worker dispatch
with Chrome/WebSocket doubles. `node --test integration/*.test.js` also runs the
existing exact-PNG route and the real JavaScript helper/producer through disposable
Easement and Socialite processes on random loopback ports. Build the neighboring
debug binaries first, or supply `EASEMENT_TEST_BIN`, `SOCIALITE_TEST_BIN` and
`WICKET_TEST_BIN`. Test stores and logs are temporary.

The Socialite socket test uses generated 177,277-byte Bookmarks-shaped JSON and a
606,762-byte PNG, verifies stored bytes and full manifests, holds image credit
while another response completes, drops the final image receipt, and recovers
with a fresh lookup after socket replacement and explicit abandonment. Tests
also cover bounds, wrong credit/binding/receipt, independent native reservations,
stale continuations, Network ownership, quiet logs and worker listeners.

This slice has not reloaded the extension or exercised live X traffic. Fresh-image
CDP representation, deferred body residency, parser cost, real browser copy/heap
cost, and behavior under sustained natural scrolling remain unmeasured. The
recognizer intentionally accepts only the observed shape and JPG/PNG forms;
future X variants require evidence and a deliberate change.
