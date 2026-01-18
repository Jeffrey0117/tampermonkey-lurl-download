/**
 * Lurl 備援下載模組
 * 用 Puppeteer 在頁面 context 下載 CDN 檔案
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

let browser = null;

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

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('[lurl-retry] Puppeteer 瀏覽器已關閉');
  }
}

/**
 * 下載檔案
 */
async function downloadInPageContext(pageUrl, fileUrl, destPath) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log(`[lurl-retry] 開啟頁面: ${pageUrl}`);

    // Debug: 監聽各種事件
    page.on('framenavigated', frame => {
      console.log(`[lurl-retry] framenavigated: ${frame.url().substring(0, 60)}`);
    });
    page.on('load', () => console.log('[lurl-retry] 事件: load'));
    page.on('domcontentloaded', () => console.log('[lurl-retry] 事件: domcontentloaded'));
    page.on('error', err => console.log(`[lurl-retry] 頁面錯誤: ${err.message}`));

    // 導航到具體頁面
    try {
      const response = await page.goto(pageUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      console.log(`[lurl-retry] 頁面載入完成, status: ${response?.status()}, url: ${page.url()}`);
    } catch (e) {
      console.log(`[lurl-retry] 頁面載入異常: ${e.message}`);
    }

    // 等頁面穩定
    await new Promise(r => setTimeout(r, 2000));
    console.log(`[lurl-retry] 當前 URL: ${page.url()}`);

    console.log(`[lurl-retry] 開始下載: ${fileUrl.substring(0, 60)}...`);

    // 在頁面 context 中下載 - 與腳本 downloadAndUpload 完全一致
    // 重點：簡單的 fetch(url)，不帶任何額外參數
    const result = await page.evaluate(async (cdnUrl) => {
      try {
        const response = await fetch(cdnUrl);

        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }

        const blob = await response.blob();

        if (blob.size < 1000) {
          return { error: `檔案太小: ${blob.size} bytes` };
        }

        // 轉 base64
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        // 分段處理避免 call stack 問題
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }

        return {
          success: true,
          data: btoa(binary),
          size: blob.size,
        };
      } catch (err) {
        return { error: err.message };
      }
    }, fileUrl);

    if (result.error) {
      throw new Error(result.error);
    }

    // 寫入檔案
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const buffer = Buffer.from(result.data, 'base64');
    fs.writeFileSync(destPath, buffer);

    console.log(`[lurl-retry] ✅ 下載成功: ${destPath} (${(result.size / 1024 / 1024).toFixed(2)} MB)`);
    return { success: true, size: result.size };

  } catch (err) {
    console.error(`[lurl-retry] ❌ 失敗: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}

async function retryRecord(record, dataDir) {
  const destPath = path.join(dataDir, record.backupPath);
  return await downloadInPageContext(record.pageUrl, record.fileUrl, destPath);
}

async function batchRetry(records, dataDir, onProgress) {
  let successCount = 0;
  const successIds = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (onProgress) onProgress(i + 1, records.length, record, null);

    const result = await retryRecord(record, dataDir);
    if (result.success) {
      successCount++;
      successIds.push(record.id);
    }

    if (i < records.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

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
