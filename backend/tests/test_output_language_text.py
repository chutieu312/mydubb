# ruff: noqa: RUF001 (the scripts and punctuation of the languages are the subject of these tests)
"""Hindi, Spanish, Arabic, French, Russian and Japanese speech text, without Azure or a database.

The language mapping, English detection, chunking, SSML, spoken-length estimates and the timed-mode
block checks. The fake voice in the block tests reads by characters per second plus hand-written
readings of numbers and terms, independent of `spoken_units.py`, so the checks run against an
estimate that is only approximately right, as with a real voice.
"""

import random
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
from app.processing_errors import ProcessingError
from app.pronunciation.detector import SpanKind, detect_english
from app.pronunciation.policy import english_detector
from app.pronunciation.scripts import ScriptBoundaryTerms, script_of
from app.speech import mandarin, spaced
from app.speech.blocks import BREAK_MS, MAX_BLOCKS_PER_REQUEST, plan_block_requests
from app.speech.chunker import SpeechTextTooLongError, speech_text, split_for_speech
from app.speech.plan import chunk_spans, request_char_limit, syllable_estimate
from app.speech.spoken_length import spoken_syllables
from app.speech.ssml import build_ssml_from_spans, chunk_language_spans
from app.speech.voices import Voice
from app.translation.glossary import Glossary, default_glossary
from app.translation.mock import MockTranslationProvider
from tests.audio_helpers import tone_samples, wav_bytes
from tests.test_speech_blocks import PITCHES, pieces_of, pitch_of, provider_for, silence

GLOSSARY = default_glossary()
NS = "{http://www.w3.org/2001/10/synthesis}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

L = TargetLanguage
NEW = [L.HINDI, L.SPANISH, L.ARABIC, L.FRENCH, L.RUSSIAN, L.JAPANESE]
SPACED = [L.HINDI, L.SPANISH, L.ARABIC, L.FRENCH, L.RUSSIAN]
NON_LATIN = [L.HINDI, L.ARABIC, L.RUSSIAN, L.JAPANESE]
LATIN = [L.SPANISH, L.FRENCH]

# --- the mapping -----------------------------------------------------------------------------

MAPPING = [
    ("vietnamese", "Vietnamese", "Vietnamese", "vi", "vi-VN", "ltr"),
    (
        "mandarin_simplified",
        "Chinese — Mandarin (Simplified)",
        "Mandarin Chinese",
        "zh-Hans",
        "zh-CN",
        "ltr",
    ),
    ("hindi", "Hindi", "Hindi", "hi", "hi-IN", "ltr"),
    ("spanish", "Spanish (Spain)", "Spanish", "es", "es-ES", "ltr"),
    ("arabic", "Arabic (Modern Standard)", "Arabic", "ar", "ar-SA", "rtl"),
    ("french", "French (France)", "French", "fr", "fr-FR", "ltr"),
    ("russian", "Russian", "Russian", "ru", "ru-RU", "ltr"),
    ("japanese", "Japanese", "Japanese", "ja", "ja-JP", "ltr"),
]


def test_the_eight_languages_map_to_fixed_codes_in_order_with_vietnamese_first() -> None:
    assert DEFAULT_TARGET_LANGUAGE is L.VIETNAMESE
    assert [
        (
            language.value,
            language.label,
            language.noun,
            language.translator_code,
            language.speech_locale,
            language.text_direction,
        )
        for language in TargetLanguage
    ] == MAPPING


@pytest.mark.parametrize("language", NEW)
def test_mock_translation_names_its_own_language(language: TargetLanguage) -> None:
    result = MockTranslationProvider().translate_lines(["Hello there."], language)
    assert result.is_illustrative
    assert f"NOT a real {language.noun} translation" in result.text
    assert "Vietnamese" not in result.text and "(VI mock)" not in result.text
    assert result.lines[0].endswith("Hello there.")


# --- English detection ---------------------------------------------------------------------


def english(language: TargetLanguage, source: str, translation: str) -> list[str]:
    detection = english_detector(language)(source, translation, GLOSSARY)
    assert detection.candidates == ()  # only Vietnamese feeds the legacy candidate store
    return [span.text for span in detection.spans]


@pytest.mark.parametrize(
    ("language", "translation"),
    [
        (L.HINDI, "हम Kubernetes पर REST API तैनात करते हैं।"),
        (L.ARABIC, "ننشر Kubernetes وواجهة REST API."),
        (L.RUSSIAN, "Мы развернём Kubernetesом и REST API."),
        (L.JAPANESE, "KubernetesでREST APIをデプロイします。"),
        (L.SPANISH, "Desplegamos Kubernetes y una REST API."),
        (L.FRENCH, "Nous déployons Kubernetes et une REST API."),
    ],
)
def test_glossary_terms_of_the_source_are_english_in_every_language(
    language: TargetLanguage, translation: str
) -> None:
    source = "We deploy a REST API on Kubernetes."
    assert english(language, source, translation) == ["Kubernetes", "REST API"]


@pytest.mark.parametrize("language", NON_LATIN)
def test_a_latin_word_copied_from_the_source_is_english_in_a_non_latin_language(
    language: TargetLanguage,
) -> None:
    sample = {
        L.HINDI: "फिर run और Go चलाएँ, image नहीं।",
        L.ARABIC: "ثم شغّل run و Go وليس image.",
        L.RUSSIAN: "Затем запустите run и Go, не image.",
        L.JAPANESE: "次にrunとGoを実行します、imageではない。",
    }[language]
    # "run" and "Go" are in the source; "image" is not, so it keeps the target locale.
    assert english(language, "Then call run and Go.", sample) == ["run", "Go"]


@pytest.mark.parametrize("language", LATIN)
def test_spanish_and_french_never_take_an_ordinary_latin_word_for_english(
    language: TargetLanguage,
) -> None:
    source = "The image is simple, local and important. Use the CPU and /usr/bin/env."
    translation = {
        L.SPANISH: "La image es simple, local e important. Use la CPU y /usr/bin/env.",
        L.FRENCH: "L'image est simple, local et important. Utilisez le CPU et /usr/bin/env.",
    }[language]
    # Words shared with English stay es-ES / fr-FR even though the source holds them; the
    # acronym copied with its capitals and the code copied verbatim are English.
    assert english(language, source, translation) == ["CPU", "/usr/bin/env"]


@pytest.mark.parametrize(
    ("language", "translation"),
    [
        (L.FRENCH, "Vue d'ensemble : le Tableau de bord."),
        (L.SPANISH, "Angular es un concepto; el Tableau final."),
    ],
)
def test_a_glossary_term_the_source_does_not_contain_is_a_word_of_the_language(
    language: TargetLanguage, translation: str
) -> None:
    # `=Vue`, `=Tableau` and `=Angular` are glossary terms, and also French/Spanish words.
    assert english(language, "An overview of the dashboard.", translation) == []
    assert english(language, "Vue, Tableau and Angular overview.", translation) != []


def test_vietnamese_detection_is_still_the_vietnamese_one() -> None:
    assert english_detector(L.VIETNAMESE) is detect_english
    detection = detect_english("Use the runtime.", "Dùng runtime nhé.", GLOSSARY)
    assert [(s.text, s.kind) for s in detection.spans] == [("runtime", SpanKind.TERM)]


# --- chunking ------------------------------------------------------------------------------


def chunk_texts(language: TargetLanguage, text: str, max_chars: int = 2000, terms=GLOSSARY):
    return [
        "".join(piece for _, piece in spans)
        for spans in chunk_spans(text, terms, max_chars, language)
    ]


SENTENCES = {
    L.HINDI: [
        "हम Kubernetes पर सेवा तैनात करते हैं।",
        "त्रुटि दर 0.4% थी, संस्करण v2.1 में।",
        "क्या आप REST API का उपयोग करते हैं?",
        "प्रशिक्षण में gradient descent और loss function शामिल हैं।",
    ],
    L.SPANISH: [
        "El Sr. García despliega Kubernetes, p. ej. con Node.js.",
        "La tasa de error fue del 0,4 % en la versión v2.1.",
        "¿Usamos la REST API? ¡Claro que sí!",
        "Incluye gradient descent y loss function, etc.",
    ],
    L.ARABIC: [
        "ننشر الخدمة باستخدام Kubernetes.",
        "كان معدل الخطأ 0.4% في الإصدار v2.1.",
        "هل تستخدم REST API؟",
        "يتضمن التدريب gradient descent و loss function.",
    ],
    L.FRENCH: [
        "M. Dupont déploie Kubernetes, p. ex. avec Node.js.",
        "Le taux d'erreur était de 0,4 % dans la version v2.1 : 1 024 requêtes.",
        "Utilisez-vous la REST API ? « Oui » !",
        "Cela inclut gradient descent et loss function.",
    ],
    L.RUSSIAN: [
        "Мы развёртываем сервис на Kubernetes, т. е. в кластере.",
        "Доля ошибок была 0,4 % в версии v2.1: 1 024 запроса.",
        "Вы используете REST API? Да!",
        "Обучение включает gradient descent и loss function.",
    ],
    L.JAPANESE: [
        "Kubernetesでサービスをデプロイします。",
        "エラー率はバージョンv2.1で0.4%でした。",
        "REST APIを使いますか？",
        "キャッシュとgradient descentとloss functionを含みます。",
    ],
}
UNSPLITTABLE = {
    "Kubernetes",
    "REST API",
    "gradient descent",
    "loss function",
    "Node.js",
    "v2.1",
    "0.4%",
    "0,4 %",
    "1 024",
}


def long_text(language: TargetLanguage, seed: int, sentences: int = 120) -> str:
    rng = random.Random(seed)  # noqa: S311 (test data, not security)
    joiner = "" if language is L.JAPANESE else " "
    lines = []
    for _ in range(4):
        lines.append(joiner.join(rng.choice(SENTENCES[language]) for _ in range(sentences // 4)))
    return "\n".join(lines)


@pytest.mark.parametrize("seed", range(10))
@pytest.mark.parametrize("language", NEW)
def test_long_text_is_chunked_completely_in_order_within_the_limit(
    language: TargetLanguage, seed: int
) -> None:
    text = long_text(language, seed)
    limit = random.Random(seed).choice([200, 300, 450])  # noqa: S311 (test data)
    chunks = chunk_texts(language, text, limit)
    full = speech_text(text)
    assert all(len(chunk) <= request_char_limit(language, limit) for chunk in chunks)
    # Nothing lost, repeated or reordered: the chunks are consecutive pieces of the text and only
    # whitespace lies between them.
    position = 0
    for chunk in chunks:
        found = full.index(chunk, position)
        assert not full[position:found].strip()
        position = found + len(chunk)
    assert not full[position:].strip()
    assert re.sub(r"\s", "", "".join(chunks)) == re.sub(r"\s", "", full)
    # No chunk starts with punctuation that belongs to the word before, or a small kana.
    for chunk in chunks[1:]:
        assert chunk[0] not in "!?:;»%ゃゅょっャュョッー", chunk[:20]


@pytest.mark.parametrize("language", NEW)
def test_chunk_boundaries_never_cut_a_protected_term_or_token(language: TargetLanguage) -> None:
    text = long_text(language, 1)
    full = speech_text(text)
    chunks = chunk_texts(language, text, 200)
    cuts, position = [], 0
    for chunk in chunks:
        start = full.index(chunk, position)
        cuts.append(start)
        position = start + len(chunk)
    for term in UNSPLITTABLE:
        for match in re.finditer(re.escape(term), full):
            assert not any(match.start() < cut < match.end() for cut in cuts), term


def test_a_spaced_sentence_ends_at_the_languages_own_marks_and_not_after_abbreviations() -> None:
    def cut(language: TargetLanguage, line: str, limit: int) -> list[str]:
        return chunk_texts(language, line, limit)

    hindi = "यह पहला वाक्य है। यह दूसरा वाक्य है।"
    assert cut(L.HINDI, hindi, 25) == ["यह पहला वाक्य है।", "यह दूसरा वाक्य है।"]
    arabic = "هل هذا سؤال؟ نعم هذا جواب."
    assert cut(L.ARABIC, arabic, 15) == ["هل هذا سؤال؟", "نعم هذا جواب."]
    # "Sr." and "p. ej." do not end the sentence: the cut is at the real end.
    spanish = "El Sr. García llega hoy. Mañana sale."
    assert cut(L.SPANISH, spanish, 30) == ["El Sr. García llega hoy.", "Mañana sale."]
    french = "M. Dupont arrive. Il part."
    assert cut(L.FRENCH, french, 20) == ["M. Dupont arrive.", "Il part."]


@pytest.mark.parametrize(
    ("language", "atom", "ends"),
    [
        (L.SPANISH, "Sr.", False),
        (L.SPANISH, "ej.", False),
        (L.SPANISH, "hoy.", True),
        (L.SPANISH, "(J.", False),  # an initial
        (L.FRENCH, "Mme.", False),
        (L.FRENCH, "e.g.", False),
        (L.FRENCH, "fin.", True),
        (L.FRENCH, "fin »", False),
        (L.RUSSIAN, "т.е.", False),
        (L.RUSSIAN, "конец.", True),
        (L.HINDI, "है।", True),
        (L.ARABIC, "سؤال؟", True),
        (L.ARABIC, "3.14", False),
    ],
)
def test_sentence_ends_of_each_spaced_language(
    language: TargetLanguage, atom: str, ends: bool
) -> None:
    assert spaced._sentence_end(language)(atom) is ends


def test_french_spaced_punctuation_and_grouped_numbers_stay_with_their_word() -> None:
    line = "Bonjour à tous ! Nous avons 1 024 requêtes : environ 50 % de plus."
    for limit in range(20, 40):
        for chunk in chunk_texts(L.FRENCH, line, limit):
            assert not chunk.startswith(("!", ":", "%", "024")), (limit, chunk)


def test_japanese_is_never_cut_before_a_small_kana_a_long_mark_or_a_combining_mark() -> None:
    dakuten = chr(0x3099)  # combining voiced sound mark
    text = ("キャッシュサーバーのチューニング" + "か" + dakuten + "ちょうど") * 40
    for limit in (37, 41, 53, 97):
        chunks = chunk_texts(L.JAPANESE, text, limit)
        assert "".join(chunks) == text
        for chunk in chunks[1:]:
            assert chunk[0] not in "ャュョッーゃゅょっ" + dakuten


def test_japanese_and_mandarin_requests_keep_the_lower_limit() -> None:
    assert request_char_limit(L.JAPANESE, 2000) == request_char_limit(L.MANDARIN, 2000) == 600
    for language in [*SPACED, L.VIETNAMESE]:
        assert request_char_limit(language, 2000) == 2000


def test_a_token_longer_than_the_limit_is_refused_not_cut() -> None:
    with pytest.raises(SpeechTextTooLongError):
        chunk_texts(L.SPANISH, "a " + "x" * 300, 200)
    with pytest.raises(SpeechTextTooLongError):
        chunk_texts(L.JAPANESE, "これは" + "A" * 700 + "です", 2000)


@pytest.mark.parametrize("language", [L.HINDI, L.ARABIC, L.RUSSIAN])
def test_a_term_glued_to_letters_of_the_script_is_still_found(language: TargetLanguage) -> None:
    word = {L.HINDI: "कोKubernetesका", L.ARABIC: "وKubernetesو", L.RUSSIAN: "сKubernetesом"}
    terms = ScriptBoundaryTerms(GLOSSARY, script_of(language))
    [match] = terms.find_matches(word[language])
    assert match.text == "Kubernetes"
    assert GLOSSARY.find_matches(word[language]) == []  # without the script boundary


def test_vietnamese_and_mandarin_keep_their_own_chunkers_and_estimates() -> None:
    text = "Đây là REST API trên Kubernetes. " * 100
    chunks = split_for_speech(text, GLOSSARY, 300)
    assert chunk_spans(text, GLOSSARY, 300, L.VIETNAMESE) == chunk_language_spans(
        speech_text(text), chunks, GLOSSARY
    )
    chinese = "我们在Kubernetes上部署REST API。" * 50
    assert chunk_spans(chinese, GLOSSARY, 2000, L.MANDARIN) == mandarin.chunk_spans(
        chinese, GLOSSARY, 2000, "zh-CN"
    )
    assert syllable_estimate(L.VIETNAMESE) is spoken_syllables
    assert syllable_estimate(L.MANDARIN) is mandarin.mandarin_syllables


# --- SSML ----------------------------------------------------------------------------------


@pytest.mark.parametrize("language", NEW)
def test_ssml_has_one_voice_the_target_locale_english_terms_and_escaped_text(
    language: TargetLanguage,
) -> None:
    text = {
        L.HINDI: 'हम <b> & Kubernetes "x" चलाते हैं।',
        L.SPANISH: 'Usamos <b> & Kubernetes "x".',
        L.ARABIC: 'نستخدم <b> & Kubernetes "x".',
        L.FRENCH: 'Nous utilisons <b> & Kubernetes "x".',
        L.RUSSIAN: 'Мы используем <b> & Kubernetes "x".',
        L.JAPANESE: '<b>&Kubernetes"x"を使います。',
    }[language]
    [spans] = chunk_spans(text, GLOSSARY, 2000, language)
    ssml = build_ssml_from_spans(spans, Voice.EMMA)
    root = ET.fromstring(ssml)  # well-formed: the user text cannot add elements
    assert root.get(XML_LANG) == "en-US"
    [voice] = root.findall(f"{NS}voice")
    assert voice.get("name") == "en-US-EmmaMultilingualNeural"
    assert [child.tag for child in voice] == [f"{NS}lang"] * len(voice)
    langs = [(child.get(XML_LANG), child.text) for child in voice]
    assert {lang for lang, _ in langs} == {language.speech_locale, "en-US"}
    assert [t for lang, t in langs if lang == "en-US"] == ["Kubernetes"]
    assert "".join(t for _, t in langs) == text
    assert "<b>" not in ssml and "&lt;b&gt;" in ssml and "&amp;" in ssml


# --- spoken length -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        (L.HINDI, "नमस्ते", 3),
        (L.HINDI, "कंप्यूटर", 3),
        (L.HINDI, "भारत", 2),
        (L.ARABIC, "كتاب", 2),
        (L.ARABIC, "المدرسة", 4),
        (L.SPANISH, "computadora", 5),
        (L.FRENCH, "base", 1),
        (L.FRENCH, "ordinateur", 4),
        (L.RUSSIAN, "компьютер", 3),
        (L.JAPANESE, "キャッシュ", 3),  # キ ャ ッ シ ュ: kya-s-shu
        (L.JAPANESE, "日本", 4),
        (L.SPANISH, "CPU", 3),
        (L.ARABIC, "API", 3),
        (L.FRENCH, "!?.,", 0),
    ],
)
def test_word_estimates(language: TargetLanguage, text: str, expected: float) -> None:
    assert syllable_estimate(language)(text) == expected


@pytest.mark.parametrize("language", NEW)
def test_numbers_are_estimated_by_their_reading_and_any_digits_count(
    language: TargetLanguage,
) -> None:
    estimate = syllable_estimate(language)
    assert estimate("2026") > estimate("26") > estimate("6") > 0
    assert estimate("1,024") == estimate("1024")
    assert estimate("3.14") > estimate("3")
    assert estimate("50%") == estimate("50") + estimate("%") > estimate("50")
    assert estimate("०१२") == estimate("٠١٢") == estimate("012")  # Devanagari, Arabic-Indic
    assert estimate("0042") == 4 * estimate("4")  # leading zero: digit by digit


@pytest.mark.parametrize("language", NEW)
def test_estimates_grow_with_text_and_ignore_punctuation(language: TargetLanguage) -> None:
    estimate = syllable_estimate(language)
    sentence = SENTENCES[language][0]
    assert estimate(sentence) > 5
    assert estimate(sentence + sentence) == pytest.approx(2 * estimate(sentence), abs=0.01)
    assert estimate("。、，！？.,;:!?()«»「」") == 0


# --- timed-mode blocks with a fake voice ---------------------------------------------------

BLOCKS = {
    L.HINDI: [
        "सामान्य तौर पर, अगर कोई कंपनी को सफल बनाना चाहता है, तो उसे बहुत मेहनत करनी चाहिए।",
        "हम Kubernetes और एक REST API के साथ सेवा तैनात करते हैं।",
        "त्रुटि दर 2% से घटकर 0.4% हो गई, यह 2026 में हुआ।",
        "हम API को कॉल करते हैं और 1,024 रिकॉर्ड SQL में सहेजते हैं।",
        "धन्यवाद, और अगले पाठ में मिलते हैं।",
    ],
    L.SPANISH: [
        "En general, si alguien intenta que una empresa funcione, debe esperar trabajar muchísimo.",
        "Desplegamos el servicio con Kubernetes y una REST API.",
        "La tasa de error bajó del 2 % al 0,4 % en 2026.",
        "Llamamos a la API y guardamos 1.024 registros en SQL.",
        "Gracias, y nos vemos en la próxima lección.",
    ],
    L.ARABIC: [
        "بشكل عام، إذا كان شخص ما يحاول إنجاح شركة، فعليه أن يتوقع العمل بجد كبير.",
        "نقوم بنشر الخدمة باستخدام Kubernetes وواجهة REST API.",
        "انخفض معدل الخطأ من 2% إلى 0.4% في عام 2026.",
        "نستدعي API ونحفظ 1,024 سجلا في SQL.",
        "شكرا لكم، ونلتقي في الدرس القادم.",
    ],
    L.FRENCH: [
        "En général, si quelqu'un essaie de faire fonctionner une entreprise, il doit s'attendre "
        "à travailler très dur.",
        "Nous déployons le service avec Kubernetes et une REST API.",
        "Le taux d'erreur est passé de 2 % à 0,4 % en 2026.",
        "Nous appelons l'API et enregistrons 1 024 lignes dans SQL.",
        "Merci, et à bientôt pour la prochaine leçon !",
    ],
    L.RUSSIAN: [
        "В целом, если кто-то пытается наладить работу компании, ему стоит ожидать очень "
        "тяжёлой работы.",
        "Мы разворачиваем сервис с помощью Kubernetes и REST API.",
        "Частота ошибок снизилась с 2 % до 0,4 % в 2026 году.",
        "Мы вызываем API и сохраняем 1 024 записи в SQL.",
        "Спасибо, увидимся на следующем уроке.",
    ],
    L.JAPANESE: [
        "一般的に、誰かが会社をうまく機能させようとするなら、非常に懸命に働くことを覚悟すべきです。",
        "KubernetesとREST APIを使ってサービスをデプロイします。",
        "エラー率は2026年に2%から0.4%に下がりました。",
        "APIを呼び出して、1,024件のレコードをSQLに保存します。",
        "ありがとうございました。次のレッスンでお会いしましょう。",
    ],
}
# Characters per second of ordinary text, and seconds for tokens read otherwise.
CHARS_PER_SECOND = {L.HINDI: 13, L.SPANISH: 14, L.ARABIC: 11, L.FRENCH: 14, L.RUSSIAN: 14}
CHARS_PER_SECOND[L.JAPANESE] = 7
READINGS = {
    "Kubernetes": 0.8,
    "REST": 0.35,
    "API": 0.6,
    "SQL": 0.6,
    "2026": 1.3,
    "2": 0.3,
    "0.4": 0.8,
    "0,4": 0.8,
    "1,024": 1.4,
    "1.024": 1.4,
    "1 024": 1.4,
    "%": 0.4,
}
_TOKEN = re.compile(r"\d+(?:[., ]\d+)*|Kubernetes|REST|API|SQL|%")
# A short pause after clause and sentence punctuation (not inside "0,4" or "1.024").
_PAUSE = re.compile(r"(?:(?<=[,.!?।،])(?=\s|$))|(?<=[。、！？])")


def seconds_of(language: TargetLanguage, text: str) -> float:
    total = sum(READINGS[m.group().strip()] for m in _TOKEN.finditer(text))
    rest = _TOKEN.sub("", text)
    letters = sum(1 for char in rest if char.isalnum())
    return total + letters / CHARS_PER_SECOND[language]


def fake_voice(
    language: TargetLanguage,
    texts: list[str],
    *,
    slow_block: int | None = None,
    drop_break: int | None = None,
) -> Callable[[httpx.Request], httpx.Response]:
    def respond(request: httpx.Request) -> httpx.Response:
        samples = silence(0.05)
        for number, piece in enumerate(pieces_of(request)):
            if number:
                gap = 0.4 if number - 1 == drop_break else BREAK_MS / 1000
                samples.extend(silence(gap, 60))
            block = next(i for i, text in enumerate(texts) if piece in text)
            slow = 3 if block == slow_block else 1
            for clause in _PAUSE.split(piece):
                if clause.strip():
                    seconds = seconds_of(language, clause) * slow
                    samples.extend(tone_samples(seconds, PITCHES[block % len(PITCHES)]))
                    samples.extend(silence(0.25))
        samples.extend(silence(0.3))
        return httpx.Response(200, content=wav_bytes(samples))

    return respond


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "work"
    directory.mkdir()
    return directory


@pytest.mark.parametrize("voice", [Voice.ANDREW, Voice.EMMA])
@pytest.mark.parametrize("language", NEW)
def test_blocks_with_numbers_acronyms_and_terms_map_to_their_own_clips(
    work_dir: Path, language: TargetLanguage, voice: Voice
) -> None:
    texts = BLOCKS[language]
    provider, calls = provider_for(fake_voice(language, texts))
    speech = provider.synthesize_blocks(texts, voice, work_dir, language=language)
    assert len(calls) == 1 and speech.requests == 1
    assert pieces_of(calls[0]) == texts  # every character, in order
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[: len(texts)]
    root = ET.fromstring(calls[0].content)
    [element] = root.findall(f"{NS}voice")
    assert element.get("name") == voice.azure_voice_name
    spans = [(c.get(XML_LANG), c.text) for c in element if c.tag == f"{NS}lang"]
    assert {lang for lang, _ in spans} == {language.speech_locale, "en-US"}
    assert [t for lang, t in spans if lang == "en-US"] == ["Kubernetes", "REST API", "API", "SQL"]


@pytest.mark.parametrize("language", NEW)
def test_a_block_read_three_times_too_long_is_rejected_without_retry(
    work_dir: Path, language: TargetLanguage, caplog: pytest.LogCaptureFixture
) -> None:
    texts = BLOCKS[language]
    provider, calls = provider_for(fake_voice(language, texts, slow_block=1))
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(texts, Voice.ANDREW, work_dir, language=language)
    assert error.value.code == "speech_block_split_failed"
    assert "inconsistent_" in caplog.text and len(calls) == 1


@pytest.mark.parametrize("language", NEW)
def test_a_missing_break_fails_the_request_without_retry(
    work_dir: Path, language: TargetLanguage
) -> None:
    texts = BLOCKS[language]
    provider, calls = provider_for(fake_voice(language, texts, drop_break=0))
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(texts, Voice.ANDREW, work_dir, language=language)
    assert error.value.code == "speech_block_split_failed"
    assert len(calls) == 1


@pytest.mark.parametrize("language", NEW)
def test_long_blocks_split_across_requests_and_rejoin(
    work_dir: Path, language: TargetLanguage
) -> None:
    texts = BLOCKS[language]
    joiner = "" if language is L.JAPANESE else " "
    long_block = joiner.join([texts[0]] * 30)
    blocks = [texts[1], long_block, texts[4]]
    requests = plan_block_requests(blocks, GLOSSARY, 2000, language)
    assert len(requests) >= 2
    assert all(r.chars <= request_char_limit(language, 2000) for r in requests)
    assert all(r.language is language for r in requests)
    pieces = [piece for request in requests for piece in request.pieces]
    for index, text in enumerate(blocks):
        joined = joiner.join(p.text for p in pieces if p.block == index)
        assert joined == speech_text(text)
    provider, calls = provider_for(fake_voice(language, blocks))
    speech = provider.synthesize_blocks(blocks, Voice.ANDREW, work_dir, language=language)
    assert len(calls) == len(requests) and len(speech.clips) == 3


def test_the_block_limit_per_request_is_the_same_for_every_language() -> None:
    for language in NEW:
        texts = [f"{BLOCKS[language][4][:8]} {i}" for i in range(MAX_BLOCKS_PER_REQUEST + 5)]
        requests = plan_block_requests(texts, GLOSSARY, 4000, language)
        assert [len(r.pieces) for r in requests] == [MAX_BLOCKS_PER_REQUEST, 5]


def test_a_glossary_with_a_language_word_is_not_english_in_speech_for_french() -> None:
    glossary = Glossary([("Vue", True), ("Kubernetes", False)])
    source = "Kubernetes overview."
    translation = "Vue d'ensemble de Kubernetes."
    detection = english_detector(L.FRENCH)(source, translation, glossary)
    [spans] = chunk_spans(translation, detection.speech_terms, 2000, L.FRENCH)
    assert [t for lang, t in spans if lang == "en-US"] == ["Kubernetes"]
