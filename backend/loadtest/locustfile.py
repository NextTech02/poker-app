"""Locust load/stress test for the Poker app API.

Simulates realistic usage: each virtual user logs in once, then loops through a
weighted mix of the screens real operators hit (tournaments, prizes, sangi,
reports, players...). Reads are the default. Writes (the sangi sales flow) are
opt-in via STRESS_WRITES=1 and create real rows — prefer a Supabase branch.

Run:
    pip install -r backend/loadtest/requirements.txt
    # headless, 50 users, spawn 5/s, 2 min:
    locust -f backend/loadtest/locustfile.py --host http://localhost:8000 \
           --headless -u 50 -r 5 -t 2m
    # or open the web UI:
    locust -f backend/loadtest/locustfile.py --host http://localhost:8000
"""
import random

from locust import HttpUser, task, between, events

from common import (
    API_BASE, STAGE_ID, ENABLE_WRITES,
    login, auth_headers, discover_ids,
)

# Shared across users — discovered once at startup.
_TOKEN = None
_IDS = {"stage_id": STAGE_ID or None, "tournament_ids": [], "player_ids": [], "staff_ids": []}


@events.test_start.add_listener
def _on_start(environment, **kw):
    global _TOKEN, _IDS
    _TOKEN = login()
    _IDS = discover_ids(_TOKEN)
    print(f"[loadtest] stage={_IDS['stage_id']} tournaments={len(_IDS['tournament_ids'])} "
          f"players={len(_IDS['player_ids'])} staff={len(_IDS['staff_ids'])} writes={ENABLE_WRITES}")


class OperatorUser(HttpUser):
    """A logged-in operator browsing the app."""
    wait_time = between(0.5, 2.5)

    def on_start(self):
        self.token = _TOKEN
        self.stage_id = _IDS.get("stage_id")
        self.headers = auth_headers(self.token, self.stage_id)
        self._open_consignment_id = None

    # ── helpers ──
    def _rand_tournament(self):
        return random.choice(_IDS["tournament_ids"]) if _IDS["tournament_ids"] else None

    def _get(self, path, name):
        self.client.get(path, headers=self.headers, name=name)

    # ── read tasks (weights ~ frequency in real use) ──
    @task(10)
    def list_tournaments(self):
        self._get("/tournaments", "/tournaments")

    @task(8)
    def prize_summary(self):
        tid = self._rand_tournament()
        if tid:
            self._get(f"/tournaments/{tid}/prizes/summary", "/tournaments/[id]/prizes/summary")

    @task(6)
    def tournament_detail(self):
        tid = self._rand_tournament()
        if tid:
            self._get(f"/tournaments/{tid}", "/tournaments/[id]")

    @task(5)
    def prize_list(self):
        tid = self._rand_tournament()
        if tid:
            self._get(f"/tournaments/{tid}/prizes", "/tournaments/[id]/prizes")

    @task(5)
    def tournament_days_and_players(self):
        tid = self._rand_tournament()
        if tid:
            self._get(f"/tournament-days/tournament/{tid}", "/tournament-days/tournament/[id]")
            self._get(f"/tournament-players/tournament/{tid}", "/tournament-players/tournament/[id]")

    @task(4)
    def players(self):
        self._get("/players", "/players")

    @task(4)
    def sangi_consignments(self):
        self._get("/sangi/consignments", "/sangi/consignments")

    @task(3)
    def tournament_report(self):
        tid = self._rand_tournament()
        if tid:
            self._get(f"/reports/tournament/{tid}", "/reports/tournament/[id]")

    @task(3)
    def misc_lists(self):
        self._get("/sponsors", "/sponsors")
        self._get("/satellite-tickets", "/satellite-tickets")

    @task(2)
    def cashboxes_and_perms(self):
        self._get("/cashboxes", "/cashboxes")
        self._get("/staff/me/permissions", "/staff/me/permissions")

    # ── write tasks (opt-in: STRESS_WRITES=1) ──
    def _ensure_open_consignment(self):
        """Reuse an existing open consignment, else release a fresh one with a
        large balance so sale tasks don't bump into the released-amount guard."""
        if self._open_consignment_id:
            return self._open_consignment_id
        # try to find an existing open one
        r = self.client.get("/sangi/consignments?status_filter=open", headers=self.headers,
                             name="/sangi/consignments?open")
        try:
            data = r.json()
            if isinstance(data, list) and data:
                self._open_consignment_id = data[0]["id"]
                return self._open_consignment_id
        except Exception:
            pass
        # else create one
        if not _IDS["staff_ids"] or not self.stage_id:
            return None
        sangi = random.choice(_IDS["staff_ids"])
        with self.client.post("/sangi/consignments",
                              json={"sangi_staff_id": sangi, "released_amount": 1_000_000},
                              headers=self.headers, name="/sangi/consignments [POST]",
                              catch_response=True) as resp:
            if resp.status_code in (200, 201):
                self._open_consignment_id = resp.json().get("id")
            elif resp.status_code == 400:
                resp.success()  # likely "já tem consignação aberta" — expected under contention
        return self._open_consignment_id

    @task(6)
    def register_sangi_sale(self):
        if not ENABLE_WRITES:
            return
        cid = self._ensure_open_consignment()
        if not cid or not _IDS["player_ids"]:
            return
        buyer = random.choice(_IDS["player_ids"])
        self.client.post(
            f"/sangi/consignments/{cid}/sales",
            json={"amount": round(random.uniform(5, 50), 2), "buyer_player_id": buyer},
            headers=self.headers, name="/sangi/consignments/[id]/sales [POST]",
        )
