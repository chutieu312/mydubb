"""The six added output languages through the API: metadata, validation, storage, migration,
Translator, speech audio, guests and invitation accounts.

Mock providers and fake Azure transports only. Tests that run real speech audio need FFmpeg (they
skip without it locally; CI has it). Vietnamese and Mandarin keep their own tests
(`test_target_language_jobs.py`); the regressions here only check they are unchanged next to the
new languages.
"""

import json
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from itertools import cycle

import httpx
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings
from app.main import create_app
from app.services import build_services
from app.translation.notranslate_markup import CLOSE_TAG, OPEN_TAG
from tests.audio_helpers import RATE, make_wav, ssml_spans, ssml_voice
from tests.conftest import alembic_config, create_job, login, sign_in, wait_for_terminal
from tests.test_guest_access import GUEST_SETTINGS, guest_job, quota, start_guest
from tests.test_target_language_jobs import field_errors, job_count, stored_language
from tests.test_timed_jobs import ELEVEN_SECONDS, SPEECH, break_voice, decoded_samples

# id, label, noun, Translator code, Speech locale, direction
NEW = {
    "hindi": ("Hindi", "Hindi", "hi", "hi-IN", "ltr"),
    "spanish": ("Spanish (Spain)", "Spanish", "es", "es-ES", "ltr"),
    "arabic": ("Arabic (Modern Standard)", "Arabic", "ar", "ar-SA", "rtl"),
    "french": ("French (France)", "French", "fr", "fr-FR", "ltr"),
    "russian": ("Russian", "Russian", "ru", "ru-RU", "ltr"),
    "japanese": ("Japanese", "Japanese", "ja", "ja-JP", "ltr"),
}
LANGUAGES = list(NEW)
SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
VOICES = ["AndrewMultilingual", "EmmaMultilingual"]
# A word of each language, repeated by the fake Translator around the protected spans.
FILLER = {
    "hindi": "अनुवाद",
    "spanish": "traducción",
    "arabic": "ترجمة",
    "french": "traduction",
    "russian": "перевод",
    "japanese": "翻訳",
}


def code(language: str) -> str:
    return NEW[language][2]


def locale(language: str) -> str:
    return NEW[language][3]


# --- metadata, defaults, validation, storage (mock providers) -----------------------------------


def test_meta_lists_the_eight_languages_in_order_with_vietnamese_the_default(client) -> None:
    meta = client.get("/api/meta").json()
    assert meta["default_target_language"] == "vietnamese"
    items = meta["target_languages"]
    assert [item["id"] for item in items] == ["vietnamese", "mandarin_simplified", *LANGUAGES]
    for item in items[2:]:
        expected = NEW[item["id"]]
        assert (
            item["label"],
            item["noun"],
            item["translator_language"],
            item["speech_locale"],
            item["text_direction"],
        ) == expected
    assert [item["text_direction"] for item in items[:2]] == ["ltr", "ltr"]


def test_a_request_without_a_language_is_still_vietnamese(client, db_engine) -> None:
    csrf = login(client)
    body = create_job(client, csrf).json()
    assert body["target_language"] == "vietnamese"
    assert stored_language(db_engine, body["id"]) == "vietnamese"


@pytest.mark.parametrize("language", LANGUAGES)
def test_a_job_in_each_language_is_stored_and_reported_with_its_own_mock_text(
    client, db_engine, language: str
) -> None:
    label, noun = NEW[language][:2]
    csrf = login(client)
    body = create_job(client, csrf, target_language=language).json()
    assert (body["target_language"], body["target_language_label"]) == (language, label)
    assert stored_language(db_engine, body["id"]) == language
    assert wait_for_terminal(client, body["id"])["status"] == "completed"
    result = client.get(f"/api/jobs/{body['id']}/result").json()
    assert (result["target_language"], result["target_language_label"]) == (language, label)
    translation = result["translation"]["text"]
    assert f"NOT a real {noun} translation" in translation
    assert "Vietnamese" not in translation and "(VI mock)" not in translation
    notices = " ".join(result["notices"])
    assert f"The {noun} text is illustrative mock content" in notices
    assert "Vietnamese" not in notices


@pytest.mark.parametrize(
    "value",
    [
        *["hi", "es-ES", "ar-SA", "ar", "fr-FR", "ru", "ja-JP", "Spanish", "FRENCH"],
        *["arabic_egypt", "german", "spanish_mexico", "french_canada", " japanese", "hindi\n"],
    ],
)
def test_codes_locales_and_other_languages_are_rejected_before_a_job_exists(
    client, db_engine, value
) -> None:
    csrf = login(client)
    assert "target_language" in field_errors(create_job(client, csrf, target_language=value))
    assert job_count(db_engine) == 0


def test_the_database_admits_exactly_the_eight_languages(client, db_engine) -> None:
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    for language in ["vietnamese", "mandarin_simplified", *LANGUAGES]:
        with db_engine.begin() as conn:
            conn.execute(
                text("UPDATE jobs SET target_language = :l WHERE id = :id"),
                {"l": language, "id": job_id},
            )
    with pytest.raises(Exception, match="target_language_valid"), db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET target_language = 'german' WHERE id = :id"), {"id": job_id}
        )


def test_switching_languages_between_jobs_keeps_each_jobs_own(client) -> None:
    csrf = login(client)
    ids = {
        language: create_job(client, csrf, target_language=language).json()["id"]
        for language in ["arabic", "vietnamese", "japanese", "mandarin_simplified"]
    }
    for language, job_id in ids.items():
        assert wait_for_terminal(client, job_id)["status"] == "completed"
        assert client.get(f"/api/jobs/{job_id}").json()["target_language"] == language
        assert client.get(f"/api/jobs/{job_id}/result").json()["target_language"] == language


# --- migration 0010 -------------------------------------------------------------------------


def _insert_job(conn, language: str | None) -> uuid.UUID:
    job_id = uuid.uuid4()
    now = datetime.now(UTC)
    conn.execute(
        text(
            "INSERT INTO jobs (id, status, voice, first_sentence_start_seconds, "
            "last_sentence_start_seconds, target_duration_seconds, transcript_char_count, "
            "translation_provider, speech_provider, audio_processor, created_at, updated_at) "
            "VALUES (:id, 'completed', 'AndrewMultilingual', 10, 370, 360, 5, 'mock-translation', "
            "'mock-speech', 'mock-audio', :now, :now)"
        ),
        {"id": job_id, "now": now},
    )
    if language is not None:  # None: the column is left to its default, as older code does
        conn.execute(
            text("UPDATE jobs SET target_language = :language WHERE id = :id"),
            {"id": job_id, "language": language},
        )
    return job_id


def _languages(engine) -> dict[uuid.UUID, str]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, target_language FROM jobs")).all()
    return {row[0]: row[1] for row in rows}


def test_0010_keeps_old_rows_and_its_downgrade_refuses_while_a_new_language_is_stored(
    db_engine, database_url
) -> None:
    engine = db_engine  # starts from empty tables
    config = alembic_config(database_url)
    command.downgrade(config, "0009")
    try:
        with engine.begin() as conn:
            old = {
                _insert_job(conn, None): "vietnamese",  # written by code older than 0009
                _insert_job(conn, "mandarin_simplified"): "mandarin_simplified",
            }
            with pytest.raises(Exception, match="target_language_valid"), conn.begin_nested():
                _insert_job(conn, "hindi")  # 0009 does not know it
        command.upgrade(config, "0010")
        assert _languages(engine) == old
        with engine.begin() as conn:
            hindi = _insert_job(conn, "hindi")
        with pytest.raises(RuntimeError, match="downgrade refused"):
            command.downgrade(config, "0009")
        assert _languages(engine) == {**old, hindi: "hindi"}  # nothing rewritten
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM jobs WHERE id = :id"), {"id": hindi})
        command.downgrade(config, "0009")
        assert _languages(engine) == old
    finally:
        command.upgrade(config, "head")
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM jobs"))


# --- Azure Translator (fake) with mock speech ------------------------------------------------


def translated(language: str, answer_code: str | None = None):
    """A fake Translator: text of `language` around the untouched no-translate spans."""

    def handler(request: httpx.Request) -> httpx.Response:
        out = []
        word = FILLER[language]
        joiner = "" if language == "japanese" else " "
        for item in json.loads(request.content):
            spans = [
                f"{OPEN_TAG}{p.split(CLOSE_TAG)[0]}{CLOSE_TAG}"
                for p in item["Text"].split(OPEN_TAG)[1:]
            ]
            words = max(3, len(item["Text"].split()))
            # Japanese writes a particle between two terms (と); two terms glued with nothing
            # between them are one word to the glossary, a documented limit.
            terms = ("と" if language == "japanese" else " ").join(spans)
            body = joiner.join([terms, *[word] * words])
            end = "。" if language == "japanese" else "."
            out.append(
                {"translations": [{"text": body + end, "to": answer_code or code(language)}]}
            )
        return httpx.Response(200, json=out)

    return handler


@pytest.fixture
def translator_client(
    make_settings: Callable[..., Settings], db_engine
) -> Iterator[Callable[..., tuple[TestClient, list[httpx.Request]]]]:
    clients: list[TestClient] = []

    def factory(handler, **overrides):
        calls: list[httpx.Request] = []

        def recording(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return handler(request)

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


@pytest.mark.parametrize("language", LANGUAGES)
def test_each_language_asks_azure_for_its_code_and_keeps_the_glossary_terms(
    translator_client, language: str
) -> None:
    client, calls = translator_client(translated(language))
    csrf = login(client)
    job_id = create_job(client, csrf, target_language=language).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert [call.url.params["to"] for call in calls] == [code(language)]
    assert all(call.url.params["from"] == "en" for call in calls)
    result = client.get(f"/api/jobs/{job_id}/result").json()
    assert result["translation"]["is_illustrative"] is False
    text_ = result["translation"]["text"]
    assert "Spring Boot" in text_ and "Dependency Injection" in text_ and FILLER[language] in text_


@pytest.mark.parametrize("language", LANGUAGES)
def test_an_answer_in_another_language_is_never_used(translator_client, language: str) -> None:
    client, calls = translator_client(translated(language, answer_code="vi"))
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, target_language=language).json()["id"])
    assert (job["status"], job["error"]["code"]) == ("failed", "translation_invalid_response")
    assert job["target_language"] == language
    assert len(calls) == 1


@pytest.mark.parametrize("language", ["arabic", "japanese"])
def test_a_failed_translation_fails_the_job_without_retry_or_fallback(
    translator_client, language: str
) -> None:
    client, calls = translator_client(lambda _: httpx.Response(500))
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, target_language=language).json()["id"])
    assert (job["status"], job["error"]["code"]) == ("failed", "translation_service_error")
    assert [call.url.params["to"] for call in calls] == [code(language)]  # once, never "vi"


# --- guests and invitation accounts (mock providers) -------------------------------------------


@pytest.fixture
def guest_client(make_cognito_client) -> TestClient:
    return make_cognito_client(**GUEST_SETTINGS)


def test_a_guest_job_counts_once_whatever_its_language(guest_client) -> None:
    csrf = start_guest(guest_client)["csrf_token"]
    before = quota(guest_client)["session_remaining"]
    for language in ("arabic", "hindi"):
        response = guest_job(guest_client, csrf, target_language=language)
        assert response.status_code == 202, response.text
        assert response.json()["target_language"] == language
        assert wait_for_terminal(guest_client, response.json()["id"])["status"] == "completed"
    assert quota(guest_client)["session_remaining"] == before - 2


def test_a_guest_cannot_send_a_locale_and_uses_no_quota(guest_client, db_engine) -> None:
    csrf = start_guest(guest_client)["csrf_token"]
    before = quota(guest_client)["session_remaining"]
    assert "target_language" in field_errors(guest_job(guest_client, csrf, target_language="ar-SA"))
    assert quota(guest_client)["session_remaining"] == before
    assert job_count(db_engine) == 0


def test_an_invited_account_can_choose_a_new_language(make_cognito_client, fake_cognito) -> None:
    client = make_cognito_client()
    fake_cognito.add_user("mai@example.com", "correct-horse-1")
    csrf = sign_in(client, "mai@example.com", "correct-horse-1")["csrf_token"]
    job_id = create_job(client, csrf, target_language="russian").json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    assert client.get(f"/api/jobs/{job_id}/result").json()["target_language"] == "russian"


# --- real speech audio: fake Azure, real FFmpeg ------------------------------------------------


def speaking(request: httpx.Request) -> httpx.Response:
    voice = ssml_voice(request.content)
    return httpx.Response(200, content=make_wav(len("".join(voice.itertext())) / 8))


@pytest.fixture
def audio_client(
    make_settings: Callable[..., Settings], db_engine, audio_tools
) -> Iterator[Callable[..., tuple[TestClient, list, list]]]:
    clients: list[TestClient] = []

    def factory(language: str, *, speech=None, **overrides):
        translations: list[httpx.Request] = []
        speeches: list[httpx.Request] = []

        def translate_recording(request: httpx.Request) -> httpx.Response:
            translations.append(request)
            return translated(language)(request)

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


def _check_requests(speeches: list[httpx.Request], language: str, voice: str) -> None:
    for request in speeches:
        assert ssml_voice(request.content).get("name") == f"en-US-{voice}Neural"
        languages = {lang for lang, _ in ssml_spans(request.content) if lang is not None}
        assert languages == {locale(language), "en-US"}


# Every language at 1x with both voices, and every speed once (languages in turn).
PLAIN_CASES = [(language, voice, 1) for language in LANGUAGES for voice in VOICES] + [
    (language, "AndrewMultilingual", speed)
    for language, speed in zip(cycle(LANGUAGES), [s for s in SPEEDS if s != 1], strict=False)
]


@pytest.mark.parametrize(("language", "voice", "speed"), PLAIN_CASES)
def test_a_plain_job_reads_its_locale_with_one_voice_and_hits_the_target(
    audio_client, language: str, voice: str, speed: float
) -> None:
    client, translations, speeches = audio_client(language)
    csrf = login(client)
    body = {"target_language": language, "voice": voice, "speed": speed}
    job = wait_for_terminal(client, create_job(client, csrf, **body).json()["id"], 60)
    assert job["status"] == "completed", job
    assert [call.url.params["to"] for call in translations] == [code(language)]
    _check_requests(speeches, language, voice)
    english = [t for r in speeches for lang, t in ssml_spans(r.content) if lang == "en-US"]
    assert english == ["Spring Boot", "Dependency Injection"]
    duration = client.get(f"/api/jobs/{job['id']}/result").json()["audio"]["duration"]
    expected = round(360 * RATE / speed)
    assert duration["target_samples"] == duration["mp3_decoded_samples"] == expected


IMPORTED = """0:00.160
A neural network uses gradient descent.
0:03.480
We deploy it with Kubernetes and a REST API.
0:07.250
Then we measure the loss function.
0:11.000
Thanks."""

TIMED_CASES = [(language, 1) for language in LANGUAGES] + [
    (language, speed)
    for language, speed in zip(cycle(LANGUAGES), [s for s in SPEEDS if s != 1], strict=False)
]


@pytest.mark.parametrize(("language", "speed"), TIMED_CASES)
def test_a_timed_job_follows_the_captions_and_hits_the_target(
    audio_client, audio_tools, tmp_path, language: str, speed: float
) -> None:
    client, translations, speeches = audio_client(language, speech=break_voice())
    csrf = login(client)
    body = {
        "transcript": IMPORTED,
        "timing_mode": "timed",
        "target_language": language,
        "speed": speed,
        **ELEVEN_SECONDS,
    }
    job = wait_for_terminal(client, create_job(client, csrf, **body).json()["id"], 60)
    assert job["status"] == "completed", job
    assert [call.url.params["to"] for call in translations] == [code(language)]
    result = client.get(f"/api/jobs/{job['id']}/result").json()
    timing = result["timing"]
    assert timing["source_first_seconds"] == 0.16 and timing["source_last_seconds"] == 11.0
    assert timing["source_baseline_seconds"] == pytest.approx(10.84)
    assert timing["blocks"] == len(result["translation"]["text"].split("\n")) == 3
    _check_requests(speeches, language, "AndrewMultilingual")
    expected = round(11 * RATE / speed)
    assert result["audio"]["duration"]["target_samples"] == expected
    downloaded = client.get(result["audio"]["download_url"]).content
    assert decoded_samples(audio_tools, downloaded, tmp_path) == expected
