// ===== server.js =====
// Режим модели: берём из переменной окружения IMAGE_MODEL, иначе gpt-image-1
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";

import express from "express";
import { OpenAI } from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import Jimp from "jimp";

const app = express();
app.use(express.json({ limit: "50mb" }));

// --- Ключи и клиент OpenAI ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;           // sk-...
const OPENAI_ORG_ID  = process.env.OPENAI_ORG_ID || undefined; // опционально
const ACTION_API_KEY = process.env.ACTION_API_KEY || "change-me"; // пароль для GPT Actions

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  organization: OPENAI_ORG_ID
});

// ---------- ОТКРЫТЫЕ ПРОБНЫЕ МАРШРУТЫ (для проверки живости) ----------
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- ПРОСТАЯ ЗАЩИТА API ДЛЯ GPT (требуем X-API-Key) ----------
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/healthz") return next();
  const k = req.header("X-API-Key");
  if (k !== ACTION_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------- Хелперы для размеров ----------
function targetSize(aspect) {
  if (aspect === "4:3") return { w: 1600, h: 1200 }; // хорошее 4:3
  return { w: 1920, h: 1080 }; // 16:9 по умолчанию
}

// Приведение к нужному аспекту (cover: масштаб + центр-кроп)
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
    // шире: подгоняем высоту, режем по ширине
    const scale = TH / H;
    img.resize(Math.round(W * scale), TH, Jimp.RESIZE_BILINEAR);
    const x = Math.max(0, Math.floor((img.bitmap.width - TW) / 2));
    img.crop(x, 0, TW, TH);
  } else {
    // уже: подгоняем ширину, режем по высоте
    const scale = TW / W;
    img.resize(TW, Math.round(H * scale), Jimp.RESIZE_BILINEAR);
    const y = Math.max(0, Math.floor((img.bitmap.height - TH) / 2));
    img.crop(0, y, TW, TH);
  }
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

// =================== FAST: до 10 изображений синхронно ===================
app.post("/submit-fast", async (req, res) => {
  try {
    const { prompts = [], aspect = "16:9" } = req.body || {};
    const limited = Array.isArray(prompts) ? prompts.slice(0, 10) : [];
    if (limited.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }

    const results = [];
    for (const p of limited) {
      const r = await client.images.generate({
        model: IMAGE_MODEL,       // gpt-image-1 (или mini, если позже включите)
        prompt: p                  // НЕЛЬЗЯ передавать response_format — по умолчанию b64_json
      });
      const b64 = r.data?.[0]?.b64_json;
      if (!b64) throw new Error("Empty image response");
      const cropped = await toAspect(Buffer.from(b64, "base64"), aspect);
      results.push("data:image/png;base64," + cropped.toString("base64"));
    }
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

    // 1) Собираем временный JSONL с запросами к /v1/images/generations
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

    // 2) Загружаем файл и создаём batch
    const file = await client.files.create({
      file: fs.createReadStream(tmp),
      purpose: "batch"
    });

    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h", // эконом-режим (медленнее/дешевле)
      metadata: { aspect }
    });

    res.json({ mode: "batch", batch_id: batch.id });
  } catch (e) {
    console.error("BATCH create error:", e);
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

// ---------- Проверка статуса батча и выдача изображений ----------
app.get("/status", async (req, res) => {
  try {
    const { batch_id } = req.query;
    if (!batch_id) return res.status(400).json({ error: "batch_id is required" });

    const b = await client.batches.retrieve(String(batch_id));
    if (b.status !== "completed") {
      return res.json({ status: b.status });
    }

    // 1) Скачиваем JSONL с результатами
    const resultFileId = b.output_file_id;
    const content = await client.files.content(resultFileId);
    const text = await content.text();

    // 2) Собираем картинки, приводим к аспекту, возвращаем data URL
    const images = [];
    for (const line of text.split("\n").filter(Boolean)) {
      const obj = JSON.parse(line);
      const b64 = obj?.response?.body?.data?.[0]?.b64_json;
      if (!b64) continue;
      const cropped = await toAspect(Buffer.from(b64, "base64"), (b.metadata && b.metadata.aspect) || "16:9");
      images.push("data:image/png;base64," + cropped.toString("base64"));
    }

    res.json({ status: "completed", count: images.length, images });
  } catch (e) {
    console.error("STATUS error:", e);
    res.status(500).json({ error: e.message || "Internal Server Error" });
  }
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server on", PORT));
