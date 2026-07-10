from __future__ import annotations

import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from incoming_call_mempalace import IncomingCallMempalaceArchiver, drawer_id_for_mission


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeCollection:
    def __init__(self):
        self.records = {}

    def upsert(self, *, ids, documents, metadatas):
        for drawer_id, document, metadata in zip(ids, documents, metadatas, strict=True):
            self.records[drawer_id] = (document, metadata)


class FakeHttp:
    def __init__(self, mission_id, transcript_payload):
        self.mission_id = mission_id
        self.transcript_payload = transcript_payload
        self.deliveries = []
        self.failures = []

    def get(self, url, **_kwargs):
        if url.endswith("knowledge-archive/pending?limit=10"):
            return FakeResponse({"archives": [{"missionId": self.mission_id, "status": "pending"}]})
        if url.endswith(f"calls/sip/{self.mission_id}/transcript"):
            return FakeResponse(self.transcript_payload)
        return FakeResponse({}, 404)

    def post(self, url, json, **_kwargs):
        if url.endswith("/delivered"):
            self.deliveries.append(json)
        elif url.endswith("/failed"):
            self.failures.append(json)
        return FakeResponse({"success": True})


class IncomingCallMempalaceTests(unittest.TestCase):
    def test_archives_full_inbound_transcript_idempotently(self):
        mission_id = "call_test_inbound"
        payload = {
            "missionId": mission_id,
            "direction": "inbound",
            "status": "completed",
            "createdAt": "2026-07-11T10:00:00Z",
            "endedAt": "2026-07-11T10:01:00Z",
            "endReason": "remote_bye",
            "salesIntake": {"serviceTopic": "customs", "summary": "Запрос клиента"},
            "transcript": [
                {"at": "2026-07-11T10:00:01Z", "source": "agent", "text": "Добрый день."},
                {"at": "2026-07-11T10:00:03Z", "source": "provider", "text": "Нужна консультация."},
            ],
        }
        collection = FakeCollection()
        http = FakeHttp(mission_id, payload)
        with TemporaryDirectory() as temp:
            archiver = IncomingCallMempalaceArchiver(
                api_base="http://127.0.0.1:3829",
                api_key="test-key",
                palace_path=Path(temp),
                http=http,
                collection_loader=lambda _path: collection,
            )
            first = archiver.sync_once()
            second = archiver.sync_once()

        drawer_id = drawer_id_for_mission(mission_id)
        self.assertEqual(first["drawers_written"], 1)
        self.assertEqual(second["drawers_written"], 1)
        self.assertEqual(len(collection.records), 1)
        document, metadata = collection.records[drawer_id]
        self.assertIn("Елена: Добрый день.", document)
        self.assertIn("Клиент: Нужна консультация.", document)
        self.assertEqual(metadata["room"], "incoming_calls")
        self.assertFalse(metadata["direct_voice_use_allowed"])
        self.assertEqual(http.deliveries[-1]["contentSha256"], hashlib.sha256(document.encode()).hexdigest())
        self.assertEqual(http.failures, [])

    def test_rejects_outbound_payload_and_marks_retry(self):
        mission_id = "call_test_outbound"
        collection = FakeCollection()
        http = FakeHttp(mission_id, {"missionId": mission_id, "direction": "outbound", "transcript": []})
        archiver = IncomingCallMempalaceArchiver(
            api_base="http://127.0.0.1:3829",
            api_key="test-key",
            palace_path=Path("unused"),
            http=http,
            collection_loader=lambda _path: collection,
        )
        result = archiver.sync_once()
        self.assertEqual(result["drawers_written"], 0)
        self.assertEqual(result["failures"][0]["error_type"], "ValueError")
        self.assertEqual(http.failures, [{"errorType": "ValueError"}])


if __name__ == "__main__":
    unittest.main()
