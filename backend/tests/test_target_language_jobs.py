"""The job's output language through the API: validation, storage, old data, providers, guests.

Mock providers and fake Azure transports only. Tests that run real speech audio need FFmpeg (they
skip without it locally; CI has it).
"""

import json
from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings
from app.main import create_app
from app.services import build_services
from app.translation.notranslate_markup import CLOSE_TAG, OPEN_TAG
from tests.audio_helpers import RATE, make_wav, ssml_spans, ssml_voice
from tests.conftest import create_job, login, sign_in, wait_for_terminal
from tests.test_guest_access import GUEST_SETTINGS, guest_job, quota, start_guest
from tests.test_timed_jobs import ELEVEN_SECONDS, SPEECH, YOUTUBE, break_voice, decoded_samples

MANDARIN = "mandarin_simplified"
SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]


def field_errors(response) -> dict[str, str]:
    assert response.status_code == 422, response.text
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    return {f["field"]: f["message"] for f in body["fields"]}


def stored_language(db_engine, job_id: str) -> str:
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT target_language FROM jobs WHERE id = :id"), {"id": job_id}
        ).scalar_one()


def job_count(db_engine) -> int:
    with db_engine.connect() as conn:
        return conn.execute(text("SELECT count(*) FROM jobs")).scalar_one()


# --- defaults, validation, metadata (mock providers) ------------------------------------------


def test_meta_lists_the_languages_and_the_vietnamese_default(client) -> None:
    meta = client.get("/api/meta").json()
    assert meta["default_target_language"] == "vietnamese"
    assert [(item["id"], item["label"]) for item in meta["target_languages"]] == [
        ("vietnamese", "Vietnamese"),
        (MANDARIN, "Chinese — Mandarin (Simplified)"),
    ]
    mandarin = meta["target_languages"][1]
    assert (mandarin["translator_language"], mandarin["speech_locale"]) == ("zh-Hans", "zh-CN")


def test_a_request_without_a_language_is_vietnamese_as_before(client, db_engine) -> None:
    csrf = login(client)
    created = create_job(client, csrf)
    assert created.status_code == 202
    body = created.json()
    assert (body["target_language"], body["target_language_label"]) == ("vietnamese", "Vietnamese")
    assert stored_language(db_engine, body["id"]) == "vietnamese"
    assert wait_for_terminal(client, body["id"])["status"] == "completed"
    result = client.get(f"/api/jobs/{body['id']}/result").json()
    assert result["target_language"] == "vietnamese"
    assert result["translation"]["text"].startswith(
        "[Development mock mode - illustrative content, NOT a real Vietnamese translation]"
    )
    assert (
        "The Vietnamese text is illustrative mock content, not a real translation."
        in (result["notices"])
    )


def test_a_mandarin_job_is_stored_and_reported_with_mandarin_mock_text(client, db_engine) -> None:
    csrf = login(client)
    body = create_job(client, csrf, target_language=MANDARIN).json()
    assert body["target_language"] == MANDARIN
    assert body["target_language_label"] == "Chinese — Mandarin (Simplified)"
    assert stored_language(db_engine, body["id"]) == MANDARIN
    assert wait_for_terminal(client, body["id"])["status"] == "completed"
    result = client.get(f"/api/jobs/{body['id']}/result").json()
    assert result["target_language"] == MANDARIN
    translation = result["translation"]["text"]
    assert "Mandarin Chinese" in translation and "Vietnamese" not in translation
    assert "(VI mock)" not in translation
    notices = " ".join(result["notices"])
    assert "The Mandarin Chinese text is illustrative mock content" in notices
    assert "Vietnamese" not in notices


@pytest.mark.parametrize(
    "value",
    [
        "zh-Hans",  # a Translator code is not an API value
        "zh-CN",  # nor a speech locale
        "vi",
        "vi-VN",
        "Vietnamese",
        "mandarin",
        "cantonese",
        "mandarin_traditional",
        "",
        None,
        1,
        True,
        ["vietnamese"],
        {"id": MANDARIN},
    ],
)
def test_unsupported_languages_are_rejected_before_a_job_exists(client, db_engine, value) -> None:
    csrf = login(client)
    assert "target_language" in field_errors(create_job(client, csrf, target_language=value))
    assert job_count(db_engine) == 0


def test_the_database_refuses_an_unknown_language(client, db_engine) -> None:
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    with pytest.raises(Exception, match="target_language_valid"), db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET target_language = 'french' WHERE id = :id"), {"id": job_id}
        )


def test_jobs_keep_their_own_language(client) -> None:
    csrf = login(client)
    mandarin = create_job(client, csrf, target_language=MANDARIN).json()["id"]
    vietnamese = create_job(client, csrf, target_language="vietnamese").json()["id"]
    for job_id in (mandarin, vietnamese):
        assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert client.get(f"/api/jobs/{mandarin}").json()["target_language"] == MANDARIN
    assert client.get(f"/api/jobs/{mandarin}/result").json()["target_language"] == MANDARIN
    assert client.get(f"/api/jobs/{vietnamese}/result").json()["target_language"] == "vietnamese"


def test_a_job_row_written_before_the_option_existed_reads_as_vietnamese(client, db_engine) -> None:
    csrf = login(client)
    job_id = create_job(client, csrf, target_language=MANDARIN).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    with db_engine.begin() as conn:
        # What the previous release did: an INSERT without the new column.
        old_id = conn.execute(
            text(
                "INSERT INTO jobs (id, session_id, status, voice, first_sentence_start_seconds,"
                " last_sentence_start_seconds, target_duration_seconds, transcript_char_count,"
                " translation_provider, speech_provider, audio_processor, created_at, updated_at)"
                " SELECT gen_random_uuid(), session_id, 'completed', 'AndrewMultilingual', 10, 370,"
                " 360, 5, 'mock-translation', 'mock-speech', 'mock-audio', now(), now()"
                " FROM jobs WHERE id = :id RETURNING id"
            ),
            {"id": job_id},
        ).scalar_one()
    body = client.get(f"/api/jobs/{old_id}").json()
    assert (body["target_language"], body["target_language_label"]) == ("vietnamese", "Vietnamese")


# --- Azure Translator (fake) with mock speech ------------------------------------------------


def chinese(code: str = "zh-Hans") -> Callable[[httpx.Request], httpx.Response]:
    """A fake Translator: Han text around the untouched no-translate spans, answering `code`."""

    def handler(request: httpx.Request) -> httpx.Response:
        out = []
        for item in json.loads(request.content):
            spans = [
                f"{OPEN_TAG}{p.split(CLOSE_TAG)[0]}{CLOSE_TAG}"
                for p in item["Text"].split(OPEN_TAG)[1:]
            ]
            words = max(3, len(item["Text"].split()))
            translated = "这是" + "和".join(spans) + "翻译" * words + "。"
            out.append({"translations": [{"text": translated, "to": code}]})
        return httpx.Response(200, json=out)

    return handler


def vietnamese(request: httpx.Request) -> httpx.Response:
    items = json.loads(request.content)
    return httpx.Response(
        200, json=[{"translations": [{"text": "Dịch: " + i["Text"], "to": "vi"}]} for i in items]
    )


@pytest.fixture
def translator_client(
    make_settings: Callable[..., Settings], db_engine
) -> Iterator[Callable[..., tuple[TestClient, list[httpx.Request]]]]:
    clients: list[TestClient] = []

    def factory(handler=None, **overrides):
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return (handler or chinese())(request)

        settings = make_settings(
            translation_provider="azure", azure_translator_key="k" * 32, **overrides
        )
        services = build_services(settings, translation_transport=httpx.MockTransport(recording))
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, calls

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def test_a_mandarin_job_asks_azure_for_zh_hans_and_shows_the_chinese_translation(
    translator_client,
) -> None:
    client, calls = translator_client()
    csrf = login(client)
    job_id = create_job(client, csrf, target_language=MANDARIN).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert [call.url.params["to"] for call in calls] == ["zh-Hans"]
    result = client.get(f"/api/jobs/{job_id}/result").json()
    assert result["translation"]["is_illustrative"] is False
    # The glossary terms of the source are kept, inside the Chinese text.
    assert result["translation"]["text"].startswith("这是Spring Boot和Dependency Injection翻译")


def test_the_client_cannot_choose_a_translator_code_locale_or_provider_voice(
    translator_client,
) -> None:
    client, calls = translator_client(handler=vietnamese)
    csrf = login(client)
    extra = {"translator_language": "fr", "speech_locale": "fr-FR", "to": "fr"}
    job_id = create_job(client, csrf, **extra).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert calls[0].url.params["to"] == "vi"  # extra fields are ignored, never forwarded
    raw_voice = create_job(client, csrf, voice="en-US-AndrewMultilingualNeural")
    assert "voice" in field_errors(raw_voice)


def test_a_failed_mandarin_translation_fails_the_job_without_retry_or_vietnamese_fallback(
    translator_client,
) -> None:
    client, calls = translator_client(handler=lambda _: httpx.Response(500))
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, target_language=MANDARIN).json()["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "translation_service_error"
    assert job["target_language"] == MANDARIN
    assert [call.url.params["to"] for call in calls] == ["zh-Hans"]  # once, never "vi"


def test_a_vietnamese_answer_to_a_mandarin_job_is_not_used(translator_client) -> None:
    client, calls = translator_client(handler=chinese(code="vi"))
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, target_language=MANDARIN).json()["id"])
    assert job["status"] == "failed"
    assert job["error"]["code"] == "translation_invalid_response"
    assert len(calls) == 1


# --- guests and invitation accounts (mock providers) -------------------------------------------


@pytest.fixture
def guest_client(make_cognito_client) -> TestClient:
    return make_cognito_client(**GUEST_SETTINGS)


def test_a_guest_can_choose_mandarin_and_a_job_counts_once_whatever_its_language(
    guest_client, db_engine
) -> None:
    csrf = start_guest(guest_client)["csrf_token"]
    before = quota(guest_client)["session_remaining"]
    for language in (MANDARIN, "vietnamese"):
        response = guest_job(guest_client, csrf, target_language=language)
        assert response.status_code == 202, response.text
        assert wait_for_terminal(guest_client, response.json()["id"])["status"] == "completed"
        assert response.json()["target_language"] == language
    assert quota(guest_client)["session_remaining"] == before - 2


def test_a_guest_language_is_validated_before_any_quota_is_used(guest_client, db_engine) -> None:
    csrf = start_guest(guest_client)["csrf_token"]
    before = quota(guest_client)["session_remaining"]
    assert "target_language" in field_errors(guest_job(guest_client, csrf, target_language="zh-CN"))
    assert quota(guest_client)["session_remaining"] == before
    assert job_count(db_engine) == 0


def test_an_invited_account_can_choose_mandarin(make_cognito_client, fake_cognito) -> None:
    client = make_cognito_client()
    fake_cognito.add_user("lan@example.com", "correct-horse-1")
    csrf = sign_in(client, "lan@example.com", "correct-horse-1")["csrf_token"]
    job_id = create_job(client, csrf, target_language=MANDARIN).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert client.get(f"/api/jobs/{job_id}/result").json()["target_language"] == MANDARIN


# --- real speech audio: fake Azure, real FFmpeg ------------------------------------------------


def speaking(request: httpx.Request) -> httpx.Response:
    voice = ssml_voice(request.content)
    return httpx.Response(200, content=make_wav(len("".join(voice.itertext())) / 5))


@pytest.fixture
def audio_client(
    make_settings: Callable[..., Settings], db_engine, audio_tools
) -> Iterator[Callable[..., tuple[TestClient, list, list]]]:
    clients: list[TestClient] = []

    def factory(*, translate=None, speech=None, **overrides):
        translations: list[httpx.Request] = []
        speeches: list[httpx.Request] = []

        def translate_recording(request: httpx.Request) -> httpx.Response:
            translations.append(request)
            return (translate or chinese())(request)

        def speech_recording(request: httpx.Request) -> httpx.Response:
            speeches.append(request)
            return (speech or speaking)(request)

        services = build_services(
            make_settings(**{**SPEECH, **overrides}),
            translation_transport=httpx.MockTransport(translate_recording),
            speech_transport=httpx.MockTransport(speech_recording),
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client, translations, speeches

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


@pytest.mark.parametrize("speed", SPEEDS)
@pytest.mark.parametrize("voice", ["AndrewMultilingual", "EmmaMultilingual"])
def test_a_plain_mandarin_job_reads_zh_cn_with_one_voice_and_hits_the_target(
    audio_client, voice: str, speed: float
) -> None:
    client, translations, speeches = audio_client()
    csrf = login(client)
    body = {"target_language": MANDARIN, "voice": voice, "speed": speed}
    job = wait_for_terminal(client, create_job(client, csrf, **body).json()["id"], 60)
    assert job["status"] == "completed", job
    assert [call.url.params["to"] for call in translations] == ["zh-Hans"]
    for request in speeches:
        voices = [ssml_voice(request.content).get("name")]
        assert voices == [f"en-US-{voice}Neural"]
        languages = {language for language, _ in ssml_spans(request.content)}
        assert languages <= {"zh-CN", "en-US"} and "zh-CN" in languages
    english = [t for r in speeches for lang, t in ssml_spans(r.content) if lang == "en-US"]
    assert english == ["Spring Boot", "Dependency Injection"]
    duration = client.get(f"/api/jobs/{job['id']}/result").json()["audio"]["duration"]
    expected = round(360 * RATE / speed)
    assert duration["target_samples"] == expected
    assert duration["mp3_decoded_samples"] == expected


@pytest.mark.parametrize("voice", ["AndrewMultilingual", "EmmaMultilingual"])
def test_a_plain_vietnamese_job_still_reads_vi_vn_with_the_same_voices(audio_client, voice) -> None:
    client, translations, speeches = audio_client(translate=real_vietnamese)
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, voice=voice).json()["id"], 60)
    assert job["status"] == "completed", job
    assert [call.url.params["to"] for call in translations] == ["vi"]
    [request] = speeches
    assert ssml_voice(request.content).get("name") == f"en-US-{voice}Neural"
    assert ssml_spans(request.content) == [
        ("en-US", "Spring Boot"),
        ("vi-VN", " dùng "),
        ("en-US", "Dependency Injection"),
        ("vi-VN", " để tự động quản lý các đối tượng."),
    ]


def real_vietnamese(request: httpx.Request) -> httpx.Response:
    """Vietnamese around the untouched no-translate spans, as Azure answers for VALID_JOB."""
    out = []
    for item in json.loads(request.content):
        t = [
            f"{OPEN_TAG}{p.split(CLOSE_TAG)[0]}{CLOSE_TAG}"
            for p in item["Text"].split(OPEN_TAG)[1:]
        ]
        text = f"{t[0]} dùng {t[1]} để tự động quản lý các đối tượng."
        out.append({"translations": [{"text": text, "to": "vi"}]})
    return httpx.Response(200, json=out)


IMPORTED = """0:00.160
A neural network uses gradient descent.
0:03.480
We deploy it with Kubernetes and a REST API.
0:07.250
Then we measure the loss function.
0:11.000
Thanks."""


@pytest.mark.parametrize("speed", SPEEDS)
def test_a_timed_mandarin_job_follows_the_captions_and_hits_the_target(
    audio_client, audio_tools, tmp_path, speed: float
) -> None:
    client, translations, speeches = audio_client(speech=break_voice())
    csrf = login(client)
    body = {
        "transcript": IMPORTED,
        "timing_mode": "timed",
        "target_language": MANDARIN,
        "speed": speed,
        **ELEVEN_SECONDS,
    }
    job = wait_for_terminal(client, create_job(client, csrf, **body).json()["id"], 60)
    assert job["status"] == "completed", job
    assert [call.url.params["to"] for call in translations] == ["zh-Hans"]
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    timing = result["timing"]
    # The baseline comes from the first and last caption, to the millisecond.
    assert timing["source_first_seconds"] == 0.16 and timing["source_last_seconds"] == 11.0
    assert timing["source_baseline_seconds"] == pytest.approx(10.84)
    assert timing["blocks"] == len(result["translation"]["text"].split("\n")) == 3
    assert timing["frames"] >= 2
    # One voice per request; its text is zh-CN with English terms in en-US (breaks carry no text).
    for request in speeches:
        assert ssml_voice(request.content).get("name") == "en-US-AndrewMultilingualNeural"
        spans = [(lang, t) for lang, t in ssml_spans(request.content) if lang is not None]
        assert {lang for lang, _ in spans} == {"zh-CN", "en-US"}
    expected = round(11 * RATE / speed)
    assert result["audio"]["duration"]["target_samples"] == expected
    downloaded = client.get(result["audio"]["download_url"]).content
    assert decoded_samples(audio_tools, downloaded, tmp_path) == expected


def test_a_timed_mandarin_job_with_paste_captions_runs(audio_client) -> None:
    client, _, _ = audio_client(speech=break_voice())
    csrf = login(client)
    body = {"transcript": YOUTUBE, "timing_mode": "timed", "target_language": MANDARIN}
    job = wait_for_terminal(
        client, create_job(client, csrf, **body, **ELEVEN_SECONDS).json()["id"], 60
    )
    assert job["status"] == "completed", job
