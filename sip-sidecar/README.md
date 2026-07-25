# AgenticMail SIP Sidecar

Local SIP bridge for a direct PBX extension.

Responsibilities:

- register to the PBX as a SIP extension;
- answer inbound calls on the extension;
- place outbound SIP calls through the PBX;
- bridge RTP G.711 PCMU audio to OpenAI Realtime over WebSocket;
- run a guided TN VED consultation through the internal CTM-backed API;
- perform an assisted manager transfer that keeps the caller with the agent
  until the allowlisted internal extension answers;
- fail closed when credentials or `OPENAI_API_KEY` are missing.

The sidecar is intentionally separate from AgenticMail core because the
upstream phone provider layer currently supports Twilio and 46elks, not
direct SIP registration.

Provide a local JSON profile with the PBX server, username, signaling and
RTP ports, plus references to the protected PBX and OpenAI credentials. Then
run the sidecar through environment-specific setup/start scripts.

The TN VED tool is configured in the PBX profile:

```json
{
  "tnvedConsultationEnabled": true,
  "tnvedApiBase": "http://10.0.200.101:8100"
}
```

After the caller finishes the first product description, Elena offers the
consultation once. The tool asks one missing question at a time and uses
category-specific prompts: vehicles request model/year/engine/new-or-used
facts, films request width/thickness/adhesive/roll facts, and machinery
requests function/model/power/finished-device facts. Multiple goods are
processed one at a time with `restart=true`.

The result contains a speech-grouped 10-digit code, compact wording, import
duty, VAT, a short product-context-aware non-tariff summary, and duty/VAT
amounts when customs value in roubles is known. A specific or combined duty
rate is spoken in full; the model must not calculate only its percentage
component. The ordinary classifier finalization gates remain available for
audit, but they do not block the voice advisory response. Tariff values must
never be supplied from model memory. The sum is described as "duty plus VAT",
not as all customs payments, because customs fees, excise, preferences and
trade-remedy duties are outside this calculator.

An assisted transfer is configured in the local PBX profile. The sidecar
dials the internal extension as a second SIP leg, switches RTP only after a
`200 OK`, and cancels the manager leg on timeout. A failed attempt returns
the caller to the Realtime agent and records a callback follow-up.

Before the second SIP leg is dialed, the sidecar waits for the queued transfer
confirmation to finish playing. The wait is bounded, logged, and occurs before
any residual audio is cleared, so starting a transfer cannot cut off Elena's
spoken sentence.

Department routes can contain one or more named employees. With
`selection: "round_robin"`, unnamed requests rotate between the employees;
an employee explicitly named by the caller is selected by an exact configured
name or alias. The route directory and selected internal destination are
recorded in local health/audit output.

```json
{
  "managerRoutes": {
    "customer_service": {
      "label": "Отдел по работе с клиентами",
      "selection": "round_robin",
      "topics": ["общие вопросы", "вопросы без конкретизации"],
      "destinations": [
        { "extension": "135", "employee": "Irina A.", "aliases": ["Ирина", "Ирина А"] },
        { "extension": "136", "employee": "Marina S.", "aliases": ["Марина", "Марина С"] }
      ]
    }
  },
  "managerRouteAliases": {
    "sales": "customer_service",
    "operator": "customer_service"
  }
}
```

Legacy one-extension routes remain supported:

```json
{
  "managerExtensions": { "sales": "135" },
  "managerTransferTimeoutSeconds": 15,
  "managerTransferNoAnswerMessage": "Manager unavailable fallback text"
}
```

Caller-requested direct extension transfers use the same assisted RTP bridge
and a separate allowlist policy:

```json
{
  "internalTransfer": {
    "enabled": true,
    "allowedExtensionPattern": "^1[0-9]{2}$",
    "blockedExtensions": ["199"],
    "timeoutSeconds": 15
  }
}
```

The caller must explicitly request and confirm the extension. The Realtime
tool accepts digits only, never infers an extension from a name, and rejects
the sidecar's own extension, external/PSTN numbers, and anything outside the
configured allowlist.

For inbound calls, the opening is fixed by the sales scenario. After the
opening audio has drained, a one-shot timer waits two seconds. If the caller
has not started speaking, the sidecar requests the configured follow-up
sentence. Any caller `speech_started` event cancels the timer immediately, so
the follow-up never talks over the caller.

The opening starts immediately after the inbound `200 OK`; it does not wait
for a separate SIP `ACK`. Some PBX paths deliver bidirectional RTP without an
observable `ACK`. In that case, inbound RTP confirms the live dialog and the
ACK timeout must not end the call. A dialog with neither `ACK` nor inbound RTP
still fails closed on the normal timeout.

On Windows, run `setup-sip-firewall.ps1` from an elevated PowerShell session
to allow the configured SIP signaling port and RTP range on the Domain
profile. The signaling rule is restricted to the configured PBX address.

Run the protocol regression tests with:

```powershell
node --test .\sip-sidecar\sip-sidecar.test.mjs
```

No real calls are started by the readiness checks.

## Windows service identity

Production-local Windows tasks run as `NT AUTHORITY\SYSTEM` with
`ServiceAccount` logon and `Highest` run level. Long-running services use an
`AtStartup` trigger; the watchdog uses `AtStartup` plus a one-minute trigger.
Every action receives an explicit `-ServiceProfile` so SYSTEM continues to use
the operator-approved `.agenticmail` data directory. SIP and Exchange passwords
use LocalMachine DPAPI and restricted ACLs; current-user DPAPI is not compatible
with this service model.

Use `migrate-agenticmail-services-to-system.ps1` for an existing installation.
The watchdog accepts a local `full-system-restart.request` marker only when no
call is active and writes a non-secret identity record for each managed service.
