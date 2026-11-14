(function (global) {
    'use strict';

    const PRICING = Object.freeze({
        clickRate: 40,
        hourlyRate: 2000,
        currency: 'VND',
        defaultTemplate: 'compact2'
    });

    const ORDER_EXPIRE_MINUTES = 30;
    const ORDER_EXPIRE_MS = ORDER_EXPIRE_MINUTES * 60 * 1000;
    const MAX_PREVIEW_HOURS = 8760;
    const COLLAPSED_PREVIEW_LIMIT = 48;
    const LOG_RING_BUFFER_MAX = 200;
    const MAX_RECENT_ORDERS = 12;

    const STORAGE_KEYS = Object.freeze({
        RECENT_ORDERS: 'boost_recent_orders_v1',
        REMOTE_BACKEND: 'boost_remote_backend_v1',
        REMOTE_TOKEN_PREFIX: 'boost_remote_token_v1:',
        DEMO_DB: 'boost_demo_db_v1',
        PREFER_DEMO: 'boost_prefer_demo_v1'
    });

    const DWELL_PRESETS = Object.freeze({
        short: Object.freeze({ key: 'short', label: 'Nhanh (2–5s)', min: 2, max: 5 }),
        medium: Object.freeze({ key: 'medium', label: 'Trung bình (5–10s)', min: 5, max: 10 }),
        long: Object.freeze({ key: 'long', label: 'Đọc sâu (10–20s)', min: 10, max: 20 })
    });

    const DEVICE_PROFILES = Object.freeze({
        mixed: Object.freeze({ key: 'mixed', label: 'Hỗn hợp Mobile + Desktop' }),
        mobile: Object.freeze({ key: 'mobile', label: 'Mobile (iOS / Android)' }),
        desktop: Object.freeze({ key: 'desktop', label: 'Desktop (Windows / macOS)' })
    });

    function $(id) {
        return document.getElementById(id);
    }

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
        try {
            return new Date(ts).toLocaleString('vi-VN');
        } catch (e) {
            return '--';
        }
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
        if (global.__STATIC_DEMO_MODE__ === true) return true;
        if (global.location && global.location.protocol === 'file:') return true;
        return /\.(pages\.dev|github\.io)$/i.test((global.location && global.location.hostname) || '');
    }

    function loadSavedRemoteToken(backendOrigin) {
        if (!backendOrigin) return '';
        try {
            return sessionStorage.getItem(STORAGE_KEYS.REMOTE_TOKEN_PREFIX + backendOrigin) || '';
        } catch (e) {
            return '';
        }
    }

    function saveRemoteToken(backendOrigin, token) {
        if (!backendOrigin) return;
        try {
            if (token) sessionStorage.setItem(STORAGE_KEYS.REMOTE_TOKEN_PREFIX + backendOrigin, token);
            else sessionStorage.removeItem(STORAGE_KEYS.REMOTE_TOKEN_PREFIX + backendOrigin);
        } catch (e) {}
    }

    function maskProxyKey(key) {
        if (!key || typeof key !== 'string') return '';
        const trimmed = key.trim();
        return trimmed.length > 4 ? `...${trimmed.slice(-4)}` : '****';
    }

    const DWELL_ALIASES = { quick: 'short', standard: 'medium', deep: 'long' };
    const DEVICE_ALIASES = { balanced: 'mixed' };

    function normalizeDwellPreset(val) {
        const raw = String(val || '').trim().toLowerCase();
        const key = DWELL_ALIASES[raw] || raw;
        return Object.prototype.hasOwnProperty.call(DWELL_PRESETS, key) ? key : 'short';
    }

    function normalizeDeviceProfile(val) {
        const raw = String(val || '').trim().toLowerCase();
        const key = DEVICE_ALIASES[raw] || raw;
        return Object.prototype.hasOwnProperty.call(DEVICE_PROFILES, key) ? key : 'mixed';
    }

    function formatDwellLabel(val) {
        return DWELL_PRESETS[normalizeDwellPreset(val)].label;
    }

    function formatDeviceLabel(val) {
        return DEVICE_PROFILES[normalizeDeviceProfile(val)].label;
    }

    /**
     * Mirror orderService.calculateOrderCost pricing rules on client/static demo.
     */
    function calculateOrderCost(targetClicks, durationHours, pricing = PRICING) {
        const clicks = Number(targetClicks);
        const hours = Number(durationHours);
        if (!Number.isInteger(clicks) || clicks < 1) {
            return { error: 'targetClicks must be a positive integer greater than or equal to 1' };
        }
        if (!Number.isFinite(hours) || hours <= 0) {
            return { error: 'durationHours must be a positive number greater than 0' };
        }
        const clickRate = Number((pricing && pricing.clickRate) || PRICING.clickRate);
        const hourlyRate = Number((pricing && pricing.hourlyRate) || PRICING.hourlyRate);
        const roundedHours = Math.ceil(hours);
        const clickFee = clicks * clickRate;
        const durationFee = roundedHours * hourlyRate;
        return {
            targetClicks: clicks,
            durationHours: hours,
            roundedHours,
            clickRate,
            hourlyRate,
            clickFee,
            durationFee,
            totalAmount: clickFee + durationFee
        };
    }

    /**
     * Validate order payload before submission (mirrors orderService.validateOrderParams).
     */
    function validateOrderPayload(params) {
        const errors = [];
        if (!params || typeof params !== 'object') {
            return { valid: false, errors: ['Dữ liệu đơn hàng không hợp lệ.'] };
        }
        const targetUrl = typeof params.targetUrl === 'string' ? params.targetUrl.trim() : '';
        let validUrl = false;
        try {
            const parsed = new URL(targetUrl);
            validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (e) {}
        if (!validUrl) errors.push('URL đích phải bắt đầu bằng http:// hoặc https://.');

        const proxyKey = typeof params.proxyKey === 'string' ? params.proxyKey.trim() : '';
        if (!proxyKey) errors.push('Vui lòng nhập KiotProxy Key.');

        const cost = calculateOrderCost(params.targetClicks, params.durationHours);
        if (cost.error) errors.push(cost.error);

        return {
            valid: errors.length === 0,
            errors,
            cost: cost.error ? null : cost
        };
    }

    /**
     * Resolve effective order status, treating unpaid orders past expiresAt as 'expired'.
     */
    function getEffectiveOrderStatus(order) {
        if (!order) return 'pending_payment';
        const progStatus = order.progress && order.progress.status;
        const rawStatus = progStatus || order.effectiveStatus || order.status || 'pending_payment';
        if (rawStatus === 'expired') return 'expired';
        if (order.paymentStatus !== 'paid' && order.expiresAt && Date.now() >= Number(order.expiresAt)) {
            return 'expired';
        }
        return rawStatus;
    }

    function appendRingLogLine(boxId, text, type = 'info', timeStr = null, maxLines = LOG_RING_BUFFER_MAX) {
        const box = $(boxId);
        if (!box) return;
        const p = document.createElement('div');
        p.className = `log-line ${type || 'info'}`;
        const time = timeStr || new Date().toLocaleTimeString('vi-VN');
        p.textContent = `[${time}] ${text}`;
        box.appendChild(p);
        const cap = Math.max(1, Number(maxLines) || LOG_RING_BUFFER_MAX);
        while (box.children.length > cap) {
            box.removeChild(box.firstChild);
        }
        box.scrollTop = box.scrollHeight;
    }

    function buildOrderReportText(order, runtimeLabel) {
        const p = order.progress || {};
        const effectiveStatus = getEffectiveOrderStatus(order);
        const dwell = formatDwellLabel(order.dwellPreset || p.dwellPreset);
        const device = formatDeviceLabel(order.deviceProfile || p.deviceProfile);
        const lines = [
            '=== BAO CAO DON HANG TRAFFIC BOOST ===',
            `Che do he thong: ${runtimeLabel}`,
            `Ma don (Order ID): ${order.orderId}`,
            `Ma chuyen khoan (Order Code): ${order.orderCode}`,
            `Ten chien dich: ${order.name || ''}`,
            `URL dich: ${order.targetUrl}`,
            `Proxy Key (da che): ${order.proxyKeyMasked || '--'}`,
            `Che do thuc thi: ${p.browserMode || order.browserMode || 'request'} (Axios + KiotProxy)`,
            `Phan bo thoi gian: ${order.scheduleMode || 'smart'} | dedupIp=${order.dedupIp !== false} | randomLinks=${order.randomLinks !== false}`,
            `Hanh vi luu trang: ${dwell} (${normalizeDwellPreset(order.dwellPreset || p.dwellPreset)}) | Thiet bi: ${device} (${normalizeDeviceProfile(order.deviceProfile || p.deviceProfile)})`,
            `Trang thai thanh toan: ${order.paymentStatus}`,
            `Trang thai don / chien dich: ${effectiveStatus}`,
            `Campaign ID: ${p.campaignId || order.campaignId || 'Chua kich hoat'}`,
            `So tien: ${Number(order.totalAmount || 0).toLocaleString('vi-VN')} VND`,
            `Muc tieu click: ${order.targetClicks}`,
            `Luot thanh cong: ${p.successVisits ?? order.successVisits ?? 0}`,
            `Luot that bai: ${p.failedVisits ?? order.failedVisits ?? 0}`,
            `Tong thu: ${p.totalVisits ?? order.totalVisits ?? 0}`,
            `IP duy nhat: ${p.uniqueIps ?? order.uniqueIps ?? 0}`,
            `IP trung bi bo qua: ${p.dupIps ?? order.dupIps ?? 0}`,
            `Thoi gian tao: ${fmtTime(order.createdAt)}`,
            `Han thanh toan: ${fmtTime(order.expiresAt)}`,
            `Thoi gian thanh toan: ${fmtTime(order.paidAt)}`,
            `Ket thuc du kien/thuc te: ${fmtTime(p.actualEndTime || p.endTime || order.completedAt)}`
        ];
        return lines.join('\n');
    }

    function escapeCsvCell(value) {
        let str = value == null ? '' : String(value);
        if (/^[=+\-@\t\r]/.test(str)) {
            str = "'" + str;
        }
        return `"${str.replace(/"/g, '""')}"`;
    }

    function buildOrderCsvContent(order, runtimeLabel) {
        const p = order.progress || {};
        const effectiveStatus = getEffectiveOrderStatus(order);
        const headers = [
            'orderId',
            'orderCode',
            'name',
            'targetUrl',
            'proxyKeyMasked',
            'runtimeMode',
            'paymentStatus',
            'status',
            'campaignId',
            'targetClicks',
            'durationHours',
            'roundedHours',
            'totalAmountVND',
            'scheduleMode',
            'dwellPreset',
            'deviceProfile',
            'dedupIp',
            'randomLinks',
            'successVisits',
            'failedVisits',
            'totalVisits',
            'uniqueIps',
            'dupIps',
            'createdAt',
            'expiresAt',
            'paidAt',
            'completedAt'
        ];
        const values = [
            order.orderId || '',
            order.orderCode || '',
            order.name || '',
            order.targetUrl || '',
            order.proxyKeyMasked || '',
            runtimeLabel || '',
            order.paymentStatus || '',
            effectiveStatus,
            p.campaignId || order.campaignId || '',
            order.targetClicks ?? 0,
            order.durationHours ?? 0,
            order.roundedHours ?? 0,
            order.totalAmount ?? 0,
            order.scheduleMode || 'smart',
            normalizeDwellPreset(order.dwellPreset || p.dwellPreset),
            normalizeDeviceProfile(order.deviceProfile || p.deviceProfile),
            order.dedupIp !== false,
            order.randomLinks !== false,
            p.successVisits ?? order.successVisits ?? 0,
            p.failedVisits ?? order.failedVisits ?? 0,
            p.totalVisits ?? order.totalVisits ?? 0,
            p.uniqueIps ?? order.uniqueIps ?? 0,
            p.dupIps ?? order.dupIps ?? 0,
            order.createdAt ? new Date(order.createdAt).toISOString() : '',
            order.expiresAt ? new Date(order.expiresAt).toISOString() : '',
            order.paidAt ? new Date(order.paidAt).toISOString() : '',
            (p.actualEndTime || order.completedAt) ? new Date(p.actualEndTime || order.completedAt).toISOString() : ''
        ];
        return '\uFEFF' + headers.map(escapeCsvCell).join(',') + '\n' + values.map(escapeCsvCell).join(',') + '\n';
    }

    function downloadBlobFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
            global.navigator.clipboard.writeText(text)
                .then(() => flash('Đã chép'))
                .catch(() => flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép'));
        } else {
            flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép');
        }
    }

    global.BoostShared = {
        PRICING,
        ORDER_EXPIRE_MINUTES,
        ORDER_EXPIRE_MS,
        MAX_PREVIEW_HOURS,
        COLLAPSED_PREVIEW_LIMIT,
        LOG_RING_BUFFER_MAX,
        MAX_RECENT_ORDERS,
        STORAGE_KEYS,
        DWELL_PRESETS,
        DEVICE_PROFILES,
        $,
        esc,
        fmtVnd,
        fmtTime,
        showAlert,
        normalizeBackendUrl,
        isStaticHostingEnv,
        loadSavedRemoteToken,
        saveRemoteToken,
        maskProxyKey,
        normalizeDwellPreset,
        normalizeDeviceProfile,
        formatDwellLabel,
        formatDeviceLabel,
        calculateOrderCost,
        validateOrderPayload,
        getEffectiveOrderStatus,
        appendRingLogLine,
        buildOrderReportText,
        buildOrderCsvContent,
        downloadBlobFile,
        copyText
    };
})(window);
