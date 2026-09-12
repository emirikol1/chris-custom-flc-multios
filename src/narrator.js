(function () {
  "use strict";

  const mudLog = document.getElementById("mud-log");
  const discussLog = document.getElementById("discuss-log");
  const form = document.getElementById("discuss-form");
  const input = document.getElementById("discuss-input");
  const statusText = document.getElementById("status-text");
  const postToggle = document.getElementById("post-to-foundry");
  const speakAs = document.getElementById("speak-as");
  const aliasInput = document.getElementById("alias-input");
  const setupBtn = document.getElementById("setup-btn");
  const splitter = document.getElementById("splitter");
  const mudPane = document.querySelector(".mud-pane");

  function appendLine(container, html, ansi, extraClass) {
    const p = document.createElement("p");
    p.className = container === mudLog ? "mud-line" : "discuss-line";
    if (extraClass) {
      p.classList.add(extraClass);
    }
    if (ansi) {
      p.dataset.ansi = ansi;
    }
    p.innerHTML = html;
    container.appendChild(p);
    container.scrollTop = container.scrollHeight;
  }

  mudLog.addEventListener("copy", (event) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    const lines = [...mudLog.querySelectorAll(".mud-line")].filter((el) =>
      selection.containsNode(el, true),
    );
    const ansi = lines
      .map((el) => el.dataset.ansi || el.textContent)
      .join("\n");
    if (!ansi) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", ansi);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !window.flcNarrator) {
      return;
    }
    appendLine(
      discussLog,
      `<span class="mud mud-W">&gt; ${escapeHtml(text)}</span>`,
    );
    input.value = "";
    const result = await window.flcNarrator.ask(text);
    if (!result || !result.ok) {
      appendLine(
        discussLog,
        `<span class="mud mud-R">${escapeHtml((result && result.message) || "ask failed")}</span>`,
      );
      return;
    }
    appendLine(
      discussLog,
      result.html || escapeHtml(result.text || ""),
      result.ansi,
    );
  });

  postToggle.addEventListener("change", () => {
    if (window.flcNarrator) {
      window.flcNarrator.setPostToFoundry(postToggle.checked);
    }
  });

  function persistVoice() {
    if (!window.flcNarrator) {
      return;
    }
    window.flcNarrator.setSettings({
      speakAs: speakAs.value,
      alias: aliasInput.value,
      localByline: aliasInput.value,
    });
  }
  speakAs.addEventListener("change", persistVoice);
  aliasInput.addEventListener("change", persistVoice);

  if (setupBtn) {
    setupBtn.addEventListener("click", () => {
      if (window.flcNarrator && typeof window.flcNarrator.openSetup === "function") {
        window.flcNarrator.openSetup();
      }
    });
  }

  let drag = null;
  splitter.addEventListener("mousedown", (event) => {
    drag = { startY: event.clientY, startH: mudPane.getBoundingClientRect().height };
    event.preventDefault();
  });
  window.addEventListener("mousemove", (event) => {
    if (!drag) {
      return;
    }
    const next = drag.startH + (event.clientY - drag.startY);
    mudPane.style.flex = `0 0 ${Math.max(80, next)}px`;
  });
  window.addEventListener("mouseup", () => {
    drag = null;
  });

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  if (window.flcNarrator) {
    window.flcNarrator.onLine((line) => {
      const html = line.html || "";
      const ansi = line.ansi || "";
      if (line.channel === "discussion") {
        appendLine(discussLog, html, ansi);
      } else {
        const byline = line.byline ? `<span class="mud mud-C">${escapeHtml(line.byline)}</span> ` : "";
        appendLine(mudLog, byline + html, ansi);
      }
    });
    window.flcNarrator.onStatus((status) => {
      statusText.textContent = status && status.text ? status.text : String(status || "");
    });
    window.flcNarrator.getSettings().then((settings) => {
      postToggle.checked = Boolean(settings && settings.postToFoundry);
      if (settings && settings.speakAs) {
        speakAs.value = settings.speakAs;
      }
      if (settings && (settings.alias || settings.localByline)) {
        aliasInput.value = settings.alias || settings.localByline;
      }
    });
  }
})();
