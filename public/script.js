const STORAGE_KEY = "image-workbench-config";
const HISTORY_KEY = "image-workbench-history";
const DRAFT_CONFIG_KEY = "image-workbench-config-draft";
const state = {
  config: null,
  detectedModel: "",
  mode: "generate",
  files: [],
  objectUrls: [],
  busy: false,
  progressTimer: 0,
  progressStartedAt: 0,
  theme: "light",
};

const els = {
  configForm: document.getElementById("configForm"),
  baseUrl: document.getElementById("baseUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  detectModelButton: document.getElementById("detectModelButton"),
  modelPanel: document.getElementById("modelPanel"),
  modelList: document.getElementById("modelList"),
  modelStatus: document.getElementById("modelStatus"),
  configBadge: document.getElementById("configBadge"),
  configError: document.getElementById("configError"),
  enterStudioButton: document.getElementById("enterStudioButton"),
  studioView: document.getElementById("studioView"),
  themeToggle: document.getElementById("themeToggle"),
  toast: document.getElementById("toast"),
  backToConfig: document.getElementById("backToConfig"),
  editKeyButton: document.getElementById("editKeyButton"),
  prompt: document.getElementById("prompt"),
  imageInput: document.getElementById("imageInput"),
  dropzone: document.getElementById("dropzone"),
  thumbGrid: document.getElementById("thumbGrid"),
  referenceHint: document.getElementById("referenceHint"),
  clearRefsButton: document.getElementById("clearRefsButton"),
  size: document.getElementById("size"),
  customSizeWrap: document.getElementById("customSizeWrap"),
  customSize: document.getElementById("customSize"),
  imageCount: document.getElementById("imageCount"),
  workspaceTitle: document.getElementById("workspaceTitle"),
  endpointLabel: document.getElementById("endpointLabel"),
  connectionName: document.getElementById("connectionName"),
  modeStatus: document.getElementById("modeStatus"),
  jobOverlay: document.getElementById("jobOverlay"),
  progressStage: document.getElementById("progressStage"),
  elapsedTime: document.getElementById("elapsedTime"),
  progressBar: document.getElementById("progressBar"),
  jobPercent: document.getElementById("jobPercent"),
  emptyState: document.getElementById("emptyState"),
  resultGrid: document.getElementById("resultGrid"),
  runButton: document.getElementById("runButton"),
  clearButton: document.getElementById("clearButton"),
  studioError: document.getElementById("studioError"),
  summaryBase: document.getElementById("summaryBase"),
  summaryModel: document.getElementById("summaryModel"),
  summaryKey: document.getElementById("summaryKey"),
  successHistoryList: document.getElementById("successHistoryList"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
  modeTabs: document.querySelectorAll("[data-mode]"),
  chips: document.querySelectorAll(".chip"),
};

const isConfigPage = Boolean(els.configForm);
const isStudioPage = Boolean(els.studioView);

initTheme();
bindEvents();

if (isConfigPage) {
  restoreConfig();
}

if (isStudioPage) {
  loadRuntimeConfig();
  updateModeUI();
  updateSummary();
  updateConnection();
  renderHistory();
}

function bindEvents() {
  if (els.themeToggle) {
    els.themeToggle.addEventListener("click", toggleTheme);
  }

  if (isConfigPage) {
    els.configForm.addEventListener("submit", onConfigSubmit);
    els.detectModelButton?.addEventListener("click", detectModels);
    els.baseUrl.addEventListener("input", resetDetectedModelState);
    els.apiKey.addEventListener("input", resetDetectedModelState);
  }

  if (!isStudioPage) return;

  els.backToConfig?.addEventListener("click", () => {
    window.location.href = "/index.html";
  });
  els.editKeyButton?.addEventListener("click", onEditKey);
  els.size?.addEventListener("change", updateCustomSizeUI);
  els.imageInput?.addEventListener("change", (event) => addFiles(event.target.files));
  els.clearRefsButton?.addEventListener("click", clearReferenceImages);
  els.runButton?.addEventListener("click", runImageJob);
  els.clearButton?.addEventListener("click", clearCanvas);
  els.clearHistoryButton?.addEventListener("click", clearHistory);

  els.modeTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode === "edit" ? "edit" : "generate";
      updateModeUI();
    });
  });

  els.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const text = chip.dataset.prompt || "";
      const current = els.prompt.value.trim();
      els.prompt.value = current ? `${current}，${text}` : text;
      els.prompt.focus();
    });
  });

  els.dropzone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.dropzone.classList.add("dragover");
  });
  els.dropzone?.addEventListener("dragleave", () => {
    els.dropzone.classList.remove("dragover");
  });
  els.dropzone?.addEventListener("drop", (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("dragover");
    addFiles(event.dataTransfer.files);
  });

  updateCustomSizeUI();
}

function restoreConfig() {
  const config = safeJson(localStorage.getItem(DRAFT_CONFIG_KEY)) || safeJson(localStorage.getItem(STORAGE_KEY));
  if (!config) {
    els.baseUrl.value = "";
    els.apiKey.value = "";
    setModelPanelVisible(false);
    updateEnterStudioState();
    return;
  }
  els.baseUrl.value = config.baseUrl || "";
  els.apiKey.value = config.apiKey || "";
  state.detectedModel = config.model || "";
  if (els.model) els.model.value = state.detectedModel || "";
  if (config.baseUrl && config.apiKey) {
    if (state.detectedModel) {
      setModelPanelVisible(true);
      setModelStatus(`已识别 ${config.modelList?.length || 1} 个图像模型，当前：${state.detectedModel}`);
      fillModelList(config.modelList?.length ? config.modelList : [config.model], state.detectedModel);
    } else {
      setModelPanelVisible(false);
    }
  }
  updateEnterStudioState();
}

function resetDetectedModelState() {
  state.detectedModel = "";
  if (els.model) els.model.value = "";
  setModelPanelVisible(false);
  fillModelList([], "");
  setModelStatus("");
  updateEnterStudioState();
}

async function detectModels() {
  hideError(els.configError);
  const baseUrl = normalizeBaseUrl(els.baseUrl.value);
  const apiKey = els.apiKey.value.trim();
  if (!baseUrl || !apiKey) {
    state.detectedModel = "";
    if (els.model) els.model.value = "";
    setModelPanelVisible(false);
    fillModelList([], "");
    setModelStatus("");
    updateEnterStudioState();
    return;
  }

  if (els.detectModelButton) els.detectModelButton.disabled = true;
  setModelPanelVisible(true);
  if (els.model) els.model.value = "";
  setModelStatus("正在识别图像模型...");
  updateConfigBadge("detecting");
  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "模型识别失败");
    }
    state.detectedModel = data.preferredModel || "";
    if (els.model) els.model.value = state.detectedModel || "";
    fillModelList(data.imageModels || [], state.detectedModel);
    localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify({
      baseUrl,
      apiKey,
      model: state.detectedModel,
      modelList: data.imageModels || [],
    }));
    setModelStatus(
      state.detectedModel
        ? `已识别 ${data.imageModels.length} 个图像模型，当前：${state.detectedModel}`
        : "没有识别到明显的图像模型"
    );
  } catch (error) {
    state.detectedModel = "";
    if (els.model) els.model.value = "";
    fillModelList([], "");
    setModelPanelVisible(false);
    setModelStatus("");
    localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify({
      baseUrl,
      apiKey,
      model: "",
      modelList: [],
    }));
    showError(els.configError, error.message || "识别失败");
  } finally {
    if (els.detectModelButton) els.detectModelButton.disabled = false;
    updateEnterStudioState();
  }
}

function fillModelList(models, activeModel = "") {
  if (!els.modelList) return;
  const unique = [...new Set((models || []).filter(Boolean))];
  els.modelList.hidden = unique.length === 0;
  els.modelList.innerHTML = unique.map((model) => {
    const active = model === activeModel ? " active" : "";
    return `<button type="button" class="chip model-chip${active}" data-model="${escapeAttr(model)}">${escapeHtml(model)}</button>`;
  }).join("");

  els.modelList.querySelectorAll("[data-model]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detectedModel = button.dataset.model || "";
      els.model.value = state.detectedModel || "等待识别";
      fillModelList(unique, state.detectedModel);
      setModelStatus(`已手动选择模型：${state.detectedModel}`);
      localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify({
        baseUrl: normalizeBaseUrl(els.baseUrl.value),
        apiKey: els.apiKey.value.trim(),
        model: state.detectedModel,
        modelList: unique,
      }));
      updateEnterStudioState();
    });
  });
}

function setModelStatus(message) {
  if (els.modelStatus) {
    els.modelStatus.textContent = message;
  }
}

function setModelPanelVisible(visible) {
  if (els.modelPanel) {
    els.modelPanel.hidden = !visible;
  }
}

function updateEnterStudioState() {
  if (!els.enterStudioButton) return;
  els.enterStudioButton.disabled = !state.detectedModel;
  updateConfigBadge();
}

function updateConfigBadge(status = "") {
  if (!els.configBadge) return;
  const baseUrl = normalizeBaseUrl(els.baseUrl?.value);
  const apiKey = els.apiKey?.value.trim();

  let label = "未配置";
  let className = "badge badge-pending";

  if (status === "detecting") {
    label = "识别中";
    className = "badge badge-busy";
  } else if (state.detectedModel) {
    label = "Ready";
    className = "badge badge-ready";
  } else if (baseUrl && apiKey) {
    label = "待识别";
    className = "badge badge-pending";
  }

  els.configBadge.className = className;
  els.configBadge.textContent = label;
}

async function onConfigSubmit(event) {
  event.preventDefault();
  hideError(els.configError);

  if (!state.detectedModel) {
    showError(els.configError, "请先点击“识别模型”，并选择可用模型。");
    return;
  }

  const config = {
    baseUrl: normalizeBaseUrl(els.baseUrl.value),
    apiKey: els.apiKey.value.trim(),
    model: state.detectedModel,
  };

  if (!config.baseUrl || !config.apiKey || !config.model) {
    showError(els.configError, "请先完成 Base URL、Key 和模型识别。");
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  localStorage.removeItem(DRAFT_CONFIG_KEY);
  toast("配置已保存");
  window.location.href = "/studio.html";
}

function loadRuntimeConfig() {
  const config = safeJson(localStorage.getItem(STORAGE_KEY));
  if (!config?.baseUrl || !config?.apiKey || !config?.model) {
    toast("请先完成连接配置");
    window.setTimeout(() => {
      window.location.href = "/index.html";
    }, 500);
    return;
  }
  state.config = config;
}

function updateSummary() {
  if (!state.config) return;
  els.summaryBase.textContent = state.config.baseUrl;
  els.summaryModel.textContent = state.config.model;
  els.summaryKey.textContent = maskKey(state.config.apiKey);
}

function updateConnection() {
  if (!els.connectionName) return;
  els.connectionName.textContent = state.config ? `${state.config.model} @ ${state.config.baseUrl}` : "等待配置";
}

function updateModeUI() {
  if (!isStudioPage) return;
  const isEdit = state.mode === "edit";
  const hasFiles = state.files.length > 0;
  els.modeTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
  els.workspaceTitle.textContent = isEdit ? "参考图改图" : "文本生图";
  els.endpointLabel.textContent = `将调用 ${isEdit ? "/images/edits" : "/images/generations"}`;
  els.modeStatus.textContent = isEdit ? "自动端点：改图" : `自动端点：生图${hasFiles ? "（已忽略参考图）" : ""}`;
  els.referenceHint.textContent = hasFiles
    ? (isEdit ? `已上传 ${state.files.length} 张，提交时会一起发送。` : `已上传 ${state.files.length} 张，但生图模式不会发送。`)
    : "改图模式会把参考图一并发送到上游接口。";
  els.clearRefsButton.hidden = !hasFiles;
  els.runButton.textContent = isEdit ? (state.busy ? "改图中..." : "开始改图") : (state.busy ? "生成中..." : "生成图像");
}

function addFiles(fileList) {
  const incoming = [...(fileList || [])].filter((file) => /^image\/(png|jpeg|webp)$/i.test(file.type));
  if (!incoming.length) {
    toast("请选择 PNG、JPG 或 WEBP 图片");
    return;
  }
  state.files = [...state.files, ...incoming].slice(0, 8);
  renderThumbs();
  updateModeUI();
}

function renderThumbs() {
  revokeObjectUrls();
  els.thumbGrid.innerHTML = "";
  state.files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);
    const item = document.createElement("div");
    item.className = "thumb";
    item.innerHTML = `
      <img src="${escapeAttr(url)}" alt="参考图 ${index + 1}">
      <button type="button" aria-label="移除参考图">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      state.files.splice(index, 1);
      renderThumbs();
      updateModeUI();
    });
    els.thumbGrid.appendChild(item);
  });
}

function clearReferenceImages() {
  state.files = [];
  if (els.imageInput) els.imageInput.value = "";
  renderThumbs();
  updateModeUI();
  toast("参考图已清空");
}

async function onEditKey() {
  if (!state.config) return;
  const nextKey = window.prompt("输入新的 API Key", state.config.apiKey || "");
  if (nextKey === null) return;
  const apiKey = nextKey.trim();
  if (!apiKey) return;
  localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify({
    baseUrl: state.config.baseUrl,
    apiKey,
    model: "",
    modelList: [],
  }));
  toast("请重新识别模型后再进入工作台");
  window.location.href = "/index.html";
}

async function runImageJob() {
  if (state.busy || !state.config) return;
  hideError(els.studioError);

  const prompt = els.prompt.value.trim();
  const size = getRequestedSize();
  const isEdit = state.mode === "edit";

  if (!prompt) {
    showError(els.studioError, "请先填写提示词");
    return;
  }
  if (!size) {
    showError(els.studioError, "自定义尺寸格式必须是 1280x720");
    return;
  }
  if (isEdit && !state.files.length) {
    showError(els.studioError, "改图模式至少需要一张参考图");
    return;
  }

  setBusy(true);
  startProgress();

  try {
    const images = isEdit ? await filesToPayload(state.files) : [];
    const response = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: state.config.baseUrl,
        apiKey: state.config.apiKey,
        model: state.config.model,
        prompt,
        mode: isEdit ? "edit" : "generate",
        size,
        count: Number(els.imageCount.value),
        images,
        async: true,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.jobId) {
      throw new Error(data.error || "任务创建失败");
    }
    const result = await pollJob(data.jobId);
    finishProgress();
    renderResults(result.result);
    recordHistory(result.result, prompt, size);
    toast("图像已生成");
  } catch (error) {
    failProgress(error.message || "请求失败");
    showError(els.studioError, error.message || "图像请求失败");
  } finally {
    setBusy(false);
  }
}

async function filesToPayload(files) {
  return Promise.all(files.map(fileToPayload));
}

function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type,
      dataUrl: String(reader.result || ""),
    });
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function pollJob(jobId) {
  const startedAt = Date.now();
  let delay = 1200;
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await sleep(delay);
    const response = await fetch(`/api/image-jobs/${encodeURIComponent(jobId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "轮询失败");
    }
    updateProgressFromJob(data);
    if (data.status === "succeeded") {
      return data;
    }
    if (data.status === "failed") {
      throw new Error(data.error || "图像任务失败");
    }
    delay = Math.min(4000, Math.round(delay * 1.2));
  }
  throw new Error("等待超时，请稍后重试");
}

function updateProgressFromJob(job) {
  if (job.status === "queued") {
    els.progressStage.textContent = "任务已提交，正在排队";
    return;
  }
  if (job.status === "running") {
    els.progressStage.textContent = "模型处理中，请继续等待";
    return;
  }
  if (job.status === "succeeded") {
    els.progressStage.textContent = "图片已生成，即将显示";
  }
}

function renderResults(result) {
  const images = result?.images || [];
  els.emptyState.hidden = images.length > 0;
  els.resultGrid.innerHTML = "";
  images.forEach((image, index) => {
    const src = image.src;
    const display = src;
    const download = src;
    const open = src;
    const card = document.createElement("article");
    card.className = "result-card";
    card.innerHTML = `
      <img src="${escapeAttr(display)}" alt="结果 ${index + 1}">
      <div class="result-meta">
        <span>${escapeHtml(result.mode === "edit" ? "改图结果" : "生图结果")} · ${escapeHtml(result.model || state.config.model)}</span>
        <div class="result-actions">
          <a href="${escapeAttr(open)}" target="_blank" rel="noopener">打开</a>
          <button type="button" data-copy="${escapeAttr(open)}">复制地址</button>
          <a href="${escapeAttr(download)}" download="${escapeAttr(buildFilename(result, index))}">下载</a>
        </div>
      </div>
    `;
    card.querySelector("[data-copy]").addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText(event.currentTarget.dataset.copy);
        toast("地址已复制");
      } catch {
        toast("复制失败");
      }
    });
    els.resultGrid.appendChild(card);
  });
}

function recordHistory(result, prompt, size) {
  const history = getHistory();
  history.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    prompt,
    size,
    mode: result.mode,
    model: result.model,
    images: (result.images || []).slice(0, 2),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
  renderHistory();
}

function renderHistory() {
  if (!els.successHistoryList) return;
  const history = getHistory();
  els.successHistoryList.innerHTML = "";
  els.clearHistoryButton.hidden = history.length === 0;

  if (!history.length) {
    els.successHistoryList.innerHTML = `<div class="history-item"><strong>暂无记录</strong><p>完成一次生图或改图后会显示在这里。</p></div>`;
    return;
  }

  history.forEach((entry) => {
    const first = entry.images?.[0];
    const href = first?.src || "";
    const item = document.createElement("article");
    item.className = "history-item";
    item.innerHTML = `
      <strong>${escapeHtml(entry.mode === "edit" ? "改图成功" : "生图成功")} · ${escapeHtml(entry.model || "-")}</strong>
      <span>${escapeHtml(formatTime(entry.createdAt))} · ${escapeHtml(entry.size || "-")}</span>
      <p>${escapeHtml(entry.prompt || "无提示词")}</p>
      <div class="history-actions">
        ${href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener">打开首图</a>` : ""}
      </div>
    `;
    els.successHistoryList.appendChild(item);
  });
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  toast("历史记录已清空");
}

function getHistory() {
  const history = safeJson(localStorage.getItem(HISTORY_KEY));
  return Array.isArray(history) ? history : [];
}

function clearCanvas() {
  els.resultGrid.innerHTML = "";
  els.emptyState.hidden = false;
  hideError(els.studioError);
  resetProgress();
}

function setBusy(busy) {
  state.busy = busy;
  if (els.runButton) els.runButton.disabled = busy;
  if (els.clearButton) els.clearButton.disabled = busy;
  updateModeUI();
}

function startProgress() {
  resetProgress(false);
  state.progressStartedAt = Date.now();
  let value = 4;
  els.progressStage.textContent = "正在提交任务";
  state.progressTimer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.progressStartedAt) / 1000);
    value = Math.min(95, value + (elapsed < 15 ? 2.6 : elapsed < 45 ? 0.9 : 0.25));
    els.progressBar.style.width = `${value}%`;
    els.jobPercent.textContent = `${Math.round(value)}%`;
    els.elapsedTime.textContent = formatDuration(elapsed);
    if (elapsed > 10 && value < 70) {
      els.progressStage.textContent = "模型处理中，请继续等待";
    }
  }, 1000);
  els.jobOverlay.hidden = false;
}

function finishProgress() {
  window.clearInterval(state.progressTimer);
  els.progressBar.style.width = "100%";
  els.jobPercent.textContent = "100%";
  els.progressStage.textContent = "图片已生成";
  window.setTimeout(() => {
    if (!state.busy) {
      els.jobOverlay.hidden = true;
    }
  }, 800);
}

function failProgress(message) {
  window.clearInterval(state.progressTimer);
  els.progressStage.textContent = message;
  els.jobPercent.textContent = "失败";
}

function resetProgress(hide = true) {
  window.clearInterval(state.progressTimer);
  state.progressTimer = 0;
  state.progressStartedAt = 0;
  if (els.progressBar) els.progressBar.style.width = "0%";
  if (els.jobPercent) els.jobPercent.textContent = "0%";
  if (els.elapsedTime) els.elapsedTime.textContent = "00:00";
  if (els.progressStage) els.progressStage.textContent = "准备请求";
  if (els.jobOverlay && hide) els.jobOverlay.hidden = true;
}

function getRequestedSize() {
  if (els.size.value !== "custom") return els.size.value;
  const value = String(els.customSize.value || "").trim().toLowerCase().replace(/\s+/g, "");
  return /^\d{2,5}x\d{2,5}$/.test(value) ? value : "";
}

function updateCustomSizeUI() {
  const isCustom = els.size?.value === "custom";
  if (els.customSizeWrap) {
    els.customSizeWrap.hidden = !isCustom;
  }
}

function buildFilename(result, index) {
  const model = String(result.model || "image").replace(/[^a-z0-9._-]+/gi, "-");
  return `image-${model}-${index + 1}.png`;
}

function maskKey(key) {
  if (!key) return "-";
  if (key.length < 10) return "已填写";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function initTheme() {
  const theme = localStorage.getItem("theme") || "light";
  applyTheme(theme);
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark");
}

function applyTheme(theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("theme", state.theme);
}

function showError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
}

function hideError(element) {
  if (!element) return;
  element.textContent = "";
  element.classList.remove("show");
}

function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2200);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function revokeObjectUrls() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
