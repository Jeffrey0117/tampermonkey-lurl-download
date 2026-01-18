/**
 * Lurl 備援下載模組
 * 用 puppeteer-extra + stealth 繞過 Cloudflare
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// 使用 stealth 插件隱藏 Puppeteer 特徵
puppeteer.use(StealthPlugin());

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

    console.log(`[lurl-retry] 開啟頁面: ${pageUrl}`);

    // 導航到具體頁面
    try {
      await page.goto(pageUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      console.log(`[lurl-retry] 頁面載入完成: ${page.url()}`);
    } catch (e) {
      console.log(`[lurl-retry] 頁面載入: ${e.message.substring(0, 80)}`);
    }

    // 檢查是否被 Cloudflare 擋
    const currentUrl = page.url();
    if (currentUrl.includes('challenges.cloudflare.com')) {
      console.log('[lurl-retry] 偵測到 Cloudflare 驗證，等待通過...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      console.log(`[lurl-retry] 驗證後 URL: ${page.url()}`);
    }

    // 等頁面穩定
    await new Promise(r => setTimeout(r, 2000));

    console.log(`[lurl-retry] 開始下載: ${fileUrl.substring(0, 60)}...`);

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
