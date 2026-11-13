const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const axios = require('axios');

const { ROOT_DIR, setupServerEnv } = require('./helpers/test_env');
const { buildStaticDemo } = require('../scripts/build-static-demo');
const {
    verifyCloudflareSetup,
    ensurePagesProject,
    parseTryCloudflareUrl,
    buildConnectUrls
} = require('../scripts/cf-tunnel');

function launchHeadlessBrowser() {
    const { chromium } = require('playwright');
    const edgeCandidates = [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    try {
        const coreDir = 'C:\\Program Files (x86)\\Microsoft\\EdgeCore';
        if (fs.existsSync(coreDir)) {
            for (const d of fs.readdirSync(coreDir)) {
                edgeCandidates.unshift(path.join(coreDir, d, 'msedge.exe'));
            }
        }
    } catch {}
    const executablePath = edgeCandidates.find(p => fs.existsSync(p));
    return chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true
    });
}

describe('Cloudflare Integration, CORS/Bearer Auth & Static Demo Dual-Mode', () => {
    let env;
    let mockProxyServer;
    let mockTargetServer;
    let staticSiteServer;
    let staticBaseUrl;
    let staticDistDir;
    let proxyPort;
    let targetPort;
    const targetHits = [];
    let ipCounter = 1;
    const originalAxiosGet = axios.get;
    const originalAxiosPost = axios.post;
    const originalAxiosRequest = axios.request;

    before(async () => {
        staticDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-static-demo-'));
        buildStaticDemo({ rootDir: ROOT_DIR, outDir: staticDistDir });

        // Serve dist-demo under both / and /traffic_server/ (simulates Cloudflare Pages & GitHub Pages subpath)
        staticSiteServer = http.createServer((req, res) => {
            const urlPath = (req.url || '/').split('?')[0];
            let rel = urlPath.replace(/^\/traffic_server/, '') || '/';
            if (rel === '/' || rel === '/boost' || rel === '/boost/') rel = '/index.html';
            const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
            const filePath = path.join(staticDistDir, safeRel);
            if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const ctype = ext === '.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
            res.writeHead(200, { 'Content-Type': ctype });
            fs.createReadStream(filePath).pipe(res);
        });
        await new Promise(resolve => staticSiteServer.listen(0, '127.0.0.1', resolve));
        staticBaseUrl = `http://127.0.0.1:${staticSiteServer.address().port}`;

        mockTargetServer = http.createServer((req, res) => {
            targetHits.push({ url: req.url });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>Remote OK<a href="/sub">Sub</a></body></html>');
        });
        await new Promise(resolve => mockTargetServer.listen(0, '127.0.0.1', resolve));
        targetPort = mockTargetServer.address().port;

        mockProxyServer = http.createServer((req, res) => {
            try {
                const parsed = new URL(req.url);
                const upstream = http.request({
                    hostname: parsed.hostname,
                    port: parsed.port || 80,
                    path: parsed.pathname + parsed.search,
                    method: req.method,
                    headers: req.headers
                }, (upRes) => {
                    res.writeHead(upRes.statusCode, upRes.headers);
                    upRes.pipe(res);
                });
                upstream.on('error', (err) => { res.writeHead(502); res.end(err.message); });
                req.pipe(upstream);
            } catch (err) {
                res.writeHead(400);
                res.end(err.message);
            }
        });
        await new Promise(resolve => mockProxyServer.listen(0, '127.0.0.1', resolve));
        proxyPort = mockProxyServer.address().port;

        axios.get = function (url, ...rest) {
            if (typeof url === 'string' && url.startsWith('https://api.kiotproxy.com')) {
                if (url.includes('/proxies/new') || url.includes('/proxies/current')) {
                    const ip = `203.0.113.${ipCounter++}`;
                    return Promise.resolve({
                        data: {
                            success: true,
                            code: 200,
                            data: { realIpAddress: ip, http: `127.0.0.1:${proxyPort}`, location: 'Test', ttl: 120, ttc: 0 }
                        }
                    });
                }
                return Promise.resolve({ data: { success: true, code: 200 } });
            }
            return originalAxiosGet.call(this, url, ...rest);
        };

        axios.post = function (url, ...rest) {
            if (typeof url === 'string' && url.startsWith('https://api.telegram.org')) {
                return Promise.resolve({ data: { ok: true, result: {} } });
            }
            return originalAxiosPost.call(this, url, ...rest);
        };

        env = await setupServerEnv();
    });

    after(async () => {
        axios.get = originalAxiosGet;
        axios.post = originalAxiosPost;
        axios.request = originalAxiosRequest;
        if (env) await env.teardown();
        if (staticSiteServer) {
            staticSiteServer.closeAllConnections?.();
            await new Promise(r => staticSiteServer.close(r));
        }
        if (mockProxyServer) {
            mockProxyServer.closeAllConnections?.();
            await new Promise(r => mockProxyServer.close(r));
        }
        if (mockTargetServer) {
            mockTargetServer.closeAllConnections?.();
            await new Promise(r => mockTargetServer.close(r));
        }
        if (staticDistDir) {
            fs.rmSync(staticDistDir, { recursive: true, force: true });
        }
    });

    it('CORS origin allowlist validates Cloudflare Pages, GitHub Pages, TryCloudflare, localhost and rejects untrusted origins', () => {
        const { isAllowedCorsOrigin } = env.serverModule;
        assert.equal(isAllowedCorsOrigin('https://traffic-server-demo.pages.dev'), true);
        assert.equal(isAllowedCorsOrigin('https://dtc245200452-hub.github.io'), true);
        assert.equal(isAllowedCorsOrigin('https://fast-tunnel-123.trycloudflare.com'), true);
        assert.equal(isAllowedCorsOrigin('http://localhost:3005'), true);
        assert.equal(isAllowedCorsOrigin('http://127.0.0.1:8080'), true);
        assert.equal(isAllowedCorsOrigin('https://evil-attacker.example.com'), false);
        assert.equal(isAllowedCorsOrigin('https://evil.github.io'), false);
        assert.equal(isAllowedCorsOrigin('not-a-url'), false);
    });

    it('Express CORS headers & X-Auth-Mode bearer login work cleanly without leaking cookies or allowing Apikey bypass', async () => {
        const preflight = await fetch(`${env.baseUrl}/api/public-config`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://traffic-server-demo.pages.dev' }
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://traffic-server-demo.pages.dev');
        assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

        // Blocked origin does not get Allow-Origin
        const badPreflight = await fetch(`${env.baseUrl}/api/public-config`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://untrusted.example.com' }
        });
        assert.equal(badPreflight.headers.get('access-control-allow-origin'), null);

        // Standard cookie login must NOT include bearer token in JSON body
        const adminPath = path.join(ROOT_DIR, 'admin.json');
        const origAdminRaw = fs.readFileSync(adminPath);
        const tmpSalt = crypto.randomBytes(8).toString('hex');
        const tmpPass = 'CorsBearerPass_123';
        const tmpHash = crypto.createHmac('sha256', tmpSalt).update(tmpPass).digest('hex');
        const origObj = JSON.parse(origAdminRaw.toString('utf-8'));

        let bearerToken;
        try {
            fs.writeFileSync(adminPath, JSON.stringify({ username: origObj.username, salt: tmpSalt, passwordHash: tmpHash }, null, 4));

            const cookieLogin = await fetch(`${env.baseUrl}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: origObj.username, password: tmpPass })
            }).then(r => r.json());
            assert.equal(cookieLogin.success, true);
            assert.equal(cookieLogin.token, undefined);

            const bearerLogin = await fetch(`${env.baseUrl}/api/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Auth-Mode': 'bearer',
                    Origin: 'https://traffic-server-demo.pages.dev'
                },
                body: JSON.stringify({ username: origObj.username, password: tmpPass })
            });
            assert.equal(bearerLogin.status, 200);
            assert.equal(bearerLogin.headers.get('access-control-allow-origin'), 'https://traffic-server-demo.pages.dev');
            const bearerBody = await bearerLogin.json();
            assert.equal(bearerBody.success, true);
            assert.equal(bearerBody.role, 'admin');
            assert.ok(typeof bearerBody.token === 'string' && bearerBody.token.length > 10);
            bearerToken = bearerBody.token;
        } finally {
            fs.writeFileSync(adminPath, origAdminRaw);
        }

        // Bearer token grants admin access without cookie; Apikey header must NOT grant admin session access
        const adminOrders = await fetch(`${env.baseUrl}/api/admin/orders`, {
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                Origin: 'https://dtc245200452-hub.github.io'
            }
        });
        assert.equal(adminOrders.status, 200);
        assert.equal(adminOrders.headers.get('access-control-allow-origin'), 'https://dtc245200452-hub.github.io');

        const apikeyDenied = await fetch(`${env.baseUrl}/api/admin/orders`, {
            headers: { Authorization: `Apikey ${bearerToken}` }
        });
        assert.equal(apikeyDenied.status, 401);
    });

    it('Static build script outputs relative asset paths, static mode flag, and .nojekyll without broken /socket.io tag', () => {
        const idx = fs.readFileSync(path.join(staticDistDir, 'index.html'), 'utf-8');
        const boostHtml = fs.readFileSync(path.join(staticDistDir, 'boost.html'), 'utf-8');
        assert.equal(idx, boostHtml);
        assert.equal(fs.existsSync(path.join(staticDistDir, '404.html')), true);
        assert.equal(fs.existsSync(path.join(staticDistDir, '.nojekyll')), true);
        assert.equal(fs.existsSync(path.join(staticDistDir, 'js', 'boost.js')), true);
        assert.equal(fs.existsSync(path.join(staticDistDir, 'js', 'timeDistribution.js')), true);
        assert.ok(idx.includes('./js/timeDistribution.js'));
        assert.ok(idx.includes('./js/boost.js'));
        assert.ok(idx.includes('window.__STATIC_DEMO_MODE__ = true'));
        assert.equal(idx.includes('src="/socket.io/socket.io.js"'), false);
    });

    it('Cloudflare API v4 verifier & Quick Tunnel helpers parse URLs and validate responses cleanly', async () => {
        const parsedUrl = parseTryCloudflareUrl('INF +-------------------------------------------+\nINF | https://alpha-beta-99.trycloudflare.com |\n');
        assert.equal(parsedUrl, 'https://alpha-beta-99.trycloudflare.com');
        assert.equal(parseTryCloudflareUrl('no url here'), null);

        const urls = buildConnectUrls({
            tunnelUrl: 'https://alpha-beta-99.trycloudflare.com/',
            pagesUrl: 'https://dtc245200452-hub.github.io/traffic_server/'
        });
        assert.equal(urls.directBoostUrl, 'https://alpha-beta-99.trycloudflare.com/boost');
        assert.equal(
            urls.staticLinkedUrl,
            'https://dtc245200452-hub.github.io/traffic_server/?backend=https%3A%2F%2Falpha-beta-99.trycloudflare.com'
        );

        await assert.rejects(() => verifyCloudflareSetup({ token: '' }), /CLOUDFLARE_API_TOKEN/);

        try {
            axios.request = async ({ url, method, data }) => {
                if (url.endsWith('/user/tokens/verify')) {
                    return { status: 200, data: { success: true, result: { status: 'active' } } };
                }
                if (url.endsWith('/accounts')) {
                    return { status: 200, data: { success: true, result: [{ id: 'acc_123', name: 'Free Account' }] } };
                }
                if (url.endsWith('/accounts/acc_123/pages/projects')) {
                    if (method === 'POST') {
                        return { status: 200, data: { success: true, result: { name: data.name, subdomain: `${data.name}.pages.dev` } } };
                    }
                    return { status: 200, data: { success: true, result: [{ name: 'traffic-server-demo', subdomain: 'traffic-server-demo.pages.dev' }] } };
                }
                if (url.endsWith('/accounts/acc_123/pages/projects/new-demo-proj') && method === 'GET') {
                    return { status: 404, data: { success: false, errors: [{ code: 8000007, message: 'Project not found' }] } };
                }
                if (url.includes('/cfd_tunnel')) {
                    return { status: 200, data: { success: true, result: [{ id: 'tun_1', name: 'demo-tun', status: 'healthy' }] } };
                }
                return { status: 404, data: { success: false, errors: [{ message: 'Not found' }] } };
            };

            const report = await verifyCloudflareSetup({ token: 'cf_test_token_123' });
            assert.equal(report.tokenStatus, 'active');
            assert.equal(report.accountId, 'acc_123');
            assert.equal(report.warning, null);
            assert.equal(report.pagesProjects[0].url, 'https://traffic-server-demo.pages.dev');
            assert.equal(report.tunnels[0].name, 'demo-tun');

            const ensured = await ensurePagesProject({ token: 'cf_test_token_123', projectName: 'new-demo-proj' });
            assert.equal(ensured.created, true);
            assert.equal(ensured.project.subdomain, 'new-demo-proj.pages.dev');

            // Verify helpful warning when scoped token cannot list /accounts
            axios.request = async ({ url }) => {
                if (url.endsWith('/user/tokens/verify')) return { status: 200, data: { success: true, result: { status: 'active' } } };
                if (url.endsWith('/accounts')) return { status: 200, data: { success: true, result: [] } };
                return { status: 403, data: { success: false, errors: [{ message: 'Unauthorized' }] } };
            };
            const prevAcc = process.env.CLOUDFLARE_ACCOUNT_ID;
            delete process.env.CLOUDFLARE_ACCOUNT_ID;
            try {
                const scopedReport = await verifyCloudflareSetup({ token: 'cf_scoped_token' });
                assert.equal(scopedReport.accountId, '');
                assert.match(scopedReport.warning || '', /Account Settings/);
            } finally {
                if (prevAcc !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = prevAcc;
            }
        } finally {
            axios.request = originalAxiosRequest;
        }
    });

    it('Browser E2E on static subpath (/traffic_server/): Static Demo simulation works offline AND ?backend= connects cross-origin to live server', async (t) => {
        let browser;
        try {
            browser = await launchHeadlessBrowser();
        } catch (err) {
            t.skip(`No headless browser binary available: ${err.message}`);
            return;
        }

        const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
        const adminPath = path.join(ROOT_DIR, 'admin.json');
        const origAdminRaw = fs.readFileSync(adminPath);

        try {
            const context = await browser.newContext();
            const page = await context.newPage();
            const consoleErrors = [];
            const pageErrors = [];
            const badResponses = [];

            await page.route('https://img.vietqr.io/**', (route) => {
                route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
            });
            page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
            page.on('pageerror', (err) => pageErrors.push(err.message));
            page.on('response', (res) => { if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`); });

            // 1. Offline Static Demo Mode on subpath /traffic_server/ (ZERO 404s, ZERO console errors)
            await page.goto(`${staticBaseUrl}/traffic_server/`, { waitUntil: 'networkidle' });
            assert.match(await page.textContent('#runtime-mode-pill'), /Static Demo/);

            await page.fill('#f-name', 'Offline Pages Sim');
            await page.fill('#f-url', 'https://example.org/demo');
            await page.fill('#f-proxy', 'K_STATIC_SIM_KEY_01');
            await page.fill('#f-clicks', '3');
            await page.fill('#f-hours', '0.5');
            await page.waitForFunction(() => document.getElementById('c-total')?.textContent?.includes('2.120'));
            await page.click('#submit-order-btn');

            await page.waitForSelector('#active-order-panel:not(.hidden)');
            const simOrderId = (await page.textContent('#ao-id')).trim();
            assert.ok(simOrderId.startsWith('ORD-'));
            assert.match(await page.textContent('#ao-status-pill'), /Chờ thanh toán/);

            // Log in via Demo Admin hint & run simulation to completion
            await page.click('#open-login-btn');
            assert.equal(await page.isVisible('#demo-login-hint'), true);
            await page.fill('#login-user', 'admin');
            await page.fill('#login-pass', 'admin123456');
            await page.click('#submit-login-btn');

            await page.waitForSelector('#inline-admin-confirm-btn:not(.hidden)');
            await page.click('#inline-admin-confirm-btn');
            await page.waitForFunction(
                () => document.getElementById('ao-status-pill')?.textContent?.includes('Đã hoàn thành'),
                null,
                { timeout: 10000 }
            );
            assert.equal((await page.textContent('#st-success')).trim(), '3');
            assert.match(await page.textContent('#ao-worker-log'), /\[DEMO SIM\]/);

            // 2. Cross-Origin Static Frontend -> Live Server Backend (?backend=env.baseUrl)
            await page.goto(`${staticBaseUrl}/traffic_server/?backend=${encodeURIComponent(env.baseUrl)}`, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => document.getElementById('runtime-mode-pill')?.textContent?.includes('Remote Tunnel'));
            await page.waitForFunction(() => document.getElementById('socket-pill')?.textContent?.includes('Đã kết nối'));

            await page.fill('#f-name', 'Cross-Origin Tunnel Real');
            await page.fill('#f-url', `http://127.0.0.1:${targetPort}/cross-origin-hit`);
            await page.fill('#f-proxy', 'K_REMOTE_TUNNEL_KEY_01');
            await page.fill('#f-clicks', '1');
            await page.fill('#f-hours', '0.001');
            await page.click('#submit-order-btn');

            await page.waitForSelector('#active-order-panel:not(.hidden)');
            const realOrderId = (await page.textContent('#ao-id')).trim();
            env.trackOrder(realOrderId);
            env.trackProxyKey('K_REMOTE_TUNNEL_KEY_01');

            const tmpSalt = crypto.randomBytes(8).toString('hex');
            const tmpPass = 'RemoteTunnelPass_99';
            const tmpHash = crypto.createHmac('sha256', tmpSalt).update(tmpPass).digest('hex');
            const origObj = JSON.parse(origAdminRaw.toString('utf-8'));
            fs.writeFileSync(adminPath, JSON.stringify({ username: origObj.username, salt: tmpSalt, passwordHash: tmpHash }, null, 4));
            try {
                await page.click('#open-login-btn');
                assert.equal(await page.isVisible('#demo-login-hint'), false);
                await page.fill('#login-user', origObj.username);
                await page.fill('#login-pass', tmpPass);
                await page.click('#submit-login-btn');
                await page.waitForFunction(() => document.getElementById('auth-pill')?.textContent?.includes('Admin:'));
            } finally {
                fs.writeFileSync(adminPath, origAdminRaw);
            }

            await page.waitForSelector('#inline-admin-confirm-btn:not(.hidden)');
            await page.click('#inline-admin-confirm-btn');
            await page.waitForFunction(
                () => document.getElementById('ao-status-pill')?.textContent?.includes('Đã hoàn thành'),
                null,
                { timeout: 15000 }
            );
            const campId = (await page.textContent('#ao-camp-id')).trim();
            env.trackCampaign(campId);
            assert.ok(targetHits.some(h => h.url === '/cross-origin-hit'), 'Cross-origin Remote Tunnel mode must trigger real backend HTTP hit');

            // Verify webhook URL in Admin tab reflects the remote backend URL rather than static origin
            await page.click('[data-tab="admin"]');
            await page.waitForSelector('#admin-workspace:not(.hidden)');
            assert.equal((await page.textContent('#cfg-webhook-url')).trim(), `${env.baseUrl}/api/payment/webhook`);

            assert.deepEqual(badResponses, [], `Unexpected HTTP >= 400 responses: ${badResponses.join('; ')}`);
            assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
            assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`);
        } finally {
            fs.writeFileSync(adminPath, origAdminRaw);
            await browser.close();
        }
    });
});
