# AgenticMail SIP Sidecar

Local SIP bridge for a direct PBX extension.

Responsibilities:

- register to the PBX as a SIP extension;
- answer inbound calls on the extension;
- place outbound SIP calls through the PBX;
- bridge RTP G.711 PCMU audio to OpenAI Realtime over WebSocket;
- fail closed when credentials or `OPENAI_API_KEY` are missing.

The sidecar is intentionally separate from AgenticMail core because the
upstream phone provider layer currently supports Twilio and 46elks, not
direct SIP registration.

Provide a local JSON profile with the PBX server, username, signaling and
RTP ports, plus references to the protected PBX and OpenAI credentials. Then
run the sidecar through environment-specific setup/start scripts.

On Windows, run `setup-sip-firewall.ps1` from an elevated PowerShell session
to allow the configured SIP signaling port and RTP range on the Domain
profile. The signaling rule is restricted to the configured PBX address.

Run the protocol regression tests with:

```powershell
node --test .\sip-sidecar\sip-sidecar.test.mjs
```

No real calls are started by the readiness checks.
