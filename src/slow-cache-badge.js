(function () {
  var pending = null;
  var epoch = 0;

  function loadFlags() {
    var list = window.flc && window.flc.slowCache && window.flc.slowCache.list;
    if (typeof list !== "function") return Promise.resolve({});
    if (!pending) {
      pending = Promise.resolve()
        .then(function () { return list(); })
        .then(function (rows) {
          return rows && typeof rows === "object" ? rows : {};
        })
        .catch(function () { return {}; });
    }
    return pending;
  }

  function hostedForge(card) {
    var node = card.querySelector(".server-card-url");
    var host = node ? String(node.textContent || "") : "";
    host = host.trim().toLowerCase();
    if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
    var colon = host.lastIndexOf(":");
    if (colon > 0 && host.indexOf("]") < 0) host = host.slice(0, colon);
    return host === "forge-vtt.com" || host.slice(-14) === ".forge-vtt.com";
  }

  function paint(card, serverId) {
    if (!card || !serverId) return;
    var token = epoch;
    loadFlags().then(function (rows) {
      var row = rows && rows[serverId];
      if (token !== epoch) return;
      if (!card.isConnected) return;
      if (!row || row.slow !== true || row.dismissed === true || row.proxy !== "nginx") return;
      if (hostedForge(card)) return;
      if (card.querySelector("[data-slow-cache]")) return;
      var line = document.createElement("p");
      var button = document.createElement("button");
      line.className = "server-slow-line";
      line.setAttribute("data-slow-cache", "1");
      button.type = "button";
      button.className = "server-slow-badge";
      button.textContent = "Server config could be optimized — Copy message for admin";
      button.addEventListener("click", function () {
        var copy = window.flc && window.flc.slowCache && window.flc.slowCache.copy;
        if (typeof copy !== "function") return;
        var previous = button.textContent;
        copy(serverId).then(function (ok) {
          if (ok === false) return;
          button.textContent = "Copied";
          setTimeout(function () { button.textContent = previous; }, 2000);
        }).catch(function () {});
      });
      line.appendChild(button);
      var body = card.querySelector(".server-card-body") || card;
      body.appendChild(line);
    }).catch(function () {});
  }

  function repaintAll() {
    epoch += 1;
    pending = null;
    var cards = document.querySelectorAll(".server-card");
    var i = 0;
    for (i = 0; i < cards.length; i += 1) {
      var old = cards[i].querySelector("[data-slow-cache]");
      if (old && old.parentNode) old.parentNode.removeChild(old);
      paint(cards[i], cards[i].dataset ? cards[i].dataset.serverId : "");
    }
  }

  var onUpdated = window.flc && window.flc.slowCache && window.flc.slowCache.onUpdated;
  if (typeof onUpdated === "function") onUpdated(function () { repaintAll(); });
  window.addEventListener("focus", function () { repaintAll(); });
  window.flcPaintSlowBadge = paint;
})();
