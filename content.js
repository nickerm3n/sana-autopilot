const MAX_STUCK_TICKS = 12;
const LOG_LIMIT = 200;

const MAX_CONSECUTIVE_RETRIES = 3;
const MAX_EXERCISE_COMPLETE_ATTEMPTS = 3;

let running = false;
let ticking = false;
let stuckCount = 0;
let timerId = null;
let observer = null;
let mutationPending = false;
let consecutiveRetries = 0;
let exerciseCompleteAttempts = 0;
let courseCompleteSince = null;
const COURSE_COMPLETE_GRACE_MS = 6000;
const matchFeedback = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExtensionContextValid() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function haltOrphanedInstance() {
  running = false;
  if (timerId) clearTimeout(timerId);
  stopObserver();
}

async function waitFor(conditionFn, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (conditionFn()) return true;
    await sleep(intervalMs);
  }
  return conditionFn();
}

async function log(message) {
  if (!isExtensionContextValid()) {
    haltOrphanedInstance();
    return;
  }
  try {
    const { logs = [] } = await chrome.storage.local.get("logs");
    logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    while (logs.length > LOG_LIMIT) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (err) {
    if (/Extension context invalidated/.test(err?.message || "")) {
      haltOrphanedInstance();
      return;
    }
    throw err;
  }
}

function sendToBackground(message) {
  if (!isExtensionContextValid()) {
    haltOrphanedInstance();
    return Promise.resolve({ ok: false, error: "Контекст розширення втрачено (Extension context invalidated)" });
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: "Немає відповіді від background-скрипта" });
    });
  });
}

function findButtonByText(text) {
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === text);
}

async function clickWhenReady(text, timeoutMs = 8000) {
  const ready = await waitFor(() => {
    const btn = findButtonByText(text);
    return Boolean(btn) && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
  }, timeoutMs, 300);
  if (!ready) return false;
  findButtonByText(text)?.click();
  return true;
}

function getQuestionText(group) {
  if (!group) return "";
  return Array.from(group.querySelectorAll("p"))
    .map((p) => p.textContent.trim())
    .filter(Boolean)
    .join(" ");
}

function findUnansweredMcq() {
  const groups = Array.from(document.querySelectorAll('[role="radiogroup"], [role="group"]'));
  for (const group of groups) {
    const options = Array.from(group.querySelectorAll('[role="radio"], [role="checkbox"]'));
    if (!options.length) continue;
    const anyDisabled = options.some((o) => o.disabled || o.getAttribute("aria-disabled") === "true");
    if (anyDisabled) continue;
    const submitBtn = findButtonByText("Submit");
    if (!submitBtn) continue;
    return { group, options, submitBtn };
  }
  return null;
}

async function handleMcq({ group, options, submitBtn }) {
  const isMulti = options[0].getAttribute("role") === "checkbox";
  const question = getQuestionText(group);
  const optionTexts = options.map((o) => o.textContent.trim());
  await log(`Квіз (MCQ): ${question.slice(0, 80)}`);
  const resp = await sendToBackground({ type: "SOLVE_QUIZ", question, options: optionTexts, multi: isMulti });
  if (!resp.ok) {
    await log(`Помилка Claude: ${resp.error}`);
    return;
  }
  for (const idx of resp.indices) {
    options[idx]?.click();
    await sleep(300);
  }
  await waitFor(() => !submitBtn.disabled, 3000);
  submitBtn.click();
  await log(`Відповідь відправлена: ${resp.indices.join(",")}`);
  await waitFor(() => document.querySelector('[role="alert"]'), 5000);
  await sleep(500);
  const clicked = await clickWhenReady("Continue", 8000);
  if (!clicked) await log("Не знайшов активну кнопку Continue після MCQ — спробую на наступному тіку");
}

function findUnansweredMatch() {
  const grid = document.querySelector('[role="grid"][aria-label="Matching pairs activity"]');
  if (!grid) return null;
  const rows = Array.from(grid.querySelectorAll('[role="row"]'));
  if (!rows.length) return null;
  const firstCell = rows[0].querySelectorAll('button[role="gridcell"]')[0];
  if (firstCell && (firstCell.disabled || firstCell.getAttribute("aria-disabled") === "true")) return null;
  const submitBtn = findButtonByText("Submit");
  if (!submitBtn) return null;
  return { grid, rows, submitBtn };
}

function pressKey(el, key, code) {
  const opts = { key, code, bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

async function moveRightCell(grid, rowIndex, steps) {
  const cell = grid.querySelector(`[data-grid-cell="${rowIndex}-1"]`);
  if (!cell) return;
  cell.focus();
  pressKey(cell, " ", "Space");
  await sleep(250);
  const direction = steps < 0 ? "ArrowDown" : "ArrowUp";
  for (let s = 0; s < Math.abs(steps); s++) {
    pressKey(cell, direction, direction);
    await sleep(250);
  }
  pressKey(cell, " ", "Space");
  await sleep(400);
}

async function handleMatch({ grid, rows, submitBtn }) {
  const group = grid.closest('[role="group"]') || grid.parentElement;
  const question = getQuestionText(group);
  const rowData = rows.map((row) => {
    const cells = row.querySelectorAll('button[role="gridcell"]');
    return {
      statement: (cells[0].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      category: (cells[1].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
    };
  });
  const statements = rowData.map((r) => r.statement);
  const categories = [...new Set(rowData.map((r) => r.category))];
  const feedbackKey = JSON.stringify(statements);
  const previousAttempt = matchFeedback.get(feedbackKey) || null;
  await log(`Квіз (Match): ${question.slice(0, 80)}${previousAttempt ? " (повтор з фідбеком)" : ""}`);
  const resp = await sendToBackground({ type: "SOLVE_MATCH", statements, categories, previousAttempt });
  if (!resp.ok) {
    await log(`Помилка Claude: ${resp.error}`);
    return;
  }
  const desired = resp.assignments;
  const current = rowData.map((r) => r.category);

  for (let i = 0; i < desired.length; i++) {
    if (current[i] === desired[i]) continue;
    let j = -1;
    for (let k = i + 1; k < current.length; k++) {
      if (current[k] === desired[i]) {
        j = k;
        break;
      }
    }
    if (j === -1) continue;
    await moveRightCell(grid, j, j - i);
    [current[i], current[j]] = [current[j], current[i]];
  }

  submitBtn.click();
  await log("Match відправлено");
  await waitFor(() => document.querySelector('[role="alert"]'), 5000);
  await waitFor(() => findButtonByText("Continue") || findButtonByText("Retry"), 5000, 300);

  if (findButtonByText("Retry")) {
    const correctness = rows.map((row) => /correct/i.test(row.textContent));
    matchFeedback.set(feedbackKey, { assignments: desired, correctness });
    const wrongCount = correctness.filter((c) => !c).length;
    await log(`Невірно ${wrongCount} з ${correctness.length} пар — фідбек збережено для повтору`);
    return;
  }

  matchFeedback.delete(feedbackKey);
  const clicked = await clickWhenReady("Continue", 8000);
  if (!clicked) await log("Не знайшов активну кнопку Continue після Match — спробую на наступному тіку");
}

function findUnclickedTakeaway() {
  const groups = document.querySelectorAll(
    '[role="group"][aria-label="Takeaways. Interact with each one to continue"]'
  );
  for (const group of groups) {
    const buttons = group.querySelectorAll("button");
    for (const btn of buttons) {
      if (!btn.disabled) return btn;
    }
  }
  return null;
}

function findClickableByText(text) {
  const matches = Array.from(document.querySelectorAll("span, div")).filter(
    (el) => el.children.length === 0 && el.textContent.trim() === text
  );
  return matches[matches.length - 1]?.parentElement || null;
}

function findExerciseCard() {
  const group = document.querySelector('[role="group"][aria-label="Upload and submit File"]');
  if (!group) return null;
  const input = group.querySelector('input[type="file"]');
  if (!input) return null;
  const hasFile = Boolean(input.files && input.files.length > 0);
  const submitBtn = Array.from(group.querySelectorAll("button")).find((b) => b.textContent.trim() === "Submit");
  return { group, input, hasFile, submitBtn };
}

function findMain() {
  return document.querySelector("main") || document.querySelector('[role="main"]');
}

function getExerciseInstructions(group) {
  const container = group.closest('main, [role="main"]') || findMain();
  if (!container) return "";
  return Array.from(container.querySelectorAll("h1, h2, h3, p, li"))
    .filter((n) => !group.contains(n))
    .map((n) => n.textContent.trim())
    .filter(Boolean)
    .join("\n");
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function sanitizeForPdf(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\n]/g, "");
}

function escapePdfText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdfString(text) {
  const lines = wrapText(sanitizeForPdf(text), 95);
  const streamParts = ["BT", "/F1 11 Tf", "72 720 Td", "14 TL"];
  lines.forEach((line, i) => {
    if (i > 0) streamParts.push("T*");
    streamParts.push(`(${escapePdfText(line)}) Tj`);
  });
  streamParts.push("ET");
  const streamContent = streamParts.join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return body + xref + trailer;
}

function buildPdfBytes(text) {
  const pdfString = buildPdfString(text);
  const bytes = new Uint8Array(pdfString.length);
  for (let i = 0; i < pdfString.length; i++) bytes[i] = pdfString.charCodeAt(i) & 0xff;
  return bytes;
}

async function handleExercise({ group }) {
  const instructions = getExerciseInstructions(group);
  await log("Exercise: генерую рекомендацію...");
  const resp = await sendToBackground({ type: "SOLVE_EXERCISE", instructions });
  if (!resp.ok) {
    await log(`Помилка Claude: ${resp.error}`);
    return;
  }
  const bytes = buildPdfBytes(resp.content);
  const injectResp = await sendToBackground({
    type: "INJECT_FILE",
    bytes: Array.from(bytes),
    filename: "submission.pdf",
  });
  if (!injectResp.ok) {
    await log(`Помилка завантаження файлу: ${injectResp.error}`);
    return;
  }
  await log(`Exercise: файл згенеровано та завантажено (${bytes.length} B)`);
  await waitFor(() => {
    const g = document.querySelector('[role="group"][aria-label="Upload and submit File"]');
    return Boolean(g && Array.from(g.querySelectorAll("button")).some((b) => b.textContent.trim() === "Submit"));
  }, 8000, 300);
}

function findScrollableAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement;
}

async function scrollToUnlock(forwardBtn) {
  const scrollable = findScrollableAncestor(findMain()) || document.scrollingElement;
  const before = scrollable.scrollTop;
  scrollable.scrollBy({ top: Math.round(scrollable.clientHeight * 0.8), behavior: "smooth" });
  await sleep(600);
  if (!forwardBtn.disabled) {
    forwardBtn.click();
    await log("Проскролив і натиснув forward-button");
    return true;
  }
  if (scrollable.scrollTop > before) {
    return true;
  }
  return false;
}

let lastDiagnostic = "";

function snapshotDiagnostic() {
  const optionCount = document.querySelectorAll('[role="radio"], [role="checkbox"]').length;
  const mcqGroupCount = Array.from(document.querySelectorAll('[role="radiogroup"], [role="group"]')).filter(
    (g) => g.querySelector('[role="radio"], [role="checkbox"]')
  ).length;
  const disabledOptionCount = Array.from(document.querySelectorAll('[role="radio"], [role="checkbox"]')).filter(
    (o) => o.disabled || o.getAttribute("aria-disabled") === "true"
  ).length;
  const matchGrid = document.querySelector('[role="grid"][aria-label="Matching pairs activity"]');
  const forwardBtn = document.querySelector('[data-testid="forward-button"]');
  const submitBtn = findButtonByText("Submit");
  const continueBtn = findButtonByText("Continue");
  const retryBtn = findButtonByText("Retry");
  const scrollDownBtn = findButtonByText("Scroll down");
  const alertEl = document.querySelector('[role="alert"]');
  const exerciseGroup = document.querySelector('[role="group"][aria-label="Upload and submit File"]');
  const takeawayBtn = findUnclickedTakeaway();
  const nextCourseBtn = findNextCourseStartBtn();
  const submitAssessmentBtn = findButtonByText("Submit assessment");
  const selected = document.querySelector('[role="treeitem"][aria-selected="true"]');
  return [
    `url=${location.pathname}`,
    `card="${(selected?.textContent || "?").trim().slice(0, 40)}"`,
    `mcqGroups=${mcqGroupCount} options=${optionCount} disabledOpts=${disabledOptionCount}`,
    `matchGrid=${Boolean(matchGrid)}`,
    `forwardBtn=${forwardBtn ? (forwardBtn.disabled ? "disabled" : "enabled") : "absent"}`,
    `submitBtn=${Boolean(submitBtn)} continueBtn=${Boolean(continueBtn)} retryBtn=${Boolean(retryBtn)} scrollDownBtn=${Boolean(scrollDownBtn)} exercise=${Boolean(exerciseGroup)} takeaway=${Boolean(takeawayBtn)} nextCourse=${Boolean(nextCourseBtn)} submitAssessment=${Boolean(submitAssessmentBtn)} alert=${Boolean(alertEl)}`,
  ].join(" ");
}

async function logDiagnosticIfChanged() {
  const snap = snapshotDiagnostic();
  if (snap === lastDiagnostic) return;
  lastDiagnostic = snap;
  await log(`Diag: ${snap}`);
}

function findNextCourseStartBtn() {
  const main = findMain();
  if (!main) return null;
  const headings = Array.from(main.querySelectorAll("div, span, h1, h2, h3, h4")).filter(
    (el) => el.children.length === 0 && el.textContent.trim() === "Course completed"
  );
  for (const heading of headings) {
    let container = heading.parentElement;
    for (let i = 0; i < 8 && container; i++) {
      const startBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent.replace(/\s+/g, " ").trim() === "Start"
      );
      if (startBtn) return startBtn;
      container = container.parentElement;
    }
  }
  return null;
}

function isCourseComplete() {
  const selected = document.querySelector('[role="treeitem"][aria-selected="true"]');
  return Boolean(
    selected && /Congratulations/i.test(selected.textContent) && !document.querySelector('[data-testid="forward-button"]')
  );
}

async function stopWithMessage(message) {
  await log(message);
  await chrome.storage.local.set({ running: false });
}

async function runStep() {
  const mcq = findUnansweredMcq();
  if (mcq) {
    consecutiveRetries = 0;
    await handleMcq(mcq);
    return true;
  }

  const match = findUnansweredMatch();
  if (match) {
    consecutiveRetries = 0;
    await handleMatch(match);
    return true;
  }

  const retryBtn = findButtonByText("Retry");
  if (retryBtn && !retryBtn.disabled) {
    consecutiveRetries += 1;
    if (consecutiveRetries > MAX_CONSECUTIVE_RETRIES) {
      await stopWithMessage(
        `Квіз пройдено з помилками ${consecutiveRetries - 1} раз(и) підряд — зупинено, потрібна перевірка вручну.`
      );
      return true;
    }
    retryBtn.click();
    await log(`Деякі пари/відповіді невірні — клік Retry (спроба ${consecutiveRetries})`);
    return true;
  }

  const exercise = findExerciseCard();
  if (exercise) {
    if (!exercise.hasFile && !exercise.submitBtn) {
      consecutiveRetries = 0;
      exerciseCompleteAttempts = 0;
      await handleExercise(exercise);
      return true;
    }
    if (exercise.submitBtn) {
      if (!exercise.submitBtn.disabled) {
        consecutiveRetries = 0;
        exerciseCompleteAttempts = 0;
        exercise.submitBtn.click();
        await log("Клік Submit (Exercise, відправка файлу)");
        return true;
      }
      await logDiagnosticIfChanged();
      return false;
    }
    const completeBtn = findClickableByText("Complete exercise");
    if (completeBtn) {
      exerciseCompleteAttempts += 1;
      if (exerciseCompleteAttempts > MAX_EXERCISE_COMPLETE_ATTEMPTS) {
        await stopWithMessage(
          "Complete exercise не завершує картку після кількох спроб — зупинено, потрібна перевірка вручну."
        );
        return true;
      }
      consecutiveRetries = 0;
      completeBtn.click();
      await log(`Клік Complete exercise (спроба ${exerciseCompleteAttempts})`);
      return true;
    }
  }

  const takeawayBtn = findUnclickedTakeaway();
  if (takeawayBtn) {
    consecutiveRetries = 0;
    const label = takeawayBtn.textContent.trim().slice(0, 40);
    takeawayBtn.click();
    await log(`Клік Takeaway: ${label}`);
    return true;
  }

  const scrollDownBtn = findButtonByText("Scroll down");
  if (scrollDownBtn && !scrollDownBtn.disabled) {
    consecutiveRetries = 0;
    scrollDownBtn.click();
    await log("Клік Scroll down");
    return true;
  }

  const forwardBtn = document.querySelector('[data-testid="forward-button"]');
  if (forwardBtn && !forwardBtn.disabled) {
    consecutiveRetries = 0;
    forwardBtn.click();
    await log("Клік forward-button");
    return true;
  }

  if (!forwardBtn) {
    const continueBtn = findButtonByText("Continue");
    if (continueBtn && !continueBtn.disabled) {
      consecutiveRetries = 0;
      continueBtn.click();
      await log("Клік Continue (картка без forward-button)");
      return true;
    }
  }

  if (forwardBtn && forwardBtn.disabled) {
    return await scrollToUnlock(forwardBtn);
  }

  const submitAssessmentBtn = findButtonByText("Submit assessment");
  if (submitAssessmentBtn && !submitAssessmentBtn.disabled) {
    consecutiveRetries = 0;
    submitAssessmentBtn.click();
    await log("Клік Submit assessment");
    return true;
  }

  const nextCourseBtn = findNextCourseStartBtn();
  if (nextCourseBtn) {
    consecutiveRetries = 0;
    nextCourseBtn.click();
    await log("Курс завершено — клік Start (наступний курс)");
    return true;
  }

  if (isCourseComplete()) {
    if (courseCompleteSince === null) courseCompleteSince = Date.now();
    if (Date.now() - courseCompleteSince < COURSE_COMPLETE_GRACE_MS) {
      await logDiagnosticIfChanged();
      return false;
    }
    await stopWithMessage("Курс/урок завершено — зупинено.");
    return true;
  }
  courseCompleteSince = null;

  await logDiagnosticIfChanged();
  return false;
}

function scheduleTick(delay) {
  if (timerId) clearTimeout(timerId);
  timerId = setTimeout(tick, delay);
}

async function tick() {
  if (!running || ticking) return;
  if (!isExtensionContextValid()) {
    haltOrphanedInstance();
    return;
  }
  ticking = true;
  try {
    const acted = await runStep();
    if (!acted) {
      stuckCount += 1;
      if (stuckCount >= MAX_STUCK_TICKS) {
        await stopWithMessage("Не вдалося знайти наступну дію — зупинено.");
      }
    } else {
      stuckCount = 0;
    }
  } catch (err) {
    await log(`Помилка: ${err.message}`);
  } finally {
    ticking = false;
    if (running) scheduleTick(1200 + Math.random() * 1300);
  }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(() => {
    if (mutationPending) return;
    mutationPending = true;
    setTimeout(() => {
      mutationPending = false;
      if (running) scheduleTick(150);
    }, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

function setRunning(value) {
  running = value;
  log(running ? "Autopilot запущено" : "Autopilot зупинено");
  if (running) {
    stuckCount = 0;
    startObserver();
    scheduleTick(200);
  } else {
    stopObserver();
    if (timerId) clearTimeout(timerId);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if ("running" in changes) {
    setRunning(Boolean(changes.running.newValue));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, running, url: location.href });
    return true;
  }
});

window.addEventListener("error", (e) => {
  log(`Необроблена помилка на сторінці: ${e.message}`);
});

log(`content.js завантажено на ${location.href}`);

chrome.storage.local.get("running").then(({ running: initial }) => {
  if (initial) setRunning(true);
});
