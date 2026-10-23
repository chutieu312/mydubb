"""The duration smoke script: synthetic mode, a failing case, and live mode against a fake Azure."""

import sys
from functools import partial

import httpx

from app.audio.mp3_header import Mp3Gapless
from scripts import azure_speech_smoke, duration_smoke
from tests.audio_helpers import make_wav, ssml_text

KEY = "duration-smoke-key-0123456789"
SMALL_CASES = [("longer", 4.2, 3), ("shorter", 2.1, 3)]


def run_script(monkeypatch, tmp_path, *args):
    monkeypatch.setattr(duration_smoke, "load_dotenv", lambda: None)
    monkeypatch.setattr(sys, "argv", ["smoke", "--output-dir", str(tmp_path / "out"), *args])
    return duration_smoke.main()


def test_synthetic_mode_needs_no_credentials_and_writes_before_and_after(
    monkeypatch, tmp_path, capsys, audio_tools
):
    monkeypatch.setattr(duration_smoke, "SYNTHETIC_CASES", SMALL_CASES)
    for name in ("AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"):
        monkeypatch.delenv(name, raising=False)

    assert run_script(monkeypatch, tmp_path) == 0

    output = capsys.readouterr().out
    assert output.count("OK") >= 3  # two cases and the summary
    assert "MISMATCH" not in output
    assert "3.000000s" in output  # the target is printed unrounded, next to the measurements
    names = sorted(path.name for path in (tmp_path / "out").iterdir())
    assert names == [
        "synthetic-1-4.2s-to-3s-after.mp3",
        "synthetic-1-4.2s-to-3s-before.wav",
        "synthetic-2-2.1s-to-3s-after.mp3",
        "synthetic-2-2.1s-to-3s-before.wav",
    ]


def test_a_case_that_misses_the_target_fails_the_run(monkeypatch, tmp_path, capsys, audio_tools):
    monkeypatch.setattr(duration_smoke, "SYNTHETIC_CASES", SMALL_CASES[:1])
    real = duration_smoke.read_gapless_info

    def two_samples_off(path):
        info = real(path)
        return Mp3Gapless(
            info.sample_rate,
            info.frames,
            info.samples_per_frame,
            info.encoder_delay,
            info.padding - 2,
        )

    monkeypatch.setattr(duration_smoke, "read_gapless_info", two_samples_off)

    assert run_script(monkeypatch, tmp_path) == 1
    assert "MISMATCH" in capsys.readouterr().out


def test_a_local_wav_is_fitted_to_each_requested_target(monkeypatch, tmp_path, capsys, audio_tools):
    wav = tmp_path / "speech.wav"
    wav.write_bytes(make_wav(5.0))
    assert run_script(monkeypatch, tmp_path, "--wav", str(wav), "--target-seconds", "4") == 0
    assert (tmp_path / "out" / "speech-after-4s.mp3").is_file()
    assert run_script(monkeypatch, tmp_path, "--wav", str(wav)) == 2  # no target given


def test_live_mode_without_credentials_explains_and_makes_no_request(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)
    assert run_script(monkeypatch, tmp_path, "--azure") == 2
    assert "AZURE_SPEECH_KEY" in capsys.readouterr().out


def test_live_mode_sends_only_the_public_sample_once_per_voice(
    monkeypatch, tmp_path, capsys, audio_tools
):
    requests = []

    def fake_azure(request: httpx.Request) -> httpx.Response:
        text = ssml_text(request.content)
        requests.append(text)
        return httpx.Response(200, content=make_wav(len(text) / 15))

    monkeypatch.setenv("AZURE_SPEECH_KEY", KEY)
    monkeypatch.setenv("AZURE_SPEECH_REGION", "westus2")
    monkeypatch.setattr(
        duration_smoke,
        "AzureSpeechProvider",
        partial(duration_smoke.AzureSpeechProvider, transport=httpx.MockTransport(fake_azure)),
    )

    assert run_script(monkeypatch, tmp_path, "--azure") == 0

    assert requests == [azure_speech_smoke.SAMPLE] * 2
    output = capsys.readouterr().out
    assert "2 Azure Speech requests" in output
    assert KEY not in output
    names = sorted(path.name for path in (tmp_path / "out").iterdir())
    assert len(names) == 2 * (2 + 2)  # per voice: before (mp3, wav) and two after files
    assert all("before" in n or "after" in n for n in names)
