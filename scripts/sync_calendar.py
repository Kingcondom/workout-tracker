#!/usr/bin/env python3
"""
Pulls a Google Calendar ICS feed and writes workout-days.json for the
frontend to fetch (same-origin, so no CORS issues).

Two things are produced:

  days     - planned workout days, with the event title, for the calendar
             page. Titles here are gym splits (Push/Pull/Leg) only.
  schedule - every event in a window around today, reduced to a CATEGORY
             and a TIME. Event titles are deliberately NOT written here:
             this file is published in a public repo, so the calendar's
             contents must not leak. Only "there was a class 08:00-16:00"
             is exposed, never what the event was called.

Requires: CALENDAR_ICS_URL env var (kept as a GitHub Actions secret, never
printed to logs).
"""
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr

# Gym splits that count as a planned workout day.
KEYWORDS = ["upper", "push", "pull", "leg"]

# Checked in order, so put the more specific category first (an exam is
# not a lecture even though both are school).
CATEGORIES = [
    ("exam", "📝", "สอบ", ["สอบ", "exam", "quiz", "midterm", "final", "osce"]),
    ("class", "📚", "เรียน", ["เรียน", "lecture", "class", "บรรยาย", "lab", "ปฏิบัติการ", "ติว"]),
    ("ward", "🏥", "วอร์ด", ["ward", "วอร์ด", "round", "ราวด์", "เวร", "opd", "รพ.", "ผู้ป่วย", "คลินิก"]),
    ("workout", "🏋️", "ออกกำลังกาย", KEYWORDS + ["gym", "ยิม", "ออกกำลังกาย", "เวท", "วิ่ง", "ว่ายน้ำ"]),
    ("meeting", "💼", "ประชุม", ["meeting", "ประชุม", "นัด", "appointment"]),
]
OTHER_CATEGORY = ("other", "📌", "อื่นๆ")

LOCAL_TZ = ZoneInfo("Asia/Bangkok")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "workout-days.json")
LOOKAHEAD_DAYS = 30      # how far past today a recurring workout still counts
MAX_HISTORY_YEARS = 3    # don't expand recurrences further back than this
SCHEDULE_BACK_DAYS = 7   # window written to `schedule`
SCHEDULE_AHEAD_DAYS = 14


def unfold_ics(text):
    lines = text.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    return unfolded


def unescape_ics_text(value):
    # RFC 5545 escapes commas, semicolons, backslashes and newlines in text.
    return (
        value.replace("\\n", " ").replace("\\N", " ")
        .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
    )


def parse_ics_moment(value, params):
    """Returns (date, "HH:MM" or None). None means an all-day event."""
    value = value.strip()
    if "VALUE=DATE" in params or (len(value) == 8 and "T" not in value):
        return datetime.strptime(value, "%Y%m%d").date(), None

    is_utc = value.endswith("Z")
    dt = datetime.strptime(value.rstrip("Z")[:15], "%Y%m%dT%H%M%S")
    if is_utc:
        dt = dt.replace(tzinfo=timezone.utc).astimezone(LOCAL_TZ)
    return dt.date(), dt.strftime("%H:%M")


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
                current["summary"] = unescape_ics_text(value.strip())
            elif key == "DTSTART":
                current["dtstart_raw"] = value
                current["dtstart_params"] = params
            elif key == "DTEND":
                current["dtend_raw"] = value
                current["dtend_params"] = params
            elif key == "RRULE":
                current["rrule"] = value.strip()
            elif key == "EXDATE":
                current.setdefault("exdate_raw", []).append((value, params))
    return events


def matches_keywords(summary):
    s = (summary or "").lower()
    return any(k in s for k in KEYWORDS)


def categorize(summary):
    s = (summary or "").lower()
    for _, emoji, label, words in CATEGORIES:
        if any(w in s for w in words):
            return emoji, label
    return OTHER_CATEGORY[1], OTHER_CATEGORY[2]


def expand_dates(ev):
    if "dtstart_raw" not in ev:
        return []
    start_date, _ = parse_ics_moment(ev["dtstart_raw"], ev.get("dtstart_params", []))
    dtstart_dt = datetime(start_date.year, start_date.month, start_date.day)

    if "rrule" not in ev:
        return [start_date]

    exdates = set()
    for raw, params in ev.get("exdate_raw", []):
        for part in raw.split(","):
            try:
                exdates.add(parse_ics_moment(part, params)[0])
            except ValueError:
                continue

    horizon = datetime.combine(date.today() + timedelta(days=LOOKAHEAD_DAYS), datetime.min.time())
    floor = datetime.combine(
        date.today().replace(year=date.today().year - MAX_HISTORY_YEARS), datetime.min.time()
    )
    try:
        rule = rrulestr(f"RRULE:{ev['rrule']}", dtstart=max(dtstart_dt, floor))
        occurrences = rule.between(floor, horizon, inc=True)
    except Exception as exc:
        print(f"warning: failed to expand RRULE for an event: {exc}", file=sys.stderr)
        return [start_date]

    return [dt.date() for dt in occurrences if dt.date() not in exdates]


def main():
    ics_url = os.environ.get("CALENDAR_ICS_URL")
    if not ics_url:
        print("error: CALENDAR_ICS_URL is not set", file=sys.stderr)
        sys.exit(1)

    req = urllib.request.Request(ics_url, headers={"User-Agent": "workout-tracker-sync/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")

    events = parse_vevents(unfold_ics(text))

    window_start = date.today() - timedelta(days=SCHEDULE_BACK_DAYS)
    window_end = date.today() + timedelta(days=SCHEDULE_AHEAD_DAYS)

    workout_days = {}
    schedule = {}

    for ev in events:
        summary = (ev.get("summary") or "").strip()
        occurrences = expand_dates(ev)
        if not occurrences:
            continue

        _, start_time = parse_ics_moment(ev["dtstart_raw"], ev.get("dtstart_params", []))
        end_time = None
        if "dtend_raw" in ev:
            _, end_time = parse_ics_moment(ev["dtend_raw"], ev.get("dtend_params", []))
        emoji, label = categorize(summary)

        for day in occurrences:
            if matches_keywords(summary):
                workout_days.setdefault(day.isoformat(), set()).add(summary)
            if window_start <= day <= window_end:
                item = {"emoji": emoji, "label": label, "start": start_time, "end": end_time}
                items = schedule.setdefault(day.isoformat(), [])
                if item not in items:
                    items.append(item)

    for items in schedule.values():
        items.sort(key=lambda i: i["start"] or "")

    result = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "keywords": KEYWORDS,
        "days": [
            {"date": day, "titles": sorted(t for t in titles if t)}
            for day, titles in sorted(workout_days.items())
        ],
        "schedule": [{"date": day, "items": items} for day, items in sorted(schedule.items())],
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Wrote {len(workout_days)} workout day(s) and {len(schedule)} scheduled day(s)")


if __name__ == "__main__":
    main()
