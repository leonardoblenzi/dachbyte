#!/usr/bin/env python3
"""Static contract check for canonical + legacy Caddy routing."""
from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "Caddyfile")
text = path.read_text(encoding="utf-8")

required = {
    "canonical core": "@business-core-api-canonical path /business/core/api /business/core/api/*",
    "canonical chat": "@business-chat-api-canonical path /business/chat/api /business/chat/api/*",
    "canonical stock": "@business-stock-api-canonical path /business/stock/api /business/stock/api/*",
    "canonical price": "@business-price-api-canonical path /business/price/api /business/price/api/*",
    "legacy core api": "@legacy-core-api path /api/core /api/core/*",
    "legacy chat api": "@legacy-chat-api path /chat-api /chat-api/*",
    "legacy transition chat api": "@legacy-business-chat-api path /business/chat-api /business/chat-api/*",
    "legacy stock api": "@legacy-stock-api path /voltstock/api /voltstock/api/*",
    "legacy price api": "@legacy-price-api path /volt-price/api /volt-price/api/*",
    "core ui redirect": "@legacy-core-ui path /core /core/*",
    "chat ui redirect": "@legacy-chat-ui path /chat /chat/*",
    "stock ui redirect": "@legacy-stock-ui path /voltstock /voltstock/*",
    "price ui redirect": "@legacy-price-ui path /volt-price /volt-price/*",
    "deprecation marker": 'X-Dachbyte-Legacy-Route "true"',
    "legacy access log": "log legacy_routes {",
    "legacy access log opt-in": "log_name legacy_routes",
    "access log isolation": "no_hostname",
    "early legacy path capture": "log_append <legacy_path {http.request.uri.path}",
    "websocket token redaction": "legacy_path regexp /messages/ws/[^/]+ /messages/ws/REDACTED",
    "request uri removal": "request>uri delete",
    "request header removal": "request>headers delete",
    "remote ip removal": "request>remote_ip delete",
    "client ip removal": "request>client_ip delete",
    "synthetic probe exclusion": "log_skip @legacy-validation-probe",
}

errors = []
for label, needle in required.items():
    if needle not in text:
        errors.append(f"missing {label}: {needle}")

ordering = [
    ("@business-core-api-canonical", "@business-core-canonical"),
    ("@business-chat-api-canonical", "@business-chat-canonical"),
    ("@business-stock-api-canonical", "@business-stock-canonical"),
    ("@business-price-api-canonical", "@business-price-canonical"),
    ("@legacy-core-api", "@legacy-core-ui"),
    ("@legacy-chat-api", "@legacy-chat-ui"),
    ("@legacy-stock-api", "@legacy-stock-ui"),
    ("@legacy-price-api", "@legacy-price-ui"),
    ("@legacy-price-health", "@legacy-price-ui"),
]
for first, second in ordering:
    if first in text and second in text and text.index(first) > text.index(second):
        errors.append(f"route ordering invalid: {first} must precede {second}")

def handler_block(matcher: str) -> str:
    marker = f"handle @{matcher} {{"
    if marker not in text:
        return ""
    start = text.index(marker)
    next_matcher = text.find("\n  @", start + len(marker))
    return text[start:] if next_matcher < 0 else text[start:next_matcher]


for matcher in ("legacy-core-ui", "legacy-chat-ui", "legacy-stock-ui", "legacy-price-ui", "legacy-voltchat", "legacy-volt-chat", "legacy-stock-short"):
    body = handler_block(matcher)
    if not body:
        errors.append(f"{matcher} must use a terminal handle")
        continue
    if "route {" not in body or " 308" not in body:
        errors.append(f"{matcher} must use HTTP 308")
    if f"log_name @{matcher} legacy_routes" not in text:
        errors.append(f"{matcher} must opt into the isolated legacy access logger")

for matcher in ("legacy-core-api", "legacy-chat-api", "legacy-business-chat-api", "legacy-stock-api", "legacy-price-api"):
    body = handler_block(matcher)
    if not body:
        continue
    if "redir " in body:
        errors.append(f"{matcher} must proxy, not redirect")
    if "Deprecation" not in body or "X-Dachbyte-Canonical-Path" not in body:
        errors.append(f"{matcher} must advertise deprecation + canonical successor")
    if "log_name legacy_routes" not in body:
        errors.append(f"{matcher} must opt into the isolated legacy access logger")

if errors:
    for error in errors:
        print(f"[fail] {error}", file=sys.stderr)
    raise SystemExit(1)

print("[ok] canonical routes, UI redirects, legacy API proxies and deprecation headers are consistent")
