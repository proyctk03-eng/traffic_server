(function () {
    'use strict';

    const S = window.BoostShared;
    const Demo = window.BoostDemo;
    const UI = window.BoostUI;
    const $ = S.$;

    const state = {
        mode: 'same-origin', // 'same-origin' | 'remote' | 'demo'
        backendUrl: '',
        bearerToken: '',
        remoteSocketLoadedFor: '',
        remoteConnectedOnce: false,
        remoteHealthy: true,
        remoteHealthTimer: null,
        config: {
            authRequired: false,
            authenticated: true,
            role: 'admin',
            username: 'admin',
            defaultPasswordWarning: false,
            orderExpireMinutes: S.ORDER_EXPIRE_MINUTES,
            pricing: { clickRate: 40, hourlyRate: 2000, currency: 'VND' },
            browserMode: 'request',
            bankInfo: null
        },
        activeOrder: null,
        activeOrderId: null,
        pollTimer: null,
        countdownTimer: null,
        waitCountdownTimer: null,
        costDebounce: null,
        costRequestSeq: 0,
        socket: null,
        adminOrders: [],
        adminCampaigns: [],
        adminLoadingPromise: null,
        expandPreviewSlices: false,
        campaignLogs: new Map(),
        activeTab: 'customer'
    };

    const orderUiHooks = {
        onStopPolling: stopOrderPolling,
        onStopQrCountdown: stopQrCountdown,
        onStartQrCountdown: startQrCountdown,
        onStartWaitCountdown: startWaitCountdown,
        onStopWaitCountdown: stopWaitCountdown
    };

    const authUiHooks = {
        ...orderUiHooks,
        onAdminAuthenticated: loadAdminDashboard,
        onRenderActiveOrder: (order) => UI.renderActiveOrder(order, state, orderUiHooks)
    };

    function getRuntimeLabel() {
        if (state.mode === 'demo') return 'STATIC DEMO (Mo phong trinh duyet, khong gui traffic that)';
        if (state.mode === 'remote') return `Remote Backend (${state.backendUrl})`;
        return 'Live Same-Origin';
    }

    function stopRemoteHealthMonitor() {
        if (state.remoteHealthTimer) {
            clearInterval(state.remoteHealthTimer);
            state.remoteHealthTimer = null;
        }
    }

    function startRemoteHealthMonitor() {
        if (state.mode !== 'remote' || !state.backendUrl) return;
        if (state.remoteHealthTimer) return;
        state.remoteHealthTimer = setInterval(async () => {
            if (state.mode !== 'remote' || !state.backendUrl) {
                stopRemoteHealthMonitor();
                return;
            }
            let controller = null;
            let abortTimer = null;
            try {
                if (typeof AbortController === 'function') {
                    controller = new AbortController();
                    abortTimer = setTimeout(() => controller.abort(), 4000);
                }
                const res = await fetch(state.backendUrl + '/api/health', {
                    method: 'GET',
                    signal: controller ? controller.signal : undefined
                });
                if (!res.ok) return;
                const data = await res.json();
                if (data && data.status === 'ok') {
                    stopRemoteHealthMonitor();
                    state.remoteHealthy = true;
                    UI.renderRuntimeModeUI(state);
                    S.showAlert('runtime-conn-msg', `Đã tự động kết nối lại Backend Tunnel (${state.backendUrl}).`, 'ok');
                    await refreshPublicConfig();
                    await reconnectSocket();
                }
            } catch (e) {
                // Keep retrying until recovered or user switches to Static Demo
            } finally {
                if (abortTimer) clearTimeout(abortTimer);
            }
        }, 8000);
    }

    function markRemoteDisconnected(reasonText) {
        if (state.mode !== 'remote' || !state.remoteConnectedOnce) return;
        state.remoteHealthy = false;
        UI.renderRuntimeModeUI(state);
        S.showAlert(
            'runtime-conn-msg',
            `${reasonText || 'Tunnel tạm thời mất kết nối.'} Đang tự kiểm tra GET /api/health để nối lại, hoặc bấm "Chế độ Demo tĩnh".`,
            'warn'
        );
        startRemoteHealthMonitor();
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
        while (list.length > S.LOG_RING_BUFFER_MAX) {
            list.shift();
        }
        if (state.campaignLogs.size > 30) {
            const firstKey = state.campaignLogs.keys().next().value;
            state.campaignLogs.delete(firstKey);
        }
        return rec;
    }

    function emitLiveLogEntry(entry) {
        if (!entry) return;
        const rec = recordCampaignLog(entry);
        const line = rec ? rec.line : `[C${entry.campaignId}] ${entry.text}`;
        const time = rec ? rec.time : null;
        UI.appendLogLine('adm-global-log', line, entry.type, time);
        if (state.activeOrder) {
            const activeCampId = (state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId;
            if (activeCampId && String(entry.campaignId) === String(activeCampId)) {
                const box = $('ao-worker-log');
                if (box && box.dataset.campId !== String(activeCampId)) {
                    UI.hydrateOrderWorkerLogs(activeCampId, state.campaignLogs);
                } else {
                    UI.appendLogLine('ao-worker-log', line, entry.type, time);
                }
            }
        }
    }

    function isAdminActive() {
        return state.config.authRequired !== true ||
            Boolean(state.config.authenticated && state.config.role === 'admin');
    }

    function applyPublicConfigData(data) {
        const normalized = Object.assign({}, data);
        if (normalized.authRequired === undefined) {
            normalized.authRequired = !(normalized.authenticated && normalized.role === 'admin');
        }
        if (normalized.authRequired === false) {
            normalized.authenticated = true;
            normalized.role = 'admin';
            normalized.username = normalized.username || 'admin';
            normalized.defaultPasswordWarning = false;
        }
        state.config = normalized;
    }

    Demo.configure({
        isDemoMode: () => state.mode === 'demo',
        getActiveOrderId: () => state.activeOrderId,
        isAdmin: () => isAdminActive(),
        onEmitLog: (campId, text, type) => emitLiveLogEntry({ campaignId: campId, text, type }),
        onOrderUpdated: (orderId) => fetchActiveOrder(orderId),
        onAdminUpdated: () => {
            loadAdminOrders();
            loadAdminCampaigns();
        }
    });

    async function apiJson(path, opts = {}) {
        if (state.mode === 'demo') {
            return Demo.dispatch(path, opts);
        }
        const url = state.mode === 'remote' && state.backendUrl ? (state.backendUrl + path) : path;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (state.mode === 'remote' && state.bearerToken && !headers.Authorization) {
            headers.Authorization = 'Bearer ' + state.bearerToken;
        }
        try {
            const res = await fetch(url, { ...opts, headers });
            if (state.mode === 'remote' && state.remoteHealthy === false && res.ok) {
                state.remoteHealthy = true;
                stopRemoteHealthMonitor();
                UI.renderRuntimeModeUI(state);
            }
            let data = null;
            try { data = await res.json(); } catch (e) { data = { success: false, message: 'Invalid JSON response' }; }
            return { res, data };
        } catch (err) {
            if (state.mode === 'remote') {
                markRemoteDisconnected('Không gọi được API qua Tunnel.');
            }
            throw err;
        }
    }

    // ─── Public Config & Single Admin Auth ────────────────────────────────────
    async function refreshPublicConfig() {
        if (state.mode === 'remote') {
            try {
                const { res, data } = await apiJson('/api/public-config');
                if (res.ok && data && data.success) {
                    applyPublicConfigData(data);
                    state.remoteConnectedOnce = true;
                    state.remoteHealthy = true;
                    UI.renderAuthState(state, authUiHooks);
                    return true;
                }
            } catch (e) {}
            UI.renderAuthState(state, authUiHooks);
            return false;
        }
        try {
            const { res, data } = await apiJson('/api/public-config');
            if (res.ok && data && data.success) {
                applyPublicConfigData(data);
            }
        } catch (e) {}
        UI.renderAuthState(state, authUiHooks);
        return true;
    }

    function openLoginModal() {
        if (state.config.authRequired !== true) return;
        S.showAlert('login-modal-msg', '');
        const demoHint = $('demo-login-hint');
        if (demoHint) {
            if (state.mode === 'demo') {
                demoHint.textContent = 'Static Demo Mode: Dùng tài khoản Admin duy nhất (admin / admin123456) để thử luồng duyệt đơn.';
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
            S.showAlert('login-modal-msg', 'Vui lòng nhập tên đăng nhập và mật khẩu.', 'err');
            return;
        }
        const btn = $('submit-login-btn');
        S.setButtonLoading(btn, true, 'Đang đăng nhập...');
        try {
            const loginHeaders = state.mode === 'remote' ? { 'X-Auth-Mode': 'bearer' } : {};
            const { res, data } = await apiJson('/api/login', {
                method: 'POST',
                headers: loginHeaders,
                body: JSON.stringify({ username, password, rememberMe })
            });
            if (!res.ok || !data.success || (data.role && data.role !== 'admin')) {
                if (res.ok && data.success && data.role && data.role !== 'admin') {
                    apiJson('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
                }
                const errMsg = (data && data.role && data.role !== 'admin')
                    ? 'Chỉ hỗ trợ đăng nhập tài khoản Admin duy nhất.'
                    : ((data && data.message) || 'Đăng nhập thất bại (chỉ hỗ trợ 1 tài khoản Admin).');
                S.showAlert('login-modal-msg', errMsg, 'err');
                return;
            }
            if (state.mode === 'remote' && data.token) {
                state.bearerToken = data.token;
                S.saveRemoteToken(state.backendUrl, data.token);
            }
            $('login-pass').value = '';
            closeLoginModal();
            await reconnectSocket();
            await refreshPublicConfig();
        } catch (err) {
            S.showAlert('login-modal-msg', 'Lỗi kết nối máy chủ khi đăng nhập.', 'err');
        } finally {
            S.setButtonLoading(btn, false);
        }
    }

    async function handleLogout() {
        try {
            await apiJson('/api/logout', { method: 'POST', body: '{}' });
        } catch (e) {}
        if (state.mode === 'remote') {
            state.bearerToken = '';
            S.saveRemoteToken(state.backendUrl, '');
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
        ['adm-action-msg', 'adm-paycfg-msg', 'adm-proxycfg-msg', 'adm-camp-msg'].forEach(id => S.showAlert(id, ''));
        if ($('cfg-secret')) $('cfg-secret').value = '';
        if ($('pcfg-keys')) $('pcfg-keys').value = '';
        await reconnectSocket();
        await refreshPublicConfig();
    }

    // ─── Cost, Proxy Validation & TimeDistribution Preview ────────────────────
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

    function initDefaultScheduleWindow() {
        const slot = S.getNextVietnamDefaultSlot();
        if ($('f-run-date') && !$('f-run-date').value) $('f-run-date').value = slot.runDate;
        if ($('f-start-time')) $('f-start-time').value = slot.startTime;
        if ($('f-end-time')) $('f-end-time').value = slot.endTime;
        setScheduleType('window', { skipRefresh: true });
    }

    function setScheduleType(nextType, opts = {}) {
        const type = nextType === 'duration' ? 'duration' : 'window';
        if ($('f-sched-type')) $('f-sched-type').value = type;
        const winBtn = $('btn-sched-window');
        const durBtn = $('btn-sched-duration');
        if (winBtn) {
            winBtn.classList.toggle('active', type === 'window');
            winBtn.setAttribute('aria-selected', type === 'window' ? 'true' : 'false');
        }
        if (durBtn) {
            durBtn.classList.toggle('active', type === 'duration');
            durBtn.setAttribute('aria-selected', type === 'duration' ? 'true' : 'false');
        }
        if ($('sched-window-fields')) $('sched-window-fields').classList.toggle('hidden', type !== 'window');
        if ($('sched-duration-fields')) $('sched-duration-fields').classList.toggle('hidden', type !== 'duration');
        if (!opts.skipRefresh) {
            updateCostAndDistribution();
        }
    }

    function getWindowValidationFromUI() {
        const schedType = ($('f-sched-type') && $('f-sched-type').value === 'duration') ? 'duration' : 'window';
        if (schedType !== 'window') return { scheduleType: 'duration', win: null };
        const runDate = ($('f-run-date') && $('f-run-date').value) || '';
        const startTime = ($('f-start-time') && $('f-start-time').value) || '';
        const endTime = ($('f-end-time') && $('f-end-time').value) || '';
        const win = S.computeVietnamScheduleWindow({ runDate, startTime, endTime });
        return { scheduleType: 'window', win };
    }

    function renderWindowCalcFeedback(win) {
        const textEl = $('window-calc-text');
        const boxEl = $('window-calc-box');
        const badgeEl = $('window-overnight-badge');
        const alertEl = $('window-alert-box');
        if (!boxEl || !textEl) return;
        if (!win) return;

        if (win.code && ['INVALID_DATE', 'INVALID_TIME', 'SAME_TIME'].includes(win.code)) {
            boxEl.classList.remove('overnight');
            if (badgeEl) badgeEl.classList.add('hidden');
            textEl.textContent = win.message || 'Vui lòng chọn ngày và giờ hợp lệ.';
            if (alertEl) {
                alertEl.classList.remove('hidden');
                alertEl.innerHTML = `<div class="alert err" style="margin-bottom:0;">${S.esc(win.message)}</div>`;
            }
            return;
        }

        const durLabel = S.formatDurationCompactVi(win.durationHours, win.durationMinutes);
        const start12 = S.formatClock12h(win.startTime);
        const end12 = S.formatClock12h(win.endTime);
        if (win.overnight) {
            boxEl.classList.add('overnight');
            if (badgeEl) badgeEl.classList.remove('hidden');
            textEl.textContent = `${S.formatVnDateDMY(win.runDate)} ${win.startTime} (${start12}) → ${S.formatVnDateDMY(win.endRunDate)} ${win.endTime} (${end12}) · ${durLabel}`;
        } else {
            boxEl.classList.remove('overnight');
            if (badgeEl) badgeEl.classList.add('hidden');
            textEl.textContent = `${S.formatVnDateDMY(win.runDate)} · ${win.startTime} – ${win.endTime} (${start12} – ${end12} · ${durLabel})`;
        }

        if ($('f-hours') && win.durationHours > 0) {
            $('f-hours').value = String(win.durationHours);
        }

        if (alertEl) {
            if (win.isPast) {
                const tomorrow = S.addDaysToIsoDate(S.getVietnamDateISO(), 1);
                alertEl.classList.remove('hidden');
                alertEl.innerHTML = `<div class="alert warn" style="margin-bottom:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
                    <span>${S.esc(win.message)}</span>
                    <button type="button" class="btn btn-sm" id="btn-shift-tomorrow" data-date="${S.esc(tomorrow)}"><span class="btn-label">Dời sang ngày mai (${S.esc(S.formatVnDateDMY(tomorrow))})</span></button>
                </div>`;
            } else if (win.isInProgressWindow) {
                alertEl.classList.remove('hidden');
                alertEl.innerHTML = `<div class="alert info" style="margin-bottom:0;">Khung giờ đang diễn ra — chiến dịch sẽ khởi chạy ngay và kết thúc lúc ${S.esc(win.endTime)} (${S.esc(S.formatVnDateDMY(win.endRunDate))}).</div>`;
            } else {
                alertEl.innerHTML = '';
                alertEl.classList.add('hidden');
            }
        }
    }

    function refreshFormSummaries() {
        const nameVal = ($('f-name') && $('f-name').value.trim()) || '';
        const urlVal = ($('f-url') && $('f-url').value.trim()) || '';
        const proxyVal = ($('f-proxy') && $('f-proxy').value.trim()) || '';

        let shortHost = urlVal;
        if (urlVal) {
            try { shortHost = new URL(urlVal).host || urlVal; } catch (e) {}
        }
        const sumTargetEl = $('sum-target');
        if (sumTargetEl) {
            const parts = [];
            parts.push(shortHost || 'Chưa nhập URL');
            parts.push(proxyVal ? `Key ${S.maskProxyKey(proxyVal)}` : 'Chưa có Key');
            sumTargetEl.textContent = parts.join(' · ');
        }
        const preTargetEl = $('pre-target');
        if (preTargetEl) {
            preTargetEl.textContent = urlVal ? `${nameVal ? nameVal + ' — ' : ''}${urlVal}` : (nameVal || 'Chưa nhập URL');
        }

        const clicksNum = Number(($('f-clicks') && $('f-clicks').value) || 0);
        const clicksOk = Number.isInteger(clicksNum) && clicksNum >= 1;
        const schedVal = ($('f-schedule') && $('f-schedule').value) || 'smart';
        const schedModeLabel = schedVal === 'even' ? 'Even' : (schedVal === 'custom' ? 'Custom' : 'Smart');

        const { scheduleType, win } = getWindowValidationFromUI();
        let windowShortText = '--';
        if (scheduleType === 'window' && win) {
            if (win.runDate && win.startTime && win.endTime && win.code !== 'SAME_TIME' && win.code !== 'INVALID_TIME' && win.code !== 'INVALID_DATE') {
                const dmy = S.formatVnDateDMY(win.runDate);
                const dur = S.formatDurationCompactVi(win.durationHours, win.durationMinutes);
                windowShortText = win.overnight
                    ? `${dmy} ${win.startTime}→${win.endTime} (+1 ngày · ${dur})`
                    : `${dmy} · ${win.startTime}–${win.endTime} (${dur})`;
            } else {
                windowShortText = win.message || 'Khung giờ chưa hợp lệ';
            }
        } else {
            const hoursNum = Number(($('f-hours') && $('f-hours').value) || 0);
            windowShortText = hoursNum > 0 ? `Chạy ngay · ${S.formatDurationCompactVi(hoursNum)}` : 'Chưa nhập giờ chạy';
        }

        const sumSchedEl = $('sum-schedule');
        if (sumSchedEl) {
            sumSchedEl.textContent = `${clicksOk ? clicksNum.toLocaleString('vi-VN') : 0} clicks · ${windowShortText} · ${schedModeLabel}`;
        }
        const preWinEl = $('pre-window');
        if (preWinEl) {
            if (scheduleType === 'window' && win && !win.code?.startsWith('INVALID_') && win.code !== 'SAME_TIME') {
                preWinEl.textContent = S.formatScheduleWindowSummary({ ...win, scheduleType: 'window' });
            } else {
                preWinEl.textContent = windowShortText;
            }
        }
        const preTrafficEl = $('pre-traffic');
        if (preTrafficEl) {
            preTrafficEl.textContent = `${clicksOk ? clicksNum.toLocaleString('vi-VN') : 0} clicks · Phân bổ ${schedModeLabel}`;
        }

        const dwellVal = S.normalizeDwellPreset($('f-dwell-preset') && $('f-dwell-preset').value);
        const deviceVal = S.normalizeDeviceProfile($('f-device-profile') && $('f-device-profile').value);
        const dedupOn = $('f-dedup') ? $('f-dedup').checked : true;
        const linksOn = $('f-links') ? $('f-links').checked : true;
        const behaviorText = `${S.formatDwellLabel(dwellVal)} · ${S.formatDeviceLabel(deviceVal)} · IP: ${dedupOn ? 'Bật' : 'Tắt'} · Link: ${linksOn ? 'Bật' : 'Tắt'}`;
        if ($('sum-behavior')) $('sum-behavior').textContent = behaviorText;
        if ($('pre-behavior')) $('pre-behavior').textContent = behaviorText;
    }

    async function updateCostAndDistribution(opts = {}) {
        const { scheduleType, win } = getWindowValidationFromUI();
        if (scheduleType === 'window') {
            renderWindowCalcFeedback(win);
        }

        const rawClicks = $('f-clicks').value.trim();
        const rawHours = $('f-hours').value.trim();
        const targetClicks = Number(rawClicks);
        const durationHours = (scheduleType === 'window' && win && win.durationHours > 0)
            ? win.durationHours
            : Number(rawHours);
        const schedVal = $('f-schedule').value;
        const mode = ['even', 'custom'].includes(schedVal) ? schedVal : 'smart';
        const customBlocks = mode === 'custom' ? getCustomBlocksFromUI() : null;

        $('custom-blocks-box').classList.toggle('hidden', mode !== 'custom');

        if (opts && opts.expandPreview) {
            const distCard = $('dist-preview-card');
            if (distCard) distCard.open = true;
        }

        const clicksOk = rawClicks !== '' && Number.isInteger(targetClicks) && targetClicks >= 1;
        const hoursOk = Number.isFinite(durationHours) && durationHours > 0;

        if ($('c-clicks')) $('c-clicks').textContent = clicksOk ? targetClicks.toLocaleString('vi-VN') : '0';

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
            UI.renderDistributionPreview({ targetClicks: 0, durationHours: 0, mode, customBlocks }, state);
            refreshFormSummaries();
            return;
        }

        setCostHint('');
        const calc = S.calculateOrderCost(targetClicks, durationHours, state.config.pricing);
        if (!calc.error) {
            if ($('c-rate')) $('c-rate').textContent = Number(calc.clickRate).toLocaleString('vi-VN');
            if ($('c-hrate')) $('c-hrate').textContent = Number(calc.hourlyRate).toLocaleString('vi-VN');
            if ($('c-hours')) $('c-hours').textContent = calc.roundedHours;
            if ($('c-click-fee')) $('c-click-fee').textContent = S.fmtVnd(calc.clickFee);
            if ($('c-hour-fee')) $('c-hour-fee').textContent = S.fmtVnd(calc.durationFee);
            if ($('c-total')) $('c-total').textContent = S.fmtVnd(calc.totalAmount);
        }

        UI.renderDistributionPreview({ targetClicks, durationHours, mode, customBlocks }, state);
        refreshFormSummaries();
    }

    function scheduleCostRefresh(opts = {}) {
        clearTimeout(state.costDebounce);
        state.costDebounce = setTimeout(() => updateCostAndDistribution(opts), 140);
    }

    async function handleValidateProxyKey() {
        const proxyKey = $('f-proxy').value.trim();
        const btn = $('validate-proxy-btn');
        S.showAlert('proxy-validate-msg', '');
        if (!proxyKey) {
            UI.renderProxyValidateResult('proxy-validate-msg', false, {
                valid: false,
                success: false,
                message: 'Vui lòng nhập KiotProxy Key trước khi kiểm tra.'
            });
            return;
        }
        S.setButtonLoading(btn, true, 'Đang kiểm tra...');
        try {
            const { res, data } = await apiJson('/api/proxy/validate', {
                method: 'POST',
                body: JSON.stringify({ proxyKey })
            });
            UI.renderProxyValidateResult('proxy-validate-msg', res.ok, data);
        } catch (err) {
            S.showAlert('proxy-validate-msg', 'Lỗi kết nối khi kiểm tra KiotProxy Key.', 'err');
        } finally {
            S.setButtonLoading(btn, false);
        }
    }

    // ─── Local Recent Orders ──────────────────────────────────────────────────
    function getRecentOrders() {
        try {
            const raw = localStorage.getItem(S.STORAGE_KEYS.RECENT_ORDERS);
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
            createdAt: order.createdAt || Date.now(),
            expiresAt: order.expiresAt || null
        });
        try {
            localStorage.setItem(S.STORAGE_KEYS.RECENT_ORDERS, JSON.stringify(list.slice(0, S.MAX_RECENT_ORDERS)));
        } catch (e) {}
        UI.renderRecentOrders(getRecentOrders());
    }

    function removeRecentOrder(orderId) {
        const list = getRecentOrders().filter(x => x && x.orderId !== orderId);
        try { localStorage.setItem(S.STORAGE_KEYS.RECENT_ORDERS, JSON.stringify(list)); } catch (e) {}
        UI.renderRecentOrders(list);
    }

    // ─── Order Submission & Active Order Tracking ─────────────────────────────
    async function handleOrderSubmit(e) {
        e.preventDefault();
        S.showAlert('order-form-msg', '');
        const { scheduleType, win } = getWindowValidationFromUI();
        if (scheduleType === 'window' && (!win || !win.valid)) {
            if ($('acc-schedule')) $('acc-schedule').open = true;
            renderWindowCalcFeedback(win);
            S.showAlert('order-form-msg', (win && win.message) || 'Khung giờ chạy không hợp lệ.', 'err');
            return;
        }

        const schedVal = $('f-schedule').value;
        const scheduleMode = ['even', 'custom'].includes(schedVal) ? schedVal : 'smart';
        const dwellEl = $('f-dwell-preset');
        const deviceEl = $('f-device-profile');
        const durationHours = (scheduleType === 'window' && win)
            ? win.durationHours
            : Number($('f-hours').value);

        const payload = {
            name: $('f-name').value.trim() || undefined,
            targetUrl: $('f-url').value.trim(),
            proxyKey: $('f-proxy').value.trim(),
            targetClicks: Number($('f-clicks').value),
            durationHours,
            scheduleType,
            runDate: scheduleType === 'window' && win ? win.runDate : undefined,
            startTime: scheduleType === 'window' && win ? win.startTime : undefined,
            endTime: scheduleType === 'window' && win ? win.endTime : undefined,
            scheduleMode,
            customBlocks: scheduleMode === 'custom' ? getCustomBlocksFromUI() : undefined,
            dwellPreset: S.normalizeDwellPreset(dwellEl && dwellEl.value),
            deviceProfile: S.normalizeDeviceProfile(deviceEl && deviceEl.value),
            dedupIp: $('f-dedup').checked,
            randomLinks: $('f-links').checked,
            autoLaunch: true
        };

        const btn = $('submit-order-btn');
        S.setButtonLoading(btn, true, 'Đang tạo & lên lịch...');

        try {
            const { res, data } = await apiJson('/api/orders', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (!res.ok || !data.success) {
                S.showAlert('order-form-msg', (data && data.message) || 'Không thể khởi tạo chiến dịch.', 'err');
                return;
            }
            const effStatus = data.orderStatus || data.status || '';
            const okMsg = effStatus === 'waiting'
                ? `Đã lên lịch chiến dịch ${data.orderId} (${S.formatScheduleWindowSummary(data)}). Xem cấu hình đã chọn bên dưới.`
                : `Đã tạo & khởi chạy chiến dịch ${data.orderId}. Xem chi tiết cấu hình bên dưới.`;
            S.showAlert('order-form-msg', okMsg, 'ok');
            saveRecentOrder(data);
            await selectOrder(data.orderId);
        } catch (err) {
            S.showAlert('order-form-msg', 'Lỗi kết nối máy chủ khi tạo chiến dịch.', 'err');
        } finally {
            S.setButtonLoading(btn, false);
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

    function stopWaitCountdown() {
        if (state.waitCountdownTimer) {
            clearInterval(state.waitCountdownTimer);
            state.waitCountdownTimer = null;
        }
    }

    function startWaitCountdown(startAtMs) {
        stopWaitCountdown();
        const el = $('ao-wait-countdown');
        if (!el) return;
        const target = Number(startAtMs) || 0;
        const tick = () => {
            const left = Math.max(0, target - Date.now());
            el.textContent = S.formatCountdownVn(target);
            if (left <= 0) {
                stopWaitCountdown();
                fetchActiveOrder();
            }
        };
        tick();
        state.waitCountdownTimer = setInterval(tick, 1000);
    }

    function startQrCountdown(expiresAt) {
        stopQrCountdown();
        const el = $('ao-countdown');
        if (!el) return;
        const deadline = Number(expiresAt) || (Date.now() + S.ORDER_EXPIRE_MS);
        let refreshedOnExpiry = false;
        const tick = () => {
            const left = Math.max(0, deadline - Date.now());
            const m = Math.floor(left / 60000);
            const s = Math.floor((left % 60000) / 1000);
            el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (left <= 0) {
                stopQrCountdown();
                if (!refreshedOnExpiry && state.activeOrder && state.activeOrder.paymentStatus !== 'paid') {
                    refreshedOnExpiry = true;
                    state.activeOrder.status = 'expired';
                    UI.renderActiveOrder(state.activeOrder, state, orderUiHooks);
                    fetchActiveOrder();
                }
            }
        };
        tick();
        state.countdownTimer = setInterval(tick, 1000);
    }

    function clearActiveOrderView() {
        stopOrderPolling();
        stopQrCountdown();
        stopWaitCountdown();
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

    async function selectOrder(orderId, triggerBtn) {
        const cleanId = String(orderId || '').trim();
        if (!cleanId) {
            S.showAlert('lookup-order-msg', 'Vui lòng nhập mã đơn hàng cần tra cứu (ORD-...).', 'warn');
            return null;
        }
        S.showAlert('lookup-order-msg', '');
        S.showAlert('ao-notice', '');
        $('lookup-order-id').value = cleanId;

        const wlog = $('ao-worker-log');
        if (wlog && state.activeOrderId !== cleanId) {
            wlog.innerHTML = '';
            delete wlog.dataset.campId;
        }
        stopOrderPolling();
        S.setButtonLoading(triggerBtn, true, 'Đang tải...');
        let order = null;
        try {
            order = await fetchActiveOrder(cleanId);
            if (order) {
                if (state.socket && state.socket.connected) {
                    state.socket.emit('subscribe-order', order.orderId);
                }
                const eff = S.getEffectiveOrderStatus(order);
                if (!['completed', 'expired', 'stopped'].includes(eff)) {
                    state.pollTimer = setInterval(() => fetchActiveOrder(), 3000);
                }
            }
        } finally {
            S.setButtonLoading(triggerBtn, false);
        }
        return order;
    }

    async function fetchActiveOrder(targetOrderId, triggerBtn) {
        const lookupId = String(targetOrderId || state.activeOrderId || '').trim();
        if (!lookupId) return null;
        const loadingLabel = triggerBtn && triggerBtn.id === 'recheck-order-btn'
            ? 'Đang kiểm tra...'
            : 'Đang làm mới...';
        S.setButtonLoading(triggerBtn, true, loadingLabel);
        try {
            const { res, data } = await apiJson('/api/orders/' + encodeURIComponent(lookupId));
            if (!res.ok || !data.success || !data.order) {
                const msg = (data && data.message && res.status !== 404)
                    ? data.message
                    : `Không tìm thấy đơn hàng ${lookupId}.`;
                clearActiveOrderView();
                S.showAlert('lookup-order-msg', msg, 'err');
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
            UI.renderActiveOrder(data.order, state, orderUiHooks);
            return data.order;
        } catch (err) {
            return null;
        } finally {
            S.setButtonLoading(triggerBtn, false);
        }
    }

    async function confirmOrderAsAdmin(orderId, triggerBtn) {
        const isViewingOrder = state.activeOrderId === orderId;
        S.showAlert('adm-action-msg', '');
        if (isViewingOrder) S.showAlert('ao-notice', '');
        S.setButtonLoading(triggerBtn, true, 'Đang xác nhận...');
        try {
            const { res, data } = await apiJson('/api/orders/' + encodeURIComponent(orderId) + '/confirm', {
                method: 'POST',
                body: '{}'
            });
            if (!res.ok || !data.success) {
                const msg = (data && data.message) || 'Không thể xác nhận đơn hàng.';
                if (isViewingOrder) S.showAlert('ao-notice', msg, 'err');
                S.showAlert('adm-action-msg', msg, 'err');
                return false;
            }
            const okMsg = `Đã xác nhận thanh toán đơn ${data.orderId} -> Campaign ${data.campaignId} đang chạy.`;
            S.showAlert('adm-action-msg', okMsg, 'ok');
            if (isViewingOrder) {
                S.showAlert('ao-notice', okMsg, 'ok');
                if (state.activeOrder && data.campaignId) {
                    state.activeOrder.campaignId = data.campaignId;
                    state.activeOrder.paymentStatus = 'paid';
                    UI.hydrateOrderWorkerLogs(data.campaignId, state.campaignLogs);
                }
                await fetchActiveOrder(orderId);
            }
            await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
            return true;
        } catch (err) {
            const msg = 'Lỗi kết nối máy chủ khi xác nhận thanh toán.';
            if (isViewingOrder) S.showAlert('ao-notice', msg, 'err');
            S.showAlert('adm-action-msg', msg, 'err');
            return false;
        } finally {
            S.setButtonLoading(triggerBtn, false);
        }
    }

    async function stopCampaignAsAdmin(campaignId, triggerBtn) {
        if (!campaignId) return;
        const activeCampId = state.activeOrder && ((state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId);
        const isViewingCampaign = Boolean(activeCampId && String(activeCampId) === String(campaignId));
        S.setButtonLoading(triggerBtn, true, 'Đang dừng...');
        try {
            const { res, data } = await apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/stop', {
                method: 'POST',
                body: '{}'
            });
            if (!res.ok || !data.success) {
                const msg = (data && data.message) || 'Không thể dừng chiến dịch.';
                if (isViewingCampaign) S.showAlert('ao-notice', msg, 'err');
                S.showAlert('adm-action-msg', msg, 'err');
                return;
            }
            const warnMsg = `Đã gửi lệnh dừng chiến dịch ${campaignId}.`;
            S.showAlert('adm-action-msg', warnMsg, 'warn');
            if (isViewingCampaign) S.showAlert('ao-notice', warnMsg, 'warn');
            if (state.activeOrderId) await fetchActiveOrder();
            await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
        } catch (err) {
            const msg = 'Lỗi kết nối máy chủ khi dừng chiến dịch.';
            if (isViewingCampaign) S.showAlert('ao-notice', msg, 'err');
            S.showAlert('adm-action-msg', msg, 'err');
        } finally {
            S.setButtonLoading(triggerBtn, false);
        }
    }

    function downloadActiveReport() {
        const o = state.activeOrder;
        if (!o) return;
        const content = S.buildOrderReportText(o, getRuntimeLabel());
        S.downloadBlobFile(`report_${o.orderCode || o.orderId}.txt`, content, 'text/plain;charset=utf-8');
    }

    function downloadActiveCsv() {
        const o = state.activeOrder;
        if (!o) return;
        const csv = S.buildOrderCsvContent(o, getRuntimeLabel());
        S.downloadBlobFile(`order_${o.orderCode || o.orderId}.csv`, csv, 'text/csv;charset=utf-8');
    }

    // ─── Admin Workspace (Single Admin Account) ───────────────────────────────
    async function loadAdminDashboard() {
        if (!isAdminActive()) return;
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
        if (!isAdminActive()) return;
        try {
            const { res, data } = await apiJson('/api/campaigns');
            if (!res.ok || !data.success) return;
            state.adminCampaigns = Array.isArray(data.data) ? data.data : [];
            UI.renderAdminCampaignsTable(state.adminCampaigns);
        } catch (e) {}
    }

    async function resetCampaignStatsAsAdmin(campaignId, triggerBtn) {
        if (!campaignId) return;
        S.setButtonLoading(triggerBtn, true, 'Đang reset...');
        try {
            const { res, data } = await apiJson('/api/campaigns/' + encodeURIComponent(campaignId) + '/reset-stats', {
                method: 'POST',
                body: '{}'
            });
            if (!res.ok || !data.success) {
                S.showAlert('adm-camp-msg', (data && data.message) || 'Không thể reset thống kê chiến dịch.', 'err');
                return;
            }
            S.showAlert('adm-camp-msg', `Đã reset thống kê chiến dịch ${campaignId}.`, 'ok');
            if (state.activeOrderId) await fetchActiveOrder();
            await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
        } catch (err) {
            S.showAlert('adm-camp-msg', 'Lỗi kết nối máy chủ khi reset thống kê.', 'err');
        } finally {
            S.setButtonLoading(triggerBtn, false);
        }
    }

    async function loadAdminOrders() {
        if (!isAdminActive()) return;
        try {
            const { res, data } = await apiJson('/api/admin/orders');
            if (!res.ok || !data.success) return;
            const s = data.summary || {};
            $('adm-sum-total').textContent = Number(s.totalOrders || 0).toLocaleString('vi-VN');
            $('adm-sum-rev').textContent = S.fmtVnd(s.totalRevenue || 0);
            $('adm-sum-paid').textContent = Number(s.paidCount || 0).toLocaleString('vi-VN');
            $('adm-sum-pending').textContent = Number(s.pendingCount || 0).toLocaleString('vi-VN');
            $('adm-sum-running').textContent = Number(s.runningCount || 0).toLocaleString('vi-VN');
            $('adm-sum-done').textContent = Number(s.completedCount || 0).toLocaleString('vi-VN');
            state.adminOrders = Array.isArray(data.orders) ? data.orders : [];
            UI.renderAdminOrdersTable(state);
        } catch (e) {}
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
        S.showAlert('adm-paycfg-msg', '');
        const btn = e.target && e.target.querySelector ? e.target.querySelector('button[type="submit"]') : null;
        S.setButtonLoading(btn, true, 'Đang lưu...');
        try {
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
                S.showAlert('adm-paycfg-msg', (data && data.message) || 'Lỗi lưu cấu hình VietQR.', 'err');
                return;
            }
            S.showAlert('adm-paycfg-msg', 'Đã lưu cấu hình VietQR & Webhook.', 'ok');
            await refreshPublicConfig();
        } catch (err) {
            S.showAlert('adm-paycfg-msg', 'Lỗi kết nối máy chủ khi lưu cấu hình VietQR.', 'err');
        } finally {
            S.setButtonLoading(btn, false);
        }
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
        S.showAlert('adm-proxycfg-msg', '');
        const btn = e.target && e.target.querySelector ? e.target.querySelector('button[type="submit"]') : null;
        S.setButtonLoading(btn, true, 'Đang lưu...');
        try {
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
                S.showAlert('adm-proxycfg-msg', (data && data.message) || 'Lỗi lưu Proxy Pool.', 'err');
                return;
            }
            S.showAlert('adm-proxycfg-msg', data.message || 'Đã lưu Proxy Pool.', 'ok');
        } catch (err) {
            S.showAlert('adm-proxycfg-msg', 'Lỗi kết nối máy chủ khi lưu Proxy Pool.', 'err');
        } finally {
            S.setButtonLoading(btn, false);
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
            $('socket-pill').className = 'pill warn hidden';
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
            if (state.mode === 'remote') {
                const wasUnhealthy = state.remoteHealthy === false;
                state.remoteConnectedOnce = true;
                state.remoteHealthy = true;
                stopRemoteHealthMonitor();
                if (wasUnhealthy) {
                    UI.renderRuntimeModeUI(state);
                    S.showAlert('runtime-conn-msg', `Đã kết nối lại Backend Tunnel (${state.backendUrl}).`, 'ok');
                }
            }
            if (state.activeOrderId) {
                socket.emit('subscribe-order', state.activeOrderId);
            }
        });

        socket.on('disconnect', () => {
            $('socket-pill').className = 'pill warn';
            $('socket-pill').textContent = 'Socket: Mất kết nối';
            if (state.mode === 'remote' && state.remoteConnectedOnce) {
                markRemoteDisconnected('Socket Tunnel bị ngắt.');
            }
        });

        socket.on('connect_error', () => {
            $('socket-pill').className = 'pill warn';
            $('socket-pill').textContent = 'Socket: Mất kết nối';
            if (state.mode === 'remote' && state.remoteConnectedOnce) {
                markRemoteDisconnected('Không kết nối được Socket Tunnel.');
            }
        });

        socket.on('user-info', (info) => {
            if (state.config.authRequired === false) {
                return;
            }
            const prevAuth = state.config.authenticated;
            const prevRole = state.config.role;
            if (info && info.role === 'admin') {
                state.config.authenticated = true;
                state.config.role = 'admin';
                state.config.username = info.username || 'admin';
                if (!prevAuth || prevRole !== 'admin') UI.renderAuthState(state, authUiHooks);
            } else {
                state.config.authenticated = false;
                state.config.role = null;
                state.config.username = null;
                state.config.defaultPasswordWarning = false;
                if (prevAuth) UI.renderAuthState(state, authUiHooks);
            }
        });

        socket.on('payment-confirmed', (payload) => {
            if (payload && payload.orderId && payload.orderId === state.activeOrderId) {
                S.showAlert('ao-notice', `Thanh toán đã được xác nhận! Campaign ${payload.campaignId || ''} đang bắt đầu chạy.`, 'ok');
                if (state.activeOrder && payload.campaignId) {
                    state.activeOrder.campaignId = payload.campaignId;
                    state.activeOrder.paymentStatus = 'paid';
                    UI.hydrateOrderWorkerLogs(payload.campaignId, state.campaignLogs);
                }
                fetchActiveOrder();
            }
            if (isAdminActive()) {
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
                if (['paid', 'running', 'completed', 'stopped'].includes(prog.status)) {
                    state.activeOrder.paymentStatus = 'paid';
                }
            }
            UI.renderActiveOrder(state.activeOrder, state, orderUiHooks);
        });

        socket.on('orders-updated', () => {
            if (isAdminActive()) {
                loadAdminOrders();
                loadAdminCampaigns();
            }
        });

        socket.on('status-update', () => {
            if (isAdminActive()) loadAdminCampaigns();
        });

        socket.on('campaign-deleted', () => {
            if (isAdminActive()) loadAdminCampaigns();
        });

        socket.on('log', (entry) => emitLiveLogEntry(entry));

        socket.on('stats-update', (st) => {
            if (isAdminActive() && st) {
                const rowOrder = state.adminOrders.find(o => o.campaignId && String(o.campaignId) === String(st.campaignId));
                if (rowOrder) {
                    rowOrder.effectiveStatus = st.status;
                    rowOrder.progress = Object.assign({}, rowOrder.progress || {}, {
                        status: st.status,
                        successVisits: st.success,
                        failedVisits: st.failed,
                        targetLimit: st.target
                    });
                    UI.renderAdminOrdersTable(state);
                }
                const rowCamp = state.adminCampaigns.find(c => String(c.id) === String(st.campaignId));
                if (rowCamp) {
                    rowCamp.status = st.status;
                    rowCamp.successVisits = st.success;
                    rowCamp.failedVisits = st.failed;
                    if (st.target !== undefined) rowCamp.targetLimit = st.target;
                    UI.renderAdminCampaignsTable(state.adminCampaigns);
                }
            }
        });
    }

    async function reconnectSocket() {
        await initSocket();
    }

    async function applyRuntimeMode(nextMode, rawBackendUrl = '', triggerBtn = null) {
        S.showAlert('runtime-conn-msg', '');
        stopRemoteHealthMonitor();
        state.remoteConnectedOnce = false;
        state.remoteHealthy = true;
        Demo.clearAllDemoTimers();
        stopOrderPolling();
        clearActiveOrderView();
        state.adminOrders = [];
        state.adminCampaigns = [];
        state.adminLoadingPromise = null;
        state.campaignLogs.clear();

        if (nextMode === 'remote') {
            const cleanUrl = S.normalizeBackendUrl(rawBackendUrl);
            if (!cleanUrl) {
                S.showAlert('runtime-conn-msg', 'URL Backend Tunnel không hợp lệ (cần bắt đầu bằng https:// hoặc http://).', 'err');
                const connDetails = $('runtime-conn-details');
                if (connDetails && triggerBtn) connDetails.open = true;
                return false;
            }
            S.setButtonLoading(triggerBtn, true, 'Đang kết nối...');
            try {
                state.mode = 'remote';
                state.backendUrl = cleanUrl;
                state.bearerToken = S.loadSavedRemoteToken(cleanUrl);
                try {
                    localStorage.setItem(S.STORAGE_KEYS.REMOTE_BACKEND, cleanUrl);
                    localStorage.removeItem(S.STORAGE_KEYS.PREFER_DEMO);
                } catch (e) {}
                UI.renderRuntimeModeUI(state);
                const ok = await refreshPublicConfig();
                if (!ok) {
                    state.remoteHealthy = false;
                    UI.renderRuntimeModeUI(state);
                    S.showAlert('runtime-conn-msg', `Không kết nối được Backend tại ${cleanUrl}. Hãy kiểm tra server + Cloudflare Tunnel đang chạy, hoặc bấm "Chế độ Demo tĩnh".`, 'err');
                    const connDetails = $('runtime-conn-details');
                    if (connDetails && triggerBtn) connDetails.open = true;
                    await initSocket();
                    return false;
                }
                await initSocket();
                S.showAlert('runtime-conn-msg', `Đã kết nối Backend thật tại ${cleanUrl}.`, 'ok');
                await updateCostAndDistribution();
                return true;
            } finally {
                S.setButtonLoading(triggerBtn, false);
            }
        }

        if (nextMode === 'demo') {
            state.mode = 'demo';
            state.backendUrl = '';
            state.bearerToken = '';
            try { localStorage.setItem(S.STORAGE_KEYS.PREFER_DEMO, '1'); } catch (e) {}
            UI.renderRuntimeModeUI(state);
            await initSocket();
            await refreshPublicConfig();
            Demo.resumeRunningDemoCampaigns();
            await updateCostAndDistribution();
            return true;
        }

        // Default same-origin live Express mode
        state.mode = 'same-origin';
        state.backendUrl = '';
        state.bearerToken = '';
        try {
            localStorage.removeItem(S.STORAGE_KEYS.PREFER_DEMO);
            localStorage.removeItem(S.STORAGE_KEYS.REMOTE_BACKEND);
        } catch (e) {}
        UI.renderRuntimeModeUI(state);
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
        if (state.activeTab === 'admin' && isAdminActive()) {
            loadAdminDashboard();
        }
    }

    function bindEvents() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        $('connect-backend-btn').addEventListener('click', () => {
            applyRuntimeMode('remote', $('backend-url-input').value, $('connect-backend-btn'));
        });
        $('backend-url-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyRuntimeMode('remote', $('backend-url-input').value, $('connect-backend-btn'));
            }
        });
        $('copy-backend-link-btn').addEventListener('click', () => {
            const target = S.normalizeBackendUrl(state.backendUrl || $('backend-url-input').value);
            if (!target) {
                S.showAlert('runtime-conn-msg', 'Chưa có URL Backend Tunnel hợp lệ để tạo link chia sẻ.', 'warn');
                return;
            }
            try {
                const shareUrl = new URL(window.location.href);
                shareUrl.searchParams.set('backend', target);
                S.copyText(shareUrl.toString(), $('copy-backend-link-btn'));
            } catch (e) {}
        });
        $('use-demo-mode-btn').addEventListener('click', () => {
            applyRuntimeMode('demo');
        });
        $('use-same-origin-btn').addEventListener('click', () => {
            applyRuntimeMode('same-origin');
        });

        $('validate-proxy-btn').addEventListener('click', handleValidateProxyKey);

        if ($('btn-sched-window')) {
            $('btn-sched-window').addEventListener('click', () => setScheduleType('window'));
        }
        if ($('btn-sched-duration')) {
            $('btn-sched-duration').addEventListener('click', () => setScheduleType('duration'));
        }

        document.querySelectorAll('.window-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const startT = btn.dataset.start;
                const endT = btn.dataset.end;
                if ($('f-start-time')) $('f-start-time').value = startT;
                if ($('f-end-time')) $('f-end-time').value = endT;
                // If selected preset on current date already ended in VN time, auto-advance to tomorrow VN date
                const curDate = ($('f-run-date') && $('f-run-date').value) || S.getVietnamDateISO();
                const testWin = S.computeVietnamScheduleWindow({ runDate: curDate, startTime: startT, endTime: endT });
                if (testWin.isPast && $('f-run-date')) {
                    $('f-run-date').value = S.addDaysToIsoDate(S.getVietnamDateISO(), 1);
                }
                setScheduleType('window');
            });
        });

        if ($('window-alert-box')) {
            $('window-alert-box').addEventListener('click', (e) => {
                const shiftBtn = e.target.closest('#btn-shift-tomorrow');
                if (!shiftBtn || !$('f-run-date')) return;
                $('f-run-date').value = shiftBtn.dataset.date || S.addDaysToIsoDate(S.getVietnamDateISO(), 1);
                updateCostAndDistribution();
            });
        }

        ['f-run-date', 'f-start-time', 'f-end-time'].forEach(id => {
            if ($(id)) {
                $(id).addEventListener('input', () => updateCostAndDistribution());
                $(id).addEventListener('change', () => updateCostAndDistribution());
            }
        });

        document.querySelectorAll('.preset-btn[data-hours]').forEach(btn => {
            btn.addEventListener('click', () => {
                $('f-hours').value = btn.dataset.hours;
                updateCostAndDistribution({ expandPreview: true });
            });
        });

        ['f-clicks', 'f-hours'].forEach(id => {
            $(id).addEventListener('input', () => scheduleCostRefresh({ expandPreview: true }));
            $(id).addEventListener('change', () => updateCostAndDistribution({ expandPreview: true }));
        });
        $('f-schedule').addEventListener('change', () => updateCostAndDistribution({ expandPreview: true }));
        ['f-name', 'f-url', 'f-proxy', 'f-dwell-preset', 'f-device-profile', 'f-dedup', 'f-links'].forEach(id => {
            if ($(id)) {
                $(id).addEventListener('input', refreshFormSummaries);
                $(id).addEventListener('change', refreshFormSummaries);
            }
        });
        ['cb-night', 'cb-early', 'cb-morn', 'cb-noon', 'cb-after', 'cb-eve', 'cb-late'].forEach(id => {
            $(id).addEventListener('change', () => updateCostAndDistribution({ expandPreview: true }));
        });
        $('dist-preview-footer').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action="toggle-preview-slices"]');
            if (!btn) return;
            state.expandPreviewSlices = !state.expandPreviewSlices;
            const { scheduleType, win } = getWindowValidationFromUI();
            const targetClicks = Number($('f-clicks').value);
            const durationHours = (scheduleType === 'window' && win && win.durationHours > 0)
                ? win.durationHours
                : Number($('f-hours').value);
            const schedVal = $('f-schedule').value;
            const mode = ['even', 'custom'].includes(schedVal) ? schedVal : 'smart';
            UI.renderDistributionPreview({
                targetClicks: Number.isInteger(targetClicks) ? targetClicks : 0,
                durationHours: Number.isFinite(durationHours) ? durationHours : 0,
                mode,
                customBlocks: mode === 'custom' ? getCustomBlocksFromUI() : null
            }, state);
        });

        $('boost-form').addEventListener('submit', handleOrderSubmit);

        $('lookup-order-btn').addEventListener('click', () => {
            selectOrder($('lookup-order-id').value, $('lookup-order-btn'));
        });
        $('lookup-order-id').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                selectOrder($('lookup-order-id').value, $('lookup-order-btn'));
            }
        });

        $('recent-orders-wrap').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            if (btn.dataset.action === 'load-recent') selectOrder(id, btn);
            if (btn.dataset.action === 'del-recent') removeRecentOrder(id);
        });

        $('recheck-order-btn').addEventListener('click', () => fetchActiveOrder(null, $('recheck-order-btn')));
        $('refresh-order-btn').addEventListener('click', () => fetchActiveOrder(null, $('refresh-order-btn')));
        $('download-report-btn').addEventListener('click', downloadActiveReport);
        $('download-csv-btn').addEventListener('click', downloadActiveCsv);

        $('copy-acc-btn').addEventListener('click', () => S.copyText($('ao-acc-num').textContent, $('copy-acc-btn')));
        $('copy-amt-btn').addEventListener('click', () => S.copyText(String((state.activeOrder && state.activeOrder.totalAmount) || ''), $('copy-amt-btn')));
        $('copy-memo-btn').addEventListener('click', () => S.copyText($('ao-memo').textContent, $('copy-memo-btn')));
        $('copy-track-link-btn').addEventListener('click', () => {
            const url = S.buildTrackOrderUrl(state.activeOrderId, state.mode, state.backendUrl);
            if (url) S.copyText(url, $('copy-track-link-btn'));
        });

        $('inline-admin-confirm-btn').addEventListener('click', () => {
            if (state.activeOrderId) confirmOrderAsAdmin(state.activeOrderId, $('inline-admin-confirm-btn'));
        });
        $('inline-admin-stop-btn').addEventListener('click', () => {
            const campId = state.activeOrder && ((state.activeOrder.progress && state.activeOrder.progress.campaignId) || state.activeOrder.campaignId);
            if (campId) stopCampaignAsAdmin(campId, $('inline-admin-stop-btn'));
        });

        $('open-login-btn').addEventListener('click', openLoginModal);
        $('gate-open-login-btn').addEventListener('click', openLoginModal);
        $('close-login-btn').addEventListener('click', closeLoginModal);
        $('login-modal').addEventListener('click', (e) => {
            if (e.target === $('login-modal')) closeLoginModal();
        });
        $('boost-login-form').addEventListener('submit', handleLoginSubmit);
        $('logout-btn').addEventListener('click', handleLogout);

        $('adm-filter').addEventListener('change', () => UI.renderAdminOrdersTable(state));
        $('adm-refresh-orders-btn').addEventListener('click', async () => {
            const btn = $('adm-refresh-orders-btn');
            S.setButtonLoading(btn, true, 'Đang tải...');
            try { await loadAdminOrders(); } finally { S.setButtonLoading(btn, false); }
        });
        $('adm-refresh-campaigns-btn').addEventListener('click', async () => {
            const btn = $('adm-refresh-campaigns-btn');
            S.setButtonLoading(btn, true, 'Đang tải...');
            try { await loadAdminCampaigns(); } finally { S.setButtonLoading(btn, false); }
        });
        $('adm-paycfg-form').addEventListener('submit', handlePaymentConfigSubmit);
        $('adm-proxycfg-form').addEventListener('submit', handleProxyConfigSubmit);
        $('clear-global-log-btn').addEventListener('click', () => { $('adm-global-log').innerHTML = ''; });

        $('adm-campaigns-body').addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'camp-stop' && id) {
                await stopCampaignAsAdmin(id, btn);
            } else if (action === 'camp-reset' && id) {
                await resetCampaignStatsAsAdmin(id, btn);
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
                await selectOrder(id, btn);
            } else if (action === 'adm-confirm' && id) {
                await confirmOrderAsAdmin(id, btn);
            } else if (action === 'adm-stop' && campId) {
                await stopCampaignAsAdmin(campId, btn);
            } else if (action === 'adm-delete' && id) {
                S.setButtonLoading(btn, true, 'Đang xóa...');
                try {
                    const { res, data } = await apiJson('/api/admin/orders/' + encodeURIComponent(id), { method: 'DELETE' });
                    if (!res.ok || !data.success) {
                        S.showAlert('adm-action-msg', (data && data.message) || 'Không thể xóa đơn.', 'err');
                    } else {
                        S.showAlert('adm-action-msg', `Đã xóa đơn ${id}.`, 'ok');
                        removeRecentOrder(id);
                        if (state.activeOrderId === id) {
                            clearActiveOrderView();
                        }
                        await Promise.all([loadAdminOrders(), loadAdminCampaigns()]);
                    }
                } catch (err) {
                    S.showAlert('adm-action-msg', 'Lỗi kết nối khi xóa đơn.', 'err');
                } finally {
                    S.setButtonLoading(btn, false);
                }
            }
        });
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    async function boot() {
        bindEvents();
        initDefaultScheduleWindow();
        refreshFormSummaries();
        UI.renderRecentOrders(getRecentOrders());

        const params = new URLSearchParams(window.location.search);
        const backendParam = params.get('backend');
        const modeParam = params.get('mode');
        const initialOrderId = params.get('orderId') || params.get('order');

        let savedRemote = '';
        let preferDemo = false;
        try {
            savedRemote = S.normalizeBackendUrl(localStorage.getItem(S.STORAGE_KEYS.REMOTE_BACKEND));
            preferDemo = localStorage.getItem(S.STORAGE_KEYS.PREFER_DEMO) === '1';
        } catch (e) {}

        if (backendParam) {
            const ok = await applyRuntimeMode('remote', backendParam);
            if (!ok) {
                await applyRuntimeMode('demo');
                S.showAlert('runtime-conn-msg', `Tunnel ${backendParam} hiện chưa phản hồi — đã tự chuyển sang Static Demo để xem giao diện.`, 'warn');
            }
        } else if (modeParam === 'demo') {
            await applyRuntimeMode('demo');
        } else if (S.isStaticHostingEnv()) {
            if (savedRemote && !preferDemo) {
                const ok = await applyRuntimeMode('remote', savedRemote);
                if (!ok) {
                    await applyRuntimeMode('demo');
                    S.showAlert('runtime-conn-msg', `Tunnel đã lưu (${savedRemote}) hiện chưa chạy — đang mở Static Demo.`, 'warn');
                }
            } else {
                await applyRuntimeMode('demo');
            }
        } else {
            state.mode = 'same-origin';
            UI.renderRuntimeModeUI(state);
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
