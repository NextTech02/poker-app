"""Quick concurrent burst load test — pure asyncio + httpx (no extra deps).

Read-only by default (safe to run against any environment). Fires a fixed
concurrency of workers at the API's read endpoints for a set duration and
reports throughput, error rate and latency percentiles.

Run:
    pip install httpx
    # 100 concurrent workers for 30s:
    python backend/loadtest/stress_quick.py --concurrency 100 --duration 30
    # ramp examples:
    python backend/loadtest/stress_quick.py -c 250 -d 60

Env: STRESS_EMAIL, STRESS_PASSWORD required (test account). API base + Supabase
URL/anon key are read from frontend/.env automatically (overridable via env).
"""
from __future__ import annotations
import argparse
import asyncio
import statistics
import time
from collections import Counter

import httpx

from common import API_BASE, login, auth_headers, discover_ids, ConfigError


def _percentile(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    k = (len(values) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def build_endpoints(ids: dict):
    """Weighted read endpoints (path, name). Repeats encode the weight."""
    eps = [("/tournaments", "list_tournaments")] * 4
    eps += [("/players", "players")] * 2
    eps += [("/sangi/consignments", "sangi_consignments")] * 2
    eps += [("/sponsors", "sponsors"), ("/satellite-tickets", "tickets"),
            ("/cashboxes", "cashboxes"), ("/staff/me/permissions", "perms")]
    for tid in ids["tournament_ids"][:10]:
        eps += [
            (f"/tournaments/{tid}/prizes/summary", "prizes_summary"),
            (f"/tournaments/{tid}/prizes", "prizes_list"),
            (f"/tournaments/{tid}", "tournament_detail"),
            (f"/reports/tournament/{tid}", "tournament_report"),
            (f"/tournament-days/tournament/{tid}", "days"),
            (f"/tournament-players/tournament/{tid}", "players_of_tournament"),
        ]
    return eps


async def worker(client, headers, endpoints, deadline, latencies, status_counter, name_counter, errors):
    import random
    while time.monotonic() < deadline:
        path, name = random.choice(endpoints)
        t0 = time.monotonic()
        try:
            r = await client.get(path, headers=headers)
            dt = (time.monotonic() - t0) * 1000.0
            latencies.append(dt)
            status_counter[r.status_code] += 1
            name_counter[name] += 1
            if r.status_code >= 400:
                errors.append((name, r.status_code))
        except Exception as exc:  # connection errors, timeouts
            status_counter["EXC"] += 1
            errors.append((name, type(exc).__name__))


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--concurrency", type=int, default=50)
    ap.add_argument("-d", "--duration", type=float, default=30.0, help="seconds")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args()

    try:
        token = login()
    except ConfigError as e:
        print(f"[config] {e}")
        return
    ids = discover_ids(token)
    endpoints = build_endpoints(ids)
    headers = auth_headers(token, ids.get("stage_id"))

    print(f"[stress] base={API_BASE} concurrency={args.concurrency} duration={args.duration}s "
          f"tournaments={len(ids['tournament_ids'])} endpoints={len(endpoints)}")

    latencies, errors = [], []
    status_counter, name_counter = Counter(), Counter()
    limits = httpx.Limits(max_connections=args.concurrency + 20, max_keepalive_connections=args.concurrency)

    start = time.monotonic()
    deadline = start + args.duration
    async with httpx.AsyncClient(base_url=API_BASE, timeout=args.timeout, limits=limits) as client:
        tasks = [
            asyncio.create_task(
                worker(client, headers, endpoints, deadline, latencies, status_counter, name_counter, errors)
            )
            for _ in range(args.concurrency)
        ]
        await asyncio.gather(*tasks)
    elapsed = time.monotonic() - start

    total = sum(status_counter.values())
    ok = sum(v for k, v in status_counter.items() if isinstance(k, int) and k < 400)
    err = total - ok
    print("\n──────── RESULT ────────")
    print(f"requests      : {total}")
    print(f"throughput    : {total / elapsed:,.1f} req/s over {elapsed:.1f}s")
    print(f"success/error : {ok} / {err}  ({(err / total * 100 if total else 0):.2f}% errors)")
    if latencies:
        print(f"latency ms    : p50={_percentile(latencies,50):.0f}  "
              f"p90={_percentile(latencies,90):.0f}  p95={_percentile(latencies,95):.0f}  "
              f"p99={_percentile(latencies,99):.0f}  max={max(latencies):.0f}  "
              f"mean={statistics.mean(latencies):.0f}")
    print(f"status codes  : {dict(status_counter)}")
    print(f"top endpoints : {dict(name_counter.most_common(8))}")
    if errors:
        ec = Counter(errors)
        print(f"errors (top)  : {dict(ec.most_common(8))}")
    print("────────────────────────")


if __name__ == "__main__":
    asyncio.run(main())
