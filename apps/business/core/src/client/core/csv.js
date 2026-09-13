function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, rows, columns) {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(row[column.key])).join(","));
  const blob = new Blob([[header, ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.URL.revokeObjectURL(url);
}

function parseCsvText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(delimiter).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(delimiter).map((value) => value.trim());
    return headers.reduce((row, header, index) => ({ ...row, [header]: values[index] || "" }), {});
  });
}

export {
  csvCell,
  downloadCsv,
  parseCsvText,
};
