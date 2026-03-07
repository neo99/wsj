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
  state.statusText = "Opening today\u2019s print edition\u2026";
  push();

  let tabId;
  try {
    // 1. Open Business & Finance section directly
    const today = new Date();
    const dateStr = today.getFullYear().toString() +
      String(today.getMonth() + 1).padStart(2, "0") +
      String(today.getDate()).padStart(2, "0");
    const printUrl = `https://www.wsj.com/print-edition/${dateStr}/business-and-finance`;

    state.statusText = "Opening Business & Finance section\u2026";
    push();

    const tab = await chrome.tabs.create({ url: printUrl, active: false });
    tabId = tab.id;
    await waitForLoad(tabId);
    await sleep(3000); // let JS hydrate

    // 2. Parse Business & Finance articles
    state.statusText = "Scanning for Business & Finance articles\u2026";
    push();

    const [parseResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: contentScript_parsePrintEdition,
    });

    const parsed = parseResult.result;

    if (parsed.error) {
      state.phase = "error";
      state.statusText = parsed.error;
      if (parsed.sections?.length) {
        state.statusText += "\nSections found on page: " + parsed.sections.join(", ");
      }
      push();
      // DEBUG: keep tab open
      return;
    }

    const articles = deduplicateArticles(parsed.articles);

    if (articles.length === 0) {
      state.phase = "error";
      state.statusText = "No articles found in the Business & Finance section.";
      push();
      // DEBUG: keep tab open
      return;
    }

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
        await chrome.tabs.remove(tabId);
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

    await chrome.tabs.remove(tabId);
  } catch (err) {
    state.phase = "error";
    state.statusText = "Unexpected error: " + err.message;
    push();
    try { if (tabId) await chrome.tabs.remove(tabId); } catch {}
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
   * This runs inside the wsj.com/print-edition/YYYYMMDD/business-and-finance page.
   * The whole page is the Business & Finance section, so we just collect all
   * <a> links whose href matches known WSJ article URL patterns.
   * Update ARTICLE_URL_RE below if WSJ changes their URL structure.
   */

  const ARTICLE_URL_RE = /wsj\.com\/(articles|business|finance|economy|tech|politics|world|us|lifestyle|style|arts|sports|real-estate|personal-finance)\//;

  // We navigate directly to the section URL, so the whole page is
  // Business & Finance. Filter to links with mod=itp_wsj, which is the
  // tracking param WSJ adds to print-edition article links (sidebar/popular
  // links use different params and would otherwise pollute the list).
  const links = document.querySelectorAll("a[href]");
  const out = [];
  const seen = new Set();
  for (const a of links) {
    const href = a.href;
    if (!ARTICLE_URL_RE.test(href)) continue;
    if (!href.includes("mod=itp_wsj")) continue;
    const url = href.split("?")[0]; // strip tracking params for dedup
    if (seen.has(url)) continue;
    seen.add(url);
    const title = a.textContent.trim().replace(/\s+/g, " ");
    if (title.length < 5 || title.length > 400) continue;
    out.push({ title, url: href });
  }
  return { articles: out };
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
  for (const sel of QUEUE_SELECTORS) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return { success: true, method: "queue-selector", selector: sel };
      }
    } catch {}
  }

  // Step 2: Audio widget not loaded yet — click "More Options" to expose it,
  // then return false so the retry loop tries again after a delay.
  const moreOptions = document.querySelector('button[aria-label="More Options"]');
  if (moreOptions) {
    moreOptions.click();
    return { success: false, error: "Clicked More Options, retry needed" };
  }

  return { success: false, error: "Neither queue button nor More Options found" };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
}
