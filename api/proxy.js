/**
 * Vercel Serverless Function: /api/proxy
 * Proxies HTTP requests to target URLs with full CORS headers
 */

const https = require('https');
const http = require('http');
const { verifyAuth } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Actor-Id, baggage, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Enforce Password Authentication
  if (!verifyAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized: Session or password token required' });
  }

  const targetUrlStr = req.query.url;
  if (!targetUrlStr) {
    return res.status(400).json({ error: 'Missing target "url" query parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format', details: err.message });
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https protocols are supported' });
  }

  // Sanitize headers
  const outgoingHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
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
    timeout: 25000
  }, (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    responseHeaders['access-control-allow-origin'] = '*';
    responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    responseHeaders['access-control-allow-headers'] = '*';

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Proxy Gateway Error', message: err.message });
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'Gateway Timeout' });
    }
  });

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
};
