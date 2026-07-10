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
$secure = Get-Content -LiteralPath $p -Raw | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
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
        self.health: dict[str, Any] = {
            "status": "starting",
            "mailbox": self.config.get("mailbox"),
            "server": self.config.get("server"),
            "initialized": bool(self.state.get("initialized")),
            "lastPoll": None,
            "lastSuccess": None,
            "lastError": None,
            "importedCount": int(self.state.get("importedCount", 0)),
        }
        self.password = decrypt_dpapi_secret(Path(self.config["secretRef"]))
        self.inbound_secret = self._load_inbound_secret()
        self.account = self._open_account()

    def _load_inbound_secret(self) -> str:
        agentic_config = read_json(Path(self.config["agenticmailConfigPath"]), {})
        secret = str(agentic_config.get("inboundSecret") or "").strip()
        if not secret:
            raise RuntimeError("AgenticMail inboundSecret is missing")
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
            return dict(self.health)

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
        seen = list(self.seen_ids)
        if len(seen) > 2000:
            seen = seen[-2000:]
            self.seen_ids = set(seen)
        value = {
            "initialized": True,
            "seenIds": seen,
            "importedCount": self.health["importedCount"],
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

    def run(self) -> None:
        interval = max(10, int(self.config.get("pollSeconds", 30)))
        self.log("sidecar_started", mailbox=self.config.get("mailbox"), server=self.config.get("server"))
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
