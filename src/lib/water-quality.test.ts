import { describe, it, expect } from 'vitest';
import { assessWater, STATUS_COLORS } from './water-quality';

describe('assessWater', () => {
  it('returns Unknown when no gradable parameters are present', () => {
    const r = assessWater({ temp: 22, conductance: 800 });
    expect(r.status).toBe('Unknown');
    expect(r.color).toBe(STATUS_COLORS.Unknown);
    expect(r.reason).toMatch(/no gradable/i);
  });

  it('grades healthy water as Good', () => {
    const r = assessWater({ do: 8, ph: 7.2, nitrate: 0.4, turbidity: 2 });
    expect(r.status).toBe('Good');
    expect(r.color).toBe(STATUS_COLORS.Good);
    expect(r.reason).toMatch(/within normal range/i);
  });

  it('dissolved oxygen boundaries: >5 Good, 2-5 Moderate, <2 Poor', () => {
    expect(assessWater({ do: 5.1 }).status).toBe('Good');
    expect(assessWater({ do: 5 }).status).toBe('Moderate');
    expect(assessWater({ do: 2 }).status).toBe('Moderate');
    expect(assessWater({ do: 1.9 }).status).toBe('Poor');
  });

  it('pH boundaries: 6.5-8.5 Good, 6.0-6.5/8.5-9.0 Moderate, outside Poor', () => {
    expect(assessWater({ ph: 7 }).status).toBe('Good');
    expect(assessWater({ ph: 6.5 }).status).toBe('Good');
    expect(assessWater({ ph: 8.5 }).status).toBe('Good');
    expect(assessWater({ ph: 6.2 }).status).toBe('Moderate');
    expect(assessWater({ ph: 8.9 }).status).toBe('Moderate');
    expect(assessWater({ ph: 5.9 }).status).toBe('Poor');
    expect(assessWater({ ph: 9.1 }).status).toBe('Poor');
  });

  it('nitrate boundaries: <1 Good, 1-10 Moderate, >10 Poor', () => {
    expect(assessWater({ nitrate: 0.9 }).status).toBe('Good');
    expect(assessWater({ nitrate: 1 }).status).toBe('Moderate');
    expect(assessWater({ nitrate: 10 }).status).toBe('Moderate');
    expect(assessWater({ nitrate: 10.1 }).status).toBe('Poor');
  });

  it('turbidity boundaries: <5 Good, 5-25 Moderate, >25 Poor', () => {
    expect(assessWater({ turbidity: 4.9 }).status).toBe('Good');
    expect(assessWater({ turbidity: 5 }).status).toBe('Moderate');
    expect(assessWater({ turbidity: 25 }).status).toBe('Moderate');
    expect(assessWater({ turbidity: 25.1 }).status).toBe('Poor');
  });

  it('overall status is the worst of all parameters (worst-wins)', () => {
    const r = assessWater({ do: 9, ph: 7, nitrate: 12 }); // nitrate Poor dominates
    expect(r.status).toBe('Poor');
    expect(r.reason).toMatch(/nitrate/i);
  });

  it('ignores non-finite parameter values', () => {
    const r = assessWater({ do: NaN, ph: 7.2 });
    expect(r.status).toBe('Good');
  });
});
