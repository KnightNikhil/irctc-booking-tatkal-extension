const CLASS_OPTIONS = [
  ["", "No fallback"],
  ["SL", "Sleeper (SL)"],
  ["3A", "AC 3 Tier (3A)"],
  ["2A", "AC 2 Tier (2A)"],
  ["1A", "AC First Class (1A)"],
  ["CC", "AC Chair Car (CC)"],
  ["EC", "Exec. Chair Car (EC)"],
  ["2S", "Second Sitting (2S)"]
];

const BERTH_OPTIONS = [
  ["", "No preference"],
  ["LB", "Lower"],
  ["MB", "Middle"],
  ["UB", "Upper"],
  ["SL", "Side Lower"],
  ["SU", "Side Upper"]
];

const GENDER_OPTIONS = [
  ["M", "Male"],
  ["F", "Female"],
  ["T", "Transgender"]
];

const DEFAULT_PASSENGERS = [
  { name: "Nikhil", age: 27, gender: "M", berthPreference: "" }
];

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
  passengers: DEFAULT_PASSENGERS,
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

const CONTENT_VERSION = "0.11.2";
const SIMPLE_IDS = [
  "fromStation",
  "fromCode",
  "toStation",
  "toCode",
  "journeyDate",
  "trainNumber",
  "quota",
  "preferredClass",
  "username",
  "scheduledContinueTime",
  "bookOnlyConfirmed",
  "noInsurance",
  "disableUpgrade",
  "preferUpi",
  "retryEnabled",
  "maxAttempts",
  "minDelaySeconds",
  "maxDelaySeconds"
];
const FALLBACK_IDS = ["fallbackClass1", "fallbackClass2", "fallbackClass3"];
const PASSENGER_LIMIT = 4;
const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function field(id) {
  return document.getElementById(id);
}

function readForm() {
  const data = {};
  for (const id of SIMPLE_IDS) {
    const el = field(id);
    if (!el) continue;
    if (el.type === "checkbox") {
      data[id] = el.checked;
    } else if (el.type === "number") {
      data[id] = Number(el.value);
    } else {
      data[id] = el.value.trim();
    }
  }

  data.maxAttempts = clamp(data.maxAttempts, 1, 50);
  data.minDelaySeconds = clamp(data.minDelaySeconds, 10, 300);
  data.maxDelaySeconds = clamp(data.maxDelaySeconds, data.minDelaySeconds, 600);
  data.preferredClass = normalizeClassCode(data.preferredClass);
  data.classOrder = readFallbackClassOrder();
  data.trainNumber = normalizeTrainNumber(data.trainNumber);
  data.scheduledContinueTime = normalizeTime(data.scheduledContinueTime);
  data.passengers = readPassengers();

  const first = data.passengers[0] || DEFAULT_PASSENGERS[0];
  data.passengerName = first.name;
  data.passengerAge = first.age;
  data.passengerGender = first.gender;
  data.berthPreference = first.berthPreference;
  return data;
}

function writeForm(data) {
  const normalized = {
    ...DEFAULTS,
    ...data,
    preferredClass: normalizeClassCode(data.preferredClass),
    classOrder: normalizeClassOrder(data.classOrder),
    scheduledContinueTime: normalizeTime(data.scheduledContinueTime),
    passengers: normalizePassengers(data)
  };

  for (const id of SIMPLE_IDS) {
    const el = field(id);
    if (!el) continue;
    const value = normalized[id] ?? DEFAULTS[id];
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = value;
    }
  }

  writeFallbackClassOrder(normalized.classOrder);
  writePassengers(normalized.passengers);
}

function clamp(value, min, max) {
  const number = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, number));
}

function normalizeClassOrder(value) {
  const known = new Set(CLASS_OPTIONS.map(([code]) => code).filter(Boolean));
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => known.has(item));
  return unique(items).join(",") || DEFAULTS.classOrder;
}

function readFallbackClassOrder() {
  const items = FALLBACK_IDS
    .map((id) => normalizeClassCode(field(id)?.value))
    .filter(Boolean);
  return unique(items).join(",") || DEFAULTS.classOrder;
}

function writeFallbackClassOrder(value) {
  const order = normalizeClassOrder(value).split(",");
  FALLBACK_IDS.forEach((id, index) => {
    const el = field(id);
    if (el) el.value = order[index] || "";
  });
}

function normalizeClassCode(value) {
  const known = new Set(CLASS_OPTIONS.map(([code]) => code).filter(Boolean));
  const code = String(value || "").trim().toUpperCase();
  return known.has(code) ? code : "";
}

function normalizeTrainNumber(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "";
  const hours = clamp(Number(match[1]), 0, 23);
  const minutes = clamp(Number(match[2]), 0, 59);
  const seconds = clamp(Number(match[3] || 0), 0, 59);
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function readPassengers() {
  const passengers = [];
  for (let index = 1; index <= PASSENGER_LIMIT; index += 1) {
    const name = field(`passenger${index}Name`)?.value.trim() || "";
    const ageValue = field(`passenger${index}Age`)?.value;
    if (!name && !ageValue) continue;

    passengers.push({
      name,
      age: clamp(Number(ageValue), 1, 120),
      gender: normalizeGender(field(`passenger${index}Gender`)?.value),
      berthPreference: normalizeBerth(field(`passenger${index}Berth`)?.value)
    });
  }

  return passengers.length ? passengers : DEFAULT_PASSENGERS;
}

function writePassengers(passengers) {
  const normalized = normalizePassengers({ passengers });
  for (let index = 1; index <= PASSENGER_LIMIT; index += 1) {
    const passenger = normalized[index - 1] || {};
    field(`passenger${index}Name`).value = passenger.name || "";
    field(`passenger${index}Age`).value = passenger.age || "";
    field(`passenger${index}Gender`).value = passenger.gender || "M";
    field(`passenger${index}Berth`).value = passenger.berthPreference || "";
  }
}

function normalizePassengers(data) {
  const source = Array.isArray(data?.passengers) && data.passengers.length
    ? data.passengers
    : [{
      name: data?.passengerName || DEFAULT_PASSENGERS[0].name,
      age: data?.passengerAge || DEFAULT_PASSENGERS[0].age,
      gender: data?.passengerGender || DEFAULT_PASSENGERS[0].gender,
      berthPreference: data?.berthPreference || DEFAULT_PASSENGERS[0].berthPreference
    }];

  return source
    .slice(0, PASSENGER_LIMIT)
    .map((passenger) => ({
      name: String(passenger.name || "").trim(),
      age: clamp(Number(passenger.age), 1, 120),
      gender: normalizeGender(passenger.gender),
      berthPreference: normalizeBerth(passenger.berthPreference)
    }))
    .filter((passenger) => passenger.name);
}

function normalizeGender(value) {
  const code = String(value || "M").trim().toUpperCase();
  return GENDER_OPTIONS.some(([option]) => option === code) ? code : "M";
}

function normalizeBerth(value) {
  const code = String(value || "").trim().toUpperCase();
  return BERTH_OPTIONS.some(([option]) => option === code) ? code : "";
}

function unique(items) {
  return [...new Set(items)];
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  writeForm(saved);
}

async function saveSettings(options = {}) {
  const data = readForm();
  await chrome.storage.sync.set(data);
  if (options.syncToPage) {
    await syncSettingsToIrctcTab(data);
  }
  setStatus("Saved.");
  return data;
}

async function syncSettingsToIrctcTab(data) {
  const tab = await findIrctcTab();
  if (!tab?.id) return;
  await sendTabMessage(tab.id, { type: "IRCTC_SYNC_CONFIG", payload: data });
}

async function sendToActiveTab(type) {
  const data = await saveSettings();
  if (type === "IRCTC_START_ASSIST" && !data.trainNumber) {
    field("trainNumber").focus();
    setStatus("Enter the train number before starting assist.");
    return;
  }
  if (type === "IRCTC_SCHEDULE_CONTINUE" && !data.scheduledContinueTime) {
    field("scheduledContinueTime").focus();
    setStatus("Enter an IST time, then click Schedule.");
    return;
  }

  const tab = await findIrctcTab();
  if (!tab?.id) {
    setStatus("Open an IRCTC tab, then try again.");
    return;
  }

  await focusTab(tab);
  if (type === "IRCTC_START_ASSIST" ||
    type === "IRCTC_FILL_SEARCH" ||
    type === "IRCTC_CONTINUE_ASSIST" ||
    type === "IRCTC_SCHEDULE_CONTINUE") {
    await ensureFreshContent(tab.id);
  }
  sendMessageToTab(tab.id, type, data);
}

async function findIrctcTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isIrctcTab(active)) return active;

  const irctcTabs = await chrome.tabs.query({
    url: ["https://www.irctc.co.in/*", "https://irctc.co.in/*"]
  });
  return irctcTabs.find((tab) => tab.active) || irctcTabs.at(-1) || null;
}

function isIrctcTab(tab) {
  return Boolean(tab?.url && /^https:\/\/(www\.)?irctc\.co\.in\//i.test(tab.url));
}

async function focusTab(tab) {
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await chrome.tabs.update(tab.id, { active: true });
}

function sendMessageToTab(tabId, type, data) {
  chrome.tabs.sendMessage(tabId, { type, payload: data }, (response) => {
    const error = chrome.runtime.lastError;
    if (error) {
      injectAndSend(tabId, type, data);
      return;
    }
    setStatus(response?.message || "Sent to IRCTC tab.");
  });
}

async function ensureFreshContent(tabId) {
  const response = await sendTabMessage(tabId, { type: "IRCTC_VERSION" });
  if (response?.version === CONTENT_VERSION) return;

  if (!response) {
    setStatus("Loading latest assistant into IRCTC tab...");
    await executeContentScript(tabId);
    return;
  }

  setStatus("Refreshing IRCTC tab to load the latest assistant...");
  await reloadTabAndWait(tabId);
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function reloadTabAndWait(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      window.setTimeout(resolve, 700);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
    window.setTimeout(finish, 15000);
  });
}

function injectAndSend(tabId, type, data) {
  executeContentScript(tabId).then(() => {
    chrome.tabs.sendMessage(tabId, { type, payload: data }, (response) => {
      const messageError = chrome.runtime.lastError;
      if (messageError) {
        setStatus("Open an IRCTC tab, then try again.");
        return;
      }
      setStatus(response?.message || "Sent to IRCTC tab.");
    });
  }).catch(() => {
    setStatus("Open an IRCTC tab, then try again.");
  });
}

function executeContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      const injectionError = chrome.runtime.lastError;
      if (injectionError) {
        reject(injectionError);
        return;
      }

      resolve();
    });
  });
}

function populateSelect(select, options) {
  select.innerHTML = "";
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

function renderPassengerRows() {
  const root = document.getElementById("passengerRows");
  root.innerHTML = "";
  for (let index = 1; index <= PASSENGER_LIMIT; index += 1) {
    const row = document.createElement("div");
    row.className = "passenger-row";
    row.innerHTML = `
      <label>
        Name
        <input id="passenger${index}Name" autocomplete="name">
      </label>
      <label>
        Age
        <input id="passenger${index}Age" type="number" min="1" max="120">
      </label>
      <label>
        Gender
        <select id="passenger${index}Gender"></select>
      </label>
      <label>
        Berth
        <select id="passenger${index}Berth"></select>
      </label>
    `;
    root.appendChild(row);
    populateSelect(field(`passenger${index}Gender`), GENDER_OPTIONS);
    populateSelect(field(`passenger${index}Berth`), BERTH_OPTIONS);
  }
}

function renderClassFallbacks() {
  for (const id of FALLBACK_IDS) {
    populateSelect(field(id), CLASS_OPTIONS);
  }
}

function updateIstClock() {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const clock = field("istClock");
  if (clock) clock.textContent = `IST ${formatter.format(new Date())}`;
}

renderPassengerRows();
renderClassFallbacks();
updateIstClock();
window.setInterval(updateIstClock, 1000);

document.getElementById("save").addEventListener("click", () => saveSettings({ syncToPage: true }));
document.getElementById("fillSearch").addEventListener("click", () => sendToActiveTab("IRCTC_FILL_SEARCH"));
document.getElementById("startAssist").addEventListener("click", () => sendToActiveTab("IRCTC_START_ASSIST"));
document.getElementById("scheduleAssist").addEventListener("click", () => sendToActiveTab("IRCTC_SCHEDULE_CONTINUE"));
document.getElementById("continueAssist").addEventListener("click", () => sendToActiveTab("IRCTC_CONTINUE_ASSIST"));
document.getElementById("stopAssist").addEventListener("click", () => sendToActiveTab("IRCTC_STOP_ASSIST"));

loadSettings().catch((error) => setStatus(error.message));
