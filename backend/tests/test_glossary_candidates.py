"""Glossary candidates: counting per job, concurrency, review, export/promote, isolation."""

import io
import logging
import random
import threading
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DataError, OperationalError

from app import maintenance
from app.audio.mock import MockAudioProcessor
from app.audio.speed import AudioSpeed
from app.db import session_scope
from app.glossary_candidates.models import CandidateStatus, CasePolicy, GlossaryCandidate
from app.glossary_candidates.store import (
    ReviewError,
    approve,
    build_export,
    list_candidates,
    promote,
    record_job_candidates,
    reject,
    reopen,
)
from app.jobs import pipeline as pipeline_module
from app.jobs import service
from app.jobs.models import JobStatus
from app.jobs.pipeline import JobInput, JobPipeline
from app.languages import TargetLanguage
from app.pronunciation import policy as policy_module
from app.pronunciation.detector import Candidate, CandidateKind
from app.pronunciation.keys import candidate_key
from app.speech.mock import MockSpeechProvider
from app.speech.ssml import language_spans
from app.speech.voices import Voice
from app.translation.base import TranslationResult
from app.translation.mock import MockTranslationProvider
from scripts import glossary_candidates as cli
from tests.test_pronunciation import SAMPLE_EN, SAMPLE_VI

SAMPLE_TERMS = ["Container", "Kernel", "containers", "trenchcoat"]


@pytest.fixture
def services(make_client):
    return make_client().app.state.services


@pytest.fixture
def factory(services):
    return services.session_factory


def new_job(factory) -> uuid.UUID:
    with session_scope(factory) as db:
        job = service.create_job(
            db,
            session_id=None,
            voice="AndrewMultilingual",
            first_sentence_start_seconds=0,
            last_sentence_start_seconds=20,
            transcript_char_count=10,
            translation_provider="azure-translator",
            speech_provider="mock-speech",
            audio_processor="mock-audio",
            runner_id="test",
        )
    return job.id


def word(term: str, kind: CandidateKind = CandidateKind.WORD) -> Candidate:
    return Candidate(candidate_key(term), term, kind)


def record(factory, job_id, terms, now=None) -> bool:
    with session_scope(factory) as db:
        return record_job_candidates(db, job_id, [word(t) for t in terms], now)


def rows(factory) -> dict[str, GlossaryCandidate]:
    with session_scope(factory) as db:
        return {c.term_key: c for c in db.scalars(select(GlossaryCandidate))}


def by_term(factory, term: str) -> GlossaryCandidate:
    return rows(factory)[candidate_key(term)]


def marker(factory, job_id):
    with session_scope(factory) as db:
        return db.execute(
            text("SELECT glossary_candidates_recorded_at FROM jobs WHERE id = :id"),
            {"id": job_id},
        ).scalar_one()


# --- counting -------------------------------------------------------------------------------


def test_each_job_counts_a_term_once_and_recording_again_counts_nothing(factory):
    first, second = new_job(factory), new_job(factory)
    t1 = datetime(2026, 10, 1, tzinfo=UTC)
    assert record(factory, first, ["kernel", "Kernel", "trenchcoat"], t1)
    assert not record(factory, first, ["kernel", "trenchcoat"], t1 + timedelta(hours=1))
    assert record(factory, second, ["kernel"], t1 + timedelta(days=1))

    kernel = by_term(factory, "kernel")
    assert (kernel.job_count, kernel.display_term, kernel.spellings) == (2, "kernel", ["kernel"])
    assert (kernel.first_seen_at, kernel.last_seen_at) == (t1, t1 + timedelta(days=1))
    assert kernel.status == CandidateStatus.PENDING
    assert by_term(factory, "trenchcoat").job_count == 1
    assert len(rows(factory)) == 2
    assert marker(factory, first) is not None


def test_spellings_are_kept_for_review_up_to_five(factory):
    for spelling in ["Docker2", "docker2", "DOCKER2", "DOCKER2", "DoCkEr2"]:
        with session_scope(factory) as db:
            candidate = Candidate("docker2", spelling, CandidateKind.WORD)
            record_job_candidates(db, new_job(factory), [candidate])
    candidate = rows(factory)["docker2"]
    assert candidate.display_term == "Docker2"  # first seen stays the display form
    assert candidate.spellings == ["Docker2", "docker2", "DOCKER2", "DoCkEr2"]
    assert candidate.job_count == 5


def test_a_name_sighting_upgrades_a_word_but_nothing_downgrades(factory):
    record(factory, new_job(factory), ["podman"])
    with session_scope(factory) as db:
        record_job_candidates(db, new_job(factory), [word("Podman", CandidateKind.PROPER_NAME)])
    record(factory, new_job(factory), ["podman"])
    assert by_term(factory, "podman").kind == CandidateKind.PROPER_NAME


def test_the_batch_is_all_or_nothing(factory):
    job = new_job(factory)
    record(factory, new_job(factory), ["kernel"])
    too_long = Candidate("x" * 300, "x" * 300, CandidateKind.WORD)
    with pytest.raises(DataError), session_scope(factory) as db:
        record_job_candidates(db, job, [word("kernel"), word("trenchcoat"), too_long])
    assert by_term(factory, "kernel").job_count == 1  # not incremented
    assert candidate_key("trenchcoat") not in rows(factory)
    assert marker(factory, job) is None  # the job can still be counted later


def test_concurrent_jobs_lose_no_count_and_create_no_duplicate(factory):
    jobs = [new_job(factory) for _ in range(8)]
    shared = ["kernel", "container", "trenchcoat", "runtime"]
    barrier = threading.Barrier(len(jobs))
    errors: list[BaseException] = []

    def work(index: int, job_id: uuid.UUID) -> None:
        terms = [*shared, f"unique{index}"]
        # Different input orders must not deadlock.
        random.Random(index).shuffle(terms)  # noqa: S311
        try:
            barrier.wait()
            record(factory, job_id, terms)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work, args=pair) for pair in enumerate(jobs)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert errors == []
    stored = rows(factory)
    assert len(stored) == len(shared) + len(jobs)
    assert all(stored[key].job_count == len(jobs) for key in shared)
    assert all(stored[f"unique{i}"].job_count == 1 for i in range(len(jobs)))


def test_the_same_job_recorded_concurrently_counts_once(factory):
    job = new_job(factory)
    barrier = threading.Barrier(4)
    results: list[bool] = []

    def work() -> None:
        barrier.wait()
        results.append(record(factory, job, ["kernel"]))

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert sorted(results) == [False, False, False, True]
    assert by_term(factory, "kernel").job_count == 1


def test_review_status_is_never_reset_by_discovery(factory):
    record(factory, new_job(factory), ["kernel", "trenchcoat"])
    with session_scope(factory) as db:
        approve(
            db,
            by_term(factory, "kernel").id,
            canonical_term="kernel",
            case_policy=CasePolicy.INSENSITIVE,
            reviewed_by="po",
            note=None,
        )
        reject(db, by_term(factory, "trenchcoat").id, reviewed_by="po", note="not technical")
    record(factory, new_job(factory), ["Kernel", "trenchcoat"])

    kernel, coat = by_term(factory, "kernel"), by_term(factory, "trenchcoat")
    assert (kernel.status, kernel.job_count, kernel.canonical_term) == ("approved", 2, "kernel")
    assert kernel.spellings == ["kernel", "Kernel"]
    assert (coat.status, coat.job_count, coat.review_note) == ("rejected", 2, "not technical")


def test_candidates_outlive_results_jobs_and_sessions(services, factory):
    job = new_job(factory)
    record(factory, job, ["trenchcoat"])
    maintenance.run_cleanup(services)  # result and session cleanup
    with session_scope(factory) as db:
        db.execute(text("DELETE FROM jobs"))  # a future metadata cleanup
        db.execute(text("DELETE FROM access_sessions"))
    assert by_term(factory, "trenchcoat").job_count == 1
    with session_scope(factory) as db:
        foreign_keys = db.execute(
            text(
                "SELECT count(*) FROM information_schema.table_constraints "
                "WHERE table_name = 'glossary_candidates' AND constraint_type = 'FOREIGN KEY'"
            )
        ).scalar_one()
    assert foreign_keys == 0


def test_a_job_that_no_longer_exists_is_not_counted(factory):
    assert not record(factory, uuid.uuid4(), ["kernel"])
    assert rows(factory) == {}


# --- review ---------------------------------------------------------------------------------


def candidate_id(factory, term: str) -> int:
    return by_term(factory, term).id


def test_list_orders_by_jobs_then_last_seen(factory):
    t = datetime(2026, 10, 1, tzinfo=UTC)
    record(factory, new_job(factory), ["alpha", "beta", "gamma"], t)
    record(factory, new_job(factory), ["beta"], t + timedelta(days=1))
    record(factory, new_job(factory), ["gamma"], t + timedelta(days=2))
    record(factory, new_job(factory), ["gamma"], t + timedelta(days=2))
    with session_scope(factory) as db:
        listed = [c.display_term for c in list_candidates(db, CandidateStatus.PENDING, 10)]
    assert listed == ["gamma", "beta", "alpha"]


def test_approve_records_canonical_spelling_and_case_policy(factory):
    record(factory, new_job(factory), ["containers", "VMs"])
    with session_scope(factory) as db:
        approved = approve(
            db,
            candidate_id(factory, "containers"),
            canonical_term=" container ",  # the singular covers the plural seen
            case_policy=CasePolicy.INSENSITIVE,
            reviewed_by="po",
            note="technical",
        )
        assert (approved.canonical_term, approved.case_policy) == ("container", "insensitive")
        assert approved.reviewed_at is not None
        with pytest.raises(ReviewError, match="does not match any spelling"):
            approve(
                db,
                candidate_id(factory, "VMs"),
                canonical_term="vms",
                case_policy=CasePolicy.EXACT,
                reviewed_by=None,
                note=None,
            )


@pytest.mark.parametrize("bad", ["", "a<b", "=kernel", "# kernel", "x" * 101, "ker\x00nel"])
def test_approve_rejects_invalid_glossary_lines(factory, bad):
    record(factory, new_job(factory), ["kernel"])
    with pytest.raises(ReviewError), session_scope(factory) as db:
        approve(
            db,
            candidate_id(factory, "kernel"),
            canonical_term=bad,
            case_policy=CasePolicy.INSENSITIVE,
            reviewed_by=None,
            note=None,
        )
    assert by_term(factory, "kernel").status == "pending"


def test_rejected_stays_rejected_until_reopened(factory):
    record(factory, new_job(factory), ["trenchcoat"])
    cid = candidate_id(factory, "trenchcoat")
    with session_scope(factory) as db:
        reject(db, cid, reviewed_by=None, note=None)
    with pytest.raises(ReviewError, match="only pending"), session_scope(factory) as db:
        approve(
            db,
            cid,
            canonical_term="trenchcoat",
            case_policy=CasePolicy.INSENSITIVE,
            reviewed_by=None,
            note=None,
        )
    with session_scope(factory) as db:
        reopened = reopen(db, cid)
        assert (reopened.status, reopened.reviewed_at, reopened.canonical_term) == (
            "pending",
            None,
            None,
        )


def approve_term(factory, term, canonical, policy=CasePolicy.INSENSITIVE):
    with session_scope(factory) as db:
        approve(
            db,
            candidate_id(factory, term),
            canonical_term=canonical,
            case_policy=policy,
            reviewed_by=None,
            note=None,
        )


def test_export_checks_conflicts_and_never_promotes(factory):
    record(factory, new_job(factory), ["kernel", "Podman", "dockers", "REST2", "container image"])
    approve_term(factory, "kernel", "kernel")
    approve_term(factory, "Podman", "Podman", CasePolicy.EXACT)
    approve_term(factory, "dockers", "dockers")
    approve_term(factory, "container image", "container image")
    glossary = "Docker\n=REST\nkernel\n"
    with session_scope(factory) as db:
        export = build_export(list_candidates(db, CandidateStatus.APPROVED, 100), glossary)
    assert sorted(line for _, line in export.lines) == ["=Podman", "container image", "dockers"]
    assert export.errors == []
    joined = "\n".join(export.warnings)
    assert "'kernel' is already in the glossary" in joined
    assert "'dockers' is already matched by glossary term 'Docker'" in joined
    assert all(c.status == "approved" for c in rows(factory).values() if c.canonical_term)


def test_export_refuses_duplicates_among_approved(factory):
    record(factory, new_job(factory), ["Kernel2", "kernel2s"])
    approve_term(factory, "Kernel2", "kernel2")
    approve_term(factory, "kernel2s", "Kernel2")
    with session_scope(factory) as db:
        export = build_export(list_candidates(db, CandidateStatus.APPROVED, 100), "")
    assert export.lines == []
    assert "duplicates" in export.errors[0]


def test_promote_only_what_the_merged_glossary_contains(factory):
    record(factory, new_job(factory), ["kernel", "Podman", "VMs"])
    approve_term(factory, "kernel", "kernel")
    approve_term(factory, "Podman", "Podman", CasePolicy.EXACT)
    approve_term(factory, "VMs", "VM", CasePolicy.EXACT)
    record(factory, new_job(factory), ["trenchcoat"])
    sha = "a" * 40
    with session_scope(factory) as db:
        # "Podman" is present but not as an exact line, so its policy does not match.
        promoted = promote(db, "kernel\nPodman\n=VM\ntrenchcoat\n", sha)
    assert sorted(c.display_term for c in promoted) == ["VMs", "kernel"]
    stored = rows(factory)
    assert stored["kernel"].status == "promoted" and stored["kernel"].promoted_commit == sha
    assert stored["podman"].status == "approved"
    assert stored["trenchcoat"].status == "pending"  # never promoted without approval


# --- the pipeline -------------------------------------------------------------------------------


class SampleTranslator:
    """A real (non-illustrative) translation, as Azure returned it for the sample."""

    name = "azure-translator"

    def translate(self, text: str, language: TargetLanguage) -> TranslationResult:
        assert text == SAMPLE_EN
        assert language is TargetLanguage.VIETNAMESE  # a job without the field is Vietnamese
        return TranslationResult(SAMPLE_VI, is_illustrative=False)


class RecordingSpeech(MockSpeechProvider):
    def __init__(self) -> None:
        super().__init__()
        self.terms = None

    def synthesize(self, text, voice, work_dir, terms=None, language=TargetLanguage.VIETNAMESE):
        self.terms = terms
        return super().synthesize(text, voice, work_dir, terms, language)


class InlineSlot:
    def start(self, work) -> None:
        work()

    def cancel(self) -> None:
        pass


def run_job(services, translator, transcript=SAMPLE_EN):
    speech = RecordingSpeech()
    pipeline = JobPipeline(
        session_factory=services.session_factory,
        translator=translator,
        speech=speech,
        audio=MockAudioProcessor(),
        result_store=services.result_store,
        result_ttl_seconds=3600,
    )
    job_id = new_job(services.session_factory)
    pipeline.start(InlineSlot(), JobInput(job_id, transcript, Voice.ANDREW, 20, AudioSpeed.X1))
    with session_scope(services.session_factory) as db:
        status = db.execute(
            text("SELECT status FROM jobs WHERE id = :id"), {"id": job_id}
        ).scalar_one()
    return job_id, status, speech


def test_a_completed_job_reads_detected_english_and_counts_its_candidates(services, caplog):
    caplog.set_level(logging.INFO)
    job_id, status, speech = run_job(services, SampleTranslator())
    assert status == JobStatus.COMPLETED
    line = SAMPLE_VI.split("\n")[1]
    english = [t for lang, t in language_spans(line, speech.terms) if lang == "en-US"]
    assert english == ["Container", "container", "Kernel", "/proc"]
    stored = rows(services.session_factory)
    assert sorted(c.display_term for c in stored.values()) == sorted(SAMPLE_TERMS)
    assert all(c.job_count == 1 and c.status == "pending" for c in stored.values())
    assert marker(services.session_factory, job_id) is not None
    assert_no_content_logged(caplog)


def test_mock_translation_records_nothing_and_speech_uses_the_glossary(services):
    _, status, speech = run_job(services, MockTranslationProvider())
    assert status == JobStatus.COMPLETED
    assert speech.terms is None
    assert rows(services.session_factory) == {}


def test_a_failed_candidate_transaction_keeps_the_completed_result(services, monkeypatch, caplog):
    """A real database error (value too long) inside the candidate transaction."""
    real = record_job_candidates

    def with_bad_row(db, job_id, candidates, now=None):
        bad = Candidate("trenchcoat " * 20, "trenchcoat " * 20, CandidateKind.PHRASE)
        return real(db, job_id, [*candidates, bad], now)

    monkeypatch.setattr(pipeline_module, "record_job_candidates", with_bad_row)
    caplog.set_level(logging.INFO)
    job_id, status, _ = run_job(services, SampleTranslator())

    assert status == JobStatus.COMPLETED
    assert services.result_store.get(job_id) is not None
    assert rows(services.session_factory) == {}  # rolled back as a whole
    assert marker(services.session_factory, job_id) is None
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("glossary candidates were not recorded (DataError)" in w for w in warnings)
    assert_no_content_logged(caplog)


def test_an_unreachable_database_for_candidates_does_not_fail_the_job(
    services, monkeypatch, caplog
):
    def unavailable(db, job_id, candidates, now=None):
        raise OperationalError(
            "INSERT INTO glossary_candidates", {"term": "trenchcoat"}, Exception("Kernel")
        )

    monkeypatch.setattr(pipeline_module, "record_job_candidates", unavailable)
    caplog.set_level(logging.INFO)
    job_id, status, _ = run_job(services, SampleTranslator())
    assert status == JobStatus.COMPLETED
    assert services.result_store.get(job_id) is not None
    assert_no_content_logged(caplog)


def test_a_detection_bug_falls_back_to_the_glossary(services, monkeypatch, caplog):
    def broken(*_):
        raise RuntimeError("trenchcoat")

    # The pipeline takes the Vietnamese detector from `pronunciation/policy.py`.
    monkeypatch.setattr(policy_module, "detect_english", broken)
    caplog.set_level(logging.INFO)
    _, status, speech = run_job(services, SampleTranslator())
    assert status == JobStatus.COMPLETED
    assert speech.terms is None
    assert any("English detection failed (RuntimeError)" in r.getMessage() for r in caplog.records)
    assert_no_content_logged(caplog)


def assert_no_content_logged(caplog) -> None:
    secrets = ["trenchcoat", "Kernel", "kernel", "Container", "Docker", "/proc", "tiến trình"]
    for record_ in caplog.records:
        message = record_.getMessage()
        assert not any(secret in message for secret in secrets), message
        assert record_.exc_text is None or not any(s in record_.exc_text for s in secrets)


# --- command line ---------------------------------------------------------------------------------


def cli_run(factory, *argv: str) -> tuple[int, str]:
    out = io.StringIO()
    code = cli.run(list(argv), factory, out=out)
    return code, out.getvalue()


def test_cli_review_flow(factory, tmp_path, capsys):
    record(factory, new_job(factory), ["kernel", "trenchcoat"])
    record(factory, new_job(factory), ["kernel"])
    kid, cid = candidate_id(factory, "kernel"), candidate_id(factory, "trenchcoat")

    code, out = cli_run(factory, "list")
    assert code == 0
    assert out.index("'kernel'") < out.index("'trenchcoat'")
    assert "2 jobs" in out

    approved = cli_run(factory, "approve", str(kid), "--term", "kernel", "--case", "insensitive")
    assert approved[0] == 0
    assert cli_run(factory, "reject", str(cid), "--note", "not technical")[0] == 0
    assert "pending" not in cli_run(factory, "list", "--status", "all")[1]

    glossary = tmp_path / "glossary.txt"
    glossary.write_text("Docker\n", encoding="utf-8")
    target = tmp_path / "proposal.txt"
    code, _ = cli_run(factory, "export", "--glossary", str(glossary), "--output", str(target))
    assert code == 0
    proposal = target.read_text(encoding="utf-8")
    assert "\nkernel\n" in proposal and "trenchcoat" not in proposal
    assert "single lowercase word" in capsys.readouterr().err
    assert by_term(factory, "kernel").status == "approved"  # export promotes nothing

    assert cli_run(factory, "reopen", str(cid))[0] == 0
    assert by_term(factory, "trenchcoat").status == "pending"


def test_cli_promote_requires_a_commit_merged_into_main(factory, monkeypatch):
    record(factory, new_job(factory), ["kernel"])
    approve_term(factory, "kernel", "kernel")
    sha = "b" * 40
    merged = {"value": False}

    def fake_git(*args):
        if args[0] == "rev-parse":
            return sha + "\n"
        if args[0] == "merge-base":
            if not merged["value"]:
                raise cli.CommandError("git merge-base failed")
            return ""
        if args[0] == "show":
            assert args[1] == f"{sha}:backend/app/translation/data/glossary.txt"
            return "Docker\nkernel\n"
        raise AssertionError(args)

    monkeypatch.setattr(cli, "git", fake_git)
    with pytest.raises(cli.CommandError, match="not merged"):
        cli_run(factory, "promote", "--ref", "feature")
    assert by_term(factory, "kernel").status == "approved"

    merged["value"] = True
    code, out = cli_run(factory, "promote", "--dry-run")
    assert code == 0 and "would promote" in out
    assert by_term(factory, "kernel").status == "approved"
    code, out = cli_run(factory, "promote")
    assert code == 0 and "1 candidate(s) found" in out
    assert by_term(factory, "kernel").promoted_commit == sha


def test_cli_never_prints_the_database_url(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://admin:S3cretPassw0rd@127.0.0.1:1/x")
    assert cli.main(["list"]) == 1
    captured = capsys.readouterr()
    assert "S3cretPassw0rd" not in captured.out + captured.err
    assert "database operation failed (OperationalError)" in captured.err
