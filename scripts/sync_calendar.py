#!/usr/bin/env python3
"""
Pulls a public Google Calendar ICS feed, keeps only events whose title
matches a workout-split keyword (Upper/Push/Pull/Leg), expands recurring
events, and writes the resulting dates to workout-days.json for the
frontend to fetch (same-origin, no CORS issues).

Requires: CALENDAR_ICS_URL env var (kept as a GitHub Actions secret, never
printed to logs).
"""
import json
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta

from dateutil.rrule import rrulestr

KEYWORDS = ["upper", "push", "pull", "leg"]
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "workout-days.json")
LOOKAHEAD_DAYS = 30  # how far past "today" to still count a recurring occurrence
MAX_HISTORY_YEARS = 3  # don't expand recurrences further back than this


def unfold_ics(text):
    lines = text.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    return unfolded


def parse_ics_date(value, params):
    value = value.strip()
    if "VALUE=DATE" in params or (len(value) == 8 and "T" not in value):
        return datetime.strptime(value, "%Y%m%d").date()
    value = value.split("Z")[0]
    return datetime.strptime(value[:15], "%Y%m%dT%H%M%S").date()


def parse_vevents(lines):
    events = []
    current = None
    for raw in lines:
        if raw.strip() == "BEGIN:VEVENT":
            current = {}
        elif raw.strip() == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in raw:
            key_part, value = raw.split(":", 1)
            key_bits = key_part.split(";")
            key = key_bits[0]
            params = key_bits[1:]
            if key == "SUMMARY":
                current["summary"] = value.strip()
            elif key == "DTSTART":
                current["dtstart_raw"] = value
                current["dtstart_params"] = params
            elif key == "RRULE":
                current["rrule"] = value.strip()
            elif key == "EXDATE":
                current.setdefault("exdate_raw", []).append((value, params))
    return events


def matches_keywords(summary):
    s = (summary or "").lower()
    return any(k in s for k in KEYWORDS)


def expand_dates(ev):
    if "dtstart_raw" not in ev:
        return []
    dtstart_date = parse_ics_date(ev["dtstart_raw"], ev.get("dtstart_params", []))
    dtstart_dt = datetime(dtstart_date.year, dtstart_date.month, dtstart_date.day)

    if "rrule" not in ev:
        return [dtstart_date]

    exdates = set()
    for raw, params in ev.get("exdate_raw", []):
        for part in raw.split(","):
            try:
                exdates.add(parse_ics_date(part, params))
            except ValueError:
                continue

    horizon = datetime.combine(date.today() + timedelta(days=LOOKAHEAD_DAYS), datetime.min.time())
    floor = datetime.combine(date.today().replace(year=date.today().year - MAX_HISTORY_YEARS), datetime.min.time())
    try:
        rule = rrulestr(f"RRULE:{ev['rrule']}", dtstart=max(dtstart_dt, floor))
        occurrences = rule.between(floor, horizon, inc=True)
    except Exception as exc:
        print(f"warning: failed to expand RRULE for an event: {exc}", file=sys.stderr)
        return [dtstart_date]

    return [dt.date() for dt in occurrences if dt.date() not in exdates]


def main():
    ics_url = os.environ.get("CALENDAR_ICS_URL")
    if not ics_url:
        print("error: CALENDAR_ICS_URL is not set", file=sys.stderr)
        sys.exit(1)

    req = urllib.request.Request(ics_url, headers={"User-Agent": "workout-tracker-sync/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")

    lines = unfold_ics(text)
    events = parse_vevents(lines)

    days_map = {}
    for ev in events:
        summary = (ev.get("summary") or "").strip()
        if not matches_keywords(summary):
            continue
        for d in expand_dates(ev):
            days_map.setdefault(d.isoformat(), set()).add(summary)

    result = {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "keywords": KEYWORDS,
        "days": [
            {"date": day, "titles": sorted(t for t in titles if t)}
            for day, titles in sorted(days_map.items())
        ],
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(days_map)} workout day(s) to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
