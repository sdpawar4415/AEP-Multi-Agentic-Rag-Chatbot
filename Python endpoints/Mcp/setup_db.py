"""
setup_db.py
-----------
Reads your Excel file and loads it into complaints.db (SQLite).
Run this once, or again whenever you get new data.
New rows are inserted. Existing rows (same complaint_id) are skipped.

Usage:
    python setup_db.py
    python setup_db.py path/to/new_data.xlsx
"""

import sys
import sqlite3
import pandas as pd
from pathlib import Path

DB_PATH      = Path(__file__).parent / "complaints.db"
DEFAULT_XLSX = Path(__file__).parent / "complaints_dataset_200 1.xlsx"

COL_MAP = {
    "Complaint ID":     "complaint_id",
    "Order ID":         "order_id",
    "Product ID":       "product_id",
    "Product Name":     "product_name",
    "Category ID":      "category_id",
    "Product Category": "product_category",
    "Complaint Type":   "complaint_type",
    "User Message":     "user_message",
    "Sentiment":        "sentiment",
    "Priority":         "priority",
    "Expected Action":  "expected_action",
    "Date Submitted":   "date_submitted",
}

DDL = """
CREATE TABLE IF NOT EXISTS complaints (
    complaint_id      TEXT PRIMARY KEY,
    order_id          TEXT,
    product_id        TEXT,
    product_name      TEXT,
    category_id       TEXT,
    product_category  TEXT,
    complaint_type    TEXT,
    user_message      TEXT,
    sentiment         TEXT,
    priority          TEXT,
    expected_action   TEXT,
    date_submitted    DATE
);
CREATE INDEX IF NOT EXISTS idx_complaint_type   ON complaints(complaint_type);
CREATE INDEX IF NOT EXISTS idx_priority         ON complaints(priority);
CREATE INDEX IF NOT EXISTS idx_sentiment        ON complaints(sentiment);
CREATE INDEX IF NOT EXISTS idx_product_category ON complaints(product_category);
CREATE INDEX IF NOT EXISTS idx_date_submitted   ON complaints(date_submitted);
"""

def load(path):
    df = pd.read_excel(path)
    known = [c for c in COL_MAP if c in df.columns]
    df = df[known].rename(columns=COL_MAP)
    if "date_submitted" in df.columns:
        df["date_submitted"] = pd.to_datetime(df["date_submitted"]).dt.date.astype(str)
    str_cols = df.select_dtypes(include=["object"]).columns
    df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())
    return df

def upsert(conn, df):
    inserted = 0
    cur = conn.cursor()
    for _, row in df.iterrows():
        cols = list(row.index)
        vals = list(row.values)
        ph   = ", ".join(["?"] * len(cols))
        sql  = f"INSERT OR IGNORE INTO complaints ({', '.join(cols)}) VALUES ({ph})"
        cur.execute(sql, vals)
        inserted += cur.rowcount
    conn.commit()
    return inserted

def main():
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"[ERROR] File not found: {xlsx}")
        raise SystemExit(1)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(DDL)
    df = load(xlsx)
    print(f"[INFO] Read {len(df)} rows from {xlsx.name}")
    n = upsert(conn, df)
    total = conn.execute("SELECT COUNT(*) FROM complaints").fetchone()[0]
    print(f"[INFO] Inserted {n} new rows — total in DB: {total}")
    conn.close()

if __name__ == "__main__":
    main()