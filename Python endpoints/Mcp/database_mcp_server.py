"""
generic_mcp_server.py
----------------------
Generic MCP server — works with ANY SQLite database.
Uses streamable-http transport (Flowise compatible).
Uses a LangChain callback to reliably capture SQL and structured data.

Install:
    pip install fastmcp langchain-community langchain-groq sqlalchemy

Run on Windows (PowerShell):
    $env:DB_PATH = "complaints.db"
    $env:GROQ_API_KEY = "gsk_your_key_here"
    python generic_mcp_server.py

Flowise Custom MCP node config:
    { "url": "http://192.168.29.88:8766/mcp" }

# Terminal 1 — complaints server
$env:DB_PATH = "complaints.db"
$env:MCP_PORT = "8766"
$env:GROQ_API_KEY = "gsk_your_key_here"
python database_mcp_server.py

# Terminal 2 — orders server
$env:DB_PATH = "orders.db"
$env:MCP_PORT = "8767"
$env:GROQ_API_KEY = "gsk_your_key_here"
python database_mcp_server.py
"""

import os
import sqlite3
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from langchain_community.utilities import SQLDatabase
from langchain_community.agent_toolkits import SQLDatabaseToolkit, create_sql_agent
from langchain_core.callbacks import BaseCallbackHandler
from langchain_groq import ChatGroq

DB_PATH = Path(os.environ.get("DB_PATH", "complaints.db"))
PORT = int(os.environ.get("MCP_PORT", 8766))

print(f"[INFO] Connecting to {DB_PATH}...")

_db = SQLDatabase.from_uri(
    f"sqlite:///{DB_PATH}",
    sample_rows_in_table_info=3,
)
_llm = ChatGroq(
    model="llama-3.3-70b-versatile",
    temperature=0,
    groq_api_key=os.environ["GROQ_API_KEY"],
)
_toolkit = SQLDatabaseToolkit(db=_db, llm=_llm)
_agent   = create_sql_agent(
    llm=_llm,
    toolkit=_toolkit,
    agent_type="zero-shot-react-description",
    verbose=True,
    handle_parsing_errors=True,
    max_iterations=10,
    max_execution_time=30,
    # return_intermediate_steps goes in agent_executor_kwargs, NOT as a top-level arg
    agent_executor_kwargs={"return_intermediate_steps": True},
)

_tables = _db.get_usable_table_names()
print(f"[INFO] Agent ready. Tables: {_tables}")


# ── Callback — fires exactly when sql_db_query tool is called ─────────────────
class SQLCaptureCallback(BaseCallbackHandler):
    """
    Captures the SQL and data at the moment sql_db_query is invoked.
    More reliable than parsing intermediate_steps after the fact.
    """
    def __init__(self):
        self.sql_used = ""
        self.data     = []

    def on_tool_start(self, serialized: dict, input_str: str, **kwargs):
        tool_name = serialized.get("name", "")
        if tool_name != "sql_db_query":
            return

        # Clean the SQL — MRKL parser sometimes appends Observation/Thought lines
        sql = input_str.strip()
        for stop in ["\nObservation:", "\nThought:", "\nAction:"]:
            if stop in sql:
                sql = sql[:sql.index(stop)]
        sql = sql.strip()

        if not sql.upper().startswith("SELECT"):
            return

        self.sql_used = sql
        print(f"[CALLBACK] sql_db_query called with: {sql[:100]}")

        # Re-run against SQLite to get structured rows
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            rows      = conn.execute(sql).fetchall()
            self.data = [dict(r) for r in rows]
            print(f"[CALLBACK] Captured {len(self.data)} rows")
        except sqlite3.Error as e:
            print(f"[CALLBACK] SQL error: {e}")
            self.data = []
        finally:
            conn.close()


# ── MCP server ────────────────────────────────────────────────────────────────
mcp = FastMCP(
    name="sql-db",
    instructions=f"""
    Database assistant. Available tables: {', '.join(_tables)}.
    Use query_db for all data questions. Always pass natural language questions —
    never pass raw SQL as the question.
    Use get_db_schema to understand table structure.
    """,
)


@mcp.tool()
def query_db(question: str) -> dict[str, Any]:
    """
    Ask any natural language question about the database.
    IMPORTANT: Always pass a natural language question, NOT raw SQL.
    Good: "how many high priority complaints are there"
    Good: "show all high priority complaints"
    Bad:  "SELECT COUNT(*) FROM complaints WHERE priority = 'High'"

    The full LangChain SQL Agent runs internally:
      1. Reads table schema automatically
      2. Generates SQL from the natural language question
      3. Validates SQL before running
      4. Executes and retries on error automatically

    Returns structured dict:
      status    : 'success' or 'error'
      answer    : natural language answer — use this as the primary response
      row_count : number of rows the SQL returned (use this for display rules)
      data      : actual rows as list of dicts, max 50
      sql_used  : SQL that was executed — NEVER show this to the user
    """
    q = question.strip()
    if q.upper().startswith("SELECT"):
        q = f"Run this query and explain the results: {q}"

    cb = SQLCaptureCallback()   # fresh callback per request

    try:
        result = _agent.invoke(
            {"input": q},
            config={"callbacks": [cb]},   # attach callback for this run only
        )
        answer = result.get("output", "")

        return {
            "status":    "success",
            "answer":    answer,
            "row_count": len(cb.data),
            "data":      cb.data[:50],
            "sql_used":  cb.sql_used,
        }

    except Exception as e:
        return {
            "status":    "error",
            "answer":    str(e),
            "row_count": 0,
            "data":      [],
            "sql_used":  "",
        }


@mcp.tool()
def get_db_schema() -> dict[str, Any]:
    """
    Returns schema of all tables: column names, types, sample rows, row counts.
    Call this when the user asks about available columns, data structure,
    or what information is stored in the database.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()]
    schema = {}
    for t in tables:
        cols   = conn.execute(f"PRAGMA table_info({t})").fetchall()
        sample = conn.execute(f"SELECT * FROM {t} LIMIT 3").fetchall()
        schema[t] = {
            "columns":     [{"name": c["name"], "type": c["type"]} for c in cols],
            "sample_rows": [dict(r) for r in sample],
            "row_count":   conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0],
        }
    conn.close()
    return {"status": "success", "tables": tables, "schema": schema}


if __name__ == "__main__":
    if not DB_PATH.exists():
        print(f"[ERROR] Database not found: {DB_PATH}. Run setup_db.py first.")
        raise SystemExit(1)
    print(f"[INFO] MCP server starting on http://0.0.0.0:{PORT}/mcp")
    print(f"[INFO] Flowise config → {{ \"url\": \"http://192.168.29.88:{PORT}/mcp\" }}")
    mcp.run(transport="streamable-http", host="0.0.0.0", port=PORT)