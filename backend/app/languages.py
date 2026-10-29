"""Output languages: the transcript is always English, and each job is translated into one of these.

The API value is the product's own name for the language. The codes of the services are separate
and fixed here, never taken from a request (checked against Microsoft Learn on 2026-10-29):

| API value             | Azure Translator `to` | Azure Speech `<lang xml:lang>` |
|-----------------------|-----------------------|--------------------------------|
| `vietnamese`          | `vi`                  | `vi-VN`                        |
| `mandarin_simplified` | `zh-Hans`             | `zh-CN`                        |
| `hindi`               | `hi`                  | `hi-IN`                        |
| `spanish`             | `es`                  | `es-ES`                        |
| `arabic`              | `ar`                  | `ar-SA`                        |
| `french`              | `fr`                  | `fr-FR`                        |
| `russian`             | `ru`                  | `ru-RU`                        |
| `japanese`            | `ja`                  | `ja-JP`                        |

* Translator language support lists "Chinese Simplified" as `zh-Hans` (Traditional is `zh-Hant`,
  Cantonese `yue`; neither is offered), and Hindi `hi`, Spanish `es`, Arabic `ar`, French `fr`
  (French (Canada) is the separate `fr-ca`, not offered), Russian `ru` and Japanese `ja`
  (checked 2026-10-29).
* The SSML voice page lists, among the speaking languages of `en-US-AndrewMultilingualNeural` and
  `en-US-EmmaMultilingualNeural` (the two voices MyDubb offers) through the `<lang xml:lang>`
  element: Chinese Mandarin `zh-CN`, Vietnamese `vi-VN`, Hindi (India) `hi-IN`, Spanish (Spain)
  `es-ES`, Arabic (Egypt) `ar-EG` and Arabic (Saudi Arabia) `ar-SA`, French (France) `fr-FR`,
  Russian (Russia) `ru-RU` and Japanese (Japan) `ja-JP` (checked 2026-10-29). The same voice reads
  every language.
* **Arabic** is translated into written Modern Standard Arabic (Translator has one `ar`) and read
  with the `ar-SA` accent, the one of the two offered locales whose formal reading is closer to
  Modern Standard Arabic (the Egyptian accent reads ج as "g"). It is one accent of one written
  standard, not a representation of spoken Arabic varieties or of other countries.

Vietnamese is the default: a request without the field, and every job stored before the field
existed, is Vietnamese.
"""

from enum import StrEnum


class TargetLanguage(StrEnum):
    VIETNAMESE = "vietnamese"
    MANDARIN = "mandarin_simplified"
    HINDI = "hindi"
    SPANISH = "spanish"
    ARABIC = "arabic"
    FRENCH = "french"
    RUSSIAN = "russian"
    JAPANESE = "japanese"

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

    @property
    def text_direction(self) -> str:
        """ "rtl" for a language written right to left (Arabic), else "ltr"."""
        return "rtl" if self is TargetLanguage.ARABIC else "ltr"


DEFAULT_TARGET_LANGUAGE = TargetLanguage.VIETNAMESE

_LABELS = {
    TargetLanguage.VIETNAMESE: "Vietnamese",
    TargetLanguage.MANDARIN: "Chinese — Mandarin (Simplified)",
    TargetLanguage.HINDI: "Hindi",
    TargetLanguage.SPANISH: "Spanish (Spain)",
    TargetLanguage.ARABIC: "Arabic (Modern Standard)",
    TargetLanguage.FRENCH: "French (France)",
    TargetLanguage.RUSSIAN: "Russian",
    TargetLanguage.JAPANESE: "Japanese",
}

_NOUNS = {
    TargetLanguage.VIETNAMESE: "Vietnamese",
    TargetLanguage.MANDARIN: "Mandarin Chinese",
    TargetLanguage.HINDI: "Hindi",
    TargetLanguage.SPANISH: "Spanish",
    TargetLanguage.ARABIC: "Arabic",
    TargetLanguage.FRENCH: "French",
    TargetLanguage.RUSSIAN: "Russian",
    TargetLanguage.JAPANESE: "Japanese",
}

_TRANSLATOR_CODES = {
    TargetLanguage.VIETNAMESE: "vi",
    TargetLanguage.MANDARIN: "zh-Hans",
    TargetLanguage.HINDI: "hi",
    TargetLanguage.SPANISH: "es",
    TargetLanguage.ARABIC: "ar",
    TargetLanguage.FRENCH: "fr",
    TargetLanguage.RUSSIAN: "ru",
    TargetLanguage.JAPANESE: "ja",
}

_SPEECH_LOCALES = {
    TargetLanguage.VIETNAMESE: "vi-VN",
    TargetLanguage.MANDARIN: "zh-CN",
    TargetLanguage.HINDI: "hi-IN",
    TargetLanguage.SPANISH: "es-ES",
    TargetLanguage.ARABIC: "ar-SA",
    TargetLanguage.FRENCH: "fr-FR",
    TargetLanguage.RUSSIAN: "ru-RU",
    TargetLanguage.JAPANESE: "ja-JP",
}
