function formatEyePrescription(prescription = {}, side) {
  const prefix = side === "right" ? "right" : "left";
  return `${prescription[`${prefix}Spherical`] ?? "-"} esf / ${prescription[`${prefix}Cylindrical`] ?? "-"} cil / ${prescription[`${prefix}Axis`] ?? "-"} eixo`;
}

function formatPrescriptionMeasures(prescription = {}) {
  return `DNP OD ${prescription.rightDnp ?? "-"} / OE ${prescription.leftDnp ?? "-"} / DP ${prescription.pupillaryDistance ?? "-"}`;
}

function prescriptionTypeLabel(value) {
  const labels = { distance: "Longe", near: "Perto", multifocal: "Multifocal" };
  return labels[String(value || "").toLowerCase()] || value || "Receita óptica";
}

export { formatEyePrescription, formatPrescriptionMeasures, prescriptionTypeLabel };
