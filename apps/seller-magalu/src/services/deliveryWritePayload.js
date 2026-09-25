"use strict";

const crypto = require("node:crypto");
const { encryptSecret, decryptSecret } = require("./tokenCipher");

const ACTIONS = Object.freeze({ INVOICE: "invoice_send", FINISH: "finish_delivery" });
const INVOICE_READ_SCOPE = "open:order-invoice-seller:read";
const DELIVERY_READ_SCOPE = "open:order-delivery-seller:read";
const ORDER_WRITE_SCOPE = "open:order-order-seller:write";
const DELIVERY_WRITE_SCOPE = "open:order-delivery-seller:write";
const LOGISTICS_WRITE_SCOPE = "open:order-logistics-seller:write";
const INVOICE_WRITE_SCOPES = Object.freeze([ORDER_WRITE_SCOPE, DELIVERY_WRITE_SCOPE, LOGISTICS_WRITE_SCOPE]);
const FINISH_WRITE_SCOPES = Object.freeze([DELIVERY_WRITE_SCOPE]);
const INVOICE_REQUIRED_SCOPES = Object.freeze([DELIVERY_READ_SCOPE,INVOICE_READ_SCOPE,...INVOICE_WRITE_SCOPES]);
const FINISH_REQUIRED_SCOPES = Object.freeze([DELIVERY_READ_SCOPE,...FINISH_WRITE_SCOPES]);
const REMOTE_SENSITIVE_KEYS = new Set(["xml","issuer","document","document_number","cpf","cnpj","email","phone","phones","address","street","number","complement","reference","recipient","raw_body","signature_header","authorization","access_token","refresh_token"]);

function text(value,max=2000){return String(value==null?"":value).trim().slice(0,max);}
function scopesSet(scopes){return new Set((Array.isArray(scopes)?scopes:[]).map(v=>text(v,300)).filter(Boolean));}
function hasScopes(account,required){const set=scopesSet(account?.scopes);return required.every(scope=>set.has(scope));}
function normalizeAction(value){const action=text(value,40).toLowerCase();if(!Object.values(ACTIONS).includes(action)){const e=new Error("Ação de entrega inválida.");e.code="MAGALU_DELIVERY_WRITE_ACTION_INVALID";e.status=400;throw e;}return action;}
function statusOf(payload){return text(payload?.status,80).toLowerCase();}
function channelIdOf(payload,fallback=null){return text(payload?.channel?.id||payload?.channel_id||fallback,160)||null;}
function orderCodeOf(payload,fallback=null){return text(payload?.order?.code||payload?.order_code||fallback,300)||null;}
function snapshot(payload, fallback={}){return{status:statusOf(payload)||text(fallback.status,80).toLowerCase()||null,channel_id:channelIdOf(payload,fallback.channel_id),order_code:orderCodeOf(payload,fallback.order_code),remote_id:text(payload?.id||payload?.remote_id||fallback.remote_id,300)||null};}
function sameSnapshot(before,current){if(!before||!current)return false;return String(before.remote_id||"")===String(current.remote_id||"")&&String(before.channel_id||"")===String(current.channel_id||"")&&String(before.status||"")===String(current.status||"");}
function validIso(value){const raw=text(value,80);if(!raw)return null;const d=new Date(raw);return Number.isNaN(d.getTime())?null:d.toISOString();}
function normalizeMoney(value){const n=Number(value);if(!Number.isFinite(n)||n<=0)return null;return Math.round(n*100)/100;}
function digits(value,max=60){return text(value,max).replace(/\D+/g,"");}
function maskIssuer(value){const d=digits(value,20);if(!d)return null;return d.length<=4?"****":`${"*".repeat(Math.max(0,d.length-4))}${d.slice(-4)}`;}
function invoiceMetadata(body){return{amount:body.amount,key:body.key,issued_at:body.issued_at,issuer_masked:maskIssuer(body.issuer),xml_bytes:Buffer.byteLength(body.xml||"","utf8")};}
function requestHash(value){return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function normalizeInvoiceInput(input, channelId, {maxXmlBytes=1_500_000}={}){
  const amount=normalizeMoney(input?.amount),key=digits(input?.key,80),xml=String(input?.xml==null?"":input.xml).trim(),issuedAt=validIso(input?.issued_at),issuer=digits(input?.issuer,20);
  if(amount==null){const e=new Error("Valor da NF-e inválido.");e.code="MAGALU_INVOICE_AMOUNT_INVALID";e.status=400;throw e;}
  if(!/^\d{44}$/.test(key)){const e=new Error("A chave da NF-e deve conter 44 dígitos.");e.code="MAGALU_INVOICE_KEY_INVALID";e.status=400;throw e;}
  if(!xml){const e=new Error("XML da NF-e obrigatório.");e.code="MAGALU_INVOICE_XML_REQUIRED";e.status=400;throw e;}
  const bytes=Buffer.byteLength(xml,"utf8");if(bytes>maxXmlBytes){const e=new Error(`XML da NF-e excede ${maxXmlBytes} bytes.`);e.code="MAGALU_INVOICE_XML_TOO_LARGE";e.status=413;throw e;}
  if(!issuedAt){const e=new Error("issued_at da NF-e inválido.");e.code="MAGALU_INVOICE_ISSUED_AT_INVALID";e.status=400;throw e;}
  if(issuer&&![11,14].includes(issuer.length)){const e=new Error("issuer deve conter CPF/CNPJ numérico quando informado.");e.code="MAGALU_INVOICE_ISSUER_INVALID";e.status=400;throw e;}
  const body={amount,channel:{extras:{},id:text(channelId,160)},issued_at:issuedAt,key,xml};if(issuer)body.issuer=issuer;
  return{body,metadata:invoiceMetadata(body)};
}
function normalizeFinishInput(input, channelId){const deliveredAt=validIso(input?.delivered_at);if(!deliveredAt){const e=new Error("delivered_at inválido.");e.code="MAGALU_DELIVERED_AT_INVALID";e.status=400;throw e;}if(new Date(deliveredAt).getTime()>Date.now()+5*60*1000){const e=new Error("delivered_at não pode estar no futuro.");e.code="MAGALU_DELIVERED_AT_FUTURE";e.status=400;throw e;}const body={channel:{extras:{},id:text(channelId,160)},delivered_at:deliveredAt};return{body,metadata:{delivered_at:deliveredAt}};}
function requiredScopes(action){return action===ACTIONS.INVOICE?INVOICE_REQUIRED_SCOPES:FINISH_REQUIRED_SCOPES;}
function sanitizeRemote(value,depth=0,seen=new WeakSet()){if(depth>10)return null;if(value==null||typeof value==="string"||typeof value==="number"||typeof value==="boolean")return value;if(typeof value!=="object")return null;if(seen.has(value))return null;seen.add(value);if(Array.isArray(value))return value.slice(0,300).map(v=>sanitizeRemote(v,depth+1,seen));const out={};for(const [rawKey,child] of Object.entries(value)){const key=String(rawKey||"");if(REMOTE_SENSITIVE_KEYS.has(key.toLowerCase()))continue;out[key]=sanitizeRemote(child,depth+1,seen);}return out;}
function encryptBody(body){return encryptSecret(JSON.stringify(body));}
function decryptBody(ciphertext){const raw=decryptSecret(ciphertext);if(!raw)return null;return JSON.parse(raw);}
function invoiceKeyPresent(payload,key){const target=digits(key,80);if(!target)return false;const seen=new Set();function walk(value,depth=0){if(value==null||depth>12)return false;if(typeof value==="string"||typeof value==="number")return digits(value,100)===target;if(typeof value!=="object"||seen.has(value))return false;seen.add(value);if(Array.isArray(value))return value.some(v=>walk(v,depth+1));for(const [k,v] of Object.entries(value)){if(["key","access_key","accesskey","chave","invoice_key"].includes(String(k).toLowerCase())&&digits(v,100)===target)return true;if(walk(v,depth+1))return true;}return false;}return walk(payload);}

module.exports={ACTIONS,INVOICE_READ_SCOPE,DELIVERY_READ_SCOPE,ORDER_WRITE_SCOPE,DELIVERY_WRITE_SCOPE,LOGISTICS_WRITE_SCOPE,INVOICE_WRITE_SCOPES,FINISH_WRITE_SCOPES,INVOICE_REQUIRED_SCOPES,FINISH_REQUIRED_SCOPES,hasScopes,normalizeAction,statusOf,snapshot,sameSnapshot,normalizeInvoiceInput,normalizeFinishInput,requiredScopes,requestHash,encryptBody,decryptBody,invoiceMetadata,invoiceKeyPresent,sanitizeRemote,_test:{text,scopesSet,validIso,normalizeMoney,digits,maskIssuer,channelIdOf,orderCodeOf}};
