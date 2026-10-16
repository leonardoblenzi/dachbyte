import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("sale date defaults and converts using the company timezone", async () => {
  const source = fs.readFileSync(new URL("./companyDateTime.js", import.meta.url), "utf8");
  const { formatCompanyDateTimeLocal, companyLocalDateTimeToISOString } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal(formatCompanyDateTimeLocal("America/Sao_Paulo", new Date("2026-10-16T12:34:00Z")), "2026-10-16T09:34");
  assert.equal(companyLocalDateTimeToISOString("2026-10-16T09:34", "America/Sao_Paulo"), "2026-10-16T12:34:00.000Z");
});
