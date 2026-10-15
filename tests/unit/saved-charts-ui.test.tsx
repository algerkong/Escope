import { useMemo } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedChartsDialog } from '../../src/features/query/SavedChartsDialog';
import { createSessionSavedChartService } from '../../src/services/saved-charts';
import { useSavedCharts } from '../../src/features/query/useSavedCharts';
import type { SavedChartDefinition } from '../../src/domain/saved-charts';
import { i18n } from '../../src/locales';
import { legacyChartDefinition } from '../../src/domain/chart-definition-sources';
import { enChartDefinitions } from '../../src/locales/chart-definitions';

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});

function TestSavedChartsWrapper({
  initialEntries = [],
  onApply = vi.fn(),
  legacy = false,
}: {
  initialEntries?: SavedChartDefinition[];
  onApply?: (chart: SavedChartDefinition) => void;
  legacy?: boolean;
}) {
  const service = useMemo(
    () => createSessionSavedChartService({ version: 1, entries: initialEntries }),
    [initialEntries]
  );
  const controller = useSavedCharts(service);

  return (
    <I18nextProvider i18n={i18n}>
      <SavedChartsDialog
        open
        onClose={vi.fn()}
        currentIndex="logs-2026"
        controller={controller}
        onApplyChart={onApply}
        legacy={legacy}
        canApplyChart={legacy ? (chart) => chart.connectionId === 'conn_1' && chart.index === 'logs-2026'
          && legacyChartDefinition(chart) !== null : undefined}
      />
    </I18nextProvider>
  );
}

describe('SavedChartsDialog UI', () => {
  const sampleChart: SavedChartDefinition = {
    id: 'chart_alpha',
    name: 'HTTP Error Rate',
    connectionId: 'conn_1',
    index: 'logs-2026',
    chartType: 'bar',
    clauses: [
      {
        id: 'c1',
        name: 'by_status',
        aggregationType: 'terms',
        field: 'status.keyword',
      },
    ],
    preferredMetric: null,
    description: null,
    updatedAt: '2026-10-13T10:00:00.000Z',
  };

  it('renders list of saved charts and applies selected chart', async () => {
    const onApply = vi.fn();
    render(<TestSavedChartsWrapper initialEntries={[sampleChart]} onApply={onApply} />);

    await waitFor(() => {
      expect(screen.getByText('HTTP Error Rate')).toBeInTheDocument();
    });

    const applyBtn = screen.getByText('Apply to Query');
    fireEvent.click(applyBtn);

    expect(onApply).toHaveBeenCalledWith(sampleChart);
  });

  it('filters charts by search keyword', async () => {
    const otherChart: SavedChartDefinition = {
      ...sampleChart,
      id: 'chart_beta',
      name: 'Memory Usage Line',
      chartType: 'line',
    };

    render(<TestSavedChartsWrapper initialEntries={[sampleChart, otherChart]} />);

    await waitFor(() => {
      expect(screen.getByText('HTTP Error Rate')).toBeInTheDocument();
      expect(screen.getByText('Memory Usage Line')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search saved charts/i);
    fireEvent.change(searchInput, { target: { value: 'Memory' } });

    expect(screen.queryByText('HTTP Error Rate')).not.toBeInTheDocument();
    expect(screen.getByText('Memory Usage Line')).toBeInTheDocument();
  });

  it('keeps previous definitions visible but only offers lossless reuse on the same target', async () => {
    const onApply = vi.fn();
    const entries = [sampleChart, { ...sampleChart, id: 'other', name: 'Other connection', connectionId: 'conn_2' },
      { ...sampleChart, id: 'ordered', name: 'Manual ordering',
        clauses: [{ ...sampleChart.clauses[0]!, orderDirection: 'asc' as const, orderMetric: '_count' }] }];
    render(<TestSavedChartsWrapper initialEntries={entries} onApply={onApply} legacy />);
    await screen.findByText('HTTP Error Rate');
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]!).getByRole('button', { name: enChartDefinitions.reuse })).toBeEnabled();
    for (const row of rows.slice(1)) {
      const reuse = within(row).getByRole('button', { name: enChartDefinitions.reuse });
      expect(reuse).toBeDisabled();
      fireEvent.click(reuse);
    }
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getAllByText(enChartDefinitions.legacyDefinition)).toHaveLength(3);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: enChartDefinitions.reuse }));
    expect(onApply).toHaveBeenCalledWith(sampleChart);
  });
});
