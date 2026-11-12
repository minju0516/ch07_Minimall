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
  ],
};
