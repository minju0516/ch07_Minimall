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
  const isWeekday = (value) => Number.isInteger(value) && value >= 0 && value <= 4;
  const isValidDay = (day) =>
    isRecord(day) &&
    isWeekday(day.weekday) &&
    Number.isFinite(day.volume) &&
    day.volume >= 1000 &&
    Number.isFinite(day.nullRate) &&
    day.nullRate < 0.05 &&
    Array.isArray(day.priceBins) &&
    Number.isFinite(day.priceBins[0]) &&
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
  if (today.volume < 1000) {
    return none(`오늘 volume ${describe(today.volume)} < 1000건`);
  }

  const qualityViolations = [];
  if (Number.isFinite(today.nullRate) && today.nullRate >= 0.05) {
    qualityViolations.push(`nullRate ${describe(today.nullRate)} ≥ 0.05`);
  }
  const todayZeroPriceShare = Array.isArray(today.priceBins) ? today.priceBins[0] : undefined;
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
  if (!Number.isInteger(today.weekday) || today.weekday < 0 || today.weekday > 6) {
    return none(`오늘 weekday=${describe(today.weekday)} (0~6 정수 필요)`);
  }
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
  // TODO
  return "hold";
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
  if (size < 5000) {
    return reject("EVAL_TOO_SMALL", `평가 데이터 ${format(size)}건 < 5000건`);
  }

  const overlap = read(candidate, ["evalSet", "overlapWithTrain"]);
  if (!Number.isFinite(overlap)) {
    return reject("LEAKAGE", `학습 데이터와의 겹침 입력 ${format(overlap)} (기준 0건)`);
  }
  if (overlap !== 0) {
    return reject("LEAKAGE", `학습 데이터와 ${format(overlap)}건 겹침 (기준 0건)`);
  }

  const nullRate = read(candidate, ["trainedOn", "nullRate"]);
  if (!Number.isFinite(nullRate)) {
    return reject("BAD_TRAIN_DATA", `학습 데이터 결측률 입력 ${format(nullRate)} (기준 0.02 이하)`);
  }
  const [nullRateScaled, maxNullRateScaled] = scaled([nullRate, 0.02]);
  if (nullRateScaled > maxNullRateScaled) {
    return reject("BAD_TRAIN_DATA", `학습 데이터 결측률 ${format(nullRate)} > 0.02`);
  }

  const ci95 = candidate == null ? undefined : candidate.ci95;
  const ciLow = Array.isArray(ci95) ? ci95[0] : undefined;
  const ciHigh = Array.isArray(ci95) ? ci95[1] : undefined;
  const championHitRate = read(champion, ["hitRatePct"]);
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
  if (latency > 120 || latencyScaled * 5n > championLatencyScaled * 6n) {
    return reject(
      "LATENCY",
      `후보 지연 ${format(latency)}ms (기준 120ms 및 챔피언×1.2=${format(championLatency * 1.2)}ms)`,
    );
  }

  return { promote: true, code: "OK" };
}

module.exports = { detectDrift, retrainDecision, shouldPromote };
