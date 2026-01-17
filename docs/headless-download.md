# Headless Browser 下載方案

## 背景

**所有 CDN 的 URL 都有時效性**（signed URL / token），過期後會 403：

| 狀況 | 結果 |
|-----|------|
| 收到 URL 後立即下載 | ✅ 成功 |
| URL 過期後再下載 | ❌ 403 |

測試證明：
- `lurl5.lurl.cc` 當時下載成功，現在同一個 URL 已經 403
- `lurl8.lurl.cc`, `r2limit2.lurl.cc` 都是 403

**結論**：不是 CDN 的差別，是時間問題。錯過即時下載窗口就需要重新取得有效 URL。

## 解決方案

### 方案 1：前端下載 + 上傳 Blob（推薦）

用戶的瀏覽器本身就在正確的上下文（cookie、session、referer 都對），直接讓 Userscript 下載：

```javascript
// Userscript 端
GM_xmlhttpRequest({
  method: "GET",
  url: fileUrl,
  responseType: "blob",
  onload: (response) => {
    const formData = new FormData();
    formData.append("file", response.response, filename);
    formData.append("id", recordId);

    // 上傳到後端
    fetch("https://epi.isnowfriend.com/lurl/api/upload", {
      method: "POST",
      body: formData
    });
  }
});
```

```javascript
// Server 端 - POST /api/upload
// 接收 multipart/form-data，存到對應目錄
```

**優點**：
- 不需要額外依賴（Puppeteer）
- 用戶的瀏覽器就是真實環境
- 成功率最高

**缺點**：
- 需要用戶停留在頁面上
- 大檔案上傳可能慢

---

### 方案 2：Headless Browser（補救用）

使用 Puppeteer headless browser 模擬真實瀏覽器：

1. 開啟 `pageUrl`（如 `https://lurl.cc/qXTYwj`）
2. Headless 會執行 JS、處理 cookies/session
3. 頁面載入後取得實際 video src
4. 在 headless 上下文中下載（此時 auth/token 有效）

## 實作方式

### 方案 A：攔截 Response

```javascript
const puppeteer = require('puppeteer');

async function downloadWithHeadless(pageUrl, fileUrl, destPath) {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // 監聽 response，攔截目標檔案
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('.mp4') || url.includes('.mov')) {
      const buffer = await response.buffer();
      fs.writeFileSync(destPath, buffer);
    }
  });

  await page.goto(pageUrl, { waitUntil: 'networkidle2' });
  await browser.close();
}
```

### 方案 B：CDP 下載

```javascript
async function downloadWithCDP(pageUrl, destPath) {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // 設定下載路徑
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.dirname(destPath),
  });

  await page.goto(pageUrl, { waitUntil: 'networkidle2' });

  // 點擊下載按鈕或直接觸發下載
  const videoSrc = await page.$eval('video', v => v.src);
  await page.goto(videoSrc); // 觸發下載

  await browser.close();
}
```

## 整合流程

```
POST /capture 或 POST /api/retry/:id
       │
       ▼
   fetch 下載
       │
       ├── 成功 → 完成
       │
       └── 失敗 (403) → 標記 needsHeadless: true
                              │
                              ▼
                    Puppeteer 批次處理
                    或即時 fallback
```

## 待辦

- [ ] 安裝 puppeteer 依賴
- [ ] 實作 `downloadWithHeadless()` 函數
- [ ] 在 fetch 失敗時 fallback 到 headless
- [ ] 測試 `r2limit*.lurl.cc` 下載
- [ ] 測試 `mpr*.myppt.cc` 下載
