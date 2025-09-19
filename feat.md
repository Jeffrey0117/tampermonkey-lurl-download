# 功能規劃 - Logo 與 Favicon 設置

## 規劃內容

- 使用品牌 LOGO 圖片：  
  `https://storage.meteor.today/image/68cd52aadbf5966d56d7a2bd.png`

### 設置項目

1. **網站入口 Logo (Header/第一眼入口)：**
   - 在 `index.html` 最頂部入口增加顯示 LOGO 圖片。
2. **網站 Favicon：**
   - 在 `index.html` 的 `<head>` 中加入 favicon 連結，讓瀏覽器標籤顯示 LOGO。

## 執行步驟

1. 修改 `index.html`

   - `<head>` 中新增 `<link rel="icon">` 指定 LOGO URL。
   - `<body>` 開頭最上方新增 `<img>`，作為網站入口 Logo。

2. 完成修改後，刪除本檔案 `feat.md`。
