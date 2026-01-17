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
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// 備援下載模組 (Puppeteer - 在頁面 context 下載)
let lurlRetry = null;
try {
  lurlRetry = require('./lurl-retry');
  console.log('[lurl] ✅ Puppeteer 備援模組已載入');
} catch (e) {
  console.log('[lurl] ⚠️ Puppeteer 備援模組未載入:', e.message);
}

// ==================== 安全配置 ====================
// 從環境變數讀取，請在 .env 檔案中設定
const ADMIN_PASSWORD = process.env.LURL_ADMIN_PASSWORD || 'change-me';
const CLIENT_TOKEN = process.env.LURL_CLIENT_TOKEN || 'change-me';
const SESSION_SECRET = process.env.LURL_SESSION_SECRET || 'change-me';

// 資料存放位置
const DATA_DIR = path.join(__dirname, '..', 'data', 'lurl');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const QUOTAS_FILE = path.join(DATA_DIR, 'quotas.jsonl');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');

// 修復服務設定
const FREE_QUOTA = 3;

// ==================== 安全函數 ====================

function generateSessionToken(password) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(password).digest('hex').substring(0, 32);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length) {
      cookies[name] = rest.join('=');
    }
  });
  return cookies;
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.lurl_session;
  const validToken = generateSessionToken(ADMIN_PASSWORD);
  return sessionToken === validToken;
}

function isClientAuthenticated(req) {
  const token = req.headers['x-client-token'];
  return token === CLIENT_TOKEN;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl - 登入</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #1a1a2e; padding: 40px; border-radius: 12px; width: 100%; max-width: 360px; }
    .login-box h1 { text-align: center; margin-bottom: 30px; font-size: 1.5em; }
    .login-box input { width: 100%; padding: 12px 16px; border: none; border-radius: 8px; background: #0f0f0f; color: white; font-size: 1em; margin-bottom: 15px; }
    .login-box input:focus { outline: 2px solid #3b82f6; }
    .login-box button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #3b82f6; color: white; font-size: 1em; cursor: pointer; }
    .login-box button:hover { background: #2563eb; }
    .error { color: #f87171; text-align: center; margin-bottom: 15px; font-size: 0.9em; }
    .logo { text-align: center; margin-bottom: 20px; }
    .logo img { height: 60px; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="logo"><img src="/lurl/files/LOGO.png" alt="Lurl"></div>
    <h1>登入</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/lurl/login">
      <input type="password" name="password" placeholder="請輸入密碼" autofocus required>
      <input type="hidden" name="redirect" value="">
      <button type="submit">登入</button>
    </form>
  </div>
  <script>
    document.querySelector('input[name="redirect"]').value = new URLSearchParams(window.location.search).get('redirect') || '/lurl/browse';
  </script>
</body>
</html>`;
}

// ==================== 工具函數 ====================

function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, IMAGES_DIR, THUMBNAILS_DIR].forEach(dir => {
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
    .substring(0, 200) || `untitled_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
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

// 用 ffmpeg 產生影片縮圖
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function generateVideoThumbnail(videoPath, thumbnailPath) {
  try {
    // 確保縮圖目錄存在
    const dir = path.dirname(thumbnailPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // ffmpeg 擷取第 1 秒的畫面，縮放到 320px 寬
    const cmd = `ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${thumbnailPath}"`;
    await execAsync(cmd, { timeout: 30000 });

    if (fs.existsSync(thumbnailPath)) {
      console.log(`[lurl] ✅ 縮圖產生成功: ${thumbnailPath}`);
      return true;
    }
    return false;
  } catch (err) {
    console.log(`[lurl] ⚠️ 縮圖產生失敗: ${err.message}`);
    return false;
  }
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

function updateRecordThumbnail(id, thumbnailPath) {
  const records = readAllRecords();
  const updated = records.map(r => {
    if (r.id === id) {
      return { ...r, thumbnailPath };
    }
    return r;
  });
  fs.writeFileSync(RECORDS_FILE, updated.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[lurl] 記錄已更新縮圖: ${id}`);
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

// ==================== 額度管理 ====================

function readAllQuotas() {
  ensureDirs();
  if (!fs.existsSync(QUOTAS_FILE)) return [];
  const content = fs.readFileSync(QUOTAS_FILE, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function getVisitorQuota(visitorId) {
  const quotas = readAllQuotas();
  let quota = quotas.find(q => q.visitorId === visitorId);
  if (!quota) {
    quota = {
      visitorId,
      usedCount: 0,
      freeQuota: FREE_QUOTA,
      paidQuota: 0,
      history: []
    };
  }
  return quota;
}

function useQuota(visitorId, pageUrl, urlId, backupUrl) {
  const quotas = readAllQuotas();
  let quotaIndex = quotas.findIndex(q => q.visitorId === visitorId);

  const historyEntry = {
    pageUrl,
    urlId,
    backupUrl,
    usedAt: new Date().toISOString()
  };

  if (quotaIndex === -1) {
    quotas.push({
      visitorId,
      usedCount: 1,
      freeQuota: FREE_QUOTA,
      paidQuota: 0,
      lastUsed: new Date().toISOString(),
      history: [historyEntry]
    });
  } else {
    quotas[quotaIndex].usedCount++;
    quotas[quotaIndex].lastUsed = new Date().toISOString();
    quotas[quotaIndex].history.push(historyEntry);
  }

  fs.writeFileSync(QUOTAS_FILE, quotas.map(q => JSON.stringify(q)).join('\n') + '\n', 'utf8');
  return getVisitorQuota(visitorId);
}

// 檢查是否已修復過此 URL
function hasRecovered(visitorId, urlId) {
  const quota = getVisitorQuota(visitorId);
  return quota.history.find(h => h.urlId === urlId);
}

function getRemainingQuota(quota) {
  return (quota.freeQuota - quota.usedCount) + quota.paidQuota;
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
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
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

    /* Version Management */
    .version-panel { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 30px; }
    .version-panel h2 { font-size: 1.2em; margin-bottom: 15px; color: #333; display: flex; align-items: center; gap: 8px; }
    .version-form { display: grid; gap: 15px; }
    .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group label { font-size: 0.85em; color: #666; font-weight: 500; }
    .form-group input, .form-group textarea { padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 0.95em; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #2196F3; }
    .form-group textarea { min-height: 60px; resize: vertical; }
    .form-group.checkbox { flex-direction: row; align-items: center; gap: 8px; }
    .form-group.checkbox input { width: auto; }
    .form-actions { display: flex; gap: 10px; margin-top: 10px; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 0.95em; }
    .btn-primary { background: #2196F3; color: white; }
    .btn-primary:hover { background: #1976D2; }
    .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; font-size: 0.9em; z-index: 1000; animation: slideIn 0.3s ease; }
    .toast.success { background: #4caf50; }
    .toast.error { background: #e53935; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    /* Maintenance Grid */
    .maintenance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 15px; }
    .maintenance-item { background: #f9f9f9; padding: 15px; border-radius: 8px; text-align: center; display: flex; flex-direction: column; gap: 8px; align-items: center; }
    .maintenance-icon { font-size: 1.5em; }
    .maintenance-label { font-size: 0.85em; color: #666; font-weight: 500; }
    .maintenance-desc { font-size: 0.7em; color: #999; margin-top: -4px; }
    .maintenance-status { font-size: 0.75em; color: #999; min-height: 1.2em; }
    .btn-sm { padding: 6px 12px; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
      <h1>管理面板</h1>
    </div>
    <nav>
      <a href="/lurl/admin" class="active">管理面板</a>
      <a href="/lurl/browse">影片庫</a>
      <a href="/lurl/health">API 狀態</a>
    </nav>
  </div>
  <div class="container">
    <div class="stats" id="stats"></div>

    <!-- 版本管理 -->
    <div class="version-panel">
      <h2>📦 腳本版本管理</h2>
      <div class="version-form">
        <div class="form-row">
          <div class="form-group">
            <label>最新版本 (latestVersion)</label>
            <input type="text" id="latestVersion" placeholder="例: 4.8">
          </div>
          <div class="form-group">
            <label>最低版本 (minVersion) - 低於此版本強制更新</label>
            <input type="text" id="minVersion" placeholder="例: 4.0.0">
          </div>
        </div>
        <div class="form-group">
          <label>更新訊息 (message)</label>
          <input type="text" id="versionMessage" placeholder="例: 新增功能、修復問題等">
        </div>
        <div class="form-group">
          <label>公告 (announcement) - 可選</label>
          <textarea id="announcement" placeholder="額外公告訊息..."></textarea>
        </div>
        <div class="form-group">
          <label>更新連結 (updateUrl)</label>
          <input type="text" id="updateUrl" placeholder="GitHub raw URL">
        </div>
        <div class="form-group checkbox">
          <input type="checkbox" id="forceUpdate">
          <label for="forceUpdate">強制更新 (forceUpdate) - 所有舊版本必須更新</label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" onclick="saveVersionConfig()">💾 儲存設定</button>
        </div>
      </div>
    </div>

    <!-- 資料維護 -->
    <div class="version-panel" style="margin-top: 20px;">
      <h2>🔧 資料維護</h2>
      <div class="maintenance-grid">
        <div class="maintenance-item">
          <div class="maintenance-icon">🔧</div>
          <div class="maintenance-label">修復 Untitled</div>
          <div class="maintenance-desc">重新抓取缺少標題的記錄</div>
          <button class="btn btn-primary btn-sm" onclick="fixUntitled()">執行</button>
          <div class="maintenance-status" id="untitledStatus"></div>
        </div>
        <div class="maintenance-item">
          <div class="maintenance-icon">🔄</div>
          <div class="maintenance-label">重試下載</div>
          <div class="maintenance-desc">用 Puppeteer 重新下載失敗的檔案</div>
          <button class="btn btn-primary btn-sm" onclick="retryFailed()" id="retryBtn">執行</button>
          <div class="maintenance-status" id="retryStatus">-</div>
        </div>
        <div class="maintenance-item">
          <div class="maintenance-icon">🖼️</div>
          <div class="maintenance-label">產生縮圖</div>
          <div class="maintenance-desc">為沒有縮圖的影片產生預覽圖</div>
          <button class="btn btn-primary btn-sm" onclick="generateThumbnails()" id="thumbBtn">執行</button>
          <div class="maintenance-status" id="thumbStatus">-</div>
        </div>
        <div class="maintenance-item">
          <div class="maintenance-icon">🗑️</div>
          <div class="maintenance-label">清理重複</div>
          <div class="maintenance-desc">移除重複的 pageUrl/fileUrl 記錄</div>
          <button class="btn btn-primary btn-sm" onclick="cleanupDuplicates()" id="dupBtn">執行</button>
          <div class="maintenance-status" id="dupStatus">-</div>
        </div>
        <div class="maintenance-item">
          <div class="maintenance-icon">📁</div>
          <div class="maintenance-label">修復路徑</div>
          <div class="maintenance-desc">修正指向同一檔案的記錄</div>
          <button class="btn btn-primary btn-sm" onclick="repairPaths()" id="repairBtn">執行</button>
          <div class="maintenance-status" id="repairStatus">-</div>
        </div>
      </div>
    </div>

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

    // Toast 訊息
    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }

    // 版本設定
    async function loadVersionConfig() {
      try {
        const res = await fetch('/lurl/api/version');
        const config = await res.json();
        document.getElementById('latestVersion').value = config.latestVersion || '';
        document.getElementById('minVersion').value = config.minVersion || '';
        document.getElementById('versionMessage').value = config.message || '';
        document.getElementById('announcement').value = config.announcement || '';
        document.getElementById('updateUrl').value = config.updateUrl || '';
        document.getElementById('forceUpdate').checked = config.forceUpdate || false;
      } catch (e) {
        console.error('載入版本設定失敗:', e);
      }
    }

    async function saveVersionConfig() {
      const config = {
        latestVersion: document.getElementById('latestVersion').value,
        minVersion: document.getElementById('minVersion').value,
        message: document.getElementById('versionMessage').value,
        announcement: document.getElementById('announcement').value,
        updateUrl: document.getElementById('updateUrl').value,
        forceUpdate: document.getElementById('forceUpdate').checked
      };
      try {
        const res = await fetch('/lurl/api/version', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.ok) {
          showToast('版本設定已儲存！');
        } else {
          showToast('儲存失敗: ' + (data.error || '未知錯誤'), 'error');
        }
      } catch (e) {
        showToast('儲存失敗: ' + e.message, 'error');
      }
    }

    async function fixUntitled() {
      const statusEl = document.getElementById('untitledStatus');
      statusEl.textContent = '修復中...';
      try {
        const res = await fetch('/lurl/api/fix-untitled', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.fixed > 0) {
            showToast('已修復 ' + data.fixed + ' 個 untitled 記錄！');
            statusEl.textContent = '已修復 ' + data.fixed + ' 筆';
            loadRecords(); // 重新載入記錄
          } else {
            showToast(data.message || '沒有需要修復的記錄');
            statusEl.textContent = '無需修復';
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          statusEl.textContent = '修復失敗';
        }
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        statusEl.textContent = '修復失敗';
      }
    }

    async function loadRetryStatus() {
      try {
        const res = await fetch('/lurl/api/retry-status');
        const data = await res.json();
        const statusEl = document.getElementById('retryStatus');
        const btn = document.getElementById('retryBtn');
        if (data.ok) {
          if (!data.puppeteerAvailable) {
            statusEl.textContent = '⚠️ Puppeteer 未安裝';
            btn.disabled = true;
            btn.style.opacity = '0.5';
          } else if (data.failed === 0) {
            statusEl.textContent = '✅ 沒有失敗記錄';
            btn.disabled = true;
            btn.style.opacity = '0.5';
          } else {
            statusEl.textContent = '待重試: ' + data.failed + ' 個';
          }
        }
      } catch (e) {
        document.getElementById('retryStatus').textContent = '載入失敗';
      }
    }

    async function retryFailed() {
      const statusEl = document.getElementById('retryStatus');
      const btn = document.getElementById('retryBtn');
      btn.disabled = true;
      statusEl.textContent = '處理中...';
      try {
        const res = await fetch('/lurl/api/retry-failed', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '沒有需要重試的記錄');
            statusEl.textContent = '無需重試';
          } else {
            showToast('開始重試 ' + data.total + ' 個記錄，請查看 server console');
            statusEl.textContent = '背景處理中 (' + data.total + ' 個)';
          }
        } else {
          showToast('重試失敗: ' + (data.error || '未知錯誤'), 'error');
          statusEl.textContent = '重試失敗';
          btn.disabled = false;
        }
      } catch (e) {
        showToast('重試失敗: ' + e.message, 'error');
        statusEl.textContent = '重試失敗';
        btn.disabled = false;
      }
    }

    async function loadThumbStatus() {
      // 簡單顯示「就緒」，不需要預先計算
      document.getElementById('thumbStatus').textContent = '就緒';
    }

    async function generateThumbnails() {
      const statusEl = document.getElementById('thumbStatus');
      const btn = document.getElementById('thumbBtn');
      btn.disabled = true;
      statusEl.textContent = '處理中...';
      try {
        const res = await fetch('/lurl/api/generate-thumbnails', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.total === 0) {
            showToast(data.message || '所有影片都已有縮圖');
            statusEl.textContent = '無需產生';
          } else {
            showToast('開始產生 ' + data.total + ' 個縮圖');
            statusEl.textContent = '背景處理中 (' + data.total + ' 個)';
          }
        } else {
          showToast('產生失敗: ' + (data.error || '未知錯誤'), 'error');
          statusEl.textContent = '產生失敗';
          btn.disabled = false;
        }
      } catch (e) {
        showToast('產生失敗: ' + e.message, 'error');
        statusEl.textContent = '產生失敗';
        btn.disabled = false;
      }
    }

    async function repairPaths() {
      const statusEl = document.getElementById('repairStatus');
      const btn = document.getElementById('repairBtn');
      btn.disabled = true;
      statusEl.textContent = '處理中...';
      try {
        const res = await fetch('/lurl/api/repair-paths', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast(data.message);
          statusEl.textContent = data.fixed > 0 ? '已修復 ' + data.fixed + ' 個' : '無需修復';
          if (data.fixed > 0) {
            loadStats();
            loadRecords();
            loadRetryStatus(); // 更新重試狀態
          }
        } else {
          showToast('修復失敗: ' + (data.error || '未知錯誤'), 'error');
          statusEl.textContent = '修復失敗';
        }
        btn.disabled = false;
      } catch (e) {
        showToast('修復失敗: ' + e.message, 'error');
        statusEl.textContent = '修復失敗';
        btn.disabled = false;
      }
    }

    async function cleanupDuplicates() {
      const statusEl = document.getElementById('dupStatus');
      const btn = document.getElementById('dupBtn');
      btn.disabled = true;
      statusEl.textContent = '處理中...';
      try {
        const res = await fetch('/lurl/api/cleanup-duplicates', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          if (data.removed === 0) {
            showToast(data.message || '沒有重複記錄');
            statusEl.textContent = '無重複';
          } else {
            showToast('已清理 ' + data.removed + ' 個重複記錄');
            statusEl.textContent = '已清理 ' + data.removed + ' 個';
            loadStats();
            loadRecords();
          }
        } else {
          showToast('清理失敗: ' + (data.error || '未知錯誤'), 'error');
          statusEl.textContent = '清理失敗';
        }
        btn.disabled = false;
      } catch (e) {
        showToast('清理失敗: ' + e.message, 'error');
        statusEl.textContent = '清理失敗';
        btn.disabled = false;
      }
    }

    loadStats();
    loadRecords();
    loadVersionConfig();
    loadRetryStatus();
    loadThumbStatus();
  </script>
</body>
</html>`;
}

function browsePage() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lurl 影片庫</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover, .header nav a.active { color: white; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    /* Search Bar */
    .search-bar { margin-bottom: 20px; }
    .search-bar input {
      width: 100%;
      max-width: 500px;
      padding: 12px 16px;
      border: none;
      border-radius: 8px;
      background: #1a1a1a;
      color: white;
      font-size: 1em;
      outline: none;
    }
    .search-bar input::placeholder { color: #666; }
    .search-bar input:focus { box-shadow: 0 0 0 2px #3b82f6; }

    /* Filter Bar */
    .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
    .tabs { display: flex; gap: 10px; }
    .tab { padding: 8px 16px; background: #333; border: none; border-radius: 20px; color: white; cursor: pointer; transition: all 0.2s; }
    .tab:hover { background: #444; }
    .tab.active { background: #3b82f6; color: #fff; }
    .result-count { margin-left: auto; color: #666; font-size: 0.9em; }

    /* Grid */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
    .card { background: #1a1a1a; border-radius: 12px; overflow: hidden; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; }
    .card:hover { transform: translateY(-4px); box-shadow: 0 8px 25px rgba(0,0,0,0.3); }

    /* Thumbnail - No video preload! */
    .card-thumb {
      aspect-ratio: 16/9;
      background: linear-gradient(135deg, #1e3a5f 0%, #0f1a2e 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
      position: relative;
      overflow: hidden;
    }
    .card-thumb .play-icon {
      width: 60px;
      height: 60px;
      background: rgba(255,255,255,0.15);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
      z-index: 2;
    }
    .card:hover .card-thumb .play-icon { background: rgba(59,130,246,0.8); transform: scale(1.1); }
    .card-thumb .play-icon::after {
      content: '';
      width: 0;
      height: 0;
      border-left: 18px solid white;
      border-top: 11px solid transparent;
      border-bottom: 11px solid transparent;
      margin-left: 4px;
    }
    .card-thumb.pending { background: linear-gradient(135deg, #3d2a1a 0%, #1a1a1a 100%); }
    .card-thumb.image { background: linear-gradient(135deg, #2d1a3d 0%, #1a1a2e 100%); }
    .card-thumb img { width: 100%; height: 100%; object-fit: cover; filter: blur(4px); transition: filter 0.3s; position: absolute; top: 0; left: 0; }
    .card:hover .card-thumb img { filter: blur(2px); }

    /* Card Info */
    .card-info { padding: 12px; }
    .card-title { font-size: 0.95em; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 8px; }
    .card-meta { display: flex; justify-content: space-between; align-items: center; }
    .card-date { font-size: 0.8em; color: #666; }
    .card-id {
      font-size: 0.75em;
      color: #3b82f6;
      background: rgba(59,130,246,0.1);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .card-id:hover { background: rgba(59,130,246,0.3); }
    .card-status { font-size: 0.75em; color: #f59e0b; margin-top: 4px; }

    .empty { text-align: center; padding: 60px; color: #666; }

    /* Skeleton Loading */
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
    }
    .skeleton-card { background: #1a1a1a; border-radius: 12px; overflow: hidden; }
    .skeleton-thumb { aspect-ratio: 16/9; }
    .skeleton-info { padding: 12px; }
    .skeleton-title { height: 20px; border-radius: 4px; margin-bottom: 12px; width: 80%; }
    .skeleton-meta { height: 14px; border-radius: 4px; width: 50%; }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #333;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 1000;
    }
    .toast.show { opacity: 1; }

    /* Card Actions (Rating & Block) */
    .card-actions { display: flex; gap: 6px; margin-top: 8px; }
    .card-actions button {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: #333;
      color: #aaa;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .card-actions button:hover { background: #444; color: white; }
    .card-actions .btn-like.active { background: #4caf50; color: white; }
    .card-actions .btn-dislike.active { background: #f44336; color: white; }
    .card-actions .btn-block:hover { background: #c62828; color: white; }
    .card.blocked { opacity: 0.5; }
    .card.blocked .card-thumb { filter: grayscale(1); }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
      <h1>影片庫</h1>
    </div>
    <nav>
      <a href="/lurl/admin">Admin</a>
      <a href="/lurl/browse" class="active">Browse</a>
    </nav>
  </div>
  <div class="container">
    <div class="search-bar">
      <input type="text" id="search" placeholder="Search by title, ID, or URL (e.g. n41Xm, mkhev)..." autocomplete="off">
    </div>
    <div class="filter-bar">
      <div class="tabs">
        <button class="tab active" data-type="all">全部</button>
        <button class="tab" data-type="video">影片</button>
        <button class="tab" data-type="image">圖片</button>
        <button class="tab" data-type="pending" style="background:#f59e0b;color:#000;">未下載</button>
        <button class="tab" data-type="blocked" style="background:#666;">🚫 已封鎖</button>
      </div>
      <div class="result-count" id="resultCount"></div>
    </div>
    <div class="grid" id="grid">
      <!-- 骨架屏 -->
      ${Array(8).fill(0).map(() => `
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let allRecords = [];
    let currentType = localStorage.getItem('lurl_browse_tab') || 'all';
    let searchQuery = '';
    let isLoading = false;

    // 恢復上次的 tab 狀態
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.type === currentType);
    });

    function showSkeleton() {
      document.getElementById('grid').innerHTML = Array(8).fill(0).map(() => \`
        <div class="skeleton-card">
          <div class="skeleton-thumb skeleton"></div>
          <div class="skeleton-info">
            <div class="skeleton-title skeleton"></div>
            <div class="skeleton-meta skeleton"></div>
          </div>
        </div>
      \`).join('');
    }

    let currentPage = 1;
    let totalRecords = 0;
    let hasMore = true;

    async function loadRecords(append = false) {
      if (isLoading) return;
      if (!append) {
        currentPage = 1;
        allRecords = [];
        hasMore = true;
        showSkeleton();
      }
      isLoading = true;

      const params = new URLSearchParams({
        page: currentPage,
        limit: 30,
        ...(currentType !== 'all' && { type: currentType }),
        ...(searchQuery && { q: searchQuery })
      });

      const res = await fetch('/lurl/api/records?' + params);
      const data = await res.json();
      isLoading = false;

      if (append) {
        allRecords = [...allRecords, ...data.records];
      } else {
        allRecords = data.records;
      }
      totalRecords = data.total;
      hasMore = data.hasMore;

      renderGrid(append);
    }

    function renderGrid(append = false) {
      document.getElementById('resultCount').textContent = totalRecords + ' items';

      if (allRecords.length === 0) {
        document.getElementById('grid').innerHTML = '<div class="empty">' +
          (searchQuery ? 'No results for "' + searchQuery + '"' : 'No content yet') + '</div>';
        return;
      }

      const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? 'Untitled' : t;

      const html = allRecords.map(r => \`
        <div class="card \${r.blocked ? 'blocked' : ''}" onclick="window.location.href='/lurl/view/\${r.id}'">
          <div class="card-thumb \${r.type === 'image' ? 'image' : ''} \${!r.fileExists ? 'pending' : ''}">
            \${r.fileExists
              ? (r.type === 'image'
                ? \`<img src="/lurl/files/\${r.backupPath}" alt="\${getTitle(r.title)}" onerror="this.style.display='none'">\`
                : (r.thumbnailExists && r.thumbnailPath
                  ? \`<img src="/lurl/files/\${r.thumbnailPath}" alt="\${getTitle(r.title)}" onerror="this.parentElement.innerHTML='<div class=play-icon></div>'"><div class="play-icon" style="position:absolute;"></div>\`
                  : '<div class="play-icon"></div>'))
              : '<span style="font-size:24px;color:#666">Pending</span>'}
          </div>
          <div class="card-info">
            <div class="card-title">\${getTitle(r.title)}</div>
            <div class="card-meta">
              <span class="card-date">\${new Date(r.capturedAt).toLocaleDateString()}</span>
              <span class="card-id" onclick="event.stopPropagation();copyId('\${r.id}')" title="Click to copy">#\${r.id}</span>
            </div>
            \${!r.fileExists ? '<div class="card-status">Backup pending</div>' : ''}
            <div class="card-actions">
              <button class="btn-like \${r.myVote === 'like' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'like')" title="讚">👍 \${r.likeCount || 0}</button>
              <button class="btn-dislike \${r.myVote === 'dislike' ? 'active' : ''}" onclick="event.stopPropagation();vote('\${r.id}', 'dislike')" title="倒讚">👎 \${r.dislikeCount || 0}</button>
              <button class="btn-block" onclick="event.stopPropagation();block('\${r.id}', \${!r.blocked})" title="\${r.blocked ? '解除封鎖' : '封鎖'}">\${r.blocked ? '✅' : '🚫'}</button>
            </div>
          </div>
        </div>
      \`).join('');

      document.getElementById('grid').innerHTML = html;
    }

    // 無限滾動
    window.addEventListener('scroll', () => {
      if (isLoading || !hasMore) return;
      const scrollBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 500;
      if (scrollBottom) {
        currentPage++;
        loadRecords(true);
      }
    });

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

    async function vote(id, voteType) {
      const record = allRecords.find(r => r.id === id);
      if (!record) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/vote\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vote: voteType })
        });
        const data = await res.json();
        if (data.ok) {
          // 更新本地記錄
          record.likeCount = data.likeCount;
          record.dislikeCount = data.dislikeCount;
          record.myVote = data.myVote;
          renderGrid();
          if (data.myVote === 'like') showToast('👍 已按讚');
          else if (data.myVote === 'dislike') showToast('👎 已倒讚');
          else showToast('已取消投票');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    async function block(id, doBlock) {
      const action = doBlock ? '封鎖此內容？檔案將被刪除。' : '解除封鎖？';
      if (!confirm(action)) return;

      try {
        const res = await fetch(\`/lurl/api/records/\${id}/block\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block: doBlock })
        });
        const data = await res.json();
        if (data.ok) {
          if (doBlock) {
            // 封鎖後從列表移除（除非在已封鎖 tab）
            if (currentType !== 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            } else {
              const record = allRecords.find(r => r.id === id);
              if (record) record.blocked = true;
            }
          } else {
            // 解除封鎖後從已封鎖列表移除
            if (currentType === 'blocked') {
              allRecords = allRecords.filter(r => r.id !== id);
              totalRecords--;
            }
          }
          renderGrid();
          showToast(doBlock ? '🚫 已封鎖' : '✅ 已解除封鎖');
        }
      } catch (e) {
        showToast('操作失敗');
      }
    }

    // Tab click
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentType = tab.dataset.type;
        localStorage.setItem('lurl_browse_tab', currentType);
        loadRecords(); // 重新從 server 載入
      });
    });

    // Search input with debounce
    let searchTimeout;
    document.getElementById('search').addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        searchQuery = e.target.value.trim();
        loadRecords(); // 重新從 server 載入
      }, 300);
    });

    // URL param for search
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
  const getTitle = (t) => (!t || t === 'untitled' || t === 'undefined') ? '未命名' : t;
  const title = getTitle(record.title);
  const isVideo = record.type === 'video';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/png" href="/lurl/files/LOGO.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Lurl</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: white; min-height: 100vh; }
    .header { background: #1a1a2e; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }
    .header .logo-title { display: flex; align-items: center; gap: 10px; }
    .header .logo { height: 36px; width: auto; }
    .header h1 { font-size: 1.3em; }
    .header nav { display: flex; gap: 20px; }
    .header nav a { color: #aaa; text-decoration: none; font-size: 0.95em; }
    .header nav a:hover { color: white; }
    .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
    .media-container { background: #000; border-radius: 12px; overflow: hidden; margin-bottom: 20px; display: flex; align-items: center; justify-content: center; }
    .media-container video { width: 100%; max-height: 70vh; object-fit: contain; display: block; aspect-ratio: 16/9; background: #000; }
    .media-container img { width: 100%; max-height: 70vh; object-fit: contain; display: block; }
    .media-missing { color: #666; text-align: center; padding: 40px; }
    .media-missing p { margin-bottom: 15px; }
    .info { background: #1a1a1a; border-radius: 12px; padding: 20px; }
    .info h2 { font-size: 1.3em; margin-bottom: 15px; line-height: 1.4; }
    .info-row { display: flex; gap: 10px; margin-bottom: 10px; color: #aaa; font-size: 0.9em; }
    .info-row span { color: #666; }
    .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
    .btn { padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 0.95em; border: none; cursor: pointer; }
    .btn-primary { background: #2196F3; color: white; }
    .btn-secondary { background: #333; color: white; }
    .btn-warning { background: #f59e0b; color: white; }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .back-link { display: inline-block; margin-bottom: 20px; color: #aaa; text-decoration: none; }
    .back-link:hover { color: white; }
    .status { margin-top: 10px; font-size: 0.9em; }
    .status.success { color: #4ade80; }
    .status.error { color: #f87171; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-title">
      <img src="/lurl/files/LOGO.png" alt="Lurl" class="logo">
    </div>
    <nav>
      <a href="/lurl/admin">管理面板</a>
      <a href="/lurl/browse">影片庫</a>
    </nav>
  </div>
  <div class="container">
    <a href="/lurl/browse" class="back-link">← 返回影片庫</a>
    <div class="media-container">
      ${fileExists
        ? (isVideo
          ? `<video src="/lurl/files/${record.backupPath}" controls autoplay></video>`
          : `<img src="/lurl/files/${record.backupPath}" alt="${title}">`)
        : `<div class="media-missing">
            <p>⚠️ 檔案尚未下載成功</p>
            <p style="font-size:0.8em;color:#555;">原始位置：${record.fileUrl}</p>
          </div>`
      }
    </div>
    <div class="info">
      <h2>${title}</h2>
      <div class="info-row"><span>類型：</span>${isVideo ? '影片' : '圖片'}</div>
      <div class="info-row"><span>來源：</span>${record.source || 'lurl'}</div>
      <div class="info-row"><span>收錄時間：</span>${new Date(record.capturedAt).toLocaleString('zh-TW')}</div>
      <div class="info-row"><span>本地檔案：</span>${fileExists ? '✅ 已備份' : '❌ 未備份'}</div>
      <div class="info-row" style="word-break:break-all;"><span>原始頁面：</span><a href="${record.pageUrl}" target="_blank" style="color:#4a9eff;font-size:0.85em;">${record.pageUrl}</a></div>
      <div class="info-row" style="word-break:break-all;"><span>CDN：</span><span style="color:#555;font-size:0.85em;">${record.fileUrl}</span></div>
      <div class="actions">
        ${fileExists ? `<a href="/lurl/files/${record.backupPath}" download class="btn btn-primary">下載</a>` : ''}
        ${record.ref ? `<a href="${record.ref}" target="_blank" class="btn btn-secondary">📖 D卡文章</a>` : ''}
        ${!fileExists ? `<a href="${record.pageUrl}" target="_blank" class="btn btn-warning">🔄 重新下載（需安裝腳本）</a>` : ''}
      </div>
      ${!fileExists ? `<div class="status" style="margin-top:15px;color:#888;font-size:0.85em;">💡 點擊「重新下載」會開啟原始頁面，若已安裝 Tampermonkey 腳本，將自動備份檔案</div>` : ''}
    </div>
  </div>
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

    // ==================== 登入系統 ====================

    // GET /login - 登入頁面
    if (req.method === 'GET' && urlPath === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }

    // POST /login - 處理登入
    if (req.method === 'POST' && urlPath === '/login') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const password = params.get('password');
        const redirect = params.get('redirect') || '/lurl/browse';

        if (password === ADMIN_PASSWORD) {
          const sessionToken = generateSessionToken(password);
          res.writeHead(302, {
            'Set-Cookie': `lurl_session=${sessionToken}; Path=/lurl; HttpOnly; SameSite=Strict; Max-Age=86400`,
            'Location': redirect
          });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginPage('密碼錯誤'));
        }
      });
      return;
    }

    // GET /logout - 登出
    if (req.method === 'GET' && urlPath === '/logout') {
      res.writeHead(302, {
        'Set-Cookie': 'lurl_session=; Path=/lurl; HttpOnly; Max-Age=0',
        'Location': '/lurl/login'
      });
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

    // POST /capture (需要 CLIENT_TOKEN)
    if (req.method === 'POST' && urlPath === '/capture') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
      try {
        const { title, pageUrl, fileUrl, type = 'video', ref, cookies, thumbnail } = await parseBody(req);

        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 去重與封鎖檢查
        const existingRecords = readAllRecords();

        // 檢查 fileUrl 是否已被封鎖
        const blockedRecord = existingRecords.find(r => r.fileUrl === fileUrl && r.blocked);
        if (blockedRecord) {
          console.log(`[lurl] 跳過已封鎖內容: ${fileUrl}`);
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, blocked: true, message: '此內容已被封鎖' }));
          return;
        }
        const duplicate = existingRecords.find(r => r.pageUrl === pageUrl || r.fileUrl === fileUrl);
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

        // 保存縮圖（如果有）
        let thumbnailPath = null;
        if (thumbnail && type === 'video') {
          try {
            const thumbFilename = `${id}.jpg`;
            const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
            // thumbnail 是 data:image/jpeg;base64,... 格式
            const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(thumbFullPath, Buffer.from(base64Data, 'base64'));
            thumbnailPath = `thumbnails/${thumbFilename}`;
            console.log(`[lurl] 縮圖已存: ${thumbFilename}`);
          } catch (thumbErr) {
            console.error(`[lurl] 縮圖保存失敗: ${thumbErr.message}`);
          }
        }

        const record = {
          id,
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath,
          ...(ref && { ref }), // D卡文章連結（如果有）
          ...(thumbnailPath && { thumbnailPath }) // 縮圖路徑（如果有）
        };

        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 後端用 cookies 嘗試下載（可能會失敗，但前端會補上傳）
        const videoFullPath = path.join(targetDir, filename);
        downloadFile(fileUrl, videoFullPath, pageUrl, cookies || '').then(async (ok) => {
          console.log(`[lurl] 後端備份${ok ? '完成' : '失敗'}: ${filename}${cookies ? ' (有cookie)' : ''}`);

          // 下載成功且是影片且沒有縮圖 → 用 ffmpeg 產生縮圖
          if (ok && type === 'video' && !thumbnailPath) {
            const thumbFilename = `${id}.jpg`;
            const thumbFullPath = path.join(THUMBNAILS_DIR, thumbFilename);
            const thumbOk = await generateVideoThumbnail(videoFullPath, thumbFullPath);
            if (thumbOk) {
              // 更新記錄加入 thumbnailPath
              updateRecordThumbnail(id, `thumbnails/${thumbFilename}`);
            }
          }
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

    // POST /api/upload - 前端上傳 blob（支援分塊上傳，需要 CLIENT_TOKEN）
    if (req.method === 'POST' && urlPath === '/api/upload') {
      if (!isClientAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid client token' }));
        return;
      }
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

    // GET /admin (需要登入)
    if (req.method === 'GET' && urlPath === '/admin') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/admin' });
        res.end();
        return;
      }
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(adminPage());
      return;
    }

    // GET /api/records (需要登入)
    if (req.method === 'GET' && urlPath === '/api/records') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      let records = readAllRecords().reverse(); // 最新的在前
      const type = query.type;
      const q = query.q;
      const page = parseInt(query.page) || 1;
      const limit = parseInt(query.limit) || 50; // 預設每頁 50 筆

      // 先檢查檔案存在狀態
      records = records.map(r => ({
        ...r,
        fileExists: fs.existsSync(path.join(DATA_DIR, r.backupPath))
      }));

      // Blocked filter (預設不顯示封鎖的，除非明確指定)
      const blocked = query.blocked;
      if (blocked === 'true') {
        records = records.filter(r => r.blocked);
      } else if (blocked !== 'all') {
        // 預設：不顯示封鎖的
        records = records.filter(r => !r.blocked);
      }

      // Rating filter
      const rating = query.rating;
      if (rating === 'like') {
        records = records.filter(r => r.rating === 'like');
      } else if (rating === 'dislike') {
        records = records.filter(r => r.rating === 'dislike');
      }

      // Type filter
      if (type === 'pending') {
        // 未下載：只顯示檔案不存在的
        records = records.filter(r => !r.fileExists);
      } else if (type === 'blocked') {
        // 已封鎖的：只顯示 blocked=true (已被上面的 blocked filter 過濾，這裡要重新讀取)
        records = readAllRecords().reverse()
          .map(r => ({ ...r, fileExists: fs.existsSync(path.join(DATA_DIR, r.backupPath)) }))
          .filter(r => r.blocked);
      } else {
        // 全部/影片/圖片：只顯示已下載的
        records = records.filter(r => r.fileExists);
        if (type && type !== 'all') {
          records = records.filter(r => r.type === type);
        }
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

      const total = records.length;
      const totalPages = Math.ceil(total / limit);

      // 分頁
      const start = (page - 1) * limit;
      const paginatedRecords = records.slice(start, start + limit);

      // 只對當前頁加上縮圖狀態
      const recordsWithStatus = paginatedRecords.map(r => ({
        ...r,
        thumbnailExists: r.thumbnailPath ? fs.existsSync(path.join(DATA_DIR, r.thumbnailPath)) : false
      }));

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        records: recordsWithStatus,
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages
      }));
      return;
    }

    // GET /api/version - 腳本版本檢查（公開，不需要驗證）
    if (req.method === 'GET' && urlPath === '/api/version') {
      try {
        const versionFile = path.join(__dirname, 'version.json');
        if (fs.existsSync(versionFile)) {
          const versionConfig = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify(versionConfig));
        } else {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            latestVersion: '0.0.0',
            minVersion: '0.0.0',
            message: '',
            updateUrl: '',
            forceUpdate: false,
            announcement: ''
          }));
        }
      } catch (err) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          latestVersion: '0.0.0',
          minVersion: '0.0.0',
          message: '',
          updateUrl: '',
          forceUpdate: false,
          announcement: ''
        }));
      }
      return;
    }

    // POST /api/version - 更新版本設定（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/version') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const body = await parseBody(req);
        const versionFile = path.join(__dirname, 'version.json');
        const config = {
          latestVersion: body.latestVersion || '0.0.0',
          minVersion: body.minVersion || '0.0.0',
          message: body.message || '',
          updateUrl: body.updateUrl || '',
          forceUpdate: body.forceUpdate || false,
          announcement: body.announcement || ''
        };
        fs.writeFileSync(versionFile, JSON.stringify(config, null, 2));
        console.log('[lurl] 版本設定已更新:', config.latestVersion);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[lurl] 更新版本設定失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/fix-untitled - 修復 untitled 記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/fix-untitled') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }
      try {
        const records = readAllRecords();
        const untitledRecords = records.filter(r => r.title === 'untitled');

        if (untitledRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有需要修復的 untitled 記錄' }));
          return;
        }

        // 讀取所有行
        const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
        const newLines = lines.map(line => {
          try {
            const record = JSON.parse(line);
            if (record.title === 'untitled') {
              // 使用 ID 作為唯一標識
              record.title = `untitled_${record.id}`;
            }
            return JSON.stringify(record);
          } catch (e) {
            return line;
          }
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
        console.log(`[lurl] 已修復 ${untitledRecords.length} 個 untitled 記錄`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, fixed: untitledRecords.length }));
      } catch (err) {
        console.error('[lurl] 修復 untitled 失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/cleanup-duplicates - 清理重複記錄（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/cleanup-duplicates') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        const seen = new Map(); // fileUrl -> record (保留第一個)
        const toRemove = [];

        records.forEach(r => {
          // 優先用 fileUrl 去重，若 fileUrl 相同只保留第一筆
          if (seen.has(r.fileUrl)) {
            toRemove.push(r);
          } else {
            seen.set(r.fileUrl, r);
          }
        });

        if (toRemove.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, removed: 0, message: '沒有重複記錄' }));
          return;
        }

        // 刪除重複記錄的檔案（如果有）
        toRemove.forEach(r => {
          const filePath = path.join(DATA_DIR, r.backupPath);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[lurl] 刪除重複檔案: ${r.backupPath}`);
          }
          if (r.thumbnailPath) {
            const thumbPath = path.join(DATA_DIR, r.thumbnailPath);
            if (fs.existsSync(thumbPath)) {
              fs.unlinkSync(thumbPath);
            }
          }
        });

        // 保留的記錄
        const keepRecords = Array.from(seen.values());
        fs.writeFileSync(RECORDS_FILE, keepRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已清理 ${toRemove.length} 個重複記錄`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ ok: true, removed: toRemove.length }));
      } catch (err) {
        console.error('[lurl] 清理重複失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/repair-paths - 修復重複的 backupPath（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/repair-paths') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();

        // 找出 backupPath 重複的
        const pathCounts = {};
        records.forEach(r => {
          pathCounts[r.backupPath] = (pathCounts[r.backupPath] || 0) + 1;
        });

        const duplicatePaths = new Set(
          Object.entries(pathCounts).filter(([_, count]) => count > 1).map(([p]) => p)
        );

        if (duplicatePaths.size === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, fixed: 0, message: '沒有重複的檔案路徑' }));
          return;
        }

        let fixedCount = 0;
        const updatedRecords = records.map(r => {
          if (duplicatePaths.has(r.backupPath)) {
            // 產生新的唯一檔名
            const ext = path.extname(r.backupPath);
            const folder = r.type === 'video' ? 'videos' : 'images';
            const safeTitle = sanitizeFilename(r.title.replace(/_[a-z0-9]+$/i, '')); // 移除舊的 ID 後綴
            const newFilename = `${safeTitle}_${r.id}${ext}`;
            const newBackupPath = `${folder}/${newFilename}`;

            console.log(`[lurl] 修復路徑: ${r.backupPath} → ${newBackupPath}`);

            fixedCount++;
            return {
              ...r,
              backupPath: newBackupPath,
              fileExists: false, // 標記需要重新下載
            };
          }
          return r;
        });

        // 寫回檔案
        fs.writeFileSync(RECORDS_FILE, updatedRecords.map(r => JSON.stringify(r)).join('\n') + '\n');

        console.log(`[lurl] 已修復 ${fixedCount} 個重複路徑`);
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          fixed: fixedCount,
          message: `已修復 ${fixedCount} 個路徑，請執行「重試失敗下載」重新抓取`
        }));
      } catch (err) {
        console.error('[lurl] 修復路徑失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/generate-thumbnails - 為現有影片產生縮圖（需要 Admin 登入）
    if (req.method === 'POST' && urlPath === '/api/generate-thumbnails') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出有影片檔案但沒縮圖的記錄
        const needThumbnails = records.filter(r => {
          if (r.type !== 'video') return false;
          if (r.thumbnailPath && fs.existsSync(path.join(DATA_DIR, r.thumbnailPath))) return false;
          const videoPath = path.join(DATA_DIR, r.backupPath);
          return fs.existsSync(videoPath);
        });

        if (needThumbnails.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '所有影片都已有縮圖' }));
          return;
        }

        console.log(`[lurl] 開始產生 ${needThumbnails.length} 個縮圖`);

        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: needThumbnails.length,
          message: `開始產生 ${needThumbnails.length} 個縮圖...`
        }));

        // 背景執行
        (async () => {
          let successCount = 0;
          for (let i = 0; i < needThumbnails.length; i++) {
            const record = needThumbnails[i];
            console.log(`[lurl] 產生縮圖 ${i + 1}/${needThumbnails.length}: ${record.id}`);

            const videoPath = path.join(DATA_DIR, record.backupPath);
            const thumbFilename = `${record.id}.jpg`;
            const thumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

            const ok = await generateVideoThumbnail(videoPath, thumbPath);
            if (ok) {
              updateRecordThumbnail(record.id, `thumbnails/${thumbFilename}`);
              successCount++;
            }

            // 間隔避免太快
            if (i < needThumbnails.length - 1) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          console.log(`[lurl] 縮圖產生完成: ${successCount}/${needThumbnails.length}`);
        })().catch(err => {
          console.error('[lurl] 縮圖產生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 縮圖產生失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/retry-failed - 重試下載失敗的檔案（需要 Admin 登入）
    // 使用 Puppeteer 開原頁面，在頁面 context 裡下載 CDN
    if (req.method === 'POST' && urlPath === '/api/retry-failed') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '請先登入' }));
        return;
      }

      if (!lurlRetry) {
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Puppeteer 未安裝，請執行 npm install' }));
        return;
      }

      try {
        const records = readAllRecords();
        // 找出下載失敗的記錄 (fileExists === false 或檔案不存在)
        const failedRecords = records.filter(r => {
          if (r.fileExists === false) return true;
          const filePath = path.join(DATA_DIR, r.backupPath);
          return !fs.existsSync(filePath);
        });

        if (failedRecords.length === 0) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({ ok: true, total: 0, message: '沒有需要重試的失敗記錄' }));
          return;
        }

        console.log(`[lurl] 開始用 Puppeteer 重試 ${failedRecords.length} 個失敗記錄`);

        // 非同步處理，先回傳
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          total: failedRecords.length,
          message: `開始重試 ${failedRecords.length} 個失敗記錄，處理中...`
        }));

        // 背景執行重試 - 用 Puppeteer 在頁面 context 下載
        (async () => {
          const result = await lurlRetry.batchRetry(failedRecords, DATA_DIR, (current, total, record) => {
            console.log(`[lurl] 重試進度: ${current}/${total} - ${record.id}`);
          });

          // 更新記錄的 fileExists 狀態
          if (result.successCount > 0) {
            const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n').filter(l => l.trim());
            const newLines = lines.map(line => {
              try {
                const rec = JSON.parse(line);
                if (result.successIds.includes(rec.id)) {
                  rec.fileExists = true;
                  rec.retrySuccess = true;
                  rec.retriedAt = new Date().toISOString();
                }
                return JSON.stringify(rec);
              } catch (e) {
                return line;
              }
            });
            fs.writeFileSync(RECORDS_FILE, newLines.join('\n') + '\n');
          }

          console.log(`[lurl] 重試完成: 成功 ${result.successCount}/${result.total}`);
        })().catch(err => {
          console.error('[lurl] 重試過程發生錯誤:', err);
        });

      } catch (err) {
        console.error('[lurl] 重試失敗:', err);
        res.writeHead(500, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // GET /api/retry-status - 取得失敗記錄數量
    if (req.method === 'GET' && urlPath === '/api/retry-status') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const records = readAllRecords();
      const failedRecords = records.filter(r => {
        if (r.fileExists === false) return true;
        const filePath = path.join(DATA_DIR, r.backupPath);
        return !fs.existsSync(filePath);
      });
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        failed: failedRecords.length,
        puppeteerAvailable: !!lurlRetry
      }));
      return;
    }

    // GET /api/stats (需要登入)
    if (req.method === 'GET' && urlPath === '/api/stats') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
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

    // DELETE /api/records/:id (需要登入)
    if (req.method === 'DELETE' && urlPath.startsWith('/api/records/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
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

    // POST /api/records/:id/vote (需要登入) - 投票（計數版）
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/vote$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const vote = body.vote; // 'like' | 'dislike'

      if (vote !== 'like' && vote !== 'dislike') {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Invalid vote value' }));
        return;
      }

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      const oldVote = record.myVote || null;

      // 初始化計數（舊記錄可能沒有）
      if (typeof record.likeCount !== 'number') record.likeCount = 0;
      if (typeof record.dislikeCount !== 'number') record.dislikeCount = 0;

      // 投票邏輯
      if (vote === oldVote) {
        // 點同一個 = 取消投票
        record.myVote = null;
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
      } else {
        // 點不同的 = 切換投票
        if (oldVote === 'like') record.likeCount = Math.max(0, record.likeCount - 1);
        if (oldVote === 'dislike') record.dislikeCount = Math.max(0, record.dislikeCount - 1);
        if (vote === 'like') record.likeCount++;
        if (vote === 'dislike') record.dislikeCount++;
        record.myVote = vote;
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      console.log(`[lurl] 投票更新: ${record.title} -> ${record.myVote} (👍${record.likeCount} 👎${record.dislikeCount})`);
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        likeCount: record.likeCount,
        dislikeCount: record.dislikeCount,
        myVote: record.myVote
      }));
      return;
    }

    // POST /api/records/:id/block (需要登入) - 封鎖/解除封鎖
    if (req.method === 'POST' && urlPath.match(/^\/api\/records\/[^/]+\/block$/)) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
      const id = urlPath.split('/')[3];
      const body = await parseBody(req);
      const block = body.block; // true | false

      const records = readAllRecords();
      const recordIndex = records.findIndex(r => r.id === id);

      if (recordIndex === -1) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: '記錄不存在' }));
        return;
      }

      const record = records[recordIndex];
      let deleted = false;

      if (block) {
        // 封鎖：刪除本地檔案和縮圖，保留記錄
        record.blocked = true;
        record.blockedAt = new Date().toISOString();

        // 刪除主檔案
        const filePath = path.join(DATA_DIR, record.backupPath);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted = true;
        }

        // 刪除縮圖
        if (record.thumbnailPath) {
          const thumbPath = path.join(DATA_DIR, record.thumbnailPath);
          if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
          }
        }

        record.fileExists = false;
        console.log(`[lurl] 封鎖: ${record.title}`);
      } else {
        // 解除封鎖：清除封鎖狀態
        record.blocked = false;
        record.blockedAt = null;
        record.fileExists = false; // 需要重新下載
        console.log(`[lurl] 解除封鎖: ${record.title}`);
      }

      fs.writeFileSync(RECORDS_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ ok: true, deleted }));
      return;
    }

    // GET /api/blocked-urls (Client Token 驗證) - 給 Userscript 的封鎖清單
    if (req.method === 'GET' && urlPath === '/api/blocked-urls') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '');

      if (token !== CLIENT_TOKEN && !isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }

      const records = readAllRecords();
      const blockedUrls = records
        .filter(r => r.blocked)
        .map(r => r.fileUrl);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        urls: blockedUrls,
        count: blockedUrls.length,
        updatedAt: new Date().toISOString()
      }));
      return;
    }

    // ==================== 修復服務 API ====================

    // GET /api/check-backup - 檢查是否有備份（公開，用 visitorId）
    if (req.method === 'GET' && urlPath === '/api/check-backup') {
      const pageUrl = query.url;
      const visitorId = req.headers['x-visitor-id'];

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing url parameter' }));
        return;
      }

      // 從 URL 提取 ID（尾部），例如 https://lurl.cc/B0Fe7 → B0Fe7
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();

      const records = readAllRecords();

      // 用 ID 匹配（大小寫不敏感），而非完整 URL
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      // 檢查本地檔案是否存在
      const localFilePath = path.join(DATA_DIR, record.backupPath);
      const fileExists = fs.existsSync(localFilePath);

      if (!fileExists) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({ hasBackup: false }));
        return;
      }

      const backupUrl = `/lurl/files/${record.backupPath}`;

      // 檢查是否已修復過（不扣點直接給 URL）
      if (visitorId) {
        const recoveredEntry = hasRecovered(visitorId, urlId);
        if (recoveredEntry) {
          res.writeHead(200, corsHeaders());
          res.end(JSON.stringify({
            hasBackup: true,
            alreadyRecovered: true,
            backupUrl,
            record: {
              id: record.id,
              title: record.title,
              type: record.type
            }
          }));
          return;
        }
      }

      // 取得額度資訊
      const quota = visitorId ? getVisitorQuota(visitorId) : { usedCount: 0, freeQuota: FREE_QUOTA, paidQuota: 0 };
      const remaining = getRemainingQuota(quota);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        hasBackup: true,
        alreadyRecovered: false,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining,
          total: quota.freeQuota + quota.paidQuota
        }
      }));
      return;
    }

    // POST /api/recover - 執行修復（消耗額度，冪等性：已修復過不重複扣點）
    if (req.method === 'POST' && urlPath === '/api/recover') {
      const visitorId = req.headers['x-visitor-id'];
      const body = await parseBody(req);
      const pageUrl = body.pageUrl;

      if (!visitorId) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing X-Visitor-Id header' }));
        return;
      }

      if (!pageUrl) {
        res.writeHead(400, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Missing pageUrl' }));
        return;
      }

      // 找備份（用 ID 匹配，大小寫不敏感）
      const urlId = pageUrl.split('/').pop().split('?')[0].toLowerCase();
      const records = readAllRecords();
      const record = records.find(r => {
        if (r.blocked) return false;
        const recordId = r.pageUrl.split('/').pop().split('?')[0].toLowerCase();
        return recordId === urlId;
      });

      if (!record) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'No backup found' }));
        return;
      }

      const localFilePath = path.join(DATA_DIR, record.backupPath);
      if (!fs.existsSync(localFilePath)) {
        res.writeHead(404, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Backup file not found' }));
        return;
      }

      const backupUrl = `/lurl/files/${record.backupPath}`;

      // 冪等性：檢查是否已修復過
      const recoveredEntry = hasRecovered(visitorId, urlId);
      if (recoveredEntry) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: true,
          alreadyRecovered: true,
          backupUrl,
          record: {
            id: record.id,
            title: record.title,
            type: record.type
          }
        }));
        return;
      }

      // 檢查額度
      const quota = getVisitorQuota(visitorId);
      const remaining = getRemainingQuota(quota);

      if (remaining <= 0) {
        res.writeHead(200, corsHeaders());
        res.end(JSON.stringify({
          ok: false,
          error: 'quota_exhausted',
          message: '免費額度已用完'
        }));
        return;
      }

      // 扣額度（帶入 urlId 和 backupUrl）
      const newQuota = useQuota(visitorId, pageUrl, urlId, backupUrl);
      const newRemaining = getRemainingQuota(newQuota);

      console.log(`[lurl] 修復服務: ${record.title} (visitor: ${visitorId.substring(0, 8)}..., 剩餘: ${newRemaining})`);

      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({
        ok: true,
        backupUrl: `/lurl/files/${record.backupPath}`,
        record: {
          id: record.id,
          title: record.title,
          type: record.type
        },
        quota: {
          remaining: newRemaining,
          total: newQuota.freeQuota + newQuota.paidQuota
        }
      }));
      return;
    }

    // ==================== Phase 3 ====================

    // GET /browse (需要登入)
    if (req.method === 'GET' && urlPath === '/browse') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/lurl/login?redirect=/lurl/browse' });
        res.end();
        return;
      }
      res.writeHead(200, corsHeaders('text/html; charset=utf-8'));
      res.end(browsePage());
      return;
    }

    // GET /view/:id (需要登入)
    if (req.method === 'GET' && urlPath.startsWith('/view/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { 'Location': `/lurl/login?redirect=/lurl${urlPath}` });
        res.end();
        return;
      }
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

    // POST /api/retry/:id - 重新下載檔案 (需要登入)
    if (req.method === 'POST' && urlPath.startsWith('/api/retry/')) {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(401, corsHeaders());
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
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
