"""Which English detection a job's target language uses (see each module for its rules).

* Vietnamese: `detector.py`, unchanged (Vietnamese syllable rule; the only one that records
  glossary candidates).
* Mandarin, Hindi, Arabic, Russian, Japanese, written in another script than Latin:
  `mandarin.detect_english_in_script` with the script of the language (`scripts.py`).
* Spanish, French, written in Latin letters: `latin.py`, which reads only certain English
  (glossary terms of the source, code, acronyms) with `en-US`.
"""

from collections.abc import Callable
from functools import partial

from app.languages import TargetLanguage
from app.pronunciation.detector import Detection, detect_english
from app.pronunciation.latin import detect_english_latin
from app.pronunciation.mandarin import detect_english_in_script
from app.pronunciation.scripts import script_of
from app.translation.glossary import Glossary

Detector = Callable[[str, str, Glossary], Detection]


def english_detector(language: TargetLanguage) -> Detector:
    if language is TargetLanguage.VIETNAMESE:
        return detect_english
    script = script_of(language)
    if script is None:
        return detect_english_latin
    return partial(detect_english_in_script, script=script)
