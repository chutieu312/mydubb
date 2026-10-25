"""The shipped glossary file: format, selection policy (docs/GLOSSARY.md) and its use end to end.

Matching rules themselves are tested in test_glossary.py; these tests are about the entries.
"""

import pytest

from app.speech.ssml import ENGLISH, language_spans
from app.translation.glossary import DEFAULT_GLOSSARY_PATH, default_glossary
from app.translation.notranslate_markup import (
    parse_translated_markup,
    to_markup,
    verify_terms_preserved,
)


def found(text: str) -> list[str]:
    return [m.text for m in default_glossary().find_matches(text)]


def test_file_holds_only_entries_one_per_line_in_sorted_order():
    lines = DEFAULT_GLOSSARY_PATH.read_text(encoding="utf-8").split("\n")
    assert lines[-1] == ""  # ends with a newline
    lines = lines[:-1]
    assert all(line and line == line.strip() for line in lines)  # no blank or padded lines
    assert not [line for line in lines if line.startswith("#")]  # no comments or headings
    assert lines == sorted(lines, key=lambda line: (line.removeprefix("=").casefold(), line))
    assert len(default_glossary()) == len(lines)  # every line is one valid, unique entry


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Store it in Amazon S3, then query DynamoDB.", ["Amazon S3", "DynamoDB"]),
        (
            "Deploy to Azure Kubernetes Service or Google Kubernetes Engine.",
            ["Azure Kubernetes Service", "Google Kubernetes Engine"],
        ),
        (
            "Apache Kafka feeds Apache Spark and BigQuery.",
            ["Apache Kafka", "Apache Spark", "BigQuery"],
        ),
        ("Node.js, C++, C# and ASP.NET Core.", ["Node.js", "C++", "C#", "ASP.NET Core"]),
        ("We use scikit-learn and Hugging Face.", ["scikit-learn", "Hugging Face"]),
        (
            "retrieval-augmented generation with a vector database",
            ["retrieval-augmented generation", "vector database"],
        ),
        (
            "A convolutional neural network and a Vision Transformer.",
            ["convolutional neural network", "Vision Transformer"],
        ),
        (
            "Kubernetes, not the Azure Kubernetes Service name, here.",
            ["Kubernetes", "Azure Kubernetes Service"],
        ),
    ],
)
def test_product_names_and_phrases_match_as_one_term(text, expected):
    assert found(text) == expected


@pytest.mark.parametrize(
    ("protected", "ordinary"),
    [
        ("Use RAG here.", "Wipe it with a rag."),
        ("Train a GAN.", "Gan là một cơ quan."),
        ("The LAN is slow.", "Lan đi học."),
        ("Set ARIA labels.", "She sang an aria."),
        ("ACID transactions.", "An acid burns."),
        ("SOLID design.", "A solid table."),
        ("Fine-tune BERT.", "Bert is my uncle."),
        ("Write it in React.", "People react quickly."),
        ("Open Azure today.", "An azure sky."),
        ("Upload to Cloud Storage.", "Cheap cloud storage."),
    ],
)
def test_exact_case_entries_ignore_other_capitalizations(protected, ordinary):
    assert found(protected)
    assert found(ordinary) == []


@pytest.mark.parametrize(
    "spellings",
    [
        ("frontend", "front-end"),
        ("backend", "back-end"),
        ("pretraining", "pre-training"),
        ("Bayes' theorem", "Bayes theorem"),
        ("autoscaling", "auto scaling"),
    ],
)
def test_selected_alternative_spellings_are_all_listed(spellings):
    for spelling in spellings:
        assert found(f"About {spelling} today.") == [spelling]


@pytest.mark.parametrize(
    "text",
    [
        "The class went to the museum, then we had a model lunch at the table.",
        "Take a rest; go for a swim, and keep the key to the cell in the drawer.",
        "A flask of water, a curl of hair and two pandas at the zoo.",
        "Then sparks fly when the swift river meets the rust on the spring.",
        "The bridge, the factory and the observer met to talk about the strategy.",
        "We grew a ruby plant and drank java with a dart champion in the morning.",
        "Hôm nay Lan và Nam đi chợ, mùi tanh của cá, anh ấy xài điện thoại mới.",
        "Khong dau: Lan va Nam di hoc, mui tanh cua ca, xai dien thoai, con vit, gan.",
    ],
)
def test_ordinary_english_and_vietnamese_sentences_are_left_alone(text):
    # Speech matches the glossary on the Vietnamese translation too, so Vietnamese words and
    # names (with or without diacritics) must never be marked as English.
    assert found(text) == []


def test_known_limit_exact_case_names_are_also_matched_at_the_start_of_a_sentence():
    # "=Spark" cannot tell the product from an ordinary word written with a capital letter.
    assert found("Spark plugs wear out. React calmly.") == ["Spark", "React"]


SOURCE = (
    "Today we deploy a FastAPI backend to Amazon EKS with Terraform and GitHub Actions. "
    "The service reads events from Apache Kafka, stores embeddings in PostgreSQL with "
    "pgvector, and uses retrieval-augmented generation with a large language model. "
    "We adapt the model with LoRA, track runs in MLflow and watch p95 latency in Grafana. "
    "Take a rest after the lab; the class will go over the key ideas again."
)
# What a translation that keeps the protected spans could look like (no service is called).
TRANSLATION = (
    "Hôm nay chúng ta triển khai một backend FastAPI lên Amazon EKS bằng Terraform và GitHub "
    "Actions. Dịch vụ đọc sự kiện từ Apache Kafka, lưu embeddings trong PostgreSQL với "
    "pgvector, và dùng retrieval-augmented generation với một large language model. Chúng ta "
    "điều chỉnh model bằng LoRA, theo dõi trong MLflow và xem độ trễ p95 trong Grafana. Hãy "
    "nghỉ ngơi sau bài lab; lớp sẽ ôn lại các ý chính."
)
TERMS = [
    "FastAPI",
    "backend",
    "Amazon EKS",
    "Terraform",
    "GitHub Actions",
    "Apache Kafka",
    "embeddings",
    "PostgreSQL",
    "pgvector",
    "retrieval-augmented generation",
    "large language model",
    "LoRA",
    "MLflow",
    "Grafana",
]


def test_technical_transcript_is_protected_for_translation():
    matches = default_glossary().find_matches(SOURCE)
    assert sorted(m.text for m in matches) == sorted(TERMS)
    markup = to_markup(SOURCE, matches)
    assert '<span class="notranslate">Amazon EKS</span>' in markup
    assert '<span class="notranslate">retrieval-augmented generation</span>' in markup
    # Ordinary words of the last sentence stay translatable.
    assert "Take a rest after the lab; the class will go over the key ideas again." in markup
    parsed = parse_translated_markup(markup)
    assert parsed.text == SOURCE
    verify_terms_preserved([m.text for m in matches], parsed)


def test_technical_translation_reads_the_terms_in_english_and_the_rest_in_vietnamese():
    spans = language_spans(TRANSLATION, default_glossary())
    assert "".join(piece for _, piece in spans) == TRANSLATION
    english = [piece for language, piece in spans if language == ENGLISH]
    assert sorted(english) == sorted(TERMS)  # "model", "lab", "p95" are not glossary terms
    assert english[:3] == ["backend", "FastAPI", "Amazon EKS"]  # Vietnamese word order
