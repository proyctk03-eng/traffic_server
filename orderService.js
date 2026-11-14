const fs = require('fs');
const path = require('path');
const BoostShared = require('./public/js/boost-shared');

const ORDERS_DIR = path.join(__dirname, 'orders');
const PAYMENT_CONFIG_PATH = path.join(__dirname, 'payment_config.json');

if (!fs.existsSync(ORDERS_DIR)) {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
}

const DEFAULT_PAYMENT_CONFIG = {
    bankId: 'MB',
    bankName: 'MBBank',
    accountNumber: '0987654321',
    accountName: 'TRAFFIC SERVICE',
    template: 'compact2'
};

const CLICK_RATE = 40;
const HOURLY_RATE = 2000;
const DEFAULT_TEMPLATE = 'compact2';
const ORDER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DWELL_PRESET_BOUNDS = {
    short: { min: 2, max: 5 },
    quick: { min: 2, max: 5 },
    medium: { min: 5, max: 10 },
    standard: { min: 5, max: 15 },
    long: { min: 10, max: 20 },
    deep: { min: 15, max: 30 }
};
const VALID_DEVICE_PROFILES = new Set(['mixed', 'mobile', 'desktop', 'balanced']);

function resolveDwellBounds(preset) {
    const key = typeof preset === 'string' ? preset.trim().toLowerCase() : '';
    return DWELL_PRESET_BOUNDS[key] || DWELL_PRESET_BOUNDS.short;
}

function isPrivateTargetAllowed() {
    if (process.env.ALLOW_PRIVATE_TARGET_URLS === 'false') return false;
    if (process.env.ALLOW_PRIVATE_TARGET_URLS === 'true') return true;
    if (process.env.NODE_ENV === 'test') return true;
    const isServerEntry = Boolean(require.main && require.main.filename && /[\\/]server\.js$/i.test(require.main.filename));
    if (isServerEntry) return false;
    const isTestRunner = Boolean(
        process.env.NODE_TEST_CONTEXT ||
        (require.main && require.main.filename && (
            /[\\/]test[\\/]/i.test(require.main.filename) ||
            /\.(?:test|spec)\.[a-z0-9]+$/i.test(require.main.filename)
        ))
    );
    if (isTestRunner && process.env.NODE_ENV !== 'production') return true;
    return false;
}

function isPrivateIpV4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;
    // 0.0.0.0/8 (current network)
    if (parts[0] === 0) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (private 172.16.0.0 - 172.31.255.255)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local / cloud metadata)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 255.255.255.255 (broadcast)
    if (parts[0] === 255 && parts[1] === 255 && parts[2] === 255 && parts[3] === 255) return true;
    return false;
}

function decodeIpv4FromHexOrDotted(tail) {
    if (!tail) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
        const w1 = parseInt(hexParts[0], 16);
        const w2 = parseInt(hexParts[1], 16);
        if (!isNaN(w1) && !isNaN(w2) && w1 >= 0 && w1 <= 0xffff && w2 >= 0 && w2 <= 0xffff) {
            return `${(w1 >> 8) & 0xff}.${w1 & 0xff}.${(w2 >> 8) & 0xff}.${w2 & 0xff}`;
        }
    }
    return null;
}

function isPrivateIpV6(rawIp) {
    const clean = (rawIp || '').replace(/^\[|\]$/g, '').toLowerCase().trim();
    if (!clean) return false;
    // Loopback & unspecified
    if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1' || clean === '0:0:0:0:0:0:0:0') return true;

    // IPv4-mapped IPv6 (::ffff:127.0.0.1, WHATWG hex normalized ::ffff:7f00:1, or expanded 0:0:0:0:0:ffff:...)
    if (clean.startsWith('::ffff:')) {
        const v4 = decodeIpv4FromHexOrDotted(clean.slice(7));
        if (v4) return isPrivateIpV4(v4);
    }
    if (/^(0+:){5}ffff:/i.test(clean)) {
        const v4 = decodeIpv4FromHexOrDotted(clean.replace(/^(0+:){5}ffff:/i, ''));
        if (v4) return isPrivateIpV4(v4);
    }

    // Deprecated IPv4-compatible IPv6 addresses (::127.0.0.1, WHATWG hex normalized ::7f00:1, or expanded 0:0:0:0:0:0:...)
    if (clean.startsWith('::') && !clean.startsWith('::ffff:')) {
        const v4 = decodeIpv4FromHexOrDotted(clean.slice(2));
        if (v4) return isPrivateIpV4(v4);
    }
    if (/^(0+:){6}/i.test(clean)) {
        const v4 = decodeIpv4FromHexOrDotted(clean.replace(/^(0+:){6}/i, ''));
        if (v4) return isPrivateIpV4(v4);
    }

    // Unique local address fc00::/7 (fc00:: - fdff::)
    if (/^f[cd][0-9a-f]{0,2}:/i.test(clean) || clean.startsWith('fc') || clean.startsWith('fd')) return true;
    // Link-local unicast fe80::/10 (fe80:: - febf::)
    if (/^fe[89ab][0-9a-f]{0,2}:/i.test(clean) || clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) return true;
    return false;
}

function isLexicallyPrivateHost(rawHost) {
    if (!rawHost) return false;
    const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase().trim();
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host === 'metadata.google.internal' || host === 'instance-data') return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return isPrivateIpV4(host);
    }
    if (host.includes(':')) {
        return isPrivateIpV6(host);
    }
    return false;
}

function getPaymentConfig() {
    try {
        if (fs.existsSync(PAYMENT_CONFIG_PATH)) {
            const data = fs.readFileSync(PAYMENT_CONFIG_PATH, 'utf-8');
            return { ...DEFAULT_PAYMENT_CONFIG, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('[orderService] Failed to read payment_config.json, using defaults:', e.message);
    }
    return { ...DEFAULT_PAYMENT_CONFIG };
}

function getPublicBankInfo(config = getPaymentConfig()) {
    const { webhookSecret, ...publicBank } = config || {};
    return publicBank;
}

function setPaymentConfig(config) {
    const current = getPaymentConfig();
    const merged = {
        ...current,
        bankId: String(config.bankId || current.bankId || DEFAULT_PAYMENT_CONFIG.bankId).trim().toUpperCase(),
        bankName: String(config.bankName || current.bankName || DEFAULT_PAYMENT_CONFIG.bankName).trim(),
        accountNumber: String(config.accountNumber || current.accountNumber || DEFAULT_PAYMENT_CONFIG.accountNumber).trim(),
        accountName: String(config.accountName || current.accountName || DEFAULT_PAYMENT_CONFIG.accountName).trim().toUpperCase(),
        template: String(config.template || current.template || DEFAULT_TEMPLATE).trim(),
        webhookSecret: config.webhookSecret !== undefined ? String(config.webhookSecret).trim() : (current.webhookSecret || '')
    };
    fs.writeFileSync(PAYMENT_CONFIG_PATH, JSON.stringify(merged, null, 4), 'utf-8');
    return getPaymentConfig();
}

function maskProxyKey(key) {
    if (!key || typeof key !== 'string') return '';
    const trimmed = key.trim();
    return trimmed.length > 4 ? `...${trimmed.slice(-4)}` : '****';
}

function validateOrderParams(params) {
    const errors = [];
    if (!params || typeof params !== 'object') {
        return { isValid: false, valid: false, errors: ['Request body must be an object'], sanitized: null };
    }

    // targetUrl
    const targetUrl = typeof params.targetUrl === 'string' ? params.targetUrl.trim() : '';
    if (!targetUrl) {
        errors.push('targetUrl is required');
    } else {
        try {
            const parsed = new URL(targetUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                errors.push('targetUrl must use http:// or https:// protocol');
            } else if (!isPrivateTargetAllowed() && isLexicallyPrivateHost(parsed.hostname)) {
                errors.push('targetUrl cannot target localhost, private, or loopback addresses');
            }
        } catch {
            errors.push('targetUrl is not a valid URL');
        }
    }

    // proxyKey
    const proxyKey = typeof params.proxyKey === 'string' ? params.proxyKey.trim() : '';
    if (!proxyKey) {
        errors.push('proxyKey is required and cannot be empty');
    }

    // targetClicks
    const clicksVal = params.targetClicks;
    if (typeof clicksVal !== 'number' && (typeof clicksVal !== 'string' || clicksVal.trim() === '')) {
        errors.push('targetClicks must be a positive integer greater than or equal to 1');
    } else {
        const rawClicks = Number(clicksVal);
        if (!Number.isInteger(rawClicks) || rawClicks < 1) {
            errors.push('targetClicks must be a positive integer greater than or equal to 1');
        }
    }

    // scheduleType + durationHours (Vietnam UTC+7 window support with overnight cross-day)
    const scheduleType = params.scheduleType === 'window' ? 'window' : 'duration';
    let resolvedDurationHours = Number(params.durationHours);
    let windowFields = {
        scheduleType,
        runDate: null,
        endRunDate: null,
        startTime: null,
        endTime: null,
        overnight: false,
        timezone: 'Asia/Ho_Chi_Minh',
        scheduledStartAt: null,
        scheduledEndAt: null
    };

    if (scheduleType === 'window') {
        const win = BoostShared.computeVietnamScheduleWindow({
            runDate: params.runDate,
            startTime: params.startTime || params.startTimeText,
            endTime: params.endTime || params.endTimeText,
            allowPast: params.allowPast === true
        });
        if (!win.valid) {
            errors.push(win.message || 'Khung giờ hẹn chạy không hợp lệ.');
        } else {
            resolvedDurationHours = win.durationHours;
            windowFields = {
                scheduleType: 'window',
                runDate: win.runDate,
                endRunDate: win.endRunDate,
                startTime: win.startTime,
                endTime: win.endTime,
                overnight: win.overnight,
                timezone: win.timezone,
                scheduledStartAt: win.scheduledStartAt,
                scheduledEndAt: win.scheduledEndAt
            };
        }
    } else {
        const durationVal = params.durationHours;
        if (typeof durationVal !== 'number' && (typeof durationVal !== 'string' || durationVal.trim() === '')) {
            errors.push('durationHours must be a positive number greater than 0');
        } else {
            const rawDuration = Number(durationVal);
            if (isNaN(rawDuration) || !Number.isFinite(rawDuration) || rawDuration <= 0) {
                errors.push('durationHours must be a positive number greater than 0');
            }
        }
    }

    const name = typeof params.name === 'string' && params.name.trim()
        ? params.name.trim()
        : `Order_${Date.now()}`;

    const scheduleMode = params.scheduleMode === 'even'
        ? 'even'
        : (params.scheduleMode === 'custom' ? 'custom' : 'smart');
    const ALLOWED_LEVELS = new Set(['low', 'medium', 'high']);
    let customBlocks = null;
    if (scheduleMode === 'custom' && params.customBlocks && typeof params.customBlocks === 'object') {
        const b = params.customBlocks;
        customBlocks = {
            night: ALLOWED_LEVELS.has(b.night) ? b.night : 'low',
            early_morning: ALLOWED_LEVELS.has(b.early_morning) ? b.early_morning : 'medium',
            morning: ALLOWED_LEVELS.has(b.morning) ? b.morning : 'high',
            noon: ALLOWED_LEVELS.has(b.noon) ? b.noon : 'medium',
            afternoon: ALLOWED_LEVELS.has(b.afternoon) ? b.afternoon : 'high',
            evening: ALLOWED_LEVELS.has(b.evening) ? b.evening : 'high',
            late_night: ALLOWED_LEVELS.has(b.late_night) ? b.late_night : 'medium'
        };
    }
    const dedupIp = params.dedupIp !== false && params.dedupIp !== 'false';
    const randomLinks = params.randomLinks !== false && params.randomLinks !== 'false';
    const rawDwellPreset = typeof params.dwellPreset === 'string' ? params.dwellPreset.trim().toLowerCase() : '';
    const dwellPreset = Object.prototype.hasOwnProperty.call(DWELL_PRESET_BOUNDS, rawDwellPreset)
        ? rawDwellPreset
        : 'short';
    const rawDeviceProfile = typeof params.deviceProfile === 'string' ? params.deviceProfile.trim().toLowerCase() : '';
    const deviceProfile = VALID_DEVICE_PROFILES.has(rawDeviceProfile)
        ? rawDeviceProfile
        : 'mixed';

    const isValid = errors.length === 0;
    return {
        isValid,
        valid: isValid,
        errors,
        sanitized: isValid ? {
            targetUrl,
            proxyKey,
            targetClicks: Number(params.targetClicks),
            durationHours: resolvedDurationHours,
            name,
            scheduleMode,
            customBlocks,
            dedupIp,
            randomLinks,
            dwellPreset,
            deviceProfile,
            ...windowFields
        } : null
    };
}

function calculateOrderCost(clicks, durationHours) {
    const targetClicks = Number(clicks);
    if (!Number.isInteger(targetClicks) || targetClicks <= 0) {
        throw new Error('targetClicks must be a positive integer greater than or equal to 1');
    }

    const rawDuration = Number(durationHours);
    if (isNaN(rawDuration) || !Number.isFinite(rawDuration) || rawDuration <= 0) {
        throw new Error('durationHours must be a positive number greater than 0');
    }

    const roundedHours = Math.ceil(rawDuration);
    const clickFee = targetClicks * CLICK_RATE;
    const durationFee = roundedHours * HOURLY_RATE;
    const totalAmount = clickFee + durationFee;

    return {
        targetClicks,
        durationHours: rawDuration,
        roundedHours,
        clickRate: CLICK_RATE,
        hourlyRate: HOURLY_RATE,
        clickFee,
        durationFee,
        totalAmount
    };
}

function generateOrderCode() {
    let maxId = 1000;
    try {
        if (fs.existsSync(ORDERS_DIR)) {
            const files = fs.readdirSync(ORDERS_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, file), 'utf-8'));
                    if (content.orderCode && typeof content.orderCode === 'string') {
                        const match = content.orderCode.match(/^TF(\d+)$/i);
                        if (match) {
                            const val = parseInt(match[1], 10);
                            if (val > maxId) maxId = val;
                        }
                    }
                } catch {}
            }
        }
    } catch {}
    return `TF${maxId + 1}`;
}

function generateVietQrUrl(bankInfo, amount, memo) {
    if (!bankInfo || typeof bankInfo !== 'object' || !bankInfo.bankId || !bankInfo.accountNumber) {
        throw new Error('Invalid bank configuration: bankId and accountNumber are required');
    }

    const safeAmount = Number(amount);
    if (!Number.isInteger(safeAmount) || safeAmount <= 0) {
        throw new Error('amount must be a positive integer');
    }

    if (!memo || typeof memo !== 'string' || !/^[A-Za-z0-9]+$/.test(memo.trim())) {
        throw new Error('memo must be a non-empty alphanumeric string without accents or special characters');
    }

    const bankId = encodeURIComponent(String(bankInfo.bankId).trim());
    const accountNo = encodeURIComponent(String(bankInfo.accountNumber).trim());
    const template = encodeURIComponent(String(bankInfo.template || DEFAULT_TEMPLATE).trim());
    const cleanMemo = encodeURIComponent(memo.trim());
    const cleanAccountName = encodeURIComponent(String(bankInfo.accountName || '').trim().toUpperCase());

    return `https://img.vietqr.io/image/${bankId}-${accountNo}-${template}.png?amount=${safeAmount}&addInfo=${cleanMemo}&accountName=${cleanAccountName}`;
}

function sanitizeOrderId(orderId) {
    if (!orderId || typeof orderId !== 'string') return null;
    const trimmed = orderId.trim();
    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null;
    const clean = path.basename(trimmed);
    if (clean !== trimmed || clean === '.' || clean === '..') return null;
    return clean;
}

function checkOrderExpiration(order) {
    if (!order || typeof order !== 'object') return order;
    if (!order.expiresAt && typeof order.createdAt === 'number') {
        order.expiresAt = order.createdAt + ORDER_TTL_MS;
    }
    if (order.status === 'pending_payment' && (Date.now() - (order.createdAt || 0)) > ORDER_TTL_MS) {
        order.status = 'expired';
        order.paymentStatus = 'expired';
        order.updatedAt = Date.now();
        const cleanId = sanitizeOrderId(order.orderId);
        if (cleanId) {
            const filePath = path.join(ORDERS_DIR, `${cleanId}.json`);
            try {
                fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');
            } catch {}
        }
    }
    return order;
}

function expireStaleOrders() {
    if (!fs.existsSync(ORDERS_DIR)) return [];
    const files = fs.readdirSync(ORDERS_DIR).filter(f => f.endsWith('.json'));
    const expired = [];
    for (const f of files) {
        try {
            const filePath = path.join(ORDERS_DIR, f);
            const o = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (o.status === 'pending_payment' && (Date.now() - (o.createdAt || 0)) > ORDER_TTL_MS) {
                o.status = 'expired';
                o.paymentStatus = 'expired';
                o.updatedAt = Date.now();
                fs.writeFileSync(filePath, JSON.stringify(o, null, 4), 'utf-8');
                expired.push(o.orderId);
            }
        } catch {}
    }
    return expired;
}

function getOrder(orderId) {
    const cleanId = sanitizeOrderId(orderId);
    if (!cleanId) return null;
    const filePath = path.join(ORDERS_DIR, `${cleanId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        const order = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return checkOrderExpiration(order);
    } catch (e) {
        console.error(`[orderService] Error reading order ${cleanId}:`, e.message);
        return null;
    }
}

function listOrders() {
    if (!fs.existsSync(ORDERS_DIR)) return [];
    const files = fs.readdirSync(ORDERS_DIR).filter(f => f.endsWith('.json'));
    const list = [];
    for (const f of files) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), 'utf-8'));
            list.push(checkOrderExpiration(parsed));
        } catch {}
    }
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function createOrder(data) {
    const validation = validateOrderParams(data);
    if (!validation.isValid) {
        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
    }

    const { sanitized } = validation;
    const pricing = calculateOrderCost(sanitized.targetClicks, sanitized.durationHours);
    const bankInfo = getPublicBankInfo();
    const orderId = `ORD-${Date.now()}-${require('crypto').randomBytes(8).toString('hex')}`; // unguessable: it is the customer's access token
    const orderCode = generateOrderCode();
    const vietQrUrl = generateVietQrUrl(bankInfo, pricing.totalAmount, orderCode);

    const now = Date.now();
    const order = {
        orderId,
        orderCode,
        name: sanitized.name,
        targetUrl: sanitized.targetUrl,
        proxyKey: sanitized.proxyKey,
        targetClicks: sanitized.targetClicks,
        durationHours: sanitized.durationHours,
        roundedHours: pricing.roundedHours,
        clickFee: pricing.clickFee,
        durationFee: pricing.durationFee,
        totalAmount: pricing.totalAmount,
        currency: 'VND',
        browserMode: 'request',
        scheduleMode: sanitized.scheduleMode || 'smart',
        customBlocks: sanitized.customBlocks || null,
        scheduleType: sanitized.scheduleType || 'duration',
        runDate: sanitized.runDate || null,
        endRunDate: sanitized.endRunDate || null,
        startTime: sanitized.startTime || null,
        endTime: sanitized.endTime || null,
        overnight: Boolean(sanitized.overnight),
        timezone: sanitized.timezone || 'Asia/Ho_Chi_Minh',
        scheduledStartAt: sanitized.scheduledStartAt || null,
        scheduledEndAt: sanitized.scheduledEndAt || null,
        dedupIp: sanitized.dedupIp !== false,
        randomLinks: sanitized.randomLinks !== false,
        dwellPreset: sanitized.dwellPreset || 'short',
        deviceProfile: sanitized.deviceProfile || 'mixed',
        vietQrUrl,
        bankInfo,
        status: 'pending_payment',
        paymentStatus: 'pending_payment',
        campaignId: null,
        createdAt: now,
        expiresAt: now + ORDER_TTL_MS,
        paidAt: null,
        updatedAt: now
    };

    const filePath = path.join(ORDERS_DIR, `${orderId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');
    return order;
}

function confirmOrderPayment(orderId, extraFields = {}) {
    const order = getOrder(orderId);
    if (!order) {
        throw new Error(`Order not found: ${orderId}`);
    }
    if (order.status === 'expired') {
        const err = new Error(`Order has expired: ${orderId}`);
        err.code = 'ORDER_EXPIRED';
        err.statusCode = 409;
        throw err;
    }

    order.status = 'paid';
    order.paymentStatus = 'paid';
    order.paidAt = order.paidAt || Date.now();
    order.updatedAt = Date.now();
    if (extraFields.campaignId) {
        order.campaignId = extraFields.campaignId;
    }
    if (extraFields.paymentMethod) order.paymentMethod = extraFields.paymentMethod;
    if (extraFields.paidAmount) order.paidAmount = extraFields.paidAmount;

    const filePath = path.join(ORDERS_DIR, `${order.orderId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');
    return order;
}

function updateOrderStatus(orderId, status, extraFields = {}) {
    const order = getOrder(orderId);
    if (!order) {
        throw new Error(`Order not found: ${orderId}`);
    }

    const terminalStates = ['completed', 'expired', 'stopped'];
    if (terminalStates.includes(order.status) && status === 'pending_payment') {
        return order;
    }

    order.status = status;
    order.updatedAt = Date.now();
    Object.assign(order, extraFields);

    const filePath = path.join(ORDERS_DIR, `${order.orderId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(order, null, 4), 'utf-8');
    return order;
}

function deleteOrder(orderId) {
    const cleanId = sanitizeOrderId(orderId);
    if (!cleanId) return false;
    const filePath = path.join(ORDERS_DIR, `${cleanId}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
}

module.exports = {
    validateOrderParams,
    calculateOrderCost,
    generateOrderCode,
    generateVietQrUrl,
    createOrder,
    getOrder,
    confirmOrderPayment,
    updateOrderStatus,
    deleteOrder,
    getPaymentConfig,
    getPublicBankInfo,
    setPaymentConfig,
    maskProxyKey,
    listOrders,
    expireStaleOrders,
    checkOrderExpiration,
    isPrivateTargetAllowed,
    isLexicallyPrivateHost,
    resolveDwellBounds,
    DWELL_PRESET_BOUNDS,
    ORDER_TTL_MS,
    CONSTANTS: {
        CLICK_RATE,
        HOURLY_RATE,
        DEFAULT_TEMPLATE
    }
};
