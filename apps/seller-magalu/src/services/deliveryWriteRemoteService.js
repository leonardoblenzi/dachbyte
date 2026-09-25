"use strict";
const env=require("../config/env");
const magaluApiClient=require("./magaluApiClient");
const rateLimiter=require("./magaluRateLimiter");
function text(v,max=500){return String(v==null?"":v).trim().slice(0,max);}
function accountArgs(account){return{accountId:Number(account.id),dachTenantId:String(account.dach_tenant_id)};}
async function request(account,kind,method,path,{body=null,headers={},requestId=null,attempts=null,timeoutMs=15000}={}){await rateLimiter.waitFor(account.id,kind);return magaluApiClient.request(path,{method,...accountArgs(account),body,headers,requestId:requestId||undefined,attempts:attempts==null?(method==="GET"?4:1):attempts,timeoutMs});}
function deliveryHeaders(channelId){const channel=text(channelId,160);if(!channel){const e=new Error("channel_id ausente para a entrega.");e.code="MAGALU_DELIVERY_CHANNEL_REQUIRED";e.status=409;throw e;}return{"X-Channel-Id":channel};}
async function getDelivery(account,id,channelId){const remoteId=text(id,300);if(!remoteId)throw new Error("delivery_id ausente.");return request(account,"delivery-read","GET",`/seller/v1/deliveries/${encodeURIComponent(remoteId)}`,{headers:deliveryHeaders(channelId)});}
async function getHistory(account,id,channelId){const remoteId=text(id,300);return request(account,"delivery-read","GET",`/seller/v1/deliveries/${encodeURIComponent(remoteId)}/histories`,{headers:deliveryHeaders(channelId)});}
async function getInvoices(account,id,channelId){const remoteId=text(id,300);return request(account,"invoice-read","GET",`/seller/v1/deliveries/${encodeURIComponent(remoteId)}/invoices`,{headers:deliveryHeaders(channelId)});}
async function sendInvoice(account,id,body,requestId){const remoteId=text(id,300);return request(account,"delivery-write","POST",`/seller/v1/deliveries/${encodeURIComponent(remoteId)}/invoices`,{body,requestId,attempts:1});}
async function finishDelivery(account,id,body,requestId){const remoteId=text(id,300);return request(account,"delivery-write","POST",`/seller/v1/deliveries/${encodeURIComponent(remoteId)}/finishing`,{body,requestId,attempts:1});}
module.exports={getDelivery,getHistory,getInvoices,sendInvoice,finishDelivery,_test:{text,deliveryHeaders}};
