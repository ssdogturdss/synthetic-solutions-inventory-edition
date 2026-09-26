/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_ROOT = path.resolve(__dirname, '..', 'static-build');
const WEB_ROOT = path.join(STATIC_ROOT, 'web');
const TEMPLATE_PATH = path.resolve(__dirname, 'templates', 'landing-page.html');
const basePath = (process.env.BASE_PATH || '/').replace(/\/+$/, '');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, '..', 'app.json');
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf-8'));
    return appJson.expo?.name || 'App Landing Page';
  } catch {
    return 'App Landing Page';
  }
}

function serveManifest(platform, res) {
  if (platform !== 'ios' && platform !== 'android') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unsupported platform' }));
    return;
  }

  const manifestPath = path.join(STATIC_ROOT, platform, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  const manifest = fs.readFileSync(manifestPath, 'utf-8');
  res.writeHead(200, {
    'content-type': 'application/json',
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
  });
  res.end(manifest);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'];
  const rawHost =
    typeof hostHeader === 'string' ? hostHeader.split(',')[0].trim() : '';
  let host;
  try {
    const parsedHost = new URL(`https://${rawHost}`);
    if (
      !rawHost ||
      parsedHost.username ||
      parsedHost.password ||
      parsedHost.pathname !== '/' ||
      parsedHost.search ||
      parsedHost.hash
    ) {
      throw new Error('Invalid host header');
    }
    host = parsedHost.host;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Invalid host');
    return;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedProtocol =
    typeof forwardedProto === 'string'
      ? forwardedProto.split(',')[0].trim().toLowerCase()
      : '';
  const protocol = forwardedProtocol === 'http' ? 'http' : 'https';
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  const escapedAppName = appName.replace(/[&<>"']/g, (character) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, escapedAppName);

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveFileFrom(root, urlPath, res) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return true;
  }
  if (decodedPath.includes('\0')) {
    res.writeHead(400);
    res.end('Bad Request');
    return true;
  }

  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const filePath = path.resolve(canonicalRoot, `.${path.sep}${decodedPath}`);
  const relativePath = path.relative(canonicalRoot, filePath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const canonicalFilePath = fs.realpathSync(filePath);
  const canonicalRelativePath = path.relative(canonicalRoot, canonicalFilePath);
  if (
    canonicalRelativePath === '..' ||
    canonicalRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelativePath)
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  const ext = path.extname(canonicalFilePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(canonicalFilePath);
  res.writeHead(200, {
    'content-type': contentType,
    ...(path.basename(canonicalFilePath) === 'push-service-worker.js'
      ? { 'service-worker-allowed': '/' }
      : {}),
  });
  res.end(content);
  return true;
}

function serveIndexPage(res) {
  const indexPath = path.join(WEB_ROOT, 'index.html');
  if (!fs.existsSync(indexPath)) return false;

  let html = fs.readFileSync(indexPath, 'utf-8');
  if (!html.includes('rel="manifest"')) {
    const pwaHeadTags = [
      `<meta name="theme-color" content="#eef2ff" />`,
      `<meta name="apple-mobile-web-app-capable" content="yes" />`,
      `<meta name="apple-mobile-web-app-status-bar-style" content="default" />`,
      `<meta name="apple-mobile-web-app-title" content="Red Carpet" />`,
      `<link rel="manifest" href="${basePath}/manifest.webmanifest" />`,
      `<link rel="apple-touch-icon" href="${basePath}/apple-touch-icon.png" />`,
    ].join('\n    ');
    const updatedHtml = html.replace('</head>', `    ${pwaHeadTags}\n  </head>`);
    if (updatedHtml === html) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The exported web app is missing a closing head tag.');
      return true;
    }
    html = updatedHtml;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}

function serveWebApp(urlPath, req, res) {
  if (urlPath === '/' || urlPath === '/index.html') {
    if (serveIndexPage(res)) return true;
  }
  if (serveFileFrom(WEB_ROOT, urlPath, res)) return true;
  if (
    typeof req.headers.accept === 'string' &&
    req.headers.accept.includes('text/html') &&
    serveIndexPage(res)
  ) {
    return true;
  }
  return false;
}

function serveStaticFile(urlPath, res) {
  if (!serveFileFrom(STATIC_ROOT, urlPath, res)) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
const appName = getAppName();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || '/';
  }

  if (pathname === '/' || pathname === '/manifest') {
    const platform = req.headers['expo-platform'];
    if (platform === 'ios' || platform === 'android') {
      return serveManifest(platform, res);
    }

    if (pathname === '/') {
      if (serveWebApp(pathname, req, res)) return;
      return serveLandingPage(req, res, landingPageTemplate, appName);
    }
  }

  if (serveWebApp(pathname, req, res)) return;
  serveStaticFile(pathname, res);
});

const port = parseInt(process.env.PORT || '3000', 10);
server.listen(port, '0.0.0.0', () => {
  console.log(`Serving static Expo build on port ${port}`);
});
