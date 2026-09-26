/**
 * Vercel Serverless Function: /api/auth
 * Authentication endpoint to verify password and manage session token
 */

const { getSitePassword, getExpectedToken, verifyAuth } = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 1. Check Session State (GET /api/auth)
  if (req.method === 'GET') {
    const isAuthenticated = verifyAuth(req);
    return res.status(200).json({
      authenticated: isAuthenticated,
      hasCustomPassword: !!(process.env.SITE_PASSWORD || process.env.ADMIN_PASSWORD)
    });
  }

  // 2. Logout (DELETE or POST with logout action)
  if (req.method === 'DELETE' || req.query.logout === '1') {
    res.setHeader('Set-Cookie', 'lw_auth=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  }

  // 3. Login Attempt (POST /api/auth)
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    }

    const submittedPassword = body?.password || req.query.password;
    const actualPassword = getSitePassword();

    if (!submittedPassword) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (submittedPassword === actualPassword) {
      const token = getExpectedToken();
      // Set 7-day session cookie
      res.setHeader('Set-Cookie', `lw_auth=${token}; Path=/; Max-Age=604800; SameSite=Lax; HttpOnly`);
      return res.status(200).json({
        success: true,
        token: token,
        message: 'Authentication successful'
      });
    } else {
      return res.status(401).json({
        error: 'Invalid password. Please check your credentials.'
      });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
