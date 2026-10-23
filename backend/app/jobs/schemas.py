import uuid
from datetime import datetime

from pydantic import BaseModel, ValidationInfo, field_validator, model_validator

from app.audio.speed import DEFAULT_SPEED, AudioSpeed, DurationTarget, speed_from_api
from app.jobs.models import Job
from app.speech.voices import DEFAULT_VOICE, Voice
from app.transcript.cleaning import clean_transcript
from app.transcript.timestamps import format_seconds, parse_timestamp, target_duration_seconds


class CreateJobRequest(BaseModel):
    transcript: str
    first_sentence_start: str
    last_sentence_start: str
    voice: Voice = DEFAULT_VOICE
    # Strict: only 0.5, 0.75, 1, 1.25, 1.5, 1.75 or 2. Omitted means 1x (the behaviour before
    # the option existed). The output length is always computed by the server, never sent.
    speed: AudioSpeed = DEFAULT_SPEED

    @field_validator("speed", mode="before")
    @classmethod
    def _supported_speed(cls, value: object) -> AudioSpeed:
        return speed_from_api(value)

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
    # Baseline: last - first sentence start. Unchanged meaning; independent of the speed.
    target_duration_seconds: int
    target_duration: str
    baseline_duration_seconds: int
    # Speed chosen when the job was submitted (jobs from before the option existed: 1).
    speed: float
    # Planned output length: baseline / speed, unrounded. The exact sample count and the
    # verified length are in the result (`audio.duration`).
    output_duration_seconds: float
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
        speed = AudioSpeed(job.audio_speed_percent)
        target = DurationTarget(job.target_duration_seconds, speed)
        return cls(
            id=job.id,
            status=job.status,
            voice=job.voice,
            first_sentence_start=format_seconds(job.first_sentence_start_seconds),
            last_sentence_start=format_seconds(job.last_sentence_start_seconds),
            target_duration_seconds=job.target_duration_seconds,
            target_duration=format_seconds(job.target_duration_seconds),
            baseline_duration_seconds=job.target_duration_seconds,
            speed=speed.number,
            output_duration_seconds=float(target.output_seconds),
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


class DurationOut(BaseModel):
    """Durations measured on the real audio. Seconds are samples / sample_rate, unrounded."""

    sample_rate: int
    # Output target: round_half_up(baseline * sample_rate / speed) samples. Equal to the
    # baseline at 1x; fractional otherwise. Same value in the two fields.
    target_seconds: float
    target_samples: int
    baseline_seconds: int
    speed: float
    # Natural length of the speech before the tempo change.
    source_seconds: float
    source_samples: int
    # PCM after the tempo change, before MP3 encoding.
    processed_seconds: float
    processed_samples: int
    # Final MP3: what a decoder produces, the playable length its gapless header declares, and
    # ffprobe's container duration (reported as is; may include encoder delay and padding).
    mp3_decoded_seconds: float
    mp3_decoded_samples: int
    mp3_header_seconds: float
    mp3_header_samples: int
    mp3_container_seconds: float
    # >1 faster, <1 slower; null when the speech was already within rounding of the target.
    tempo_factor: float | None
    padded_samples: int
    trimmed_samples: int
    # Samples by which the MP3 header's end padding was corrected (FFmpeg caps it); 0 if exact.
    mp3_padding_adjusted_samples: int = 0

    @model_validator(mode="before")
    @classmethod
    def _results_from_before_speed_existed(cls, data: object) -> object:
        """A stored report without speed is a 1x result: its baseline is its target."""
        if isinstance(data, dict) and "speed" not in data:
            data = {**data, "speed": 1.0, "baseline_seconds": round(data["target_seconds"])}
        return data


class AudioOut(BaseModel):
    url: str
    download_url: str
    content_type: str
    # Speech provider that produced the audio (e.g. "mock-speech", "azure-speech").
    provider: str
    is_fixture: bool
    duration_adjusted: bool
    # Measured durations; null when the duration was not adjusted.
    duration: DurationOut | None = None


class JobResultResponse(BaseModel):
    job_id: uuid.UUID
    # What was submitted, from the job record (also when the audio was not adjusted, e.g. with
    # the mock audio processor, where `audio.duration` is null).
    baseline_duration_seconds: int
    speed: float
    output_duration_seconds: float
    translation: TranslationOut
    audio: AudioOut
    expires_at: datetime
    notices: list[str]
