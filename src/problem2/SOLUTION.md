# Problem 2: Diagnose Me Doctor

**Situation:** Ubuntu 24.04 VM, 64 GB disk, sitting at ~99% usage. Its only job is running NGINX as a load balancer / traffic router.

**Assumptions:**
- The full 64 GB is provisioned to the root filesystem: the partition/LVM volume and the filesystem already use the whole disk (checked with `df -hT` / `lsblk`), so "99%" really means ~63 GB used, not a small root volume.
- The VM runs only NGINX plus the standard Ubuntu 24.04 base and monitoring agent; there are no other workloads on it.

**Starting point:** a reverse proxy is close to stateless. Its binaries and config take a few hundred MB, so a disk that is 99% full is not something NGINX needs. Either something is **growing** (logs, temp/cache files, journal) or something is **held** (deleted files that are still open). The steps below are meant to tell those apart quickly. Stop the bleeding first, then find the root cause, then make sure it can't come back.

---

## 1. Stabilise first (first 5–10 minutes)

The load balancer sits in front of every upstream, so a full disk here can become an outage for **all** of them. Before digging deep:

```bash
# Is traffic still flowing? Is NGINX already failing?
systemctl status nginx
curl -sI http://localhost/ -o /dev/null -w '%{http_code}\n'
tail -n 50 /var/log/nginx/error.log | grep -i "no space\|28:"   # errno 28 = ENOSPC
```

If we're at 100% or close to it, free space **safely** to buy time. Go from "loses nothing" to "loses data":

```bash
# 1) Free space that holds no data we need
sudo apt-get clean                     # cached .deb packages
sudo journalctl --vacuum-size=200M     # old journal entries (keeps the most recent)

# 2) Move old rotated logs off the box, then delete them locally
#    (logs are audit data, especially in healthcare, so archive before deleting)
aws s3 cp /var/log/nginx/ s3://<log-archive>/$(hostname)/ --recursive --exclude "*" --include "*.gz" \
  && sudo find /var/log/nginx -name "*.gz" -delete

# 3) Rotate the live log WITHOUT losing it: rename, tell NGINX to reopen, then compress or ship it
sudo mv /var/log/nginx/access.log /var/log/nginx/access.log.emergency
sudo nginx -s reopen                   # NGINX starts a new access.log; the old one is now closed
gzip -c /var/log/nginx/access.log.emergency | aws s3 cp - s3://<log-archive>/$(hostname)/access-$(date +%F-%H%M).log.gz \
  && sudo rm /var/log/nginx/access.log.emergency
#    (gzip -c | upload streams off the box, so it works even with almost no free space.
#     If there is a few GB free, `sudo gzip access.log.emergency` locally also works: text logs shrink ~10x.)

# 4) LAST RESORT ONLY: truncate. This throws away the log content.
#    Keep at least the recent tail for the investigation first.
sudo tail -n 200000 /var/log/nginx/access.log > /dev/shm/access.tail   # RAM, not the full disk
sudo truncate -s 0 /var/log/nginx/access.log
```

> **Why not `rm` the live log?** NGINX keeps the file open, so `rm` only removes the name. The space is **not** freed until NGINX reopens it (see cause D). `mv` + `nginx -s reopen` is the correct way to rotate. `truncate` frees space immediately but **deletes the content**, so only use it once the log is saved or confirmed worthless.

> If there is a high-availability (HA) pair or load balancer pool, take this node **out of rotation** (or shift DNS/load balancer weight) while we work, so users aren't affected if NGINX has to restart.

---

## 2. Troubleshooting steps

### Step 1: What exactly is full?

```bash
df -hT                 # which filesystem is at 99%? (assumed: / at ~64G)
lsblk -f               # quick sanity check of the disk layout
```

### Step 2: Where is the space going?

```bash
sudo du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -15
sudo du -xh --max-depth=2 /var 2>/dev/null | sort -h | tail -15
sudo find / -xdev -type f -size +500M -exec ls -lh {} \; 2>/dev/null
sudo ncdu -x /          # interactive, if it's installed
```

The usual suspects on an NGINX box:

| Path | What lives there |
|---|---|
| `/var/log/nginx/` | access/error logs, rotated `.gz` files |
| `/var/log/journal/`, `/var/log/syslog*` | journald / rsyslog |
| `/var/lib/nginx/` (`body`, `proxy`, `fastcgi`) | request/response buffers spilled to disk |
| `/var/cache/nginx/` (or whatever `proxy_cache_path` points to) | proxy cache |

### Step 3: Does `du` match `df`?

If `df` says 63 GB used but `du` only adds up to ~10 GB, the space is held by **deleted files that are still open**, or by files **hidden underneath a mount point**.

```bash
sudo lsof -nP +L1 | sort -k7 -n | tail      # deleted files that are still open, with their size
sudo lsof -nP +L1 | grep nginx

# Hidden-under-mountpoint check: bind-mount / somewhere else and look underneath
sudo mkdir -p /mnt/rootfs && sudo mount --bind / /mnt/rootfs && sudo du -sh /mnt/rootfs/var/* ; sudo umount /mnt/rootfs
```

### Step 4: Is it still growing, and how fast?

```bash
watch -n 5 'df -h /'                                       # growth rate
sudo find / -xdev -type f -mmin -10 -size +10M 2>/dev/null # big files written in the last 10 minutes
sudo iotop -oPa                                            # which process is writing
```

Also look at the monitoring graph. A **steady slope** points to log/journal growth. A **sudden step** points to a core dump, a cache fill or someone's file. A **sawtooth that never drops** points to rotation running without space ever being released.

### Step 5: Check the NGINX and log-rotation config

```bash
sudo nginx -T 2>/dev/null | grep -Ei "access_log|error_log|proxy_cache_path|proxy_temp|client_body|proxy_buffering|max_temp_file"
systemctl list-timers | grep logrotate         # on 24.04 logrotate runs from a systemd timer, not cron
systemctl status logrotate.service             # did the last run fail?
sudo logrotate -d /etc/logrotate.d/nginx       # dry run: would it rotate?
sudo journalctl --disk-usage
```

---

## 3. Likely root causes (most to least likely): impact, recovery, prevention

### A. NGINX logs growing without limit *(most likely)*

**Scenario:** a load balancer logs **every request**, so at a few thousand RPS `access.log` grows by GBs per day. It gets worse when:
- logrotate is broken: the timer is disabled, the config has a syntax error, the `/var/log/nginx` permissions are wrong, or the last run failed and left `/var/lib/logrotate/status` in a bad state;
- rotation is time-based only (`daily`, `rotate 14`) while traffic grew, e.g. after a launch, a bot or a DDoS;
- `error_log ... debug` or `info` was left on after an investigation;
- a custom `log_format` logs large fields (headers, request bodies, `$request_body`);
- upstreams are failing, so the error log fills with `upstream timed out` / `connect() failed`, one line per request.

**Impact:**
- NGINX normally **keeps proxying** when it can't write logs, but you lose access and audit logs, which is bad for security and compliance (healthcare data).
- Anything that needs disk space starts to fail: request buffering (see B), `nginx -t` / reloads, certbot renewals (and then TLS certificates expire), apt security updates, journald, and even SSH logins can get flaky.

**Recovery:**
```bash
# Preferred: rotate without losing data (mv + reopen, then compress/ship. See section 1)
sudo mv /var/log/nginx/access.log /var/log/nginx/access.log.1 && sudo nginx -s reopen
# Archive old rotated logs off-box before deleting them locally
sudo find /var/log/nginx -name "*.gz" -mtime +7 -delete   # after they are archived
# Last resort: `truncate -s 0` gives immediate relief but discards the content
sudo logrotate -f /etc/logrotate.d/nginx             # force a rotation once the config is fixed
```
Fix the logrotate config: rotate on size and keep fewer copies.
```
/var/log/nginx/*.log {
    daily
    maxsize 1G          # rotate early if a file gets large between runs
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -s /run/nginx.pid ] && kill -USR1 $(cat /run/nginx.pid)
    endscript
}
```
Optionally run logrotate hourly (`systemctl edit logrotate.timer` → `OnCalendar=hourly`) so `maxsize` takes effect quickly.

**Prevention:** send logs to a central system (Loki/ELK/CloudWatch) and keep only a short local buffer. Sample or skip noisy logging (`access_log ... if=$loggable` for health checks; `access_log off` on `/healthz`). Use `error_log warn` in production. Optionally use `access_log ... buffer=64k flush=5s` to cut down on IOPS.

---

### B. NGINX buffering or caching to disk (proxy temp / client body / proxy_cache) *(likely if users upload large files)*

**Scenario:**
- **`client_body_temp`:** large uploads that exceed `client_body_buffer_size` are written to `/var/lib/nginx/body`. A large `client_max_body_size` combined with heavy upload traffic (or an abuse pattern) fills the disk.
- **`proxy_temp`:** with `proxy_buffering on`, upstream responses bigger than the memory buffers spill to `/var/lib/nginx/proxy`, up to `proxy_max_temp_file_size` (default 1 GB **per request**). Slow clients downloading large files (reports, images, exports) multiply this.
- **`proxy_cache_path` without `max_size`:** the cache grows until the disk is full. The cache manager only evicts after the disk is already in trouble, or never.
- **Leftovers that nobody cleans up:** temp files orphaned when NGINX crashes, is killed with `kill -9` or a request is cut off mid-upload, plus old cache directories left behind after a `proxy_cache_path` change. Nothing removes these automatically, so they pile up over time.

**Impact:** this is where a full disk turns into **user-facing errors**. NGINX logs `pwrite() ... failed (28: No space left on device)` and returns **500/502** on large requests and responses. Uploads fail. Cache writes fail (higher upstream load, more latency). Problems show up intermittently, only on "big" requests, which makes them hard to pin down.

**Recovery:**
```bash
sudo du -sh /var/lib/nginx/* /var/cache/nginx 2>/dev/null
# Cache: safe to wipe. NGINX rebuilds it (expect a temporary rise in upstream load)
sudo find /var/cache/nginx -type f -delete
# Temp: only delete files that no live request is using
sudo find /var/lib/nginx/{body,proxy} -type f -mmin +60 -delete
sudo systemctl reload nginx
```
Fix the config:
```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=edge:50m max_size=10g inactive=60m use_temp_path=off;
proxy_max_temp_file_size 256m;    # or 0 to stream instead of spooling (for downloads/exports)
client_max_body_size 20m;         # match the real business requirement
# For large upload endpoints, stream to the upstream:
# proxy_request_buffering off;
```

**Prevention:** always set `max_size` on caches. Put the cache and temp directories on a **separate volume** or a size-capped tmpfs, so they can't take the root filesystem with them. Rate-limit upload endpoints. Alert on the size of `/var/lib/nginx`.

---

### C. systemd journal / rsyslog bloat *(possible)*

**Scenario:** `error_log syslog:` or `access_log syslog:` is configured, so every request also goes through rsyslog into `/var/log/syslog` (stored **twice**, in syslog and in the journal). Or NGINX runs under systemd with stdout/stderr logging into journald. Or another process is flapping and restart-looping, writing to the journal non-stop. journald's default cap is 10% of the filesystem (≈6.4 GB here) and `/var/log/syslog` has its own rotation, so together they add up.

**Impact:** gradual fill; the same knock-on effects as A.

**Recovery:**
```bash
sudo journalctl --disk-usage
sudo journalctl --vacuum-size=500M      # or --vacuum-time=7d
sudo truncate -s 0 /var/log/syslog
```
Make the cap permanent in `/etc/systemd/journald.conf`: `SystemMaxUse=1G`, `SystemMaxFileSize=100M`, then `systemctl restart systemd-journald`. Remove the duplicated syslog targets.

**Prevention:** one logging path per log stream. Use explicit caps on journald.

---

### D. Deleted-but-still-open files (space never released) *(least likely)*

*Least likely here because the server is under our own management: the team knows not to `rm` live logs, and the standard logrotate setup reopens NGINX logs. It's still worth one quick check (`lsof +L1`), because it is the case where `df` and `du` disagree.*

**Scenario:** someone ran `rm access.log` to "free space", or logrotate rotates the file **without signalling NGINX** (the `postrotate` USR1 is missing or broken, or `copytruncate` is misused). NGINX keeps writing to a file handle that has no name anymore. `du` can't see it, but `df` keeps climbing. This is the classic case where **`df` and `du` disagree**.

**Impact:** the same as A, and it's confusing: the disk "fills up for no reason" and cleaning up doesn't help. Logs written after the deletion are effectively lost.

**Recovery:**
```bash
sudo lsof -nP +L1 | grep nginx                 # confirm: (deleted) files with large sizes
sudo nginx -s reopen                           # or: systemctl reload nginx. Workers close old handles, open new files; no downtime
# Emergency option without signalling NGINX: truncate through /proc
sudo truncate -s 0 /proc/<PID>/fd/<FD>
```

**Prevention:** fix `postrotate` (USR1 / `nginx -s reopen`). Add a runbook rule: **never `rm` live logs**. Rotate with `mv` + reopen, and only truncate after the content is saved. Alert when `df` and `du` drift apart.

---

## 4. Summary decision tree

```
99% disk on NGINX load balancer
│
├─ du shows a big directory:
│   ├─ /var/log/nginx ───────────────────────────────► A: logrotate / log volume
│   ├─ /var/lib/nginx, /var/cache/nginx ─────────────► B: temp buffering / cache max_size
│   └─ /var/log/journal, /var/log/syslog ────────────► C: journald / rsyslog caps
└─ du total ≪ df used? ──► lsof +L1 ─────────────────► D: deleted-open files → nginx -s reopen
```

## 5. Hardening after the incident

1. **Alerting:** warn at 75%, page at 90%, **plus a growth-rate / "full in < 24h" prediction** alert (e.g. Prometheus `predict_linear(node_filesystem_avail_bytes[6h], 24*3600) < 0`). Include an alert for `df`/`du` drift (deleted-open files).
2. **Isolation:** give `/var/log` and the NGINX cache/temp directories their own volumes (or caps), so a log or cache runaway can't take down the OS and the proxy.
3. **Logs off-box:** ship logs centrally, keep short local retention, use size-based rotation.
4. **Config guardrails:** `max_size` on every cache, `proxy_max_temp_file_size`, sensible `client_max_body_size`, `error_log warn`, no access logging for health checks. All of it managed through config management or IaC and reviewed in PRs.
5. **Remove the single point of failure:** run at least 2 load balancer nodes (or a managed load balancer) behind a VIP/DNS, so one node can be drained and fixed (or **rebuilt from the golden image**) without an outage.
6. **Runbook:** document the "never rm a live log; mv + reopen, truncate only as a last resort" rule, the safe cleanup commands above, and how to drain the node.
