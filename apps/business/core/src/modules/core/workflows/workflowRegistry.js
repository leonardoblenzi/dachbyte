"use strict";

const workflows = Object.freeze({
  service_order: {
    key: "service_order",
    name: "Ordem de servico",
    initial: "open",
    states: ["open", "in_production", "waiting_part", "ready", "delivered", "canceled"],
    transitions: {
      open: ["in_production", "waiting_part", "ready", "canceled"],
      in_production: ["waiting_part", "ready", "canceled"],
      waiting_part: ["in_production", "ready", "canceled"],
      ready: ["delivered", "in_production", "canceled"],
      delivered: [],
      canceled: [],
    },
  },
  optical_order: {
    key: "optical_order",
    name: "Pedido optico",
    initial: "awaiting_lab",
    states: [
      "awaiting_prescription", "awaiting_measurements", "awaiting_lab", "ready_for_production",
      "sent_to_lab", "in_production", "received_from_lab", "quality_check", "ready", "delivered", "rework", "canceled",
    ],
    transitions: {
      awaiting_prescription: ["awaiting_measurements", "awaiting_lab", "canceled"],
      awaiting_measurements: ["awaiting_lab", "ready_for_production", "canceled"],
      awaiting_lab: ["ready_for_production", "sent_to_lab", "canceled"],
      ready_for_production: ["sent_to_lab", "in_production", "canceled"],
      sent_to_lab: ["in_production", "received_from_lab", "canceled"],
      in_production: ["received_from_lab", "rework", "canceled"],
      received_from_lab: ["quality_check", "rework", "canceled"],
      quality_check: ["ready", "rework", "canceled"],
      ready: ["delivered", "rework", "canceled"],
      rework: ["sent_to_lab", "in_production", "received_from_lab", "quality_check", "canceled"],
      delivered: [],
      canceled: [],
    },
  },
});

module.exports = { workflows };
