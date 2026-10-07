(function () {
  var preview = document.getElementById("preview");
  var copyBtn = document.getElementById("copy");
  var dismiss = document.getElementById("dismiss");
  var api = window.flcLoadNotice;
  var label = "Copy message for your server admin";
  var timer = 0;

  function showMessage(text) {
    if (!preview) return;
    preview.textContent = typeof text === "string" && text ? text : "";
  }

  if (api && typeof api.getAdminMessage === "function") {
    api.getAdminMessage().then(function (text) {
      showMessage(text);
    }).catch(function () {
      showMessage("");
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (!api || typeof api.copyAdminMessage !== "function") return;
      api.copyAdminMessage().then(function (ok) {
        if (ok === false) return;
        copyBtn.textContent = "Copied";
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          copyBtn.textContent = label;
        }, 2000);
      }).catch(function () {});
    });
  }

  if (dismiss) {
    dismiss.addEventListener("click", function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (api && typeof api.dismiss === "function") api.dismiss();
    });
  }
})();
