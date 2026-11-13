// [Mission 4] 카나리 롤아웃 판단 — 학생이 완성하는 파일
// 새 버전을 5% → 25% → 50% 로 늘려 가며 매 분 decide() 를 부른다. (규칙: docs/OPS_CONTRACT.md 6장)
//   ctx = { trafficPct, stepIndex, minuteInStep, elapsed, canary[], baseline[], slo }
//         canary / baseline : 이 단계 시작 이후의 분 단위 지표 배열(같은 시각의 두 갈래: 새 버전 vs 기존 버전)
//   반환 { action: "promote" | "hold" | "rollback", reason }
//   한 단계에서 30분 넘게 hold 하면 안전을 위해 자동 롤백된다.
// 평가: node scripts/eval.js rollout   (공개 릴리스 5개)
const ops = require("../lib/ops");

// 승인 표의 제안값: 최근 6분 중 5분 이상에서 오류율 회귀가 보여야 지속으로 본다.
const ROLLBACK_WINDOW_MINUTES = 6;
const REQUIRED_BAD_MINUTES = 5;
// 승인 표의 제안값: 분별 오류율은 canary 오류가 최소 1건인 분만 증거로 센다.
const MIN_ERRORS_PER_BAD_MINUTE = 1;
// 승인 표의 제안값: 최근 5분 합산도 오류 5건 이상이고 baseline보다 2%p 초과 나빠야 한다.
const AGGREGATE_WINDOW_MINUTES = 5;
const MIN_AGGREGATE_ERRORS = 5;
const ROLLBACK_ERROR_RATE_DELTA = 0.02;
// 승인 표의 제안 하한: canary의 최근 5분 요청 표본, 단계별 5% / 25% / 50%.
const MIN_RECENT_REQUESTS_BY_TRAFFIC_PCT = Object.freeze({
  5: 100,
  25: 500,
  50: 1000,
});
// 승인 표의 제안값: 승격 전 최소 6분 관찰, 단계 누적 canary 요청 200건.
const PROMOTION_MINUTES = 6;
const PROMOTION_MIN_REQUESTS = 200;
// 승인 표의 제안값: canary는 baseline보다 1%p 초과 나쁘지 않아야 하며 baseline 오류율은 1% 이하.
const PROMOTION_ERROR_RATE_DELTA = 0.01;
const MAX_BASELINE_ERROR_RATE = 0.01;
// 승인 표의 제안값: 최근 6분 중 5분 이상에서 canary p95가 baseline의 1.5배를 초과해야 한다.
const P95_ROLLBACK_MULTIPLIER = 1.5;
// 승인 표의 제안값: 승격 때 canary p95 중앙값은 baseline 중앙값의 1.2배 이내여야 한다.
// 5% 단계는 분별 p95 잡음이 커서 분별 비교 대신 최근 6분의 중앙값을 비교한다.
const P95_PROMOTION_MULTIPLIER = 1.2;

function contextIssue(ctx) {
  if (!ctx || !Array.isArray(ctx.canary) || !Array.isArray(ctx.baseline)) {
    return "ctx.canary와 ctx.baseline 표본 배열이 없어 판단을 보류합니다.";
  }
  if (ctx.canary.length !== ctx.baseline.length) {
    return "canary와 baseline 표본 수가 달라 같은 분 비교를 할 수 없어 판단을 보류합니다.";
  }

  for (let i = 0; i < ctx.canary.length; i++) {
    const canary = ctx.canary[i];
    const baseline = ctx.baseline[i];
    for (const [sample, branch] of [[canary, "canary"], [baseline, "baseline"]]) {
      if (
        !sample ||
        !Number.isInteger(sample.requests) ||
        !Number.isInteger(sample.errors) ||
        sample.requests < 0 ||
        sample.errors < 0 ||
        sample.errors > sample.requests
      ) {
        return `${branch}의 ${i + 1}번째 표본 값이 올바르지 않아 판단을 보류합니다.`;
      }
      if (sample.t !== undefined && !Number.isInteger(sample.t)) {
        return `${branch}의 ${i + 1}번째 표본 시각이 올바르지 않아 판단을 보류합니다.`;
      }
    }
    if (
      (canary.t !== undefined || baseline.t !== undefined) &&
      canary.t !== baseline.t
    ) {
      return `${i + 1}번째 canary와 baseline의 t가 달라 판단을 보류합니다.`;
    }
  }
  return null;
}

function isValidP95(value) {
  // p95 응답 시간은 0보다 큰 유한한 밀리초 값이어야 유효 표본으로 쓴다.
  return Number.isFinite(value) && value > 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function decide(ctx) {
  const issue = contextIssue(ctx);
  if (issue) return { action: "hold", reason: issue };

  const { canary, baseline, trafficPct } = ctx;
  const hasKnownTrafficPct = Object.prototype.hasOwnProperty.call(
    MIN_RECENT_REQUESTS_BY_TRAFFIC_PCT,
    trafficPct,
  );
  const rollbackRequestFloor = hasKnownTrafficPct
    ? MIN_RECENT_REQUESTS_BY_TRAFFIC_PCT[trafficPct]
    : Math.max(...Object.values(MIN_RECENT_REQUESTS_BY_TRAFFIC_PCT));
  const trafficPctNote = hasKnownTrafficPct
    ? ""
    : " 알 수 없는 trafficPct여서 가장 큰 요청 하한을 적용했습니다.";
  const recentCanary = ops.last(canary, AGGREGATE_WINDOW_MINUTES);
  const recentBaseline = ops.last(baseline, AGGREGATE_WINDOW_MINUTES);
  const recentBaselineRate = ops.ratio(recentBaseline, "errors", "requests");
  const baselineStageRate = ops.ratio(baseline, "errors", "requests");
  const canaryStageRate = ops.ratio(canary, "errors", "requests");

  const recentCanaryRequests = ops.sum(recentCanary, "requests");
  const recentCanaryErrors = ops.sum(recentCanary, "errors");
  const recentBaselineRequests = ops.sum(recentBaseline, "requests");
  const recentCanaryRate = ops.ratio(recentCanary, "errors", "requests");
  const recentBaselineAggregateRate = ops.ratio(recentBaseline, "errors", "requests");

  const rollbackMinutes = ops.last(canary, ROLLBACK_WINDOW_MINUTES);
  const rollbackBaselineMinutes = ops.last(baseline, ROLLBACK_WINDOW_MINUTES);
  let badMinuteCount = 0;
  for (let i = 0; i < rollbackMinutes.length; i++) {
    const canaryMinute = rollbackMinutes[i];
    const baselineMinute = rollbackBaselineMinutes[i];
    if (
      canaryMinute.requests > 0 &&
      baselineMinute.requests > 0 &&
      canaryMinute.errors >= MIN_ERRORS_PER_BAD_MINUTE &&
      canaryMinute.errors / canaryMinute.requests >
        baselineMinute.errors / baselineMinute.requests + ROLLBACK_ERROR_RATE_DELTA
    ) {
      badMinuteCount++;
    }
  }

  const rollbackEvidence =
    rollbackMinutes.length === ROLLBACK_WINDOW_MINUTES &&
    badMinuteCount >= REQUIRED_BAD_MINUTES &&
    recentCanaryRequests >= rollbackRequestFloor &&
    recentCanaryErrors >= MIN_AGGREGATE_ERRORS &&
    recentCanaryRate > recentBaselineAggregateRate + ROLLBACK_ERROR_RATE_DELTA;

  // 지연은 승인 표의 제안값대로 같은 분 p95를 최근 6분 중 5분 이상 비교한다.
  const recentCanaryP95Minutes = ops.last(canary, ROLLBACK_WINDOW_MINUTES);
  const recentBaselineP95Minutes = ops.last(baseline, ROLLBACK_WINDOW_MINUTES);
  let validP95PairCount = 0;
  let badP95MinuteCount = 0;
  const canaryP95Values = [];
  const baselineP95Values = [];
  for (let i = 0; i < recentCanaryP95Minutes.length; i++) {
    const canaryMinute = recentCanaryP95Minutes[i];
    const baselineMinute = recentBaselineP95Minutes[i];
    if (
      canaryMinute.requests === 0 ||
      baselineMinute.requests === 0 ||
      !isValidP95(canaryMinute.p95Ms) ||
      !isValidP95(baselineMinute.p95Ms)
    ) {
      continue;
    }

    validP95PairCount++;
    canaryP95Values.push(canaryMinute.p95Ms);
    baselineP95Values.push(baselineMinute.p95Ms);
    if (canaryMinute.p95Ms > baselineMinute.p95Ms * P95_ROLLBACK_MULTIPLIER) {
      badP95MinuteCount++;
    }
  }
  const latencyRollbackEvidence =
    recentCanaryP95Minutes.length === ROLLBACK_WINDOW_MINUTES &&
    recentBaselineP95Minutes.length === ROLLBACK_WINDOW_MINUTES &&
    badP95MinuteCount >= REQUIRED_BAD_MINUTES;

  // External degradation does not suppress a sustained canary-only regression; baseline health gates promotion only.
  const baselineRecentIsHealthy =
    recentBaselineRequests > 0 && recentBaselineRate <= MAX_BASELINE_ERROR_RATE;

  if (rollbackEvidence || latencyRollbackEvidence) {
    return {
      action: "rollback",
      reason: [
        rollbackEvidence && "오류율이 같은 분 baseline보다 지속적으로 높고 합산 기준도 초과했습니다.",
        latencyRollbackEvidence && "같은 분 canary p95가 baseline보다 지속적으로 높습니다.",
      ]
        .filter(Boolean)
        .join(" ") + trafficPctNote,
    };
  }

  const canaryStageRequests = ops.sum(canary, "requests");
  const baselineStageRequests = ops.sum(baseline, "requests");
  if (!baselineRecentIsHealthy) {
    return {
      action: "hold",
      reason: "baseline 오류율이 정상 기준을 벗어나 승격을 보류합니다." + trafficPctNote,
    };
  }

  if (
    canary.length >= PROMOTION_MINUTES &&
    canaryStageRequests >= PROMOTION_MIN_REQUESTS &&
    baselineStageRequests > 0 &&
    canaryStageRate <= baselineStageRate + PROMOTION_ERROR_RATE_DELTA &&
    validP95PairCount === ROLLBACK_WINDOW_MINUTES &&
    ctx.slo &&
    isValidP95(ctx.slo.p95Ms) &&
    median(canaryP95Values) <=
      median(baselineP95Values) * P95_PROMOTION_MULTIPLIER &&
    median(baselineP95Values) <= ctx.slo.p95Ms
  ) {
    return {
      action: "promote",
      reason: "오류율·지연 표본과 관찰 조건이 충족됐고 baseline 대비 허용 범위 안입니다." +
        trafficPctNote,
    };
  }

  return {
    action: "hold",
    reason:
      "오류율 롤백 증거가 부족하거나 승격 표본·관찰 조건을 아직 충족하지 않았습니다." +
      trafficPctNote,
  };
}
module.exports = { decide };
