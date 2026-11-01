"""Summarize a PostgreSQL log (log_statement=all, docker logs --timestamps) for an idle window.

Usage: analyze_idle.py LOG WINDOW_START_UTC OBSERVE_SECONDS [key=value ...]
Prints JSON. The benchmark's own monitoring queries (pg_stat_*, pg_isready) are excluded.
"""

import json
import re
import statistics
import sys
from collections import defaultdict
from datetime import UTC, datetime, timedelta

LINE = re.compile(r"^(\S+Z) \S+ \S+ \S+ \[\d+\] LOG:\s+(statement|execute [^:]*): (.*)$")
CONN = re.compile(r"^(\S+Z) .*LOG:\s+(connection authorized|disconnection)")
TX = {"BEGIN", "COMMIT", "ROLLBACK"}


def shape(sql: str) -> str:
    sql = re.sub(r"\s+", " ", sql).strip()
    sql = re.sub(r"'[^']*'", "'?'", sql)
    return sql[:160]


def parse_ts(text: str) -> datetime:
    text = text.rstrip("Z")
    head, _, frac = text.partition(".")
    return datetime.fromisoformat(head).replace(tzinfo=UTC) + timedelta(
        microseconds=int((frac + "000000")[:6])
    )


def main() -> None:
    path, start_text, observe = sys.argv[1], sys.argv[2], float(sys.argv[3])
    extra = dict(item.split("=", 1) for item in sys.argv[4:])
    start = parse_ts(start_text if start_text.endswith("Z") else start_text + "Z")
    end = start + timedelta(seconds=observe)
    times: dict[str, list[datetime]] = defaultdict(list)
    connections = 0
    with open(path, encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            m = CONN.match(raw)
            if m and start <= parse_ts(m.group(1)) < end:
                connections += 1
                continue
            m = LINE.match(raw)
            if not m:
                continue
            when = parse_ts(m.group(1))
            if not (start <= when < end):
                continue
            sql = shape(m.group(3))
            if "pg_stat_" in sql or "pg_backend_pid" in sql or "pg_isready" in sql:
                continue
            times[sql].append(when)
    rows = []
    for sql, stamps in times.items():
        gaps = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:])]
        rows.append(
            {
                "statement": sql,
                "count": len(stamps),
                "median_gap_s": round(statistics.median(gaps), 2) if gaps else None,
                "min_gap_s": round(min(gaps), 2) if gaps else None,
                "max_gap_s": round(max(gaps), 2) if gaps else None,
            }
        )
    rows.sort(key=lambda r: -r["count"])
    sql_rows = [r for r in rows if r["statement"] not in TX]
    # Longest stretch with no statement at all: Neon's 5-minute scale-to-zero needs >= 300 s.
    all_stamps = sorted(s for stamps in times.values() for s in stamps)
    edges = [start, *all_stamps, end]
    longest = max((b - a).total_seconds() for a, b in zip(edges, edges[1:]))
    print(
        json.dumps(
            {
                "window_start_utc": start.isoformat(),
                "observe_seconds": observe,
                "statements_total": sum(r["count"] for r in rows),
                "statements_excluding_begin_commit": sum(r["count"] for r in sql_rows),
                "connection_events": connections,
                "longest_gap_without_any_statement_s": round(longest, 1),
                "by_statement": rows,
                "extra": extra,
            },
            indent=2,
        )
    )


main()
