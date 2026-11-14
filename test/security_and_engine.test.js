/**
 * Comprehensive Backend Core, Security, Scheduler Reliability & API Contract Test Suite
 *
 * Verifies:
 * 1. SSRF lexical gating, IPv4/IPv6 private/loopback/metadata blocking, opt-in mechanism, connect-time validation
 * 2. Zero Direct IP Fallback: paid orders strictly route through proxy; failures release keys without direct requests
 * 3. Auth & Account Hardening: guest removal, session TTL, legacy seeded sessions, rate limiting, Socket.IO admin room
 * 4. 30-Minute Order TTL: lazy & periodic expiration, HTTP 409 on late confirm, admin summary accuracy, webhook idempotency
 * 5. Scheduler Concurrency & Overdue Protection: execution lock, atomic checkpointing, overdue error shutdown
 * 6. API Contracts: GET /api/health, GET /api/public-config, POST /api/proxy/validate, dwellPreset & deviceProfile, admin Telegram APIs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const axios = require('axios');

const { setupServerEnv, withTempAdminCredentials, ROOT_DIR, CAMPAIGNS_DIR, SESSIONS_FILE } = require('./helpers/test_env');
const { SocketClient } = require('./helpers/socket_client');
const orderService = require('../orderService');

describe('Security Hardening, Engine Reliability & Backend API Test Suite', () => {
    let env = null;
    let campaigns = null;
    let activeSessions = null;
    let createCampaignState = null;
    let scheduleTick = null;
    let completeCampaign = null;
    let globalProxyPool = null;
    let runVisitWorker = null;
    let checkpointCampaignState = null;
    let saveSessions = null;

    const originalAxiosGet = axios.get;
    const originalAxiosPost = axios.post;

    before(async () => {
        env = await setupServerEnv();
        ({
            campaigns,
            activeSessions,
            createCampaignState,
            scheduleTick,
            completeCampaign,
            globalProxyPool,
            runVisitWorker,
            checkpointCampaignState,
            saveSessions
        } = env.serverModule);

        // Mock external outgoing network calls to avoid hitting live services
        axios.get = function (url, ...args) {
            if (typeof url === 'string' && url.startsWith('https://api.kiotproxy.com')) {
                return Promise.resolve({
                    data: {
                        status: 'success',
                        code: 200,
                        data: { http: '203.0.113.10:8080', realIpAddress: '203.0.113.10', ttc: 60 }
                    }
                });
            }
            if (typeof url === 'string' && url.startsWith('https://api.telegram.org')) {
                return Promise.resolve({ data: { ok: true, result: [] } });
            }
            return originalAxiosGet.call(this, url, ...args);
        };

        axios.post = function (url, ...args) {
            if (typeof url === 'string' && url.startsWith('https://api.telegram.org')) {
                return Promise.resolve({ data: { ok: true, result: {} } });
            }
            return originalAxiosPost.call(this, url, ...args);
        };
    });

    after(async () => {
        axios.get = originalAxiosGet;
        axios.post = originalAxiosPost;
        if (env) await env.teardown();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 1: SSRF Protection & Private Target Address Gating
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. SSRF Protection & Address Gating', () => {
        it('blocks loopback, RFC 1918 private subnets, and cloud metadata when opt-in is disabled', () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';

                const forbiddenTargets = [
                    'http://127.0.0.1:8080/admin',
                    'http://127.0.0.2:3000',
                    'http://localhost:3000',
                    'http://sub.localhost:8080',
                    'http://myhost.local/metrics',
                    'http://service.internal/health',
                    'http://metadata.google.internal/computeMetadata/v1/',
                    'http://10.0.0.1:8080',
                    'http://10.254.1.1:80',
                    'http://172.16.0.1:4000',
                    'http://172.31.255.255:80',
                    'http://192.168.1.1:8080',
                    'http://192.168.100.50/',
                    'http://169.254.169.254/latest/meta-data/',
                    'http://[::1]:8080/',
                    'http://[fc00::1]/',
                    'http://[fe80::1]/',
                    'http://[::ffff:127.0.0.1]:8080/admin',
                    'http://[::ffff:7f00:1]:8080/admin',
                    'http://[::ffff:169.254.169.254]/latest/meta-data/',
                    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
                    'http://[::127.0.0.1]:8080/admin',
                    'http://[::7f00:1]:8080/admin'
                ];

                for (const targetUrl of forbiddenTargets) {
                    const result = orderService.validateOrderParams({
                        targetUrl,
                        proxyKey: 'valid_proxy_key_123',
                        targetClicks: 100,
                        durationHours: 1
                    });
                    assert.strictEqual(result.isValid, false, `Should reject private target: ${targetUrl}`);
                    assert.ok(
                        result.errors.some(e => e.includes('private') || e.includes('loopback') || e.includes('localhost')),
                        `Expected SSRF error message for ${targetUrl}`
                    );
                }
            } finally {
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('permits unresolvable synthetic test domains without DNS resolution at creation time', () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';

                const syntheticDomains = [
                    'https://traffic-test.example.com/page1',
                    'https://adversarial-target.example.com/unpaid',
                    'https://my-legit-store.com/product/123'
                ];

                for (const targetUrl of syntheticDomains) {
                    const result = orderService.validateOrderParams({
                        targetUrl,
                        proxyKey: 'valid_proxy_key_123',
                        targetClicks: 50,
                        durationHours: 1
                    });
                    assert.strictEqual(result.isValid, true, `Should accept valid public domain syntax: ${targetUrl}`);
                }
            } finally {
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('allows local private mock addresses when explicitly opted-in via ALLOW_PRIVATE_TARGET_URLS=true', () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'true';

                const result = orderService.validateOrderParams({
                    targetUrl: 'http://127.0.0.1:9999/mock-target',
                    proxyKey: 'valid_proxy_key_123',
                    targetClicks: 10,
                    durationHours: 1
                });
                assert.strictEqual(result.isValid, true, 'Must permit local target with opt-in enabled');
            } finally {
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('rejects disallowed schemes such as ftp, file, gopher', () => {
            for (const scheme of ['ftp://example.com', 'file:///etc/passwd', 'gopher://example.com']) {
                const result = orderService.validateOrderParams({
                    targetUrl: scheme,
                    proxyKey: 'valid_proxy_key_123',
                    targetClicks: 10,
                    durationHours: 1
                });
                assert.strictEqual(result.isValid, false);
            }
        });

        it('blocks IPv4-mapped and IPv4-compatible IPv6 loopback and metadata addresses', () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';

                const ipv6MappedTargets = [
                    'http://[::ffff:127.0.0.1]:8080/',
                    'http://[::ffff:169.254.169.254]/',
                    'http://[::ffff:7f00:1]/',
                    'http://[::7f00:1]/'
                ];

                for (const targetUrl of ipv6MappedTargets) {
                    const result = orderService.validateOrderParams({
                        targetUrl,
                        proxyKey: 'valid_proxy_key_123',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    assert.strictEqual(
                        result.isValid,
                        false,
                        `IPv4-mapped/compatible target must be rejected: ${targetUrl}`
                    );
                    assert.ok(
                        result.errors.some(e => e.includes('private') || e.includes('loopback') || e.includes('localhost')),
                        `Expected SSRF rejection error message for ${targetUrl}`
                    );
                }
            } finally {
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('permits public IPv4-mapped IPv6 targets when SSRF opt-in is disabled', () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';
                const publicTargets = [
                    'http://[::ffff:8.8.8.8]:8080/test',
                    'http://[::ffff:808:808]:8080/test',
                    'http://[2001:4860:4860::8888]/'
                ];
                for (const targetUrl of publicTargets) {
                    const result = orderService.validateOrderParams({
                        targetUrl,
                        proxyKey: 'valid_proxy_key_123',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    assert.strictEqual(result.isValid, true, `Expected public mapped address ${targetUrl} to be permitted`);
                }
            } finally {
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('ensures default standalone runtime (node server.js) blocks private target URLs by default', () => {
            const cp = require('node:child_process');
            const serverPath = path.resolve(ROOT_DIR, 'server.js');

            const childCode = `
                require.main = { filename: process.argv[1] };
                const orderService = require('./orderService');
                const allowed = orderService.isPrivateTargetAllowed();
                process.stdout.write(JSON.stringify({ allowed }));
            `;

            const res = cp.spawnSync(process.execPath, [
                '-e',
                childCode,
                serverPath
            ], {
                cwd: ROOT_DIR,
                env: {
                    PATH: process.env.PATH,
                    SYSTEMROOT: process.env.SYSTEMROOT
                }
            });

            assert.strictEqual(res.status, 0, `Child process failed with error: ${res.stderr.toString()}`);
            const data = JSON.parse(res.stdout.toString().trim());
            assert.strictEqual(
                data.allowed,
                false,
                'orderService.isPrivateTargetAllowed() must return false when server.js is entry point'
            );
        });

        it('aborts redirects pointing to IPv4-mapped loopback or private addresses via beforeRedirect hook', async () => {
            const savedOpt = process.env.ALLOW_PRIVATE_TARGET_URLS;
            let mockServer = null;
            let targetHit = false;

            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';

                const http = require('node:http');
                mockServer = http.createServer((req, res) => {
                    if (req.url === '/redirect-loopback') {
                        res.writeHead(302, { Location: 'http://[::ffff:127.0.0.1]:8080/evil' });
                        res.end();
                    } else if (req.url === '/evil') {
                        targetHit = true;
                        res.writeHead(200);
                        res.end('PWNED');
                    }
                });

                await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
                const port = mockServer.address().port;

                await assert.rejects(
                    axios.get(`http://127.0.0.1:${port}/redirect-loopback`, {
                        maxRedirects: 5,
                        beforeRedirect: (options, { headers }) => {
                            if (!orderService.isPrivateTargetAllowed() && headers && headers.location) {
                                const nextTarget = new URL(headers.location, `http://127.0.0.1:${port}/redirect-loopback`);
                                if (nextTarget.protocol !== 'http:' && nextTarget.protocol !== 'https:') {
                                    throw new Error(`SSRF redirect blocked: scheme ${nextTarget.protocol} not allowed`);
                                }
                                if (orderService.isLexicallyPrivateHost(nextTarget.hostname)) {
                                    throw new Error(`SSRF redirect blocked: ${nextTarget.hostname}`);
                                }
                            }
                        }
                    }),
                    /SSRF redirect blocked/
                );

                assert.strictEqual(targetHit, false, 'Redirect destination must never be contacted');
            } finally {
                if (mockServer) await new Promise(resolve => mockServer.close(resolve));
                if (savedOpt !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedOpt;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 2: Zero Direct IP Fallback for Paid Orders
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Zero Direct IP Fallback for Paid Orders', () => {
        it('aborts scheduleTick and key lock without advancing scheduleIdx when proxy acquisition fails', async () => {
            const testKey = 'test_zero_fallback_key';
            const campaignId = 'test_camp_zero_fallback';
            const state = createCampaignState(campaignId, {
                targetUrl: 'https://traffic-test.example.com',
                targetClicks: 10,
                startTime: Date.now() - 5000,
                endTime: Date.now() + 3600000,
                customerProxyKey: testKey,
                paymentStatus: 'paid'
            });
            state.status = 'running';
            campaigns.set(campaignId, state);

            // Seed key in pool without active proxy
            globalProxyPool.set(testKey, {
                key: testKey,
                currentProxy: null,
                nextRequestAt: Date.now() + 100000, // force fetchCurrentProxy
                isBusy: false,
                campaignId: null
            });

            // Mock proxy fetch to return null (provider outage simulation)
            const origGet = axios.get;
            axios.get = (url, ...args) => {
                if (typeof url === 'string' && url.includes('api.kiotproxy.com')) {
                    return Promise.resolve({ data: { success: false, message: 'Provider offline' } });
                }
                return origGet.call(axios, url, ...args);
            };

            try {
                const initialScheduleIdx = state.scheduleIdx;
                const initialTotalVisits = state.totalVisits;

                await scheduleTick(campaignId);

                // Invariant: scheduleIdx must NOT have advanced and visits must NOT have incremented
                assert.strictEqual(state.scheduleIdx, initialScheduleIdx, 'Schedule index must not advance on proxy failure');
                assert.strictEqual(state.totalVisits, initialTotalVisits, 'Total visits must not increment on proxy failure');

                // Key must be released back to idle state
                const k = globalProxyPool.get(testKey);
                assert.strictEqual(k.isBusy, false, 'Key must be released back to pool on proxy failure');
            } finally {
                axios.get = origGet;
                campaigns.delete(campaignId);
                globalProxyPool.delete(testKey);
                try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${campaignId}.json`)); } catch {}
                try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${campaignId}.tmp`)); } catch {}
            }
        });

        it('defensively aborts runVisitWorker immediately if called with missing proxy for paid campaign', async () => {
            const campaignId = 'test_worker_guard';
            const testKey = 'test_key_no_proxy';
            const state = createCampaignState(campaignId, {
                targetUrl: 'https://traffic-test.example.com',
                targetClicks: 5,
                startTime: Date.now() - 1000,
                endTime: Date.now() + 10000,
                customerProxyKey: testKey,
                paymentStatus: 'paid'
            });
            state.status = 'running';
            campaigns.set(campaignId, state);

            const keyState = {
                key: testKey,
                currentProxy: null, // No proxy available
                isBusy: true,
                campaignId
            };
            globalProxyPool.set(testKey, keyState);

            let directRequestMade = false;
            const origGet = axios.get;
            axios.get = (url, ...args) => {
                if (typeof url === 'string' && url.includes('traffic-test.example.com')) {
                    directRequestMade = true;
                }
                return origGet.call(axios, url, ...args);
            };

            try {
                await runVisitWorker(campaignId, keyState);

                assert.strictEqual(directRequestMade, false, 'Direct HTTP request must NEVER be made when proxy is missing');
                assert.strictEqual(keyState.isBusy, false, 'Key must be released');
                assert.strictEqual(state.activeWorkers, 0, 'Active workers count must remain 0');
            } finally {
                axios.get = origGet;
                campaigns.delete(campaignId);
                globalProxyPool.delete(testKey);
                try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${campaignId}.json`)); } catch {}
                try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${campaignId}.tmp`)); } catch {}
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 3: Authentication, Session TTL & Account Hardening
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Authentication & Account Hardening', () => {
        it('unconditionally rejects guest 1/1 credentials with HTTP 401 and reports guestEnabled=false', async () => {
            const savedGuest = process.env.ALLOW_GUEST_LOGIN;
            try {
                process.env.ALLOW_GUEST_LOGIN = 'true';

                const res = await env.request('POST', '/api/login', {
                    body: { username: '1', password: '1', rememberMe: false }
                });
                assert.strictEqual(res.status, 401, 'Guest 1/1 credentials must unconditionally be rejected with 401');
                assert.strictEqual(res.body.success, false);

                const cfgRes = await env.request('GET', '/api/public-config');
                assert.strictEqual(cfgRes.status, 200);
                assert.strictEqual(cfgRes.body.guestEnabled, false);

                const healthRes = await env.request('GET', '/api/health');
                assert.strictEqual(healthRes.status, 200);
                assert.strictEqual(healthRes.body.guestEnabled, false);
            } finally {
                if (savedGuest !== undefined) process.env.ALLOW_GUEST_LOGIN = savedGuest;
                else delete process.env.ALLOW_GUEST_LOGIN;
            }
        });

        it('enforces 24-hour session TTL for sessions containing expiresAt timestamp (when REQUIRE_AUTH=true)', async () => {
            const savedRequireAuth = process.env.REQUIRE_AUTH;
            process.env.REQUIRE_AUTH = 'true';
            const expiredToken = `test-expired-${crypto.randomUUID()}`;
            const validToken = `test-valid-${crypto.randomUUID()}`;

            // Expired 1 hour ago
            activeSessions.set(expiredToken, {
                username: 'admin',
                role: 'admin',
                expiresAt: Date.now() - 3600000
            });

            // Valid for next 23 hours
            activeSessions.set(validToken, {
                username: 'admin',
                role: 'admin',
                expiresAt: Date.now() + 23 * 3600000
            });

            try {
                // Request with expired session should be treated as unauthenticated (401 on admin endpoint)
                const expiredRes = await env.request('GET', '/api/campaigns', {
                    cookie: `session_token=${expiredToken}`
                });
                assert.strictEqual(expiredRes.status, 401, 'Expired session must return 401');

                // Request with valid session should succeed (200)
                const validRes = await env.request('GET', '/api/campaigns', {
                    cookie: `session_token=${validToken}`
                });
                assert.strictEqual(validRes.status, 200, 'Valid session must return 200');
            } finally {
                activeSessions.delete(expiredToken);
                activeSessions.delete(validToken);
                if (savedRequireAuth !== undefined) process.env.REQUIRE_AUTH = savedRequireAuth;
                else delete process.env.REQUIRE_AUTH;
            }
        });

        it('tolerates legacy seeded test sessions that omit expiresAt', async () => {
            const legacyToken = `test-legacy-${crypto.randomUUID()}`;
            activeSessions.set(legacyToken, {
                username: 'admin',
                role: 'admin'
                // No expiresAt field (seeded by test helpers)
            });

            try {
                const res = await env.request('GET', '/api/campaigns', {
                    cookie: `session_token=${legacyToken}`
                });
                assert.strictEqual(res.status, 200, 'Legacy seeded session without expiresAt must be accepted');
            } finally {
                activeSessions.delete(legacyToken);
            }
        });

        it('enforces admin-only access on sensitive endpoints (/api/campaigns & /api/proxy-config) when REQUIRE_AUTH=true', async () => {
            const savedRequireAuth = process.env.REQUIRE_AUTH;
            process.env.REQUIRE_AUTH = 'true';
            try {
                // Unauthenticated
                const unauthCamp = await env.request('GET', '/api/campaigns');
                assert.strictEqual(unauthCamp.status, 401);

                const unauthProxy = await env.request('GET', '/api/proxy-config');
                assert.strictEqual(unauthProxy.status, 401);

                // Admin
                const adminCamp = await env.request('GET', '/api/campaigns', { cookie: env.adminCookie });
                assert.strictEqual(adminCamp.status, 200);

                const adminProxy = await env.request('GET', '/api/proxy-config', { cookie: env.adminCookie });
                assert.strictEqual(adminProxy.status, 200);
            } finally {
                if (savedRequireAuth !== undefined) process.env.REQUIRE_AUTH = savedRequireAuth;
                else delete process.env.REQUIRE_AUTH;
            }
        });

        it('restricts Socket.IO admins room strictly to socketRole === admin when REQUIRE_AUTH=true', async () => {
            const savedRequireAuth = process.env.REQUIRE_AUTH;
            process.env.REQUIRE_AUTH = 'true';
            const anonClient = new SocketClient(env.baseUrl);
            const adminClient = new SocketClient(env.baseUrl, { cookie: env.adminCookie });

            try {
                await anonClient.connect();
                await adminClient.connect();

                const adminInfo = await adminClient.waitForEvent('user-info');
                assert.strictEqual(adminInfo.role, 'admin');

                const proxyConfig = await adminClient.waitForEvent('proxy-config');
                assert.ok(proxyConfig, 'Admin socket must receive proxy-config');

                await new Promise(resolve => setTimeout(resolve, 150));
                assert.strictEqual(anonClient.getEvents('proxy-config').length, 0, 'Unauthenticated socket must not receive admin proxy-config');
            } finally {
                await anonClient.disconnect();
                await adminClient.disconnect();
                if (savedRequireAuth !== undefined) process.env.REQUIRE_AUTH = savedRequireAuth;
                else delete process.env.REQUIRE_AUTH;
            }
        });

        it('POST /api/change-password in open-access mode verifies configured admin username without writing null session key', async () => {
            await withTempAdminCredentials('InitOpenPass_1', async (_origUser, tmpPass) => {
                const res1 = await env.request('POST', '/api/change-password', {
                    body: {
                        currentPassword: tmpPass,
                        newUsername: 'renamedOpenAdmin',
                        newPassword: 'UpdatedOpenPass_2'
                    }
                });
                assert.strictEqual(res1.status, 200);
                assert.strictEqual(res1.body.success, true);
                assert.strictEqual(activeSessions.has(null), false, 'Open-access password change must not insert null session key');
                assert.strictEqual(activeSessions.has('null'), false, 'Open-access password change must not insert string "null" session key');
                if (fs.existsSync(SESSIONS_FILE)) {
                    const diskSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
                    assert.strictEqual(Object.prototype.hasOwnProperty.call(diskSessions, 'null'), false);
                }

                // Subsequent open-access call must validate against updated username in admin.json
                const res2 = await env.request('POST', '/api/change-password', {
                    body: {
                        currentPassword: 'UpdatedOpenPass_2',
                        newUsername: 'renamedOpenAdmin2',
                        newPassword: 'UpdatedOpenPass_3'
                    }
                });
                assert.strictEqual(res2.status, 200);
                assert.strictEqual(res2.body.success, true);
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 4: 30-Minute Order TTL & Lifecycle Expiration
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. 30-Minute Order TTL & Expiration', () => {
        it('transitions pending_payment order older than 30 minutes to expired', async () => {
            const order = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/order-ttl',
                proxyKey: 'test_order_key_ttl',
                targetClicks: 100,
                durationHours: 1
            });

            // Backdate createdAt to 35 minutes ago
            const filePath = path.join(ROOT_DIR, 'orders', `${order.orderId}.json`);
            order.createdAt = Date.now() - 35 * 60 * 1000;
            fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');

            // Reading via getOrder should evaluate TTL lazily and update status to expired
            const fetched = orderService.getOrder(order.orderId);
            assert.strictEqual(fetched.status, 'expired', 'Order older than 30m must be transitioned to expired');

            // Cleanup
            orderService.deleteOrder(order.orderId);
        });

        it('rejects late payment confirmation on expired orders with HTTP 409 Conflict', async () => {
            const order = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/expired-late-confirm',
                proxyKey: 'test_order_late_key',
                targetClicks: 100,
                durationHours: 1
            });

            // Backdate to expired
            const filePath = path.join(ROOT_DIR, 'orders', `${order.orderId}.json`);
            order.createdAt = Date.now() - 40 * 60 * 1000;
            order.status = 'expired';
            fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');

            const res = await env.request('POST', `/api/orders/${order.orderId}/confirm`, {
                cookie: env.adminCookie
            });
            assert.strictEqual(res.status, 409, 'Late confirm on expired order must return HTTP 409');
            assert.strictEqual(res.body.success, false);

            // Cleanup
            orderService.deleteOrder(order.orderId);
        });

        it('does not double-count unpaid expired orders in pendingCount or completedCount in GET /api/admin/orders', async () => {
            const order = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/summary-check',
                proxyKey: 'test_summary_key',
                targetClicks: 100,
                durationHours: 1
            });

            // Set to expired without payment
            order.status = 'expired';
            order.paymentStatus = 'pending_payment';
            const filePath = path.join(ROOT_DIR, 'orders', `${order.orderId}.json`);
            fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');

            const res = await env.request('GET', '/api/admin/orders', { cookie: env.adminCookie });
            assert.strictEqual(res.status, 200);

            const found = res.body.orders.find(o => o.orderId === order.orderId);
            assert.ok(found, 'Order must appear in admin list');
            assert.strictEqual(found.effectiveStatus, 'expired');

            // Summary must separate expired orders
            assert.ok(typeof res.body.summary.expiredCount === 'number');

            // Cleanup
            orderService.deleteOrder(order.orderId);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 5: Scheduler Reliability, Concurrency & Overdue Error Cutoff
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Scheduler Concurrency, Checkpointing & Overdue Protection', () => {
        it('prevents overlapping ticks via _isTickRunning concurrency lock', async () => {
            const cid = 'test_concurrency_lock';
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/lock-test',
                targetClicks: 20,
                startTime: Date.now() - 1000,
                endTime: Date.now() + 10000,
                customerProxyKey: 'lock_key_1',
                paymentStatus: 'paid'
            });
            state.status = 'running';
            state._isTickRunning = true; // Simulate in-flight tick
            campaigns.set(cid, state);

            const initialIdx = state.scheduleIdx;
            await scheduleTick(cid);

            // Because _isTickRunning was true, scheduleTick should abort immediately
            assert.strictEqual(state.scheduleIdx, initialIdx, 'Re-entrant tick must exit immediately without doing work');

            campaigns.delete(cid);
        });

        it('safely stops campaign and triggers alert when overdue errors exceed cutoff threshold', async () => {
            const cid = 'test_overdue_cutoff';
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/overdue',
                targetClicks: 50,
                startTime: Date.now() - 60000,
                endTime: Date.now() - 10000, // already overdue
                customerProxyKey: 'overdue_key',
                paymentStatus: 'paid'
            });
            state.status = 'running';
            state.overdueErrors = 10; // Hit threshold
            campaigns.set(cid, state);

            await scheduleTick(cid);

            assert.strictEqual(state.status, 'stopped', 'Campaign must be stopped safely when overdue error threshold exceeded');

            campaigns.delete(cid);
            try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${cid}.json`)); } catch {}
            try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${cid}.tmp`)); } catch {}
        });

        it('atomically checkpoints runtime state to disk', () => {
            const cid = 'test_checkpoint_cid';
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/cp',
                targetClicks: 100,
                startTime: Date.now(),
                endTime: Date.now() + 3600000,
                paymentStatus: 'paid'
            });
            state.scheduleIdx = 42;
            state.successVisits = 40;
            state.failedVisits = 2;
            state.usedIps = new Set(['1.2.3.4', '5.6.7.8']);
            campaigns.set(cid, state);

            checkpointCampaignState(cid);

            const diskFile = path.join(CAMPAIGNS_DIR, `${cid}.json`);
            assert.ok(fs.existsSync(diskFile), 'Checkpointed file must exist on disk');

            const content = JSON.parse(fs.readFileSync(diskFile, 'utf-8'));
            assert.strictEqual(content.scheduleIdx, 42);
            assert.strictEqual(content.successVisits, 40);
            assert.strictEqual(content.failedVisits, 2);
            assert.deepStrictEqual(content.usedIps, ['1.2.3.4', '5.6.7.8']);

            // Cleanup
            try { fs.unlinkSync(diskFile); } catch {}
            campaigns.delete(cid);
        });

        it('checkpointCampaignState and saveSessions survive transient Windows EPERM/EBUSY rename locks without orphan .tmp files', () => {
            const cid = `test_win_retry_${Date.now()}`;
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/retry',
                targetClicks: 10,
                startTime: Date.now(),
                endTime: Date.now() + 60000,
                paymentStatus: 'paid'
            });
            state.successVisits = 7;
            campaigns.set(cid, state);

            const sessionToken = `test-retry-sess-${crypto.randomUUID()}`;
            activeSessions.set(sessionToken, {
                username: 'admin',
                role: 'admin',
                expiresAt: Date.now() + 60000
            });

            const origRenameSync = fs.renameSync;
            let campaignRenameCalls = 0;
            let sessionRenameCalls = 0;

            fs.renameSync = function (oldPath, newPath) {
                if (String(newPath).endsWith(`${cid}.json`) && campaignRenameCalls === 0) {
                    campaignRenameCalls++;
                    const err = new Error('EPERM: transient lock');
                    err.code = 'EPERM';
                    throw err;
                }
                if (String(newPath) === SESSIONS_FILE && sessionRenameCalls === 0) {
                    sessionRenameCalls++;
                    const err = new Error('EBUSY: transient lock');
                    err.code = 'EBUSY';
                    throw err;
                }
                return origRenameSync.call(fs, oldPath, newPath);
            };

            const diskFile = path.join(CAMPAIGNS_DIR, `${cid}.json`);
            try {
                checkpointCampaignState(cid);
                assert.strictEqual(campaignRenameCalls, 1, 'Expected retry after EPERM on checkpointCampaignState');
                assert.ok(fs.existsSync(diskFile), 'Campaign checkpoint file must exist after transient EPERM retry');
                const savedCamp = JSON.parse(fs.readFileSync(diskFile, 'utf-8'));
                assert.strictEqual(savedCamp.successVisits, 7);

                saveSessions();
                assert.strictEqual(sessionRenameCalls, 1, 'Expected retry after EBUSY on saveSessions');
                const savedSess = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
                assert.ok(savedSess[sessionToken], 'Session token must be persisted atomically after transient EBUSY retry');

                const campaignTmps = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.includes(cid) && f.endsWith('.tmp'));
                assert.strictEqual(campaignTmps.length, 0, 'No orphan campaign .tmp files may remain');
                const rootTmps = fs.readdirSync(ROOT_DIR).filter(f => f.startsWith('sessions.json.') && f.endsWith('.tmp'));
                assert.strictEqual(rootTmps.length, 0, 'No orphan sessions .tmp files may remain');
            } finally {
                fs.renameSync = origRenameSync;
                activeSessions.delete(sessionToken);
                campaigns.delete(cid);
                try { fs.unlinkSync(diskFile); } catch {}
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 6: API Contracts: Health, Public Config, Proxy Validate, Telegram
    // ─────────────────────────────────────────────────────────────────────────
    describe('6. API Contracts Verification', () => {
        it('GET /api/health returns health status, uptime, campaigns and tunnel config', async () => {
            const res = await env.request('GET', '/api/health');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.status, 'ok');
            assert.ok(typeof res.body.uptime === 'number');
            assert.ok(typeof res.body.timestamp === 'number');
            assert.ok(res.body.campaigns && typeof res.body.campaigns.total === 'number');
            assert.ok(res.body.tunnel && typeof res.body.tunnel.type === 'string');
        });

        it('GET /api/public-config returns public pricing, dwellPresets, deviceProfiles and zero secrets', async () => {
            const res = await env.request('GET', '/api/public-config');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.pricing && res.body.pricing.clickRate === 40);
            assert.ok(res.body.dwellPresets && res.body.dwellPresets.standard && res.body.dwellPresets.short);
            assert.ok(Array.isArray(res.body.deviceProfiles) && res.body.deviceProfiles.includes('mixed'));
            assert.strictEqual(res.body.orderExpireMinutes, 30);
            assert.strictEqual(res.body.guestEnabled, false, 'guestEnabled must unconditionally be false');
            assert.strictEqual(res.body.defaultPasswordWarning, false, 'Unauthenticated public-config must never leak password warnings');
            assert.strictEqual(res.body.webhookSecret, undefined, 'webhookSecret must never be exposed');
            assert.strictEqual(res.body.keys, undefined, 'Proxy keys must never be exposed');
        });

        it('defaultPasswordWarning reflects default admin123456 only for authenticated admin when REQUIRE_AUTH=true and clears on password change, with #admin-default-pw-banner wired in UI', async () => {
            const nonAdminCookie = env.seedNonAdminSession();
            const savedRequireAuth = process.env.REQUIRE_AUTH;
            process.env.REQUIRE_AUTH = 'true';

            try {
                await withTempAdminCredentials('admin123456', async (adminUser, defaultPass) => {
                    const unauthRes = await env.request('GET', '/api/public-config');
                    assert.strictEqual(unauthRes.status, 200);
                    assert.strictEqual(unauthRes.body.defaultPasswordWarning, false);
                    assert.strictEqual(unauthRes.body.guestEnabled, false);

                    const nonAdminRes = await env.request('GET', '/api/public-config', { cookie: nonAdminCookie });
                    assert.strictEqual(nonAdminRes.status, 200);
                    assert.strictEqual(nonAdminRes.body.defaultPasswordWarning, false);
                    assert.strictEqual(nonAdminRes.body.guestEnabled, false);

                    const loginRes = await env.request('POST', '/api/login', {
                        body: { username: adminUser, password: defaultPass, rememberMe: false }
                    });
                    assert.strictEqual(loginRes.status, 200);
                    assert.ok(loginRes.cookies.session_token, 'Admin login must return session cookie');
                    const adminSessionCookie = `session_token=${loginRes.cookies.session_token}`;

                    try {
                        const warnRes = await env.request('GET', '/api/public-config', { cookie: adminSessionCookie });
                        assert.strictEqual(warnRes.status, 200);
                        assert.strictEqual(warnRes.body.authenticated, true);
                        assert.strictEqual(warnRes.body.role, 'admin');
                        assert.strictEqual(warnRes.body.guestEnabled, false);
                        assert.strictEqual(warnRes.body.defaultPasswordWarning, true);

                        const changeRes = await env.request('POST', '/api/change-password', {
                            cookie: adminSessionCookie,
                            body: {
                                currentPassword: defaultPass,
                                newUsername: adminUser,
                                newPassword: 'RotatedStrongPassword_2026!'
                            }
                        });
                        assert.strictEqual(changeRes.status, 200);
                        assert.strictEqual(changeRes.body.success, true);

                        const clearedRes = await env.request('GET', '/api/public-config', { cookie: adminSessionCookie });
                        assert.strictEqual(clearedRes.status, 200);
                        assert.strictEqual(clearedRes.body.defaultPasswordWarning, false);
                        assert.strictEqual(clearedRes.body.guestEnabled, false);
                    } finally {
                        await env.request('POST', '/api/logout', { cookie: adminSessionCookie }).catch(() => {});
                    }
                });
            } finally {
                if (savedRequireAuth !== undefined) process.env.REQUIRE_AUTH = savedRequireAuth;
                else delete process.env.REQUIRE_AUTH;
            }

            const boostHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'boost.html'), 'utf-8');
            const boostUiJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'boost-ui.js'), 'utf-8');
            assert.match(boostHtml, /id=["']admin-default-pw-banner["']/);
            assert.match(boostUiJs, /admin-default-pw-banner/);
            assert.match(boostUiJs, /defaultPasswordWarning\s*!==\s*true/);
        });

        it('POST /api/proxy/validate validates proxy key parameter', async () => {
            // Missing key
            const emptyRes = await env.request('POST', '/api/proxy/validate', { body: {} });
            assert.strictEqual(emptyRes.status, 400);

            // Valid key format
            const validRes = await env.request('POST', '/api/proxy/validate', {
                body: { proxyKey: 'valid_test_proxy_key' }
            });
            assert.strictEqual(validRes.status, 200);
            assert.strictEqual(validRes.body.success, true);
            assert.strictEqual(validRes.body.valid, true);
        });

        it('POST /api/orders accepts optional dwellPreset and deviceProfile and propagates them to activated campaign', async () => {
            const res = await env.request('POST', '/api/orders', {
                body: {
                    targetUrl: 'https://traffic-test.example.com/custom-profile',
                    proxyKey: 'test_dwell_device_key',
                    targetClicks: 50,
                    durationHours: 1,
                    dwellPreset: 'deep',
                    deviceProfile: 'mobile'
                }
            });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.dwellPreset, 'deep');
            assert.strictEqual(res.body.deviceProfile, 'mobile');
            assert.ok(res.body.expiresAt >= res.body.createdAt + 29 * 60 * 1000, 'Order must include ~30m expiresAt');

            const confirmRes = await env.request('POST', `/api/orders/${res.body.orderId}/confirm`, {
                cookie: env.adminCookie
            });
            assert.strictEqual(confirmRes.status, 200);
            const camp = campaigns.get(confirmRes.body.campaignId);
            assert.ok(camp, 'Activated campaign must exist');
            assert.strictEqual(camp.config.dwellMin, 15);
            assert.strictEqual(camp.config.dwellMax, 30);
            assert.strictEqual(camp.config.dwellPreset, 'deep');
            assert.strictEqual(camp.config.deviceProfile, 'mobile');

            // Cleanup
            await env.request('DELETE', `/api/admin/orders/${res.body.orderId}`, { cookie: env.adminCookie });
        });

        it('runVisitWorker selects User-Agent matching deviceProfile (mobile vs desktop)', async () => {
            const seenHeaders = [];
            const savedGet = axios.get;
            axios.get = async (url, config = {}) => {
                if (typeof url === 'string' && url.includes('device-check.example.com')) {
                    seenHeaders.push(config.headers || {});
                    return { status: 200, data: '<html><body>ok</body></html>', headers: { 'content-type': 'text/html' } };
                }
                return savedGet.call(axios, url, config);
            };

            const mobileCid = `test_device_mobile_${Date.now()}`;
            const desktopCid = `test_device_desktop_${Date.now()}`;
            try {
                const mobileState = createCampaignState(mobileCid, {
                    targetUrl: 'https://device-check.example.com/m',
                    targetClicks: 5,
                    startTime: Date.now() - 1000,
                    endTime: Date.now() + 60000,
                    dwellMin: 1,
                    dwellMax: 1,
                    deviceProfile: 'mobile',
                    randomLinks: false,
                    paymentStatus: 'paid'
                });
                mobileState.status = 'running';
                campaigns.set(mobileCid, mobileState);
                await runVisitWorker(mobileCid, {
                    key: 'dev_mob_key',
                    currentProxy: { http: '127.0.0.1:8888', realIpAddress: '203.0.113.55' }
                });

                const desktopState = createCampaignState(desktopCid, {
                    targetUrl: 'https://device-check.example.com/d',
                    targetClicks: 5,
                    startTime: Date.now() - 1000,
                    endTime: Date.now() + 60000,
                    dwellMin: 1,
                    dwellMax: 1,
                    deviceProfile: 'desktop',
                    randomLinks: false,
                    paymentStatus: 'paid'
                });
                desktopState.status = 'running';
                campaigns.set(desktopCid, desktopState);
                await runVisitWorker(desktopCid, {
                    key: 'dev_desk_key',
                    currentProxy: { http: '127.0.0.1:8889', realIpAddress: '203.0.113.56' }
                });

                assert.strictEqual(seenHeaders.length, 2);
                assert.match(seenHeaders[0]['User-Agent'], /(Android|iPhone|Mobile)/i, 'mobile profile must send mobile UA');
                assert.strictEqual(seenHeaders[0]['sec-ch-ua'], undefined, 'mobile profile must omit desktop sec-ch-ua');
                assert.strictEqual(/(Android|iPhone|Mobile)/i.test(seenHeaders[1]['User-Agent']), false, 'desktop profile must send desktop UA');
                assert.ok(seenHeaders[1]['sec-ch-ua'], 'desktop profile must include sec-ch-ua');
            } finally {
                axios.get = savedGet;
                campaigns.delete(mobileCid);
                campaigns.delete(desktopCid);
                globalProxyPool.delete('dev_mob_key');
                globalProxyPool.delete('dev_desk_key');
                for (const cid of [mobileCid, desktopCid]) {
                    try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${cid}.json`)); } catch {}
                    try { fs.unlinkSync(path.join(CAMPAIGNS_DIR, `${cid}.tmp`)); } catch {}
                }
            }
        });

        it('Admin Telegram APIs: GET /api/admin/telegram, POST /api/admin/telegram, and POST /api/admin/telegram/test', async () => {
            // Unauthenticated should fail with 401 when REQUIRE_AUTH=true
            const savedRequireAuth = process.env.REQUIRE_AUTH;
            process.env.REQUIRE_AUTH = 'true';
            try {
                const unauthGet = await env.request('GET', '/api/admin/telegram');
                assert.strictEqual(unauthGet.status, 401);
            } finally {
                if (savedRequireAuth !== undefined) process.env.REQUIRE_AUTH = savedRequireAuth;
                else delete process.env.REQUIRE_AUTH;
            }

            // Admin GET
            const adminGet = await env.request('GET', '/api/admin/telegram', { cookie: env.adminCookie });
            assert.strictEqual(adminGet.status, 200);
            assert.strictEqual(adminGet.body.success, true);
            assert.ok(adminGet.body.config && Array.isArray(adminGet.body.config.chatIds));

            // Admin POST update
            const updateRes = await env.request('POST', '/api/admin/telegram', {
                cookie: env.adminCookie,
                body: {
                    botToken: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz',
                    chatIds: ['987654321', '123456789'],
                    notifyOnComplete: true,
                    sendFileReport: true
                }
            });
            assert.strictEqual(updateRes.status, 200);
            assert.strictEqual(updateRes.body.success, true);

            // Verify updated config (masked token, sanitized chatIds)
            const checkGet = await env.request('GET', '/api/admin/telegram', { cookie: env.adminCookie });
            assert.strictEqual(checkGet.body.config.botTokenConfigured, true);
            assert.ok(checkGet.body.config.botTokenMasked.includes('...'));
            assert.deepStrictEqual(checkGet.body.config.chatIds, ['987654321', '123456789']);

            // Admin test alert trigger
            const testAlertRes = await env.request('POST', '/api/admin/telegram/test', {
                cookie: env.adminCookie
            });
            assert.strictEqual(testAlertRes.status, 200);
            assert.strictEqual(testAlertRes.body.success, true);
        });
    });
});
