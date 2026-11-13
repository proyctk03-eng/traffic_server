const fs = require('fs');
const path = require('path');

/**
 * Transform boost.html so it runs cleanly on static hosts (Cloudflare Pages, GitHub Pages)
 * at both root (/) and subpath (/repo-name/), without triggering 404 on /socket.io/.
 */
function transformHtmlForStaticHosting(html) {
    return String(html)
        .replace(
            '<script src="/socket.io/socket.io.js"></script>',
            '<script>window.__STATIC_DEMO_MODE__ = true;</script>'
        )
        .replace(
            /<script(\s+[^>]*)src=["']\/js\/([^"']+)["']([^>]*)><\/script>/gi,
            '<script$1src="./js/$2"$3></script>'
        );
}

/**
 * Extract local ./js/* script paths referenced by transformed static HTML.
 */
function collectReferencedStaticJs(staticHtml) {
    const found = [];
    const seen = new Set();
    const re = /<script\s+[^>]*src=["']\.\/js\/([^"'?#]+)["'][^>]*>\s*<\/script>/gi;
    let m;
    while ((m = re.exec(staticHtml)) !== null) {
        const rel = String(m[1] || '').trim().replace(/^\/+/, '');
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        found.push(rel);
    }
    if (found.length === 0) {
        return ['timeDistribution.js', 'boost-shared.js', 'boost-demo.js', 'boost-ui.js', 'boost.js'];
    }
    return found;
}

/**
 * Build standalone static demo bundle into dist-demo/ for Cloudflare Pages & GitHub Pages.
 */
function buildStaticDemo(options = {}) {
    const rootDir = options.rootDir || path.join(__dirname, '..');
    const publicDir = path.join(rootDir, 'public');
    const outDir = options.outDir || path.join(rootDir, 'dist-demo');
    const jsOutDir = path.join(outDir, 'js');

    const boostHtmlPath = path.join(publicDir, 'boost.html');

    if (!fs.existsSync(boostHtmlPath)) {
        throw new Error(`Missing source HTML: ${boostHtmlPath}`);
    }

    const rawHtml = fs.readFileSync(boostHtmlPath, 'utf-8');
    const staticHtml = transformHtmlForStaticHosting(rawHtml);
    const jsFiles = collectReferencedStaticJs(staticHtml);

    for (const rel of jsFiles) {
        const srcJsPath = path.join(publicDir, 'js', rel);
        if (!fs.existsSync(srcJsPath)) {
            throw new Error(`Missing referenced static JS asset: ${srcJsPath}`);
        }
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(jsOutDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'index.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'boost.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, '404.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf-8');

    const copiedRelFiles = [];
    for (const rel of jsFiles) {
        const srcJsPath = path.join(publicDir, 'js', rel);
        const destJsPath = path.join(jsOutDir, rel);
        fs.mkdirSync(path.dirname(destJsPath), { recursive: true });
        fs.copyFileSync(srcJsPath, destJsPath);
        copiedRelFiles.push(`js/${rel}`);
    }

    return {
        outDir,
        files: ['index.html', 'boost.html', '404.html', '.nojekyll', ...copiedRelFiles]
    };
}

if (require.main === module) {
    const result = buildStaticDemo();
    console.log(`[build-static-demo] Built ${result.files.length} static demo files in ${result.outDir}`);
}

module.exports = { buildStaticDemo, transformHtmlForStaticHosting };
