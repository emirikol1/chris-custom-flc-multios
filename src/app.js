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
    usernameManual: $("#server-username-manual"),
    getUsersBtn: $("#get-users-btn"),
    getUsersResult: $("#get-users-result"),
    password: $("#server-password"),
    passwordToggle: $("#password-toggle-btn"),
    autoJoin: $("#server-autojoin"),
    incognito: $("#incognito-toggle"),
    mudToggle: $("#mud-toggle"),
    webglStatus: $("#webgl-status"),
    webglOverride: $("#webgl-override-select"),
    notifications: $("#notifications"),
    mudPanel: $("#mud-setup-panel"),
    mudState: $("#mud-setup-state"),
    mudNotice: $("#mud-setup-notice"),
    mudForm: $("#mud-setup-form"),
    mudError: $("#mud-setup-error"),
    aiPreset: $("#ai-preset"),
    aiPresetHint: $("#ai-preset-hint"),
    aiSignupLink: $("#ai-signup-link"),
    aiBaseUrl: $("#ai-base-url"),
    aiKeyRow: $("#ai-key-row"),
    aiApiKey: $("#ai-api-key"),
    aiKeyToggle: $("#ai-key-toggle-btn"),
    aiTestBtn: $("#ai-test-btn"),
    aiTestResult: $("#ai-test-result"),
    aiModel: $("#ai-model"),
    mudSave: $("#mud-setup-save"),
    serverListPanel: $("#server-list-panel"),
    serverListToggle: $("#server-list-toggle"),
    serverListSummary: $("#server-list-summary"),
    mudSetupToggle: $("#mud-setup-toggle"),
    mudProviderName: $("#mud-provider-name"),
    mudStatusLight: $("#mud-status-light"),
    settingsImportBtn: $("#settings-import-btn"),
    settingsExportBtn: $("#settings-export-btn"),
  };

  /** Collapsed state of the two collapsible panels (persisted in app prefs). */
  const collapsed = { servers: false, mud: false };

  /** @type {Array<{id:string,label:string,group:string,baseUrl:string,keyRequired:boolean,signupUrl:string,hint:string}>} */
  let aiPresets = [];
  /** @type {{preset:string,baseUrl:string,model:string,hasKey:boolean}|null} */
  let aiSettings = null;
  let aiTestedOk = false;

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

  const MANUAL_USER = "__manual__";

  /**
   * Rebuild the username dropdown. `users` are names fetched from the server;
   * `selected` is the stored username (kept even if not in the list).
   * @param {string[]} users
   * @param {string} [selected]
   */
  function setUsernameOptions(users, selected) {
    const names = [...users];
    if (selected && !names.includes(selected)) names.unshift(selected);
    els.username.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    els.username.appendChild(none);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      els.username.appendChild(opt);
    }
    const manual = document.createElement("option");
    manual.value = MANUAL_USER;
    manual.textContent = "Type a name…";
    els.username.appendChild(manual);
    els.username.value = selected || "";
    els.usernameManual.hidden = true;
    els.usernameManual.value = "";
  }

  function readUsername() {
    const v = els.username.value;
    if (v === MANUAL_USER) return els.usernameManual.value.trim();
    return v.trim();
  }

  function setGetUsersResult(text, cls) {
    els.getUsersResult.className = `field-hint${cls ? ` ${cls}` : ""}`;
    els.getUsersResult.textContent = text || "";
  }

  const GET_USERS_ERROR_TEXT = {
    invalid_url: "Enter a valid server URL first.",
    unreachable: "Could not reach the server.",
    not_found: "No join page found at that URL.",
    http_error: "The server returned an error.",
    no_users: "No users listed on the join page (the world may not be active).",
  };

  async function handleGetUsers() {
    const getUsers = window.flc?.servers?.getUsers;
    if (typeof getUsers !== "function") return;
    const url = els.url.value.trim();
    if (!url) {
      setGetUsersResult(GET_USERS_ERROR_TEXT.invalid_url, "bad");
      els.url.focus();
      return;
    }
    const previous = readUsername();
    els.getUsersBtn.disabled = true;
    els.getUsersBtn.textContent = "Fetching…";
    setGetUsersResult("");
    try {
      const result = await getUsers(url, els.editId.value || undefined);
      if (result && result.ok) {
        setUsernameOptions(result.users, previous && result.users.includes(previous) ? previous : "");
        setGetUsersResult(`${result.users.length} user${result.users.length === 1 ? "" : "s"} found`, "ok");
      } else {
        setGetUsersResult(GET_USERS_ERROR_TEXT[result && result.error] || GET_USERS_ERROR_TEXT.http_error, "bad");
      }
    } catch {
      setGetUsersResult(GET_USERS_ERROR_TEXT.http_error, "bad");
    } finally {
      els.getUsersBtn.disabled = false;
      els.getUsersBtn.textContent = "Get Users";
    }
  }

  function setAddMode() {
    formMode = "add";
    els.editId.value = "";
    els.serverForm.reset();
    setUsernameOptions([], "");
    setGetUsersResult("");
    els.autoJoin.checked = true;
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
    setUsernameOptions([], server.username || "");
    setGetUsersResult("");
    els.password.value = server.password || "";
    els.autoJoin.checked = server.autoJoin !== false;
    resetPasswordVisibility();
    setFormError("");
    els.serverFormHeading.textContent = "Edit Server";
    els.serverFormSubmit.textContent = "Update Server";
    els.formCancelBtn.hidden = false;
    els.label.focus();
  }

  function sortedServers() {
    return [...servers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** Compact rows (label + session username) shown while the panel is collapsed. */
  function renderServerCompactList() {
    const existing = els.serverListPanel.querySelector(".server-compact-list");
    if (existing) existing.remove();
    els.serverListSummary.textContent = "";
    if (!collapsed.servers) return;

    const sorted = sortedServers();
    els.serverListSummary.textContent = `${sorted.length} server${sorted.length === 1 ? "" : "s"}`;
    if (sorted.length === 0) return;

    const list = document.createElement("div");
    list.className = "server-compact-list";
    list.setAttribute("role", "list");
    for (const server of sorted) {
      const row = document.createElement("div");
      row.className = "server-compact";
      row.setAttribute("role", "listitem");
      const user = (server.username || "").trim();
      row.innerHTML = `
        <span class="server-compact-label" title="${escapeHtml(server.url)}">${escapeHtml(server.label)}</span>
        <span class="server-compact-user${user ? "" : " none"}">${escapeHtml(user || "no session user")}</span>
        <button type="button" class="btn btn-primary btn-sm" data-action="connect">Connect</button>
      `;
      row.querySelector('[data-action="connect"]').addEventListener("click", () =>
        handleConnect(server)
      );
      list.appendChild(row);
    }
    els.serverListPanel.appendChild(list);
  }

  function renderServerList() {
    els.serverList.innerHTML = "";
    const sorted = sortedServers();

    els.serverListEmpty.hidden = sorted.length > 0;
    renderServerCompactList();

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
        autoJoin: server.autoJoin !== false,
        username: server.username || undefined,
        password: server.password || undefined,
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
      username: readUsername() || undefined,
      password: els.password.value || undefined,
      autoJoin: Boolean(els.autoJoin.checked),
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
        setUsernameOptions([], "");
        setGetUsersResult("");
        els.autoJoin.checked = true;
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

  // ---------------------------------------------------------------------
  // Mud toggle + AI provider setup
  // ---------------------------------------------------------------------

  const AI_ERROR_TEXT = {
    unreachable: "Could not reach the server. Is it running / is the URL right?",
    unauthorized: "The server rejected the API key.",
    forbidden: "The server refused the request (forbidden).",
    not_found: "No /models endpoint at that URL. Check the URL ends with /v1.",
    rate_limited: "Rate limited. Wait a moment and try again.",
    no_models: "Connected, but no models are available. Load a model first.",
    invalid_url: "That is not a valid http(s) URL.",
    http_error: "The server returned an error.",
  };

  function setMudSetupError(message) {
    els.mudError.hidden = !message;
    els.mudError.textContent = message || "";
  }

  function currentPreset() {
    return aiPresets.find((p) => p.id === els.aiPreset.value) || null;
  }

  function isAiConfigured() {
    if (!aiSettings) return false;
    const preset = aiPresets.find((p) => p.id === aiSettings.preset);
    const keyOk = preset && !preset.keyRequired ? true : aiSettings.hasKey;
    return Boolean(aiSettings.baseUrl && aiSettings.model && keyOk);
  }

  function refreshMudSetupState() {
    const configured = isAiConfigured();
    els.mudState.classList.toggle("ok", configured);
    els.mudState.textContent = configured
      ? `Ready · ${aiSettings.model}`
      : "Not set up";
    els.mudNotice.hidden = configured || !els.mudToggle.checked;
    const preset = aiSettings && aiPresets.find((p) => p.id === aiSettings.preset);
    els.mudProviderName.textContent = preset ? preset.label : aiSettings?.preset || "";
    if (!configured) setMudStatusLight("unknown", "AI server: not set up");
  }

  /**
   * @param {"ok"|"bad"|"unknown"|"checking"} state
   * @param {string} title
   */
  function setMudStatusLight(state, title) {
    els.mudStatusLight.className = `status-light ${state}`;
    els.mudStatusLight.title = title;
    els.mudStatusLight.setAttribute("aria-label", title);
  }

  const MUD_PING_INTERVAL_MS = 60_000;
  let mudPingTimer = null;
  let mudPingInFlight = false;

  /** Ping the saved AI server (using the saved key) and set the red/green light. */
  async function pingMudServer() {
    const api = window.flc?.ai;
    if (!api || mudPingInFlight) return;
    if (!isAiConfigured()) {
      setMudStatusLight("unknown", "AI server: not set up");
      return;
    }
    mudPingInFlight = true;
    els.mudStatusLight.classList.add("checking");
    try {
      const result = await api.testConnection({
        preset: aiSettings.preset,
        baseUrl: aiSettings.baseUrl,
        apiKey: undefined, // use the saved key
      });
      if (result && result.ok) {
        const hasModel = result.models.includes(aiSettings.model);
        setMudStatusLight(
          hasModel ? "ok" : "bad",
          hasModel
            ? `AI server: connected (${result.models.length} model${result.models.length === 1 ? "" : "s"})`
            : `AI server: connected, but model "${aiSettings.model}" is not loaded`
        );
      } else {
        setMudStatusLight(
          "bad",
          `AI server: ${AI_ERROR_TEXT[result && result.error] || AI_ERROR_TEXT.http_error}`
        );
      }
    } catch {
      setMudStatusLight("bad", `AI server: ${AI_ERROR_TEXT.http_error}`);
    } finally {
      mudPingInFlight = false;
      els.mudStatusLight.classList.remove("checking");
    }
  }

  function startMudPing() {
    stopMudPing();
    pingMudServer();
    mudPingTimer = setInterval(pingMudServer, MUD_PING_INTERVAL_MS);
  }

  function stopMudPing() {
    if (mudPingTimer !== null) {
      clearInterval(mudPingTimer);
      mudPingTimer = null;
    }
  }

  /**
   * @param {"servers"|"mud"} panel
   * @param {boolean} isCollapsed
   * @param {{ persist?: boolean }} [opts]
   */
  function setPanelCollapsed(panel, isCollapsed, opts = {}) {
    collapsed[panel] = Boolean(isCollapsed);
    const section = panel === "servers" ? els.serverListPanel : els.mudPanel;
    const toggle = panel === "servers" ? els.serverListToggle : els.mudSetupToggle;
    section.classList.toggle("collapsed", collapsed[panel]);
    toggle.setAttribute("aria-expanded", collapsed[panel] ? "false" : "true");
    if (panel === "servers") {
      renderServerCompactList();
    } else {
      // Expanded header shows "Ready · model"; collapsed shows provider + light only.
      els.mudState.hidden = collapsed.mud;
    }
    if (opts.persist !== false) {
      const setPrefs = window.flc?.prefs?.set;
      if (typeof setPrefs === "function") {
        const key = panel === "servers" ? "serversCollapsed" : "mudCollapsed";
        setPrefs({ [key]: collapsed[panel] }).catch(() => {});
      }
    }
  }

  function applyPresetToForm(presetId, opts = {}) {
    const preset = aiPresets.find((p) => p.id === presetId);
    if (!preset) return;
    els.aiPreset.value = preset.id;
    els.aiPresetHint.textContent = preset.hint || "";
    if (preset.signupUrl) {
      els.aiSignupLink.hidden = false;
      els.aiSignupLink.textContent = preset.keyRequired
        ? "Get a free key"
        : "Download";
    } else {
      els.aiSignupLink.hidden = true;
    }
    els.aiKeyRow.querySelector("label").textContent = preset.keyRequired
      ? "API key"
      : "API key (optional — only if your server requires one)";
    if (!opts.keepUrl) {
      els.aiBaseUrl.value = preset.baseUrl || "";
    }
    els.aiBaseUrl.readOnly = false;
  }

  function resetModelDropdown(placeholder) {
    els.aiModel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    els.aiModel.appendChild(opt);
    els.aiModel.disabled = true;
    aiTestedOk = false;
    els.mudSave.disabled = true;
  }

  function fillModelDropdown(models, preferred) {
    els.aiModel.innerHTML = "";
    for (const id of models) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      els.aiModel.appendChild(opt);
    }
    if (preferred && models.includes(preferred)) {
      els.aiModel.value = preferred;
    }
    els.aiModel.disabled = false;
    aiTestedOk = true;
    els.mudSave.disabled = !els.aiModel.value;
  }

  function populatePresetSelect() {
    const groups = [
      ["local", "Local (free, runs on this computer)"],
      ["hosted-free", "Hosted (free tier, needs a free key)"],
      ["paid", "Paid"],
      ["custom", "Custom"],
    ];
    els.aiPreset.innerHTML = "";
    for (const [groupId, label] of groups) {
      const items = aiPresets.filter((p) => p.group === groupId);
      if (items.length === 0) continue;
      const og = document.createElement("optgroup");
      og.label = label;
      for (const p of items) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        og.appendChild(opt);
      }
      els.aiPreset.appendChild(og);
    }
  }

  async function loadAiSetup() {
    const api = window.flc?.ai;
    if (!api) return;
    try {
      aiPresets = await api.getPresets();
      aiSettings = await api.getSettings();
    } catch (err) {
      console.warn("[FLC] AI setup load failed", err);
      return;
    }
    populatePresetSelect();
    applyPresetToForm(aiSettings.preset || aiPresets[0]?.id, { keepUrl: true });
    els.aiBaseUrl.value = aiSettings.baseUrl || currentPreset()?.baseUrl || "";
    els.aiApiKey.value = "";
    els.aiApiKey.placeholder = aiSettings.hasKey
      ? "Key saved (leave blank to keep it)"
      : "Paste your key";
    if (aiSettings.model) {
      fillModelDropdown([aiSettings.model], aiSettings.model);
      aiTestedOk = false;
      els.mudSave.disabled = true;
    } else {
      resetModelDropdown("Press Test Server first");
    }
    refreshMudSetupState();
  }

  function readAiForm() {
    const preset = currentPreset();
    const key = els.aiApiKey.value;
    return {
      preset: preset ? preset.id : "custom",
      baseUrl: els.aiBaseUrl.value.trim(),
      // undefined = keep the saved key; '' = explicitly cleared
      apiKey: key === "" && aiSettings && aiSettings.hasKey ? undefined : key,
      model: els.aiModel.value || "",
    };
  }

  async function handleTestServer() {
    const api = window.flc?.ai;
    if (!api) return;
    setMudSetupError("");
    const cfg = readAiForm();
    if (!cfg.baseUrl) {
      setMudSetupError("Server URL is required.");
      els.aiBaseUrl.focus();
      return;
    }
    els.aiTestBtn.disabled = true;
    els.aiTestBtn.textContent = "Testing…";
    els.aiTestResult.className = "field-hint";
    els.aiTestResult.textContent = "";
    try {
      const result = await api.testConnection(cfg);
      if (result && result.ok) {
        fillModelDropdown(result.models, aiSettings?.model);
        els.aiTestResult.className = "field-hint ok";
        els.aiTestResult.textContent = `Connected · ${result.models.length} model${result.models.length === 1 ? "" : "s"}`;
      } else {
        resetModelDropdown("Test failed");
        els.aiTestResult.className = "field-hint bad";
        els.aiTestResult.textContent =
          AI_ERROR_TEXT[result && result.error] || AI_ERROR_TEXT.http_error;
      }
    } catch (err) {
      resetModelDropdown("Test failed");
      els.aiTestResult.className = "field-hint bad";
      els.aiTestResult.textContent = AI_ERROR_TEXT.http_error;
    } finally {
      els.aiTestBtn.disabled = false;
      els.aiTestBtn.textContent = "Test Server";
    }
  }

  async function handleMudSetupSave(event) {
    event.preventDefault();
    const api = window.flc?.ai;
    if (!api) return;
    setMudSetupError("");
    if (!aiTestedOk || !els.aiModel.value) {
      setMudSetupError("Press Test Server and pick a model before saving.");
      return;
    }
    try {
      aiSettings = await api.saveSettings(readAiForm());
      els.aiApiKey.value = "";
      els.aiApiKey.placeholder = aiSettings.hasKey
        ? "Key saved (leave blank to keep it)"
        : "Paste your key";
      refreshMudSetupState();
      startMudPing();
      showNotification("Mud AI server saved", "info");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setMudSetupError(msg);
    }
  }

  function showMudPanel(show, opts = {}) {
    els.mudPanel.hidden = !show;
    refreshMudSetupState();
    if (show) {
      startMudPing();
      if (opts.expand) setPanelCollapsed("mud", false);
      if (opts.scroll) {
        els.mudPanel.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    } else {
      stopMudPing();
    }
  }

  async function handleMudToggle() {
    const enabled = Boolean(els.mudToggle.checked);
    const setPrefs = window.flc?.prefs?.set;
    if (typeof setPrefs === "function") {
      try {
        await setPrefs({ mudEnabled: enabled });
      } catch (err) {
        showNotification("Could not save Mud preference", "error");
      }
    }
    // Turning Mud on that isn't set up yet: open the panel so the user sees what to do.
    showMudPanel(enabled, { expand: enabled && !isAiConfigured(), scroll: enabled });
    if (enabled && !isAiConfigured()) {
      showNotification(
        "FLC MUD needs an AI server (LM Studio, Ollama, a free hosted key, or OpenAI). Set it up in Mud Setup.",
        "warn"
      );
    }
  }

  async function loadPrefs() {
    const getPrefs = window.flc?.prefs?.get;
    if (typeof getPrefs !== "function") return;
    try {
      const prefs = await getPrefs();
      setPanelCollapsed("servers", Boolean(prefs && prefs.serversCollapsed), { persist: false });
      setPanelCollapsed("mud", Boolean(prefs && prefs.mudCollapsed), { persist: false });
      els.mudToggle.checked = Boolean(prefs && prefs.mudEnabled);
      showMudPanel(els.mudToggle.checked);
    } catch (err) {
      console.warn("[FLC] prefs load failed", err);
    }
  }

  function bindMudUi() {
    els.mudToggle.addEventListener("change", handleMudToggle);
    els.aiPreset.addEventListener("change", () => {
      applyPresetToForm(els.aiPreset.value);
      resetModelDropdown("Press Test Server first");
      els.aiTestResult.textContent = "";
      setMudSetupError("");
    });
    els.aiBaseUrl.addEventListener("input", () => {
      if (aiTestedOk) resetModelDropdown("URL changed — press Test Server");
    });
    els.aiApiKey.addEventListener("input", () => {
      if (aiTestedOk) resetModelDropdown("Key changed — press Test Server");
    });
    els.aiModel.addEventListener("change", () => {
      els.mudSave.disabled = !(aiTestedOk && els.aiModel.value);
    });
    els.aiTestBtn.addEventListener("click", handleTestServer);
    els.mudForm.addEventListener("submit", handleMudSetupSave);
    els.aiSignupLink.addEventListener("click", (event) => {
      event.preventDefault();
      const preset = currentPreset();
      if (preset && window.flc?.ai?.openSignup) {
        window.flc.ai.openSignup(preset.id);
      }
    });
    els.aiKeyToggle.addEventListener("click", () => {
      const showing = els.aiApiKey.type === "text";
      els.aiApiKey.type = showing ? "password" : "text";
      els.aiKeyToggle.textContent = showing ? "Show" : "Hide";
      els.aiKeyToggle.setAttribute("aria-pressed", showing ? "false" : "true");
    });

    els.serverListToggle.addEventListener("click", () =>
      setPanelCollapsed("servers", !collapsed.servers)
    );
    els.mudSetupToggle.addEventListener("click", () => setPanelCollapsed("mud", !collapsed.mud));
    els.mudStatusLight.addEventListener("click", () => pingMudServer());

    if (typeof window.flc?.onOpenMudSetup === "function") {
      window.flc.onOpenMudSetup(() => {
        showMudPanel(true, { expand: true, scroll: true });
      });
    }
    if (typeof window.flc?.onAutologinStatus === "function") {
      window.flc.onAutologinStatus((status) => {
        if (!status) return;
        if (status.matched === false && status.userCount !== undefined) {
          showNotification(
            `Auto-join: no user named "${status.username || "?"}" on ${status.label || "that server"}. Pick a user manually.`,
            "warn"
          );
        } else if (status.matched === false && status.error) {
          showNotification("Auto-join could not run on the join page.", "warn");
        }
      });
    }
  }

  const IMPORT_ERROR_TEXT = {
    invalid_json: "That file is not valid JSON.",
    not_settings_file: "That file is not an FLC settings export.",
    unsupported_format: "That settings file was made by a newer version of FLC.",
    read_failed: "Could not read that file.",
    apply_failed: "Import failed part-way; some settings may have been applied.",
    write_failed: "Could not write the settings file.",
  };

  async function handleExportSettings() {
    const api = window.flc?.settings;
    if (!api) return;
    els.settingsExportBtn.disabled = true;
    try {
      const result = await api.exportToFile();
      if (result && result.ok) {
        showNotification(
          `Settings exported (${result.servers} server${result.servers === 1 ? "" : "s"}, Mud setup, preferences, window layouts). The file contains your passwords and API key — keep it private.`,
          "info"
        );
      } else if (result && !result.canceled) {
        showNotification(IMPORT_ERROR_TEXT[result.error] || IMPORT_ERROR_TEXT.write_failed, "error");
      }
    } finally {
      els.settingsExportBtn.disabled = false;
    }
  }

  async function handleImportSettings() {
    const api = window.flc?.settings;
    if (!api) return;
    els.settingsImportBtn.disabled = true;
    try {
      const result = await api.importFromFile();
      if (result && result.ok) {
        const s = result.servers || { added: 0, updated: 0, skipped: 0 };
        const parts = [];
        if (result.applied.includes("servers")) {
          parts.push(`servers: ${s.added} added, ${s.updated} updated${s.skipped ? `, ${s.skipped} skipped` : ""}`);
        }
        if (result.applied.includes("aiProvider")) parts.push("Mud setup");
        if (result.applied.includes("narratorSettings")) parts.push("Mud options");
        if (result.applied.includes("appPrefs")) parts.push("preferences");
        if (result.applied.includes("windowState")) parts.push("window layouts");
        showNotification(`Imported ${parts.join(" · ") || "nothing"}.`, "info");
        // Refresh everything the import may have touched.
        await loadServers();
        setAddMode();
        await loadAiSetup();
        await loadPrefs();
      } else if (result && !result.canceled) {
        showNotification(IMPORT_ERROR_TEXT[result.error] || IMPORT_ERROR_TEXT.read_failed, "error");
      }
    } finally {
      els.settingsImportBtn.disabled = false;
    }
  }

  function bindUi() {
    bindMudUi();
    els.settingsExportBtn.addEventListener("click", handleExportSettings);
    els.settingsImportBtn.addEventListener("click", handleImportSettings);
    els.serverForm.addEventListener("submit", handleFormSubmit);
    els.getUsersBtn.addEventListener("click", handleGetUsers);
    els.username.addEventListener("change", () => {
      const manual = els.username.value === MANUAL_USER;
      els.usernameManual.hidden = !manual;
      if (manual) els.usernameManual.focus();
    });
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
    loadAiSetup().then(loadPrefs);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
