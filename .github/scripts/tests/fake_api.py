"""Fake Render + GitHub + MyDubb server for testing the CD scripts. No network beyond 127.0.0.1.

Usage: fake_api.py <port> <scenario> <log-file>
Every request is appended to the log as "METHOD /path auth=<yes|no> cookie=<yes|no>"; the
Authorization value itself is never logged. The scenario decides how the fake answers.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SHA = "a" * 40
OLD = "b" * 40
SERVICE = "srv-testservice"
DEP = "dep-newdeploy"

port = int(sys.argv[1])
scenario = sys.argv[2]
log_path = sys.argv[3]
lock = threading.Lock()
state = {"polls": 0, "created": False}


def deploy(status, commit=SHA, dep_id=DEP, created="2026-10-23T10:00:00Z"):
    d = {"id": dep_id, "status": status, "trigger": "api", "createdAt": created}
    if commit is not None:
        d["commit"] = {"id": commit, "message": "x"}
    return d


def wrap(items):
    return [{"deploy": d, "cursor": "c"} for d in items]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body=None):
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def record(self):
        with lock, open(log_path, "a") as f:
            auth = "yes" if self.headers.get("Authorization") else "no"
            cookie = "yes" if self.headers.get("Cookie") else "no"
            f.write(f"{self.command} {self.path} auth={auth} cookie={cookie}\n")

    def do_GET(self):
        self.record()
        u = urlparse(self.path)
        p, q = u.path, u.query
        if p.startswith("/repos/"):
            return self.github(p)
        if p.startswith(f"/v1/services/{SERVICE}"):
            return self.render_get(p, q)
        return self.site(p)

    def do_POST(self):
        self.record()
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length)
        with lock, open(log_path, "a") as f:
            f.write("BODY " + data.decode() + "\n")
        if self.path != f"/v1/services/{SERVICE}/deploys":
            return self.send(404, {})
        s = scenario
        if s == "post_400":
            return self.send(400, {"message": "bad"})
        if s == "post_409":
            return self.send(409, {"message": "conflict"})
        if s == "post_500_none":
            return self.send(500, {})
        if s in ("post_500_created", "lookup_two"):
            state["created"] = True
            return self.send(500, {})
        if s == "post_drop_created":
            state["created"] = True
            self.connection.close()
            return None
        if s == "post_202":
            state["created"] = True
            return self.send(202)
        state["created"] = True
        return self.send(201, deploy("created"))

    # ---- GitHub ----
    def github(self, p):
        if scenario == "compare_404":
            return self.send(404, {"message": "Not Found"})
        status = {
            "stale": "behind",
            "same_live": "identical",
            "diverged": "diverged",
        }.get(scenario, "ahead")
        return self.send(200, {"status": status})

    # ---- Render ----
    def render_get(self, p, q):
        s = scenario
        base = f"/v1/services/{SERVICE}"
        if p == base:
            trigger = "commit" if s == "autodeploy_on" else "off"
            body = {"id": SERVICE, "name": "mydubb", "autoDeployTrigger": trigger, "suspended": "not_suspended"}
            if s == "legacy_autodeploy_yes":
                body = {"id": SERVICE, "name": "mydubb", "autoDeploy": "yes", "suspended": "not_suspended"}
            if s == "suspended":
                body["suspended"] = "suspended"
            if s == "service_401":
                return self.send(401, {})
            return self.send(200, body)
        if p == base + "/deploys":
            if "status=live" in q:
                if s == "same_live":
                    return self.send(200, wrap([deploy("live", SHA, "dep-old")]))
                if s == "no_live":
                    return self.send(200, [])
                return self.send(200, wrap([deploy("live", OLD, "dep-old", "2026-10-22T10:00:00Z")]))
            if "status=created" in q:
                if s == "busy":
                    return self.send(200, wrap([deploy("build_in_progress", "c" * 40, "dep-manual")]))
                return self.send(200, [])
            if "createdAfter" in q:  # lookup after an unknown create outcome
                if not state["created"]:
                    return self.send(200, [])
                if s == "lookup_two":
                    return self.send(200, wrap([deploy("build_in_progress", SHA, "dep-one"), deploy("build_in_progress", SHA, "dep-two")]))
                return self.send(200, wrap([deploy("build_in_progress", SHA)]))
            return self.send(200, [])
        if p == f"{base}/deploys/{DEP}":
            state["polls"] += 1
            n = state["polls"]
            if s == "timeout":
                return self.send(200, deploy("build_in_progress"))
            if s == "build_failed":
                return self.send(200, deploy("build_failed" if n > 1 else "build_in_progress"))
            if s == "update_failed":
                return self.send(200, deploy("update_failed" if n > 1 else "update_in_progress"))
            if s == "canceled":
                return self.send(200, deploy("canceled" if n > 1 else "build_in_progress"))
            if s == "deactivated":
                return self.send(200, deploy("deactivated"))
            if s == "sha_mismatch":
                return self.send(200, deploy("live", "d" * 40))
            if s == "live_no_commit":
                return self.send(200, deploy("live", None))
            if s == "poll_500_then_ok":
                if n <= 2:
                    return self.send(500, {})
            if s == "poll_500_forever":
                return self.send(500, {})
            if n == 1:
                return self.send(200, deploy("build_in_progress"))
            if n == 2:
                return self.send(200, deploy("update_in_progress"))
            return self.send(200, deploy("live"))
        return self.send(404, {})

    # ---- the site ----
    def site(self, p):
        s = scenario
        meta = {
            "provider_mode": "azure",
            "mock_mode": False,
            "providers": {"translation": "azure", "speech": "azure", "audio": "ffmpeg"},
            "voices": [],
        }
        if s == "smoke_audio_mock":
            meta["providers"]["audio"] = "mock"
        if s == "smoke_mock_mode":
            meta["mock_mode"] = True
        if s == "smoke_provider_mock":
            meta["provider_mode"] = "mock"
        if p == "/":
            if s == "smoke_home_wrong":
                return self.raw(200, "<html>Welcome to nginx</html>")
            if s == "smoke_home_500":
                return self.raw(500, "boom")
            return self.raw(200, "<!doctype html><html><head><title>MyDubb</title></head></html>")
        if p == "/api/health":
            if s == "smoke_health_bad":
                return self.send(200, {"status": "degraded"})
            return self.send(200, {"status": "ok"})
        if p == "/api/ready":
            if s == "smoke_ready_503":
                return self.send(503, {"status": "not_ready", "checks": {"database": "unavailable"}})
            if s == "smoke_ready_flaky":
                state["polls"] += 1
                if state["polls"] <= 2:
                    return self.send(503, {})
            return self.send(200, {"status": "ready", "checks": {"database": "ok"}})
        if p == "/api/meta":
            return self.send(200, meta)
        return self.send(404, {})

    def raw(self, code, text):
        raw = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
