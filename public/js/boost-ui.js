(function (global) {
    'use strict';

    const S = global.BoostShared;
    const $ = S.$;
    const esc = S.esc;
    const fmtVnd = S.fmtVnd;
    const fmtTime = S.fmtTime;

    function renderRuntimeModeUI(state) {
        const pill = $('runtime-mode-pill');
        const desc = $('runtime-mode-desc');
        const input = $('backend-url-input');
        const sameBtn = $('use-same-origin-btn');
        const demoBtn = $('use-demo-mode-btn');
        const copyShareBtn = $('copy-backend-link-btn');

        if (input && state.backendUrl && document.activeElement !== input) {
            input.value = state.backendUrl;
        } else if (input && !state.backendUrl && state.mode !== 'remote' && document.activeElement !== input) {
            input.value = '';
        }

        const socketPill = $('socket-pill');
        if (socketPill) {
            socketPill.classList.toggle('hidden', state.mode === 'demo');
        }

        const canUseSameOrigin = !S.isStaticHostingEnv();
        if (sameBtn) sameBtn.classList.toggle('hidden', !canUseSameOrigin || state.mode === 'same-origin');
        if (demoBtn) demoBtn.classList.toggle('hidden', state.mode === 'demo');
        if (copyShareBtn) {
            const hasShareTarget = Boolean(state.mode === 'remote' && state.backendUrl);
            copyShareBtn.classList.toggle('hidden', !hasShareTarget);
        }

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

        if (!pill || !desc) return;
        if (state.mode === 'remote') {
            if (state.remoteHealthy === false) {
                pill.className = 'pill warn';
                pill.textContent = 'Chế độ: Remote Tunnel (Đang kết nối lại...)';
                desc.textContent = `Mất kết nối tạm thời tới ${state.backendUrl}. Đang thử GET /api/health tự động hoặc bạn có thể chuyển sang Static Demo.`;
            } else {
                pill.className = 'pill info';
                pill.textContent = 'Chế độ: Remote Tunnel';
                desc.textContent = `Đang nối Backend thật tại ${state.backendUrl} (CORS + Bearer Token).`;
            }
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

    function renderAuthState(state, hooks = {}) {
        const { authenticated, role, username, pricing, defaultPasswordWarning } = state.config;
        const authPill = $('auth-pill');
        const loginBtn = $('open-login-btn');
        const logoutBtn = $('logout-btn');
        const gateBox = $('admin-gate-box');
        const adminWorkspace = $('admin-workspace');
        const pwBanner = $('admin-default-pw-banner');

        if (pricing) {
            const cRateEl = $('c-rate');
            const cHrateEl = $('c-hrate');
            if (cRateEl) cRateEl.textContent = Number(pricing.clickRate || 40).toLocaleString('vi-VN');
            if (cHrateEl) cHrateEl.textContent = Number(pricing.hourlyRate || 2000).toLocaleString('vi-VN');
        }

        const authRequired = state.config.authRequired === true;
        const isAdmin = !authRequired || Boolean(authenticated && role === 'admin');
        const loginModal = $('login-modal');

        if (!authRequired) {
            if (authPill) authPill.classList.add('hidden');
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
            if (gateBox) gateBox.classList.add('hidden');
            if (adminWorkspace) adminWorkspace.classList.remove('hidden');
            if (loginModal) loginModal.classList.remove('open');
            if (pwBanner) {
                pwBanner.classList.toggle('hidden', defaultPasswordWarning !== true);
            }
            if (typeof hooks.onAdminAuthenticated === 'function') {
                hooks.onAdminAuthenticated();
            }
        } else if (isAdmin) {
            if (authPill) {
                authPill.className = 'pill ok';
                authPill.textContent = `Admin: ${username || 'admin'} (1 tài khoản)`;
            }
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
            if (gateBox) gateBox.classList.add('hidden');
            if (adminWorkspace) adminWorkspace.classList.remove('hidden');
            if (pwBanner) {
                pwBanner.classList.toggle('hidden', defaultPasswordWarning !== true);
            }
            if (typeof hooks.onAdminAuthenticated === 'function') {
                hooks.onAdminAuthenticated();
            }
        } else {
            if (authPill) {
                authPill.className = 'pill info';
                authPill.textContent = 'Khách (Không cần tài khoản)';
            }
            if (loginBtn) {
                loginBtn.classList.remove('hidden');
                S.setButtonTextSafe(loginBtn, 'Đăng nhập Admin');
            }
            if (logoutBtn) logoutBtn.classList.add('hidden');
            if (gateBox) gateBox.classList.remove('hidden');
            if (adminWorkspace) adminWorkspace.classList.add('hidden');
            if (pwBanner) pwBanner.classList.add('hidden');
            S.showAlert('admin-gate-msg', '');
        }

        if (state.activeOrder) {
            renderActiveOrder(state.activeOrder, state, hooks);
        }
    }

    function renderProxyValidateResult(containerId, ok, data) {
        const el = $(containerId);
        if (!el) return;
        if (!data) {
            el.innerHTML = '';
            return;
        }
        const isValid = Boolean(ok && data.valid !== false && data.success !== false);
        const kind = isValid ? 'ok' : (ok ? 'warn' : 'err');
        const details = [];
        const ip = data.realIpAddress || data.ip;
        if (ip) details.push(`IP: ${ip}`);
        if (data.location) details.push(`Vùng: ${data.location}`);
        if (data.ttl != null) details.push(`TTL: ${data.ttl}s`);
        if (data.ttc != null) details.push(`Đổi mới sau: ${data.ttc}s`);
        const detailText = details.length ? ` (${details.join(' · ')})` : '';
        const msg = (data.message || (isValid ? 'Key KiotProxy hợp lệ.' : 'Key KiotProxy không hợp lệ.')) + detailText;
        el.innerHTML = `<div class="alert ${kind}" style="margin-top:6px;">${esc(msg)}</div>`;
    }

    function setPreviewFooterButton(footer, labelText) {
        if (!footer) return;
        if (!labelText) {
            if (footer.firstChild) footer.innerHTML = '';
            return;
        }
        const existingBtn = footer.querySelector('button[data-action="toggle-preview-slices"]');
        const labelSpan = existingBtn ? existingBtn.querySelector('.btn-label') : null;
        if (existingBtn && labelSpan) {
            labelSpan.textContent = labelText;
            return;
        }
        footer.innerHTML = `<button type="button" class="btn btn-sm" data-action="toggle-preview-slices"><span class="btn-label">${esc(labelText)}</span></button>`;
    }

    function renderDistributionPreview({ targetClicks, durationHours, mode, customBlocks }, state) {
        const tbody = $('dist-preview-body');
        const footer = $('dist-preview-footer');
        const capAlert = $('dist-capacity-alert');
        const intervalPill = $('dist-interval-pill');

        if (!global.TimeDistribution || !Number.isInteger(targetClicks) || targetClicks <= 0 || !Number.isFinite(durationHours) || durationHours <= 0) {
            setPreviewFooterButton(footer, '');
            if (intervalPill) intervalPill.textContent = '--';
            if (capAlert) capAlert.innerHTML = '';
            if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Nhập số click nguyên (≥ 1) &amp; thời gian &gt; 0 để xem trước phân bổ.</td></tr>';
            return;
        }

        if (durationHours > S.MAX_PREVIEW_HOURS) {
            setPreviewFooterButton(footer, '');
            const avgIntervalSec = Number(((durationHours * 3600) / targetClicks).toFixed(1));
            if (intervalPill) intervalPill.textContent = `TB ~${avgIntervalSec}s / click`;
            if (capAlert) {
                capAlert.innerHTML = `<div class="alert warn">Thời gian ${esc(durationHours)} giờ vượt quá giới hạn xem trước từng giờ (${S.MAX_PREVIEW_HOURS.toLocaleString('vi-VN')} giờ / 1 năm). Phí thời gian vẫn được tính chính xác.</div>`;
            }
            if (tbody) {
                tbody.innerHTML = `<tr><td class="mono">Tổng ${esc(durationHours)} giờ</td><td>${Math.round(durationHours * 60).toLocaleString('vi-VN')} phút</td><td><strong>${targetClicks.toLocaleString('vi-VN')}</strong></td><td>100.0%</td></tr>`;
            }
            return;
        }

        const startTime = Date.now();
        const endTime = startTime + Math.round(durationHours * 3600000);
        const dist = global.TimeDistribution.buildTimeDistribution({
            startTime,
            endTime,
            targetClicks,
            mode,
            customBlocks
        });

        if (!dist.valid) {
            setPreviewFooterButton(footer, '');
            if (intervalPill) intervalPill.textContent = '--';
            if (capAlert) capAlert.innerHTML = '';
            if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">Không thể tính phân bổ với thông số này.</td></tr>';
            return;
        }

        if (intervalPill) intervalPill.textContent = `TB ~${dist.avgIntervalSec}s / click`;
        if (capAlert) {
            if (dist.avgIntervalSec < 15) {
                const safeMax = Math.max(1, Math.floor((durationHours * 3600) / 15));
                capAlert.innerHTML = `<div class="alert warn">Cảnh báo công suất 1 KiotProxy key: nhịp trung bình ~${esc(dist.avgIntervalSec)}s/click nhanh hơn cooldown xoay IP (~15s). 1 key chạy ổn định tối đa khoảng ~${safeMax.toLocaleString('vi-VN')} lượt trong ${esc(durationHours)} giờ (hoặc phần dư sẽ chậm hơn thời hạn).</div>`;
            } else {
                capAlert.innerHTML = `<div class="alert ok">Phù hợp công suất 1 KiotProxy key (nhịp ~${esc(dist.avgIntervalSec)}s/click ≥ 15s cooldown).</div>`;
            }
        }

        const allRows = dist.slices && dist.slices.length > 0 ? dist.slices : dist.summaryBlocks;
        let visibleRows = allRows;
        let tailSummaryRow = '';

        if (allRows.length > S.COLLAPSED_PREVIEW_LIMIT && !state.expandPreviewSlices) {
            visibleRows = allRows.slice(0, S.COLLAPSED_PREVIEW_LIMIT);
            const rest = allRows.slice(S.COLLAPSED_PREVIEW_LIMIT);
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
            setPreviewFooterButton(footer, `Hiển thị đủ ${allRows.length} khung giờ (đang gộp ${rest.length} khung cuối)`);
        } else if (allRows.length > S.COLLAPSED_PREVIEW_LIMIT) {
            setPreviewFooterButton(footer, `Thu gọn về ${S.COLLAPSED_PREVIEW_LIMIT} khung giờ + tổng phần còn lại`);
        } else {
            setPreviewFooterButton(footer, '');
        }

        if (tbody) {
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
    }

    function renderRecentOrders(list) {
        const wrap = $('recent-orders-wrap');
        if (!wrap) return;
        if (!list.length) {
            wrap.innerHTML = '<div class="hint">Chưa có đơn nào được lưu trên trình duyệt này.</div>';
            return;
        }
        wrap.innerHTML = list.slice(0, 6).map(item => `
            <div class="kv recent-order-row">
                <div style="min-width:0; padding-right:8px;">
                    <code class="mono">${esc(item.orderId)}</code>
                    <span class="pill" style="padding:1px 7px;font-size:11px;">${esc(item.orderCode || '')}</span>
                    <div class="hint" style="margin:2px 0 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:300px;">
                        ${esc(item.targetUrl || '')}
                    </div>
                </div>
                <div style="display:flex; gap:5px; align-items:center; flex-shrink:0;">
                    <button type="button" class="btn btn-sm" data-action="load-recent" data-id="${esc(item.orderId)}"><span class="btn-label">Mở</span></button>
                    <button type="button" class="btn btn-sm" data-action="del-recent" data-id="${esc(item.orderId)}" aria-label="Xóa khỏi lịch sử">&times;</button>
                </div>
            </div>
        `).join('');
    }

    function appendLogLine(boxId, text, type = 'info', timeStr = null) {
        S.appendRingLogLine(boxId, text, type, timeStr, S.LOG_RING_BUFFER_MAX);
    }

    function hydrateOrderWorkerLogs(campId, campaignLogs) {
        const box = $('ao-worker-log');
        if (!box || !campId) return;
        const cid = String(campId);
        if (box.dataset.campId === cid) return;
        box.dataset.campId = cid;
        box.innerHTML = '';
        const list = campaignLogs && campaignLogs.get(cid) ? campaignLogs.get(cid) : [];
        const sliced = list.slice(-S.LOG_RING_BUFFER_MAX);
        for (const item of sliced) {
            appendLogLine('ao-worker-log', item.line, item.type, item.time);
        }
    }

    function renderActiveOrder(o, state, hooks = {}) {
        const emptyEl = $('active-order-empty');
        const panelEl = $('active-order-panel');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (panelEl) panelEl.classList.remove('hidden');

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
            scheduleMode: o.scheduleMode || 'smart',
            dwellPreset: o.dwellPreset || 'short',
            deviceProfile: o.deviceProfile || 'mixed'
        };

        const effectiveStatus = S.getEffectiveOrderStatus({ ...o, progress: prog });
        const isPaid = o.paymentStatus === 'paid';
        const isExpired = effectiveStatus === 'expired';
        const isDone = ['completed', 'expired', 'stopped'].includes(effectiveStatus);
        const isAdmin = state.config.authRequired !== true || Boolean(state.config.authenticated && state.config.role === 'admin');

        $('ao-id').textContent = o.orderId || '--';
        $('ao-code').textContent = o.orderCode || '--';

        const trackUrl = S.buildTrackOrderUrl(o.orderId, state.mode, state.backendUrl);
        const trackCardEl = $('ao-track-card');
        const trackLinkEl = $('ao-track-link');
        const trackOpenEl = $('ao-track-open-link');
        if (trackCardEl) trackCardEl.classList.toggle('hidden', !trackUrl);
        if (trackLinkEl) trackLinkEl.textContent = trackUrl || '--';
        if (trackOpenEl) {
            if (trackUrl) {
                trackOpenEl.href = trackUrl;
                trackOpenEl.classList.remove('hidden');
            } else {
                trackOpenEl.removeAttribute('href');
                trackOpenEl.classList.add('hidden');
            }
        }
        $('ao-target').textContent = `${o.name ? o.name + ' — ' : ''}${o.targetUrl || ''}`;
        $('ao-proxy').textContent = o.proxyKeyMasked || '--';
        const schedSummaryEl = $('ao-schedule-window');
        if (schedSummaryEl) {
            schedSummaryEl.textContent = S.formatScheduleWindowSummary(o);
        }
        const waitRowEl = $('ao-wait-row');
        const waitTargetMs = Number(o.scheduledStartAt || prog.startTime || 0);
        const showWaitingCountdown = effectiveStatus === 'waiting' && waitTargetMs > Date.now();
        if (waitRowEl) {
            waitRowEl.classList.toggle('hidden', !showWaitingCountdown);
        }
        if (showWaitingCountdown && hooks.onStartWaitCountdown) {
            hooks.onStartWaitCountdown(waitTargetMs);
        } else if (!showWaitingCountdown && hooks.onStopWaitCountdown) {
            hooks.onStopWaitCountdown();
        }

        const schedLabel = o.scheduleMode === 'even' ? 'Even' : (o.scheduleMode === 'custom' ? 'Custom' : 'Smart');
        const durText = S.formatDurationCompactVi(o.durationHours);
        $('ao-plan').textContent = `${Number(o.targetClicks || 0).toLocaleString('vi-VN')} clicks · ${durText} · Phân bổ ${schedLabel}`;
        const profileEl = $('ao-profile');
        if (profileEl) {
            profileEl.textContent = `${S.formatDwellLabel(o.dwellPreset || prog.dwellPreset)} · ${S.formatDeviceLabel(o.deviceProfile || prog.deviceProfile)}`;
        }
        const togglesEl = $('ao-toggles');
        if (togglesEl) {
            togglesEl.textContent = `Chống trùng IP: ${o.dedupIp !== false ? 'Bật' : 'Tắt'} · Click link con: ${o.randomLinks !== false ? 'Bật' : 'Tắt'}`;
        }
        if ($('ao-amount')) $('ao-amount').textContent = fmtVnd(o.totalAmount);

        const pill = $('ao-status-pill');
        if (effectiveStatus === 'completed') {
            pill.className = 'pill ok';
            pill.textContent = 'Đã hoàn thành';
            if (hooks.onStopPolling) hooks.onStopPolling();
            if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();
        } else if (isExpired) {
            pill.className = 'pill warn';
            pill.textContent = isPaid ? 'Hết giờ chạy' : 'Hết hạn';
            if (hooks.onStopPolling) hooks.onStopPolling();
            if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();
        } else if (effectiveStatus === 'stopped') {
            pill.className = 'pill err';
            pill.textContent = 'Đã dừng';
            if (hooks.onStopPolling) hooks.onStopPolling();
            if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();
        } else if (effectiveStatus === 'waiting') {
            pill.className = 'pill warn';
            pill.textContent = 'Chờ tới giờ hẹn';
            if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();
        } else if (!isPaid) {
            pill.className = 'pill warn';
            pill.textContent = 'Chờ kích hoạt';
        } else {
            pill.className = 'pill info';
            pill.textContent = 'Đang chạy';
            if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();
        }

        // Payment UI is intentionally deferred/hidden on /boost
        const payBox = $('ao-payment-box');
        if (payBox) payBox.classList.add('hidden');
        if ($('inline-admin-confirm-btn')) $('inline-admin-confirm-btn').classList.add('hidden');
        if (hooks.onStopQrCountdown) hooks.onStopQrCountdown();

        const target = Math.max(1, Number(prog.targetLimit || o.targetClicks || 1));
        const success = Number(prog.successVisits || 0);
        const failed = Number(prog.failedVisits || 0);
        const total = Number(prog.totalVisits || (success + failed));
        const pct = Math.min(100, Math.floor((success / target) * 100));
        const campId = prog.campaignId || o.campaignId || null;

        $('ao-camp-id').textContent = campId || 'Chưa kích hoạt';
        $('ao-progress-bar').style.width = pct + '%';
        $('ao-progress-text').textContent = `${success.toLocaleString('vi-VN')} / ${target.toLocaleString('vi-VN')} lượt thành công (${pct}%)`;

        if (isExpired && !isPaid) {
            const expTime = o.expiresAt || ((o.createdAt || Date.now()) + S.ORDER_EXPIRE_MS);
            $('ao-time-text').textContent = `Hết hạn lúc: ${S.formatVnDateTime(expTime)}`;
        } else if (isDone) {
            const endedAt = prog.actualEndTime || o.completedAt || prog.endTime;
            const startedAt = prog.actualStartTime || o.paidAt || prog.startTime;
            let durSuffix = '';
            if (endedAt && startedAt && endedAt >= startedAt && global.TimeDistribution && typeof global.TimeDistribution.formatDuration === 'function') {
                durSuffix = ` · Thời lượng: ${global.TimeDistribution.formatDuration(endedAt - startedAt)}`;
            }
            $('ao-time-text').textContent = endedAt ? `Kết thúc thực tế: ${S.formatVnDateTime(endedAt)}${durSuffix}` : `Hoàn tất (Tạo lúc: ${S.formatVnDateTime(o.createdAt)})`;
        } else if (effectiveStatus === 'waiting' && (o.scheduledStartAt || prog.startTime)) {
            const sAt = Number(o.scheduledStartAt || prog.startTime);
            const eAt = Number(o.scheduledEndAt || prog.endTime);
            $('ao-time-text').textContent = `Bắt đầu: ${S.formatVnDateTime(sAt)} → Kết thúc: ${S.formatVnDateTime(eAt)} (Giờ VN)`;
        } else {
            $('ao-time-text').textContent = prog.endTime ? `Dự kiến kết thúc: ${S.formatVnDateTime(prog.endTime)}` : `Tạo lúc: ${S.formatVnDateTime(o.createdAt)}`;
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
            hydrateOrderWorkerLogs(campId, state.campaignLogs);
        }
    }

    function renderAdminOrdersTable(state) {
        const tbody = $('adm-orders-body');
        const filterEl = $('adm-filter');
        if (!tbody || !filterEl) return;
        const filter = filterEl.value;
        const filtered = state.adminOrders.filter(o => {
            const st = S.getEffectiveOrderStatus(o);
            if (filter === 'all') return true;
            return st === filter;
        });

        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">Không có đơn hàng nào khớp bộ lọc.</td></tr>';
            return;
        }

        tbody.innerHTML = filtered.map(o => {
            const eff = S.getEffectiveOrderStatus(o);
            const p = o.progress || {};
            const succ = p.successVisits ?? o.successVisits ?? 0;
            const target = p.targetLimit || o.targetClicks || 0;
            const isPaid = o.paymentStatus === 'paid';
            const isExpired = eff === 'expired';
            const canStop = Boolean(o.campaignId) && ['running', 'waiting'].includes(eff);
            const canDelete = !['running', 'waiting'].includes(eff);
            const payBadge = isPaid
                ? '<span class="pill ok">paid</span>'
                : (isExpired ? '<span class="pill err">expired</span>' : '<span class="pill warn">pending_payment</span>');

            return `<tr>
                <td>
                    <code class="mono">${esc(o.orderId)}</code><br>
                    <span class="pill" style="padding:1px 6px;font-size:11px;margin-top:3px;">${esc(o.orderCode)}</span>
                </td>
                <td style="max-width:250px; word-break:break-all;">
                    <strong>${esc(o.name || o.orderCode)}</strong><br>
                    <span class="hint">${esc(o.targetUrl)}</span><br>
                    <span class="hint">Key: <code>${esc(o.proxyKeyMasked || '')}</code> · ${esc(o.scheduleMode || 'smart')} · ${esc(S.normalizeDwellPreset(o.dwellPreset))}/${esc(S.normalizeDeviceProfile(o.deviceProfile))}</span><br>
                    <span class="hint">${esc(S.formatScheduleWindowSummary(o))}</span>
                </td>
                <td>${fmtVnd(o.totalAmount)}</td>
                <td>
                    <div>${payBadge}</div>
                    <div class="hint" style="margin-top:4px;">Trạng thái: <code>${esc(eff)}</code></div>
                </td>
                <td>
                    <strong>${Number(succ).toLocaleString('vi-VN')} / ${Number(target).toLocaleString('vi-VN')}</strong>
                    <div class="hint">${o.campaignId ? 'C' + esc(o.campaignId) : 'Chưa kích hoạt'}</div>
                </td>
                <td>
                    <div style="display:flex; flex-wrap:wrap; gap:4px;">
                        <button type="button" class="btn btn-sm" data-action="adm-view" data-id="${esc(o.orderId)}"><span class="btn-label">Xem</span></button>
                        ${(!isPaid && !isExpired) ? `<button type="button" class="btn btn-sm btn-success" data-action="adm-confirm" data-id="${esc(o.orderId)}"><span class="btn-label">Duyệt</span></button>` : ''}
                        ${canStop ? `<button type="button" class="btn btn-sm btn-danger" data-action="adm-stop" data-camp-id="${esc(o.campaignId)}"><span class="btn-label">Dừng</span></button>` : ''}
                        ${canDelete ? `<button type="button" class="btn btn-sm" data-action="adm-delete" data-id="${esc(o.orderId)}"><span class="btn-label">Xóa</span></button>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');
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
                        ${canStop ? `<button type="button" class="btn btn-sm btn-danger" data-action="camp-stop" data-id="${esc(c.id)}"><span class="btn-label">Dừng</span></button>` : ''}
                        <button type="button" class="btn btn-sm" data-action="camp-reset" data-id="${esc(c.id)}"><span class="btn-label">Reset</span></button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    global.BoostUI = {
        renderRuntimeModeUI,
        renderAuthState,
        renderProxyValidateResult,
        renderDistributionPreview,
        renderRecentOrders,
        renderActiveOrder,
        renderAdminOrdersTable,
        renderAdminCampaignsTable,
        appendLogLine,
        hydrateOrderWorkerLogs
    };
})(window);
