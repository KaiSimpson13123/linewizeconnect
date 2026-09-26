/**
 * Vercel Serverless Function: /api/sse
 * Dedicated Server-Sent Events (SSE) streaming proxy
 */

const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no'
    });

    res.write(`: sse-proxy-connected timestamp=${Date.now()}\n\n`);

    upstreamRes.on('data', (chunk) => {
      res.write(chunk);
    });

    upstreamRes.on('end', () => res.end());
    upstreamRes.on('error', () => res.end());
  });

  upstreamReq.on('error', (err) => {
    if (!clientClosed && !res.headersSent) {
      res.status(502).json({ error: 'Failed to connect upstream SSE', message: err.message });
    }
  });

  req.on('close', () => {
    clientClosed = true;
    upstreamReq.destroy();
  });
};
