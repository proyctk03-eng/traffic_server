(function (global) {
    'use strict';

    const S = global.BoostShared;
    const DEMO_STARTED_AT = Date.now();
    const demoTimers = new Map();

    const hooks = {
        isDemoMode: () => false,
        getActiveOrderId: () => null,
        isAdmin: () => false,
        onEmitLog: () => {},
        onOrderUpdated: () => {},
        onAdminUpdated: () => {}
    };

    function configure(nextHooks) {
        Object.assign(hooks, nextHooks || {});
    }

    function getDefaultDemoDb() {
        return {
            auth: { authenticated: false, role: null, username: null },
            bankInfo: {
                bankId: 'MB',
                bankName: 'MBBank',
                accountNumber: '0987654321',
                accountName: 'TRAFFIC SERVICE',
                template: 'compact2',
                webhookSecret: ''
            },
            proxyConfig: { region: 'random', keys: ['K_DEMO_KEY_SAMPLE_01'], cooldownSec: 14 },
            orders: [],
            campaigns: [],
            nextOrderSeq: 1001,
            nextCampSeq: 1
        };
    }

    function sanitizeAuthState(db) {
        if (!db.auth || !db.auth.authenticated || db.auth.role !== 'admin') {
            const changed = Boolean(db.auth && (db.auth.authenticated || db.auth.role || db.auth.username));
            db.auth = { authenticated: false, role: null, username: null };
            return changed;
        }
        return false;
    }

    function loadDemoDb() {
        const def = getDefaultDemoDb();
        let db = def;
        try {
            const raw = localStorage.getItem(S.STORAGE_KEYS.DEMO_DB);
            if (raw) {
                const parsed = JSON.parse(raw);
                db = Object.assign(def, parsed || {});
            }
        } catch (e) {
            db = def;
        }
        if (!Array.isArray(db.orders)) db.orders = [];
        if (!Array.isArray(db.campaigns)) db.campaigns = [];
        if (sanitizeAuthState(db)) {
            saveDemoDb(db);
        }
        return db;
    }

    function saveDemoDb(db) {
        try {
            localStorage.setItem(S.STORAGE_KEYS.DEMO_DB, JSON.stringify(db));
        } catch (e) {}
    }

    function expireStaleDemoOrders(db) {
        let dirty = false;
        const now = Date.now();
        for (const ord of db.orders) {
            if (!ord) continue;
            if (!ord.expiresAt && ord.createdAt) {
                ord.expiresAt = Number(ord.createdAt) + S.ORDER_EXPIRE_MS;
                dirty = true;
            }
            if (ord.paymentStatus !== 'paid' && ord.status === 'pending_payment' && ord.expiresAt && now >= Number(ord.expiresAt)) {
                ord.status = 'expired';
                dirty = true;
            }
        }
        if (dirty) saveDemoDb(db);
        return dirty;
    }

    function demoJsonRes(status, data) {
        return { res: { ok: status >= 200 && status < 300, status }, data };
    }

    function stopDemoCampaignTimer(orderId) {
        const t = demoTimers.get(orderId);
        if (t) {
            clearInterval(t);
            demoTimers.delete(orderId);
        }
    }

    function clearAllDemoTimers() {
        for (const t of demoTimers.values()) clearInterval(t);
        demoTimers.clear();
    }

    function startDemoCampaignSimulation(orderId) {
        if (!hooks.isDemoMode()) return;
        stopDemoCampaignTimer(orderId);
        const db0 = loadDemoDb();
        const ord0 = db0.orders.find(o => o.orderId === orderId);
        if (!ord0 || ord0.paymentStatus !== 'paid' || ord0.status !== 'running') return;
        const cid = ord0.campaignId;
        const dwellLabel = S.formatDwellLabel(ord0.dwellPreset);
        const deviceLabel = S.formatDeviceLabel(ord0.deviceProfile);
        hooks.onEmitLog(
            cid,
            `[DEMO SIM] Khoi chay chien dich mo phong -> ${ord0.targetUrl} (${ord0.targetClicks} luot, ${ord0.scheduleMode}, ${dwellLabel}, ${deviceLabel})`,
            'system'
        );

        const batchStep = Math.max(1, Math.ceil((ord0.targetClicks || 1) / 14));
        const timer = setInterval(() => {
            if (!hooks.isDemoMode()) {
                stopDemoCampaignTimer(orderId);
                return;
            }
            const db = loadDemoDb();
            const ord = db.orders.find(o => o.orderId === orderId);
            const camp = db.campaigns.find(c => String(c.id) === String(cid));
            if (!ord || !camp || ord.status !== 'running') {
                stopDemoCampaignTimer(orderId);
                return;
            }
            const remaining = Math.max(0, ord.targetClicks - (ord.successVisits || 0));
            const inc = Math.min(remaining, batchStep);
            if (inc > 0) {
                ord.successVisits = (ord.successVisits || 0) + inc;
                ord.totalVisits = (ord.totalVisits || 0) + inc;
                ord.uniqueIps = (ord.uniqueIps || 0) + inc;
                camp.successVisits = ord.successVisits;
                camp.totalVisits = ord.totalVisits;
                camp.uniqueIps = ord.uniqueIps;
                const fakeIp = `203.0.113.${(ord.successVisits % 250) + 1}`;
                hooks.onEmitLog(
                    cid,
                    `[DEMO SIM] Quay IP gia lap ${fakeIp} -> HTTP 200 OK (+${inc} luot: ${ord.successVisits}/${ord.targetClicks})`,
                    'success'
                );
            }
            if (ord.successVisits >= ord.targetClicks) {
                ord.status = 'completed';
                ord.completedAt = Date.now();
                camp.status = 'completed';
                camp.actualEndTime = ord.completedAt;
                saveDemoDb(db);
                stopDemoCampaignTimer(orderId);
                hooks.onEmitLog(cid, `[DEMO SIM] Hoan thanh ${ord.successVisits}/${ord.targetClicks} luot mo phong!`, 'success');
            } else {
                saveDemoDb(db);
            }
            if (hooks.getActiveOrderId() === orderId) {
                hooks.onOrderUpdated(orderId);
            }
            if (hooks.isAdmin()) {
                hooks.onAdminUpdated();
            }
        }, 380);
        demoTimers.set(orderId, timer);
    }

    function resumeRunningDemoCampaigns() {
        if (!hooks.isDemoMode()) return;
        const db = loadDemoDb();
        expireStaleDemoOrders(db);
        for (const ord of db.orders) {
            if (ord.paymentStatus === 'paid' && ord.status === 'running') {
                startDemoCampaignSimulation(ord.orderId);
            }
        }
    }

    function buildDemoOrderPublic(ord, camp) {
        const { proxyKey, ...rest } = ord;
        const c = camp || {};
        const expiresAt = ord.expiresAt || ((ord.createdAt || Date.now()) + S.ORDER_EXPIRE_MS);
        const dwellPreset = S.normalizeDwellPreset(ord.dwellPreset);
        const deviceProfile = S.normalizeDeviceProfile(ord.deviceProfile);
        const effectiveStatus = S.getEffectiveOrderStatus({ ...ord, expiresAt, progress: c });
        return {
            ...rest,
            dwellPreset,
            deviceProfile,
            expiresAt,
            effectiveStatus,
            proxyKeyMasked: S.maskProxyKey(proxyKey),
            progress: {
                orderId: ord.orderId,
                campaignId: ord.campaignId,
                status: effectiveStatus,
                successVisits: c.successVisits ?? ord.successVisits ?? 0,
                failedVisits: c.failedVisits ?? ord.failedVisits ?? 0,
                totalVisits: c.totalVisits ?? ord.totalVisits ?? 0,
                uniqueIps: c.uniqueIps ?? ord.uniqueIps ?? 0,
                dupIps: c.dupIps ?? ord.dupIps ?? 0,
                targetLimit: ord.targetClicks,
                browserMode: 'request (demo-sim)',
                scheduleMode: ord.scheduleMode || 'smart',
                dwellPreset,
                deviceProfile,
                startTime: c.startTime || null,
                endTime: c.endTime || null,
                actualStartTime: c.actualStartTime || ord.paidAt || null,
                actualEndTime: c.actualEndTime || ord.completedAt || null
            }
        };
    }

    function demoApiDispatch(path, opts = {}) {
        const method = String(opts.method || 'GET').toUpperCase();
        let body = {};
        if (opts.body && typeof opts.body === 'string') {
            try { body = JSON.parse(opts.body); } catch (e) {}
        }
        const db = loadDemoDb();
        expireStaleDemoOrders(db);
        const isAdmin = Boolean(db.auth && db.auth.authenticated && db.auth.role === 'admin');
        const { webhookSecret, ...publicBank } = db.bankInfo;

        if (path === '/api/health' && method === 'GET') {
            const activeCampaigns = db.campaigns.length;
            const runningCampaigns = db.campaigns.filter(c => c.status === 'running').length;
            const pendingOrders = db.orders.filter(o => o.paymentStatus !== 'paid' && S.getEffectiveOrderStatus(o) === 'pending_payment').length;
            return demoJsonRes(200, {
                success: true,
                status: 'ok',
                mode: 'demo',
                uptimeSec: Math.max(0, Math.floor((Date.now() - DEMO_STARTED_AT) / 1000)),
                activeCampaigns,
                runningCampaigns,
                pendingOrders,
                guestEnabled: false
            });
        }

        if (path === '/api/public-config' && method === 'GET') {
            return demoJsonRes(200, {
                success: true,
                authenticated: isAdmin,
                role: isAdmin ? 'admin' : null,
                username: isAdmin ? (db.auth.username || 'admin') : null,
                singleAccountMode: true,
                guestEnabled: false,
                orderExpireMinutes: S.ORDER_EXPIRE_MINUTES,
                defaultPasswordWarning: false,
                browserMode: 'request',
                pricing: {
                    clickRate: S.PRICING.clickRate,
                    hourlyRate: S.PRICING.hourlyRate,
                    currency: S.PRICING.currency
                },
                bankInfo: publicBank
            });
        }

        if (path === '/api/login' && method === 'POST') {
            const u = String(body.username || '').trim();
            const p = String(body.password || '');
            if (u === 'admin' && p === 'admin123456') {
                db.auth = { authenticated: true, role: 'admin', username: 'admin' };
                saveDemoDb(db);
                return demoJsonRes(200, { success: true, role: 'admin', username: 'admin' });
            }
            return demoJsonRes(401, {
                success: false,
                message: 'Sai tài khoản Static Demo (chỉ hỗ trợ 1 tài khoản Admin: admin / admin123456).'
            });
        }

        if (path === '/api/logout' && method === 'POST') {
            db.auth = { authenticated: false, role: null, username: null };
            saveDemoDb(db);
            return demoJsonRes(200, { success: true });
        }

        if (path === '/api/proxy/validate' && method === 'POST') {
            const proxyKey = String(body.proxyKey || '').trim();
            if (!proxyKey) {
                return demoJsonRes(400, {
                    success: false,
                    valid: false,
                    realIpAddress: null,
                    ip: null,
                    location: null,
                    ttl: null,
                    ttc: null,
                    message: 'Vui lòng nhập KiotProxy Key.'
                });
            }
            const suffix = proxyKey.length >= 4 ? proxyKey.slice(-2) : '11';
            const octet = ((suffix.charCodeAt(0) + (suffix.charCodeAt(1) || 0)) % 220) + 10;
            const simIp = `14.232.${octet}.${(proxyKey.length % 200) + 20}`;
            return demoJsonRes(200, {
                success: true,
                valid: true,
                realIpAddress: simIp,
                ip: `${simIp}:48001`,
                location: 'VN (Static Demo)',
                ttl: 120,
                ttc: 15,
                message: `[Static Demo] Key ${S.maskProxyKey(proxyKey)} hợp lệ — IP mô phỏng ${simIp}`
            });
        }

        if (path === '/api/orders/calculate-cost' && method === 'POST') {
            const calc = S.calculateOrderCost(body.targetClicks, body.durationHours);
            if (calc.error) return demoJsonRes(400, { success: false, message: calc.error });
            return demoJsonRes(200, { success: true, ...calc });
        }

        if (path === '/api/orders' && method === 'POST') {
            const validation = S.validateOrderPayload(body);
            if (!validation.valid) {
                return demoJsonRes(400, { success: false, message: validation.errors[0] });
            }
            const calc = validation.cost;
            const pKey = String(body.proxyKey || '').trim();
            const createdAt = Date.now();
            const expiresAt = createdAt + S.ORDER_EXPIRE_MS;
            const orderId = 'ORD-' + createdAt + '-' + Math.random().toString(16).slice(2, 10);
            const orderCode = 'TF' + (db.nextOrderSeq++);
            const dwellPreset = S.normalizeDwellPreset(body.dwellPreset);
            const deviceProfile = S.normalizeDeviceProfile(body.deviceProfile);
            const vietQrUrl = `https://img.vietqr.io/image/${encodeURIComponent(publicBank.bankId)}-${encodeURIComponent(publicBank.accountNumber)}-${encodeURIComponent(publicBank.template || 'compact2')}.png?amount=${calc.totalAmount}&addInfo=${encodeURIComponent(orderCode)}&accountName=${encodeURIComponent((publicBank.accountName || '').toUpperCase())}`;

            const order = {
                orderId,
                orderCode,
                name: String(body.name || '').trim() || `Demo_${orderCode}`,
                targetUrl: String(body.targetUrl).trim(),
                proxyKey: pKey,
                targetClicks: calc.targetClicks,
                durationHours: calc.durationHours,
                roundedHours: calc.roundedHours,
                clickFee: calc.clickFee,
                durationFee: calc.durationFee,
                totalAmount: calc.totalAmount,
                currency: S.PRICING.currency,
                browserMode: 'request',
                scheduleMode: ['even', 'custom'].includes(body.scheduleMode) ? body.scheduleMode : 'smart',
                customBlocks: body.customBlocks || null,
                dwellPreset,
                deviceProfile,
                dedupIp: body.dedupIp !== false,
                randomLinks: body.randomLinks !== false,
                vietQrUrl,
                bankInfo: publicBank,
                status: 'pending_payment',
                paymentStatus: 'pending_payment',
                campaignId: null,
                createdAt,
                expiresAt,
                paidAt: null,
                successVisits: 0,
                failedVisits: 0,
                totalVisits: 0,
                uniqueIps: 0,
                dupIps: 0
            };
            db.orders.unshift(order);
            saveDemoDb(db);
            return demoJsonRes(201, { success: true, ...buildDemoOrderPublic(order, null) });
        }

        const getOrderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
        if (getOrderMatch && method === 'GET') {
            const oid = decodeURIComponent(getOrderMatch[1]);
            const ord = db.orders.find(o => o.orderId === oid);
            if (!ord) return demoJsonRes(404, { success: false, message: 'Order not found' });
            const camp = ord.campaignId ? db.campaigns.find(c => String(c.id) === String(ord.campaignId)) : null;
            return demoJsonRes(200, { success: true, order: buildDemoOrderPublic(ord, camp) });
        }

        // Everything below requires single admin auth in Static Demo (mirrors backend RBAC)
        if (!isAdmin) {
            return demoJsonRes(403, { success: false, message: 'Vui lòng đăng nhập tài khoản Admin demo (admin / admin123456).' });
        }

        const confirmMatch = path.match(/^\/api\/orders\/([^/]+)\/confirm$/);
        if (confirmMatch && method === 'POST') {
            const oid = decodeURIComponent(confirmMatch[1]);
            const ord = db.orders.find(o => o.orderId === oid);
            if (!ord) return demoJsonRes(404, { success: false, message: 'Order not found' });
            if (S.getEffectiveOrderStatus(ord) === 'expired') {
                return demoJsonRes(400, { success: false, message: 'Đơn hàng đã hết hạn thanh toán (quá 30 phút).' });
            }
            if (!ord.campaignId) {
                const cid = String(db.nextCampSeq++);
                const now = Date.now();
                ord.paymentStatus = 'paid';
                ord.status = 'running';
                ord.paidAt = now;
                ord.campaignId = cid;
                db.campaigns.unshift({
                    id: cid,
                    name: ord.name,
                    targetUrl: ord.targetUrl,
                    status: 'running',
                    dwellPreset: S.normalizeDwellPreset(ord.dwellPreset),
                    deviceProfile: S.normalizeDeviceProfile(ord.deviceProfile),
                    successVisits: 0,
                    failedVisits: 0,
                    totalVisits: 0,
                    uniqueIps: 0,
                    dupIps: 0,
                    targetLimit: ord.targetClicks,
                    startTime: now,
                    actualStartTime: now,
                    endTime: now + Math.round(ord.durationHours * 3600000)
                });
                saveDemoDb(db);
                startDemoCampaignSimulation(ord.orderId);
            }
            return demoJsonRes(200, { success: true, orderId: ord.orderId, campaignId: ord.campaignId });
        }

        if (path === '/api/admin/orders' && method === 'GET') {
            const orders = db.orders.map(o => {
                const camp = o.campaignId ? db.campaigns.find(c => String(c.id) === String(o.campaignId)) : null;
                return buildDemoOrderPublic(o, camp);
            });
            const summary = {
                totalOrders: orders.length,
                totalRevenue: orders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + Number(o.totalAmount || 0), 0),
                paidCount: orders.filter(o => o.paymentStatus === 'paid').length,
                pendingCount: orders.filter(o => o.paymentStatus !== 'paid' && o.effectiveStatus === 'pending_payment').length,
                runningCount: orders.filter(o => ['running', 'waiting'].includes(o.effectiveStatus)).length,
                completedCount: orders.filter(o => ['completed', 'stopped', 'expired'].includes(o.effectiveStatus)).length
            };
            return demoJsonRes(200, { success: true, summary, orders });
        }

        const delMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (delMatch && method === 'DELETE') {
            const oid = decodeURIComponent(delMatch[1]);
            const idx = db.orders.findIndex(o => o.orderId === oid);
            if (idx === -1) return demoJsonRes(404, { success: false, message: 'Order not found' });
            const removed = db.orders.splice(idx, 1)[0];
            stopDemoCampaignTimer(oid);
            if (removed.campaignId) {
                db.campaigns = db.campaigns.filter(c => String(c.id) !== String(removed.campaignId));
            }
            saveDemoDb(db);
            return demoJsonRes(200, { success: true });
        }

        if (path === '/api/campaigns' && method === 'GET') {
            return demoJsonRes(200, { success: true, data: db.campaigns });
        }

        const stopMatch = path.match(/^\/api\/campaigns\/([^/]+)\/stop$/);
        if (stopMatch && method === 'POST') {
            const cid = decodeURIComponent(stopMatch[1]);
            const camp = db.campaigns.find(c => String(c.id) === String(cid));
            if (!camp) return demoJsonRes(404, { success: false, message: 'Campaign not found' });
            camp.status = 'stopped';
            camp.actualEndTime = Date.now();
            const ord = db.orders.find(o => String(o.campaignId) === String(cid));
            if (ord) {
                ord.status = 'stopped';
                stopDemoCampaignTimer(ord.orderId);
            }
            saveDemoDb(db);
            hooks.onEmitLog(cid, '[DEMO SIM] Admin da dung chien dich.', 'warn');
            return demoJsonRes(200, { success: true });
        }

        const resetMatch = path.match(/^\/api\/campaigns\/([^/]+)\/reset-stats$/);
        if (resetMatch && method === 'POST') {
            const cid = decodeURIComponent(resetMatch[1]);
            const camp = db.campaigns.find(c => String(c.id) === String(cid));
            if (!camp) return demoJsonRes(404, { success: false, message: 'Campaign not found' });
            camp.successVisits = 0;
            camp.failedVisits = 0;
            camp.totalVisits = 0;
            camp.uniqueIps = 0;
            camp.dupIps = 0;
            const ord = db.orders.find(o => String(o.campaignId) === String(cid));
            if (ord) {
                ord.successVisits = 0;
                ord.failedVisits = 0;
                ord.totalVisits = 0;
                ord.uniqueIps = 0;
                ord.dupIps = 0;
            }
            saveDemoDb(db);
            return demoJsonRes(200, { success: true });
        }

        if (path === '/api/admin/payment-config' && method === 'GET') {
            return demoJsonRes(200, { success: true, config: db.bankInfo });
        }

        if (path === '/api/admin/payment-config' && method === 'POST') {
            db.bankInfo = Object.assign({}, db.bankInfo, {
                bankId: String(body.bankId || 'MB').toUpperCase(),
                bankName: String(body.bankName || body.bankId || 'MBBank'),
                accountNumber: String(body.accountNumber || ''),
                accountName: String(body.accountName || '').toUpperCase(),
                template: body.template || 'compact2',
                webhookSecret: body.webhookSecret || ''
            });
            saveDemoDb(db);
            return demoJsonRes(200, { success: true, config: db.bankInfo });
        }

        if (path === '/api/proxy-config' && method === 'GET') {
            return demoJsonRes(200, { success: true, data: db.proxyConfig });
        }

        if (path === '/api/proxy-config' && method === 'POST') {
            db.proxyConfig = {
                region: body.region || 'random',
                keys: Array.isArray(body.keys) ? body.keys : [],
                cooldownSec: Number.isFinite(body.cooldownSec) ? body.cooldownSec : 14
            };
            saveDemoDb(db);
            return demoJsonRes(200, { success: true, message: `[Static Demo] Đã lưu ${db.proxyConfig.keys.length} proxy key mô phỏng.` });
        }

        return demoJsonRes(404, { success: false, message: 'Endpoint not mocked in Static Demo' });
    }

    global.BoostDemo = {
        configure,
        loadDemoDb,
        saveDemoDb,
        stopDemoCampaignTimer,
        clearAllDemoTimers,
        startDemoCampaignSimulation,
        resumeRunningDemoCampaigns,
        dispatch: demoApiDispatch
    };
})(window);
