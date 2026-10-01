import asyncio
import importlib.util
import pickle
import sys
import types
from fractions import Fraction
from pathlib import Path


class DummyMangaTranslator:
    def __init__(self, params):
        self.params = params
        self.font_path = None
        self._is_streaming_mode = False

    def add_progress_hook(self, hook):
        self.progress_hook = hook

    def translate(self, **attributes):
        return {"ok": True, "keys": sorted(attributes)}


class NotAllowedForPickle:
    pass


class FakeRequest:
    headers = {}

    def __init__(self, payload):
        self.payload = payload

    async def body(self):
        return self.payload


def load_share_module(monkeypatch):
    fake_package = types.ModuleType("manga_translator")
    fake_package.MangaTranslator = DummyMangaTranslator
    monkeypatch.setitem(sys.modules, "manga_translator", fake_package)

    path = Path(__file__).resolve().parents[1] / "manga_translator" / "mode" / "share.py"
    spec = importlib.util.spec_from_file_location("share_under_test", path)
    share_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(share_module)
    return share_module


async def collect_streaming_response_body(response):
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


def test_stream_execute_releases_lock_when_request_cannot_be_unpickled(monkeypatch):
    share_module = load_share_module(monkeypatch)
    manga_share = share_module.MangaShare({"host": "127.0.0.1", "port": 5003, "nonce": "None"})
    app = manga_share.create_app()
    execute = next(route.endpoint for route in app.routes if route.path == "/execute/{method_name}")
    is_locked = next(route.endpoint for route in app.routes if route.path == "/is_locked")

    async def scenario():
        try:
            await execute(FakeRequest(pickle.dumps({"bad": NotAllowedForPickle()})), "translate")
        except Exception as exc:
            response = exc
        else:
            raise AssertionError("Expected bad pickle request to fail")

        assert response.status_code == 500
        assert manga_share.lock.locked() is False
        assert await is_locked() == {"locked": False}

        retry = await execute(FakeRequest(pickle.dumps({"text": "retry"})), "translate")
        retry_body = await collect_streaming_response_body(retry)

        assert manga_share.lock.locked() is False
        assert retry_body[:1] == b"\x00"

    asyncio.run(scenario())


def test_restricted_loads_allows_fraction_values_from_image_payloads(monkeypatch):
    share_module = load_share_module(monkeypatch)
    payload = pickle.dumps({"scale": Fraction(1, 2)})

    decoded = share_module.restricted_loads(payload)

    assert decoded["scale"] == Fraction(1, 2)
