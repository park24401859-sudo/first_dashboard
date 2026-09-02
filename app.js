const DATA_URL = "./data/bike_station_hourly.csv";
const COMMUTE_HOURS = new Set([7, 8, 9, 17, 18, 19]);

const dashboard = document.querySelector("#dashboard");
const totalRidesElement = document.querySelector("#total-rides");
const activeStationsElement = document.querySelector("#active-stations");
const averageRidesElement = document.querySelector("#average-rides");
const weekdaySummaryElement = document.querySelector("#weekday-summary");
const weekendSummaryElement = document.querySelector("#weekend-summary");
const weekdayBarElement = document.querySelector("#weekday-bar");
const weekendBarElement = document.querySelector("#weekend-bar");
const dataStatusElement = document.querySelector("#data-status");
const rankingListElement = document.querySelector("#ranking-list");
const rankingContextElement = document.querySelector("#ranking-context");
const sourceCountElement = document.querySelector("#source-count");
const replayButton = document.querySelector("#replay-button");
const errorPanel = document.querySelector("#error-panel");
const errorMessage = document.querySelector("#error-message");
const tabElements = [...document.querySelectorAll("[data-ranking]")];
const numberFormatter = new Intl.NumberFormat("ko-KR");

let dashboardData = null;
let activeRanking = "total";

const rankingConfig = {
  total: {
    field: "total",
    context: "전체 요일·시간대 이용건수 합계",
  },
  commute: {
    field: "commute",
    context: "평일 출근(07–09시)과 퇴근(17–19시) 이용건수 합계",
  },
  weekend: {
    field: "weekend",
    context: "주말 전체 시간대 이용건수 합계",
  },
};

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

function aggregateData(csvText) {
  let headers = null;
  let rowCount = 0;
  let totalRides = 0;
  let weekdayRides = 0;
  let weekendRides = 0;
  const stations = new Map();

  scanCsv(csvText, (row) => {
    if (!headers) {
      headers = row.map((value) => value.replace(/^\uFEFF/, "").trim());
      const requiredColumns = ["대여소번호", "대여소명", "요일유형", "대여시간", "이용건수"];
      const missingColumns = requiredColumns.filter((column) => !headers.includes(column));

      if (missingColumns.length > 0) {
        throw new Error(`필수 열을 찾을 수 없습니다: ${missingColumns.join(", ")}`);
      }
      return;
    }

    const stationNumber = String(row[headers.indexOf("대여소번호")] ?? "").trim();
    const stationName = String(row[headers.indexOf("대여소명")] ?? "").trim();
    const dayType = String(row[headers.indexOf("요일유형")] ?? "").trim();
    const hour = Number(row[headers.indexOf("대여시간")]);
    const usageCount = Number(String(row[headers.indexOf("이용건수")] ?? "").replaceAll(",", "").trim());

    if (!stationNumber || !Number.isFinite(hour) || !Number.isFinite(usageCount)) {
      return;
    }

    rowCount += 1;
    totalRides += usageCount;

    if (dayType === "평일") {
      weekdayRides += usageCount;
    } else if (dayType === "주말") {
      weekendRides += usageCount;
    }

    if (!stations.has(stationNumber)) {
      stations.set(stationNumber, {
        number: stationNumber,
        name: stationName || `대여소 ${stationNumber}`,
        total: 0,
        commute: 0,
        weekend: 0,
      });
    }

    const station = stations.get(stationNumber);
    station.total += usageCount;

    if (dayType === "평일" && COMMUTE_HOURS.has(hour)) {
      station.commute += usageCount;
    }

    if (dayType === "주말") {
      station.weekend += usageCount;
    }
  });

  const stationList = [...stations.values()].filter((station) => station.total > 0);

  return {
    rowCount,
    totalRides,
    weekdayRides,
    weekendRides,
    activeStations: stationList.length,
    stations: stationList,
  };
}

function formatPercent(value, total) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function formatTenThousands(value) {
  return `${numberFormatter.format(Math.round(value / 10000))}만건`;
}

function cleanStationName(name) {
  return name.replace(/^\s*\d+\.\s*/, "").trim() || name;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function animateNumber(element, targetValue, duration = 850) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animationDuration = reduceMotion ? 0 : duration;
  const startTime = performance.now();

  element.classList.remove("skeleton");

  const tick = (currentTime) => {
    const progress = animationDuration === 0
      ? 1
      : Math.min((currentTime - startTime) / animationDuration, 1);
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

function renderMetrics(data, animate = true) {
  const weekdayPercent = (data.weekdayRides / data.totalRides) * 100;
  const weekendPercent = (data.weekendRides / data.totalRides) * 100;

  if (animate) {
    animateNumber(totalRidesElement, data.totalRides, 1000);
    animateNumber(activeStationsElement, data.activeStations, 760);
  } else {
    totalRidesElement.textContent = numberFormatter.format(data.totalRides);
    activeStationsElement.textContent = numberFormatter.format(data.activeStations);
  }

  averageRidesElement.textContent = `${numberFormatter.format(Math.round(data.totalRides / data.activeStations))}건 / 소`;
  weekdaySummaryElement.textContent = `${formatTenThousands(data.weekdayRides)} (${formatPercent(data.weekdayRides, data.totalRides)})`;
  weekendSummaryElement.textContent = `${formatTenThousands(data.weekendRides)} (${formatPercent(data.weekendRides, data.totalRides)})`;
  sourceCountElement.textContent = `${numberFormatter.format(data.rowCount)}행 실데이터 분석`;

  requestAnimationFrame(() => {
    weekdayBarElement.style.width = `${weekdayPercent}%`;
    weekendBarElement.style.width = `${weekendPercent}%`;
  });
}

function renderRanking(type) {
  if (!dashboardData) {
    return;
  }

  activeRanking = type;
  const config = rankingConfig[type];
  const topStations = [...dashboardData.stations]
    .sort((left, right) => right[config.field] - left[config.field])
    .slice(0, 10);
  const maxValue = topStations[0]?.[config.field] ?? 1;

  rankingContextElement.textContent = config.context;
  rankingListElement.innerHTML = topStations
    .map((station, index) => {
      const value = station[config.field];
      const barWidth = Math.max((value / maxValue) * 100, 2);
      return `
        <li class="ranking-item" style="animation-delay: ${index * 35}ms">
          <span class="rank">${index + 1}</span>
          <div class="station-info">
            <div class="station-name" title="${escapeHtml(station.name)}">${escapeHtml(cleanStationName(station.name))}</div>
            <div class="station-meta">대여소 #${escapeHtml(station.number)}</div>
            <div class="station-bar" aria-hidden="true"><span style="--bar-width: ${barWidth.toFixed(1)}%"></span></div>
          </div>
          <strong class="station-total">${numberFormatter.format(value)}건</strong>
        </li>`;
    })
    .join("");

  rankingListElement.setAttribute("aria-busy", "false");
}

function selectTab(type, focus = false) {
  tabElements.forEach((tab) => {
    const selected = tab.dataset.ranking === type;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;

    if (selected && focus) {
      tab.focus();
    }
  });

  renderRanking(type);
}

function replayAnimations() {
  if (!dashboardData) {
    return;
  }

  document.querySelectorAll(".reveal-item").forEach((element) => {
    element.style.animation = "none";
    void element.offsetWidth;
    element.style.animation = "";
  });

  weekdayBarElement.style.width = "0";
  weekendBarElement.style.width = "0";
  renderMetrics(dashboardData, true);
  renderRanking(activeRanking);
}

tabElements.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.ranking));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + direction + tabElements.length) % tabElements.length;
    selectTab(tabElements[nextIndex].dataset.ranking, true);
  });
});

replayButton.addEventListener("click", replayAnimations);

async function loadDashboard() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`데이터 요청 실패 (${response.status})`);
    }

    const csvText = await response.text();
    dashboardData = aggregateData(csvText);

    if (dashboardData.totalRides <= 0 || dashboardData.activeStations <= 0) {
      throw new Error("집계 가능한 이용 기록이 없습니다.");
    }

    renderMetrics(dashboardData);
    renderRanking("total");
    setStatus("is-ready", "실데이터 집계 완료");
    dashboard.setAttribute("aria-busy", "false");
  } catch (error) {
    totalRidesElement.classList.remove("skeleton");
    activeStationsElement.classList.remove("skeleton");
    totalRidesElement.textContent = "—";
    activeStationsElement.textContent = "—";
    rankingListElement.setAttribute("aria-busy", "false");
    setStatus("is-error", "데이터 오류");
    dashboard.setAttribute("aria-busy", "false");
    errorMessage.textContent = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    errorPanel.hidden = false;
  }
}

loadDashboard();
