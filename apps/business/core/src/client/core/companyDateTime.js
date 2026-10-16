function companyDateParts(timezone, instant) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
}

function formatCompanyDateTimeLocal(timezone, instant = new Date()) {
  const parts = companyDateParts(timezone, instant);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function companyLocalDateTimeToISOString(value, timezone) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Data/hora da venda invalida");
  const requested = Date.UTC(...[Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])]);
  let instant = requested;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = companyDateParts(timezone, new Date(instant));
    const displayed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    instant += requested - displayed;
  }
  if (formatCompanyDateTimeLocal(timezone, new Date(instant)) !== value) {
    throw new Error("Data/hora inexistente no fuso da empresa");
  }
  return new Date(instant).toISOString();
}

export { companyLocalDateTimeToISOString, formatCompanyDateTimeLocal };
