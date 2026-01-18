/**
 * Lurl 備援下載模組
 * 用 Puppeteer 開原頁面，模擬 <a download> 點擊下載
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
 * 用 <a download> 方式下載檔案（與腳本 downloadFile 一致）
 * @param {string} pageUrl - 原始頁面 URL (lurl.cc/xxx)
 * @param {string} fileUrl - CDN 檔案 URL
 * @param {string} destPath - 本地儲存路徑
 */
async function downloadInPageContext(pageUrl, fileUrl, destPath) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  // 建立暫存下載目錄
  const downloadDir = path.join(path.dirname(destPath), '.downloads');
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

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

    // 等頁面完全載入
    await new Promise(r => setTimeout(r, 2000));

    console.log(`[lurl-retry] 頁面載入完成，嘗試下載: ${fileUrl}`);

    // 方法1: 用 <a download> 點擊下載（與腳本 downloadFile 完全一致）
    const fileData = await page.evaluate(async (url) => {
      try {
        // 完全照抄腳本的 downloadFile 邏輯
        const response = await fetch(url);

        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }

        const blob = await response.blob();
        const size = blob.size;

        if (size < 1000) {
          return { error: '檔案太小，可能是錯誤頁面' };
        }

        // 轉成 base64 傳回 Node.js
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // 分段轉換避免 stack overflow
        const chunkSize = 32768;
        let binary = '';
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
          binary += String.fromCharCode.apply(null, chunk);
        }

        return {
          success: true,
          data: btoa(binary),
          size: size,
        };
      } catch (err) {
        return { error: err.message };
      }
    }, fileUrl);

    if (fileData.error) {
      console.error(`[lurl-retry] 下載失敗: ${fileData.error}`);

      // 備案：嘗試用 <a download> 觸發下載
      console.log(`[lurl-retry] 嘗試備案：<a download> 方式...`);

      // 設定下載行為
      const client = await page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      // 用 <a download> 觸發下載
      const downloadResult = await page.evaluate((url, filename) => {
        return new Promise((resolve) => {
          try {
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // 給一點時間讓下載開始
            setTimeout(() => resolve({ triggered: true }), 500);
          } catch (err) {
            resolve({ error: err.message });
          }
        });
      }, fileUrl, path.basename(destPath));

      if (downloadResult.triggered) {
        // 等待下載完成（最多 60 秒）
        const downloadedFile = await waitForDownload(downloadDir, 60000);
        if (downloadedFile) {
          // 移動到目標位置
          const finalDir = path.dirname(destPath);
          if (!fs.existsSync(finalDir)) {
            fs.mkdirSync(finalDir, { recursive: true });
          }
          fs.renameSync(downloadedFile, destPath);
          const stats = fs.statSync(destPath);
          console.log(`[lurl-retry] ✅ 備案下載成功: ${destPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          return { success: true, size: stats.size };
        }
      }

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
    // 清理暫存目錄
    try {
      if (fs.existsSync(downloadDir)) {
        const files = fs.readdirSync(downloadDir);
        for (const file of files) {
          fs.unlinkSync(path.join(downloadDir, file));
        }
        fs.rmdirSync(downloadDir);
      }
    } catch (e) {
      // 忽略清理錯誤
    }
  }
}

/**
 * 等待下載完成
 */
async function waitForDownload(downloadDir, timeout = 60000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 1000));

    if (!fs.existsSync(downloadDir)) continue;

    const files = fs.readdirSync(downloadDir);
    // 找到非 .crdownload 的檔案
    const completedFile = files.find(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));

    if (completedFile) {
      return path.join(downloadDir, completedFile);
    }
  }

  return null;
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
