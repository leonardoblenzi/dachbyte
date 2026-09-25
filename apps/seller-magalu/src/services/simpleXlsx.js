"use strict";

const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function xml(value) { return String(value == null ? "" : value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function colName(index) { let n=index+1,out=""; while(n){ n--; out=String.fromCharCode(65+(n%26))+out; n=Math.floor(n/26); } return out; }

function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g,"/"));
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const localHeader = Buffer.concat([
      u32(0x04034b50),u16(20),u16(0),u16(8),u16(0),u16(0),u32(crc),u32(compressed.length),u32(raw.length),u16(name.length),u16(0),name,
    ]);
    local.push(localHeader, compressed);
    central.push(Buffer.concat([
      u32(0x02014b50),u16(20),u16(20),u16(0),u16(8),u16(0),u16(0),u32(crc),u32(compressed.length),u32(raw.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name,
    ]));
    offset += localHeader.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(centralBuffer.length),u32(offset),u16(0)]);
  return Buffer.concat([...local, centralBuffer, end]);
}

function createXlsx(rows, columns, sheetName = "Auditoria") {
  const data = [columns.map((c) => c.header), ...rows.map((row) => columns.map((c) => row[c.key]))];
  const sheetRows = data.map((row, r) => `<row r="${r+1}">${row.map((value,c) => `<c r="${colName(c)}${r+1}" t="inlineStr"><is><t xml:space="preserve">${xml(value && typeof value === "object" ? JSON.stringify(value) : value)}</t></is></c>`).join("")}</row>`).join("");
  const files = [
    { name:"[Content_Types].xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name:"_rels/.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name:"xl/workbook.xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName).slice(0,31)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name:"xl/_rels/workbook.xml.rels", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name:"xl/worksheets/sheet1.xml", data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` },
  ];
  return zip(files);
}

module.exports = { createXlsx, _test: { crc32, colName, zip } };
