"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {code}=require("../src/totp");

test("TOTP gera seis digitos deterministicamente no mesmo timestep",()=>{
  const secret="JBSWY3DPEHPK3PXP";
  const a=code(secret,123456);
  const b=code(secret,123456);
  assert.match(a,/^\d{6}$/);
  assert.equal(a,b);
});
