import { useRef } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { ChannelSlice } from '../../../shared/types.ts';
import { downloadChartPng } from '../chartExport.ts';
import { formatNumber, formatPercent } from '../format.ts';
import { useChartAnimationGate } from '../hooks/useChartAnimationGate.ts';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion.ts';
import { ChartExportActions } from './ChartExportActions.tsx';

const EXPORT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif';
const EXPORT_PADDING = 20;
const EXPORT_MIN_WIDTH = 360;
const EXPORT_LEGEND_GAP = 14;
const EXPORT_HEADER_HEIGHT = 18;
const EXPORT_RULE_GAP = 6;
const EXPORT_ROW_HEIGHT = 22;
const EXPORT_VALUE_WIDTH = 62;

function fitCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

export const CHANNEL_COLORS: Record<string, string> = {
  'Organic Search': '#8065E9',
  Direct: '#65B99C',
  'Social Media': '#F19A7D',
  Email: '#6FA8F5',
};

const FALLBACK_COLORS = ['#E4B363', '#B27BD6', '#8FD3C1', '#F6B7A3'];

function colorFor(channel: string, index: number): string {
  return CHANNEL_COLORS[channel] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

type Props = {
  channels: ChannelSlice[];
  height?: number;
  showLegend?: boolean;
};

export default function ChannelDonut({ channels, height = 210, showLegend = true }: Props) {
  const total = channels.reduce((sum, slice) => sum + slice.sessions, 0);
  const frameRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const animationGate = useChartAnimationGate(!reducedMotion);
  const csvRows: Array<Array<string | number>> = [
    ['渠道', '会话', '占比%'],
    ...channels.map((slice) => [slice.channel, slice.sessions, slice.share]),
  ];

  // Recharts only renders the ring as SVG; the center total and legend are HTML overlays.
  const exportPng = async (): Promise<boolean> => {
    await animationGate.waitForAnimation();
    const host = frameRef.current;
    const svg = host?.querySelector('svg');
    if (!host || !svg) return false;
    const bounds = svg.getBoundingClientRect();
    const chartWidth = Math.max(1, Math.round(bounds.width));
    const chartHeight = Math.max(1, Math.round(bounds.height));
    const width = Math.max(chartWidth, EXPORT_MIN_WIDTH);
    const height =
      EXPORT_PADDING * 2 +
      chartHeight +
      EXPORT_LEGEND_GAP +
      EXPORT_HEADER_HEIGHT +
      EXPORT_RULE_GAP +
      channels.length * EXPORT_ROW_HEIGHT;

    return downloadChartPng(host, '渠道份额', {
      width,
      height,
      draw: ({
        context,
        width: canvasWidth,
        image,
        chartWidth: plotWidth,
        chartHeight: plotHeight,
      }) => {
        const imageX = (canvasWidth - plotWidth) / 2;
        const imageY = EXPORT_PADDING;
        context.drawImage(image, imageX, imageY, plotWidth, plotHeight);

        const centerX = canvasWidth / 2;
        const centerY = imageY + plotHeight / 2;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = '#172443';
        context.font = `600 24px ${EXPORT_FONT}`;
        context.fillText(formatNumber(total), centerX, centerY - 8);
        context.fillStyle = '#62627a';
        context.font = `11px ${EXPORT_FONT}`;
        context.fillText('总会话', centerX, centerY + 16);

        const left = EXPORT_PADDING;
        const right = canvasWidth - EXPORT_PADDING;
        const nameX = left + 18;
        const shareRight = right - EXPORT_VALUE_WIDTH - 10;
        const legendTop = imageY + plotHeight + EXPORT_LEGEND_GAP;
        const headerY = legendTop + EXPORT_HEADER_HEIGHT / 2;

        context.font = `11px ${EXPORT_FONT}`;
        context.fillStyle = '#6b6b83';
        context.textAlign = 'left';
        context.fillText('渠道', nameX, headerY);
        context.textAlign = 'right';
        context.fillText('占比', shareRight, headerY);
        context.fillText('会话', right, headerY);

        const ruleY = legendTop + EXPORT_HEADER_HEIGHT + 3;
        context.strokeStyle = '#ece7f8';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(left, ruleY);
        context.lineTo(right, ruleY);
        context.stroke();

        const rowsTop = legendTop + EXPORT_HEADER_HEIGHT + EXPORT_RULE_GAP;
        channels.forEach((slice, index) => {
          const rowCenter = rowsTop + index * EXPORT_ROW_HEIGHT + EXPORT_ROW_HEIGHT / 2;
          context.fillStyle = colorFor(slice.channel, index);
          context.fillRect(left, rowCenter - 4.5, 9, 9);

          context.textAlign = 'left';
          context.textBaseline = 'middle';
          context.fillStyle = '#62627a';
          context.font = `11.5px ${EXPORT_FONT}`;
          context.fillText(
            fitCanvasText(context, slice.channel, shareRight - nameX - 10),
            nameX,
            rowCenter,
          );

          context.textAlign = 'right';
          context.fillStyle = '#172443';
          context.font = `600 11.5px ${EXPORT_FONT}`;
          context.fillText(formatPercent(slice.share), shareRight, rowCenter);

          context.fillStyle = '#62627a';
          context.font = `11.5px ${EXPORT_FONT}`;
          context.fillText(formatNumber(slice.sessions), right, rowCenter);
        });
      },
    });
  };

  return (
    <div className="donut-widget">
      <div
        className="donut-frame"
        ref={frameRef}
        style={{ height }}
        role="img"
        aria-label={`渠道份额图，共 ${channels.length} 个渠道，总计 ${formatNumber(total)} 次会话`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={channels}
              dataKey="sessions"
              nameKey="channel"
              innerRadius="68%"
              outerRadius="94%"
              paddingAngle={3}
              cornerRadius={8}
              stroke="none"
              isAnimationActive={!reducedMotion}
              animationDuration={560}
              onAnimationStart={animationGate.onAnimationStart}
              onAnimationEnd={animationGate.onAnimationEnd}
            >
              {channels.map((slice, index) => (
                <Cell key={slice.channel} fill={colorFor(slice.channel, index)} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                borderRadius: 14,
                border: '1px solid #EFECF9',
                boxShadow: '0 18px 40px -22px rgba(70,52,140,.45)',
                fontSize: 12.5,
              }}
              formatter={(value, name) => [
                `${formatNumber(Number(value ?? 0))} 次访问`,
                String(name),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <strong>{formatNumber(total)}</strong>
          <span>总会话</span>
        </div>
      </div>

      {showLegend ? (
        <ul className="donut-legend">
          {channels.map((slice, index) => (
            <li key={slice.channel}>
              <span
                className="legend-swatch"
                style={{ background: colorFor(slice.channel, index) }}
              />
              <span className="legend-name">{slice.channel}</span>
              <span className="legend-share">{formatPercent(slice.share)}</span>
              <span className="legend-value">{formatNumber(slice.sessions)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <table className="visually-hidden">
        <caption>渠道份额</caption>
        <thead>
          <tr>
            <th scope="col">渠道</th>
            <th scope="col">会话</th>
            <th scope="col">占比</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((slice) => (
            <tr key={slice.channel}>
              <th scope="row">{slice.channel}</th>
              <td>{formatNumber(slice.sessions)}</td>
              <td>{formatPercent(slice.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ChartExportActions
        targetRef={frameRef}
        filename="渠道份额"
        label="渠道份额图"
        rows={csvRows}
        onExportPng={exportPng}
      />
    </div>
  );
}
