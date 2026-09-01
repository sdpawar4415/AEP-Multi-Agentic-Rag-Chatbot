# AEP Assist — Flowise Setup Guide

---

## 1. Import the flows

In Flowise (Chatflows / Agentflows tab → Import):

**Agentflow:**
- Master Agentflow (orchestrator)

**Chatflows (7 modules):**
- Product Search
- Policy
- Warranty
- Order Tracking
- Complaints
- FAQ
- Human Handoff

**Custom Tools:**
- Import any exported standalone (Product Search, Policy, Warranty tools). Tools built inside a chatflow import automatically with it.

---

## 2. Set up Flowise Variables

All flows/tools read shared config from Flowise Variables instead of hardcoded values. Go to **Settings → Variables** and create these as **Static**:

| Variable | Value | Used by |
|---|---|---|
| `endpoint` | Your machine's IP (e.g. `192.168.1.166`) | Embedding server, guardrail servers, MCP servers |
| `solr_config` | `{"base_url":"","user":"","pass":""}` | Product Search, Policy |
| `upstash_token` | Upstash Redis token | Cache lookup/write |
| `upstash_url` | Upstash Redis REST URL | Cache lookup/write |
| `tavilyApiKey` | Tavily API key | Shoe warranty search |
| `firecrawl_api` | Firecrawl API key | Smartphone warranty search |

---

## 3. Why `endpoint` matters

Every locally-hosted server (embedding, guardrails, MCP) runs on the same machine, different ports. Since tools read the IP from `endpoint` instead of having it typed in, moving machines or changing networks is one edit — update `endpoint`, save, done.

---

## 4. Quick verification

1. Product Search test query → confirms `endpoint` + `solr_config`.
2. Shoe warranty query → confirms `tavilyApiKey`.
3. Smartphone warranty query → confirms `firecrawl_api`.
4. Ask the exact same question twice → instant second response confirms cache (`upstash_token`/`upstash_url`) is hitting on an exact match.

If a tool fails to connect, check the variable name matches exactly what the code expects (`$vars.endpoint`, etc.).

---

## Notes

- These six variables are the only things that should change between environments — nothing else in the flows needs editing.
- Cache is exact-match only (not semantic) — a differently worded repeat question won't hit the cache.
- Rotating any API key only needs an update here, not in any flow.
