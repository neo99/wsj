const startBtn  = document.getElementById("start-btn");
const cancelBtn = document.getElementById("cancel-btn");
const statusEl  = document.getElementById("status");
const listEl    = document.getElementById("article-list");

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: "popup" });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case "state":
        render(msg.state);
        break;
    }
  });

  port.onDisconnect.addListener(() => { port = null; });
}

function render(state) {
  // Buttons
  const running = state.phase === "fetching" || state.phase === "processing";
  startBtn.disabled = running;
  cancelBtn.style.display = running ? "block" : "none";

  // Status text
  statusEl.textContent = state.statusText || "";

  // Article list
  listEl.innerHTML = "";
  for (const a of state.articles) {
    const row = document.createElement("div");
    row.className = "article-row " + a.status;

    const icon  = document.createElement("span");
    icon.className = "icon";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = a.title;

    row.appendChild(icon);
    row.appendChild(title);
    listEl.appendChild(row);
  }

  // Summary when done
  if (state.phase === "done") {
    const div = document.createElement("div");
    div.className = "summary";
    div.textContent = `${state.queued} of ${state.articles.length} articles queued`;
    listEl.appendChild(div);
  }
}

startBtn.addEventListener("click", () => {
  if (!port) connect();
  port.postMessage({ action: "start" });
});

cancelBtn.addEventListener("click", () => {
  if (port) port.postMessage({ action: "cancel" });
});

// Connect on open to get current state
connect();
