// [Mission 3] MLOps 정책 — 학생이 완성하는 파일
// 세 함수를 구현한다. 규칙은 docs/OPS_CONTRACT.md 5장. 평가: node scripts/eval.js policy
// 실제로 돌려 보기: node scripts/retrain.js --scenario normal|shift|dirty
const { psi } = require("../lib/ops");

// history : 일 단위 스냅샷 배열(마지막이 오늘). { day, weekday, volume, nullRate, priceBins[10], catBins[6] }
// ctx     : { reference: { priceBins, catBins }, today }
// 반환    : { drift: boolean, kind: "covariate" | "data_quality" | "none", reason? }
function detectDrift(history, ctx) {
  const none = (reason) => ({ drift: false, kind: "none", reason });
  const describe = (value) => String(value);
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  // 계약서 5.1: weekday 값은 0~4인 평일만 유효일로 인정한다.
  const isWeekday = (value) => Number.isInteger(value) && value >= 0 && value <= 4;
  const isValidDay = (day) =>
    isRecord(day) &&
    isWeekday(day.weekday) &&
    Number.isFinite(day.volume) &&
    // 계약서 5.2: 1,000건 미만은 통계를 믿지 않는다.
    day.volume >= 1000 &&
    Number.isFinite(day.nullRate) &&
    // 계약서 5.2: 결측률 5% 이상은 데이터 품질 문제다.
    day.nullRate < 0.05 &&
    Array.isArray(day.priceBins) &&
    Number.isFinite(day.priceBins[0]) &&
    // 계약서 5.2: 0원 상품 비중 20% 이상은 데이터 품질 문제다.
    day.priceBins[0] < 0.2;
  const validBins = (bins, length) =>
    Array.isArray(bins) && bins.length === length && bins.every(Number.isFinite);

  if (!Array.isArray(history) || history.length === 0) {
    return none(`history에 오늘 스냅샷이 없습니다 (history=${describe(history)})`);
  }

  const today = history[history.length - 1];
  if (!isRecord(today)) {
    return none(`오늘 스냅샷이 유효하지 않습니다 (${describe(today)})`);
  }
  if (!Number.isFinite(today.volume)) {
    return none(`오늘 volume=${describe(today.volume)} (숫자 필요)`);
  }
  // 계약서 5.2: 1,000건 미만은 표본이 부족해 통계를 믿지 않는다.
  if (today.volume < 1000) {
    return none(`오늘 volume ${describe(today.volume)} < 1000건`);
  }

  const qualityViolations = [];
  // 계약서 5.2: nullRate 5% 이상이면 데이터 품질 문제로 분류한다.
  if (Number.isFinite(today.nullRate) && today.nullRate >= 0.05) {
    qualityViolations.push(`nullRate ${describe(today.nullRate)} ≥ 0.05`);
  }
  const todayZeroPriceShare = Array.isArray(today.priceBins) ? today.priceBins[0] : undefined;
  // 계약서 5.2: 0원 상품 비중 20% 이상이면 데이터 품질 문제로 분류한다.
  if (Number.isFinite(todayZeroPriceShare) && todayZeroPriceShare >= 0.2) {
    qualityViolations.push(`priceBins[0] ${describe(todayZeroPriceShare)} ≥ 0.20`);
  }
  if (qualityViolations.length > 0) {
    return {
      drift: true,
      kind: "data_quality",
      reason: `오늘 데이터 품질 위반: ${qualityViolations.join("; ")}`,
    };
  }
  if (!Number.isFinite(today.nullRate) || !Number.isFinite(todayZeroPriceShare)) {
    return none(
      `오늘 품질 입력 확인 불가: nullRate=${describe(today.nullRate)}, priceBins[0]=${describe(todayZeroPriceShare)}`,
    );
  }
  // 계약서 5.1: 요일 값은 0~6 정수만 유효(5·6 = 주말).
  if (!Number.isInteger(today.weekday) || today.weekday < 0 || today.weekday > 6) {
    return none(`오늘 weekday=${describe(today.weekday)} (0~6 정수 필요)`);
  }
  // 계약서 5.2: 주말은 계절성이 있어 드리프트 판정에서 제외한다.
  if (today.weekday === 5 || today.weekday === 6) {
    return none(`오늘 weekday=${describe(today.weekday)}은 주말 계절성이므로 제외`);
  }

  let previousValidDay;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    if (isValidDay(history[index])) {
      previousValidDay = history[index];
      break;
    }
  }
  if (!previousValidDay) {
    return none(`오늘 이전에 유효한 날이 없습니다 (과거 스냅샷 ${history.length - 1}개 탐색)`);
  }

  const reference = isRecord(ctx) && isRecord(ctx.reference) ? ctx.reference : undefined;
  const distributions = [
    ["기준 priceBins", reference && reference.priceBins, 10],
    ["오늘 priceBins", today.priceBins, 10],
    ["직전 유효일 priceBins", previousValidDay.priceBins, 10],
    ["기준 catBins", reference && reference.catBins, 6],
    ["오늘 catBins", today.catBins, 6],
    ["직전 유효일 catBins", previousValidDay.catBins, 6],
  ];
  for (const [label, bins, length] of distributions) {
    if (!validBins(bins, length)) {
      return none(`${label} 입력이 유효하지 않습니다 (${describe(bins)}; 숫자 ${length}개 필요)`);
    }
  }

  const previousPricePsi = psi(reference.priceBins, previousValidDay.priceBins);
  const previousCategoryPsi = psi(reference.catBins, previousValidDay.catBins);
  const todayPricePsi = psi(reference.priceBins, today.priceBins);
  const todayCategoryPsi = psi(reference.catBins, today.catBins);
  const previousPsi = Math.max(previousPricePsi, previousCategoryPsi);
  const todayPsi = Math.max(todayPricePsi, todayCategoryPsi);
  const psiDetails =
    `직전 유효일 ${describe(previousValidDay.day)} PSI 가격·카테고리 ` +
    `${describe(previousPricePsi)}·${describe(previousCategoryPsi)}, 오늘 ${describe(today.day)} ` +
    `PSI ${describe(todayPricePsi)}·${describe(todayCategoryPsi)}`;
  if (![previousPsi, todayPsi].every(Number.isFinite)) {
    return none(`${psiDetails} (유한한 PSI를 계산할 수 없음)`);
  }
  // 계약서 5.2의 PSI 0.1 미만은 안정 기준; 이틀 연속 조건은 문제지 그림 6 · OPS_DESIGN 4.2/4.3(팀 판단).
  if (previousPsi >= 0.1 && todayPsi >= 0.1) {
    return {
      drift: true,
      kind: "covariate",
      reason: `${psiDetails}; 두 유효일 모두 최대 PSI ≥ 0.1`,
    };
  }
  return none(`${psiDetails}; 두 유효일 모두 최대 PSI ≥ 0.1이 아님`);
}

// state : { drift(detectDrift 결과), history, today, lastRetrainDay, reference }
// 반환  : "retrain" | "fix_data" | "hold"
function retrainDecision(state) {
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isRecord(state) || !isRecord(state.drift) || typeof state.drift.drift !== "boolean") {
    return "hold";
  }
  if (!state.drift.drift) {
    return "hold";
  }
  if (state.drift.kind === "data_quality") {
    return "fix_data";
  }
  if (state.drift.kind !== "covariate") {
    return "hold";
  }

  const history = state.history;
  if (!Array.isArray(history) || history.length === 0) {
    return "hold";
  }
  const latest = history[history.length - 1];
  if (!isRecord(latest) || !Number.isFinite(latest.day)) {
    return "hold";
  }
  let today = latest.day;
  if (state.today !== undefined && state.today !== null) {
    if (!Number.isFinite(state.today) || state.today !== latest.day) {
      return "hold";
    }
    today = state.today;
  }

  if (state.lastRetrainDay !== undefined && state.lastRetrainDay !== null) {
    if (!Number.isFinite(state.lastRetrainDay)) {
      return "hold";
    }
    const daysSinceRetrain = today - state.lastRetrainDay;
    if (daysSinceRetrain < 0) {
      return "hold";
    }
    // 계약서 5.2: 마지막 재학습 후 7일 이내에는 잦은 재학습을 막는다.
    if (daysSinceRetrain <= 7) {
      return "hold";
    }
  }

  // OPS_DESIGN 4.3(팀 추가 안전장치) · 계약서 5.2(재학습 후 기준 분포 = 최근 3일 평균) · 문제지 부록 D: 검사할 최근 3개 스냅샷이 필요하다.
  if (history.length < 3) {
    return "hold";
  }
  // OPS_DESIGN 4.3(팀 추가 안전장치) · 계약서 5.2(재학습 후 기준 분포 = 최근 3일 평균) · 문제지 부록 D.
  for (const day of history.slice(-3)) {
    if (
      !isRecord(day) ||
      !Number.isFinite(day.volume) ||
      !Number.isFinite(day.nullRate) ||
      !Array.isArray(day.priceBins) ||
      !Number.isFinite(day.priceBins[0])
    ) {
      return "hold";
    }
    // 계약서 5.2: 최근 3일의 표본과 품질이 기준을 충족해야 오염된 데이터로 재학습하지 않는다.
    if (day.volume < 1000 || day.nullRate >= 0.05 || day.priceBins[0] >= 0.2) {
      return "hold";
    }
  }
  return "retrain";
}

// candidate / champion : 모델 평가 요약(OPS_CONTRACT 5.3).  반환: { promote: boolean, code, reason }
function shouldPromote(candidate, champion) {
  const reject = (code, reason) => ({ promote: false, code, reason });
  const read = (object, path) =>
    path.reduce((value, key) => (value == null ? undefined : value[key]), object);
  const format = (value) => String(value);
  const decimal = (value) => {
    const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
    const exponent = exponentText === undefined ? 0 : Number(exponentText);
    const point = coefficient.indexOf(".");
    const fractionDigits = point === -1 ? 0 : coefficient.length - point - 1;
    let integer = BigInt(coefficient.replace(".", ""));
    let scale = fractionDigits - exponent;
    if (scale < 0) {
      integer *= 10n ** BigInt(-scale);
      scale = 0;
    }
    return { integer, scale };
  };
  const scaled = (values) => {
    const parts = values.map(decimal);
    const scale = Math.max(...parts.map((part) => part.scale));
    return parts.map((part) => part.integer * 10n ** BigInt(scale - part.scale));
  };
  const size = read(candidate, ["evalSet", "size"]);
  if (!Number.isFinite(size)) {
    return reject("EVAL_TOO_SMALL", `평가 데이터 크기 입력 ${format(size)} (기준 5000건 이상)`);
  }
  // 계약서 5.3: 평가 데이터가 5,000건 미만이면 표본이 부족하다.
  if (size < 5000) {
    return reject("EVAL_TOO_SMALL", `평가 데이터 ${format(size)}건 < 5000건`);
  }

  const overlap = read(candidate, ["evalSet", "overlapWithTrain"]);
  if (!Number.isFinite(overlap)) {
    return reject("LEAKAGE", `학습 데이터와의 겹침 입력 ${format(overlap)} (기준 0건)`);
  }
  // 계약서 5.3: 평가 데이터와 학습 데이터는 0건 겹쳐야 누수가 없다.
  if (overlap !== 0) {
    return reject("LEAKAGE", `학습 데이터와 ${format(overlap)}건 겹침 (기준 0건)`);
  }

  const nullRate = read(candidate, ["trainedOn", "nullRate"]);
  if (!Number.isFinite(nullRate)) {
    return reject("BAD_TRAIN_DATA", `학습 데이터 결측률 입력 ${format(nullRate)} (기준 0.02 이하)`);
  }
  // 계약서 5.3: 학습 데이터 결측률은 0.02 이하여야 한다.
  const [nullRateScaled, maxNullRateScaled] = scaled([nullRate, 0.02]);
  if (nullRateScaled > maxNullRateScaled) {
    return reject("BAD_TRAIN_DATA", `학습 데이터 결측률 ${format(nullRate)} > 0.02`);
  }

  const ci95 = candidate == null ? undefined : candidate.ci95;
  const ciLow = Array.isArray(ci95) ? ci95[0] : undefined;
  const ciHigh = Array.isArray(ci95) ? ci95[1] : undefined;
  const championHitRate = read(champion, ["hitRatePct"]);
  // 계약서 5.3: 95% 신뢰구간의 하한과 상한 두 값이 있어야 비교할 수 있다.
  if (
    !Array.isArray(ci95) ||
    ci95.length < 2 ||
    !Number.isFinite(ciLow) ||
    !Number.isFinite(ciHigh) ||
    !Number.isFinite(championHitRate)
  ) {
    return reject(
      "NOT_SIGNIFICANT",
      `신뢰구간 또는 챔피언 적중률 입력이 유효하지 않습니다 (ci95=${format(ci95)}, 챔피언=${format(championHitRate)}; CI 하한은 챔피언보다 커야 함)`,
    );
  }
  const [ciLowScaled, championHitRateScaled] = scaled([ciLow, championHitRate]);
  if (ciLowScaled <= championHitRateScaled) {
    return reject(
      "NOT_SIGNIFICANT",
      `후보 CI 하한 ${format(ciLow)}% <= 챔피언 적중률 ${format(championHitRate)}%`,
    );
  }

  for (const segment of ["new", "returning"]) {
    const candidateRate = read(candidate, ["segments", segment, "hitRatePct"]);
    const championRate = read(champion, ["segments", segment, "hitRatePct"]);
    if (!Number.isFinite(candidateRate) || !Number.isFinite(championRate)) {
      return reject(
        "SEGMENT_REGRESSION",
        `${segment} 구간 적중률 입력 후보=${format(candidateRate)}, 챔피언=${format(championRate)} (허용 하락 2.0%p)`,
      );
    }
    const [candidateScaled, championScaled, allowedDropScaled] = scaled([
      candidateRate,
      championRate,
      // 계약서 5.3: 구간 적중률은 챔피언보다 2.0%p까지 낮아도 허용한다.
      2,
    ]);
    if (championScaled > candidateScaled + allowedDropScaled) {
      return reject(
        "SEGMENT_REGRESSION",
        `${segment} 구간 후보 ${format(candidateRate)}% / 챔피언 ${format(championRate)}% (허용 하락 2.0%p)`,
      );
    }
  }

  const latency = read(candidate, ["latencyMs"]);
  const championLatency = read(champion, ["latencyMs"]);
  if (!Number.isFinite(latency) || !Number.isFinite(championLatency)) {
    return reject(
      "LATENCY",
      `지연 입력 후보=${format(latency)}ms, 챔피언=${format(championLatency)}ms (기준 120ms 및 챔피언×1.2)`,
    );
  }
  const [latencyScaled, championLatencyScaled] = scaled([latency, championLatency]);
  // 계약서 5.3: 후보 지연은 120ms 이하이면서 챔피언의 1.2배(5:6 비율) 이하여야 한다.
  if (latency > 120 || latencyScaled * 5n > championLatencyScaled * 6n) {
    return reject(
      "LATENCY",
      `후보 지연 ${format(latency)}ms (기준 120ms 및 챔피언×1.2=${format(championLatency * 1.2)}ms)`,
    );
  }

  return { promote: true, code: "OK" };
}

module.exports = { detectDrift, retrainDecision, shouldPromote };
