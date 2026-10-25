"""YouTube link validation: what is accepted, the canonical URL, and what is refused."""

import pytest

from app.youtube_import.youtube_url import InvalidYouTubeUrl, parse_youtube_url

VIDEO = "dQw4w9WgXcQ"
CANONICAL = f"https://www.youtube.com/watch?v={VIDEO}"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VIDEO}",
        f"https://youtube.com/watch?v={VIDEO}",
        f"https://m.youtube.com/watch?v={VIDEO}",
        f"https://WWW.YouTube.com/watch?v={VIDEO}",
        f"HTTPS://www.youtube.com/watch?v={VIDEO}",
        f"https://www.youtube.com/watch/?v={VIDEO}",
        f"https://www.youtube.com:443/watch?v={VIDEO}",
        f"  https://www.youtube.com/watch?v={VIDEO}  ",
        # Other parameters and the fragment are dropped, never forwarded.
        f"https://www.youtube.com/watch?v={VIDEO}&t=42s&list=PL123&index=3&si=abc",
        f"https://www.youtube.com/watch?feature=share&v={VIDEO}",
        f"https://www.youtube.com/watch?v={VIDEO}#t=30",
        f"https://youtu.be/{VIDEO}",
        f"https://youtu.be/{VIDEO}/",
        f"https://youtu.be/{VIDEO}?si=share-token&t=10",
        f"https://www.youtube.com/shorts/{VIDEO}",
        f"https://www.youtube.com/embed/{VIDEO}",
        f"https://www.youtube.com/live/{VIDEO}?feature=share",
    ],
)
def test_supported_links_become_the_canonical_watch_url(url):
    video = parse_youtube_url(url)
    assert video.video_id == VIDEO
    assert video.canonical_url == CANONICAL


def test_video_ids_keep_their_case_dashes_and_underscores():
    assert parse_youtube_url("https://youtu.be/A-b_C-d_E-f").video_id == "A-b_C-d_E-f"


@pytest.mark.parametrize(
    "url",
    [
        # Not https.
        f"http://www.youtube.com/watch?v={VIDEO}",
        f"ftp://www.youtube.com/watch?v={VIDEO}",
        f"//www.youtube.com/watch?v={VIDEO}",
        f"www.youtube.com/watch?v={VIDEO}",
        f"javascript:alert(1)//www.youtube.com/watch?v={VIDEO}",
        # Look-alike or unrelated hosts.
        f"https://youtube.com.example.org/watch?v={VIDEO}",
        f"https://www.youtube.com.example.org/watch?v={VIDEO}",
        f"https://evilyoutube.com/watch?v={VIDEO}",
        f"https://youtube.co/watch?v={VIDEO}",
        f"https://www.youtube.com./watch?v={VIDEO}",
        f"https://music.youtube.com/watch?v={VIDEO}",
        f"https://youtu.be.example.org/{VIDEO}",
        f"https://example.org/watch?v={VIDEO}",
        f"https://example.org/?u=https://www.youtube.com/watch?v={VIDEO}",
        "https://127.0.0.1/watch?v=dQw4w9WgXcQ",
        # Credentials and unusual ports.
        f"https://user:pass@www.youtube.com/watch?v={VIDEO}",
        f"https://user@www.youtube.com/watch?v={VIDEO}",
        f"https://www.youtube.com@evil.example/watch?v={VIDEO}",
        f"https://www.youtube.com:8443/watch?v={VIDEO}",
        f"https://www.youtube.com:notaport/watch?v={VIDEO}",
        # No single video.
        "https://www.youtube.com/playlist?list=PL9tY0BWXOZFuFEG_GtOBZ8-8wbkH-NVAr",
        "https://www.youtube.com/watch?list=PL9tY0BWXOZFuFEG_GtOBZ8-8wbkH-NVAr",
        f"https://www.youtube.com/watch?v={VIDEO}&v=aaaaaaaaaaa",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/watch?v=",
        "https://www.youtube.com/@RickAstley",
        "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
        "https://www.youtube.com/",
        "https://youtu.be/",
        # Malformed IDs.
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQX",
        "https://www.youtube.com/watch?v=dQw4w9WgXc%21",
        "https://www.youtube.com/watch?v=dQw4w9WgXc!",
        f"https://youtu.be/{VIDEO}/extra",
        f"https://www.youtube.com/shorts/{VIDEO}/extra",
        f"https://www.youtube.com/embed/{VIDEO}x",
        # Characters that URL parsers disagree on.
        f"https://www.youtube.com\\@evil.example/watch?v={VIDEO}",
        f"https://www.you tube.com/watch?v={VIDEO}",
        f"https://www.youtube.com/wat\nch?v={VIDEO}",
        f"https://www.youtube.com/watch?v={VIDEO}\x00",
        f"https://www.youtube.com/watch?v={VIDEO}\t&x=1",
        # Not a link.
        "",
        "   ",
        VIDEO,
        "https://" + "a" * 3000 + ".youtube.com/watch?v=" + VIDEO,
    ],
)
def test_other_links_are_refused(url):
    with pytest.raises(InvalidYouTubeUrl):
        parse_youtube_url(url)


def test_the_reason_is_specific_and_contains_no_input():
    with pytest.raises(InvalidYouTubeUrl, match="Only https"):
        parse_youtube_url(f"http://www.youtube.com/watch?v={VIDEO}")
    with pytest.raises(InvalidYouTubeUrl, match="playlist or channel") as error:
        parse_youtube_url("https://www.youtube.com/playlist?list=PLsecret")
    assert "PLsecret" not in str(error.value)
    with pytest.raises(InvalidYouTubeUrl, match="valid YouTube video ID"):
        parse_youtube_url("https://youtu.be/short")
