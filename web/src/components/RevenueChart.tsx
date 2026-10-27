import { useId, useRef } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Granularity, RevenueSeriesPoint } from '../../../shared/types.ts';
import { downloadChartPng } from '../chartExport.ts';
import { formatCompactCurrency, formatCurrency, formatNumber } from '../format.ts';
import { useChartAnimationGate } from '../hooks/useChartAnimationGate.ts';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion.ts';
import { ChartExportActions } from './ChartExportActions.tsx';

type Props = {
  points: RevenueSeriesPoint[];
  granularity: Granularity;
  comparison?: boolean;
  height?: number;
  seriesLabel?: string;
  valueFormat?: 'currency' | 'number';
};

export default function RevenueChart({
  points,
  granularity,
  comparison = false,
  height = 264,
  seriesLabel = '收入',
  valueFormat = 'currency',
}: Props) {
  const rawId = useId();
  const gradientId = `revenue-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const hasPrevious = comparison && points.some((point) => point.previous !== null);
  const frameRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const animationGate = useChartAnimationGate(!reducedMotion);
  const chartLabel = `${seriesLabel}趋势`;
  const formatValue = (value: number) =>
    valueFormat === 'currency' ? formatCurrency(value) : formatNumber(value);
  const csvRows: Array<Array<string | number>> = [
    ['周期', seriesLabel, ...(hasPrevious ? ['上一周期'] : [])],
    ...points.map((point) => [
      point.bucket,
      point.revenue,
      ...(hasPrevious ? [point.previous ?? ''] : []),
    ]),
  ];

  const exportPng = async (): Promise<boolean> => {
    await animationGate.waitForAnimation();
    return downloadChartPng(frameRef.current, `${seriesLabel}-趋势`);
  };

  return (
    <div className="chart-widget">
      <div
        className="chart-frame"
        ref={frameRef}
        style={{ height }}
        role="img"
        aria-label={`${chartLabel}，共 ${points.length} 个数据点，可用下方 CSV 导出完整数据`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            margin={{ top: 8, right: 10, left: 0, bottom: 0 }}
            accessibilityLayer
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8065E9" stopOpacity={0.34} />
                <stop offset="100%" stopColor="#8065E9" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 7" stroke="#EDE9F8" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: '#8B8BA3' }}
              minTickGap={granularity === 'day' ? 24 : 12}
              dy={8}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={62}
              tick={{ fontSize: 11, fill: '#8B8BA3' }}
              tickFormatter={(value: number) =>
                valueFormat === 'currency' ? formatCompactCurrency(value) : formatNumber(value)
              }
            />
            <Tooltip
              cursor={{ stroke: '#C9BDF3', strokeWidth: 1.5, strokeDasharray: '4 4' }}
              contentStyle={{
                borderRadius: 16,
                border: '1px solid #EFECF9',
                boxShadow: '0 18px 40px -22px rgba(70,52,140,.45)',
                fontSize: 12.5,
                padding: '10px 14px',
              }}
              labelStyle={{ color: '#77778F', marginBottom: 4 }}
              formatter={(value, name) => {
                const formatted =
                  valueFormat === 'currency'
                    ? formatCurrency(Number(value ?? 0))
                    : formatNumber(Number(value ?? 0));
                return [formatted, name === 'previous' ? '上一周期' : seriesLabel];
              }}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#8065E9"
              strokeWidth={2.6}
              fill={`url(#${gradientId})`}
              activeDot={{ r: 5, strokeWidth: 3, stroke: '#FFFFFF', fill: '#8065E9' }}
              isAnimationActive={!reducedMotion}
              animationDuration={520}
              onAnimationStart={animationGate.onAnimationStart}
              onAnimationEnd={animationGate.onAnimationEnd}
            />
            {hasPrevious ? (
              <Line
                type="monotone"
                dataKey="previous"
                stroke="#C7BFF0"
                strokeWidth={2}
                strokeDasharray="5 6"
                dot={false}
                isAnimationActive={!reducedMotion}
                animationDuration={520}
                onAnimationStart={animationGate.onAnimationStart}
                onAnimationEnd={animationGate.onAnimationEnd}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>{chartLabel}</caption>
        <thead>
          <tr>
            <th scope="col">周期</th>
            <th scope="col">{seriesLabel}</th>
            {hasPrevious ? <th scope="col">上一周期</th> : null}
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.bucket}>
              <th scope="row">{point.label}</th>
              <td>{formatValue(point.revenue)}</td>
              {hasPrevious ? (
                <td>{point.previous === null ? '—' : formatValue(point.previous)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      <ChartExportActions
        targetRef={frameRef}
        filename={`${seriesLabel}-趋势`}
        label={chartLabel}
        rows={csvRows}
        onExportPng={exportPng}
      />
    </div>
  );
}
