# Firehose

`firehose` replaces `read_network_requests`. It is an explicitly armed,
temporary Network tap on one tab, with one append-only pile in worker memory.

```json
{ "action": "start", "tabId": 7, "url": "https://example.test/api" }
{ "action": "read", "from": 0, "limit": 50 }
{ "action": "stop" }
{ "action": "read", "body": 17 }
```

Start requires a positive tab ID. The optional `url` is an absolute literal
without query or fragment. It is compared exactly to the response URL with query
and fragment removed; the full observed URL remains in the pile. Omitting it
allows body attempts for all observed completed responses. Metadata is observed
regardless of the selector. Invalid selectors fail before attaching.

Admission starts when `Network.enable` succeeds. Starting while collecting
fails. A successful start after stop or fullness replaces the old pile; a failed
start preserves it. There is no automatic restart. Navigation does not clear the
pile. Extension reload or worker loss loses it.

The pile contains compact `Network.requestWillBeSent`, `responseReceived`,
`loadingFinished`, and `loadingFailed` records, plus body outcomes. Records keep
their supplied CDP request IDs and redirect responses. `index` is a pile position;
a body's `response` and `finished` fields point to its observed events. Partial
lifecycles remain partial. Failed network requests do not acquire invented HTTP
statuses.

A selected response is attempted immediately on `loadingFinished` if the one
native body-command slot is free. Otherwise its outcome is `busy`; nothing is
queued. `unavailable` includes bounded Chrome error text. `retained` preserves
Chrome's body string and `base64Encoded` flag, including a successful empty body.
`returnedBytes` and `retainedBytes` measure the UTF-8 representation of that
string, including base64 characters when applicable, rather than decoded or
transferred bytes. `clipped: true` means a retained prefix; it is not promised to
be complete JSON. Base64 prefixes end at quartet boundaries.

Inventory reads omit body strings and return `next` for a following bounded
slice. A body read names one body-outcome position and returns that outcome,
including busy or unavailable outcomes as successful observations. Reads never
call CDP or change collection state.

Fixed limits are reported in every inventory:

| Bound | Value |
| --- | --- |
| Pile records, including body outcomes | 4,000 |
| Aggregate UTF-8 JSON record bytes | 8 MiB |
| Individual retained body-string bytes | 512 KiB |
| Serialized JSON result in tool `output` | 1 MiB |
| Records requested per inventory read | 100 maximum, 50 default |
| Body retrieval and disable error text | 1,024 UTF-8 bytes |
| Selector | 8,192 UTF-8 bytes |

Body prefixes also fit the serialized result limit after JSON escaping. A
metadata record too large for a single read ends collection with `read_limit`.
Count or aggregate fullness likewise closes admission without eviction. If the
record that encounters a limit cannot fit, `omitted` reports its event family
and, for a body, its response/completion positions. It does not retain the
rejected payload. `bytes` counts retained records, not JavaScript heap usage.
These bounds cannot prevent Chrome from materializing a large native result
before Shotgun can measure it. `Network.enable` uses `maxPostDataSize: 65536`;
Firehose makes no guarantee about Chrome's response-body cache.

Stop freezes admission immediately and disables Network reporting without
detaching the shared debugger. Detach and tab removal also stop collection.
`network.pending` reports unsettled attach/enable/disable work; start is guarded
until that transition settles. A rejected disable is reported as `network.error`
and keeps rearming guarded until a confirmed detach or tab removal.

Stop never releases a held native body command early. `outstandingBodyAtStop`
records that its result will be discarded; `bodyCommandInFlight` reports the
current native slot. A replacement can encounter busy outcomes until the old
command settles. Private markers keep late results out of replacement piles,
and the pending slot does not retain the replaced pile's data.

Capture contents and CDP errors are excluded from logs. Each tool call replies
only on its original socket. Captures are not persisted.

`npm test` covers the state machine and actual worker dispatch using browser
doubles. It does not load Chrome. A controlled local check through the real
analysis reader, followed by an ordinary application walk, remains necessary to
establish actual body availability and reader transport behavior.
