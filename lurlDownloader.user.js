// ==UserScript==
// @name         🔥2026|破解lurl&myppt密碼|自動帶入日期|可下載圖影片🚀|v3.5
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  針對lurl與myppt自動帶入日期密碼;開放下載圖片與影片
// @author       Jeffrey
// @match        https://lurl.cc/*
// @match        https://myppt.cc/*
// @match        https://www.dcard.tw/f/sex/*
// @match        https://www.dcard.tw/f/sex
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=lurl.cc
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      epi.isnowfriend.com
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// ==/UserScript==

/*
  Lurl Downloader - 自動破解密碼 & 下載圖片影片

  更新紀錄：
  2026/01/17 v3.5 - 修復 myppt reload 導致 title 遺失問題
  2026/01/17 v3.4 - Dcard 攔截 myppt 連結、新增回到D卡按鈕
  2026/01/17 v3.3 - myppt 支援下載與 API 回報
  2026/01/17 v3.2 - Dcard 多連結編號、修復重複下載按鈕
  2026/01/17 v3.1 - 修復影片 URL 取得邏輯，整合 API 回報
  2025/09/19 v3.0 - 重構為 functional 風格，採用 jQuery
  2025/09/19 v2.1 - 新增 myppt 密碼自動帶入
  2025/07/29 v2.0 - 修復 lurl 邏輯改變問題
*/

(function ($) {
  "use strict";

  const Utils = {
    extractMMDD: (dateText) => {
      const pattern = /(\d{4})-(\d{2})-(\d{2})/;
      const match = dateText.match(pattern);
      return match ? match[2] + match[3] : null;
    },

    getQueryParam: (name) => {
      const params = new URLSearchParams(window.location.search);
      return params.get(name);
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

    showToast: (message, type = "success") => {
      if (typeof Toastify === "undefined") return;
      Toastify({
        text: message,
        duration: 5000,
        gravity: "top",
        position: "right",
        style: { background: type === "success" ? "#28a745" : "#dc3545" },
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

    sendToAPI: (data) => {
      const API_URL = "https://epi.isnowfriend.com/lurl/capture";
      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(data),
        onload: (response) => {
          if (response.status === 200) {
            console.log("API 回報成功:", data.title);
          } else {
            console.error("API 回報失敗:", response.status);
          }
        },
        onerror: (error) => {
          console.error("API 連線失敗:", error);
        },
      });
    },
  };

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

  const MypptHandler = {
    saveQueryParams: () => {
      const title = Utils.getQueryParam("title");
      const ref = Utils.getQueryParam("ref");
      if (title) sessionStorage.setItem("myppt_title", title);
      if (ref) sessionStorage.setItem("myppt_ref", ref);
    },

    getTitle: () => {
      return Utils.getQueryParam("title") || sessionStorage.getItem("myppt_title") || "untitled";
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
      const date = MypptHandler.getUploadDate();
      if (!date) return;
      MypptHandler.saveQueryParams();
      $("#pasahaicsword").val(date);
      $("#main_fjim60unBU").click();
      location.reload();
    },

    pictureDownloader: {
      getImageUrl: () => {
        const $preloadLink = $('link[rel="preload"][as="image"]');
        return $preloadLink.attr("href") || null;
      },

      createDownloadButton: () => {
        const imageUrl = MypptHandler.pictureDownloader.getImageUrl();
        if (!imageUrl) return null;
        const $button = $("<button>", { text: "下載圖片", class: "btn btn-primary" });
        const $link = $("<a>", {
          href: imageUrl,
          download: "downloaded-image.jpg",
          css: { textDecoration: "none" },
        }).append($button);
        return $("<div>", { class: "col-12" }).append($link);
      },

      inject: () => {
        if ($("#myppt-download-btn").length) return;
        const $button = MypptHandler.pictureDownloader.createDownloadButton();
        if (!$button) return;
        $button.attr("id", "myppt-download-btn");
        const $targetRow = $('div.row[style*="margin: 10px"][style*="border-style:solid"]');
        if ($targetRow.length) {
          $targetRow.append($button);
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

    captureToAPI: (type) => {
      const title = MypptHandler.getTitle();
      const pageUrl = window.location.href.split("?")[0];
      const fileUrl =
        type === "video"
          ? MypptHandler.videoDownloader.getVideoUrl()
          : MypptHandler.pictureDownloader.getImageUrl();
      if (!fileUrl) {
        console.log("無法取得檔案 URL，跳過 API 回報");
        return;
      }
      Utils.sendToAPI({
        title: decodeURIComponent(title),
        pageUrl,
        fileUrl,
        type,
        source: "myppt",
      });
    },

    init: () => {
      $(document).ready(() => {
        MypptHandler.autoFillPassword();
      });
      $(window).on("load", () => {
        const contentType = MypptHandler.detectContentType();
        if (contentType === "video") {
          MypptHandler.videoDownloader.inject();
          MypptHandler.captureToAPI("video");
        } else {
          MypptHandler.pictureDownloader.inject();
          MypptHandler.captureToAPI("image");
        }
        BackToDcardButton.inject($("h2").first());
      });
    },
  };

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

  const LurlHandler = {
    passwordCracker: {
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
        if (LurlHandler.passwordCracker.isPasswordCorrect()) return false;
        const $dateSpan = $(".login_span").eq(1);
        if (!$dateSpan.length) return false;
        const date = Utils.extractMMDD($dateSpan.text());
        if (!date) return false;
        const cookieName = LurlHandler.passwordCracker.getCookieName();
        if (!cookieName) return false;
        Utils.cookie.set(cookieName, date);
        return true;
      },

      init: () => {
        if (LurlHandler.passwordCracker.tryTodayPassword()) {
          location.reload();
        }
      },
    },

    pictureDownloader: {
      getImageUrl: () => {
        const $preloadLink = $('link[rel="preload"][as="image"]');
        return $preloadLink.attr("href") || null;
      },

      createDownloadButton: () => {
        const imageUrl = LurlHandler.pictureDownloader.getImageUrl();
        if (!imageUrl) return null;
        const $button = $("<button>", { text: "下載圖片", class: "btn btn-primary" });
        const $link = $("<a>", {
          href: imageUrl,
          download: "downloaded-image.jpg",
          css: { textDecoration: "none" },
        }).append($button);
        return $("<div>", { class: "col-12" }).append($link);
      },

      inject: () => {
        const $button = LurlHandler.pictureDownloader.createDownloadButton();
        if (!$button) return;
        const $targetRow = $('div.row[style*="margin: 10px"][style*="border-style:solid"]');
        if ($targetRow.length) {
          $targetRow.append($button);
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
          width: 640,
          height: 360,
          preload: "metadata",
          class: "vjs-tech",
          id: "vjs_video_3_html5_api",
          tabIndex: -1,
          role: "application",
          "data-setup": '{"aspectRatio":"16:9"}',
        });
        $("video").replaceWith($newVideo);
        $("#vjs_video_3").removeAttr("oncontextmenu controlslist");
        $(".vjs-control-bar").remove();
      },

      createDownloadButton: () => {
        const videoUrl = LurlHandler.videoDownloader.getVideoUrl();
        if (!videoUrl) return null;
        const title = Utils.getQueryParam("title") || "video";
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
        } else {
          $h2List.first().append($button);
        }
      },
    },

    detectContentType: () => {
      return $("video").length > 0 ? "video" : "picture";
    },

    captureToAPI: (type) => {
      const title = Utils.getQueryParam("title") || "untitled";
      const pageUrl = window.location.href.split("?")[0];
      const fileUrl =
        type === "video"
          ? LurlHandler.videoDownloader.getVideoUrl()
          : LurlHandler.pictureDownloader.getImageUrl();
      if (!fileUrl) {
        console.log("無法取得檔案 URL，跳過 API 回報");
        return;
      }
      Utils.sendToAPI({
        title: decodeURIComponent(title),
        pageUrl,
        fileUrl,
        type,
      });
    },

    init: () => {
      LurlHandler.passwordCracker.init();
      $(window).on("load", () => {
        const contentType = LurlHandler.detectContentType();
        if (contentType === "video") {
          LurlHandler.videoDownloader.inject();
          LurlHandler.videoDownloader.replacePlayer();
          LurlHandler.captureToAPI("video");
        } else {
          LurlHandler.pictureDownloader.inject();
          LurlHandler.captureToAPI("image");
        }
        BackToDcardButton.inject($("h2").first());
      });
    },
  };

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

  const Main = {
    init: () => {
      ResourceLoader.init();
      Router.dispatch();
    },
  };

  $(document).ready(() => {
    Main.init();
  });
})(jQuery);