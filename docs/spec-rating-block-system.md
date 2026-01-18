# 評價與封鎖系統規格

> 版本：v2.0
> 日期：2026-01-18
> 狀態：討論中

---

## 1. 概述

### 目標
- 讓使用者對內容進行**公開評分**（讚/倒讚計數）
- 支援依照評分排序（熱門內容優先）
- 封鎖不想要的內容，避免重複下載
- 優化 UI，讓維護功能更直觀

### 設計原則
- **評分是計數器**：類似 YouTube 的讚/倒讚，顯示累計數字
- **一人一票**：每個用戶對每個內容只能投一次票
- **可改變選擇**：可以從讚改成倒讚（或反過來）
- **封鎖是個人行為**：封鎖後檔案刪除，記錄保留用於阻擋重複下載

---

## 2. 資料結構

### 2.1 Record 欄位（修正版）

```javascript
{
  // 現有欄位
  id: "mkhaw9fq",
  title: "...",
  pageUrl: "https://lurl.cc/xxx",
  fileUrl: "https://cdn.../xxx.mp4",
  type: "video",
  source: "lurl" | "myppt",
  backupPath: "videos/xxx.mp4",
  thumbnailPath: "thumbnails/xxx.jpg",
  capturedAt: "2026-01-18T12:00:00Z",

  // D卡來源（可選，有此欄位才顯示「返回D卡」按鈕）
  ref: "https://www.dcard.tw/f/sex/p/123456",  // ← 關鍵欄位

  // === 評分欄位（v2.0 修正）===
  likeCount: 0,           // 讚的數量
  dislikeCount: 0,        // 倒讚的數量
  myVote: "like" | "dislike" | null,  // 當前用戶的投票（單機版只有一個用戶）

  // === 封鎖欄位 ===
  blocked: false,
  blockedAt: null
}
```

### 2.2 與 v1.0 的差異

| v1.0 | v2.0 | 說明 |
|------|------|------|
| `rating: "like"` | `likeCount: 5` | 從狀態改為計數 |
| - | `dislikeCount: 2` | 新增倒讚計數 |
| - | `myVote: "like"` | 記錄當前用戶投票 |

### 2.3 關於 `ref` 欄位（D卡來源）

**問題**：有些影片沒有「返回D卡」按鈕

**原因**：
- `ref` 欄位只在從 D卡 點進 lurl/myppt 時才會傳遞
- 如果用戶直接開 lurl.cc 頁面（不是從 D卡來的），就不會有 `ref`
- 早期版本可能沒有記錄這個欄位

**解法**：
- View 頁面：只在 `ref` 存在時顯示「返回D卡」按鈕
- 目前已實作（需確認）

---

## 3. UI 變更

### 3.1 Browse 頁面 Tab（修正版）

```
[全部] [影片] [圖片] [未下載] [🚫 已封鎖]
                              ↑ 移除「喜歡」Tab
```

**移除「喜歡」Tab 的原因**：
- 評分是公開計數，不是個人收藏
- 改用「排序」功能來找熱門內容

### 3.2 排序功能（新增）

```html
<div class="sort-bar">
  <select id="sortBy">
    <option value="newest">最新</option>
    <option value="oldest">最舊</option>
    <option value="popular">最多讚</option>
    <option value="controversial">最多倒讚</option>
  </select>
</div>
```

### 3.3 卡片評分顯示（修正版）

```
┌─────────────────────────────┐
│  [縮圖]                      │
├─────────────────────────────┤
│  標題                        │
│  2026/01/18  #mkhaw9        │
│                              │
│  👍 12   👎 3   [🚫]         │  ← 顯示計數
│  ──────────────────         │
│  [我的讚是亮的]              │  ← 如果投過票，按鈕高亮
└─────────────────────────────┘
```

### 3.4 View 頁面「返回D卡」按鈕

```javascript
// 只在 ref 存在時顯示
${record.ref
  ? `<a href="${record.ref}" class="btn btn-secondary" target="_blank">返回D卡</a>`
  : ''}
```

---

## 4. API 變更

### 4.1 評分 API（修正版）

```
POST /api/records/:id/vote
Content-Type: application/json

{ "vote": "like" | "dislike" | null }  // null = 取消投票

Response:
{
  "ok": true,
  "likeCount": 13,      // 更新後的數字
  "dislikeCount": 3,
  "myVote": "like"
}
```

**邏輯**：
```javascript
// 投票邏輯
if (newVote === oldVote) {
  // 取消投票
  myVote = null;
  if (oldVote === 'like') likeCount--;
  if (oldVote === 'dislike') dislikeCount--;
} else {
  // 改變投票
  if (oldVote === 'like') likeCount--;
  if (oldVote === 'dislike') dislikeCount--;
  if (newVote === 'like') likeCount++;
  if (newVote === 'dislike') dislikeCount++;
  myVote = newVote;
}
```

### 4.2 查詢 API 支援排序

```
GET /api/records?sort=popular    // 依讚數排序（高到低）
GET /api/records?sort=newest     // 依時間排序（新到舊，預設）
GET /api/records?sort=oldest     // 依時間排序（舊到新）
```

### 4.3 封鎖 API（不變）

```
POST /api/records/:id/block
{ "block": true }
```

---

## 5. 問題討論

### Q1: 單機 vs 多用戶？

目前是單機系統（只有一個管理員），所以：
- `myVote` 就是唯一用戶的投票
- `likeCount` 最多只會是 0 或 1

**未來如果要多用戶**：
- 需要 `votes` 表記錄每個用戶的投票
- `myVote` 改從 session/cookie 判斷

**建議**：先按單機實作，資料結構預留擴充空間

### Q2: 沒有 ref 的舊記錄怎麼辦？

選項：
1. **不處理** - 舊記錄就是沒有，新記錄會有
2. **批次修復** - 寫腳本從 pageUrl 反推 ref（不可行，因為無法知道當初從哪個 D卡文章來）
3. **手動補充** - 在 View 頁面加「補充 D卡連結」功能

**建議**：選項 1，接受舊記錄沒有 ref

### Q3: 評分要顯示在哪？

- Browse 卡片：顯示 `👍 12  👎 3`
- View 頁面：顯示計數 + 投票按鈕

---

## 6. 修改項目清單

### 需要修改的（對比 v1.0 已實作）

| 項目 | v1.0 已實作 | v2.0 需求 | 動作 |
|------|------------|----------|------|
| 資料結構 | `rating` | `likeCount`, `dislikeCount`, `myVote` | 改 |
| API | `/rate` | `/vote` + 計數邏輯 | 改 |
| Browse Tab | 有「喜歡」Tab | 移除「喜歡」Tab | 刪 |
| 排序功能 | 無 | 依讚數排序 | 新增 |
| 卡片顯示 | 高亮按鈕 | 顯示計數 + 高亮 | 改 |
| D卡按鈕 | ? | 只在 ref 存在時顯示 | 確認 |

### 不需要改的

- 封鎖功能（維持原樣）
- 封鎖清單快取（維持原樣）
- 維護面板橫向 Grid（已完成）

---

## 7. 下一步

請確認：
1. 單機版的 likeCount 最多 0/1，這樣 OK 嗎？
2. 移除「喜歡」Tab，改用排序功能，這樣 OK 嗎？
3. 舊記錄沒有 ref 就接受，不補救，OK 嗎？

確認後我會開始修改實作。
