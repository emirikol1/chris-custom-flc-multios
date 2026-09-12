(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const els = {
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
    notifications: $("#notifications"),
  };

  /** @type {'add'|'edit'|'clone'} */
  let mode = "add";
  let submitting = false;

  function showNotification(message, level = "info") {
    const toast = document.createElement("div");
    toast.className = `toast toast-${level}`;
    toast.setAttribute("role", level === "error" ? "alert" : "status");
    const p = document.createElement("p");
    p.className = "toast-message";
    p.textContent = message;
    toast.appendChild(p);
    els.notifications.appendChild(toast);
    if (level !== "error") {
      window.setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, 5000);
    }
  }

  function setFormError(message) {
    els.formError.hidden = !message;
    els.formError.textContent = message || "";
  }

  function resetPasswordVisibility() {
    els.password.type = "password";
    els.passwordToggle.textContent = "Show";
    els.passwordToggle.setAttribute("aria-pressed", "false");
    els.passwordToggle.setAttribute("aria-label", "Show password");
  }

  const MANUAL_USER = "__manual__";

  /**
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
      // Edit mode reuses that server's session cookies; add/clone use a fresh one.
      const result = await getUsers(url, mode === "edit" ? els.editId.value || undefined : undefined);
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

  /**
   * @param {{ mode: 'add'|'edit'|'clone', server: object|null }} ctx
   */
  function applyContext(ctx) {
    mode = ctx && (ctx.mode === "edit" || ctx.mode === "clone") ? ctx.mode : "add";
    const server = (ctx && ctx.server) || {};
    els.serverForm.reset();
    setFormError("");
    setGetUsersResult("");
    resetPasswordVisibility();

    els.editId.value = mode === "edit" ? server.id || "" : "";
    els.label.value = mode === "clone" ? `${server.label || ""} (copy)`.trim() : server.label || "";
    els.url.value = server.url || "";
    els.notes.value = server.notes || "";
    setUsernameOptions([], server.username || "");
    els.password.value = server.password || "";
    els.autoJoin.checked = server.autoJoin !== false;

    const titles = {
      add: ["Add Server", "Add Server"],
      edit: ["Edit Server", "Update Server"],
      clone: ["Clone Server", "Add Server"],
    };
    els.serverFormHeading.textContent = titles[mode][0];
    els.serverFormSubmit.textContent = titles[mode][1];
    document.title = `${titles[mode][0]} — Chris's Custom FLC MultiOS`;
    els.label.focus();
    if (mode === "clone") els.label.select();
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
    if (submitting) return;
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
    const api = window.flc?.servers;
    if (!api) {
      setFormError("Server storage API not available");
      return;
    }
    submitting = true;
    els.serverFormSubmit.disabled = true;
    try {
      if (mode === "edit") {
        const id = els.editId.value;
        if (!id) {
          setFormError("Missing server id for edit.");
          return;
        }
        await api.update(id, payload);
      } else {
        await api.add(payload);
      }
      window.flc?.serverConfig?.close();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setFormError(msg);
    } finally {
      submitting = false;
      els.serverFormSubmit.disabled = false;
    }
  }

  function bindUi() {
    els.serverForm.addEventListener("submit", handleFormSubmit);
    els.getUsersBtn.addEventListener("click", handleGetUsers);
    els.username.addEventListener("change", () => {
      const manual = els.username.value === MANUAL_USER;
      els.usernameManual.hidden = !manual;
      if (manual) els.usernameManual.focus();
    });
    els.formCancelBtn.addEventListener("click", () => window.flc?.serverConfig?.close());
    els.passwordToggle.addEventListener("click", () => {
      const showing = els.password.type === "text";
      els.password.type = showing ? "password" : "text";
      els.passwordToggle.textContent = showing ? "Show" : "Hide";
      els.passwordToggle.setAttribute("aria-pressed", showing ? "false" : "true");
      els.passwordToggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.flc?.serverConfig?.close();
    });
    if (typeof window.flc?.serverConfig?.onContext === "function") {
      window.flc.serverConfig.onContext(applyContext);
    }
  }

  async function init() {
    bindUi();
    try {
      const ctx = await window.flc?.serverConfig?.getContext();
      applyContext(ctx || { mode: "add", server: null });
    } catch (err) {
      console.warn("[FLC] server-config context load failed", err);
      applyContext({ mode: "add", server: null });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
