"""Minimal Python client for the lucarne control API (stdlib only).

The daemon is the source of truth; this is convenience sugar. The session's
``cdpUrl`` is still driven with your CDP client of choice (e.g. Playwright).
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

try:  # single source of truth — the installed package metadata (pyproject version)
    from importlib.metadata import version as _pkg_version

    __version__ = _pkg_version("lucarne")
except Exception:  # not installed (vendored single file) — fall back to a literal
    __version__ = "1.4.1"


class LucarneClient:
    def __init__(self, base_url: str = "http://127.0.0.1:7800", token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            ctype = resp.headers.get("content-type", "")
            return json.loads(raw) if "application/json" in ctype else raw.decode()

    def health(self) -> dict:
        return self._req("GET", "/health")

    def create(self, **opts: Any) -> dict:
        return self._req("POST", "/sessions", opts)

    def list(self, **meta: str) -> list:
        # URL-encode keys/values (matches the Node SDK) so a filter containing a
        # space/&/=/non-ASCII isn't mis-split by the server's query parser.
        qz = urllib.parse.quote
        q = "?" + "&".join(f"meta.{qz(k)}={qz(v)}" for k, v in meta.items()) if meta else ""
        return self._req("GET", "/sessions" + q)

    def get(self, session_id: str) -> dict:
        return self._req("GET", f"/sessions/{session_id}")

    def destroy(self, session_id: str) -> dict:
        return self._req("DELETE", f"/sessions/{session_id}")

    def act(self, session_id: str, **action: Any) -> dict:
        return self._req("POST", f"/sessions/{session_id}/act", action)

    def content(self, session_id: str) -> str:
        return self._req("GET", f"/sessions/{session_id}/content")
