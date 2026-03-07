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
- Opens a hidden tab directly to `wsj.com/print-edition/YYYYMMDD/business-and-finance` (date is constructed at runtime)
- Injects `contentScript_parsePrintEdition()` to collect all article links using the `a[data-testid="flexcard-headline"]` selector — no section-heading search needed since the whole page is the B&F section
- Navigates the same tab to each article URL and injects `contentScript_clickAudio()` which: (1) clicks the "More Options" button (`aria-label="More Options"`) to expose the audio widget, then (2) clicks `button.audio-queue-button` on the next retry
- Maintains a `state` object (`phase`, `statusText`, `articles[]`, `queued`) and pushes it to the popup on every change

**`popup.js` / `popup.html` / `popup.css`** — thin UI layer:
- Connects to the background service worker on open
- Sends `{ action: "start" }` or `{ action: "cancel" }` messages
- Re-renders the article list and status text on every incoming state update

## Key Maintenance Points

**If WSJ changes their DOM**, update the selectors at the top of the two injected content script functions inside `background.js`:
- `contentScript_parsePrintEdition`: the `a[data-testid="flexcard-headline"]` selector used to find article headline links
- `contentScript_clickAudio`: the `button[aria-label="More Options"]` selector for the toolbar button, and `button.audio-queue-button` / `QUEUE_SELECTORS` for the queue button

The content script functions are defined as named functions in `background.js` and passed by reference to `chrome.scripting.executeScript`. They run in the page context, so they cannot close over any variables from the service worker scope.
