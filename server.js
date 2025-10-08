// server.js
import express from "express";
import { OpenAI } from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import Jimp from "jimp";

// ------------------------
// Конфиг и константы
// ------------------------
const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORG_ID = process.env.OPENAI_ORG_ID || undefined; // опционально
if (!OPENAI_API_KEY) {
  console.error("ENV OPENAI_API_KEY is required");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  organization: OPENAI_ORG_ID,
});

// Модель
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";

// Ключ для Actions (проверка запросов от GPT)
const ACTION_API_KEY = process.env.ACTION_API_KEY || "change-me";

// Фиксированное соотношение сторон
const DEFAULT_ASPECT = "4:3"; // жестко 4:3

// Фиксированный стиль — можно менять из переменных окружения STYLE_PREFIX
const STYLE_PREFIX =
  (process.env.STYLE_PREFIX && process.env.STYLE_PREFIX.trim()) ||
  `
horizontal cartoon illustration, strictly in the style of the attached reference images.

Background: Flat-shaded low poly 2.5D style. Minimalistic environment built from polygonal shapes with 2 tones per object. No gradients, no textures, no realistic shadows. Depth created only by layering: foreground darker, background lighter and desaturated. Colors muted, pastel-like, not too bright.

Characters: simplified stickman style exactly like in the reference images.

Large round heads, dot eyes, small or absent mouth, no nose or ears.

Minimal expressions, emotions shown only by pose and head tilt.

Arms and legs are not single lines, but tube-like (at least two lines, cylindrical look).

Hands and feet simplified as small ovals, without fingers.

Outfits and props allowed if context requires, always simple and cartoonish.
Characters must be at least 70% brighter and more saturated than the background and environment, visually standing out as the main focus.

General style: clean medium black outlines, playful comic atmosphere, consistent with reference images.
Restrictions: no realistic faces, no manga/comic style, no gradients, no typography, no mixing of visual styles.
`.trim();

// ------------------------
// Утилиты
// ------------------------

// Карта целевых размеров (наши 4:3 = 1600x1200)
function targetSize(aspect) {
  if (aspect === "4:3") return { w: 1600, h: 1200 };
  // теоретически не используется — мы фиксируем 4:3
  return { w: 1920, h: 1080 }; // fallback 16:9
}

// Приведение к нужному аспекту через cover-кроп (по центру)
async function toAspect(pngBuffer, aspect = DEFAULT_ASPECT) {
  const { w: TW, h: TH } = targetSize(aspect);
  const img = await Jimp.read(pngBuffer);
  const W = img.bitmap.width;
  const H = img.bitmap.height;
  const R = TW / TH;
  const r0 = W / H;

  // уже нужный размер
  if (Math.abs(r0 - R) < 1e-3 && W === TW && H === TH) {
    return await img.getBufferAsync(Jimp.MIME_PNG);
  }

  if (r0 > R) {
    // исходник шире: подгоняем высоту, ширину кропаем
    const scale = TH / H;
    img.resize(Math.round(W * scale), TH, Jimp.RESIZE_BILINEAR);
    const x = Math.max(0, Math.floor((img.bitmap.width - TW) / 2));
    img.crop(x, 0, TW, TH);
  } else {
    // исходник уже: подгоняем ширину, высоту кропаем
    const scale = TW / W;
    img.resize(TW, Math.round(H * scale), Jimp.RESIZE_BILINEAR);
    const y = Math.max(0, Math.floor((img.bitmap.height - TH) / 2));
    img.crop(0, y, TW, TH);
  }
  return await img.getBufferAsync(Jimp.MIME_PNG);
}

// Генерация одной картинки с ретраями
async function generateImageB64(prompt, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    console.log(`Images API call attempt ${attempt}...`);
    const r = await client.images.generate({
      model: IMAGE_MODEL,
      prompt,
      // можно добавить size, но мы всё равно кропаем до 1600x1200
      // size: "1024x1024"
    });
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new Error("Empty b64_json from API");
    console.log("Images API success");
    return b64;
  } catch (e) {
    console.error("Images API attempt failed:", e?.message || e);
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, 1500 * attempt));
      return generateImageB64(prompt, attempt + 1);
    }
    throw e;
  }
}

// ------------------------
// Middleware
// ------------------------
app.use((req, res, next) => {
  const k = req.header("X-API-Key");
  if (k !== ACTION_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Health
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// ------------------------
// FAST: до 10 промптов синхронно (строго 4:3 и фикс. стиль)
// ------------------------
app.post("/submit-fast", async (req, res) => {
  res.setTimeout(0); // длинные операции
  try {
    const { prompts = [] } = req.body || {};
    const limited = Array.isArray(prompts) ? prompts.slice(0, 10) : [];
    if (limited.length === 0)
      return res.status(400).json({ error: "prompts must be a non-empty array" });

    console.log(`FAST started, prompts=${limited.length}, aspect=${DEFAULT_ASPECT}`);

    const results = [];
    for (const raw of limited) {
      console.log("Generate for prompt (subject):", raw);
      const fullPrompt = `${STYLE_PREFIX}\n\nSubject: ${raw}`;
      const b64 = await generateImageB64(fullPrompt);
      const cropped = await toAspect(Buffer.from(b64, "base64"), DEFAULT_ASPECT);
      results.push("data:image/png;base64," + cropped.toString("base64"));
    }

    console.log("FAST done:", results.length);
    res.json({ mode: "fast", count: results.length, images: results });
  } catch (e) {
    console.error("FAST error:", e?.message || e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ------------------------
// BATCH: до 500 промптов асинхронно (строго 4:3 и фикс. стиль)
// ------------------------
app.post("/submit-batch", async (req, res) => {
  try {
    const { prompts = [] } = req.body || {};
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts must be a non-empty array" });
    }

    // временный JSONL для Batch API
    const tmp = path.join(os.tmpdir(), `input_${Date.now()}.jsonl`);
    const stream = fs.createWriteStream(tmp);
    prompts.forEach((raw, idx) => {
      const fullPrompt = `${STYLE_PREFIX}\n\nSubject: ${raw}`;
      const line = JSON.stringify({
        custom_id: `img_${String(idx).padStart(4, "0")}`,
        method: "POST",
        url: "/v1/images/generations",
        body: { model: IMAGE_MODEL, prompt: fullPrompt },
      });
      stream.write(line + "\n");
    });
    stream.end();
    await new Promise((r) => stream.on("finish", r));

    const file = await client.files.create({
      file: fs.createReadStream(tmp),
      purpose: "batch",
    });

    const batch = await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h", // эконом-режим
      metadata: { aspect: DEFAULT_ASPECT },
    });

    res.json({ mode: "batch", batch_id: batch.id });
  } catch (e) {
    console.error("BATCH error:", e?.message || e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ------------------------
// STATUS: проверка batch и возврат картинок (в 4:3)
// ------------------------
app.get("/status", async (req, res) => {
  try {
    const { batch_id } = req.query;
    if (!batch_id) return res.status(400).json({ error: "batch_id is required" });

    const b = await client.batches.retrieve(batch_id);
    if (b.status !== "completed") {
      return res.json({ status: b.status });
    }

    const resultFileId = b.output_file_id;
    const content = await client.files.content(resultFileId);
    const text = await content.text();

    const images = [];
    for (const line of text.split("\n").filter(Boolean)) {
      const obj = JSON.parse(line);
      const b64 = obj.response?.body?.data?.[0]?.b64_json;
      if (!b64) continue;
      const cropped = await toAspect(
        Buffer.from(b64, "base64"),
        (b.metadata && b.metadata.aspect) || DEFAULT_ASPECT
      );
      images.push("data:image/png;base64," + cropped.toString("base64"));
    }

    res.json({ status: "completed", count: images.length, images });
  } catch (e) {
    console.error("STATUS error:", e?.message || e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ------------------------
app.listen(PORT, () => console.log("Server on", PORT));
