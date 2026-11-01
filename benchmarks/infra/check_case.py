"""Exit 0 only if one case's jsonl file is a complete, valid result.

Usage: check_case.py FILE EXPECTED_RUNS CONCURRENCY   (reasons go to stderr)
Run with `python -I`; the sibling module is found through the script directory below.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from checks import load_records, validate_case  # noqa: E402

path = Path(sys.argv[1])
records = load_records(path) if path.is_file() else []
reasons = (
    validate_case(records, int(sys.argv[2]), int(sys.argv[3])) if records else ["no output file"]
)
for reason in reasons:
    print(f"  FAIL {path.name}: {reason}", file=sys.stderr)
sys.exit(1 if reasons else 0)
