"use strict";
const crypto = require("crypto");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(input){const clean=String(input||"").toUpperCase().replace(/[^A-Z2-7]/g,"");let bits="";for(const ch of clean){const i=ALPHABET.indexOf(ch);if(i<0)throw new Error("TOTP secret invalido");bits+=i.toString(2).padStart(5,"0");}const out=[];for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(out);}
function code(secret,timeStep=Math.floor(Date.now()/1000/30)){const key=decodeBase32(secret);const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(timeStep));const h=crypto.createHmac("sha1",key).update(buf).digest();const offset=h[h.length-1]&0xf;const n=((h[offset]&0x7f)<<24)|((h[offset+1]&0xff)<<16)|((h[offset+2]&0xff)<<8)|(h[offset+3]&0xff);return String(n%1_000_000).padStart(6,"0");}
function verify(secret,value,window=1){const supplied=String(value||"").replace(/\D/g,"");if(supplied.length!==6)return false;const step=Math.floor(Date.now()/1000/30);for(let d=-window;d<=window;d++){const expected=code(secret,step+d);if(crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))return true;}return false;}
module.exports={code,verify};
