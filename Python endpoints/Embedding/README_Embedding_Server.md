# AEP Assist — Embedding Server Setup

This is the shared embedding service every Solr-backed module calls for vector search — Product Search, Policy, and (per your smartphone warranty tool) any other module doing KNN search against Solr. One shared model, one shared endpoint.

---

## 1. Prerequisites

- Python 3.10 or later
- `app.py` in its own folder
- Internet access the **first time** you run it — it downloads the `all-MiniLM-L6-v2` model from HuggingFace (a few hundred MB) and caches it locally. After that first run, it works offline.

---

## 2. Install dependencies

Two external packages needed — Flask for the server, `sentence-transformers` for the embedding model (this will also pull in `torch` as a dependency, so the install can take a few minutes):

```bash
pip install flask sentence-transformers
```

---

## 3. `.env` file — not needed

No API keys here — the model runs entirely locally, no external calls. No `.env` file required.

---

## 4. Run the server

```bash
python app.py
```

The first run will pause briefly while it downloads the model — you'll see download progress in the terminal. Once ready, it starts listening on port 5000.

There's no home route on this one, so a plain browser visit to `http://localhost:5000` will show a 404 — that's expected. Use the test below to confirm it's actually working.

---

## 5. Quick test

```bash
curl -X POST http://localhost:5000/embed \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"wireless earphones under 1000\"}"
```

Expected response: a JSON array of 384 numbers (the embedding vector). If you get that back, it's working.

---

## 6. How the other modules use this

You don't connect this one to Flowise directly — it's called *from inside* the Product Search and Policy custom tool scripts, at:

```
http://<this-machine-ip>:5000/embed
```

Each of those scripts sends the customer's query text here, gets back a 384-dimension vector, and uses that vector for the KNN half of the hybrid Solr search. If this server isn't running, the KNN search silently fails and those modules fall back to keyword-only search — worth starting this one **before** you start the Product Search or Policy demo, since a stopped embedding server won't throw an obvious error, it'll just make search quality quietly worse.

---

## Notes

- Keep this terminal running for the whole demo — it's a dependency for two of your six chatflows.
- If you move this to a different machine or IP later, update the `EMBEDDING_API` / `EMBED_URL` constant at the top of the Product Search and Policy custom tool scripts to match.
- This has no request-level error handling — a malformed request (missing `text` key) will throw an unhandled exception. Fine for a controlled demo, worth hardening if this goes beyond that.
