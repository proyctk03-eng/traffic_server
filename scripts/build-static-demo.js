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
        .replace('<script src="/js/timeDistribution.js"></script>', '<script src="./js/timeDistribution.js"></script>')
        .replace('<script src="/js/boost.js"></script>', '<script src="./js/boost.js"></script>');
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
    const distJsPath = path.join(publicDir, 'js', 'timeDistribution.js');
    const boostJsPath = path.join(publicDir, 'js', 'boost.js');

    if (!fs.existsSync(boostHtmlPath)) {
        throw new Error(`Missing source HTML: ${boostHtmlPath}`);
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(jsOutDir, { recursive: true });

    const rawHtml = fs.readFileSync(boostHtmlPath, 'utf-8');
    const staticHtml = transformHtmlForStaticHosting(rawHtml);

    fs.writeFileSync(path.join(outDir, 'index.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, 'boost.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, '404.html'), staticHtml, 'utf-8');
    fs.writeFileSync(path.join(outDir, '.nojekyll'), '', 'utf-8');

    fs.copyFileSync(distJsPath, path.join(jsOutDir, 'timeDistribution.js'));
    fs.copyFileSync(boostJsPath, path.join(jsOutDir, 'boost.js'));

    return {
        outDir,
        files: ['index.html', 'boost.html', '404.html', '.nojekyll', 'js/timeDistribution.js', 'js/boost.js']
    };
}

if (require.main === module) {
    const result = buildStaticDemo();
    console.log(`[build-static-demo] Built ${result.files.length} static demo files in ${result.outDir}`);
}

module.exports = { buildStaticDemo, transformHtmlForStaticHosting };
