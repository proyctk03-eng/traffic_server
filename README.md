# Traffic Server & Web Demo (`/boost`)

Ứng dụng Node.js (Express + Socket.IO) điều phối chiến dịch traffic HTTP theo phân bố thời gian chuẩn Việt Nam (`UTC+7`), kèm giao diện Dark Mode 1 màn hình tại `/boost` cho phép mở vào dùng ngay không cần đăng nhập.

Hỗ trợ đầy đủ **3 chế độ chạy**:
1. **Live Backend (Same-Origin):** Chạy trực tiếp trên `node server.js` (`http://localhost:3005/boost`) với toàn bộ tính năng thật (hẹn giờ chạy theo ngày/khung giờ VN, KiotProxy, Socket.IO real-time, theo dõi tại `/track.html`).
2. **Static Demo Fallback (24/7 trên Cloudflare Pages / GitHub Pages):** Tự động chạy giao diện `/boost` độc lập trên trình duyệt (chia lịch Smart/Even/Custom, hẹn ngày & khung giờ VN, mô phỏng tiến độ bằng `localStorage`) khi không có server backend online.
3. **Remote Tunnel (`Cloudflare Quick Tunnel` / `Cloudflare Named Tunnel`):** Nối trực tiếp giao diện static trên Cloudflare Pages / GitHub Pages với server Node.js thật qua URL `https://*.trycloudflare.com` hoặc domain riêng (CORS + Bearer Token + Socket.IO).

## Tính năng chính hiện tại (`/boost` & `/track.html`)

- **Mở dùng ngay (Open-Access mặc định):** Truy cập `/` hoặc `/boost` là dùng được ngay các chức năng, không bắt buộc đăng nhập/tạo tài khoản (có thể bật lại khóa Admin bằng `REQUIRE_AUTH=true`).
- **Giao diện Tóm tắt → Chi tiết (Accordion):**
  - Chỉ mở sẵn **Khối 1 (Mục tiêu & Proxy IP)** để thao tác nhanh.
  - **Khối 2 (Số lượt, Ngày & Khung giờ VN)**, **Khối 3 (Hành vi, Thiết bị & Tùy chọn)** và **Bảng xem trước Phân bổ (`Smart` / `Even` / `Custom`)** mặc định thu gọn kèm thanh tóm tắt cập nhật theo thời gian thực, bấm vào để mở chi tiết.
- **Lên lịch theo Ngày & Khung giờ chuẩn Việt Nam (`UTC+7 / Asia/Ho_Chi_Minh`):**
  - Chọn ngày chạy và giờ bắt đầu → giờ kết thúc (ví dụ preset nhanh `06:00 – 07:00`, `08:00 – 12:00`...).
  - Hỗ trợ **vắt qua đêm sang ngày hôm sau** (`+1 ngày`, ví dụ `23:00 → 01:00`).
  - Tự cảnh báo nếu khung giờ đã trôi qua theo giờ VN và có nút **Dời sang ngày mai**; hỗ trợ trạng thái chờ (`Chờ tới giờ hẹn`) kèm đếm ngược live trước khi chạy và tự động đẩy bù lượt còn lại (burst) nếu quá giờ kết thúc.
- **Tạm ẩn phần Thanh toán & Phiếu Cấu hình đã chọn:**
  - Phần tính tiền/QR thanh toán được ẩn trên UI `/boost`; khi bấm **Xác nhận & Lên lịch Chiến dịch**, hệ thống hiển thị ngay **Phiếu "Cấu hình bạn đã chọn"** (URL đích, Proxy đã che, lịch chạy VN, hồ sơ hành vi/toggle, link chia sẻ `/track.html?orderId=...`) và tự kích hoạt/hẹn giờ chạy luôn trong Open-Access & Static Demo.
  - Ở tầng API backend, chế độ kiểm soát thanh toán (`pending_payment = 0 click` trước khi duyệt) và phân quyền Admin vẫn được bảo toàn khi bật `REQUIRE_AUTH=true`.

## Cơ chế gửi click (HTTP Request siêu nhẹ)

Hệ thống chạy ở chế độ **`request` (Axios + KiotProxy)** — **không mở trình duyệt thật** (không chạy Puppeteer/Chrome):
1. Xoay/lấy IP từ **KiotProxy** và gửi request qua HTTP Proxy Agent (`HttpProxyAgent` / `HttpsProxyAgent`), hỗ trợ **chống trùng IP (`dedupIp`)** theo từng key.
2. Giả lập bộ header HTTP giống trình duyệt thật: ngẫu nhiên `User-Agent` theo nhóm thiết bị (`mobile`, `desktop`, hoặc `mixed`), `Accept-Language`, `sec-fetch-*` và `Referer` (`Google`, `Facebook`, `Bing` hoặc truy cập trực tiếp).
3. Tải HTML trang đích (`status < 500`, có lớp chặn SSRF redirect), chờ mô phỏng thời gian đọc trang (**Dwell**) và tùy chọn quét click thêm 1 link nội bộ cùng tên miền (`randomLinks`).

> **Lưu ý kỹ thuật:** Vì gửi HTTP request tải HTML thuần (không thực thi JavaScript phía trình duyệt), chi phí CPU/RAM rất nhẹ và phù hợp ghi nhận truy cập ở phía server / redirect / link tracker; các công cụ đo đếm dựa hoàn toàn vào JS trình duyệt (như GA4, Facebook Pixel hoặc Cloudflare JS Challenge) sẽ không được kích hoạt. Bản **Static Demo** chỉ mô phỏng trên trình duyệt cho tới khi bạn kết nối URL **Cloudflare Tunnel** trỏ về `server.js` thật.

## Yêu cầu môi trường

- **Node.js** (khuyến nghị LTS v18+ / v20+) + **npm** (hoặc **Docker** + **Docker Compose v2**)
- (Tùy chọn cho test giao diện trình duyệt) **Microsoft Edge / Playwright** (`playwright` nằm trong dependencies)
- (Tùy chọn để public localhost không cần VPS/tên miền) **`cloudflared`** (`winget install --id Cloudflare.cloudflared -e`)

## Cài đặt & Chạy cục bộ (Node.js)

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

- **Web Demo 1 màn hình (vào dùng ngay, không cần tài khoản):** `http://localhost:3005/boost`
- **Dashboard quản lý chiến dịch (Open-Access mặc định):** `http://localhost:3005/`
- **Trang đặt đơn riêng / theo dõi đơn công khai (kèm lịch VN & hành vi):** `http://localhost:3005/order.html`, `http://localhost:3005/track.html`
- **Healthcheck API:** `http://localhost:3005/api/health`
- **Đăng nhập Admin (chỉ kích hoạt khi bật `REQUIRE_AUTH=true`):** `http://localhost:3005/login.html`
  - Mặc định (`REQUIRE_AUTH` chưa bật / `false`), `/` và tab Quản trị trên `/boost` mở thẳng không qua màn hình đăng nhập.
  - Khi public server ra internet và muốn khóa quản trị, đặt `REQUIRE_AUTH=true` trong `.env`. Nếu chưa có `admin.json`, server tự khởi tạo `admin` / `admin123456` — hãy đổi mật khẩu ngay khi triển khai thực tế.

## Chạy bằng Docker & Docker Compose

`Dockerfile` chạy dưới user non-root `node`, tích hợp sẵn `HEALTHCHECK` kiểm tra `http://127.0.0.1:3005/api/health`, và `.dockerignore` loại trừ toàn bộ `.env`, `admin.json`, `sessions.json`, `orders/`, `campaigns/`, `dist-demo/` khỏi image.

```bash
# 1. Tạo thư mục dữ liệu (tránh lỗi quyền root trên Linux) và file .env
mkdir -p orders campaigns
cp .env.example .env

# 2. Chỉ chạy traffic-server (mount ./orders, ./campaigns và nạp ./.env)
docker compose up -d --build

# 3. Kiểm tra trạng thái healthy & log
docker compose ps
docker compose logs -f traffic-server
```

### Chạy kèm Cloudflare Named Tunnel bằng Docker Compose

1. Tạo Tunnel trong **Cloudflare Zero Trust → Networks → Tunnels** (loại *Cloudflared*), copy **Token** vào `CLOUDFLARE_TUNNEL_TOKEN` trong `.env`.
2. Trong tab **Public Hostname** của Tunnel, trỏ domain (ví dụ `api.yourdomain.com`) tới service `http://traffic-server:3005`.
3. Khởi động cả `traffic-server` và `cloudflared` (profile `tunnel`):

```bash
docker compose --profile tunnel up -d --build

# Dừng toàn bộ
docker compose --profile tunnel down
```

## Giữ Web Demo chạy 24/7 với GitHub + Cloudflare

### 1. Host giao diện Web Demo 24/7 (Cloudflare Pages / GitHub Pages)

Repository đã tích hợp sẵn script build tĩnh (`npm run build:demo` tạo thư mục `dist-demo/`) và GitHub Actions workflows trong `.github/workflows/`:

- **GitHub Pages (`.github/workflows/pages.yml`):**
  1. Trên GitHub vào **Settings → Pages → Build and deployment → Source**, chọn **GitHub Actions**.
  2. Mỗi khi push lên `main`, web demo tự cập nhật tại `https://proyctk03-eng.github.io/traffic_server/boost.html`.
- **Cloudflare Pages miễn phí `*.pages.dev`:**
  - *Cách A (không cần tạo API Token):* Vào Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**, chọn repo GitHub này, đặt:
    - **Build command:** `npm run build:demo`
    - **Build output directory:** `dist-demo`
  - *Cách B (tự động deploy qua GitHub Actions `.github/workflows/cloudflare-pages.yml`):* Thêm 2 GitHub Secrets `CLOUDFLARE_API_TOKEN` (Scoped API Token có quyền `Cloudflare Pages: Edit` + `Account Settings: Read`) và `CLOUDFLARE_ACCOUNT_ID` vào **Settings → Secrets and variables → Actions** (workflow tự tạo Pages project `traffic-server-demo` và deploy lên `https://traffic-server-demo.pages.dev/boost`).

### 2. Nối Web Demo với Backend thật qua Cloudflare Tunnel

#### 2.1 Cloudflare Quick Tunnel (Miễn phí, URL ngẫu nhiên `*.trycloudflare.com`)

```bash
# Terminal 1: Chạy server backend
npm start

# Terminal 2: Mở Cloudflare Quick Tunnel (không cần domain)
npm run tunnel:quick
```

Lệnh sẽ xuất ra 2 đường dẫn HTTPS công khai:
- Link chạy trực tiếp: `https://<random>.trycloudflare.com/boost`
- Link gắn Backend vào trang Pages: `https://.../traffic_server/?backend=https://<random>.trycloudflare.com` (hoặc dán URL Tunnel vào thanh **Kết nối Tunnel** ngay trên trang demo).

#### 2.2 Cloudflare Named Tunnel (URL cố định trên domain riêng)

Phù hợp khi chạy 24/7 để link `?backend=https://api.yourdomain.com` không bị đổi sau mỗi lần restart:

1. Tạo Tunnel trong **Cloudflare Zero Trust → Networks → Tunnels**, trỏ Public Hostname (ví dụ `https://api.yourdomain.com`) về `http://127.0.0.1:3005` (nếu chạy `cloudflared` trực tiếp trên máy host) hoặc `http://traffic-server:3005` (nếu chạy qua Docker Compose).
2. Điền vào `.env`:
   ```dotenv
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
   CLOUDFLARE_TUNNEL_URL=https://api.yourdomain.com
   ```
   *(Nếu chạy frontend trên domain riêng khác `*.pages.dev` / GitHub Pages mặc định, thêm domain đó vào `CORS_ORIGINS` trong `.env`).*
3. Khởi chạy Named Tunnel trên máy host:
   ```bash
   node scripts/cf-tunnel.js named
   ```
   Script chạy `cloudflared tunnel --no-autoupdate run --token ...` và (khi có `CLOUDFLARE_TUNNEL_URL`) in sẵn cả link `/boost` trực tiếp lẫn link `?backend=...` cho Pages.

### 3. Kiểm tra kết nối Cloudflare API v4 (Tùy chọn)

Sao chép `.env.example` thành `.env`, điền `CLOUDFLARE_API_TOKEN` (khuyến nghị quyền `Account Settings: Read`, `Cloudflare Pages: Edit`, `Cloudflare Tunnel: Read`) và/hoặc `CLOUDFLARE_ACCOUNT_ID`, rồi chạy:

```bash
npm run cf:verify
```

Nếu token không có quyền `Account Settings: Read` hoặc chưa cấu hình `CLOUDFLARE_ACCOUNT_ID`, lệnh sẽ in rõ hướng dẫn bổ sung quyền hoặc điền `CLOUDFLARE_ACCOUNT_ID`.

## Biến môi trường & Cấu hình cục bộ (`.gitignore` loại trừ khỏi Git)

Các file nhạy cảm hoặc dữ liệu runtime không được đẩy lên GitHub:

- `.env`: Biến môi trường cục bộ (xem mẫu đầy đủ tại `.env.example`):
  - `PORT`: Cổng server (mặc định `3005`; với Docker Compose, host port lấy từ `PORT`, trong container luôn chạy `3005`).
  - `REQUIRE_AUTH`: Mặc định không bật (`false` — chế độ Open-Access, vào thẳng dashboard và `/boost` không cần đăng nhập). Đặt `REQUIRE_AUTH=true` để bắt buộc đăng nhập Admin tại `/login.html` và khóa thao tác quản trị trên API.
  - `ALLOW_PRIVATE_TARGET_URLS`: Mặc định `false` để chặn SSRF tới IP nội bộ / loopback (`127.0.0.1`, `10.x`, `192.168.x`, `localhost`). Chỉ đặt `true` khi test với target server nội bộ.
  - `CORS_ORIGINS`: Danh sách origin cho phép gọi API cross-origin (phân tách bằng dấu phẩy), bổ sung ngoài `*.pages.dev`, `*.trycloudflare.com` và GitHub Pages mặc định.
  - `TELEGRAM_BOT_TOKEN`: Token bot Telegram (dùng khi `telegram_config.json` chưa có).
  - `STATIC_DEMO_URL`: URL trang static demo dùng để ghép sẵn tham số `?backend=...`.
  - `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_TUNNEL_URL`: Token và URL công khai của Named Tunnel.
  - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`: Cấu hình Cloudflare API v4 & Pages.
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
