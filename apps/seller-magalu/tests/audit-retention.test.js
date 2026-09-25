"use strict";
const test=require("node:test");const assert=require("node:assert/strict");
const {sanitizeAuditDetails,normalizeAuditEvent}=require("../src/services/auditSanitizer");
const {createXlsx}=require("../src/services/simpleXlsx");

test("sanitizer redacts secrets recursively and bearer/jwt-like strings",()=>{const input={access_token:"abc",token:"opaque",nested:{refresh_token:"def",safe:"Bearer abcdefghijklmnopqrstuv"},password:"x"};const out=sanitizeAuditDetails(input);assert.equal(out.access_token,"[REDACTED]");assert.equal(out.token,"[REDACTED]");assert.equal(out.nested.refresh_token,"[REDACTED]");assert.match(out.nested.safe,/Bearer \[REDACTED\]/);assert.equal(out.password,"[REDACTED]");});
test("audit normalization classifies protected writes and master actions",()=>{const w=normalizeAuditEvent({action:"WRITE_DIVERGENT",details:{}});assert.equal(w.category,"write");assert.equal(w.outcome,"divergent");assert.equal(w.severity,"warning");const a=normalizeAuditEvent({action:"MASTER_AUDIT_RETENTION_UPDATED"});assert.equal(a.category,"admin");});
test("xlsx generator creates a real ZIP/OOXML container",()=>{const buffer=createXlsx([{event_key:"write_verified",details:{ok:true}}],[{header:"event_key",key:"event_key"},{header:"details",key:"details"}]);assert.ok(Buffer.isBuffer(buffer));assert.equal(buffer.subarray(0,2).toString("ascii"),"PK");assert.ok(buffer.length>500);});
