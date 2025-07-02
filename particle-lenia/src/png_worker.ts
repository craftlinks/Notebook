// Dedicated worker: encodes an ImageBitmap to a PNG Blob using OffscreenCanvas
// The main thread sends { frame, fileName, bitmap } and expects the blob back.

// Explicit module context for bundlers
export {};

self.onmessage = async (event: MessageEvent) => {
  const { frame, fileName, bitmap } = event.data as {
    frame: number;
    fileName: string;
    bitmap: ImageBitmap;
  };

  try {
    const { width, height } = bitmap;

    // Create offscreen canvas for encoding
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/png' });

    // Send blob back to main thread
    (self as DedicatedWorkerGlobalScope).postMessage({ frame, fileName, blob });
  } catch (error) {
    (self as DedicatedWorkerGlobalScope).postMessage({ frame, fileName, error: (error as Error).message });
  }
}; 