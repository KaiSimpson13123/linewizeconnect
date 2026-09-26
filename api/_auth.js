/**
 * Shared Authentication Utility for Vercel Serverless Functions
 */

const crypto = require('crypto');

function getSitePassword() {
  return process.env.SITE_PASSWORD || process.env.ADMIN_PASSWORD || 'admin';
}

function getExpectedToken() {
  const password = getSitePassword();
  return crypto.createHash('sha256').update(`linewize_salt_v1:${password}`).digest('hex');
}

function verifyAuth(req) {
  const expected = getExpectedToken();

  // 1. Check Cookie
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/lw_auth=([a-f0-9]+)/);
  if (match && match[1] === expected) {
    return true;
  }

  // 2. Check Authorization Header (Bearer token)
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === expected) {
    return true;
  }

  // 3. Check Query parameter (used by EventSource which cannot set custom headers)
  const queryToken = req.query && (req.query.token || req.query.auth);
  if (queryToken && queryToken === expected) {
    return true;
  }

  return false;
}

module.exports = {
  getSitePassword,
  getExpectedToken,
  verifyAuth
};
