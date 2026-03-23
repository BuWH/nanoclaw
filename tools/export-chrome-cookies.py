#!/usr/bin/env python3
"""Export Chrome cookies to Playwright storage_state format.

Reads the Chrome cookie database on macOS using rookiepy, converts cookies
to Playwright's storage_state JSON format, and writes to the specified output
path. Designed to be called by the NanoClaw host IPC handler.

Usage:
    uv run --with rookiepy tools/export-chrome-cookies.py
    uv run --with rookiepy tools/export-chrome-cookies.py --domains github.com,notion.so
    uv run --with rookiepy tools/export-chrome-cookies.py --profile "Profile 1"

Output (stdout): JSON with success status and summary.
"""

import argparse
import json
import os
import sys
import tempfile
import time


def parse_args():
    parser = argparse.ArgumentParser(
        description="Export Chrome cookies to Playwright storage_state format"
    )
    parser.add_argument(
        "--domains",
        default=None,
        help="Comma-separated list of domains to export (e.g. github.com,google.com)",
    )
    parser.add_argument(
        "--profile",
        default=None,
        help='Chrome profile directory name (e.g. "Default", "Profile 1")',
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output file path (default: data/browser-state/storage.json)",
    )
    return parser.parse_args()


def domain_matches(cookie_domain, filter_domains):
    """Check if a cookie domain matches any of the filter domains.

    Cookie domains may have a leading dot (e.g. ".github.com") which means
    the cookie is valid for all subdomains. We match if:
    - The cookie domain (stripped of leading dot) equals the filter domain
    - The cookie domain (stripped of leading dot) ends with .filter_domain
    """
    bare = cookie_domain.lstrip(".")
    for fd in filter_domains:
        fd_bare = fd.lstrip(".")
        if bare == fd_bare or bare.endswith(f".{fd_bare}"):
            return True
    return False


def _normalize_same_site(value):
    """Normalize sameSite to a valid Playwright value.

    rookiepy returns same_site as an integer:
      0 = no restriction (None)
      1 = Lax
      2 = Strict
    Playwright expects: "Strict", "Lax", or "None".
    """
    if isinstance(value, int):
        return {0: "None", 1: "Lax", 2: "Strict"}.get(value, "Lax")
    if isinstance(value, str):
        lower = value.lower()
        if lower in ("strict", "lax", "none"):
            return {"strict": "Strict", "lax": "Lax", "none": "None"}[lower]
    return "Lax"


def export_cookies(domains=None, profile=None):
    """Read Chrome cookies using rookiepy and return Playwright-format list."""
    try:
        import rookiepy
    except ImportError:
        return None, "rookiepy not installed. Run: uv run --with rookiepy"

    try:
        kwargs = {}
        if profile:
            kwargs["profile"] = profile
        if domains:
            kwargs["domains"] = [f".{d.lstrip('.')}" for d in domains]

        raw_cookies = rookiepy.chrome(**kwargs)
    except Exception as e:
        return None, f"Failed to read Chrome cookies: {e}"

    now = time.time()
    playwright_cookies = []

    for c in raw_cookies:
        expires = c.get("expires") or 0
        # Skip expired cookies (expires > 0 means it has an expiry)
        if expires > 0 and expires < now:
            continue

        cookie = {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "expires": float(expires) if expires > 0 else -1,
            "httpOnly": bool(c.get("http_only", False)),
            "secure": bool(c.get("secure", False)),
            "sameSite": _normalize_same_site(c.get("same_site")),
        }
        playwright_cookies.append(cookie)

    # Apply domain filter if rookiepy didn't handle it (fallback)
    if domains and not any("domains" in str(k) for k in []):
        filtered = [
            c for c in playwright_cookies if domain_matches(c["domain"], domains)
        ]
        playwright_cookies = filtered

    return playwright_cookies, None


def write_storage_state(cookies, output_path):
    """Merge cookies into existing storage_state JSON and write atomically.

    Preserves existing origins (localStorage) and cookies for domains not
    covered by the new import. New cookies overwrite existing ones with the
    same (name, domain, path) tuple.
    """
    existing = {"cookies": [], "origins": []}
    if os.path.exists(output_path):
        try:
            with open(output_path) as f:
                existing = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass  # Corrupted file -- start fresh

    # Index new cookies by (name, domain, path) for O(1) lookup
    new_index = {(c["name"], c["domain"], c["path"]): c for c in cookies}

    # Build merged cookie list: keep existing cookies not replaced by new ones
    merged = list(new_index.values())
    for ec in existing.get("cookies", []):
        key = (ec.get("name"), ec.get("domain"), ec.get("path"))
        if key not in new_index:
            merged.append(ec)

    storage_state = {
        "cookies": merged,
        "origins": existing.get("origins", []),
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Atomic write: temp file in same directory then rename
    dir_name = os.path.dirname(output_path)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(storage_state, f, indent=2)
        os.rename(tmp_path, output_path)
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def main():
    args = parse_args()

    # Resolve output path
    if args.output:
        output_path = args.output
    else:
        # Default: data/browser-state/storage.json relative to project root
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(script_dir)
        output_path = os.path.join(
            project_root, "data", "browser-state", "storage.json"
        )

    # Parse domains
    domains = None
    if args.domains:
        domains = [d.strip() for d in args.domains.split(",") if d.strip()]

    # Export cookies
    cookies, error = export_cookies(domains=domains, profile=args.profile)
    if error:
        result = {"success": False, "message": error}
        print(json.dumps(result))
        sys.exit(1)

    # Collect unique domains for summary
    unique_domains = sorted(set(c["domain"].lstrip(".") for c in cookies))

    # Write output
    try:
        write_storage_state(cookies, output_path)
    except Exception as e:
        result = {"success": False, "message": f"Failed to write output: {e}"}
        print(json.dumps(result))
        sys.exit(1)

    result = {
        "success": True,
        "message": f"Exported {len(cookies)} cookies for {len(unique_domains)} domains",
        "count": len(cookies),
        "domains": unique_domains,
        "path": output_path,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
