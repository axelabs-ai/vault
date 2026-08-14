/**
 * 서비스 목록 드리프트 가드.
 *
 * `src/lib/services.ts` 는 @axe/ui 정본(`axelabs/src/lib/contracts/services.ts`)의 사본이다
 * (Consumer Kit 이 이 데이터를 내보내지 않는 이유는 그 파일 주석 참조). 사본은 조용히
 * 낡는다 — 정본이 옆에 있을 때는 기계가 대조한다.
 *
 * 정본 체크아웃이 없는 환경(CI 컨테이너 등)에서는 건너뛴다. axe-ui:check 스크립트도 같은
 * 상대 경로(`../../axelabs`)를 전제한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { platformServices, SELF_SERVICE_KEY } from "../src/lib/services.ts";

const CANONICAL = fileURLToPath(new URL("../../../axelabs/src/lib/contracts/services.json", import.meta.url));

test("이 앱은 정본 목록에 자기 자신으로 등재돼 있다", () => {
  assert.ok(
    platformServices.some((s) => s.key === SELF_SERVICE_KEY),
    "self key 가 목록에 없으면 전환기에 현재 서비스 표시가 서지 않는다",
  );
});

test("사본이 @axe/ui 정본과 같다", (t) => {
  let canonical;
  try {
    canonical = JSON.parse(readFileSync(CANONICAL, "utf8"));
  } catch {
    t.skip(`정본 체크아웃 없음: ${CANONICAL}`);
    return;
  }
  // services.json 은 배열이거나 {services:[…]} 투영일 수 있다 — 둘 다 받는다.
  const rows = Array.isArray(canonical) ? canonical : canonical.services;
  assert.ok(Array.isArray(rows), "정본 투영에서 배열을 못 찾았다 (형식 변경?)");
  assert.deepEqual(
    platformServices.map((s) => ({ key: s.key, label: s.label, detail: s.detail, href: s.href })),
    rows.map((s) => ({ key: s.key, label: s.label, detail: s.detail, href: s.href })),
    "정본이 바뀌었다 — src/lib/services.ts 를 맞출 것",
  );
});
