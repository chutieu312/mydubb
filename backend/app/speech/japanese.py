"""Japanese speech text: chunked like Mandarin (no spaces), with its own script.

`mandarin.chunk_unspaced` does the cutting (sentence, then clause punctuation, then between
characters; never inside a protected term or a Latin/number token). What Japanese adds: its
characters are Han characters and kana (`pronunciation/scripts.JAPANESE`, also the word
boundaries for term matching), and a cut never comes before a small kana, the prolonged sound mark
ー, an iteration mark, a combining mark (such as the combining dakuten) or a zero-width joiner,
which belong to the character before them. Its length estimate is in morae
(`spoken_units.py`).
"""

from functools import partial

from app.pronunciation.scripts import JAPANESE, ScriptBoundaryTerms
from app.speech.mandarin import UnspacedScript

_ATTACHED = frozenset(
    "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿｧｨｩｪｫｬｭｮｯ"
    "ーｰゝゞヽヾ々゛゜ﾞﾟ‍"
)

JAPANESE_SCRIPT = UnspacedScript(
    characters=JAPANESE,
    boundary_terms=partial(ScriptBoundaryTerms, script=JAPANESE),
    no_cut_before=_ATTACHED,
    keep_marks=True,
)
