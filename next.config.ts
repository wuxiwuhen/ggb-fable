import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // GeoGebra 的 deployggb.js 在客户端动态加载, 不需要 Next 打包
  reactStrictMode: true,
  // 把 prompts/*.md 以原始字符串打进服务端 bundle(供 lib/server-prompts.ts import)。
  // 仅 server-prompts 引用 .md; 不影响客户端代码, 提示词不进前端 bundle。
  webpack: (config) => {
    config.module.rules.push({ test: /\.md$/i, type: 'asset/source' });
    return config;
  },
};

export default nextConfig;
