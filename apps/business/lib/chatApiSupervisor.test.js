"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChatApiExitHandler } = require("./chatApiSupervisor");

test("reinicia a suite quando a API interna do VoltChat encerra inesperadamente", () => {
  let reportedExit;
  let termination;
  const logs = [];
  const handleExit = createChatApiExitHandler({
    isShuttingDown: () => false,
    onChatApiExit: (exit) => { reportedExit = exit; },
    terminateSuite: (exit) => { termination = exit; },
    log: (message) => logs.push(message),
  });

  handleExit(1, null);

  assert.deepEqual(reportedExit, { code: 1, signal: null });
  assert.deepEqual(termination, { code: 1, signal: null });
  assert.match(logs[0], /Reiniciando o servico/);
});

test("nao reinicia a suite durante o desligamento solicitado", () => {
  let termination = false;
  const handleExit = createChatApiExitHandler({
    isShuttingDown: () => true,
    onChatApiExit: () => {},
    terminateSuite: () => { termination = true; },
  });

  handleExit(0, "SIGTERM");

  assert.equal(termination, false);
});
