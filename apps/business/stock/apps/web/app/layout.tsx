import type { Metadata } from 'next';
import './globals.css';

const basePath = process.env.NEXT_PUBLIC_VOLTSTOCK_BASE_PATH ?? '/voltstock';

export const metadata: Metadata = {
  title: 'DACHBYTE Stock',
  description: 'DACHBYTE Stock: controle visual com mapa 2D/3D, QR Code, bipagem e auditoria.',
  icons: {
    icon: `${basePath}/brand/voltstock-favicon.png`,
    shortcut: `${basePath}/favicon.ico`,
    apple: `${basePath}/brand/voltstock-favicon.png`
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" data-dachbyte-line="business" data-dachbyte-app="stock">
      <head><link rel="stylesheet" href="/brand/dachbyte/theme.css?v=20260904" /></head>
      <body>{children}</body>
    </html>
  );
}
