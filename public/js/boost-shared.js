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
            return { valid: false, errors: ['Dữ liệu chiến dịch không hợp lệ.'] };
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

        let effectiveDurationHours = params.durationHours;
        let windowMeta = null;
        if (params.scheduleType === 'window') {
            windowMeta = computeVietnamScheduleWindow({
                runDate: params.runDate,
                startTime: params.startTime || params.startTimeText,
                endTime: params.endTime || params.endTimeText,
                allowPast: params.allowPast === true
            });
            if (!windowMeta.valid) {
                errors.push(windowMeta.message || 'Khung giờ hẹn chạy không hợp lệ.');
            } else {
                effectiveDurationHours = windowMeta.durationHours;
            }
        }

        const cost = calculateOrderCost(params.targetClicks, effectiveDurationHours);
        if (cost.error) errors.push(cost.error);

        return {
            valid: errors.length === 0,
            errors,
            cost: cost.error ? null : cost,
            windowMeta: windowMeta && windowMeta.valid ? windowMeta : null
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
        const schedSummary = formatScheduleWindowSummary(order);
        const lines = [
            '=== BAO CAO CHIEN DICH TRAFFIC BOOST ===',
            `Che do he thong: ${runtimeLabel}`,
            `Ma don (Order ID): ${order.orderId}`,
            `Ma tham chieu (Order Code): ${order.orderCode}`,
            `Ten chien dich: ${order.name || ''}`,
            `URL dich: ${order.targetUrl}`,
            `Proxy Key (da che): ${order.proxyKeyMasked || '--'}`,
            `Lich chay: ${schedSummary}`,
            `Che do thuc thi: ${p.browserMode || order.browserMode || 'request'} (Axios + KiotProxy)`,
            `Phan bo thoi gian: ${order.scheduleMode || 'smart'} | dedupIp=${order.dedupIp !== false} | randomLinks=${order.randomLinks !== false}`,
            `Hanh vi luu trang: ${dwell} (${normalizeDwellPreset(order.dwellPreset || p.dwellPreset)}) | Thiet bi: ${device} (${normalizeDeviceProfile(order.deviceProfile || p.deviceProfile)})`,
            `Trang thai don / chien dich: ${effectiveStatus}`,
            `Campaign ID: ${p.campaignId || order.campaignId || 'Chua kich hoat'}`,
            `Muc tieu click: ${order.targetClicks}`,
            `Luot thanh cong: ${p.successVisits ?? order.successVisits ?? 0}`,
            `Luot that bai: ${p.failedVisits ?? order.failedVisits ?? 0}`,
            `Tong thu: ${p.totalVisits ?? order.totalVisits ?? 0}`,
            `IP duy nhat: ${p.uniqueIps ?? order.uniqueIps ?? 0}`,
            `IP trung bi bo qua: ${p.dupIps ?? order.dupIps ?? 0}`,
            `Thoi gian tao: ${fmtTime(order.createdAt)}`,
            `Bat dau du kien: ${formatVnDateTime(order.scheduledStartAt || p.startTime)}`,
            `Ket thuc du kien/thuc te: ${formatVnDateTime(p.actualEndTime || order.scheduledEndAt || p.endTime || order.completedAt)}`
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

    function getButtonLabelTarget(btn) {
        if (!btn || typeof btn.querySelector !== 'function') return null;
        return btn.querySelector('.btn-label, [data-btn-label]') || null;
    }

    function setButtonTextSafe(btn, text) {
        if (!btn) return;
        const target = getButtonLabelTarget(btn);
        if (target) {
            target.textContent = text;
        } else {
            btn.textContent = text;
        }
    }

    function setButtonLoading(btn, isLoading, loadingText) {
        if (!btn) return;
        const target = getButtonLabelTarget(btn);
        if (isLoading) {
            if (btn.dataset.origLabel === undefined) {
                btn.dataset.origLabel = target ? target.textContent : btn.textContent;
            }
            btn.disabled = true;
            btn.classList.add('is-loading');
            btn.setAttribute('aria-busy', 'true');
            if (loadingText) {
                setButtonTextSafe(btn, loadingText);
            }
        } else {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btn.removeAttribute('aria-busy');
            if (btn.dataset.origLabel !== undefined) {
                setButtonTextSafe(btn, btn.dataset.origLabel);
                delete btn.dataset.origLabel;
            }
        }
    }

    function buildTrackOrderUrl(orderId, mode, backendUrl) {
        const cleanId = String(orderId || '').trim();
        if (!cleanId) return '';
        const encoded = encodeURIComponent(cleanId);
        if (mode === 'remote' && backendUrl) {
            return `${backendUrl}/track.html?orderId=${encoded}`;
        }
        if (mode === 'demo') {
            try {
                const u = new URL(global.location.href);
                u.searchParams.delete('backend');
                u.searchParams.set('mode', 'demo');
                u.searchParams.set('orderId', cleanId);
                u.searchParams.delete('order');
                return u.toString();
            } catch (e) {
                return `?mode=demo&orderId=${encoded}`;
            }
        }
        const origin = (global.location && global.location.origin) ? global.location.origin : '';
        return `${origin}/track.html?orderId=${encoded}`;
    }

    function copyText(text, btn) {
        if (!text || text === '--') return;
        const flash = (label) => {
            if (!btn) return;
            const target = getButtonLabelTarget(btn);
            const currentText = target ? target.textContent : btn.textContent;
            const prev = btn.dataset.copyOrigLabel || currentText;
            btn.dataset.copyOrigLabel = prev;
            if (btn._copyTimer) clearTimeout(btn._copyTimer);
            setButtonTextSafe(btn, label);
            btn.classList.add('is-copied');
            btn._copyTimer = setTimeout(() => {
                setButtonTextSafe(btn, prev);
                btn.classList.remove('is-copied');
                delete btn.dataset.copyOrigLabel;
                btn._copyTimer = null;
            }, 1200);
        };
        if (typeof global.navigator !== 'undefined' && global.navigator.clipboard && global.navigator.clipboard.writeText) {
            global.navigator.clipboard.writeText(text)
                .then(() => flash('Đã chép'))
                .catch(() => flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép'));
        } else {
            flash(fallbackExecCopy(text) ? 'Đã chép' : 'Lỗi chép');
        }
    }

    // ─── Vietnam Timezone (UTC+7 / Asia/Ho_Chi_Minh) Schedule Window Helpers ──
    const VN_UTC_OFFSET_MS = 7 * 3600 * 1000;

    function pad2(n) {
        return String(Math.floor(Math.abs(Number(n) || 0))).padStart(2, '0');
    }

    function getVietnamDateISO(ms = Date.now()) {
        const d = new Date(Number(ms) + VN_UTC_OFFSET_MS);
        return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }

    function getVietnamTimeHHMM(ms = Date.now()) {
        const d = new Date(Number(ms) + VN_UTC_OFFSET_MS);
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    }

    function addDaysToIsoDate(isoDate, deltaDays) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
        if (!m) return '';
        const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
        const utc = new Date(Date.UTC(y, mo - 1, da + (Number(deltaDays) || 0)));
        return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
    }

    function formatVnDateDMY(isoDate) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || '').trim());
        if (!m) return String(isoDate || '--');
        return `${m[3]}/${m[2]}/${m[1]}`;
    }

    function formatVnDateTime(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return '--';
        const d = new Date(n + VN_UTC_OFFSET_MS);
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} ${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    }

    function formatClock12h(hhmm) {
        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
        if (!m) return String(hhmm || '--');
        const h24 = Number(m[1]);
        const min = m[2];
        const period = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 === 0 ? 12 : (h24 % 12);
        return `${h12}:${min} ${period}`;
    }

    function getNextVietnamDefaultSlot(nowMs = Date.now()) {
        const shifted = new Date(Number(nowMs) + VN_UTC_OFFSET_MS);
        shifted.setUTCMinutes(0, 0, 0);
        shifted.setUTCHours(shifted.getUTCHours() + 1);
        const startMs = shifted.getTime() - VN_UTC_OFFSET_MS;
        const endMs = startMs + 3600 * 1000;
        return {
            runDate: getVietnamDateISO(startMs),
            startTime: getVietnamTimeHHMM(startMs),
            endTime: getVietnamTimeHHMM(endMs)
        };
    }

    function computeVietnamScheduleWindow(input = {}) {
        const runDate = String(input.runDate || '').trim();
        const startTime = String(input.startTime || input.startTimeText || '').trim();
        const endTime = String(input.endTime || input.endTimeText || '').trim();
        const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
        const allowPast = input.allowPast === true;

        const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
        if (!dm) {
            return { valid: false, code: 'INVALID_DATE', message: 'Ngày chạy không hợp lệ (định dạng YYYY-MM-DD).' };
        }
        const y = Number(dm[1]), mo = Number(dm[2]), da = Number(dm[3]);
        const probe = new Date(Date.UTC(y, mo - 1, da));
        if (probe.getUTCFullYear() !== y || (probe.getUTCMonth() + 1) !== mo || probe.getUTCDate() !== da) {
            return { valid: false, code: 'INVALID_DATE', message: 'Ngày chạy không tồn tại trên lịch.' };
        }

        const sm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime);
        const em = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(endTime);
        if (!sm || !em) {
            return { valid: false, code: 'INVALID_TIME', message: 'Giờ bắt đầu và giờ kết thúc phải đúng định dạng HH:MM.' };
        }

        const sh = Number(sm[1]), smin = Number(sm[2]);
        const eh = Number(em[1]), emin = Number(em[2]);
        const startMinutes = sh * 60 + smin;
        const endMinutes = eh * 60 + emin;

        if (startMinutes === endMinutes) {
            return { valid: false, code: 'SAME_TIME', message: 'Giờ kết thúc phải khác giờ bắt đầu.' };
        }

        const overnight = endMinutes < startMinutes;
        const durationMinutes = overnight ? (1440 - startMinutes + endMinutes) : (endMinutes - startMinutes);
        const durationHours = Number((durationMinutes / 60).toFixed(4));
        const scheduledStartAt = Date.UTC(y, mo - 1, da, sh, smin, 0, 0) - VN_UTC_OFFSET_MS;
        const scheduledEndAt = scheduledStartAt + durationMinutes * 60 * 1000;
        const endRunDate = getVietnamDateISO(scheduledEndAt);
        const isPast = !allowPast && scheduledEndAt <= (nowMs - 60000);
        const isInProgressWindow = scheduledStartAt <= nowMs && scheduledEndAt > nowMs;

        return {
            valid: !isPast,
            isPast,
            isInProgressWindow,
            code: isPast ? 'WINDOW_IN_PAST' : 'OK',
            message: isPast
                ? `Khung giờ ${startTime} – ${endTime} ngày ${formatVnDateDMY(runDate)} đã qua theo giờ Việt Nam.`
                : '',
            runDate,
            endRunDate,
            startTime,
            endTime,
            overnight,
            durationMinutes,
            durationHours,
            scheduledStartAt,
            scheduledEndAt,
            timezone: 'Asia/Ho_Chi_Minh'
        };
    }

    function formatDurationCompactVi(durationHours, durationMinutes) {
        const mins = Number.isFinite(Number(durationMinutes))
            ? Math.round(Number(durationMinutes))
            : Math.round((Number(durationHours) || 0) * 60);
        if (mins <= 0) return '0p';
        if (mins < 60) return `${mins} phút`;
        const h = Math.floor(mins / 60);
        const rem = mins % 60;
        return rem > 0 ? `${h}g ${rem}p` : `${h} giờ`;
    }

    function formatScheduleWindowSummary(obj) {
        if (!obj || obj.scheduleType !== 'window' || !obj.runDate || !obj.startTime || !obj.endTime) {
            const h = Number(obj && obj.durationHours) || 1;
            return `Chạy ngay · ${h} giờ`;
        }
        const dur = formatDurationCompactVi(obj.durationHours, obj.durationMinutes);
        const start12 = formatClock12h(obj.startTime);
        const end12 = formatClock12h(obj.endTime);
        const startDmy = formatVnDateDMY(obj.runDate);
        if (obj.overnight) {
            const endDmy = formatVnDateDMY(obj.endRunDate || addDaysToIsoDate(obj.runDate, 1));
            return `${startDmy} ${obj.startTime} (${start12}) → ${endDmy} ${obj.endTime} (${end12}) · Qua đêm +1 ngày · ${dur} (Giờ VN)`;
        }
        return `${startDmy} · ${obj.startTime} – ${obj.endTime} (${start12} – ${end12} · ${dur} · Giờ VN)`;
    }

    function formatCountdownVn(targetMs, nowMs = Date.now()) {
        const diff = Math.max(0, Number(targetMs) - Number(nowMs));
        if (diff <= 0) return 'Đang vào giờ chạy';
        const totalSec = Math.floor(diff / 1000);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        if (days > 0) return `${days} ngày ${hours}g ${mins}p`;
        if (hours > 0) return `${hours}g ${mins}p`;
        if (mins > 0) return `${mins}p ${secs}s`;
        return `${secs}s`;
    }

    const exported = {
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
        VN_UTC_OFFSET_MS,
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
        getButtonLabelTarget,
        setButtonTextSafe,
        setButtonLoading,
        buildTrackOrderUrl,
        copyText,
        getVietnamDateISO,
        getVietnamTimeHHMM,
        addDaysToIsoDate,
        formatVnDateDMY,
        formatVnDateTime,
        formatClock12h,
        getNextVietnamDefaultSlot,
        computeVietnamScheduleWindow,
        formatDurationCompactVi,
        formatScheduleWindowSummary,
        formatCountdownVn
    };

    global.BoostShared = exported;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }
})(typeof window !== 'undefined' ? window : globalThis);
