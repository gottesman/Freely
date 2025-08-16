export async function computeHash(buffer: ArrayBuffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return hex(new Uint8Array(hash))
}

function hex(arr: Uint8Array) {
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('')
}

export function chunkArrayBuffer(buf: ArrayBuffer, chunkSize = 256 * 1024) {
  const chunks: ArrayBuffer[] = []
  let offset = 0
  while (offset < buf.byteLength) {
    const end = Math.min(offset + chunkSize, buf.byteLength)
    chunks.push(buf.slice(offset, end))
    offset = end
  }
  return chunks
}