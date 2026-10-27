/** Center-crops an image to a square and re-encodes it as a small JPEG avatar. */
export async function centerCropAvatar(file: File, size = 256): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < 8) throw new Error('图片尺寸过小');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持图片裁剪');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      Math.round((bitmap.width - side) / 2),
      Math.round((bitmap.height - side) / 2),
      side,
      side,
      0,
      0,
      size,
      size,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('图片处理失败'))),
        'image/jpeg',
        0.9,
      );
    });
    return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
