# AgenticMail Exchange EWS Sidecar

Windows-oriented inbound bridge for Exchange installations where direct IMAP
is unavailable or cannot pass strict TLS validation.

The sidecar:

- reads an EWS password from a current-user DPAPI secret file;
- verifies EWS over TLS with an explicit CA bundle;
- establishes a baseline without importing historical mail;
- polls for new Inbox messages and forwards RFC 822 payloads to AgenticMail's
  authenticated inbound endpoint;
- keeps a bounded deduplication state and a metadata-only audit log;
- exposes local health on `127.0.0.1`.

It does not mark Exchange messages as read or send external email. Runtime
configuration is supplied as a local JSON file and must not be committed.
