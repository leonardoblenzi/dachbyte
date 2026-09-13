import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NEXT_PRIVATE_BUILD_WORKER ??= '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const basePath = process.env.NEXT_PUBLIC_VOLTSTOCK_BASE_PATH ?? '/voltstock';

const nextConfig = {
  basePath,
  assetPrefix: basePath,
  outputFileTracingRoot: path.join(__dirname, '..', '..', '..', '..'),
  transpilePackages: ['@voltstock/shared'],
  experimental: {
    optimizePackageImports: ['lucide-react']
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false
    };
    return config;
  }
};

export default nextConfig;
