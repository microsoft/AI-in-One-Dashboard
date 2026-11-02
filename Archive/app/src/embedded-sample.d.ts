// Gzipped, base64 sample CSVs keyed by file name. Only the single-file build embeds them; elsewhere it's null.
declare module 'virtual:embedded-sample' {
  const files: Record<string, string> | null
  export default files
}
