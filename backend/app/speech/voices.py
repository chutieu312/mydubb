from enum import StrEnum


class Voice(StrEnum):
    """Approved Vietnamese voices. API values are the product voice names."""

    HOAI_MY = "HoaiMy"
    NAM_MINH = "NamMinh"

    @property
    def azure_voice_name(self) -> str:
        return _AZURE_VOICE_NAMES[self]

    @property
    def description(self) -> str:
        return _DESCRIPTIONS[self]


_AZURE_VOICE_NAMES = {
    Voice.HOAI_MY: "vi-VN-HoaiMyNeural",
    Voice.NAM_MINH: "vi-VN-NamMinhNeural",
}

_DESCRIPTIONS = {
    Voice.HOAI_MY: "Female",
    Voice.NAM_MINH: "Male",
}
