/**
 * Lurl API 路由 - 轉發到本地 Lurl Server
 * 上傳到 cloudpipe 使用
 */

const http = require('http');

const TARGET_HOST = 'localhost';
const TARGET_PORT = 3000;

module.exports = {
  match(req) {
    return req.url.startsWith('/lurl');
  },

  handle(req, res) {
    const path = req.url.replace(/^\/lurl/, '') || '/';

    console.log(`[lurl] ${req.method} ${req.url} -> localhost:${TARGET_PORT}${path}`);

    const options = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${TARGET_HOST}:${TARGET_PORT}`
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        ...proxyRes.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[lurl] Error:', err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Lurl server not running', message: err.message }));
    });

    req.pipe(proxyReq);
  }
};
