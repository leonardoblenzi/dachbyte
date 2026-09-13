"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeArchiveMessages, shouldCompactArchiveJournal } = require("./chatArchive");

test("mescla somente alteracoes incrementais sem duplicar mensagens", () => {
  const merged = mergeArchiveMessages(
    [
      { id: 10, company_id: "company-a", timestamp: "2026-08-17T10:00:00.000Z", content: "anterior" },
    ],
    [
      { id: 10, company_id: "company-a", timestamp: "2026-08-17T10:00:00.000Z", content: "editada" },
      { id: 11, company_id: "company-a", timestamp: "2026-08-17T10:01:00.000Z", content: "nova" },
    ],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, "editada");
  assert.equal(merged[1].id, 11);
});

test("mantem somente a janela mais recente do arquivo local", () => {
  const merged = mergeArchiveMessages(
    [
      { id: 1, company_id: "company-a", timestamp: "2026-08-17T10:00:00.000Z" },
      { id: 2, company_id: "company-a", timestamp: "2026-08-17T10:01:00.000Z" },
      { id: 3, company_id: "company-a", timestamp: "2026-08-17T10:02:00.000Z" },
    ],
    [],
    2,
  );

  assert.deepEqual(merged.map((message) => message.id), [2, 3]);
});

test("compacta somente quando o jornal acumula mensagens suficientes", () => {
  assert.equal(shouldCompactArchiveJournal(249, 250), false);
  assert.equal(shouldCompactArchiveJournal(250, 250), true);
});
