# AEP Assist — Policy Document Ingestion Script

Reads `Policies_Document_2.pdf`, chunks it, embeds each chunk, and pushes it into the Solr `policy_vectors` core — this is what Policy RAG's hybrid search queries against.

---

## 1. Prerequisites

- Python 3.10+
- Solr running with a `policy_vectors` core already created
- These two files in the same folder:
  - the ingestion script (`.py`)
  - `Policies_Document_2.pdf`

---

## 2. Install dependencies

```bash
pip install sentence-transformers pypdf requests
```

---

## 3. Set your config

At the top of the script, update:

```python
SOLR_URL = "http://<your-solr-ip>:8983/solr/policy_vectors/update/json/docs"
USERNAME = "your_solr_username"
PASSWORD = "your_solr_password"
pdf_path = "Policies_Document 2.pdf"
```

Make sure `pdf_path` matches your actual filename exactly (underscore vs space).

---

## 4. Run it

```bash
python ingest_policy.py
```

It'll print `Inserted chunk N` per chunk, then `✅ Ingestion complete` at the end. Chunking is 500 characters with 100-character overlap.

---

## 5. Verify

Query Solr directly to confirm the docs landed:
```
http://<your-solr-ip>:8983/solr/policy_vectors/select?q=*:*&rows=5
```
Or just run a Policy chatflow query and confirm it returns real policy content.

---

## Notes

- Re-running this script will re-insert with the same `id` values (0, 1, 2...) and overwrite existing docs — safe to re-run after updating the PDF.
- Credentials are hardcoded in the script, not read from `.env` — fine for a demo, worth moving to environment variables if this becomes permanent.
- If the policy document changes, just re-run this script — no need to touch the Policy chatflow itself.
