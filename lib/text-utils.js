/* 服务端文本截断/单行化：报告与提示词增强共用，避免各处口径漂移。 */

export function clipText(text, max, suffix = '') {
  const s = text === null || text === undefined ? '' : String(text)
  return s.length > max ? s.slice(0, max) + suffix : s
}

export function oneLine(text, max = 300) {
  return clipText(String(text === null || text === undefined ? '' : text).replace(/\s*\n+\s*/g, ' ').trim(), max)
}
