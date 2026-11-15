// [Mission 1] 파이프라인 품질 게이트 — 학생이 완성하는 파일
// 구조: stages[] → { name, gates[] } → gate = { id, check(change) → { pass, code?, reason? } }
//   change : 변경 매니페스트(docs/OPS_CONTRACT.md 4장). 단계는 위에서 아래로 실행되고, 처음 실패한 게이트에서 멈춘다.
//   code   : 차단 사유 코드(4.3 표). 코드가 틀리면 부분 점수만 받는다.
// 평가: node scripts/eval.js pipeline   (공개 변경 10건)
const { shouldPromote } = require("../mlops/policy");   // 모델 승격 판단은 Mission 3 에서 만든 함수를 재사용한다
const ok = { pass: true };
const fail = (code, reason) => ({ pass: false, code, reason });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasTouch = (change, area) => Array.isArray(change && change.touches) && change.touches.includes(area);
const isDocsOnly = (change) =>
  Array.isArray(change && change.touches) &&
  change.touches.length > 0 &&
  change.touches.every((area) => area === "docs");
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

module.exports = {
  stages: [
    { name: "validate", gates: [
      {
        id: "secrets",
        check: (change) => {
          const secrets = change && change.diff && Array.isArray(change.diff.secrets)
            ? change.diff.secrets
            : [];
          const high = secrets.filter((secret) => isRecord(secret) && secret.confidence === "high");
          return high.length > 0
            ? fail("SECRET_LEAK", `high 신뢰도 비밀 값 ${high.length}건 (기준 0건; low는 통과)`)
            : ok;
        },
      },
      {
        id: "migration",
        check: (change) => {
          const migration = change && change.migration;
          if (!isRecord(migration) || migration.destructive !== true || migration.reversible === true) {
            return ok;
          }
          return fail(
            "DESTRUCTIVE_MIGRATION",
            `destructive=${String(migration.destructive)}, reversible=${String(migration.reversible)} (기준: destructive가 아니거나 reversible=true)`,
          );
        },
      },
    ] },
    { name: "test", gates: [
      {
        id: "tests-missing",
        check: (change) => {
          const tests = change && change.tests;
          const total = isRecord(tests) ? tests.total : undefined;
          return hasTouch(change, "src") && !(Number.isFinite(total) && total > 0)
            ? fail("TEST_MISSING", `tests.total=${String(total)} (기준: src 변경에서 1건 이상)`)
            : ok;
        },
      },
      {
        id: "tests-pass",
        check: (change) => {
          const tests = change && change.tests;
          const failed = isRecord(tests) ? tests.failed : undefined;
          return Number.isFinite(failed) && failed > 0
            ? fail("TEST_FAIL", `tests.failed=${String(failed)} (기준 0건)`)
            : ok;
        },
      },
      {
        id: "tests-skipped",
        check: (change) => {
          const tests = change && change.tests;
          const total = isRecord(tests) ? tests.total : undefined;
          const skipped = isRecord(tests) ? tests.skipped : undefined;
          if (
            !Number.isSafeInteger(total) ||
            total <= 0 ||
            !Number.isSafeInteger(skipped) ||
            skipped < 0
          ) {
            return ok;
          }
          return BigInt(skipped) * 20n > BigInt(total)
            ? fail("TEST_SKIPPED_MANY", `건너뜀 ${skipped}/${total}건 (>5% 기준; 정확히 5%는 통과)`)
            : ok;
        },
      },
      {
        id: "tests-flaky",
        check: (change) => {
          const tests = change && change.tests;
          const retries = isRecord(tests) ? tests.retries : undefined;
          return Number.isSafeInteger(retries) && retries >= 3
            ? fail("TEST_FLAKY", `tests.retries=${String(retries)} (기준 3회 이상; 2회까지 통과)`)
            : ok;
        },
      },
      {
        id: "coverage-drop",
        check: (change) => {
          const tests = change && change.tests;
          const coverage = isRecord(tests) ? tests.coveragePct : undefined;
          const baseline = isRecord(tests) ? tests.coverageBasePct : undefined;
          if (isDocsOnly(change) || !Number.isFinite(coverage) || !Number.isFinite(baseline)) {
            return ok;
          }
          const [coverageScaled, baselineScaled, threeScaled] = scaled([coverage, baseline, 3]);
          return coverageScaled + threeScaled < baselineScaled
            ? fail(
                "COVERAGE_DROP",
                `coveragePct=${String(coverage)}%, coverageBasePct=${String(baseline)}% (하락 ${String(coverage - baseline)}%p; 기준 −3.0%p 미만)`,
              )
            : ok;
        },
      },
      {
        id: "mutation-score",
        check: (change) => {
          if (!hasTouch(change, "src")) return ok;
          const tests = change && change.tests;
          const mutationScore = isRecord(tests) ? tests.mutationScore : undefined;
          if (!Number.isFinite(mutationScore)) {
            return fail("MUTATION_LOW", `mutationScore=${String(mutationScore)} (측정 기준 70 이상)`);
          }
          const [scoreScaled, minimumScaled] = scaled([mutationScore, 70]);
          return scoreScaled < minimumScaled
            ? fail("MUTATION_LOW", `mutationScore=${String(mutationScore)} (기준 70 이상)`)
            : ok;
        },
      },
    ] },
    { name: "model-eval", gates: [
      {
        id: "model-promotion",
        check: (change) => {
          const model = change && change.model;
          if (model == null) return ok;
          if (!isRecord(model) || !isRecord(model.candidate) || !isRecord(model.champion)) {
            return fail(
              "EVAL_TOO_SMALL",
              `후보·챔피언 정보 없음: candidate=${String(model && model.candidate)}, champion=${String(model && model.champion)} (기준: 둘 다 객체)`,
            );
          }
          const result = shouldPromote(model.candidate, model.champion);
          return result.promote ? ok : fail(result.code, result.reason);
        },
      },
    ] },
    { name: "build", gates: [
      {
        id: "build-success",
        check: (change) => {
          if (isDocsOnly(change)) return ok;
          const build = change && change.build;
          const buildOk = isRecord(build) ? build.ok : undefined;
          return buildOk === true
            ? ok
            : fail("BUILD_FAIL", `build.ok=${String(buildOk)} (기준 true; 문서만 바꾼 변경은 제외)`);
        },
      },
      {
        id: "runtime-critical-vulnerability",
        check: (change) => {
          const build = change && change.build;
          const vulns = isRecord(build) && Array.isArray(build.vulns) ? build.vulns : [];
          const critical = vulns.filter(
            (vulnerability) =>
              isRecord(vulnerability) &&
              vulnerability.scope === "runtime" &&
              vulnerability.severity === "critical",
          );
          return critical.length > 0
            ? fail(
                "VULN_CRITICAL",
                `runtime critical 취약점 ${critical.length}건 (기준 0건; dev critical과 runtime high는 통과)`,
              )
            : ok;
        },
      },
      {
        id: "size-limit",
        check: (change) => {
          if (isDocsOnly(change)) return ok;
          const build = change && change.build;
          const size = isRecord(build) ? build.sizeMB : undefined;
          const baseline = isRecord(build) ? build.baseSizeMB : undefined;
          if (!Number.isFinite(size) || !Number.isFinite(baseline) || size < 0 || baseline <= 0) {
            return ok;
          }
          const [sizeScaled, baselineScaled] = scaled([size, baseline]);
          return sizeScaled * 10n > baselineScaled * 13n
            ? fail(
                "SIZE_BLOAT",
                `sizeMB=${String(size)}, baseSizeMB=${String(baseline)}, 비율=${String(size / baseline)}배 (기준 1.3배 이하)`,
              )
            : ok;
        },
      },
    ] },
    { name: "staging", gates: [
      {
        id: "smoke-tests",
        check: (change) => {
          if (isDocsOnly(change)) return ok;
          const staging = change && change.staging;
          const passed = isRecord(staging) ? staging.smokePassed : undefined;
          const total = isRecord(staging) ? staging.smokeTotal : undefined;
          return Number.isFinite(total) && total > 0 && Number.isFinite(passed) && passed >= total
            ? ok
            : fail(
                "SMOKE_FAIL",
                `smokePassed=${String(passed)}, smokeTotal=${String(total)} (기준: total > 0이고 passed ≥ total)`,
              );
        },
      },
    ] },
  ],
};
