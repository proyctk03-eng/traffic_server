(function () {
    'use strict';

    const RECENT_ORDERS_KEY = 'boost_recent_orders_v1';
    const REMOTE_BACKEND_KEY = 'boost_remote_backend_v1';
    const REMOTE_TOKEN_KEY_PREFIX = 'boost_remote_token_v1:';
    const DEMO_DB_KEY = 'boost_demo_db_v1';
    const MAX_RECENT_ORDERS = 12;

    const state = {
        mode: 'same-origin', // 'same-origin' | 'remote' | 'demo'
        backendUrl: '',
        bearerToken: '',
        remoteSocketLoadedFor: '',
        config: {
            authenticated: false,
            role: null,
            username: null,
            pricing: { clickRate: 40, hourlyRate: 2000, currency: 'VND' },
            browserMode: 'request',
            bankInfo: null
        },
        activeOrder: null,
        activeOrderId: null,
        pollTimer: null,
        countdownTimer: null,
        costDebounce: null,
        costRequestSeq: 0,
        socket: null,
        adminOrders: [],
        adminCampaigns: [],
        adminLoadingPromise: null,
        expandPreviewSlices: false,
        campaignLogs: new Map(),
        demoTimers: new Map(),
        activeTab: 'customer'
    };

    const $ = (id) => document.getElementById(id);

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtVnd(amount) {
        const n = Number(amount || 0);
        return n.toLocaleString('vi-VN') + ' VNĐ';
    }

    function fmtTime(ts) {
        if (!ts) return '--';
        try { return new Date(ts).toLocaleString('vi-VN'); } catch (e) { return '--'; }
    }

    function showAlert(containerId, msg, kind = 'info') {
        const el = $(containerId);
        if (!el) return;
        if (!msg) {
            el.innerHTML = '';
            return;
        }
        el.innerHTML = `<div class="alert ${esc(kind)}">${esc(msg)}</div>`;
    }

    function normalizeBackendUrl(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        try {
            const u = new URL(s);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return u.origin;
        } catch (e) {
            return '';
        }
    }

    function isStaticHostingEnv() {
        if (window.__STATIC_DEMO_MODE__ === true) return true;
        if (window.location.protocol === 'file:') return true;
        return /\.(pages\.dev|github\.io)$/i.test(window.location.hostname || '');
    }

    function loadSavedRemoteToken(backendOrigin) {
        if (!backendOrigin) return '';
        try { return sessionStorage.getItem(REMOTE_TOKEN_KEY_PREFIX + backendOrigin) || ''; } catch (e) { return ''; }
    }

    function saveRemoteToken(backendOrigin, token) {
        if (!backendOrigin) return;
        try {
            if (token) sessionStorage.setItem(REMOTE_TOKEN_KEY_PREFIX + backendOrigin, token);
            else sessionStorage.removeItem(REMOTE_TOKEN_KEY_PREFIX + backendOrigin);
        } catch (e) {}
    }

    function renderRuntimeModeUI() {
        const pill = $('runtime-mode-pill');
        const desc = $('runtime-mode-desc');
        const input = $('backend-url-input');
        const sameBtn = $('use-same-origin-btn');
        const demoBtn = $('use-demo-mode-btn');
        if (input && state.backendUrl && document.activeElement !== input) {
            input.value = state.backendUrl;
        } else if (input && !state.backendUrl && state.mode !== 'remote' && document.activeElement !== input) {
            input.value = '';
        }

        const canUseSameOrigin = !isStaticHostingEnv();
        if (sameBtn) sameBtn.classList.toggle('hidden', !canUseSameOrigin || state.mode === 'same-origin');
        if (demoBtn) demoBtn.classList.toggle('hidden', state.mode === 'demo');

        document.querySelectorAll('.server-only-nav').forEach(link => {
            const origHref = link.dataset.origHref || link.getAttribute('href');
            link.dataset.origHref = origHref;
            if (state.mode === 'demo') {
                link.classList.add('hidden');
            } else if (state.mode === 'remote' && state.backendUrl) {
                link.classList.remove('hidden');
                link.setAttribute('href', state.backendUrl + origHref);
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener');
            } else {
                link.classList.remove('hidden');
                link.setAttribute('href', origHref);
                link.removeAttribute('target');
            }
        });

        if (state.mode === 'remote') {
            pill.className = 'pill info';
            pill.textContent = 'Chế độ: Remote Tunnel';
            desc.textContent = `Đang nối Backend thật tại ${state.backendUrl} (CORS + Bearer Token).`;
        } else if (state.mode === 'demo') {
            pill.className = 'pill warn';
            pill.textContent = 'Chế độ: Static Demo (Giả lập)';
            desc.textContent = 'Đang chạy độc lập trên trình duyệt (localStorage, không gửi traffic thật). Nhập URL Cloudflare Tunnel để chạy thật.';
        } else {
            pill.className = 'pill ok';
            pill.textContent = 'Chế độ: Live Backend';
            desc.textContent = 'Kết nối trực tiếp server Node.js & KiotProxy thật (Same-Origin).';
        }
    }

    // ─── Static Demo Fallback Engine (Cloudflare Pages / GitHub Pages) ─────────
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

    function loadDemoDb() {
        const def = getDefaultDemoDb();
        try {
            const raw = localStorage.getItem(DEMO_DB_KEY);
            if (!raw) return def;
            const parsed = JSON.parse(raw);
            return Object.assign(def, parsed || {});
        } catch (e) {
            return def;
        }
    }

    function saveDemoDb(db) {
        try { localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db)); } catch (e) {}
    }

    function demoJsonRes(status, data) {
        return { res: { ok: status >= 200 && status < 300, status }, data };
    }

    function demoMaskProxyKey(key) {
        const s = String(key || '').trim();
        return s.length > 4 ? '...' + s.slice(-4) : '****';
    }

    function demoCalcCost(targetClicks, durationHours) {
        const clicks = Number(targetClicks);
        const hours = Number(durationHours);
        if (!Number.isInteger(clicks) || clicks < 1) {
            return { error: 'targetClicks must be a positive integer greater than or equal to 1' };
        }
        if (!Number.isFinite(hours) || hours <= 0) {
            return { error: 'durationHours must be a positive number greater than 0' };
        }
        const roundedHours = Math.ceil(hours);
        const clickFee = clicks * 40;
        const durationFee = roundedHours * 2000;
        return {
            targetClicks: clicks,
            durationHours: hours,
            roundedHours,
            clickRate: 40,
            hourlyRate: 2000,
            clickFee,
            durationFee,
            totalAmount: clickFee + durationFee
        };
    }

    function stopDemoCampaignTimer(orderId) {
        const t = state.demoTimers.get(orderId);
        if (t) {
            clearInterval(t);
            state.demoTimers.delete(orderId);
        }
    }

    function clearAllDemoTimers() {
        for (const t of state.demoTimers.values()) clearInterval(t);
        state.demoTimers.clear();
    }

    function emitDemoLog(campId, text, type = 'info') {
        const entry = { campaignId: campId, text, type };
        const rec = recordCampaignLog(entry);
        const line = rec ? rec.line : `[C${campId}] ${text}`;
        const time = rec ? rec.time : null;
        appendLogLine('adm-global-log', line, type, time);
        if (state.activeOrder) {
            const activeCampId = (state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId;
            if (activeCampId && String(campId) === String(activeCampId)) {
                const box = $('ao-worker-log');
                if (box && box.dataset.campId !== String(activeCampId)) hydrateOrderWorkerLogs(activeCampId);
                else appendLogLine('ao-worker-log', line, type, time);
            }
        }
    }

    function startDemoCampaignSimulation(orderId) {
        if (state.mode !== 'demo') return;
        stopDemoCampaignTimer(orderId);
        const db0 = loadDemoDb();
        const ord0 = db0.orders.find(o => o.orderId === orderId);
        if (!ord0 || ord0.paymentStatus !== 'paid' || ord0.status !== 'running') return;
        const cid = ord0.campaignId;
        emitDemoLog(cid, `[DEMO SIM] Khoi chay chien dich mo phong -> ${ord0.targetUrl} (${ord0.targetClicks} luot, ${ord0.scheduleMode})`, 'system');

        const batchStep = Math.max(1, Math.ceil((ord0.targetClicks || 1) / 14));
        const timer = setInterval(() => {
            if (state.mode !== 'demo') {
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
                emitDemoLog(cid, `[DEMO SIM] Quay IP gia lap ${fakeIp} -> HTTP 200 OK (+${inc} luot: ${ord.successVisits}/${ord.targetClicks})`, 'success');
            }
            if (ord.successVisits >= ord.targetClicks) {
                ord.status = 'completed';
                ord.completedAt = Date.now();
                camp.status = 'completed';
                camp.actualEndTime = ord.completedAt;
                saveDemoDb(db);
                stopDemoCampaignTimer(orderId);
                emitDemoLog(cid, `[DEMO SIM] Hoan thanh ${ord.successVisits}/${ord.targetClicks} luot mo phong!`, 'success');
            } else {
                saveDemoDb(db);
            }
            if (state.activeOrderId === orderId) fetchActiveOrder(orderId);
            if (state.config.role === 'admin') {
                loadAdminOrders();
                loadAdminCampaigns();
            }
        }, 380);
        state.demoTimers.set(orderId, timer);
    }

    function buildDemoOrderPublic(ord, camp) {
        const { proxyKey, ...rest } = ord;
        const c = camp || {};
        return {
            ...rest,
            proxyKeyMasked: demoMaskProxyKey(proxyKey),
            progress: {
                orderId: ord.orderId,
                campaignId: ord.campaignId,
                status: c.status || ord.status,
                successVisits: c.successVisits ?? ord.successVisits ?? 0,
                failedVisits: c.failedVisits ?? ord.failedVisits ?? 0,
                totalVisits: c.totalVisits ?? ord.totalVisits ?? 0,
                uniqueIps: c.uniqueIps ?? ord.uniqueIps ?? 0,
                dupIps: c.dupIps ?? ord.dupIps ?? 0,
                targetLimit: ord.targetClicks,
                browserMode: 'request (demo-sim)',
                scheduleMode: ord.scheduleMode || 'smart',
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
        const isAdmin = db.auth && db.auth.authenticated && db.auth.role === 'admin';
        const { webhookSecret, ...publicBank } = db.bankInfo;

        if (path === '/api/public-config' && method === 'GET') {
            return demoJsonRes(200, {
                success: true,
                authenticated: Boolean(db.auth && db.auth.authenticated),
                role: (db.auth && db.auth.role) || null,
                username: (db.auth && db.auth.username) || null,
                singleAccountMode: true,
                browserMode: 'request',
                pricing: { clickRate: 40, hourlyRate: 2000, currency: 'VND' },
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
            if (u === '1' && p === '1') {
                db.auth = { authenticated: true, role: 'guest', username: '1' };
                saveDemoDb(db);
                return demoJsonRes(200, { success: true, role: 'guest', username: '1' });
            }
            return demoJsonRes(401, { success: false, message: 'Sai tài khoản Static Demo (dùng admin / admin123456 hoặc guest 1/1).' });
        }
        if (path === '/api/logout' && method === 'POST') {
            db.auth = { authenticated: false, role: null, username: null };
            saveDemoDb(db);
            return demoJsonRes(200, { success: true });
        }
        if (path === '/api/orders/calculate-cost' && method === 'POST') {
            const calc = demoCalcCost(body.targetClicks, body.durationHours);
            if (calc.error) return demoJsonRes(400, { success: false, message: calc.error });
            return demoJsonRes(200, { success: true, ...calc });
        }
        if (path === '/api/orders' && method === 'POST') {
            let validUrl = false;
            try {
                const u = new URL(String(body.targetUrl || '').trim());
                validUrl = u.protocol === 'http:' || u.protocol === 'https:';
            } catch (e) {}
            if (!validUrl) return demoJsonRes(400, { success: false, message: 'URL đích phải bắt đầu bằng http:// hoặc https://.' });
            const pKey = String(body.proxyKey || '').trim();
            if (!pKey) return demoJsonRes(400, { success: false, message: 'Vui lòng nhập KiotProxy Key.' });
            const calc = demoCalcCost(body.targetClicks, body.durationHours);
            if (calc.error) return demoJsonRes(400, { success: false, message: calc.error });

            const orderId = 'ORD-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10);
            const orderCode = 'TF' + (db.nextOrderSeq++);
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
                currency: 'VND',
                browserMode: 'request',
                scheduleMode: ['even', 'custom'].includes(body.scheduleMode) ? body.scheduleMode : 'smart',
                customBlocks: body.customBlocks || null,
                dedupIp: body.dedupIp !== false,
                randomLinks: body.randomLinks !== false,
                vietQrUrl,
                bankInfo: publicBank,
                status: 'pending_payment',
                paymentStatus: 'pending_payment',
                campaignId: null,
                createdAt: Date.now(),
                paidAt: null,
                successVisits: 0,
                failedVisits: 0,
                totalVisits: 0,
                uniqueIps: 0,
                dupIps: 0
            };
            db.orders.unshift(order);
            saveDemoDb(db);
            return demoJsonRes(201, { success: true, ...order });
        }
        const getOrderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
        if (getOrderMatch && method === 'GET') {
            const oid = decodeURIComponent(getOrderMatch[1]);
            const ord = db.orders.find(o => o.orderId === oid);
            if (!ord) return demoJsonRes(404, { success: false, message: 'Order not found' });
            const camp = ord.campaignId ? db.campaigns.find(c => String(c.id) === String(ord.campaignId)) : null;
            return demoJsonRes(200, { success: true, order: buildDemoOrderPublic(ord, camp) });
        }

        // Everything below requires admin in Static Demo too (mirrors backend RBAC)
        if (!isAdmin) {
            return demoJsonRes(403, { success: false, message: 'Vui lòng đăng nhập tài khoản Admin demo (admin / admin123456).' });
        }

        const confirmMatch = path.match(/^\/api\/orders\/([^/]+)\/confirm$/);
        if (confirmMatch && method === 'POST') {
            const oid = decodeURIComponent(confirmMatch[1]);
            const ord = db.orders.find(o => o.orderId === oid);
            if (!ord) return demoJsonRes(404, { success: false, message: 'Order not found' });
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
                const pub = buildDemoOrderPublic(o, camp);
                pub.effectiveStatus = pub.progress.status;
                return pub;
            });
            const summary = {
                totalOrders: orders.length,
                totalRevenue: orders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + Number(o.totalAmount || 0), 0),
                paidCount: orders.filter(o => o.paymentStatus === 'paid').length,
                pendingCount: orders.filter(o => o.paymentStatus !== 'paid').length,
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
            emitDemoLog(cid, '[DEMO SIM] Admin da dung chien dich.', 'warn');
            return demoJsonRes(200, { success: true });
        }
        const resetMatch = path.match(/^\/api\/campaigns\/([^/]+)\/reset-stats$/);
        if (resetMatch && method === 'POST') {
            const cid = decodeURIComponent(resetMatch[1]);
            const camp = db.campaigns.find(c => String(c.id) === String(cid));
            if (!camp) return demoJsonRes(404, { success: false, message: 'Campaign not found' });
            camp.successVisits = 0; camp.failedVisits = 0; camp.totalVisits = 0; camp.uniqueIps = 0; camp.dupIps = 0;
            const ord = db.orders.find(o => String(o.campaignId) === String(cid));
            if (ord) { ord.successVisits = 0; ord.failedVisits = 0; ord.totalVisits = 0; ord.uniqueIps = 0; ord.dupIps = 0; }
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

    async function apiJson(path, opts = {}) {
        if (state.mode === 'demo') {
            return demoApiDispatch(path, opts);
        }
        const url = state.mode === 'remote' && state.backendUrl ? (state.backendUrl + path) : path;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (state.mode === 'remote' && state.bearerToken && !headers.Authorization) {
            headers.Authorization = 'Bearer ' + state.bearerToken;
        }
        const res = await fetch(url, { ...opts, headers });
        let data = null;
        try { data = await res.json(); } catch (e) { data = { success: false, message: 'Invalid JSON response' }; }
        return { res, data };
    }

    // ─── Public Config & Single-Account Auth State ────────────────────────────
    async function refreshPublicConfig() {
        if (state.mode === 'remote') {
            try {
                const { res, data } = await apiJson('/api/public-config');
                if (res.ok && data && data.success) {
                    state.config = data;
                    renderAuthState();
                    return true;
                }
            } catch (e) {
                // Handled below
            }
            renderAuthState();
            return false;
        }
        try {
            const { res, data } = await apiJson('/api/public-config');
            if (res.ok && data && data.success) {
                state.config = data;
            }
        } catch (e) {
            // Keep existing fallback pricing/config
        }
        renderAuthState();
        return true;
    }

    function renderAuthState() {
        const { authenticated, role, username, pricing } = state.config;
        const authPill = $('auth-pill');
        const loginBtn = $('open-login-btn');
        const logoutBtn = $('logout-btn');

        if (pricing) {
            $('spec-pricing').textContent =
                `${Number(pricing.clickRate || 40).toLocaleString('vi-VN')} VNĐ/click + Math.ceil(giờ) × ${Number(pricing.hourlyRate || 2000).toLocaleString('vi-VN')} VNĐ`;
            $('c-rate').textContent = Number(pricing.clickRate || 40).toLocaleString('vi-VN');
            $('c-hrate').textContent = Number(pricing.hourlyRate || 2000).toLocaleString('vi-VN');
        }

        const isAdmin = authenticated && role === 'admin';
        if (isAdmin) {
            authPill.className = 'pill ok';
            authPill.textContent = `Admin: ${username || 'admin'} (1 tài khoản)`;
            loginBtn.classList.add('hidden');
            logoutBtn.classList.remove('hidden');
            $('admin-gate-box').classList.add('hidden');
            $('admin-workspace').classList.remove('hidden');
            loadAdminDashboard();
        } else if (authenticated && role === 'guest') {
            authPill.className = 'pill warn';
            authPill.textContent = `Guest: ${username || '1'} (Chỉ xem)`;
            loginBtn.classList.remove('hidden');
            loginBtn.textContent = 'Đổi sang Admin';
            logoutBtn.classList.remove('hidden');
            $('admin-gate-box').classList.remove('hidden');
            $('admin-workspace').classList.add('hidden');
            showAlert('admin-gate-msg', 'Bạn đang đăng nhập bằng tài khoản guest (1/1) chỉ đọc. Để duyệt thanh toán và cấu hình, hãy đăng nhập bằng tài khoản Admin duy nhất trong admin.json.', 'warn');
        } else {
            authPill.className = 'pill info';
            authPill.textContent = 'Khách (Không cần tài khoản)';
            loginBtn.classList.remove('hidden');
            loginBtn.textContent = 'Đăng nhập 1 Tài khoản';
            logoutBtn.classList.add('hidden');
            $('admin-gate-box').classList.remove('hidden');
            $('admin-workspace').classList.add('hidden');
            showAlert('admin-gate-msg', '');
        }

        if (state.activeOrder) {
            renderActiveOrder(state.activeOrder);
        }
    }

    function openLoginModal() {
        showAlert('login-modal-msg', '');
        const demoHint = $('demo-login-hint');
        if (demoHint) {
            if (state.mode === 'demo') {
                demoHint.textContent = 'Static Demo Mode: Dùng tài khoản mẫu admin / admin123456 (hoặc guest 1 / 1 chỉ xem) để thử luồng duyệt đơn.';
                demoHint.classList.remove('hidden');
            } else {
                demoHint.textContent = '';
                demoHint.classList.add('hidden');
            }
        }
        $('login-modal').classList.add('open');
        const userInput = $('login-user');
        if (userInput) {
            userInput.focus();
            setTimeout(() => {
                const modal = $('login-modal');
                if (modal && modal.classList.contains('open') && !modal.contains(document.activeElement)) {
                    userInput.focus();
                }
            }, 20);
        }
    }

    function closeLoginModal() {
        $('login-modal').classList.remove('open');
    }

    async function handleLoginSubmit(e) {
        e.preventDefault();
        const username = $('login-user').value.trim();
        const password = $('login-pass').value;
        const rememberMe = $('login-remember').checked;
        if (!username || !password) {
            showAlert('login-modal-msg', 'Vui lòng nhập tên đăng nhập và mật khẩu.', 'err');
            return;
        }
        const btn = $('submit-login-btn');
        btn.disabled = true;
        try {
            const loginHeaders = state.mode === 'remote' ? { 'X-Auth-Mode': 'bearer' } : {};
            const { res, data } = await apiJson('/api/login', {
                method: 'POST',
                headers: loginHeaders,
                body: JSON.stringify({ username, password, rememberMe })
            });
            if (!res.ok || !data.success) {
                showAlert('login-modal-msg', data.message || 'Đăng nhập thất bại.', 'err');
                return;
            }
            if (state.mode === 'remote' && data.token) {
                state.bearerToken = data.token;
                saveRemoteToken(state.backendUrl, data.token);
            }
            $('login-pass').value = '';
            closeLoginModal();
            await reconnectSocket();
            await refreshPublicConfig();
        } catch (err) {
            showAlert('login-modal-msg', 'Lỗi kết nối máy chủ khi đăng nhập.', 'err');
        } finally {
            btn.disabled = false;
        }
    }

    async function handleLogout() {
        try {
            await apiJson('/api/logout', { method: 'POST', body: '{}' });
        } catch (e) {}
        if (state.mode === 'remote') {
            state.bearerToken = '';
            saveRemoteToken(state.backendUrl, '');
        }
        state.adminOrders = [];
        state.adminCampaigns = [];
        state.adminLoadingPromise = null;
        state.campaignLogs.clear();
        const glog = $('adm-global-log');
        if (glog) glog.innerHTML = '';
        const wlog = $('ao-worker-log');
        if (wlog) wlog.innerHTML = '';
        const cbody = $('adm-campaigns-body');
        if (cbody) cbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">Chưa có chiến dịch nào.</td></tr>';
        const obody = $('adm-orders-body');
        if (obody) obody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">Chưa có đơn hàng nào.</td></tr>';
        if ($('adm-sum-total')) $('adm-sum-total').textContent = '0';
        if ($('adm-sum-rev')) $('adm-sum-rev').textContent = '0 VNĐ';
        if ($('adm-sum-paid')) $('adm-sum-paid').textContent = '0';
        if ($('adm-sum-pending')) $('adm-sum-pending').textContent = '0';
        if ($('adm-sum-running')) $('adm-sum-running').textContent = '0';
        if ($('adm-sum-done')) $('adm-sum-done').textContent = '0';
        ['adm-action-msg', 'adm-paycfg-msg', 'adm-proxycfg-msg', 'adm-camp-msg'].forEach(id => showAlert(id, ''));
        if ($('cfg-secret')) $('cfg-secret').value = '';
        if ($('pcfg-keys')) $('pcfg-keys').value = '';
        await reconnectSocket();
        await refreshPublicConfig();
    }

    // ─── Cost & TimeDistribution Preview ──────────────────────────────────────
    function getCustomBlocksFromUI() {
        return {
            night: $('cb-night').value || 'low',
            early_morning: $('cb-early').value || 'medium',
            morning: $('cb-morn').value || 'high',
            noon: $('cb-noon').value || 'medium',
            afternoon: $('cb-after').value || 'high',
            evening: $('cb-eve').value || 'high',
            late_night: $('cb-late').value || 'medium'
        };
    }

    function setCostHint(msg) {
        const el = $('cost-hint');
        if (!el) return;
        if (!msg) {
            el.textContent = '';
            el.classList.add('hidden');
        } else {
            el.textContent = msg;
            el.classList.remove('hidden');
        }
    }

    function resetCostDisplay() {
        $('c-hours').textContent = '0';
        $('c-click-fee').textContent = '0 VNĐ';
        $('c-hour-fee').textContent = '0 VNĐ';
        $('c-total').textContent = '0 VNĐ';
    }

    async function updateCostAndDistribution() {
        const rawClicks = $('f-clicks').value.trim();
        const rawHours = $('f-hours').value.trim();
        const targetClicks = Number(rawClicks);
        const durationHours = Number(rawHours);
        const schedVal = $('f-schedule').value;
        const mode = ['even', 'custom'].includes(schedVal) ? schedVal : 'smart';
        const customBlocks = mode === 'custom' ? getCustomBlocksFromUI() : null;

        $('custom-blocks-box').classList.toggle('hidden', mode !== 'custom');

        const clicksOk = rawClicks !== '' && Number.isInteger(targetClicks) && targetClicks >= 1;
        const hoursOk = rawHours !== '' && Number.isFinite(durationHours) && durationHours > 0;

        $('c-clicks').textContent = clicksOk ? targetClicks.toLocaleString('vi-VN') : '0';

        if (!clicksOk || !hoursOk) {
            state.costRequestSeq++;
            resetCostDisplay();
            if (!clicksOk && rawClicks !== '') {
                setCostHint('Số lượt click phải là số nguyên dương (≥ 1).');
            } else if (!hoursOk && rawHours !== '') {
                setCostHint('Thời gian chạy phải lớn hơn 0 giờ.');
            } else {
                setCostHint('');
            }
            renderDistributionPreview(0, 0, mode, customBlocks);
            return;
        }

        setCostHint('');
        const reqSeq = ++state.costRequestSeq;
        try {
            const { res, data } = await apiJson('/api/orders/calculate-cost', {
                method: 'POST',
                body: JSON.stringify({ targetClicks, durationHours })
            });
            if (reqSeq !== state.costRequestSeq) return;
            if (res.ok && data.success) {
                $('c-rate').textContent = Number(data.clickRate).toLocaleString('vi-VN');
                $('c-hrate').textContent = Number(data.hourlyRate).toLocaleString('vi-VN');
                $('c-hours').textContent = data.roundedHours;
                $('c-click-fee').textContent = fmtVnd(data.clickFee);
                $('c-hour-fee').textContent = fmtVnd(data.durationFee);
                $('c-total').textContent = fmtVnd(data.totalAmount);
            } else {
                resetCostDisplay();
                setCostHint((data && data.message) || 'Thông số tính giá chưa hợp lệ.');
            }
        } catch (e) {}

        if (reqSeq !== state.costRequestSeq) return;
        renderDistributionPreview(targetClicks, durationHours, mode, customBlocks);
    }

    function scheduleCostRefresh() {
        clearTimeout(state.costDebounce);
        state.costDebounce = setTimeout(updateCostAndDistribution, 140);
    }

    const MAX_PREVIEW_HOURS = 8760;
    const COLLAPSED_PREVIEW_LIMIT = 48;

    function renderDistributionPreview(targetClicks, durationHours, mode, customBlocks) {
        const tbody = $('dist-preview-body');
        const footer = $('dist-preview-footer');
        const capAlert = $('dist-capacity-alert');
        const intervalPill = $('dist-interval-pill');
        if (footer) footer.innerHTML = '';

        if (!window.TimeDistribution || !Number.isInteger(targetClicks) || targetClicks <= 0 || !Number.isFinite(durationHours) || durationHours <= 0) {
            intervalPill.textContent = '--';
            capAlert.innerHTML = '';
            tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Nhập số click nguyên (≥ 1) &amp; thời gian &gt; 0 để xem trước phân bổ.</td></tr>';
            return;
        }

        if (durationHours > MAX_PREVIEW_HOURS) {
            const avgIntervalSec = Number(((durationHours * 3600) / targetClicks).toFixed(1));
            intervalPill.textContent = `TB ~${avgIntervalSec}s / click`;
            capAlert.innerHTML = `<div class="alert warn">Thời gian ${esc(durationHours)} giờ vượt quá giới hạn xem trước từng giờ (${MAX_PREVIEW_HOURS.toLocaleString('vi-VN')} giờ / 1 năm). Phí thời gian vẫn được tính chính xác.</div>`;
            tbody.innerHTML = `<tr><td class="mono">Tổng ${esc(durationHours)} giờ</td><td>${Math.round(durationHours * 60).toLocaleString('vi-VN')} phút</td><td><strong>${targetClicks.toLocaleString('vi-VN')}</strong></td><td>100.0%</td></tr>`;
            return;
        }

        const startTime = Date.now();
        const endTime = startTime + Math.round(durationHours * 3600000);
        const dist = window.TimeDistribution.buildTimeDistribution({
            startTime,
            endTime,
            targetClicks,
            mode,
            customBlocks
        });

        if (!dist.valid) {
            intervalPill.textContent = '--';
            capAlert.innerHTML = '';
            tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Không thể tính phân bổ với thông số này.</td></tr>';
            return;
        }

        intervalPill.textContent = `TB ~${dist.avgIntervalSec}s / click`;
        if (dist.avgIntervalSec < 15) {
            const safeMax = Math.max(1, Math.floor((durationHours * 3600) / 15));
            capAlert.innerHTML = `<div class="alert warn">Cảnh báo công suất 1 KiotProxy key: nhịp trung bình ~${esc(dist.avgIntervalSec)}s/click nhanh hơn cooldown xoay IP (~15s). 1 key chạy ổn định tối đa khoảng ~${safeMax.toLocaleString('vi-VN')} lượt trong ${esc(durationHours)} giờ (hoặc phần dư sẽ chậm hơn thời hạn).</div>`;
        } else {
            capAlert.innerHTML = `<div class="alert ok">Phù hợp công suất 1 KiotProxy key (nhịp ~${esc(dist.avgIntervalSec)}s/click ≥ 15s cooldown).</div>`;
        }

        const allRows = dist.slices && dist.slices.length > 0 ? dist.slices : dist.summaryBlocks;
        let visibleRows = allRows;
        let tailSummaryRow = '';

        if (allRows.length > COLLAPSED_PREVIEW_LIMIT && !state.expandPreviewSlices) {
            visibleRows = allRows.slice(0, COLLAPSED_PREVIEW_LIMIT);
            const rest = allRows.slice(COLLAPSED_PREVIEW_LIMIT);
            const restMinutes = rest.reduce((acc, s) => acc + Number(s.durationMinutes || 0), 0);
            const restQuota = rest.reduce((acc, s) => acc + Number(s.quota || 0), 0);
            const restPercent = dist.targetClicks > 0 ? ((restQuota / dist.targetClicks) * 100).toFixed(1) : '0.0';
            const firstRest = rest[0];
            const lastRest = rest[rest.length - 1];
            const rangeHint = (firstRest && lastRest && firstRest.startStr && lastRest.endStr)
                ? ` (${firstRest.startStr} → ${lastRest.endStr})`
                : '';
            tailSummaryRow = `<tr data-preview-rest-summary="1" style="background:rgba(56,189,248,0.06);">
                <td class="mono">+ ${rest.length} khung giờ còn lại${esc(rangeHint)}</td>
                <td>${restMinutes.toLocaleString('vi-VN')} phút</td>
                <td><strong>${restQuota.toLocaleString('vi-VN')}</strong></td>
                <td>${esc(restPercent)}%</td>
            </tr>`;
            if (footer) {
                footer.innerHTML = `<button type="button" class="btn btn-sm" data-action="toggle-preview-slices">Hiển thị đủ ${allRows.length} khung giờ (đang gộp ${rest.length} khung cuối)</button>`;
            }
        } else if (allRows.length > COLLAPSED_PREVIEW_LIMIT && footer) {
            footer.innerHTML = `<button type="button" class="btn btn-sm" data-action="toggle-preview-slices">Thu gọn về ${COLLAPSED_PREVIEW_LIMIT} khung giờ + tổng phần còn lại</button>`;
        }

        tbody.innerHTML = visibleRows.map(s => {
            const label = s.startStr && s.endStr ? `${s.startStr} → ${s.endStr}` : (s.label || '--');
            const dur = s.durationMinutes !== undefined ? `${s.durationMinutes} phút` : (s.durationFormatted || '--');
            return `<tr>
                <td class="mono">${esc(label)}</td>
                <td>${esc(dur)}</td>
                <td><strong>${Number(s.quota || 0).toLocaleString('vi-VN')}</strong></td>
                <td>${esc(s.percent)}%</td>
            </tr>`;
        }).join('') + tailSummaryRow;
    }

    // ─── Local Recent Orders (No Account Needed) ──────────────────────────────
    function getRecentOrders() {
        try {
            const raw = localStorage.getItem(RECENT_ORDERS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveRecentOrder(order) {
        if (!order || !order.orderId) return;
        const list = getRecentOrders().filter(x => x && x.orderId !== order.orderId);
        list.unshift({
            orderId: order.orderId,
            orderCode: order.orderCode,
            name: order.name || order.orderCode,
            targetUrl: order.targetUrl,
            totalAmount: order.totalAmount,
            status: order.status,
            createdAt: order.createdAt || Date.now()
        });
        try {
            localStorage.setItem(RECENT_ORDERS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_ORDERS)));
        } catch (e) {}
        renderRecentOrders();
    }

    function removeRecentOrder(orderId) {
        const list = getRecentOrders().filter(x => x && x.orderId !== orderId);
        try { localStorage.setItem(RECENT_ORDERS_KEY, JSON.stringify(list)); } catch (e) {}
        renderRecentOrders();
    }

    function renderRecentOrders() {
        const wrap = $('recent-orders-wrap');
        const list = getRecentOrders();
        if (!list.length) {
            wrap.innerHTML = '<div class="hint">Chưa có đơn nào được lưu trên trình duyệt này.</div>';
            return;
        }
        wrap.innerHTML = list.slice(0, 6).map(item => `
            <div class="kv">
                <div style="min-width:0; padding-right:8px;">
                    <code class="mono">${esc(item.orderId)}</code>
                    <span class="pill" style="padding:1px 6px;font-size:11px;">${esc(item.orderCode || '')}</span>
                    <div class="hint" style="margin:2px 0 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:300px;">
                        ${esc(item.targetUrl || '')}
                    </div>
                </div>
                <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
                    <button type="button" class="btn btn-sm" data-action="load-recent" data-id="${esc(item.orderId)}">Mở</button>
                    <button type="button" class="btn btn-sm" data-action="del-recent" data-id="${esc(item.orderId)}">×</button>
                </div>
            </div>
        `).join('');
    }

    // ─── Order Submission & Active Order Tracking ─────────────────────────────
    async function handleOrderSubmit(e) {
        e.preventDefault();
        showAlert('order-form-msg', '');
        const schedVal = $('f-schedule').value;
        const scheduleMode = ['even', 'custom'].includes(schedVal) ? schedVal : 'smart';
        const payload = {
            name: $('f-name').value.trim() || undefined,
            targetUrl: $('f-url').value.trim(),
            proxyKey: $('f-proxy').value.trim(),
            targetClicks: Number($('f-clicks').value),
            durationHours: Number($('f-hours').value),
            scheduleMode,
            customBlocks: scheduleMode === 'custom' ? getCustomBlocksFromUI() : undefined,
            dedupIp: $('f-dedup').checked,
            randomLinks: $('f-links').checked
        };

        const btn = $('submit-order-btn');
        btn.disabled = true;
        btn.textContent = 'Đang tạo đơn & sinh VietQR...';

        try {
            const { res, data } = await apiJson('/api/orders', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!res.ok || !data.success) {
                showAlert('order-form-msg', data.message || 'Không thể tạo đơn hàng.', 'err');
                return;
            }
            showAlert('order-form-msg', `Đã tạo đơn ${data.orderId} (${data.orderCode}). Vui lòng thanh toán để mở khóa thực thi.`, 'ok');
            saveRecentOrder(data);
            await selectOrder(data.orderId);
        } catch (err) {
            showAlert('order-form-msg', 'Lỗi kết nối máy chủ khi tạo đơn.', 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Tạo đơn Boost & Lấy mã VietQR (Không cần tài khoản)';
        }
    }

    function stopOrderPolling() {
        if (state.pollTimer) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    function stopQrCountdown() {
        if (state.countdownTimer) {
            clearInterval(state.countdownTimer);
            state.countdownTimer = null;
        }
    }

    function startQrCountdown(createdAt) {
        stopQrCountdown();
        const el = $('ao-countdown');
        const expireAt = (createdAt || Date.now()) + 15 * 60 * 1000;
        const tick = () => {
            const left = Math.max(0, expireAt - Date.now());
            const m = Math.floor(left / 60000);
            const s = Math.floor((left % 60000) / 1000);
            el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (left <= 0) stopQrCountdown();
        };
        tick();
        state.countdownTimer = setInterval(tick, 1000);
    }

    function clearActiveOrderView() {
        stopOrderPolling();
        stopQrCountdown();
        state.activeOrderId = null;
        state.activeOrder = null;
        const wlog = $('ao-worker-log');
        if (wlog) {
            wlog.innerHTML = '';
            delete wlog.dataset.campId;
        }
        $('active-order-panel').classList.add('hidden');
        $('active-order-empty').classList.remove('hidden');
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('orderId');
            url.searchParams.delete('order');
            history.replaceState(null, '', url.toString());
        } catch (e) {}
    }

    async function selectOrder(orderId) {
        const cleanId = String(orderId || '').trim();
        if (!cleanId) {
            showAlert('lookup-order-msg', 'Vui lòng nhập mã đơn hàng cần tra cứu (ORD-...).', 'warn');
            return null;
        }
        showAlert('lookup-order-msg', '');
        showAlert('ao-notice', '');
        $('lookup-order-id').value = cleanId;

        const wlog = $('ao-worker-log');
        if (wlog && state.activeOrderId !== cleanId) {
            wlog.innerHTML = '';
            delete wlog.dataset.campId;
        }
        stopOrderPolling();
        const order = await fetchActiveOrder(cleanId);
        if (order) {
            if (state.socket && state.socket.connected) {
                state.socket.emit('subscribe-order', order.orderId);
            }
            const eff = (order.progress && order.progress.status) || order.status;
            if (!['completed', 'expired', 'stopped'].includes(eff)) {
                state.pollTimer = setInterval(() => fetchActiveOrder(), 3000);
            }
        }
        return order;
    }

    async function fetchActiveOrder(targetOrderId) {
        const lookupId = String(targetOrderId || state.activeOrderId || '').trim();
        if (!lookupId) return null;
        try {
            const { res, data } = await apiJson('/api/orders/' + encodeURIComponent(lookupId));
            if (!res.ok || !data.success || !data.order) {
                const msg = (data && data.message && res.status !== 404)
                    ? data.message
                    : `Không tìm thấy đơn hàng ${lookupId}.`;
                clearActiveOrderView();
                showAlert('lookup-order-msg', msg, 'err');
                return null;
            }
            state.activeOrderId = data.order.orderId;
            state.activeOrder = data.order;
            try {
                const url = new URL(window.location.href);
                url.searchParams.set('orderId', data.order.orderId);
                url.searchParams.delete('order');
                history.replaceState(null, '', url.toString());
            } catch (e) {}
            saveRecentOrder(data.order);
            renderActiveOrder(data.order);
            return data.order;
        } catch (e) {
            if (!state.activeOrder || state.activeOrderId !== lookupId) {
                showAlert('lookup-order-msg', `Lỗi kết nối khi tải đơn hàng ${lookupId}.`, 'err');
            }
            return null;
        }
    }

    function renderActiveOrder(o) {
        $('active-order-empty').classList.add('hidden');
        $('active-order-panel').classList.remove('hidden');

        const prog = o.progress || {
            orderId: o.orderId,
            campaignId: o.campaignId || null,
            status: o.status,
            successVisits: o.successVisits || 0,
            failedVisits: o.failedVisits || 0,
            totalVisits: o.totalVisits || ((o.successVisits || 0) + (o.failedVisits || 0)),
            uniqueIps: o.uniqueIps || 0,
            dupIps: o.dupIps || 0,
            targetLimit: o.targetClicks || 0,
            browserMode: o.browserMode || 'request',
            scheduleMode: o.scheduleMode || 'smart'
        };

        const effectiveStatus = prog.status || o.status || 'pending_payment';
        const isPaid = o.paymentStatus === 'paid';
        const isDone = ['completed', 'expired', 'stopped'].includes(effectiveStatus);
        const isAdmin = state.config.authenticated && state.config.role === 'admin';

        $('ao-id').textContent = o.orderId || '--';
        $('ao-code').textContent = o.orderCode || '--';
        $('ao-target').textContent = `${o.name ? o.name + ' — ' : ''}${o.targetUrl || ''}`;
        $('ao-proxy').textContent = o.proxyKeyMasked || '--';
        const schedLabel = o.scheduleMode === 'even' ? 'Even' : (o.scheduleMode === 'custom' ? 'Custom' : 'Smart');
        $('ao-plan').textContent = `${Number(o.targetClicks || 0).toLocaleString('vi-VN')} clicks / ${o.durationHours}h (${schedLabel}) · Request HTTP`;
        $('ao-amount').textContent = fmtVnd(o.totalAmount);

        const pill = $('ao-status-pill');
        if (!isPaid) {
            pill.className = 'pill warn';
            pill.textContent = 'Chờ thanh toán (Khóa 0 click)';
        } else if (effectiveStatus === 'completed') {
            pill.className = 'pill ok';
            pill.textContent = 'Đã hoàn thành';
            stopOrderPolling();
            stopQrCountdown();
        } else if (effectiveStatus === 'expired') {
            pill.className = 'pill warn';
            pill.textContent = 'Hết thời gian';
            stopOrderPolling();
            stopQrCountdown();
        } else if (effectiveStatus === 'stopped') {
            pill.className = 'pill err';
            pill.textContent = 'Đã dừng';
            stopOrderPolling();
            stopQrCountdown();
        } else {
            pill.className = 'pill info';
            pill.textContent = 'Đã thanh toán · Đang chạy';
            stopQrCountdown();
        }

        const payBox = $('ao-payment-box');
        if (!isPaid) {
            payBox.classList.remove('hidden');
            const bank = o.bankInfo || state.config.bankInfo || {};
            const img = $('ao-qr-img');
            const fb = $('ao-qr-fallback');
            if (o.vietQrUrl) {
                if (img.getAttribute('src') !== o.vietQrUrl) {
                    fb.classList.add('hidden');
                    img.classList.remove('hidden');
                    img.onload = () => {
                        fb.classList.add('hidden');
                        img.classList.remove('hidden');
                    };
                    img.onerror = () => {
                        img.classList.add('hidden');
                        fb.classList.remove('hidden');
                    };
                    img.src = o.vietQrUrl;
                }
            } else {
                img.removeAttribute('src');
                img.classList.add('hidden');
                fb.classList.remove('hidden');
            }
            $('ao-bank').textContent = `${bank.bankName || bank.bankId || '--'} (${bank.bankId || '--'})`;
            $('ao-acc-num').textContent = bank.accountNumber || '--';
            $('ao-acc-name').textContent = bank.accountName || '--';
            $('ao-pay-amount').textContent = fmtVnd(o.totalAmount);
            $('ao-memo').textContent = o.orderCode || '--';
            startQrCountdown(o.createdAt);

            $('inline-admin-confirm-btn').classList.toggle('hidden', !isAdmin);
            $('guest-pay-hint').classList.toggle('hidden', isAdmin);
        } else {
            payBox.classList.add('hidden');
            $('inline-admin-confirm-btn').classList.add('hidden');
        }

        const target = Math.max(1, Number(prog.targetLimit || o.targetClicks || 1));
        const success = Number(prog.successVisits || 0);
        const failed = Number(prog.failedVisits || 0);
        const total = Number(prog.totalVisits || (success + failed));
        const pct = Math.min(100, Math.floor((success / target) * 100));
        const campId = prog.campaignId || o.campaignId || null;

        $('ao-camp-id').textContent = campId || 'Chưa kích hoạt';
        $('ao-progress-bar').style.width = pct + '%';
        $('ao-progress-text').textContent = `${success.toLocaleString('vi-VN')} / ${target.toLocaleString('vi-VN')} lượt thành công (${pct}%)`;

        if (isDone) {
            const endedAt = prog.actualEndTime || o.completedAt || prog.endTime;
            const startedAt = prog.actualStartTime || o.paidAt || prog.startTime;
            let durSuffix = '';
            if (endedAt && startedAt && endedAt >= startedAt && window.TimeDistribution && typeof window.TimeDistribution.formatDuration === 'function') {
                durSuffix = ` · Thời lượng: ${window.TimeDistribution.formatDuration(endedAt - startedAt)}`;
            }
            $('ao-time-text').textContent = endedAt ? `Kết thúc thực tế: ${fmtTime(endedAt)}${durSuffix}` : `Hoàn tất (Tạo lúc: ${fmtTime(o.createdAt)})`;
        } else {
            $('ao-time-text').textContent = prog.endTime ? `Dự kiến kết thúc: ${fmtTime(prog.endTime)}` : `Tạo lúc: ${fmtTime(o.createdAt)}`;
        }

        $('st-success').textContent = success.toLocaleString('vi-VN');
        $('st-failed').textContent = failed.toLocaleString('vi-VN');
        $('st-total').textContent = total.toLocaleString('vi-VN');
        $('st-unique').textContent = Number(prog.uniqueIps || 0).toLocaleString('vi-VN');
        $('st-dup').textContent = Number(prog.dupIps || 0).toLocaleString('vi-VN');
        $('st-mode').textContent = prog.browserMode || o.browserMode || 'request';

        $('inline-admin-stop-btn').classList.toggle('hidden', !(isAdmin && campId && !isDone));
        $('ao-admin-log-wrap').classList.toggle('hidden', !isAdmin);
        if (isAdmin && campId) {
            hydrateOrderWorkerLogs(campId);
        }
    }

    async function confirmOrderAsAdmin(orderId) {
        const isViewingOrder = state.activeOrderId === orderId;
        showAlert('adm-action-msg', '');
        if (isViewingOrder) showAlert('ao-notice', '');
        const { res, data } = await apiJson('/api/orders/' + encodeURIComponent(orderId) + '/confirm', {
            method: 'POST',
            body: '{}'
        });
        if (!res.ok || !data.success) {
            const msg = (data && data.message) || 'Không thể xác nhận đơn hàng.';
            if (isViewingOrder) showAlert('ao-notice', msg, 'err');
            showAlert('adm-action-msg', msg, 'err');
            return false;
        }
        const okMsg = `Đã xác nhận thanh toán đơn ${data.orderId} -> Campaign ${data.campaignId} đang chạy.`;
        showAlert('adm-action-msg', okMsg, 'ok');
        if (isViewingOrder) {
            showAlert('ao-notice', okMsg, 'ok');
            if (state.activeOrder && data.campaignId) {
                state.activeOrder.campaignId = data.campaignId;
                state.activeOrder.paymentStatus = 'paid';
                hydrateOrderWorkerLogs(data.campaignId);
            }
            await fetchActiveOrder(orderId);
        }
        await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
        return true;
    }

    async function stopCampaignAsAdmin(campaignId) {
        if (!campaignId) return;
        const activeCampId = state.activeOrder && ((state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId);
        const isViewingCampaign = Boolean(activeCampId && String(activeCampId) === String(campaignId));
        const { res, data } = await apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/stop', {
            method: 'POST',
            body: '{}'
        });
        if (!res.ok || !data.success) {
            const msg = (data && data.message) || 'Không thể dừng chiến dịch.';
            if (isViewingCampaign) showAlert('ao-notice', msg, 'err');
            showAlert('adm-action-msg', msg, 'err');
            return;
        }
        const warnMsg = `Đã gửi lệnh dừng chiến dịch ${campaignId}.`;
        showAlert('adm-action-msg', warnMsg, 'warn');
        if (isViewingCampaign) showAlert('ao-notice', warnMsg, 'warn');
        if (state.activeOrderId) await fetchActiveOrder();
        await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
    }

    function downloadActiveReport() {
        const o = state.activeOrder;
        if (!o) return;
        const p = o.progress || {};
        const runtimeLabel = state.mode === 'demo'
            ? 'STATIC DEMO (Mo phong trinh duyet, khong gui traffic that)'
            : (state.mode === 'remote' ? `Remote Backend (${state.backendUrl})` : 'Live Same-Origin');
        const lines = [
            '=== BAO CAO DON HANG TRAFFIC BOOST ===',
            `Che do he thong: ${runtimeLabel}`,
            `Ma don (Order ID): ${o.orderId}`,
            `Ma chuyen khoan (Order Code): ${o.orderCode}`,
            `Ten chien dich: ${o.name || ''}`,
            `URL dich: ${o.targetUrl}`,
            `Proxy Key (da che): ${o.proxyKeyMasked || '--'}`,
            `Che do thuc thi: ${p.browserMode || o.browserMode || 'request'} (Axios + KiotProxy)`,
            `Phan bo thoi gian: ${o.scheduleMode || 'smart'} | dedupIp=${o.dedupIp !== false} | randomLinks=${o.randomLinks !== false}`,
            `Trang thai thanh toan: ${o.paymentStatus}`,
            `Trang thai chien dich: ${p.status || o.status}`,
            `Campaign ID: ${p.campaignId || o.campaignId || 'Chua kich hoat'}`,
            `So tien: ${Number(o.totalAmount || 0).toLocaleString('vi-VN')} VND`,
            `Muc tieu click: ${o.targetClicks}`,
            `Luot thanh cong: ${p.successVisits ?? o.successVisits ?? 0}`,
            `Luot that bai: ${p.failedVisits ?? o.failedVisits ?? 0}`,
            `Tong thu: ${p.totalVisits ?? o.totalVisits ?? 0}`,
            `IP duy nhat: ${p.uniqueIps ?? o.uniqueIps ?? 0}`,
            `IP trung bi bo qua: ${p.dupIps ?? o.dupIps ?? 0}`,
            `Thoi gian tao: ${fmtTime(o.createdAt)}`,
            `Thoi gian thanh toan: ${fmtTime(o.paidAt)}`,
            `Ket thuc du kien/thuc te: ${fmtTime(p.actualEndTime || p.endTime || o.completedAt)}`
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `report_${o.orderCode || o.orderId}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    // ─── Admin Workspace (Single Operator Account) ────────────────────────────
    async function loadAdminDashboard() {
        if (!(state.config.authenticated && state.config.role === 'admin')) return;
        const whEl = $('cfg-webhook-url');
        if (whEl) {
            whEl.textContent = state.mode === 'demo'
                ? '[Static Demo] Can Backend Tunnel de nhan webhook'
                : `${state.backendUrl || window.location.origin}/api/payment/webhook`;
        }
        if (state.adminLoadingPromise) return state.adminLoadingPromise;
        state.adminLoadingPromise = Promise.all([
            loadAdminOrders(),
            loadAdminCampaigns(),
            loadAdminPaymentConfig(),
            loadAdminProxyConfig()
        ]).finally(() => {
            state.adminLoadingPromise = null;
        });
        return state.adminLoadingPromise;
    }

    async function loadAdminCampaigns() {
        if (!(state.config.authenticated && state.config.role === 'admin')) return;
        try {
            const { res, data } = await apiJson('/api/campaigns');
            if (!res.ok || !data.success) return;
            state.adminCampaigns = Array.isArray(data.data) ? data.data : [];
            renderAdminCampaignsTable(state.adminCampaigns);
        } catch (e) {}
    }

    function renderAdminCampaignsTable(list) {
        const tbody = $('adm-campaigns-body');
        if (!tbody) return;
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">Chưa có chiến dịch nào.</td></tr>';
            return;
        }
        tbody.innerHTML = list.map(c => {
            const st = c.status || 'waiting';
            const badge = st === 'completed' ? 'ok' : (st === 'stopped' ? 'err' : (st === 'running' ? 'info' : 'warn'));
            const canStop = st === 'running' || st === 'waiting';
            return `<tr>
                <td><code class="mono">${esc(c.id)}</code><div class="hint" style="margin:2px 0 0 0;">${esc(c.name || '')}</div></td>
                <td style="max-width:220px; word-break:break-all;">${esc(c.targetUrl || '')}</td>
                <td><span class="pill ${badge}">${esc(st)}</span></td>
                <td>${Number(c.successVisits || 0).toLocaleString('vi-VN')} / ${Number(c.targetLimit || 0).toLocaleString('vi-VN')}<div class="hint" style="margin:2px 0 0 0;">Err: ${Number(c.failedVisits || 0).toLocaleString('vi-VN')}</div></td>
                <td>
                    <div style="display:flex; flex-wrap:wrap; gap:4px;">
                        ${canStop ? `<button type="button" class="btn btn-sm btn-danger" data-action="camp-stop" data-id="${esc(c.id)}">Dừng</button>` : ''}
                        <button type="button" class="btn btn-sm" data-action="camp-reset" data-id="${esc(c.id)}">Reset</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    async function resetCampaignStatsAsAdmin(campaignId) {
        if (!campaignId) return;
        const { res, data } = await apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/reset-stats', {
            method: 'POST',
            body: '{}'
        });
        if (!res.ok || !data.success) {
            showAlert('adm-camp-msg', (data && data.message) || 'Không thể reset thống kê chiến dịch.', 'err');
            return;
        }
        showAlert('adm-camp-msg', `Đã reset thống kê chiến dịch ${campaignId}.`, 'ok');
        if (state.activeOrderId) await fetchActiveOrder();
        await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
    }

    async function loadAdminOrders() {
        if (!(state.config.authenticated && state.config.role === 'admin')) return;
        try {
            const { res, data } = await apiJson('/api/admin/orders');
            if (!res.ok || !data.success) return;
            const s = data.summary || {};
            $('adm-sum-total').textContent = Number(s.totalOrders || 0).toLocaleString('vi-VN');
            $('adm-sum-rev').textContent = fmtVnd(s.totalRevenue || 0);
            $('adm-sum-paid').textContent = Number(s.paidCount || 0).toLocaleString('vi-VN');
            $('adm-sum-pending').textContent = Number(s.pendingCount || 0).toLocaleString('vi-VN');
            $('adm-sum-running').textContent = Number(s.runningCount || 0).toLocaleString('vi-VN');
            $('adm-sum-done').textContent = Number(s.completedCount || 0).toLocaleString('vi-VN');
            state.adminOrders = Array.isArray(data.orders) ? data.orders : [];
            renderAdminOrdersTable();
        } catch (e) {}
    }

    function renderAdminOrdersTable() {
        const tbody = $('adm-orders-body');
        const filter = $('adm-filter').value;
        const filtered = state.adminOrders.filter(o => {
            const st = o.effectiveStatus || o.status;
            if (filter === 'all') return true;
            if (filter === 'stopped') return st === 'stopped' || st === 'expired';
            return st === filter;
        });

        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">Không có đơn hàng nào khớp bộ lọc.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(o => {
            const eff = o.effectiveStatus || o.status || 'pending_payment';
            const p = o.progress || {};
            const succ = p.successVisits ?? o.successVisits ?? 0;
            const target = p.targetLimit || o.targetClicks || 0;
            const isPaid = o.paymentStatus === 'paid';
            const canStop = Boolean(o.campaignId) && ['running', 'waiting'].includes(eff);
            const canDelete = !['running', 'waiting'].includes(eff);

            return `<tr>
                <td>
                    <code class="mono">${esc(o.orderId)}</code><br>
                    <span class="pill" style="padding:1px 6px;font-size:11px;margin-top:3px;">${esc(o.orderCode)}</span>
                </td>
                <td style="max-width:250px; word-break:break-all;">
                    <strong>${esc(o.name || o.orderCode)}</strong><br>
                    <span class="hint">${esc(o.targetUrl)}</span><br>
                    <span class="hint">Key: <code>${esc(o.proxyKeyMasked || '')}</code> · ${esc(o.scheduleMode || 'smart')}</span>
                </td>
                <td>${fmtVnd(o.totalAmount)}</td>
                <td>
                    <div>${isPaid ? '<span class="pill ok">paid</span>' : '<span class="pill warn">pending_payment</span>'}</div>
                    <div class="hint" style="margin-top:4px;">Trạng thái: <code>${esc(eff)}</code></div>
                </td>
                <td>
                    <strong>${Number(succ).toLocaleString('vi-VN')} / ${Number(target).toLocaleString('vi-VN')}</strong>
                    <div class="hint">${o.campaignId ? 'C' + esc(o.campaignId) : 'Chưa kích hoạt'}</div>
                </td>
                <td>
                    <div style="display:flex; flex-wrap:wrap; gap:4px;">
                        <button type="button" class="btn btn-sm" data-action="adm-view" data-id="${esc(o.orderId)}">Xem</button>
                        ${!isPaid ? `<button type="button" class="btn btn-sm btn-success" data-action="adm-confirm" data-id="${esc(o.orderId)}">Duyệt</button>` : ''}
                        ${canStop ? `<button type="button" class="btn btn-sm btn-danger" data-action="adm-stop" data-camp-id="${esc(o.campaignId)}">Dừng</button>` : ''}
                        ${canDelete ? `<button type="button" class="btn btn-sm" data-action="adm-delete" data-id="${esc(o.orderId)}">Xóa</button>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    async function loadAdminPaymentConfig() {
        try {
            const { res, data } = await apiJson('/api/admin/payment-config');
            if (!res.ok || !data.success || !data.config) return;
            const c = data.config;
            $('cfg-bankid').value = c.bankId || '';
            $('cfg-bankname').value = c.bankName || '';
            $('cfg-accnum').value = c.accountNumber || '';
            $('cfg-accname').value = c.accountName || '';
            $('cfg-template').value = c.template || 'compact2';
            $('cfg-secret').value = c.webhookSecret || '';
        } catch (e) {}
    }

    async function handlePaymentConfigSubmit(e) {
        e.preventDefault();
        showAlert('adm-paycfg-msg', '');
        const payload = {
            bankId: $('cfg-bankid').value.trim(),
            bankName: $('cfg-bankname').value.trim(),
            accountNumber: $('cfg-accnum').value.trim(),
            accountName: $('cfg-accname').value.trim(),
            template: $('cfg-template').value,
            webhookSecret: $('cfg-secret').value.trim()
        };
        const { res, data } = await apiJson('/api/admin/payment-config', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if (!res.ok || !data.success) {
            showAlert('adm-paycfg-msg', data.message || 'Lỗi lưu cấu hình VietQR.', 'err');
            return;
        }
        showAlert('adm-paycfg-msg', 'Đã lưu cấu hình VietQR & Webhook.', 'ok');
        await refreshPublicConfig();
    }

    async function loadAdminProxyConfig() {
        try {
            const { res, data } = await apiJson('/api/proxy-config');
            if (!res.ok || !data.success || !data.data) return;
            const d = data.data;
            $('pcfg-region').value = d.region || 'random';
            $('pcfg-cooldown').value = typeof d.cooldownSec === 'number' ? d.cooldownSec : 14;
            $('pcfg-keys').value = Array.isArray(d.keys) ? d.keys.join('\n') : '';
        } catch (e) {}
    }

    async function handleProxyConfigSubmit(e) {
        e.preventDefault();
        showAlert('adm-proxycfg-msg', '');
        const keys = $('pcfg-keys').value
            .split(/[\r\n,]+/)
            .map(s => s.trim())
            .filter(Boolean);
        const cooldownSec = Number($('pcfg-cooldown').value);
        const region = $('pcfg-region').value || 'random';
        const { res, data } = await apiJson('/api/proxy-config', {
            method: 'POST',
            body: JSON.stringify({ region, keys, cooldownSec: Number.isFinite(cooldownSec) ? cooldownSec : 14 })
        });
        if (!res.ok || !data.success) {
            showAlert('adm-proxycfg-msg', data.message || 'Lỗi lưu Proxy Pool.', 'err');
            return;
        }
        showAlert('adm-proxycfg-msg', data.message || 'Đã lưu Proxy Pool.', 'ok');
    }

    function appendLogLine(boxId, text, type = 'info', timeStr = null) {
        const box = $(boxId);
        if (!box) return;
        const p = document.createElement('div');
        p.className = `log-line ${type || 'info'}`;
        const time = timeStr || new Date().toLocaleTimeString('vi-VN');
        p.textContent = `[${time}] ${text}`;
        box.appendChild(p);
        while (box.children.length > 250) {
            box.removeChild(box.firstChild);
        }
        box.scrollTop = box.scrollHeight;
    }

    function recordCampaignLog(entry) {
        if (!entry || entry.campaignId == null) return null;
        const cid = String(entry.campaignId);
        let list = state.campaignLogs.get(cid);
        if (!list) {
            list = [];
            state.campaignLogs.set(cid, list);
        }
        const rec = {
            time: new Date().toLocaleTimeString('vi-VN'),
            line: `[C${cid}] ${entry.text}`,
            type: entry.type || 'info'
        };
        list.push(rec);
        if (list.length > 150) list.shift();
        if (state.campaignLogs.size > 30) {
            const firstKey = state.campaignLogs.keys().next().value;
            state.campaignLogs.delete(firstKey);
        }
        return rec;
    }

    function hydrateOrderWorkerLogs(campId) {
        const box = $('ao-worker-log');
        if (!box || !campId) return;
        const cid = String(campId);
        if (box.dataset.campId === cid) return;
        box.dataset.campId = cid;
        box.innerHTML = '';
        const list = state.campaignLogs.get(cid) || [];
        for (const item of list) {
            appendLogLine('ao-worker-log', item.line, item.type, item.time);
        }
    }

    // ─── Socket.IO Integration ────────────────────────────────────────────────
    function ensureRemoteSocketScript(backendUrl) {
        return new Promise((resolve) => {
            if (!backendUrl) return resolve(false);
            if (typeof window.io === 'function' && state.remoteSocketLoadedFor === backendUrl) {
                return resolve(true);
            }
            const existing = document.getElementById('remote-socketio-script');
            if (existing) existing.remove();
            const script = document.createElement('script');
            script.id = 'remote-socketio-script';
            script.src = `${backendUrl}/socket.io/socket.io.js`;
            script.async = true;
            const done = (ok) => {
                if (ok) state.remoteSocketLoadedFor = backendUrl;
                resolve(ok);
            };
            const timer = setTimeout(() => done(false), 6000);
            script.onload = () => { clearTimeout(timer); done(typeof window.io === 'function'); };
            script.onerror = () => { clearTimeout(timer); done(false); };
            document.head.appendChild(script);
        });
    }

    async function initSocket() {
        if (state.socket) {
            try { state.socket.disconnect(); } catch (e) {}
            state.socket = null;
        }
        if (state.mode === 'demo') {
            $('socket-pill').className = 'pill warn';
            $('socket-pill').textContent = 'Demo: Giả lập trình duyệt';
            return;
        }
        if (state.mode === 'remote') {
            const ok = await ensureRemoteSocketScript(state.backendUrl);
            if (!ok || typeof window.io !== 'function') {
                $('socket-pill').className = 'pill warn';
                $('socket-pill').textContent = 'Socket: Chưa nối được Tunnel';
                return;
            }
        }
        if (typeof window.io !== 'function') {
            $('socket-pill').className = 'pill err';
            $('socket-pill').textContent = 'Socket: Không khả dụng';
            return;
        }
        const socket = state.mode === 'remote'
            ? window.io(state.backendUrl, {
                withCredentials: false,
                auth: state.bearerToken ? { token: state.bearerToken } : {}
            })
            : window.io();
        state.socket = socket;

        socket.on('connect', () => {
            $('socket-pill').className = 'pill ok';
            $('socket-pill').textContent = 'Socket: Đã kết nối';
            if (state.activeOrderId) {
                socket.emit('subscribe-order', state.activeOrderId);
            }
        });

        socket.on('disconnect', () => {
            $('socket-pill').className = 'pill warn';
            $('socket-pill').textContent = 'Socket: Mất kết nối';
        });

        socket.on('user-info', (info) => {
            const prevAuth = state.config.authenticated;
            const prevRole = state.config.role;
            if (info && info.role) {
                state.config.authenticated = true;
                state.config.role = info.role;
                state.config.username = info.username;
                if (!prevAuth || prevRole !== info.role) renderAuthState();
            } else {
                state.config.authenticated = false;
                state.config.role = null;
                state.config.username = null;
                if (prevAuth) renderAuthState();
            }
        });

        socket.on('payment-confirmed', (payload) => {
            if (payload && payload.orderId && payload.orderId === state.activeOrderId) {
                showAlert('ao-notice', `Thanh toán đã được xác nhận! Campaign ${payload.campaignId || ''} đang bắt đầu chạy.`, 'ok');
                if (state.activeOrder && payload.campaignId) {
                    state.activeOrder.campaignId = payload.campaignId;
                    state.activeOrder.paymentStatus = 'paid';
                    hydrateOrderWorkerLogs(payload.campaignId);
                }
                fetchActiveOrder();
            }
            if (state.config.role === 'admin') {
                loadAdminOrders();
                loadAdminCampaigns();
            }
        });

        socket.on('order-progress', (prog) => {
            if (!prog || prog.orderId !== state.activeOrderId || !state.activeOrder) return;
            state.activeOrder.progress = prog;
            if (!state.activeOrder.campaignId && prog.campaignId) {
                state.activeOrder.campaignId = prog.campaignId;
            }
            if (prog.status) {
                state.activeOrder.status = prog.status;
                if (['paid', 'running', 'completed', 'expired', 'stopped'].includes(prog.status)) {
                    state.activeOrder.paymentStatus = 'paid';
                }
            }
            renderActiveOrder(state.activeOrder);
        });

        socket.on('orders-updated', () => {
            if (state.config.role === 'admin') {
                loadAdminOrders();
                loadAdminCampaigns();
            }
        });

        socket.on('status-update', () => {
            if (state.config.role === 'admin') loadAdminCampaigns();
        });

        socket.on('campaign-deleted', () => {
            if (state.config.role === 'admin') loadAdminCampaigns();
        });

        socket.on('log', (entry) => {
            if (!entry) return;
            const rec = recordCampaignLog(entry);
            const line = rec ? rec.line : `[C${entry.campaignId}] ${entry.text}`;
            const time = rec ? rec.time : null;
            appendLogLine('adm-global-log', line, entry.type, time);
            if (state.activeOrder) {
                const activeCampId = (state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId;
                if (activeCampId && String(entry.campaignId) === String(activeCampId)) {
                    const box = $('ao-worker-log');
                    if (box && box.dataset.campId !== String(activeCampId)) {
                        hydrateOrderWorkerLogs(activeCampId);
                    } else {
                        appendLogLine('ao-worker-log', line, entry.type, time);
                    }
                }
            }
        });

        socket.on('stats-update', (st) => {
            if (state.config.role === 'admin' && st) {
                const rowOrder = state.adminOrders.find(o => o.campaignId && String(o.campaignId) === String(st.campaignId));
                if (rowOrder) {
                    rowOrder.effectiveStatus = st.status;
                    rowOrder.progress = Object.assign({}, rowOrder.progress || {}, {
                        status: st.status,
                        successVisits: st.success,
                        failedVisits: st.failed,
                        targetLimit: st.target
                    });
                    renderAdminOrdersTable();
                }
                const rowCamp = state.adminCampaigns.find(c => String(c.id) === String(st.campaignId));
                if (rowCamp) {
                    rowCamp.status = st.status;
                    rowCamp.successVisits = st.success;
                    rowCamp.failedVisits = st.failed;
                    if (st.target !== undefined) rowCamp.targetLimit = st.target;
                    renderAdminCampaignsTable(state.adminCampaigns);
                }
            }
        });
    }

    async function reconnectSocket() {
        await initSocket();
    }

    function resumeRunningDemoCampaigns() {
        if (state.mode !== 'demo') return;
        const db = loadDemoDb();
        for (const ord of db.orders) {
            if (ord.paymentStatus === 'paid' && ord.status === 'running') {
                startDemoCampaignSimulation(ord.orderId);
            }
        }
    }

    async function applyRuntimeMode(nextMode, rawBackendUrl = '') {
        showAlert('runtime-conn-msg', '');
        clearAllDemoTimers();
        stopOrderPolling();
        clearActiveOrderView();
        state.adminOrders = [];
        state.adminCampaigns = [];
        state.adminLoadingPromise = null;
        state.campaignLogs.clear();

        if (nextMode === 'remote') {
            const cleanUrl = normalizeBackendUrl(rawBackendUrl);
            if (!cleanUrl) {
                showAlert('runtime-conn-msg', 'URL Backend Tunnel không hợp lệ (cần bắt đầu bằng https:// hoặc http://).', 'err');
                return false;
            }
            state.mode = 'remote';
            state.backendUrl = cleanUrl;
            state.bearerToken = loadSavedRemoteToken(cleanUrl);
            try {
                localStorage.setItem(REMOTE_BACKEND_KEY, cleanUrl);
                localStorage.removeItem('boost_prefer_demo_v1');
            } catch (e) {}
            renderRuntimeModeUI();
            const ok = await refreshPublicConfig();
            if (!ok) {
                showAlert('runtime-conn-msg', `Không kết nối được Backend tại ${cleanUrl}. Hãy kiểm tra server + Cloudflare Tunnel đang chạy, hoặc bấm "Chế độ Demo tĩnh".`, 'err');
                await initSocket();
                return false;
            }
            await initSocket();
            showAlert('runtime-conn-msg', `Đã kết nối Backend thật tại ${cleanUrl}.`, 'ok');
            await updateCostAndDistribution();
            return true;
        }

        if (nextMode === 'demo') {
            state.mode = 'demo';
            state.backendUrl = '';
            state.bearerToken = '';
            try { localStorage.setItem('boost_prefer_demo_v1', '1'); } catch (e) {}
            renderRuntimeModeUI();
            await initSocket();
            await refreshPublicConfig();
            resumeRunningDemoCampaigns();
            await updateCostAndDistribution();
            return true;
        }

        // Default same-origin live Express mode
        state.mode = 'same-origin';
        state.backendUrl = '';
        state.bearerToken = '';
        try {
            localStorage.removeItem('boost_prefer_demo_v1');
            localStorage.removeItem(REMOTE_BACKEND_KEY);
        } catch (e) {}
        renderRuntimeModeUI();
        await initSocket();
        await refreshPublicConfig();
        await updateCostAndDistribution();
        return true;
    }

    // ─── Event Wiring ─────────────────────────────────────────────────────────
    function switchTab(tab) {
        state.activeTab = tab === 'admin' ? 'admin' : 'customer';
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
        });
        $('tab-customer').classList.toggle('hidden', state.activeTab !== 'customer');
        $('tab-admin').classList.toggle('hidden', state.activeTab !== 'admin');
        if (state.activeTab === 'admin' && state.config.role === 'admin') {
            loadAdminDashboard();
        }
    }

    function bindEvents() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        $('connect-backend-btn').addEventListener('click', () => {
            applyRuntimeMode('remote', $('backend-url-input').value);
        });
        $('backend-url-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyRuntimeMode('remote', $('backend-url-input').value);
            }
        });
        $('use-demo-mode-btn').addEventListener('click', () => {
            applyRuntimeMode('demo');
        });
        $('use-same-origin-btn').addEventListener('click', () => {
            applyRuntimeMode('same-origin');
        });

        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $('f-hours').value = btn.dataset.hours;
                updateCostAndDistribution();
            });
        });

        ['f-clicks', 'f-hours'].forEach(id => {
            $(id).addEventListener('input', scheduleCostRefresh);
            $(id).addEventListener('change', updateCostAndDistribution);
        });
        $('f-schedule').addEventListener('change', updateCostAndDistribution);
        ['cb-night', 'cb-early', 'cb-morn', 'cb-noon', 'cb-after', 'cb-eve', 'cb-late'].forEach(id => {
            $(id).addEventListener('change', updateCostAndDistribution);
        });
        $('dist-preview-footer').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action="toggle-preview-slices"]');
            if (!btn) return;
            state.expandPreviewSlices = !state.expandPreviewSlices;
            const targetClicks = Number($('f-clicks').value);
            const durationHours = Number($('f-hours').value);
            const mode = $('f-schedule').value;
            renderDistributionPreview(
                Number.isInteger(targetClicks) ? targetClicks : 0,
                Number.isFinite(durationHours) ? durationHours : 0,
                mode,
                mode === 'custom' ? getCustomBlocksFromUI() : null
            );
        });

        $('boost-form').addEventListener('submit', handleOrderSubmit);

        $('lookup-order-btn').addEventListener('click', () => {
            selectOrder($('lookup-order-id').value);
        });
        $('lookup-order-id').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                selectOrder($('lookup-order-id').value);
            }
        });

        $('recent-orders-wrap').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            if (btn.dataset.action === 'load-recent') selectOrder(id);
            if (btn.dataset.action === 'del-recent') removeRecentOrder(id);
        });

        $('recheck-order-btn').addEventListener('click', fetchActiveOrder);
        $('refresh-order-btn').addEventListener('click', fetchActiveOrder);
        $('download-report-btn').addEventListener('click', downloadActiveReport);

        $('copy-acc-btn').addEventListener('click', () => copyText($('ao-acc-num').textContent, $('copy-acc-btn')));
        $('copy-amt-btn').addEventListener('click', () => copyText(String((state.activeOrder && state.activeOrder.totalAmount) || ''), $('copy-amt-btn')));
        $('copy-memo-btn').addEventListener('click', () => copyText($('ao-memo').textContent, $('copy-memo-btn')));

        $('inline-admin-confirm-btn').addEventListener('click', () => {
            if (state.activeOrderId) confirmOrderAsAdmin(state.activeOrderId);
        });
        $('inline-admin-stop-btn').addEventListener('click', () => {
            const campId = state.activeOrder && ((state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId);
            if (campId) stopCampaignAsAdmin(campId);
        });

        $('open-login-btn').addEventListener('click', openLoginModal);
        $('gate-open-login-btn').addEventListener('click', openLoginModal);
        $('close-login-btn').addEventListener('click', closeLoginModal);
        $('login-modal').addEventListener('click', (e) => {
            if (e.target === $('login-modal')) closeLoginModal();
        });
        $('boost-login-form').addEventListener('submit', handleLoginSubmit);
        $('logout-btn').addEventListener('click', handleLogout);

        $('adm-filter').addEventListener('change', renderAdminOrdersTable);
        $('adm-refresh-orders-btn').addEventListener('click', loadAdminOrders);
        $('adm-refresh-campaigns-btn').addEventListener('click', loadAdminCampaigns);
        $('adm-paycfg-form').addEventListener('submit', handlePaymentConfigSubmit);
        $('adm-proxycfg-form').addEventListener('submit', handleProxyConfigSubmit);
        $('clear-global-log-btn').addEventListener('click', () => { $('adm-global-log').innerHTML = ''; });

        $('adm-campaigns-body').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'camp-stop' && id) {
                await stopCampaignAsAdmin(id);
            } else if (action === 'camp-reset' && id) {
                await resetCampaignStatsAsAdmin(id);
            }
        });

        $('adm-orders-body').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            const campId = btn.dataset.campId;
            if (action === 'adm-view' && id) {
                switchTab('customer');
                await selectOrder(id);
            } else if (action === 'adm-confirm' && id) {
                await confirmOrderAsAdmin(id);
            } else if (action === 'adm-stop' && campId) {
                await stopCampaignAsAdmin(campId);
            } else if (action === 'adm-delete' && id) {
                const { res, data } = await apiJson('/api/admin/orders/' + encodeURIComponent(id), { method: 'DELETE' });
                if (!res.ok || !data.success) {
                    showAlert('adm-action-msg', data.message || 'Không thể xóa đơn.', 'err');
                } else {
                    showAlert('adm-action-msg', `Đã xóa đơn ${id}.`, 'ok');
                    removeRecentOrder(id);
                    if (state.activeOrderId === id) {
                        clearActiveOrderView();
                    }
                    await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
                }
            }
        });
    }

    function fallbackExecCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return !!ok;
        } catch (e) {
            return false;
        }
    }

    function copyText(text, btn) {
        if (!text || text === '--') return;
        const flash = (label) => {
            if (!btn) return;
            const prev = btn.dataset.origLabel || btn.textContent;
            btn.dataset.origLabel = prev;
            btn.textContent = label;
            setTimeout(() => { btn.textContent = prev; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => flash('Đã chép'))
                .catch(() => flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép'));
        } else {
            flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép');
        }
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    async function boot() {
        bindEvents();
        renderRecentOrders();

        const params = new URLSearchParams(window.location.search);
        const backendParam = params.get('backend');
        const modeParam = params.get('mode');
        const initialOrderId = params.get('orderId') || params.get('order');

        let savedRemote = '';
        let preferDemo = false;
        try {
            savedRemote = normalizeBackendUrl(localStorage.getItem(REMOTE_BACKEND_KEY));
            preferDemo = localStorage.getItem('boost_prefer_demo_v1') === '1';
        } catch (e) {}

        if (backendParam) {
            const ok = await applyRuntimeMode('remote', backendParam);
            if (!ok) {
                await applyRuntimeMode('demo');
                showAlert('runtime-conn-msg', `Tunnel ${backendParam} hiện chưa phản hồi — đã tự chuyển sang Static Demo để xem giao diện.`, 'warn');
            }
        } else if (modeParam === 'demo') {
            await applyRuntimeMode('demo');
        } else if (isStaticHostingEnv()) {
            if (savedRemote && !preferDemo) {
                const ok = await applyRuntimeMode('remote', savedRemote);
                if (!ok) {
                    await applyRuntimeMode('demo');
                    showAlert('runtime-conn-msg', `Tunnel đã lưu (${savedRemote}) hiện chưa chạy — đang mở Static Demo.`, 'warn');
                }
            } else {
                await applyRuntimeMode('demo');
            }
        } else {
            state.mode = 'same-origin';
            renderRuntimeModeUI();
            await initSocket();
            await refreshPublicConfig();
            await updateCostAndDistribution();
        }

        if (initialOrderId) {
            await selectOrder(initialOrderId);
        }
    }

    document.addEventListener('DOMContentLoaded', boot);
})();
