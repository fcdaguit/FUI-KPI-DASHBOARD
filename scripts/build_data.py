#!/usr/bin/env python3
"""
Combine per-principal CSV exports (Google Sheets > Download > CSV) into the
single data/sales-data.json file the dashboard reads.

Usage:
    python3 scripts/build_data.py raw/*.csv

Each input CSV must use the template's required columns:
    Branch/Site,Principal/Supplier,Channel,Category,Month,Year,Target Sales,Actual Sales

Two more columns are optional — include them only for a principal that
reports Volume alongside Amount (e.g. Shell Lubricants in liters):
    Metric Type   "Amount" or "Volume" — blank/omitted defaults to "Amount"
    Unit          e.g. "Liters", "Kilograms" — only meaningful for Volume rows

A principal reporting both just needs two rows per Branch/Channel/Category/
Month: one with Metric Type=Amount (peso Target/Actual), one with Metric
Type=Volume (unit-count Target/Actual) and its Unit filled in.

Any additional columns (e.g. Salesman, Area, Supervisor) are passed through
as-is — the dashboard auto-detects and charts them. Blank or duplicate
header names are dropped with a warning rather than failing the build.

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
OPTIONAL_KNOWN_COLUMNS = ["Metric Type", "Unit"]

def clean_headers(fieldnames, path):
    """Return list of (index, name) for the first occurrence of each
    non-blank header name, dropping blanks and later duplicates."""
    seen = set()
    kept = []
    for i, h in enumerate(fieldnames):
        name = (h or "").strip()
        if not name:
            print(f"  ! {path}: skipping a blank column header (position {i + 1})")
            continue
        if name in seen:
            print(f"  ! {path}: duplicate column '{name}' — keeping the first occurrence only")
            continue
        seen.add(name)
        kept.append((i, name))
    return kept

def load_csv(path):
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            return rows
        columns = clean_headers(header, path)  # list of (index, name), first-occurrence only
        names = [name for _, name in columns]
        missing = [c for c in REQUIRED_COLUMNS if c not in names]
        if missing:
            raise ValueError(f"{path}: missing required column(s) {missing}")
        extra_columns = [c for c in names if c not in REQUIRED_COLUMNS and c not in OPTIONAL_KNOWN_COLUMNS]

        for raw_row in reader:
            if not any(cell.strip() for cell in raw_row):
                continue  # skip fully blank lines
            r = {}
            for idx, name in columns:
                r[name] = raw_row[idx].strip() if idx < len(raw_row) else ""

            try:
                target = float(r["Target Sales"])
                actual = float(r["Actual Sales"])
                year = int(r["Year"])
            except (ValueError, TypeError, KeyError):
                print(f"  ! {path}: skipping row with invalid Target/Actual/Year: {r}")
                continue
            if not r.get("Branch/Site") or not r.get("Principal/Supplier"):
                print(f"  ! {path}: skipping row missing Branch/Site or Principal/Supplier: {r}")
                continue

            row = {
                "branch": r["Branch/Site"],
                "principal": r["Principal/Supplier"],
                "channel": r.get("Channel", ""),
                "category": r.get("Category", ""),
                "month": r.get("Month", ""),
                "year": year,
                "target": target,
                "actual": actual,
                "achievement": round((actual / target) * 100, 1) if target else 0,
                "metricType": r.get("Metric Type") or "Amount",
                "unit": r.get("Unit") or "",
            }
            # pass through any extra columns (Salesman, Area, Supervisor, ...) as-is
            for col in extra_columns:
                value = r.get(col, "")
                if value:
                    row[col] = value
            rows.append(row)
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
