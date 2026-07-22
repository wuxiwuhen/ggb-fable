// .md 经 next.config 的 asset/source 规则以原始字符串导入(仅 lib/server-prompts.ts 使用)
declare module '*.md' {
  const content: string;
  export default content;
}
