import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // GeoGebra 的 deployggb.js 在客户端动态加载, 不需要 Next 打包
  reactStrictMode: true,
};

export default nextConfig;
