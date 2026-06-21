# Douyin Video Downloader API

Backend API server để download video Douyin (抖音) từ link video đơn lẻ hoặc từ kênh/user profile.

**Base URL:** `https://thq-solution-tools.io.vn`

## Tính năng

- 🎬 **Parse video**: Lấy thông tin chi tiết video (title, author, statistics, download URL không watermark)
- ⬇️ **Download video**: Stream video trực tiếp qua API (không cần lưu trên server)
- 📋 **Danh sách video kênh**: Lấy danh sách video từ user profile
- 📦 **Batch download**: Download hàng loạt video từ kênh với task tracking
- 🔄 **Job queue**: Tất cả request được xử lý qua hàng đợi, polling kết quả qua jobId (UUID)
- 🔐 **Authentication**: API Token + Credit system

## Yêu cầu

- Node.js >= 18
- MongoDB + Redis
- Chromium (tự động cài bởi Puppeteer)
- Cookie Douyin hợp lệ

## Cài đặt

```bash
cd douyin-downloader
npm install
```

## Cấu hình

Chỉnh sửa file `.env`:

```env
PORT=3000
DOUYIN_COOKIE=your_douyin_cookie_here
DOWNLOAD_DIR=./downloads
MAX_CONCURRENT_DOWNLOADS=1
QUEUE_CONCURRENCY=1
QUEUE_LIMIT_MAX=2
QUEUE_LIMIT_DURATION_MS=10000
BROWSER_IDLE_TIMEOUT_MS=300000
REQUEST_TIMEOUT=30000
```

### Cách lấy Cookie Douyin

1. Mở trình duyệt, truy cập [douyin.com](https://www.douyin.com)
2. Đăng nhập tài khoản Douyin
3. Mở DevTools (F12) → tab **Application** → **Cookies** → `www.douyin.com`
4. Copy tất cả cookie thành 1 chuỗi dạng: `key1=value1; key2=value2; ...`
5. Paste vào `DOUYIN_COOKIE` trong file `.env`

> ⚠️ Cookie cần được cập nhật thường xuyên vì Douyin sẽ hết hạn cookie sau 1 thời gian.

## Chạy server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Server sẽ chạy tại `https://thq-solution-tools.io.vn`

## Authentication

Tất cả API endpoint (trừ `/api/free/*` và `/api/health`) yêu cầu API Token trong header:

```
Authorization: Bearer <your_api_token>
```

## API Endpoints

### 1. Parse Video

Lấy thông tin video từ URL (queue-based, trả về jobId):

```bash
curl -X POST https://thq-solution-tools.io.vn/api/video/parse \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{"url": "https://www.douyin.com/video/7000000000000000000"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "message": "Job queued. Poll GET /api/job/:jobId for result."
  }
}
```

### 2. Download Video

Queue parse video, sau đó download từ URL trả về:

```bash
curl -X POST https://thq-solution-tools.io.vn/api/video/download \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{"url": "https://www.douyin.com/video/7000000000000000000"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "f7e6d5c4-b3a2-1098-7654-321fedcba098",
    "message": "Job queued. Poll GET /api/job/:jobId for download URL."
  }
}
```

### 3. Kiểm tra kết quả Job

Polling kết quả job bằng jobId (UUID):

```bash
curl https://thq-solution-tools.io.vn/api/job/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Response (đang xử lý):**
```json
{
  "success": true,
  "data": {
    "status": "active",
    "progress": null
  }
}
```

**Response (hoàn thành):**
```json
{
  "success": true,
  "data": {
    "status": "completed",
    "result": {
      "video_id": "7000000000000000000",
      "title": "Video title",
      "author": { "nickname": "Author", "uid": "...", "sec_uid": "..." },
      "download_url": "https://...",
      "cover_url": "https://...",
      "duration": 30,
      "statistics": { "likes": 1000, "comments": 50, "shares": 10 }
    }
  }
}
```

### 4. Danh sách video từ kênh

```bash
curl -X POST https://thq-solution-tools.io.vn/api/channel/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{"url": "https://www.douyin.com/user/MS4wLjABAAAAxxxxxx", "count": 20, "cursor": 0}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "message": "Job queued. Poll GET /api/job/:jobId for result."
  }
}
```

### 5. Batch download từ kênh

```bash
curl -X POST https://thq-solution-tools.io.vn/api/channel/download \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -d '{"url": "https://www.douyin.com/user/MS4wLjABAAAAxxxxxx", "count": 10}'
```

### 6. Free Parse (không cần auth)

```bash
curl -X POST https://thq-solution-tools.io.vn/api/free/parse \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.douyin.com/video/7000000000000000000"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "c3d4e5f6-a7b8-9012-cdef-234567890123"
  }
}
```

### 7. Media Proxy (bypass Douyin anti-hotlink)

```bash
# Stream media
curl "https://thq-solution-tools.io.vn/api/proxy/media?url=ENCODED_DOUYIN_CDN_URL"

# Force download
curl "https://thq-solution-tools.io.vn/api/proxy/media?url=ENCODED_DOUYIN_CDN_URL&dl=1" -o video.mp4
```

### 8. Health Check

```bash
curl https://thq-solution-tools.io.vn/api/health
```

### 9. Auth / Session Management

```bash
# Kiểm tra trạng thái login
curl https://thq-solution-tools.io.vn/api/auth/status

# Mở browser để login (quét QR)
curl https://thq-solution-tools.io.vn/api/auth/login

# Xác nhận đã login xong
curl https://thq-solution-tools.io.vn/api/auth/confirm

# Import cookie từ .env
curl -X POST https://thq-solution-tools.io.vn/api/auth/inject
```

## Workflow sử dụng API

```
1. POST /api/video/parse        →  Nhận jobId (UUID)
2. GET  /api/job/{jobId}         →  Poll cho đến khi status = "completed"
3. Lấy download_url từ result   →  Download video qua /api/proxy/media
```

## Hỗ trợ URL

- `https://www.douyin.com/video/xxxxx` - Link video đầy đủ
- `https://www.douyin.com/note/xxxxx` - Link note
- `https://v.douyin.com/xxxxx/` - Link chia sẻ ngắn
- `https://www.douyin.com/user/xxxxx` - Link user profile
- Text chia sẻ chứa link Douyin

## Lưu ý quan trọng

1. **Cookie bắt buộc**: Cần cookie Douyin hợp lệ để API hoạt động
2. **Mạng**: Douyin là nền tảng Trung Quốc, cần IP Trung Quốc hoặc proxy cho kết quả ổn định
3. **Anti-bot**: Douyin có hệ thống chống bot mạnh, cookie có thể hết hạn bất kỳ lúc nào
4. **Sử dụng**: Chỉ dùng cho mục đích cá nhân/giáo dục

## Cấu trúc dự án

```
douyin-downloader/
├── .env                         # Cấu hình (cookie, port, ...)
├── package.json
├── README.md
├── Dockerfile
├── docker-compose.yml           # App + Mongo + Redis
├── start.sh                     # Khởi tạo Xvfb + VNC + Node.js
├── docker/
│   └── nginx-bridge/
│       ├── docker-compose.yaml  # Nginx reverse proxy (SSL)
│       └── conf.d/sites.conf    # Nginx config
├── src/
│   ├── server.js                # Entry point Express server
│   ├── config.js                # Configuration
│   ├── routes/
│   │   ├── api.js               # API routes
│   │   └── web.js               # Web routes
│   ├── services/
│   │   ├── douyin.js            # Douyin scraping service
│   │   ├── downloader.js        # Video download service
│   │   └── queue.js             # BullMQ job queue
│   ├── models/
│   │   ├── User.js              # User model (auth + credits)
│   │   ├── Package.js           # Credit packages
│   │   └── ApiLog.js            # API usage logging
│   ├── middleware/
│   │   ├── authApi.js           # API token auth
│   │   ├── authWeb.js           # Web session auth
│   │   ├── deductCredits.js     # Credit deduction
│   │   └── errorHandler.js      # Error handler
│   └── utils/
│       ├── logger.js            # Winston logger
│       └── helpers.js           # URL parsing, utilities
├── views/                       # EJS templates
├── public/                      # Static assets
└── downloads/                   # Downloaded videos
```
