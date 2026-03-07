# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension (Manifest V3) that automates adding WSJ Business & Finance articles from today's print edition to the WSJ audio queue.

## Loading the Extension for Testing

Load unpacked in Chrome:
1. Navigate to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

After any code change, click the reload icon on the extension card at `chrome://extensions`.

## Architecture

The extension has two runtime contexts that communicate via a long-lived port named `"popup"`:

**`background.js` (service worker)** — all orchestration logic lives here:
- Opens a hidden tab to `wsj.com/print-edition/today`
- Injects `contentScript_parsePrintEdition()` to find Business & Finance article links using three strategies: embedded JSON, DOM heading + container traversal, and between-headings range fallback
- Navigates the same tab to each article URL and injects `contentScript_clickAudio()` to find and click the Listen button
- Maintains a `state` object (`phase`, `statusText`, `articles[]`, `queued`) and pushes it to the popup on every change

**`popup.js` / `popup.html` / `popup.css`** — thin UI layer:
- Connects to the background service worker on open
- Sends `{ action: "start" }` or `{ action: "cancel" }` messages
- Re-renders the article list and status text on every incoming state update

## Key Maintenance Points

**If WSJ changes their DOM**, update the selectors at the top of the two injected content script functions inside `background.js`:
- `contentScript_parsePrintEdition`: `ARTICLE_URL_RE` and `SECTION_RE` constants, and the selector strings in the DOM-walking strategies
- `contentScript_clickAudio`: the `SELECTORS` array (priority-ordered CSS selectors for the Listen button)

The content script functions are defined as named functions in `background.js` and passed by reference to `chrome.scripting.executeScript`. They run in the page context, so they cannot close over any variables from the service worker scope.
