# Direct SIP Sales Agent: Final Implementation Plan

Status: implemented locally and deployed for extension 199. A coordinated live
call remains the final acceptance test. PBX dial-plan changes and manager-route
selection require PBX administrator input.

## 1. Runtime architecture

1. The PBX registers extension 199 to `sip-sidecar` over SIP/UDP.
2. The sidecar bridges bidirectional PCMU RTP audio to OpenAI Realtime over a
   WebSocket session using `gpt-realtime-2.1` and the `marin` voice.
3. OpenAI Realtime performs server VAD, interruption handling, input
   transcription, audio output, and function calling.
4. Every final caller and agent turn is written through the AgenticMail API to
   the `phone_missions` table before call finalization.
5. Structured sales intake is kept in mission metadata. Raw email and callback
   values are stored separately as encrypted contact secrets.
6. Call completion creates an internal recap in AgenticMail and queues an
   Exchange Draft. The Exchange sidecar creates the draft but never sends it.

## 2. Conversation and qualification flow

The tracked scenario is `sip-sidecar/sales-call-scenario.json`.

- The opening identifies the voice agent and discloses transcription storage.
- The agent classifies the caller as a new customer, existing customer,
  supplier, carrier, or other contact.
- It classifies goods, freight, service, support, or other requests.
- Freight qualification captures the lane, mode, cargo, weight or volume,
  package data, readiness, deadline, Incoterm, and target when known.
- Exact names, email addresses, phone numbers, dates, routes, and references
  are read back before persistence.
- The agent can record a callback request or request a SIP transfer to a
  configured allowlisted manager route.
- It cannot accept rates, orders, bookings, routes, payment terms, discounts,
  legal terms, or other commercial commitments.

## 3. Realtime tools

- `route_call_specialist`: performs a seamless in-session handoff from
  reception to the selected specialist profile and persists the classification.
- `update_call_intake`: incrementally persists confirmed facts.
- `finalize_call_intake`: validates the final call card and returns missing
  fields.
- `request_callback`: stores a request only; it never auto-dials.
- `lookup_verified_information`: reads only high-confidence knowledge,
  corrections, and system notices from agent memory. A miss requires human
  follow-up rather than an improvised answer.
- `create_internal_followup`: creates a durable pending task for a manager or
  information response.
- `transfer_to_manager`: sends SIP REFER only to a locally configured logical
  route and allowlisted extension.

The Realtime session uses low reasoning effort to preserve call latency. The
model itself is reasoning-capable; no undocumented GPT-Live or GPT-5.5 model
identifier is used.

## 4. Transcript durability and privacy

- Full turn-by-turn text is mandatory for answered calls.
- SIP calls are rejected before answer when DB persistence is unavailable.
- Transcript text is encrypted at rest with the AgenticMail master key.
- A dialable SIP caller ID is retained only in the encrypted contact store;
  ordinary mission fields and logs keep a hash or redacted value.
- Ordinary SIP and Exchange audit JSONL files contain event metadata and
  lengths, not transcript text, raw caller numbers, or raw contacts.
- Failed DB writes are placed in an AES-256-GCM encrypted local spool and
  replayed after recovery.
- Event IDs make transcript appends idempotent.
- Pending transcript deltas are flushed as partial entries when a call closes.
- Retention is configurable from 1 to 3650 days. The production-local default
  is `0`, meaning indefinite retention and no automatic deletion.

## 5. Media reliability

- RTP output is paced in 20 ms PCMU packets.
- The output queue is bounded and cleared immediately on caller speech.
- On interruption, the bridge also sends `conversation.item.truncate` with the
  amount of audio actually sent to the PBX, keeping model context and the
  transcript aligned with heard audio.
- Symmetric RTP updates the destination port from valid inbound RTP on the
  expected media IP.
- A configurable inbound-RTP inactivity watchdog ends broken media sessions.
- Duplicate INVITE, ACK, CANCEL, BYE, REFER, NOTIFY, registration renewal, and
  call-duration limits are handled explicitly.

## 6. Operating controls

- Inbound and outbound calling have independent enable flags.
- Concurrent calls default to one.
- Maximum call duration defaults to 1800 seconds.
- Business hours support timezone-aware weekly and overnight intervals.
  Current local policy is 24/7 answering until a business schedule is supplied.
- Outside-hours behavior can be `answer` or `reject`.
- Manager transfer remains disabled until a logical route-to-extension map is
  approved and added to local config. The current SIP implementation is a
  context-preserving transfer request plus an internal follow-up record, not a
  three-party attended conference; a true warm transfer requires PBX attended
  transfer support and an approved manager route.
- The Exchange recap remains a draft; no external email is sent automatically.

## 7. Readiness and acceptance

Automated acceptance requires:

- AgenticMail API health is `ok`.
- Exchange EWS sidecar health is `ok`.
- SIP sidecar health is `ok` and extension 199 is registered.
- OpenAI API key and SIP secret are present without being printed.
- Transcript persistence is ready and encrypted spool depth is zero.
- A real OpenAI Realtime session accepts the configured model and tools.
- A synthetic call persists encrypted transcript text, finalizes the mission,
  and creates an Exchange Draft.

Final live acceptance requires one coordinated inbound call to extension 199.
After hangup, verify two spoken sides in the DB, structured intake, terminal
mission status, zero spool depth, acceptable RTP loss/latency, and one Exchange
Draft. The PBX ring group still sends calls to several destinations in
parallel; eliminating answer races requires PBX dial-plan administrator access.
