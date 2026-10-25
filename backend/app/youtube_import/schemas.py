from pydantic import BaseModel, field_validator

from app.youtube_import.captions import CaptionTrack
from app.youtube_import.youtube_url import YouTubeVideo, parse_youtube_url


class YouTubeImportRequest(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def _youtube_video(cls, value: str) -> str:
        # InvalidYouTubeUrl is a ValueError: a 422 on `url` with its reason.
        parse_youtube_url(value)
        return value

    @property
    def video(self) -> YouTubeVideo:
        return parse_youtube_url(self.url)


class YouTubeImportResponse(BaseModel):
    # Timestamped transcript in the handoff format (captions.py, docs/API.md). The form shows it
    # as text; the server keeps no copy.
    transcript: str
    language: str
    caption_count: int
    # Captions without text, left out of `transcript` (and reported to the user).
    skipped_empty_captions: int
    first_caption_start_ms: int
    last_caption_start_ms: int
    # Suggestions for the two time fields (HH:MM:SS, truncated to whole seconds). Null when the
    # first and last caption start in the same second: there is no baseline to suggest.
    first_sentence_start: str | None
    last_sentence_start: str | None
    provider: str

    @classmethod
    def from_track(cls, track: CaptionTrack, provider: str) -> "YouTubeImportResponse":
        starts = track.suggested_starts()
        return cls(
            transcript=track.transcript,
            language=track.language,
            caption_count=len(track.captions),
            skipped_empty_captions=track.skipped_empty,
            first_caption_start_ms=track.first_start_ms,
            last_caption_start_ms=track.last_start_ms,
            first_sentence_start=starts[0] if starts else None,
            last_sentence_start=starts[1] if starts else None,
            provider=provider,
        )
