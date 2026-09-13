export const rolePermissions = {
  admin: [
    'companies.manage',
    'users.manage',
    'map.manage',
    'products.manage',
    'stock.move',
    'stock.adjust',
    'inventory.run',
    'audit.read',
    'integrations.manage',
    'labels.manage'
  ],
  gestor: [
    'map.manage',
    'products.manage',
    'stock.move',
    'stock.adjust',
    'inventory.run',
    'audit.read',
    'labels.manage'
  ],
  operador: ['products.create', 'stock.move', 'inventory.run', 'labels.print'],
  auditor: ['inventory.run', 'audit.read'],
  integrador: ['integrations.manage']
} as const;

export type VoltRole = keyof typeof rolePermissions;
export type VoltPermission = (typeof rolePermissions)[VoltRole][number];

export function hasPermission(role: VoltRole, permission: VoltPermission): boolean {
  return (rolePermissions[role] as readonly string[]).includes(permission);
}

export function hasAnyPermission(role: VoltRole, permissions: readonly VoltPermission[]): boolean {
  return permissions.some((permission) => hasPermission(role, permission));
}
