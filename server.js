
import express from "express";
import { OpenAI } from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import Jimp from "jimp";

const app = express();
app.use(express.json({ limit: "50mb" }));

// --- Настройки ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // добавьте в переменные окружения
const ACTION_API_KEY = process.env.ACTION_API_KEY || "change-me"; // ключ для защиты экшенов
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// Простая проверка ключа для Actions
app.use((req, res, next) => {
  const k = req.header("X-API-Key");
  if (k !== ACTION_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

function targetSize(aspect) {
  if (aspect === "4:3") return { w: 1600, h: 1200 };
  return { w: 1920, h: 1080 }; // 16:9 по умолчанию
}

// Приведение к нужному аспекту через "cover" (кроп по центру после масштабирования)
async function toAspect(pngBuffer, aspect = "16:9") {
  const { w: TW, h: TH } = targetSize(aspect);
  const img = await Jimp.read(pngBuffer);
  const W = img.bitmap.width, H = img.bitmap.height;
  const R = TW / TH;
  const r0 = W / H;

  if (Math.abs(r0 - R) < 1e-3 && W === TW && H === TH) {
    return await img.getBufferAsync(Jimp.MIME_PNG); // уже нужный размер
  }

  if (r0 > R) {
    // шире: подгоняем высоту, ширину кропаем
    const scale = TH / H;
    img.resize(Math.round(W * scale), TH, Jimp.RESIZE_BILINEAR);
    const x = Math.max(0, Math.floor((img.bitmap.width - TW) / 2));
    img.crop(x, 0, TW, TH);
  } else {
    // уже: подгоняем ширину, высоту кропаем
    const scale = TW / W;
    img.resize(TW, Math.round(H * scale), Jimp.RESIZE_BILINEAR);
    const y = Math.max(0, Math.floor((img.bitmap.height - TH) / 2));
    img.crop(0, y, TW, TH);
  }
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

// ============== FAST: до 10 промптов синхронно ==============
app.post("/submit-fast", async (req, res) => {
  try {
    const { prompts = [], aspect = "16:9" } = req.body || {};
    const limited = prompts.slice(0, 10); // на всякий случай ограничим
    if (!Array.isArray(prompts) || limited.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }

    const results = [];
    for (const p of limited) {
      const r = await client.images.generate({
        model: "gpt-image-1-mini",
        prompt: p
        });
      const b64 = r.data[0].b64_json;
      const cropped = await toAspect(Buffer.from(b64, "base64"), aspect);
      results.push("data:image/png;base64," + cropped.toString("base64"));
    }
    res.json({ mode: "fast", count: results.length, images: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============== BATCH: до 500 промптов асинхронно ==============
app.post("/submit-batch", async (req, res) => {
  try {
    const { prompts = [], aspect = "16:9" } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }
    // 1) Собираем временный JSONL
    const tmp = path.join(os.tmpdir(), `input_${Date.now()}.jsonl`);
    const stream = fs.createWriteStream(tmp);
    prompts.forEach((p, idx) => {
      const line = JSON.stringify({
        custom_id: `img_${String(idx).padStart(4,"0")}`,
        method: "POST",
        url: "/v1/images/generations",
        body: { model: "gpt-image-1-mini", prompt: p, response_format: "b64_json" }
      });
      stream.write(line + "\n");
    });
    stream.end();
    await new Promise(r => stream.on("finish", r));

    // 2) Загружаем файл и создаём batch
    const file = await client.files.create({ file: fs.createReadStream(tmp), purpose: "batch" });
    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h", // эконом-режим (дешевле)
      metadata: { aspect }
    });

    res.json({ mode: "batch", batch_id: batch.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Проверка статуса + выдача картинок когда всё готово
app.get("/status", async (req, res) => {
  try {
    const { batch_id } = req.query;
    if (!batch_id) return res.status(400).json({ error: "batch_id is required" });

    const b = await client.batches.retrieve(batch_id);
    if (b.status !== "completed") {
      return res.json({ status: b.status });
    }
    // 1) Скачиваем результирующий JSONL
    const resultFileId = b.output_file_id;
    const content = await client.files.content(resultFileId);
    const text = await content.text();

    // 2) Парсим строки, достаём base64 => приводим к аспекту => dataURL
    const images = [];
    for (const line of text.split("\n").filter(Boolean)) {
      const obj = JSON.parse(line);
      const b64 = obj.response?.body?.data?.[0]?.b64_json;
      if (!b64) continue;
      const cropped = await toAspect(Buffer.from(b64, "base64"), (b.metadata && b.metadata.aspect) || "16:9");
      images.push("data:image/png;base64," + cropped.toString("base64"));
    }

    res.json({ status: "completed", count: images.length, images });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server on", PORT));
