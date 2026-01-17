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
    // 移除所有 emoji（更全面的範圍）
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, '')
    // 移除其他特殊符號
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf._-]/g, '')
    .replace(/_+/g, '_') // 多個底線合併
    .replace(/^_|_$/g, '') // 移除開頭結尾底線
    .substring(0, 200) || 'untitled';
}

async function downloadFile(url, destPath, pageUrl = '', cookies = '') {
  // 根據 CDN 來源決定 Referer
  // lurl CDN 需要 https://lurl.cc/ 當 referer
  // myppt CDN 需要 https://myppt.cc/ 當 referer
  let baseReferer = 'https://lurl.cc/';
  if (url.includes('myppt.cc')) {
    baseReferer = 'https://myppt.cc/';
  }

  // 策略清單：有 cookie 優先試 cookie
  const strategies = [];

  // 策略 1：用前端傳來的 cookies（最可能成功）
  if (cookies) {
    strategies.push({ referer: baseReferer, cookie: cookies, name: 'cookie+referer' });
  }

  // 策略 2：只用 referer（fallback）
  strategies.push({ referer: baseReferer, cookie: '', name: 'referer-only' });
  if (pageUrl) {
    strategies.push({ referer: pageUrl, cookie: '', name: 'pageUrl-referer' });
  }

  for (const strategy of strategies) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'Sec-CH-UA-Mobile': '?1',
        'Sec-CH-UA-Platform': '"Android"',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-site',
        'Range': 'bytes=0-',
      };

      if (strategy.referer) {
        headers['Referer'] = strategy.referer;
      }
      if (strategy.cookie) {
        headers['Cookie'] = strategy.cookie;
      }

      console.log(`[lurl] 嘗試下載 (策略: ${strategy.name})`);
      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.log(`[lurl] 策略失敗: HTTP ${response.status}`);
        continue;
      }

      const fileStream = fs.createWriteStream(destPath);
      await pipeline(response.body, fileStream);
      console.log(`[lurl] 下載成功 (策略: ${strategy.name})`);
      return true;
    } catch (err) {
      console.log(`[lurl] 策略錯誤: ${err.message}`);
    }
  }

  console.error(`[lurl] 下載失敗: ${url} (所有策略都失敗)`);
  return false;
}

function appendRecord(record) {
  ensureDirs();
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n', 'utf8');
}

function updateRecordFileUrl(id, newFileUrl) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, fileUrl: newFileUrl };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Record-Id, X-Chunk-Index, X-Total-Chunks',
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: white; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat-card h3 { font-size: 2em; color: #2196F3; }
    .stat-card p { color: #666; margin-top: 5px; }
    .records { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); overflow: hidden; }
    .record { display: flex; align-items: center; padding: 15px; border-bottom: 1px solid #eee; gap: 15px; }
    .record:hover { background: #f9f9f9; }
    .record-thumb { width: 80px; height: 60px; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 24px; background: #f0f0f0; flex-shrink: 0; }
    .record-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .record-thumb.video { background: #e3f2fd; }
    .record-info { flex: 1; min-width: 0; }
    .record-title { font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .record-meta { font-size: 0.85em; color: #999; margin-top: 4px; }
    .record-actions { display: flex; gap: 10px; align-items: center; }
    .record-actions a { color: #2196F3; text-decoration: none; }
    .record-actions .delete-btn { color: #e53935; cursor: pointer; border: none; background: none; font-size: 0.9em; }
    .record-actions .delete-btn:hover { text-decoration: underline; }
    .empty { padding: 40px; text-align: center; color: #999; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { padding: 10px 20px; background: white; border: none; border-radius: 8px; cursor: pointer; }
    .tab.active { background: #2196F3; color: white; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Lurl</h1>
    <nav>
      <a href="/lurl/admin" class="active">管理面板</a>
      <a href="/lurl/browse">影片庫</a>
      <a href="/lurl/health">API 狀態</a>
    </nav>
  </div>
  <div class="container">
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
        <div class="record" data-id="\${r.id}">
          <div class="record-thumb \${r.type}">
            \${r.type === 'image'
              ? \`<img src="/lurl/files/\${r.backupPath}" onerror="this.outerHTML='🖼️'">\`
              : (r.fileExists ? '🎬' : '⏳')}
          </div>
          <div class="record-info">
            <div class="record-title">\${getTitle(r.title)}\${r.fileExists ? '' : ' <span style="color:#e53935;font-size:0.8em">(未備份)</span>'}</div>
            <div class="record-meta">\${new Date(r.capturedAt).toLocaleString()}</div>
          </div>
          <div class="record-actions">
            \${r.fileExists ? \`<a href="/lurl/files/\${r.backupPath}" target="_blank">查看</a>\` : ''}
            <a href="/lurl/view/\${r.id}">詳情</a>
            <a href="\${r.pageUrl}" target="_blank">原始</a>
            <button class="delete-btn" onclick="deleteRecord('\${r.id}')">刪除</button>
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

    async function deleteRecord(id) {
      if (!confirm('確定要刪除這筆記錄？')) return;
      const res = await fetch('/lurl/api/records/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        loadStats();
        loadRecords();
      } else {
        alert('刪除失敗: ' + (data.error || '未知錯誤'));
      }
    }

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
  <title>Lurl Archive - Video Library</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>">
  <style>
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111111;
      --bg-card: #181818;
      --bg-hover: #252525;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --text-primary: #ffffff;
      --text-secondary: #aaaaaa;
      --text-muted: #666666;
      --border: #2a2a2a;
      --success: #22c55e;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-inner {
      max-width: 1600px;
      margin: 0 auto;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text-primary);
      font-weight: 700;
      font-size: 1.25em;
    }
    .logo-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }
    .search-container {
      flex: 1;
      max-width: 600px;
      position: relative;
    }
    .search-input {
      width: 100%;
      padding: 10px 16px 10px 42px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.95em;
      outline: none;
      transition: all 0.2s;
    }
    .search-input::placeholder { color: var(--text-muted); }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    .search-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 16px;
    }
    .header-nav {
      display: flex;
      gap: 8px;
    }
    .nav-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 0.9em;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
    }
    .nav-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* Stats Bar */
    .stats-bar {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
    }
    .stats-inner {
      max-width: 1600px;
      margin: 0 auto;
      display: flex;
      gap: 32px;
      flex-wrap: wrap;
    }
    .stat-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stat-value {
      font-size: 1.5em;
      font-weight: 700;
      color: var(--accent);
    }
    .stat-label { color: var(--text-muted); font-size: 0.85em; }

    /* Main Content */
    .main {
      max-width: 1600px;
      margin: 0 auto;
      padding: 24px;
    }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tabs { display: flex; gap: 8px; }
    .tab {
      padding: 8px 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .tab:hover { background: var(--bg-hover); color: var(--text-primary); }
    .tab.active {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .result-info {
      margin-left: auto;
      color: var(--text-muted);
      font-size: 0.9em;
    }

    /* Grid */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 24px;
    }

    /* Card */
    .card {
      background: var(--bg-card);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.3s ease;
      border: 1px solid transparent;
    }
    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      border-color: var(--border);
    }

    /* Thumbnail */
    .thumb {
      aspect-ratio: 16/9;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      position: relative;
      overflow: hidden;
    }
    .thumb.image-type { background: linear-gradient(135deg, #2d1f3d 0%, #1a1a2e 100%); }
    .thumb.pending { background: linear-gradient(135deg, #2d2a1a 0%, #1a1a1a 100%); }
    .thumb-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.2);
      opacity: 0;
      transition: opacity 0.3s;
    }
    .card:hover .thumb-overlay { opacity: 1; }
    .play-btn {
      width: 64px;
      height: 64px;
      background: rgba(255,255,255,0.95);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: scale(0.8);
      transition: transform 0.3s;
    }
    .card:hover .play-btn { transform: scale(1); }
    .play-btn::after {
      content: '';
      width: 0;
      height: 0;
      border-left: 22px solid #0a0a0a;
      border-top: 13px solid transparent;
      border-bottom: 13px solid transparent;
      margin-left: 4px;
    }
    .thumb-badge {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 500;
    }
    .thumb-pending {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-size: 0.9em;
    }

    /* Card Info */
    .card-body { padding: 16px; }
    .card-title {
      font-size: 1em;
      font-weight: 500;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 12px;
      color: var(--text-primary);
    }
    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-date {
      font-size: 0.8em;
      color: var(--text-muted);
    }
    .card-id {
      font-size: 0.75em;
      color: var(--accent);
      background: rgba(59,130,246,0.1);
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      font-family: monospace;
    }
    .card-id:hover { background: rgba(59,130,246,0.25); }
    .card-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 0.75em;
      color: var(--warning);
      margin-top: 8px;
    }

    /* Load More */
    .load-more-container {
      text-align: center;
      padding: 40px 0;
    }
    .load-more-btn {
      padding: 12px 32px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 0.95em;
      cursor: pointer;
      transition: all 0.2s;
    }
    .load-more-btn:hover { background: var(--bg-hover); border-color: var(--accent); }
    .load-more-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Empty State */
    .empty {
      text-align: center;
      padding: 80px 20px;
      color: var(--text-muted);
    }
    .empty-icon { font-size: 64px; margin-bottom: 16px; }
    .empty-text { font-size: 1.1em; }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    /* Responsive */
    @media (max-width: 768px) {
      .header-inner { padding: 12px 16px; gap: 12px; }
      .logo span { display: none; }
      .search-container { max-width: none; }
      .header-nav { display: none; }
      .stats-bar { padding: 12px 16px; }
      .stats-inner { gap: 16px; }
      .stat-value { font-size: 1.2em; }
      .main { padding: 16px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a href="/lurl" class="logo">
        <div class="logo-icon">▶</div>
        <span>Lurl Archive</span>
      </a>
      <div class="search-container">
        <span class="search-icon">🔍</span>
        <input type="text" class="search-input" id="search" placeholder="Search videos by title, ID, or URL..." autocomplete="off">
      </div>
      <nav class="header-nav">
        <a href="/lurl/admin" class="nav-btn">Admin</a>
      </nav>
    </div>
  </header>

  <div class="stats-bar">
    <div class="stats-inner">
      <div class="stat-item">
        <span class="stat-value" id="statTotal">-</span>
        <span class="stat-label">Total</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" id="statVideos">-</span>
        <span class="stat-label">Videos</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" id="statImages">-</span>
        <span class="stat-label">Images</span>
      </div>
      <div class="stat-item">
        <span class="stat-value" id="statBacked">-</span>
        <span class="stat-label">Backed Up</span>
      </div>
    </div>
  </div>

  <main class="main">
    <div class="filter-bar">
      <div class="tabs">
        <button class="tab active" data-type="all">All</button>
        <button class="tab" data-type="video">Videos</button>
        <button class="tab" data-type="image">Images</button>
      </div>
      <div class="result-info" id="resultInfo"></div>
    </div>

    <div class="grid" id="grid"></div>

    <div class="load-more-container" id="loadMoreContainer" style="display:none;">
      <button class="load-more-btn" id="loadMoreBtn">Load More</button>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    const PAGE_SIZE = 24;
    let allRecords = [];
    let currentType = 'all';
    let searchQuery = '';
    let displayCount = PAGE_SIZE;

    async function loadRecords() {
      const res = await fetch('/lurl/api/records');
      const data = await res.json();
      allRecords = data.records;
      updateStats();
      renderGrid();
    }

    function updateStats() {
      const videos = allRecords.filter(r => r.type === 'video').length;
      const images = allRecords.filter(r => r.type === 'image').length;
      const backed = allRecords.filter(r => r.fileExists).length;
      document.getElementById('statTotal').textContent = allRecords.length;
      document.getElementById('statVideos').textContent = videos;
      document.getElementById('statImages').textContent = images;
      document.getElementById('statBacked').textContent = backed;
    }

    function filterRecords() {
      let filtered = allRecords;
      if (currentType !== 'all') {
        filtered = filtered.filter(r => r.type === currentType);
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(r =>
          r.id.toLowerCase().includes(q) ||
          (r.title && r.title.toLowerCase().includes(q)) ||
          (r.pageUrl && r.pageUrl.toLowerCase().includes(q))
        );
      }
      return filtered;
    }

    function renderGrid() {
      const filtered = filterRecords();
      const toShow = filtered.slice(0, displayCount);
      const hasMore = filtered.length > displayCount;

      document.getElementById('resultInfo').textContent =
        'Showing ' + toShow.length + ' of ' + filtered.length;

      document.getElementById('loadMoreContainer').style.display = hasMore ? 'block' : 'none';

      if (filtered.length === 0) {
        document.getElementById('grid').innerHTML =
          '<div class="empty"><div class="empty-icon">' +
          (searchQuery ? '🔍' : '📭') + '</div><div class="empty-text">' +
          (searchQuery ? 'No results for "' + searchQuery + '"' : 'No content yet') + '</div></div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;
      const formatDate = (d) => {
        const date = new Date(d);
        const now = new Date();
        const diff = now - date;
        if (diff < 86400000) return 'Today';
        if (diff < 172800000) return 'Yesterday';
        return date.toLocaleDateString();
      };

      document.getElementById('grid').innerHTML = toShow.map(r => \`
        <article class="card" onclick="window.location.href='/lurl/view/\${r.id}'">
          <div class="thumb \${r.type === 'image' ? 'image-type' : ''} \${!r.fileExists ? 'pending' : ''}">
            \${r.fileExists ? \`
              <div class="thumb-overlay">
                <div class="play-btn"></div>
              </div>
              <span class="thumb-badge">\${r.type === 'video' ? 'VIDEO' : 'IMAGE'}</span>
            \` : \`
              <div class="thumb-pending">⏳ Backup Pending</div>
            \`}
          </div>
          <div class="card-body">
            <h3 class="card-title">\${getTitle(r.title)}</h3>
            <div class="card-footer">
              <span class="card-date">\${formatDate(r.capturedAt)}</span>
              <span class="card-id" onclick="event.stopPropagation();copyId('\${r.id}')" title="Click to copy">\${r.id}</span>
            </div>
            \${!r.fileExists ? '<div class="card-status">⏳ Waiting for backup</div>' : ''}
          </div>
        </article>
      \`).join('');
    }

    function copyId(id) {
      navigator.clipboard.writeText(id);
      showToast('Copied: ' + id);
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    function loadMore() {
      displayCount += PAGE_SIZE;
      renderGrid();
    }

    // Event listeners
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        displayCount = PAGE_SIZE;
        renderGrid();
      });
    });

    let searchTimeout;
    document.getElementById('search').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = e.target.value.trim();
        displayCount = PAGE_SIZE;
        renderGrid();
      }, 200);
    });

    document.getElementById('loadMoreBtn').addEventListener('click', loadMore);

    // URL param
    const urlParams = new URLSearchParams(window.location.search);
    const qParam = urlParams.get('q');
    if (qParam) {
      document.getElementById('search').value = qParam;
      searchQuery = qParam;
    }

    loadRecords();
  </script>
</body>
</html>`;
}

function viewPage(record, fileExists) {
  const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;
  const title = getTitle(record.title);
  const isVideo = record.type === 'video';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Lurl Archive</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>">
  <style>
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111111;
      --bg-card: #181818;
      --bg-hover: #252525;
      --accent: #3b82f6;
      --text-primary: #ffffff;
      --text-secondary: #aaaaaa;
      --text-muted: #666666;
      --border: #2a2a2a;
      --success: #22c55e;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }

    /* Header */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
    }
    .header-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text-primary);
      font-weight: 700;
      font-size: 1.1em;
    }
    .logo-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent) 0%, #8b5cf6 100%);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    .nav-link {
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 0.9em;
      padding: 8px 16px;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .nav-link:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* Main */
    .main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 0.9em;
      margin-bottom: 20px;
      transition: color 0.2s;
    }
    .back-link:hover { color: var(--text-primary); }

    /* Player */
    .player-container {
      background: #000;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .player-container video, .player-container img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .player-missing {
      text-align: center;
      color: var(--text-muted);
      padding: 40px;
    }
    .player-missing-icon { font-size: 48px; margin-bottom: 16px; }
    .player-missing-text { font-size: 1.1em; margin-bottom: 8px; }
    .player-missing-url {
      font-size: 0.8em;
      color: var(--text-muted);
      word-break: break-all;
      max-width: 500px;
      margin: 0 auto;
    }

    /* Content */
    .content {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 24px;
    }
    @media (max-width: 900px) {
      .content { grid-template-columns: 1fr; }
    }

    /* Info Panel */
    .info-panel {
      background: var(--bg-card);
      border-radius: 12px;
      padding: 24px;
      border: 1px solid var(--border);
    }
    .info-title {
      font-size: 1.4em;
      font-weight: 600;
      line-height: 1.4;
      margin-bottom: 16px;
    }
    .info-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.9em;
      color: var(--text-secondary);
    }
    .meta-icon { font-size: 1.1em; }

    .info-section {
      margin-bottom: 20px;
    }
    .info-label {
      font-size: 0.8em;
      color: var(--text-muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .info-value {
      font-size: 0.9em;
      color: var(--text-secondary);
      word-break: break-all;
    }
    .info-value a {
      color: var(--accent);
      text-decoration: none;
    }
    .info-value a:hover { text-decoration: underline; }

    .id-badge {
      display: inline-block;
      background: rgba(59,130,246,0.1);
      color: var(--accent);
      padding: 6px 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.95em;
      cursor: pointer;
      transition: all 0.2s;
    }
    .id-badge:hover { background: rgba(59,130,246,0.2); }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.85em;
    }
    .status-badge.success { background: rgba(34,197,94,0.1); color: var(--success); }
    .status-badge.warning { background: rgba(245,158,11,0.1); color: var(--warning); }

    /* Actions */
    .actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 0.95em;
      font-weight: 500;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover { background: #2563eb; }
    .btn-secondary {
      background: var(--bg-hover);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { border-color: var(--accent); }
    .btn-warning {
      background: var(--warning);
      color: #000;
    }
    .btn-warning:hover { background: #d97706; }

    .help-text {
      font-size: 0.8em;
      color: var(--text-muted);
      text-align: center;
      margin-top: 12px;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a href="/lurl/browse" class="logo">
        <div class="logo-icon">▶</div>
        <span>Lurl Archive</span>
      </a>
      <a href="/lurl/browse" class="nav-link">Browse</a>
    </div>
  </header>

  <main class="main">
    <a href="/lurl/browse" class="back-link">← Back to library</a>

    <div class="player-container">
      ${fileExists
        ? (isVideo
          ? `<video src="/lurl/files/${record.backupPath}" controls autoplay></video>`
          : `<img src="/lurl/files/${record.backupPath}" alt="${title}">`)
        : `<div class="player-missing">
            <div class="player-missing-icon">⏳</div>
            <div class="player-missing-text">Backup Pending</div>
            <div class="player-missing-url">${record.fileUrl}</div>
          </div>`
      }
    </div>

    <div class="content">
      <div class="info-panel">
        <h1 class="info-title">${title}</h1>

        <div class="info-meta">
          <div class="meta-item">
            <span class="meta-icon">${isVideo ? '🎬' : '🖼️'}</span>
            <span>${isVideo ? 'Video' : 'Image'}</span>
          </div>
          <div class="meta-item">
            <span class="meta-icon">📅</span>
            <span>${new Date(record.capturedAt).toLocaleDateString()}</span>
          </div>
          <div class="meta-item">
            <span class="meta-icon">🌐</span>
            <span>${record.source || 'lurl'}</span>
          </div>
        </div>

        <div class="info-section">
          <div class="info-label">Record ID</div>
          <span class="id-badge" onclick="copyId('${record.id}')" title="Click to copy">${record.id}</span>
        </div>

        <div class="info-section">
          <div class="info-label">Status</div>
          ${fileExists
            ? '<span class="status-badge success">✓ Backed up</span>'
            : '<span class="status-badge warning">⏳ Pending backup</span>'}
        </div>

        <div class="info-section">
          <div class="info-label">Original Page</div>
          <div class="info-value"><a href="${record.pageUrl}" target="_blank">${record.pageUrl}</a></div>
        </div>

        ${record.ref ? `
        <div class="info-section">
          <div class="info-label">Dcard Article</div>
          <div class="info-value"><a href="${record.ref}" target="_blank">${record.ref}</a></div>
        </div>
        ` : ''}

        <div class="info-section">
          <div class="info-label">CDN URL</div>
          <div class="info-value" style="color:var(--text-muted);font-size:0.8em;">${record.fileUrl}</div>
        </div>
      </div>

      <div class="actions-panel">
        <div class="actions">
          ${fileExists ? `<a href="/lurl/files/${record.backupPath}" download class="btn btn-primary">⬇️ Download</a>` : ''}
          ${record.ref ? `<a href="${record.ref}" target="_blank" class="btn btn-secondary">📖 View Dcard Post</a>` : ''}
          <a href="${record.pageUrl}" target="_blank" class="btn btn-secondary">🔗 Original Page</a>
          ${!fileExists ? `<a href="${record.pageUrl}" target="_blank" class="btn btn-warning">🔄 Retry Backup</a>` : ''}
        </div>
        ${!fileExists ? `<p class="help-text">Open the original page with Tampermonkey script installed to backup this file.</p>` : ''}
      </div>
    </div>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    function copyId(id) {
      navigator.clipboard.writeText(id);
      const toast = document.getElementById('toast');
      toast.textContent = 'Copied: ' + id;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  </script>
</body>
</html>`;
}

// ==================== Landing Page ====================

function landingPage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl Archive - Preserve lurl.cc Videos Forever</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>">
  <style>
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #111111;
      --bg-card: #181818;
      --bg-hover: #252525;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-light: rgba(59,130,246,0.1);
      --purple: #8b5cf6;
      --text-primary: #ffffff;
      --text-secondary: #aaaaaa;
      --text-muted: #666666;
      --border: #2a2a2a;
      --success: #22c55e;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.6;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Header */
    .header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: rgba(10,10,10,0.9);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      z-index: 100;
    }
    .header-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text-primary);
      font-weight: 700;
      font-size: 1.25em;
    }
    .logo-icon {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .nav { display: flex; gap: 8px; }
    .nav-link {
      padding: 8px 16px;
      color: var(--text-secondary);
      text-decoration: none;
      border-radius: 8px;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .nav-link:hover { color: var(--text-primary); background: var(--bg-hover); text-decoration: none; }
    .nav-btn {
      padding: 8px 20px;
      background: var(--accent);
      color: white;
      border-radius: 8px;
      font-size: 0.9em;
      font-weight: 500;
      text-decoration: none;
      transition: all 0.2s;
    }
    .nav-btn:hover { background: var(--accent-hover); text-decoration: none; }

    /* Hero Section */
    .hero {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 100px 24px 60px;
      background: radial-gradient(ellipse at top, rgba(59,130,246,0.1) 0%, transparent 50%);
    }
    .hero-inner {
      max-width: 1000px;
      text-align: center;
    }
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--accent-light);
      border: 1px solid rgba(59,130,246,0.3);
      border-radius: 24px;
      font-size: 0.85em;
      color: var(--accent);
      margin-bottom: 24px;
    }
    .hero-title {
      font-size: clamp(2.5em, 6vw, 4em);
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 24px;
      background: linear-gradient(135deg, #fff 0%, #aaa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero-subtitle {
      font-size: 1.25em;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto 40px;
    }
    .hero-actions {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 14px 28px;
      border-radius: 12px;
      font-size: 1em;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s;
      cursor: pointer;
      border: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      color: white;
      box-shadow: 0 4px 20px rgba(59,130,246,0.3);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 30px rgba(59,130,246,0.4); text-decoration: none; }
    .btn-secondary {
      background: var(--bg-card);
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { border-color: var(--accent); text-decoration: none; }

    /* Stats Section */
    .stats-section {
      padding: 80px 24px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .stats-inner {
      max-width: 1000px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 24px;
    }
    .stat-card {
      text-align: center;
      padding: 24px;
    }
    .stat-value {
      font-size: 3em;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .stat-label { color: var(--text-muted); margin-top: 8px; }

    /* Features Section */
    .features {
      padding: 100px 24px;
      max-width: 1200px;
      margin: 0 auto;
    }
    .section-title {
      font-size: 2.5em;
      font-weight: 700;
      text-align: center;
      margin-bottom: 16px;
    }
    .section-desc {
      text-align: center;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto 60px;
    }
    .features-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }
    .feature-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      transition: all 0.3s;
    }
    .feature-card:hover {
      transform: translateY(-4px);
      border-color: var(--accent);
      box-shadow: 0 20px 40px rgba(0,0,0,0.3);
    }
    .feature-icon {
      width: 56px;
      height: 56px;
      background: var(--accent-light);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      margin-bottom: 20px;
    }
    .feature-title { font-size: 1.25em; font-weight: 600; margin-bottom: 12px; }
    .feature-desc { color: var(--text-secondary); font-size: 0.95em; }

    /* How It Works */
    .how-it-works {
      padding: 100px 24px;
      background: var(--bg-secondary);
    }
    .how-inner { max-width: 1000px; margin: 0 auto; }
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 40px;
      margin-top: 60px;
    }
    .step {
      text-align: center;
      position: relative;
    }
    .step-number {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--purple) 100%);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25em;
      font-weight: 700;
      margin: 0 auto 20px;
    }
    .step-title { font-size: 1.2em; font-weight: 600; margin-bottom: 12px; }
    .step-desc { color: var(--text-secondary); font-size: 0.95em; }

    /* Recent Videos */
    .recent {
      padding: 100px 24px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .recent-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 40px;
    }
    .recent-title { font-size: 1.75em; font-weight: 700; }
    .recent-link { color: var(--accent); font-size: 0.95em; }
    .recent-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }
    .video-card {
      background: var(--bg-card);
      border-radius: 12px;
      overflow: hidden;
      cursor: pointer;
      transition: all 0.3s;
      border: 1px solid transparent;
    }
    .video-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 16px 32px rgba(0,0,0,0.3);
      border-color: var(--border);
    }
    .video-thumb {
      aspect-ratio: 16/9;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .video-thumb-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.3s;
    }
    .video-card:hover .video-thumb-overlay { opacity: 1; }
    .play-icon {
      width: 56px;
      height: 56px;
      background: rgba(255,255,255,0.95);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .play-icon::after {
      content: '';
      width: 0;
      height: 0;
      border-left: 18px solid #0a0a0a;
      border-top: 11px solid transparent;
      border-bottom: 11px solid transparent;
      margin-left: 3px;
    }
    .video-info { padding: 16px; }
    .video-title {
      font-size: 0.95em;
      font-weight: 500;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .video-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.8em;
      color: var(--text-muted);
    }

    /* CTA Section */
    .cta {
      padding: 100px 24px;
      background: linear-gradient(135deg, rgba(59,130,246,0.1) 0%, rgba(139,92,246,0.1) 100%);
      text-align: center;
    }
    .cta-inner { max-width: 600px; margin: 0 auto; }
    .cta-title { font-size: 2.5em; font-weight: 700; margin-bottom: 16px; }
    .cta-desc { color: var(--text-secondary); margin-bottom: 32px; font-size: 1.1em; }

    /* Footer */
    .footer {
      padding: 40px 24px;
      border-top: 1px solid var(--border);
      text-align: center;
      color: var(--text-muted);
      font-size: 0.9em;
    }
    .footer a { color: var(--text-secondary); }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-inner { grid-template-columns: repeat(2, 1fr); }
      .features-grid { grid-template-columns: 1fr; }
      .steps { grid-template-columns: 1fr; gap: 32px; }
    }
    @media (max-width: 600px) {
      .header-inner { padding: 12px 16px; }
      .nav { display: none; }
      .hero { padding: 80px 16px 40px; }
      .hero-title { font-size: 2em; }
      .hero-subtitle { font-size: 1em; }
      .stats-inner { grid-template-columns: repeat(2, 1fr); gap: 12px; }
      .stat-value { font-size: 2em; }
      .section-title { font-size: 1.75em; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <a href="/lurl" class="logo">
        <div class="logo-icon">▶</div>
        <span>Lurl Archive</span>
      </a>
      <nav class="nav">
        <a href="/lurl/browse" class="nav-link">Browse</a>
        <a href="#features" class="nav-link">Features</a>
        <a href="#how-it-works" class="nav-link">How It Works</a>
        <a href="/lurl/browse" class="nav-btn">Enter Library</a>
      </nav>
    </div>
  </header>

  <section class="hero">
    <div class="hero-inner">
      <div class="hero-badge">
        <span>🔥</span>
        <span>Crowdsourced Video Archive</span>
      </div>
      <h1 class="hero-title">Preserve lurl.cc Videos Forever</h1>
      <p class="hero-subtitle">
        lurl.cc links expire in 24 hours. We preserve them permanently.
        Install our script and contribute to the growing archive.
      </p>
      <div class="hero-actions">
        <a href="#install" class="btn btn-primary">
          <span>🔌</span>
          Install Tampermonkey Script
        </a>
        <a href="/lurl/browse" class="btn btn-secondary">
          <span>📚</span>
          Browse Archive
        </a>
      </div>
    </div>
  </section>

  <section class="stats-section">
    <div class="stats-inner">
      <div class="stat-card">
        <div class="stat-value" id="statTotal">-</div>
        <div class="stat-label">Total Videos</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="statBacked">-</div>
        <div class="stat-label">Backed Up</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="statToday">-</div>
        <div class="stat-label">Added Today</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">∞</div>
        <div class="stat-label">Forever Preserved</div>
      </div>
    </div>
  </section>

  <section class="features" id="features">
    <h2 class="section-title">Why Lurl Archive?</h2>
    <p class="section-desc">
      Built by the community, for the community. Never lose a lurl.cc video again.
    </p>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">⏰</div>
        <h3 class="feature-title">Beat the 24h Limit</h3>
        <p class="feature-desc">
          lurl.cc links expire in 24 hours. Our archive keeps them available permanently,
          so you can access them anytime.
        </p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🤝</div>
        <h3 class="feature-title">Crowdsourced</h3>
        <p class="feature-desc">
          Every user with the script contributes to the archive.
          The more users, the more complete the collection.
        </p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔒</div>
        <h3 class="feature-title">CDN Bypass</h3>
        <p class="feature-desc">
          lurl.cc uses anti-hotlinking protection. Our script runs in your browser,
          capturing videos only you can access.
        </p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">🔍</div>
        <h3 class="feature-title">Search & Browse</h3>
        <p class="feature-desc">
          Search by title, ID, or URL. Browse all archived content with our
          modern, fast interface.
        </p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">📱</div>
        <h3 class="feature-title">Mobile Friendly</h3>
        <p class="feature-desc">
          Our archive works on any device. Watch your favorite videos
          on desktop, tablet, or phone.
        </p>
      </div>
      <div class="feature-card">
        <div class="feature-icon">⚡</div>
        <h3 class="feature-title">Fast Streaming</h3>
        <p class="feature-desc">
          Videos are served with Range request support for smooth playback.
          No buffering, no waiting.
        </p>
      </div>
    </div>
  </section>

  <section class="how-it-works" id="how-it-works">
    <div class="how-inner">
      <h2 class="section-title">How It Works</h2>
      <p class="section-desc">
        Start contributing in just 3 simple steps.
      </p>
      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <h3 class="step-title">Install Tampermonkey</h3>
          <p class="step-desc">
            Get the Tampermonkey browser extension from the Chrome/Firefox store.
          </p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h3 class="step-title">Add Our Script</h3>
          <p class="step-desc">
            Install the Lurl Downloader userscript. It runs automatically on lurl.cc pages.
          </p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h3 class="step-title">Browse Normally</h3>
          <p class="step-desc">
            Just browse lurl.cc as usual. The script automatically backs up videos you view.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section class="recent">
    <div class="recent-header">
      <h2 class="recent-title">Recently Archived</h2>
      <a href="/lurl/browse" class="recent-link">View all →</a>
    </div>
    <div class="recent-grid" id="recentGrid">
      <!-- Populated by JS -->
    </div>
  </section>

  <section class="cta" id="install">
    <div class="cta-inner">
      <h2 class="cta-title">Ready to Contribute?</h2>
      <p class="cta-desc">
        Join the community and help preserve lurl.cc content.
        Every video you view gets archived for everyone.
      </p>
      <div class="hero-actions">
        <a href="https://greasyfork.org" target="_blank" class="btn btn-primary">
          <span>📥</span>
          Get the Script
        </a>
        <a href="/lurl/browse" class="btn btn-secondary">
          <span>🎬</span>
          Browse Archive
        </a>
      </div>
    </div>
  </section>

  <footer class="footer">
    <p>Lurl Archive - Preserving content for the community</p>
    <p style="margin-top: 8px;">
      <a href="/lurl/browse">Browse</a> ·
      <a href="/lurl/admin">Admin</a>
    </p>
  </footer>

  <script>
    // Load stats
    async function loadStats() {
      try {
        const res = await fetch('/lurl/api/records');
        const data = await res.json();
        const records = data.records || [];

        const backed = records.filter(r => r.fileExists).length;
        const today = new Date().toDateString();
        const todayCount = records.filter(r => new Date(r.capturedAt).toDateString() === today).length;

        document.getElementById('statTotal').textContent = records.length;
        document.getElementById('statBacked').textContent = backed;
        document.getElementById('statToday').textContent = todayCount;

        // Render recent videos
        renderRecent(records.slice(0, 8));
      } catch (e) {
        console.error('Failed to load stats:', e);
      }
    }

    function renderRecent(records) {
      const grid = document.getElementById('recentGrid');
      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;
      const formatDate = (d) => {
        const date = new Date(d);
        const now = new Date();
        const diff = now - date;
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return date.toLocaleDateString();
      };

      if (records.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">No videos archived yet. Be the first contributor!</p>';
        return;
      }

      grid.innerHTML = records.map(r => \`
        <div class="video-card" onclick="window.location.href='/lurl/view/\${r.id}'">
          <div class="video-thumb">
            <div class="video-thumb-overlay">
              <div class="play-icon"></div>
            </div>
          </div>
          <div class="video-info">
            <h3 class="video-title">\${getTitle(r.title)}</h3>
            <div class="video-meta">
              <span>\${formatDate(r.capturedAt)}</span>
              <span>\${r.fileExists ? '✓ Backed up' : '⏳ Pending'}</span>
            </div>
          </div>
        </div>
      \`).join('');
    }

    loadStats();
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
      res.end(JSON.stringify({ status: 'ok', version: 'v3-fixed', timestamp: new Date().toISOString() }));
      return;
    }

    // POST /capture
    if (req.method === 'POST' && urlPath === '/capture') {
      try {
        const { title, pageUrl, fileUrl, type = 'video', ref, cookies } = await parseBody(req);

        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 去重：用 pageUrl 判斷（同一頁面不建立重複記錄）
        const existingRecords = readAllRecords();
        const duplicate = existingRecords.find(r => r.pageUrl === pageUrl);
        if (duplicate) {
          // 檢查檔案是否真的存在
          const filePath = path.join(DATA_DIR, duplicate.backupPath);
          const fileExists = fs.existsSync(filePath);

          if (fileExists) {
            console.log(`[lurl] 跳過重複頁面: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, existingId: duplicate.id }));
          } else {
            // 記錄存在但檔案不存在，更新 fileUrl（CDN 可能換了）並讓前端上傳
            if (duplicate.fileUrl !== fileUrl) {
              console.log(`[lurl] CDN URL 已更新: ${duplicate.fileUrl} → ${fileUrl}`);
              // 更新記錄中的 fileUrl
              updateRecordFileUrl(duplicate.id, fileUrl);
            }
            console.log(`[lurl] 重複頁面但檔案遺失，需要前端上傳: ${pageUrl}`);
            res.writeHead(200, corsHeaders());
            res.end(JSON.stringify({ ok: true, duplicate: true, id: duplicate.id, needUpload: true }));
          }
          return;
        }

        ensureDirs();
        // 先產生 ID，用於確保檔名唯一
        const id = Date.now().toString(36);

        // 從 fileUrl 取得原始副檔名
        const urlExt = path.extname(new URL(fileUrl).pathname).toLowerCase() || (type === 'video' ? '.mp4' : '.jpg');
        const ext = ['.mp4', '.mov', '.webm', '.avi'].includes(urlExt) ? urlExt : (type === 'video' ? '.mp4' : '.jpg');
        const safeTitle = sanitizeFilename(title);
        // 檔名加上 ID 確保唯一性（同標題不同影片不會覆蓋）
        const filename = `${safeTitle}_${id}${ext}`;
        const targetDir = type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const folder = type === 'video' ? 'videos' : 'images';
        const backupPath = `${folder}/${filename}`; // 用正斜線，URL 才正確

        const record = {
          id,
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath,
          ...(ref && { ref }) // D卡文章連結（如果有）
        };

        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 後端用 cookies 嘗試下載（可能會失敗，但前端會補上傳）
        downloadFile(fileUrl, path.join(targetDir, filename), pageUrl, cookies || '').then(ok => {
          console.log(`[lurl] 後端備份${ok ? '完成' : '失敗'}: ${filename}${cookies ? ' (有cookie)' : ''}`);
        });

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, id: record.id, needUpload: true }));
      } catch (err) {
        console.error('[lurl] Error:', err.message);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/upload - 前端上傳 blob（支援分塊上傳）
    if (req.method === 'POST' && urlPath === '/api/upload') {
      try {
        const id = req.headers['x-record-id'];
        const chunkIndex = req.headers['x-chunk-index'];
        const totalChunks = req.headers['x-total-chunks'];

        if (!id) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少 x-record-id header' }));
          return;
        }

        // 找到對應的記錄
        const records = readAllRecords();
        const record = records.find(r => r.id === id);
        if (!record) {
          res.writeHead(404, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '找不到記錄' }));
          return;
        }

        // 讀取 body（binary）
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        if (buffer.length === 0) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '沒有收到檔案資料' }));
          return;
        }

        ensureDirs();
        const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const filename = path.basename(record.backupPath);
        const destPath = path.join(targetDir, filename);

        // 分塊上傳
        if (chunkIndex !== undefined && totalChunks !== undefined) {
          const chunkDir = path.join(DATA_DIR, 'chunks', id);
          if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
          }

          // 存分塊
          const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
          fs.writeFileSync(chunkPath, buffer);
          console.log(`[lurl] 分塊 ${parseInt(chunkIndex) + 1}/${totalChunks} 收到: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

          // 檢查是否所有分塊都收到
          const receivedChunks = fs.readdirSync(chunkDir).filter(f => f.startsWith('chunk_')).length;
          if (receivedChunks === parseInt(totalChunks)) {
            // 組裝完整檔案
            console.log(`[lurl] 所有分塊收齊，組裝中...`);

            // 同步寫入組裝檔案
            const allChunks = [];
            for (let i = 0; i < parseInt(totalChunks); i++) {
              const chunkData = fs.readFileSync(path.join(chunkDir, `chunk_${i}`));
              allChunks.push(chunkData);
            }
            const finalBuffer = Buffer.concat(allChunks);
            fs.writeFileSync(destPath, finalBuffer);

            // 清理分塊
            fs.rmSync(chunkDir, { recursive: true });

            console.log(`[lurl] 分塊上傳完成: ${filename} (${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
          }

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, chunk: parseInt(chunkIndex), total: parseInt(totalChunks) }));
        } else {
          // 單次上傳（小檔案）
          fs.writeFileSync(destPath, buffer);
          console.log(`[lurl] 前端上傳成功: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, size: buffer.length }));
        }
      } catch (err) {
        console.error('[lurl] Upload error:', err.message);
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
      let records = readAllRecords().reverse(); // 最新的在前
      const type = query.type;
      const q = query.q;

      // Type filter
      if (type && type !== 'all') {
        records = records.filter(r => r.type === type);
      }

      // Search filter (q parameter)
      if (q) {
        const searchTerm = q.toLowerCase();
        records = records.filter(r =>
          r.id.toLowerCase().includes(searchTerm) ||
          (r.title && r.title.toLowerCase().includes(searchTerm)) ||
          (r.pageUrl && r.pageUrl.toLowerCase().includes(searchTerm))
        );
      }

      // 加入 fileExists 狀態
      const recordsWithStatus = records.map(r => ({
        ...r,
        fileExists: fs.existsSync(path.join(DATA_DIR, r.backupPath))
      }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ records: recordsWithStatus, total: recordsWithStatus.length }));
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

    // DELETE /api/records/:id
    if (req.method === 'DELETE' && urlPath.startsWith('/api/records/')) {
      const id = urlPath.replace('/api/records/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      // 刪除檔案
      const filePath = path.join(DATA_DIR, record.backupPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // 更新記錄（過濾掉要刪除的）
      const newRecords = records.filter(r => r.id !== id);
      fs.writeFileSync(RECORDS_FILE, newRecords.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 已刪除: ${record.title}`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== Phase 3 ====================

    // GET / (Landing Page)
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(landingPage());
      return;
    }

    // GET /browse
    if (req.method === 'GET' && urlPath === '/browse') {
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(browsePage());
      return;
    }

    // GET /view/:id
    if (req.method === 'GET' && urlPath.startsWith('/view/')) {
      const id = urlPath.replace('/view/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders('text/html; charset=utf-8'));
        res.end('<h1>404 - 找不到此內容</h1><a href="/lurl/browse">返回影片庫</a>');
        return;
      }

      // 檢查本地檔案是否存在
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const fileExists = fs.existsSync(localFilePath);

      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(viewPage(record, fileExists));
      return;
    }

    // POST /api/retry/:id - 重新下載檔案
    if (req.method === 'POST' && urlPath.startsWith('/api/retry/')) {
      const id = urlPath.replace('/api/retry/', '');
      const records = readAllRecords();
      const record = records.find(r => r.id === id);

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const targetDir = record.type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
      const localFilePath = path.join(DATA_DIR, record.backupPath);

      // 用 pageUrl 當 Referer 來下載
      const success = await downloadFile(record.fileUrl, localFilePath, record.pageUrl);

      if (success) {
        console.log(`[lurl] 重試下載成功: ${record.title}`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '下載失敗，CDN 可能已過期' }));
      }
      return;
    }

    // GET/HEAD /files/videos/:filename 或 /files/images/:filename
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith('/files/')) {
      const filePath = decodeURIComponent(urlPath.replace('/files/', '')); // URL decode 中文檔名

      // 防止讀取資料夾
      if (!filePath || filePath.endsWith('/') || !filePath.includes('.')) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ error: 'Invalid file path' }));
        return;
      }

      const fullFilePath = path.join(DATA_DIR, filePath);

      if (!fs.existsSync(fullFilePath) || fs.statSync(fullFilePath).isDirectory()) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      const ext = path.extname(fullFilePath).toLowerCase();
      const mimeTypes = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
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
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath, { start, end }).pipe(res);
        }
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileSize,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(fullFilePath).pipe(res);
        }
      }
      return;
    }

    // 404
    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
