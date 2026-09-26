/**
 * Vercel Serverless Function: /api/status
 * Health check and proxy diagnostic telemetry
 */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  res.status(200).json({
    status: 'online',
    service: 'Linewize Connect Proxy Server',
    environment: process.env.VERCEL ? 'vercel-serverless' : 'node-local',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    proxyEnabled: true
  });
};
