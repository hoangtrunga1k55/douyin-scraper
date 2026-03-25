#!/usr/bin/env node

/**
 * Cookie Helper Script
 * 
 * Mở trình duyệt Chromium, bạn đăng nhập Douyin,
 * sau đó script tự động lưu cookie vào file .env
 * 
 * Usage: node scripts/get-cookie.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '..', '.env');

async function main() {
  console.log('🍪 Douyin Cookie Helper');
  console.log('========================');
  console.log('');
  console.log('Đang mở trình duyệt... Hãy đăng nhập vào Douyin.');
  console.log('Sau khi đăng nhập xong, quay lại terminal và nhấn ENTER.');
  console.log('');

  // Launch browser with visible window (non-headless)
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--lang=zh-CN',
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();
  await page.goto('https://www.douyin.com', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for user to press ENTER
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question('✅ Đã đăng nhập xong? Nhấn ENTER để lưu cookie... ', resolve);
  });
  rl.close();

  // Get all cookies
  const cookies = await page.cookies();
  await browser.close();

  if (cookies.length === 0) {
    console.log('❌ Không tìm thấy cookie nào. Hãy thử lại.');
    process.exit(1);
  }

  // Convert to cookie string
  const cookieString = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  console.log(`\n🍪 Đã lấy ${cookies.length} cookies.`);

  // Update .env file
  let envContent = '';
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  if (envContent.includes('DOUYIN_COOKIE=')) {
    // Replace existing cookie
    envContent = envContent.replace(
      /DOUYIN_COOKIE=.*/,
      `DOUYIN_COOKIE=${cookieString}`
    );
  } else {
    envContent += `\nDOUYIN_COOKIE=${cookieString}\n`;
  }

  fs.writeFileSync(ENV_PATH, envContent);
  console.log('✅ Cookie đã được lưu vào file .env');
  console.log('🚀 Bây giờ bạn có thể chạy: npm start');
}

main().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
