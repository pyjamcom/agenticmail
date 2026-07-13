from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import requests

from incoming_call_mempalace import IncomingCallMempalaceArchiver


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return dict(fallback)


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def safe_error(exc: Exception) -> str:
    text = re.sub(r"(?i)(password|authorization|token)\s*[:=]\s*\S+", r"\1=[redacted]", str(exc))
    return text[:300]


def decrypt_dpapi_secret(path: Path) -> str:
    script = r"""
$p = $env:AGENTICMAIL_DPAPI_SECRET_PATH
Add-Type -AssemblyName System.Security
$raw = (Get-Content -LiteralPath $p -Raw).Trim()
if ($raw.StartsWith("{")) {
    $payload = $raw | ConvertFrom-Json
    if ($payload.version -ne 1 -or $payload.scope -ne "LocalMachine" -or -not $payload.ciphertext) {
        throw "Unsupported machine secret format"
    }
    $entropy = [Text.Encoding]::UTF8.GetBytes("AgenticMail.WindowsService.LocalMachine.v1")
    $ciphertext = [Convert]::FromBase64String([string]$payload.ciphertext)
    $clear = [Security.Cryptography.ProtectedData]::Unprotect(
        $ciphertext,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    try { [Text.Encoding]::UTF8.GetString($clear) }
    finally { [Array]::Clear($clear, 0, $clear.Length) }
} else {
    $secure = $raw | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
}
"""
    child_env = os.environ.copy()
    child_env["AGENTICMAIL_DPAPI_SECRET_PATH"] = str(path)
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=child_env,
    )
    secret = completed.stdout.strip()
    if not secret:
        raise RuntimeError("DPAPI secret is empty")
    return secret


class ExchangeEwsSidecar:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path
        self.config = read_json(config_path, {})
        self.state_path = Path(self.config["statePath"])
        self.audit_path = Path(self.config["auditPath"])
        self.state = read_json(self.state_path, {"initialized": False, "seenIds": []})
        self.seen_ids = set(str(value) for value in self.state.get("seenIds", []))
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.state_write_lock = threading.Lock()
        self.health: dict[str, Any] = {
            "status": "starting",
            "mailbox": self.config.get("mailbox"),
            "server": self.config.get("server"),
            "initialized": bool(self.state.get("initialized")),
            "lastPoll": None,
            "lastSuccess": None,
            "lastError": None,
            "importedCount": int(self.state.get("importedCount", 0)),
            "draftsCreated": int(self.state.get("draftsCreated", 0)),
            "lastDraftAt": None,
            "transcriptEmail": {
                "enabled": False,
                "status": "disabled",
                "sender": None,
                "recipient": None,
                "lastPoll": None,
                "lastSuccess": None,
                "lastError": None,
                "sentCount": int(self.state.get("transcriptEmailsSent", 0)),
                "lastSentAt": None,
            },
            "callArchive": {
                "enabled": False,
                "status": "disabled",
                "room": "incoming_calls",
                "lastPoll": None,
                "lastSuccess": None,
                "lastError": None,
                "drawersWritten": int(self.state.get("callArchiveDrawersWritten", 0)),
            },
        }
        self.password = decrypt_dpapi_secret(Path(self.config["secretRef"]))
        self.agentic_config = read_json(Path(self.config["agenticmailConfigPath"]), {})
        self.inbound_secret = self._agentic_secret("inboundSecret")
        self.internal_api_key = self._agentic_secret("masterKey")
        transcript_email = self.config.get("postCallTranscriptEmail") or {}
        self.transcript_email_enabled = transcript_email.get("enabled") is True
        self.transcript_email_sender = str(transcript_email.get("sender") or "").strip().lower()
        self.transcript_email_recipient = str(transcript_email.get("recipient") or "").strip().lower()
        self.transcript_email_allowed_recipients = {
            str(value).strip().lower()
            for value in transcript_email.get("allowedRecipients") or []
            if str(value).strip()
        }
        self.transcript_email_poll_seconds = max(2, int(transcript_email.get("pollSeconds") or 2))
        if self.transcript_email_enabled:
            mailbox = str(self.config.get("mailbox") or "").strip().lower()
            if self.transcript_email_sender != mailbox:
                raise RuntimeError("Post-call transcript sender must match the authenticated Exchange mailbox")
            if not self.transcript_email_recipient:
                raise RuntimeError("Post-call transcript recipient is missing")
            if self.transcript_email_recipient not in self.transcript_email_allowed_recipients:
                raise RuntimeError("Post-call transcript recipient is not allowlisted")
            self.health["transcriptEmail"].update({
                "enabled": True,
                "status": "starting",
                "sender": self.transcript_email_sender,
                "recipient": self.transcript_email_recipient,
            })
        palace_path = str(os.getenv("INCOMING_CALL_MEMPALACE_PATH") or "").strip()
        self.call_archiver = (
            IncomingCallMempalaceArchiver(
                api_base=self.config["apiBase"],
                api_key=self.internal_api_key,
                palace_path=Path(palace_path),
                wing=str(os.getenv("INCOMING_CALL_MEMPALACE_WING") or "purchasing department"),
                room=str(os.getenv("INCOMING_CALL_MEMPALACE_ROOM") or "incoming_calls"),
            )
            if palace_path
            else None
        )
        if self.call_archiver:
            self.health["callArchive"].update({"enabled": True, "status": "starting"})
        self.account = self._open_account()

    def _agentic_secret(self, name: str) -> str:
        secret = str(self.agentic_config.get(name) or "").strip()
        if not secret:
            raise RuntimeError(f"AgenticMail {name} is missing")
        return secret

    def _open_account(self):
        ca_path = Path(self.config["caBundlePath"])
        if not ca_path.exists():
            raise RuntimeError(f"Exchange CA bundle not found: {ca_path}")
        os.environ["REQUESTS_CA_BUNDLE"] = str(ca_path)
        os.environ["SSL_CERT_FILE"] = str(ca_path)
        os.environ["EXCHANGE_EWS_CA_BUNDLE_PATH"] = str(ca_path)

        from exchangelib import Account, Configuration, Credentials, DELEGATE, NTLM
        from exchangelib.protocol import BaseProtocol
        from requests.adapters import HTTPAdapter

        BaseProtocol.HTTP_ADAPTER_CLS = HTTPAdapter
        credentials = Credentials(username=self.config["username"], password=self.password)
        exchange_config = Configuration(
            service_endpoint=f"https://{self.config['server']}/EWS/Exchange.asmx",
            credentials=credentials,
            auth_type=NTLM,
        )
        return Account(
            primary_smtp_address=self.config["mailbox"],
            config=exchange_config,
            autodiscover=False,
            access_type=DELEGATE,
        )

    def log(self, event_type: str, **fields: Any) -> None:
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        record = {"at": now_iso(), "type": event_type, **fields}
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def public_health(self) -> dict[str, Any]:
        with self.lock:
            return json.loads(json.dumps(self.health))

    def _recent_messages(self, limit: int = 50):
        query = self.account.inbox.all().only("message_id", "datetime_received")
        try:
            return list(query.order_by("-datetime_received")[:limit])
        except Exception:
            return list(query[:limit])

    @staticmethod
    def _item_key(item: Any) -> str:
        return str(getattr(item, "id", "") or getattr(item, "message_id", ""))

    def _save_state(self) -> None:
        with self.state_write_lock:
            seen = list(self.seen_ids)
            if len(seen) > 2000:
                seen = seen[-2000:]
                self.seen_ids = set(seen)
            value = {
                "initialized": True,
                "seenIds": seen,
                "importedCount": self.health["importedCount"],
                "draftsCreated": self.health["draftsCreated"],
                "transcriptEmailsSent": self.health["transcriptEmail"]["sentCount"],
                "callArchiveDrawersWritten": self.health["callArchive"]["drawersWritten"],
                "updatedAt": now_iso(),
            }
            write_json(self.state_path, value)

    def initialize_baseline(self) -> None:
        messages = self._recent_messages(limit=100)
        for item in messages:
            key = self._item_key(item)
            if key:
                self.seen_ids.add(key)
        with self.lock:
            self.health["initialized"] = True
            self.health["status"] = "ok"
            self.health["lastSuccess"] = now_iso()
        self._save_state()
        self.log("baseline_initialized", messageCount=len(messages))

    @staticmethod
    def _sender(item: Any) -> tuple[str, str]:
        sender = getattr(item, "sender", None)
        address = str(getattr(sender, "email_address", "") or "unknown@localhost")
        name = str(getattr(sender, "name", "") or "").strip()
        return name, address

    def _raw_email(self, item: Any) -> bytes:
        sender_name, sender_address = self._sender(item)
        message = EmailMessage()
        message["From"] = f"{sender_name} <{sender_address}>" if sender_name else sender_address
        recipients = [
            str(getattr(recipient, "email_address", ""))
            for recipient in (getattr(item, "to_recipients", None) or [])
            if getattr(recipient, "email_address", None)
        ]
        message["To"] = ", ".join(recipients) if recipients else self.config["mailbox"]
        message["Subject"] = str(getattr(item, "subject", "") or "(no subject)")
        message_id = str(getattr(item, "message_id", "") or "").strip()
        if not message_id:
            digest = hashlib.sha256(self._item_key(item).encode("utf-8")).hexdigest()[:24]
            message_id = f"<ews-{digest}@agenticmail.local>"
        message["Message-ID"] = message_id
        received = getattr(item, "datetime_received", None)
        if received is not None:
            message["Date"] = format_datetime(received)

        body = str(getattr(item, "body", "") or "")
        plain = re.sub(r"<[^>]+>", " ", body)
        plain = re.sub(r"\s+", " ", plain).strip()
        message.set_content(plain or "(empty message)")
        if re.search(r"</?[a-z][^>]*>", body, flags=re.IGNORECASE):
            message.add_alternative(body, subtype="html")
        if bool(getattr(item, "has_attachments", False)):
            message["X-AgenticMail-Attachments-Pending"] = "true"
        return message.as_bytes(policy=policy.SMTP)

    def deliver(self, item: Any) -> None:
        sender_name, sender_address = self._sender(item)
        del sender_name
        raw = self._raw_email(item)
        payload = {
            "from": sender_address,
            "to": self.config["agentRecipient"],
            "subject": str(getattr(item, "subject", "") or "(no subject)"),
            "rawEmail": base64.b64encode(raw).decode("ascii"),
        }
        response = requests.post(
            f"{self.config['apiBase'].rstrip('/')}/api/agenticmail/mail/inbound",
            headers={"X-Inbound-Secret": self.inbound_secret},
            json=payload,
            timeout=20,
        )
        response.raise_for_status()
        key_hash = hashlib.sha256(self._item_key(item).encode("utf-8")).hexdigest()[:16]
        self.log("message_imported", itemHash=key_hash, httpStatus=response.status_code)

    def _agentic_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.internal_api_key}"}

    def create_recap_draft(self, payload: dict[str, Any]) -> tuple[str, bool]:
        mission_id = str(payload.get("missionId") or "").strip()
        subject = str(payload.get("subject") or "").strip()[:255]
        text_body = str(payload.get("textBody") or "").strip()[:100_000]
        if not mission_id or not subject or not text_body:
            raise ValueError("missionId, subject and textBody are required")

        existing = list(self.account.drafts.filter(subject=subject).only("id")[:1])
        if existing:
            item_id = str(getattr(existing[0], "id", "") or subject)
            return hashlib.sha256(item_id.encode("utf-8")).hexdigest()[:24], False

        from exchangelib import Message

        message = Message(
            account=self.account,
            folder=self.account.drafts,
            subject=subject,
            body=text_body,
        )
        saved = message.save()
        item_id = str(getattr(saved, "id", "") or getattr(message, "id", "") or subject)
        ref_hash = hashlib.sha256(item_id.encode("utf-8")).hexdigest()[:24]
        with self.lock:
            self.health["draftsCreated"] += 1
            self.health["lastDraftAt"] = now_iso()
        self.log(
            "internal_recap_draft_created",
            missionHash=hashlib.sha256(mission_id.encode("utf-8")).hexdigest()[:16],
            exchangeRefHash=ref_hash,
            bodyLength=len(text_body),
        )
        self._save_state()
        return ref_hash, True

    def sync_recap_drafts(self) -> None:
        api_root = self.config["apiBase"].rstrip("/")
        response = requests.get(
            f"{api_root}/api/agenticmail/calls/sip/recap-drafts/pending?limit=10",
            headers=self._agentic_headers(),
            timeout=15,
        )
        response.raise_for_status()
        for draft in response.json().get("drafts", []):
            mission_id = str(draft.get("missionId") or "")
            if not mission_id:
                continue
            try:
                ref_hash, _created = self.create_recap_draft(draft)
                ack = requests.post(
                    f"{api_root}/api/agenticmail/calls/sip/recap-drafts/{mission_id}/delivered",
                    headers={**self._agentic_headers(), "Content-Type": "application/json"},
                    json={"exchangeRefHash": ref_hash},
                    timeout=15,
                )
                ack.raise_for_status()
            except Exception as exc:
                try:
                    requests.post(
                        f"{api_root}/api/agenticmail/calls/sip/recap-drafts/{mission_id}/failed",
                        headers={**self._agentic_headers(), "Content-Type": "application/json"},
                        json={"errorType": type(exc).__name__},
                        timeout=10,
                    ).raise_for_status()
                except Exception:
                    pass
                raise

    def send_transcript_email(self, payload: dict[str, Any]) -> tuple[str, bool]:
        mission_id = str(payload.get("missionId") or "").strip()
        subject = str(payload.get("subject") or "").strip()[:255]
        text_body = str(payload.get("textBody") or "").strip()
        if not mission_id or not subject or not text_body:
            raise ValueError("missionId, subject and textBody are required")
        if not self.transcript_email_enabled:
            raise RuntimeError("Post-call transcript email delivery is disabled")

        existing = list(self.account.sent.filter(subject=subject).only("id")[:1])
        if existing:
            item_id = str(getattr(existing[0], "id", "") or subject)
            return hashlib.sha256(item_id.encode("utf-8")).hexdigest()[:24], False

        from exchangelib import Mailbox, Message

        message = Message(
            account=self.account,
            subject=subject,
            body=text_body,
            to_recipients=[Mailbox(email_address=self.transcript_email_recipient)],
        )
        message.send_and_save()
        item_id = str(getattr(message, "id", "") or subject)
        ref_hash = hashlib.sha256(item_id.encode("utf-8")).hexdigest()[:24]
        with self.lock:
            transcript_health = self.health["transcriptEmail"]
            transcript_health["sentCount"] += 1
            transcript_health["lastSentAt"] = now_iso()
        self.log(
            "post_call_transcript_email_sent",
            missionHash=hashlib.sha256(mission_id.encode("utf-8")).hexdigest()[:16],
            recipientHash=hashlib.sha256(self.transcript_email_recipient.encode("utf-8")).hexdigest()[:16],
            exchangeRefHash=ref_hash,
            bodyLength=len(text_body),
        )
        self._save_state()
        return ref_hash, True

    def sync_transcript_emails_once(self) -> None:
        if not self.transcript_email_enabled:
            return
        api_root = self.config["apiBase"].rstrip("/")
        response = requests.get(
            f"{api_root}/api/agenticmail/calls/sip/transcript-emails/pending?limit=10",
            headers=self._agentic_headers(),
            timeout=15,
        )
        response.raise_for_status()
        for email in response.json().get("emails", []):
            mission_id = str(email.get("missionId") or "")
            if not mission_id:
                continue
            try:
                ref_hash, _created = self.send_transcript_email(email)
                ack = requests.post(
                    f"{api_root}/api/agenticmail/calls/sip/transcript-emails/{mission_id}/delivered",
                    headers={**self._agentic_headers(), "Content-Type": "application/json"},
                    json={"exchangeRefHash": ref_hash},
                    timeout=15,
                )
                ack.raise_for_status()
            except Exception as exc:
                try:
                    requests.post(
                        f"{api_root}/api/agenticmail/calls/sip/transcript-emails/{mission_id}/failed",
                        headers={**self._agentic_headers(), "Content-Type": "application/json"},
                        json={"errorType": type(exc).__name__},
                        timeout=10,
                    ).raise_for_status()
                except Exception:
                    pass
                raise

    def run_transcript_email_loop(self) -> None:
        while not self.stop_event.is_set():
            with self.lock:
                self.health["transcriptEmail"]["lastPoll"] = now_iso()
            try:
                self.sync_transcript_emails_once()
                with self.lock:
                    transcript_health = self.health["transcriptEmail"]
                    transcript_health["status"] = "ok"
                    transcript_health["lastSuccess"] = now_iso()
                    transcript_health["lastError"] = None
            except Exception as exc:
                message = safe_error(exc)
                with self.lock:
                    transcript_health = self.health["transcriptEmail"]
                    transcript_health["status"] = "degraded"
                    transcript_health["lastError"] = message
                self.log("post_call_transcript_email_sync_failed", errorType=type(exc).__name__, message=message)
            self.stop_event.wait(self.transcript_email_poll_seconds)

    def poll_once(self) -> None:
        with self.lock:
            self.health["lastPoll"] = now_iso()
        try:
            messages = self._recent_messages(limit=50)
            if not self.state.get("initialized", False):
                self.initialize_baseline()
                self.state["initialized"] = True
                return
            imported = 0
            for item in reversed(messages):
                key = self._item_key(item)
                if not key or key in self.seen_ids:
                    continue
                full_item = self.account.inbox.get(id=key)
                self.deliver(full_item)
                self.seen_ids.add(key)
                imported += 1
            self.sync_recap_drafts()
            with self.lock:
                self.health["status"] = "ok"
                self.health["lastSuccess"] = now_iso()
                self.health["lastError"] = None
                self.health["importedCount"] += imported
            self._save_state()
        except Exception as exc:
            message = safe_error(exc)
            with self.lock:
                self.health["status"] = "degraded"
                self.health["lastError"] = message
            self.log("poll_failed", errorType=type(exc).__name__, message=message)

    def sync_call_archives_once(self) -> None:
        if not self.call_archiver:
            return
        with self.lock:
            self.health["callArchive"]["lastPoll"] = now_iso()
        try:
            result = self.call_archiver.sync_once(limit=10)
            with self.lock:
                call_health = self.health["callArchive"]
                call_health["status"] = "ok" if not result["failures"] else "degraded"
                call_health["lastSuccess"] = now_iso()
                call_health["lastError"] = (
                    result["failures"][0]["error_type"] if result["failures"] else None
                )
                call_health["drawersWritten"] += int(result["drawers_written"])
            if result["drawers_written"] or result["failures"]:
                self.log(
                    "incoming_call_mempalace_sync",
                    room=result["room"],
                    pendingSeen=result["pending_seen"],
                    drawersWritten=result["drawers_written"],
                    failures=len(result["failures"]),
                )
            if result["drawers_written"]:
                self._save_state()
        except Exception as exc:
            message = safe_error(exc)
            with self.lock:
                self.health["callArchive"]["status"] = "degraded"
                self.health["callArchive"]["lastError"] = message
            self.log("incoming_call_mempalace_sync_failed", errorType=type(exc).__name__, message=message)

    def run_call_archive_loop(self) -> None:
        interval = max(2, int(os.getenv("INCOMING_CALL_MEMPALACE_POLL_SECONDS") or "2"))
        while not self.stop_event.is_set():
            self.sync_call_archives_once()
            self.stop_event.wait(interval)

    def run(self) -> None:
        interval = max(10, int(self.config.get("pollSeconds", 30)))
        self.log("sidecar_started", mailbox=self.config.get("mailbox"), server=self.config.get("server"))
        if self.call_archiver:
            threading.Thread(
                target=self.run_call_archive_loop,
                name="incoming-call-mempalace",
                daemon=True,
            ).start()
        if self.transcript_email_enabled:
            threading.Thread(
                target=self.run_transcript_email_loop,
                name="post-call-transcript-email",
                daemon=True,
            ).start()
        while not self.stop_event.is_set():
            self.poll_once()
            self.stop_event.wait(interval)


def start_health_server(sidecar: ExchangeEwsSidecar) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            payload = json.dumps(sidecar.public_health(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", int(sidecar.config.get("healthPort", 3901))), Handler)
    threading.Thread(target=server.serve_forever, name="ews-health", daemon=True).start()
    return server


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    sidecar = ExchangeEwsSidecar(Path(args.config))
    server = start_health_server(sidecar)

    def stop(_signum: int, _frame: Any) -> None:
        sidecar.stop_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        sidecar.run()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
