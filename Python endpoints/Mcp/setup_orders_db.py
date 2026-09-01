"""
setup_orders_db.py
-------------------
Reads orders.xlsx and order_items.xlsx and loads them into orders.db (SQLite).
Run this once, or again whenever you get new data.
New rows are inserted. Existing rows (same order_id / same item line) are skipped.

Usage:
    python setup_orders_db.py
    python setup_orders_db.py path/to/orders.xlsx path/to/order_items.xlsx
"""

import sys
import sqlite3
import pandas as pd
from pathlib import Path

DB_PATH                = Path(__file__).parent / "orders.db"
DEFAULT_ORDERS_XLSX    = Path(__file__).parent / "orders.xlsx"
DEFAULT_ORDER_ITEMS_XLSX = Path(__file__).parent / "order_items.xlsx"

# Excel columns already match DB column names (snake_case), so no renaming needed —
# unlike the complaints file. ORDERS_COLS / ITEMS_COLS just define the load order
# and act as a safety filter against any unexpected extra columns.
ORDERS_COLS = [
    "order_id", "customer_name", "order_status", "delivery_status",
    "order_date", "estimated_delivery_date", "tracking_number", "shipping_carrier",
    "address_line_1", "address_line_2", "shipping_city", "shipping_state",
    "shipping_zip_code", "country", "base_price", "discount", "tax",
    "shipping_fee", "total_amount", "currency", "payment_status",
]

ITEMS_COLS = [
    "order_id", "product_id", "product_name", "quantity", "unit_price", "line_total",
]

DDL = """
CREATE TABLE IF NOT EXISTS orders (
    order_id                 TEXT PRIMARY KEY,
    customer_name             TEXT,
    order_status               TEXT,
    delivery_status            TEXT,
    order_date                 DATE,
    estimated_delivery_date    DATE,
    tracking_number             TEXT,
    shipping_carrier            TEXT,
    address_line_1              TEXT,
    address_line_2              TEXT,
    shipping_city                TEXT,
    shipping_state                TEXT,
    shipping_zip_code             TEXT,
    country                        TEXT,
    base_price                     REAL,
    discount                       REAL,
    tax                             REAL,
    shipping_fee                   REAL,
    total_amount                   REAL,
    currency                       TEXT,
    payment_status                  TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
    item_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      TEXT NOT NULL,
    product_id    TEXT,
    product_name  TEXT,
    quantity      INTEGER,
    unit_price    REAL,
    line_total    REAL,
    UNIQUE(order_id, product_id),
    FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX IF NOT EXISTS idx_order_status      ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_delivery_status   ON orders(delivery_status);
CREATE INDEX IF NOT EXISTS idx_payment_status    ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_order_date        ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_shipping_state    ON orders(shipping_state);

CREATE INDEX IF NOT EXISTS idx_items_order_id    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product_name ON order_items(product_name);
"""


def load(path, cols):
    df = pd.read_excel(path)
    known = [c for c in cols if c in df.columns]
    df = df[known]
    for date_col in ("order_date", "estimated_delivery_date"):
        if date_col in df.columns:
            df[date_col] = pd.to_datetime(df[date_col]).dt.date.astype(str)
    if "shipping_zip_code" in df.columns:
        df["shipping_zip_code"] = df["shipping_zip_code"].astype(str)
    str_cols = df.select_dtypes(include=["object", "string"]).columns
    df[str_cols] = df[str_cols].apply(lambda s: s.str.strip())
    return df


def upsert_orders(conn, df):
    inserted = 0
    cur = conn.cursor()
    for _, row in df.iterrows():
        cols = list(row.index)
        vals = list(row.values)
        ph = ", ".join(["?"] * len(cols))
        sql = f"INSERT OR IGNORE INTO orders ({', '.join(cols)}) VALUES ({ph})"
        cur.execute(sql, vals)
        inserted += cur.rowcount
    conn.commit()
    return inserted


def upsert_items(conn, df):
    inserted = 0
    cur = conn.cursor()
    for _, row in df.iterrows():
        cols = list(row.index)
        vals = list(row.values)
        ph = ", ".join(["?"] * len(cols))
        sql = f"INSERT OR IGNORE INTO order_items ({', '.join(cols)}) VALUES ({ph})"
        cur.execute(sql, vals)
        inserted += cur.rowcount
    conn.commit()
    return inserted


def main():
    if len(sys.argv) > 2:
        orders_xlsx, items_xlsx = Path(sys.argv[1]), Path(sys.argv[2])
    else:
        orders_xlsx, items_xlsx = DEFAULT_ORDERS_XLSX, DEFAULT_ORDER_ITEMS_XLSX

    for f in (orders_xlsx, items_xlsx):
        if not f.exists():
            print(f"[ERROR] File not found: {f}")
            raise SystemExit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(DDL)

    # Orders must load first so order_items' FK target already exists.
    orders_df = load(orders_xlsx, ORDERS_COLS)
    print(f"[INFO] Read {len(orders_df)} rows from {orders_xlsx.name}")
    n_orders = upsert_orders(conn, orders_df)
    total_orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    print(f"[INFO] Inserted {n_orders} new orders — total in DB: {total_orders}")

    items_df = load(items_xlsx, ITEMS_COLS)
    print(f"[INFO] Read {len(items_df)} rows from {items_xlsx.name}")
    n_items = upsert_items(conn, items_df)
    total_items = conn.execute("SELECT COUNT(*) FROM order_items").fetchone()[0]
    print(f"[INFO] Inserted {n_items} new order_items — total in DB: {total_items}")

    conn.close()


if __name__ == "__main__":
    main()
