require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const http = require("http");

const app = express();
const PORT = 3001;

// =========================
// CONFIG
// =========================
const FLOWISE_BASE_URL = "http://localhost:3000";
const FLOWISE_CHATFLOW_ID = "4189da03-3365-4d4b-9bda-d5e824104f28";
const FLOWISE_AGENTFLOW_URL = `${FLOWISE_BASE_URL}/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`;

// Direct Groq call for suggestion generation — deliberately kept OUTSIDE
// the Flowise agentflow (see design notes above SUGGESTION_BANK). Reuses
// the same model already used across the POC's chatflows.
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// =========================
// NODE ID → FRIENDLY NAME MAP
// =========================
const NODE_LABELS = {
  startAgentflow_0:          "Start",
  customFunctionAgentflow_4: "Layered Input Guardrail 1",
  llmAgentflow_0:            "Layered Input Guardrail 2",
  conditionAgentflow_0:      "Guardrail Router 2",
  conditionAgentflow_2:      "Guardrail Router 1",
  directReplyAgentflow_0:    "Layered Direct Reply (Blocked)",
  directReplyAgentflow_3:    "Layered Direct Reply (Blocked)",
  directReplyAgentflow_1:    "Direct Reply (Greeting)",
  customFunctionAgentflow_2: "Cache Lookup",
  conditionAgentflow_1:      "Cache Router",
  customFunctionAgentflow_0: "Cache Extract Answer",
  directReplyAgentflow_2:    "Direct Reply (Cache Hit)",
  customFunctionAgentflow_5: "Output Guardrail",
  customFunctionAgentflow_1: "Cache Write",
  llmAgentflow_1:            "Intent Detector",
  customFunctionAgentflow_3: "Custom Tool Call",
  llmAgentflow_2:            "Response Generation",
};

const NODE_LABEL_OVERRIDES = {
  "Start":                    "Start",
  "Guardrail":                "Guardrail LLM",
  "LLM 0":                    "Guardrail LLM",
  "Condition 0":              "Guardrail Router",
  "Condition 1":              "Cache Router",
  "Custom Function 0":        "Cache Lookup",
  "Custom Function 1":        "Cache Write",
  "Custom Function 2":        "Cache Extract Answer",
  "Orchestrator":             "Intent Detector",
  "Direct Reply (Greetings)": "Direct Reply (Greeting)",
  "Direct Reply 2":           "Direct Reply (Cache Hit)",
};

const NODE_STATUS_MESSAGES = {
  "Start":                    null,
  "Input Guardrail 1":        "Reviewing your request.",
  "Input Guardrail 2":        "Validating your request.",
  "Guardrail Router":         "Routing your request.",
  "Guardrail 2 Router":       "Routing your request.",
  "Output Guardrail":         "Reviewing the response for quality.",
  "Cache Lookup":             "Checking for quick answers.",
  "Cache Router":             "Finding the best response.",
  "Cache Extract Answer":     "Found a matching answer.",
  "Cache Write":              "Improving future assistance by saving this interaction.",
  "Intent Detector":          "Detecting intent and planning.",
  "Custom Tool Call":         "Retrieving Required Information.",
  "Response Generation":      "Generating response.",
  "Direct Reply (Greeting)":  "Happy to assist you today.",
  "Direct Reply (Blocked)":   "Unable to process this request.",
  "Direct Reply (Cache Hit)": "Retrieving your answer.",
  "PolicyInfo":               "Checking the relevant policy details for you.",
  "ComplaintSearch":          "Looking into your complaint and support details.",
  "SolrProductSearch":        "Searching our catalog for the best matching products.",
  "FAQ":                      "Looking up frequently asked questions for you.",
  "WarrantySearch":           "Checking warranty details for your product.",
  "Order MCP":                "Fetching your order and tracking details.",
  "HumanHandoff":             "Connecting you with a support specialist.",
};

// V2: intents returned by Intent Detector and prefixed in Custom Tool Call output
const KNOWN_TOOLS = ["product", "policy", "complaint", "faq", "handoff", "warranty", "tracking"];

// Maps V2 intent keys → display names used in chips and logs
const INTENT_DISPLAY = {
  product:   "SolrProductSearch",
  policy:    "PolicyInfo",
  complaint: "ComplaintSearch",
  faq:       "FAQ",
  handoff:   "HumanHandoff",
  warranty:  "WarrantySearch",
  tracking:  "Order MCP",
};

// =========================
// SUGGESTED FOLLOW-UP QUESTIONS
// Deterministic, per-module question bank — keeps suggestions guaranteed
// to map to a module that actually exists in this POC (no LLM hallucination).
// Keyed by the SAME display names produced by deriveUsedTool()/INTENT_DISPLAY,
// so no new intent-detection logic is needed.
//
// IMPORTANT: every question here was checked against that module's own
// toolAgent_0 system prompt to confirm the module can actually answer it
// WITHOUT handing off to a different module. Two real bugs this fixed:
//   - Order MCP's prompt is read-only SQL lookups (query_db) — there is no
//     cancel/update capability, so "cancel this order?" is invalid.
//   - Complaints' prompt explicitly says "Never promise refunds,
//     replacements, timelines, or escalations" — so "escalate to a
//     manager?" is something the module is instructed to refuse.
// =========================
const SUGGESTION_BANK = {
  // Scope per product_search_rag_updated_Chatflow.json toolAgent_0:
  // SolrProductSearch (browse/filter/detail) + CatalogMetadata (what's
  // available), PLUS one cross-module entry: PolicyInfo's own prompt
  // documents answering ungrounded/general policy questions just fine
  // ("if no specific product or category is mentioned, pass query as-is"),
  // so this routes correctly via the orchestrator on click.
  SolrProductSearch: [
    "Show me more options like this",
    "Do you have this from a different brand?",
    "Show me cheaper alternatives",
    "What's your return policy?",
  ],
  // Scope per policy_rag prompt: exactly the 8 named policies. Tagged by
  // policy name so we never re-suggest the SAME policy the answer just
  // covered (e.g. answer already explained Return Policy -> don't offer
  // "what's your return policy?" again, even phrased differently).
  PolicyInfo: [
    { q: "What's your return policy?", aspect: "Return Policy" },
    { q: "What's your refund policy?", aspect: "Refund Policy" },
    { q: "What's your exchange policy?", aspect: "Exchange Policy" },
    { q: "What's your shipping policy?", aspect: "Shipping Policy" },
    { q: "What's your cancellation policy?", aspect: "Cancellation Policy" },
  ],
  // Scope per warranty prompt: limited warranty terms, extended plan
  // details/pricing, service fees, and claim STEPS (informational — the
  // module explains how to claim, it doesn't file one). Tagged by the
  // exact OUTPUT PRESENTATION section it belongs to (LIMITED WARRANTY /
  // EXTENDED PLAN / PRICING) so an already-shown section isn't repeated.
  WarrantySearch: [
    { q: "What's covered under the limited warranty?", aspect: "limited" },
    { q: "How do I file a warranty claim?", aspect: "limited" },
    { q: "What extended protection plans do you offer?", aspect: "extended" },
    { q: "What are the service fees for repairs?", aspect: "pricing" },
  ],
  // Scope per Order MCP prompt: read-only query_db lookups on the SAME
  // order_id already given this session — status/delivery/items/payment/
  // address (VIEW only)/pricing breakdown. No cancel, no address change.
  // Each entry tagged with the section it maps to (see ORDER_ASPECT_PATTERNS
  // below) so we can exclude whatever was JUST shown in the current answer —
  // no point re-suggesting "shipping address" right under an answer that
  // already displayed it.
  // Kept fully SELF-CONTAINED (no PolicyInfo cross-suggestion) — Order
  // MCP is a structured record lookup, not an open-ended module, so every
  // follow-up should stay inside what THIS record already contains.
  // "total" reuses the "payment" aspect tag since both live under the
  // same "Payment & Pricing" answer section — showing one means the
  // other was shown too. "complete" is a real, normally-competing
  // candidate (not backfill-only) — see the call site, which marks it
  // covered only once every OTHER aspect has already been shown this turn.
  "Order MCP": [
    { q: "What's the delivery status of my order?", aspect: "delivery" },
    { q: "Show me the items in this order", aspect: "items" },
    { q: "What's the payment status?", aspect: "payment" },
    { q: "Can I see the shipping address on file for this order?", aspect: "address" },
    { q: "What's the tracking number for this order?", aspect: "tracking" },
    { q: "What was the total amount charged for this order?", aspect: "payment" },
    { q: "Show me the complete order details", aspect: "complete" },
  ],
  // Scope per complaints prompt Mode B (specific field questions) on the
  // SAME complaint already discussed. No escalation/refund promises —
  // the prompt explicitly forbids the module from offering those. Also
  // kept self-contained: "linked order" stays inside ComplaintSearch's
  // own known fields (order_id it already has on file) rather than
  // routing to Order MCP. "complete" is a real, normally-competing
  // candidate (not backfill-only) — see the call site.
  ComplaintSearch: [
    { q: "What's the status of my complaint?", aspect: "status" },
    { q: "What happens next with my complaint?", aspect: "nextSteps" },
    { q: "What product is this complaint about?", aspect: "product" },
    { q: "When was this complaint submitted?", aspect: "submitted" },
    { q: "Which order is this complaint linked to?", aspect: "linkedOrder" },
    { q: "Show me the complete complaint details", aspect: "complete" },
  ],
  // Pulled directly from real faq_data_1.xlsx rows (one per category) so
  // even the static fallback is guaranteed to exist in the retriever's KB.
  FAQ: [
    "What is RAM in a smartphone?",
    "How do I choose the correct shoe size?",
    "What is slim fit clothing?",
    "How can I compare two products?",
  ],
  // NOTE: HumanHandoff intentionally has NO bank entry — once a customer
  // is being escalated to a person, there's nothing useful left for the
  // bot to suggest. generateDynamicSuggestions() and
  // generateSuggestedQuestions() both short-circuit to [] for this
  // module before this bank is ever consulted.
  // Pre-module menu (no answer to scope suggestions from yet) — one
  // representative entry point into each real module.
  Greeting: [
    "Show me running shoes under $100",
    "What's your return policy?",
    "I need help with a warranty claim",
    "I have a question about my order",
  ],
  "Cache Hit": [
    "Show me related products",
  ],
};

// Fallback shown when the module can't be identified (errors, blocked replies, etc.)
const SUGGESTION_FALLBACK = [
  "Show me running shoes under $100",
  "What's your return policy?",
];

// Which section(s) of THIS answer are present — grounded in each module's
// own confirmed output-format headers, so we never re-suggest something
// the customer was just shown a sentence above the chips. Per-turn only
// (not tracked across the session) per your call — that's the right scope.
// Policy: platform has exactly 8 fixed policy names.
const POLICY_NAMES = ["Return Policy","Refund Policy","Cancellation Policy","Exchange Policy","Warranty Policy","Shipping Policy","Payment Policy","Replacement Policy"];

const ASPECT_PATTERNS = {
  // Order_mcp_module_Chatflow toolAgent_0 output sections
  "Order MCP": {
    delivery: /Delivery Info/i,
    items: /Items Ordered/i,
    address: /Shipping Address/i,
    payment: /Payment\s*(&|and)\s*Pricing/i,
    tracking: /tracking number/i,
  },
  // warranty prompt's OUTPUT PRESENTATION sections (LIMITED WARRANTY /
  // EXTENDED PLAN / PRICING) — matched loosely since headers vary slightly
  // between the smartphone and shoe paths.
  WarrantySearch: {
    limited: /limited warranty|how to claim/i,
    extended: /extended plan|protection plan/i,
    pricing: /pricing|service fee/i,
  },
  // policy_rag prompt: the answer names whichever of the 8 fixed policies
  // it addressed — reuse POLICY_NAMES directly as the aspect keys.
  PolicyInfo: Object.fromEntries(
    POLICY_NAMES.map(name => [name, new RegExp(name.replace(/\s+/g, "\\s+"), "i")])
  ),
  // complaints prompt has no fixed markdown headers (it answers in prose),
  // so this is a looser keyword match — still useful, just less precise
  // than the markdown-based modules above.
  ComplaintSearch: {
    status: /\bstatus\b/i,
    nextSteps: /next step|recommended action|what happens next/i,
    product: /\bproduct\b/i,
    submitted: /submitted|submission date|filed on|date (it was|this was)/i,
    linkedOrder: /\bORD-\d{4,}\b|linked order/i,
  },
};

// =========================
// GENERIC ASPECT-BASED PICKER (Order MCP / ComplaintSearch)
// Same rule for both: never repeat an aspect this answer already covered.
// If that leaves fewer than `count` questions (e.g. "show complete
// details" covers everything at once), backfill — catch-all entries
// first, then previously-covered specific ones — rather than show fewer
// than 4 chips just because one broad answer happened to cover a lot.
// excludeJustAsked (declared below) still runs on the result afterward,
// so a chip never exactly repeats the question that produced this answer.
// =========================
// The "complete details" catch-all question competes fairly for a slot in
// pickAspectQuestions (see design note above that function), but once
// picked it should NOT go through rephraseForVariety like the others: its
// job is to ask for literally everything, and rewording it tends to drift
// into phrasing like "all the information you have on file" — which reads
// like a records/PII request to an input guardrail, even though it's a
// completely normal request scoped to an order/complaint the customer
// already identified. Kept literal here for the same reason the fixed
// "different order"/"different complaint" chip is kept literal below.
function splitOutCompleteDetails(picked, canonicalText) {
  const rest = picked.filter(q => q !== canonicalText);
  const hadComplete = rest.length !== picked.length;
  return { rest, completeChip: hadComplete ? canonicalText : null };
}

function pickAspectQuestions(bank, answeredAspects, count = 4, neverBackfillAspects = new Set(), session = null, rotationKey = null) {
  // The catch-all ("show me complete details") used to be excluded from
  // this pool entirely and only considered as backfill — but with 5+
  // other aspects usually available, backfill was rarely reached, so the
  // catch-all almost never actually appeared even on turns where it
  // would've been a genuinely useful suggestion (customer asked about
  // one field, hasn't seen everything yet). It's now folded into the
  // SAME pool as every other aspect and competes fairly for a slot,
  // excluded only when it's genuinely redundant (answeredAspects already
  // marks it covered — see the "complete" aspect handling at the call
  // sites, set only once every real aspect has already been shown).
  const specific = bank.filter(e => e.aspect);

  // Rotate the pool's starting point (session-tracked) so priority among
  // CURRENTLY-uncovered candidates shifts turn to turn instead of always
  // following fixed bank order — otherwise the catch-all, sitting last in
  // the array, would still rarely win a slot against aspects earlier in
  // the list even though both are equally uncovered.
  let pool = specific;
  if (session && rotationKey && specific.length > 0) {
    if (!session.productRotation) session.productRotation = {};
    const offset = session.productRotation[rotationKey] || 0;
    pool = specific.map((_, i) => specific[(i + offset) % specific.length]);
    session.productRotation[rotationKey] = (offset + 1) % specific.length;
  }

  const picked = [];
  for (const e of pool) {
    if (picked.length >= count) break;
    if (!answeredAspects.has(e.aspect) && !picked.includes(e.q)) picked.push(e.q);
  }
  if (picked.length < count) {
    // Nothing currently uncovered left to fill remaining slots — fall
    // back to previously-covered aspects (skipping whatever the customer
    // just directly asked about, which would be an exact repeat).
    for (const e of pool) {
      if (picked.length >= count) break;
      if (neverBackfillAspects.has(e.aspect)) continue;
      if (!picked.includes(e.q)) picked.push(e.q);
    }
  }
  // Absolute last resort: if every remaining candidate got skipped above
  // (e.g. a bank this small with everything either answered or directly
  // asked), allow them back in rather than showing fewer than requested.
  if (picked.length < count) {
    for (const e of bank) {
      if (picked.length >= count) break;
      if (!picked.includes(e.q)) picked.push(e.q);
    }
  }
  return picked.slice(0, count);
}

// Scans BOTH the answer AND the user's own question for aspect keywords.
// A markdown-structured answer (Order MCP) reliably names its own
// sections, but a prose answer (ComplaintSearch) doesn't always use the
// literal aspect word even when it's clearly covering that topic — e.g.
// answering "what's the status?" with "the recommended next step is..."
// never says the word "status", so scanning the answer alone missed it.
// The user's OWN question reliably names the topic they just asked about
// (it literally contains "status"), so unioning both catches what either
// side alone would miss.
function detectAnsweredAspects(usedTool, answerText, userQuery) {
  const patterns = ASPECT_PATTERNS[usedTool];
  if (!patterns) return new Set();
  const found = new Set();
  for (const [aspect, pattern] of Object.entries(patterns)) {
    if (pattern.test(answerText || "") || pattern.test(userQuery || "")) found.add(aspect);
  }
  return found;
}

// usedTool can be a single display name (e.g. "SolrProductSearch") or a
// combo string from multi-intent queries (e.g. "SolrProductSearch + PolicyInfo").
// We split, pull 1-2 from each matched module, dedupe, and cap the total.
// answerText (optional) is used to exclude aspects already covered in
// THIS specific answer (Order MCP, Warranty, Policy, Complaints all have
// aspect-tagged entries) — a follow-up chip never just repeats what the
// customer was already shown a sentence above it.
function generateSuggestedQuestions(usedTool, answerText, sessionPolicyContext, userQuery) {
  if (!usedTool || usedTool === "Blocked" || usedTool === "Processing") return [];
  // Terminal module — nothing useful left to suggest once a customer is
  // already being handed off to a human agent.
  if (usedTool === "HumanHandoff") return [];

  // PolicyInfo: prefer real document-grounded sub-questions (same policy,
  // deeper section) over the generic cross-policy bank, even in the
  // no-API-key static path. Falls back to sessionPolicyContext (the last
  // policy explicitly established this session) when THIS turn's answer
  // is a sub-question reply that doesn't restate the policy name. Always
  // excludes whatever question the customer just asked, so a chip never
  // repeats the question that produced the answer sitting above it.
  // (POLICY_FOLLOWUPS/extractPolicyEntities are declared later in the
  // file but that's fine — this function body only runs at request time,
  // well after module load finishes.)
  if (usedTool === "PolicyInfo") {
    const { matchedPolicy } = extractPolicyEntities(answerText || "");
    const effectivePolicy = matchedPolicy || sessionPolicyContext || null;
    const docQuestions = effectivePolicy ? POLICY_FOLLOWUPS[effectivePolicy] : null;
    if (docQuestions && docQuestions.length > 0) {
      return excludeJustAsked(docQuestions, userQuery).slice(0, 4);
    }
  }

  const parts = usedTool.split(" + ").map(p => p.trim());
  const picked = [];

  for (const part of parts) {
    let bank = SUGGESTION_BANK[part];
    if (!bank) continue;
    // Normalize: aspect-tagged modules use {q, aspect} objects; modules
    // with no sub-topics (SolrProductSearch, FAQ, HumanHandoff, Greeting,
    // Cache Hit) are still plain strings.
    let entries = bank.map(e => (typeof e === "string" ? { q: e, aspect: null } : e));
    const answeredAspects = detectAnsweredAspects(part, answerText);
    if (answeredAspects.size > 0) {
      const remaining = entries.filter(e => !answeredAspects.has(e.aspect));
      // Only exclude if something is actually left — never show zero chips
      // just because every aspect happened to be covered in one answer
      // (e.g. Order MCP's COMPLETE/FULL DETAILS shows everything at once).
      if (remaining.length > 0) entries = remaining;
    }
    // take up to 2 per module so a combo reply doesn't get crowded
    for (const e of entries.slice(0, parts.length > 1 ? 2 : 4)) {
      if (!picked.includes(e.q)) picked.push(e.q);
    }
  }

  if (picked.length === 0) return SUGGESTION_FALLBACK;
  return picked.slice(0, 4);
}

// =========================
// ENTITY EXTRACTION (per module)
// Pulls ONLY values that are guaranteed real, because they were already
// returned by the tool and are visible in the final answer text. This is
// what makes suggestions "grounded" — the LLM never sees raw free text,
// only a short verified list, so it can't invent an order ID, a size, or
// a color that doesn't exist in the catalog.
// =========================

// Product Search (product_search_rag_updated_Chatflow.json, toolAgent_0):
// browse format is "**name** — price | ⭐ rating", detail format is
// "**[name]**" followed by "• Brand: X". No color/size fields exist in
// the Solr schema (confirmed in SolrProductSearch tool code), so those
// are NEVER extracted or suggested.
const KNOWN_BRANDS = [
  "Samsung","Apple","OnePlus","Xiaomi","Redmi","POCO","Realme","OPPO","Vivo",
  "Motorola","Nothing","Under Armour","Nike","Adidas","Puma","Levi's","Zara",
  "Bata","Reebok","Woodland","ASICS","Skechers","Crocs","Vans","Converse",
  "Calvin Klein","H&M","Sperry","OtterBox","Hoka","Brooks","On Cloud","Altra",
  "Birkenstock","New Balance","Saucony","Google","Pixel",
];

// Only brands the WarrantySearch module's own prompt confirms it supports
// (smartphone_warranty_search brand list + shoe_warranty_search example
// brands). Used to gate cross-module warranty suggestions so we never
// suggest "warranty for this?" on a Zara dress or an unlisted brand —
// warranty only covers smartphones and a specific set of shoe brands.
const WARRANTY_ELIGIBLE_BRANDS = [
  "Apple","iPhone","Samsung","Galaxy","Google","Pixel","Motorola","Nothing",
  "Nike","Hoka","Brooks","On Cloud","Altra","Birkenstock",
];

// Lightweight top-level category detector — mirrors the same signal the
// Solr tool itself uses to route (shoes/apparel/mobile-and-accessories),
// used here only to ground PolicyInfo/WarrantySearch cross-suggestions,
// not to re-implement the tool's routing.
// =========================
// MULTI-TURN CLARIFICATION OPTIONS
// Per product_search_rag_updated_Chatflow.json's MULTI-TURN CLARIFICATION
// RULES, the tool agent asks exactly ONE clarification question before
// calling SolrProductSearch when required context (gender/age/type/budget)
// is missing — e.g. "Are you looking for men's, women's, boys', or girls'
// running shoes?" or "What type — clothing sets, rompers, sleepwear, or
// t-shirts?". When that happens, there are no products in the answer yet,
// so the useful "suggestions" ARE the answer options themselves — letting
// the customer click their answer instead of retyping it. Anchored on the
// two concrete phrasings the prompt actually uses, not generic parsing.
// =========================

// Structure A: dash-delimited list — "...— A, B, C, or D?" (used for
// age-bucket and product-type sub-clarifications per the prompt). No cap
// on how many raw options the question lists (some real answers list
// 10+) — we only cap how many are DISPLAYED, at the very end.
const FILLER_OPTION_PATTERNS = [
  /^(or\s+)?something else$/i, /^other$/i, /^others$/i, /^etc\.?$/i,
  /^and more$/i, /^anything else$/i,
];
function extractDashOptions(q) {
  const m = q.match(/[—–]\s*([^?]+)\?\s*$/);
  if (!m) return null;
  // Try ", or X" / " or X" BEFORE the plain comma split, so "or" never
  // ends up stuck to the last option.
  let options = m[1]
    .split(/\s*,?\s*\bor\b\s+|\s*,\s*/i)
    .map(s => s.trim().replace(/[.,;:]+$/, ""))
    .filter(Boolean)
    .filter(s => !FILLER_OPTION_PATTERNS.some(p => p.test(s))); // drop "or something else" etc.
  options = [...new Set(options)];
  if (options.length < 2 || options.length > 15) return null;
  return options;
}

// Structure B: relationship/gender clarification — closed 4-category
// vocabulary (men/women/boys/girls), covering BOTH possessive phrasing
// ("men's, women's, boys', or girls'") AND plain phrasing ("a boy, a
// girl, a man, or a woman") since the prompt uses both depending on
// context. Matches are ordered by where they first appear in the
// question, so chips read in the same order the bot listed them.
const RELATIONSHIP_CATEGORIES = [
  { label: "Men's",   re: /\bmen'?s?\b|\ba\s+man\b/i },
  { label: "Women's", re: /\bwomen'?s?\b|\ba\s+woman\b/i },
  { label: "Boys'",   re: /\bboys?'?\b|\ba\s+boy\b/i },
  { label: "Girls'",  re: /\bgirls?'?\b|\ba\s+girl\b/i },
];
function extractRelationshipOptions(q) {
  const matches = RELATIONSHIP_CATEGORIES
    .map(c => ({ label: c.label, idx: q.search(c.re) }))
    .filter(c => c.idx !== -1)
    .sort((a, b) => a.idx - b.idx)
    .map(c => c.label);
  return matches.length >= 2 ? matches : null;
}

// Single-gender detection (vs. extractRelationshipOptions above, which
// needs 2+ matches to be a valid clarification-question extraction).
// Used to establish/update the sticky "which gender is this conversation
// about" session context — e.g. "mens apparel" establishes "Men's", and
// that context then carries into later product-search follow-ups even
// when a specific reply doesn't repeat the word (mirrors lastPolicyContext).
function detectSingleGender(text) {
  if (!text) return null;
  const matches = RELATIONSHIP_CATEGORIES
    .map(c => ({ label: c.label, idx: text.search(c.re) }))
    .filter(c => c.idx !== -1)
    .sort((a, b) => a.idx - b.idx);
  return matches.length > 0 ? matches[0].label : null;
}

function extractClarificationOptions(answerText) {
  const q = answerText.trim();
  if (!q.endsWith("?")) return null;
  if (q.length > 400) return null;
  // Already has product results (bold name + price) — this is a results
  // turn, not a clarification turn.
  if (/\*\*[^*]+\*\*\s*(?:—|-)\s*\$?[\d,]+\.?\d*/.test(q)) return null;

  const options = extractDashOptions(q) || extractRelationshipOptions(q);
  if (!options) return null;
  return options.map(o => o.charAt(0).toUpperCase() + o.slice(1)).slice(0, 4);
}

// =========================
// CATALOG LISTING (CatalogMetadata answers)
// product_search_rag_updated_Chatflow's toolAgent_0 has a SECOND tool,
// CatalogMetadata, used for "what brands/models/categories do you
// carry?" questions — a distinct answer shape from both product results
// (numbered, bold name + price) and clarification questions (ends in
// "?"). Per that prompt's own CATALOG RESPONSE FORMAT template, it's
// ALWAYS a bullet list ("• Item"), optionally grouped under bold section
// headers ("**Section Name**"), and NEVER shows prices. deriveUsedTool()
// still labels this "SolrProductSearch" (both tools live under the same
// module), so we detect the shape here rather than relying on a label.
// The useful follow-ups are simply "show me <item>" for a few of the
// actual listed brands/categories — e.g. after "Here are the mobile
// brands we carry: • Apple • Samsung • OnePlus", offer "Show me Apple" /
// "Show me Samsung", not a generic browsing chip.
//
// IMPORTANT: "is this a bulleted list with 2+ items" alone is too loose —
// plenty of OTHER modules' answers are bulleted too (e.g. a warranty
// exclusions list: "* Physical damage * Unauthorized repairs..."), which
// would get misclassified as a catalog listing and produce nonsense
// chips like "Show me Physical damage". Anchored instead to the two
// intro phrasings the prompt's own CATALOG RESPONSE FORMAT template
// actually uses ("Here are the ... :" / "We carry products across...") —
// real catalog answers always open with one of these; unrelated bulleted
// answers from other modules essentially never do.
// =========================
const CATALOG_INTRO_PATTERN = /^(here are the [^\n]*:|we carry products across)/i;

function extractCatalogItems(answerText) {
  const text = (answerText || "").trim();
  if (text.endsWith("?")) return null; // clarification question, not a listing
  if (/\*\*[^*]{3,80}\*\*\s*(?:—|-)\s*\$?[\d,]+\.?\d*/.test(text)) return null; // has prices — product results, not a catalog listing
  if (!CATALOG_INTRO_PATTERN.test(text)) return null; // not the confirmed catalog intro phrasing

  const items = [];
  for (const rawLine of text.split("\n")) {
    // Bullet item line: "• Item", "- Item", or "* Item" — bold SECTION
    // headers ("**Men's Clothing**") don't start with a bullet marker,
    // so they're naturally excluded without extra logic.
    const m = rawLine.trim().match(/^[•\-*]\s+(.+)$/);
    if (!m) continue;
    const item = m[1].trim().replace(/\*\*/g, "").replace(/[.,;:]+$/, "");
    if (item.length > 0 && item.length <= 60) items.push(item);
  }
  const unique = [...new Set(items)];
  return unique.length >= 2 ? unique : null;
}

// The noun that makes a bare catalog item ("Samsung") read as an actual
// product search ("Samsung smartphones") instead of just repeating the
// brand name back. Mobile explicitly says "smartphones" rather than the
// more generic "phones" used elsewhere, per how this category is asked
// about when browsing brands specifically.
function catalogCategoryNoun(category) {
  if (category === "mobile") return "smartphones";
  if (category === "shoes") return "shoes";
  if (category === "apparel") return "apparel";
  return "options";
}

// First 2 chips: plain "Show me <item> <category>" browse, using real
// listed items. Last 2: made VERSATILE by folding in a real price or
// rating band (reusing the same PRICE_BANDS/RATING_BANDS pools and
// session-rotation as composeProductFilterQuestions) instead of just
// repeating more bare "Show me <brand>" chips — so a catalog listing
// answer leads somewhere more specific than only "browse this brand."
function composeCatalogQuestions(catalogItems, category, session) {
  if (!catalogItems || catalogItems.length === 0) return [];
  const noun = catalogCategoryNoun(category);
  const qs = [];

  const plainCount = Math.min(2, catalogItems.length);
  for (let i = 0; i < plainCount; i++) qs.push(`Show me ${catalogItems[i]} ${noun}`);

  // Reuse item 3/4 if the listing is long enough; otherwise cycle back
  // to item 1/2 rather than leaving a slot empty.
  const item3 = catalogItems[2] || catalogItems[0];
  const item4 = catalogItems[3] || catalogItems[1] || catalogItems[0];
  const priceBand = rotatePick(session, `catalogPrice:${category}`, PRICE_BANDS[category] || PRICE_BANDS.mobile);
  const ratingBand = rotatePick(session, `catalogRating:${category}`, RATING_BANDS);
  qs.push(`Show me ${item3} ${noun} under $${priceBand}`);
  qs.push(`Show me ${item4} ${noun} rated above ${ratingBand.toFixed(1)}`);

  return qs.slice(0, 4);
}

function detectTopCategory(answerText) {
  const t = (answerText || "").toLowerCase();
  if (/\b(shoes?|sneakers?|boots?|sandals?|footwear|loafers?|heels?|flats?|sports?\s+shoes?)\b/.test(t)) return "shoes";
  if (/\b(shirts?|dress(es)?|jeans?|jackets?|kurtas?|apparel|clothe?s?|hoodies?|sweaters?|trousers?|leggings?|blazers?|suits?|vests?|tunics?|coats?|skirts?|tops?)\b/.test(t)) return "apparel";
  if (/\b(phones?|smartphones?|mobiles?|chargers?|earphones?|headphones?|screen\s+protectors?|back\s+covers?)\b/.test(t)) return "mobile";
  return null;
}

function extractProductEntities(answerText) {
  const products = [];
  // Matches a product line by its PRICE + RATING suffix — "— $49.99 |
  // ⭐ 4.5/5" — instead of requiring **bold** around the name. Bold
  // formatting turned out to be inconsistent in real Response Generation
  // output (present on multi-result lists, often absent on single-result
  // or filtered-result answers), which was silently dropping detection
  // to 0 products and falling back to the generic static bank on those
  // turns. Price+rating suffix is the one thing every product line
  // actually has in common across every answer shape observed so far.
  // Leading "1. "/bullet and surrounding ** are optional and stripped.
  const lineRe = /^\s*(?:\d+\.\s*)?\*{0,2}([^\n$*]{3,120}?)\*{0,2}\s*[—-]\s*\$\s*([\d,]+\.?\d*)(?:\s*\|\s*⭐?\s*[\d.]+\s*\/\s*5)?/gm;
  let m;
  while ((m = lineRe.exec(answerText)) && products.length < 5) {
    const name = m[1].trim();
    if (name.length < 3) continue; // skip stray dash/number-only matches
    products.push({ name, price: m[2] });
  }
  const brand = KNOWN_BRANDS.find(b => answerText.includes(b)) || null;
  const category = detectTopCategory(answerText);
  const warrantyEligible = !!(brand && WARRANTY_ELIGIBLE_BRANDS.includes(brand) && (category === "shoes" || category === "mobile"));
  return { products, brand, category, warrantyEligible };
}

// =========================
// PRODUCT FILTER QUESTIONS (gender + category aware)
// Grounded in what the SolrProductSearch tool code actually supports:
// extractPriceFromQuery() (min/max price), resolveSort() (rating-based
// sort), detectBrand() (brand filter), and detectCategoryPrefix() (real
// category subtypes per department). Replaces generic cross-module
// suggestions with questions this module can directly fulfill — a price
// filter, a rating filter, a brand filter, and (when a category is
// known) a gender-aware subtype suggestion, e.g. "running shoes" for
// men vs "ballet flats" for girls, pulled from the tool's own supported
// category list, not invented.
// =========================
// Real subtype vocabulary per category/gender (used only to phrase the
// price/rating/brand questions naturally, e.g. "running shoes under $50"
// instead of generic "options under $50" — no separate subtype question
// is generated on its own).
const SHOE_SUBTYPES = {
  "Men's":   ["running shoes", "casual shoes", "formal shoes", "sandals"],
  "Women's": ["running shoes", "casual shoes", "sandals", "flats"],
  "Boys'":   ["running shoes", "casual shoes", "sandals", "school shoes"],
  "Girls'":  ["casual shoes", "sandals", "ballet flats", "school shoes"],
  default:   ["running shoes", "casual shoes", "sandals", "formal shoes"],
};
const APPAREL_SUBTYPES = {
  "Men's":   ["t-shirts", "shirts", "jeans", "jackets"],
  "Women's": ["tops", "dresses", "jeans", "leggings"],
  "Boys'":   ["t-shirts", "shorts", "jeans"],
  "Girls'":  ["tops", "dresses", "leggings"],
  default:   ["t-shirts", "jeans", "jackets"],
};

// LLM prose sometimes renders straight punctuation as "smart" typographic
// characters (curly apostrophe, non-breaking hyphen, etc.) — normalize
// before running any text-shape regex against it (ID matching, intro-line
// parsing) so a stylistic rendering choice doesn't break detection.
const TYPOGRAPHIC_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015]/g;
const TYPOGRAPHIC_APOSTROPHES = /[\u2018\u2019\u02BC]/g;
function normalizeTypography(text) {
  return (text || "").replace(TYPOGRAPHIC_DASHES, "-").replace(TYPOGRAPHIC_APOSTROPHES, "'");
}
// Kept as an alias — extractOrderEntities/extractComplaintEntities were
// written against this name before apostrophes were added to the mix.
const normalizeDashes = normalizeTypography;

// Reads the SPECIFIC noun phrase straight out of the answer's own intro
// line (e.g. "blazers" from "Here are the men's blazers under $100 I
// found:") instead of only matching a fixed, inevitably-incomplete
// vocabulary list. A customer asking about a specific sub-category (like
// blazers) should get filter questions about THAT sub-category, not a
// generic fallback just because "blazers" wasn't a word we thought to
// hardcode. Guards against capturing something generic/unhelpful (a bare
// brand name, "products", "items") by falling back to the vocabulary list
// in that case.
function detectSubtypeFromIntro(answerText) {
  const line = normalizeTypography((answerText || "").split("\n")[0] || "");
  const m = line.match(/^here are (?:the\s+)?(?:(?:men|women|boys|girls)'s?\s+)?([a-z][a-z\s'-]*?)(?:\s+under\s+\$|\s+i found|\s+we carry|\s*:|\s*$)/i);
  if (!m) return null;
  const phrase = m[1].trim().replace(/^(top|best|available|some)\s+/i, "").toLowerCase();
  if (phrase.length < 3) return null;
  if (/^(products?|items?|options?|results?)$/.test(phrase)) return null; // too generic to be useful
  if (KNOWN_BRANDS.some(b => phrase.includes(b.toLowerCase()))) return null; // e.g. "Nike products" — not a real subtype
  return phrase;
}

// Pulls out whatever specific subtype the answer is actually about —
// first from the answer's own intro phrasing (covers anything the
// customer asked for, e.g. "blazers"), falling back to the fixed
// vocabulary list only when the intro line doesn't parse cleanly (e.g. a
// cached/differently-worded answer).
function detectSubtypeLabel(category, genderContext, answerText) {
  const introPhrase = detectSubtypeFromIntro(answerText);
  if (introPhrase) return introPhrase;

  const lower = normalizeTypography(answerText || "").toLowerCase();
  const list = category === "shoes" ? (SHOE_SUBTYPES[genderContext] || SHOE_SUBTYPES.default)
             : category === "apparel" ? (APPAREL_SUBTYPES[genderContext] || APPAREL_SUBTYPES.default)
             : null;
  if (!list) return category === "mobile" ? "phones" : "options";
  return list.find(s => lower.includes(s)) || (category === "shoes" ? "shoes" : "clothing");
}

// =========================
// PRODUCT FILTER QUESTIONS (fixed bands, category/brand/gender aware)
// Per your call: the catalog is small enough that these DON'T need to be
// derived by parsing the exact prices/ratings in the current answer — a
// fixed, sensible set of bands per category is simpler and reliable.
// Grounded in what SolrProductSearch actually supports: price range,
// rating sort, brand filter, gender filter (real Solr fields, confirmed
// in the tool code) — nothing here is invented.
// =========================
const PRICE_BANDS = {
  mobile:  [150, 250, 400, 500],
  shoes:   [30, 50, 75, 100],
  apparel: [30, 50, 75, 100],
};
const RATING_BANDS = [4.0, 4.3, 4.5, 4.8];

// Real, recurring brands per category confirmed against solr_products.json
// (curated to recognizable brand-shopping names, not raw frequency — e.g.
// apparel's top sellers by row count are private-label/print-on-demand
// names like "ThisWear"/"Spreadshirt", which aren't useful things to
// suggest, so this list uses the recognizable subset instead).
const BRAND_POOLS = {
  mobile:  ["Samsung", "Apple", "OnePlus", "Xiaomi", "Realme", "OPPO", "Motorola"],
  shoes:   ["Nike", "Adidas", "ASICS", "Skechers", "New Balance", "Vans", "Crocs", "Sperry"],
  apparel: ["Calvin Klein", "French Toast", "Weatherproof", "Under Armour", "Carter's"],
};

// Apparel's brand pool above is grounded against general apparel
// (t-shirts/tops/dresses/jeans) — but "apparel" has sub-sections that
// don't share that same brand coverage. Verified directly against
// solr_products.json: Calvin Klein and French Toast have ZERO blazer/suit
// items (despite 44 and 21 items respectively elsewhere), Weatherproof
// has 1, Under Armour has 3 — suggesting any of these as a "blazers from
// X" filter risks a genuine zero-result dead end. Rather than maintain a
// brand pool per every possible sub-section (which will always be
// incomplete), subtypes confirmed thin like this skip the brand question
// entirely and get a different-clothing-type suggestion instead.
const APPAREL_THIN_BRAND_SUBTYPES = ["blazer", "blazers", "suit", "suits", "dress suit", "tuxedo", "vest", "vests"];
function isThinBrandApparelSubtype(subtype) {
  return APPAREL_THIN_BRAND_SUBTYPES.some(s => (subtype || "").includes(s));
}
// Real alternates within the same formalwear cluster to offer instead of
// an unsafe brand filter — genuinely different next steps, not a
// rewording of the same request.
const APPAREL_FORMAL_ALTERNATES = ["dress shirts", "dress pants", "ties"];
function pickApparelAlternateSubtype(currentSubtype, session) {
  const pool = APPAREL_FORMAL_ALTERNATES.filter(s => s !== currentSubtype);
  return pool.length > 0 ? rotatePick(session, `apparelAlt:${currentSubtype}`, pool) : null;
}

// A few natural phrasings for the gender-swap chip, on top of the LLM
// rephrase pass — keeps it from being the identical sentence every time
// even before rephraseForVariety touches it.
const GENDER_SWAP_PHRASINGS = {
  "Men's":   subtype => `Show me the women's ${subtype} instead`,
  "Women's": subtype => `Show me the men's ${subtype} instead`,
};

// Cycles through a fixed list using a per-session, per-key counter so
// consecutive turns (even for the identical category/input) don't always
// land on the same band/brand — this is the "connected to input, not
// random" variety mechanism: the pool and the filtering are always
// relevance-first, rotation only decides WHICH equally-valid pick comes
// next, exactly like agreed.
function rotatePick(session, key, list) {
  if (!session.productRotation) session.productRotation = {};
  const idx = session.productRotation[key] || 0;
  session.productRotation[key] = (idx + 1) % list.length;
  return list[idx % list.length];
}

// Suggests switching to an ENTIRELY different category — a genuinely
// different, still fully answerable SolrProductSearch query (never a
// catalog browse, never a different module). Used both as mobile's
// dedicated "different" slot (phones have no same-category gender
// variation to offer) and as a ROTATING alternative for shoes/apparel's
// last question, so two consecutive product searches don't always
// produce the identical SHAPE of "different" suggestion.
// Phrased as a plain, concrete "Show me X under $Y" request — same
// pattern as every other filter question — rather than a conversational
// "I'd like to see X instead", which is easy for an LLM rewording pass to
// drift into something wordier/more roundabout and harder for the
// downstream Intent Detector to reliably parse as a simple category+price
// search. Mobile is never gendered in the phrase (phones aren't
// gendered); shoes/apparel targets keep whatever gender is already
// established in THIS conversation (reads naturally — "men's apparel"
// when already mid a men's search) rather than picking an unrelated one,
// falling back to a rotated default only when no gender context exists
// yet at all.
// WarrantySearch only actually supports these brands per its own tool
// agent system prompt (warranty_search_final_Chatflow.json) — anything
// else, it explicitly says so without calling a tool. Distinct from the
// general shopping BRAND_POOLS above, which reflect what the CATALOG
// sells, not what warranty lookups are supported for.
const WARRANTY_MOBILE_BRANDS = ["Apple", "Samsung", "Google", "Motorola", "Nothing"];
const WARRANTY_SHOE_BRANDS = ["Nike", "Hoka", "Brooks", "On Cloud", "Altra", "Birkenstock", "Adidas", "New Balance", "ASICS", "Saucony"];

// The fixed structured sections WarrantySearch's own prompt mandates per
// category (OUTPUT PRESENTATION for phones; the Duration/Defect
// Criteria/Claim Process fields for footwear) — used to ask about
// whichever section THIS answer hasn't already covered.
const WARRANTY_SECTIONS = {
  mobile: [
    { q: "What's covered under the limited warranty?", test: /limited warranty/i },
    { q: "What does the extended protection plan include?", test: /extended (plan|protection)|protection plan/i },
    { q: "How much does the protection plan cost?", test: /pricing|\$\d/i },
  ],
  shoes: [
    { q: "How long is the warranty coverage period?", test: /duration|coverage period|\b\d+\s*(year|month)/i },
    { q: "What counts as a defect under this warranty?", test: /defect criteria|manufacturing defect/i },
    { q: "How do I file a claim for this?", test: /claim (process|steps)|file (a|the) claim|submit/i },
  ],
};

// Picks up to n DISTINCT items from list, rotating the starting offset
// each call (session-tracked) so consecutive turns don't always surface
// the same brands/section first, without ever repeating an item within
// the same single response.
function pickNDistinct(session, key, list, n) {
  if (!list || list.length === 0) return [];
  if (!session.productRotation) session.productRotation = {};
  const start = session.productRotation[key] || 0;
  session.productRotation[key] = (start + n) % list.length;
  const result = [];
  for (let i = 0; i < list.length && result.length < n; i++) {
    result.push(list[(start + i) % list.length]);
  }
  return result;
}

function composeWarrantyQuestions(answerText, userQuery, session) {
  const text = normalizeTypography(answerText || "");
  const query = normalizeTypography(userQuery || "");
  const isMobile = /\b(phone|smartphone|iphone|galaxy|pixel|motorola|nothing phone|android)\b/i.test(text)
    || /\b(phone|smartphone|iphone|galaxy|pixel|motorola|android)\b/i.test(query);
  const category = isMobile ? "mobile" : "shoes";
  const brandList = category === "mobile" ? WARRANTY_MOBILE_BRANDS : WARRANTY_SHOE_BRANDS;
  const noun = category === "mobile" ? "phones" : "shoes";

  const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const currentBrand = brandList.find(b => new RegExp(`\\b${escapeRegex(b)}\\b`, "i").test(text));

  const altPool = brandList.filter(b => b !== currentBrand);
  const altBrands = pickNDistinct(session, `warrantyBrand:${category}:${currentBrand || "none"}`, altPool, 3);
  const qs = altBrands.map(b => `What's the warranty on ${b} ${noun}?`);

  const sections = WARRANTY_SECTIONS[category];
  const uncovered = sections.filter(s => !s.test.test(text));
  const sectionPool = (uncovered.length > 0 ? uncovered : sections).map(s => s.q);
  const sectionPick = pickNDistinct(session, `warrantySection:${category}`, sectionPool, 1);
  if (sectionPick.length > 0) qs.push(sectionPick[0]);

  return excludeJustAsked(qs.slice(0, 4), userQuery);
}

function crossCategorySwitchQuestion(fromCategory, genderContext, session) {
  const targets = ["mobile", "shoes", "apparel"].filter(c => c !== fromCategory);
  const target = rotatePick(session, `categorySwitch:${fromCategory}`, targets);
  const targetNoun = target === "mobile" ? "smartphones" : target;
  const priceBand = rotatePick(session, `price:${target}`, PRICE_BANDS[target] || PRICE_BANDS.mobile);
  if (target === "mobile") return `Show me ${targetNoun} under $${priceBand}`;
  const gender = genderContext
    ? genderContext.toLowerCase()
    : rotatePick(session, `categorySwitchGender:${fromCategory}`, ["men's", "women's"]);
  return `Show me ${gender} ${targetNoun} under $${priceBand}`;
}

function composeProductFilterQuestions(entities, genderContext, answerText, session) {
  const category = entities.category || "mobile";
  const brand = entities.brand;
  const subtype = detectSubtypeLabel(category, genderContext, answerText);
  const gPhrase = (category !== "mobile" && genderContext) ? genderContext.toLowerCase() + " " : "";

  const qs = [];

  // ---- SAME 2: fixed price + rating bands, rotated for variety ----
  const priceBand = rotatePick(session, `price:${category}`, PRICE_BANDS[category] || PRICE_BANDS.mobile);
  qs.push(`Show me ${gPhrase}${subtype} under $${priceBand}`);

  const ratingBand = rotatePick(session, `rating:${category}`, RATING_BANDS);
  qs.push(`Show me ${gPhrase}${subtype} rated above ${ratingBand.toFixed(1)}`);

  // Apparel-only: is a brand question even safe for this specific
  // subtype? (See APPAREL_THIN_BRAND_SUBTYPES above.)
  const apparelBrandUnsafe = category === "apparel" && isThinBrandApparelSubtype(subtype);

  // ---- DIFFERENT 2, slot A: brand alternative — never repeats current brand ----
  const brandPool = apparelBrandUnsafe ? [] : (BRAND_POOLS[category] || BRAND_POOLS.mobile).filter(b => b !== brand);
  const brandAlt = brandPool.length > 0 ? rotatePick(session, `brand:${category}:${brand || "none"}`, brandPool) : null;
  if (brandAlt) {
    qs.push(`Show me ${gPhrase}${subtype} from ${brandAlt} instead`);
  } else if (apparelBrandUnsafe) {
    const altSubtype = pickApparelAlternateSubtype(subtype, session);
    if (altSubtype) qs.push(`Show me ${gPhrase}${altSubtype} instead`);
  }

  // ---- DIFFERENT 2, slot B: category-specific rule ----
  if (category === "mobile") {
    // Never a gender question for phones directly — but instead of a
    // warranty cross-check (routes to a DIFFERENT module, WarrantySearch,
    // rather than staying in product search), offer a real category
    // switch: a genuinely different, still fully answerable
    // SolrProductSearch query, not a catalog browse and not another
    // module.
    qs.push(crossCategorySwitchQuestion("mobile", genderContext, session));
  } else if (category === "shoes") {
    // Rotate between the existing same-category variation (gender swap
    // within shoes) and a full category switch, so the last question
    // doesn't follow the identical pattern every single turn — without
    // this, two shoe searches in a row always produce the same SHAPE of
    // "different" question even though the wording varies.
    const slotBType = rotatePick(session, "shoesSlotBType", ["same", "switch"]);
    if (slotBType === "switch") {
      qs.push(crossCategorySwitchQuestion("shoes", genderContext, session));
    } else {
      // Shoes: men's/women's are the same catalog filtered by gender, so
      // swapping to the opposite gender is always a safe, real filter —
      // whether or not a gender is established yet (defaults to offering
      // the women's view first if none is set).
      const swapFrom = genderContext || "Men's";
      qs.push(GENDER_SWAP_PHRASINGS[swapFrom](subtype));
    }
  } else if (category === "apparel") {
    // Same rotation idea as shoes — but the "switch" option always wins
    // when no gender is established yet, since apparel's own same-
    // category options (gender-first-time / alt-subtype / second brand)
    // are each conditional anyway, and a category switch is always safe
    // as an alternative regardless of gender state.
    const slotBType = rotatePick(session, "apparelSlotBType", ["same", "switch"]);
    if (slotBType === "switch") {
      qs.push(crossCategorySwitchQuestion("apparel", genderContext, session));
    } else if (!genderContext) {
      // Apparel: men's/women's are genuinely different product lines, so
      // only offer a gender filter the FIRST time (nothing established
      // yet) — never swap once one is set, to avoid implying a "women's
      // version" of something that may not map cleanly.
      const firstGender = rotatePick(session, "apparelFirstGender", ["Men's", "Women's"]);
      qs.push(`Show me ${firstGender.toLowerCase()} ${subtype}`);
    } else if (apparelBrandUnsafe) {
      // Brand pool is unsafe here too — a second different clothing
      // type instead of a second (equally unsafe) brand alternative.
      const altSubtype2 = pickApparelAlternateSubtype(subtype, session);
      if (altSubtype2) qs.push(`Show me ${gPhrase}${altSubtype2} instead`);
    } else {
      const secondBrandPool = brandPool.filter(b => b !== brandAlt);
      const secondBrand = secondBrandPool.length > 0 ? rotatePick(session, `brand2:${category}:${brand || "none"}`, secondBrandPool) : null;
      if (secondBrand) qs.push(`Show me ${gPhrase}${subtype} from ${secondBrand} instead`);
    }
  }

  return qs.slice(0, 4);
}

// =========================
// "NO RESULTS" PIVOT QUESTIONS
// Matches the actual no-results template Response Generation uses
// ("We couldn't find any... Try using different keywords or broadening
// your search criteria.") — a distinct answer shape from a real product
// list, so it needs its own detection and its own question set rather
// than falling through to the generic static bank.
// =========================
function isNoResultsAnswer(answerText) {
  return /couldn't find any|could not find any|no (matching\s+)?(products|results)\s+(found|matched)|try (using\s+)?different keywords|broaden(ing)? your search/i.test(answerText || "");
}

// Pulls the subtype out of the no-results sentence itself (e.g. "blazers"
// from "We couldn't find any men's blazers from Calvin Klein.") — same
// idea as detectSubtypeFromIntro but matched against THIS answer shape's
// phrasing instead of the "Here are..." results-list phrasing.
function detectSubtypeFromNoResults(answerText) {
  const t = normalizeTypography(answerText || "");
  const m = t.match(/couldn't find any\s+(?:(?:men|women|boys|girls)'s?\s+)?([a-z][a-z\s'-]*?)(?:\s+from\s+|\s*\.|\s*$)/i);
  if (!m) return null;
  const phrase = m[1].trim().toLowerCase();
  if (phrase.length < 3) return null;
  if (KNOWN_BRANDS.some(b => phrase.includes(b.toLowerCase()))) return null;
  return phrase;
}

// A rotating set of alternative things to pivot to when a search comes
// back empty. Deliberately NOT tied to one fixed pair of words — the
// point is "offer something plausibly different," and which specific
// alternative comes up should vary rather than always being the same
// two options.
const APPAREL_PIVOT_SUBTYPES = ["t-shirts", "jeans", "jackets", "dresses", "tops", "leggings", "hoodies", "formal shirts"];
const APPAREL_PIVOT_LINES = ["Women's", "Men's", "Boys'", "Girls'"];

function composeNoResultsQuestions(category, genderContext, brand, subtype, session) {
  const cat = category || "apparel";
  const noun = subtype || (cat === "shoes" ? "shoes" : cat === "mobile" ? "phones" : "clothing");
  const gPhrase = (cat !== "mobile" && genderContext) ? genderContext.toLowerCase() + " " : "";
  const qs = [];

  // Same 2: broaden the SAME search without the brand that just came up empty.
  const priceBand = rotatePick(session, `noResultsPrice:${cat}`, PRICE_BANDS[cat] || PRICE_BANDS.mobile);
  qs.push(`Show me ${gPhrase}${noun} under $${priceBand}`);
  const ratingBand = rotatePick(session, `noResultsRating:${cat}`, RATING_BANDS);
  qs.push(`Show me ${gPhrase}${noun} rated above ${ratingBand.toFixed(1)}`);

  if (cat === "apparel") {
    // Apparel sub-categories (like blazers) often only carry a couple of
    // real brands — suggesting yet another specific brand after one just
    // came back empty tends to just hit a second dead end. Pivot to
    // something more likely to actually have results: a different
    // clothing type, or a different gender/age line — kids' and
    // women's/men's apparel are genuinely separate product lines here,
    // not just a filter on the same one, so this is a real alternative,
    // not a repeat of the same search.
    const subtypePool = APPAREL_PIVOT_SUBTYPES.filter(s => s !== noun);
    const pivotSubtype = subtypePool.length > 0 ? rotatePick(session, "pivotSubtype:apparel", subtypePool) : null;
    if (pivotSubtype) qs.push(`Show me ${gPhrase}${pivotSubtype} instead`);

    const linePool = APPAREL_PIVOT_LINES.filter(g => g !== genderContext);
    const pivotLine = linePool.length > 0 ? rotatePick(session, "pivotLine:apparel", linePool) : null;
    if (pivotLine) qs.push(`Show me ${pivotLine.toLowerCase()} ${noun} instead`);
  } else {
    // Shoes/mobile have well-stocked, recognizable brand catalogs — a
    // different real brand is still a reasonable next try here.
    const brandPool = (BRAND_POOLS[cat] || BRAND_POOLS.mobile).filter(b => b !== brand);
    const brandAlt = brandPool.length > 0 ? rotatePick(session, `noResultsBrand:${cat}:${brand || "none"}`, brandPool) : null;
    if (brandAlt) qs.push(`Show me ${gPhrase}${noun} from ${brandAlt} instead`);
  }

  return qs.slice(0, 4);
}

// normalizeDashes is now an alias for normalizeTypography, defined once
// earlier in the file alongside detectSubtypeFromIntro (both need the
// same dash/apostrophe normalization) — no separate definition needed here.

// Order MCP (Order_mcp_module_Chatflow, toolAgent_0): the order ID
// itself is matched directly by its ORD-###### pattern (like
// ComplaintSearch below) rather than requiring the "**Order ID:**" bold
// label — that label isn't guaranteed to be bold (or even present) on
// every answer shape, e.g. a short single-field reply to "what's my
// order status" vs. the full "📦 Order Summary" table. Status fields are
// still read with a tolerant (optional-bold) label match since those
// aren't needed to decide IF we have an order, only to describe it.
function extractOrderEntities(answerText) {
  const t = normalizeDashes(answerText);
  const orderId = (t.match(/\bORD-\d{4,}\b/i) || [])[0] || null;
  const orderStatus = (t.match(/\*{0,2}Order Status:?\*{0,2}\s*([^\n|*]+)/i) || [])[1];
  const deliveryStatus = (t.match(/\*{0,2}Delivery Status:?\*{0,2}\s*([^\n|*]+)/i) || [])[1];
  return {
    orderId,
    orderStatus: orderStatus ? orderStatus.trim() : null,
    deliveryStatus: deliveryStatus ? deliveryStatus.trim() : null,
  };
}

// Complaints module: complaint IDs are always formatted CMP-##### and
// order refs ORD-###### per the complaints system prompt. Dash-normalized
// for the same reason as above.
function extractComplaintEntities(answerText) {
  const t = normalizeDashes(answerText);
  const complaintId = (t.match(/\bCMP-\d{4,}\b/i) || [])[0] || null;
  const orderId = (t.match(/\bORD-\d{4,}\b/i) || [])[0] || null;
  return { complaintId, orderId };
}

// Warranty: brand/model are stated in the answer since the tool agent
// is required to detect and act on them before calling its tool.
const WARRANTY_BRANDS = ["Apple","iPhone","Samsung","Galaxy","Google","Pixel","Motorola","Nothing","Nike","Hoka","Brooks","On Cloud","Altra","Birkenstock","Adidas","New Balance","ASICS","Saucony"];
function extractWarrantyEntities(answerText) {
  const brand = WARRANTY_BRANDS.find(b => answerText.includes(b)) || null;
  return { brand };
}

// =========================
// POLICY DOCUMENT SUB-TOPIC QUESTIONS
// Built directly from the actual section structure of Policies_Document_2.pdf
// (Return/Refund/Cancellation/Warranty/Exchange/Shipping/Payment/Replacement
// Policy — each with its own numbered sections in the real document). When
// a customer asks about ONE policy, the best follow-ups are DEEPER questions
// about THAT SAME policy's other sections — not a generic "ask about a
// different policy" chip. Deterministic and grounded, same reliability
// model as the FAQ knowledge base: every question maps to a section that
// genuinely exists in the document, so nothing here can be unanswerable.
// =========================
const POLICY_FOLLOWUPS = {
  "Return Policy": [
    "How do I initiate a return request?",
    "What items are not eligible for return?",
    "What's the return window for shoes?",
    "What's the return window for mobile & accessories?",
    "What's the return window for apparel?",
    "What condition must the product be in to qualify for a return?",
    "Do I need proof of purchase to return an item?",
    "How long does pickup take after a return is approved?",
    "What if pickup isn't available in my area?",
    "Why would my return request get rejected?",
  ],
  "Refund Policy": [
    "How long does a refund take for prepaid orders?",
    "How long does a COD refund take?",
    "Can I get a partial refund?",
    "Why would a refund request be rejected?",
    "What if my refund is delayed?",
    "Which payment mode will my refund go to?",
    "Can I change my refund mode after it's initiated?",
    "What happens if I paid but my order failed?",
    "When is a refund initiated after cancellation?",
    "Are shipping charges refunded too?",
  ],
  "Cancellation Policy": [
    "How do I cancel my order?",
    "Can I cancel an order after it's shipped?",
    "What items can't be cancelled?",
    "What happens to my refund if I cancel a prepaid order?",
    "Can the platform cancel my order?",
    "Can I cancel before my order is confirmed?",
    "Is there a charge for cancelling a COD order?",
    "What happens if I cancel orders too often?",
    "Can a cancelled order be reinstated?",
    "Why might the platform cancel my order on its own?",
  ],
  "Warranty Policy": [
    "How do I file a warranty claim?",
    "What's not covered under warranty?",
    "Do shoes come with a warranty?",
    "How long is the warranty period?",
    "Who decides whether my product is repaired or replaced?",
    "Is warranty provided by you or the manufacturer?",
    "Do accessories like chargers have warranty coverage?",
    "What happens if my product is already out of warranty?",
    "When does the warranty period start?",
    "Are you responsible for repair timelines?",
  ],
  "Exchange Policy": [
    "How do I request an exchange?",
    "Can I exchange apparel for a different size?",
    "How many times can I exchange the same item?",
    "What items can't be exchanged?",
    "What happens if the replacement item isn't available?",
    "What's the exchange window for shoes?",
    "Is exchange available for mobile phones?",
    "Can I exchange a defective phone?",
    "What condition must the product be in for exchange?",
    "Can an exchange be converted into a refund?",
  ],
  "Shipping Policy": [
    "How long does delivery take for shoes?",
    "Is shipping free on my order?",
    "How can I track my order?",
    "What happens if my delivery is delayed?",
    "What if my package looks damaged on delivery?",
    "How long does delivery take for mobiles and accessories?",
    "How long does delivery take for apparel?",
    "How many delivery attempts will you make?",
    "What if my address is incorrect?",
    "How soon is my order processed after confirmation?",
  ],
  "Payment Policy": [
    "What payment methods do you accept?",
    "Is Cash on Delivery available?",
    "What happens if my payment fails?",
    "How do I get my invoice?",
    "Is it safe to pay on this platform?",
    "Are prices shown inclusive of tax?",
    "What if money is deducted but my order isn't placed?",
    "Can COD be restricted on my account?",
    "Who do I contact for a payment dispute?",
    "Can a transaction be cancelled for fraud reasons?",
  ],
  "Replacement Policy": [
    "How do I request a replacement?",
    "What's the replacement window for shoes?",
    "What if the replacement item is out of stock?",
    "What items don't qualify for replacement?",
    "What condition must the product be in for a replacement?",
    "What's the replacement window for mobile & accessories?",
    "What's the replacement window for apparel?",
    "Can I get a replacement for a defective phone?",
    "What if my stated reason doesn't match the product's actual condition?",
    "Is replacement possible without original packaging?",
  ],
};

// Which OTHER policy is meaningfully connected to each one — grounded in
// real cross-references the document itself makes (e.g. Return Policy's
// own "Refund Process" section points to Refund Policy; Cancellation's
// "Payment-Mode Specifics" section points to Refund Policy). Used to mix
// in 2 same-policy sub-questions + 2 from a genuinely related policy,
// instead of 4 from the same policy every time.
const RELATED_POLICY = {
  "Return Policy": "Refund Policy",
  "Refund Policy": "Return Policy",
  "Cancellation Policy": "Refund Policy",
  "Exchange Policy": "Return Policy",
  "Warranty Policy": "Replacement Policy",
  "Shipping Policy": "Return Policy",
  "Payment Policy": "Refund Policy",
  "Replacement Policy": "Warranty Policy",
};

// Excludes whatever question the customer just clicked/typed (that's how
// we got THIS answer) from the next round of suggestions — a chip should
// never just repeat the question that produced the answer it's sitting
// under. Falls back to the full list if filtering would empty it out.
//
// Exact string matching alone misses paraphrases: "how to apply for a
// return" vs a bank entry like "How do I initiate a return request?" are
// the same question but share no identical wording, so a literal compare
// never caught it — the near-duplicate then sailed through rephrasing
// too, since rephraseForVariety only avoids echoing the user's literal
// wording, not their underlying intent. This adds a lightweight content-
// overlap check: strip filler/question words, normalize a few known verb
// synonyms used across the FAQ/policy bank (apply/initiate/start/submit/
// begin/raise/file all mean the same thing here), then require overlap
// on the NON-topic words (return/refund/warranty/etc. are excluded from
// that check since practically every candidate in a given bank shares the
// topic word by design — that alone must never be enough to flag a
// duplicate, or genuinely different questions like "what's not eligible
// for return" would get wrongly filtered out too).
const DEDUP_STOPWORDS = new Set(["a","an","the","to","for","of","in","on","at","is","are","was","were","do","does","did","how","what","why","when","where","who","which","can","could","would","will","i","my","me","you","your","tell","please","this","that","it","and","or","if","be","get","about"]);
const DEDUP_SYNONYMS = { apply: "initiate", start: "initiate", begin: "initiate", submit: "initiate", raise: "initiate", file: "initiate", initiate: "initiate" };
const DEDUP_TOPIC_WORDS = new Set(["return","refund","warranty","exchange","cancel","cancellation","shipping","payment","replacement","policy","order","product","item","request"]);

function dedupTokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w && !DEDUP_STOPWORDS.has(w))
    .filter(w => !/^(ord|cmp)\d{3,}$/.test(w)) // strip order/complaint ID tokens — shared across every chip once IDs are injected, so they'd otherwise falsely inflate overlap with the user's own message
    .map(w => DEDUP_SYNONYMS[w] || w);
}

function isNearDuplicateQuestion(a, b) {
  const bagA = new Set(dedupTokenize(a));
  const bagB = new Set(dedupTokenize(b));
  if (bagA.size === 0 || bagB.size === 0) return false;
  const distinctiveA = [...bagA].filter(w => !DEDUP_TOPIC_WORDS.has(w));
  const distinctiveB = new Set([...bagB].filter(w => !DEDUP_TOPIC_WORDS.has(w)));
  const distinctiveOverlap = distinctiveA.some(w => distinctiveB.has(w));
  if (!distinctiveOverlap) return false; // only shares the topic word — not a real duplicate
  const intersectionSize = [...bagA].filter(w => bagB.has(w)).length;
  const ratio = intersectionSize / Math.min(bagA.size, bagB.size);
  return ratio >= 0.6;
}

// Deterministic (no LLM) — always weaves the customer's ACTUAL order or
// complaint ID into a suggestion question, rather than leaving it generic
// ("this order"). Runs BEFORE rephraseForVariety, so the real ID is
// already present in the "original" text the fabrication guard compares
// against — genuinely reusing a known ID is never flagged as fabricated.
function injectRealId(question, id, kind) {
  if (!id) return question;
  const genericPhrase = new RegExp(`\\b(this|my)\\s+${kind}\\b`, "i");
  if (genericPhrase.test(question)) {
    return question.replace(genericPhrase, `${kind} ${id}`);
  }
  // "...complete order details" / "...complete complaint details" already
  // names the kind — swap that instead of appending a second, redundant
  // "for order X" onto "order details".
  const detailsPhrase = new RegExp(`\\b${kind}\\s+details\\b`, "i");
  if (detailsPhrase.test(question)) {
    return question.replace(detailsPhrase, `details for ${kind} ${id}`);
  }
  // No generic phrase to swap (e.g. "What's the payment status?") — append
  // a scoped reference just before the trailing punctuation, preserving
  // whether the original was a question or a plain statement.
  const wasQuestion = /\?\s*$/.test(question);
  const stripped = question.replace(/[?.\s]+$/, "");
  return `${stripped} for ${kind} ${id}${wasQuestion ? "?" : ""}`;
}

function excludeJustAsked(questions, userQuery) {
  if (!userQuery) return questions;
  const filtered = questions.filter(q => !isNearDuplicateQuestion(q, userQuery));
  return filtered.length > 0 ? filtered : questions;
}

// Picks `count` items from `candidates` that haven't been shown yet this
// session (per `shown`, a plain array of previously-shown question
// strings for this bucket). Relevance already decided WHICH candidate
// list to use (same policy / related policy) — this only decides which
// still-fresh entries come next, so a customer revisiting the same policy
// doesn't keep seeing the identical first 2 questions. Once every
// candidate has been shown at least once, it reuses the full list again
// (better than showing nothing) rather than ever going empty.
function pickWithoutRepeat(shown, candidates, count) {
  const shownSet = new Set(shown);
  const fresh = candidates.filter(q => !shownSet.has(q));
  const pool = fresh.length >= count ? fresh : candidates;
  return pool.slice(0, count);
}


// Policy: platform has exactly 8 fixed policy names (policy_rag prompt) —
// detect which one this answer was about so we don't suggest a policy
// question already just answered. (POLICY_NAMES itself is declared
// earlier, above ASPECT_PATTERNS, since that needs it at module-load time.)
//
// IMPORTANT: these policies cross-reference each other in the actual
// document (e.g. Cancellation Policy's answer says "...refund timelines
// follow the Refund Policy" as a passing cross-reference). A naive
// "does this name appear ANYWHERE in the text" check picks up that
// incidental mention instead of the real topic — and since array order
// put "Refund Policy" before "Cancellation Policy", .find() returned the
// wrong one every time. Fixed by preferring whichever name appears in
// the HEADING (start of the answer), which is where Response Generation
// actually states the topic; only falling back to a body-text scan (by
// mention COUNT, not position) when no heading match exists at all.
// Fallback for when the answer is pure procedure/content and never
// literally names its own policy at all (e.g. "how to apply for return"
// answers with numbered steps, no "Return Policy" heading anywhere).
// Without this, extractPolicyEntities() found nothing and fell back to
// whatever policy was active in a PREVIOUS, unrelated turn (session
// stickiness meant for continuing a sub-question thread on the SAME
// policy, not for guessing an entirely new one) — producing suggestions
// for the wrong policy entirely. Distinctive phrasing per policy, drawn
// from the actual document language, not just single generic words.
const POLICY_KEYWORD_PATTERNS = {
  "Return Policy": [/return request/i, /return window/i, /return reason/i, /unused,?\s*unworn/i, /self-?ship/i, /\bpickup\b/i],
  "Refund Policy": [/refund (will be|is|was|has been) (processed|initiated)/i, /refund timeline/i, /refund mode/i, /partial refund/i, /prepaid orders?/i],
  "Cancellation Policy": [/cancel (my|the|your|an) order/i, /cancellation window/i, /non-?cancellable/i, /before (shipment|dispatch)/i],
  "Warranty Policy": [/warranty claim/i, /service center/i, /manufacturer warranty/i, /warranty period/i, /out-?of-?warranty/i],
  "Exchange Policy": [/exchange request/i, /exchange window/i, /different size/i, /exchange (option|it) (once|for)/i],
  "Shipping Policy": [/delivery timeline/i, /tracking (id|number)/i, /shipping charges?/i, /delivery attempts?/i, /processed within 24/i],
  "Payment Policy": [/payment method/i, /payment fail/i, /cash on delivery/i, /\bCOD\b/, /payment gateway/i],
  "Replacement Policy": [/replacement request/i, /replacement window/i, /defective (item|product)/i, /replace (the|my) (product|item)/i],
};

function extractPolicyEntities(answerText) {
  const text = (answerText || "").trim();
  const heading = text.slice(0, 60);

  let matched = POLICY_NAMES.find(p => heading.includes(p)) || null;

  if (!matched) {
    // No policy name in the heading — count mentions across the whole
    // text instead of taking the first array-order hit. A genuine topic
    // tends to be central to the answer (mentioned once as the subject);
    // an incidental cross-reference is usually a single passing mention
    // too, so this isn't foolproof, but it's strictly better than fixed
    // array order and only runs as a last resort anyway.
    const counts = POLICY_NAMES
      .map(p => ({ p, count: (text.match(new RegExp(p.replace(/\s+/g, "\\s+"), "gi")) || []).length }))
      .filter(c => c.count > 0)
      .sort((a, b) => b.count - a.count);
    if (counts.length > 0) matched = counts[0].p;
  }

  if (!matched) {
    // Still nothing — the answer never names ANY policy at all (pure
    // procedure/content). Score against distinctive keyword patterns
    // instead of giving up and letting a stale session policy win.
    const kwScores = Object.entries(POLICY_KEYWORD_PATTERNS)
      .map(([p, patterns]) => ({ p, score: patterns.filter(re => re.test(text)).length }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (kwScores.length > 0) matched = kwScores[0].p;
  }

  return { matchedPolicy: matched, otherPolicies: POLICY_NAMES.filter(p => p !== matched) };
}

// =========================
// CACHE HIT CONTENT SNIFFER
// A cache hit carries NO record of which module originally produced the
// content (Intent Detector + Custom Tool Call are both skipped for a
// cache hit), so we infer it from the text itself. Checks are ordered
// most-confident-first and each uses a stricter signal than the live-
// module version would need, since there's no other context to confirm
// against here. Returns a usedTool-style label to delegate to, or null
// if nothing matches (falls back to the generic single chip).
// =========================
function inferCacheHitModule(answerText) {
  const text = answerText || "";
  const heading = text.slice(0, 60);

  // Policy — trust a HEADING match first. If there's no heading (pure
  // procedure/content, e.g. "how to apply for a return" answered with
  // numbered steps and no "Return Policy" heading anywhere), fall back to
  // the same distinctive keyword patterns extractPolicyEntities uses for
  // this exact case on the LIVE path — these are precise, per-policy
  // phrases (e.g. Return Policy needs "return request"/"self-ship"/
  // "pickup", not just any mention of the word "return"), so it's safe to
  // run blind here too, unlike the looser whole-text mention-count scan
  // extractPolicyEntities uses as ITS last resort — that one's still too
  // permissive to trust without other context, so it's intentionally not
  // reused here.
  if (POLICY_NAMES.some(p => heading.includes(p))) return "PolicyInfo";
  const policyKwScore = Object.values(POLICY_KEYWORD_PATTERNS)
    .some(patterns => patterns.some(re => re.test(text)));
  if (policyKwScore) return "PolicyInfo";

  // Order info — the exact "**Order ID:**" field only Order MCP prints.
  if (/\*\*Order ID:\*\*/.test(text)) return "Order MCP";

  // Complaint — the fixed CMP-##### ID format.
  if (/\bCMP-\d{4,}\b/.test(text)) return "ComplaintSearch";

  // Product results — the bold-name + price line format.
  if (/\*\*[^*]{3,80}\*\*\s*(?:—|-)\s*\$?[\d,]+\.?\d*/.test(text)) return "SolrProductSearch";

  // Catalog listing (brands/models/categories bullet list, no prices) —
  // delegating to SolrProductSearch routes through extractCatalogItems
  // on the recursive call.
  if (extractCatalogItems(text)) return "SolrProductSearch";

  // Warranty — needs BOTH a recognized eligible brand AND warranty-
  // specific language, to avoid matching a brand mentioned in some
  // unrelated cached product answer.
  if (/warranty|claim/i.test(text) && WARRANTY_ELIGIBLE_BRANDS.some(b => text.includes(b))) {
    return "WarrantySearch";
  }

  return null;
}

// =========================
// BUILD GROUNDING CONTEXT
// Returns null when nothing usable was extracted — that's the signal to
// skip the LLM call entirely and use the static SUGGESTION_BANK instead,
// rather than let the model guess from nothing.
// =========================
function buildGroundingContext(usedTool, answerText) {
  switch (usedTool) {
    case "SolrProductSearch": {
      const e = extractProductEntities(answerText);
      if (e.products.length === 0) return null;
      return { module: usedTool, entities: e };
    }
    case "Order MCP": {
      const e = extractOrderEntities(answerText);
      if (!e.orderId) return null;
      return { module: usedTool, entities: e };
    }
    case "ComplaintSearch": {
      const e = extractComplaintEntities(answerText);
      if (!e.complaintId && !e.orderId) return null;
      return { module: usedTool, entities: e };
    }
    case "WarrantySearch": {
      const e = extractWarrantyEntities(answerText);
      if (!e.brand) return null;
      return { module: usedTool, entities: e };
    }
    case "PolicyInfo": {
      const e = extractPolicyEntities(answerText);
      return { module: usedTool, entities: e };
    }
    default:
      return null;
  }
}

// =========================
// DYNAMIC, GROUNDED SUGGESTION GENERATION
// Calls Groq directly (NOT through the Flowise agentflow — see chat notes)
// with ONLY the verified entity list, never the raw answer text. Falls
// back to the static SUGGESTION_BANK on any failure, timeout, or when no
// entities were extracted at all.
// =========================
// =========================
// SYSTEM CAPABILITY MAP
// Distilled from every toolAgent_0 system prompt across the 6 modules.
// Cross-module suggestions ARE allowed — e.g. after Product Search shows
// shoes, "what's your return policy for shoes?" is fine because
// PolicyInfo's own prompt documents category-scoped policy answers as a
// supported case. What's NOT allowed is suggesting an action that NO
// module in the whole system actually performs (see GLOBAL_FORBIDDEN).
// =========================
const MODULE_CAPABILITIES = {
  SolrProductSearch:
    "Searches/browses the product catalog by category, gender, brand, price; answers catalog " +
    "metadata questions (available brands/models/categories). No color or size data exists.",
  PolicyInfo:
    "Explains one of 8 fixed store policies (Return, Refund, Cancellation, Exchange, Warranty, " +
    "Shipping, Payment, Replacement), optionally scoped to a product category (shoes/apparel/mobile). " +
    "Cannot look up a specific order, complaint, or product by name.",
  WarrantySearch:
    "Explains manufacturer warranty terms, extended protection plans, pricing, service fees, and the " +
    "STEPS to file a claim (informational only, for supported smartphone and shoe brands).",
  "Order MCP":
    "Read-only lookups on an order already confirmed this session: status, delivery, items, payment, " +
    "shipping address (VIEW only), pricing breakdown. Cannot cancel, update, or change anything.",
  ComplaintSearch:
    "Answers specific-field questions about a complaint/order already discussed: status, next steps, " +
    "submission date, linked product, linked order. Cannot promise refunds, replacements, timelines, " +
    "or escalations, and cannot add/update complaint details.",
  FAQ:
    "Answers general product-education questions from a fixed 70-question knowledge base covering " +
    "Mobile, Mobile Accessories, Shoes, Apparel, and General topics.",
};

// Actions/topics that NO module in this system performs, regardless of
// which module the suggestion routes to. These stay forbidden even
// though cross-module suggestions are otherwise allowed.
const GLOBAL_FORBIDDEN = [
  "cancelling or modifying an order",
  "changing a delivery/shipping address",
  "promising a refund, replacement, or resolution timeline",
  "escalating to a manager or human agent (unless the module used IS HumanHandoff)",
  "filtering or asking about product color or size (catalog has no such data)",
  "adding or updating details on an existing complaint",
];

// =========================
// WORDING VARIETY (rephrase, don't regenerate)
// The deterministic paths above (Policy 2+2 mix, product filter
// questions) already pick the RIGHT topics — this is a purely cosmetic
// pass so the same customer doesn't see identical chip wording every
// time. Critically, this REPHRASES a given, already-correct list — it
// never generates new topics — so it can't introduce an unsupported
// question the way open generation could. On any failure, timeout, or
// malformed response it silently falls back to the original wording;
// nothing ever breaks because of this step.
// =========================
async function rephraseForVariety(questions, note, userQuery, knownIds = []) {
  if (!GROQ_API_KEY || !questions || questions.length === 0) return questions;

  const prompt = `Lightly reword each of these customer-support follow-up questions — a small surface change only (e.g. reorder the clause, swap "what's" for "can you tell me"), NOT a full rewrite. Stay as close to the original wording as possible while still being a slightly different sentence. ${note || ""}

Do not change what's being asked. Keep any product names, brand names, order IDs, or policy names EXACTLY as written — do not alter, translate, or remove them.
Do NOT add descriptive flourishes, extra framing, or words that weren't implied by the original — no "on file," "records," "documentation," "everything you have," or similar phrasing. A short, plain question is always preferred over an elaborate one.
Do NOT invent, add, or imply any order number, complaint ID, tracking number, or other identifier that is not already present verbatim in the original question. If the original question refers generically to "this order" or "my order" with no ID in it, keep it generic — never insert a number, a placeholder pattern like "#XXXXX"/"#12345", or any other stand-in ID.
${userQuery ? `The customer's own last message was: "${userQuery}" — do NOT reword any question into something that closely echoes this same wording back to them; that would look like a repeat of what they just asked.` : ""}

Return ONLY a JSON array with the same number of items, in the same order, nothing else.

Questions:
${JSON.stringify(questions)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const axios = require("axios");
    const resp = await axios.post(
      GROQ_URL,
      { model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.7, max_tokens: 300 },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, signal: controller.signal }
    );
    clearTimeout(timeout);
    const raw = resp.data.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length !== questions.length) return questions;

    // Per-item mid-word truncation check rather than all-or-nothing: a
    // reworded item that's a valid non-empty string can still be a
    // truncated fragment (e.g. "Show me highly rated men's sh" — this
    // slipped past a simple non-empty/length check since it's not
    // dramatically shorter than the original). Flags an item as
    // truncated if it doesn't end in sentence punctuation, doesn't end
    // in a number/price (a legitimate ending for these questions), and
    // ends in a suspiciously short word that isn't a real short word —
    // and falls back to the safe original for THAT item specifically.
    const REAL_SHORT_WORDS = new Set(["a", "an", "of", "to", "in", "on", "at", "by", "is", "it", "my", "no", "or", "so", "up", "us", "if"]);
    function looksTruncated(text) {
      const t = (text || "").trim();
      if (t.length === 0) return true;
      if (/[.?!]$/.test(t)) return false;
      const lastToken = t.split(/\s+/).pop();
      if (/\d/.test(lastToken)) return false; // ends in a price/number — legitimate
      const letters = lastToken.replace(/[^a-zA-Z']/g, "");
      if (letters.length === 0) return false; // ends in punctuation/symbol only
      return letters.length <= 2 && !REAL_SHORT_WORDS.has(letters.toLowerCase());
    }

    // Catches a rephrase that fabricated an ID-shaped token (e.g. "Order
    // #XXXXX", "#12345", "ORD-999999") that ISN'T one of the real IDs
    // already established in this conversation. A real order/complaint ID
    // the customer actually provided (e.g. ORD-001045, CMP-00157) is fine
    // and passes through untouched — only an ID-shaped token that matches
    // NONE of the known real IDs counts as fabricated.
    const ID_SHAPE = /#\s*[a-zA-Z0-9]{3,}|\b(?:ORD|CMP)-[a-zA-Z0-9]{3,}\b/gi;
    const knownIdsUpper = (knownIds || []).filter(Boolean).map((id) => id.toUpperCase());
    function hasFabricatedId(reworded) {
      const matches = reworded.match(ID_SHAPE);
      if (!matches) return false;
      return matches.some((m) => {
        const normalized = m.replace(/^#\s*/, "").toUpperCase();
        return !knownIdsUpper.some((known) => known === normalized || known.includes(normalized) || normalized.includes(known));
      });
    }

    return parsed.map((q, i) => {
      const valid = typeof q === "string" && q.trim().length > 0
        && !looksTruncated(q)
        && !hasFabricatedId(q);
      return valid ? q.trim() : questions[i];
    });
  } catch (err) {
    console.warn("Wording-variety rephrase failed, using canonical wording:", err.message);
    return questions;
  }
}

async function generateDynamicSuggestions(usedTool, answerText, userQuery, sessionPolicyContext, genderContext, session = {}) {
  const staticFallback = () => generateSuggestedQuestions(usedTool, answerText, sessionPolicyContext, userQuery);

  // Terminal module — once the customer is being handed to a human agent
  // there's nothing left for the bot to usefully suggest.
  if (usedTool === "HumanHandoff") return [];

  // FAQ: no LLM call at all — match against the FAQ module's own
  // knowledge base (faq_data_1.xlsx) so every suggestion is guaranteed
  // to be a real, retrievable question, not a guess. Left as-is (not
  // rephrased) — these are real KB questions meant to stay literal.
  if (usedTool === "FAQ") {
    const faqQuestions = getFaqFollowups(userQuery);
    return (faqQuestions && faqQuestions.length > 0) ? faqQuestions : staticFallback();
  }

  // PolicyInfo: mix 2 questions from the SAME policy's document sections
  // with 2 from a genuinely RELATED policy (RELATED_POLICY map, grounded
  // in real cross-references the document itself makes). Each pool now
  // has 10 real sub-questions (up from 5), and session.shownPolicyQuestions
  // tracks what's already been shown THIS session per policy so repeat
  // visits to the same policy surface fresh ones instead of always the
  // same first 2 — relevance (same/related policy) still decides the
  // topic; the session tracking only decides which of several equally
  // valid candidates comes next.
  if (usedTool === "PolicyInfo") {
    const { matchedPolicy } = extractPolicyEntities(answerText);
    const effectivePolicy = matchedPolicy || sessionPolicyContext || null;
    const sameBank = effectivePolicy ? POLICY_FOLLOWUPS[effectivePolicy] : null;
    if (sameBank && sameBank.length > 0) {
      if (!session.shownPolicyQuestions) session.shownPolicyQuestions = {};
      const sameShown = session.shownPolicyQuestions[effectivePolicy] || [];
      const sameCandidates = excludeJustAsked(sameBank, userQuery);
      const sameTwo = pickWithoutRepeat(sameShown, sameCandidates, 2);
      session.shownPolicyQuestions[effectivePolicy] = [...sameShown, ...sameTwo].slice(-sameBank.length);

      const relatedPolicy = RELATED_POLICY[effectivePolicy];
      const relatedBank = relatedPolicy ? POLICY_FOLLOWUPS[relatedPolicy] : null;
      let relatedTwo = [];
      if (relatedBank && relatedBank.length > 0) {
        const relatedShown = session.shownPolicyQuestions[relatedPolicy] || [];
        relatedTwo = pickWithoutRepeat(relatedShown, relatedBank, 2);
        session.shownPolicyQuestions[relatedPolicy] = [...relatedShown, ...relatedTwo].slice(-relatedBank.length);
      }

      const mixed = [...sameTwo, ...relatedTwo].slice(0, 4);
      if (mixed.length > 0) {
        return rephraseForVariety(
          mixed,
          `These are about the store's "${effectivePolicy}"${relatedPolicy ? ` and related "${relatedPolicy}"` : ""}. Keep each question clearly about a policy topic.`,
          userQuery
        );
      }
    }
    return staticFallback();
  }

  // Order MCP: fully self-contained (no PolicyInfo cross-suggestion).
  // No chips at all until an order ID is actually on record this turn —
  // there's nothing concrete to branch a follow-up from yet. Once an
  // order ID exists, never repeat an aspect this specific answer already
  // covered; backfill with catch-alls / previously-covered fields rather
  // than show fewer than 3 once a broad answer ("complete details")
  // covers everything at once. The 4th slot is ALWAYS reserved for a
  // fixed "different order" chip (see below) — kept literal, not run
  // through the LLM rewording pass, so there's no risk of it drifting
  // into confusing phrasing; a customer clicking it just gets asked for
  // a new order ID, same as the very first turn of any Order MCP
  // conversation, so there's nothing new for the module to misinterpret.
  if (usedTool === "Order MCP") {
    const { orderId } = extractOrderEntities(answerText);
    if (!orderId) return [];
    const answeredAspects = detectAnsweredAspects("Order MCP", answerText, userQuery);
    // "complete" (the "show me complete order details" chip) is only
    // marked covered once every OTHER real aspect has already been shown
    // this turn — otherwise it stays a normal, fairly-rotated candidate
    // like any other, so it actually surfaces on ordinary turns where the
    // customer hasn't seen everything yet (previously it was backfill-
    // only and almost never won a slot against 5 other real aspects).
    const REAL_ORDER_ASPECTS = ["delivery", "items", "payment", "address", "tracking"];
    if (REAL_ORDER_ASPECTS.every(a => answeredAspects.has(a))) answeredAspects.add("complete");
    const directlyAsked = detectAnsweredAspects("Order MCP", "", userQuery);
    const picked = excludeJustAsked(
      pickAspectQuestions(SUGGESTION_BANK["Order MCP"], answeredAspects, 3, directlyAsked, session, `orderAspectRotation:${orderId}`),
      userQuery
    );
    // See ComplaintSearch block below for why we don't fall back to
    // staticFallback() here: an empty `picked` means every real order
    // aspect is already covered, and staticFallback()'s own "never show
    // zero chips" rule would return the FULL unfiltered bank in that
    // case — re-surfacing fields already shown this turn.
    const { rest, completeChip } = splitOutCompleteDetails(picked, "Show me the complete order details");
    const restWithId = rest.map(q => injectRealId(q, orderId, "order"));
    const worded = restWithId.length > 0
      ? await rephraseForVariety(restWithId, "These are about this same order's own details only.", userQuery, [orderId])
      : [];
    if (completeChip) worded.push(injectRealId(completeChip, orderId, "order"));
    return [...worded, "I'd like to check on a different order"].slice(0, 4);
  }

  // ComplaintSearch: same self-contained treatment, same reserved 4th
  // slot for a fixed "different complaint" chip.
  if (usedTool === "ComplaintSearch") {
    const { complaintId, orderId } = extractComplaintEntities(answerText);
    if (!complaintId && !orderId) return [];
    const answeredAspects = detectAnsweredAspects("ComplaintSearch", answerText, userQuery);
    // The real "📋 Complaint Details" table (Complaint ID / Order ID /
    // Product / Issue Type / Date Submitted) never literally uses the
    // words "status" or "recommended action" — so those two aspects were
    // NEVER detected as covered by a full-table answer, which meant
    // "complete" (below) never got marked covered either. A full table
    // covers every aspect by definition regardless of which exact words
    // it used, so detect that shape directly and mark everything
    // covered — while a single-field answer (just a status update, just
    // a date) still only marks what it actually covered.
    const isFullTable = /📋\s*Complaint Details/i.test(answerText)
      || (/\bComplaint ID\b/i.test(answerText) && /\bIssue Type\b/i.test(answerText) && /\bOrder ID\b/i.test(answerText));
    if (isFullTable) {
      for (const a of ["status", "nextSteps", "product", "submitted", "linkedOrder"]) answeredAspects.add(a);
    }
    // "complete" only counts as covered once every OTHER real aspect is
    // — otherwise it's a normal, fairly-rotated candidate like any other,
    // so it actually appears on ordinary Mode B (single-field) turns
    // instead of being backfill-only and almost never winning a slot.
    const REAL_COMPLAINT_ASPECTS = ["status", "nextSteps", "product", "submitted", "linkedOrder"];
    if (REAL_COMPLAINT_ASPECTS.every(a => answeredAspects.has(a))) answeredAspects.add("complete");
    const directlyAsked = detectAnsweredAspects("ComplaintSearch", "", userQuery);
    const picked = excludeJustAsked(
      pickAspectQuestions(SUGGESTION_BANK.ComplaintSearch, answeredAspects, 3, directlyAsked, session, `complaintAspectRotation:${complaintId || orderId}`),
      userQuery
    );
    // IMPORTANT: do NOT fall back to staticFallback() here when picked is
    // empty. staticFallback() (generateSuggestedQuestions) runs its own
    // independent detectAnsweredAspects() call with no knowledge of the
    // isFullTable override above — it won't recognize a full details
    // table as covering "status"/"nextSteps", so it falls through to its
    // own "never show zero chips" rule and returns the ENTIRE unfiltered
    // question bank, re-surfacing fields (submission date, order ID)
    // already sitting in the table just shown. An empty `picked` here
    // means every real aspect is genuinely covered — offer only
    // non-redundant next actions instead of any field-specific question.
    const { rest, completeChip } = splitOutCompleteDetails(picked, "Show me the complete complaint details");
    const idForInjection = complaintId || orderId;
    const restWithId = rest.map(q => injectRealId(q, idForInjection, "complaint"));
    const worded = restWithId.length > 0
      ? await rephraseForVariety(restWithId, "These are about this same complaint's own details only.", userQuery, [complaintId, orderId])
      : [];
    if (completeChip) worded.push(injectRealId(completeChip, idForInjection, "complaint"));
    return [...worded, "I have a question about a different complaint"].slice(0, 4);
  }

  // Cache Hit: unlike every other module, we have NO record of which
  // module originally produced this content — a cache hit skips Intent
  // Detector and Custom Tool Call entirely (pipeline shows Cache Lookup
  // -> Cache Router -> Cache Extract Answer -> Direct Reply, nothing
  // else), so the cached text could be a product list, a policy answer,
  // order info, anything. Sniff the content itself and DELEGATE to that
  // module's own suggestion logic (full reuse — aspect exclusion, policy
  // sticky-context, warranty brand gating, gender context, all of it),
  // instead of only having a single generic fallback chip for every
  // cache hit regardless of what's actually in it.
  if (usedTool === "Cache Hit") {
    const clarificationOptions = extractClarificationOptions(answerText);
    if (clarificationOptions) return clarificationOptions;

    const inferredModule = inferCacheHitModule(answerText);
    if (inferredModule) {
      return generateDynamicSuggestions(inferredModule, answerText, userQuery, sessionPolicyContext, genderContext, session);
    }

    // No confident content-shape match — e.g. a policy sub-question
    // answer like "what's not covered under warranty?" has no heading,
    // no order ID, no brand name, nothing distinctive to sniff. If we're
    // already mid a policy conversation (sessionPolicyContext set from
    // an earlier LIVE PolicyInfo turn), this cached answer is almost
    // certainly continuing that same policy — same inference the live
    // path already makes for non-cached sub-question answers.
    if (sessionPolicyContext) {
      return generateDynamicSuggestions("PolicyInfo", answerText, userQuery, sessionPolicyContext, genderContext, session);
    }

    // No confident match, and no policy context to lean on either — a
    // generic "Show me related products" chip would be actively wrong
    // for most of what lands here (policy sub-answers, order/complaint
    // fragments, FAQ snippets), so show nothing rather than something
    // misleading.
    return [];
  }

  // Multi-turn clarification: Product Search itself just asked a follow-up
  // question (no product results yet). The most useful "suggestions" are
  // literally the answer options embedded in that question — pure regex,
  // no LLM call, works even without a Groq key. Left as literal chip text
  // (not rephrased) since these need to stay recognizable as direct
  // answers to the bot's own question.
  //
  // Catalog listing: CatalogMetadata answered "what brands/categories do
  // you carry?" with a bullet list. The useful follow-ups are "show me
  // <item>" for a few of the REAL listed items. Also literal, not
  // rephrased — each item name already IS the variety.
  //
  // Product filter questions: real product RESULTS were shown. Fixed
  // price/rating bands + category/brand/gender-aware "different" slots
  // (see composeProductFilterQuestions), then rephrase for varied wording.
  // Deterministic even with no Groq key; the rephrase step on top is a
  // pure wording pass, not what decides the topics.
  if (usedTool === "SolrProductSearch") {
    const clarificationOptions = extractClarificationOptions(answerText);
    if (clarificationOptions) return clarificationOptions;

    const catalogItems = extractCatalogItems(answerText);
    if (catalogItems) {
      const catalogCategory = detectTopCategory(answerText);
      const catalogQuestions = composeCatalogQuestions(catalogItems, catalogCategory, session);
      if (catalogQuestions.length > 0) return catalogQuestions;
    }

    if (isNoResultsAnswer(answerText)) {
      const category = detectTopCategory(answerText) || session.lastProductCategory || null;
      const brand = KNOWN_BRANDS.find(b => answerText.includes(b)) || null;
      const subtype = detectSubtypeFromNoResults(answerText);
      const noResultsQuestions = composeNoResultsQuestions(category, genderContext, brand, subtype, session);
      if (noResultsQuestions.length > 0) {
        return rephraseForVariety(
          noResultsQuestions,
          `A search for "${brand || "that brand"}" ${subtype || category || "products"} came back with no results — these are alternative next steps, not a repeat of the same search.`,
          userQuery
        );
      }
    }

    const entities = extractProductEntities(answerText);
    if (entities.products.length > 0) {
      const filterQuestions = composeProductFilterQuestions(entities, genderContext, answerText, session);
      if (filterQuestions.length > 0) {
        // The 4th question (gender-swap / category-switch — see
        // composeProductFilterQuestions) is kept LITERAL, not run through
        // the LLM rewording pass at all. That slot is the one that kept
        // coming back overly complex or truncated/garbled — an LLM
        // rewording pass is inherently variable-length output, and no
        // amount of prompt instruction fully eliminates the risk of a
        // bad generation. Since this question already varies turn to
        // turn on its own (rotation between same-category/switch, and
        // between price bands/brands/target categories), it doesn't need
        // LLM wording variety on top — a plain, guaranteed-correct
        // sentence is exactly what's wanted here. Only price/rating/brand
        // (naturally simple, low-risk templates) still get reworded.
        const [rephraseEligible, lastQuestion] = [filterQuestions.slice(0, -1), filterQuestions[filterQuestions.length - 1]];

        const genderApplies = entities.category !== "mobile" && !!genderContext;
        const worded = rephraseEligible.length > 0
          ? await rephraseForVariety(
              rephraseEligible,
              genderApplies
                ? `These are product-search filter questions for a "${genderContext}" ${entities.category || "product"} search — keep the gender context in each one.`
                : `These are product-search filter questions for a ${entities.category || "product"} search. Do NOT add or imply any gender (men's/women's) — none of these questions are gender-specific.`,
              userQuery
            )
          : [];
        return [...worded, lastQuestion].slice(0, 4);
      }
    }
  }

  // Multi-intent combo replies (e.g. "SolrProductSearch + WarrantySearch"):
  // pull real, grounded chips from EACH matched module instead of falling
  // back to the generic static bank. Recurses per-part using this same
  // function (so each part gets its own proper grounded logic — product
  // filter questions, warranty aspect exclusion, etc.), takes up to 2 from
  // each, dedupes, and caps the combined total at 4.
  if (usedTool && usedTool.includes(" + ")) {
    const parts = usedTool.split(" + ").map(p => p.trim());
    const combined = [];
    for (const part of parts) {
      const partQuestions = await generateDynamicSuggestions(part, answerText, userQuery, sessionPolicyContext, genderContext, session);
      for (const q of partQuestions) {
        if (combined.length >= 4) break;
        if (!combined.includes(q)) combined.push(q);
      }
    }
    return combined.length > 0 ? combined : staticFallback();
  }

  // WarrantySearch: grounded directly in what the tool agent's own system
  // prompt actually supports (verified against warranty_search_final_
  // Chatflow.json) — 5 real phone brands, 10 real shoe brands, and a
  // fixed structured output shape per category. Mostly brand-alternative
  // questions ("what's the warranty on Nike shoes?") since that's the
  // single most useful, always-answerable follow-up this module has;
  // one question about a specific SECTION of the structured answer
  // (Limited Warranty/Extended Plan/Pricing for phones, Duration/Defect
  // Criteria/Claim Process for shoes), excluding whichever section this
  // exact answer already covered. Kept literal (no LLM rewording pass)
  // for the same reliability reason as the other deterministic slots —
  // variety here comes from the brand/section rotation itself.
  if (usedTool === "WarrantySearch") {
    const picked = composeWarrantyQuestions(answerText, userQuery, session);
    return picked.length > 0 ? picked : staticFallback();
  }

  if (!usedTool || !GROQ_API_KEY) return staticFallback();

  const ctx = buildGroundingContext(usedTool, answerText);
  if (!ctx) return staticFallback();

  const capabilityMap = Object.entries(MODULE_CAPABILITIES)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");

  const groundingNotes = [];
  if (ctx.module === "SolrProductSearch") {
    groundingNotes.push(
      ctx.entities.warrantyEligible
        ? `A WarrantySearch question about the "${ctx.entities.brand}" product IS valid — that brand/category is confirmed covered.`
        : `A WarrantySearch question is NOT valid here — this product's brand/category is not in WarrantySearch's confirmed coverage. Do not suggest a warranty question.`
    );
    groundingNotes.push(
      ctx.entities.category
        ? `A PolicyInfo question may reference the "${ctx.entities.category}" category (e.g. "return policy for ${ctx.entities.category}").`
        : `No specific category was detected — a PolicyInfo question should stay general, not name a category.`
    );
  }

  // Generic "don't repeat what this answer already covered" constraint —
  // applies to every module with sub-topics (Order MCP, Warranty, Policy,
  // Complaints). Per-turn only, not tracked across the session.
  const REMAINING_ASPECTS_HINT = {
    "Order MCP": "status, delivery, items, payment, address, tracking, pricing breakdown",
    WarrantySearch: "limited warranty terms, extended protection plans, pricing/service fees",
    PolicyInfo: "any of the other store policies (Return, Refund, Cancellation, Exchange, Warranty, Shipping, Payment, Replacement)",
    ComplaintSearch: "status, next steps, product, submission date",
  };
  const answeredAspects = [...detectAnsweredAspects(ctx.module, answerText, userQuery)];
  if (answeredAspects.length > 0) {
    groundingNotes.push(
      `This answer ALREADY covered: ${answeredAspects.join(", ")}. Do NOT suggest a question about ` +
      `any of these again — ask about a DIFFERENT aspect instead ` +
      `(the remaining aspects are: ${REMAINING_ASPECTS_HINT[ctx.module] || "other topics this module covers"}).`
    );
  }

  const prompt = `You generate follow-up question suggestions for an eCommerce support chatbot (apparel, shoes, mobile phones/accessories) built from several specialized modules. An orchestrator automatically routes each customer question to whichever module can answer it, so suggestions may cross into a DIFFERENT module than the one that just answered — that's fine, as long as some module in the system genuinely supports it.

The module that JUST answered: ${ctx.module}

Verified facts from that answer, which you may reference (ONLY these — nothing else):
${JSON.stringify(ctx.entities, null, 2)}

Full system capability map (what each module can do):
${capabilityMap}
${groundingNotes.length ? `\nHard constraints for THIS specific answer:\n${groundingNotes.map(n => `- ${n}`).join("\n")}` : ""}

These actions/topics are NOT supported by ANY module — never suggest them:
${GLOBAL_FORBIDDEN.map(f => `- ${f}`).join("\n")}

Rules:
- Return ONLY a JSON array of 2-3 short customer-style questions, nothing else (no markdown, no preamble).
- Each question must be answerable by SOME module in the capability map above — it does not have to be the module that just answered.
- Each question must be grounded in the verified facts above — do not invent order IDs, complaint IDs, product names, sizes, or colors not listed.
- Obey the "Hard constraints for THIS specific answer" section exactly — these override your own judgment.
- Never suggest anything from the forbidden list above, regardless of which module it would route to.
- Keep questions short and natural, the way a real customer would type them.
- If verified facts include an orderId, questions about that order must reuse that exact orderId string.
- If verified facts include products, only reference products from that list by their exact name.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const axios = require("axios");
    const resp = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    const raw = resp.data.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return staticFallback();
    return parsed.filter(q => typeof q === "string").slice(0, 3);
  } catch (err) {
    console.warn("Dynamic suggestion generation failed, using static bank:", err.message);
    return staticFallback();
  }
}

// =========================
// FAQ KNOWLEDGE BASE (mirrors faq_data_1.xlsx used by the FAQ module's
// vector store — see FAQ_module_Chatflow.json / microsoftExcel_0 node)
// Used for grounded FAQ follow-ups: since every question here is
// guaranteed to be in the retriever's own dataset, suggesting one of
// these is guaranteed answerable — no LLM call, no hallucination risk.
// Categories: Mobile, Mobile Accessories, Shoes, Apparel, General.
// =========================
const FAQ_DATA = [
  ["Mobile", "What is RAM in a smartphone?"],
  ["Mobile", "How much RAM do I need for daily use?"],
  ["Mobile", "What is internal storage?"],
  ["Mobile", "How much storage should I choose in a smartphone?"],
  ["Mobile", "What is a 5G smartphone?"],
  ["Mobile", "What is the difference between 4G and 5G?"],
  ["Mobile", "What is an AMOLED display?"],
  ["Mobile", "What is an LCD display?"],
  ["Mobile", "What is screen refresh rate?"],
  ["Mobile", "Is a 120Hz display better than 60Hz?"],
  ["Mobile", "What is fast charging?"],
  ["Mobile", "What is wireless charging?"],
  ["Mobile", "What is NFC in a smartphone?"],
  ["Mobile", "What is Gorilla Glass protection?"],
  ["Mobile", "What does IP68 water resistance mean?"],
  ["Mobile", "What is a smartphone processor?"],
  ["Mobile", "Which processor is good for gaming?"],
  ["Mobile", "How can I improve my phone's battery life?"],
  ["Mobile", "What is battery capacity measured in mAh?"],
  ["Mobile", "What is dual SIM functionality?"],
  ["Mobile Accessories", "What is a power bank?"],
  ["Mobile Accessories", "How do I choose the right power bank capacity?"],
  ["Mobile Accessories", "Are all chargers compatible with every phone?"],
  ["Mobile Accessories", "What is the difference between wired and wireless charging?"],
  ["Mobile Accessories", "What is a USB-C charger?"],
  ["Mobile Accessories", "What is a fast charger?"],
  ["Mobile Accessories", "What is a screen protector?"],
  ["Mobile Accessories", "What is the difference between tempered glass and plastic screen protectors?"],
  ["Mobile Accessories", "What are wireless earbuds?"],
  ["Mobile Accessories", "How do Bluetooth earphones work?"],
  ["Shoes", "How do I choose the correct shoe size?"],
  ["Shoes", "What should I do if I am between two shoe sizes?"],
  ["Shoes", "What are running shoes?"],
  ["Shoes", "What are walking shoes?"],
  ["Shoes", "What is arch support in footwear?"],
  ["Shoes", "How should shoes fit properly?"],
  ["Shoes", "What are waterproof shoes?"],
  ["Shoes", "What is memory foam cushioning?"],
  ["Shoes", "What is the difference between sports shoes and casual shoes?"],
  ["Shoes", "How often should running shoes be replaced?"],
  ["Shoes", "Can shoes be washed in a washing machine?"],
  ["Shoes", "What materials are commonly used in shoes?"],
  ["Shoes", "Which shoes are best for long-distance walking?"],
  ["Shoes", "What is the difference between sneakers and running shoes?"],
  ["Shoes", "Why do shoe sizes vary across brands?"],
  ["Apparel", "How do I choose the correct apparel size?"],
  ["Apparel", "What is slim fit clothing?"],
  ["Apparel", "What is regular fit clothing?"],
  ["Apparel", "What is oversized fit clothing?"],
  ["Apparel", "What is cotton fabric?"],
  ["Apparel", "What is polyester fabric?"],
  ["Apparel", "What is moisture-wicking fabric?"],
  ["Apparel", "What is stretch fabric?"],
  ["Apparel", "What is blended fabric?"],
  ["Apparel", "How should I wash cotton clothes?"],
  ["Apparel", "How can I prevent clothes from shrinking?"],
  ["Apparel", "How can I prevent colors from fading after washing?"],
  ["Apparel", "What is the difference between casual wear and formal wear?"],
  ["Apparel", "How do I read a clothing size chart?"],
  ["Apparel", "Which fabrics are best for summer?"],
  ["General", "How can I compare two products?"],
  ["General", "What do customer ratings indicate?"],
  ["General", "What do product reviews mean?"],
  ["General", "How do I know if a product is authentic?"],
  ["General", "What should I consider before buying a smartphone?"],
  ["General", "What should I consider before buying shoes?"],
  ["General", "What should I consider before buying apparel?"],
  ["General", "How can I choose products within my budget?"],
  ["General", "What is a refurbished product?"],
  ["General", "What is the difference between a refurbished and a new product?"],
];

const FAQ_STOPWORDS = new Set(["what","is","are","the","a","an","how","do","i","does","should","can","of","for","to","in","on","my","your","which","between"]);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !FAQ_STOPWORDS.has(w));
}

// Finds the best-matching FAQ category for the customer's query, then
// returns up to 3 OTHER real questions from that same category (so the
// customer isn't shown the question they just asked). Falls back to
// null if nothing scores above zero overlap, letting the caller fall
// back to the static SUGGESTION_BANK.
function getFaqFollowups(userQuery) {
  const queryTokens = new Set(tokenize(userQuery));
  if (queryTokens.size === 0) return null;

  const catScores = {};
  for (const [cat, question] of FAQ_DATA) {
    const qTokens = tokenize(question);
    const overlap = qTokens.filter(t => queryTokens.has(t)).length;
    if (overlap > 0) catScores[cat] = (catScores[cat] || 0) + overlap;
  }

  const bestCat = Object.keys(catScores).sort((a, b) => catScores[b] - catScores[a])[0];
  if (!bestCat) return null;

  // Exclude questions nearly identical to what was just asked. A
  // similarity RATIO (shared / union) catches one-word paraphrases of
  // the same question (e.g. KB has "...correct shoe size?" while the
  // customer typed "...right shoe size?" — only 1 word differs, so an
  // exact-subset check let it through); requiring an exact 100% token
  // subset was too strict to catch that.
  const candidates = FAQ_DATA
    .filter(([cat]) => cat === bestCat)
    .map(([, q]) => q)
    .filter(q => {
      const qTokens = new Set(tokenize(q));
      const union = new Set([...qTokens, ...queryTokens]);
      if (union.size === 0) return true;
      const shared = [...qTokens].filter(t => queryTokens.has(t)).length;
      const similarity = shared / union.size;
      return similarity < 0.5; // not a near-duplicate of the asked question
    });

  // Shuffle-ish pick: take a spread rather than always the first 3
  return candidates.slice(0, 3);
}

// =========================
// MIDDLEWARE
// =========================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "aep-ecommerce-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);

// =========================
// SESSION INITIALIZER
// =========================
function initSession(req) {
  if (!req.session.session_id) req.session.session_id = uuidv4();
  if (!req.session.messages) req.session.messages = [];
  if (!req.session.execution_log) req.session.execution_log = [];
  // Sticky "which policy are we currently discussing" — mirrors what the
  // Flowise PolicyInfo module's own buffer memory already knows. Needed
  // because follow-up sub-question answers (e.g. "how do I initiate a
  // return?") don't restate the policy name, so extractPolicyEntities()
  // alone can't tell which policy is still active on those turns.
  if (req.session.lastPolicyContext === undefined) req.session.lastPolicyContext = null;
  // Sticky "which gender is this product conversation about" — same
  // pattern, needed because catalog/product answers often don't restate
  // the gender explicitly on every turn even though it's still the topic.
  if (req.session.lastGenderContext === undefined) req.session.lastGenderContext = null;
  if (req.session.lastProductCategory === undefined) req.session.lastProductCategory = null;
  // Tracks which POLICY_FOLLOWUPS questions have already been shown this
  // session, keyed by policy name — lets pickWithoutRepeat() surface
  // fresh sub-questions on repeat visits to the same policy instead of
  // always the same first 2 (see generateDynamicSuggestions).
  if (req.session.shownPolicyQuestions === undefined) req.session.shownPolicyQuestions = {};
  // Per-key rotation counters (price band / rating band / brand pick) for
  // composeProductFilterQuestions() — plain object so it survives
  // whatever session store is configured (avoids Set/Map serialization
  // issues if this ever moves off the in-memory store).
  if (req.session.productRotation === undefined) req.session.productRotation = {};
}

// =========================
// RESOLVE NODE NAME
// =========================
function resolveNodeName(node) {
  const nodeId    = node.nodeId    || "";
  const nodeLabel = node.nodeLabel || "";
  if (NODE_LABELS[nodeId])               return NODE_LABELS[nodeId];
  if (NODE_LABEL_OVERRIDES[nodeLabel])   return NODE_LABEL_OVERRIDES[nodeLabel];
  if (nodeLabel && !nodeLabel.includes("_")) return nodeLabel;
  return nodeId.replace(/agentflow/gi, "").replace(/_/g, " ").trim() || "Unknown Node";
}

// =========================
// EXTRACT TOOL FROM ORCHESTRATOR
// Confirmed: tool is at output.usedTools[0].tool
// =========================
function extractToolFromOrchestrator(executedNodes) {
  const toolNode = executedNodes.find(n => n.nodeId === "customFunctionAgentflow_3");
  if (!toolNode) return null;

  const output = toolNode.data && toolNode.data.output;
  const text = (output && (output.content || output.text || output.result)) || "";

  // V2 Custom Tool Call returns "HANDOFF::..." for human escalation
  if (text.startsWith("HANDOFF::")) return "HumanHandoff";

  // Returns "###INTENT:PRODUCT\n...", "###INTENT:POLICY\n..." etc. (may be multiple)
  const intentMatches = [...text.matchAll(/###INTENT:([A-Z]+)/g)].map(m => m[1].toLowerCase());
  if (intentMatches.length === 1) {
    return INTENT_DISPLAY[intentMatches[0]] || intentMatches[0];
  }
  if (intentMatches.length > 1) {
    return intentMatches.map(i => INTENT_DISPLAY[i] || i).join(" + ");
  }

  // Fallback: check Intent Detector (llmAgentflow_1) output for intent key
  const intentNode = executedNodes.find(n => n.nodeId === "llmAgentflow_1");
  if (intentNode) {
    const iOut = intentNode.data && intentNode.data.output;
    const iText = (iOut && (iOut.content || iOut.text)) || "";
    for (const key of KNOWN_TOOLS) {
      if (iText.toLowerCase().includes(key)) return INTENT_DISPLAY[key] || key;
    }
  }

  return null;
}
 // =========================
// RAW RESPONSE EXTRACTOR (pre-guardrail debug)
// Response Generation (llmAgentflow_2) runs BEFORE Output Guardrail
// (customFunctionAgentflow_5), so its output is the exact raw
// generated_response text that gets sent into mask_pii(). Pulling it
// straight from executedNodes needs no changes to the Python guardrail
// server or Flowise flow itself.
// =========================
function extractRawGeneratedResponse(executedNodes) {
  const node = executedNodes.find(n => n.nodeId === "llmAgentflow_2");
  if (!node) return null;
  const out = node.data && node.data.output;
  if (typeof out === "string") return out;
  return (out && (out.text || out.content || out.answer || out.result)) || null;
}

// =========================
// DERIVE USED TOOL (chip label)
// =========================
function deriveUsedTool(executedNodes) {
  if (!executedNodes || executedNodes.length === 0) return "Processing";
  const nodeIds = executedNodes.map(n => n.nodeId);
  if (nodeIds.includes("directReplyAgentflow_1")) return "Greeting";
  if (nodeIds.includes("directReplyAgentflow_0") || nodeIds.includes("directReplyAgentflow_3")) return "Blocked"
  if (nodeIds.includes("directReplyAgentflow_2")) return "Cache Hit";
  if (nodeIds.includes("customFunctionAgentflow_3")) {
    const tool = extractToolFromOrchestrator(executedNodes);
    return tool || "Custom Tool Call";
  }
  return "Processing";
}

// =========================
// BUILD PIPELINE STRING
// =========================
function buildPipeline(executedNodes, toolCalled) {
  if (!executedNodes || executedNodes.length === 0) return "Flowise Orchestrator";
  const steps = executedNodes.map(resolveNodeName).filter(n => n !== "Start");
  if (toolCalled) {
    const idx = steps.lastIndexOf("Custom Tool Call");
    if (idx !== -1) steps.splice(idx + 1, 0, toolCalled);
  }
  return steps.filter((s, i) => i === 0 || s !== steps[i - 1]).join(" → ");
}

// =========================
// BUILD NODE STEPS (sidebar)
// =========================
function buildNodeSteps(executedNodes, toolCalled) {
  const steps = executedNodes.map(node => {
    const name = resolveNodeName(node);
    const out  = node.data && node.data.output;
    let preview = "";
    if (typeof out === "string") preview = out.slice(0, 120);
    else if (out) preview = String(out.text || out.answer || out.result || out.question || "").slice(0, 120);
    return { node: name, status: node.status || "FINISHED", preview };
  });
  if (toolCalled) {
    const idx = steps.findIndex(s => s.node === "Custom Tool Call");
    if (idx !== -1) steps.splice(idx + 1, 0, { node: `Tool: ${toolCalled}`, status: "FINISHED", preview: "" });
  }
  return steps.map((s, i) => ({ step: i + 1, ...s }));
}

// =========================
// APPEND EXECUTION LOG
// =========================
function appendExecutionLog(req, { query, status, responseText, executedNodes }) {
  const toolCalled = extractToolFromOrchestrator(executedNodes);
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  req.session.execution_log.push({
    time: `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    query,
    flow: "Master Agentflow (Flowise Orchestrator)",
    status,
    used_tool:       deriveUsedTool(executedNodes),
    pipeline:        buildPipeline(executedNodes, toolCalled),
    node_steps:      buildNodeSteps(executedNodes, toolCalled),
    response_length: (responseText || "").length,
  });
  if (req.session.execution_log.length > 200)
    req.session.execution_log = req.session.execution_log.slice(-200);
}

// =========================
// STREAMING FLOWISE CALL
// Uses Node http module to stream SSE from Flowise → browser
// Parses nextAgentFlow INPROGRESS events for real-time node updates
// =========================
function streamFlowiseToClient(question, sessionId, res, onDone) {
  const body = JSON.stringify({
    question,
    overrideConfig: { sessionId },
    streaming: true,
  });

  const options = {
    hostname: "localhost",
    port: 3000,
    path: `/api/v1/prediction/${FLOWISE_CHATFLOW_ID}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const flowiseReq = http.request(options, flowiseRes => {
    let buffer = "";
    let finalExecutedNodes = [];
    let finalAnswer = "";

    flowiseRes.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const event = parsed.event;
        const data  = parsed.data;

        // ── Real-time node start: fire customer message to browser ──
        if (event === "nextAgentFlow" && data && data.status === "INPROGRESS") {
          const friendlyName   = resolveNodeName(data);
          const customerMsg    = NODE_STATUS_MESSAGES[friendlyName];
          if (customerMsg) {
            res.write(`data: ${JSON.stringify({ type: "node", message: customerMsg })}\n\n`);
          }
        }

        // ── Cumulative executed nodes (last one is the complete list) ──
        if (event === "agentFlowExecutedData" && Array.isArray(data)) {
          finalExecutedNodes = data;
        }

        // ── Token event: the answer text ──
        if (event === "token" && typeof data === "string") {
          finalAnswer += data;
        }
      }
    });

    flowiseRes.on("end", () => {
      // If token events gave us the answer use that, otherwise extract from last executed node
      if (!finalAnswer && finalExecutedNodes.length > 0) {
        const last = finalExecutedNodes[finalExecutedNodes.length - 1];
        const out  = last.data && last.data.output;
        finalAnswer = (out && (out.content || out.text || out.answer)) || "";
      }
      onDone(null, { answer: finalAnswer, executedNodes: finalExecutedNodes });
    });

    flowiseRes.on("error", err => onDone(err));
  });

  flowiseReq.on("error", err => onDone(err));
  flowiseReq.write(body);
  flowiseReq.end();
}

// =========================
// ROUTES
// =========================

app.get("/api/state", (req, res) => {
  initSession(req);
  req.session.messages = [];
  req.session.execution_log = [];
  res.json({ session_id: req.session.session_id, messages: [], execution_log: [] });
});

// SSE streaming chat endpoint
app.post("/api/chat", (req, res) => {
  initSession(req);
  const userInput = (req.body.message || "").trim();
  if (!userInput) return res.status(400).json({ error: "Empty message" });

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  req.session.messages.push({ role: "user", content: userInput, time: timeStr });

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  streamFlowiseToClient(userInput, req.session.session_id, res, async (err, result) => {
    if (err) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      return res.end();
    }

    const { answer, executedNodes } = result;
    const isError       = answer.startsWith("❌");
    const displayAnswer = isError ? "⚠️ Something went wrong. Please try again." : answer;

    const toolCalled = extractToolFromOrchestrator(executedNodes);
    const usedTool   = deriveUsedTool(executedNodes);
    const pipeline   = buildPipeline(executedNodes, toolCalled);

    const assistantMsg = {
      role: "assistant", content: displayAnswer,
      flow: "Master Agentflow", time: timeStr,
      route_source: "Flowise Orchestrator",
      used_tool: usedTool, pipeline,
      raw_response_debug: extractRawGeneratedResponse(executedNodes),
      suggested_questions: [], // filled in below, AFTER the answer is already sent
    };
    res.write(`data: ${JSON.stringify({
      type: "done",
      messages:      req.session.messages,
      execution_log: req.session.execution_log,
    })}\n\n`);
    console.log("RAW (pre-guardrail):", JSON.stringify(assistantMsg.raw_response_debug));
    req.session.messages.push(assistantMsg);
    const assistantMsgIndex = req.session.messages.length - 1;

    appendExecutionLog(req, {
      query: userInput,
      status: isError ? "Error" : "Completed",
      responseText: answer,
      executedNodes,
    });

    // Send the answer immediately — the customer sees their reply right away,
    // with zero added latency from suggestion generation.
    res.write(`data: ${JSON.stringify({
      type: "done",
      messages:      req.session.messages,
      execution_log: req.session.execution_log,
    })}\n\n`);

    if (isError) return res.end();

    // Keep the sticky "which policy is active" context up to date BEFORE
    // generating suggestions, so a sub-question answer that doesn't
    // restate the policy name still gets the right document-grounded
    // follow-ups (see initSession / generateDynamicSuggestions notes).
    if (usedTool === "PolicyInfo") {
      const { matchedPolicy } = extractPolicyEntities(answer);
      req.session.lastPolicyContext = matchedPolicy || req.session.lastPolicyContext || null;
    }

    // Same idea for gender context — check the customer's own message
    // first (most direct signal, e.g. "mens apparel"), then the answer
    // itself, and keep whatever was last established if neither turn
    // mentions a gender (product/catalog conversations only, mirrors
    // the policy context above).
    if (usedTool === "SolrProductSearch" || usedTool === "Cache Hit") {
      const detectedGender = detectSingleGender(userInput) || detectSingleGender(answer);
      req.session.lastGenderContext = detectedGender || req.session.lastGenderContext || null;

      // Same idea for category — a "no results" answer often doesn't
      // restate the category clearly enough for detectTopCategory to
      // find it (e.g. "We couldn't find any... from Calvin Klein" has no
      // shoes/apparel/mobile keyword at all), so fall back to whatever
      // category the customer was actually searching last turn.
      const detectedCategory = detectTopCategory(userInput) || detectTopCategory(answer);
      req.session.lastProductCategory = detectedCategory || req.session.lastProductCategory || null;
    }

    // Generate suggestions AFTER the answer already went out, then push them
    // as a small separate event. generateDynamicSuggestions() has its own
    // internal try/catch + static fallback, so this never throws — worst
    // case it resolves to the static bank.
    const suggestedQuestions = await generateDynamicSuggestions(
      usedTool, answer, userInput, req.session.lastPolicyContext, req.session.lastGenderContext, req.session
    );
    assistantMsg.suggested_questions = suggestedQuestions;

    res.write(`data: ${JSON.stringify({
      type: "suggestions",
      messageIndex: assistantMsgIndex,
      suggested_questions: suggestedQuestions,
    })}\n\n`);
    res.end();
  });
});

app.post("/api/clear", (req, res) => {
  req.session.messages = [];
  req.session.execution_log = [];
  req.session.session_id = uuidv4();
  res.json({ session_id: req.session.session_id, messages: [], execution_log: [] });
});

app.get("/api/flowise-executions", async (req, res) => {
  try {
    const axios = require("axios");
    const r = await axios.get(`${FLOWISE_BASE_URL}/api/v1/executions`, {
      params: { chatflowId: FLOWISE_CHATFLOW_ID, limit: req.query.limit || 20 },
      timeout: 10000,
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AEP eCommerce Assistant running at http://localhost:${PORT}`);
  console.log(`📱 Mobile URL: http://192.168.1.36:${PORT}`);
});