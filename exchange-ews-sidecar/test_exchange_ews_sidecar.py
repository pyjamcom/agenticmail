from __future__ import annotations

import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MODULE_DIR))
SPEC = importlib.util.spec_from_file_location("exchange_ews_sidecar", MODULE_DIR / "exchange-ews-sidecar.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ExchangeEwsSidecar = MODULE.ExchangeEwsSidecar


class FakeQuery(list):
    def only(self, *_fields):
        return self


class FakeSentFolder:
    def __init__(self):
        self.items = []

    def filter(self, *, subject):
        return FakeQuery(item for item in self.items if item.subject == subject)


class FakeAccount:
    def __init__(self):
        self.sent = FakeSentFolder()


class FakeMailbox:
    def __init__(self, *, email_address):
        self.email_address = email_address


class FakeHTMLBody(str):
    pass


class FakeMessage:
    send_count = 0

    def __init__(self, *, account, subject, body, to_recipients):
        self.account = account
        self.subject = subject
        self.body = body
        self.to_recipients = to_recipients
        self.id = None

    def send_and_save(self):
        type(self).send_count += 1
        self.id = f"ews-sent-{type(self).send_count}"
        self.account.sent.items.append(self)


class ExchangeEwsSidecarTests(unittest.TestCase):
    def setUp(self):
        FakeMessage.send_count = 0
        self.sidecar = object.__new__(ExchangeEwsSidecar)
        self.sidecar.account = FakeAccount()
        self.sidecar.transcript_email_enabled = True
        self.sidecar.transcript_email_recipient = "pavel@nbr.ru"
        self.sidecar.lock = threading.Lock()
        self.sidecar.health = {
            "transcriptEmail": {"sentCount": 0, "lastSentAt": None},
        }
        self.sidecar.log = lambda *_args, **_kwargs: None
        self.sidecar._save_state = lambda: None

    def test_sends_full_transcript_once_and_deduplicates_by_subject(self):
        payload = {
            "missionId": "sip_test_1",
            "subject": "Расшифровка звонка 199 - sip_test_1",
            "textBody": "Клиент: Нужна доставка.\nЕлена: Уточните город отправления.",
            "htmlBody": "<p><strong>Клиент:</strong> Нужна доставка.</p>",
        }
        fake_module = types.SimpleNamespace(HTMLBody=FakeHTMLBody, Mailbox=FakeMailbox, Message=FakeMessage)

        with patch.dict(sys.modules, {"exchangelib": fake_module}):
            first_ref, first_created = self.sidecar.send_transcript_email(payload)
            second_ref, second_created = self.sidecar.send_transcript_email(payload)

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first_ref, second_ref)
        self.assertEqual(FakeMessage.send_count, 1)
        self.assertEqual(self.sidecar.health["transcriptEmail"]["sentCount"], 1)
        sent = self.sidecar.account.sent.items[0]
        self.assertEqual(sent.subject, payload["subject"])
        self.assertIsInstance(sent.body, FakeHTMLBody)
        self.assertEqual(sent.body, payload["htmlBody"])
        self.assertEqual(sent.to_recipients[0].email_address, "pavel@nbr.ru")


if __name__ == "__main__":
    unittest.main()
