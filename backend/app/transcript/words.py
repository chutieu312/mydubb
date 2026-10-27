"""Word count of the text a job translates (the guest word limit).

Counted on the text prepared for translation (`CreateJobRequest.spoken_text`): the cleaned
transcript in plain mode, the blocks in timed mode. Timestamp lines, cue markup and blank lines
are already gone there, so they never count. A word is a whitespace-separated token with at
least one letter or digit, so a lone dash or bullet does not count. The UI's preview
(frontend/src/lib/wordCount.ts) follows the same rule; the server's count is the one that decides.
"""


def count_words(text: str) -> int:
    return sum(1 for token in text.split() if any(c.isalnum() for c in token))
