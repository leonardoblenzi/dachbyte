"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const examplePath = path.join(root, ".env.example");
const localPath = path.join(root, ".env");
const sensitive = {
  DB_VOLTPRICE: "postgresql://USER:PASSWORD@POOLED_HOST/DATABASE?sslmode=verify-full",
  DB_VOLTPRICE_DIRECT: "postgresql://USER:PASSWORD@DIRECT_HOST/DATABASE?sslmode=verify-full",
};

function lines(file) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : []; }
function parse(rows) {
  const values = new Map();
  for (const row of rows) {
    if (!row || row.trim().startsWith("#") || !row.includes("=")) continue;
    const index = row.indexOf("=");
    values.set(row.slice(0,index).trim(), row.slice(index+1).trim());
  }
  return values;
}
function upsert(rows,key,value) {
  const index = rows.findIndex((row) => row.startsWith(`${key}=`));
  if (index >= 0) rows[index] = `${key}=${value}`;
  else rows.push(`${key}=${value}`);
}

const exampleRows = lines(examplePath);
const exampleValues = parse(exampleRows);
const localRows = lines(localPath);
for (const [key, placeholder] of Object.entries(sensitive)) {
  const current = exampleValues.get(key);
  if (current && !current.includes("USER:PASSWORD") && !current.includes("_HOST/")) upsert(localRows,key,current);
  upsert(exampleRows,key,placeholder);
}
while (exampleRows.at(-1) === "") exampleRows.pop();
fs.writeFileSync(localPath, `${localRows.filter(Boolean).join("\n")}\n`, { encoding:"utf8", mode:0o600 });
fs.writeFileSync(examplePath, `${exampleRows.join("\n")}\n`, "utf8");
console.log("[VoltPrice] URLs locais movidas para .env ignorado e .env.example sanitizado.");
