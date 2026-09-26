# Resumable session teleport

Teleport v2 sends the bundle from the source server through the relay to the
destination server. The app authorizes both ends, then polls for progress. It
never downloads or uploads the bundle. Transfers between folders or backends on
one server use the same durable job without a relay connection.

Both servers must advertise `sessionTransfer.version >= 2`. Remote transfers
require the same configured relay and active relay access. Deploy the relay's
`POST /api/session-transfer` and `/session-transfer` WebSocket endpoint before
rolling out the app. Older export/import endpoints remain for older apps; the
new app does not silently fall back to phone-mediated transfer.

## Authorization and transport

The app supplies the public keys from its paired server identities. The relay
issues separate source and destination tickets for a job after checking the
subscriber's access to both pairings. Tickets last seven days; retrying renews
them without deleting partial data. Servers receive these scoped tickets, not
the subscriber token.

Each server opens an outbound WebSocket to its configured relay. Frames contain
a length-prefixed JSON header and optional binary chunk, all encrypted with NaCl
box using the two server identities. The authenticated header includes the job
ID. The relay forwards opaque binary frames with bounded buffering and cannot
decrypt the session. It can see connection metadata, ciphertext sizes and timing.

The source freezes a gzip bundle and SHA-256 digest. The receiver requests four
512 KiB chunks at a time. Each chunk has an authenticated offset and SHA-256;
the receiver writes and fsyncs it, then durably records its new offset. After a
restart it truncates unacknowledged bytes and requests the saved offset. The
full bundle checksum is verified before import. Network disconnects reconnect
with exponential backoff, capped at 30 seconds.

## Commit and recovery

Jobs and bundles live in the server data directory under `transfer-jobs/<uuid>`.
Job files use mode 0600 and atomic replacement with fsync. They include scoped
relay credentials and must not be returned through the public status API.
Partial bundles survive failed imports and restarts.

The import has a stable transfer ID, a persisted write intent and transfer
lineage. Repeated imports return the existing session, including after its
provider-native ID changes. The receiver saves the import result before sending
a receipt. A lost receipt is replayed after reconnecting.

Only the source finalizes a move. It archives the original after the destination
commits. If the original changed or started running during transfer, it stays
available and the completed job reports that it was kept. An archive failure
also keeps the original. Clones never archive their source.

The app keeps the job ID before sending either start request, so retrying a lost
acknowledgement does not create another transfer. Its Transfers view lists
server-owned jobs; closing the view stops polling, not the transfer. Source and
destination options cannot be changed when resuming an accepted job.

Existing content limits and compatibility rules remain: at most 256 MiB gzip /
768 MiB expanded, exact native resume for cross-computer Claude-to-Claude moves,
and handoff context for other backend combinations. Project files are not copied.
Bundles and job records currently remain on disk until explicitly cleaned up.
