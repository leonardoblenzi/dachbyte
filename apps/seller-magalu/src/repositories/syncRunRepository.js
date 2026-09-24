"use strict";
const db=require("../config/postgres");
async function createRun({dachTenantId,accountId,syncType,cursorIn=null,result={}}){const {rows}=await db.query(`insert into magalu.sync_runs
(dach_tenant_id,account_id,sync_type,status,cursor_in,result) values($1,$2,$3,'running',$4,$5::jsonb) returning *`,[String(dachTenantId),Number(accountId),String(syncType),cursorIn,JSON.stringify(result||{})]);return rows[0]||null;}
async function finishRun(runId,{status,cursorOut=null,scannedCount=0,createdCount=0,updatedCount=0,failedCount=0,result={},errorMessage=null}={}){const {rows}=await db.query(`update magalu.sync_runs set status=$2,cursor_out=$3,scanned_count=$4,created_count=$5,updated_count=$6,
failed_count=$7,result=coalesce(result,'{}'::jsonb)||$8::jsonb,error_message=$9,finished_at=now() where id=$1 returning *`,[Number(runId),String(status),cursorOut,Number(scannedCount)||0,Number(createdCount)||0,Number(updatedCount)||0,Number(failedCount)||0,JSON.stringify(result||{}),errorMessage?String(errorMessage).slice(0,4000):null]);return rows[0]||null;}
async function listRuns(accountId,limit=10){const {rows}=await db.query(`select id,sync_type,status,cursor_in,cursor_out,scanned_count,created_count,updated_count,failed_count,result,error_message,started_at,finished_at from magalu.sync_runs where account_id=$1 order by started_at desc limit $2`,[Number(accountId),Math.min(50,Math.max(1,Number(limit)||10))]);return rows;}
async function latestRun(accountId){return db.queryOne(`select id,sync_type,status,scanned_count,created_count,updated_count,failed_count,result,error_message,started_at,finished_at from magalu.sync_runs where account_id=$1 order by started_at desc limit 1`,[Number(accountId)]);}
module.exports={createRun,finishRun,listRuns,latestRun};
