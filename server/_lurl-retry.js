/**
 * Lurl 備援下載模組
 * 用 puppeteer-extra + stealth 繞過 Cloudflare
 * 支援並行下載加速
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// 使用 stealth 插件隱藏 Puppeteer 特徵
puppeteer.use(StealthPlugin());

let browser = null;

// 並發數量（同時開幾個 tab）
const CONCURRENCY = 4;

async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    console.log('[lurl-retry] Puppeteer (stealth) 瀏覽器已啟動');
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

async function downloadInPageContext(pageUrl, fileUrl, destPath) {
  const browser = await initBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 設定 over18 cookie（年齡驗證）
    const domain = pageUrl.includes('myppt.cc') ? '.myppt.cc' : '.lurl.cc';
    await page.setCookie({
      name: 'over18_years',
      value: 'true',
      domain: domain,
      path: '/',
    });

    // 導航到具體頁面（減少 log 輸出）
    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded', // 改用 domcontentloaded，比 networkidle2 快
        timeout: 20000,
      });
    } catch (e) {
      // 忽略 timeout，繼續嘗試下載
    }

    // 檢查是否被 Cloudflare 擋
    const currentUrl = page.url();
    if (currentUrl.includes('challenges.cloudflare.com')) {
      console.log('[lurl-retry] Cloudflare 驗證中...');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    // 等頁面穩定（減少到 500ms）
    await new Promise(r => setTimeout(r, 500));

    // 在頁面 context 中下載
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

        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

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

    console.log(`[lurl-retry] ✅ ${path.basename(destPath)} (${(result.size / 1024 / 1024).toFixed(2)} MB)`);
    return { success: true, size: result.size };

  } catch (err) {
    console.error(`[lurl-retry] ❌ ${path.basename(destPath)}: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}

async function retryRecord(record, dataDir) {
  const destPath = path.join(dataDir, record.backupPath);
  return await downloadInPageContext(record.pageUrl, record.fileUrl, destPath);
}

/**
 * 並行批次重試
 * @param {Array} records - 要重試的記錄
 * @param {string} dataDir - 資料目錄
 * @param {Function} onProgress - 進度回調 (completed, total, record, result)
 * @param {number} concurrency - 並發數量（預設 4）
 */
async function batchRetry(records, dataDir, onProgress, concurrency = CONCURRENCY) {
  let successCount = 0;
  const successIds = [];
  let completed = 0;

  console.log(`[lurl-retry] 開始並行下載 ${records.length} 個檔案（並發數: ${concurrency}）`);

  // 分批處理
  const chunks = [];
  for (let i = 0; i < records.length; i += concurrency) {
    chunks.push(records.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    // 並行處理這批
    const promises = chunk.map(async (record) => {
      const result = await retryRecord(record, dataDir);
      completed++;

      if (result.success) {
        successCount++;
        successIds.push(record.id);
      }

      if (onProgress) {
        onProgress(completed, records.length, record, result);
      }

      return { record, result };
    });

    await Promise.all(promises);
  }

  await closeBrowser();
  console.log(`[lurl-retry] 完成！成功: ${successCount}/${records.length}`);
  return { successCount, successIds, total: records.length };
}

module.exports = {
  initBrowser,
  closeBrowser,
  downloadInPageContext,
  retryRecord,
  batchRetry,
  CONCURRENCY,
};
