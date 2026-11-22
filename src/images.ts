export async function compressImage(image: Blob): Promise<Blob> {
  if (!['image/jpeg', 'image/png'].includes(image.type) || image.size < 200 * 1024) return image
  // Leave animated PNGs unmodified.
  if (image.type === 'image/png') {
    const bytes = new Uint8Array(await image.arrayBuffer())
    const chunks = new DataView(bytes.buffer)
    for (let offset = 8; offset + 8 <= bytes.length; offset += 12 + chunks.getUint32(offset)) {
      const type = chunks.getUint32(offset + 4)
      if (type === 0x6163544c) return image
      if (type === 0x49444154) break
    }
  }
  let bitmap: ImageBitmap | undefined
  try {
    bitmap = await createImageBitmap(image)
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return image
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.86))
    return compressed && compressed.size < image.size ? compressed : image
  } catch {
    return image
  } finally {
    bitmap?.close()
  }
}
