function formatEyePrescription(prescription = {}, side) {
  const prefix = side === "right" ? "right" : "left";
  return `${prescription[`${prefix}Spherical`] ?? "-"} esf / ${prescription[`${prefix}Cylindrical`] ?? "-"} cil / ${prescription[`${prefix}Axis`] ?? "-"} eixo`;
}

function formatPrescriptionMeasures(prescription = {}) {
  return `DNP OD ${prescription.rightDnp ?? "-"} / OE ${prescription.leftDnp ?? "-"} / DP ${prescription.pupillaryDistance ?? "-"}`;
}

export { formatEyePrescription, formatPrescriptionMeasures };
