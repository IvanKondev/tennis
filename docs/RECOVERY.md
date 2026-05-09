# Recovery runbook

When something goes wrong in production, run through these in order. Each section is a self-contained recipe — you don't need to read top-to-bottom.

All paths are inside the Coolify container's data volume (`/data` by default).

---

## 1. Data file is corrupt

**Symptom:** every API call returns `503 {"error":"data file corrupt — recover from backup"}`. The server is running, the JSON parser is throwing on `tennis.json`.

**Verify:**
```sh
ssh into coolify host
cat /var/lib/docker/volumes/<tennis-data-volume>/_data/tennis.json | head -3
# or directly, if you can exec into the container:
docker exec -it <container> cat /data/tennis.json | head -3
```

If it's invalid JSON, you'll see truncation, weird control chars, or a parse error.

**Restore from the most recent backup:**
```sh
# Inside the container or with the host volume mounted:
cd /data
cp tennis.json tennis.json.broken           # keep the bad copy for forensics
cp tennis.json.bak.1 tennis.json            # bak.1 is a hard link / copy of the previous primary
```

Then:
```sh
docker restart <tennis-container>
# or via Coolify UI: Restart service
```

If `bak.1` itself is corrupt (rare — it's a hard link to the previous primary at the time of last write, NOT a partial copy), try `bak.2` then `bak.3`. Each step loses the writes between that backup and "now".

**After recovery:** check the audit log (`/data/audit.jsonl`) to see what got lost — every admin mutation is recorded there.

---

## 2. Service worker is serving stale code

**Symptom:** users report "I see the old version" outside incognito. They reload, still old. Incognito works.

**Why this still happens:** the system has multiple update paths (controllerchange, updatefound, version-poll on 60s). At least one should fire on a normal deploy. If none does, look at:

1. **Check the deployed version** matches what you expect:
   ```sh
   curl -s https://<host>/api/version
   # → {"version":"tennis-XXXXXXXXXXXX"}
   ```
   The version is a hash of all shell file contents. If this doesn't change between deploys, the underlying files didn't change either.

2. **Check sw.js was substituted:**
   ```sh
   curl -s https://<host>/sw.js | grep CACHE_VERSION
   # → const CACHE_VERSION = 'tennis-XXXXXXXXXXXX';
   ```
   If this still says `__CACHE_VERSION__`, server boot didn't run phase 3 — check container logs for `cache: sw.js auto-versioned`.

3. **Force a single user out of stale state:**
   - Have them open the app and tap the "↻ Презареди" button (admin only) — unregisters SW + clears all caches + reloads.
   - Or: instruct to clear site data (Settings → Site Settings → Clear & reset).

**Nuclear: kill-switch SW** (only if MANY users are stuck, e.g. you shipped a SW with a fatal bug):
1. Replace `sw.js` content with a self-unregistering SW (see the kill-switch pattern in [Self-Destroying ServiceWorker](https://medium.com/@nekrtemplar/self-destroying-serviceworker-73d62921d717)).
2. Deploy. Existing users' browsers fetch new sw.js → activate kill switch → unregister + clear caches.
3. After 24-48h, redeploy with the normal sw.js. New users register fresh.

---

## 3. Admin password compromised / leaked

**Symptom:** suspect that the admin password is no longer secret (saw it in a screenshot, an old log, etc.).

**Steps:**
1. **Rotate the password in Coolify:**
   - Coolify UI → service → Environment → change `ADMIN_PASSWORD` → restart.
   - On restart, all in-memory sessions are invalidated automatically. Every admin device must log in again.
2. **Audit recent activity:**
   ```sh
   tail -200 /data/audit.jsonl | jq .
   ```
   Look for unexpected `player.delete`, `match.finalize`, or `data.put` events from unfamiliar IPs.
3. **If an unauthorized mutation happened:** restore from `bak.1/2/3` per section 1.

---

## 4. Single-host outage

**Symptom:** Coolify host is down. The site doesn't load at all.

**Steps:**
1. Coolify UI → check container/service status.
2. If host is alive but service is down: restart the service.
3. If host is dead: contact hosting provider (Hetzner / wherever the Coolify VM lives).
4. **There is no failover.** RTO target is ~30 min manual restore on a fresh host. The data volume is the source of truth — without it, all data is lost (until the off-site backup story is implemented; see roadmap).

---

## 5. Migrating to a new host

1. On the old host: `tar czf tennis-data.tar.gz /var/lib/docker/volumes/<volume>/_data/`.
2. Move the tarball to the new host.
3. Set up Coolify on the new host with the same git repo.
4. Before first deploy: `tar xzf tennis-data.tar.gz -C /var/lib/docker/volumes/<new-volume>/_data/`.
5. Deploy. Server reads existing `tennis.json` on boot.

---

## 6. Sanity checks after any recovery

```sh
# Server is alive
curl -s https://<host>/api/health
# → {"ok":true,"hasAdmin":true}

# Data is valid
curl -s https://<host>/api/data | jq '.players | length'
# Should match the expected player count

# Version is fresh
curl -s https://<host>/api/version

# Logs are clean
docker logs <container> | tail -20 | jq .
```

If anything looks off, escalate to the developer before letting users hit the system.

---

## Audit log format

`/data/audit.jsonl` is append-only, one JSON object per line:

```json
{"ts":"2026-05-10T18:30:12.345Z","ip":"1.2.3.4","action":"match.finalize","key":"Иван|Митко","score":[2,1],"via":"result","isAdmin":true}
```

Common actions:
- `session.create` / `session.revoke` — login / logout
- `player.add` / `player.rename` / `player.delete`
- `match.finalize` (via `result` or `live`)
- `live.update` / `live.clear` / `live.cleared-empty`
- `data.put` — bulk overwrite (rare; sync from local mode)

Useful queries:
```sh
# Today's actions
jq 'select(.ts | startswith("2026-05-10"))' /data/audit.jsonl

# All deletions
jq 'select(.action == "player.delete")' /data/audit.jsonl

# Distinct IPs that authenticated today
jq -r 'select(.action=="session.create" and (.ts | startswith("2026-05-10"))) | .ip' /data/audit.jsonl | sort -u
```
