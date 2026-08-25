const apiKeyInput = document.getElementById("apiKey");
const statusEl = document.getElementById("status");
const warningEl = document.getElementById("warning");
const toggleBtn = document.getElementById("toggleBtn");
const scanBtn = document.getElementById("scanBtn");
const coursesEl = document.getElementById("courses");
const logEl = document.getElementById("log");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pingContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

async function checkContentScript() {
  const tab = await getActiveTab();
  if (!tab?.url?.includes("openai-partneru.sana.ai")) {
    warningEl.className = "visible";
    warningEl.textContent = "Відкрий сторінку курсу на openai-partneru.sana.ai — розширення працює лише там.";
    return;
  }
  const response = await pingContentScript(tab.id);
  if (!response) {
    warningEl.className = "visible";
    warningEl.textContent =
      "Content script не відповідає на цій вкладці. Якщо вкладку було відкрито до встановлення розширення — перезавантаж сторінку (F5).";
    return;
  }
  warningEl.className = "";
  warningEl.textContent = "";
}

function renderStatus(running) {
  statusEl.textContent = running ? "Запущено" : "Зупинено";
  statusEl.className = running ? "running" : "stopped";
  toggleBtn.textContent = running ? "Зупинити" : "Запустити на цій сторінці";
}

async function renderLog() {
  const { logs = [] } = await chrome.storage.local.get("logs");
  logEl.textContent = logs.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

async function init() {
  const { apiKey = "", running = false } = await chrome.storage.local.get(["apiKey", "running"]);
  apiKeyInput.value = apiKey;
  renderStatus(running);
  await renderLog();
  await checkContentScript();
}

apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
});

toggleBtn.addEventListener("click", async () => {
  const { running = false } = await chrome.storage.local.get("running");
  await chrome.storage.local.set({ running: !running });
  renderStatus(!running);
  await checkContentScript();
});

function scanLibraryInPage() {
  const items = Array.from(document.querySelectorAll("article, li"));
  const courses = [];
  for (const item of items) {
    const link = item.querySelector("a[href]");
    if (!link) continue;
    const hasContinue = Array.from(item.querySelectorAll("button")).some((b) => /continue/i.test(b.textContent));
    if (!hasContinue) continue;
    const titleEl = item.querySelector("h1,h2,h3,h4,h5,h6") || link;
    const title = titleEl.textContent.trim();
    if (!title) continue;
    const progressEl = item.querySelector('[role="progressbar"]');
    const progress = progressEl ? progressEl.getAttribute("aria-valuenow") || progressEl.textContent.trim() : null;
    courses.push({ title, url: link.href, progress });
  }
  const seen = new Set();
  return courses.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

function renderCourses(courses, tabId) {
  coursesEl.innerHTML = "";
  if (!courses.length) {
    coursesEl.textContent = "Курсів у процесі не знайдено.";
    return;
  }
  for (const course of courses) {
    const btn = document.createElement("button");
    btn.textContent = course.progress ? `${course.title} (${course.progress}%)` : course.title;
    btn.addEventListener("click", async () => {
      await chrome.tabs.update(tabId, { url: course.url });
      await chrome.storage.local.set({ running: true });
      renderStatus(true);
    });
    coursesEl.appendChild(btn);
  }
}

scanBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.url?.includes("openai-partneru.sana.ai/learn")) {
    coursesEl.textContent = "Спочатку відкрий https://openai-partneru.sana.ai/learn.";
    return;
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scanLibraryInPage,
  });
  renderCourses(result, tab.id);
});

chrome.storage.onChanged.addListener((changes) => {
  if ("logs" in changes) renderLog();
  if ("running" in changes) renderStatus(Boolean(changes.running.newValue));
});

init();
