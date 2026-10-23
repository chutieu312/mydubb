"""The live smoke script, run against a fake Azure (it must write playable samples, no secrets)."""

import sys
from functools import partial

import httpx

from app.audio.ffmpeg import probe_mp3
from scripts import azure_speech_smoke
from tests.audio_helpers import make_wav, ssml_text, ssml_voice

KEY = "smoke-test-key-0123456789"


def run_script(monkeypatch, tmp_path, *args, handler=None):
    requests = []

    def fake_azure(request: httpx.Request) -> httpx.Response:
        text = ssml_text(request.content)
        requests.append((request.url.host, text, ssml_voice(request.content).get("name")))
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
    assert files == ["speech-AndrewMultilingual.mp3", "speech-EmmaMultilingual.mp3"]
    for path in (tmp_path / "out").iterdir():
        assert probe_mp3(audio_tools, path) > 5
    output = capsys.readouterr().out
    assert "LISTEN" in output  # it never claims the pronunciation is good
    assert KEY not in output
    # Only the synthetic transcript the Product Owner accepted, once per voice.
    assert [(text, voice) for _, text, voice in requests] == [
        (azure_speech_smoke.SAMPLE, "en-US-AndrewMultilingualNeural"),
        (azure_speech_smoke.SAMPLE, "en-US-EmmaMultilingualNeural"),
    ]
    assert {host for host, _, _ in requests} == {"westus2.tts.speech.microsoft.com"}


def test_multi_chunk_mode_exercises_joining(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    status, requests = run_script(monkeypatch, tmp_path, "--multi-chunk")

    assert status == 0
    assert len(requests) == 2 + 2 * 4  # 4 small chunks per voice besides the 1 normal request
    names = sorted(p.name for p in (tmp_path / "out").iterdir())
    assert names == [
        "speech-AndrewMultilingual.mp3",
        "speech-EmmaMultilingual.mp3",
        "speech-multi-chunk-AndrewMultilingual.mp3",
        "speech-multi-chunk-EmmaMultilingual.mp3",
    ]
    assert len(requests) <= 20  # fits one minute of the Free (F0) quota
    # The four small requests of a voice are the accepted transcript line by line, in order.
    chunks = [text for _, text, voice in requests[1:5]]
    assert [voice for _, _, voice in requests[1:5]] == ["en-US-AndrewMultilingualNeural"] * 4
    assert "\n".join(chunks) == azure_speech_smoke.SAMPLE
    capsys.readouterr()


def test_a_service_error_is_reported_without_secrets(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    status, _ = run_script(monkeypatch, tmp_path, handler=lambda request: httpx.Response(401))
    assert status == 1
    output = capsys.readouterr().out
    assert "speech_auth_failed" in output
    assert KEY not in output
