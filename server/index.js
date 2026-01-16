const fastify = require("fastify")({ logger: true });
const cors = require("@fastify/cors");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

// 設定
const PORT = 3000;
const DATA_DIR = path.join(__dirname, "data");
const RECORDS_FILE = path.join(DATA_DIR, "records.jsonl");
const VIDEOS_DIR = path.join(DATA_DIR, "videos");
const IMAGES_DIR = path.join(DATA_DIR, "images");

// 確保資料夾存在
[DATA_DIR, VIDEOS_DIR, IMAGES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 清理檔名（移除不合法字元）
function sanitizeFilename(filename) {
  return filename
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 200); // 限制長度
}

// 下載檔案到本地
async function downloadFile(url, destPath) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const fileStream = fs.createWriteStream(destPath);
    await pipeline(response.body, fileStream);
    return true;
  } catch (error) {
    console.error(`下載失敗: ${url}`, error.message);
    return false;
  }
}

// 存記錄到 jsonl
function appendRecord(record) {
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(RECORDS_FILE, line, "utf8");
}

// 註冊 CORS（允許 Tampermonkey 跨域請求）
fastify.register(cors, {
  origin: true,
});

// POST /capture - 主要端點
fastify.post("/capture", async (request, reply) => {
  const { title, pageUrl, fileUrl, type = "video" } = request.body;

  // 驗證必要欄位
  if (!title || !pageUrl || !fileUrl) {
    return reply.status(400).send({
      ok: false,
      error: "缺少必要欄位: title, pageUrl, fileUrl",
    });
  }

  // 決定檔案副檔名
  const ext = type === "video" ? ".mp4" : ".jpg";
  const safeTitle = sanitizeFilename(title);
  const filename = `${safeTitle}${ext}`;
  const targetDir = type === "video" ? VIDEOS_DIR : IMAGES_DIR;
  const backupPath = path.join(type === "video" ? "videos" : "images", filename);
  const fullPath = path.join(targetDir, filename);

  // 建立記錄
  const record = {
    title,
    pageUrl,
    fileUrl,
    type,
    source: "lurl",
    capturedAt: new Date().toISOString(),
    backupPath,
  };

  // 存記錄
  appendRecord(record);
  console.log(`記錄已存: ${title}`);

  // 背景下載檔案（不阻塞回應）
  downloadFile(fileUrl, fullPath).then((success) => {
    if (success) {
      console.log(`備份完成: ${filename}`);
    } else {
      console.log(`備份失敗: ${filename}`);
    }
  });

  return { ok: true };
});

// GET /health - 健康檢查
fastify.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

// 啟動 server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server 啟動於 http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
