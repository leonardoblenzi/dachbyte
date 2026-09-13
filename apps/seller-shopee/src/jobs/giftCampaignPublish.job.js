"use strict";
const { runPublishJob }=require("../services/GiftCampaignService");
module.exports=async function(job){if(job?.name!=="publish"||!job?.data?.campaignId)return{ok:true,ignored:true,reason:"unsupported_gift_campaign_job"};return runPublishJob({campaignId:String(job.data.campaignId),progress:(payload)=>job.updateProgress(payload)})};