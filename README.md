# Douyin Video Downloader API

Backend API server để download video Douyin (抖音) từ link video đơn lẻ hoặc từ kênh/user profile.

## Tính năng

- 🎬 **Parse video**: Lấy thông tin chi tiết video (title, author, statistics, download URL không watermark)
- ⬇️ **Download video**: Stream video trực tiếp qua API (không cần lưu trên server)
- 📋 **Danh sách video kênh**: Lấy danh sách video từ user profile
- 📦 **Batch download**: Download hàng loạt video từ kênh với task tracking
- 🔄 **Task management**: Theo dõi tiến trình batch download

## Yêu cầu

- Node.js >= 18
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
MAX_CONCURRENT_DOWNLOADS=3
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

Server sẽ chạy tại `http://localhost:3000`

## API Endpoints

### 1. Parse Video

Lấy thông tin video từ URL:

```bash
curl -X POST http://localhost:3000/api/video/parse \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.douyin.com/video/7000000000000000000"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "video_id": "7000000000000000000",
    "title": "Video title",
    "author": { "nickname": "Author", "uid": "...", "sec_uid": "..." },
    "download_url": "https://...",
    "cover_url": "https://...",
    "duration": 30,
    "statistics": { "likes": 1000, "comments": 50, "shares": 10 }
  }
}
```

### 2. Download Video

Download video trực tiếp (trả về file mp4):

```bash
curl -X POST http://localhost:3000/api/video/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.douyin.com/video/7000000000000000000"}' \
  -o video.mp4
```

### 3. Danh sách video từ kênh

```bash
curl -X POST http://localhost:3000/api/channel/videos \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.douyin.com/user/MS4wLjABAAAAxxxxxx", "count": 20, "cursor": 0}'
```

### 4. Batch download từ kênh

```bash
# Bắt đầu batch download
curl -X POST http://localhost:3000/api/channel/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.douyin.com/user/MS4wLjABAAAAxxxxxx", "count": 10}'

# Kiểm tra tiến trình
curl http://localhost:3000/api/task/{task_id}
```

### 5. Health Check

```bash
curl http://localhost:3000/api/health
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
├── .env                     # Cấu hình (cookie, port, ...)
├── package.json
├── README.md
├── src/
│   ├── server.js            # Entry point Express server
│   ├── config.js            # Configuration
│   ├── routes/api.js        # API routes
│   ├── services/
│   │   ├── douyin.js        # Douyin scraping service
│   │   └── downloader.js    # Video download service
│   ├── middleware/
│   │   └── errorHandler.js  # Error handler
│   └── utils/
│       ├── logger.js        # Winston logger
│       └── helpers.js       # URL parsing, utilities
└── downloads/               # Downloaded videos
```
