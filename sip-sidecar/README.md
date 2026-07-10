# AgenticMail SIP Sidecar

Local SIP bridge for a direct PBX extension.

Responsibilities:

- register to the PBX as a SIP extension;
- answer inbound calls on the extension;
- place outbound SIP calls through the PBX;
- bridge RTP G.711 PCMU audio to OpenAI Realtime over WebSocket;
- perform an assisted manager transfer that keeps the caller with the agent
  until the allowlisted internal extension answers;
- fail closed when credentials or `OPENAI_API_KEY` are missing.

The sidecar is intentionally separate from AgenticMail core because the
upstream phone provider layer currently supports Twilio and 46elks, not
direct SIP registration.

Provide a local JSON profile with the PBX server, username, signaling and
RTP ports, plus references to the protected PBX and OpenAI credentials. Then
run the sidecar through environment-specific setup/start scripts.

An assisted transfer is configured in the local PBX profile. The sidecar
dials the internal extension as a second SIP leg, switches RTP only after a
`200 OK`, and cancels the manager leg on timeout. A failed attempt returns
the caller to the Realtime agent and records a callback follow-up.

```json
{
  "managerExtensions": { "sales": "135" },
  "managerTransferTimeoutSeconds": 15,
  "managerTransferNoAnswerMessage": "Manager unavailable fallback text"
}
```

On Windows, run `setup-sip-firewall.ps1` from an elevated PowerShell session
to allow the configured SIP signaling port and RTP range on the Domain
profile. The signaling rule is restricted to the configured PBX address.

Run the protocol regression tests with:

```powershell
node --test .\sip-sidecar\sip-sidecar.test.mjs
```

No real calls are started by the readiness checks.
