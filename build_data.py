#!/usr/bin/env python3
"""
Combine per-principal CSV exports (Google Sheets > Download > CSV) into the
single data/sales-data.json file the dashboard reads.

Usage:
    python3 scripts/build_data.py raw/*.csv

Each input CSV must use the template header:
    Branch/Site,Principal/Supplier,Channel,Category,Month,Year,Target Sales,Actual Sales

Run this after dropping new monthly exports into raw/, then commit the
updated data/sales-data.json so GitHub Pages serves the refreshed numbers.
"""
import csv
import glob
import json
import sys
from pathlib import Path

REQUIRED_COLUMNS = [
    "Branch/Site", "Principal/Supplier", "Channel", "Category",
    "Month", "Year", "Target Sales", "Actual Sales",
]

def load_csv(path):
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [c for c in REQUIRED_COLUMNS if c not in reader.fieldnames]
        if missing:
            raise ValueError(f"{path}: missing columns {missing}")
        for r in reader:
            target = float(r["Target Sales"])
            actual = float(r["Actual Sales"])
            rows.append({
                "branch": r["Branch/Site"].strip(),
                "principal": r["Principal/Supplier"].strip(),
                "channel": r["Channel"].strip(),
                "category": r["Category"].strip(),
                "month": r["Month"].strip(),
                "year": int(r["Year"]),
                "target": target,
                "actual": actual,
                "achievement": round((actual / target) * 100, 1) if target else 0,
            })
    return rows

def main(argv):
    paths = []
    for pattern in argv[1:]:
        paths.extend(glob.glob(pattern))
    if not paths:
        print("No input CSVs given. Example:\n  python3 scripts/build_data.py raw/*.csv")
        return 1

    combined = []
    for p in sorted(paths):
        combined.extend(load_csv(p))
        print(f"  + {p} ({len(combined)} rows so far)")

    out_path = Path(__file__).resolve().parent.parent / "data" / "sales-data.json"
    out_path.write_text(json.dumps(combined, indent=2))
    print(f"Wrote {len(combined)} rows to {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
