"""Keyword/regex input-rail actions for NeMo Guardrails.

These run as true input rails (no dialog intent matching) and preserve the
original phrase/regex lists from rails.co.
"""

import re
from typing import Optional

from nemoguardrails.actions import action

JAILBREAK_PHRASES = (
    "ignore instructions",
    "ignore previous instructions",
    "ignore all previous instructions",
    "forget previous instructions",
    "forget your instructions",
    "forget your rules",
    "forget everything",
    "act as system",
    "act as the system",
    "act as developer",
    "pretend to be system",
    "bypass security",
    "bypass guardrails",
    "bypass restrictions",
    "disable safety",
    "disable guardrails",
    "override instructions",
    "override system prompt",
    "override developer prompt",
    "jailbreak",
    "developer mode",
    "system mode",
    "domain validation",
    "hallucination",
    "output validation",
    "competitor policy",
    "refusal policy",
)

PII_PATTERNS = (
    re.compile(r"[0-9]{10}"),
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    re.compile(r"[0-9]{16}"),
    re.compile(r"[A-Z]{5}[0-9]{4}[A-Z]"),
)

TOXICITY_PHRASES = (
    "idiot",
    "stupid",
    "hate",
    "kill",
    "useless",
    "hopeless",
    "moron",
    "dumb",
    "shut up",
    "garbage",
    "worthless",
    "you suck",
)

PROMPT_INJECTION_PHRASES = (
    "system prompt",
    "developer prompt",
    "reveal prompt",
    "show hidden instructions",
    "show system prompt",
    "show developer prompt",
    "print your prompt",
    "print system prompt",
    "what are your instructions",
    "what is your system prompt",
    "reveal your instructions",
)

HTML_SCRIPT_PHRASES = (
    "<script>",
    "</script>",
    "<html>",
    "</html>",
    "javascript:",
    "onerror=",
    "onload=",
    "eval(",
    "document.cookie",
)

INTENT_MISALIGNMENT_PHRASES = (
    "write malware",
    "create malware",
    "hack system",
    "hack account",
    "steal password",
    "phishing",
    "sql injection",
    "xss attack",
    "ddos attack",
    "ransomware",
    "trojan",
    "keylogger",
    "refund without returning",
    "get products without paying",
    "bypass payment",
    "fake refund",
    "payment fraud",
)


def _user_text(context: Optional[dict]) -> str:
    return (context or {}).get("user_message") or ""


def _contains_phrase(text: str, phrases: tuple) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in phrases)


def _outcome(blocked: bool) -> dict:
    # Dict so Colang 1.0 can read `$result.is_blocked` via AttributeDict.
    return {"is_blocked": bool(blocked)}


@action(name="check_jailbreak_keywords")
async def check_jailbreak_keywords(context: Optional[dict] = None, **kwargs):
    return _outcome(_contains_phrase(_user_text(context), JAILBREAK_PHRASES))


@action(name="check_pii_patterns")
async def check_pii_patterns(context: Optional[dict] = None, **kwargs):
    text = _user_text(context)
    return _outcome(any(pattern.search(text) for pattern in PII_PATTERNS))


@action(name="check_toxicity_keywords")
async def check_toxicity_keywords(context: Optional[dict] = None, **kwargs):
    return _outcome(_contains_phrase(_user_text(context), TOXICITY_PHRASES))


@action(name="check_prompt_injection_keywords")
async def check_prompt_injection_keywords(context: Optional[dict] = None, **kwargs):
    return _outcome(_contains_phrase(_user_text(context), PROMPT_INJECTION_PHRASES))


@action(name="check_html_script_keywords")
async def check_html_script_keywords(context: Optional[dict] = None, **kwargs):
    return _outcome(_contains_phrase(_user_text(context), HTML_SCRIPT_PHRASES))


@action(name="check_intent_misalignment_keywords")
async def check_intent_misalignment_keywords(context: Optional[dict] = None, **kwargs):
    return _outcome(_contains_phrase(_user_text(context), INTENT_MISALIGNMENT_PHRASES))
