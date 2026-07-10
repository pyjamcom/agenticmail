from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests


DEFAULT_WING = "purchasing department"
DEFAULT_ROOM = "incoming_calls"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def drawer_id_for_mission(mission_id: str) -> str:
    digest = hashlib.sha256(mission_id.encode("utf-8")).hexdigest()[:40]
    return f"sip_incoming_{digest}"


def render_call_document(payload: dict[str, Any], *, wing: str, room: str) -> str:
    mission_id = str(payload.get("missionId") or "").strip()
    if not mission_id:
        raise ValueError("missionId is required")
    if str(payload.get("direction") or "").strip().lower() != "inbound":
        raise ValueError("only inbound call transcripts may be filed in incoming_calls")

    intake = payload.get("salesIntake") if isinstance(payload.get("salesIntake"), dict) else {}
    transcript = payload.get("transcript") if isinstance(payload.get("transcript"), list) else []
    role_names = {
        "provider": "Клиент",
        "agent": "Елена",
        "operator": "Менеджер",
        "system": "Система",
    }
    lines = [
        "Полная расшифровка входящего звонка",
        f"База знаний: {wing}",
        f"Раздел: {room}",
        f"Mission ID: {mission_id}",
        f"Статус: {payload.get('status') or ''}",
        f"Начало: {payload.get('createdAt') or ''}",
        f"Завершение: {payload.get('endedAt') or payload.get('updatedAt') or ''}",
        f"Причина завершения: {payload.get('endReason') or ''}",
        "Класс доверия: непроверенные слова участников звонка; не использовать как подтвержденный факт компании.",
        "Политика использования: история обращения и последующая работа менеджера.",
        "",
        "--- Структурированная карточка ---",
        json.dumps(intake, ensure_ascii=False, sort_keys=True, indent=2),
        "",
        "--- Полный текст разговора ---",
    ]
    for index, entry in enumerate(transcript, start=1):
        if not isinstance(entry, dict):
            continue
        source = str(entry.get("source") or "system")
        role = role_names.get(source, source)
        at = str(entry.get("at") or "")
        text = str(entry.get("text") or "").strip()
        if text:
            lines.append(f"[{index:04d}] [{at}] {role}: {text}")
    if not any(str(entry.get("text") or "").strip() for entry in transcript if isinstance(entry, dict)):
        lines.append("[Текстовые реплики отсутствуют]")
    return "\n".join(lines)


def load_collection(palace_path: Path):
    try:
        from mempalace.palace import get_collection
    except ImportError as exc:
        raise RuntimeError("mempalace is not installed") from exc
    palace_path.mkdir(parents=True, exist_ok=True)
    return get_collection(str(palace_path), create=True)


class IncomingCallMempalaceArchiver:
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        palace_path: Path,
        wing: str = DEFAULT_WING,
        room: str = DEFAULT_ROOM,
        http: Any = requests,
        collection_loader: Callable[[Path], Any] = load_collection,
    ) -> None:
        self.api_root = api_base.rstrip("/") + "/api/agenticmail"
        self.api_key = api_key
        self.palace_path = palace_path
        self.wing = wing
        self.room = room
        self.http = http
        self.collection_loader = collection_loader
        self._collection = None

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    @property
    def collection(self):
        if self._collection is None:
            self._collection = self.collection_loader(self.palace_path)
        return self._collection

    def _mark_failed(self, mission_id: str, exc: Exception) -> None:
        try:
            response = self.http.post(
                f"{self.api_root}/calls/sip/knowledge-archive/{mission_id}/failed",
                headers={**self.headers, "Content-Type": "application/json"},
                json={"errorType": type(exc).__name__},
                timeout=10,
            )
            response.raise_for_status()
        except Exception:
            return

    def archive_one(self, mission_id: str) -> dict[str, Any]:
        response = self.http.get(
            f"{self.api_root}/calls/sip/{mission_id}/transcript",
            headers=self.headers,
            timeout=90,
        )
        response.raise_for_status()
        payload = response.json()
        document = render_call_document(payload, wing=self.wing, room=self.room)
        content_sha256 = hashlib.sha256(document.encode("utf-8")).hexdigest()
        drawer_id = drawer_id_for_mission(mission_id)
        metadata = {
            "wing": self.wing,
            "room": self.room,
            "record_type": "incoming_call_transcript",
            "mission_id": mission_id,
            "direction": "inbound",
            "status": str(payload.get("status") or ""),
            "source_reference": f"agenticmail:phone_missions:{mission_id}",
            "content_sha256": content_sha256,
            "full_transcript": True,
            "contains_restricted_personal_data": True,
            "untrusted_external_source": True,
            "direct_voice_use_allowed": False,
            "added_by": "agenticmail-incoming-call-archiver",
            "filed_at": now_iso(),
        }
        self.collection.upsert(ids=[drawer_id], documents=[document], metadatas=[metadata])
        ack = self.http.post(
            f"{self.api_root}/calls/sip/knowledge-archive/{mission_id}/delivered",
            headers={**self.headers, "Content-Type": "application/json"},
            json={"drawerId": drawer_id, "contentSha256": content_sha256, "room": self.room},
            timeout=15,
        )
        ack.raise_for_status()
        return {
            "mission_id": mission_id,
            "drawer_id": drawer_id,
            "content_sha256": content_sha256,
            "transcript_entries": len(payload.get("transcript") or []),
        }

    def sync_once(self, *, limit: int = 10) -> dict[str, Any]:
        response = self.http.get(
            f"{self.api_root}/calls/sip/knowledge-archive/pending?limit={max(1, min(limit, 50))}",
            headers=self.headers,
            timeout=15,
        )
        response.raise_for_status()
        archives = response.json().get("archives", [])
        written: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []
        for item in archives:
            mission_id = str(item.get("missionId") or "").strip()
            if not mission_id:
                continue
            try:
                written.append(self.archive_one(mission_id))
            except Exception as exc:
                self._mark_failed(mission_id, exc)
                failures.append({"mission_id": mission_id, "error_type": type(exc).__name__})
        return {
            "room": self.room,
            "pending_seen": len(archives),
            "drawers_written": len(written),
            "failures": failures,
            "written": written,
        }
