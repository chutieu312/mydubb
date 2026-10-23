from enum import StrEnum


class Voice(StrEnum):
    """Approved voices. API values are the product voice names.

    Both are Azure multilingual voices: one speaker reads the Vietnamese text and, through
    `<lang>` spans, the English technical terms. The first member is the default.
    Jobs created before this set (voices `HoaiMy` and `NamMinh`) keep their stored voice
    name; it is only displayed, never converted back to a `Voice`.
    """

    ANDREW = "AndrewMultilingual"
    EMMA = "EmmaMultilingual"

    @property
    def azure_voice_name(self) -> str:
        return _AZURE_VOICE_NAMES[self]

    @property
    def label(self) -> str:
        return _LABELS[self]

    @property
    def description(self) -> str:
        return _DESCRIPTIONS[self]


DEFAULT_VOICE = Voice.ANDREW

_AZURE_VOICE_NAMES = {
    Voice.ANDREW: "en-US-AndrewMultilingualNeural",
    Voice.EMMA: "en-US-EmmaMultilingualNeural",
}

_LABELS = {
    Voice.ANDREW: "Andrew Multilingual",
    Voice.EMMA: "Emma Multilingual",
}

_DESCRIPTIONS = {
    Voice.ANDREW: "Male",
    Voice.EMMA: "Female",
}
