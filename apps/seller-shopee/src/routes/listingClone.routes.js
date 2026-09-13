const express = require("express");
const { requireAuth } = require("../middlewares/sessionAuth");
const asyncHandler = require("../utils/asyncHandler");
const uploadCloneImages = require("../middlewares/uploadCloneImages");
const uploadClipVideo = require("../middlewares/uploadClipVideo");
const ListingCloneController = require("../controllers/ListingCloneController");
const { chargeOperation } = require("../middlewares/shopeeCreditBilling");

const router = express.Router();

router.use(requireAuth);

router.post(
  "/shops/active/listing-clone/preview",
  chargeOperation("shopee.listing.preview"),
  asyncHandler(ListingCloneController.preview),
);
router.post(
  "/shops/active/listing-clone/category-attributes",
  chargeOperation("shopee.listing.attributes"),
  asyncHandler(ListingCloneController.categoryAttributes),
);
router.get(
  "/shops/active/listing-clone/categories",
  asyncHandler(ListingCloneController.categories),
);
router.get(
  "/shops/active/listing-clone/drafts",
  asyncHandler(ListingCloneController.listDrafts),
);
router.get(
  "/shops/active/listing-clone/drafts/:draftId",
  asyncHandler(ListingCloneController.getDraft),
);
router.post(
  "/shops/active/listing-clone/drafts/save",
  asyncHandler(ListingCloneController.saveDraft),
);
router.delete(
  "/shops/active/listing-clone/drafts/:draftId",
  asyncHandler(ListingCloneController.deleteDraft),
);
router.post(
  "/shops/active/listing-clone/logistics/validate",
  chargeOperation("shopee.listing.attributes"),
  asyncHandler(ListingCloneController.validateLogistics),
);
router.post(
  "/shops/active/listing-clone/images/upload",
  uploadCloneImages,
  chargeOperation("shopee.listing.media"),
  asyncHandler(ListingCloneController.uploadImages),
);
router.post(
  "/shops/active/listing-clone/video/upload",
  uploadClipVideo,
  chargeOperation("shopee.listing.media"),
  asyncHandler(ListingCloneController.uploadVideo),
);
router.post(
  "/shops/active/listing-clone/publish",
  chargeOperation("shopee.listing.publish"),
  asyncHandler(ListingCloneController.publish),
);

module.exports = router;
