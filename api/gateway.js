/**
 * Vercel Serverless Function: /api/gateway
 * Regional Gateway Proxy shortcut
 */

const proxyHandler = require('./proxy');

module.exports = async (req, res) => {
  const { region, ...otherParams } = req.query;

  if (!region) {
    return res.status(400).json({ error: 'Missing "region" query parameter (e.g. syd-1, syd-2, uk-1)' });
  }

  // Forward query string
  const queryStr = new URLSearchParams(otherParams).toString();
  const targetUrl = `https://configuration-gw.${region}.linewize.net/get/configuration/chrome-extension${queryStr ? '?' + queryStr : ''}`;

  req.query.url = targetUrl;
  return proxyHandler(req, res);
};
