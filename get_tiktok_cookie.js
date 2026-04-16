/**
 * get_tiktok_cookie.js
 * Chạy trực tiếp trên Mac: node get_tiktok_cookie.js
 * - Mở browser TikTok để đăng nhập
 * - Tự động detect khi login xong
 * - Ghi cookie vào .env
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '.env');

async function run() {
  console.log('🚀 Mở browser TikTok... Hãy đăng nhập trong cửa sổ vừa mở.');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.goto('https://www.tiktok.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('⏳ Đang đợi bạn đăng nhập... (tối đa 3 phút)');

  let cookieString = null;
  const deadline = Date.now() + 3 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const cookies = await page.cookies('https://www.tiktok.com');
    const session = cookies.find(c => c.name === 'sessionid' && c.value.length > 5);
    if (session) {
      cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      console.log(`✅ Đăng nhập thành công! Đã tìm thấy ${cookies.length} cookies.`);
      break;
    }
  }

  await browser.close();

  if (!cookieString) {
    console.error('❌ Timeout — chưa đăng nhập trong 3 phút. Chạy lại script.');
    process.exit(1);
  }

  // Ghi vào .env (single quote để Docker Compose không bị lỗi ký tự $)
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `TIKTOK_COOKIE='${cookieString}'\n`);
  } else {
    let content = fs.readFileSync(ENV_PATH, 'utf8');
    if (/^TIKTOK_COOKIE=.*$/m.test(content)) {
      content = content.replace(/^TIKTOK_COOKIE=.*$/m, `TIKTOK_COOKIE='${cookieString}'`);
    } else {
      content += `\nTIKTOK_COOKIE='${cookieString}'\n`;
    }
    fs.writeFileSync(ENV_PATH, content);
  }

  console.log(`✅ Đã lưu TIKTOK_COOKIE vào .env (${cookieString.length} ký tự)`);
  console.log('👉 Restart Docker: docker compose up -d douyin-api');
}

run().catch(err => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});