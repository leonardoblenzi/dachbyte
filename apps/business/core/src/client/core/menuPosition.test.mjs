import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("menu stays visible beside the trigger and flips above a clipped row", async () => {
  const source = fs.readFileSync(new URL("./menuPosition.js", import.meta.url), "utf8");
  const { positionMenu } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(positionMenu({ left: 1450, right: 1580, top: 320, bottom: 350 }, { width: 210, height: 130 }, { width: 1600, height: 400 }), { left: 1370, top: 182 });
  assert.deepEqual(positionMenu({ left: 8, right: 88, top: 20, bottom: 50 }, { width: 230, height: 120 }, { width: 320, height: 600 }), { left: 8, top: 58 });
});
