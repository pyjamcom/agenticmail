# AgenticMail Exchange EWS Sidecar

Windows-oriented inbound bridge for Exchange installations where direct IMAP
is unavailable or cannot pass strict TLS validation.

The sidecar:

- reads an EWS password from a LocalMachine DPAPI secret file restricted to SYSTEM, administrators, and the operator;
- verifies EWS over TLS with an explicit CA bundle;
- establishes a baseline without importing historical mail;
- polls for new Inbox messages and forwards RFC 822 payloads to AgenticMail's
  authenticated inbound endpoint;
- keeps a bounded deduplication state and a metadata-only audit log;
- archives completed inbound SIP transcripts idempotently into the MemPalace
  room `incoming_calls` through an API-backed retry queue;
- sends the full caller/Elena dialog after a completed SIP call from the
  authenticated Exchange mailbox to one explicitly allowlisted internal
  recipient through a separate idempotent retry queue;
- exposes local health on `127.0.0.1`.

It does not mark Exchange messages as read or send external email. Post-call
transcript delivery is disabled unless `postCallTranscriptEmail.enabled` is
true, its sender matches the authenticated mailbox, and its recipient appears
in `allowedRecipients`. Runtime configuration is supplied as a local JSON file
and must not be committed.

The transcript-email worker polls every two seconds by default. It searches
Sent Items for the mission-specific subject before sending, so an API
acknowledgement failure cannot create a duplicate message. Audit logs contain
only hashes, body length, delivery state, and error types, never transcript
text.

The message shows the decrypted caller number to the allowlisted internal
recipient, uses plain `Елена:` / `Клиент:` dialog lines without per-turn
timestamps, and translates call-end codes into Russian descriptions. Its HTML
view bolds caller turns with logistics or customs intent and renders cost or
rate questions in bold red. Transcript text is HTML-escaped before formatting.

The transcript archive is enabled with `INCOMING_CALL_MEMPALACE_PATH`. Stored
documents contain the full call text and a structured intake card, but are
marked as untrusted case history and are never treated as verified company
knowledge or direct voice-agent instructions.

The Windows service wrapper always receives an explicit service profile and
runs under `NT AUTHORITY\SYSTEM`. Its Python search path includes the approved
service profile's user-site packages and the local MemPalace source checkout;
it does not depend on SYSTEM's default profile.
