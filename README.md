# Traffic Server & Web Demo (`/boost`)

Ứng dụng Node.js (Express + Socket.IO) quản lý chiến dịch điều phối traffic theo phân bố thời gian, kèm web demo đặt đơn / thanh toán / theo dõi trực tiếp không cần đăng ký tài khoản tại `/boost`.

Hỗ trợ đầy đủ **3 chế độ chạy**:
1. **Live Backend (Same-Origin):** Chạy trực tiếp trên `node server.js` (`http://localhost:3005/boost`) với toàn bộ tính năng thật (VietQR, Webhook, KiotProxy, Admin 1 tài khoản).
2. **Static Demo Fallback (24/7 trên GitHub Pages / Cloudflare Pages):** Tự động chạy giao diện `/boost` độc lập trên trình duyệt (tính giá, chia lịch Smart/Even/Custom, tạo mã VietQR, mô phỏng duyệt đơn & tiến độ bằng `localStorage`) khi không có server backend online.
3. **Remote Tunnel (`Cloudflare Quick Tunnel` / `Cloudflare API v4`):** Nối trực tiếp giao diện static trên GitHub Pages / Cloudflare Pages với server Node.js thật qua URL `https://*.trycloudflare.com` (CORS + Bearer Token + Socket.IO).

## Yêu cầu môi trường

- **Node.js** (khuyến nghị LTS v18+ / v20+)
- **npm**
- (Tùy chọn cho test giao diện trình duyệt) **Microsoft Edge / Playwright** (`playwright` nằm trong dependencies)
- (Tùy chọn để public localhost không cần VPS/tên miền) **`cloudflared`** (`winget install --id Cloudflare.cloudflared -e`)

## Cài đặt & Chạy cục bộ

```bash
# 1. Cài đặt thư viện
npm install

# 2. Khởi động server (mặc định cổng 3005)
npm start
```

Có thể đổi cổng bằng biến môi trường `PORT`, ví dụ trên PowerShell:

```powershell
$env:PORT=3005; npm start
```

### Các đường dẫn chính khi chạy server

- **Web Demo 1 màn hình (không cần tạo tài khoản):** `http://localhost:3005/boost`
- **Trang đặt đơn riêng / theo dõi đơn công khai:** `http://localhost:3005/order.html`, `http://localhost:3005/track.html`
- **Trang quản trị Admin:** `http://localhost:3005/` (đăng nhập tại `http://localhost:3005/login.html`)
  - Khi clone mới chưa có `admin.json`, server tự khởi tạo tài khoản mặc định `admin` / `admin123456`. Hãy đổi mật khẩu ngay khi triển khai thực tế.

## Giữ Web Demo chạy 24/7 với GitHub + Cloudflare (Không cần VPS / Tên miền)

### 1. Host giao diện Web Demo 24/7 (Cloudflare Pages / GitHub Pages)

Repository đã tích hợp sẵn script build tĩnh (`npm run build:demo` tạo thư mục `dist-demo/`) và GitHub Actions workflows trong `.github/workflows/`:

- **GitHub Pages (`.github/workflows/pages.yml`):**
  1. Trên GitHub vào **Settings → Pages → Build and deployment → Source**, chọn **GitHub Actions**.
  2. Mỗi khi push lên `main`, web demo tự cập nhật tại `https://proyctk03-eng.github.io/traffic_server/`.
- **Cloudflare Pages miễn phí `*.pages.dev`:**
  - *Cách A (không cần tạo API Token):* Vào Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**, chọn repo GitHub này, đặt:
    - **Build command:** `npm run build:demo`
    - **Build output directory:** `dist-demo`
  - *Cách B (tự động deploy qua GitHub Actions `.github/workflows/cloudflare-pages.yml`):* Thêm 2 GitHub Secrets `CLOUDFLARE_API_TOKEN` (Scoped API Token có quyền `Cloudflare Pages: Edit` + `Account Settings: Read`) và `CLOUDFLARE_ACCOUNT_ID` vào **Settings → Secrets and variables → Actions** (workflow tự tạo Pages project `traffic-server-demo` nếu chưa tồn tại).

### 2. Nối Web Demo với Backend thật qua Cloudflare Quick Tunnel (Miễn phí)

Khi muốn web demo trên Cloudflare Pages / GitHub Pages chạy **chức năng thật** (KiotProxy, HTTP request thật, webhook):

```bash
# Terminal 1: Chạy server backend
npm start

# Terminal 2: Mở Cloudflare Quick Tunnel (không cần domain)
npm run tunnel:quick
```

Lệnh sẽ xuất ra 2 đường dẫn HTTPS công khai:
- Link chạy trực tiếp: `https://<random>.trycloudflare.com/boost`
- Link gắn Backend vào trang Pages: `https://.../traffic_server/?backend=https://<random>.trycloudflare.com` (hoặc dán URL Tunnel vào thanh **Kết nối Tunnel** ngay trên trang demo).

### 3. Kiểm tra kết nối Cloudflare API v4 (Tùy chọn)

Sao chép `.env.example` thành `.env`, điền `CLOUDFLARE_API_TOKEN` (và `CLOUDFLARE_ACCOUNT_ID` nếu có), rồi chạy:

```bash
npm run cf:verify
```

## Cấu hình cục bộ (được `.gitignore` loại trừ khỏi Git)

Các file chứa thông tin nhạy cảm hoặc dữ liệu runtime không được đẩy lên GitHub:

- `.env`: Biến môi trường cục bộ (`PORT`, `CORS_ORIGINS`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Xem mẫu tại `.env.example`.
- `admin.json`, `sessions.json`: Tài khoản quản trị và phiên đăng nhập.
- `proxy_config.json`: Khóa API KiotProxy và cấu hình xoay proxy (`region`, `keys`, `cooldownSec`).
- `payment_config.json`: Thông tin ngân hàng VietQR & `webhookSecret` cho `/api/payment/webhook`.
- `telegram_config.json`: `botToken` và `chatIds` nhận thông báo Telegram.
- `orders/`, `campaigns/`, `dist-demo/`: Dữ liệu đơn hàng, chiến dịch và bản build tĩnh được tạo khi chạy.

## Chạy kiểm thử (Test Suite)

> Lưu ý: Chạy **tuần tự từng lệnh** (không chạy song song vì các suite dùng chung file cấu hình snapshot và port nội bộ).

```bash
# 1. Kiểm tra phân bố thời gian (timeDistribution)
node test_distribution.js

# 2. Unit & Integration tests + UI Web Demo (/boost) + Cloudflare/Static Dual-Mode
npm test

# 3. Bộ kiểm thử End-to-End (Tier 1 -> Tier 4)
node e2e_tests/run_all_tests.js

# 4. Build thử gói Static Demo (dist-demo/)
npm run build:demo
```
