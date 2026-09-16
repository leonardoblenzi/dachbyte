#!/usr/bin/env python3
"""Summarize DACHBYTE Business legacy route usage from Caddy JSON access logs."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from urllib.parse import urlsplit

LEGACY_ROUTES = (
    ("api.core", "/api/core", "api", "/business/core/api"),
    ("api.chat", "/chat-api", "api", "/business/chat/api"),
    ("api.chat-transition", "/business/chat-api", "api", "/business/chat/api"),
    ("api.stock", "/voltstock/api", "api", "/business/stock/api"),
    ("api.price", "/volt-price/api", "api", "/business/price/api"),
    ("compat.price-health", "/volt-price/health", "compat", "/business/price/health"),
    ("ui.core", "/core", "ui", "/business/core"),
    ("ui.chat", "/chat", "ui", "/business/chat"),
    ("ui.stock", "/voltstock", "ui", "/business/stock"),
    ("ui.price", "/volt-price", "ui", "/business/price"),
    ("ui.voltchat", "/voltchat", "ui", "/business/chat"),
    ("ui.volt_chat", "/volt_chat", "ui", "/business/chat"),
    ("ui.stock-short", "/stock", "ui", "/business/stock"),
    ("compat.core-assets", "/assets", "compat", "/business/core/assets"),
    ("compat.core-health", "/health", "compat", "/business/core/api/health"),
    ("compat.core-status", "/status", "compat", "/business/core/api/health"),
    ("compat.chat-version", "/version.json", "compat", "/business/chat/version.json"),
    ("compat.stock-icon", "/icon.png", "compat", "/business/stock"),
    ("compat.stock-logo", "/logo-volt-chat.png", "compat", "/business/stock"),
)


def matches(path: str, prefix: str) -> bool:
    if prefix.endswith(".json") or prefix.endswith(".png"):
        return path == prefix
    return path == prefix or path.startswith(prefix + "/")


def classify(path: str):
    # Order matters: API prefixes must win before their parent UI prefixes.
    for name, prefix, kind, canonical in LEGACY_ROUTES:
        if matches(path, prefix):
            return name, kind, canonical
    return None


def extract_uri(record: dict) -> str:
    # Stage 7's isolated Caddy logger stores only a sanitized path in
    # `legacy_path`. Keep request.uri/url as a backwards-compatible fallback
    # for older logs captured before this hardening was deployed.
    legacy_path = record.get("legacy_path")
    if legacy_path:
        return str(legacy_path)
    request = record.get("request") or {}
    return str(request.get("uri") or request.get("url") or "")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fail-on-api-hits", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    counts: Counter[str] = Counter()
    kinds: Counter[str] = Counter()
    examples: dict[str, str] = {}
    parsed = 0

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        # `docker logs` is raw JSON, but tolerate compose prefixes or noise.
        brace = line.find("{")
        if brace < 0:
            continue
        try:
            record = json.loads(line[brace:])
        except json.JSONDecodeError:
            continue
        uri = extract_uri(record)
        if not uri:
            continue
        parsed += 1
        path = urlsplit(uri).path
        hit = classify(path)
        if not hit:
            continue
        name, kind, canonical = hit
        counts[name] += 1
        kinds[kind] += 1
        examples.setdefault(name, f"{path} -> {canonical}")

    payload = {
        "parsed_access_records": parsed,
        "legacy_hits": sum(counts.values()),
        "api_hits": kinds["api"],
        "ui_hits": kinds["ui"],
        "compat_hits": kinds["compat"],
        "routes": [
            {"route": name, "hits": counts[name], "example": examples.get(name, "")}
            for name, *_ in LEGACY_ROUTES
            if counts[name]
        ],
    }

    if args.as_json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print("DACHBYTE Business legacy route usage")
        print(f"parsed_access_records={payload['parsed_access_records']}")
        print(f"legacy_hits={payload['legacy_hits']} api_hits={payload['api_hits']} ui_hits={payload['ui_hits']} compat_hits={payload['compat_hits']}")
        if payload["routes"]:
            print("\nroute hits:")
            for item in payload["routes"]:
                print(f"  {item['route']:<26} {item['hits']:>8}  {item['example']}")
        else:
            print("\nNo legacy-route hits were found in the supplied access-log window.")

    if args.fail_on_api_hits and payload["api_hits"] > 0:
        print("\nAPI retirement gate BLOCKED: legacy API traffic is still present.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
