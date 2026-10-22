"""The live smoke script, run against a fake Azure (it must write playable samples, no secrets)."""

import sys
import xml.etree.ElementTree as ET
from functools import partial

import httpx

from app.audio.ffmpeg import probe_mp3
from scripts import azure_speech_smoke
from tests.audio_helpers import make_wav

KEY = "smoke-test-key-0123456789"
NS = {"s": "http://www.w3.org/2001/10/synthesis"}


def run_script(monkeypatch, tmp_path, *args, handler=None):
    requests = []

    def fake_azure(request: httpx.Request) -> httpx.Response:
        text = ET.fromstring(request.content).find("s:voice", NS).text
        requests.append((request.url.host, text))
        if handler:
            return handler(request)
        return httpx.Response(200, content=make_wav(len(text) / 15))

    monkeypatch.setattr(azure_speech_smoke, "load_dotenv", lambda: None)
    monkeypatch.setattr(
        azure_speech_smoke,
        "AzureSpeechProvider",
        partial(azure_speech_smoke.AzureSpeechProvider, transport=httpx.MockTransport(fake_azure)),
    )
    monkeypatch.setattr(sys, "argv", ["smoke", "--output-dir", str(tmp_path / "out"), *args])
    return azure_speech_smoke.main(), requests


def test_without_credentials_it_explains_and_makes_no_request(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)
    status, requests = run_script(monkeypatch, tmp_path)
    assert status == 2
    assert requests == []
    assert "AZURE_SPEECH_KEY" in capsys.readouterr().out


def test_it_writes_valid_mp3_samples_for_both_voices(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    status, requests = run_script(monkeypatch, tmp_path)

    assert status == 0
    assert len(requests) == 2  # one short request per voice
    files = sorted(p.name for p in (tmp_path / "out").iterdir())
    assert files == ["speech-HoaiMy.mp3", "speech-NamMinh.mp3"]
    for path in (tmp_path / "out").iterdir():
        assert probe_mp3(audio_tools, path) > 5
    output = capsys.readouterr().out
    assert "LISTEN" in output  # it never claims the pronunciation is good
    assert KEY not in output
    assert all("neural network" in text for _, text in requests)


def test_multi_chunk_mode_exercises_joining(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    status, requests = run_script(monkeypatch, tmp_path, "--multi-chunk")

    assert status == 0
    assert len(requests) == 2 + 2 * 4  # 4 small chunks per voice besides the 1 normal request
    names = sorted(p.name for p in (tmp_path / "out").iterdir())
    assert names == [
        "speech-HoaiMy.mp3",
        "speech-NamMinh.mp3",
        "speech-multi-chunk-HoaiMy.mp3",
        "speech-multi-chunk-NamMinh.mp3",
    ]
    assert len(requests) <= 20  # fits one minute of the Free (F0) quota
    capsys.readouterr()


def test_a_service_error_is_reported_without_secrets(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    status, _ = run_script(monkeypatch, tmp_path, handler=lambda request: httpx.Response(401))
    assert status == 1
    output = capsys.readouterr().out
    assert "speech_auth_failed" in output
    assert KEY not in output
