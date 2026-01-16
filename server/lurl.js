/**
 * Lurl 影片存檔 API
 * 上傳到 cloudpipe 即可使用，不需額外跑 server
 *
 * 端點：
 *   POST /lurl/capture - 接收影片資料並備份
 *   GET  /lurl/health  - 健康檢查
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

// 資料存放位置（相對於 cloudpipe 根目錄）
const DATA_DIR = path.join(__dirname, '..', 'data', 'lurl');
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

// 確保資料夾存在
function ensureDirs() {
  [DATA_DIR, VIDEOS_DIR, IMAGES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// 清理檔名
function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

// 下載檔案
async function downloadFile(url, destPath) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const fileStream = fs.createWriteStream(destPath);
    await pipeline(response.body, fileStream);
    return true;
  } catch (err) {
    console.error(`[lurl] 下載失敗: ${url}`, err.message);
    return false;
  }
}

// 存記錄
function appendRecord(record) {
  ensureDirs();
  fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n', 'utf8');
}

// 解析 JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// CORS headers
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

module.exports = {
  match(req) {
    return req.url.startsWith('/lurl');
  },

  async handle(req, res) {
    const urlPath = req.url.replace(/^\/lurl/, '') || '/';

    console.log(`[lurl] ${req.method} ${urlPath}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // GET /health - 健康檢查
    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, corsHeaders());
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // POST /capture - 接收資料
    if (req.method === 'POST' && urlPath === '/capture') {
      try {
        const { title, pageUrl, fileUrl, type = 'video' } = await parseBody(req);

        // 驗證
        if (!title || !pageUrl || !fileUrl) {
          res.writeHead(400, corsHeaders());
          res.end(JSON.stringify({ ok: false, error: '缺少必要欄位' }));
          return;
        }

        // 準備存檔
        ensureDirs();
        const ext = type === 'video' ? '.mp4' : '.jpg';
        const safeTitle = sanitizeFilename(title);
        const filename = `${safeTitle}${ext}`;
        const targetDir = type === 'video' ? VIDEOS_DIR : IMAGES_DIR;
        const backupPath = path.join(type === 'video' ? 'videos' : 'images', filename);

        // 建立記錄
        const record = {
          title,
          pageUrl,
          fileUrl,
          type,
          source: 'lurl',
          capturedAt: new Date().toISOString(),
          backupPath
        };

        // 存記錄
        appendRecord(record);
        console.log(`[lurl] 記錄已存: ${title}`);

        // 背景下載
        downloadFile(fileUrl, path.join(targetDir, filename)).then(ok => {
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

    // 404
    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
