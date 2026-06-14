# Deploy & Vận hành

Hướng dẫn deploy, chạy lại Docker khi đổi code, gia hạn cookie đăng nhập Douyin, và cron cảnh báo session.

- **VPS:** `103.163.118.42` — user `root`
- **Đường dẫn project:** `/home/ubuntu/Project/douyin-scraper`
- **Domain:** `https://thq-solution-tools.io.vn`
- **Múi giờ VPS:** Europe/London (≠ giờ VN — các cron đặt giờ VN qua `CRON_TZ`)

---

## 1. Deploy (CI/CD tự động)

Push lên `master` → GitHub Actions tự SSH vào VPS, pull code, rebuild Docker, prune image cũ, health-check, báo Telegram.

```bash
git push origin master
```

Workflow: `.github/workflows/deploy.yml` → chạy `scripts/deploy.sh` trên VPS:
`git reset --hard origin/master` → `docker compose build` → `up -d` → prune image/cache >7 ngày → health-check `/api/health` → Telegram.

**Secrets cần có** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Giá trị |
|---|---|
| `VPS_HOST` | `103.163.118.42` |
| `VPS_USERNAME` | `root` |
| `VPS_SSH_KEY` | private key (`cat ~/.ssh/douyin_deploy`) |
| `VPS_PORT` | (tùy chọn, mặc định 22) |

> ⚠️ Workflow dùng `git reset --hard` → **mọi sửa tay file tracked trên VPS chưa commit sẽ bị xóa**. Sửa gì trên VPS (vd nginx `docker/nginx-bridge/conf.d/sites.conf`) thì phải commit vào repo, đừng chỉ sửa trên VPS.

### Deploy thủ công (nếu không dùng CI/CD)

```bash
ssh root@103.163.118.42
cd /home/ubuntu/Project/douyin-scraper
git pull origin master        # hoặc: git fetch && git reset --hard origin/master
bash scripts/deploy.sh
```

---

## 2. Chạy lại Docker khi đổi code

`douyin-api` build từ source (Dockerfile `COPY . .`) nên đổi code **phải rebuild**, không chỉ restart.

```bash
cd /home/ubuntu/Project/douyin-scraper

# Rebuild + chạy lại chỉ app (mongo/redis giữ nguyên)
docker compose up -d --build douyin-api

# Xem log
docker compose logs -f --tail=100 douyin-api

# Health check
curl -s http://localhost:3000/api/health
```

Lệnh hữu ích:
```bash
docker compose ps                      # trạng thái các service
docker compose restart douyin-api      # chỉ restart (KHÔNG nạp code mới)
docker compose down && docker compose up -d   # dựng lại cả stack
```

> **Cookie không mất khi rebuild:** `browser_data/`, `mongo_data/`, `redis_data/` là volume mount → tồn tại qua mọi lần `up -d --build`.
>
> **Port:** host port chỉnh qua `.env` (`DOUYIN_HOST_PORT`, `DOUYIN_VNC_PORT`); để trống → mặc định 3000/6080. Nginx route nội bộ qua `douyin-downloader:3000` nên đổi host port không ảnh hưởng prod.

---

## 3. Gia hạn cookie đăng nhập Douyin (re-login)

Session Douyin (`sessionid`) sống ~60 ngày nhưng có thể bị Douyin vô hiệu sớm hơn. **Session hết hạn → feed trả data cũ, thiếu video mới** (không báo lỗi). Khi đó cần login lại:

1. **Mở browser login trên VPS** (cần API token):
   ```bash
   curl https://thq-solution-tools.io.vn/api/auth/login \
     -H "Authorization: Bearer YOUR_API_TOKEN"
   ```

2. **Mở noVNC** rồi bấm **Connect** (lưu ý tham số `?path=...` cho WebSocket):
   ```
   https://thq-solution-tools.io.vn/douyin-login/vnc.html?path=douyin-login/websockify
   ```
   → thấy cửa sổ Chromium ở trang login Douyin.

3. **Quét mã QR** bằng app Douyin trên điện thoại, đợi trang vào douyin.com đã đăng nhập.

4. **Lưu cookie:**
   ```bash
   curl https://thq-solution-tools.io.vn/api/auth/confirm \
     -H "Authorization: Bearer YOUR_API_TOKEN"
   ```
   Trả về `"logged_in": true` là xong.

5. **Kiểm tra** (since=yesterday để chắc lấy được video mới):
   ```bash
   JOB=$(curl -s -X POST https://thq-solution-tools.io.vn/api/channel/videos \
     -H "Authorization: Bearer YOUR_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"url":"https://www.douyin.com/user/SEC_UID","count":20,"since":"yesterday"}' | jq -r '.data.jobId')
   sleep 8
   curl -s https://thq-solution-tools.io.vn/api/job/$JOB \
     -H "Authorization: Bearer YOUR_API_TOKEN" | jq '.data.result.videos[] | {create_time, title}'
   ```

> Kiểm tra trạng thái session bất kỳ lúc nào: `GET /api/auth/status` → `{ logged_in, has_session, ... }`.

---

## 4. Cron cảnh báo session hết hạn (Telegram)

Chạy **1 lần/ngày lúc 12:00 giờ VN**, gọi `/api/auth/status`; nếu phát hiện hết đăng nhập thì nhắn Telegram kèm các bước login lại.

**Cài (chạy 1 lần trên VPS, cần root):**
```bash
sudo bash /home/ubuntu/Project/douyin-scraper/scripts/install-vps-maintenance.sh
```
Lệnh này cài `/usr/local/bin/douyin-session-check.sh` + ghi `/etc/cron.d/vps-maintenance` (kèm disk monitor + weekly prune).

**Test / chạy tay:**
```bash
/usr/local/bin/douyin-session-check.sh test    # gửi tin Telegram test
/usr/local/bin/douyin-session-check.sh          # check thật
```

Log: `/var/log/douyin-session-check.log`

> Script lấy 3 mẫu trong 1 lần chạy, chỉ cảnh báo "hết hạn" khi **không mẫu nào** báo đăng nhập và **≥2 mẫu** báo chưa đăng nhập — tránh báo giả do `checkSession` thỉnh thoảng âm tính giả. Đọc `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` từ `.env`.

---

## Tham khảo nhanh

| Việc | Lệnh |
|---|---|
| Deploy | `git push origin master` |
| Rebuild app | `docker compose up -d --build douyin-api` |
| Log app | `docker compose logs -f --tail=100 douyin-api` |
| Trạng thái session | `curl .../api/auth/status -H "Authorization: Bearer TOKEN"` |
| Login lại | `/api/auth/login` → noVNC quét QR → `/api/auth/confirm` |
| Cài cron cảnh báo | `sudo bash scripts/install-vps-maintenance.sh` |