# CDN 防盜鏈繞過筆記

> 日期：2026/01/17
> 專案：lurl-download-userscript
> 目標：從 lurl.cc / myppt.cc 備份影片到自己的伺服器

---

## 問題描述

想要在用戶瀏覽 lurl.cc 影片時，自動備份到我們的後端伺服器。

---

## 踩過的坑

### 坑 1：後端直接 fetch CDN URL → 403

```javascript
// server 端
const response = await fetch(cdnUrl);  // 403 Forbidden
```

**原因**：CDN 檢查 Referer、Sec-Fetch-Site 等 headers

---

### 坑 2：加上偽造 headers 還是 403

```javascript
const headers = {
  'Referer': 'https://lurl.cc/',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': 'Mozilla/5.0...',
};
const response = await fetch(cdnUrl, { headers });  // 還是 403
```

**原因**：CDN 使用 Cloudflare，需要 `cf_clearance` cookie（通過 JS challenge 才能拿到）

---

### 坑 3：Userscript 用 GM_xmlhttpRequest 下載 → 403

```javascript
GM_xmlhttpRequest({
  method: "GET",
  url: cdnUrl,
  responseType: "arraybuffer",
  // ...
});  // 403
```

**原因**：GM_xmlhttpRequest 是 Tampermonkey 的獨立 context，不共享頁面的 cookies

---

### 坑 4：Userscript 用 fetch + credentials: "include" → CORS 錯誤

```javascript
const response = await fetch(cdnUrl, {
  credentials: "include",
  mode: "cors",
});
// Error: Access-Control-Allow-Credentials header must be 'true'
```

**原因**：`credentials: "include"` 觸發 CORS 預檢請求，CDN 不回 `Access-Control-Allow-Credentials: true`

---

## 關鍵發現

### 測試 1：在 lurl.cc 頁面 console 直接 fetch

```javascript
fetch("https://lurl3.lurl.cc/.../video.mov")
  .then(r => console.log(r.status))
// 結果：200 OK！
```

**重要發現**：不加 credentials 就能成功！

### 測試 2：比較成功 vs 失敗的 curl

**成功**（從 lurl.cc iframe 發起）：
```
-H "referer: https://lurl.cc/"
-H "sec-fetch-site: same-site"
-b "cf_clearance=..."
```

**失敗**（從其他 origin 發起）：
```
-H "referer: https://epi.isnowfriend.com/"
-H "sec-fetch-site: cross-site"
```

**關鍵**：
1. Referer 必須是 `lurl.cc`
2. sec-fetch-site 必須是 `same-site`
3. 但如果是**同頁面的 fetch**（不帶 credentials），瀏覽器會自動處理這些

---

## 最終解決方案

### 架構

```
用戶瀏覽器 (lurl.cc 頁面)
    │
    ├─ Userscript 偵測到影片
    │
    ├─ 呼叫 /capture API 回報 metadata
    │       └─ Server 返回 { ok: true, id: "xxx", needUpload: true }
    │
    ├─ 用頁面原生 fetch 下載 CDN 檔案（無 credentials）
    │       └─ 瀏覽器在正確 context，自動帶正確 headers
    │
    └─ 用 GM_xmlhttpRequest 上傳到我們的 /api/upload
            └─ Server 存檔
```

### 關鍵程式碼

**Userscript（v4.1）**：
```javascript
downloadAndUpload: async (fileUrl, recordId) => {
  // 關鍵：不加 credentials！
  const response = await fetch(fileUrl);

  if (!response.ok) return;

  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();

  // 上傳用 GM_xmlhttpRequest（避免 CORS）
  GM_xmlhttpRequest({
    method: "POST",
    url: "https://our-server/api/upload",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Record-Id": recordId,
    },
    data: arrayBuffer,
    // ...
  });
}
```

### 重複 URL 處理

Server 檢查：記錄存在但檔案不存在 → 還是返回 `needUpload: true`

```javascript
if (duplicate) {
  const fileExists = fs.existsSync(filePath);
  if (!fileExists) {
    // 讓前端再次上傳
    res.end(JSON.stringify({ ok: true, duplicate: true, id: duplicate.id, needUpload: true }));
  }
}
```

---

## 心得總結

| 方法 | 結果 | 原因 |
|-----|------|------|
| 後端 fetch | ❌ 403 | 沒有 cf_clearance cookie |
| 後端 fetch + 偽造 headers | ❌ 403 | Cloudflare 驗證 |
| GM_xmlhttpRequest | ❌ 403 | 獨立 context，無頁面 cookies |
| fetch + credentials | ❌ CORS | CDN 不支持 credentials 模式 |
| **fetch（無 credentials）** | ✅ 200 | 簡單請求，瀏覽器處理 |

### 核心原理

1. **Cloudflare 防盜鏈**：檢查 cf_clearance cookie + Referer + Sec-Fetch-Site
2. **瀏覽器同源策略**：頁面內的 fetch 自動帶正確 context
3. **CORS 簡單請求**：不加 credentials 就不需要預檢
4. **利用用戶瀏覽器**：用戶是「合法觀看者」，借用他的 context 來下載

### 這算逆向嗎？

算是**網路層面的逆向工程**：
- 分析 CDN 的防盜鏈機制（Cloudflare、Referer 檢查）
- 找出瀏覽器 context 的特殊性
- 利用「簡單請求」繞過 CORS 預檢
- 最終實現「用戶看就順便幫我們下載」

不是傳統的二進制逆向，而是 **HTTP 協議 + 瀏覽器安全模型** 的逆向分析。

---

## 未來可能的坑

1. CDN 改成不允許跨域（目前允許）
2. Cloudflare 加強檢測（檢查更多 headers）
3. URL 時效性更短（要在用戶瀏覽時立即下載）

---

## 版本歷程

- v3.8：嘗試 GM_xmlhttpRequest 下載 → 403
- v3.9：改用 fetch + credentials → CORS 錯誤
- v4.0：修復重複 URL 邏輯
- v4.1：移除 credentials → **成功！**
