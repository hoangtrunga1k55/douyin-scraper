# Session Summary — VPS Disk Full + Redis "No Space Left on Device" Fix

**Date:** 2026-05-29
**Project:** douyin-downloader (this repo) deployed to VPS at `103.163.118.42` (path `/home/ubuntu/Project/douyin-scraper`)
**Claude session ID:** `c906f0d7-3c2b-4d2d-a2ab-33757612a07f`
**Resume command:** `cd <this-project> && claude --resume c906f0d7-3c2b-4d2d-a2ab-33757612a07f`

To carry this context into another project, add to that project's `CLAUDE.md`:
```
@/Users/hoangtrung/Documents/THQ Solution/Project/Projects/claude/douyin-downloader/SESSION-SUMMARY.md
```

---

## 1. The Problem

Redis on the VPS logged repeatedly:
```
write error while saving DB to Disk (rdbSaveRio): No space left on device
```

**Root cause:** the VPS root partition was 100% full (23GB / 23GB). Redis was trying to `BGSAVE` the RDB snapshot to disk and failing.

**Investigation found Redis itself was NOT storing video files.** This project uses Redis only as a BullMQ queue backend. The actual disk hogs were:

| Source | Size | Notes |
|---|---|---|
| Docker images (old + dangling) | 12.92 GB | Multiple builds of `douyin-scraper-douyin-api`, plus old `n8n`, `mongo`, `postgres` images |
| Docker build cache | 8.99 GB | BuildKit layers accumulated over many `docker compose build` runs |
| `/var/log/syslog` (single file) | 950 MB | Not rotated by logrotate; brute-force SSH attempts inflated it |
| `/var/log/journal` (systemd) | 793 MB | Default vacuum settings too lax |
| `/var/log/btmp` + `btmp.1` | 243 MB | Failed SSH logins — strong signal of active brute-force |
| Docker container JSON logs | 388 MB | One container alone: 336 MB |
| `n8n_data/storage/...` | 1.3 GB | Unrelated to douyin app, but on same VPS |
| `downloads/` (douyin videos) | 41 MB | **Not the problem.** Videos are mounted to host, but tiny |

## 2. Immediate Cleanup (freed ~10 GB; 100% → 56%)

Run on VPS as root:

```bash
# Docker — biggest win
docker system prune -af              # images + stopped containers + networks. KEEPS volumes.
docker builder prune -af             # BuildKit cache

# System logs
truncate -s 0 /var/log/syslog
truncate -s 0 /var/log/btmp /var/log/btmp.1
journalctl --vacuum-size=100M

# Docker container logs — use truncate, NOT rm (rm leaves dockerd holding the inode)
for f in /var/lib/docker/containers/*/*-json.log; do truncate -s 0 "$f"; done
```

**Why these are safe:**
- `docker system prune -af` removes only images with no running container + stopped containers. Volumes are untouched (so `mongo_data`, `downloads`, `browser_data` are safe).
- `docker builder prune` only removes cache. Next build will be slower by 1-2 min; no functional impact.
- Truncating log files preserves the file descriptor so daemons keep writing — no service restart needed.

## 3. Long-term Fix — Configuration Changes

### `docker-compose.yml` — Redis settings + log limits for all services

Added a shared logging anchor (10 MB × 3 files per container = max 30 MB per container):
```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Applied `logging: *default-logging` to `douyin-api`, `mongo`, and `redis`.

Critical Redis change:
```yaml
redis:
  image: redis:7-alpine
  command: >
    redis-server
    --maxmemory 256mb
    --maxmemory-policy allkeys-lru
    --save ""
    --appendonly no
  volumes:
    - ./redis_data:/data
```

- `--maxmemory 256mb` + `allkeys-lru`: caps RAM use and auto-evicts oldest keys.
- `--save ""` + `--appendonly no`: **disables RDB and AOF persistence**. The "no space left" error came from RDB snapshots. BullMQ data is transient (job IDs, results with TTL) — losing it on restart is acceptable.
- `volumes: - ./redis_data:/data`: if persistence is ever re-enabled, it lands on the host disk (mountable, monitorable), not the container overlay layer.

### `src/services/queue.js` — shorter BullMQ TTL

```js
// Before
removeOnComplete: { age: 3600 },      // 1 hour
removeOnFail: { age: 3600 },

// After
removeOnComplete: { age: 600, count: 100 },
removeOnFail:     { age: 600, count: 50 },
```

10 minutes is enough for the frontend to poll for `channel.videos` results. Adding `count` caps prevents runaway queue growth.

### Apply
```bash
docker compose down && docker compose up -d
docker exec douyin-redis redis-cli CONFIG GET save        # should be empty
docker exec douyin-redis redis-cli INFO memory | grep maxmemory_policy   # allkeys-lru
```

## 4. Monitoring + Auto-Cleanup (Telegram)

Added two scripts to this repo under `scripts/`:

- `scripts/vps-maintenance.sh` — script with 3 modes:
  - `monitor`: check disk %, send Telegram alert if ≥ 85%
  - `prune`: docker prune (images > 7d) + truncate logs + journal vacuum, send result
  - `test`: send test Telegram message
- `scripts/install-vps-maintenance.sh` — installer: copies the script to `/usr/local/bin/` and writes `/etc/cron.d/vps-maintenance` with:
  - `0 * * * *` → hourly monitor
  - `0 3 * * 0` → weekly prune (Sunday 03:00)

Both scripts read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the project `.env` directly (so no credentials are hardcoded). The installer patches the `ENV_FILE` default in the installed script so manual runs work without exporting env vars.

Install on a new VPS:
```bash
sudo bash scripts/install-vps-maintenance.sh
# Or with custom .env path:
sudo ENV_FILE=/srv/myapp/.env bash scripts/install-vps-maintenance.sh
/usr/local/bin/vps-maintenance.sh test
```

Log location: `/var/log/vps-maintenance.log`.

## 5. Reusable Patterns (for other projects)

Things that generalize to any Node + Redis + Docker project on a small VPS:

1. **Never run `redis:alpine` without `--maxmemory`.** A queue backend with no memory cap will eventually OOM the host or fill disk via RDB.
2. **Disable Redis persistence if you only use it as a cache or queue.** `--save "" --appendonly no` eliminates an entire class of disk-full failure modes. Re-enable only if you need to survive restarts.
3. **Always set `logging.options.max-size` in docker-compose.** Default JSON file logging grows unbounded.
4. **BullMQ `removeOnComplete` / `removeOnFail` should have BOTH `age` and `count`.** Without `count`, a burst of jobs in one minute can blow up Redis memory before the age TTL kicks in.
5. **`docker system prune -af --filter "until=168h"`** in a weekly cron is a near-zero-risk way to prevent runaway image accumulation. Build cache (`docker builder prune`) needs separate handling.
6. **Use `truncate -s 0`, not `rm`, on log files held open by daemons.** `rm` keeps the inode allocated until the daemon closes the fd; truncate frees space immediately.
7. **High `/var/log/btmp` size = active SSH brute-force.** Treat as a security signal, not a disk problem. Solution is disabling password auth + key-only login + (optionally) fail2ban.

## 6. Outstanding Security Items (Not Done This Session)

1. **Change VPS root password.** The previous one was shared in chat; user said they would `passwd` it themselves.
2. **Disable SSH password auth.** Edit `/etc/ssh/sshd_config`:
   ```
   PasswordAuthentication no
   PermitRootLogin prohibit-password
   ```
   then `systemctl restart ssh`. Make sure a working SSH key is set up first.
3. Consider installing `fail2ban` given the brute-force traffic.

## 7. Files Touched

In this repo:
- `docker-compose.yml` — Redis command/volume, logging limits (committed as `8d7734b`)
- `src/services/queue.js` — BullMQ TTL (committed as `8d7734b`)
- `scripts/vps-maintenance.sh` — new (committed as `9ec5b4f`)
- `scripts/install-vps-maintenance.sh` — new (committed as `9ec5b4f`)

On VPS:
- `/usr/local/bin/vps-maintenance.sh` — installed copy of the script
- `/etc/cron.d/vps-maintenance` — cron schedule
- `/home/ubuntu/Project/douyin-scraper/docker-compose.yml.bak` — backup of pre-change file
- `/home/ubuntu/Project/douyin-scraper/src/services/queue.js.bak` — backup of pre-change file
- `./redis_data/` (project dir) — new Redis volume mount point