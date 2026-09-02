const DATA_URL = "./data/bike_station_hourly.csv";

const dashboard = document.querySelector("#dashboard");
const totalRidesElement = document.querySelector("#total-rides");
const activeStationsElement = document.querySelector("#active-stations");
const dataStatusElement = document.querySelector("#data-status");
const errorPanel = document.querySelector("#error-panel");
const errorMessage = document.querySelector("#error-message");
const numberFormatter = new Intl.NumberFormat("ko-KR");

function scanCsv(text, onRow) {
  let row = [];
  let field = "";
  let quoted = false;

  const emitRow = () => {
    row.push(field);
    onRow(row);
    row = [];
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      emitRow();
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    emitRow();
  }
}

function aggregateMetrics(csvText) {
  let stationIndex = -1;
  let usageIndex = -1;
  let isHeader = true;
  let totalRides = 0;
  const stationTotals = new Map();

  scanCsv(csvText, (row) => {
    if (isHeader) {
      const headers = row.map((value) => value.replace(/^\uFEFF/, "").trim());
      stationIndex = headers.indexOf("대여소번호");
      usageIndex = headers.indexOf("이용건수");
      isHeader = false;

      if (stationIndex < 0 || usageIndex < 0) {
        throw new Error("필수 열(대여소번호, 이용건수)을 찾을 수 없습니다.");
      }
      return;
    }

    const stationNumber = String(row[stationIndex] ?? "").trim();
    const usageCount = Number(String(row[usageIndex] ?? "").replaceAll(",", "").trim());

    if (!stationNumber || !Number.isFinite(usageCount)) {
      return;
    }

    totalRides += usageCount;
    stationTotals.set(stationNumber, (stationTotals.get(stationNumber) ?? 0) + usageCount);
  });

  const activeStations = [...stationTotals.values()].filter((total) => total > 0).length;
  return { totalRides, activeStations };
}

function animateNumber(element, targetValue) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reduceMotion ? 0 : 850;
  const startTime = performance.now();

  element.classList.remove("skeleton");

  const tick = (currentTime) => {
    const progress = duration === 0 ? 1 : Math.min((currentTime - startTime) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = numberFormatter.format(Math.round(targetValue * eased));

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  };

  requestAnimationFrame(tick);
}

function setStatus(type, label) {
  dataStatusElement.classList.remove("is-ready", "is-error");
  dataStatusElement.classList.add(type);
  dataStatusElement.lastElementChild.textContent = label;
}

async function loadDashboard() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`데이터 요청 실패 (${response.status})`);
    }

    const csvText = await response.text();
    const metrics = aggregateMetrics(csvText);

    if (metrics.totalRides <= 0 || metrics.activeStations <= 0) {
      throw new Error("집계 가능한 이용 기록이 없습니다.");
    }

    animateNumber(totalRidesElement, metrics.totalRides);
    animateNumber(activeStationsElement, metrics.activeStations);
    setStatus("is-ready", "집계 완료");
    dashboard.setAttribute("aria-busy", "false");
  } catch (error) {
    totalRidesElement.classList.remove("skeleton");
    activeStationsElement.classList.remove("skeleton");
    totalRidesElement.textContent = "—";
    activeStationsElement.textContent = "—";
    setStatus("is-error", "데이터 오류");
    dashboard.setAttribute("aria-busy", "false");
    errorMessage.textContent = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    errorPanel.hidden = false;
  }
}

loadDashboard();
