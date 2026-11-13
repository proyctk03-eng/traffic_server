/**
 * Challenger 2: Empirical Stress Test Harness
 * 
 * Focus Areas:
 * 1. Concurrency Lock & Scheduler Overlap:
 *    - Rapid concurrent scheduleTick invocations (50 parallel calls) verify _isTickRunning lock
 *    - Error resiliency in tick execution guarantees _isTickRunning lock is always unlocked
 *    - Overdue error threshold cutoff: when Date.now() > endTime, 10 consecutive proxy errors safely stops campaign
 *    - Overdue 15-minute grace window cutoff
 * 2. 30-Minute Order TTL & Lifecycle Stress:
 *    - Exact boundary testing (29m vs 30m vs 31m)
 *    - Paid and running orders older than 30m never expire
 *    - Batch sweep expireStaleOrders() returns only stale pending orders
 *    - Late payment confirmation on expired orders returns HTTP 409 Conflict
 *    - GET /api/admin/orders summary counts: unpaid expired strictly in expiredCount, zero in pending/completed
 *    - Webhook replay idempotency (already: true) without txId
 * 3. Proxy Dispatch & Invariants:
 *    - Target URL protocol to agent mapping (httpsAgent vs httpAgent, proxy: false)
 *    - Zero occurrences of 'chromium' in server.js outside lines containing 'sec-ch-ua'
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const axios = require('axios');

const { setupServerEnv, ROOT_DIR, CAMPAIGNS_DIR } = require('./helpers/test_env');
const orderService = require('../orderService');

describe('Challenger 2: Scheduler Concurrency, Overdue Cutoff & 30m Order TTL Stress Harness', () => {
    let env = null;
    let campaigns = null;
    let createCampaignState = null;
    let scheduleTick = null;
    let completeCampaign = null;
    let globalProxyPool = null;
    let runVisitWorker = null;
    let checkpointCampaignState = null;

    const originalAxiosGet = axios.get;
    const originalAxiosPost = axios.post;

    before(async () => {
        env = await setupServerEnv();
        ({
            campaigns,
            createCampaignState,
            scheduleTick,
            completeCampaign,
            globalProxyPool,
            runVisitWorker,
            checkpointCampaignState
        } = env.serverModule);

        // Intercept external third-party calls
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

    const createdCampaignIds = [
        'c2_stress_concurrency_50',
        'c2_stress_lock_release_on_error',
        'c2_stress_overdue_threshold',
        'c2_stress_overdue_grace'
    ];

    after(async () => {
        axios.get = originalAxiosGet;
        axios.post = originalAxiosPost;
        for (const cid of createdCampaignIds) {
            if (campaigns) campaigns.delete(cid);
            try {
                const f = path.join(CAMPAIGNS_DIR, `${cid}.json`);
                if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch {}
            try {
                const fTmp = path.join(CAMPAIGNS_DIR, `${cid}.json.tmp`);
                if (fs.existsSync(fTmp)) fs.unlinkSync(fTmp);
            } catch {}
        }
        if (env) await env.teardown();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DOMAIN 1: Concurrency Lock & Scheduler Overlap Stress
    // ─────────────────────────────────────────────────────────────────────────
    describe('Domain 1: Concurrency Lock & Scheduler Overlap Stress', () => {
        it('blocks 50 rapid concurrent invocations via _isTickRunning lock without double-dispatch or races', async () => {
            const cid = 'c2_stress_concurrency_50';
            const startTime = Date.now() - 5000;
            const endTime = Date.now() + 60000;
            const key = 'c2_proxy_key_concurrency';

            globalProxyPool.set(key, { key, currentProxy: null, nextRequestAt: 0, isBusy: false, campaignId: null });

            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/c2-concurrent',
                targetClicks: 20,
                startTime,
                endTime,
                customerProxyKey: key,
                paymentStatus: 'paid'
            });
            state.status = 'running';
            campaigns.set(cid, state);

            // Mock KiotProxy rotation with a deliberate 25ms delay to expand the concurrency window
            const savedGet = axios.get;
            let mockProxyCallCount = 0;
            axios.get = async function (url, ...args) {
                if (typeof url === 'string' && url.startsWith('https://api.kiotproxy.com')) {
                    mockProxyCallCount++;
                    await new Promise(res => setTimeout(res, 25));
                    return {
                        data: {
                            status: 'success',
                            code: 200,
                            data: { http: '203.0.113.20:8080', realIpAddress: '203.0.113.20', ttc: 60 }
                        }
                    };
                }
                return savedGet.call(this, url, ...args);
            };

            try {
                // Launch 50 simultaneous scheduleTick invocations concurrently
                const promises = Array.from({ length: 50 }, () => scheduleTick(cid));
                await Promise.all(promises);

                // Because _isTickRunning locked the campaign during the 25ms window:
                // Only the first tick was permitted to run; the remaining 49 returned immediately
                assert.strictEqual(state._isTickRunning, false, 'Lock must be fully released in finally block');
                assert.ok(mockProxyCallCount >= 1, `Expected at least 1 proxy rotation from tick execution, got ${mockProxyCallCount}`);
                assert.ok(
                    mockProxyCallCount <= 2,
                    `Expected at most 2 proxy rotations from single tick execution, got ${mockProxyCallCount}`
                );
                assert.ok(
                    state.scheduleIdx <= 2,
                    `scheduleIdx must not be incremented by 50 concurrent ticks, actual: ${state.scheduleIdx}`
                );
            } finally {
                axios.get = savedGet;
                campaigns.delete(cid);
                globalProxyPool.delete(key);
            }
        });

        it('guarantees _isTickRunning lock is released even if an unhandled error occurs within scheduleTick', async () => {
            const cid = 'c2_stress_lock_release_on_error';
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/c2-error',
                targetClicks: 10,
                startTime: Date.now() - 1000,
                endTime: Date.now() + 10000,
                customerProxyKey: 'c2_error_key',
                paymentStatus: 'paid'
            });
            state.status = 'running';
            campaigns.set(cid, state);

            // Force an error inside scheduleTick by making schedule throw on property access
            Object.defineProperty(state, 'targetLimit', {
                get() {
                    if (state._throwOnce) {
                        state._throwOnce = false;
                        throw new Error('Simulated internal tick explosion');
                    }
                    return 10;
                },
                configurable: true
            });
            state._throwOnce = true;

            await assert.rejects(async () => {
                await scheduleTick(cid);
            }, /Simulated internal tick explosion/);

            // Invariant: finally block must reset _isTickRunning to false
            assert.strictEqual(state._isTickRunning, false, '_isTickRunning must be reset to false even after exception');

            // Subsequent invocation should now succeed without deadlock
            await scheduleTick(cid);
            assert.strictEqual(state._isTickRunning, false);

            campaigns.delete(cid);
        });

        it('stops campaign safely when consecutive proxy errors exceed threshold (10) after endTime', async () => {
            const cid = 'c2_stress_overdue_threshold';
            const key = 'c2_overdue_error_key';

            globalProxyPool.set(key, { key, currentProxy: null, nextRequestAt: 0, isBusy: false, campaignId: null });

            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/c2-overdue',
                targetClicks: 100,
                startTime: Date.now() - 60000,
                endTime: Date.now() - 5000, // strictly past endTime
                customerProxyKey: key,
                paymentStatus: 'paid'
            });
            state.status = 'running';
            state.overdueErrors = 0;
            campaigns.set(cid, state);

            // Make proxy acquisition fail (return null proxy)
            const savedGet = axios.get;
            axios.get = async function (url, ...args) {
                if (typeof url === 'string' && url.startsWith('https://api.kiotproxy.com')) {
                    return { data: { status: 'failed', code: 500, message: 'All proxies offline' } };
                }
                return savedGet.call(this, url, ...args);
            };

            try {
                // Call scheduleTick 10 times: each tick encounters proxy failure and increments overdueErrors
                for (let i = 1; i <= 10; i++) {
                    await scheduleTick(cid);
                    assert.strictEqual(state.overdueErrors, i, `overdueErrors must be ${i} after tick ${i}`);
                    assert.strictEqual(state.status, 'running', `Campaign must still be running at tick ${i}`);
                    assert.strictEqual(state.activeWorkers, 0, 'Zero direct IP fallback: no workers dispatched');
                }

                // On the 11th tick, overdueErrors is 10 (>= MAX_OVERDUE_ERRORS = 10)
                await scheduleTick(cid);
                assert.strictEqual(state.status, 'stopped', 'Campaign must be safely stopped after 10 consecutive overdue errors');

                // On subsequent ticks, campaign is stopped and does not continue looping or incrementing
                const finalErrors = state.overdueErrors;
                await scheduleTick(cid);
                assert.strictEqual(state.status, 'stopped');
                assert.strictEqual(state.overdueErrors, finalErrors, 'Stopped campaign must not increment overdueErrors further');
            } finally {
                axios.get = savedGet;
                campaigns.delete(cid);
                globalProxyPool.delete(key);
            }
        });

        it('stops campaign immediately when now exceeds endTime by more than 15-minute grace window', async () => {
            const cid = 'c2_stress_overdue_grace';
            const pastEndTime = Date.now() - (16 * 60 * 1000); // 16 minutes past endTime (> 15m grace)
            const state = createCampaignState(cid, {
                targetUrl: 'https://traffic-test.example.com/c2-grace',
                targetClicks: 50,
                startTime: pastEndTime - 3600000,
                endTime: pastEndTime,
                customerProxyKey: 'c2_grace_key',
                paymentStatus: 'paid'
            });
            state.status = 'running';
            state.overdueErrors = 0; // zero errors, but exceeded grace period
            campaigns.set(cid, state);

            await scheduleTick(cid);
            assert.strictEqual(state.status, 'stopped', 'Campaign must stop when overdue by more than 15 minutes');

            campaigns.delete(cid);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DOMAIN 2: 30-Minute Order TTL & Lifecycle Stress
    // ─────────────────────────────────────────────────────────────────────────
    describe('Domain 2: 30-Minute Order TTL & Lifecycle Stress', () => {
        const createdOrderIds = [];

        after(() => {
            for (const id of createdOrderIds) {
                try { orderService.deleteOrder(id); } catch {}
            }
        });

        it('accurately distinguishes the 30-minute boundary (29m vs 30m vs 31m)', () => {
            const now = Date.now();
            const TTL = orderService.ORDER_TTL_MS; // 30 * 60 * 1000 ms = 1800000 ms

            // 1. Order at 29 minutes old (1,740,000 ms ago) -> MUST REMAIN pending_payment
            const order29m = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-29m',
                proxyKey: 'ttl_key_29m',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order29m.orderId);
            order29m.createdAt = now - (29 * 60 * 1000);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${order29m.orderId}.json`), JSON.stringify(order29m, null, 4));

            const fetched29m = orderService.getOrder(order29m.orderId);
            assert.strictEqual(fetched29m.status, 'pending_payment', '29m order must remain pending_payment');
            assert.strictEqual(fetched29m.paymentStatus, 'pending_payment');

            // 2. Order at 29m59s old (1,799,000 ms ago) -> MUST REMAIN pending_payment
            const order29m59s = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-29m59s',
                proxyKey: 'ttl_key_29m59s',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order29m59s.orderId);
            order29m59s.createdAt = now - (TTL - 1000);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${order29m59s.orderId}.json`), JSON.stringify(order29m59s, null, 4));

            const fetched29m59s = orderService.getOrder(order29m59s.orderId);
            assert.strictEqual(fetched29m59s.status, 'pending_payment', '29m59s order must remain pending_payment');

            // 3. Order at 30m + 1ms old (1,800,001 ms ago) -> MUST EXPIRE
            const order30m = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-30m',
                proxyKey: 'ttl_key_30m',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order30m.orderId);
            order30m.createdAt = now - (TTL + 1);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${order30m.orderId}.json`), JSON.stringify(order30m, null, 4));

            const fetched30m = orderService.getOrder(order30m.orderId);
            assert.strictEqual(fetched30m.status, 'expired', '30m + 1ms order must be transitioned to expired');
            assert.strictEqual(fetched30m.paymentStatus, 'expired');

            // 4. Order at 45m old -> MUST EXPIRE
            const order45m = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-45m',
                proxyKey: 'ttl_key_45m',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order45m.orderId);
            order45m.createdAt = now - (45 * 60 * 1000);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${order45m.orderId}.json`), JSON.stringify(order45m, null, 4));

            const fetched45m = orderService.getOrder(order45m.orderId);
            assert.strictEqual(fetched45m.status, 'expired', '45m order must be transitioned to expired');
        });

        it('guarantees paid, running, and completed orders older than 30 minutes NEVER expire', () => {
            const now = Date.now();
            const twoHoursAgo = now - (2 * 3600 * 1000);

            // Paid order
            const paidOrder = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-paid',
                proxyKey: 'ttl_paid_key',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(paidOrder.orderId);
            paidOrder.createdAt = twoHoursAgo;
            paidOrder.status = 'paid';
            paidOrder.paymentStatus = 'paid';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${paidOrder.orderId}.json`), JSON.stringify(paidOrder, null, 4));

            const fetchedPaid = orderService.getOrder(paidOrder.orderId);
            assert.strictEqual(fetchedPaid.status, 'paid', 'Paid order older than 30m must NOT expire');

            // Running order
            const runningOrder = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-running',
                proxyKey: 'ttl_running_key',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(runningOrder.orderId);
            runningOrder.createdAt = twoHoursAgo;
            runningOrder.status = 'running';
            runningOrder.paymentStatus = 'paid';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${runningOrder.orderId}.json`), JSON.stringify(runningOrder, null, 4));

            const fetchedRunning = orderService.getOrder(runningOrder.orderId);
            assert.strictEqual(fetchedRunning.status, 'running', 'Running order older than 30m must NOT expire');

            // Completed order
            const completedOrder = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/ttl-completed',
                proxyKey: 'ttl_completed_key',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(completedOrder.orderId);
            completedOrder.createdAt = twoHoursAgo;
            completedOrder.status = 'completed';
            completedOrder.paymentStatus = 'paid';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${completedOrder.orderId}.json`), JSON.stringify(completedOrder, null, 4));

            const fetchedCompleted = orderService.getOrder(completedOrder.orderId);
            assert.strictEqual(fetchedCompleted.status, 'completed', 'Completed order older than 30m must NOT expire');
        });

        it('batch sweep expireStaleOrders() expires only stale pending orders and preserves others', () => {
            const now = Date.now();
            const TTL = orderService.ORDER_TTL_MS;

            // Fresh pending
            const fresh = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/sweep-fresh', proxyKey: 'k1', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(fresh.orderId);
            fresh.createdAt = now - 5000;
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${fresh.orderId}.json`), JSON.stringify(fresh, null, 4));

            // Stale pending 1
            const stale1 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/sweep-stale1', proxyKey: 'k2', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(stale1.orderId);
            stale1.createdAt = now - (TTL + 10000);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${stale1.orderId}.json`), JSON.stringify(stale1, null, 4));

            // Stale pending 2
            const stale2 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/sweep-stale2', proxyKey: 'k3', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(stale2.orderId);
            stale2.createdAt = now - (TTL + 50000);
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${stale2.orderId}.json`), JSON.stringify(stale2, null, 4));

            // Old paid order
            const oldPaid = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/sweep-paid', proxyKey: 'k4', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(oldPaid.orderId);
            oldPaid.createdAt = now - (TTL + 60000);
            oldPaid.status = 'paid';
            oldPaid.paymentStatus = 'paid';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${oldPaid.orderId}.json`), JSON.stringify(oldPaid, null, 4));

            const expiredList = orderService.expireStaleOrders();
            assert.ok(expiredList.includes(stale1.orderId), 'stale1 must be expired');
            assert.ok(expiredList.includes(stale2.orderId), 'stale2 must be expired');
            assert.ok(!expiredList.includes(fresh.orderId), 'fresh order must NOT be expired');
            assert.ok(!expiredList.includes(oldPaid.orderId), 'oldPaid order must NOT be expired');

            assert.strictEqual(orderService.getOrder(fresh.orderId).status, 'pending_payment');
            assert.strictEqual(orderService.getOrder(oldPaid.orderId).status, 'paid');
        });

        it('rejects late payment confirmation on expired orders with HTTP 409 Conflict via API and throws 409 in service', async () => {
            const order = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/late-409',
                proxyKey: 'late_key',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order.orderId);

            // Mark expired
            order.status = 'expired';
            order.paymentStatus = 'expired';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${order.orderId}.json`), JSON.stringify(order, null, 4));

            // 1. Direct orderService call
            assert.throws(() => {
                orderService.confirmOrderPayment(order.orderId);
            }, (err) => {
                return err.statusCode === 409 && err.code === 'ORDER_EXPIRED';
            });

            // 2. HTTP API call
            const res = await env.request('POST', `/api/orders/${order.orderId}/confirm`, {
                cookie: env.adminCookie
            });
            assert.strictEqual(res.status, 409, 'Late confirm must return HTTP 409 Conflict');
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.message, /expired/i);
        });

        it('strictly audits GET /api/admin/orders summary counts to guarantee zero double-counting', async () => {
            // Setup a clear known population of orders
            const now = Date.now();

            // 2 fresh pending orders
            const p1 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/p1', proxyKey: 'kp1', targetClicks: 5, durationHours: 1 });
            const p2 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/p2', proxyKey: 'kp2', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(p1.orderId, p2.orderId);

            // 2 expired orders (unpaid)
            const e1 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/e1', proxyKey: 'ke1', targetClicks: 5, durationHours: 1 });
            const e2 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/e2', proxyKey: 'ke2', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(e1.orderId, e2.orderId);
            e1.createdAt = now - (40 * 60 * 1000);
            e1.status = 'expired';
            e1.paymentStatus = 'expired';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${e1.orderId}.json`), JSON.stringify(e1, null, 4));
            e2.createdAt = now - (50 * 60 * 1000);
            e2.status = 'expired';
            e2.paymentStatus = 'expired';
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${e2.orderId}.json`), JSON.stringify(e2, null, 4));

            // 1 completed order (paid)
            const c1 = orderService.createOrder({ targetUrl: 'https://traffic-test.example.com/c1', proxyKey: 'kc1', targetClicks: 5, durationHours: 1 });
            createdOrderIds.push(c1.orderId);
            c1.status = 'completed';
            c1.paymentStatus = 'paid';
            c1.paidAmount = c1.totalAmount;
            fs.writeFileSync(path.join(ROOT_DIR, 'orders', `${c1.orderId}.json`), JSON.stringify(c1, null, 4));

            const res = await env.request('GET', '/api/admin/orders', { cookie: env.adminCookie });
            assert.strictEqual(res.status, 200);

            const { summary, orders } = res.body;

            // Audit the 2 expired orders in the response
            const o_e1 = orders.find(o => o.orderId === e1.orderId);
            const o_e2 = orders.find(o => o.orderId === e2.orderId);
            assert.ok(o_e1 && o_e2, 'Expired orders must be in returned list');
            assert.strictEqual(o_e1.effectiveStatus, 'expired');
            assert.strictEqual(o_e2.effectiveStatus, 'expired');

            // Summary counts audit:
            // Expired orders MUST NOT contribute to pendingCount or completedCount
            assert.ok(summary.expiredCount >= 2, `expiredCount should be at least 2, got ${summary.expiredCount}`);
            // Invariant: totalOrders === paidCount + pendingCount + expiredCount
            assert.strictEqual(
                summary.totalOrders,
                summary.paidCount + summary.pendingCount + summary.expiredCount,
                'Summary counts must be strictly partitioned without overlap: total = paid + pending + expired'
            );
        });

        it('guarantees bank webhook replay idempotency (already: true) without txId', async () => {
            const webhookSecret = 'c2_test_webhook_secret_xyz';
            orderService.setPaymentConfig({ webhookSecret });

            const order = orderService.createOrder({
                targetUrl: 'https://traffic-test.example.com/webhook-replay',
                proxyKey: 'webhook_replay_key',
                targetClicks: 10,
                durationHours: 1
            });
            createdOrderIds.push(order.orderId);

            const webhookPayload = {
                transferType: 'in',
                transferAmount: order.totalAmount,
                content: `THANH TOAN DON HANG ${order.orderCode} XIN CAM ON`
                // Intentionally NO txId in payload
            };

            // 1. First webhook delivery: confirms payment and activates campaign
            const firstRes = await env.request('POST', '/api/payment/webhook', {
                headers: {
                    'Authorization': `Apikey ${webhookSecret}`
                },
                body: webhookPayload
            });

            assert.strictEqual(firstRes.status, 200);
            assert.strictEqual(firstRes.body.success, true);
            assert.strictEqual(firstRes.body.orderId, order.orderId);
            assert.strictEqual(firstRes.body.already, false, 'First webhook delivery must activate campaign (already: false)');
            assert.ok(firstRes.body.campaignId, 'First delivery must return activated campaignId');

            const initialCampaignId = firstRes.body.campaignId;
            const campaignsCountBefore = campaigns.size;

            // 2. Second webhook delivery (REPLAY of identical payload, no txId)
            const replayRes = await env.request('POST', '/api/payment/webhook', {
                headers: {
                    'Authorization': `Apikey ${webhookSecret}`
                },
                body: webhookPayload
            });

            assert.strictEqual(replayRes.status, 200);
            assert.strictEqual(replayRes.body.success, true);
            assert.strictEqual(replayRes.body.orderId, order.orderId);
            assert.strictEqual(replayRes.body.already, true, 'Replay webhook must be idempotent (already: true)');
            assert.strictEqual(replayRes.body.campaignId, initialCampaignId, 'Must return the same campaignId without re-activating');
            assert.strictEqual(campaigns.size, campaignsCountBefore, 'No duplicate campaign must be created on replay');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // DOMAIN 3: Proxy Dispatch Agent Selection & Invariants
    // ─────────────────────────────────────────────────────────────────────────
    describe('Domain 3: Proxy Dispatch Agent Selection & Invariants', () => {
        it('requires https-proxy-agent and http-proxy-agent packages in package.json', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
            assert.ok(pkg.dependencies['https-proxy-agent'], 'package.json must declare https-proxy-agent');
            assert.ok(pkg.dependencies['http-proxy-agent'], 'package.json must declare http-proxy-agent');
        });

        it('verifies server.js configures HttpsProxyAgent for https: and HttpProxyAgent for http: with proxy: false', () => {
            const serverCode = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf-8');

            // Verify HttpsProxyAgent instantiation for https target
            assert.match(
                serverCode,
                /httpsAgent:\s*new\s+HttpsProxyAgent\(`http:\/\/\$\{proxyHost\}:\$\{proxyPort\}`\),\s*proxy:\s*false/,
                'server.js must configure httpsAgent with HttpsProxyAgent and proxy: false'
            );

            // Verify HttpProxyAgent instantiation for http target
            assert.match(
                serverCode,
                /httpAgent:\s*new\s+HttpProxyAgent\(`http:\/\/\$\{proxyHost\}:\$\{proxyPort\}`\),\s*proxy:\s*false/,
                'server.js must configure httpAgent with HttpProxyAgent and proxy: false'
            );

            // Verify direct KiotProxy calls do not use customer proxy agent
            assert.match(
                serverCode,
                /axios\.get\(url,\s*\{\s*timeout:\s*10000\s*\}\)/,
                'KiotProxy calls must remain direct without customer proxy agent'
            );
        });

        it('verifies Chromium line invariant: ZERO occurrences outside lines containing sec-ch-ua', () => {
            const serverLines = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf-8').split(/\r?\n/);
            const violations = [];

            serverLines.forEach((line, idx) => {
                if (/chromium/i.test(line)) {
                    if (!line.includes("'sec-ch-ua'")) {
                        violations.push({ lineNum: idx + 1, content: line.trim() });
                    }
                }
            });

            assert.strictEqual(
                violations.length,
                0,
                `Found chromium in server.js outside 'sec-ch-ua' lines: ${JSON.stringify(violations)}`
            );
        });
    });
});
