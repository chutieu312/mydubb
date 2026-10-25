import xml.etree.ElementTree as ET

import pytest

from app.speech.ssml import build_ssml, escape_text, language_spans
from app.speech.voices import DEFAULT_VOICE, Voice
from app.translation.glossary import Glossary, default_glossary
from tests.audio_helpers import NS, XML_LANG, ssml_spans, ssml_text, ssml_voice

GLOSSARY = default_glossary()

# The transcript the Product Owner auditioned and accepted, and its English spans.
ACCEPTED = (
    "Hôm nay chúng ta tìm hiểu cách một neural network học từ dữ liệu.\n"
    "Mô hình sử dụng gradient descent để giảm thiểu loss function.\n"
    "Spring Boot sử dụng Dependency Injection để quản lý các đối tượng.\n"
    "Ứng dụng gọi REST API, nhận dữ liệu JSON và chạy pipeline CI/CD."
)
ACCEPTED_TERMS = [
    "neural network",
    "gradient descent",
    "loss function",
    "Spring Boot",
    "Dependency Injection",
    "REST API",
    "JSON",
    "pipeline",
    "CI/CD",
]


def ssml(text: str, voice: Voice = Voice.ANDREW, glossary: Glossary = GLOSSARY) -> bytes:
    return build_ssml(text, voice, glossary).encode("utf-8")


@pytest.mark.parametrize(
    ("voice", "name", "label"),
    [
        (Voice.ANDREW, "en-US-AndrewMultilingualNeural", "Andrew Multilingual"),
        (Voice.EMMA, "en-US-EmmaMultilingualNeural", "Emma Multilingual"),
    ],
)
def test_each_approved_voice_maps_to_its_azure_voice(voice, name, label):
    root = ET.fromstring(ssml("Xin chào", voice))
    assert root.get(XML_LANG) == "en-US"
    assert [v.get("name") for v in root.findall("s:voice", NS)] == [name]
    assert voice.azure_voice_name == name
    assert voice.label == label


def test_only_the_two_multilingual_voices_exist_and_andrew_is_the_default():
    assert [v.value for v in Voice] == ["AndrewMultilingual", "EmmaMultilingual"]
    assert DEFAULT_VOICE is Voice.ANDREW
    assert "HoaiMy" not in [v.value for v in Voice]
    assert "NamMinh" not in [v.value for v in Voice]


def test_one_voice_holds_everything_and_the_children_are_only_language_spans():
    root = ET.fromstring(ssml(ACCEPTED, Voice.EMMA))
    assert [child.tag.split("}")[1] for child in root] == ["voice"]  # no second speaker
    voice = root.find("s:voice", NS)
    assert voice.text is None
    assert {child.tag.split("}")[1] for child in voice} == {"lang"}
    assert all(len(child) == 0 for child in voice)  # spans hold text only


def test_the_accepted_transcript_gets_vietnamese_and_english_spans_like_the_audition():
    spans = ssml_spans(ssml(ACCEPTED))
    english = [text for language, text in spans if language == "en-US"]
    assert english == ACCEPTED_TERMS
    assert {language for language, _ in spans} == {"vi-VN", "en-US"}
    # Spans alternate pieces of the text exactly as the accepted sample was built.
    assert spans[0] == ("vi-VN", "Hôm nay chúng ta tìm hiểu cách một ")
    assert spans[1] == ("en-US", "neural network")
    assert spans[-4:] == [
        ("en-US", "pipeline"),
        ("vi-VN", " "),
        ("en-US", "CI/CD"),
        ("vi-VN", "."),
    ]


def test_spans_never_change_spelling_case_whitespace_or_order():
    assert ssml_text(ssml(ACCEPTED)) == ACCEPTED
    text = "  Neural   NETWORK dùng JSON, Spring Boot và loss function. "
    assert ssml_text(ssml(text)) == text
    english = [t for language, t in ssml_spans(ssml(text)) if language == "en-US"]
    assert english == ["Neural   NETWORK", "JSON", "Spring Boot", "loss function"]


def test_the_longest_term_wins_where_terms_overlap():
    spans = language_spans("Dùng REST API và API khác.", GLOSSARY)
    assert [t for language, t in spans if language == "en-US"] == ["REST API", "API"]
    nested = Glossary.from_text("neural network\nconvolutional neural network")
    spans = language_spans("một convolutional neural network", nested)
    assert [t for language, t in spans if language == "en-US"] == ["convolutional neural network"]


def test_text_without_terms_is_one_vietnamese_span_and_empty_text_has_none():
    assert language_spans("Xin chào các bạn.", GLOSSARY) == [("vi-VN", "Xin chào các bạn.")]
    assert language_spans("", GLOSSARY) == []


def test_terms_outside_the_glossary_get_no_english_span():
    # The documented limit: no automatic detection of other English terms.
    spans = language_spans("Dùng Flask và Buildah.", GLOSSARY)
    assert spans == [("vi-VN", "Dùng Flask và Buildah.")]


@pytest.mark.parametrize(
    "text",
    [
        "Tom & Jerry <b>bold</b> 5 > 3 neural network",
        '</lang></voice><voice name="en-US-JennyNeural">Injected</voice>',
        '<audio src="https://evil.example/x.mp3"/> JSON',
        "<break time='10s'/><phoneme alphabet='ipa' ph='x'>y</phoneme> CI/CD",
        '<!DOCTYPE x [<!ENTITY e "boom">]>&e; loss function',
        "<![CDATA[ x ]]> &amp; &#x41; REST API",
        "a && b || c",
        "quote \" and ' apostrophe Spring Boot",
        '<lang xml:lang="fr-FR">bonjour</lang>',
    ],
)
def test_user_text_is_only_ever_text_content_of_a_span_of_the_single_voice(text):
    content = ssml(text, Voice.EMMA)
    root = ET.fromstring(content)
    assert [child.tag.split("}")[1] for child in root] == ["voice"]
    assert ssml_voice(content).get("name") == "en-US-EmmaMultilingualNeural"
    assert all(len(span) == 0 for span in ssml_voice(content))  # no child elements anywhere
    assert {span.get(XML_LANG) for span in ssml_voice(content)} <= {"vi-VN", "en-US"}
    assert ssml_text(content) == text  # lossless round trip


def test_characters_xml_cannot_carry_are_dropped_not_passed_through():
    content = ssml("a\x00b\x0bc\ud800d￾e JSON")
    assert ssml_text(content) == "abcde JSON"


def test_whitespace_controls_and_vietnamese_text_are_kept():
    text = "Một neural network\tgiảm thiểu\nloss function"
    assert escape_text(text) == text
