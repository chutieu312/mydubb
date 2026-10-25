"""Timed mode through the API: validation, the job flow and the result (fake Azure, real FFmpeg)."""

import array
import json
import subprocess
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.audio.ffmpeg import AudioTools
from app.config import Settings
from app.main import create_app
from app.services import build_services
from app.speech.blocks import BREAK_MS
from tests.audio_helpers import RATE, tone_samples, wav_bytes
from tests.conftest import create_job, login, wait_for_terminal

YOUTUBE = """0:00
Generally, if if somebody's trying to
0:01
make a company work, they should expect
0:03
to grind super hard. Uh except that
0:05
there's like some meaningful chance of
0:06
failure. I could not make a spaceship by
0:08
myself, but but uh with a collection of
0:11
humans, uh we can make spaceships. It's"""
ELEVEN_SECONDS = {"first_sentence_start": "00:00:00", "last_sentence_start": "00:00:11"}
NS = "{http://www.w3.org/2001/10/synthesis}"


def timed_job(client: TestClient, csrf: str, **overrides):
    body = {"transcript": YOUTUBE, "timing_mode": "timed", **ELEVEN_SECONDS, **overrides}
    return create_job(client, csrf, **body)


# --- validation and the mock flow ----------------------------------------------------------------


def test_a_timed_job_runs_with_mock_providers(client: TestClient) -> None:
    csrf = login(client)
    response = timed_job(client, csrf)
    assert response.status_code == 202, response.text
    job = wait_for_terminal(client, response.json()["id"])
    assert job["status"] == "completed"
    assert job["baseline_duration_seconds"] == 11
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    timing = result["timing"]
    assert timing["mode"] == "timed"
    assert (timing["captions"], timing["blocks"]) == (7, 3)
    assert (timing["source_first_seconds"], timing["source_last_seconds"]) == (0, 11)
    assert timing["selected_baseline_seconds"] == 11
    assert timing["frames"] is None  # mock audio places nothing on a timeline
    # One translated line per block (the mock marks its text as illustrative).
    lines = result["translation"]["text"].split("\n")[1:]
    assert len(lines) == 3
    assert lines[1] == "(VI mock) Uh except that there's like some meaningful chance of failure."
    assert any("not exact sentence-by-sentence" in notice for notice in result["notices"])


def test_plain_mode_is_the_default_and_unchanged(client: TestClient) -> None:
    csrf = login(client)
    job = wait_for_terminal(
        client, create_job(client, csrf, transcript=YOUTUBE, **ELEVEN_SECONDS).json()["id"]
    )
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    assert result["timing"] is None
    # Plain cleaning removes the timestamps and keeps the caption lines as they were.
    assert "(VI mock) Generally, if if somebody's trying to" in result["translation"]["text"]
    assert not any("caption times" in notice for notice in result["notices"])


@pytest.mark.parametrize(
    ("transcript", "reason"),
    [
        ("Just plain text.", "no timestamps on their own lines"),
        ("0:00\nA.\n0:05\nB.\n0:03\nC.", "go backwards"),
        ("0:00\nA.\n0:75\nB.", "not a valid timestamp"),
        ("0:04\nA.\n0:04\nB.", "no time span"),
        ("Intro\n0:00\nA.\n0:05\nB.", "before the first timestamp"),
    ],
)
def test_a_transcript_that_cannot_be_timed_is_rejected_not_processed_as_plain(
    client: TestClient, transcript: str, reason: str
) -> None:
    csrf = login(client)
    response = timed_job(client, csrf, transcript=transcript)
    assert response.status_code == 422
    fields = response.json()["error"]["fields"]
    assert fields[0]["field"] == "transcript"
    assert reason in fields[0]["message"]


def test_an_unknown_timing_mode_is_rejected(client: TestClient) -> None:
    csrf = login(client)
    response = timed_job(client, csrf, timing_mode="auto")
    assert response.status_code == 422
    assert response.json()["error"]["fields"][0]["field"] == "timing_mode"


def test_the_time_fields_are_still_validated_in_timed_mode(client: TestClient) -> None:
    csrf = login(client)
    response = timed_job(client, csrf, last_sentence_start="00:00:00")
    assert response.status_code == 422
    assert response.json()["error"]["fields"][0]["field"] == "last_sentence_start"


# --- fake Azure and real FFmpeg ------------------------------------------------------------------

SPEECH = {
    "speech_provider": "azure",
    "azure_speech_key": "speech-key-0123456789abcdef-different",
    "azure_speech_region": "westus2",
    "audio_processor": "ffmpeg",
    "translation_provider": "azure",
    "azure_translator_key": "translator-key-0123456789abcdef",
    "provider_mode": "azure",
}


def echo_translation(request: httpx.Request) -> httpx.Response:
    items = json.loads(request.content)
    return httpx.Response(
        200, json=[{"translations": [{"text": i["Text"], "to": "vi"}]} for i in items]
    )


def silence(seconds: float, noise: int = 0) -> array.array:
    samples = array.array("h", bytes(int(seconds * RATE) * 2))
    for index in range(0, len(samples), RATE // 20):
        samples[index] = noise
    return samples


def break_voice(*, breaks: bool = True) -> Callable[[httpx.Request], httpx.Response]:
    """Reads the text between <break/> elements at 15 characters per second, one pitch each."""

    def respond(request: httpx.Request) -> httpx.Response:
        voice = ET.fromstring(request.content).find(f"{NS}voice")
        pieces = [""]
        for child in voice:
            if child.tag == f"{NS}break":
                pieces.append("")
            else:
                pieces[-1] += child.text or ""
        samples = silence(0.05)
        for number, piece in enumerate(pieces):
            if number:
                samples.extend(silence(BREAK_MS / 1000 if breaks else 0.3, 60))
            samples.extend(tone_samples(len(piece) / 15, 300 + 150 * number))
        samples.extend(silence(0.3))
        return httpx.Response(200, content=wav_bytes(samples))

    return respond


@pytest.fixture
def azure_client(
    make_settings: Callable[..., Settings], db_engine, audio_tools: AudioTools
) -> Iterator[Callable[..., tuple[TestClient, list]]]:
    clients: list[TestClient] = []

    def factory(speech_handler=None) -> tuple[TestClient, list]:
        calls: list[httpx.Request] = []
        handler = speech_handler or break_voice()

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        services = build_services(
            make_settings(**SPEECH),
            translation_transport=httpx.MockTransport(echo_translation),
            speech_transport=httpx.MockTransport(recording),
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def decoded_samples(audio_tools: AudioTools, mp3: bytes, tmp_path) -> int:
    source = tmp_path / "downloaded.mp3"
    source.write_bytes(mp3)
    pcm = tmp_path / "downloaded.s16le"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(source), "-f", "s16le", str(pcm)],
        check=True,
        capture_output=True,
    )
    return pcm.stat().st_size // 2


@pytest.mark.parametrize(
    ("speed", "target_samples"), [(1, 264_000), (1.25, 211_200), (1.5, 176_000), (1.75, 150_857)]
)
def test_a_timed_job_places_the_blocks_and_hits_the_target(
    azure_client, audio_tools, tmp_path, speed: float, target_samples: int
) -> None:
    client, calls = azure_client()
    csrf = login(client)
    job = wait_for_terminal(client, timed_job(client, csrf, speed=speed).json()["id"], 60)
    assert job["status"] == "completed", job
    assert len(calls) == 1  # all three blocks in one speech request
    assert calls[0].content.count(b"<break") == 2
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    duration = result["audio"]["duration"]
    assert duration["target_samples"] == target_samples
    assert duration["mp3_decoded_samples"] == target_samples
    assert abs(duration["mp3_header_samples"] - target_samples) <= 1
    timing = result["timing"]
    assert timing["blocks"] == 3 and timing["speech_requests"] == 1
    assert timing["frames"] >= 2  # never one frame for the whole transcript
    details = timing["frame_details"]
    assert details[0]["start_seconds"] == 0
    assert sum(f["frame_seconds"] for f in details) == pytest.approx(target_samples / RATE)
    assert [f["first_block"] for f in details] == sorted(f["first_block"] for f in details)
    assert result["translation"]["text"].count("\n") == 2
    downloaded = client.get(result["audio"]["download_url"]).content
    assert decoded_samples(audio_tools, downloaded, tmp_path) == target_samples


def test_edited_time_fields_rescale_the_caption_timeline(azure_client) -> None:
    client, _ = azure_client()
    csrf = login(client)
    response = timed_job(client, csrf, last_sentence_start="00:00:22")
    job = wait_for_terminal(client, response.json()["id"], 60)
    assert job["status"] == "completed", job
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    timing = result["timing"]
    assert timing["source_baseline_seconds"] == 11
    assert timing["selected_baseline_seconds"] == 22
    assert result["audio"]["duration"]["target_samples"] == 22 * RATE
    starts = [f["start_seconds"] for f in timing["frame_details"]]
    assert starts[1] == pytest.approx(198_857 / RATE)  # 29/77 of 22 s, not of 11 s


def test_a_block_mapping_check_failure_fails_the_job_without_plain_fallback(azure_client) -> None:
    client, calls = azure_client(break_voice(breaks=False))
    csrf = login(client)
    job = wait_for_terminal(client, timed_job(client, csrf).json()["id"], 60)
    assert job["status"] == "failed"
    assert job["error"]["code"] == "speech_block_split_failed"
    assert len(calls) == 1  # not retried, not synthesized as plain text
    result = client.get(f"/api/jobs/{job['id']}/result")
    assert result.status_code == 409
