# AEP Assist — Order & Complaints MCP Server Setup

This sets up two databases (Orders, Complaints) and exposes each one to Flowise through its own MCP server.

---

## 1. Prerequisites

- Python 3.10 or later
- The following files in one folder together:
  - `database_mcp_server.py`
  - `requirements.txt`
  - `setup_db.py`
  - `setup_orders_db.py`
  - `orders.xlsx`
  - `order_items.xlsx`
  - `complaints_dataset_200_1.xlsx`

---

## 2. Install dependencies

```bash
pip install -r requirements.txt
```

---

## 3. Fix the complaints filename (one-time)

`setup_db.py` looks for `complaints_dataset_200 1.xlsx` (with a space) by default, but the file you have is named `complaints_dataset_200_1.xlsx` (with an underscore). Do one of these:

- **Easiest:** rename your file to match — `complaints_dataset_200 1.xlsx`, **or**
- Pass the filename explicitly when you run the script (see step 4).

---

## 4. Build the databases

Run these once — they create the SQLite `.db` files from your Excel data.

**Orders database:**
```bash
python setup_orders_db.py
```
This reads `orders.xlsx` and `order_items.xlsx` and creates `orders.db`.

**Complaints database:**
```bash
python setup_db.py complaints_dataset_200_1.xlsx
```
(Passing the filename directly avoids the naming mismatch from step 3.) This creates `complaints.db`.

You should see a row count printed for each — confirm it matches your Excel row count.

---

## 5. Run the MCP servers

Each database needs its own server process, on its own port. Open **two terminals**.

**Terminal 1 — Complaints server:**
```powershell
$env:DB_PATH = "complaints.db"
$env:MCP_PORT = "8766"
$env:GROQ_API_KEY = "your_groq_api_key"
python database_mcp_server.py
```

**Terminal 2 — Orders server:**
```powershell
$env:DB_PATH = "orders.db"
$env:MCP_PORT = "8767"
$env:GROQ_API_KEY = "your_groq_api_key"
python database_mcp_server.py
```

(On Mac/Linux, replace `$env:VAR = "value"` with `export VAR=value`.)

Each terminal should print something like:
```
[INFO] MCP server starting on http://0.0.0.0:8766/mcp
```

Leave both terminals running — closing them stops the server.

---

## 6. Connect to Flowise

For each chatflow:

1. Add a **Custom MCP** node.
2. Set the URL to the matching server:
   - Complaints flow → `http://<your-machine-ip>:8766/mcp`
   - Orders flow → `http://<your-machine-ip>:8767/mcp`
3. Transport type: **streamable-http**.
4. Save and let Flowise fetch the available tools — you should see `query_db` and `get_db_schema` listed.
5. Attach the MCP node to the relevant Tool Agent.

Use your machine's actual local IP (not `localhost`) if Flowise is running elsewhere on the network, e.g. `http://192.168.29.88:8766/mcp`.

---

## 7. Quick test

Before switching to Flowise, you can sanity-check a server is alive by hitting it directly, or just ask the connected chatflow a simple question like:

- Orders: *"what's the status of order ID <some real order_id from your Excel>"*
- Complaints: *"show me all high priority complaints"*

If you get a natural-language answer back (not an error), the server, database, and Flowise connection are all wired correctly.

---

## Notes

- `sql_used` in the tool response is for debugging only — the agent is instructed never to show raw SQL to the customer.
- Re-running `setup_db.py` or `setup_orders_db.py` later with updated Excel files is safe — existing rows are skipped, only new rows get inserted.
- If you add more databases later, this same `database_mcp_server.py` script works for any SQLite file — just point `DB_PATH` at it and give it its own `MCP_PORT`.
