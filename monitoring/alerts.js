// [Mission 2] 알림 규칙 — 학생이 완성하는 파일
// 규칙 하나 = { id, severity: "page"(즉시 호출) | "ticket"(근무 시간 확인), runbook: "RB-…", evaluate(window, ctx) }
//   window : 최근 최대 120분의 분 단위 지표 배열(마지막 원소가 현재). 필드는 docs/OPS_CONTRACT.md 2장
//   ctx    : { t, minuteOfDay, slo, expectedRequests }   (이 시각의 평소 요청 수 = ops.expected(minuteOfDay))
//   반환   : true/false  (또는 { fire: true, reason })
// 평가: node scripts/eval.js alerts   (공개 시나리오 5개)
module.exports = {
  rules: [
    {
      id: "deploy-error-spike",
      severity: "page",
      runbook: "RB-ERR-01",
      evaluate: (window) => {
        const consecutiveMinutes = 4; // 4분 연속이면 공개 기준의 5분 감지 목표 안에 든다.
        const minRequestsPerMinute = 100; // 평소 최저 약 480건/분, 새벽 40% 수준도 약 192건/분이므로 저표본을 거른다.
        const errorRateThreshold = 0.01; // 1%는 평소 약 0.4%의 2.5배이며 availability SLO 오류 한도 0.5%의 2배다.
        const recent = window.slice(-consecutiveMinutes);

        return recent.length === consecutiveMinutes && recent.every(
          (sample) =>
            sample.requests >= minRequestsPerMinute &&
            sample.errors / sample.requests > errorRateThreshold
        );
      },
    },
    {
      id: "brief-error-spike",
      severity: "ticket",
      runbook: "RB-ERR-02",
      evaluate: (window) => {
        const observationMinutes = 3; // 3분 관찰로 같은 길이의 공개 일시 급증을 놓치지 않는다.
        const requiredMinutes = 2; // 3분 중 2분을 요구해 한 번의 튐만으로 티켓을 만들지 않는다.
        const minRequestsPerMinute = 100; // 평소 최저 약 480건/분, 새벽 40% 수준도 약 192건/분이므로 저표본을 거른다.
        const errorRateThreshold = 0.01; // 1%는 평소 약 0.4%의 2.5배이며 availability SLO 오류 한도 0.5%의 2배다.
        const recent = window.slice(-observationMinutes);

        return (
          recent.length === observationMinutes &&
          recent.every((sample) => sample.requests >= minRequestsPerMinute) &&
          recent.filter((sample) => sample.errors / sample.requests > errorRateThreshold).length >=
            requiredMinutes
        );
      },
    },
    {
      id: "persistent-error-rate",
      severity: "ticket",
      runbook: "RB-ERR-03",
      evaluate: (window) => {
        const observationMinutes = 15; // 15분 동안 반복되는 오류를 봐 짧은 급증과 구분한다.
        const requiredMinutes = 10; // 15분 중 10분을 요구해 평소 약 0.4%의 흔들림과 SLO 0.5% 경계 부근의 간헐값을 거른다.
        const minRequestsPerMinute = 100; // 평소 최저 약 480건/분, 새벽 40% 수준도 약 192건/분이므로 저표본은 판단하지 않는다.
        const errorRateThreshold = 0.01; // 1%는 평소 약 0.4%의 2.5배이며 SLO 오류 한도 0.5%의 2배다.
        const pageConsecutiveMinutes = 4; // RB-ERR-01의 4분 연속 page 조건과 동일하게 중복 여부를 판정한다.
        const recent = window.slice(-observationMinutes);

        if (
          recent.length !== observationMinutes ||
          recent.some((sample) => sample.requests < minRequestsPerMinute)
        ) {
          return false;
        }

        const pageAlreadyFired = recent.some((_, startIndex) => {
          const pageWindow = recent.slice(
            startIndex,
            startIndex + pageConsecutiveMinutes
          );
          return (
            pageWindow.length === pageConsecutiveMinutes &&
            pageWindow.every(
              (sample) =>
                sample.requests >= minRequestsPerMinute &&
                sample.errors / sample.requests > errorRateThreshold
            )
          );
        });

        return (
          !pageAlreadyFired &&
          recent.filter(
            (sample) => sample.errors / sample.requests > errorRateThreshold
          ).length >= requiredMinutes
        );
      },
    },
    {
      id: "slo-latency-breach",
      severity: "page",
      runbook: "RB-LAT-01",
      evaluate: (window, ctx) => {
        const observationMinutes = 8; // 8분 창에서 일시 변동이 아닌 지속 초과를 판단한다.
        const requiredMinutes = 5; // 8분 중 5분 초과를 요구해 한두 번의 튐을 거른다.
        const p95ThresholdMs = ctx.slo.p95Ms; // config/slo.json의 p95Ms 800ms SLO를 그대로 사용한다.
        const recent = window.slice(-observationMinutes);

        return (
          recent.length === observationMinutes &&
          recent.filter((sample) => sample.p95Ms > p95ThresholdMs).length >=
            requiredMinutes
        );
      },
    },
    {
      id: "relative-latency-rise",
      severity: "ticket",
      runbook: "RB-LAT-02",
      evaluate: (window) => {
        const maxWindowMinutes = 120; // OPS_CONTRACT가 허용하는 최대 120분 표본으로 오래된 기준 구간을 확보한다.
        const baselineMinutes = 60; // 창의 오래된 60분(현재 기준 60~120분 전)을 평소 기준으로 삼는다.
        const observationMinutes = 15; // 승인된 최근 15분 관찰 창으로 지속 상승을 확인한다.
        const requiredMinutes = 10; // 최근 15분 중 10분을 요구해 단발 상승만으로 티켓을 만들지 않는다.
        const riseFactor = 1.5; // 계약서에 정해진 값이 아닌 제안값이며, 기준 중앙값보다 50% 이상 상승한 경우를 의미한다.
        const history = window.slice(-maxWindowMinutes);

        if (history.length !== maxWindowMinutes) {
            return false;
        }

        const baselineValues = history
            .slice(0, baselineMinutes)
            .map((sample) => sample.p95Ms)
            .filter(Number.isFinite)
            .sort((left, right) => left - right);
        const recent = history.slice(-observationMinutes);

        if (
            baselineValues.length !== baselineMinutes ||
            recent.length !== observationMinutes ||
            recent.some((sample) => !Number.isFinite(sample.p95Ms))
        ) {
            return false;
        }

        const middleIndex = baselineValues.length / 2; // 짝수인 60개 기준 표본의 중앙 두 값 위치다.
        const baselineMedian =
            (baselineValues[middleIndex - 1] + baselineValues[middleIndex]) / 2; // 중앙 두 값의 평균으로 중앙값을 구한다.

        return (
            recent.filter(
              (sample) => sample.p95Ms >= baselineMedian * riseFactor
            ).length >= requiredMinutes
        );
      },
    },
    {
      id: "traffic-drop",
      severity: "page",
      runbook: "RB-TRAFFIC-01",
      evaluate: (window, ctx) => {
        const observationMinutes = 7; // 승인된 최근 7분 창에서 지속적인 감소를 확인한다.
        const requiredMinutes = 5; // 5/7은 단기 하락을 걸러내기 위한 제안값이며 계약서에 정해진 값은 아니다.
        const expectedFraction = 0.5; // 50% 미만은 제안값이며, 시간대별 ctx.expectedRequests 대비 비율로 비교한다.
        const recent = window.slice(-observationMinutes);

        return (
            recent.length === observationMinutes &&
            recent.filter(
              (sample) => sample.requests < ctx.expectedRequests * expectedFraction
            ).length >= requiredMinutes
        );
      },
    },
    {
      id: "payment-failure-rate",
      severity: "page",
      runbook: "RB-PAY-01",
      evaluate: (window, ctx) => {
        const minimumWindowMinutes = 10; // 최초 10분은 제안된 시작 창이며, 짧은 지연으로 실패율을 확인하기 위한 값이다.
        const requiredPaymentAttempts = 400; // 400회는 제안 표본 하한(5% 부근 비율의 근사 95% 오차폭 약 2.1%p)이며 계약서 고정값은 아니다.
        const maximumWindowMinutes = 120; // OPS_CONTRACT가 허용하는 최대 120분 표본 창이다.
        const failureRateThreshold = ctx.slo.paymentFailMax; // config/slo.json의 paymentFailMax 0.05(5%) SLO를 사용한다.
        const persistenceMinutes = 5; // 최근 5분 조건은 3분짜리 일시 이상에 page하지 않기 위한 제안값이다.
        const requiredPersistenceMinutes = 4; // 5분 중 4분 조건은 제안값으로, 순간 초과를 걸러낸다.
        const minAttemptsPerMinute = 20; // 분당 20회 미만은 비율 표본 부족으로 간주하는 제안값이다.
        const available = window.slice(-maximumWindowMinutes);
        const recentMinutes = window.slice(-persistenceMinutes);

        if (recentMinutes.length !== persistenceMinutes) {
            return false;
        }

        const persistentPerMinuteBreach =
            recentMinutes.filter(
              (sample) =>
                sample.paymentAttempts >= minAttemptsPerMinute &&
                sample.paymentFails / sample.paymentAttempts > failureRateThreshold
            ).length >= requiredPersistenceMinutes;

        if (!persistentPerMinuteBreach) {
            return false;
        }

        if (available.length < minimumWindowMinutes) {
            return false;
        }

        let selectedWindowMinutes = minimumWindowMinutes;
        let selectedWindow = available.slice(-selectedWindowMinutes);
        let totalPaymentAttempts = selectedWindow.reduce(
            (total, sample) => total + sample.paymentAttempts,
            0
        );

        while (
            totalPaymentAttempts < requiredPaymentAttempts &&
            selectedWindowMinutes < maximumWindowMinutes &&
            selectedWindowMinutes < available.length
        ) {
            selectedWindowMinutes += 1;
            selectedWindow = available.slice(-selectedWindowMinutes);
            totalPaymentAttempts = selectedWindow.reduce(
              (total, sample) => total + sample.paymentAttempts,
              0
            );
        }

        if (
            !totalPaymentAttempts ||
            totalPaymentAttempts < requiredPaymentAttempts
        ) {
            return false;
        }

        const totalPaymentFails = selectedWindow.reduce(
            (total, sample) => total + sample.paymentFails,
            0
        );

        return totalPaymentFails / totalPaymentAttempts > failureRateThreshold;
      },
    },
    {
      id: "recommendation-quality-drop",
      severity: "ticket",
      runbook: "RB-REC-01",
      evaluate: (window, ctx) => {
        const observationMinutes = 15; // 최근 15분 창은 지속 저하를 보려는 제안값이며 계약서에 정해진 값은 아니다.
        const minimumImpressions = 1000; // 1,000회는 클릭률 비율을 판단하기 위한 제안 표본 하한이다.
        const baselineFraction = 0.75; // 75%는 제안값이며, ctx.slo.recCtrBaseline 8%의 75%인 6%를 기준으로 삼는다.
        const recent = window.slice(-observationMinutes);

        if (recent.length !== observationMinutes) {
          return false;
        }

        const totalImpressions = recent.reduce(
          (total, sample) => total + sample.recImpr,
          0
        );
        if (!totalImpressions || totalImpressions < minimumImpressions) {
          return false;
        }

        const totalClicks = recent.reduce(
          (total, sample) => total + sample.recClicks,
          0
        );
        const ctrThreshold = ctx.slo.recCtrBaseline * baselineFraction; // 8% × 75% = 제안 임계값 6%.

        return totalClicks / totalImpressions < ctrThreshold;
      },
    },
  ],
};
