// ==UserScript==
// @name         Torn Restock Companion
// @namespace    local.torn.restock-companion
// @version      1.2.3
// @description  Visible-page foreign-shop alerts and a cash check before planned departures.
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/corvus2606/personal-userscripts/main/Torn-Restock-Companion.user.js
// @updateURL    https://raw.githubusercontent.com/corvus2606/personal-userscripts/main/Torn-Restock-Companion.user.js
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "restock-companion-settings";
  const saved = GM_getValue(STORE_KEY, {});
  const settings = {
    enabled: saved?.enabled !== false,
    hospitalOnly: saved?.hospitalOnly !== false,
    minimum: Number.isInteger(saved?.minimum) && saved.minimum > 0 ? saved.minimum : 1,
    items: Array.isArray(saved?.items) ? saved.items.map(String) : [],
  };
  const readiness = new Map();
  let country = null;
  let pending = null;
  let shopRoot = null;
  let shopObserver = null;
  let choicesKey = "";
  let statusText = "";

  const panel = document.createElement("details");
  panel.id = "torn-restock-companion";
  panel.open = true;
  panel.innerHTML = `
    <summary>Torn Restock Companion</summary>
    <div style="display:flex;flex-wrap:wrap;gap:12px;padding:8px 0">
      <label><input type="checkbox" data-enabled> Alerts enabled</label>
      <label><input type="checkbox" data-hospital> Hospital only</label>
      <label>Minimum stock <input type="number" data-minimum min="1" step="1"
        value="1" style="width:6em"></label>
      <button type="button" data-test>Test notification</button>
    </div>
    <div data-items style="display:flex;flex-wrap:wrap;gap:8px 16px;padding-bottom:8px"></div>
    <div data-status role="status" style="padding-bottom:8px"></div>`;
  const enabledInput = panel.querySelector("[data-enabled]");
  const hospitalInput = panel.querySelector("[data-hospital]");
  const minimumInput = panel.querySelector("[data-minimum]");
  const itemList = panel.querySelector("[data-items]");
  const status = panel.querySelector("[data-status]");
  enabledInput.checked = settings.enabled;
  hospitalInput.checked = settings.hospitalOnly;
  minimumInput.value = String(settings.minimum);

  function persist() {
    GM_setValue(STORE_KEY, settings);
    readiness.clear();
    check();
  }

  enabledInput.addEventListener("change", () => {
    settings.enabled = enabledInput.checked;
    persist();
  });
  hospitalInput.addEventListener("change", () => {
    settings.hospitalOnly = hospitalInput.checked;
    persist();
  });
  minimumInput.addEventListener("change", () => {
    const minimum = Number(minimumInput.value);
    if (!Number.isSafeInteger(minimum) || minimum < 1) {
      minimumInput.value = String(settings.minimum);
      return;
    }
    settings.minimum = minimum;
    persist();
  });

  function notify(text) {
    if (document.visibilityState !== "visible") return;
    try {
      GM_notification({
        title: "Torn Restock Companion",
        text,
        timeout: 25000,
        onclick: () => { window.focus(); },
      });
    } catch (error) {
      console.warn("[Restock Companion] Notification failed", error);
    }
  }

  panel.querySelector("[data-test]").addEventListener("click", () => {
    notify("Test notification. Your browser and OS control notification delivery.");
  });

  function readRows(root) {
    const rows = [];
    for (const form of root.querySelectorAll('form[id^="item-"][id$="-form"]')) {
      const match = /^item-(\d+)-form$/.exec(form.id);
      const row = form.closest("li");
      if (!match || !row) continue;
      const name = row.querySelector('button[aria-controls$="-itemInfoWrapper"]')?.textContent.trim();
      const label = [...row.querySelectorAll("span")]
        .find((span) => span.textContent.trim().toLowerCase() === "stock");
      const quantity = label?.parentElement?.textContent.replace(/stock/i, "").trim();
      const stock = quantity && /^[\d,\s]+$/.test(quantity)
        ? Number(quantity.replace(/[,\s]/g, "")) : NaN;
      if (!name || !Number.isSafeInteger(stock) || stock < 0) continue;
      rows.push({ id: match[1], name, stock });
    }
    return rows;
  }

  function renderChoices(rows) {
    const key = JSON.stringify(rows.map((row) => [row.id, row.name]));
    if (key === choicesKey) return;
    choicesKey = key;
    itemList.replaceChildren();
    for (const row of rows) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = settings.items.includes(row.id);
      input.addEventListener("change", () => {
        settings.items = settings.items.filter((id) => id !== row.id);
        if (input.checked) settings.items.push(row.id);
        persist();
      });
      label.append(input, " " + row.name);
      itemList.append(label);
    }
  }

  function setStatus(text) {
    if (text === statusText) return;
    statusText = text;
    status.textContent = text;
  }

  function check() {
    if (document.visibilityState !== "visible") return;
    const root = document.querySelector("#travel-root");
    if (root !== shopRoot) {
      shopObserver?.disconnect();
      shopRoot = root;
      if (root) {
        shopObserver = new MutationObserver(schedule);
        shopObserver.observe(root, { childList: true, subtree: true, characterData: true });
      }
    }
    const abroad = document.body.dataset.abroad === "true"
      && document.body.dataset.traveling !== "true";
    if (!abroad || !root) {
      panel.hidden = true;
      readiness.clear();
      country = null;
      return;
    }
    if (panel.nextSibling !== root) root.before(panel);
    panel.hidden = false;
    const nextCountry = document.body.dataset.country || "abroad";
    if (country !== nextCountry) {
      country = nextCountry;
      readiness.clear();
    }
    const rows = readRows(root);
    renderChoices(rows);
    if (!settings.enabled) { setStatus("Alerts paused."); return; }
    if (settings.hospitalOnly && document.body.dataset.layout !== "hospital") {
      readiness.clear();
      setStatus("Waiting for hospital.");
      return;
    }
    if (!rows.length) { setStatus("Shop stock unavailable."); return; }
    const selected = rows.filter((row) => settings.items.includes(row.id));
    if (!selected.length) { setStatus("No selected items on this shelf."); return; }
    const restocked = [];
    for (const row of selected) {
      const ready = row.stock >= settings.minimum;
      if (ready && readiness.get(row.id) !== true) restocked.push(row);
      readiness.set(row.id, ready);
    }
    if (restocked.length && !document.hasFocus()) {
      notify(restocked.map((row) => row.name + ": " + row.stock.toLocaleString() + " in stock").join("; "));
    }
    setStatus(selected.map((row) => row.name + ": " + row.stock.toLocaleString()).join(" | "));
  }

  function schedule() {
    if (document.visibilityState !== "visible") {
      clearTimeout(pending);
      pending = null;
      return;
    }
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      check();
    }, 250);
  }

  function parseCash(text) {
    const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*$/.exec(String(text || "").trim());
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ""));
    return Number.isSafeInteger(amount) ? amount : null;
  }

  function walletCash() {
    const money = document.querySelector("#user-money");
    if (!money) return null;
    const exact = money.getAttribute("data-money");
    return exact !== null ? parseCash(exact) : parseCash(money.textContent);
  }

  function flightFare(button) {
    const confirmation = button.closest('[class*="departPanel___"]');
    if (!confirmation) return null;
    const fares = [...confirmation.querySelectorAll("p strong")]
      .map((node) => node.textContent.trim())
      .filter((text) => text.startsWith("$"))
      .map(parseCash);
    const distinct = [...new Set(fares)];
    return distinct.length === 1 ? distinct[0] : null;
  }

  function readOracleTrip() {
    let trip = null;
    try { trip = GM_getValue("oracle:trip", null); } catch {}
    if (typeof trip === "string") {
      try { trip = JSON.parse(trip); } catch { trip = null; }
    }
    if (!trip && typeof window.localStorage === "object") {
      try {
        const raw = window.localStorage.getItem("oracle:trip");
        trip = raw ? JSON.parse(raw) : null;
      } catch {}
    }
    return trip && typeof trip === "object" ? trip : null;
  }

  function nextPurchase() {
    const trip = readOracleTrip();
    if (trip?.active && Array.isArray(trip.legs) && Array.isArray(trip.runtime)) {
      const index = trip.runtime.findIndex((runtime) => runtime?.status === "pending");
      const runtime = trip.runtime[index];
      const leg = trip.legs[index];
      if (runtime?.status === "pending" && leg) {
        const units = Number(leg.units);
        const unitCost = Number(leg.unit_cost);
        const required = units * unitCost;
        if (Number.isSafeInteger(units) && units > 0
          && Number.isFinite(unitCost) && unitCost > 0
          && Number.isSafeInteger(Math.ceil(required))) {
          return {
            units,
            name: String(leg.item_name || "items"),
            required: Math.ceil(required),
          };
        }
      }
    }
    return null;
  }

  function guardTravel(event) {
    const button = event.target instanceof Element
      ? event.target.closest("#travel-root button, button.torn-btn")
      : null;
    if (!button || button.disabled || button.textContent.trim().toLowerCase() !== "travel") return;
    if (document.body.dataset.abroad === "true" || document.body.dataset.traveling === "true") return;
    const purchase = nextPurchase();
    const cash = walletCash();
    const fare = flightFare(button);
    const total = purchase && fare !== null ? purchase.required + fare : null;
    let warning = "";
    if (!purchase) {
      warning = "Oracle's exact next-trip purchase cost could not be read. "
        + "Open Oracle's Plan tab, check or refresh the plan, then try again.";
    } else if (cash === null) {
      warning = "Your current cash balance could not be read. "
        + "Refresh Torn and check your cash before trying again.";
    } else if (fare === null || !Number.isSafeInteger(total)) {
      warning = "The selected flight's fare could not be read reliably. "
        + "Check the travel confirmation and try again.";
    } else if (cash < total) {
      const money = (amount) => "$" + amount.toLocaleString("en-US");
      warning = "Oracle's exact Take amount: " + money(purchase.required) + " for "
        + purchase.units + " x " + purchase.name + ".\nFlight fare: " + money(fare)
        + ".\nTotal needed: " + money(total) + ".\nYou have " + money(cash)
        + ". You need another " + money(total - cash) + ".";
    }
    if (!warning) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.alert("Travel blocked\n\n" + warning);
  }

  window.addEventListener("click", guardTravel, true);

  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-abroad", "data-traveling", "data-country", "data-layout"],
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  window.addEventListener("pageshow", schedule);
  setInterval(check, 5000);
  check();
})();
