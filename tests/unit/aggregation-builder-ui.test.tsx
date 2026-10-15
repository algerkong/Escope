import { useMemo } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AggregationBuilderDialog } from '../../src/features/query/AggregationBuilderDialog';
import { createSessionSavedChartService } from '../../src/services/saved-charts';
import { useSavedCharts } from '../../src/features/query/useSavedCharts';
import type { FieldCatalog } from '../../src/domain/resource';
import { i18n } from '../../src/locales';

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
});

function TestWrapper({
  initialDsl = '{\n  "query": { "match_all": {} }\n}',
  onApplyDsl = vi.fn(),
}: {
  initialDsl?: string;
  onApplyDsl?: (newDsl: string) => void;
}) {
  const service = useMemo(() => createSessionSavedChartService(), []);
  const controller = useSavedCharts(service);

  const sampleCatalog: FieldCatalog = {
    indices: ['logs'],
    fields: [
      {
        name: 'status.keyword',
        conflict: false,
        types: [{ type: 'keyword', searchable: true, aggregatable: true, metadata: false }],
      },
      {
        name: 'duration',
        conflict: false,
        types: [{ type: 'long', searchable: true, aggregatable: true, metadata: false }],
      },
    ],
  };

  return (
    <I18nextProvider i18n={i18n}>
      <AggregationBuilderDialog
        open
        onClose={vi.fn()}
        currentDsl={initialDsl}
        currentIndex="logs"
        connectionId="conn_1"
        fieldCatalog={sampleCatalog}
        onApplyDsl={onApplyDsl}
        savedChartsController={controller}
      />
    </I18nextProvider>
  );
}

describe('AggregationBuilderDialog UI', () => {
  it('renders builder dialog and allows adding and configuring an aggregation clause', async () => {
    const onApply = vi.fn();
    render(<TestWrapper onApplyDsl={onApply} />);

    expect(screen.getByText('Aggregation Builder')).toBeInTheDocument();

    // Click "Add Aggregation"
    const addBtn = screen.getByText('Add Aggregation');
    fireEvent.click(addBtn);

    // Clause should appear
    const nameInput = screen.getByLabelText('Aggregation Name');
    expect(nameInput).toBeInTheDocument();
    fireEvent.change(nameInput, { target: { value: 'status_terms' } });

    // Apply to query button should be enabled
    const applyBtn = screen.getByText('Apply to Query');
    expect(applyBtn).toBeEnabled();

    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalled();
    const appliedDsl = onApply.mock.calls[0]![0];
    expect(appliedDsl).toContain('"status_terms"');
    expect(appliedDsl).toContain('"terms"');
    expect(appliedDsl).toContain('"match_all"');
  });

  it('allows adding sub metrics to terms aggregation', async () => {
    const onApply = vi.fn();
    render(<TestWrapper onApplyDsl={onApply} />);

    fireEvent.click(screen.getByText('Add Aggregation'));

    // Click "Add Sub-metric"
    const addSubBtn = screen.getByText('Add Sub-metric');
    fireEvent.click(addSubBtn);

    const subNameInput = screen.getByLabelText('Metric Name');
    expect(subNameInput).toBeInTheDocument();
    fireEvent.change(subNameInput, { target: { value: 'avg_latency' } });

    const applyBtn = screen.getByText('Apply to Query');
    fireEvent.click(applyBtn);

    expect(onApply).toHaveBeenCalled();
    const appliedDsl = onApply.mock.calls[0]![0];
    expect(appliedDsl).toContain('"avg_latency"');
  });
});
