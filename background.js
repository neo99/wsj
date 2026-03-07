/*
 * WSJ Audio Queue – Background Service Worker
 *
 * Flow:
 *   1. Open a hidden tab to wsj.com/print-edition/today
 *   2. Inject a content script that parses the Business & Finance section
 *   3. For each article found, navigate the same tab to the article URL
 *   4. Inject a content script that finds and clicks the "Listen" / audio button
 *   5. Report progress back to the popup via a port
 *
 * The selectors used by the injected content scripts are best-effort guesses.
 * If WSJ changes their DOM, the SELECTORS constants at the top of each
 * injected function are the only things you need to update.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = emptyState();
let popupPort = null;
let cancelled = false;

function emptyState() {
  return {
    phase: "idle",       // idle | fetching | processing | done | error
    statusText: "",
    articles: [],        // { title, url, status: pending|working|success|error|skipped }
    queued: 0,
  };
}

// ---------------------------------------------------------------------------
// Popup communication
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;
  push();

  port.onMessage.addListener((msg) => {
    if (msg.action === "start")  startQueue();
    if (msg.action === "cancel") cancelled = true;
  });

  port.onDisconnect.addListener(() => { popupPort = null; });
});

function push() {
  try { popupPort?.postMessage({ type: "state", state }); } catch {}
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------
async function startQueue() {
  cancelled = false;
  state = emptyState();
  state.phase = "fetching";
  state.statusText = "Opening article\u2026";
  push();

  // DEBUG: single article mode
  const DEBUG_ARTICLE = {
    title: "Ford Issues Recall Over Rearview Camera Errors",
    url: "https://www.wsj.com/business/autos/ford-issues-recall-over-rearview-camera-errors-18454972",
  };

  let tabId;
  try {
    const articles = [DEBUG_ARTICLE];

    // Open tab to the article directly
    const tab = await chrome.tabs.create({ url: articles[0].url, active: true });
    tabId = tab.id;
    await waitForLoad(tabId);
    await sleep(3000); // let JS hydrate

    // Populate state with articles
    state.articles = articles.map((a) => ({
      title: truncate(a.title, 80),
      url: a.url,
      status: "pending",
    }));
    state.statusText = `Found ${articles.length} articles. Queuing\u2026`;
    state.phase = "processing";
    push();

    // 3. Process each article
    let queued = 0;
    for (let i = 0; i < articles.length; i++) {
      if (cancelled) {
        for (let j = i; j < articles.length; j++) state.articles[j].status = "skipped";
        state.statusText = "Cancelled.";
        state.phase = "done";
        state.queued = queued;
        push();
        // DEBUG: await chrome.tabs.remove(tabId);
        return;
      }

      state.articles[i].status = "working";
      state.statusText = `Queuing article ${i + 1} of ${articles.length}\u2026`;
      push();

      try {
        await chrome.tabs.update(tabId, { url: articles[i].url });
        await waitForLoad(tabId);
        await sleep(2500); // let article page hydrate

        const ok = await tryClickAudio(tabId, 8);

        if (ok) {
          state.articles[i].status = "success";
          queued++;
        } else {
          state.articles[i].status = "error";
        }
      } catch (err) {
        state.articles[i].status = "error";
      }

      state.queued = queued;
      push();

      // Small pause between articles to be polite to WSJ servers
      if (i < articles.length - 1) await sleep(800);
    }

    // 4. Done
    state.phase = "done";
    state.queued = queued;
    state.statusText = `Done — ${queued} of ${articles.length} articles queued.`;
    push();

    // DEBUG: await chrome.tabs.remove(tabId);
  } catch (err) {
    state.phase = "error";
    state.statusText = "Unexpected error: " + err.message;
    push();
    // DEBUG: try { if (tabId) await chrome.tabs.remove(tabId); } catch {}
  }
}

// Retry clicking the audio button several times (element may load late)
async function tryClickAudio(tabId, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: contentScript_clickAudio,
    });
    if (result.result?.success) return true;
    await sleep(2000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway after timeout
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function truncate(s, n) { return s.length > n ? s.slice(0, n) + "\u2026" : s; }

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Content script: Parse print edition page
// ---------------------------------------------------------------------------
function contentScript_parsePrintEdition() {
  /*
   * This runs inside the wsj.com/print-edition/today page.
   *
   * Strategy:
   *   A) Look for embedded JSON state that might contain section/article data.
   *   B) DOM: find a heading whose text matches "Business & Finance" (case-
   *      insensitive), then walk up to the nearest section-like container and
   *      collect all <a> links that look like article URLs.
   *   C) Fallback: find the heading, then collect all sibling-level links
   *      until we hit the next section heading.
   */

  const ARTICLE_URL_RE = /wsj\.com\/(articles|business|finance|economy|tech|politics|world|us|lifestyle|style|arts|sports|real-estate|personal-finance)\//;
  const SECTION_RE     = /business\s*[&+]\s*finance|business\s+and\s+finance/i;

  // ---- Strategy A: embedded JSON ----
  try {
    const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
    for (const s of scripts) {
      const txt = s.textContent;
      if (!txt || txt.length < 200 || !SECTION_RE.test(txt)) continue;
      try {
        const json = JSON.parse(txt);
        const found = findArticlesInJson(json);
        if (found.length > 0) return { articles: found };
      } catch {}
    }
  } catch {}

  // ---- Strategy B: DOM heading + container ----
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")];
  let header = headings.find((h) => SECTION_RE.test(h.textContent));

  // Broaden: any element whose direct text matches
  if (!header) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const direct = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("");
      if (SECTION_RE.test(direct)) { header = el; break; }
    }
  }

  if (!header) {
    return {
      error: "Could not find the Business & Finance section on the print edition page.",
      sections: headings.map((h) => h.textContent.trim()).filter((t) => t.length > 2 && t.length < 120),
    };
  }

  // Walk up to find a meaningful container
  let container = header.closest("section, [data-module-zone], [class*='section'], [class*='Section']");
  if (!container) container = header.parentElement;

  // If the container has very few links, try one level higher
  for (let i = 0; i < 3; i++) {
    if (container.querySelectorAll("a[href]").length >= 2) break;
    if (container.parentElement && container.parentElement !== document.body) {
      container = container.parentElement;
    }
  }

  const articles = extractLinksFromContainer(container);

  // ---- Strategy C: between-headings fallback ----
  if (articles.length === 0) {
    const headerTag = header.tagName;
    const allSameLevel = [...document.querySelectorAll(headerTag)];
    const idx = allSameLevel.indexOf(header);
    const nextHeader = idx >= 0 && idx + 1 < allSameLevel.length ? allSameLevel[idx + 1] : null;

    const range = document.createRange();
    range.setStartAfter(header);
    if (nextHeader) range.setEndBefore(nextHeader);
    else range.selectNodeContents(document.body), range.setStartAfter(header);

    const frag = range.cloneContents();
    const tempDiv = document.createElement("div");
    tempDiv.appendChild(frag);
    articles.push(...extractLinksFromContainer(tempDiv));
  }

  return { articles };

  // ---- helpers ----
  function extractLinksFromContainer(el) {
    const links = el.querySelectorAll("a[href]");
    const out = [];
    const seen = new Set();
    for (const a of links) {
      const href = a.href;
      if (!ARTICLE_URL_RE.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const title = a.textContent.trim().replace(/\s+/g, " ");
      if (title.length < 5 || title.length > 400) continue;
      out.push({ title, url: href });
    }
    return out;
  }

  function findArticlesInJson(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 12 || !obj) return [];
    if (Array.isArray(obj)) return obj.flatMap((v) => findArticlesInJson(v, depth + 1));
    if (typeof obj !== "object") return [];

    // Look for a section matching Business & Finance with child articles
    const name = obj.name || obj.label || obj.sectionName || obj.headline || "";
    if (SECTION_RE.test(name) && (obj.articles || obj.items || obj.children)) {
      const list = obj.articles || obj.items || obj.children;
      if (Array.isArray(list)) {
        return list
          .filter((a) => a.url || a.href || a.link)
          .map((a) => ({
            title: a.headline || a.title || a.name || "Untitled",
            url: a.url || a.href || a.link,
          }));
      }
    }

    return Object.values(obj).flatMap((v) => findArticlesInJson(v, depth + 1));
  }
}

// ---------------------------------------------------------------------------
// Content script: Click the audio / listen button on an article page
// ---------------------------------------------------------------------------
function contentScript_clickAudio() {
  /*
   * This runs inside a wsj.com article page.
   *
   * WSJ's current flow: click the 3-dot "more options" button in the article
   * toolbar, which opens a dropdown containing "Add to my Queue".
   *
   * Strategy:
   *   0) Try to click "Add to my Queue" directly (menu may already be open
   *      from a prior attempt).
   *   1) Try direct CSS selectors for a visible audio/listen button.
   *   2) Text-content scan on buttons.
   *   3) SVG icon scan for headphones/listen labels.
   *   4) If nothing worked yet, find and click the 3-dot / more-options button
   *      to open the dropdown — the caller will retry and hit strategy 0.
   *
   * Update QUEUE_SELECTORS / THREE_DOT_SELECTORS / AUDIO_SELECTORS below
   * if WSJ changes their markup.
   */

  // CSS selectors for the "Add to my Queue" button (confirmed WSJ markup)
  const QUEUE_SELECTORS = [
    'button.audio-queue-button',
    'button[aria-label="Add to my Queue"]',
    'button[aria-label*="Add to my Queue" i]',
    '[data-testid*="add-to-queue" i]',
    '[class*="AddToQueue"]',
    '[class*="add-to-queue"]',
  ];

  // Step 1: If the audio queue button is already in the DOM, click it.
  console.log('[WSJ] contentScript_clickAudio attempt, button.audio-queue-button found:', !!document.querySelector('button.audio-queue-button'));
  for (const sel of QUEUE_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        console.log('[WSJ] clicked queue button:', sel);
        return { success: true, method: "queue-selector", selector: sel };
      }
    } catch {}
  }

  // Step 2: Audio widget not loaded yet — click "More Options" to trigger it,
  // then return false so the retry loop tries again after a delay.
  const moreOptions = document.querySelector('button[aria-label="More Options"]');
  if (moreOptions) {
    moreOptions.click();
    console.log('[WSJ] clicked More Options, waiting for audio widget...');
    return { success: false, error: "Clicked More Options, retry needed" };
  }

  console.log('[WSJ] More Options button not found either');
  return { success: false, error: "Neither queue button nor More Options found" };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
}
