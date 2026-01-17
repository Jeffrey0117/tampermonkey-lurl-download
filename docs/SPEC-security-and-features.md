# Lurl 安全性與功能規格

## 優先級

| 優先級 | 任務 | 風險 |
|--------|------|------|
| P0 | API 安全性保護 | 資料可能被惡意刪除 |
| P1 | 數據清洗 | 佔用空間、資料混亂 |
| P2 | 用戶統計功能 | 無風險，純功能 |
| P3 | ffmpeg 縮圖生成 | 無風險，純功能 |

---

## P0: API 安全性保護

### 問題
- `/lurl/admin` 任何人都可以訪問
- `/lurl/api/records/:id` DELETE 任何人都可以調用
- `/lurl/browse` 內容公開（這個可能是預期的？）

### 方案：API Token 驗證

#### 1. 管理員 Token
```
環境變數或配置文件：
LURL_ADMIN_TOKEN=<random-32-char-string>
```

#### 2. 保護的端點
| 端點 | 保護方式 |
|------|----------|
| GET /admin | 需要 ?token=xxx 或 Cookie |
| DELETE /api/records/:id | 需要 Header: X-Admin-Token |
| GET /api/stats | 需要 Token |
| POST /capture | 需要 X-Client-Token（腳本專用） |

#### 3. 腳本端 Token
- userscript 內建一個 `CLIENT_TOKEN`
- POST /capture 時帶上 `X-Client-Token` header
- Server 驗證 token 才接受上傳

#### 4. Admin 登入流程
```
訪問 /admin
    ↓
顯示簡單密碼輸入框
    ↓
驗證成功 → 設置 Cookie (lurl_admin_session)
    ↓
後續請求檢查 Cookie
```

#### 5. 實作細節

**Server 端：**
```javascript
// 配置
const ADMIN_TOKEN = process.env.LURL_ADMIN_TOKEN || 'change-me-in-production';
const CLIENT_TOKEN = process.env.LURL_CLIENT_TOKEN || 'script-token-123';

// 驗證中間件
function requireAdmin(req) {
  const token = req.headers['x-admin-token'] || parseQuery(req.url).token;
  const cookie = parseCookie(req.headers.cookie || '').lurl_admin;
  return token === ADMIN_TOKEN || cookie === ADMIN_TOKEN;
}

function requireClient(req) {
  const token = req.headers['x-client-token'];
  return token === CLIENT_TOKEN;
}
```

**Userscript 端：**
```javascript
const CLIENT_TOKEN = 'script-token-123';

GM_xmlhttpRequest({
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Token': CLIENT_TOKEN
  },
  ...
});
```

---

## P1: 數據清洗

### 問題
1. 重複圖片（同一 pageUrl 多筆記錄）
2. 未成功下載的檔案（fileExists = false）
3. untitled 記錄過多

### 方案：清洗腳本

#### 1. 重複記錄清理
```javascript
// 保留最新的記錄，刪除舊的重複記錄
// 判斷標準：相同 pageUrl

步驟：
1. 讀取所有記錄
2. 按 pageUrl 分組
3. 每組只保留最新的一筆
4. 刪除多餘的記錄和檔案
```

#### 2. 未成功下載分類
```
新增狀態欄位或分類：
- status: 'completed' | 'pending' | 'failed'

或在 Admin 頁面新增篩選器：
- [全部] [已備份] [待備份] [失敗]
```

#### 3. untitled 記錄處理
```
選項 A: 保留但標記
選項 B: 嘗試從 pageUrl 提取標題
選項 C: 手動編輯功能
```

#### 4. 清洗腳本位置
```
server/scripts/cleanup.js

執行方式：
node server/scripts/cleanup.js --dry-run  # 預覽
node server/scripts/cleanup.js --execute  # 執行
```

---

## P2: 用戶統計功能

### 目標
- 追蹤有多少人在使用腳本
- 統計每日活躍用戶
- 顯示貢獻排行（匿名）

### 方案：匿名用戶標識

#### 1. Userscript 端
```javascript
// 生成或獲取匿名 userId
function getAnonymousUserId() {
  let userId = localStorage.getItem('lurl_user_id');
  if (!userId) {
    userId = 'u_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('lurl_user_id', userId);
  }
  return userId;
}

// capture 時帶上
Utils.sendToAPI({
  ...data,
  userId: getAnonymousUserId()
});
```

#### 2. Server 端
```javascript
// 記錄結構新增
const record = {
  ...existingFields,
  userId: body.userId || 'anonymous',
  uploadedAt: new Date().toISOString()
};

// 新增 API
GET /api/stats/users
Response: {
  totalUsers: 15,
  todayActiveUsers: 3,
  topContributors: [
    { userId: 'u_abc123', count: 45 },
    { userId: 'u_def456', count: 23 }
  ]
}
```

#### 3. Admin 頁面
```
新增統計卡片：
┌─────────────┬─────────────┬─────────────┐
│ 總用戶數    │ 今日活躍    │ 本週上傳    │
│     15      │      3      │     127     │
└─────────────┴─────────────┴─────────────┘

貢獻者排行：
1. u_abc*** - 45 筆
2. u_def*** - 23 筆
3. u_ghi*** - 18 筆
```

---

## P3: ffmpeg 縮圖生成

### 目標
為已存在但沒有縮圖的影片生成縮圖

### 前置條件
- 系統需安裝 ffmpeg
- `ffmpeg -version` 可執行

### 方案：批次腳本

#### 腳本位置
```
server/scripts/generate-thumbnails.js
```

#### 邏輯
```javascript
const { execSync } = require('child_process');

// 1. 讀取所有記錄
// 2. 篩選：type === 'video' && !thumbnailPath && fileExists
// 3. 對每個影片執行 ffmpeg

function generateThumbnail(videoPath, outputPath) {
  // 取第 1 秒的畫面
  execSync(`ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -q:v 2 "${outputPath}"`);
}

// 4. 更新記錄的 thumbnailPath
```

#### 執行方式
```bash
# 檢查 ffmpeg
ffmpeg -version

# 預覽要處理的影片
node server/scripts/generate-thumbnails.js --dry-run

# 執行生成
node server/scripts/generate-thumbnails.js --execute
```

#### 預估負擔
- 一次性執行，不會持續佔用資源
- 每個影片約 1-2 秒處理時間
- 可加入 --batch=10 參數分批處理

---

## 實作順序建議

### Phase 1: 安全性（立即）
1. 新增 ADMIN_TOKEN 和 CLIENT_TOKEN 配置
2. 保護 /admin 和 DELETE API
3. 更新 userscript 帶上 CLIENT_TOKEN
4. 部署並測試

### Phase 2: 數據清洗
1. 寫清洗腳本
2. 先 --dry-run 檢查
3. 備份 records.jsonl
4. 執行清洗

### Phase 3: 用戶統計
1. userscript 加入匿名 userId
2. server 記錄 userId
3. 新增統計 API
4. Admin 頁面顯示統計

### Phase 4: 縮圖生成
1. 確認 ffmpeg 已安裝
2. 寫生成腳本
3. 執行生成

---

## 問題討論

### Q: /browse 頁面要保護嗎？
選項：
- A: 不保護，內容公開可瀏覽（像公開相簿）
- B: 需要 token 才能瀏覽
- C: 只顯示標題，點進去需要驗證

### Q: userscript 的 CLIENT_TOKEN 會被看到嗎？
會，但這是為了防止「隨意的」惡意請求。
如果有人真的想繞過，可以從 userscript 源碼取得 token。
進階方案：每個用戶有自己的 token（需要註冊系統）

### Q: 要不要加 rate limit？
建議加，防止惡意大量請求：
- POST /capture: 每 IP 每分鐘 10 次
- DELETE: 每 token 每分鐘 5 次
