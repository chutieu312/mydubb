import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, PrivateAttr, ValidationInfo, field_validator, model_validator

from app.audio.speed import DEFAULT_SPEED, AudioSpeed, DurationTarget, speed_from_api
from app.jobs.models import Job
from app.speech.voices import DEFAULT_VOICE, Voice
from app.transcript.cleaning import clean_transcript
from app.transcript.timed import TimedTranscript, parse_timed_transcript
from app.transcript.timestamps import format_seconds, parse_timestamp, target_duration_seconds


class TimingMode(StrEnum):
    """How the transcript's timestamps are used.

    `plain`: timing markup is removed and the whole audio is fitted to the baseline (the behaviour
    before timed mode; the default, also for clients that do not send the field). `timed`: the
    transcript must have the YouTube-style structure (transcript/timed.py); its caption times place
    the blocks on the timeline. Never switched silently: a timed transcript that cannot be timed is
    a validation error, not a plain job.
    """

    PLAIN = "plain"
    TIMED = "timed"


class CreateJobRequest(BaseModel):
    # Declared before `transcript`, whose validator depends on it.
    timing_mode: TimingMode = TimingMode.PLAIN
    transcript: str
    first_sentence_start: str
    last_sentence_start: str
    voice: Voice = DEFAULT_VOICE
    # Strict: only 0.5, 0.75, 1, 1.25, 1.5, 1.75 or 2. Omitted means 1x (the behaviour before
    # the option existed). The output length is always computed by the server, never sent.
    speed: AudioSpeed = DEFAULT_SPEED
    _timed: TimedTranscript | None = PrivateAttr(default=None)

    @field_validator("speed", mode="before")
    @classmethod
    def _supported_speed(cls, value: object) -> AudioSpeed:
        return speed_from_api(value)

    @field_validator("transcript")
    @classmethod
    def _clean_transcript(cls, value: str, info: ValidationInfo) -> str:
        if info.data.get("timing_mode") is TimingMode.TIMED:
            # TimedTranscriptError is a ValueError: a 422 on `transcript` with its reason.
            parse_timed_transcript(value)
            return value
        cleaned = clean_transcript(value)
        if not cleaned:
            raise ValueError("Transcript must contain English text.")
        return cleaned

    @model_validator(mode="after")
    def _parse_timeline(self) -> "CreateJobRequest":
        if self.timing_mode is TimingMode.TIMED:
            self._timed = parse_timed_transcript(self.transcript)
        return self

    @property
    def timed(self) -> TimedTranscript | None:
        """The parsed captions and blocks in timed mode (kept in memory only)."""
        return self._timed

    @property
    def spoken_text(self) -> str:
        """What is translated and read: the cleaned text, or the timed blocks one per line."""
        return self._timed.text if self._timed is not None else self.transcript

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


class TimedFrameOut(BaseModel):
    """One frame of the output timeline: one block, or several grouped blocks read in it."""

    first_block: int
    last_block: int
    start_seconds: float
    frame_seconds: float
    # Audio that had to be heard in the frame, before any tempo change.
    audio_seconds: float
    # >1 faster (pitch kept); null when the speech fitted at its natural speed.
    tempo_factor: float | None
    padded_seconds: float


class TimingOut(BaseModel):
    """Timed mode: how the caption times were used. Block starts inside a caption are estimated
    by word count, and grouped blocks share a frame, so this is not exact sentence timing."""

    mode: str  # "timed"
    captions: int
    blocks: int
    # Baseline from the first and last caption, and the one the time fields selected.
    source_first_seconds: int
    source_last_seconds: int
    source_baseline_seconds: int
    selected_baseline_seconds: int
    speech_requests: int
    # The rest is null when the audio was not placed on a timeline (mock audio).
    frames: int | None = None
    removed_boundaries: int | None = None
    tempo_warning_level: float | None = None
    max_tempo_factor: float | None = None
    frames_over_warning_level: int | None = None
    # Computed from the tempo factors, not measured on the audio.
    estimated_max_displacement_seconds: float | None = None
    frame_details: list[TimedFrameOut] | None = None

    @classmethod
    def from_summary(cls, summary: dict) -> "TimingOut":
        timeline = summary.get("timeline")
        fields = {
            key: summary[key]
            for key in (
                "mode",
                "captions",
                "blocks",
                "source_first_seconds",
                "source_last_seconds",
                "source_baseline_seconds",
                "selected_baseline_seconds",
                "speech_requests",
            )
        }
        if not timeline:
            return cls(**fields)
        rate = timeline["sample_rate"]
        boundaries = timeline["boundaries"]
        fits = timeline["frame_fits"]
        tempos = [fit["tempo_factor"] for fit in fits if fit["tempo_factor"] is not None]
        return cls(
            **fields,
            frames=len(fits),
            removed_boundaries=len(timeline["removed_boundaries"]),
            tempo_warning_level=timeline["tempo_warning_level"],
            max_tempo_factor=max(tempos, default=None),
            frames_over_warning_level=timeline["frames_over_warning_level"],
            estimated_max_displacement_seconds=timeline["estimated_max_displacement_seconds"],
            frame_details=[
                TimedFrameOut(
                    first_block=fit["first_block"],
                    last_block=fit["last_block"],
                    start_seconds=boundaries[fit["first_block"]] / rate,
                    frame_seconds=fit["frame_samples"] / rate,
                    audio_seconds=fit["audible_samples"] / rate,
                    tempo_factor=fit["tempo_factor"],
                    padded_seconds=fit["padded_samples"] / rate,
                )
                for fit in fits
            ],
        )


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
    # Timed mode only; null for plain jobs (and for results stored before timed mode existed).
    timing: TimingOut | None = None
