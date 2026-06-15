"""Targeted WRITE stress for the sangi sales flow.

Two modes:
  --mode race    : fire many concurrent sales at a consignment whose released
                   amount only covers a few of them, to expose the non-atomic
                   read-modify-write guard in register_sale (TOCTOU oversell).
  --mode throughput : sustained concurrent sales against a high-limit
                   consignment, to measure write throughput/latency/errors.

After a race run it reports: successes vs the theoretical max, the
consignment's reported total_sold, the real SUM(amount) of sale rows, and
whether the released cap was breached.

WRITES REAL ROWS. Run only against a disposable/test database.
"""
from __future__ import annotations
import argparse
import asyncio
import time
from collections import Counter

import httpx

from common import API_BASE, login, auth_headers, discover_ids, ConfigError


async def _fresh_consignment(client, headers, staff_ids, released):
    """Reconcile any open consignment for the staff, then release a fresh one
    with the requested released_amount so the race cap is exactly known."""
    for sid in staff_ids:
        # find open consignments for this sangi and reconcile them
        r = await client.get(f"/sangi/consignments?status_filter=open&sangi_staff_id={sid}", headers=headers)
        try:
            for c in r.json():
                await client.post(f"/sangi/consignments/{c['id']}/reconcile", headers=headers, json={})
        except Exception:
            pass
        r = await client.post("/sangi/consignments", headers=headers,
                              json={"sangi_staff_id": sid, "released_amount": released})
        if r.status_code in (200, 201):
            return r.json()["id"]
    return None


async def _sale(client, headers, cid, amount, buyer, results, latencies):
    t0 = time.monotonic()
    try:
        r = await client.post(f"/sangi/consignments/{cid}/sales", headers=headers,
                              json={"amount": amount, "buyer_player_id": buyer})
        latencies.append((time.monotonic() - t0) * 1000)
        results[r.status_code] += 1
        return r.status_code
    except Exception as exc:
        results[type(exc).__name__] += 1
        return None


async def run_race(client, headers, ids, n, amount, released):
    cid = await _fresh_consignment(client, headers, ids["staff_ids"], released)
    if not cid:
        print("[race] could not create a consignment (no staff/permission).")
        return
    buyer = ids["player_ids"][0]
    theoretical_max = int(released // amount)
    print(f"[race] consignment={cid} released={released} sale_amount={amount} "
          f"concurrent_sales={n} theoretical_max_success={theoretical_max}")

    results = Counter()
    latencies = []
    t0 = time.monotonic()
    await asyncio.gather(*[_sale(client, headers, cid, amount, buyer, results, latencies) for _ in range(n)])
    elapsed = time.monotonic() - t0

    ok = results.get(201, 0) + results.get(200, 0)
    rejected = results.get(400, 0)

    # Ground truth from the API
    cons = (await client.get(f"/sangi/consignments/{cid}", headers=headers)).json()
    reported_total = float(cons.get("total_sold") or 0)
    real_sum = sum(float(s["amount"]) for s in cons.get("sales", []))
    real_count = len(cons.get("sales", []))

    print("\n──────── RACE RESULT ────────")
    print(f"elapsed         : {elapsed*1000:.0f} ms for {n} concurrent sales")
    print(f"http 201/200    : {ok}   (expected ≤ {theoretical_max} if guard is atomic)")
    print(f"http 400 reject : {rejected}")
    print(f"other           : {dict((k,v) for k,v in results.items() if k not in (200,201,400))}")
    print(f"reported total_sold : {reported_total}")
    print(f"real SUM(sales)     : {real_sum}  over {real_count} rows")
    print(f"released cap        : {released}")
    breach = real_sum > released + 0.001
    print(f"OVERSELL (sum>cap)  : {'YES — RACE BUG' if breach else 'no'}")
    drift = abs(real_sum - reported_total) > 0.001
    print(f"total_sold drift    : {'YES — trigger inconsistent' if drift else 'no'}")
    if latencies:
        latencies.sort()
        print(f"sale latency ms     : p50={latencies[len(latencies)//2]:.0f} max={latencies[-1]:.0f}")
    print("─────────────────────────────")


async def run_throughput(client, headers, ids, concurrency, duration, amount):
    cid = await _fresh_consignment(client, headers, ids["staff_ids"], released=10_000_000)
    if not cid:
        print("[throughput] could not create a consignment.")
        return
    buyer = ids["player_ids"][0]
    results = Counter()
    latencies = []
    deadline = time.monotonic() + duration

    async def worker():
        while time.monotonic() < deadline:
            await _sale(client, headers, cid, amount, buyer, results, latencies)

    t0 = time.monotonic()
    await asyncio.gather(*[worker() for _ in range(concurrency)])
    elapsed = time.monotonic() - t0
    total = sum(results.values())
    ok = results.get(201, 0) + results.get(200, 0)
    print("\n──────── WRITE THROUGHPUT ────────")
    print(f"sales attempted : {total}")
    print(f"throughput      : {total/elapsed:.1f} writes/s over {elapsed:.1f}s")
    print(f"success/error   : {ok} / {total-ok}")
    if latencies:
        latencies.sort()
        p = lambda q: latencies[min(int(len(latencies)*q), len(latencies)-1)]
        print(f"latency ms      : p50={p(0.5):.0f} p95={p(0.95):.0f} p99={p(0.99):.0f} max={latencies[-1]:.0f}")
    print(f"status codes    : {dict(results)}")
    print("──────────────────────────────────")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["race", "throughput"], default="race")
    ap.add_argument("-n", "--num", type=int, default=50, help="concurrent sales (race)")
    ap.add_argument("-c", "--concurrency", type=int, default=30)
    ap.add_argument("-d", "--duration", type=float, default=20.0)
    ap.add_argument("--amount", type=float, default=10.0)
    ap.add_argument("--released", type=float, default=100.0)
    args = ap.parse_args()

    try:
        token = login()
    except ConfigError as e:
        print(f"[config] {e}")
        return
    ids = discover_ids(token)
    if not ids["staff_ids"] or not ids["player_ids"]:
        print(f"[abort] need staff and players. staff={len(ids['staff_ids'])} players={len(ids['player_ids'])}")
        return
    headers = auth_headers(token, ids.get("stage_id"))

    limits = httpx.Limits(max_connections=args.num + args.concurrency + 20)
    async with httpx.AsyncClient(base_url=API_BASE, timeout=30.0, limits=limits) as client:
        if args.mode == "race":
            await run_race(client, headers, ids, args.num, args.amount, args.released)
        else:
            await run_throughput(client, headers, ids, args.concurrency, args.duration, args.amount)


if __name__ == "__main__":
    asyncio.run(main())
