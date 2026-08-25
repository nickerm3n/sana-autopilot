const CLAUDE_MODEL = "claude-sonnet-5";
const REQUEST_TIMEOUT_MS = 45000;
const MAX_RETRIES = 3;

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("Anthropic API ключ не встановлено. Відкрий popup і введи ключ.");
  return apiKey;
}

async function callClaude(apiKey, userContent, schema) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          messages: [{ role: "user", content: userContent }],
          output_config: { format: { type: "json_schema", schema } },
        }),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Claude API ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Claude API ${res.status}: ${text}`);
      }

      const data = await res.json();
      const block = (data.content || []).find((b) => b.type === "text" && typeof b.text === "string");
      if (!block) {
        const blockTypes = (data.content || []).map((b) => b.type).join(",") || "none";
        throw new Error(
          `Claude API не повернув текстовий контент (stop_reason=${data.stop_reason}, blocks=[${blockTypes}])`
        );
      }
      return JSON.parse(block.text);
    } catch (err) {
      lastError = err;
      if (err.name === "AbortError") lastError = new Error("Час очікування запиту до Claude API вичерпано");
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function buildQuizPrompt(question, options) {
  const optionLines = options.map((o, i) => `${i}: ${o}`).join("\n");
  return `You are answering a multiple-choice quiz question from a corporate training course. Pick the correct option(s).\n\nQuestion: ${question}\n\nOptions:\n${optionLines}`;
}

function buildMatchPrompt(statements, categories, previousAttempt) {
  const statementLines = statements.map((s, i) => `${i}: ${s}`).join("\n");
  let feedbackBlock = "";
  if (previousAttempt?.assignments && previousAttempt?.correctness) {
    const feedbackLines = statements.map((s, i) => {
      const guess = previousAttempt.assignments[i];
      const wasCorrect = previousAttempt.correctness[i];
      return `${i}: previously guessed "${guess}" — ${wasCorrect ? "this was CORRECT, keep it" : "this was WRONG, pick a different category"}`;
    });
    feedbackBlock = `\n\nThis is a retry. Your previous attempt got some pairs wrong:\n${feedbackLines.join(
      "\n"
    )}\n\nKeep the ones marked correct, and reconsider the ones marked wrong more carefully.`;
  }
  return `You are answering a "match the pairs" question from a corporate training course. For each numbered statement, pick the correct category from the given list.\n\nStatements:\n${statementLines}\n\nCategories: ${categories.join(
    ", "
  )}\n\nReturn one category per statement, in the same order as the statements.${feedbackBlock}`;
}

function buildExercisePrompt(instructions) {
  return `You are completing a written exercise in a corporate training course. Read the instructions below and write the requested recommendation.\n\nInstructions:\n${instructions}\n\nWrite the recommendation now. Requirements:\n- 250-400 words.\n- Plain prose paragraphs, no markdown formatting, no headers, no bullet lists.\n- Use only plain ASCII punctuation (straight quotes, hyphens) — no smart quotes or em dashes.\n- Address every point requested in the instructions.`;
}

function injectFileIntoPage(bytesArray, filename) {
  const input = document.querySelector('[role="group"][aria-label="Upload and submit File"] input[type="file"]');
  if (!input) return false;
  const bytes = new Uint8Array(bytesArray);
  const file = new File([bytes], filename, { type: "application/pdf" });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(input, "files", { value: dataTransfer.files, configurable: true });
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "INJECT_FILE") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) throw new Error("Немає tabId для INJECT_FILE");
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: injectFileIntoPage,
          args: [message.bytes, message.filename],
        });
        if (!result) throw new Error("Поле завантаження файлу не знайдено на сторінці");
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "SOLVE_EXERCISE") {
    (async () => {
      try {
        const apiKey = await getApiKey();
        const schema = {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
          additionalProperties: false,
        };
        const result = await callClaude(apiKey, buildExercisePrompt(message.instructions), schema);
        sendResponse({ ok: true, content: result.content });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "SOLVE_QUIZ") {
    (async () => {
      try {
        const apiKey = await getApiKey();
        const schema = message.multi
          ? {
              type: "object",
              properties: { indices: { type: "array", items: { type: "integer" } } },
              required: ["indices"],
              additionalProperties: false,
            }
          : {
              type: "object",
              properties: { index: { type: "integer" } },
              required: ["index"],
              additionalProperties: false,
            };
        const result = await callClaude(apiKey, buildQuizPrompt(message.question, message.options), schema);
        sendResponse({ ok: true, indices: message.multi ? result.indices : [result.index] });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "SOLVE_MATCH") {
    (async () => {
      try {
        const apiKey = await getApiKey();
        const schema = {
          type: "object",
          properties: {
            assignments: { type: "array", items: { type: "string", enum: message.categories } },
          },
          required: ["assignments"],
          additionalProperties: false,
        };
        const result = await callClaude(
          apiKey,
          buildMatchPrompt(message.statements, message.categories, message.previousAttempt),
          schema
        );
        sendResponse({ ok: true, assignments: result.assignments });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
