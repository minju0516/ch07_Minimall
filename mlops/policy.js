// [Mission 3] MLOps 정책 — 학생이 완성하는 파일
// 세 함수를 구현한다. 규칙은 docs/OPS_CONTRACT.md 5장. 평가: node scripts/eval.js policy
// 실제로 돌려 보기: node scripts/retrain.js --scenario normal|shift|dirty
const { psi } = require("../lib/ops");

// history : 일 단위 스냅샷 배열(마지막이 오늘). { day, weekday, volume, nullRate, priceBins[10], catBins[6] }
// ctx     : { reference: { priceBins, catBins }, today }
// 반환    : { drift: boolean, kind: "covariate" | "data_quality" | "none", reason? }
function detectDrift(history, ctx) {
  // TODO
  return { drift: false, kind: "none" };
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
