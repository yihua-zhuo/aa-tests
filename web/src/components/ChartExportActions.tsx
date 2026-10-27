import { type RefObject, useState } from 'react';
import { downloadChartPng, downloadCsv } from '../chartExport.ts';
import { Icon } from './Icon.tsx';

type Props = {
  targetRef: RefObject<HTMLDivElement | null>;
  filename: string;
  label: string;
  rows: Array<Array<string | number>>;
  onExportPng?: () => Promise<boolean>;
};

export function ChartExportActions({ targetRef, filename, label, rows, onExportPng }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const exportPng = async () => {
    setBusy(true);
    setError(false);
    try {
      const exported = onExportPng
        ? await onExportPng()
        : await downloadChartPng(targetRef.current, filename);
      if (!exported) setError(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chart-export">
      <span className="chart-export-label">导出</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => downloadCsv(filename, rows)}
        aria-label={`导出${label}数据为 CSV`}
      >
        <Icon name="download" size={13} />
        CSV
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => void exportPng()}
        disabled={busy}
        aria-label={`导出${label}为 PNG 图片`}
      >
        {busy ? <span className="spinner" /> : <Icon name="download" size={13} />}
        PNG
      </button>
      {error ? (
        <span className="chart-export-error" role="alert">
          图片导出失败
        </span>
      ) : null}
    </div>
  );
}
