# Load / Stress tests

Simulates real operator usage against the running API. Two tools:

- **`stress_quick.py`** — pure `httpx` async burst. No extra deps beyond `httpx`.
  Read-only. Great for a fast throughput/latency snapshot.
- **`locustfile.py`** — [Locust](https://locust.io) with weighted user behaviour,
  a live web UI, ramp-up, and per-endpoint stats. Optional write load (sangi sales).

Both run on **your machine** against your local (or deployed) API — they can't be
run from the assistant's sandbox.

## Setup

```bash
cd backend
venv\Scripts\activate            # or: source venv/bin/activate
pip install -r loadtest/requirements.txt

# credentials for a test login (a real account in your Supabase)
copy loadtest\.env.example loadtest\.env     # Windows  (cp on mac/linux)
# edit loadtest/.env -> set STRESS_EMAIL / STRESS_PASSWORD
```

Supabase URL, anon key and the API base are auto-read from `frontend/.env`.

## Quick burst (read-only, safe)

```bash
# from the backend/ folder, with the API running on :8000
python loadtest/stress_quick.py --concurrency 100 --duration 30
python loadtest/stress_quick.py -c 250 -d 60        # heavier
```

Prints requests, throughput (req/s), error %, and latency p50/p90/p95/p99/max.

## Locust (realistic users + UI)

```bash
# Web UI — open http://localhost:8089 and set users/spawn rate
locust -f loadtest/locustfile.py --host http://localhost:8000

# Headless — 50 users, spawn 5/s, run 2 minutes, write a CSV report
locust -f loadtest/locustfile.py --host http://localhost:8000 \
       --headless -u 50 -r 5 -t 2m --csv loadtest/report
```

### Write load (optional, destructive)

By default both tools only **read**. To also stress the sangi **sales** flow
(create consignment → register sales), set `STRESS_WRITES=1`. This inserts real
rows — **run it against a Supabase branch**, not production:

```bash
# in loadtest/.env:  STRESS_WRITES=1
locust -f loadtest/locustfile.py --host http://localhost:8000 --headless -u 30 -r 3 -t 1m
```

## Reading results

- **Error %** should stay near 0. A spike of `5xx`/`EXC` means the API or DB is
  saturating; `429`/timeouts mean you've found a ceiling.
- **p95/p99 latency** is what users feel. Watch where it starts climbing as you
  raise concurrency — that's your capacity knee.
- Run a read-only baseline first, then re-run with writes to see the write path's
  effect on the same endpoints.

## Tips

- Start the API with multiple workers to test realistic capacity:
  `uvicorn app.main:app --workers 4` (no `--reload`).
- Ramp gradually (e.g. 25 → 100 → 250 users) and note where p95 / errors break.
- The Supabase free tier has its own connection/rate limits — heavy runs may hit
  those before the API itself.
```
