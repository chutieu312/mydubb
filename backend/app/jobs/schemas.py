import uuid
from datetime import datetime

from pydantic import BaseModel, ValidationInfo, field_validator

from app.jobs.models import Job
from app.speech.voices import Voice
from app.transcript.cleaning import clean_transcript
from app.transcript.timestamps import format_seconds, parse_timestamp, target_duration_seconds


class CreateJobRequest(BaseModel):
    transcript: str
    first_sentence_start: str
    last_sentence_start: str
    voice: Voice

    @field_validator("transcript")
    @classmethod
    def _clean_transcript(cls, value: str) -> str:
        cleaned = clean_transcript(value)
        if not cleaned:
            raise ValueError("Transcript must contain English text.")
        return cleaned

    @field_validator("first_sentence_start", "last_sentence_start")
    @classmethod
    def _valid_timestamp(cls, value: str) -> str:
        parse_timestamp(value)  # TimestampError is a ValueError -> 422
        return value.strip()

    @field_validator("last_sentence_start")
    @classmethod
    def _after_first(cls, value: str, info: ValidationInfo) -> str:
        first = info.data.get("first_sentence_start")
        if first is not None:
            target_duration_seconds(parse_timestamp(first), parse_timestamp(value))
        return value


class JobError(BaseModel):
    code: str
    message: str


class JobResponse(BaseModel):
    id: uuid.UUID
    status: str
    voice: str
    first_sentence_start: str
    last_sentence_start: str
    target_duration_seconds: int
    target_duration: str
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    result_expires_at: datetime | None
    error: JobError | None

    @classmethod
    def from_job(cls, job: Job) -> "JobResponse":
        error = None
        if job.error_code:
            error = JobError(code=job.error_code, message=job.error_message or "")
        return cls(
            id=job.id,
            status=job.status,
            voice=job.voice,
            first_sentence_start=format_seconds(job.first_sentence_start_seconds),
            last_sentence_start=format_seconds(job.last_sentence_start_seconds),
            target_duration_seconds=job.target_duration_seconds,
            target_duration=format_seconds(job.target_duration_seconds),
            created_at=job.created_at,
            updated_at=job.updated_at,
            completed_at=job.completed_at,
            result_expires_at=job.result_expires_at,
            error=error,
        )


class TranslationOut(BaseModel):
    text: str
    is_illustrative: bool
    provider: str


class AudioOut(BaseModel):
    url: str
    download_url: str
    content_type: str
    is_fixture: bool
    duration_adjusted: bool


class JobResultResponse(BaseModel):
    job_id: uuid.UUID
    translation: TranslationOut
    audio: AudioOut
    expires_at: datetime
    notices: list[str]
