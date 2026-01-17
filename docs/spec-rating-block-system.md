# 評價與封鎖系統規格

> 版本：v1.0
> 日期：2026-01-18
> 狀態：草稿

---

## 1. 概述

### 目標
- 讓使用者對內容進行評價（讚/倒讚）
- 封鎖不想要的內容，避免重複下載
- 優化 UI，讓維護功能更直觀

### 影響範圍
- `server/lurl.js` - API 端點、資料結構、頁面 UI
- `lurlDownloader.user.js` - 封鎖檢查邏輯

---

## 2. 資料結構變更

### 2.1 Record 新增欄位

```javascript
{
  // 現有欄位
  id: "mkhaw9fq",
  title: "...",
  pageUrl: "https://lurl.cc/xxx",
  fileUrl: "https://cdn.../xxx.mp4",
  type: "video",
  backupPath: "videos/xxx.mp4",
  thumbnailPath: "thumbnails/xxx.jpg",
  fileExists: true,

  // === 新增欄位 ===
  rating: "like" | "dislike" | null,  // 評價狀態
  blocked: false,                      // 是否封鎖
  blockedAt: null                      // 封鎖時間 (ISO string)
}
```

### 2.2 封鎖清單快取（Userscript 用）

Server 提供一個輕量 API 回傳所有已封鎖的 `fileUrl`：

```javascript
// GET /api/blocked-urls
{
  "urls": [
    "https://cdn.../blocked1.mp4",
    "https://cdn.../blocked2.jpg"
  ],
  "count": 2,
  "updatedAt": "2026-01-18T12:00:00Z"
}
```

---

## 3. Server API 變更

### 3.1 評價 API

```
POST /api/records/:id/rate
Content-Type: application/json

{ "rating": "like" | "dislike" | null }

Response:
{ "ok": true }
```

### 3.2 封鎖 API

```
POST /api/records/:id/block
Content-Type: application/json

{ "block": true }  // true=封鎖, false=解除封鎖

Response:
{ "ok": true, "deleted": true }  // deleted 表示有刪除本地檔案
```

**封鎖時執行**：
1. 設定 `blocked: true`, `blockedAt: new Date().toISOString()`
2. 刪除本地檔案 (`backupPath`)
3. 刪除縮圖 (`thumbnailPath`)
4. 保留 JSONL 記錄（用於後續阻擋）

**解除封鎖時執行**：
1. 設定 `blocked: false`, `blockedAt: null`
2. 設定 `fileExists: false`（需要重新下載）

### 3.3 封鎖清單 API（給 Userscript）

```
GET /api/blocked-urls
Authorization: Bearer {CLIENT_TOKEN}

Response:
{
  "urls": ["https://...", "https://..."],
  "count": 123,
  "updatedAt": "2026-01-18T12:00:00Z"
}
```

### 3.4 修改現有 API

#### GET /api/records
新增 query 參數：
- `blocked=false` - 預設不顯示封鎖的
- `blocked=true` - 只顯示封鎖的
- `rating=like` - 只顯示讚的

#### POST /capture
新增封鎖檢查：
```javascript
// 檢查 fileUrl 是否已被封鎖
const blockedRecord = existingRecords.find(r => r.fileUrl === fileUrl && r.blocked);
if (blockedRecord) {
  return { ok: true, blocked: true, message: '此內容已被封鎖' };
}
```

---

## 4. Userscript 變更

### 4.1 封鎖清單快取

```javascript
const BlockedCache = {
  urls: new Set(),
  lastFetch: 0,
  CACHE_DURATION: 5 * 60 * 1000, // 5 分鐘快取

  async refresh() {
    if (Date.now() - this.lastFetch < this.CACHE_DURATION) return;

    try {
      const res = await GM_xmlhttpRequest({
        method: 'GET',
        url: `${API_BASE}/api/blocked-urls`,
        headers: { 'Authorization': `Bearer ${CLIENT_TOKEN}` }
      });
      const data = JSON.parse(res.responseText);
      this.urls = new Set(data.urls);
      this.lastFetch = Date.now();
    } catch (e) {
      console.error('[lurl] 無法取得封鎖清單:', e);
    }
  },

  isBlocked(fileUrl) {
    return this.urls.has(fileUrl);
  }
};
```

### 4.2 Capture 前檢查

```javascript
// 在 sendToAPI 之前
await BlockedCache.refresh();
if (BlockedCache.isBlocked(fileUrl)) {
  console.log('[lurl] 跳過已封鎖內容:', fileUrl);
  return; // 不發送 API
}
```

### 4.3 效率考量

| 方案 | 優點 | 缺點 |
|------|------|------|
| 每次 capture 都查 API | 即時準確 | 多一次 API call |
| 本地快取封鎖清單 | 減少 API call | 5 分鐘內的新封鎖可能漏掉 |
| Server 在 capture 回傳封鎖狀態 | 不需額外 API | 已經發送請求了才知道 |

**建議採用**：本地快取 + Server 雙重檢查
1. Userscript 快取封鎖清單，本地先過濾（減少無效請求）
2. Server capture 時再次檢查（確保準確）

---

## 5. UI 變更

### 5.1 Admin 維護面板改橫向

```html
<div class="maintenance-grid">
  <div class="maintenance-item">
    <span class="icon">🔧</span>
    <span class="label">修復 Untitled</span>
    <button onclick="fixUntitled()">執行</button>
    <span class="status" id="untitledStatus"></span>
  </div>
  <div class="maintenance-item">
    <span class="icon">🔄</span>
    <span class="label">重試下載</span>
    <button onclick="retryFailed()">執行</button>
    <span class="status" id="retryStatus"></span>
  </div>
  <!-- ... 其他按鈕 ... -->
</div>
```

```css
.maintenance-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 15px;
}
.maintenance-item {
  background: #2a2a2a;
  padding: 15px;
  border-radius: 8px;
  text-align: center;
}
```

### 5.2 Browse 卡片新增評價按鈕

```html
<div class="card">
  <div class="card-thumb">...</div>
  <div class="card-info">
    <div class="card-title">...</div>
    <div class="card-meta">...</div>
    <div class="card-actions">
      <button class="btn-rate like" onclick="rate('${id}', 'like')">👍</button>
      <button class="btn-rate dislike" onclick="rate('${id}', 'dislike')">👎</button>
      <button class="btn-block" onclick="block('${id}')">🚫</button>
    </div>
  </div>
</div>
```

```css
.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.btn-rate, .btn-block {
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: #333;
}
.btn-rate:hover { background: #444; }
.btn-rate.active.like { background: #4CAF50; }
.btn-rate.active.dislike { background: #f44336; }
.btn-block:hover { background: #c62828; }
```

### 5.3 Browse 新增 Tab

```html
<div class="tabs">
  <button class="tab" data-type="all">全部</button>
  <button class="tab" data-type="video">影片</button>
  <button class="tab" data-type="image">圖片</button>
  <button class="tab" data-type="pending">未下載</button>
  <button class="tab" data-type="liked">❤️ 喜歡</button>
  <button class="tab" data-type="blocked">🚫 已封鎖</button>
</div>
```

---

## 6. 成本與效能分析

### API 呼叫次數

| 情境 | 現在 | 改後 |
|------|------|------|
| 開啟頁面 | 1 次 capture | 1 次 capture |
| 封鎖檢查 | 無 | +1 次 /api/blocked-urls（每 5 分鐘） |
| 評價操作 | 無 | +1 次 /api/records/:id/rate |
| 封鎖操作 | 無 | +1 次 /api/records/:id/block |

### 資料大小估算

假設封鎖 1000 個項目：
- 每個 fileUrl 約 80 bytes
- 總計 80KB（gzip 後約 15KB）
- 每 5 分鐘傳一次，可接受

### 效能優化建議

1. **封鎖清單分頁**：若超過 10000 筆，改用 bloom filter 或分頁
2. **ETag 快取**：Server 回傳 ETag，Userscript 用 If-None-Match 避免重複下載
3. **WebSocket**：未來可改用 WebSocket 即時推送封鎖更新

---

## 7. 實作順序

1. [ ] Server: 新增 rating/blocked 欄位處理
2. [ ] Server: 新增 API 端點 (rate, block, blocked-urls)
3. [ ] Server: 修改 /api/records 支援 blocked/rating 過濾
4. [ ] Server: 修改 capture 檢查封鎖
5. [ ] Server: Admin 維護面板改橫向
6. [ ] Server: Browse 卡片加評價/封鎖按鈕
7. [ ] Server: Browse 新增 Tab (喜歡/已封鎖)
8. [ ] Userscript: 新增 BlockedCache
9. [ ] Userscript: capture 前檢查封鎖
10. [ ] 測試與同步兩個 repo

---

## 8. 未來擴充

- 標籤系統 (tags)
- 收藏夾 (collections)
- 批次操作
- 匯出/匯入評價資料
