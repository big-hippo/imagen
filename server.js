import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import http from "node:http";
import https from "node:https";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = join(process.cwd(), "public");
const GENERATED_DIR = join(PUBLIC_DIR, "generated");
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MODELS_REQUEST_LIMIT_BYTES = 32 * 1024;
const IMAGE_JOB_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
const MODELS_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const IMAGE_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const REMOTE_IMAGE_LIMIT_BYTES = 25 * 1024 * 1024;
const UPSTREAM_MODELS_TIMEOUT_MS = readPositiveIntEnv("UPSTREAM_MODELS_TIMEOUT_MS", 30 * 1000);
const UPSTREAM_IMAGE_TIMEOUT_MS = readPositiveIntEnv("UPSTREAM_IMAGE_TIMEOUT_MS", 300 * 1000);
const UPSTREAM_DOWNLOAD_TIMEOUT_MS = readPositiveIntEnv("UPSTREAM_DOWNLOAD_TIMEOUT_MS", 30 * 1000);
const jobs = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const corsAllowed = setCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(corsAllowed ? 204 : 403);
      res.end();
      return;
    }

    if (url.pathname === "/api/models" && req.method === "POST") {
      const body = await readJson(req, MODELS_REQUEST_LIMIT_BYTES);
      const result = await detectModels(body);
      return sendJson(res, 200, result);
    }

    if (url.pathname === "/api/images" && req.method === "POST") {
      const body = await readJson(req, IMAGE_JOB_REQUEST_LIMIT_BYTES);
      const job = await createJob(body);
      runImageJob(job).catch((error) => failJob(job.id, error));
      return sendJson(res, 202, {
        jobId: job.id,
        status: job.status,
        startedAt: job.startedAt,
      });
    }

    if (url.pathname.startsWith("/api/image-jobs/") && req.method === "GET") {
      const jobId = decodeURIComponent(url.pathname.slice("/api/image-jobs/".length));
      const job = jobs.get(jobId);
      if (!job) {
        return sendJson(res, 404, { error: "任务不存在或已过期" });
      }
      return sendJson(res, 200, serializeJob(job));
    }

    if (url.pathname === "/api/image-proxy" && req.method === "GET") {
      const target = url.searchParams.get("url");
      if (!target) {
        return sendJson(res, 400, { error: "缺少 url 参数" });
      }
      return proxyRemoteImage(res, target, false, url.searchParams.get("filename"));
    }

    if (url.pathname === "/api/download-image" && req.method === "GET") {
      const target = url.searchParams.get("url");
      const filename = url.searchParams.get("filename") || "image.png";
      if (!target) {
        return sendJson(res, 400, { error: "缺少 url 参数" });
      }
      return proxyRemoteImage(res, target, true, filename);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = error.statusCode || 500;
    return sendJson(res, status, {
      error: error.expose ? error.message : "服务器内部错误",
      detail: error.expose ? undefined : String(error.message || error),
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`Image workbench listening on http://${HOST}:${PORT}`);
});

function setCors(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin || !isAllowedOrigin(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return true;
}

async function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(PUBLIC_DIR, safePath));
  const relativePath = relative(PUBLIC_DIR, filePath);
  const outsidePublicDir = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  if (outsidePublicDir || !existsSync(filePath)) {
    return sendNotFound(res);
  }

  const type = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  try {
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    // Browsers sometimes close the socket early while static assets are streaming.
    // That should not take down the whole server process.
    if (error?.code !== "ERR_STREAM_PREMATURE_CLOSE" && error?.code !== "ECONNRESET") {
      throw error;
    }
  }
}

function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (maxBytes && totalBytes > maxBytes) {
      throw payloadTooLarge(`请求体超过限制（最大 ${formatByteLimit(maxBytes)}）`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

async function detectModels(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = String(input.apiKey || "").trim();
  if (!baseUrl || !apiKey) {
    throw badRequest("请提供 baseUrl 和 apiKey");
  }
  await assertSafeRemoteUrl(baseUrl, "baseUrl");

  const candidates = unique([
    joinUrl(baseUrl, "/v1/models"),
    joinUrl(baseUrl, "/models"),
  ]);

  let lastError = null;
  for (const endpoint of candidates) {
    try {
      const response = await requestJson(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeoutMs: UPSTREAM_MODELS_TIMEOUT_MS,
        maxBytes: MODELS_RESPONSE_LIMIT_BYTES,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(response.data.error?.message || response.data.error || `HTTP ${response.statusCode}`);
      }
      const imageModels = pickImageModels(response.data);
      return {
        imageModels,
        preferredModel: pickPreferredModel(imageModels),
        source: endpoint,
      };
    } catch (error) {
      lastError = new Error(`${endpoint} -> ${error?.message || error || "未知错误"}`);
    }
  }

  throw badGateway(`模型识别失败：${lastError?.message || "无法连接上游"}`);
}

function pickImageModels(payload) {
  const records = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  const imageModels = records
    .map((item) => ({
      id: String(item?.id || item?.name || "").trim(),
      raw: item,
    }))
    .filter((item) => item.id)
    .filter((item) => modelLooksImageCapable(item.id, item.raw))
    .map((item) => item.id);

  return unique(imageModels);
}

function modelLooksImageCapable(id, raw) {
  const haystack = `${id} ${JSON.stringify(raw || {})}`.toLowerCase();
  const positives = [
    "image",
    "gpt-image",
    "flux",
    "sdxl",
    "stable-diffusion",
    "midjourney",
    "recraft",
    "dall-e",
    "dalle",
    "playground",
    "imagen",
    "vision-art",
    "kolors",
    "seedream",
    "jimeng",
    "wanx",
    "cogview",
    "ideogram",
    "image-preview",
  ];
  const negatives = [
    "embedding",
    "whisper",
    "rerank",
    "moderation",
    "tts",
    "transcription",
    "speech",
    "audio",
  ];

  if (positives.some((token) => haystack.includes(token))) return true;
  if (negatives.some((token) => haystack.includes(token))) return false;
  return Boolean(raw?.capabilities?.image || raw?.modalities?.includes?.("image"));
}

function pickPreferredModel(models) {
  if (!models.length) return "";
  const priority = [
    "gpt-image-1",
    "gpt-image",
    "flux",
    "recraft",
    "sdxl",
    "stable-diffusion",
  ];

  for (const token of priority) {
    const hit = models.find((model) => model.toLowerCase().includes(token));
    if (hit) return hit;
  }
  return models[0];
}

async function createJob(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = String(input.apiKey || "").trim();
  const model = String(input.model || "").trim();
  const prompt = String(input.prompt || "").trim();
  const mode = input.mode === "edit" ? "edit" : "generate";
  const size = String(input.size || "").trim() || "1024x1024";
  const count = clampCount(input.count);
  const images = Array.isArray(input.images) ? input.images.slice(0, 8) : [];

  if (!baseUrl || !apiKey || !model || !prompt) {
    throw badRequest("baseUrl、apiKey、model、prompt 均不能为空");
  }
  await assertSafeRemoteUrl(baseUrl, "baseUrl");
  if (!/^\d{2,5}x\d{2,5}$/.test(size)) {
    throw badRequest("size 格式必须是 1024x1024");
  }
  if (mode === "edit" && images.length === 0) {
    throw badRequest("改图模式至少需要一张参考图");
  }

  const job = {
    id: randomUUID(),
    status: "queued",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: {
      baseUrl,
      apiKey,
      model,
      prompt,
      mode,
      size,
      count,
      images,
    },
    endpoint: mode === "edit" ? "/images/edits" : "/images/generations",
    result: null,
    error: "",
  };
  jobs.set(job.id, job);
  scheduleCleanup(job.id);
  return job;
}

async function runImageJob(job) {
  job.status = "running";
  job.updatedAt = new Date().toISOString();

  const payload = await dispatchUpstream(job.input);
  const result = await normalizeImageResult(payload, job.input, job.endpoint);
  if (!result.images.length) {
    throw new Error(`上游没有返回可用图片: ${summarizePayload(payload)}`);
  }

  job.status = "succeeded";
  job.updatedAt = new Date().toISOString();
  job.result = result;
}

function failJob(jobId, error) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "failed";
  job.updatedAt = new Date().toISOString();
  job.error = String(error?.message || error || "任务失败");
}

function scheduleCleanup(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TIMEOUT_MS).unref?.();
}

function serializeJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    error: job.error || undefined,
    endpoint: job.endpoint,
    result: job.result,
  };
}

async function dispatchUpstream(input) {
  const isEdit = input.mode === "edit";
  const endpointCandidates = isEdit
    ? [
        joinUrl(input.baseUrl, "/v1/images/edits"),
        joinUrl(input.baseUrl, "/images/edits"),
      ]
    : [
        joinUrl(input.baseUrl, "/v1/images/generations"),
        joinUrl(input.baseUrl, "/images/generations"),
      ];

  let lastError = null;
  for (const endpoint of unique(endpointCandidates)) {
    try {
      const response = isEdit
        ? await requestFormData(endpoint, {
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              Accept: "application/json",
            },
            timeoutMs: UPSTREAM_IMAGE_TIMEOUT_MS,
            maxBytes: IMAGE_RESPONSE_LIMIT_BYTES,
          }, buildEditFormData(input))
        : await requestJson(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            timeoutMs: UPSTREAM_IMAGE_TIMEOUT_MS,
            maxBytes: IMAGE_RESPONSE_LIMIT_BYTES,
          }, buildGenerationBody(input));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const data = response.data;
        throw new Error(data.error?.message || data.error || data.message || `HTTP ${response.statusCode}`);
      }
      return response.data;
    } catch (error) {
      lastError = new Error(`${endpoint} -> ${error?.message || error || "未知错误"}`);
    }
  }

  throw badGateway(`图像请求失败：${lastError?.message || "无法连接上游"}`);
}

function buildGenerationBody(input) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    n: input.count,
  };

  if (input.model.toLowerCase().includes("gpt-image")) {
    body.quality = "high";
  }

  return body;
}

function buildEditFormData(input) {
  const form = new FormData();
  form.set("model", input.model);
  form.set("prompt", input.prompt);
  form.set("size", input.size);
  form.set("n", String(input.count));

  input.images.forEach((image, index) => {
    const { buffer, type, name } = decodeDataUrl(image.dataUrl);
    const file = new File([buffer], image.name || name || `reference-${index + 1}.png`, { type });
    form.append("image", file);
  });

  return form;
}

async function normalizeImageResult(payload, input, endpoint) {
  const images = [];
  const seen = new Set();

  if (Array.isArray(payload?.images)) {
    for (const image of payload.images) {
      const normalized = await normalizeImageNode(image);
      pushImage(images, seen, normalized);
    }
  }

  if (Array.isArray(payload?.data)) {
    for (const image of payload.data) {
      const normalized = await normalizeImageNode(image);
      pushImage(images, seen, normalized);
    }
  }

  if (payload?.image) {
    const normalized = await normalizeImageNode(payload.image);
    pushImage(images, seen, normalized);
  }

  // Some gateways wrap image results differently between text-to-image and image-edit.
  // Fall back to a bounded recursive scan before declaring the payload unusable.
  if (!images.length) {
    const discovered = await collectImagesFromPayload(payload);
    for (const image of discovered) {
      pushImage(images, seen, image);
    }
  }

  return {
    model: payload?.model || input.model,
    endpoint,
    mode: input.mode,
    images,
    raw: undefined,
  };
}

async function normalizeImageNode(node) {
  if (!node) return null;
  if (typeof node === "string") {
    return cacheImageSource(node);
  }
  if (node.url) {
    return cacheImageSource(node.url);
  }
  if (node.src) {
    return cacheImageSource(node.src);
  }
  if (node.b64_json) {
    return saveBase64Image(node.b64_json, "image/png");
  }
  if (node.base64) {
    return saveBase64Image(node.base64, "image/png");
  }
  return null;
}

async function collectImagesFromPayload(payload) {
  const queue = [payload];
  const visited = new Set();
  const found = [];
  const seen = new Set();

  while (queue.length && visited.size < 200) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const normalized = await normalizeImageNode(current);
    pushImage(found, seen, normalized);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === "object") queue.push(item);
      }
      continue;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return found;
}

function toImageRecord(src) {
  const value = String(src || "").trim();
  if (!value) return null;
  if (value.startsWith("data:")) {
    return { kind: "data", src: value };
  }
  return { kind: "url", src: value };
}

async function cacheImageSource(src) {
  const value = String(src || "").trim();
  if (!value) return null;

  if (value.startsWith("data:")) {
    return saveDataUrlImage(value);
  }

  if (/^https?:\/\//i.test(value)) {
    return downloadRemoteImage(value);
  }

  return {
    kind: "asset",
    src: value,
  };
}

async function downloadRemoteImage(url) {
  await assertSafeRemoteUrl(url, "imageUrl");
  const response = await requestBinary(url, {
    method: "GET",
    headers: {
      Accept: "image/*,*/*;q=0.8",
    },
    timeoutMs: UPSTREAM_DOWNLOAD_TIMEOUT_MS,
    maxBytes: REMOTE_IMAGE_LIMIT_BYTES,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw badGateway(`结果图片下载失败：HTTP ${response.statusCode}`);
  }

  const extension = inferImageExtension(response.headers["content-type"], url);
  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(join(GENERATED_DIR, filename), response.buffer);
  return {
    kind: "asset",
    src: `/generated/${filename}`,
  };
}

async function saveDataUrlImage(dataUrl) {
  const { buffer, type } = decodeDataUrl(dataUrl);
  const extension = inferImageExtension(type, "");
  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(join(GENERATED_DIR, filename), buffer);
  return {
    kind: "asset",
    src: `/generated/${filename}`,
  };
}

async function saveBase64Image(base64, type) {
  const buffer = Buffer.from(String(base64 || ""), "base64");
  const extension = inferImageExtension(type, "");
  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(join(GENERATED_DIR, filename), buffer);
  return {
    kind: "asset",
    src: `/generated/${filename}`,
  };
}

async function proxyRemoteImage(res, target, asDownload, filename) {
  await assertSafeRemoteUrl(target, "url");
  return proxyViaNodeRequest(res, target, asDownload, filename);
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function joinUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ""));
  if (!match) {
    throw badRequest("参考图必须是 base64 data URL");
  }
  const type = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  const ext = type.split("/")[1] || "png";
  return {
    buffer,
    type,
    name: `image.${ext}`,
  };
}

function inferImageExtension(contentType, fallbackUrl) {
  const normalizedType = String(contentType || "").toLowerCase();
  if (normalizedType.includes("png")) return "png";
  if (normalizedType.includes("jpeg") || normalizedType.includes("jpg")) return "jpg";
  if (normalizedType.includes("webp")) return "webp";
  if (normalizedType.includes("gif")) return "gif";

  const extension = extname(new URL(String(fallbackUrl || "https://local.invalid/file")).pathname)
    .replace(".", "")
    .toLowerCase();
  return extension || "png";
}

function clampCount(value) {
  const count = Number.parseInt(String(value || "1"), 10);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(10, count));
}

function sanitizeFilename(value) {
  return String(value || "image.png").replace(/[^a-z0-9._-]+/gi, "-");
}

function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function pushImage(images, seen, image) {
  if (!image?.src) return;
  const key = `${image.kind}:${image.src}`;
  if (seen.has(key)) return;
  seen.add(key);
  images.push(image);
}

function summarizePayload(payload) {
  try {
    if (payload === null || payload === undefined) return "empty payload";
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (typeof payload !== "object") return typeof payload;
    const keys = Object.keys(payload).slice(0, 12);
    const summary = {};
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) {
        summary[key] = `array(${value.length})`;
      } else if (value && typeof value === "object") {
        summary[key] = `object(${Object.keys(value).slice(0, 6).join(",")})`;
      } else {
        summary[key] = value;
      }
    }
    return JSON.stringify(summary);
  } catch {
    return "unserializable payload";
  }
}

async function requestJson(url, options = {}, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return requestViaNode(url, {
    method: options.method || "GET",
    headers: {
      ...(options.headers || {}),
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    },
  }, payload, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
  });
}

async function requestFormData(url, options = {}, formData) {
  const request = new Request(url, {
    method: options.method || "POST",
    headers: options.headers,
    body: formData,
  });
  const headers = Object.fromEntries(request.headers.entries());
  const payloadBuffer = Buffer.from(await request.arrayBuffer());
  return requestViaNode(url, {
    method: request.method,
    headers: {
      ...headers,
      "Content-Length": String(payloadBuffer.byteLength),
    },
  }, payloadBuffer, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
  });
}

async function requestBinary(url, options = {}) {
  return requestViaNode(url, {
    method: options.method || "GET",
    headers: options.headers || {},
  }, null, {
    raw: true,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
  });
}

function requestViaNode(target, options, body, meta = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transport.request(url, options, (response) => {
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (meta.maxBytes && totalBytes > meta.maxBytes) {
          response.destroy(payloadTooLarge(`上游响应超过限制（最大 ${formatByteLimit(meta.maxBytes)}）`));
        }
      });
      response.on("error", finishWithError);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const buffer = Buffer.concat(chunks);
        const contentType = String(response.headers["content-type"] || "");
        let data;
        if (meta.raw) {
          data = null;
        } else if (contentType.includes("application/json")) {
          try {
            data = JSON.parse(buffer.toString("utf8") || "{}");
          } catch {
            data = {};
          }
        } else {
          data = { error: buffer.toString("utf8") };
        }
        resolve({
          statusCode: response.statusCode || 500,
          headers: response.headers,
          data,
          buffer,
        });
      });
    });
    request.setTimeout(meta.timeoutMs ?? UPSTREAM_IMAGE_TIMEOUT_MS, () => {
      request.destroy(badGateway("上游请求超时"));
    });
    request.on("error", finishWithError);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function proxyViaNodeRequest(res, target, asDownload, filename) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finishWithError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const upstream = transport.get(url, (response) => {
      if (!response.statusCode || response.statusCode >= 400) {
        response.resume();
        finishWithError(badGateway(`图片拉取失败：HTTP ${response.statusCode || 502}`));
        return;
      }

      const headers = {
        "Content-Type": String(response.headers["content-type"] || "application/octet-stream"),
        "Cache-Control": "no-cache",
      };
      if (asDownload) {
        headers["Content-Disposition"] = `attachment; filename="${sanitizeFilename(filename || "image.png")}"`;
      }
      res.writeHead(200, headers);
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > REMOTE_IMAGE_LIMIT_BYTES) {
          response.destroy(payloadTooLarge(`图片超过限制（最大 ${formatByteLimit(REMOTE_IMAGE_LIMIT_BYTES)}）`));
          return;
        }
        if (!res.write(chunk)) {
          response.pause();
        }
      });
      res.on("drain", () => response.resume());
      response.on("end", () => {
        if (settled) return;
        settled = true;
        res.end();
        resolve();
      });
      response.on("error", finishWithError);
    });
    upstream.setTimeout(UPSTREAM_DOWNLOAD_TIMEOUT_MS, () => {
      upstream.destroy(badGateway("图片代理超时"));
    });
    upstream.on("error", finishWithError);
  });
}

function isAllowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function assertSafeRemoteUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw badRequest(`${label} 不是合法 URL`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw badRequest(`${label} 只支持 http 或 https`);
  }
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function payloadTooLarge(message) {
  const error = new Error(message);
  error.statusCode = 413;
  error.expose = true;
  return error;
}

function badGateway(message) {
  const error = new Error(message);
  error.statusCode = 502;
  error.expose = true;
  return error;
}

function readPositiveIntEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
