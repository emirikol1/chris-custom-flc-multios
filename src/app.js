(function () {
  "use strict";

  /** @type {Array<{id:string,label:string,url:string,notes?:string,order?:number,username?:string,password?:string}>} */
  let servers = [];

  let formMode = "add";

  const $ = (sel) => document.querySelector(sel);

  const els = {
    serverList: $("#server-list"),
    serverListEmpty: $("#server-list-empty"),
    serverForm: $("#server-form"),
    serverFormHeading: $("#server-form-heading"),
    serverFormSubmit: $("#server-form-submit"),
    formCancelBtn: $("#form-cancel-btn"),
    formError: $("#form-error"),
    editId: $("#server-edit-id"),
    label: $("#server-label"),
    url: $("#server-url"),
    notes: $("#server-notes"),
    username: $("#server-username"),
    password: $("#server-password"),
    passwordToggle: $("#password-toggle-btn"),
    incognito: $("#incognito-toggle"),
    webglStatus: $("#webgl-status"),
    webglOverride: $("#webgl-override-select"),
    notifications: $("#notifications"),
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function displayHost(url) {
    try {
      const u = new URL(url.includes("://") ? url : `https://${url}`);
      return u.host;
    } catch {
      return url;
    }
  }

  /**
   * @param {string} message
   * @param {'info'|'warn'|'error'} [level]
   */
  function showNotification(message, level = "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${level}`;
    toast.setAttribute("role", level === "error" ? "alert" : "status");

    const p = document.createElement("p");
    p.className = "toast-message";
    p.textContent = message;
    toast.appendChild(p);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());
    toast.appendChild(close);

    els.notifications.appendChild(toast);

    if (level !== "error") {
      window.setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, 5000);
    }
  }

  function setFormError(message) {
    if (!message) {
      els.formError.hidden = true;
      els.formError.textContent = "";
      return;
    }
    els.formError.hidden = false;
    els.formError.textContent = message;
  }

  function resetPasswordVisibility() {
    els.password.type = "password";
    els.passwordToggle.textContent = "Show";
    els.passwordToggle.setAttribute("aria-pressed", "false");
    els.passwordToggle.setAttribute("aria-label", "Show password");
  }

  function setAddMode() {
    formMode = "add";
    els.editId.value = "";
    els.serverForm.reset();
    resetPasswordVisibility();
    setFormError("");
    els.serverFormHeading.textContent = "Add Server";
    els.serverFormSubmit.textContent = "Add Server";
    els.formCancelBtn.hidden = true;
  }

  function setEditMode(server) {
    formMode = "edit";
    els.editId.value = server.id;
    els.label.value = server.label || "";
    els.url.value = server.url || "";
    els.notes.value = server.notes || "";
    els.username.value = server.username || "";
    els.password.value = server.password || "";
    resetPasswordVisibility();
    setFormError("");
    els.serverFormHeading.textContent = "Edit Server";
    els.serverFormSubmit.textContent = "Update Server";
    els.formCancelBtn.hidden = false;
    els.label.focus();
  }

  function renderServerList() {
    els.serverList.innerHTML = "";
    const sorted = [...servers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    els.serverListEmpty.hidden = sorted.length > 0;

    for (const server of sorted) {
      const card = document.createElement("article");
      card.className = "server-card";
      card.setAttribute("role", "listitem");
      card.dataset.serverId = server.id;

      const notesText = (server.notes || "").trim();
      const notesClass = notesText ? "server-card-notes" : "server-card-notes empty";
      const notesPreview = notesText || "No notes";

      card.innerHTML = `
        <div class="server-card-body">
          <h3 class="server-card-label">${escapeHtml(server.label)}</h3>
          <p class="server-card-url" title="${escapeHtml(server.url)}">${escapeHtml(displayHost(server.url))}</p>
          <p class="${notesClass}">${escapeHtml(notesPreview)}</p>
        </div>
        <div class="server-card-actions">
          <button type="button" class="btn btn-primary btn-sm" data-action="connect">Connect</button>
          <button type="button" class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete">Delete</button>
        </div>
      `;

      card.querySelector('[data-action="connect"]').addEventListener("click", () =>
        handleConnect(server)
      );
      card.querySelector('[data-action="edit"]').addEventListener("click", () => setEditMode(server));
      card.querySelector('[data-action="delete"]').addEventListener("click", () =>
        handleDelete(server)
      );

      els.serverList.appendChild(card);
    }
  }

  async function loadServers() {
    if (typeof window.flc?.servers?.list !== "function") {
      console.warn("[FLC] window.flc.servers.list is not available");
      showNotification("Server storage API not available", "error");
      return;
    }

    try {
      servers = await window.flc.servers.list();
      if (!Array.isArray(servers)) servers = [];

      renderServerList();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showNotification(msg, "error");
    }
  }

  async function handleConnect(server) {
    const incognito = Boolean(els.incognito.checked);
    const connect = window.flc?.game?.connect;

    if (typeof connect !== "function") {
      showNotification("Game window not available yet", "warn");
      return;
    }

    try {
      await connect({
        id: server.id,
        url: server.url,
        label: server.label,
        incognito,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showNotification(msg, "error");
    }
  }

  async function handleDelete(server) {
    const ok = window.confirm(`Delete server "${server.label}"?`);
    if (!ok) return;

    if (typeof window.flc?.servers?.delete !== "function") {
      showNotification("Server storage API not available", "error");
      return;
    }

    try {
      servers = await window.flc.servers.delete(server.id);
      if (!Array.isArray(servers)) servers = [];
      if (els.editId.value === server.id) setAddMode();
      renderServerList();
      showNotification("Server deleted", "info");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showNotification(msg, "error");
    }
  }

  function readFormPayload() {
    return {
      label: els.label.value.trim(),
      url: els.url.value.trim(),
      notes: els.notes.value.trim(),
      username: els.username.value.trim() || undefined,
      password: els.password.value || undefined,
    };
  }

  async function handleFormSubmit(event) {
    event.preventDefault();
    setFormError("");

    const payload = readFormPayload();
    if (!payload.label) {
      setFormError("Label is required.");
      els.label.focus();
      return;
    }
    if (!payload.url) {
      setFormError("URL is required.");
      els.url.focus();
      return;
    }

    try {
      if (formMode === "edit") {
        const id = els.editId.value;
        if (!id) {
          setFormError("Missing server id for edit.");
          return;
        }
        if (typeof window.flc?.servers?.update !== "function") {
          showNotification("Server storage API not available", "error");
          return;
        }
        servers = await window.flc.servers.update(id, payload);
        showNotification("Server updated", "info");
        setAddMode();
      } else {
        if (typeof window.flc?.servers?.add !== "function") {
          showNotification("Server storage API not available", "error");
          return;
        }
        const order = servers.length;
        servers = await window.flc.servers.add({ ...payload, order });
        showNotification("Server added", "info");
        els.serverForm.reset();
        resetPasswordVisibility();
      }

      if (!Array.isArray(servers)) servers = [];
      renderServerList();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setFormError(msg);
      showNotification(msg, "error");
    }
  }

  function applyWebglStatusToUi(status) {
    if (!status || !els.webglStatus) return;

    const mode = status.mode === "software" ? "software" : "hardware";
    els.webglStatus.classList.remove("mode-hardware", "mode-software");
    els.webglStatus.classList.add(mode === "software" ? "mode-software" : "mode-hardware");

    if (mode === "software") {
      const reason = status.lastFallbackReason
        ? ` — ${status.lastFallbackReason}`
        : " (fallback)";
      els.webglStatus.textContent = `WebGL: Software${reason}`;
    } else {
      els.webglStatus.textContent = "WebGL: Hardware";
    }

    if (els.webglOverride) {
      if (mode === "software") {
        els.webglOverride.value = "software";
      } else {
        const current = els.webglOverride.value;
        if (current !== "software") {
          els.webglOverride.value = current === "hardware" ? "hardware" : "auto";
        }
      }
    }
  }

  window.__flcUpdateWebglStatus = function (status) {
    applyWebglStatusToUi(status);

    if (status && status.mode === "software") {
      const reason = status.lastFallbackReason
        ? `WebGL fell back to software rendering: ${status.lastFallbackReason}`
        : "WebGL fell back to software rendering (see logs)";
      showNotification(reason, "warn");
    }
  };

  async function refreshWebglStatusFromBackend() {
    const getStatus = window.flc?.game?.getWebglStatus;
    if (typeof getStatus !== "function") {
      if (els.webglStatus) els.webglStatus.textContent = "WebGL: —";
      return;
    }
    try {
      const status = await getStatus();
      applyWebglStatusToUi(status);
    } catch (err) {
      console.warn("[FLC] getWebglStatus failed", err);
    }
  }

  async function applyWebglOverride(value) {
    const setSoftware = window.flc?.game?.setSoftwareWebgl;
    if (typeof setSoftware !== "function") {
      showNotification("WebGL preference API not available yet", "warn");
      return;
    }

    const preferSoftware = value === "software";
    try {
      await setSoftware(preferSoftware);
      await refreshWebglStatusFromBackend();
      if (value === "hardware" || value === "auto") {
        showNotification("WebGL set to prefer hardware rendering", "info");
      } else {
        showNotification("WebGL set to software rendering", "info");
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      showNotification(msg, "error");
    }
  }

  function subscribeWebglFallback() {
    try {
      const onFallback = window.flc?.onWebglFallback;
      if (typeof onFallback !== "function") return;

      onFallback((info) => {
        const status = {
          mode: "software",
          lastFallbackReason: info && (info.reason || info.message),
        };
        window.__flcUpdateWebglStatus(status);
      });
    } catch (err) {
      console.warn("[FLC] onWebglFallback subscription failed", err);
    }
  }

  function bindUi() {
    els.serverForm.addEventListener("submit", handleFormSubmit);
    els.formCancelBtn.addEventListener("click", () => setAddMode());

    els.passwordToggle.addEventListener("click", () => {
      const showing = els.password.type === "text";
      els.password.type = showing ? "password" : "text";
      els.passwordToggle.textContent = showing ? "Show" : "Hide";
      els.passwordToggle.setAttribute("aria-pressed", showing ? "false" : "true");
      els.passwordToggle.setAttribute(
        "aria-label",
        showing ? "Show password" : "Hide password"
      );
    });

    if (els.webglOverride) {
      els.webglOverride.addEventListener("change", () => {
        applyWebglOverride(els.webglOverride.value);
      });
    }
  }

  function init() {
    bindUi();
    setAddMode();
    subscribeWebglFallback();
    refreshWebglStatusFromBackend();
    loadServers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
