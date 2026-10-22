import xml.etree.ElementTree as ET

import pytest

from app.speech.ssml import build_ssml, escape_text
from app.speech.voices import Voice

NS = {"s": "http://www.w3.org/2001/10/synthesis"}
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"


@pytest.mark.parametrize(
    ("voice", "name"),
    [(Voice.HOAI_MY, "vi-VN-HoaiMyNeural"), (Voice.NAM_MINH, "vi-VN-NamMinhNeural")],
)
def test_each_approved_voice_maps_to_its_azure_voice(voice, name):
    root = ET.fromstring(build_ssml("Xin chào", voice))
    assert root.get(XML_LANG) == "vi-VN"
    assert [v.get("name") for v in root.findall("s:voice", NS)] == [name]


def test_only_two_voices_exist():
    assert {v.azure_voice_name for v in Voice} == {"vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"}


@pytest.mark.parametrize(
    "text",
    [
        "Tom & Jerry <b>bold</b> 5 > 3",
        '</voice><voice name="en-US-JennyNeural">Injected</voice>',
        '<audio src="https://evil.example/x.mp3"/>',
        "<break time='10s'/><phoneme alphabet='ipa' ph='x'>y</phoneme>",
        '<!DOCTYPE x [<!ENTITY e "boom">]>&e;',
        "<![CDATA[ x ]]> &amp; &#x41;",
        "a && b || c",
        "quote \" and ' apostrophe",
    ],
)
def test_user_text_is_only_ever_text_content_of_the_single_voice(text):
    root = ET.fromstring(build_ssml(text, Voice.NAM_MINH))
    assert [child.tag.split("}")[1] for child in root] == ["voice"]
    voice = root.find("s:voice", NS)
    assert voice.get("name") == "vi-VN-NamMinhNeural"
    assert len(voice) == 0  # no child elements at all
    assert voice.text == text  # lossless round trip


def test_characters_xml_cannot_carry_are_dropped_not_passed_through():
    root = ET.fromstring(build_ssml("a\x00b\x0bc\ud800d￾e", Voice.HOAI_MY))
    assert root.find("s:voice", NS).text == "abcde"


def test_whitespace_controls_and_vietnamese_text_are_kept():
    text = "Một neural network\tgiảm thiểu\nloss function"
    assert escape_text(text) == text
