/**
 * Challenger 1: Empirical SSRF, Zero Direct IP Fallback & Auth Hardening Stress Suite
 * 
 * Verifies and stresses:
 * 1. SSRF Stress:
 *    - RFC 1918 private subnets, cloud metadata (169.254.169.254, metadata.google.internal, instance-data)
 *    - Alternative numeric IP representations (decimal, octal, hex, 0.0.0.0, 0)
 *    - IPv4-mapped IPv6 ([::ffff:127.0.0.1], [::ffff:7f00:1], etc.)
 *    - Opt-in toggle (ALLOW_PRIVATE_TARGET_URLS=true vs false)
 * 2. Paid Order Zero Direct IP Fallback:
 *    - Dead proxy (ECONNREFUSED)
 *    - 500 / 502 Bad Gateway proxy
 *    - Missing / null proxy
 *    - Asserting strictly 0 direct HTTP hits on target server
 * 3. Auth & Session Hardening:
 *    - Strict rejection of guest 1/1 login (401)
 *    - Session TTL expiration (past expiresAt yields 401 & eviction)
 *    - Unauthenticated manual confirm rejection (403)
 *    - Rate limiter enforcement (429)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const orderService = require('../orderService');
const server = require('../server');

describe('Challenger 1: Empirical Security & Resilience Stress Suite', () => {

    describe('1. SSRF & Address Gating Stress Testing', () => {

        it('strictly blocks standard IPv4 loopback and private subnets when opt-in disabled', () => {
            const saved = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';
                const privateIps = [
                    'http://127.0.0.1/test',
                    'http://127.0.0.2:8080/test',
                    'http://127.255.255.254/',
                    'http://10.0.0.1/',
                    'http://10.254.1.2:3000/',
                    'http://172.16.0.1/',
                    'http://172.31.255.255/',
                    'http://192.168.0.1/',
                    'http://192.168.1.254/'
                ];

                for (const url of privateIps) {
                    const res = orderService.validateOrderParams({
                        targetUrl: url,
                        proxyKey: 'test_key',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    assert.strictEqual(res.isValid, false, `Expected ${url} to be blocked`);
                    assert.ok(
                        res.errors.some(e => e.includes('localhost, private, or loopback')),
                        `Expected private target error for ${url}`
                    );
                }
            } finally {
                if (saved !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = saved;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('strictly blocks cloud metadata endpoints and private hostnames', () => {
            const saved = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';
                const metadataUrls = [
                    'http://169.254.169.254/latest/meta-data/',
                    'http://169.254.169.254/computeMetadata/v1/',
                    'http://169.254.0.1/',
                    'http://metadata.google.internal/computeMetadata/v1/',
                    'http://instance-data/latest/meta-data/',
                    'http://localhost/',
                    'http://service.localhost/',
                    'http://db.local/',
                    'http://backend.internal/'
                ];

                for (const url of metadataUrls) {
                    const res = orderService.validateOrderParams({
                        targetUrl: url,
                        proxyKey: 'test_key',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    assert.strictEqual(res.isValid, false, `Expected metadata/private hostname ${url} to be blocked`);
                }
            } finally {
                if (saved !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = saved;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('blocks zero IP, decimal, octal, and hex IPv4 representations normalized by WHATWG URL', () => {
            const saved = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';
                const exoticUrls = [
                    'http://0.0.0.0/',
                    'http://0.0.0.0:8080/',
                    'http://0/',                    // resolves to 0.0.0.0
                    'http://2130706433/',           // decimal for 127.0.0.1
                    'http://0177.0.0.1/',           // octal for 127.0.0.1
                    'http://0x7f000001/',           // hex for 127.0.0.1
                    'http://2852039166/',           // decimal for 169.254.169.254
                    'http://0xa9fea9fe/',           // hex for 169.254.169.254
                    'http://127.1/',                // shorthand for 127.0.0.1
                    'http://10.1/',                 // shorthand for 10.0.0.1
                    'http://[::1]/',                // IPv6 loopback
                    'http://[::]/',                 // IPv6 unspecified
                    'http://[fc00::1]/',            // IPv6 unique local
                    'http://[fe80::1]/'             // IPv6 link local
                ];

                for (const url of exoticUrls) {
                    const res = orderService.validateOrderParams({
                        targetUrl: url,
                        proxyKey: 'test_key',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    assert.strictEqual(res.isValid, false, `Expected exotic numeric URL ${url} to be blocked`);
                }
            } finally {
                if (saved !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = saved;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('permits private targets when explicit opt-in ALLOW_PRIVATE_TARGET_URLS=true is set', () => {
            const saved = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'true';
                const res = orderService.validateOrderParams({
                    targetUrl: 'http://127.0.0.1:8080/mock-target',
                    proxyKey: 'test_key',
                    targetClicks: 10,
                    durationHours: 1
                });
                assert.strictEqual(res.isValid, true, 'Opt-in must permit local target URLs for mock test harnesses');
            } finally {
                if (saved !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = saved;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });

        it('EMPIRICAL BUG DETECTION: exposes IPv4-mapped IPv6 bypass due to WHATWG hex normalization', () => {
            const saved = process.env.ALLOW_PRIVATE_TARGET_URLS;
            try {
                process.env.ALLOW_PRIVATE_TARGET_URLS = 'false';
                // WHATWG URL parser automatically normalizes http://[::ffff:127.0.0.1] to http://[::ffff:7f00:1]
                const mappedUrls = [
                    'http://[::ffff:127.0.0.1]/',
                    'http://[::ffff:169.254.169.254]/',
                    'http://[::ffff:7f00:1]/'
                ];

                let bypassedCount = 0;
                for (const url of mappedUrls) {
                    const res = orderService.validateOrderParams({
                        targetUrl: url,
                        proxyKey: 'test_key',
                        targetClicks: 10,
                        durationHours: 1
                    });
                    if (res.isValid) {
                        bypassedCount++;
                    }
                }
                // Challenger verification: Confirmed all IPv4-mapped IPv6 targets are blocked
                assert.strictEqual(bypassedCount, 0, 'All IPv4-mapped IPv6 targets must be blocked');
            } finally {
                if (saved !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = saved;
                else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
            }
        });
    });

    describe('2. Paid Order Zero Direct IP Fallback Verification', () => {
        let targetServer = null;
        let targetPort = null;
        let directTargetHits = 0;

        before(async () => {
            targetServer = http.createServer((req, res) => {
                directTargetHits++;
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('TARGET_RECEIVED_DIRECT_REQUEST');
            });
            await new Promise(resolve => targetServer.listen(0, '127.0.0.1', resolve));
            targetPort = targetServer.address().port;
        });

        after(() => {
            if (targetServer) targetServer.close();
            const fs = require('node:fs');
            const path = require('node:path');
            for (const cid of ['challenger_camp_dead_proxy', 'challenger_camp_502_proxy', 'challenger_camp_null_proxy']) {
                try { server.campaigns.delete(cid); } catch {}
                for (const ext of ['.json', '.tmp']) {
                    const p = path.join(__dirname, '..', 'campaigns', `${cid}${ext}`);
                    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
                }
            }
        });

        it('guarantees ZERO direct requests to target server when proxy fails with ECONNREFUSED', async () => {
            const savedAllow = process.env.ALLOW_PRIVATE_TARGET_URLS;
            process.env.ALLOW_PRIVATE_TARGET_URLS = 'true';
            const initialHits = directTargetHits;

            const deadPort = 59129;
            const cid = 'challenger_camp_dead_proxy';
            const mockCamp = {
                id: cid,
                paymentStatus: 'paid',
                activeWorkers: 0,
                totalVisits: 0,
                successVisits: 0,
                failedVisits: 0,
                usedIps: new Set(),
                dupIpsCount: 0,
                config: {
                    targetUrl: `http://127.0.0.1:${targetPort}/test`,
                    dwellMin: 1,
                    dwellMax: 2
                }
            };
            server.campaigns.set(cid, mockCamp);

            await server.runVisitWorker(cid, {
                key: 'dead_key',
                currentProxy: { http: `127.0.0.1:${deadPort}`, realIpAddress: '99.99.99.99' }
            });

            assert.strictEqual(
                directTargetHits,
                initialHits,
                'Dead proxy MUST NOT cause any direct HTTP request to reach the target server'
            );
            assert.strictEqual(mockCamp.successVisits, 0);

            if (savedAllow !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedAllow;
            else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
        });

        it('guarantees ZERO direct requests to target server when proxy returns HTTP 502 Bad Gateway', async () => {
            const savedAllow = process.env.ALLOW_PRIVATE_TARGET_URLS;
            process.env.ALLOW_PRIVATE_TARGET_URLS = 'true';
            const initialHits = directTargetHits;

            let proxyHits = 0;
            const badProxy = http.createServer((req, res) => {
                proxyHits++;
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway from Mock Proxy');
            });
            await new Promise(resolve => badProxy.listen(0, '127.0.0.1', resolve));
            const badProxyPort = badProxy.address().port;

            const cid = 'challenger_camp_502_proxy';
            const mockCamp = {
                id: cid,
                paymentStatus: 'paid',
                activeWorkers: 0,
                totalVisits: 0,
                successVisits: 0,
                failedVisits: 0,
                usedIps: new Set(),
                dupIpsCount: 0,
                config: {
                    targetUrl: `http://127.0.0.1:${targetPort}/test`,
                    dwellMin: 1,
                    dwellMax: 2
                }
            };
            server.campaigns.set(cid, mockCamp);

            await server.runVisitWorker(cid, {
                key: 'bad_proxy_key',
                currentProxy: { http: `127.0.0.1:${badProxyPort}`, realIpAddress: '88.88.88.88' }
            });

            badProxy.close();

            assert.ok(proxyHits > 0, 'Request was routed through the proxy agent');
            assert.strictEqual(
                directTargetHits,
                initialHits,
                'Failing proxy (502) MUST NOT fall back to direct request'
            );
            assert.strictEqual(mockCamp.successVisits, 0);

            if (savedAllow !== undefined) process.env.ALLOW_PRIVATE_TARGET_URLS = savedAllow;
            else delete process.env.ALLOW_PRIVATE_TARGET_URLS;
        });

        it('aborts worker immediately when paid campaign keyState has null currentProxy', async () => {
            const initialHits = directTargetHits;
            const cid = 'challenger_camp_null_proxy';
            const mockCamp = {
                id: cid,
                paymentStatus: 'paid',
                activeWorkers: 0,
                totalVisits: 0,
                successVisits: 0,
                failedVisits: 0,
                usedIps: new Set(),
                dupIpsCount: 0,
                config: {
                    targetUrl: `http://127.0.0.1:${targetPort}/test`,
                    dwellMin: 1,
                    dwellMax: 2
                }
            };
            server.campaigns.set(cid, mockCamp);

            await server.runVisitWorker(cid, {
                key: 'null_proxy_key',
                currentProxy: null
            });

            assert.strictEqual(directTargetHits, initialHits, 'Null proxy must never cause direct traffic');
            assert.strictEqual(mockCamp.totalVisits, 0, 'Worker must abort before incrementing totalVisits');
        });
    });

    describe('3. Auth & Session Hardening Stress Testing', () => {
        let appServer = null;
        let appPort = null;
        let axiosClient = null;

        before(async () => {
            await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
            appPort = server.server.address().port;
            const axios = require('axios');
            axiosClient = axios.create({
                baseURL: `http://127.0.0.1:${appPort}`,
                validateStatus: () => true
            });
        });

        after(() => {
            if (server.server) server.server.close();
        });

        it('unconditionally rejects guest 1/1 login with HTTP 401 and keeps guestEnabled=false', async () => {
            const saved = process.env.ALLOW_GUEST_LOGIN;
            try {
                // Even if legacy ALLOW_GUEST_LOGIN env var is set, 1/1 must remain strictly rejected
                process.env.ALLOW_GUEST_LOGIN = 'true';
                const res = await axiosClient.post('/api/login', {
                    username: '1',
                    password: '1'
                });
                assert.strictEqual(res.status, 401, 'Guest 1/1 login must unconditionally be rejected with 401');
                assert.strictEqual(res.data.success, false);

                const cfg = await axiosClient.get('/api/public-config');
                assert.strictEqual(cfg.status, 200);
                assert.strictEqual(cfg.data.guestEnabled, false);
            } finally {
                if (saved !== undefined) process.env.ALLOW_GUEST_LOGIN = saved;
                else delete process.env.ALLOW_GUEST_LOGIN;
            }
        });

        it('enforces session TTL: expired session is rejected (401) and evicted from activeSessions', async () => {
            const expiredToken = `challenger-expired-token-${Date.now()}`;
            server.activeSessions.set(expiredToken, {
                username: 'admin',
                role: 'admin',
                expiresAt: Date.now() - 10000 // expired 10s ago
            });

            const res = await axiosClient.get('/api/me', {
                headers: { Cookie: `session_token=${expiredToken}` }
            });

            assert.strictEqual(res.status, 401, 'Expired session must return 401 Unauthorized');
            assert.strictEqual(
                server.activeSessions.has(expiredToken),
                false,
                'Expired session must be evicted from activeSessions'
            );
        });

        it('accepts unexpired session with valid TTL', async () => {
            const validToken = `challenger-valid-token-${Date.now()}`;
            server.activeSessions.set(validToken, {
                username: 'admin',
                role: 'admin',
                expiresAt: Date.now() + 60000 // valid for 60s
            });

            const res = await axiosClient.get('/api/me', {
                headers: { Cookie: `session_token=${validToken}` }
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.username, 'admin');
            assert.strictEqual(res.data.role, 'admin');

            server.activeSessions.delete(validToken);
        });

        it('strictly returns HTTP 403 on unauthenticated POST /api/orders/:id/confirm', async () => {
            const res = await axiosClient.post('/api/orders/non_existent_order_id/confirm');
            assert.strictEqual(res.status, 403, 'Unauthenticated confirm must return HTTP 403 Forbidden');
            assert.strictEqual(res.data.success, false);
        });

        it('enforces rate limiting on /api/login under brute-force threshold', async () => {
            const savedRate = process.env.RATE_LIMIT_DISABLED;
            delete process.env.RATE_LIMIT_DISABLED;
            try {
                let triggered429 = false;
                for (let i = 0; i < 35; i++) {
                    const r = await axiosClient.post('/api/login', {
                        username: 'invalid_user',
                        password: 'invalid_password'
                    });
                    if (r.status === 429) {
                        triggered429 = true;
                        break;
                    }
                }
                assert.strictEqual(triggered429, true, 'Rapid login attempts must trigger HTTP 429 Rate Limit');
            } finally {
                if (savedRate !== undefined) process.env.RATE_LIMIT_DISABLED = savedRate;
            }
        });
    });
});
