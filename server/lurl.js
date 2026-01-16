/**
 * Lurl 影片存檔 API v2
 * 上傳到 cloudpipe 即可使用
 *
 * Phase 1 - 資料收集：
 *   POST /lurl/capture - 接收影片資料並備份
 *   GET  /lurl/health  - 健康檢查
 *
 * Phase 2 - 管理面板：
 *   GET  /lurl/admin       - 管理頁面
 *   GET  /lurl/api/records - 取得所有記錄
 *   GET  /lurl/api/stats   - 統計資料
 *
 * Phase 3 - 內容展示：
 *   GET  /lurl/browse              - 瀏覽頁面
 *   GET  /lurl/files/videos/:name  - 提供影片
 *   GET  /lurl/files/images/:name  - 提供圖片
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// 資料存放位置
const DATA_DIR = path.join(__dirname, '..', 'data', 'lurl');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

// ==================== 工具函數 ====================

function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, IMAGES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

async function downloadFile(url, destPath, referer = '') {
  try {
    // 偽裝成瀏覽器請求
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'identity', // 不要壓縮，直接拿原始檔
    };

    // 有些網站會檢查 Referer
    if (referer) {
      headers['Referer'] = referer;
    } else {
      // 嘗試從 URL 推測 referer
      try {
        const urlObj = new URL(url);
        headers['Referer'] = urlObj.origin + '/';
      } catch {}
    }

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const fileStream = fs.createWriteStream(destPath);
    await pipeline(response.body, fileStream);
    return true;
  } catch (err) {
    console.error(`[lurl] 下載失敗: ${url}`, err.message);
    return false;
  }
}

function appendRecord(record) {
  ensureDirs();
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n', 'utf8');
}

function readAllRecords() {
  ensureDirs();
  if (!fs.existsSync(RECORDS_FILE)) return [];
  const content = fs.readFileSync(RECORDS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx));
  return Object.fromEntries(params);
}

function corsHeaders(contentType = 'application/json') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': contentType
  };
}

// ==================== HTML 頁面 ====================

function adminPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { margin-bottom: 20px; color: #333; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 2em; color: #2196F3; }
    .stat-card p { color: #666; margin-top: 5px; }
    .records { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .record { display: flex; align-items: center; padding: 15px; border-bottom: 1px solid #eee; gap: 15px; }
    .record:hover { background: #f9f9f9; }
    .record-type { width: 60px; height: 60px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .record-type.video { background: #e3f2fd; }
    .record-type.image { background: #f3e5f5; }
    .record-info { flex: 1; min-width: 0; }
    .record-title { font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .record-meta { font-size: 0.85em; color: #999; margin-top: 4px; }
    .record-actions a { color: #2196F3; text-decoration: none; margin-left: 10px; }
    .empty { padding: 40px; text-align: center; color: #999; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .tab.active { background: #2196F3; color: white; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Lurl 管理面板</h1>
    <div class="stats" id="stats"></div>
    <div class="tabs">
      <button class="tab active" data-type="all">全部</button>
      <button class="tab" data-type="video">影片</button>
      <button class="tab" data-type="image">圖片</button>
    </div>
    <div class="records" id="records"></div>
  </div>
  <script>
    let allRecords = [];
    let currentType = 'all';

    async function loadStats() {
      const res = await fetch('/lurl/api/stats');
      const data = await res.json();
      document.getElementById('stats').innerHTML = \`
        <div class="stat-card"><h3>\${data.total}</h3><p>總記錄</p></div>
        <div class="stat-card"><h3>\${data.videos}</h3><p>影片</p></div>
        <div class="stat-card"><h3>\${data.images}</h3><p>圖片</p></div>
      \`;
    }

    async function loadRecords() {
      const res = await fetch('/lurl/api/records');
      const data = await res.json();
      allRecords = data.records;
      renderRecords();
    }

    function renderRecords() {
      const filtered = currentType === 'all' ? allRecords : allRecords.filter(r => r.type === currentType);
      if (filtered.length === 0) {
        document.getElementById('records').innerHTML = '<div class="empty">尚無記錄</div>';
        return;
      }
      const getTitle = (t) => (!t || t === 'untitle' || t === 'undefined') ? '未命名' : t;
      document.getElementById('records').innerHTML = filtered.map(r => \`
        <div class="record">
          <div class="record-type \${r.type}">\${r.type === 'video' ? '🎬' : '🖼️'}</div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            <a href="/lurl/files/\${r.backupPath}" target="_blank">查看</a>
            <a href="\${r.pageUrl}" target="_blank">原始</a>
          </div>
        </div>
      \`).join('');
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        renderRecords();
      });
    });

    loadStats();
    loadRecords();
  </script>
</body>
</html>`;
}

function browsePage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl 影片庫</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { padding: 20px; background: #1a1a1a; }
    .header h1 { font-size: 1.5em; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .card { background: #1a1a1a; border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform 0.2s; }
    .card:hover { transform: scale(1.02); }
    .card-thumb { aspect-ratio: 16/9; background: #333; display: flex; align-items: center; justify-content: center; font-size: 48px; }
    .card-thumb video, .card-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .card-info { padding: 12px; }
    .card-title { font-size: 0.95em; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card-meta { font-size: 0.8em; color: #aaa; margin-top: 8px; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 8px 16px; background: #333; border: none; border-radius: 20px; color: white; cursor: pointer; }
    .tab.active { background: #fff; color: #000; }
    .empty { text-align: center; padding: 60px; color: #666; }
  </style>
</head>
<body>
  <div class="header"><h1>Lurl 影片庫</h1></div>
  <div class="container">
    <div class="tabs">
      <button class="tab active" data-type="all">全部</button>
      <button class="tab" data-type="video">影片</button>
      <button class="tab" data-type="image">圖片</button>
    </div>
    <div class="grid" id="grid"></div>
  </div>
  <script>
    let allRecords = [];
    let currentType = 'all';

    async function loadRecords() {
      const res = await fetch('/lurl/api/records');
      const data = await res.json();
      allRecords = data.records;
      renderGrid();
    }

    function renderGrid() {
      const filtered = currentType === 'all' ? allRecords : allRecords.filter(r => r.type === currentType);
      if (filtered.length === 0) {
        document.getElementById('grid').innerHTML = '<div class="empty">尚無內容</div>';
        return;
      }
      const getTitle = (t) => (!t || t === 'untitle' || t === 'undefined') ? '未命名' : t;
      document.getElementById('grid').innerHTML = filtered.map(r => \`
        <div class="card" onclick="window.open('/lurl/files/\${r.backupPath}', '_blank')">
          <div class="card-thumb">
            \${r.type === 'image'
              ? \`<img src="/lurl/files/\${r.backupPath}" alt="\${getTitle(r.title)}" onerror="this.outerHTML='🖼️'">\`
              : '🎬'}
          </div>
          <div class="card-info">
            <div class="card-title">\${getTitle(r.title)}</div>
            <div class="card-meta">\${new Date(r.capturedAt).toLocaleDateString()}</div>
          </div>
        </div>
      \`).join('');
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        renderGrid();
      });
    });

    loadRecords();
  </script>
</body>
</html>`;
}

// ==================== 主處理器 ====================

module.exports = {
  match(req) {
    return req.url.startsWith('/lurl');
  },

  async handle(req, res) {
    const fullPath = req.url.split('?')[0];
    const urlPath = fullPath.replace(/^\/lurl/, '') || '/';
    const query = parseQuery(req.url);

    console.log(`[lurl] ${req.method} ${urlPath}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // ==================== Phase 1 ====================

    // GET /health
    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // POST /capture
    if (req.method === 'POST' && urlPath === '/capture') {
      try {
        const { title, pageUrl, fileUrl, type = 'video' } = await parseBody(req);

        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        ensureDirs();
        const ext = type === 'video' ? '.mp4' : '.jpg';
        const safeTitle = sanitizeFilename(title);
        const filename = `${safeTitle}${ext}`;
        const targetDir = type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const backupPath = path.join(type === 'video' ? 'videos' : 'images', filename);

        const record = {
          id: Date.now().toString(36),
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath
        };

        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 用 pageUrl 當 referer，更真實
        downloadFile(fileUrl, path.join(targetDir, filename), pageUrl).then(ok => {
          console.log(`[lurl] 備份${ok ? '完成' : '失敗'}: ${filename}`);
        });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[lurl] Error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ==================== Phase 2 ====================

    // GET /admin
    if (req.method === 'GET' && urlPath === '/admin') {
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(adminPage());
      return;
    }

    // GET /api/records
    if (req.method === 'GET' && urlPath === '/api/records') {
      const records = readAllRecords().reverse(); // 最新的在前
      const type = query.type;
      const filtered = type && type !== 'all' ? records.filter(r => r.type === type) : records;

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ records: filtered, total: filtered.length }));
      return;
    }

    // GET /api/stats
    if (req.method === 'GET' && urlPath === '/api/stats') {
      const records = readAllRecords();
      const videos = records.filter(r => r.type === 'video').length;
      const images = records.filter(r => r.type === 'image').length;

      // 人氣排行（同一 pageUrl 出現次數）
      const urlCounts = {};
      records.forEach(r => {
        urlCounts[r.pageUrl] = (urlCounts[r.pageUrl] || 0) + 1;
      });
      const topUrls = Object.entries(urlCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pageUrl, count]) => ({ pageUrl, count }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ total: records.length, videos, images, topUrls }));
      return;
    }

    // ==================== Phase 3 ====================

    // GET /browse
    if (req.method === 'GET' && urlPath === '/browse') {
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(browsePage());
      return;
    }

    // GET /files/videos/:filename 或 /files/images/:filename
    if (req.method === 'GET' && urlPath.startsWith('/files/')) {
      const filePath = urlPath.replace('/files/', '');
      const fullFilePath = path.join(DATA_DIR, filePath);

      if (!fs.existsSync(fullFilePath)) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      const ext = path.extname(fullFilePath).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const stat = fs.statSync(fullFilePath);
      const fileSize = stat.size;

      // 支援 Range 請求（影片串流必需）
      const range = req.headers.range;
      if (range && contentType.startsWith('video/')) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(fullFilePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(fullFilePath).pipe(res);
      }
      return;
    }

    // 404
    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
