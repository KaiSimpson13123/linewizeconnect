/**
 * Linewize Connect - High-Performance Web & Reverse Proxy Server
 * 
 * Solves all CORS (Cross-Origin Resource Sharing) restrictions:
 *  1. Serves the web interface (`live_screen_view.html`, `live_screen_view.js`, assets).
 *  2. Transparently proxies Configuration Gateway requests to bypass CORS.
 *  3. Streams Server-Sent Events (SSE) from Linewize Event Service directly to the browser
 *     with appropriate SSE and CORS headers (`Content-Type: text/event-stream`, `Access-Control-Allow-Origin: *`).
 *  4. Zero external runtime dependencies required (uses Node.js built-in modules).
 */

const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

// Configuration
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// ANSI Color helper for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m'
};

function log(level, message, detail = '') {
  const timestamp = new Date().toTimeString().split(' ')[0];
  let prefix = `[${timestamp}]`;
  let levelStr = `[${level}]`;

  switch (level.toLowerCase()) {
    case 'info':
      levelStr = `${colors.cyan}[INFO]${colors.reset}`;
      break;
    case 'proxy':
      levelStr = `${colors.magenta}[PROXY]${colors.reset}`;
      break;
    case 'sse':
      levelStr = `${colors.yellow}[SSE]${colors.reset}`;
      break;
    case 'success':
      levelStr = `${colors.green}[SUCCESS]${colors.reset}`;
      break;
    case 'error':
      levelStr = `${colors.red}[ERROR]${colors.reset}`;
      break;
  }

  console.log(`${colors.dim}${prefix}${colors.reset} ${levelStr} ${message} ${detail ? colors.dim + JSON.stringify(detail) + colors.reset : ''}`);
}

/**
 * Attaches standard CORS headers to any HTTP response
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Actor-Id, baggage, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Handles HTTP OPTIONS preflight requests
 */
function handlePreflight(req, res) {
  setCorsHeaders(res);
  res.writeHead(204);
  res.end();
}

/**
 * Serves static files safely from ROOT_DIR
 */
function serveStaticFile(req, res, pathname) {
  // Normalize path
  let safePath = pathname === '/' || pathname === '' ? '/index.html' : pathname;

  // Prevent directory traversal
  let filePath = path.join(ROOT_DIR, path.normalize(safePath).replace(/^(\.\.[\/\\])+/, ''));

  if (!fs.existsSync(filePath)) {
    const publicPath = path.join(ROOT_DIR, 'public', path.normalize(safePath).replace(/^(\.\.[\/\\])+/, ''));
    if (fs.existsSync(publicPath)) {
      filePath = publicPath;
    }
  }

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (!path.extname(filePath)) {
        return serveStaticFile(req, res, pathname + '.html');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    setCorsHeaders(res);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Cache-Control', 'no-cache'); // Don't cache during active development

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

/**
 * General API Proxy: Fetches target URL server-side and relays response with CORS headers
 */
function handleApiProxy(req, res, targetUrlStr) {
  setCorsHeaders(res);

  if (!targetUrlStr) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing target "url" query parameter' }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URL format', details: err.message }));
    return;
  }

  // Only allow HTTP/HTTPS
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Only http and https protocols are supported' }));
    return;
  }

  log('proxy', `${req.method} -> ${targetUrl.href}`);

  // Prepare outgoing headers
  const outgoingHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    // Exclude host/origin/referer so upstream sees correct destination
    if (!['host', 'origin', 'referer', 'connection', 'content-length'].includes(lowerKey)) {
      outgoingHeaders[key] = value;
    }
  }

  outgoingHeaders['host'] = targetUrl.host;
  if (!outgoingHeaders['user-agent']) {
    outgoingHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  }

  const client = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = client.request(targetUrl, {
    method: req.method,
    headers: outgoingHeaders,
    timeout: 20000
  }, (proxyRes) => {
    // Collect headers from upstream, attach CORS
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['access-control-allow-origin'] = '*';
    responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    responseHeaders['access-control-allow-headers'] = '*';
    responseHeaders['access-control-expose-headers'] = '*';

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      log('proxy', `${req.method} ${targetUrl.pathname} -> HTTP ${proxyRes.statusCode}`);
    });
  });

  proxyReq.on('error', (err) => {
    log('error', `Proxy error requesting ${targetUrl.href}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy Gateway Error', message: err.message }));
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    log('error', `Proxy timeout requesting ${targetUrl.href}`);
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway Timeout' }));
    }
  });

  // Forward incoming body if any (POST/PUT)
  req.pipe(proxyReq);
}

/**
 * Dedicated SSE (Server-Sent Events) Stream Proxy
 * Connects upstream to Linewize Event Service and pipes events to the browser with CORS
 */
function handleSseProxy(req, res, targetUrlStr) {
  setCorsHeaders(res);

  if (!targetUrlStr) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing target "url" query parameter for SSE' }));
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid SSE URL format', details: err.message }));
    return;
  }

  log('sse', `Initializing SSE proxy stream -> ${targetUrl.href}`);

  const outgoingHeaders = {
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Host': targetUrl.host,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  };

  const client = targetUrl.protocol === 'https:' ? https : http;

  let clientClosed = false;

  const upstreamReq = client.request(targetUrl, {
    method: 'GET',
    headers: outgoingHeaders
  }, (upstreamRes) => {
    log('sse', `Connected to upstream Event Service (HTTP ${upstreamRes.statusCode})`);

    // Write SSE headers to client browser
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no'
    });

    // Send an initial SSE comment to confirm connection to client
    res.write(`: sse-proxy-connected timestamp=${Date.now()}\n\n`);

    // Pipe upstream data directly to client response
    upstreamRes.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.includes('INIT_P2P')) {
        log('sse', `${colors.green}>>> Intercepted INIT_P2P Event! Forwarding to browser... <<<${colors.reset}`);
      } else if (text.includes('HEARTBEAT')) {
        log('sse', `Heartbeat ping forwarded.`);
      }
      res.write(chunk);
    });

    upstreamRes.on('end', () => {
      log('sse', 'Upstream SSE stream ended.');
      res.end();
    });

    upstreamRes.on('error', (err) => {
      if (!clientClosed) {
        log('error', `Upstream SSE stream error: ${err.message}`);
      }
      res.end();
    });
  });

  upstreamReq.on('error', (err) => {
    if (!clientClosed) {
      log('error', `Failed to connect upstream SSE: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to connect to Linewize Event Service', message: err.message }));
      }
    }
  });

  // When client browser closes the tab or disconnects, cleanly destroy upstream connection
  req.on('close', () => {
    clientClosed = true;
    log('sse', 'Client browser closed SSE connection. Cleaned up upstream stream.');
    upstreamReq.destroy();
  });
}

/**
 * Direct Shortcut Gateway Proxy: /api/gateway/:region/*
 */
function handleGatewayProxy(req, res, pathname, queryParams) {
  // Path format: /api/gateway/:region/get/configuration/...
  const parts = pathname.replace(/^\/api\/gateway\/?/, '').split('/');
  const region = parts[0];
  const restPath = parts.slice(1).join('/');

  if (!region) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing region in /api/gateway/:region/...' }));
    return;
  }

  const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
  const targetUrlStr = `https://configuration-gw.${region}.linewize.net/${restPath}${queryString}`;

  handleApiProxy(req, res, targetUrlStr);
}

/**
 * Main HTTP Server Request Handler
 */
const server = http.createServer((req, res) => {
  // Always handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return handlePreflight(req, res);
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;

  // 1. Health / Status check
  if (pathname === '/api/status' || pathname === '/api/health') {
    setCorsHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'online',
      service: 'Linewize Connect Web & Proxy Server',
      version: '1.0.0',
      uptime: Math.round(process.uptime()),
      proxyEnabled: true,
      routes: {
        webApp: '/',
        apiProxy: '/api/proxy?url=<target>',
        sseProxy: '/api/sse?url=<target>',
        gatewayProxy: '/api/gateway/:region/*'
      }
    }, null, 2));
  }

  // 2. SSE Proxy
  if (pathname === '/api/sse' || pathname === '/api/events') {
    const targetUrl = searchParams.get('url');
    return handleSseProxy(req, res, targetUrl);
  }

  // 3. Gateway shortcut proxy
  if (pathname.startsWith('/api/gateway/')) {
    return handleGatewayProxy(req, res, pathname, searchParams);
  }

  // 4. General API Proxy
  if (pathname === '/api/proxy') {
    const targetUrl = searchParams.get('url');
    return handleApiProxy(req, res, targetUrl);
  }

  // 5. Static Files (Web Interface)
  return serveStaticFile(req, res, pathname);
});

/**
 * Start Server with Port Fallback
 */
function startServer(port = DEFAULT_PORT) {
  server.listen(port, HOST, () => {
    const hostLabel = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`
${colors.cyan}╔══════════════════════════════════════════════════════════════════╗${colors.reset}
${colors.cyan}║${colors.reset}       ${colors.bright}Linewize Connect - Web Interface & CORS Proxy Server${colors.reset}       ${colors.cyan}║${colors.reset}
${colors.cyan}╚══════════════════════════════════════════════════════════════════╝${colors.reset}

  ${colors.green}● Web Interface:${colors.reset}       http://${hostLabel}:${port}/
  ${colors.green}● Gateway Proxy:${colors.reset}       http://${hostLabel}:${port}/api/gateway/:region/*
  ${colors.green}● General API Proxy:${colors.reset}   http://${hostLabel}:${port}/api/proxy?url=...
  ${colors.green}● SSE Stream Proxy:${colors.reset}    http://${hostLabel}:${port}/api/sse?url=...
  ${colors.green}● Health Status:${colors.reset}       http://${hostLabel}:${port}/api/status

  ${colors.yellow}★ CORS errors are fully resolved through this proxy.${colors.reset}
  ${colors.dim}Press Ctrl+C to stop the server.${colors.reset}
`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('error', `Port ${port} is currently in use. Attempting next port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

// Parse command line arguments
let chosenPort = DEFAULT_PORT;
const portArgIdx = process.argv.indexOf('--port');
if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
  chosenPort = parseInt(process.argv[portArgIdx + 1], 10) || DEFAULT_PORT;
}

startServer(chosenPort);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${colors.yellow}Shutting down Linewize Connect Web Server...${colors.reset}`);
  server.close(() => {
    console.log(`${colors.green}Server stopped cleanly.${colors.reset}`);
    process.exit(0);
  });
});
