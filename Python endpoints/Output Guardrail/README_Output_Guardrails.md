# AEP Assist — Output Guardrail Server Setup

This runs the output-side check — it masks sensitive PII (phone numbers, customer names, addresses) in the agent's generated response before it's sent back to the customer.

---

## 1. Prerequisites

- Python 3.10 or later
- These two files together in one folder:
  - `output_guardrail_server.py`
  - `output_guardrails.py`

`output_guardrail_server.py` imports directly from `output_guardrails.py`, so they must stay in the same folder.

---

## 2. Install dependencies

Only one external package is needed — Flask. `re` (used for the masking patterns) is part of core Python and needs no install.

```bash
pip install flask
```

---

## 3. `.env` file — not needed

Unlike the input guardrail server, this one makes no external API calls (no Groq, no LLM call at all) — it's pure pattern-based text masking. There's no API key to configure, so **no `.env` file is required** for this component.

---

## 4. Run the server

```bash
python output_guardrail_server.py
```

Runs on port 8001. Visit `http://localhost:8001` in a browser — you should see:
```json
{"status": "Output Guardrails Running"}
```

You can also check `http://localhost:8001/health` for a simple health check response.

---

## 5. Quick test

```bash
curl -X POST http://localhost:8001/check_output \
  -H "Content-Type: application/json" \
  -d "{\"generated_response\": \"- **Customer Name:** Sayali Jadhav\\n- **Phone:** 9876123450\"}"
```

Expected response — name and phone masked, address untouched since none was present:
```json
{"safe": true, "response": "- **Customer Name:** S***** J*****\n- **Phone:** 98******50"}
```

---

## 6. Connect to Flowise

Add a **Custom Function** node as the *last* step in each chatflow, after the Tool Agent generates its response and before it's shown to the customer:

1. Take the Tool Agent's generated response.
2. POST it to:
   ```
   http://<your-machine-ip>:8001/check_output
   ```
   as `{"generated_response": "<the agent's text>"}`.
3. Return the `response` field from that call as the final message shown to the customer — this is the masked version.

Do this once per chatflow, pointing at the same server — same pattern as the input guardrail, just on the other end of the flow.

There's also an `/invoke` route that does exactly the same thing as `/check_output` — use whichever fits your Flowise node naming, they're interchangeable.

---

## Notes

- This fails **open**, not closed — if masking throws an unexpected error, it still returns `"safe": false"` but with a fallback message asking the customer to try again, rather than silently letting an error respond. This is the opposite of the input guardrail server's fail-closed behavior — worth mentioning if it comes up, since it's a deliberate asymmetry: better to block a suspicious *input*, but better to *attempt* a response than strand a customer on the output side.
- The masking is pattern-based — it looks for specific labeled formats like `Phone:`, `Customer Name:`, `Address:` (plain and markdown bullet styles). If the Tool Agent's response phrases these differently than the patterns expect, that field won't get masked. Worth spot-checking real agent output against this during the demo rather than assuming it always matches.
- `debug=True` is set on the Flask app — fine for a demo, but should be turned off before this runs anywhere customer-facing, since debug mode exposes stack traces.
