/* 따릉이 대여소 군집 관제 — 가중치와 지도
   ==================================================================
   서버·프레임워크·빌드 없이 돌아간다. 브라우저가 data/bike_station_profile.csv
   를 fetch로 직접 읽고, 표준화 → 가중치 적용 → KMeans(k=4) → 군집별 원본 평균
   까지 전부 이 파일 안에서 다시 계산한다.

   가중치를 거리에 반영하는 방법 (여기가 이 파일의 핵심)
   ------------------------------------------------------------------
   쓰고 싶은 거리는 가중 유클리드 거리다.

       거리² = Σ_j  w_j × (z_aj − z_bj)²          (w는 합이 1인 정규화 가중치)

   KMeans는 입력 좌표에 대해 그냥 유클리드 거리를 쓴다. 그래서 입력 좌표를

       x_j = z_j × √w_j

   로 만들어 넣는다. 그러면 (x_aj − x_bj)² = w_j × (z_aj − z_bj)² 가 되어
   원하는 거리와 정확히 같아진다.

   z_j × w_j 로 넣으면 (z_aj − z_bj)² 에 w_j² 가 곱해져서 가중치가 **제곱**으로
   반영된다. 20% → 40%로 두 배 올렸을 때 거리 기여가 네 배가 되는 것이다.
   흔한 실수이고, 이 화면에서는 하지 않는다. applyWeights()를 보라.

   재현성
   ------------------------------------------------------------------
   초기 중심은 고정 시드 LCG를 쓴 k-means++로 뽑는다. 같은 데이터 · 같은
   가중치라면 몇 번을 눌러도 같은 결과가 나온다(Math.random을 쓰지 않는다).
*/

(() => {
  "use strict";

  // ── 상수 ───────────────────────────────────────────────────
  const CSV_URL = "data/bike_station_profile.csv";
  const K = 4;
  const MAX_ITER = 100;         // 반복 상한
  const TOL = 1e-9;             // 중심 이동량(제곱합)이 이보다 작으면 수렴 종료
  const N_INIT = 5;             // 서로 다른 고정 시드 5개로 시작해 최소 inertia 채택
  const SEEDS = [11, 2027, 40503, 777771, 99999989];
  const CLUSTER_COLORS = ["#ff9f0a", "#35a0ff", "#35d17a", "#c07af5"];

  /** 군집 변수 5개. 이 순서가 곧 가중치 배열의 순서다. */
  const FEATURES = [
    { col: "일평균이용건수", label: "일평균 이용건수", short: "일평균",
      unit: "건/일", fmt: v => v.toFixed(2) },
    { col: "출근시간비중", label: "출근시간 비중", short: "출근",
      unit: "%", fmt: v => (v * 100).toFixed(1) + "%" },
    { col: "퇴근시간비중", label: "퇴근시간 비중", short: "퇴근",
      unit: "%", fmt: v => (v * 100).toFixed(1) + "%" },
    { col: "주말비중", label: "주말 비중", short: "주말",
      unit: "%", fmt: v => (v * 100).toFixed(1) + "%" },
    { col: "거치대당일평균이용건수", label: "거치대당 일평균 이용건수", short: "거치대당",
      unit: "건/일/거치대", fmt: v => v.toFixed(2) },
  ];
  const DEFAULT_WEIGHTS = FEATURES.map(() => 20);

  // ── 상태 ───────────────────────────────────────────────────
  const S = {
    rows: [],            // 대여소 원본 레코드
    z: [],               // 표준화값 (행 = 대여소, 열 = FEATURES 순서)
    mean: [], std: [],   // StandardScaler의 mean_ / scale_
    overall: [],         // 5개 변수의 전체 평균(원본 단위) — 해석 기준선
    labels: [],          // 현재 군집 라벨 (정렬 후)
    baseLabels: [],      // 기본 가중치(각 20%) 결과 라벨 — 색·번호의 기준
    baseCentersZ: null,  // 기본 결과의 중심 (표준화 공간)
    summary: [],         // 군집별 요약
    weights: DEFAULT_WEIGHTS.slice(),   // 입력값(정규화 전)
    appliedWeights: DEFAULT_WEIGHTS.slice(),  // 마지막 재계산에 쓴 입력값
    filter: "all",
    selectedId: null,
    map: null, canvasRenderer: null, markers: new Map(), tileOk: false,
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => n.toLocaleString("ko-KR");

  // ── 1. CSV 읽기 ────────────────────────────────────────────
  /** 따옴표로 감싼 필드와 필드 안의 콤마·따옴표를 처리하는 CSV 파서.
   *  상세주소에 콤마가 들어간 행이 실제로 있어서 split(",")로는 안 된다. */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // UTF-8 BOM
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { quoted = true; }
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift();
    return rows.map(r => {
      const o = {};
      header.forEach((h, j) => { o[h] = r[j]; });
      return o;
    });
  }

  const toNum = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };

  /** 결측치·무한대 확인 → 계산에 쓸 수 없는 행은 이유와 함께 걸러낸다. */
  function prepare(records) {
    const kept = [], dropped = [];
    for (const r of records) {
      const feat = FEATURES.map(f => toNum(r[f.col]));
      const lat = toNum(r["위도"]), lon = toNum(r["경도"]);
      const bad = feat.some(v => !Number.isFinite(v));
      if (bad || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        dropped.push(r["대여소명"] || r["대여소번호"]);
        continue;
      }
      kept.push({
        id: String(r["대여소번호"]).trim(),
        name: (r["대여소명"] || "").trim(),
        gu: (r["자치구"] || "").trim(),
        addr: (r["상세주소"] || "").trim(),
        lat, lon,
        racks: toNum(r["거치대수"]),
        night: toNum(r["심야비중"]),
        equalScore: toNum(r["동일가중치점수"]),
        focusScore: toNum(r["집중운영점수"]),
        grade: (r["우선관리등급"] || "").trim(),
        first: (r["최초관측일"] || "").trim(),
        last: (r["최종관측일"] || "").trim(),
        feat,
      });
    }
    return { kept, dropped };
  }

  // ── 2. 표준화 (StandardScaler와 같은 계산) ─────────────────
  /** 모집단 표준편차(ddof=0)를 쓴다 — sklearn StandardScaler와 같다. */
  function standardize(rows) {
    const n = rows.length, w = FEATURES.length;
    const mean = new Array(w).fill(0), std = new Array(w).fill(0);
    for (let j = 0; j < w; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rows[i].feat[j];
      mean[j] = s / n;
      let v = 0;
      for (let i = 0; i < n; i++) { const d = rows[i].feat[j] - mean[j]; v += d * d; }
      std[j] = Math.sqrt(v / n) || 1;   // 상수 열이면 1로 두어 0나눗셈을 막는다
    }
    const z = rows.map(r => r.feat.map((v, j) => (v - mean[j]) / std[j]));
    return { mean, std, z };
  }

  // ── 3. 가중치 ─────────────────────────────────────────────
  /** 합계 100%가 되도록 다시 나눈다. 전부 0이면 균등(각 1/5)으로 되돌린다. */
  function normalizeWeights(input) {
    const clean = input.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
    const total = clean.reduce((a, b) => a + b, 0);
    if (total <= 0) return FEATURES.map(() => 1 / FEATURES.length);
    return clean.map(v => v / total);
  }

  /** ★ 가중치를 거리에 올바르게 반영하는 지점.
   *  z × √w 를 쓴다. z × w 로 하면 거리에서 w가 제곱된다. */
  function applyWeights(z, normalized) {
    const scale = normalized.map(Math.sqrt);
    return z.map(row => row.map((v, j) => v * scale[j]));
  }

  // ── 4. KMeans ─────────────────────────────────────────────
  /** 고정 시드 LCG. Math.random을 쓰지 않아야 재현이 된다. */
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const dist2 = (a, b) => {
    let d = 0;
    for (let j = 0; j < a.length; j++) { const t = a[j] - b[j]; d += t * t; }
    return d;
  };

  /** k-means++ 초기화 — 첫 중심만 시드로 뽑고, 이후는 D² 확률로 뽑는다. */
  function kmeansppInit(X, rnd) {
    const n = X.length;
    const centers = [X[Math.floor(rnd() * n)].slice()];
    const closest = X.map(x => dist2(x, centers[0]));
    while (centers.length < K) {
      const total = closest.reduce((a, b) => a + b, 0);
      let target = rnd() * total, idx = n - 1;
      for (let i = 0; i < n; i++) {
        target -= closest[i];
        if (target <= 0) { idx = i; break; }
      }
      centers.push(X[idx].slice());
      for (let i = 0; i < n; i++) {
        const d = dist2(X[i], centers[centers.length - 1]);
        if (d < closest[i]) closest[i] = d;
      }
    }
    return centers;
  }

  /** Lloyd 반복. 수렴 조건 = 중심 이동 제곱합 < TOL 또는 라벨 변화 없음.
   *  빈 군집이 생기면 자기 중심에서 가장 먼 점을 그 군집으로 옮긴다. */
  function kmeansOnce(X, seed) {
    const n = X.length, w = X[0].length;
    let centers = kmeansppInit(X, lcg(seed));
    let labels = new Int32Array(n).fill(-1);
    let iter = 0, converged = false, emptyFixes = 0;

    for (; iter < MAX_ITER; iter++) {
      // 배정
      let changed = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bestD = Infinity;
        for (let k = 0; k < K; k++) {
          const d = dist2(X[i], centers[k]);
          if (d < bestD) { bestD = d; best = k; }
        }
        if (labels[i] !== best) { labels[i] = best; changed++; }
      }

      // 빈 군집 처리 — 가장 먼 점을 뺏어온다
      const counts = new Array(K).fill(0);
      for (let i = 0; i < n; i++) counts[labels[i]]++;
      for (let k = 0; k < K; k++) {
        if (counts[k] > 0) continue;
        let far = 0, farD = -1;
        for (let i = 0; i < n; i++) {
          if (counts[labels[i]] <= 1) continue;
          const d = dist2(X[i], centers[labels[i]]);
          if (d > farD) { farD = d; far = i; }
        }
        counts[labels[far]]--;
        labels[far] = k;
        counts[k] = 1;
        emptyFixes++;
        changed++;
      }

      // 중심 재계산
      const next = Array.from({ length: K }, () => new Array(w).fill(0));
      for (let i = 0; i < n; i++) {
        const k = labels[i];
        for (let j = 0; j < w; j++) next[k][j] += X[i][j];
      }
      for (let k = 0; k < K; k++) {
        if (counts[k] === 0) { next[k] = centers[k].slice(); continue; }
        for (let j = 0; j < w; j++) next[k][j] /= counts[k];
      }

      let shift = 0;
      for (let k = 0; k < K; k++) shift += dist2(centers[k], next[k]);
      centers = next;
      if (changed === 0 || shift < TOL) { converged = true; iter++; break; }
    }

    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(X[i], centers[labels[i]]);
    return { centers, labels, inertia, iter, converged, emptyFixes };
  }

  /** 고정 시드 N_INIT개를 돌려 inertia가 가장 작은 결과를 쓴다(결정론적). */
  function kmeans(X) {
    let best = null;
    for (const seed of SEEDS.slice(0, N_INIT)) {
      const r = kmeansOnce(X, seed);
      if (!best || r.inertia < best.inertia - 1e-12) best = r;
    }
    return best;
  }

  // ── 5. 군집 번호·색 정렬 ───────────────────────────────────
  const PERMS = (function perms(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    arr.forEach((v, i) => {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of perms(rest)) out.push([v, ...p]);
    });
    return out;
  })([0, 1, 2, 3]);   // 4! = 24가지

  /** 새 중심을 기본 중심에 최소거리로 매칭한다.
   *  k=4라 24가지 순열을 전수 계산해 거리합이 최소인 것을 고른다(그리디가
   *  아니라 최적 매칭). 비교는 가중치를 벗긴 **표준화 공간**에서 한다 —
   *  가중치가 다르면 좌표 축척이 달라 그대로 비교할 수 없기 때문이다. */
  function alignLabels(centersWeighted, normalized, labels) {
    if (!S.baseCentersZ) return { labels, map: [0, 1, 2, 3] };
    const scale = normalized.map(v => Math.sqrt(v) || 1e-12);
    const centersZ = centersWeighted.map(c => c.map((v, j) => v / scale[j]));

    let bestPerm = [0, 1, 2, 3], bestCost = Infinity;
    for (const perm of PERMS) {
      // perm[newK] = 이 새 군집에 붙일 기준 번호
      let cost = 0;
      for (let k = 0; k < K; k++) cost += dist2(centersZ[k], S.baseCentersZ[perm[k]]);
      if (cost < bestCost - 1e-12) { bestCost = cost; bestPerm = perm; }
    }
    const out = new Int32Array(labels.length);
    for (let i = 0; i < labels.length; i++) out[i] = bestPerm[labels[i]];
    return { labels: out, map: bestPerm, cost: bestCost, centersZ };
  }

  // ── 6. 군집 요약 (원본 단위 평균) ──────────────────────────
  const NAME_RULES = [
    { name: "고이용 혼합형 후보", test: r => r[0] >= 1.3 || r[4] >= 1.3 },
    { name: "출근 집중형 후보",   test: r => r[1] >= 1.15 && r[1] >= r[2] && r[1] >= r[3] },
    { name: "퇴근 집중형 후보",   test: r => r[2] >= 1.15 && r[2] >= r[3] },
    { name: "주말 이용형 후보",   test: r => r[3] >= 1.15 },
  ];

  function summarize(labels) {
    const acc = Array.from({ length: K },
      () => ({ n: 0, sum: new Array(FEATURES.length).fill(0) }));
    for (let i = 0; i < S.rows.length; i++) {
      const a = acc[labels[i]];
      a.n++;
      for (let j = 0; j < FEATURES.length; j++) a.sum[j] += S.rows[i].feat[j];
    }
    return acc.map((a, k) => {
      const mean = a.sum.map(v => (a.n ? v / a.n : 0));
      const rel = mean.map((v, j) => (S.overall[j] ? v / S.overall[j] : 1));
      let topIdx = 0, topScore = -1;
      rel.forEach((v, j) => {
        const score = Math.abs(Math.log(v > 0 ? v : 1e-9));
        if (score > topScore) { topScore = score; topIdx = j; }
      });
      const rule = NAME_RULES.find(r => r.test(rel));
      return {
        k, n: a.n, mean, rel, topIdx,
        nameCandidate: rule ? rule.name : "특정 특징 없음",
      };
    });
  }

  /** 기본 결과의 군집 번호를 정하는 규칙.
   *
   *  KMeans가 내놓는 번호는 아무 뜻이 없어서 실행 환경마다 순서가 달라진다.
   *  그러면 수업 중에 발표자료(`발표자료/10_국내데이터분석실전_13~16일차/`)의
   *  "군집 1이 고이용" 같은 설명과 화면이 어긋난다. 그래서 기본 가중치 결과에
   *  한 번만 아래 규칙을 적용해 번호를 고정한다. 규칙은 원본 평균만 쓴다.
   *
   *    1) 일평균이용건수 평균이 가장 큰 군집        → 1
   *    2) 남은 셋 중 출근시간비중 평균이 가장 큰 군집 → 3
   *    3) 남은 둘 중 퇴근시간비중 평균이 가장 큰 군집 → 0
   *    4) 마지막 군집                              → 2
   *
   *  가중치를 바꾼 뒤의 결과는 이 기본 번호에 최소거리로 맞춘다(alignLabels).
   */
  function canonicalOrder(labels) {
    const acc = Array.from({ length: K },
      () => ({ n: 0, sum: new Array(FEATURES.length).fill(0) }));
    for (let i = 0; i < S.rows.length; i++) {
      const a = acc[labels[i]];
      a.n++;
      for (let j = 0; j < FEATURES.length; j++) a.sum[j] += S.rows[i].feat[j];
    }
    const mean = acc.map(a => a.sum.map(v => (a.n ? v / a.n : 0)));
    const left = [0, 1, 2, 3];
    const take = (featIdx) => {
      let pick = left[0];
      for (const k of left) if (mean[k][featIdx] > mean[pick][featIdx]) pick = k;
      left.splice(left.indexOf(pick), 1);
      return pick;
    };
    const target = new Array(K);
    target[take(0)] = 1;   // 일평균이용건수 최대 → 1
    target[take(1)] = 3;   // 출근시간비중 최대 → 3
    target[take(2)] = 0;   // 퇴근시간비중 최대 → 0
    target[left[0]] = 2;   // 남은 하나 → 2
    return target;         // target[원래번호] = 고정번호
  }

  // ── 7. 재계산 파이프라인 ───────────────────────────────────
  function recompute(inputWeights, { isBaseline = false } = {}) {
    const t0 = performance.now();
    const normalized = normalizeWeights(inputWeights);
    const X = applyWeights(S.z, normalized);
    const raw = kmeans(X);

    let labels = raw.labels, map = [0, 1, 2, 3];
    if (isBaseline) {
      const order = canonicalOrder(raw.labels);
      const relabeled = new Int32Array(raw.labels.length);
      for (let i = 0; i < raw.labels.length; i++) relabeled[i] = order[raw.labels[i]];
      labels = relabeled;
      map = order;
      const scale = normalized.map(v => Math.sqrt(v) || 1e-12);
      const centersZ = raw.centers.map(c => c.map((v, j) => v / scale[j]));
      S.baseCentersZ = new Array(K);
      for (let k = 0; k < K; k++) S.baseCentersZ[order[k]] = centersZ[k];
    } else {
      const aligned = alignLabels(raw.centers, normalized, raw.labels);
      labels = aligned.labels;
      map = aligned.map;
    }

    S.labels = labels;
    S.summary = summarize(labels);
    S.appliedWeights = inputWeights.slice();
    if (isBaseline) S.baseLabels = Array.from(labels);

    let moved = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] !== S.baseLabels[i]) moved++;

    return {
      normalized, moved, map,
      ms: Math.round(performance.now() - t0),
      iter: raw.iter, converged: raw.converged,
      emptyFixes: raw.emptyFixes, inertia: raw.inertia,
    };
  }

  // ── 8. 화면 — 가중치 패널 ──────────────────────────────────
  function buildWeightForm() {
    const form = $("weightForm");
    form.innerHTML = FEATURES.map((f, j) => `
      <div class="weight">
        <label class="weight__name" for="w${j}">${esc(f.label)}</label>
        <input class="weight__value" id="wn${j}" type="number" min="0" max="100"
               step="1" value="${DEFAULT_WEIGHTS[j]}"
               aria-label="${esc(f.label)} 가중치 값(%)">
        <input id="w${j}" type="range" min="0" max="100" step="1"
               value="${DEFAULT_WEIGHTS[j]}"
               aria-label="${esc(f.label)} 가중치 슬라이더">
      </div>`).join("");

    FEATURES.forEach((f, j) => {
      const slider = $("w" + j), box = $("wn" + j);
      const set = v => {
        const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
        S.weights[j] = n;
        slider.value = n;
        box.value = n;
        renderWeightState();
      };
      slider.addEventListener("input", e => set(e.target.value));
      box.addEventListener("input", e => set(e.target.value));
    });
  }

  /** 입력값 합계 · 유효 가중치 · 거리 배율을 항상 같이 보여준다.
   *  "정규화 전 값"과 "실제 적용된 값"을 구분해 보여주는 것이 이 표의 목적. */
  function renderWeightState() {
    const sum = S.weights.reduce((a, b) => a + b, 0);
    const el = $("weightSum");
    el.textContent = sum + "%";
    $("weightSum").parentElement.dataset.off = sum === 100 ? "0" : "1";
    $("weightNote").textContent = sum === 100
      ? "합계가 100%다. 입력값이 그대로 유효 가중치가 된다."
      : `합계가 ${sum}%다. 재계산할 때 합계 100%로 다시 나눠서 쓴다(아래 표의 유효 가중치).`;

    const normalized = normalizeWeights(S.weights);
    const dirty = S.weights.some((v, j) => v !== S.appliedWeights[j]);
    $("effectiveBody").innerHTML = FEATURES.map((f, j) => `
      <tr${dirty ? ' data-stale="1"' : ""}>
        <td>${esc(f.short)}</td>
        <td>${S.weights[j]}%</td>
        <td>${(normalized[j] * 100).toFixed(1)}%</td>
        <td>${Math.sqrt(normalized[j]).toFixed(3)}</td>
      </tr>`).join("");

    const btn = $("btnRecalc");
    btn.dataset.dirty = dirty ? "1" : "0";
    btn.textContent = dirty ? "군집 다시 계산 (변경됨)" : "군집 다시 계산";
  }

  // ── 9. 화면 — 지도 ────────────────────────────────────────
  function radiusFor(daily, maxDaily) {
    return 2.6 + 7.4 * Math.sqrt(Math.max(daily, 0) / maxDaily);
  }

  function initMap() {
    S.map = L.map("map", {
      center: [37.5512, 126.9882],
      zoom: 11,
      minZoom: 10,
      maxZoom: 18,
      preferCanvas: true,       // 2,782개 마커를 DOM 대신 캔버스에 그린다
      zoomControl: true,
    });
    S.canvasRenderer = L.canvas({ padding: 0.4 });

    const tiles = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution: '지도 타일 © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자',
        crossOrigin: true,
      });
    // 타일을 못 불러오면 안내 문구를 남긴다(점은 그대로 보인다).
    tiles.on("tileload", () => {
      if (!S.tileOk) { S.tileOk = true; $("mapTip").hidden = true; }
    });
    tiles.on("tileerror", () => { $("mapTip").hidden = false; });
    tiles.addTo(S.map);

    const maxDaily = Math.max(...S.rows.map(r => r.feat[0]));
    S.rows.forEach((r, i) => {
      const m = L.circleMarker([r.lat, r.lon], {
        renderer: S.canvasRenderer,
        radius: radiusFor(r.feat[0], maxDaily),
        weight: 0.7,
        color: "#0b0d10",
        fillColor: CLUSTER_COLORS[S.labels[i]],
        fillOpacity: 0.82,
      });
      m.on("click", () => selectStation(r.id, { fromMap: true }));
      m.bindPopup(() => popupHtml(r.id));
      S.markers.set(r.id, m);
      m.addTo(S.map);
    });
  }

  function popupHtml(id) {
    const i = indexOf(id);
    const r = S.rows[i], k = S.labels[i];
    return `<b>${esc(r.name)}</b>
      <span class="pop__k">군집 ${k} · ${esc(S.summary[k].nameCandidate)}</span><br>
      ${esc(r.gu)} · 일평균 ${r.feat[0].toFixed(1)}건/일<br>
      출근 ${(r.feat[1] * 100).toFixed(1)}% · 퇴근 ${(r.feat[2] * 100).toFixed(1)}%
      · 주말 ${(r.feat[3] * 100).toFixed(1)}%`;
  }

  function refreshMarkers() {
    S.rows.forEach((r, i) => {
      const m = S.markers.get(r.id);
      const k = S.labels[i];
      const visible = S.filter === "all" || Number(S.filter) === k;
      m.setStyle({
        fillColor: CLUSTER_COLORS[k],
        fillOpacity: visible ? 0.82 : 0,
        opacity: visible ? 1 : 0,
      });
      m.options.interactive = visible;
    });
  }

  // ── 10. 화면 — 범례 · 필터 · 카드 · 목록 · 상세 ────────────
  function renderLegend() {
    $("legend").innerHTML =
      S.summary.map(c => `
        <span class="legend__item">
          <span class="legend__swatch" style="background:${CLUSTER_COLORS[c.k]}"></span>
          군집 ${c.k} · ${esc(c.nameCandidate)} · ${num(c.n)}곳
        </span>`).join("") + `
        <span class="legend__size">
          점 크기 = 일평균 이용건수
          <i style="width:6px;height:6px"></i><i style="width:11px;height:11px"></i><i style="width:17px;height:17px"></i>
        </span>`;
  }

  function renderFilter() {
    const chips = [{ v: "all", label: "전체", n: S.rows.length, color: null }]
      .concat(S.summary.map(c => ({ v: String(c.k), label: `군집 ${c.k}`, n: c.n, color: CLUSTER_COLORS[c.k] })));
    $("clusterFilter").innerHTML = chips.map(c => `
      <button type="button" class="chip" data-v="${c.v}"
              aria-pressed="${S.filter === c.v}">
        ${c.color ? `<span class="chip__dot" style="background:${c.color}"></span>` : ""}
        ${esc(c.label)}<span class="chip__n">${num(c.n)}</span>
      </button>`).join("");
    $("clusterFilter").querySelectorAll(".chip").forEach(btn => {
      btn.addEventListener("click", () => {
        S.filter = btn.dataset.v;
        renderFilter();
        refreshMarkers();
        renderList();
      });
    });
  }

  function renderCards() {
    $("clusterCards").innerHTML = S.summary.map(c => `
      <button type="button" class="card" data-k="${c.k}"
              aria-pressed="${S.filter === String(c.k)}"
              style="border-left-color:${CLUSTER_COLORS[c.k]}">
        <span class="card__top">
          <span class="card__id" style="color:${CLUSTER_COLORS[c.k]}">군집 ${c.k}</span>
          <span class="card__n">${num(c.n)}곳</span>
        </span>
        <span class="card__name">${esc(c.nameCandidate)}</span>
        <span class="card__top-metric">가장 두드러진 지표 —
          ${esc(FEATURES[c.topIdx].short)} ${esc(FEATURES[c.topIdx].fmt(c.mean[c.topIdx]))}
          (전체 평균의 ${c.rel[c.topIdx].toFixed(2)}배)</span>
        <span class="card__grid">
          ${FEATURES.map((f, j) => `
            <div><span>${esc(f.short)}</span><strong>${esc(f.fmt(c.mean[j]))}</strong></div>`).join("")}
        </span>
      </button>`).join("");
    $("clusterCards").querySelectorAll(".card").forEach(btn => {
      btn.addEventListener("click", () => {
        S.filter = S.filter === btn.dataset.k ? "all" : btn.dataset.k;
        renderFilter(); renderCards(); refreshMarkers(); renderList();
      });
    });
  }

  const indexOf = id => S.rows.findIndex(r => r.id === id);

  function visibleRows() {
    const q = ($("search").value || "").trim().toLowerCase();
    const out = [];
    for (let i = 0; i < S.rows.length; i++) {
      const k = S.labels[i];
      if (S.filter !== "all" && Number(S.filter) !== k) continue;
      const r = S.rows[i];
      if (q && !(r.name.toLowerCase().includes(q) || r.id.includes(q))) continue;
      out.push(i);
    }
    return out;
  }

  const LIST_CAP = 300;   // 목록은 상한을 둔다. 지도에는 전부 그린다.

  function renderList() {
    const idx = visibleRows();
    idx.sort((a, b) => S.rows[b].feat[0] - S.rows[a].feat[0]);
    const shown = idx.slice(0, LIST_CAP);
    $("listCount").textContent =
      `${num(idx.length)}곳` + (idx.length > LIST_CAP ? ` (일평균 이용건수 상위 ${LIST_CAP}곳 표시)` : "");
    $("stationList").innerHTML = shown.length
      ? shown.map(i => {
          const r = S.rows[i], k = S.labels[i];
          return `<li><button type="button" class="row" data-id="${esc(r.id)}"
              aria-current="${S.selectedId === r.id}">
            <span class="row__k" style="color:${CLUSTER_COLORS[k]}">${k}</span>
            <span class="row__name">${esc(r.name)}</span>
            <span class="row__v">${r.feat[0].toFixed(1)}건</span>
          </button></li>`;
        }).join("")
      : `<li class="stationlist__empty">조건에 맞는 대여소가 없다. 검색어나 군집 필터를 확인한다.</li>`;
    $("stationList").querySelectorAll(".row").forEach(btn => {
      btn.addEventListener("click", () => selectStation(btn.dataset.id));
    });
  }

  function selectStation(id, { fromMap = false } = {}) {
    S.selectedId = id;
    const i = indexOf(id);
    if (i < 0) return;
    const r = S.rows[i], k = S.labels[i];

    if (!fromMap) {
      // 목록에서 골랐으면 지도를 그 대여소로 옮기고 팝업을 띄운다
      S.map.setView([r.lat, r.lon], Math.max(S.map.getZoom(), 15), { animate: false });
      S.markers.get(id).openPopup();
    }
    renderList();
    const rows = [
      ["대여소번호", r.id],
      ["자치구", r.gu || "—"],
      ["일평균 이용건수", r.feat[0].toFixed(2) + " 건/일"],
      ["거치대 수", Number.isFinite(r.racks) ? num(r.racks) + " 대" : "—"],
      ["출근시간 비중", (r.feat[1] * 100).toFixed(1) + "%"],
      ["퇴근시간 비중", (r.feat[2] * 100).toFixed(1) + "%"],
      ["주말 비중", (r.feat[3] * 100).toFixed(1) + "%"],
      ["심야 비중", Number.isFinite(r.night) ? (r.night * 100).toFixed(1) + "%" : "—"],
      ["거치대당 일평균", r.feat[4].toFixed(2) + " 건/일/거치대"],
      ["동일가중치점수", Number.isFinite(r.equalScore) ? r.equalScore + " 점" : "—"],
      ["집중운영점수", Number.isFinite(r.focusScore) ? r.focusScore.toFixed(2) + " 점" : "—"],
      ["우선관리등급", r.grade || "—"],
    ];
    $("station").innerHTML = `
      <div class="station__card">
        <h3 class="station__name">${esc(r.name)}</h3>
        <p class="station__where">${esc(r.addr || "상세주소 없음")}</p>
        <span class="station__k"
              style="color:${CLUSTER_COLORS[k]};border:1px solid ${CLUSTER_COLORS[k]}">
          군집 ${k} · ${esc(S.summary[k].nameCandidate)}
        </span>
        <dl class="station__dl">
          ${rows.map(([t, v]) => `<div><dt>${esc(t)}</dt><dd>${esc(v)}</dd></div>`).join("")}
        </dl>
        <p class="station__foot">
          군집 번호는 순위가 아니다. 이 대여소가 왜 이런 패턴인지(주변 시설·환승 여부)는
          현재 데이터로 알 수 없다.
        </p>
      </div>`;
  }

  // ── 11. 재계산 버튼 ───────────────────────────────────────
  function runRecalc() {
    const info = recompute(S.weights);
    $("deltaValue").textContent = num(info.moved) + "곳";
    $("deltaSub").textContent =
      `기본 가중치(각 20%) 결과와 비교 · 전체 ${num(S.rows.length)}곳 중 `
      + `${(info.moved / S.rows.length * 100).toFixed(1)}%`;
    $("statRecalc").textContent = `${info.ms}ms · ${info.iter}회 반복`
      + (info.converged ? " · 수렴" : " · 상한 도달");
    banner(
      `재계산 완료 — 유효 가중치 ` +
      FEATURES.map((f, j) => `${f.short} ${(info.normalized[j] * 100).toFixed(1)}%`).join(" / ") +
      ` · 군집 번호는 기본 결과 중심과 최소거리로 맞춤(매칭 ${info.map.join("→")})` +
      (info.emptyFixes ? ` · 빈 군집 ${info.emptyFixes}회 재배정` : ""));
    renderWeightState();
    renderLegend(); renderFilter(); renderCards(); refreshMarkers(); renderList();
    if (S.selectedId) selectStation(S.selectedId, { fromMap: true });
  }

  function banner(msg, state) {
    const el = $("banner");
    el.hidden = false;
    el.textContent = msg;
    if (state) el.dataset.state = state; else delete el.dataset.state;
  }

  // ── 12. 시작 ──────────────────────────────────────────────
  async function main() {
    let text;
    try {
      const res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      banner(`데이터를 읽지 못했다 (${err.message}). `
        + `이 화면은 file:// 로 열면 CSV를 읽을 수 없다. dashboard 폴더에서 `
        + `python -m http.server 8000 을 실행하고 http://localhost:8000 으로 접속한다. `
        + `data/bike_station_profile.csv 파일이 있는지도 확인한다.`, "error");
      return;
    }

    const records = parseCsv(text);
    const { kept, dropped } = prepare(records);
    if (!kept.length) {
      banner("CSV를 읽었지만 사용할 수 있는 행이 없다. 컬럼 이름을 확인한다.", "error");
      return;
    }
    S.rows = kept;

    const st = standardize(S.rows);
    S.mean = st.mean; S.std = st.std; S.z = st.z;
    S.overall = st.mean.slice();     // 전체 평균 = 해석 기준선

    // 기본 가중치 결과를 먼저 만들어 색·번호의 기준으로 삼는다
    S.baseLabels = new Int32Array(S.rows.length);
    const base = recompute(DEFAULT_WEIGHTS, { isBaseline: true });

    $("statStations").textContent = num(S.rows.length) + "곳";
    const first = S.rows.reduce((a, r) => (r.first && r.first < a ? r.first : a), "9999");
    const last = S.rows.reduce((a, r) => (r.last && r.last > a ? r.last : a), "");
    $("statPeriod").textContent = `${first} ~ ${last}`;
    $("statRecalc").textContent = `${base.ms}ms · ${base.iter}회 반복`;

    $("layout").hidden = false;
    buildWeightForm();
    renderWeightState();
    initMap();
    renderLegend(); renderFilter(); renderCards(); renderList();

    banner(`CSV ${num(records.length)}행을 읽어 ${num(S.rows.length)}곳으로 군집을 계산했다`
      + (dropped.length ? ` (결측·무한대 값으로 제외 ${dropped.length}곳)` : " (결측치·무한대 없음)")
      + ` · 기본 가중치는 다섯 변수 각 20%다.`);

    $("btnRecalc").addEventListener("click", runRecalc);
    $("btnReset").addEventListener("click", () => {
      S.weights = DEFAULT_WEIGHTS.slice();
      FEATURES.forEach((f, j) => { $("w" + j).value = 20; $("wn" + j).value = 20; });
      renderWeightState();
      runRecalc();
    });
    $("search").addEventListener("input", renderList);

    // 목록에 포커스가 있을 때 위/아래로 대여소를 옮겨 고를 수 있게 한다
    $("stationList").addEventListener("keydown", e => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const btns = Array.from($("stationList").querySelectorAll(".row"));
      if (!btns.length) return;
      e.preventDefault();
      const cur = btns.findIndex(b => b.dataset.id === S.selectedId);
      const next = e.key === "ArrowDown"
        ? Math.min(btns.length - 1, cur + 1)
        : Math.max(0, cur <= 0 ? 0 : cur - 1);
      selectStation(btns[next].dataset.id);
      const el = $("stationList").querySelector(`.row[data-id="${btns[next].dataset.id}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    });

    // 검수·테스트에서 계산을 직접 부를 수 있게 최소한만 노출한다
    window.__dash = {
      state: S, FEATURES, recompute, normalizeWeights, applyWeights,
      standardize, kmeans, summarize, parseCsv,
    };
  }

  document.addEventListener("DOMContentLoaded", main);
})();
