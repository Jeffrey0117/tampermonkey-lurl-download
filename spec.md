# Lurl 影片存檔系統 - 技術規格

## 概述

一個「眾人拾柴」的影片存檔系統：
- 每個使用 Tampermonkey 腳本的人都在幫忙收集資料
- 收集到的資料讓所有人受益
- 影片過期的問題被解決

## 系統架構

```
┌─────────────────┐         ┌─────────────────┐
│  Tampermonkey   │  HTTP   │  Fastify API    │
│     腳本        │ ──────► │    Server       │
└─────────────────┘  POST   └────────┬────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐    ┌──────────┐    ┌──────────┐
              │ 資料庫   │    │ 備份資料夾│    │  (未來)  │
              │ .jsonl   │    │ /videos  │    │ 影片站   │
              └──────────┘    │ /images  │    └──────────┘
                              └──────────┘
```

## MVP 範圍

### 1. API Server（Fastify）

**端點：**
```
POST /capture
```

**職責：**
- 接收 JSON
- 存到 `data/records.jsonl`
- 下載影片/圖片到 `data/videos/` 或 `data/images/`
- 回應 `{ "ok": true }` 或 HTTP 200

**Port：** `3000`

### 2. Tampermonkey 腳本修改

- 在 lurl 頁面，當影片/圖片 URL 成功取得時
- 組 JSON 打到 `http://localhost:3000/capture`
- 使用 `GM_xmlhttpRequest` 或 fetch + CORS

### 3. 資料結構

```json
{
  "title": "Dcard 文章標題",
  "pageUrl": "https://lurl.cc/xxx",
  "fileUrl": "https://xxx.com/video.mp4",
  "type": "video | image",
  "source": "lurl",
  "capturedAt": "2026-01-16T12:00:00Z",
  "backupPath": "videos/Dcard文章標題.mp4"
}
```

### 4. 備份檔名規則

- 使用 lurl 傳來的 title
- 特殊字元需清理（移除 `/\:*?"<>|` 等）
- 範例：`videos/超好看的影片.mp4`

## 檔案結構

```
lurl-download-userscript/
├── lurlDownloader.user.js    # Tampermonkey 腳本（需修改）
├── server/
│   ├── index.js              # Fastify Server 入口
│   ├── package.json
│   └── data/
│       ├── records.jsonl     # 資料記錄（一行一筆 JSON）
│       ├── videos/           # 影片備份
│       └── images/           # 圖片備份
├── SPEC.md                   # 本文件
└── feat.md                   # 原始需求討論
```

## 開發順序

| 順序 | 任務 | 說明 |
|------|------|------|
| 1 | 建 Server 骨架 | Fastify + `POST /capture` 能收 JSON、回 200 |
| 2 | 存 jsonl | 收到資料寫入 `data/records.jsonl` |
| 3 | 下載備份 | 把 fileUrl 下載到 `data/videos/` 或 `data/images/` |
| 4 | 改腳本 | 加入打 API 的邏輯，加 `@grant GM_xmlhttpRequest` |
| 5 | 測試 | 實際跑一次完整流程 |

## 技術選擇

- **框架：** Fastify（輕量、高效能）
- **存儲：** .jsonl（簡單、可追加、好 debug）
- **下載：** Node.js 原生 fetch

## 未來擴展（MVP 之後）

- 影片復活機制：查資料庫 → 試原始 URL → 提供備份
- 密碼繞過：資料庫有的影片直接渲染
- 影片站：所有收集的影片展示
- 會員系統
- 人氣統計
- 圖片支援
