// Pure water-quality scoring. No I/O — fully unit-testable.

export type WaterStatus = 'Good' | 'Moderate' | 'Poor' | 'Unknown';

export const STATUS_COLORS: Record<WaterStatus, string> = {
  Good: '#00E676',
  Moderate: '#FFD700',
  Poor: '#FF1744',
  Unknown: '#607D8B',
};

export interface WaterParams {
  temp?: number;        // °C (context only, not graded)
  do?: number;          // dissolved oxygen, mg/L
  ph?: number;
  conductance?: number; // µS/cm (context only, not graded)
  turbidity?: number;   // FNU
  nitrate?: number;     // mg/L as N
}

export interface WaterAssessment {
  status: WaterStatus;
  color: string;
  reason: string;
}

type Grade = 'Good' | 'Moderate' | 'Poor';
const RANK: Record<Grade, number> = { Good: 0, Moderate: 1, Poor: 2 };

interface ParamGrade { grade: Grade; reason: string; }

function gradeDO(v: number): ParamGrade {
  if (v < 2) return { grade: 'Poor', reason: `Dissolved oxygen critically low (${v} mg/L)` };
  if (v <= 5) return { grade: 'Moderate', reason: `Dissolved oxygen low (${v} mg/L)` };
  return { grade: 'Good', reason: `Dissolved oxygen healthy (${v} mg/L)` };
}

function gradePH(v: number): ParamGrade {
  if (v < 6.0 || v > 9.0) return { grade: 'Poor', reason: `pH out of safe range (${v})` };
  if (v < 6.5 || v > 8.5) return { grade: 'Moderate', reason: `pH borderline (${v})` };
  return { grade: 'Good', reason: `pH normal (${v})` };
}

function gradeNitrate(v: number): ParamGrade {
  if (v > 10) return { grade: 'Poor', reason: `Nitrate exceeds drinking limit (${v} mg/L)` };
  if (v >= 1) return { grade: 'Moderate', reason: `Nitrate elevated (${v} mg/L)` };
  return { grade: 'Good', reason: `Nitrate low (${v} mg/L)` };
}

function gradeTurbidity(v: number): ParamGrade {
  if (v > 25) return { grade: 'Poor', reason: `High turbidity (${v} FNU)` };
  if (v >= 5) return { grade: 'Moderate', reason: `Moderate turbidity (${v} FNU)` };
  return { grade: 'Good', reason: `Clear water (${v} FNU)` };
}

export function assessWater(params: WaterParams): WaterAssessment {
  const grades: ParamGrade[] = [];
  if (Number.isFinite(params.do)) grades.push(gradeDO(params.do as number));
  if (Number.isFinite(params.ph)) grades.push(gradePH(params.ph as number));
  if (Number.isFinite(params.nitrate)) grades.push(gradeNitrate(params.nitrate as number));
  if (Number.isFinite(params.turbidity)) grades.push(gradeTurbidity(params.turbidity as number));

  if (grades.length === 0) {
    return { status: 'Unknown', color: STATUS_COLORS.Unknown, reason: 'No gradable parameters reported' };
  }

  const worst = grades.reduce((a, b) => (RANK[b.grade] > RANK[a.grade] ? b : a));
  const status: WaterStatus = worst.grade;
  const reason = worst.grade === 'Good' ? 'All measured parameters within normal range' : worst.reason;
  return { status, color: STATUS_COLORS[status], reason };
}
