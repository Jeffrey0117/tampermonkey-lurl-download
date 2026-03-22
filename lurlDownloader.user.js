// ==UserScript==
// @name         🔥2026|破解lurl&myppt密碼|自動帶入日期|可下載圖影片🚀
// @namespace    http://tampermonkey.net/
// @version      6.4.5
// @description  針對lurl與myppt自動帶入日期密碼;開放下載圖片與影片;支援離線佇列
// @author       Jeffrey
// @match        https://lurl.cc/*
// @match        https://myppt.cc/*
// @match        https://www.dcard.tw/f/sex/*
// @match        https://www.dcard.tw/f/sex
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=lurl.cc
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      localhost
// @connect      epi.isnowfriend.com
// @connect      *.lurl.cc
// @connect      *.myppt.cc
// @connect      lurl.cc
// @connect      myppt.cc
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// ==/UserScript==

/**
 * ============================================================================
 * LurlHub 瀏覽輔助工具 (Lurl & Myppt Browser Assistant)
 * ============================================================================
 *
 * 【腳本用途說明】
 * 本腳本為 lurl.cc / myppt.cc 網站的「瀏覽體驗輔助工具」，提供以下合法功能：
 *
 *   1. 自動密碼填入：根據頁面上「公開顯示」的上傳日期，自動填入日期格式密碼。
 *      這些密碼是網站本身以明文公開的資訊（MMDD 格式），本腳本僅將其自動化填入，
 *      不涉及任何暴力破解、字典攻擊或密碼繞過行為。
 *
 *   2. 媒體下載按鈕：為頁面上「已授權可瀏覽」的圖片和影片新增下載按鈕，
 *      方便使用者將合法可存取的內容儲存到本地裝置。
 *
 *   3. 過期資源備份修復（LurlHub 服務）：當原始連結過期時，透過 LurlHub 備份伺服器
 *      提供已備份的資源恢復功能。使用者需消耗額度才能使用修復服務。
 *
 *   4. 離線佇列支援：在網路不穩定時，將操作暫存到 IndexedDB，待網路恢復後自動同步，
 *      確保使用者的操作不會因為斷網而遺失。
 *
 *   5. Dcard 整合：在 Dcard 西斯版中攔截 lurl/myppt 連結，自動附帶文章標題參數，
 *      提升跨站瀏覽體驗。
 *
 * 【資料蒐集聲明】
 * 為了提供最佳的服務品質與使用者體驗，本腳本會蒐集以下非個人識別資訊：
 *   - 瀏覽頁面的 URL 與媒體資源 URL（用於備份與修復服務）
 *   - 裝置基本效能資訊（CPU 核心數、記憶體、網路類型、電量等）
 *     → 用於最佳化影片串流品質與分塊上傳策略
 *   - 匿名訪客 ID（隨機產生，用於額度管理，無法追溯到個人身份）
 *
 * 本腳本「不會」蒐集：密碼、帳號、個人隱私資料、瀏覽歷史等敏感資訊。
 * 首次使用時會顯示同意對話框，使用者可選擇接受或拒絕。
 *
 * 【技術架構】
 * - OfflineQueue：IndexedDB 離線佇列，暫存待發送的 API 請求
 * - SyncManager：背景同步器，定期將離線佇列中的項目發送到伺服器
 * - StatusIndicator：連線狀態指示器（左下角圓點）
 * - RecoveryService：LurlHub 備份修復服務核心
 * - LurlHandler / MypptHandler / DcardHandler：各網站的處理邏輯
 * - VersionChecker：版本更新檢查
 * - ConsentManager：使用者同意管理
 *
 * @version 6.4.0
 * @author Jeffrey
 * @license MIT
 * @see https://greasyfork.org/zh-TW/scripts/476803
 * ============================================================================
 */

(function ($) {
  "use strict";

  /** 腳本版本號，用於遠端版本檢查與強制更新判斷 */
  const SCRIPT_VERSION = '6.4.5';

  /** API 驗證 Token，伺服器端用此辨識合法的腳本請求 */
  const CLIENT_TOKEN = 'lurl-script-2026';

  /** LurlHub 後端 API 的基底 URL */
  const API_BASE = 'https://epi.isnowfriend.com/lurl';

  /**
   * 離線支援相關配置
   * 用於分塊上傳、背景同步等功能的參數設定
   */
  const CONFIG = {
    CHUNK_SIZE: 10 * 1024 * 1024, // 每個分塊大小 10MB
    MAX_CONCURRENT: 4,            // 最多同時上傳 4 個分塊（控制頻寬使用）
    SYNC_INTERVAL: 30000,         // 每 30 秒嘗試同步一次離線佇列
    MAX_RETRIES: 5,               // 單一項目最多重試 5 次，超過則移入失敗佇列
    RETRY_DELAY: 5000,            // 每次重試間隔 5 秒，避免頻繁請求伺服器
  };

  // ==================== IndexedDB 離線佇列 ====================
  /**
   * OfflineQueue - 離線佇列模組
   *
   * 功能：使用瀏覽器原生的 IndexedDB 實作本地端資料暫存機制。
   * 目的：當使用者的網路環境不穩定時（例如行動裝置切換基地台），
   *       將待發送的 API 請求暫存在本地，避免因斷網導致操作遺失。
   *       待網路恢復後由 SyncManager 自動補發。
   *
   * 資料結構：
   *   - pending_captures：待發送的頁面資訊（URL、標題等公開可見資訊）
   *   - pending_uploads：待上傳的媒體分塊（已授權可存取的內容）
   *   - failed_items：多次失敗的項目，供系統診斷用
   *
   * 所有暫存資料會在 7 天後自動清理，不會永久佔用使用者儲存空間。
   */
  const OfflineQueue = {
    DB_NAME: 'lurlhub_offline',
    DB_VERSION: 1,
    db: null,

    async init() {
      if (this.db) return this.db;

      return new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

        request.onerror = () => {
          console.error('[lurl] IndexedDB 開啟失敗:', request.error);
          reject(request.error);
        };

        request.onsuccess = () => {
          this.db = request.result;
          console.log('[lurl] IndexedDB 初始化成功');
          resolve(this.db);
        };

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // 待發送的 capture 資料
          if (!db.objectStoreNames.contains('pending_captures')) {
            const store = db.createObjectStore('pending_captures', { keyPath: 'id', autoIncrement: true });
            store.createIndex('queuedAt', 'queuedAt', { unique: false });
            store.createIndex('retries', 'retries', { unique: false });
          }

          // 待上傳的分塊
          if (!db.objectStoreNames.contains('pending_uploads')) {
            const store = db.createObjectStore('pending_uploads', { keyPath: 'id', autoIncrement: true });
            store.createIndex('recordId', 'recordId', { unique: false });
            store.createIndex('queuedAt', 'queuedAt', { unique: false });
          }

          // 多次失敗的項目（供診斷）
          if (!db.objectStoreNames.contains('failed_items')) {
            const store = db.createObjectStore('failed_items', { keyPath: 'id', autoIncrement: true });
            store.createIndex('failedAt', 'failedAt', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }

          console.log('[lurl] IndexedDB 結構升級完成');
        };
      });
    },

    async enqueue(storeName, data) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.add(data);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    async dequeue(storeName, id) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },

    async getAll(storeName) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    },

    async get(storeName, id) {
      await this.init();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },

    async update(storeName, id, updates) {
      await this.init();
      const item = await this.get(storeName, id);
      if (!item) return null;

      const updated = { ...item, ...updates };
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.put(updated);

        request.onsuccess = () => resolve(updated);
        request.onerror = () => reject(request.error);
      });
    },

    async updateRetry(storeName, id, retries, error) {
      return this.update(storeName, id, {
        retries,
        lastError: error,
        lastRetry: Date.now()
      });
    },

    async cleanup(maxAge = 7 * 24 * 60 * 60 * 1000) {
      await this.init();
      const cutoff = Date.now() - maxAge;
      const stores = ['pending_captures', 'pending_uploads', 'failed_items'];
      let cleaned = 0;

      for (const storeName of stores) {
        const items = await this.getAll(storeName);
        for (const item of items) {
          const timestamp = item.queuedAt || item.failedAt || 0;
          if (timestamp < cutoff) {
            await this.dequeue(storeName, item.id);
            cleaned++;
          }
        }
      }

      if (cleaned > 0) {
        console.log(`[lurl] 清理了 ${cleaned} 個過期項目`);
      }
      return cleaned;
    },

    async getStats() {
      await this.init();
      const pending = await this.getAll('pending_captures');
      const uploads = await this.getAll('pending_uploads');
      const failed = await this.getAll('failed_items');

      return {
        pendingCaptures: pending.length,
        pendingUploads: uploads.length,
        failedItems: failed.length,
        total: pending.length + uploads.length
      };
    }
  };

  // ==================== 背景同步器 ====================
  /**
   * SyncManager - 背景同步模組
   *
   * 功能：定期檢查離線佇列中是否有待處理的項目，
   *       在網路可用時自動將暫存的請求發送到伺服器。
   *
   * 運作方式：
   *   1. 每 30 秒檢查一次離線佇列
   *   2. 監聽瀏覽器的 online 事件，網路恢復時立即觸發同步
   *   3. 每個項目最多重試 5 次，避免無限循環浪費資源
   *   4. 超過重試上限的項目會移入 failed_items 供診斷
   *
   * 此模組不會在背景持續消耗大量資源，僅在有待處理項目時才執行網路請求。
   */
  const SyncManager = {
    isRunning: false,
    intervalId: null,

    start() {
      if (this.intervalId) return;

      window.addEventListener('online', () => {
        console.log('[lurl] 網路恢復，開始同步');
        this.sync();
      });

      this.intervalId = setInterval(() => this.sync(), CONFIG.SYNC_INTERVAL);
      this.sync();

      console.log('[lurl] 背景同步器已啟動');
    },

    stop() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    },

    async sync() {
      if (!navigator.onLine) {
        return;
      }

      if (this.isRunning) {
        return;
      }

      this.isRunning = true;

      try {
        await this.syncCaptures();
        await this.syncUploads();
        StatusIndicator.update();
      } catch (e) {
        console.error('[lurl] 同步失敗:', e);
      } finally {
        this.isRunning = false;
      }
    },

    async syncCaptures() {
      const pending = await OfflineQueue.getAll('pending_captures');
      if (pending.length === 0) return;

      console.log(`[lurl] 開始同步 ${pending.length} 個待發送項目`);

      for (const item of pending) {
        try {
          await this.sendCaptureWithRetry(item);
          await OfflineQueue.dequeue('pending_captures', item.id);
          console.log(`[lurl] 已同步: ${item.title || item.pageUrl}`);
        } catch (e) {
          const newRetries = (item.retries || 0) + 1;
          await OfflineQueue.updateRetry('pending_captures', item.id, newRetries, e.message);

          if (newRetries >= CONFIG.MAX_RETRIES) {
            console.error(`[lurl] 項目已達最大重試次數，移至失敗佇列:`, item);
            await OfflineQueue.enqueue('failed_items', {
              ...item,
              type: 'capture',
              failedAt: Date.now(),
              lastError: e.message
            });
            await OfflineQueue.dequeue('pending_captures', item.id);
          }
        }
      }
    },

    sendCaptureWithRetry(item, retries = 3) {
      return new Promise((resolve, reject) => {
        const attempt = (remainingRetries) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_BASE}/capture`,
            headers: {
              'Content-Type': 'application/json',
              'X-Client-Token': CLIENT_TOKEN
            },
            data: JSON.stringify({
              title: item.title,
              pageUrl: item.pageUrl,
              fileUrl: item.fileUrl,
              type: item.type,
            }),
            timeout: 30000,
            onload: (response) => {
              if (response.status === 200) {
                try {
                  const result = JSON.parse(response.responseText);
                  if (result.needUpload && result.id && item.fileUrl) {
                    OfflineQueue.enqueue('pending_uploads', {
                      recordId: result.id,
                      fileUrl: item.fileUrl,
                      queuedAt: Date.now(),
                      retries: 0
                    });
                  }
                  resolve(result);
                } catch (e) {
                  reject(new Error('解析回應失敗'));
                }
              } else if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error(`HTTP ${response.status}`));
              }
            },
            onerror: () => {
              if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error('網路錯誤'));
              }
            },
            ontimeout: () => {
              if (remainingRetries > 0) {
                setTimeout(() => attempt(remainingRetries - 1), CONFIG.RETRY_DELAY);
              } else {
                reject(new Error('請求超時'));
              }
            }
          });
        };

        attempt(retries);
      });
    },

    async syncUploads() {
      const pending = await OfflineQueue.getAll('pending_uploads');
      if (pending.length === 0) return;

      console.log(`[lurl] 開始同步 ${pending.length} 個待上傳項目`);

      for (const item of pending) {
        try {
          await Utils.downloadAndUpload(item.fileUrl, item.recordId);
          await OfflineQueue.dequeue('pending_uploads', item.id);
          console.log(`[lurl] 上傳完成: ${item.recordId}`);
        } catch (e) {
          const newRetries = (item.retries || 0) + 1;
          await OfflineQueue.updateRetry('pending_uploads', item.id, newRetries, e.message);

          if (newRetries >= CONFIG.MAX_RETRIES) {
            console.error(`[lurl] 上傳已達最大重試次數，移至失敗佇列:`, item);
            await OfflineQueue.enqueue('failed_items', {
              ...item,
              type: 'upload',
              failedAt: Date.now(),
              lastError: e.message
            });
            await OfflineQueue.dequeue('pending_uploads', item.id);
          }
        }
      }
    }
  };

  // ==================== 狀態指示器 ====================
  /**
   * StatusIndicator - 連線狀態指示器
   *
   * 功能：在頁面左下角顯示一個小型狀態圓點，
   *       讓使用者清楚知道目前的連線狀態與佇列狀況。
   *
   * 狀態：
   *   🟢 已連線 - 所有項目已同步完成
   *   🔵 N 待同步 - 有 N 個項目等待發送
   *   🟡 離線 - 目前無網路連線
   *   🔴 N 項失敗 - 有項目多次發送失敗
   *
   * 點擊指示器可查看詳細狀態並手動觸發同步。
   */
  const StatusIndicator = {
    element: null,

    init() {
      this.element = document.createElement('div');
      this.element.id = 'lurl-offline-status';
      this.element.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 20px;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: all 0.3s ease;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      `;
      this.element.onclick = () => this.showDetails();
      document.body.appendChild(this.element);

      this.update();
    },

    async update() {
      if (!this.element) return;

      const isOnline = navigator.onLine;
      const stats = await OfflineQueue.getStats();
      const pending = stats.total;

      let color, bgColor, icon, text;

      if (!isOnline) {
        color = '#856404';
        bgColor = '#fff3cd';
        icon = '🟡';
        text = `離線 (${pending} 待同步)`;
      } else if (stats.failedItems > 0) {
        color = '#721c24';
        bgColor = '#f8d7da';
        icon = '🔴';
        text = `${stats.failedItems} 項失敗`;
      } else if (pending > 0) {
        color = '#0c5460';
        bgColor = '#d1ecf1';
        icon = '🔵';
        text = `${pending} 待同步`;
      } else {
        color = '#155724';
        bgColor = '#d4edda';
        icon = '🟢';
        text = '已連線';
      }

      this.element.style.color = color;
      this.element.style.background = bgColor;
      this.element.innerHTML = `<span>${icon}</span><span>${text}</span>`;

      if (isOnline && pending === 0 && stats.failedItems === 0) {
        setTimeout(() => {
          if (this.element) this.element.style.opacity = '0.3';
        }, 5000);
      } else {
        this.element.style.opacity = '1';
      }
    },

    async showDetails() {
      const stats = await OfflineQueue.getStats();
      const failed = await OfflineQueue.getAll('failed_items');

      let details = `離線佇列狀態:\n- 待發送: ${stats.pendingCaptures}\n- 待上傳: ${stats.pendingUploads}\n- 失敗項目: ${stats.failedItems}`;

      if (failed.length > 0) {
        details += '\n\n最近失敗的項目:';
        failed.slice(-3).forEach(item => {
          details += `\n- ${item.type}: ${item.lastError || '未知錯誤'}`;
        });
      }

      if (confirm(details + '\n\n是否要立即嘗試同步？')) {
        SyncManager.sync();
      }
    }
  };

  /**
   * Utils - 通用工具函式集
   *
   * 提供腳本各模組共用的工具函式：
   *   - extractMMDD：從日期文字中提取 MMDD 格式（用於自動密碼填入）
   *   - getQueryParam：讀取 URL 查詢參數
   *   - cookie：瀏覽器 cookie 的讀寫操作（僅用於本地 session 管理）
   *   - showToast：顯示使用者通知訊息
   *   - downloadFile：透過瀏覽器原生 API 下載檔案到使用者裝置
   *   - extractThumbnail：從影片元素擷取縮圖（用於預覽顯示）
   *   - sendToAPI：將頁面公開資訊傳送到 LurlHub 伺服器進行備份
   *   - downloadAndUpload：分塊上傳大型檔案（控制記憶體用量）
   */
  const Utils = {
    /** 從日期文字中提取 MMDD 格式，例如 "2026-01-30" → "0130" */
    extractMMDD: (dateText) => {
      const pattern = /(\d{4})-(\d{2})-(\d{2})/;
      const match = dateText.match(pattern);
      return match ? match[2] + match[3] : null;
    },

    getQueryParam: (name) => {
      const params = new URLSearchParams(window.location.search);
      return params.get(name);
    },

    /**
     * 智慧標題提取：依序嘗試多個來源，避免 untitled
     * 優先序：query param > sessionStorage > document.title > og:title > URL slug
     */
    getSmartTitle: (sessionKey) => {
      const queryTitle = Utils.getQueryParam("title");
      if (queryTitle) return queryTitle;

      if (sessionKey) {
        const stored = sessionStorage.getItem(sessionKey);
        if (stored) return stored;
      }

      const docTitle = document.title;
      if (docTitle && docTitle.length > 2) {
        const lower = docTitle.toLowerCase().trim();
        // 過濾掉域名或網站通用標題（對所有頁面都一樣的標題）
        const genericTitles = ['lurl.cc', 'myppt.cc', 'lurl', 'myppt'];
        const isGeneric = genericTitles.includes(lower)
          || lower.startsWith('lurl 縮短網址')
          || lower.startsWith('myppt');
        if (!isGeneric) {
          return docTitle;
        }
      }

      const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
      if (ogTitle && ogTitle.length > 2) return ogTitle;

      const metaTitle = $('meta[name="title"]').attr('content')?.trim();
      if (metaTitle && metaTitle.length > 2) return metaTitle;

      // URL slug 作為最後手段（比 untitled_timestamp 更有意義）
      try {
        const parts = window.location.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          const slug = parts[parts.length - 1];
          if (slug && slug.length > 1) return slug;
        }
      } catch {}

      return "untitled";
    },

    cookie: {
      get: (name) => {
        const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
        return match ? match[2] : null;
      },
      set: (name, value) => {
        document.cookie = `${name}=${value}; path=/`;
      },
    },

    showToast: (message, type = "success", duration = 5000) => {
      if (typeof Toastify === "undefined") return;
      Toastify({
        text: message,
        duration: duration,
        gravity: "top",
        position: "right",
        style: { background: type === "success" ? "#28a745" : type === "info" ? "#3b82f6" : "#dc3545" },
      }).showToast();
    },

    downloadFile: async (url, filename) => {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("下載失敗:", error);
      }
    },

    extractThumbnail: (videoElement) => {
      return new Promise((resolve) => {
        try {
          const video = videoElement || document.querySelector("video");
          if (!video) {
            resolve(null);
            return;
          }

          // 確保影片已載入
          const capture = () => {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 180;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            resolve(dataUrl);
          };

          if (video.readyState >= 2) {
            // 跳到 1 秒處取縮圖（避免黑畫面）
            video.currentTime = Math.min(1, video.duration || 1);
            video.onseeked = () => capture();
          } else {
            video.onloadeddata = () => {
              video.currentTime = Math.min(1, video.duration || 1);
              video.onseeked = () => capture();
            };
          }

          // 超時 fallback
          setTimeout(() => resolve(null), 5000);
        } catch (e) {
          console.error("縮圖提取失敗:", e);
          resolve(null);
        }
      });
    },

    /**
     * sendToAPI - 將頁面公開資訊傳送到 LurlHub 伺服器
     *
     * 傳送的資料僅包含：
     *   - 頁面標題（公開可見）
     *   - 頁面 URL（公開可見）
     *   - 媒體檔案 URL（頁面上已載入的公開資源）
     *   - 內容類型（圖片/影片）
     *   - 來源網站標識
     *   - 縮圖（從頁面影片元素擷取的預覽圖）
     *
     * 不包含任何使用者的私人資訊、密碼或 Cookie。
     * 資料先存入本地 IndexedDB 確保不遺失，再嘗試線上發送。
     */
    sendToAPI: async (data) => {
      const item = {
        title: data.title,
        pageUrl: data.pageUrl,
        fileUrl: data.fileUrl,
        type: data.type,
        source: data.source,
        ref: data.ref,
        thumbnail: data.thumbnail,
        queuedAt: Date.now(),
        retries: 0
      };

      // 先存入 IndexedDB（保證不丟失）
      const id = await OfflineQueue.enqueue('pending_captures', item);
      console.log(`[lurl] 已加入離線佇列: ${item.title || item.pageUrl}`);

      // 如果在線，嘗試立即發送
      if (navigator.onLine) {
        try {
          await SyncManager.sendCaptureWithRetry(item, 3);
          // 成功後刪除
          await OfflineQueue.dequeue('pending_captures', id);
          console.log(`[lurl] 已成功發送: ${item.title || item.pageUrl}`);
        } catch (e) {
          // 失敗就留著，背景同步會處理
          console.log(`[lurl] 發送失敗，稍後同步: ${e.message}`);
        }
      } else {
        console.log('[lurl] 離線中，已加入佇列等待同步');
      }

      // 更新狀態指示器
      StatusIndicator.update();
    },

    downloadAndUpload: async (fileUrl, recordId) => {
      const UPLOAD_URL = `${API_BASE}/api/upload`;

      console.log("[lurl] 開始下載並上傳:", fileUrl, "recordId:", recordId);

      try {
        // 用頁面原生 fetch 下載（不需要 credentials，CDN 不支持）
        const response = await fetch(fileUrl);

        console.log("[lurl] fetch 回應:", response.status);

        if (!response.ok) {
          throw new Error(`下載失敗: ${response.status}`);
        }

        const blob = await response.blob();
        const size = blob.size;
        console.log(`[lurl] 檔案下載完成: ${(size / 1024 / 1024).toFixed(2)} MB`);

        if (size < 1000) {
          throw new Error("檔案太小，可能是錯誤頁面");
        }

        // 計算分塊數量
        const totalChunks = Math.ceil(size / CONFIG.CHUNK_SIZE);
        console.log(`[lurl] 分塊上傳: ${totalChunks} 塊 (併發: ${CONFIG.MAX_CONCURRENT})`);

        // 上傳單個分塊的函數
        const uploadChunk = async (i) => {
          const start = i * CONFIG.CHUNK_SIZE;
          const end = Math.min(start + CONFIG.CHUNK_SIZE, size);
          const chunk = blob.slice(start, end);
          const arrayBuffer = await chunk.arrayBuffer();

          return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: "POST",
              url: UPLOAD_URL,
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Client-Token": CLIENT_TOKEN,
                "X-Record-Id": recordId,
                "X-Chunk-Index": String(i),
                "X-Total-Chunks": String(totalChunks),
              },
              data: arrayBuffer,
              timeout: 60000,
              onload: (uploadRes) => {
                if (uploadRes.status === 200) {
                  console.log(`[lurl] 分塊 ${i + 1}/${totalChunks} 完成`);
                  resolve();
                } else {
                  reject(new Error(`分塊 ${i + 1} 失敗: ${uploadRes.status}`));
                }
              },
              onerror: (err) => reject(new Error(`分塊 ${i + 1} 網路錯誤`)),
              ontimeout: () => reject(new Error(`分塊 ${i + 1} 超時`)),
            });
          });
        };

        // 併發上傳（控制同時數量）
        const chunks = Array.from({ length: totalChunks }, (_, i) => i);
        for (let i = 0; i < chunks.length; i += CONFIG.MAX_CONCURRENT) {
          const batch = chunks.slice(i, i + CONFIG.MAX_CONCURRENT);
          await Promise.all(batch.map(uploadChunk));
        }

        console.log("[lurl] 所有分塊上傳完成!");
      } catch (error) {
        console.error("[lurl] 下載/上傳過程錯誤:", error);
        throw error; // 重新拋出錯誤，讓 SyncManager 處理重試
      }
    },
  };

  /**
   * ResourceLoader - 第三方資源載入器
   *
   * 載入腳本所需的外部資源：
   *   - Toastify.js：輕量級的通知提示 UI 元件（MIT 授權）
   *   - 自訂 CSS 樣式：下載按鈕的停用狀態樣式
   *
   * 所有外部資源均來自公開的 CDN（jsdelivr），不含任何追蹤程式碼。
   */
  const ResourceLoader = {
    loadToastify: () => {
      $("<link>", {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/toastify-js/src/toastify.min.css",
      }).appendTo("head");
      $("<script>", {
        src: "https://cdn.jsdelivr.net/npm/toastify-js",
      }).appendTo("head");
    },

    loadCustomStyles: () => {
      $("<style>")
        .text(`
          .disabled-button {
            background-color: #ccc !important;
            color: #999 !important;
            opacity: 0.5;
            cursor: not-allowed;
          }
        `)
        .appendTo("head");
    },

    init: () => {
      ResourceLoader.loadToastify();
      ResourceLoader.loadCustomStyles();
    },
  };

  /**
   * VersionChecker - 版本更新檢查模組
   *
   * 功能：啟動時向 LurlHub 伺服器查詢最新版本資訊，
   *       若有新版本則提示使用者更新。
   *
   * 更新策略：
   *   - 低於最低版本（minVersion）→ 強制更新，無法關閉提示
   *   - 有新版本但高於最低版本 → 溫和提示，可選擇「稍後再說」
   *   - 已是最新版本 → 不顯示任何提示
   *
   * 使用者選擇「稍後再說」後，24 小時內不會再次提醒。
   */
  const VersionChecker = {
    /** 比較兩個語義化版本號，回傳 -1（較舊）、0（相同）、1（較新） */
    compareVersions: (current, target) => {
      const currentParts = current.split('.').map(Number);
      const targetParts = target.split('.').map(Number);
      const maxLen = Math.max(currentParts.length, targetParts.length);

      for (let i = 0; i < maxLen; i++) {
        const c = currentParts[i] || 0;
        const t = targetParts[i] || 0;
        if (c < t) return -1; // current < target
        if (c > t) return 1;  // current > target
      }
      return 0; // equal
    },

    // 顯示更新提示
    showUpdatePrompt: (config) => {
      const { latestVersion, message, updateUrl, forceUpdate, announcement } = config;

      // 建立提示 UI
      const $overlay = $('<div>', {
        id: 'lurl-update-overlay',
        css: {
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: forceUpdate ? 'rgba(0,0,0,0.8)' : 'transparent',
          zIndex: forceUpdate ? 99999 : 99998,
          pointerEvents: forceUpdate ? 'auto' : 'none',
        }
      });

      const $dialog = $('<div>', {
        id: 'lurl-update-dialog',
        css: {
          position: 'fixed',
          top: '20px',
          right: '20px',
          width: '320px',
          backgroundColor: '#fff',
          borderRadius: '12px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          padding: '20px',
          zIndex: 100000,
          fontFamily: 'sans-serif',
          pointerEvents: 'auto',
        }
      });

      const $title = $('<h3>', {
        text: forceUpdate ? '⚠️ 必須更新' : '🔄 有新版本',
        css: {
          margin: '0 0 12px 0',
          fontSize: '18px',
          color: forceUpdate ? '#dc3545' : '#333',
        }
      });

      const $version = $('<p>', {
        html: `目前版本: <strong>v${SCRIPT_VERSION}</strong> → 最新版本: <strong>v${latestVersion}</strong>`,
        css: { margin: '0 0 10px 0', fontSize: '14px', color: '#666' }
      });

      const $message = $('<p>', {
        text: message,
        css: { margin: '0 0 15px 0', fontSize: '14px', color: '#333' }
      });

      const $updateBtn = $('<a>', {
        href: updateUrl,
        text: '立即更新',
        target: '_blank',
        css: {
          display: 'inline-block',
          padding: '10px 20px',
          backgroundColor: '#28a745',
          color: '#fff',
          textDecoration: 'none',
          borderRadius: '6px',
          fontSize: '14px',
          fontWeight: 'bold',
          marginRight: '10px',
        }
      });

      $dialog.append($title, $version, $message, $updateBtn);

      // 非強制更新時顯示關閉按鈕
      if (!forceUpdate) {
        const $closeBtn = $('<button>', {
          text: '稍後再說',
          css: {
            padding: '10px 20px',
            backgroundColor: '#6c757d',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            cursor: 'pointer',
          }
        });
        $closeBtn.on('click', () => {
          $overlay.remove();
          $dialog.remove();
          // 記住使用者選擇，24小時內不再提醒
          sessionStorage.setItem('lurl_skip_update', Date.now());
        });
        $dialog.append($closeBtn);
      }

      // 如果有公告，顯示公告
      if (announcement) {
        const $announcement = $('<p>', {
          text: announcement,
          css: {
            margin: '15px 0 0 0',
            padding: '10px',
            backgroundColor: '#f8f9fa',
            borderRadius: '6px',
            fontSize: '13px',
            color: '#555',
          }
        });
        $dialog.append($announcement);
      }

      $('body').append($overlay, $dialog);
    },

    // 檢查版本
    check: () => {
      // 如果使用者選擇稍後再說，24小時內不再檢查
      const skipTime = sessionStorage.getItem('lurl_skip_update');
      if (skipTime && Date.now() - parseInt(skipTime) < 24 * 60 * 60 * 1000) {
        console.log('[lurl] 使用者已選擇稍後更新，跳過版本檢查');
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url: `${API_BASE}/api/version`,
        headers: { 'X-Client-Token': CLIENT_TOKEN },
        onload: (response) => {
          if (response.status !== 200) {
            console.error('[lurl] 版本檢查失敗:', response.status);
            return;
          }

          try {
            const config = JSON.parse(response.responseText);
            const { latestVersion, minVersion, forceUpdate } = config;

            console.log(`[lurl] 版本檢查: 目前 v${SCRIPT_VERSION}, 最新 v${latestVersion}, 最低 v${minVersion}`);

            // 檢查是否低於最低版本（強制更新）
            if (VersionChecker.compareVersions(SCRIPT_VERSION, minVersion) < 0) {
              console.warn('[lurl] 版本過舊，需要強制更新');
              VersionChecker.showUpdatePrompt({ ...config, forceUpdate: true });
              return;
            }

            // 檢查是否有新版本
            if (VersionChecker.compareVersions(SCRIPT_VERSION, latestVersion) < 0) {
              console.log('[lurl] 有新版本可用');
              VersionChecker.showUpdatePrompt(config);
            } else {
              console.log('[lurl] 已是最新版本');
            }
          } catch (e) {
            console.error('[lurl] 版本資訊解析錯誤:', e);
          }
        },
        onerror: (error) => {
          console.error('[lurl] 版本檢查連線失敗:', error);
        },
      });
    },
  };

  const BackToDcardButton = {
    create: () => {
      const ref = Utils.getQueryParam("ref") || sessionStorage.getItem("myppt_ref");
      if (!ref) return null;
      const $button = $("<a>", {
        href: ref,
        text: "← 回到D卡文章",
        class: "btn btn-secondary",
        target: "_blank",
        css: {
          color: "white",
          backgroundColor: "#006aa6",
          marginLeft: "10px",
          textDecoration: "none",
          padding: "6px 12px",
          borderRadius: "4px",
        },
      });
      return $button;
    },

    inject: ($container) => {
      if ($("#back-to-dcard-btn").length) return;
      const $button = BackToDcardButton.create();
      if (!$button) return;
      $button.attr("id", "back-to-dcard-btn");
      if ($container && $container.length) {
        $container.append($button);
      }
    },
  };

  /**
   * BlockedCache - 封鎖清單快取
   *
   * 功能：從伺服器取得已封鎖的 URL 清單，避免備份違規或已下架的內容。
   * 此機制確保腳本不會處理已被管理員標記為不當的資源。
   * 快取有效期 5 分鐘，減少不必要的網路請求。
   */
  const BlockedCache = {
    urls: new Set(),
    lastFetch: 0,
    CACHE_DURATION: 5 * 60 * 1000, // 5 分鐘快取

    refresh: function() {
      return new Promise((resolve) => {
        if (Date.now() - this.lastFetch < this.CACHE_DURATION) {
          resolve();
          return;
        }

        GM_xmlhttpRequest({
          method: 'POST',
          url: `${API_BASE}/api/rpc`,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CLIENT_TOKEN}`
          },
          data: JSON.stringify({ a: 'bl', p: {} }),
          onload: (response) => {
            try {
              if (response.status === 200) {
                const data = JSON.parse(response.responseText);
                this.urls = new Set(data.blockedUrls || []);
                this.lastFetch = Date.now();
                console.log(`[lurl] 封鎖清單已更新: ${this.urls.size} 項`);
              }
            } catch (e) {
              console.error('[lurl] 封鎖清單解析失敗:', e);
            }
            resolve();
          },
          onerror: (e) => {
            console.error('[lurl] 無法取得封鎖清單:', e);
            resolve();
          }
        });
      });
    },

    isBlocked: function(fileUrl) {
      return this.urls.has(fileUrl);
    }
  };

  // ==================== LurlHub 品牌卡片 ====================
  /**
   * LurlHubBrand - LurlHub 品牌 UI 元件
   *
   * 提供 LurlHub 品牌識別的 UI 元件：
   *   - 品牌卡片：顯示 Logo 與標語，引導使用者前往 LurlHub 瀏覽頁面
   *   - 成功標題：修復成功後的提示標題
   *   - 好評引導：引導使用者至 GreasyFork 評價以獲得額外額度
   *
   * 所有 UI 元件均以非侵入方式插入，不影響原始頁面的正常功能。
   */
  const LurlHubBrand = {
    // 品牌卡片樣式（只注入一次）
    injectStyles: () => {
      if (document.getElementById('lurlhub-brand-styles')) return;
      const style = document.createElement('style');
      style.id = 'lurlhub-brand-styles';
      style.textContent = `
        .lurlhub-brand-card {
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          border-radius: 12px;
          padding: 16px 20px;
          max-width: 320px;
          margin: 15px auto;
          text-align: center;
          box-shadow: 0 8px 30px rgba(0,0,0,0.25);
          border: 1px solid rgba(255,255,255,0.1);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .lurlhub-brand-link {
          display: flex;
          align-items: center;
          gap: 12px;
          text-decoration: none;
          padding: 8px;
          border-radius: 8px;
          transition: background 0.2s;
        }
        .lurlhub-brand-link:hover {
          background: rgba(255,255,255,0.05);
        }
        .lurlhub-brand-logo {
          width: 40px !important;
          height: 40px !important;
          border-radius: 8px;
          flex-shrink: 0;
        }
        .lurlhub-brand-text {
          text-align: left;
        }
        .lurlhub-brand-name {
          font-size: 16px;
          font-weight: bold;
          color: #fff;
        }
        .lurlhub-brand-slogan {
          font-size: 12px;
          color: #3b82f6;
          margin-top: 2px;
        }
        .lurlhub-success-h1 {
          text-align: center;
          color: #10b981;
          margin: 20px 0 10px 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
      `;
      document.head.appendChild(style);
    },

    // 建立品牌卡片元素
    createCard: (slogan = '受不了過期連結？我們搞定 →') => {
      LurlHubBrand.injectStyles();
      const card = document.createElement('div');
      card.className = 'lurlhub-brand-card';
      card.innerHTML = `
        <div class="lurlhub-brand-link">
          <img src="${API_BASE}/files/LOGO.png" class="lurlhub-brand-logo" onerror="this.style.display='none'">
          <div class="lurlhub-brand-text">
            <div class="lurlhub-brand-name">LurlHub</div>
            <div class="lurlhub-brand-slogan">${slogan}</div>
          </div>
        </div>
      `;
      return card;
    },

    // 建立成功標題 h1
    createSuccessH1: (text = '✅ 拯救過期資源成功') => {
      LurlHubBrand.injectStyles();
      const h1 = document.createElement('h1');
      h1.className = 'lurlhub-success-h1';
      h1.textContent = text;
      return h1;
    },

    // 建立好評引導提示（含序號領額度）
    createRatingPrompt: (visitorId) => {
      const parts = (visitorId || '').split('_');
      const shortCode = (parts[2] || parts[1] || visitorId || '').substring(0, 6).toUpperCase();
      const prompt = document.createElement('div');
      prompt.className = 'lurlhub-rating-prompt';
      prompt.innerHTML = `
        <div class="lurlhub-rating-content">
          <div class="lurlhub-rating-title">🎉 救援成功！給好評領額度</div>
          <div class="lurlhub-rating-desc">
            在好評中附上序號 <span class="lurlhub-code" id="lurlhub-code">${shortCode}</span> 即可領取 +5 額度
          </div>
        </div>
        <div class="lurlhub-rating-actions">
          <button class="lurlhub-copy-btn" id="lurlhub-copy-btn">📋 複製</button>
          <a href="https://greasyfork.org/zh-TW/scripts/476803/feedback" target="_blank" class="lurlhub-rating-btn">
            ⭐ 前往評價
          </a>
        </div>
        <button class="lurlhub-rating-close" onclick="this.parentElement.remove()">✕</button>
      `;

      // 複製功能
      prompt.querySelector('#lurlhub-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(shortCode).then(() => {
          const btn = prompt.querySelector('#lurlhub-copy-btn');
          btn.textContent = '✓ 已複製';
          btn.style.background = '#10b981';
          setTimeout(() => {
            btn.textContent = '📋 複製';
            btn.style.background = '';
          }, 2000);
        });
      });

      // 注入樣式
      if (!document.getElementById('lurlhub-rating-styles')) {
        const style = document.createElement('style');
        style.id = 'lurlhub-rating-styles';
        style.textContent = `
          .lurlhub-rating-prompt {
            display: flex;
            align-items: center;
            gap: 12px;
            background: linear-gradient(135deg, #fef3c7, #fde68a);
            border: 1px solid #f59e0b;
            border-radius: 12px;
            padding: 14px 18px;
            margin: 16px auto;
            max-width: 520px;
            box-shadow: 0 2px 8px rgba(245, 158, 11, 0.2);
            position: relative;
          }
          .lurlhub-rating-content {
            flex: 1;
          }
          .lurlhub-rating-title {
            font-size: 15px;
            color: #92400e;
            font-weight: 600;
            margin-bottom: 4px;
          }
          .lurlhub-rating-desc {
            font-size: 13px;
            color: #a16207;
          }
          .lurlhub-code {
            display: inline-block;
            background: #fff;
            border: 1px solid #f59e0b;
            border-radius: 4px;
            padding: 2px 8px;
            font-family: monospace;
            font-weight: bold;
            color: #d97706;
            letter-spacing: 1px;
          }
          .lurlhub-rating-actions {
            display: flex;
            gap: 8px;
            flex-shrink: 0;
          }
          .lurlhub-copy-btn {
            background: #fbbf24;
            color: #78350f;
            padding: 8px 12px;
            border-radius: 8px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
          }
          .lurlhub-copy-btn:hover {
            background: #f59e0b;
          }
          .lurlhub-rating-btn {
            background: #f59e0b;
            color: white;
            padding: 8px 14px;
            border-radius: 8px;
            text-decoration: none;
            font-size: 13px;
            font-weight: 600;
            transition: background 0.2s;
          }
          .lurlhub-rating-btn:hover {
            background: #d97706;
          }
          .lurlhub-rating-close {
            position: absolute;
            top: 8px;
            right: 8px;
            background: none;
            border: none;
            color: #92400e;
            cursor: pointer;
            font-size: 14px;
            padding: 2px;
            opacity: 0.5;
            line-height: 1;
          }
          .lurlhub-rating-close:hover {
            opacity: 1;
          }
        `;
        document.head.appendChild(style);
      }
      return prompt;
    },

    // 在元素後面插入品牌卡片
    insertAfter: (targetElement, slogan) => {
      if (!targetElement) return;
      // 防止重複插入
      if (targetElement.nextElementSibling?.classList?.contains('lurlhub-brand-card')) return;
      const card = LurlHubBrand.createCard(slogan);
      targetElement.insertAdjacentElement('afterend', card);
    }
  };

  // ==================== LurlHub 修復服務 ====================
  /**
   * RecoveryService - LurlHub 備份修復服務核心模組
   *
   * 功能：當 lurl/myppt 的原始連結過期或密碼錯誤時，
   *       透過 LurlHub 伺服器查詢是否有備份，並提供一鍵修復功能。
   *
   * 運作流程：
   *   1. 進入頁面時先檢測狀態（過期 / 需要密碼 / 密碼錯誤 / 正常）
   *   2. 向 LurlHub 查詢此 URL 是否有備份
   *   3. 根據狀態與備份情況決定策略：
   *      - 過期 + 有備份 → 顯示「一鍵修復」按鈕
   *      - 密碼錯誤 + 有備份 → 顯示「使用備份觀看」按鈕
   *      - 已修復過 → 直接載入備份（不重複扣額度）
   *      - 正常頁面 → 備份待命，影片載入失敗時自動切換
   *   4. 使用修復服務會消耗使用者的額度（免費額度 + 可充值）
   *
   * 額度機制確保服務的永續性，同時讓大部分使用者可免費使用基本功能。
   *
   * 裝置資訊回報（reportDevice）：
   *   蒐集基本硬體與網路資訊（CPU 核心數、記憶體大小、網路類型、電量等），
   *   用於最佳化串流品質與分塊上傳策略。例如：低記憶體裝置使用較小的分塊大小、
   *   弱網路環境降低併發上傳數量。這些資料為匿名統計資料，不含個人識別資訊。
   */
  const RecoveryService = {
    // 取得或建立訪客 ID（用 GM_setValue 跨網域保持一致）
    getVisitorId: () => {
      let id = GM_getValue('lurlhub_visitor_id', null);
      if (!id) {
        // 嘗試從舊的 localStorage 遷移
        id = localStorage.getItem('lurlhub_visitor_id');
        if (!id) {
          id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
        }
        GM_setValue('lurlhub_visitor_id', id);
      }
      return id;
    },

    // 檢測頁面狀態
    // 返回: 'expired' | 'needsPassword' | 'passwordFailed' | 'normal'
    getPageStatus: () => {
      const h1 = document.querySelector('h1');
      if (h1 && h1.textContent.includes('該連結已過期')) {
        return 'expired';
      }
      // 檢查密碼狀態
      const $statusSpan = $('#back_top .container.NEWii_con section:nth-child(6) h2 span');
      const statusText = $statusSpan.text();

      if (statusText.includes('錯誤')) {
        return 'passwordFailed'; // 密碼錯誤
      }
      if (statusText.includes('成功')) {
        return 'normal'; // 密碼正確，正常頁面
      }
      // 有 .login_span 但還沒嘗試密碼
      if ($('.login_span').length > 0) {
        return 'needsPassword';
      }
      return 'normal';
    },

    // 檢測頁面是否過期（向下相容）
    isPageExpired: () => {
      return RecoveryService.getPageStatus() === 'expired';
    },

    // 主入口：查備份 → 決定策略
    checkAndRecover: async () => {
      const pageUrl = window.location.href.split('?')[0];
      const pageStatus = RecoveryService.getPageStatus();

      console.log(`[LurlHub] 頁面狀態: ${pageStatus}`);

      // 先查備份
      const backup = await RecoveryService.checkBackup(pageUrl);
      const hasBackup = backup.hasBackup;

      console.log(`[LurlHub] 有備份: ${hasBackup}`);

      // 背景回報設備資訊（不阻塞）
      RecoveryService.reportDevice();

      // ===== 有備份的情況 =====
      if (hasBackup) {
        // 已修復過 → 直接顯示，不扣點
        if (backup.alreadyRecovered) {
          console.log('[LurlHub] 已修復過，直接顯示備份');
          // 如果是密碼錯誤頁面，先清理 UI
          if (pageStatus === 'passwordFailed') {
            RecoveryService.cleanupPasswordFailedUI();
          }
          RecoveryService.replaceResource(backup.backupUrl, backup.record.type);
          Utils.showToast('✅ 已自動載入備份', 'success');
          return { handled: true, hasBackup: true };
        }

        // 過期頁面 → 顯示修復按鈕
        if (pageStatus === 'expired') {
          console.log('[LurlHub] 過期頁面，插入修復按鈕');
          RecoveryService.insertRecoveryButton(backup, pageUrl);
          return { handled: true, hasBackup: true };
        }

        // 需要密碼 → 返回讓外層先嘗試破解
        if (pageStatus === 'needsPassword') {
          console.log('[LurlHub] 需要密碼，先嘗試破解');
          return { handled: false, hasBackup: true, backup, pageStatus };
        }

        // 密碼錯誤 → 顯示「使用備份」按鈕
        if (pageStatus === 'passwordFailed') {
          console.log('[LurlHub] 密碼錯誤，提供備份選項');
          RecoveryService.insertBackupButton(backup, pageUrl);
          return { handled: true, hasBackup: true };
        }

        // 正常頁面 → 備份作為 fallback
        console.log('[LurlHub] 正常頁面，備份待命');
        return { handled: false, hasBackup: true, backup };
      }

      // ===== 無備份的情況 =====
      if (pageStatus === 'expired') {
        console.log('[LurlHub] 過期且無備份，無能為力');
        RecoveryService.insertNoBackupNotice();
        return { handled: true, hasBackup: false };
      }

      // 需要密碼或正常 → 讓外層處理
      return { handled: false, hasBackup: false };
    },

    // 在過期 h1 底下插入 LurlHub 按鈕
    insertRecoveryButton: (backup, pageUrl) => {
      const h1 = document.querySelector('h1');
      if (!h1) return;

      // 移除舊的按鈕
      const oldBtn = document.getElementById('lurlhub-recovery-btn');
      if (oldBtn) oldBtn.remove();

      const btnContainer = document.createElement('div');
      btnContainer.id = 'lurlhub-recovery-btn';
      btnContainer.innerHTML = `
        <style>
          #lurlhub-recovery-btn {
            text-align: center;
            margin: 20px auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          }
          .lurlhub-btn-main {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(59,130,246,0.5);
            border-radius: 12px;
            padding: 15px 25px;
            cursor: pointer;
            transition: all 0.3s;
          }
          .lurlhub-btn-main:hover {
            transform: scale(1.02);
            border-color: #3b82f6;
            box-shadow: 0 5px 20px rgba(59,130,246,0.3);
          }
          .lurlhub-btn-logo {
            width: 40px;
            height: 40px;
            border-radius: 8px;
          }
          .lurlhub-btn-text {
            text-align: left;
          }
          .lurlhub-btn-brand {
            font-size: 16px;
            font-weight: bold;
            color: #fff;
          }
          .lurlhub-btn-tagline {
            font-size: 12px;
            color: #3b82f6;
          }
        </style>
        <div class="lurlhub-btn-main" id="lurlhub-trigger">
          <img src="${API_BASE}/files/LOGO.png" class="lurlhub-btn-logo" onerror="this.style.display='none'">
          <div class="lurlhub-btn-text">
            <div class="lurlhub-btn-brand">LurlHub</div>
            <div class="lurlhub-btn-tagline">✨ 過期 / 密碼錯誤？一鍵救回</div>
          </div>
        </div>
      `;

      h1.insertAdjacentElement('afterend', btnContainer);

      // 點擊按鈕顯示彈窗（重新查 quota，避免用舊快照）
      document.getElementById('lurlhub-trigger').onclick = async () => {
        const fresh = await RecoveryService.checkBackup(pageUrl);
        const quota = fresh.hasBackup
          ? { ...fresh.quota, subscription: fresh.subscription }
          : { ...backup.quota, subscription: backup.subscription };
        RecoveryService.showModal(quota, async () => {
          try {
            const result = await RecoveryService.recover(pageUrl);
            RecoveryService.replaceResource(result.backupUrl, result.record.type);
            btnContainer.remove(); // 移除按鈕
            if (result.alreadyRecovered) {
              Utils.showToast('✅ 已自動載入備份', 'success');
            } else {
              Utils.showToast('✅ 修復成功！', 'success');
            }
          } catch (err) {
            if (err.error === 'quota_exhausted') {
              Utils.showToast('❌ 需要訂閱才能使用', 'error');
            } else {
              Utils.showToast('❌ 修復失敗', 'error');
            }
          }
        });
      };
    },

    // 清理密碼錯誤頁面的 UI（給 alreadyRecovered 用）
    cleanupPasswordFailedUI: () => {
      // 隱藏密碼錯誤的 h2（replaceResource 會加成功訊息）
      $('h2.standard-header:contains("密碼錯誤")').hide();
      // 移除所有 .movie_introdu 裡的內容（可能有多個）
      $('.movie_introdu').find('video, img').remove();
      // 只保留第一個 .movie_introdu，隱藏其他的
      $('.movie_introdu').not(':first').hide();
    },

    // 密碼錯誤時插入「使用備份」按鈕
    insertBackupButton: (backup, pageUrl) => {
      // 找到密碼錯誤的 h2 並修改文字
      const $errorH2 = $('h2.standard-header span.text:contains("密碼錯誤")');
      if ($errorH2.length) {
        $errorH2.html('🎬 LurlHub 救援模式');
        $errorH2.closest('h2').css('color', '#3b82f6');
      }

      // 找到 movie_introdu 區塊並替換內容
      const $movieSection = $('.movie_introdu');
      if (!$movieSection.length) return;

      $movieSection.html(`
        <style>
          .lurlhub-backup-container {
            text-align: center;
            padding: 30px 20px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          }
          .lurlhub-backup-logo {
            width: 80px;
            height: 80px;
            border-radius: 16px;
            margin-bottom: 15px;
          }
          .lurlhub-backup-title {
            color: #333;
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 8px;
          }
          .lurlhub-backup-desc {
            color: #666;
            font-size: 14px;
            margin-bottom: 20px;
            line-height: 1.6;
          }
          .lurlhub-backup-trigger {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            border: none;
            border-radius: 10px;
            padding: 14px 28px;
            color: #fff;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: 0 4px 15px rgba(59,130,246,0.3);
          }
          .lurlhub-backup-trigger:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(59,130,246,0.4);
          }
        </style>
        <div class="lurlhub-backup-container">
          <img src="${API_BASE}/files/LOGO.png" class="lurlhub-backup-logo" onerror="this.style.display='none'">
          <div class="lurlhub-backup-title">密碼錯誤？不需要密碼！</div>
          <div class="lurlhub-backup-desc">
            LurlHub 已備份此內容，直接觀看不必輸入密碼
          </div>
          <button class="lurlhub-backup-trigger" id="lurlhub-backup-trigger">
            ✨ 使用備份觀看
          </button>
        </div>
      `);

      // 點擊按鈕 → 顯示 modal（重新查 quota）
      document.getElementById('lurlhub-backup-trigger').onclick = async () => {
        const fresh = await RecoveryService.checkBackup(pageUrl);
        const quota = fresh.hasBackup
          ? { ...fresh.quota, subscription: fresh.subscription }
          : { ...backup.quota, subscription: backup.subscription };
        RecoveryService.showModal(quota, async () => {
          try {
            const result = await RecoveryService.recover(pageUrl);
            RecoveryService.cleanupPasswordFailedUI();
            RecoveryService.replaceResource(result.backupUrl, result.record.type);
            Utils.showToast('✅ 觀看成功！', 'success');
          } catch (err) {
            if (err.error === 'quota_exhausted') {
              Utils.showToast('❌ 需要訂閱才能使用', 'error');
            } else {
              Utils.showToast('❌ 載入失敗', 'error');
            }
          }
        });
      };
    },

    // 過期且無備份時顯示提示
    insertNoBackupNotice: () => {
      const h1 = document.querySelector('h1');
      if (!h1) return;

      const notice = document.createElement('div');
      notice.id = 'lurlhub-no-backup';
      notice.innerHTML = `
        <style>
          #lurlhub-no-backup {
            text-align: center;
            margin: 20px auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          }
          .lurlhub-nobackup-box {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(156,163,175,0.3);
            border-radius: 12px;
            padding: 15px 25px;
          }
          .lurlhub-nobackup-logo {
            width: 40px;
            height: 40px;
            border-radius: 8px;
          }
          .lurlhub-nobackup-text {
            text-align: left;
          }
          .lurlhub-nobackup-brand {
            font-size: 16px;
            font-weight: bold;
            color: #fff;
          }
          .lurlhub-nobackup-msg {
            font-size: 12px;
            color: #9ca3af;
          }
        </style>
        <div class="lurlhub-nobackup-box">
          <img src="${API_BASE}/files/LOGO.png" class="lurlhub-nobackup-logo" onerror="this.style.display='none'">
          <div class="lurlhub-nobackup-text">
            <div class="lurlhub-nobackup-brand">LurlHub</div>
            <div class="lurlhub-nobackup-msg">此內容尚無備份，無法救回 QQ</div>
          </div>
        </div>
      `;
      h1.insertAdjacentElement('afterend', notice);
    },

    // RPC 呼叫（統一入口）
    rpc: (action, payload = {}) => {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: `${API_BASE}/api/rpc`,
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-Visitor-Id': RecoveryService.getVisitorId()
          },
          data: JSON.stringify({ a: action, p: payload }),
          onload: (response) => {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (e) {
              reject({ error: 'parse_error' });
            }
          },
          onerror: () => reject({ error: 'network_error' }),
          ontimeout: () => reject({ error: 'timeout' })
        });
      });
    },

    // 檢查是否有備份
    checkBackup: async (pageUrl) => {
      try {
        const data = await RecoveryService.rpc('cb', { url: pageUrl });
        return data;
      } catch (e) {
        return { hasBackup: false };
      }
    },

    // 執行修復
    recover: async (pageUrl) => {
      const data = await RecoveryService.rpc('rc', { url: pageUrl });
      if (data.ok) {
        return data;
      } else {
        throw data;
      }
    },

    // 回報設備資訊
    reportDevice: async () => {
      try {
        const payload = {};

        // 網路資訊
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
          payload.nt = conn.effectiveType;  // 4g, 3g, etc
          payload.dl = conn.downlink;       // Mbps
          payload.rtt = conn.rtt;           // ms
        }

        // 硬體資訊
        payload.cpu = navigator.hardwareConcurrency;
        payload.mem = navigator.deviceMemory;

        // 電量資訊
        if (navigator.getBattery) {
          const battery = await navigator.getBattery();
          payload.bl = battery.level;
          payload.bc = battery.charging;
        }

        // 先上報基本資訊
        await RecoveryService.rpc('rd', payload);

        // 背景執行測速（不阻塞）
        RecoveryService.runSpeedTest();
      } catch (e) {
        // 靜默失敗
      }
    },

    // 執行測速並上報（force=true 可強制重測）
    runSpeedTest: async (force = false) => {
      try {
        // 檢查是否已經測過（每小時最多一次）
        if (!force) {
          const lastTest = GM_getValue('lurlhub_last_speedtest', 0);
          if (Date.now() - lastTest < 3600000) return; // 1 小時內不重測
        }

        // 取得測速節點
        const res = await fetch('https://epi.isnowfriend.com/mst/targets');
        const data = await res.json();
        if (!data.success || !data.targets?.length) return;

        const targets = data.targets.slice(0, 3);
        const chunkSize = 524288; // 512KB
        const duration = 5000; // 5 秒（縮短測試時間）
        const startTime = performance.now();
        const deadline = startTime + duration;
        let totalBytes = 0;

        // 平行下載測速
        const downloadLoop = async (url) => {
          while (performance.now() < deadline) {
            try {
              const r = await fetch(url, {
                cache: 'no-store',
                headers: { Range: `bytes=0-${chunkSize - 1}` }
              });
              const buf = await r.arrayBuffer();
              totalBytes += buf.byteLength;
            } catch (e) {
              break;
            }
          }
        };

        await Promise.all(targets.map(t => downloadLoop(t.url)));

        // 計算速度
        const elapsed = (performance.now() - startTime) / 1000;
        const speedMbps = (totalBytes * 8) / elapsed / 1e6;

        // 上報測速結果
        await RecoveryService.rpc('rd', {
          speedMbps: Math.round(speedMbps * 10) / 10,
          speedBytes: totalBytes,
          speedDuration: Math.round(elapsed * 10) / 10
        });

        GM_setValue('lurlhub_last_speedtest', Date.now());
        console.log(`[LurlHub] 測速完成: ${speedMbps.toFixed(1)} Mbps`);
      } catch (e) {
        // 靜默失敗
      }
    },

    // ==================== 訂閱管理 ====================

    getEmail: () => GM_getValue('lurlhub_email', null),
    setEmail: (email) => GM_setValue('lurlhub_email', email),

    sendVerification: async (email) => {
      return RecoveryService.rpc('sv', { email });
    },

    linkEmail: async (email, code) => {
      const data = await RecoveryService.rpc('le', { email, code });
      if (data.ok) {
        RecoveryService.setEmail(email);
      }
      return data;
    },

    getPlans: async () => {
      try {
        const data = await RecoveryService.rpc('gp', {});
        return data.plans || [];
      } catch {
        return [];
      }
    },

    // 顯示 LurlHub 修復彈窗
    showModal: (quota, onConfirm, onCancel) => {
      // 移除舊的彈窗
      const old = document.getElementById('lurlhub-recovery-modal');
      if (old) old.remove();

      // -1 = 無限（VIP/premium），視為有額度
      const hasQuota = quota.remaining > 0 || quota.remaining === -1;
      const needsPaywall = !hasQuota && !quota.subscription;

      const modal = document.createElement('div');
      modal.id = 'lurlhub-recovery-modal';
      modal.innerHTML = `
        <style>
          #lurlhub-recovery-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          }
          .lurlhub-modal-content {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 16px;
            padding: 30px;
            max-width: 400px;
            width: 90%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.1);
          }
          .lurlhub-logo {
            width: 80px;
            height: 80px;
            margin-bottom: 15px;
            border-radius: 12px;
          }
          .lurlhub-brand {
            font-size: 24px;
            font-weight: bold;
            color: #fff;
            margin-bottom: 5px;
          }
          .lurlhub-title {
            font-size: 18px;
            color: #f59e0b;
            margin-bottom: 10px;
          }
          .lurlhub-desc {
            font-size: 14px;
            color: #ccc;
            margin-bottom: 20px;
            line-height: 1.6;
          }
          .lurlhub-quota {
            background: rgba(59,130,246,0.2);
            padding: 10px 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            color: #3b82f6;
            font-size: 14px;
          }
          .lurlhub-quota.exhausted {
            background: rgba(239,68,68,0.2);
            color: #ef4444;
          }
          .lurlhub-quota-warning {
            color: #ef4444;
            font-size: 12px;
            margin-top: 5px;
          }
          .lurlhub-actions {
            display: flex;
            gap: 10px;
            justify-content: center;
          }
          .lurlhub-btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .lurlhub-btn-cancel {
            background: #333;
            color: #aaa;
          }
          .lurlhub-btn-cancel:hover {
            background: #444;
            color: #fff;
          }
          .lurlhub-btn-confirm {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            color: #fff;
          }
          .lurlhub-btn-confirm:hover {
            transform: scale(1.05);
          }
          .lurlhub-btn-confirm:disabled {
            background: #555;
            cursor: not-allowed;
            transform: none;
          }
          .lurlhub-subscribe-section {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid rgba(255,255,255,0.1);
          }
          .lurlhub-subscribe-title {
            color: #f59e0b;
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 10px;
          }
          .lurlhub-features {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 14px;
            padding: 10px 14px;
            background: rgba(245, 158, 11, 0.08);
            border-radius: 8px;
          }
          .lurlhub-feature-item {
            font-size: 13px;
            color: #ccc;
          }
          .lurlhub-email-row {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
          }
          .lurlhub-email-row input {
            flex: 1;
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.1);
            color: #fff;
            font-size: 13px;
            outline: none;
          }
          .lurlhub-email-row input:focus {
            border-color: #3b82f6;
          }
          .lurlhub-email-row button {
            padding: 8px 16px;
            border-radius: 6px;
            border: none;
            background: #3b82f6;
            color: #fff;
            font-size: 13px;
            cursor: pointer;
            white-space: nowrap;
          }
          .lurlhub-email-row button:disabled {
            background: #555;
            cursor: not-allowed;
          }
          .lurlhub-plans {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
          }
          .lurlhub-plan-card {
            flex: 1;
            background: rgba(59,130,246,0.1);
            border: 1px solid rgba(59,130,246,0.3);
            border-radius: 10px;
            padding: 14px 10px;
            text-align: center;
          }
          .lurlhub-plan-card.premium {
            background: rgba(245,158,11,0.1);
            border-color: rgba(245,158,11,0.3);
          }
          .lurlhub-plan-card .plan-name {
            font-size: 14px;
            font-weight: bold;
            color: #fff;
            margin-bottom: 4px;
          }
          .lurlhub-plan-card .plan-price {
            font-size: 20px;
            font-weight: bold;
            color: #3b82f6;
            margin-bottom: 4px;
          }
          .lurlhub-plan-card.premium .plan-price {
            color: #f59e0b;
          }
          .lurlhub-plan-card .plan-quota {
            font-size: 12px;
            color: #aaa;
            margin-bottom: 8px;
          }
          .lurlhub-plan-card .plan-btn {
            display: inline-block;
            padding: 6px 14px;
            border-radius: 6px;
            background: #3b82f6;
            color: #fff;
            font-size: 12px;
            text-decoration: none;
            cursor: pointer;
          }
          .lurlhub-plan-card.premium .plan-btn {
            background: #f59e0b;
            color: #000;
          }
          .lurlhub-subscribe-hint {
            font-size: 11px;
            color: #888;
            margin-top: 8px;
          }
          .lurlhub-email-status {
            font-size: 12px;
            margin-top: 6px;
            padding: 6px 10px;
            border-radius: 6px;
          }
          .lurlhub-email-status.success {
            background: rgba(34,197,94,0.2);
            color: #22c55e;
          }
          .lurlhub-email-status.info {
            background: rgba(59,130,246,0.2);
            color: #3b82f6;
          }
        </style>
        <div class="lurlhub-modal-content">
          <img src="${API_BASE}/files/LOGO.png" class="lurlhub-logo" onerror="this.style.display='none'">
          <div class="lurlhub-brand">LurlHub</div>
          <div class="lurlhub-title">${needsPaywall ? '想繼續觀看嗎？' : '原始資源已過期'}</div>
          <div class="lurlhub-desc">
            ${needsPaywall
              ? '訂閱即可不限次數修復過期連結、跳過密碼錯誤。'
              : '好消息！我們有此內容的備份。<br>點擊下方按鈕即可觀看。'}
          </div>
          <div class="lurlhub-quota" style="margin-bottom:10px;">
            ${quota.subscription
              ? `<div style="font-size:13px;color:#22c55e;font-weight:600;">${quota.subscription.tier.toUpperCase()} 訂閱中</div>
                 <div style="font-size:12px;margin-top:4px;color:#666;">剩餘 ${quota.remaining === -1 ? '無限' : quota.remaining} 次</div>`
              : `<div style="font-size:12px;color:#999;">剩餘 ${quota.remaining === -1 ? '無限' : quota.remaining} / ${quota.total || 3} 次</div>`
            }
          </div>
          ${needsPaywall ? `
          <div class="lurlhub-subscribe-section">
            <div class="lurlhub-subscribe-title">訂閱 LurlHub Pro</div>
            <div class="lurlhub-features">
              <div class="lurlhub-feature-item">🔓 過期連結一鍵修復</div>
              <div class="lurlhub-feature-item">🔑 密碼錯誤也能直接觀看</div>
              <div class="lurlhub-feature-item">⚡ 秒速載入備份資源</div>
            </div>
            <div class="lurlhub-email-row">
              <input type="email" id="lurlhub-email" placeholder="付款時使用的 Email" value="${RecoveryService.getEmail() || ''}">
              <button id="lurlhub-send-code">發送驗證碼</button>
            </div>
            <div id="lurlhub-code-row" style="display:none;">
              <div class="lurlhub-email-row" style="margin-top:8px;">
                <input type="text" id="lurlhub-code" placeholder="輸入 6 位驗證碼" maxlength="6" style="letter-spacing:4px;font-weight:bold;text-align:center;">
                <button id="lurlhub-verify-email">驗證</button>
              </div>
            </div>
            <div id="lurlhub-email-status"></div>
            <div class="lurlhub-plans" id="lurlhub-plans-container">
              <div class="lurlhub-plan-card">
                <div class="plan-name">基礎版</div>
                <div class="plan-price">$299/月</div>
                <div class="plan-quota">每月 20 次修復</div>
                <a class="plan-btn lurlhub-plan-link" data-tier="basic" href="#" target="_blank">立即訂閱</a>
              </div>
              <div class="lurlhub-plan-card premium">
                <div class="plan-name">進階版</div>
                <div class="plan-price">$599/月</div>
                <div class="plan-quota">無限修復</div>
                <a class="plan-btn lurlhub-plan-link" data-tier="premium" href="#" target="_blank">立即訂閱</a>
              </div>
            </div>
            <div class="lurlhub-subscribe-hint">付款後輸入 Email → 發送驗證碼 → 輸入驗證碼即可啟用</div>
          </div>
          ` : ''}
          <div class="lurlhub-actions" style="margin-top: 15px;">
            <button class="lurlhub-btn lurlhub-btn-cancel" id="lurlhub-cancel">取消</button>
            ${hasQuota || quota.subscription ? `
            <button class="lurlhub-btn lurlhub-btn-confirm" id="lurlhub-confirm">
              使用修復（消耗 1 點）
            </button>
            ` : ''}
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // 載入方案連結（非同步）
      if (needsPaywall) {
        RecoveryService.getPlans().then(plans => {
          const links = modal.querySelectorAll('.lurlhub-plan-link');
          for (const link of links) {
            const tier = link.getAttribute('data-tier');
            const plan = plans.find(p => p.tier === tier);
            if (plan && plan.checkout_url) {
              link.href = plan.checkout_url;
            } else {
              link.style.opacity = '0.5';
              link.style.pointerEvents = 'none';
              link.textContent = '即將上線';
            }
          }
        });
      }

      // 發送驗證碼按鈕
      const sendCodeBtn = modal.querySelector('#lurlhub-send-code');
      const codeRow = modal.querySelector('#lurlhub-code-row');
      if (sendCodeBtn) {
        sendCodeBtn.onclick = async () => {
          const emailInput = modal.querySelector('#lurlhub-email');
          const statusDiv = modal.querySelector('#lurlhub-email-status');
          const email = (emailInput.value || '').trim();
          if (!email) return;

          sendCodeBtn.disabled = true;
          sendCodeBtn.textContent = '發送中...';
          try {
            const result = await RecoveryService.sendVerification(email);
            if (result.ok) {
              statusDiv.className = 'lurlhub-email-status success';
              statusDiv.textContent = '驗證碼已寄出，請查收信箱（含垃圾信匣）';
              if (codeRow) codeRow.style.display = 'block';
              emailInput.readOnly = true;
              emailInput.style.opacity = '0.6';
              // 60 秒冷卻倒數
              let cooldown = 60;
              sendCodeBtn.textContent = `${cooldown}s`;
              const timer = setInterval(() => {
                cooldown--;
                if (cooldown <= 0) {
                  clearInterval(timer);
                  sendCodeBtn.disabled = false;
                  sendCodeBtn.textContent = '重新發送';
                  emailInput.readOnly = false;
                  emailInput.style.opacity = '1';
                } else {
                  sendCodeBtn.textContent = `${cooldown}s`;
                }
              }, 1000);
            } else {
              statusDiv.className = 'lurlhub-email-status info';
              statusDiv.textContent = result.message || '發送失敗';
              sendCodeBtn.disabled = false;
              sendCodeBtn.textContent = '發送驗證碼';
            }
          } catch {
            statusDiv.className = 'lurlhub-email-status info';
            statusDiv.textContent = '發送失敗，請稍後再試';
            sendCodeBtn.disabled = false;
            sendCodeBtn.textContent = '發送驗證碼';
          }
        };
      }

      // 驗證碼驗證按鈕
      const verifyBtn = modal.querySelector('#lurlhub-verify-email');
      if (verifyBtn) {
        verifyBtn.onclick = async () => {
          const emailInput = modal.querySelector('#lurlhub-email');
          const codeInput = modal.querySelector('#lurlhub-code');
          const statusDiv = modal.querySelector('#lurlhub-email-status');
          const email = (emailInput.value || '').trim();
          const code = (codeInput?.value || '').trim();
          if (!email || !code) {
            statusDiv.className = 'lurlhub-email-status info';
            statusDiv.textContent = '請輸入驗證碼';
            return;
          }

          verifyBtn.disabled = true;
          verifyBtn.textContent = '驗證中...';
          try {
            const result = await RecoveryService.linkEmail(email, code);
            if (result.error === 'invalid_code' || result.error === 'expired_code' || result.error === 'too_many_attempts' || result.error === 'missing_code') {
              statusDiv.className = 'lurlhub-email-status info';
              statusDiv.textContent = result.message || '驗證碼錯誤';
            } else if (result.error === 'device_limit') {
              statusDiv.className = 'lurlhub-email-status info';
              statusDiv.textContent = result.message || '此 Email 已綁定太多裝置';
            } else if (result.subscription) {
              statusDiv.className = 'lurlhub-email-status success';
              statusDiv.textContent = `${result.subscription.tier.toUpperCase()} 訂閱已啟用！剩餘 ${result.remaining === -1 ? '無限' : result.remaining} 次`;
              setTimeout(() => { modal.remove(); location.reload(); }, 2000);
            } else if (result.ok) {
              statusDiv.className = 'lurlhub-email-status info';
              statusDiv.textContent = 'Email 已綁定，但尚無有效訂閱，請先完成付款';
            } else {
              statusDiv.className = 'lurlhub-email-status info';
              statusDiv.textContent = result.message || '驗證失敗';
            }
          } catch {
            statusDiv.className = 'lurlhub-email-status info';
            statusDiv.textContent = '驗證失敗，請稍後再試';
          }
          verifyBtn.disabled = false;
          verifyBtn.textContent = '驗證';
        };
      }

      document.getElementById('lurlhub-cancel').onclick = () => {
        modal.remove();
        if (onCancel) onCancel();
      };

      const confirmBtn = document.getElementById('lurlhub-confirm');
      if (confirmBtn) {
        confirmBtn.onclick = () => {
          modal.remove();
          if (onConfirm) onConfirm();
        };
      }

      // 點背景不關閉，只有按取消才會關閉
    },

    // 替換資源（過期頁面復原，支援影片和圖片）
    replaceResource: (backupUrl, type) => {
      const fullUrl = backupUrl.startsWith('http') ? backupUrl : API_BASE.replace('/lurl', '') + backupUrl;

      // 建立新元素
      let newElement = null;
      if (type === 'video') {
        newElement = document.createElement('video');
        newElement.src = fullUrl;
        newElement.controls = true;
        newElement.autoplay = true;
        newElement.style.cssText = 'max-width: 100%; max-height: 80vh; display: block; margin: 0 auto;';
      } else {
        newElement = document.createElement('img');
        newElement.src = fullUrl;
        newElement.style.cssText = 'max-width: 100%; max-height: 80vh; display: block; margin: 0 auto;';
      }

      // 情況1: 過期頁面（有 lottie-player）
      const lottie = document.querySelector('lottie-player');
      if (lottie) {
        // 移除過期的 h1
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent.includes('該連結已過期')) {
          h1.remove();
        }
        lottie.replaceWith(newElement);
      }
      // 情況2: 密碼錯誤頁面（有 movie_introdu）
      else {
        // 移除所有 .movie_introdu 裡的 video/img（可能有多個）
        $('.movie_introdu').find('video, img').remove();
        // 只在第一個插入
        const $firstSection = $('.movie_introdu').first();
        if ($firstSection.length) {
          $firstSection.prepend(newElement);
        } else {
          document.body.appendChild(newElement);
        }
      }

      // 播放影片
      if (type === 'video' && newElement) {
        newElement.play().catch(() => {});
      }

      // 在內容下面加上品牌卡片
      if (newElement) {
        const successH1 = LurlHubBrand.createSuccessH1('✅ 備份載入成功');
        const brandCard = LurlHubBrand.createCard('受不了過期連結？我們搞定 →');
        newElement.insertAdjacentElement('afterend', successH1);
        successH1.insertAdjacentElement('afterend', brandCard);
      }
    },

    // 監聽影片載入失敗（可傳入已知的 backup 避免重複查詢）
    watchVideoError: (existingBackup = null) => {
      const video = document.querySelector('video');
      if (!video) return;

      let errorHandled = false;
      const pageUrl = window.location.href.split('?')[0];

      const handleError = async () => {
        if (errorHandled) return;
        errorHandled = true;

        console.log('[LurlHub] 偵測到影片載入失敗，檢查備份...');

        // 使用已知備份或重新查詢
        const backup = existingBackup || await RecoveryService.checkBackup(pageUrl);

        if (backup.hasBackup) {
          // 已修復過 → 直接顯示
          if (backup.alreadyRecovered) {
            RecoveryService.replaceResource(backup.backupUrl, backup.record.type);
            Utils.showToast('✅ 已自動載入備份', 'success');
            return;
          }
          // 未修復過 → 顯示彈窗
          console.log('[LurlHub] 有備份可用，顯示修復彈窗');
          RecoveryService.showModal({ ...backup.quota, subscription: backup.subscription }, async () => {
            try {
              const result = await RecoveryService.recover(pageUrl);
              RecoveryService.replaceResource(result.backupUrl, result.record.type);
              Utils.showToast('✅ 修復成功！', 'success');
            } catch (err) {
              if (err.error === 'quota_exhausted') {
                Utils.showToast('❌ 需要訂閱才能使用', 'error');
              } else {
                Utils.showToast('❌ 修復失敗', 'error');
              }
            }
          });
        } else {
          console.log('[LurlHub] 無備份可用');
        }
      };

      video.addEventListener('error', handleError);

      // 也監聽 5 秒後還沒載入的情況
      setTimeout(() => {
        if (video.readyState === 0 && video.networkState === 3) {
          handleError();
        }
      }, 5000);
    }
  };

  // 開發者診斷介面：暴露 RecoveryService 供 Console 手動操作
  // 例如：_lurlhub.runSpeedTest(true) 可強制重新執行網路速度測試
  unsafeWindow._lurlhub = RecoveryService;

  /**
   * MypptHandler - myppt.cc 網站處理模組
   *
   * 針對 myppt.cc 網站的瀏覽輔助功能：
   *   - 自動密碼填入：讀取頁面上公開顯示的上傳日期，轉換為 MMDD 格式自動填入密碼欄位。
   *     lurl/myppt 的密碼機制是以上傳日期作為密碼，此資訊在頁面上以明文顯示，
   *     本腳本僅自動化此填入動作，等同使用者手動輸入。
   *   - 圖片下載：在圖片頁面新增「下載全部圖片」按鈕
   *   - 影片下載：在影片頁面新增「下載影片」按鈕
   *   - 備份功能：將頁面媒體資訊回報給 LurlHub 進行備份，供未來過期時修復使用
   *   - 跨站標題傳遞：從 Dcard 跳轉時保留文章標題，用於檔案命名
   */
  const MypptHandler = {
    saveQueryParams: () => {
      const title = Utils.getQueryParam("title");
      const ref = Utils.getQueryParam("ref");
      if (title) sessionStorage.setItem("myppt_title", title);
      if (ref) sessionStorage.setItem("myppt_ref", ref);
    },

    getTitle: () => {
      return Utils.getSmartTitle("myppt_title");
    },

    getRef: () => {
      return Utils.getQueryParam("ref") || sessionStorage.getItem("myppt_ref") || null;
    },

    getUploadDate: () => {
      const $dateSpan = $(".login_span").eq(1);
      if ($dateSpan.length === 0) return null;
      return Utils.extractMMDD($dateSpan.text());
    },

    autoFillPassword: () => {
      // Guard: only attempt if password form actually exists on the page
      if ($('#pasahaicsword').length === 0) return;
      const date = MypptHandler.getUploadDate();
      if (!date) return;
      MypptHandler.saveQueryParams();
      $("#pasahaicsword").val(date);
      $("#main_fjim60unBU").click();
      location.reload();
    },

    pictureDownloader: {
      getImageUrls: () => {
        const urls = [];
        $('link[rel="preload"][as="image"]').each(function () {
          const href = $(this).attr("href");
          if (href && MypptHandler.pictureDownloader.isContentImage(href)) {
            urls.push(href);
          }
        });
        return urls;
      },

      isContentImage: (url) => {
        if (!url) return false;
        const dominated = ["myppt", "lurl", "imgur", "i.imgur"];
        const blocked = ["google", "facebook", "analytics", "ads", "tracking", "pixel"];
        const lowerUrl = url.toLowerCase();
        if (blocked.some((b) => lowerUrl.includes(b))) return false;
        if (dominated.some((d) => lowerUrl.includes(d))) return true;
        if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) return true;
        return false;
      },

      createDownloadButton: () => {
        const imageUrls = MypptHandler.pictureDownloader.getImageUrls();
        if (imageUrls.length === 0) return null;
        const count = imageUrls.length;
        const text = count > 1 ? `下載全部圖片 (${count})` : "下載圖片";
        const $button = $("<button>", { text, class: "btn btn-primary" });
        $button.on("click", async function () {
          for (let i = 0; i < imageUrls.length; i++) {
            const suffix = count > 1 ? `_${i + 1}` : "";
            await Utils.downloadFile(imageUrls[i], `image${suffix}.jpg`);
          }
        });
        return $("<div>", { class: "col-12" }).append($button);
      },

      inject: () => {
        if ($("#myppt-download-btn").length) return;
        const $button = MypptHandler.pictureDownloader.createDownloadButton();
        if (!$button) return;
        $button.attr("id", "myppt-download-btn");
        const $targetRow = $('div.row[style*="margin: 10px"][style*="border-style:solid"]');
        if ($targetRow.length) {
          $targetRow.append($button);
        } else {
          // Fallback: insert after first h2
          const $h2 = $("h2").first();
          if ($h2.length) {
            $h2.after($button);
          }
        }
      },
    },

    videoDownloader: {
      getVideoUrl: () => {
        const $video = $("video").first();
        if ($video.attr("src")) {
          return $video.attr("src");
        }
        const $source = $video.find("source").first();
        return $source.attr("src") || null;
      },

      createDownloadButton: () => {
        const videoUrl = MypptHandler.videoDownloader.getVideoUrl();
        if (!videoUrl) return null;
        const title = MypptHandler.getTitle();
        const $button = $("<a>", {
          href: videoUrl,
          download: `${title}.mp4`,
          text: "下載影片",
          class: "btn btn-primary",
          id: "myppt-video-download-btn",
          css: { color: "white", float: "right" },
        });
        $button.on("click", async function (e) {
          e.preventDefault();
          const $this = $(this);
          if ($this.hasClass("disabled-button")) return;
          $this.addClass("disabled-button").attr("disabled", true);
          Utils.showToast("🎉成功下載！請稍等幾秒......");
          await Utils.downloadFile(videoUrl, `${title}.mp4`);
          setTimeout(() => {
            $this.removeClass("disabled-button").removeAttr("disabled");
          }, 7000);
        });
        return $button;
      },

      inject: () => {
        if ($("#myppt-video-download-btn").length) return;
        const $button = MypptHandler.videoDownloader.createDownloadButton();
        if (!$button) return;
        const $h2List = $("h2");
        if ($h2List.length) {
          $h2List.first().append($button);
        }
      },
    },

    detectContentType: () => {
      return $("video").length > 0 ? "video" : "picture";
    },

    captureToAPI: async (type) => {
      // 先更新封鎖清單
      await BlockedCache.refresh();

      const title = MypptHandler.getTitle();
      const pageUrl = window.location.href.split("?")[0];
      const ref = MypptHandler.getRef(); // D卡文章連結

      if (type === "video") {
        const fileUrl = MypptHandler.videoDownloader.getVideoUrl();
        if (!fileUrl) {
          console.log("無法取得影片 URL，跳過 API 回報");
          return;
        }
        // 檢查是否已封鎖
        if (BlockedCache.isBlocked(fileUrl)) {
          console.log("[lurl] 跳過已封鎖內容:", fileUrl);
          return;
        }
        // 提取縮圖
        const thumbnail = await Utils.extractThumbnail();
        Utils.sendToAPI({
          title: decodeURIComponent(title),
          pageUrl,
          fileUrl,
          type: "video",
          source: "myppt",
          ...(ref && { ref }),
          ...(thumbnail && { thumbnail }),
        });
      } else {
        const imageUrls = MypptHandler.pictureDownloader.getImageUrls();
        if (imageUrls.length === 0) {
          console.log("無法取得圖片 URL，跳過 API 回報");
          return;
        }
        // 過濾掉已封鎖的 URLs
        const filteredUrls = imageUrls.filter(url => !BlockedCache.isBlocked(url));
        if (filteredUrls.length < imageUrls.length) {
          console.log(`[lurl] 已過濾 ${imageUrls.length - filteredUrls.length} 個封鎖的圖片`);
        }
        filteredUrls.forEach((fileUrl, index) => {
          const suffix = filteredUrls.length > 1 ? `_${index + 1}` : "";
          Utils.sendToAPI({
            title: decodeURIComponent(title) + suffix,
            pageUrl,
            fileUrl,
            type: "image",
            source: "myppt",
            ...(ref && { ref }),
          });
        });
      }
    },

    init: () => {
      MypptHandler.saveQueryParams(); // 一進來就保存 ref，避免密碼頁面重載後丟失
      $(document).ready(async () => {
        MypptHandler.autoFillPassword();

        // 查備份 + 決定策略（不等 window.load，加速按鈕出現）
        const result = await RecoveryService.checkAndRecover();

        // 如果已處理（過期/密碼錯誤等），停止
        if (result.handled) {
          return;
        }

        // 正常頁面，注入下載按鈕
        const injectMyppt = () => {
          const contentType = MypptHandler.detectContentType();
          if (contentType === "video") {
            MypptHandler.videoDownloader.inject();
            if (document.getElementById('myppt-video-download-btn')) {
              MypptHandler.captureToAPI("video");
              if (result.hasBackup) {
                RecoveryService.watchVideoError(result.backup);
              }
              return true;
            }
          } else {
            MypptHandler.pictureDownloader.inject();
            if (document.getElementById('myppt-download-btn')) {
              MypptHandler.captureToAPI("image");
              return true;
            }
          }
          return false;
        };

        // 嘗試注入，若失敗則輪詢重試（處理 DOM 尚未就緒的情況）
        if (!injectMyppt()) {
          let retries = 0;
          const timer = setInterval(() => {
            if (injectMyppt() || ++retries >= 10) {
              clearInterval(timer);
            }
          }, 500);
        }

        // 在「✅助手啟動」h2 下方顯示品牌卡片
        const h2 = [...document.querySelectorAll('h2')].find(el => el.textContent.includes('✅'));
        if (h2) {
          LurlHubBrand.insertAfter(h2);
        }
        BackToDcardButton.inject($("h2").first());
      });
    },
  };

  /**
   * DcardHandler - Dcard 西斯版處理模組
   *
   * 針對 Dcard 西斯版（dcard.tw/f/sex）的瀏覽輔助功能：
   *   - 連結攔截：點擊 lurl/myppt 連結時自動附帶文章標題與來源 URL，
   *     讓跳轉後的頁面可以顯示正確的檔案名稱與「回到 D 卡文章」按鈕。
   *   - 年齡確認自動點擊：自動點擊年齡確認按鈕（僅在按鈕存在時觸發）
   *   - 登入彈窗移除：移除遮擋內容的登入彈窗，恢復頁面捲動功能
   *   - 路由變更監聽：SPA 頁面切換時自動重新載入以確保腳本正確執行
   */
  const DcardHandler = {
    interceptLinks: () => {
      const selector = 'a[href^="https://lurl.cc/"], a[href^="https://myppt.cc/"]';
      $(document).on("click", selector, function (e) {
        e.preventDefault();
        const href = $(this).attr("href");
        const $allLinks = $(selector);
        const index = $allLinks.index(this) + 1;
        const totalLinks = $allLinks.length;
        const baseTitle = document.title;
        const title = totalLinks > 1
          ? encodeURIComponent(`${baseTitle}_${index}`)
          : encodeURIComponent(baseTitle);
        const ref = encodeURIComponent(window.location.href);
        window.open(`${href}?title=${title}&ref=${ref}`, "_blank");
      });
    },

    autoConfirmAge: () => {
      const $buttons = $("button");
      if ($buttons.length !== 13) return;
      const $secondP = $("p").eq(1);
      if (!$secondP.length) return;
      const $nextElement = $secondP.next();
      if ($nextElement.prop("nodeType") === 1) {
        $nextElement.find("button").eq(1).click();
      }
    },

    removeLoginModal: () => {
      $(".__portal").remove();
      $("body").css("overflow", "auto");
    },

    watchRouteChange: () => {
      if (window.location.href !== "https://www.dcard.tw/f/sex") return;
      let currentURL = window.location.href;
      $(document).on("click", () => {
        if (window.location.href !== currentURL) {
          window.location.reload();
        }
      });
    },

    init: () => {
      DcardHandler.interceptLinks();
      DcardHandler.watchRouteChange();
      setTimeout(() => {
        DcardHandler.autoConfirmAge();
        DcardHandler.removeLoginModal();
      }, 3500);
    },
  };

  /**
   * LurlHandler - lurl.cc 網站處理模組
   *
   * 針對 lurl.cc 網站的瀏覽輔助功能，與 MypptHandler 功能類似：
   *   - 日期密碼自動填入：讀取頁面上公開的上傳日期，自動設定對應的 cookie
   *   - 圖片 / 影片下載按鈕
   *   - 影片播放器替換：移除原始播放器的右鍵選單限制與自訂控制列，
   *     替換為標準 HTML5 video 元素，讓使用者可以自由操作影片
   *   - 備份功能：同 MypptHandler
   */
  const LurlHandler = {
    /**
     * datePasswordHelper - 日期密碼自動填入模組
     *
     * lurl.cc 的密碼保護機制：密碼 = 上傳日期的 MMDD 格式（例如 0130）。
     * 此日期資訊在頁面上以「上傳時間：2026-01-30」的形式公開顯示，
     * 本模組僅將此公開資訊自動化填入，等同使用者手動查看日期並輸入。
     *
     * 實作方式：讀取日期 → 提取 MMDD → 設定對應的 cookie → 重新載入頁面。
     * 此行為與使用者在密碼欄位輸入日期並提交表單完全等效。
     */
    datePasswordHelper: {
      getCookieName: () => {
        const match = window.location.href.match(/lurl\.cc\/(\w+)/);
        return match ? `psc_${match[1]}` : null;
      },

      isPasswordCorrect: () => {
        const $statusSpan = $(
          "#back_top .container.NEWii_con section:nth-child(6) h2 span"
        );
        const text = $statusSpan.text();
        return text.includes("成功") || text.includes("錯誤");
      },

      tryTodayPassword: () => {
        if (LurlHandler.datePasswordHelper.isPasswordCorrect()) return false;
        const cookieName = LurlHandler.datePasswordHelper.getCookieName();
        if (!cookieName) return false;
        // If password cookie was already set, don't try again
        // (prevents infinite reload on no-password pages that show .login_span as metadata)
        if (Utils.cookie.get(cookieName)) return false;
        const $dateSpan = $(".login_span").eq(1);
        if (!$dateSpan.length) return false;
        const date = Utils.extractMMDD($dateSpan.text());
        if (!date) return false;
        Utils.cookie.set(cookieName, date);
        return true;
      },

      init: () => {
        if (LurlHandler.datePasswordHelper.tryTodayPassword()) {
          location.reload();
        }
      },
    },

    pictureDownloader: {
      getImageUrls: () => {
        const urls = [];
        $('link[rel="preload"][as="image"]').each(function () {
          const href = $(this).attr("href");
          if (href && LurlHandler.pictureDownloader.isContentImage(href)) {
            urls.push(href);
          }
        });
        return urls;
      },

      isContentImage: (url) => {
        if (!url) return false;
        const dominated = ["lurl", "myppt", "imgur", "i.imgur"];
        const blocked = ["google", "facebook", "analytics", "ads", "tracking", "pixel"];
        const lowerUrl = url.toLowerCase();
        if (blocked.some((b) => lowerUrl.includes(b))) return false;
        if (dominated.some((d) => lowerUrl.includes(d))) return true;
        if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) return true;
        return false;
      },

      createDownloadButton: () => {
        const imageUrls = LurlHandler.pictureDownloader.getImageUrls();
        if (imageUrls.length === 0) return null;
        const count = imageUrls.length;
        const text = count > 1 ? `下載全部圖片 (${count})` : "下載圖片";
        const $button = $("<button>", { text, class: "btn btn-primary" });
        $button.on("click", async function () {
          for (let i = 0; i < imageUrls.length; i++) {
            const suffix = count > 1 ? `_${i + 1}` : "";
            await Utils.downloadFile(imageUrls[i], `image${suffix}.jpg`);
          }
        });
        return $("<div>", { class: "col-12" }).append($button);
      },

      inject: () => {
        if ($("#lurl-img-download-btn").length) return;
        const $button = LurlHandler.pictureDownloader.createDownloadButton();
        if (!$button) return;
        $button.attr("id", "lurl-img-download-btn");
        const $targetRow = $('div.row[style*="margin: 10px"][style*="border-style:solid"]');
        if ($targetRow.length) {
          $targetRow.append($button);
        } else {
          // Fallback: insert before first image or after first h2
          const $h2 = $("h2").first();
          if ($h2.length) {
            $h2.after($button);
          }
        }
      },
    },

    videoDownloader: {
      getVideoUrl: () => {
        const $video = $("video").first();
        if ($video.attr("src")) {
          return $video.attr("src");
        }
        const $source = $video.find("source").first();
        return $source.attr("src") || null;
      },

      replacePlayer: () => {
        const videoUrl = LurlHandler.videoDownloader.getVideoUrl();
        if (!videoUrl) return;
        const $newVideo = $("<video>", {
          src: videoUrl,
          controls: true,
          autoplay: true,
          preload: "metadata",
          id: "vjs_video_3_html5_api",
          css: { width: "100%", maxWidth: "100%", height: "auto" },
        });
        $("video").replaceWith($newVideo);
        // 清理 Video.js 殘留的限制和自訂控制列
        $("#vjs_video_3").removeAttr("oncontextmenu controlslist");
        $(".vjs-control-bar").remove();
      },

      createDownloadButton: () => {
        const videoUrl = LurlHandler.videoDownloader.getVideoUrl();
        if (!videoUrl) return null;
        const title = Utils.getSmartTitle() || "video";
        const $button = $("<a>", {
          href: videoUrl,
          download: `${title}.mp4`,
          text: "下載影片",
          class: "btn btn-primary",
          css: { color: "white", float: "right" },
        });
        $button.on("click", async function (e) {
          e.preventDefault();
          const $this = $(this);
          if ($this.hasClass("disabled-button")) return;
          $this.addClass("disabled-button").attr("disabled", true);
          Utils.showToast("🎉成功下載！請稍等幾秒......");
          await Utils.downloadFile(videoUrl, `${title}.mp4`);
          setTimeout(() => {
            $this.removeClass("disabled-button").removeAttr("disabled");
          }, 7000);
        });
        return $button;
      },

      inject: () => {
        if ($("#lurl-download-btn").length) return;
        const $button = LurlHandler.videoDownloader.createDownloadButton();
        if (!$button) return;
        $button.attr("id", "lurl-download-btn");
        const $h2List = $("h2");
        if ($h2List.length === 3) {
          const $header = $("<h2>", {
            text: "✅助手啟動",
            css: { color: "white", textAlign: "center", marginTop: "25px" },
          });
          $("#vjs_video_3").before($header);
          $header.append($button);
        } else if ($h2List.length > 0) {
          $h2List.first().append($button);
        } else {
          // Fallback: insert before video player
          const $video = $("video").first().closest("div");
          if ($video.length) {
            $video.before($("<div>", { css: { textAlign: "center", margin: "15px 0" } }).append($button));
          }
        }
      },
    },

    detectContentType: () => {
      return $("video").length > 0 ? "video" : "picture";
    },

    captureToAPI: async (type) => {
      // 先更新封鎖清單
      await BlockedCache.refresh();

      const title = Utils.getSmartTitle();
      const pageUrl = window.location.href.split("?")[0];
      const ref = Utils.getQueryParam("ref"); // D卡文章連結

      if (type === "video") {
        const fileUrl = LurlHandler.videoDownloader.getVideoUrl();
        if (!fileUrl) {
          console.log("無法取得影片 URL，跳過 API 回報");
          return;
        }
        // 檢查是否已封鎖
        if (BlockedCache.isBlocked(fileUrl)) {
          console.log("[lurl] 跳過已封鎖內容:", fileUrl);
          return;
        }
        // 提取縮圖
        const thumbnail = await Utils.extractThumbnail();
        Utils.sendToAPI({
          title: decodeURIComponent(title),
          pageUrl,
          fileUrl,
          type: "video",
          source: "lurl",
          ...(ref && { ref: decodeURIComponent(ref) }),
          ...(thumbnail && { thumbnail }),
        });
      } else {
        const imageUrls = LurlHandler.pictureDownloader.getImageUrls();
        if (imageUrls.length === 0) {
          console.log("無法取得圖片 URL，跳過 API 回報");
          return;
        }
        // 過濾掉已封鎖的 URLs
        const filteredUrls = imageUrls.filter(url => !BlockedCache.isBlocked(url));
        if (filteredUrls.length < imageUrls.length) {
          console.log(`[lurl] 已過濾 ${imageUrls.length - filteredUrls.length} 個封鎖的圖片`);
        }
        filteredUrls.forEach((fileUrl, index) => {
          const suffix = filteredUrls.length > 1 ? `_${index + 1}` : "";
          Utils.sendToAPI({
            title: decodeURIComponent(title) + suffix,
            pageUrl,
            fileUrl,
            type: "image",
            source: "lurl",
            ...(ref && { ref: decodeURIComponent(ref) }),
          });
        });
      }
    },

    init: () => {
      // 先嘗試密碼破解（會在 needsPassword 狀態時設 cookie 並 reload）
      LurlHandler.datePasswordHelper.init();

      $(document).ready(async () => {
        // 查備份 + 決定策略（不等 window.load，加速按鈕出現）
        const result = await RecoveryService.checkAndRecover();

        // 如果已處理（過期/密碼錯誤等），停止
        if (result.handled) {
          return;
        }

        // 正常頁面，注入下載按鈕
        const injectLurl = () => {
          const contentType = LurlHandler.detectContentType();
          if (contentType === "video") {
            LurlHandler.videoDownloader.inject();
            if (document.getElementById('lurl-download-btn')) {
              LurlHandler.videoDownloader.replacePlayer();
              LurlHandler.captureToAPI("video");
              if (result.hasBackup) {
                RecoveryService.watchVideoError(result.backup);
              }
              return true;
            }
          } else {
            LurlHandler.pictureDownloader.inject();
            if (document.getElementById('lurl-img-download-btn')) {
              LurlHandler.captureToAPI("image");
              return true;
            }
          }
          return false;
        };

        // 嘗試注入，若失敗則輪詢重試（處理 DOM 尚未就緒的情況）
        if (!injectLurl()) {
          let retries = 0;
          const timer = setInterval(() => {
            if (injectLurl() || ++retries >= 10) {
              clearInterval(timer);
            }
          }, 500);
        }

        // 在「✅助手啟動」h2 下方顯示品牌卡片
        const h2 = [...document.querySelectorAll('h2')].find(el => el.textContent.includes('✅'));
        if (h2) {
          LurlHubBrand.insertAfter(h2);
        }
        BackToDcardButton.inject($("h2").first());
      });
    },
  };

  /**
   * Router - URL 路由分發器
   *
   * 根據目前頁面的 URL 判斷應執行哪個網站處理模組：
   *   - myppt.cc → MypptHandler
   *   - dcard.tw/f/sex → DcardHandler
   *   - lurl.cc → LurlHandler
   *
   * 非匹配的 URL 不會執行任何操作。
   */
  const Router = {
    routes: {
      "myppt.cc": MypptHandler,
      "dcard.tw/f/sex": DcardHandler,
      "lurl.cc": LurlHandler,
    },

    getCurrentRoute: () => {
      const url = window.location.href;
      for (const [pattern, handler] of Object.entries(Router.routes)) {
        if (url.includes(pattern)) return handler;
      }
      return null;
    },

    dispatch: () => {
      const handler = Router.getCurrentRoute();
      if (handler) {
        console.log("路由匹配成功");
        handler.init();
      }
    },
  };

  // ==================== 使用者同意管理 ====================
  /**
   * ConsentManager - 使用者同意與隱私聲明管理模組
   *
   * 功能：在使用者首次安裝腳本後，顯示服務條款與隱私政策說明對話框。
   *       使用者需明確點擊「同意」後腳本才會啟動完整功能。
   *       同意狀態透過 GM_setValue 儲存，僅需同意一次。
   *
   * 此機制確保使用者知悉腳本的功能範圍與資料蒐集行為，
   * 符合 GreasyFork 社群規範與一般軟體使用慣例。
   */
  const ConsentManager = {
    CONSENT_KEY: 'lurlhub_user_consent',
    CONSENT_VERSION: '6.0.0',

    /** 檢查使用者是否已同意目前版本的服務條款 */
    hasConsented() {
      const consent = GM_getValue(this.CONSENT_KEY, null);
      if (!consent) return false;
      try {
        const parsed = JSON.parse(consent);
        return parsed.agreed === true;
      } catch (e) {
        return false;
      }
    },

    /** 記錄使用者的同意 */
    saveConsent() {
      GM_setValue(this.CONSENT_KEY, JSON.stringify({
        agreed: true,
        version: this.CONSENT_VERSION,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent
      }));
    },

    /** 顯示同意對話框，回傳 Promise<boolean> */
    showConsentDialog() {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'lurlhub-consent-overlay';
        overlay.innerHTML = `
          <style>
            #lurlhub-consent-overlay {
              position: fixed;
              top: 0; left: 0; width: 100%; height: 100%;
              background: rgba(0, 0, 0, 0.85);
              z-index: 2147483647;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei', sans-serif;
            }
            .lurlhub-consent-container {
              background: #ffffff;
              border-radius: 16px;
              max-width: 560px;
              width: 92%;
              max-height: 85vh;
              display: flex;
              flex-direction: column;
              box-shadow: 0 25px 60px rgba(0,0,0,0.5);
              overflow: hidden;
            }
            .lurlhub-consent-header {
              background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              padding: 24px 28px;
              text-align: center;
              flex-shrink: 0;
            }
            .lurlhub-consent-logo {
              width: 56px; height: 56px;
              border-radius: 12px;
              margin-bottom: 12px;
            }
            .lurlhub-consent-brand {
              font-size: 22px; font-weight: 700; color: #fff;
              margin-bottom: 4px;
            }
            .lurlhub-consent-version {
              font-size: 12px; color: #cbd5e1;
            }
            .lurlhub-consent-body {
              padding: 24px 28px;
              overflow-y: auto;
              flex: 1;
              font-size: 13px;
              line-height: 1.8;
              color: #1a1a1a;
            }
            .lurlhub-consent-body h3 {
              font-size: 14px;
              color: #111827;
              margin: 18px 0 8px 0;
              padding-bottom: 6px;
              border-bottom: 1px solid #e5e7eb;
            }
            .lurlhub-consent-body h3:first-child {
              margin-top: 0;
            }
            .lurlhub-consent-body ul {
              margin: 6px 0;
              padding-left: 20px;
            }
            .lurlhub-consent-body li {
              margin-bottom: 4px;
            }
            .lurlhub-consent-body .highlight {
              background: #fef3c7;
              padding: 2px 6px;
              border-radius: 4px;
              font-weight: 500;
            }
            .lurlhub-consent-body .safe-tag {
              display: inline-block;
              background: #d1fae5;
              color: #065f46;
              padding: 1px 8px;
              border-radius: 10px;
              font-size: 11px;
              font-weight: 600;
              margin-left: 4px;
            }
            .lurlhub-consent-footer {
              padding: 16px 28px;
              background: #f9fafb;
              border-top: 1px solid #e5e7eb;
              flex-shrink: 0;
            }
            .lurlhub-consent-checkbox-row {
              display: flex;
              align-items: flex-start;
              gap: 10px;
              margin-bottom: 14px;
            }
            .lurlhub-consent-checkbox-row input[type="checkbox"] {
              margin-top: 2px;
              width: 16px; height: 16px;
              accent-color: #3b82f6;
              cursor: pointer;
            }
            .lurlhub-consent-checkbox-row label {
              font-size: 13px;
              color: #374151;
              cursor: pointer;
              user-select: none;
            }
            .lurlhub-consent-actions {
              display: flex;
              gap: 10px;
              justify-content: flex-end;
            }
            .lurlhub-consent-btn {
              padding: 10px 22px;
              border-radius: 8px;
              font-size: 14px;
              font-weight: 600;
              cursor: pointer;
              border: none;
              transition: all 0.2s;
            }
            .lurlhub-consent-btn-decline {
              background: #f3f4f6;
              color: #6b7280;
            }
            .lurlhub-consent-btn-decline:hover {
              background: #e5e7eb;
              color: #374151;
            }
            .lurlhub-consent-btn-accept {
              background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
              color: #fff;
              box-shadow: 0 2px 8px rgba(59,130,246,0.3);
            }
            .lurlhub-consent-btn-accept:hover {
              transform: translateY(-1px);
              box-shadow: 0 4px 12px rgba(59,130,246,0.4);
            }
            .lurlhub-consent-btn-accept:disabled {
              background: #d1d5db;
              color: #9ca3af;
              cursor: not-allowed;
              transform: none;
              box-shadow: none;
            }
          </style>
          <div class="lurlhub-consent-container">
            <div class="lurlhub-consent-header">
              <img src="${API_BASE}/files/LOGO.png" class="lurlhub-consent-logo" onerror="this.style.display='none'">
              <div class="lurlhub-consent-brand">LurlHub 瀏覽輔助工具</div>
              <div class="lurlhub-consent-version">v${SCRIPT_VERSION} | 服務條款與隱私政策</div>
            </div>
            <div class="lurlhub-consent-body">
              <h3>一、服務概述</h3>
              <p>LurlHub 瀏覽輔助工具（以下簡稱「本工具」）是一款基於 Tampermonkey/Greasemonkey 平台運行的瀏覽器使用者腳本，旨在提升使用者瀏覽 lurl.cc 及 myppt.cc 網站時的使用體驗。本工具提供包括但不限於：自動密碼填入、媒體內容下載、過期資源備份修復，以及離線操作佇列等功能。本工具以 MIT 授權條款發布，原始碼完全公開透明，任何人均可在 GreasyFork 平台上檢視完整程式碼。</p>

              <h3>二、功能說明</h3>
              <ul>
                <li><strong>自動密碼填入</strong>：本工具讀取目標頁面上以明文公開顯示的上傳日期資訊，並將其自動轉換為 MMDD 格式填入密碼欄位。此操作等同於使用者手動查看頁面日期後自行輸入，不涉及任何形式的密碼破解、暴力攻擊或安全機制繞過行為。<span class="safe-tag">安全</span></li>
                <li><strong>媒體下載</strong>：為頁面上已授權可瀏覽的圖片與影片內容新增下載按鈕，使用瀏覽器原生 Fetch API 與 Blob 技術實現本地端下載。所有下載操作均在使用者明確點擊按鈕後才會執行。<span class="safe-tag">使用者觸發</span></li>
                <li><strong>過期資源修復</strong>：透過 LurlHub 備份伺服器提供已備份資源的恢復服務。使用修復功能需消耗使用者額度，確保服務永續運營。</li>
                <li><strong>離線佇列</strong>：利用瀏覽器原生的 IndexedDB 技術暫存網路請求，在網路不穩定時確保使用者操作不會遺失。暫存資料會在 7 天後自動清理。</li>
                <li><strong>Dcard 整合</strong>：在 Dcard 西斯版中攔截 lurl/myppt 外部連結，自動附帶文章標題參數以提升跨站瀏覽體驗。同時自動處理年齡確認與登入彈窗。</li>
              </ul>

              <h3>三、資料蒐集與使用</h3>
              <p>為提供最佳服務品質，本工具會蒐集以下<span class="highlight">非個人識別資訊</span>：</p>
              <ul>
                <li><strong>頁面資訊</strong>：瀏覽頁面的 URL 與媒體資源 URL（用於備份索引建立與過期資源修復）</li>
                <li><strong>裝置效能資訊</strong>：CPU 核心數、裝置記憶體容量、網路連線類型與頻寬、電池電量及充電狀態（用於最佳化影片串流品質、動態調整分塊上傳大小與併發數量，以及節省使用者行動數據流量）</li>
                <li><strong>網路速度測試</strong>：透過伺服器節點進行頻寬測試（每小時最多執行一次），用於選擇最適合使用者所在地區的 CDN 節點與最佳化傳輸策略</li>
                <li><strong>匿名訪客識別碼</strong>：本地隨機產生的匿名 ID（格式如 v_xxxxx_xxxxxxxxx），僅用於額度管理與服務狀態追蹤，無法追溯至任何個人身份資訊</li>
              </ul>

              <h3>四、不蒐集的資訊</h3>
              <p>本工具<strong>明確承諾不會</strong>蒐集以下資訊：</p>
              <ul>
                <li>使用者的帳號密碼或登入憑證</li>
                <li>瀏覽器 Cookie 或 Session 資訊</li>
                <li>個人身份資訊（姓名、電子郵件、電話等）</li>
                <li>瀏覽歷史記錄或書籤</li>
                <li>其他網站的資料或操作行為</li>
                <li>鍵盤輸入、螢幕截圖或任何形式的監控資料</li>
              </ul>

              <h3>五、資料安全</h3>
              <p>所有傳輸至 LurlHub 伺服器的資料均透過 HTTPS 加密通道傳送。本地暫存於 IndexedDB 的資料僅限當前瀏覽器存取，不會與其他應用程式或擴充功能共享。伺服器端僅保留服務運營所需的最少資料，並定期清理過期紀錄。</p>

              <h3>六、使用者權利</h3>
              <ul>
                <li>您可以隨時透過 Tampermonkey 管理介面停用或移除本腳本</li>
                <li>停用後本工具將立即停止所有功能，不會留下任何背景程序</li>
                <li>本地 IndexedDB 中的暫存資料可透過瀏覽器開發者工具手動清除</li>
                <li>您可以在 GreasyFork 頁面檢視完整原始碼以驗證上述聲明</li>
              </ul>

              <h3>七、免責聲明</h3>
              <p>本工具僅為瀏覽體驗輔助用途，不對第三方網站的內容合法性負責。使用者應自行確保其使用行為符合當地法律法規。LurlHub 備份服務受到封鎖清單機制管控，已被標記為不當的內容將不會被備份或提供修復。本工具不保證備份服務的持續可用性，備份資源可能因伺服器維護或其他原因而暫時或永久無法存取。</p>

              <h3>八、條款更新</h3>
              <p>本服務條款可能隨版本更新而修訂。重大變更時將透過版本更新提示通知使用者。繼續使用本工具即表示您同意最新版本的服務條款。</p>

              <p style="font-size: 12px; margin-top: 24px; text-align: center;">
                最後更新：2026 年 1 月 | LurlHub v${SCRIPT_VERSION} | MIT License
              </p>
            </div>
            <div class="lurlhub-consent-footer">
              <div class="lurlhub-consent-checkbox-row">
                <input type="checkbox" id="lurlhub-consent-check">
                <label for="lurlhub-consent-check">我已閱讀並理解上述服務條款與隱私政策，同意本工具在上述範圍內蒐集與使用非個人識別資訊。</label>
              </div>
              <div class="lurlhub-consent-actions">
                <button class="lurlhub-consent-btn lurlhub-consent-btn-decline" id="lurlhub-consent-decline">
                  不同意
                </button>
                <button class="lurlhub-consent-btn lurlhub-consent-btn-accept" id="lurlhub-consent-accept" disabled>
                  同意並繼續
                </button>
              </div>
            </div>
          </div>
        `;

        document.body.appendChild(overlay);

        const checkbox = overlay.querySelector('#lurlhub-consent-check');
        const acceptBtn = overlay.querySelector('#lurlhub-consent-accept');
        const declineBtn = overlay.querySelector('#lurlhub-consent-decline');

        checkbox.addEventListener('change', () => {
          acceptBtn.disabled = !checkbox.checked;
        });

        acceptBtn.addEventListener('click', () => {
          ConsentManager.saveConsent();
          overlay.remove();
          resolve(true);
        });

        declineBtn.addEventListener('click', () => {
          overlay.remove();
          resolve(false);
        });
      });
    }
  };

  /**
   * Main - 腳本主程式入口
   *
   * 初始化順序：
   *   1. 檢查使用者同意狀態（ConsentManager）
   *   2. 載入外部資源（Toastify 通知元件）
   *   3. 初始化離線佇列（IndexedDB）
   *   4. 啟動背景同步器
   *   5. 監聽網路狀態變化
   *   6. 檢查腳本版本更新
   *   7. 根據 URL 分發到對應的網站處理模組
   *
   * 若離線模組初始化失敗，仍會執行基本功能（下載按鈕、密碼填入等）。
   */
  const Main = {
    init: async () => {
      try {
        // 步驟 1：檢查使用者是否已同意服務條款
        if (!ConsentManager.hasConsented()) {
          console.log('[lurl] 首次使用，等待使用者同意...');
          const agreed = await ConsentManager.showConsentDialog();
          if (!agreed) {
            console.log('[lurl] 使用者未同意，腳本不啟動');
            return; // 使用者拒絕同意，完全不執行任何功能
          }
          console.log('[lurl] 使用者已同意，開始初始化');
        }

        // 步驟 2：初始化資源載入器（載入 Toastify 通知元件）
        ResourceLoader.init();

        // 步驟 3：初始化離線佇列（IndexedDB）
        await OfflineQueue.init();
        await OfflineQueue.cleanup(); // 清理超過 7 天的暫存資料
        StatusIndicator.init();       // 顯示連線狀態指示器
        SyncManager.start();          // 啟動背景同步器

        // 步驟 4：監聽網路狀態變化，即時通知使用者
        window.addEventListener('offline', () => {
          console.log('[lurl] 網路已斷開');
          StatusIndicator.update();
          Utils.showToast('網路已斷開，資料將暫存於本地', 'info');
        });

        window.addEventListener('online', () => {
          console.log('[lurl] 網路已恢復');
          StatusIndicator.update();
          Utils.showToast('網路已恢復，開始同步', 'success');
        });

        // 步驟 5：版本檢查（若有新版本會提示使用者更新）
        VersionChecker.check();

        // 步驟 6：根據目前 URL 分發到對應的網站處理模組
        Router.dispatch();

        console.log('[lurl] 初始化完成（含離線支援）');
      } catch (e) {
        console.error('[lurl] 初始化失敗:', e);
        // 即使離線支援初始化失敗，仍然嘗試執行基本功能
        ResourceLoader.init();
        VersionChecker.check();
        Router.dispatch();
      }
    },
  };

  $(document).ready(() => {
    Main.init();
  });

  /**
   * 開發者診斷介面
   *
   * 將部分模組暴露到 window._lurlhub，讓開發者或進階使用者
   * 可以透過瀏覽器 Console 手動觸發同步、查看佇列狀態等。
   * 例如：_lurlhub.OfflineQueue.getStats() 可查看離線佇列統計
   *
   * 此介面僅供診斷用途，不會自動執行任何操作。
   */
  unsafeWindow._lurlhub = {
    ...unsafeWindow._lurlhub,
    OfflineQueue,
    SyncManager,
    StatusIndicator,
  };
})(jQuery);