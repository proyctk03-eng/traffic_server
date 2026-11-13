const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_GH_PAGES_URL = 'https://dtc245200452-hub.github.io/traffic_server/';

/**
 * Load simple KEY=VALUE lines from local .env without overriding already-set env vars.
 */
function loadDotEnv(envPath) {
    if (!envPath || !fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = val;
        }
    }
}

/**
 * Call Cloudflare API v4 using Bearer API Token.
 */
async function cloudflareApiRequest(endpoint, options = {}) {
    const token = String(options.token || process.env.CLOUDFLARE_API_TOKEN || '').trim();
    if (!token) {
        throw new Error('Missing CLOUDFLARE_API_TOKEN');
    }
    const method = (options.method || 'GET').toUpperCase();
    const url = `${CF_API_BASE}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
    const res = await axios.request({
        url,
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        data: options.data,
        timeout: options.timeoutMs || 10000,
        validateStatus: () => true
    });
    const body = res.data || {};
    if (res.status >= 400 || body.success === false) {
        const errText = Array.isArray(body.errors) && body.errors.length
            ? body.errors.map(e => `${e.code || res.status}: ${e.message}`).join('; ')
            : `HTTP ${res.status}`;
        const err = new Error(`Cloudflare API error (${endpoint}): ${errText}`);
        err.status = res.status;
        throw err;
    }
    return body.result;
}

/**
 * Verify Cloudflare API token, inspect accounts, Pages projects (*.pages.dev), and Tunnels.
 */
async function verifyCloudflareSetup(options = {}) {
    const token = String(options.token || process.env.CLOUDFLARE_API_TOKEN || '').trim();
    if (!token) {
        throw new Error('Thieu CLOUDFLARE_API_TOKEN. Tao Scoped API Token tai Cloudflare Dashboard -> My Profile -> API Tokens.');
    }

    const tokenInfo = await cloudflareApiRequest('/user/tokens/verify', { token });
    const accounts = await cloudflareApiRequest('/accounts', { token });
    const resolvedAccountId = String(
        options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || (accounts[0] && accounts[0].id) || ''
    ).trim();

    let pagesProjects = [];
    let pagesError = null;
    let tunnels = [];
    let tunnelError = null;

    if (resolvedAccountId) {
        try {
            const rawPages = await cloudflareApiRequest(`/accounts/${resolvedAccountId}/pages/projects`, { token });
            pagesProjects = Array.isArray(rawPages)
                ? rawPages.map(p => ({
                    name: p.name,
                    subdomain: p.subdomain,
                    url: p.subdomain ? `https://${p.subdomain}` : null
                }))
                : [];
        } catch (err) {
            pagesError = err.message;
        }

        try {
            const rawTunnels = await cloudflareApiRequest(`/accounts/${resolvedAccountId}/cfd_tunnel?is_deleted=false`, { token });
            tunnels = Array.isArray(rawTunnels)
                ? rawTunnels.map(t => ({ id: t.id, name: t.name, status: t.status }))
                : [];
        } catch (err) {
            tunnelError = err.message;
        }
    }

    return {
        tokenStatus: tokenInfo && tokenInfo.status ? tokenInfo.status : 'active',
        accounts: Array.isArray(accounts) ? accounts.map(a => ({ id: a.id, name: a.name })) : [],
        accountId: resolvedAccountId,
        pagesProjects,
        pagesError,
        tunnels,
        tunnelError
    };
}

function parseTryCloudflareUrl(text) {
    const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    return match ? match[0] : null;
}

function buildConnectUrls({ tunnelUrl, pagesUrl }) {
    const cleanTunnel = String(tunnelUrl || '').replace(/\/+$/, '');
    const cleanPages = String(pagesUrl || DEFAULT_GH_PAGES_URL).trim();
    const sep = cleanPages.includes('?') ? '&' : '?';
    return {
        directBoostUrl: `${cleanTunnel}/boost`,
        staticLinkedUrl: `${cleanPages}${sep}backend=${encodeURIComponent(cleanTunnel)}`
    };
}

function findCloudflaredBinary() {
    const check = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf-8' });
    return check.status === 0 ? 'cloudflared' : null;
}

function runQuickTunnel({ port = 3005, pagesUrl = DEFAULT_GH_PAGES_URL } = {}) {
    const bin = findCloudflaredBinary();
    if (!bin) {
        console.error('[cf-tunnel] Chua cai dat "cloudflared".');
        console.error('  Windows: winget install --id Cloudflare.cloudflared -e');
        console.error('  macOS:   brew install cloudflared');
        console.error('  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
        process.exitCode = 1;
        return null;
    }

    const target = `http://127.0.0.1:${port}`;
    console.log(`[cf-tunnel] Dang mo Cloudflare Quick Tunnel toi ${target} (mien phi, khong can domain)...`);
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', target], { stdio: ['ignore', 'pipe', 'pipe'] });

    let printed = false;
    const handleChunk = (chunk) => {
        const text = chunk.toString();
        process.stderr.write(text);
        if (!printed) {
            const url = parseTryCloudflareUrl(text);
            if (url) {
                printed = true;
                const links = buildConnectUrls({ tunnelUrl: url, pagesUrl });
                console.log('\n===============================================================');
                console.log(`Live /boost URL:      ${links.directBoostUrl}`);
                console.log(`Frontend Pages Link:  ${links.staticLinkedUrl}`);
                console.log('Nhan Ctrl+C de dong Tunnel khi test xong.');
                console.log('===============================================================\n');
            }
        }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('exit', (code) => {
        if (code && code !== 0) process.exitCode = code;
    });
    return child;
}

async function main() {
    loadDotEnv(path.join(__dirname, '..', '.env'));
    const [cmd, arg1, arg2] = process.argv.slice(2);

    if (cmd === 'verify') {
        const report = await verifyCloudflareSetup();
        console.log('Cloudflare Token Status:', report.tokenStatus);
        console.log('Accounts:', report.accounts);
        console.log('Resolved Account ID:', report.accountId || '(none)');
        if (report.pagesError) console.log('Pages Projects check:', report.pagesError);
        else console.log('Pages Projects:', report.pagesProjects);
        if (report.tunnelError) console.log('Tunnels check:', report.tunnelError);
        else console.log('Tunnels:', report.tunnels);
        return;
    }

    if (cmd === 'quick') {
        const port = Number(arg1 || process.env.PORT || 3005);
        const pagesUrl = arg2 || process.env.STATIC_DEMO_URL || DEFAULT_GH_PAGES_URL;
        runQuickTunnel({ port, pagesUrl });
        return;
    }

    console.log('Usage:');
    console.log('  node scripts/cf-tunnel.js quick [port] [pagesUrl]   # Mo Quick Tunnel (*.trycloudflare.com)');
    console.log('  node scripts/cf-tunnel.js verify                    # Kiem tra CLOUDFLARE_API_TOKEN & Pages/Tunnels');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[cf-tunnel] Error:', err.message);
        process.exit(1);
    });
}

module.exports = {
    CF_API_BASE,
    loadDotEnv,
    cloudflareApiRequest,
    verifyCloudflareSetup,
    parseTryCloudflareUrl,
    buildConnectUrls,
    runQuickTunnel
};
