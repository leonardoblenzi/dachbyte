import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(2).optional()
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(24)
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().optional()
});

export const createProductSchema = z.object({
  companyId: z.string().uuid().optional(),
  productCode: z.string().trim().min(2).max(80),
  sku: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(120).optional(),
  name: z.string().trim().min(2).max(240),
  description: z.string().trim().max(1000).optional(),
  category: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  unit: z.string().trim().min(1).max(20).default('un'),
  trackingMode: z.enum(['none', 'lot', 'serial', 'pallet', 'box', 'unit']).default('none'),
  costAmount: z.coerce.number().nonnegative().optional()
});

export const updateProductSchema = createProductSchema.partial().omit({ companyId: true });

export const createFacilitySchema = z.object({
  companyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(180),
  facilityType: z.string().trim().min(2).max(60).default('warehouse'),
  dimensions: z.record(z.unknown()).default({})
});

export const bulkGenerateLocationsSchema = z.object({
  companyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  facilityId: z.string().uuid(),
  parentLocationId: z.string().uuid().optional(),
  aisleCode: z.string().trim().min(1).max(30).default('RUA-A'),
  rackCode: z.string().trim().min(1).max(30),
  rackName: z.string().trim().min(2).max(120),
  columns: z.coerce.number().int().min(1).max(80),
  levels: z.coerce.number().int().min(1).max(30),
  binsPerLevel: z.coerce.number().int().min(1).max(20),
  capacityPerBin: z.coerce.number().nonnegative().optional()
});

export const scanResolveSchema = z.object({
  scannedValue: z.string().trim().min(1).max(500),
  source: z.enum(['android_camera', 'web_camera', 'desktop_hid', 'manual']).default('manual'),
  sessionId: z.string().uuid().optional()
});

export const existingCodeIdentifySchema = z.object({
  scannedValue: z.string().trim().min(1).max(500),
  codeFormat: z.string().trim().max(40).default('unknown'),
  source: z.enum(['android_camera', 'web_camera', 'desktop_hid', 'manual']).default('manual'),
  createInternalIdentifier: z.boolean().default(true),
  linkToProductId: z.string().uuid().optional()
});

export const stockMoveSchema = z.object({
  companyId: z.string().uuid().optional(),
  productId: z.string().uuid(),
  fromLocationId: z.string().uuid().optional(),
  toLocationId: z.string().uuid().optional(),
  quantity: z.coerce.number().positive(),
  movementType: z.enum(['entrada', 'saida', 'alocacao', 'transferencia', 'ajuste', 'contagem', 'reserva', 'bloqueio']),
  lotCode: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(500).optional(),
  source: z.string().trim().max(80).default('manual')
});

export const allocationConfirmSchema = z.object({
  companyId: z.string().uuid().optional(),
  productId: z.string().uuid(),
  locationId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  flowType: z.enum(['product_to_location', 'location_to_product', 'new_product_allocation']).default('product_to_location'),
  lotCode: z.string().trim().max(120).optional()
});

export const labelRequestSchema = z.object({
  companyId: z.string().uuid().optional(),
  targetEntity: z.enum(['product', 'location']),
  entityIds: z.array(z.string().uuid()).min(1).max(100),
  copies: z.coerce.number().int().min(1).max(20).default(1),
  pageFormat: z.enum(['A4']).default('A4'),
  templateName: z.string().trim().min(2).max(120).default('Padrao A4'),
  includeBarcode: z.boolean().default(true),
  includePath: z.boolean().default(true)
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type StockMoveInput = z.infer<typeof stockMoveSchema>;
export type LabelRequestInput = z.infer<typeof labelRequestSchema>;
