"""AzureSpeechProvider with fake HTTP (no Azure, no credentials) and real ffmpeg/ffprobe."""

import logging
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from app.audio.ffmpeg import AudioTools, probe_mp3
from app.processing_errors import ProcessingError
from app.speech import azure
from app.speech.azure import AzureSpeechProvider
from app.speech.chunker import split_for_speech
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.translation.glossary import default_glossary
from tests.audio_helpers import make_wav, wav_samples

KEY = "speech-test-key-0123456789abcdef"
NS = {"s": "http://www.w3.org/2001/10/synthesis"}
TEXT = "\n".join(
    f"Câu số {i} nói về neural network và Spring Boot, loss function & JSON <tag>."
    for i in range(12)
)
CHUNK_LIMIT = 200


def ssml_text(request: httpx.Request) -> str:
    return ET.fromstring(request.content).find("s:voice", NS).text


def speaking(request: httpx.Request) -> httpx.Response:
    """Audio whose length follows the text, like a real voice (about 15 characters/second)."""
    return httpx.Response(200, content=make_wav(len(ssml_text(request)) / 15))


class CountingLimiter(RequestRateLimiter):
    def __init__(self) -> None:
        super().__init__(1000, 1)
        self.acquired = 0

    def acquire(self) -> None:
        super().acquire()
        self.acquired += 1


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "work"
    directory.mkdir()
    return directory


@pytest.fixture
def make_provider(audio_tools: AudioTools):
    def factory(
        handler: Callable[[httpx.Request], httpx.Response] = speaking,
        *,
        limiter: RequestRateLimiter | None = None,
        tools: AudioTools = audio_tools,
        max_chunk_chars: int = CHUNK_LIMIT,
    ) -> tuple[AzureSpeechProvider, list[httpx.Request]]:
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

        provider = AzureSpeechProvider(
            key=SecretStr(KEY),
            region="westus2",
            glossary=default_glossary(),
            tools=tools,
            limiter=limiter or RequestRateLimiter(1000, 1),
            timeout_seconds=30,
            max_chunk_chars=max_chunk_chars,
            transport=httpx.MockTransport(recording),
        )
        return provider, calls

    return factory


def failing_with(code: str, provider: AzureSpeechProvider, work_dir: Path, text: str = TEXT):
    with pytest.raises(ProcessingError) as error:
        provider.synthesize(text, Voice.HOAI_MY, work_dir)
    assert error.value.code == code
    assert KEY not in error.value.user_message
    assert list(work_dir.iterdir()) == []  # no partial audio, no leftover temporary files
    return error.value


# --- request ------------------------------------------------------------------------------------


def test_request_url_headers_and_voice(make_provider, work_dir):
    provider, calls = make_provider()
    provider.synthesize("Xin chào neural network.", Voice.NAM_MINH, work_dir)

    (request,) = calls
    assert request.method == "POST"
    assert str(request.url) == "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1"
    assert request.headers["Ocp-Apim-Subscription-Key"] == KEY
    assert request.headers["Content-Type"] == "application/ssml+xml"
    assert request.headers["X-Microsoft-OutputFormat"] == "riff-24khz-16bit-mono-pcm"
    assert request.headers["User-Agent"] == "MyDubb"
    assert "Authorization" not in request.headers
    voice = ET.fromstring(request.content).find("s:voice", NS)
    assert voice.get("name") == "vi-VN-NamMinhNeural"
    assert voice.text == "Xin chào neural network."


def test_the_other_voice_uses_its_own_name(make_provider, work_dir):
    provider, calls = make_provider()
    provider.synthesize("Xin chào.", Voice.HOAI_MY, work_dir)
    assert ET.fromstring(calls[0].content).find("s:voice", NS).get("name") == "vi-VN-HoaiMyNeural"


def test_text_is_escaped_and_cannot_add_markup(make_provider, work_dir):
    hostile = '</voice><audio src="https://evil.example/a.mp3"/> a & b < c neural network'
    provider, calls = make_provider()
    provider.synthesize(hostile, Voice.HOAI_MY, work_dir)
    root = ET.fromstring(calls[0].content)
    assert [child.tag.split("}")[1] for child in root] == ["voice"]
    assert root.find("s:voice", NS).text == hostile


def test_redirects_are_not_followed_so_the_key_never_goes_elsewhere(make_provider, work_dir):
    provider, calls = make_provider(
        lambda request: httpx.Response(302, headers={"Location": "https://evil.example/steal"})
    )
    failing_with("speech_service_error", provider, work_dir)
    assert [c.url.host for c in calls] == ["westus2.tts.speech.microsoft.com"]


# --- chunking, order and assembly -----------------------------------------------------------------


def test_long_text_is_sent_in_ordered_chunks_without_losing_or_repeating_text(
    make_provider, work_dir
):
    served: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        response = speaking(request)
        served.append(response.content)
        return response

    limiter = CountingLimiter()
    provider, calls = make_provider(handler, limiter=limiter)
    audio = provider.synthesize(TEXT, Voice.HOAI_MY, work_dir)

    sent = [ssml_text(c) for c in calls]
    assert len(sent) > 3
    assert all(len(chunk) <= CHUNK_LIMIT for chunk in sent)
    assert sent == split_for_speech(TEXT, default_glossary(), CHUNK_LIMIT)
    assert " ".join(sent).split() == TEXT.split()
    assert limiter.acquired == len(calls)  # every request went through the shared limiter

    # The joined audio holds exactly the chunks' samples, in request order.
    chunk_samples = []
    for index, content in enumerate(served):
        path = work_dir.parent / f"served-{index}.wav"
        path.write_bytes(content)
        chunk_samples.append(wav_samples(path))
    assert audio.lossless_path is not None
    assert wav_samples(audio.lossless_path) == b"".join(chunk_samples)


def test_the_result_is_a_valid_mp3_and_only_the_final_files_remain(
    make_provider, work_dir, audio_tools
):
    provider, calls = make_provider()
    audio = provider.synthesize(TEXT, Voice.NAM_MINH, work_dir)

    assert audio.is_fixture is False
    assert audio.path == work_dir / "speech.mp3"
    assert audio.lossless_path == work_dir / "speech.wav"
    total_chars = sum(len(ssml_text(c)) for c in calls)
    assert probe_mp3(audio_tools, audio.path) == pytest.approx(total_chars / 15, abs=0.5)
    assert sorted(p.name for p in work_dir.iterdir()) == ["speech.mp3", "speech.wav"]


def test_only_punctuation_has_nothing_to_speak_and_makes_no_request(make_provider, work_dir):
    provider, calls = make_provider()
    failing_with("speech_no_speakable_text", provider, work_dir, text="... --- !!!")
    failing_with("speech_no_speakable_text", provider, work_dir, text="  \n ")
    assert calls == []


def test_unsplittable_text_fails_before_any_request(make_provider, work_dir):
    provider, calls = make_provider()
    failing_with("speech_input_unsupported", provider, work_dir, text="a" * 500)
    assert calls == []


# --- provider errors: no retry, no fallback, no partial result ------------------------------------


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "speech_rejected"),
        (401, "speech_auth_failed"),
        (403, "speech_auth_failed"),
        (415, "speech_rejected"),
        (429, "speech_quota_exceeded"),
        (408, "speech_timeout"),
        (500, "speech_service_error"),
        (502, "speech_service_error"),
        (503, "speech_service_error"),
    ],
)
def test_http_errors_map_to_safe_codes_without_retry(make_provider, work_dir, status, code):
    provider, calls = make_provider(
        lambda request: httpx.Response(status, text=f"secret detail {KEY} " + ssml_text(request))
    )
    error = failing_with(code, provider, work_dir)
    assert len(calls) == 1
    assert "secret detail" not in error.user_message


@pytest.mark.parametrize(
    ("exception", "code"),
    [
        (httpx.ReadTimeout("slow"), "speech_timeout"),
        (httpx.ConnectTimeout("slow"), "speech_timeout"),
        (httpx.ConnectError("down"), "speech_network_error"),
        (httpx.ReadError("reset"), "speech_network_error"),
        (httpx.DecodingError("bad"), "speech_service_error"),
    ],
)
def test_network_failures_map_to_safe_codes_without_retry(make_provider, work_dir, exception, code):
    def failing(request: httpx.Request) -> httpx.Response:
        raise exception

    provider, calls = make_provider(failing)
    failing_with(code, provider, work_dir)
    assert len(calls) == 1


def test_one_failed_chunk_fails_the_job_and_stops_with_no_partial_audio(make_provider, work_dir):
    def second_fails(request: httpx.Request) -> httpx.Response:
        if len(calls) == 2:
            return httpx.Response(429)
        return speaking(request)

    provider, calls = make_provider(second_fails)
    failing_with("speech_quota_exceeded", provider, work_dir)
    assert len(calls) == 2  # chunk 1 was fine, chunk 2 failed, nothing else was sent


# --- audio that cannot be trusted ---------------------------------------------------------------


@pytest.mark.parametrize(
    "response",
    [
        lambda request: httpx.Response(200, content=b""),
        lambda request: httpx.Response(200, content=b"<html>not audio</html>"),
        lambda request: httpx.Response(200, content=b"ID3\x04" + b"\x00" * 200),  # MP3, not WAV
        lambda request: httpx.Response(200, content=speaking(request).content[:5000]),  # cut off
        lambda request: httpx.Response(200, content=make_wav(5, rate=16000)),  # wrong format
        lambda request: httpx.Response(200, content=make_wav(0.1)),  # far too short for the text
    ],
    ids=["empty", "html", "mp3", "truncated", "wrong-format", "implausibly-short"],
)
def test_unusable_audio_fails_the_job(make_provider, work_dir, response):
    provider, calls = make_provider(response)
    failing_with("speech_invalid_audio", provider, work_dir)
    assert len(calls) == 1


def test_audio_that_reaches_the_service_limit_is_rejected_as_possibly_cut_off(
    make_provider, work_dir, monkeypatch
):
    # Azure cuts audio at 10 minutes and still answers 200: a chunk that long is not trusted.
    monkeypatch.setattr(azure, "SUSPECT_TRUNCATION_SECONDS", 2.0)
    provider, _ = make_provider(lambda request: httpx.Response(200, content=make_wav(3)))
    failing_with("speech_invalid_audio", provider, work_dir, text="Một câu ngắn.")


def test_an_oversized_response_is_rejected(make_provider, work_dir, monkeypatch):
    monkeypatch.setattr(azure, "MAX_RESPONSE_BYTES", 10_000)
    provider, _ = make_provider(lambda request: httpx.Response(200, content=make_wav(2)))
    failing_with("speech_invalid_audio", provider, work_dir, text="Một câu ngắn.")


def test_a_failing_ffmpeg_fails_the_job_and_cleans_up(make_provider, work_dir, audio_tools):
    broken = AudioTools(ffmpeg=str(work_dir / "no-such-ffmpeg"), ffprobe=audio_tools.ffprobe)
    provider, calls = make_provider(tools=broken)
    failing_with("speech_audio_failed", provider, work_dir)
    assert len(calls) > 1  # synthesis itself worked; the failure is in assembly


# --- cancellation, rate coordination, logging ------------------------------------------------


def test_a_closed_limiter_cancels_before_any_request(make_provider, work_dir):
    limiter = RequestRateLimiter(1000, 1)
    limiter.close()
    provider, calls = make_provider(limiter=limiter)
    failing_with("speech_cancelled", provider, work_dir)
    assert calls == []


def test_shutdown_while_waiting_between_chunks_stops_without_partial_audio(make_provider, work_dir):
    limiter = RequestRateLimiter(1000, 1)

    def close_after_first(request: httpx.Request) -> httpx.Response:
        limiter.close()
        return speaking(request)

    provider, calls = make_provider(close_after_first, limiter=limiter)
    failing_with("speech_cancelled", provider, work_dir)
    assert len(calls) == 1


def test_two_jobs_share_one_rate_limit(make_provider, work_dir, tmp_path):
    now = [0.0]
    waits: list[float] = []

    def wait(seconds: float) -> bool:
        waits.append(seconds)
        now[0] += seconds
        return False

    limiter = RequestRateLimiter(4, 60, clock=lambda: now[0], wait=wait)
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    first, first_calls = make_provider(limiter=limiter)
    second, second_calls = make_provider(limiter=limiter)
    first.synthesize(TEXT, Voice.HOAI_MY, work_dir)
    second.synthesize(TEXT, Voice.NAM_MINH, other_dir)

    total = len(first_calls) + len(second_calls)
    assert total > 4
    assert waits  # the second job was held back by what the first one already used


@pytest.mark.parametrize("fail", [False, True])
def test_logs_contain_no_key_ssml_text_or_content(make_provider, work_dir, caplog, fail):
    caplog.set_level(logging.DEBUG)
    secret_text = "Bí mật riêng tư xyz-12345 về neural network."

    def handler(request: httpx.Request) -> httpx.Response:
        if fail:
            return httpx.Response(429, text="body with xyz-12345", headers={"X-RequestId": "abc-1"})
        return speaking(request)

    provider, _ = make_provider(handler)
    try:
        provider.synthesize(secret_text, Voice.HOAI_MY, work_dir)
    except ProcessingError:
        assert fail
    logged = caplog.text
    for forbidden in (KEY, "xyz-12345", "Bí mật", "<speak", "neural network"):
        assert forbidden not in logged
    assert "Azure Speech" in logged  # sizes/status are logged
