(function () {
  "use strict";

  const CONTENT_VERSION = "0.11.2";
  const LOAD_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const DEFAULTS = {
    fromStation: "PUNE JN. - PUNE (PUNE)",
    fromCode: "PUNE",
    toStation: "RATLAM JN. - RTM",
    toCode: "RTM",
    journeyDate: "2026-11-21",
    trainNumber: "",
    quota: "GENERAL",
    preferredClass: "",
    classOrder: "SL,3A,2A,1A",
    passengers: [
      { name: "Nikhil", age: 27, gender: "M", berthPreference: "" }
    ],
    passengerName: "Nikhil",
    passengerAge: 27,
    passengerGender: "M",
    berthPreference: "",
    username: "NLaddha109",
    scheduledContinueTime: "",
    bookOnlyConfirmed: true,
    noInsurance: true,
    disableUpgrade: true,
    preferUpi: true,
    retryEnabled: true,
    maxAttempts: 20,
    minDelaySeconds: 15,
    maxDelaySeconds: 120
  };
  const STATE = {
    running: false,
    config: null,
    attempt: 0,
    timer: null,
    submitLock: null,
    scheduleArmed: false,
    scheduledContinueDone: false,
    status: "Idle"
  };

  const CLASS_NAMES = {
    SL: "Sleeper (SL)",
    "3A": "AC 3 Tier (3A)",
    "2A": "AC 2 Tier (2A)",
    "1A": "AC First Class (1A)",
    CC: "AC Chair car (CC)",
    EC: "Exec. Chair Car (EC)",
    "2S": "Second Sitting (2S)"
  };
  const FLOW_SUBMIT_LOCK_MS = 90000;
  const PASSENGER_LIMIT = 4;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message?.type;
    const payload = message?.payload;

    if (type === "IRCTC_VERSION") {
      sendResponse({ ok: true, version: CONTENT_VERSION });
      return true;
    }

    if (type === "IRCTC_STOP_ASSIST") {
      stop("Stopped by user.");
      sendResponse({ ok: true, message: STATE.status });
      return true;
    }

    if (payload) {
      STATE.config = normalizeConfig(payload);
      syncPanelControls();
    }

    if (type === "IRCTC_SYNC_CONFIG") {
      STATE.scheduleArmed = false;
      STATE.scheduledContinueDone = false;
      setStatus("Settings synced.");
      sendResponse({ ok: true, message: STATE.status });
      return true;
    }

    if (type === "IRCTC_FILL_SEARCH") {
      runOnce(fillSearchPage)
        .then(() => sendResponse({ ok: true, message: "Search form filled." }))
        .catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }

    if (type === "IRCTC_SCHEDULE_CONTINUE") {
      STATE.running = true;
      STATE.attempt = 0;
      STATE.submitLock = null;
      STATE.scheduleArmed = true;
      STATE.scheduledContinueDone = false;
      scheduleAssistAtTime()
        .catch((error) => setStatus(error.message));
      sendResponse({ ok: true, message: STATE.status });
      return true;
    }

    if (type === "IRCTC_START_ASSIST" || type === "IRCTC_CONTINUE_ASSIST") {
      STATE.running = true;
      STATE.attempt = 0;
      STATE.scheduleArmed = false;
      if (type === "IRCTC_START_ASSIST") {
        STATE.scheduledContinueDone = false;
      }
      if (type === "IRCTC_CONTINUE_ASSIST" && !isRequestUnderProcess()) {
        STATE.submitLock = null;
      }
      runAssist()
        .then(() => sendResponse({ ok: true, message: STATE.status }))
        .catch((error) => {
          setStatus(error.message);
          sendResponse({ ok: false, message: error.message });
        });
      return true;
    }

    sendResponse({ ok: false, message: "Unknown action." });
    return true;
  });

  bootPanel();

  function normalizeConfig(raw) {
    return {
      ...raw,
      trainNumber: normalizeTrainNumber(raw.trainNumber),
      preferredClass: normalizeClassCode(raw.preferredClass),
      classOrder: effectiveClassOrder(raw),
      passengers: normalizePassengers(raw),
      scheduledContinueTime: normalizeTime(raw.scheduledContinueTime),
      maxAttempts: clamp(Number(raw.maxAttempts), 1, 50),
      minDelaySeconds: clamp(Number(raw.minDelaySeconds), 10, 300),
      maxDelaySeconds: clamp(Number(raw.maxDelaySeconds), Number(raw.minDelaySeconds) || 10, 600)
    };
  }

  function clamp(value, min, max) {
    const safe = Number.isFinite(value) ? value : min;
    return Math.max(min, Math.min(max, safe));
  }

  function normalizeTrainNumber(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 5);
  }

  function normalizeClassCode(value) {
    const code = String(value || "").trim().toUpperCase();
    return CLASS_NAMES[code] ? code : "";
  }

  function effectiveClassOrder(raw) {
    const known = new Set(Object.keys(CLASS_NAMES));
    const preferred = normalizeClassCode(raw.preferredClass);
    const order = String(raw.classOrder || "SL,3A,2A,1A")
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter((item) => known.has(item));

    const combined = unique(preferred ? [preferred, ...order] : order).slice(0, 4);
    return combined.length ? combined : ["SL", "3A", "2A", "1A"];
  }

  function normalizePassengers(raw) {
    const source = Array.isArray(raw.passengers) && raw.passengers.length
      ? raw.passengers
      : [{
        name: raw.passengerName || DEFAULTS.passengerName,
        age: raw.passengerAge || DEFAULTS.passengerAge,
        gender: raw.passengerGender || DEFAULTS.passengerGender,
        berthPreference: raw.berthPreference || DEFAULTS.berthPreference
      }];

    const passengers = source
      .slice(0, PASSENGER_LIMIT)
      .map((passenger) => ({
        name: String(passenger.name || "").trim(),
        age: clamp(Number(passenger.age), 1, 120),
        gender: normalizeGender(passenger.gender),
        berthPreference: normalizeBerth(passenger.berthPreference)
      }))
      .filter((passenger) => passenger.name);

    return passengers.length ? passengers : DEFAULTS.passengers;
  }

  function normalizeGender(value) {
    const code = String(value || "M").trim().toUpperCase();
    return ["M", "F", "T"].includes(code) ? code : "M";
  }

  function normalizeBerth(value) {
    const code = String(value || "").trim().toUpperCase();
    return ["", "LB", "MB", "UB", "SL", "SU"].includes(code) ? code : "";
  }

  function normalizeTime(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return "";
    const hours = clamp(Number(match[1]), 0, 23);
    const minutes = clamp(Number(match[2]), 0, 59);
    const seconds = clamp(Number(match[3] || 0), 0, 59);
    return [hours, minutes, seconds].map((part) => pad(part)).join(":");
  }

  function unique(items) {
    return [...new Set(items.filter(Boolean))];
  }

  async function bootPanel() {
    try {
      STATE.config = await loadStoredConfig();
      showPanel();
      syncPanelControls();
      setStatus(STATE.config.trainNumber ? "Ready." : "Enter train number, then start assist.");
    } catch (error) {
      setStatus(error.message);
    }
  }

  function loadStoredConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (saved) => resolve(normalizeConfig(saved)));
    });
  }

  function saveStoredConfig(values) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(values, resolve);
    });
  }

  async function configFromPanel() {
    const saved = await loadStoredConfig();
    const trainInput = document.getElementById("irctc-assist-train");
    const classSelect = document.getElementById("irctc-assist-class");
    const timeInput = document.getElementById("irctc-assist-time");
    const panelTrainNumber = normalizeTrainNumber(trainInput?.value);
    const panelPreferredClass = normalizeClassCode(classSelect?.value);
    const panelScheduledTime = normalizeTime(timeInput?.value);
    const hasPanelTimeInput = Boolean(timeInput);
    const savedScheduledTime = normalizeTime(saved.scheduledContinueTime);
    const lastSyncedScheduledTime = timeInput?.dataset.syncedValue || "";
    const panelTimeWasEdited = hasPanelTimeInput && timeInput.value !== lastSyncedScheduledTime;
    const scheduledContinueTime = panelTimeWasEdited ? panelScheduledTime : savedScheduledTime;
    const config = normalizeConfig({
      ...saved,
      trainNumber: panelTrainNumber || saved.trainNumber,
      preferredClass: panelPreferredClass || saved.preferredClass,
      scheduledContinueTime
    });

    const updates = {};
    if (panelTrainNumber && panelTrainNumber !== saved.trainNumber) {
      updates.trainNumber = panelTrainNumber;
    }
    if (panelPreferredClass && panelPreferredClass !== saved.preferredClass) {
      updates.preferredClass = panelPreferredClass;
    }
    if (panelTimeWasEdited && panelScheduledTime !== savedScheduledTime) {
      updates.scheduledContinueTime = panelScheduledTime;
    }
    if (Object.keys(updates).length) {
      await saveStoredConfig(updates);
    }

    STATE.config = config;
    syncPanelControls();
    return config;
  }

  function syncPanelControls() {
    const input = document.getElementById("irctc-assist-train");
    if (input && STATE.config?.trainNumber && input.value !== STATE.config.trainNumber) {
      input.value = STATE.config.trainNumber;
    }

    const classSelect = document.getElementById("irctc-assist-class");
    if (classSelect && classSelect.value !== (STATE.config?.preferredClass || "")) {
      classSelect.value = STATE.config?.preferredClass || "";
    }

    const timeInput = document.getElementById("irctc-assist-time");
    if (timeInput) {
      const scheduledTime = STATE.config?.scheduledContinueTime || "";
      if (timeInput.value !== scheduledTime) {
        timeInput.value = scheduledTime;
      }
      timeInput.dataset.syncedValue = scheduledTime;
    }
  }

  async function startFromPanel(mode) {
    try {
      await configFromPanel();
      if (mode === "start" && !STATE.config.trainNumber) {
        setStatus("Enter train number before starting assist.");
        document.getElementById("irctc-assist-train")?.focus();
        return;
      }

      if (mode === "fill") {
        await runOnce(fillSearchPage);
        return;
      }

      if (mode === "schedule") {
        STATE.running = true;
        STATE.attempt = 0;
        STATE.submitLock = null;
        STATE.scheduleArmed = true;
        STATE.scheduledContinueDone = false;
        await scheduleAssistAtTime();
        return;
      }

      STATE.running = true;
      STATE.attempt = 0;
      STATE.scheduleArmed = false;
      if (mode === "start") STATE.scheduledContinueDone = false;
      if (mode === "continue" && !isRequestUnderProcess()) STATE.submitLock = null;
      await runAssist();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function scheduleAssistAtTime() {
    ensureConfig();
    showPanel();
    clearScheduledRetry();

    const scheduledTime = STATE.config.scheduledContinueTime;
    if (!scheduledTime) {
      pause("Enter an IST time, then click Schedule.");
      return;
    }

    const delay = msUntilIstTime(scheduledTime);
    if (delay <= 0) {
      pause(`IST ${scheduledTime} has already passed. Set a future time, then click Schedule.`);
      return;
    }

    STATE.scheduleArmed = true;
    STATE.scheduledContinueDone = false;
    const startedAt = Date.now();
    setStatus(`Schedule armed for IST ${scheduledTime}.`);

    while (STATE.running && STATE.scheduleArmed) {
      const remaining = delay - (Date.now() - startedAt);
      if (remaining <= 0) break;
      setStatus(`Schedule armed for IST ${scheduledTime}. Starts in ${formatRemaining(remaining)}.`);
      await sleep(Math.min(1000, remaining));
    }

    if (!STATE.running || !STATE.scheduleArmed) return;

    STATE.scheduleArmed = false;
    STATE.scheduledContinueDone = true;
    STATE.attempt = 0;
    setStatus(`IST ${scheduledTime} reached. Resuming current page...`);
    await runAssist();
  }

  async function runOnce(fn) {
    ensureConfig();
    showPanel();
    await fn();
  }

  async function runAssist() {
    ensureConfig();
    showPanel();
    clearScheduledRetry();

    while (STATE.running) {
      STATE.attempt += 1;
      setStatus(`Attempt ${STATE.attempt}: checking page...`);

      if (STATE.attempt > STATE.config.maxAttempts) {
        stop(`Stopped after ${STATE.config.maxAttempts} attempts.`);
        return;
      }

      if (isRequestUnderProcess()) {
        pause("IRCTC is still processing the previous request. I stopped to avoid submitting Continue again.");
        return;
      }

      const page = detectPage();
      if (page === "search") {
        await fillSearchPage();
        const moved = await submitSearchAndWait();
        if (!moved) {
          await scheduleRetry("Search did not move to train results.");
          return;
        }
        continue;
      }

      if (page === "trainList") {
        const result = await selectConfirmedTrain();
        if (result === "advanced") {
          continue;
        }
        if (result === "retrying") return;
        if (result === "no-confirmed") {
          stop("No confirmed availability found for the selected date.");
          return;
        }
        if (result === "train-not-found") {
          stop(`Train ${STATE.config.trainNumber} was not found in the visible results.`);
          return;
        }
      }

      if (page === "login") {
        await fillUsername();
        pause("Log in manually first, then click Continue to resume from the current page.");
        return;
      }

      if (page === "passenger") {
        await fillPassengerDetails();
        const advanced = await continueFromPassengerPage();
        if (advanced) continue;
        pause("Passenger details filled. Review, solve any CAPTCHA/OTP if shown, then continue manually.");
        return;
      }

      if (page === "review") {
        const advanced = await continueFromReviewPage();
        if (advanced) continue;
        pause("Review page reached. Continue manually if the page needs your attention.");
        return;
      }

      if (page === "payment") {
        await selectUpiPayment();
        pause("UPI preference selected if available. Review and complete payment manually.");
        return;
      }

      if (isTransientErrorPage()) {
        await scheduleRetry("IRCTC showed a transient error.");
        return;
      }

      pause("Waiting for a recognizable IRCTC booking page.");
      return;
    }
  }

  function ensureConfig() {
    if (!STATE.config) {
      throw new Error("Open the extension popup and save settings first.");
    }
  }

  function detectPage() {
    const url = location.href;
    const text = pageText();

    if (/reviewBooking/i.test(url)) return "review";
    if (/payment/i.test(url)) return "payment";
    if (/train-list/i.test(url) || /Results for/i.test(text)) return "trainList";
    if (/passenger/i.test(url) || /Passenger Details/i.test(text)) return "passenger";
    if (/train-search/i.test(url) || /BOOK TICKET|Search Trains/i.test(text)) return "search";
    if (/login/i.test(url) || /User Name|Password|Captcha/i.test(text)) return "login";
    if (/Payment Method|Payment Options|Make Payment|Amount Payable|Choose Payment|UPI ID|QR Code|Scan.*QR|BHIM UPI/i.test(text)) return "payment";
    return "unknown";
  }

  async function fillSearchPage() {
    setStatus("Filling search form...");
    await dismissStartupDialogs();
    const config = STATE.config;
    const stationInputs = visibleInputs().filter((input) => !looksLikeDateInput(input));
    const fromInput = findInputNearText(/from/i) || stationInputs[0];
    const toInput = findInputNearText(/^to$/i) || stationInputs[1];

    if (!fromInput || !toInput) {
      throw new Error("Could not find From/To station inputs.");
    }

    await chooseAutocomplete(fromInput, config.fromCode || config.fromStation, config.fromStation || config.fromCode);
    await chooseAutocomplete(toInput, config.toCode || config.toStation, config.toStation || config.toCode);
    await setJourneyDate(config.journeyDate);
    await setDropdownChoice(/quota/i, config.quota);
    await setSearchTravelClass(config.preferredClass);
    setStatus("Search form is ready.");
  }

  async function setSearchTravelClass(classCode) {
    const code = normalizeClassCode(classCode);
    if (!code) return false;

    const label = CLASS_NAMES[code] || code;
    return setDropdownChoice(/class|all classes/i, new RegExp(`^(${escapeRegExp(label)}|${escapeRegExp(code)})$`, "i"));
  }

  async function submitSearchAndWait() {
    const beforeUrl = location.href;
    await clickButtonByText(/search trains/i);
    return waitUntil(() => {
      const page = detectPage();
      return page === "trainList" || isTransientErrorPage() || location.href !== beforeUrl;
    }, 25000);
  }

  async function chooseAutocomplete(input, query, expectedText) {
    input.scrollIntoView({ block: "center", inline: "center" });
    input.focus();
    setNativeValue(input, "");
    await sleep(80);
    setNativeValue(input, query);
    await sleep(700);

    const expected = normalize(expectedText || query);
    const queryNorm = normalize(query);
    const options = allVisible(document.querySelectorAll('[role="option"], li, .ui-autocomplete-list-item, .p-autocomplete-item'));
    const match = options.find((option) => {
      const text = normalize(option.innerText || option.textContent || "");
      return text.includes(expected) || text.includes(queryNorm);
    }) || options[0];

    if (match) {
      match.click();
      await sleep(400);
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await sleep(300);
    }
  }

  async function setJourneyDate(value) {
    const dateValue = isoToDisplayDate(value);
    const input = findDateInput();
    if (!input) {
      throw new Error("Could not find journey date input.");
    }

    if (input.closest("p-calendar") || document.querySelector("p-calendar#jDate, #jDate")) {
      const selected = await selectPrimeNgDate(input, value);
      if (selected) return;
    }

    input.scrollIntoView({ block: "center", inline: "center" });
    input.focus();
    setNativeValue(input, dateValue);
    await sleep(150);
    input.blur();
    await sleep(150);

    if (input.value === dateValue) {
      return;
    }

    await selectDateWithPicker(input, value);
  }

  async function selectPrimeNgDate(input, isoDate) {
    const target = parseIsoDate(isoDate);
    input.scrollIntoView({ block: "center", inline: "center" });
    input.click();
    await sleep(300);

    for (let step = 0; step < 18; step += 1) {
      const title = getPrimeNgCalendarTitle();
      if (title && title.month === target.month && title.year === target.year) {
        const day = findPrimeNgCalendarDay(target.day);
        if (!day) return false;
        day.click();
        await sleep(500);
        return true;
      }

      const direction = title && (title.year > target.year || (title.year === target.year && title.month > target.month))
        ? "prev"
        : "next";
      const arrow = document.querySelector(direction === "next" ? ".ui-datepicker-next" : ".ui-datepicker-prev");
      if (!arrow || !isVisible(arrow)) return false;
      arrow.click();
      await sleep(350);
    }

    return false;
  }

  function getPrimeNgCalendarTitle() {
    const title = allVisible(document.querySelectorAll(".ui-datepicker-title"))
      .map((element) => normalize(element.innerText || element.textContent || ""))
      .find(Boolean);
    if (!title) return null;

    const monthNames = "january february march april may june july august september october november december".split(" ");
    const match = title.match(/\b([a-z]+)\s*(20\d{2})\b/);
    if (!match) return null;

    const month = monthNames.indexOf(match[1]) + 1;
    return month > 0 ? { month, year: Number(match[2]) } : null;
  }

  function findPrimeNgCalendarDay(day) {
    return allVisible(document.querySelectorAll(".ui-datepicker-calendar a.ui-state-default"))
      .find((element) => {
        const text = (element.innerText || element.textContent || "").trim();
        const className = String(element.className || "");
        return text === String(day) && !/disabled|other-month/i.test(className);
      });
  }

  async function selectDateWithPicker(input, isoDate) {
    const target = parseIsoDate(isoDate);
    input.click();
    await sleep(300);

    for (let step = 0; step < 18; step += 1) {
      const title = getCalendarTitle();
      if (title && title.month === target.month && title.year === target.year) {
        const day = findCalendarDay(target.day);
        if (!day) break;
        day.click();
        await sleep(300);
        return;
      }

      const direction = title && (title.year > target.year || (title.year === target.year && title.month > target.month))
        ? "prev"
        : "next";
      const arrow = findCalendarArrow(direction);
      if (!arrow) break;
      arrow.click();
      await sleep(250);
    }

    throw new Error("Could not select journey date from calendar.");
  }

  function getCalendarTitle() {
    const monthNames = "january february march april may june july august september october november december".split(" ");
    const candidates = allVisible(document.querySelectorAll("*"));
    for (const element of candidates) {
      const text = normalize(element.innerText || "");
      const match = text.match(/\b([a-z]+)\s*(20\d{2})\b/);
      if (!match) continue;
      const month = monthNames.indexOf(match[1]) + 1;
      if (month > 0) return { month, year: Number(match[2]) };
    }
    return null;
  }

  function findCalendarArrow(direction) {
    const wanted = direction === "next" ? /next|right|forward|/i : /prev|previous|left|back|/i;
    return allVisible(document.querySelectorAll("a, button, span"))
      .find((element) => {
        const descriptor = [
          element.getAttribute("aria-label"),
          element.title,
          element.innerText,
          element.textContent,
          String(element.className || "")
        ].join(" ");
        return wanted.test(descriptor);
      });
  }

  function findCalendarDay(day) {
    const candidates = allVisible(document.querySelectorAll("a, button, td, span"))
      .filter((element) => (element.innerText || element.textContent || "").trim() === String(day));
    return candidates.find((element) => {
      const className = String(element.className || "");
      return /^(A|BUTTON)$/i.test(element.tagName) && !/disabled|other-month/i.test(className);
    }) || candidates.find((element) => !/disabled|other-month/i.test(String(element.className || "")));
  }

  async function setDropdownChoice(labelPattern, value) {
    if (!value) return;
    const text = document.body.innerText || "";
    if (!labelPattern.test(text)) return;
    const matchesValue = (candidate) => value instanceof RegExp
      ? value.test(candidate)
      : normalize(candidate) === normalize(value);

    const target = allVisible(document.querySelectorAll('[role="combobox"], select, .ui-dropdown, .p-dropdown'))
      .find((element) => {
        const around = normalize(textAround(element));
        return labelPattern.test(around) || (!(value instanceof RegExp) && around.includes(normalize(value)));
      });

    if (!target) return;
    target.click();
    await sleep(250);

    const option = allVisible(document.querySelectorAll('[role="option"], li, option, span'))
      .find((element) => matchesValue(element.innerText || element.textContent || ""));
    if (option) option.click();
    await sleep(150);
  }

  async function dismissStartupDialogs() {
    const dialogs = allVisible(document.querySelectorAll('[role="dialog"], .ui-dialog, .p-dialog, .modal'));
    for (const dialog of dialogs) {
      const text = normalize(dialog.innerText || dialog.textContent || "");
      if (!/welcome to irctc|preferred language|select your preferred language/.test(text)) continue;

      const english = findButtonIn(dialog, /english/i);
      if (english) {
        english.click();
        await sleep(700);
        return true;
      }
    }
    return false;
  }

  async function selectConfirmedTrain() {
    const requestedTrain = STATE.config.trainNumber;
    setStatus(`Checking train ${requestedTrain} for confirmed availability...`);
    const allCards = trainCards();
    const cards = requestedTrain
      ? allCards.filter((card) => cardMatchesTrainNumber(card, requestedTrain))
      : allCards;

    if (!cards.length) {
      if (isTransientErrorPage()) {
        await scheduleRetry("No train cards found yet.");
        return "retrying";
      }
      return requestedTrain ? "train-not-found" : "no-confirmed";
    }

    const targetDate = irctcShortDate(STATE.config.journeyDate);
    for (const card of cards) {
      for (const code of STATE.config.classOrder) {
        const classLabel = CLASS_NAMES[code] || code;
        const clicked = await clickClassInCard(card, code, classLabel);
        if (!clicked) continue;

        await waitForAvailability(card, targetDate);
        const availability = findAvailabilityForDate(card, targetDate);
        if (!availability) continue;

        const statusText = availabilityStatusText(availability, targetDate);
        if (isConfirmedStatus(statusText)) {
          const availabilityLabel = cleanText(availability);
          availability.click();
          await sleep(250);
          const bookButton = findButtonIn(card, /book now/i);
          if (!bookButton) throw new Error("Confirmed class found, but Book Now button was not found.");
          const trainLabel = requestedTrain ? `train ${requestedTrain}` : "selected train";
          setStatus(`Selected ${availabilityLabel || "confirmed availability"} for ${classLabel} on ${trainLabel}. Opening booking flow...`);
          bookButton.click();
          await sleep(800);
          await clickNonPaymentContinueIfPresent();
          const advanced = await waitForKnownPage(["login", "passenger", "payment"], 20000);
          if (!advanced) {
            throw new Error("Book Now was clicked, but IRCTC did not advance. Check the visible page for a dialog.");
          }
          return "advanced";
        }
      }
    }

    return "no-confirmed";
  }

  async function clickClassInCard(card, classCode, classLabel) {
    const exact = normalize(classLabel);
    const candidates = allVisible(card.querySelectorAll(".pre-avl, button, a, li, [role='tab'], div, span, strong"))
      .sort((left, right) => cleanText(left).length - cleanText(right).length);
    const label = candidates.find((element) => {
      const text = normalize(element.innerText || element.textContent || "");
      if (!element.matches(".pre-avl, button, a, li, [role='tab']") && text.length > 120) return false;
      return text === exact ||
        text.startsWith(exact + " ") ||
        text.includes(exact + " refresh") ||
        matchesTrainClassText(text, classCode, classLabel);
    });
    if (!label) return false;

    const tile = label.closest(".pre-avl") || label;
    tile.scrollIntoView({ block: "center", inline: "center" });
    const refresh = allVisible(tile.querySelectorAll(".link, button, a, div, span"))
      .find((element) => /^refresh$/i.test((element.innerText || element.textContent || "").trim()));

    (refresh || tile).click();
    await sleep(refresh ? 1200 : 500);
    return true;
  }

  function matchesTrainClassText(text, classCode, classLabel) {
    const normalized = normalize(text);
    const code = normalize(classCode);
    if (!normalized || !code) return false;
    if (normalized === code || normalized.startsWith(`${code} `) || normalized.includes(`(${code})`)) return true;

    const label = normalize(classLabel);
    if (label && (normalized === label || normalized.startsWith(`${label} `))) return true;

    const aliases = {
      SL: [/sleeper/, /\bsl\b/],
      "3A": [/ac\s*3\s*tier/, /\b3a\b/],
      "2A": [/ac\s*2\s*tier/, /\b2a\b/],
      "1A": [/ac\s*first/, /\b1a\b/],
      CC: [/chair\s*car/, /\bcc\b/],
      EC: [/exec.*chair/, /\bec\b/],
      "2S": [/second\s*sitting/, /\b2s\b/]
    };
    return (aliases[classCode] || []).some((pattern) => pattern.test(normalized));
  }

  async function waitForAvailability(card, targetDate) {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (findAvailabilityForDate(card, targetDate)) return;
      await sleep(400);
    }
  }

  function findAvailabilityForDate(card, targetDate) {
    const wanted = normalize(targetDate);
    const preAvailabilityTiles = allVisible(card.querySelectorAll(".pre-avl"))
      .filter((element) => isConfirmedStatus(availabilityStatusText(element, targetDate)));
    const exactTile = preAvailabilityTiles.find((element) => {
      const text = normalize(element.innerText || element.textContent || "");
      return text.includes(wanted);
    });
    if (exactTile) return exactTile;
    if (preAvailabilityTiles.length) return preAvailabilityTiles[0];

    const candidates = allVisible(card.querySelectorAll("div, span, td, button"))
      .filter((element) => {
        const text = normalize(element.innerText || element.textContent || "");
        return text.includes(wanted) && /(available|cnf|rac|wl|regret|not available)/i.test(text);
      });
    return candidates
      .filter((element) => isConfirmedStatus(availabilityStatusText(element, targetDate)))
      .sort((left, right) => cleanText(left).length - cleanText(right).length)[0];
  }

  function availabilityStatusText(element, targetDate) {
    const text = normalize(element.innerText || element.textContent || "");
    const wanted = normalize(targetDate);
    const start = text.indexOf(wanted);
    if (start === -1) return text;

    const afterDate = text.slice(start + wanted.length);
    const nextDate = afterDate.search(/\b(sun|mon|tue|wed|thu|fri|sat),\s+\d{1,2}\s+[a-z]{3}\b/i);
    return nextDate === -1 ? afterDate : afterDate.slice(0, nextDate);
  }

  function isConfirmedStatus(text) {
    if (/(wl|rac|regret|not available|nosb)/i.test(text)) return false;
    return /(available|curr_avbl|cnf)/i.test(text);
  }

  function trainCards() {
    const buttons = allVisible(document.querySelectorAll("button"))
      .filter((button) => /book now/i.test(button.innerText || button.textContent || ""));
    const cards = [];
    for (const button of buttons) {
      let node = button.parentElement;
      while (node && node !== document.body) {
        const text = node.innerText || "";
        if (/runs on/i.test(text) && /book now/i.test(text) && /(sleeper|ac|chair|second sitting)/i.test(text)) {
          cards.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return [...new Set(cards)];
  }

  function cardMatchesTrainNumber(card, trainNumber) {
    const text = card.innerText || card.textContent || "";
    return new RegExp(`\\b${escapeRegExp(trainNumber)}\\b`).test(text);
  }

  async function fillUsername() {
    const username = STATE.config.username;
    if (!username) return;

    const input = visibleInputs().find((candidate) => {
      const label = normalize(textAround(candidate));
      return /user|login/.test(label) && !/password/.test(label);
    }) || visibleInputs()[0];

    if (input) {
      input.focus();
      setNativeValue(input, username);
      setStatus("User ID filled. Enter password and CAPTCHA manually.");
    }
  }

  async function fillPassengerDetails() {
    setStatus("Filling passenger details...");
    const config = STATE.config;
    const passengers = config.passengers.length ? config.passengers : normalizePassengers(config);

    await ensurePassengerRows(passengers.length);
    for (let index = 0; index < passengers.length; index += 1) {
      await fillPassengerRow(index, passengers[index]);
    }

    await fillOtherPreferences(config);
    if (config.preferUpi) await selectBhimUpiPaymentMode();

    setStatus(`${passengers.length} passenger${passengers.length === 1 ? "" : "s"} filled. Review before proceeding.`);
  }

  async function ensurePassengerRows(count) {
    for (let attempt = 0; attempt < count - 1; attempt += 1) {
      if (passengerNameInputs().length >= count) return true;
      const addButton = findAddPassengerButton();
      if (!addButton) return false;
      addButton.scrollIntoView({ block: "center", inline: "center" });
      addButton.click();
      await sleep(500);
    }
    return passengerNameInputs().length >= count;
  }

  function findAddPassengerButton() {
    return allVisible(document.querySelectorAll("button, a, span, div"))
      .filter((element) => !element.closest("#irctc-assist-panel") && !isDisabledControl(element))
      .sort((left, right) => cleanText(left).length - cleanText(right).length)
      .find((element) => /^(\+?\s*)?add passenger$/i.test(cleanText(element)) || /add passenger/i.test(cleanText(element)));
  }

  async function fillPassengerRow(index, passenger) {
    const nameInput = passengerNameInputs()[index] || passengerNameInputs()[0];
    const ageInput = passengerAgeInputs()[index] || passengerAgeInputs()[0];

    if (nameInput) setNativeValue(nameInput, passenger.name);
    if (ageInput) setNativeValue(ageInput, String(passenger.age));

    await setPassengerGender(passenger.gender, index);
    await setPassengerBerth(passenger.berthPreference, index);
  }

  function passengerNameInputs() {
    const direct = allVisible(document.querySelectorAll("input[formcontrolname='passengerName'], input[name*='passengerName' i]"));
    if (direct.length) return direct;
    return visibleInputs().filter((input) => /name/i.test(textAround(input)) && !/infant|nominee|gst/i.test(textAround(input)));
  }

  function passengerAgeInputs() {
    const direct = allVisible(document.querySelectorAll("input[formcontrolname='passengerAge'], input[name*='passengerAge' i]"));
    if (direct.length) return direct;
    return visibleInputs().filter((input) => /age/i.test(textAround(input)) || input.type === "number");
  }

  async function setPassengerGender(value, index = 0) {
    const wanted = String(value || "M").toUpperCase();
    const select = allVisible(document.querySelectorAll("select[formcontrolname='passengerGender'], select[name*='passengerGender' i]"))[index];
    if (select instanceof HTMLSelectElement) {
      const option = Array.from(select.options)
        .find((item) => item.value.toUpperCase() === wanted || normalize(item.textContent || "") === normalize(genderLabel(wanted)));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(150);
        return true;
      }
    }

    return chooseVisibleText(genderText(wanted));
  }

  async function setPassengerBerth(value, index = 0) {
    const wanted = normalizeBerth(value);
    const select = allVisible(document.querySelectorAll([
      "select[formcontrolname='passengerBerthChoice']",
      "select[formcontrolname*='berth' i]",
      "select[name*='berth' i]"
    ].join(", ")))[index];

    if (select instanceof HTMLSelectElement) {
      const pattern = berthText(wanted);
      const option = Array.from(select.options)
        .find((item) => String(item.value || "").toUpperCase() === wanted || pattern.test(item.textContent || ""));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(150);
        return true;
      }
    }

    if (wanted) return chooseVisibleText(berthText(wanted));
    return chooseVisibleText(/no preference/i);
  }

  async function fillOtherPreferences(config) {
    await expandOtherPreferences();

    if (config.disableUpgrade) {
      setCheckboxById("autoUpgradation", false) ||
        setCheckboxNear(/auto.?upgrade|upgradation|consider.*upgrade/i, false);
    }

    if (config.bookOnlyConfirmed) {
      const selected = setCheckboxById("confirmberths", true) ||
        setChoiceNear(/book only if.*confirm|confirmed berth.*allotted|confirm berth.*allotted/i, true);
      if (!selected) {
        await selectDropdownOptionNear(
          /reservation choice|other preference|booking choice|booking option/i,
          /book only if.*confirm|confirmed berth.*allotted|confirm berth.*allotted/i
        );
      }
    }

    if (config.noInsurance) {
      await selectNoTravelInsurance();
    }
  }

  async function expandOtherPreferences() {
    if (/reservation choice|travel insurance|auto.?upgrad|preferred coach/i.test(pageText())) {
      return true;
    }

    const trigger = allVisible(document.querySelectorAll("button, a, [role='button'], div, span, p-panel, p-accordiontab"))
      .find((element) => /^other preferences?$/i.test(cleanText(element)) || /other preferences?/i.test(cleanText(element)));
    if (!trigger) return false;

    const expanded = trigger.getAttribute("aria-expanded");
    if (expanded !== "true") {
      trigger.scrollIntoView({ block: "center", inline: "center" });
      trigger.click();
      await sleep(400);
    }
    return true;
  }

  async function selectUpiPayment() {
    if (!STATE.config.preferUpi) return;
    if (await selectBhimUpiPaymentMode()) {
      setStatus("BHIM/UPI payment mode selected. Complete payment manually.");
      return;
    }
    await chooseVisibleText(/upi|bhim|qr/i);
    setStatus("UPI option selected if it was available. Complete payment manually.");
  }

  async function selectBhimUpiPaymentMode() {
    const control = findBhimUpiPaymentModeControl();
    if (!control) return false;

    clickPrimeRadioControl(control);
    await sleep(300);
    return isPaymentTypeSelected("2");
  }

  function findBhimUpiPaymentModeControl() {
    const direct = document.querySelector([
      "p-radiobutton[name='paymentType'][id='2']",
      "input[type='radio'][name='paymentType'][value='2']"
    ].join(", "));
    if (direct) return direct;

    const section = candidateSections(/payment mode/i)
      .find((candidate) => /pay through bhim\/upi/i.test(cleanText(candidate)));
    if (!section) return null;

    const label = allVisible(section.querySelectorAll("label, span, div, p, strong"))
      .find((element) => /^pay through bhim\/upi$/i.test(cleanText(element)));
    if (!label) return null;

    const row = label.closest("label, .col-xs-12, .form-group, div") || label;
    return row.querySelector([
      "p-radiobutton[name='paymentType']",
      "input[type='radio'][name='paymentType']",
      ".ui-radiobutton-box",
      ".p-radiobutton-box",
      "[role='radio']"
    ].join(", "));
  }

  function clickPrimeRadioControl(control) {
    const target = control.matches?.(".ui-radiobutton-box, .p-radiobutton-box, [role='radio']")
      ? control
      : control.querySelector?.(".ui-radiobutton-box, .p-radiobutton-box, [role='radio'], input[type='radio']") || control;
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
  }

  function isPaymentTypeSelected(value) {
    const input = document.querySelector(`input[type='radio'][name='paymentType'][value='${value}']`);
    if (input?.checked) return true;

    const control = document.querySelector(`p-radiobutton[name='paymentType'][id='${value}']`);
    const radioBox = control?.querySelector(".ui-radiobutton-box, .p-radiobutton-box, [role='radio']");
    return radioBox?.getAttribute("aria-checked") === "true" ||
      /ui-state-active|p-radiobutton-checked|p-highlight/i.test(radioBox?.className || "");
  }

  function setCheckboxNear(pattern, checked) {
    const boxes = allVisible(document.querySelectorAll("input[type='checkbox']"));
    for (const box of boxes) {
      if (!pattern.test(textAround(box)) && !pattern.test(nearestContainerText(box))) continue;
      if (box.checked !== checked) box.click();
      return true;
    }

    const label = allVisible(document.querySelectorAll("label, span, div, p, strong"))
      .find((element) => pattern.test(cleanText(element)));
    const box = label ? findControlNearElement(label, "input[type='checkbox']") : null;
    if (box) {
      if (box.checked !== checked) box.click();
      return true;
    }

    return false;
  }

  function setChoiceNear(pattern, checked) {
    const controls = allVisible(document.querySelectorAll("input[type='checkbox'], input[type='radio']"));
    for (const control of controls) {
      if (!pattern.test(textAround(control)) && !pattern.test(nearestContainerText(control))) continue;
      if (checked && !control.checked) control.click();
      if (!checked && control.checked) control.click();
      return true;
    }
    return false;
  }

  function setCheckboxById(id, checked) {
    const box = document.getElementById(id);
    if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return false;
    if (box.checked !== checked) box.click();
    return true;
  }

  function setRadioByIdPattern(pattern) {
    const candidates = allVisible(document.querySelectorAll("input[type='radio'], [id]"))
      .filter((element) => pattern.test(element.id || ""));
    for (const candidate of candidates) {
      const radio = candidate instanceof HTMLInputElement && candidate.type === "radio"
        ? candidate
        : candidate.querySelector("input[type='radio']");
      if (radio && !radio.checked) radio.click();
      if (!radio) candidate.click();
      return true;
    }
    return false;
  }

  async function selectNoTravelInsurance() {
    const noControl = findTravelInsuranceNoControl();
    if (noControl) {
      clickInsuranceControl(noControl);
      await sleep(300);
      return isNoTravelInsuranceSelected();
    }

    return false;
  }

  function findTravelInsuranceNoControl() {
    const direct = document.querySelector([
      "#travelInsuranceOptedNo-0",
      "[id^='travelInsuranceOptedNo']",
      "p-radiobutton[formcontrolname='travelInsuranceOpted'][value='false']",
      "input[name^='travelInsuranceOpted'][value='false']"
    ].join(", "));
    if (direct) return direct;

    const section = candidateSections(/travel insurance|insurance/i)[0] || document;
    const noLabel = allVisible(section.querySelectorAll("label, span, div, p, strong"))
      .find((element) => /^no,?\s*i\s+do(?:\s+not|n't)\s+want\s+travel\s+insurance$/i.test(cleanText(element)));
    if (!noLabel) return null;

    const row = noLabel.closest("label, .col-sm-6, .col-xs-12, .form-group, div") || noLabel;
    return row.querySelector([
      "p-radiobutton[value='false']",
      "[id^='travelInsuranceOptedNo']",
      "input[type='radio'][value='false']",
      ".ui-radiobutton-box",
      ".p-radiobutton-box",
      "[role='radio']"
    ].join(", "));
  }

  function clickInsuranceControl(control) {
    const target = control.matches?.(".ui-radiobutton-box, .p-radiobutton-box, [role='radio']")
      ? control
      : control.querySelector?.(".ui-radiobutton-box, .p-radiobutton-box, [role='radio'], input[type='radio'][value='false']") || control;
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
  }

  function isNoTravelInsuranceSelected() {
    const noControl = findTravelInsuranceNoControl();
    if (!noControl) return false;

    const radio = noControl instanceof HTMLInputElement && noControl.type === "radio"
      ? noControl
      : noControl.querySelector("input[type='radio']");
    if (radio?.checked) return true;

    const radioBox = noControl.matches?.(".ui-radiobutton-box, .p-radiobutton-box, [role='radio']")
      ? noControl
      : noControl.querySelector(".ui-radiobutton-box, .p-radiobutton-box, [role='radio']");
    if (radioBox?.getAttribute("aria-checked") === "true") return true;

    const descriptor = [
      noControl.getAttribute("class"),
      radioBox?.getAttribute("class")
    ].join(" ");
    return /ui-state-active|p-radiobutton-checked|p-highlight|ui-radiobutton-box\s+ui-state-active/i.test(descriptor);
  }

  async function selectDropdownOptionNear(labelPattern, optionPattern) {
    const dropdowns = allVisible(document.querySelectorAll("select, [role='combobox'], [role='listbox'], .ui-dropdown, .p-dropdown, p-dropdown"))
      .filter((element) => labelPattern.test(textAround(element)) || labelPattern.test(nearestContainerText(element)));

    for (const dropdown of dropdowns) {
      if (dropdown instanceof HTMLSelectElement) {
        const option = Array.from(dropdown.options)
          .find((item) => optionPattern.test(item.textContent || ""));
        if (option) {
          dropdown.value = option.value;
          dropdown.dispatchEvent(new Event("input", { bubbles: true }));
          dropdown.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }

      dropdown.scrollIntoView({ block: "center", inline: "center" });
      dropdown.click();
      await sleep(250);

      const option = allVisible(document.querySelectorAll("[role='option'], .ui-dropdown-item, .p-dropdown-item, li, option, span"))
        .find((element) => optionPattern.test(cleanText(element)));
      if (option) {
        option.click();
        await sleep(250);
        return true;
      }
    }

    return false;
  }

  function setRadioChoiceInSection(sectionPattern, choicePattern) {
    const sections = candidateSections(sectionPattern);
    for (const section of sections) {
      const radios = allVisible(section.querySelectorAll("input[type='radio']"));
      for (const radio of radios) {
        if (!choicePattern.test(textAround(radio)) && !choicePattern.test(nearestContainerText(radio))) continue;
        if (!radio.checked) radio.click();
        return true;
      }

      const label = allVisible(section.querySelectorAll("label, span, div, button"))
        .find((element) => choicePattern.test(cleanText(element)));
      const radio = label ? findControlNearElement(label, "input[type='radio']") : null;
      if (radio) {
        if (!radio.checked) radio.click();
        return true;
      }
      if (label && /^(LABEL|BUTTON)$/i.test(label.tagName)) {
        label.click();
        return true;
      }
    }

    return false;
  }

  function candidateSections(pattern) {
    const sections = allVisible(document.querySelectorAll("fieldset, section, form, p-panel, p-accordiontab, .ui-panel, .ui-accordion-content, div"))
      .filter((element) => pattern.test(cleanText(element)));
    return sections.sort((left, right) => cleanText(left).length - cleanText(right).length);
  }

  function findControlNearElement(element, selector) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const direct = allVisible(node.querySelectorAll(selector))[0];
      if (direct) return direct;
    }
    return null;
  }

  async function chooseVisibleText(patternOrText) {
    const pattern = patternOrText instanceof RegExp ? patternOrText : new RegExp(escapeRegExp(patternOrText), "i");
    const target = allVisible(document.querySelectorAll("button, a, li, span, label, div, select, option"))
      .find((element) => pattern.test(element.innerText || element.textContent || ""));
    if (target) {
      target.click();
      await sleep(250);
      return true;
    }
    return false;
  }

  function genderText(value) {
    if (value === "F") return /^female$/i;
    if (value === "T") return /^(transgender|trans)$/i;
    return /^male$/i;
  }

  function genderLabel(value) {
    if (value === "F") return "Female";
    if (value === "T") return "Transgender";
    return "Male";
  }

  function berthText(value) {
    const map = {
      LB: /lower/i,
      MB: /middle/i,
      UB: /upper/i,
      SL: /side lower/i,
      SU: /side upper/i
    };
    return map[value] || /no preference/i;
  }

  async function clickButtonByText(pattern) {
    const button = findButtonIn(document, pattern);
    if (!button) throw new Error("Button not found.");
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    await sleep(800);
  }

  async function continueFromPassengerPage() {
    return continueBookingFlowOnce(
      "passenger",
      "Passenger details filled. Continuing to review page...",
      ["review", "payment"]
    );
  }

  async function continueFromReviewPage() {
    return continueBookingFlowOnce(
      "review",
      "Review page reached. Continuing to payment page...",
      ["payment"]
    );
  }

  async function continueBookingFlowOnce(pageName, statusMessage, nextPages) {
    if (hasHumanGate()) return false;
    if (isRequestUnderProcess()) {
      pause("IRCTC is still processing the previous request. I stopped to avoid submitting Continue again.");
      return false;
    }
    if (!await waitForScheduledContinue(pageName)) return false;

    const button = findBookingFlowButton(/continue/i);
    if (!button) return false;
    const lockKey = submitLockKey(pageName, button);

    if (hasActiveSubmitLock(lockKey)) {
      setStatus("Continue was already clicked on this page. Waiting for IRCTC to finish...");
      const advanced = await waitForKnownPage(nextPages, 45000, { includeTransient: false });
      if (!advanced && isRequestUnderProcess()) {
        pause("IRCTC is still processing the previous request. I stopped to avoid submitting Continue again.");
      }
      if (!advanced && !isRequestUnderProcess()) {
        STATE.submitLock = null;
      }
      return advanced;
    }

    STATE.submitLock = { key: lockKey, at: Date.now() };
    setStatus(statusMessage);
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    await sleep(900);

    if (isRequestUnderProcess()) {
      pause("IRCTC is still processing the previous request. I stopped to avoid submitting Continue again.");
      return false;
    }

    await clickNonPaymentContinueIfPresent();
    if (isRequestUnderProcess()) {
      pause("IRCTC is still processing the previous request. I stopped to avoid submitting Continue again.");
      return false;
    }

    const advanced = await waitForKnownPage(nextPages, 20000, { includeTransient: false });
    if (!advanced && !isRequestUnderProcess()) {
      STATE.submitLock = null;
    }
    return advanced;
  }

  async function waitForScheduledContinue(pageName) {
    const scheduledTime = STATE.config.scheduledContinueTime;
    if (pageName !== "passenger" || !scheduledTime || !STATE.scheduleArmed || STATE.scheduledContinueDone) return true;

    const delay = msUntilIstTime(scheduledTime);
    if (delay <= 0) {
      STATE.scheduledContinueDone = true;
      setStatus(`IST ${scheduledTime} is due. Clicking Continue...`);
      return true;
    }

    const startedAt = Date.now();
    setStatus(`Timer armed for IST ${scheduledTime}.`);
    while (STATE.running) {
      const remaining = delay - (Date.now() - startedAt);
      if (remaining <= 0) break;
      setStatus(`Waiting for IST ${scheduledTime}. Continue clicks in ${formatRemaining(remaining)}.`);
      await sleep(Math.min(1000, remaining));
    }

    if (!STATE.running) return false;
    STATE.scheduledContinueDone = true;
    setStatus(`IST ${scheduledTime} reached. Clicking Continue...`);
    return true;
  }

  function msUntilIstTime(value) {
    const match = normalizeTime(value).match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return 0;

    const targetSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    const now = istTimeParts();
    const nowSeconds = now.hour * 3600 + now.minute * 60 + now.second;
    return Math.max(0, (targetSeconds - nowSeconds) * 1000);
  }

  function istTimeParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(new Date());

    return {
      hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
      minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
      second: Number(parts.find((part) => part.type === "second")?.value || 0)
    };
  }

  function formatRemaining(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${minutes}:${pad(seconds)}`;
  }

  function submitLockKey(pageName, button) {
    const buttonText = normalize(button.innerText || button.value || button.textContent || "");
    return `${pageName}:${location.pathname}:${buttonText}`;
  }

  function hasActiveSubmitLock(key) {
    return STATE.submitLock?.key === key && Date.now() - STATE.submitLock.at < FLOW_SUBMIT_LOCK_MS;
  }

  function findBookingFlowButton(pattern) {
    const controls = allVisible(document.querySelectorAll("button, input[type='button'], input[type='submit'], a"))
      .filter((element) => !element.closest("#irctc-assist-panel") &&
        !element.closest("footer, #dFooter, .footer, .footer_div") &&
        !isDisabledControl(element));

    return controls.find((element) => {
      const text = (element.innerText || element.value || element.textContent || "").trim();
      const className = String(element.className || "");
      return pattern.test(text) && /train_Search|btnDefault|btn-primary/i.test(className);
    }) || controls.find((element) => {
      const text = (element.innerText || element.value || element.textContent || "").trim();
      return pattern.test(text);
    });
  }

  function hasHumanGate() {
    return /captcha|otp|one time password|verification code|upi pin|enter pin/i.test(pageText());
  }

  function isRequestUnderProcess(text = pageText()) {
    return /your request is under process|do n[o]?t submit multiple request|don not submit multiple request/i.test(normalize(text));
  }

  async function clickNonPaymentContinueIfPresent() {
    const dialogs = allVisible(document.querySelectorAll('[role="dialog"], .modal, .ui-dialog, .swal2-popup, .p-dialog'));
    const scope = dialogs[0];
    if (!scope) return false;

    const scopeText = normalize(scope.innerText || scope.textContent || "");
    if (isRequestUnderProcess(scopeText)) return false;
    if (/payment|upi pin|pay now|make payment|amount payable/.test(scopeText)) return false;

    const button = allVisible(scope.querySelectorAll("button, a, input[type='button'], input[type='submit']"))
      .filter((element) => !isDisabledControl(element))
      .find((element) => /\b(yes|ok|continue|proceed|confirm)\b/i.test((element.innerText || element.value || element.textContent || "").trim()));
    if (!button) return false;

    button.click();
    await sleep(800);
    return true;
  }

  function findButtonIn(root, pattern) {
    return allVisible(root.querySelectorAll("button, input[type='button'], input[type='submit'], a"))
      .find((element) => pattern.test(element.innerText || element.value || element.textContent || ""));
  }

  function isTransientErrorPage() {
    const text = document.body.innerText || "";
    if (isRequestUnderProcess(text)) return false;
    return /please try again|unable to process|temporarily unavailable|too many requests|rate limit|session expired|something went wrong|please wait/i.test(text);
  }

  async function scheduleRetry(reason) {
    if (!STATE.config.retryEnabled) {
      pause(`${reason} Retry is disabled.`);
      return;
    }

    const delay = nextRetryDelay();
    setStatus(`${reason} Retrying in ${Math.round(delay / 1000)}s.`);
    clearScheduledRetry();
    STATE.timer = window.setTimeout(() => {
      STATE.timer = null;
      if (STATE.running) runAssist();
    }, delay);
  }

  function nextRetryDelay() {
    const { minDelaySeconds, maxDelaySeconds } = STATE.config;
    const base = Math.min(maxDelaySeconds, minDelaySeconds * Math.pow(1.45, Math.max(0, STATE.attempt - 1)));
    const jitter = base * (0.1 + Math.random() * 0.2);
    return Math.round((base + jitter) * 1000);
  }

  async function waitForKnownPage(pages, timeoutMs, options = {}) {
    const includeTransient = options.includeTransient !== false;
    return waitUntil(() => pages.includes(detectPage()) || (includeTransient && isTransientErrorPage()), timeoutMs);
  }

  async function waitUntil(predicate, timeoutMs, intervalMs = 350) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  function stop(message) {
    STATE.running = false;
    STATE.scheduleArmed = false;
    clearScheduledRetry();
    setStatus(message);
  }

  function pause(message) {
    STATE.running = false;
    STATE.scheduleArmed = false;
    clearScheduledRetry();
    setStatus(message);
  }

  function clearScheduledRetry() {
    if (STATE.timer) {
      window.clearTimeout(STATE.timer);
      STATE.timer = null;
    }
  }

  function showPanel() {
    const existing = document.getElementById("irctc-assist-panel");
    if (existing?.dataset.owner === LOAD_ID) {
      syncPanelControls();
      return;
    }
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = "irctc-assist-panel";
    panel.dataset.owner = LOAD_ID;
    panel.innerHTML = `
      <strong>IRCTC Assistant</strong>
      <label>
        Train #
        <input id="irctc-assist-train" type="text" inputmode="numeric" maxlength="5" placeholder="e.g. 22943">
      </label>
      <label>
        Class
        <select id="irctc-assist-class">
          <option value="">Use order</option>
          <option value="SL">Sleeper (SL)</option>
          <option value="3A">AC 3 Tier (3A)</option>
          <option value="2A">AC 2 Tier (2A)</option>
          <option value="1A">AC First Class (1A)</option>
          <option value="CC">AC Chair Car (CC)</option>
          <option value="EC">Exec. Chair Car (EC)</option>
          <option value="2S">Second Sitting (2S)</option>
        </select>
      </label>
      <label>
        Auto Continue IST
        <input id="irctc-assist-time" type="time" step="1">
      </label>
      <span id="irctc-assist-status">Idle</span>
      <div>
        <button id="irctc-assist-start" type="button">Start Assist</button>
        <button id="irctc-assist-fill" type="button">Fill Search</button>
        <button id="irctc-assist-schedule" type="button">Schedule</button>
        <button id="irctc-assist-continue" type="button">Continue</button>
        <button id="irctc-assist-stop" type="button">Stop</button>
      </div>
    `;
    const style = document.createElement("style");
    style.textContent = `
      #irctc-assist-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: grid;
        gap: 8px;
        width: 280px;
        padding: 12px;
        color: #16213a;
        background: #fff;
        border: 1px solid #d9dfeb;
        border-radius: 8px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #irctc-assist-panel label {
        display: grid;
        gap: 4px;
        margin: 0;
        font-weight: 700;
      }
      #irctc-assist-panel input,
      #irctc-assist-panel select {
        width: 100%;
        min-height: 30px;
        padding: 5px 8px;
        color: #16213a;
        background: #fff;
        border: 1px solid #d9dfeb;
        border-radius: 6px;
        font: inherit;
      }
      #irctc-assist-panel button {
        margin-top: 6px;
        margin-right: 8px;
        padding: 6px 10px;
        border: 1px solid #203a78;
        border-radius: 6px;
        color: #fff;
        background: #203a78;
        font: inherit;
        font-weight: 700;
      }
      #irctc-assist-stop {
        border-color: #b3261e !important;
        background: #b3261e !important;
      }
      #irctc-assist-status {
        color: #5a6680;
      }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);
    syncPanelControls();
    document.getElementById("irctc-assist-train").addEventListener("input", (event) => {
      event.target.value = normalizeTrainNumber(event.target.value);
    });
    document.getElementById("irctc-assist-class").addEventListener("change", async (event) => {
      const preferredClass = normalizeClassCode(event.target.value);
      STATE.config = normalizeConfig({ ...(STATE.config || DEFAULTS), preferredClass });
      await saveStoredConfig({ preferredClass });
    });
    document.getElementById("irctc-assist-time").addEventListener("change", async (event) => {
      const scheduledContinueTime = normalizeTime(event.target.value);
      event.target.value = scheduledContinueTime;
      STATE.config = normalizeConfig({ ...(STATE.config || DEFAULTS), scheduledContinueTime });
      STATE.scheduledContinueDone = false;
      await saveStoredConfig({ scheduledContinueTime });
    });
    document.getElementById("irctc-assist-start").addEventListener("click", () => startFromPanel("start"));
    document.getElementById("irctc-assist-fill").addEventListener("click", () => startFromPanel("fill"));
    document.getElementById("irctc-assist-schedule").addEventListener("click", () => startFromPanel("schedule"));
    document.getElementById("irctc-assist-stop").addEventListener("click", () => stop("Stopped by user."));
    document.getElementById("irctc-assist-continue").addEventListener("click", () => {
      startFromPanel("continue");
    });
  }

  function setStatus(message) {
    STATE.status = message;
    showPanel();
    const el = document.getElementById("irctc-assist-status");
    if (el) el.textContent = message;
  }

  function visibleInputs() {
    return allVisible(document.querySelectorAll("input, textarea"))
      .filter((input) => !["hidden", "password", "file", "checkbox", "radio"].includes(input.type));
  }

  function findInputNearText(pattern) {
    return visibleInputs().find((input) => pattern.test(textAround(input)));
  }

  function findDateInput() {
    return visibleInputs().find((input) => looksLikeDateInput(input));
  }

  function looksLikeDateInput(input) {
    const text = `${input.type} ${input.placeholder || ""} ${input.value || ""} ${textAround(input)}`;
    return /date|dd\/mm|journey date|\d{2}\/\d{2}\/\d{4}/i.test(text);
  }

  function textAround(element) {
    const pieces = [];
    pieces.push(controlDescriptor(element));
    if (element.labels) {
      for (const label of element.labels) pieces.push(label.innerText || "");
    }
    let node = element.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      pieces.push(node.innerText || "");
    }
    return pieces.join(" ");
  }

  function nearestContainerText(element) {
    const pieces = [controlDescriptor(element)];
    let node = element.parentElement;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      pieces.push(controlDescriptor(node));
      pieces.push(node.innerText || "");
    }
    return pieces.join(" ");
  }

  function controlDescriptor(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("name"),
      element.id,
      element.getAttribute?.("formcontrolname")
    ].filter(Boolean).join(" ");
  }

  function allVisible(nodes) {
    return Array.from(nodes).filter(isVisible);
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabledControl(element) {
    const className = String(element?.className || "");
    return Boolean(element?.disabled) ||
      element?.getAttribute?.("aria-disabled") === "true" ||
      /disabled|ui-state-disabled|p-disabled/i.test(className);
  }

  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isoToDisplayDate(value) {
    const { day, month, year } = parseIsoDate(value);
    return `${pad(day)}/${pad(month)}/${year}`;
  }

  function parseIsoDate(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return { year, month, day };
  }

  function irctcShortDate(value) {
    const { year, month, day } = parseIsoDate(value);
    const date = new Date(year, month - 1, day);
    const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
    const monthName = date.toLocaleDateString("en-US", { month: "short" });
    return `${weekday}, ${day} ${monthName}`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function pageText() {
    const bodyText = document.body.innerText || "";
    const panelText = document.getElementById("irctc-assist-panel")?.innerText || "";
    return panelText ? bodyText.replace(panelText, "") : bodyText;
  }

  function cleanText(element) {
    return String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
