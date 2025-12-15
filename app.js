/* Scan2Sheets Web - app.js (FULL)
   - Capture/Upload image
   - ROI select (drag rectangle)
   - Image enhance (grayscale/contrast/threshold/adaptive)
   - OCR (Tesseract.js)
   - Barcode/QR (ZXing)
   - Send to Google Sheets via Apps Script Web App
   - History & Pending via localStorage

   CORS FIX:
   - Avoid preflight by NOT sending Content-Type: application/json
*/

const els = {
  scriptUrl: document.getElementById("scriptUrl"),
  secretToken: document.getElementById("secretToken"),
  mode: document.getElementById("mode"),
  ocrLang: document.getElementById("ocrLang"),
  saveSettings: document.getElementById("saveSettings"),
  clearSettings: document.getElementById("clearSettings"),

  startCamera: document.getElementById("startCamera"),
  stopCamera: document.getElementById("stopCamera"),
  capture: document.getElementById("capture"),
  fileInput: document.getElementById("fileInput"),

  video: document.getElementById("video"),
  canvas: document.getElementById("canvas"),
  preview: document.getElementById("preview"),

  enhance: document.getElementById("enhance"),
  crop: document.getElementById("crop"),

  analyze: document.getElementById("analyze"),
  reset: document.getElementById("reset"),

  status: document.getElementById("status"),
  progressBar: document.getElementById("progressBar"),

  sourceType: document.getElementById("sourceType"),
  value: document.getElementById("value"),
  notes: document.getElementById("notes"),
  copyResult: document.getElementById("copyResult"),

  send: document.getElementById("send"),
  savePending: document.getElementById("savePending"),
  sendMsg: document.getElementById("sendMsg"),

  history: document.getElementById("history"),
  retryAll: document.getElementById("retryAll"),
  clearHistory: document.getElementById("clearHistory"),
};

const STORAGE_KEYS = {
  settings: "scan2sheets_settings_v1",
  history: "scan2sheets_history_v1",
};

let cameraStream = null;
let currentImageBlob = null;
let currentImageDataUrl = null;

const ZXing = window.ZXing;
const barcodeReader = ZXing ? new ZXing.BrowserMultiFormatReader() : null;

// ===== ROI (Region of Interest) =====
const roiCanvas = document.getElementById("roiCanvas");
const enableRoiBtn = document.getElementById("enableRoi");
const clearRoiBtn = document.getElementById("clearRoi");

const roi = {
  enabled: false,
  rect: null,      // {x,y,w,h} in canvas coords
  dragging: false,
  start: null,
  baseImageData: null,
};

init();

function init() {
  loadSettings();
  renderHistory();

  els.saveSettings.addEventListener("click", saveSettings);
  els.clearSettings.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEYS.settings);
    loadSettings();
    toast("تم مسح الإعدادات.");
  });

  els.startCamera.addEventListener("click", startCamera);
  els.stopCamera.addEventListener("click", stopCamera);
  els.capture.addEventListener("click", captureFromVideo);
  els.fileInput.addEventListener("change", onFileSelected);

  els.analyze.addEventListener("click", analyzeCurrentImage);
  els.reset.addEventListener("click", resetAll);

  els.copyResult.addEventListener("click", copyResult);
  els.send.addEventListener("click", sendToSheets);
  els.savePending.addEventListener("click", () => saveHistoryItem(buildPayload(), "pending"));

  els.retryAll.addEventListener("click", retryAllPending);
  els.clearHistory.addEventListener("click", () => {
    if (!confirm("هل تريد مسح السجل بالكامل؟")) return;
    setHistory([]);
    renderHistory();
  });

  enableRoiBtn.addEventListener("click", () => enableRoiMode(true));
  clearRoiBtn.addEventListener("click", () => {
    roi.rect = null;
    clearRoiBtn.disabled = true;
    redrawRoiCanvas();
    setStatus("تم إلغاء التحديد.");
  });
  setupRoiEvents();

  setUiEnabled(false);
  setStatus("جاهز. اختر فتح الكاميرا أو رفع صورة.");
}

function setUiEnabled(hasImage) {
  els.analyze.disabled = !hasImage;
  els.reset.disabled = !hasImage;
  els.send.disabled = !hasImage;
  els.savePending.disabled = !hasImage;
  els.copyResult.disabled = !hasImage;
}

function setStatus(msg) { els.status.textContent = msg; }
function setSendMsg(msg) { els.sendMsg.textContent = msg; }
function setProgress(pct) { els.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
function toast(msg) { setStatus(msg); }

function saveSettings() {
  const s = {
    scriptUrl: els.scriptUrl.value.trim(),
    secretToken: els.secretToken.value.trim(),
    mode: els.mode.value,
    ocrLang: els.ocrLang.value,
  };
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(s));
  toast("تم حفظ الإعدادات.");
}

function loadSettings() {
  const raw = localStorage.getItem(STORAGE_KEYS.settings);
  const s = raw ? JSON.parse(raw) : {};
  els.scriptUrl.value = s.scriptUrl || "";
  els.secretToken.value = s.secretToken || "";
  els.mode.value = s.mode || "auto";
  els.ocrLang.value = s.ocrLang || "eng";
}

async function startCamera() {
  try {
    stopCamera();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    els.video.srcObject = cameraStream;
    await els.video.play();

    els.capture.disabled = false;
    els.stopCamera.disabled = false;
    setStatus("الكاميرا تعمل. اضغط التقاط.");
  } catch (err) {
    console.error(err);
    setStatus("تعذر فتح الكاميرا. تأكد من السماح بالصلاحيات أو جرّب رفع صورة.");
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  els.video.pause();
  els.video.srcObject = null;
  els.capture.disabled = true;
  els.stopCamera.disabled = true;
}

function captureFromVideo() {
  if (!els.video.videoWidth) return;

  const w = els.video.videoWidth;
  const h = els.video.videoHeight;

  els.canvas.width = w;
  els.canvas.height = h;
  const ctx = els.canvas.getContext("2d");
  ctx.drawImage(els.video, 0, 0, w, h);

  els.canvas.toBlob(async (blob) => {
    if (!blob) return;
    currentImageBlob = blob;

    if (currentImageDataUrl) URL.revokeObjectURL(currentImageDataUrl);
    currentImageDataUrl = URL.createObjectURL(blob);

    // عرض عبر roiCanvas لتحديد المنطقة
    await renderImageToRoiCanvas(blob);

    setUiEnabled(true);
    setStatus("تم التقاط الصورة. يمكنك تحديد منطقة النص ثم التعرّف.");
  }, "image/jpeg", 0.92);
}

async function onFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  currentImageBlob = file;

  if (currentImageDataUrl) URL.revokeObjectURL(currentImageDataUrl);
  currentImageDataUrl = URL.createObjectURL(file);

  await renderImageToRoiCanvas(file);

  setUiEnabled(true);
  setStatus("تم تحميل الصورة. يمكنك تحديد منطقة النص ثم التعرّف.");
}

function resetAll() {
  currentImageBlob = null;

  if (currentImageDataUrl) URL.revokeObjectURL(currentImageDataUrl);
  currentImageDataUrl = null;

  // reset UI
  els.value.value = "";
  els.notes.value = "";
  setProgress(0);
  setSendMsg("");
  setUiEnabled(false);

  // ROI reset
  roi.enabled = false;
  roi.rect = null;
  roi.dragging = false;
  roi.start = null;
  roi.baseImageData = null;
  clearRoiBtn.disabled = true;

  // show img default
  els.preview.removeAttribute("src");
  els.preview.style.display = "block";
  roiCanvas.style.display = "none";

  setStatus("جاهز. اختر فتح الكاميرا أو رفع صورة.");
}

async function analyzeCurrentImage() {
  if (!currentImageBlob) return;
  setProgress(0);
  setSendMsg("");
  els.value.value = "";

  try {
    setStatus("تحضير الصورة...");
    const processed = await preprocessImage(currentImageBlob, els.enhance.value, els.crop.value);

    const mode = els.mode.value;

    if (mode === "barcode") {
      const barcode = await tryDecodeBarcode(processed);
      if (!barcode) throw new Error("لم يتم العثور على باركود/QR في الصورة.");
      els.sourceType.value = "BARCODE";
      els.value.value = barcode;
      setStatus("تمت قراءة الباركود بنجاح.");
      setUiEnabled(true);
      return;
    }

    if (mode === "text") {
      const text = await runOcr(processed, els.ocrLang.value);
      if (!text.trim()) throw new Error("لم يتم استخراج نص واضح. جرّب تحديد منطقة أصغر أو تحسين الصورة.");
      els.sourceType.value = "HANDWRITING";
      els.value.value = text.trim();
      setStatus("تم استخراج النص بنجاح.");
      setUiEnabled(true);
      return;
    }

    // AUTO: barcode first then OCR
    setStatus("محاولة قراءة الباركود/QR...");
    const barcode = await tryDecodeBarcode(processed);
    if (barcode) {
      els.sourceType.value = "BARCODE";
      els.value.value = barcode;
      setStatus("تمت قراءة الباركود بنجاح.");
      setUiEnabled(true);
      return;
    }

    setStatus("لم يتم العثور على باركود. بدء OCR...");
    const text = await runOcr(processed, els.ocrLang.value);
    if (!text.trim()) throw new Error("فشل OCR أو النص غير واضح.");
    els.sourceType.value = "HANDWRITING";
    els.value.value = text.trim();
    setStatus("تم استخراج النص بنجاح.");
    setUiEnabled(true);

  } catch (err) {
    console.error(err);
    setStatus(`خطأ: ${err.message || err}`);
  } finally {
    setProgress(100);
    setTimeout(() => setProgress(0), 500);
  }
}

// ================= ROI Rendering & Events =================

async function renderImageToRoiCanvas(blob) {
  const img = await blobToImage(blob);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  roiCanvas.width = w;
  roiCanvas.height = h;

  const ctx = roiCanvas.getContext("2d", { willReadFrequently: true });

  // reset ROI
  roi.baseImageData = null;
  roi.rect = null;
  clearRoiBtn.disabled = true;

  ctx.drawImage(img, 0, 0, w, h);
  roi.baseImageData = ctx.getImageData(0, 0, w, h);

  // show roiCanvas & hide img
  roiCanvas.style.display = "block";
  els.preview.style.display = "none";

  redrawRoiCanvas();
}

function enableRoiMode(on) {
  roi.enabled = on;
  if (on) {
    setStatus("اسحب على الصورة لتحديد منطقة النص، ثم اضغط (التعرّف على المحتوى).");
  } else {
    setStatus("تم إيقاف وضع التحديد.");
  }
}

function setupRoiEvents() {
  const getPos = (ev) => {
    const r = roiCanvas.getBoundingClientRect();
    const clientX = ("touches" in ev) ? ev.touches[0].clientX : ev.clientX;
    const clientY = ("touches" in ev) ? ev.touches[0].clientY : ev.clientY;
    const xCss = clientX - r.left;
    const yCss = clientY - r.top;

    const sx = roiCanvas.width / r.width;
    const sy = roiCanvas.height / r.height;
    return { x: xCss * sx, y: yCss * sy };
  };

  const down = (ev) => {
    if (!roi.enabled || !currentImageBlob) return;
    ev.preventDefault();
    roi.dragging = true;
    roi.start = getPos(ev);
    roi.rect = { x: roi.start.x, y: roi.start.y, w: 0, h: 0 };
    redrawRoiCanvas();
  };

  const move = (ev) => {
    if (!roi.enabled || !roi.dragging) return;
    ev.preventDefault();
    const p = getPos(ev);
    roi.rect.w = p.x - roi.start.x;
    roi.rect.h = p.y - roi.start.y;
    redrawRoiCanvas();
  };

  const up = (ev) => {
    if (!roi.enabled || !roi.dragging) return;
    ev.preventDefault();
    roi.dragging = false;

    roi.rect = normalizeRect(roi.rect);
    if (roi.rect.w < 40 || roi.rect.h < 40) {
      roi.rect = null;
      clearRoiBtn.disabled = true;
      setStatus("التحديد صغير جدًا. جرّب تحديد منطقة أكبر.");
    } else {
      clearRoiBtn.disabled = false;
      setStatus("تم تحديد المنطقة ✅ الآن اضغط (التعرّف على المحتوى).");
    }
    redrawRoiCanvas();
  };

  roiCanvas.addEventListener("mousedown", down);
  roiCanvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);

  roiCanvas.addEventListener("touchstart", down, { passive: false });
  roiCanvas.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", up, { passive: false });
}

function normalizeRect(r) {
  let { x, y, w, h } = r;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  return { x, y, w, h };
}

function redrawRoiCanvas() {
  const ctx = roiCanvas.getContext("2d", { willReadFrequently: true });
  if (!roi.baseImageData) return;

  ctx.putImageData(roi.baseImageData, 0, 0);

  if (roi.rect) {
    const r = normalizeRect(roi.rect);

    // darken outside ROI
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, roiCanvas.width, roiCanvas.height);
    ctx.putImageData(roi.baseImageData, 0, 0); // restore then clear ROI area effect in a simple way
    ctx.restore();

    // draw overlay by re-drawing base, then darken, then clear ROI
    ctx.putImageData(roi.baseImageData, 0, 0);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, roiCanvas.width, roiCanvas.height);
    ctx.clearRect(r.x, r.y, r.w, r.h);

    // border
    ctx.save();
    ctx.strokeStyle = "rgba(31,111,235,0.95)";
    ctx.lineWidth = Math.max(3, Math.round(roiCanvas.width * 0.003));
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

// ================= Image preprocess (ROI + enhance) =================

async function preprocessImage(blob, enhanceMode, cropMode) {
  const img = await blobToImage(blob);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;

  // optional center crop (global)
  let sx = 0, sy = 0, sw = w, sh = h;
  if (cropMode === "center") {
    const cw = Math.floor(w * 0.8);
    const ch = Math.floor(h * 0.8);
    sx = Math.floor((w - cw) / 2);
    sy = Math.floor((h - ch) / 2);
    sw = cw; sh = ch;
  }

  canvas.width = sw;
  canvas.height = sh;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  // ROI crop (if selected)
  if (roi.rect && roiCanvas.width && roiCanvas.height) {
    // roi.rect is based on original image (roiCanvas == original)
    // we must map ROI to current canvas if center crop was applied
    // if no center crop, mapping is direct.

    const r0 = normalizeRect(roi.rect);

    // mapping from original -> (center-cropped) canvas coordinates:
    const rx = r0.x - sx;
    const ry = r0.y - sy;
    const rw = r0.w;
    const rh = r0.h;

    // clamp inside canvas
    const r = {
      x: clampInt(rx, 0, canvas.width - 1),
      y: clampInt(ry, 0, canvas.height - 1),
      w: clampInt(rw, 1, canvas.width),
      h: clampInt(rh, 1, canvas.height),
    };

    // adjust w/h if exceed bounds
    if (r.x + r.w > canvas.width) r.w = canvas.width - r.x;
    if (r.y + r.h > canvas.height) r.h = canvas.height - r.y;

    if (r.w >= 10 && r.h >= 10) {
      const tmp = document.createElement("canvas");
      tmp.width = r.w;
      tmp.height = r.h;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);

      canvas.width = tmp.width;
      canvas.height = tmp.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(tmp, 0, 0);
    }
  }

  // enhance
  if (enhanceMode !== "none") {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;

    // grayscale / contrast / threshold prep
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;

      if (enhanceMode === "grayscale" || enhanceMode === "adaptive" || enhanceMode === "threshold") {
        d[i] = d[i + 1] = d[i + 2] = gray;
      } else if (enhanceMode === "contrast") {
        const factor = 1.25;
        d[i] = clampByte((r - 128) * factor + 128);
        d[i + 1] = clampByte((g - 128) * factor + 128);
        d[i + 2] = clampByte((b - 128) * factor + 128);
      }
    }

    // threshold fixed
    if (enhanceMode === "threshold") {
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        const t = v > 150 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = t;
      }
    }

    // adaptive threshold (simple but effective)
    if (enhanceMode === "adaptive") {
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i];
      const mean = sum / (d.length / 4);
      const T = mean * 0.95; // tweak: 0.9..1.05 حسب صورك

      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        const out = v > T ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = out;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  const outBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png", 1.0));
  return outBlob;
}

function clampByte(x) { return Math.max(0, Math.min(255, x)); }
function clampInt(x, min, max) { return Math.max(min, Math.min(max, Math.floor(x))); }

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// ================= Barcode =================

async function tryDecodeBarcode(blob) {
  if (!barcodeReader) return null;

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const result = await barcodeReader.decodeFromImageElement(img);
    return result?.text || null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ================= OCR =================

async function runOcr(blob, lang) {
  setProgress(5);

  const url = URL.createObjectURL(blob);
  try {
    const workerProgress = (m) => {
      if (m?.status === "recognizing text" && typeof m.progress === "number") {
        setProgress(10 + Math.floor(m.progress * 80));
        setStatus(`OCR جاري... ${Math.floor(m.progress * 100)}%`);
      }
    };

    const { data } = await Tesseract.recognize(url, lang, { logger: workerProgress });
    return (data?.text || "").trim();
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ================= Sending to Sheets (CORS-safe) =================

function buildPayload() {
  const token = els.secretToken.value.trim();
  const value = (els.value.value || "").trim();
  const sourceType = els.sourceType.value;
  const notes = (els.notes.value || "").trim();

  return {
    token,
    timestamp: new Date().toISOString(),
    sourceType,
    value,
    notes,
    client: navigator.userAgent,
  };
}

// no JSON headers -> avoid preflight
async function postToAppsScript(scriptUrl, payloadObj) {
  const bodyText = JSON.stringify(payloadObj);

  const res = await fetch(scriptUrl, {
    method: "POST",
    mode: "cors",
    body: bodyText,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

async function sendToSheets() {
  const scriptUrl = els.scriptUrl.value.trim();
  const token = els.secretToken.value.trim();
  const value = (els.value.value || "").trim();

  if (!scriptUrl) return setSendMsg("ضع رابط Google Apps Script Web App أولاً.");
  if (!token) return setSendMsg("ضع SECRET_TOKEN أولاً.");
  if (!value) return setSendMsg("لا توجد قيمة لإرسالها.");

  const payload = buildPayload();
  setSendMsg("جارٍ الإرسال...");
  els.send.disabled = true;

  try {
    const { res, json } = await postToAppsScript(scriptUrl, payload);

    if (!res.ok || !json?.ok) {
      const errMsg = json?.error || `فشل الإرسال (HTTP ${res.status}).`;
      saveHistoryItem(payload, "pending", errMsg);
      setSendMsg(`فشل الإرسال، تم حفظه Pending. السبب: ${errMsg}`);
      return;
    }

    saveHistoryItem(payload, "sent");
    setSendMsg("تم الإرسال بنجاح ✅");
    renderHistory();

  } catch (err) {
    console.error(err);
    saveHistoryItem(payload, "pending", "Network/CORS error");
    setSendMsg("تعذر الإرسال (CORS/Network). تم حفظه Pending.");
  } finally {
    els.send.disabled = false;
    renderHistory();
  }
}

// ================= Utilities =================

function copyResult() {
  const v = (els.value.value || "").trim();
  if (!v) return;
  navigator.clipboard.writeText(v).then(
    () => toast("تم النسخ إلى الحافظة."),
    () => toast("تعذر النسخ.")
  );
}

function getHistory() {
  const raw = localStorage.getItem(STORAGE_KEYS.history);
  return raw ? JSON.parse(raw) : [];
}

function setHistory(arr) {
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(arr));
}

function saveHistoryItem(payload, status, error = "") {
  const h = getHistory();
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status, // sent | pending | failed
    payload,
    error,
  };
  h.unshift(item);
  setHistory(h.slice(0, 50));
  renderHistory();
  return item;
}

function renderHistory() {
  const h = getHistory();
  els.history.innerHTML = "";

  if (!h.length) {
    els.history.innerHTML = `<div class="muted">لا يوجد سجل بعد.</div>`;
    return;
  }

  for (const it of h) {
    const badgeClass = it.status === "sent" ? "sent" : it.status === "pending" ? "pending" : "failed";
    const value = it.payload?.value ?? "";
    const notes = it.payload?.notes ?? "";
    const sourceType = it.payload?.sourceType ?? "";

    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="itemHeader">
        <div class="muted small">${new Date(it.createdAt).toLocaleString()}</div>
        <div class="badge ${badgeClass}">${it.status.toUpperCase()}</div>
      </div>
      <div class="muted small">Type: ${escapeHtml(sourceType)}</div>
      ${it.error ? `<div class="muted small">Error: ${escapeHtml(it.error)}</div>` : ""}
      <pre>${escapeHtml(value)}${notes ? `\n\nNotes: ${escapeHtml(notes)}` : ""}</pre>
      <div class="itemActions">
        <button class="btn" data-act="retry" data-id="${it.id}">إعادة الإرسال</button>
        <button class="btn ghost" data-act="copy" data-id="${it.id}">نسخ</button>
        <button class="btn ghost" data-act="delete" data-id="${it.id}">حذف</button>
      </div>
    `;
    div.addEventListener("click", (e) => onHistoryAction(e, it.id));
    els.history.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function onHistoryAction(e, id) {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.getAttribute("data-act");
  const h = getHistory();
  const idx = h.findIndex(x => x.id === id);
  if (idx === -1) return;

  if (act === "delete") {
    h.splice(idx, 1);
    setHistory(h);
    renderHistory();
    return;
  }

  if (act === "copy") {
    const v = h[idx]?.payload?.value || "";
    navigator.clipboard.writeText(v).then(
      () => toast("تم النسخ."),
      () => toast("تعذر النسخ.")
    );
    return;
  }

  if (act === "retry") {
    await retryOne(h[idx]);
    return;
  }
}

async function retryOne(item) {
  const scriptUrl = els.scriptUrl.value.trim();
  if (!scriptUrl) return toast("ضع رابط السكربت أولاً.");

  setSendMsg("جارٍ إعادة الإرسال...");
  try {
    const { res, json } = await postToAppsScript(scriptUrl, item.payload);

    if (!res.ok || !json?.ok) {
      const errMsg = json?.error || `فشل (HTTP ${res.status})`;
      updateHistoryStatus(item.id, "pending", errMsg);
      setSendMsg(`فشل إعادة الإرسال: ${errMsg}`);
      renderHistory();
      return;
    }

    updateHistoryStatus(item.id, "sent", "");
    setSendMsg("تمت إعادة الإرسال بنجاح ✅");
    renderHistory();
  } catch (err) {
    console.error(err);
    updateHistoryStatus(item.id, "pending", "Network/CORS error");
    setSendMsg("تعذر الإرسال (CORS/Network). بقي Pending.");
    renderHistory();
  }
}

async function retryAllPending() {
  const h = getHistory();
  const pendings = h.filter(x => x.status === "pending");
  if (!pendings.length) return toast("لا توجد عمليات Pending.");

  for (const it of pendings) {
    await retryOne(it);
  }
}

function updateHistoryStatus(id, status, error) {
  const h = getHistory();
  const idx = h.findIndex(x => x.id === id);
  if (idx === -1) return;
  h[idx].status = status;
  h[idx].error = error || "";
  setHistory(h);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(console.error);
}
