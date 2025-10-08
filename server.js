// ===== server.js =====
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";

import express from "express";
import { OpenAI } from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import Jimp from "jimp";

const app = express();
app.use(express.json({ limit: "50mb" }));

// Лог каждого запроса
app.use((req, _res, next) => {
  console.log("REQ", req.method, req.path, "at", new Date().toISOString());
  next();
});

// Ключи
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ACTION_API_KEY = process.env.ACTION_API_KEY || "change-me";

// Клиент OpenAI оставим для batch/файлов
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Требуем X-API-Key для защищенных путей
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/healthz") return next();
  const k = req.header("X-API-Key");
  if (k !== ACTION_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Вспомогательный тестовый маршрут
app.post("/ping-auth", (req, res) => {
  res.json({ ok: true, now: Date.now() });
});

// ---------- Хелперы ----------
function targetSize(aspect) {
  if (aspect === "4:3") return { w: 1600, h: 1200 };
  return { w: 1920, h: 1080 }; // 16:9 дефолт
}

async function toAspect(pngBuffer, aspect = "16:9") {
  const { w: TW, h: TH } = targetSize(aspect);
  const img = await Jimp.read(pngBuffer);
  const W = img.bitmap.width, H = img.bitmap.height;
  const R = TW / TH;
  const r0 = W / H;

  if (Math.abs(r0 - R) < 1e-3 && W === TW && H === TH) {
    return await img.getBufferAsync(Jimp.MIME_PNG);
  }
  if (r0 > R) {
    const scale = TH / H;
    img.resize(Math.round(W * scale), TH, Jimp.RESIZE_BILINEAR);
    const x = Math.max(0, Math.floor((img.bitmap.width - TW) / 2));
    img.crop(x, 0, TW, TH);
  } else {
    const scale = TW / W;
    img.resize(TW, Math.round(H * scale), Jimp.RESIZE_BILINEAR);
    const y = Math.max(0, Math.floor((img.bitmap.height - TH) / 2));
    img.crop(0, y, TW, TH);
  }
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, ms = 50000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Прямой вызов Images API (обход бага gzip): Accept-Encoding: identity + ретраи
async function generateImageB64(prompt) {
  const body = JSON.stringify({ model: IMAGE_MODEL, prompt });
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity" // <- важное
  };

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetchWithTimeout("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers,
        body
      }, 50000);

      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`OpenAI HTTP ${resp.status} ${resp.statusText}: ${t}`);
      }
      const json = await resp.json();
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) throw new Error("Empty image response");
      return b64;
    } catch (e) {
      lastErr = e;
      console.error(`Images API attempt ${i + 1} failed:`, e.message);
      if (i < 2) await sleep(500 * (i + 1));
    }
  }
  throw lastErr || new Error("Images API failed");
}

// =================== FAST: до 10 изображений, параллельно ===================
app.post("/submit-fast", async (req, res) => {
  res.setTimeout(0);
  try {
    const { prompts = [], aspect = "16:9" } = req.body || {};
    const limited = Array.isArray(prompts) ? prompts.slice(0, 10) : [];
    if (limited.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }

    const tasks = limited.map(async (p) => {
      const b64 = await generateImageB64(p);
      const cropped = await toAspect(Buffer.from(b64, "base64"), aspect);
      return "data:image/png;base64," + cropped.toString("base64");
    });

    const results = await Promise.all(tasks);
    res.json({ mode: "fast", count: results.length, images: results });
  } catch (e) {
    console.error("FAST error:", e);
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

// =================== BATCH: до 500 изображений асинхронно ===================
app.post("/submit-batch", async (req, res) => {
  try {
    const { prompts = [], aspect = "16:9" } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }

    // JSONL с заданиями
    const tmp = path.join(os.tmpdir(), `input_${Date.now()}.jsonl`);
    const stream = fs.createWriteStream(tmp);
    prompts.forEach((p, idx) => {
      const line = JSON.stringify({
        custom_id: `img_${String(idx).padStart(4, "0")}`,
        method: "POST",
        url: "/v1/images/generations",
        body: { model: IMAGE_MODEL, prompt: p }
      });
      stream.write(line + "\n");
    });
    stream.end();
    await new Promise((r) => stream.on("finish", r));

    const file = await client.files.create({
      file: fs.createReadStream(tmp),
      purpose: "batch"
    });

    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h",
      metadata: { aspect }
    });

    res.json({ mode: "batch", batch_id: batch.id });
  } catch (e) {
    console.error("BATCH create error:", e);
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

// ---------- Статус батча ----------
app.get("/status", async (req, res) => {
  try {
    const { batch_id } = req.query;
    if (!batch_id) return res.status(400).json({ error: "batch_id is required" });

    const b = await client.batches.retrieve(String(batch_id));
    if (b.status !== "completed") {
      return res.json({ status: b.status });
    }

    const resultFileId = b.output_file_id;
    const content = await client.files.content(resultFileId);
    const text = await content.text();

    const images = [];
    for (const line of text.split("\n").filter(Boolean)) {
      const obj = JSON.parse(line);
      const b64 = obj?.response?.body?.data?.[0]?.b64_json;
      if (!b64) continue;
      const cropped = await toAspect(
        Buffer.from(b64, "base64"),
        (b.metadata && b.metadata.aspect) || "16:9"
      );
      images.push("data:image/png;base64," + cropped.toString("base64"));
    }

    res.json({ status: "completed", count: images.length, images });
  } catch (e) {
    console.error("STATUS error:", e);
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

// ---------- Запуск с увеличенными таймаутами ----------
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log("Server on", PORT));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
