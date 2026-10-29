"""Output languages: the transcript is always English, and each job is translated into one of these.

The API value is the product's own name for the language. The codes of the services are separate
and fixed here, never taken from a request (checked against Microsoft Learn on 2026-10-29):

| API value             | Azure Translator `to` | Azure Speech `<lang xml:lang>` |
|-----------------------|-----------------------|--------------------------------|
| `vietnamese`          | `vi`                  | `vi-VN`                        |
| `mandarin_simplified` | `zh-Hans`             | `zh-CN`                        |

* Translator language support lists "Chinese Simplified" as `zh-Hans` (Traditional is `zh-Hant`,
  Cantonese `yue`; neither is offered).
* The SSML voice page lists Chinese Mandarin (`zh-CN`) and Vietnamese (`vi-VN`) among the speaking
  languages of `en-US-AndrewMultilingualNeural` and `en-US-EmmaMultilingualNeural`, the two voices
  MyDubb offers, through the `<lang xml:lang>` element. The same voice reads every language.

Vietnamese is the default: a request without the field, and every job stored before the field
existed, is Vietnamese.
"""

from enum import StrEnum


class TargetLanguage(StrEnum):
    VIETNAMESE = "vietnamese"
    MANDARIN = "mandarin_simplified"

    @property
    def label(self) -> str:
        """Name shown in the language selector."""
        return _LABELS[self]

    @property
    def noun(self) -> str:
        """Name used inside a sentence ("the Vietnamese text")."""
        return _NOUNS[self]

    @property
    def translator_code(self) -> str:
        return _TRANSLATOR_CODES[self]

    @property
    def speech_locale(self) -> str:
        return _SPEECH_LOCALES[self]


DEFAULT_TARGET_LANGUAGE = TargetLanguage.VIETNAMESE

_LABELS = {
    TargetLanguage.VIETNAMESE: "Vietnamese",
    TargetLanguage.MANDARIN: "Chinese — Mandarin (Simplified)",
}

_NOUNS = {
    TargetLanguage.VIETNAMESE: "Vietnamese",
    TargetLanguage.MANDARIN: "Mandarin Chinese",
}

_TRANSLATOR_CODES = {
    TargetLanguage.VIETNAMESE: "vi",
    TargetLanguage.MANDARIN: "zh-Hans",
}

_SPEECH_LOCALES = {
    TargetLanguage.VIETNAMESE: "vi-VN",
    TargetLanguage.MANDARIN: "zh-CN",
}
