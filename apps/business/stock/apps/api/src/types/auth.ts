export type AuthContext = {
  tenantId: string;
  userId: string;
  companyId: string;
  branchId?: string;
  email: string;
  role: string;
};

export type JwtUserPayload = {
  sub: string;
  tenantId: string;
  companyId: string;
  branchId?: string;
  email: string;
  role: string;
};
