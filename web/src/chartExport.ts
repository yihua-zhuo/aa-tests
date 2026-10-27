function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function safeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'chart';
}

export function downloadCsv(filename: string, rows: Array<Array<string | number>>): void {
  const content = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `${safeFilename(filename)}.csv`);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export type ChartPngOptions = {
  background?: string;
  width?: number;
  height?: number;
  draw?: (frame: {
    context: CanvasRenderingContext2D;
    width: number;
    height: number;
    chartWidth: number;
    chartHeight: number;
    image: HTMLImageElement;
  }) => void;
};

export async function downloadChartPng(
  container: HTMLElement | null,
  filename: string,
  options: ChartPngOptions = {},
): Promise<boolean> {
  const svg = container?.querySelector('svg');
  if (!svg) return false;

  const bounds = svg.getBoundingClientRect();
  const chartWidth = Math.max(1, Math.round(bounds.width));
  const chartHeight = Math.max(1, Math.round(bounds.height));
  const width = Math.max(1, Math.round(options.width ?? chartWidth));
  const height = Math.max(1, Math.round(options.height ?? chartHeight));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(chartWidth));
  clone.setAttribute('height', String(chartHeight));

  const source = new XMLSerializer().serializeToString(clone);
  // A blob: URL would be blocked by the app's img-src CSP; data: is allowed.
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('无法渲染图表'));
    image.src = svgUrl;
  });

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.scale(scale, scale);
  context.fillStyle = options.background ?? '#ffffff';
  context.fillRect(0, 0, width, height);
  context.save();
  if (options.draw) {
    options.draw({ context, width, height, chartWidth, chartHeight, image });
  } else {
    context.drawImage(image, 0, 0, chartWidth, chartHeight);
  }
  context.restore();
  triggerDownload(canvas.toDataURL('image/png'), `${safeFilename(filename)}.png`);
  return true;
}
