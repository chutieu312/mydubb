"""The manual Supadata smoke script, run against a fake transport (never the real service)."""

from functools import partial

import httpx
import pytest

from scripts import supadata_smoke

LINK = "https://youtu.be/dQw4w9WgXcQ"
TRANSCRIPT = {
    "content": [
        {"text": "Hello  there.", "offset": 480, "duration": 1000, "lang": "en"},
        {"text": "General Kenobi.", "offset": 2000, "duration": 1000, "lang": "en"},
    ],
    "lang": "en",
    "availableLangs": ["en"],
}


@pytest.fixture
def fake_supadata(monkeypatch):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if "noEnglish00" in str(request.url):
            return httpx.Response(206, json={"error": "transcript-unavailable"})
        return httpx.Response(200, json=TRANSCRIPT, headers={"x-billable-requests": "1"})

    monkeypatch.setattr(
        supadata_smoke,
        "SupadataCaptionProvider",
        partial(supadata_smoke.SupadataCaptionProvider, transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(supadata_smoke, "load_dotenv", lambda: None)
    monkeypatch.setenv("SUPADATA_API_KEY", "smoke-test-key")
    return calls


def test_the_credits_must_be_confirmed_before_anything_is_sent(fake_supadata, capsys):
    assert supadata_smoke.main(["--confirm-credits", "1", LINK, LINK]) == 2
    assert "Nothing was sent" in capsys.readouterr().out
    assert fake_supadata == []


def test_an_invalid_link_or_a_missing_key_sends_nothing(fake_supadata, capsys, monkeypatch):
    assert supadata_smoke.main(["--confirm-credits", "1", "https://evil.example/x"]) == 2
    monkeypatch.delenv("SUPADATA_API_KEY")
    assert supadata_smoke.main(["--confirm-credits", "1", LINK]) == 2
    assert "SUPADATA_API_KEY is not set" in capsys.readouterr().out
    assert fake_supadata == []


def test_each_link_reports_its_outcome(fake_supadata, capsys):
    links = [LINK, "https://youtu.be/noEnglish00"]
    assert supadata_smoke.main(["--confirm-credits", "2", *links]) == 0
    out = capsys.readouterr().out
    assert "language=en captions=2 skipped_empty=0 first_start_ms=480" in out
    assert "starts_with_milliseconds=1" in out
    assert "billed_credits=1" in out
    assert "0:00.480\n  Hello  there." in out
    assert "plain cleaning keeps every caption text in order: True" in out
    assert "error: youtube_import_no_english_captions" in out
    assert "smoke-test-key" not in out
    assert len(fake_supadata) == 2
