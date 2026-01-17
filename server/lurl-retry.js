/**
 * Lurl 備援下載模組
 * 用 Puppeteer 開原頁面，在頁面 context 裡下載 CDN 檔案
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

let browser = null;

/**
 * 初始化瀏覽器
 */
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    console.log('[lurl-retry] Puppeteer 瀏覽器已啟動');
  }
  return browser;
}

/**
 * 關閉瀏覽器
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('[lurl-retry] Puppeteer 瀏覽器已關閉');
  }
}

/**
 * 在頁面 context 裡下載檔案
 * @param {string} pageUrl - 原始頁面 URL (lurl.cc/xxx)
 * @param {string} fileUrl - CDN 檔案 URL
 * @param {string} destPath - 本地儲存路徑
 */
async function downloadInPageContext(pageUrl, fileUrl, destPath) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  try {
    // 設定 User-Agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log(`[lurl-retry] 開啟頁面: ${pageUrl}`);

    // 載入原始頁面（這樣會有正確的 cookie/session）
    await page.goto(pageUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // 等一下讓頁面完全載入
    await new Promise(r => setTimeout(r, 2000));

    console.log(`[lurl-retry] 頁面載入完成，開始在頁面 context 下載: ${fileUrl}`);

    // 在頁面 context 裡 fetch CDN 檔案
    // 重要：不帶 credentials，CDN 不支持（與腳本一致）
    const fileData = await page.evaluate(async (url) => {
      try {
        // 用最簡單的 fetch，與腳本 downloadAndUpload 一致
        const response = await fetch(url);

        console.log('[lurl-retry] fetch 回應:', response.status);

        if (!response.ok) {
          return { error: `HTTP ${response.status} - ${response.statusText}`, url };
        }

        // 轉成 base64（因為要傳回 Node.js）
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        return {
          success: true,
          data: btoa(binary),
          size: uint8Array.length,
        };
      } catch (err) {
        return { error: err.message };
      }
    }, fileUrl);

    if (fileData.error) {
      console.error(`[lurl-retry] Fetch 錯誤: ${fileData.error} - URL: ${fileUrl}`);
      throw new Error(fileData.error);
    }

    // 確保目錄存在
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 寫入檔案
    const buffer = Buffer.from(fileData.data, 'base64');
    fs.writeFileSync(destPath, buffer);

    console.log(`[lurl-retry] ✅ 下載成功: ${destPath} (${(fileData.size / 1024 / 1024).toFixed(2)} MB)`);

    return { success: true, size: fileData.size };

  } catch (err) {
    console.error(`[lurl-retry] ❌ 下載失敗: ${err.message}`);
    return { success: false, error: err.message };

  } finally {
    await page.close();
  }
}

/**
 * 重試下載單筆記錄
 */
async function retryRecord(record, dataDir) {
  const destPath = path.join(dataDir, record.backupPath);
  return await downloadInPageContext(record.pageUrl, record.fileUrl, destPath);
}

/**
 * 批次重試
 */
async function batchRetry(records, dataDir, onProgress) {
  let successCount = 0;
  const successIds = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    if (onProgress) {
      onProgress(i + 1, records.length, record, null);
    }

    const result = await retryRecord(record, dataDir);

    if (result.success) {
      successCount++;
      successIds.push(record.id);
    }

    // 間隔避免太快
    if (i < records.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 完成後關閉瀏覽器
  await closeBrowser();

  return { successCount, successIds, total: records.length };
}

module.exports = {
  initBrowser,
  closeBrowser,
  downloadInPageContext,
  retryRecord,
  batchRetry,
};
