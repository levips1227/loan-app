import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  recalcLoanPayments,
  recalcAllLoans,
  round2,
  toISODate,
  parseISO,
  daysBetween,
  addMonths,
  addDays,
  amortizedPayment,
  isAmortizedType,
  fixedPIForLoan,
  EPS,
  nearlyEqual,
  recalcLoanPayments as engineRecalc,
  computePayoffDate,
  projectWithExtras,
} from './loanEngine';
// Local helper not shared in loanEngine
const addYears = (date, years) => {
  const d = parseISO(date);
  return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
};

// =============================
// Utility + Business Logic
// =============================

const FREQ = { Monthly: 12, Biweekly: 26, Weekly: 52, Quarterly: 4, Annual: 1 };
const EXTRA_FREQ = { day: 365, week: 52, month: 12, year: 1 };
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PASSWORD_MIN_LENGTH = 8;
const USER_ROLES = ['Admin', 'Standard User'];
const API_BASE = import.meta.env.VITE_API_BASE || '';

async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const message = data?.error || data?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}
function normalizeUsername(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}
function hasAnotherActiveAdmin(list, excludeId = null) {
  const admins = list.filter((u) => u.role === 'Admin' && !u.disabled && u.id !== excludeId);
  return admins.length > 0;
}

function nextByFreq(dt, freq) {
  switch (freq) {
    case 'Weekly': return addDays(dt, 7);
    case 'Biweekly': return addDays(dt, 14);
    case 'Monthly': return addMonths(dt, 1);
    case 'Quarterly': return addMonths(dt, 3);
    case 'Annual': return addYears(dt, 1);
    default: return addMonths(dt, 1);
  }
}
function periodsPerYear(freq) { return FREQ[freq] || 12; }

function listDueDates(loan, endDate) {
  if (!loan) return [];
  const end = parseISO(endDate);
  if (Number.isNaN(end.getTime())) return [];
  const freq = loan.PaymentFrequency || 'Monthly';
  let due = loan.NextPaymentDate
    ? parseISO(loan.NextPaymentDate)
    : addMonths(parseISO(loan.OriginationDate), 1);
  if (Number.isNaN(due.getTime())) return [];
  const dates = [];
  for (let i = 0; i < 2400 && due <= end; i += 1) {
    dates.push(new Date(due.getTime()));
    due = nextByFreq(due, freq);
  }
  return dates;
}

function calcPerDiem(apr, balance) { return (apr ?? 0) / 365 * (balance ?? 0); }
function calcPayoff(balance, apr, daysSince) { return Math.max(0, round2(balance + calcPerDiem(apr, balance) * Math.max(0, daysSince))); }

// Payment rule by loan type + frequency (principal & interest only; escrow handled separately)
function principalInterestPaymentFor(balance, apr, remainingMonths, freq, type) {
  const ppy = periodsPerYear(freq);
  const nPeriods = Math.max(1, Math.round((remainingMonths || 0) * ppy / 12));
  switch (type) {
    case 'Mortgage':
    case 'Car Loan':
    case 'Personal Loan':
      return amortizedPayment(balance, apr, nPeriods, ppy);
    case 'Revolving LOC':
      return round2((apr ?? 0) / ppy * (balance ?? 0)); // interest-only minimum
    case 'Credit Card': {
      // Common rule of thumb: monthly minimum = max(2% of balance, $25)
      const monthlyMin = Math.max(round2((balance ?? 0) * 0.02), 25);
      return round2(monthlyMin * 12 / ppy);
    }
    default:
      return amortizedPayment(balance, apr, nPeriods, ppy);
  }
}

// Full payment incl. escrow for a given loan
// CHANGE: for amortized types we now compute PI from ORIGINAL principal & term (fixed),
// falling back to provided `balance` only if OriginalPrincipal is missing (keeps tests valid).
function scheduledPaymentFor(loan, balance, remainingMonthsOverride) {
  const ppy = periodsPerYear(loan.PaymentFrequency || 'Monthly');
  const remainingMonths = typeof remainingMonthsOverride === 'number'
    ? remainingMonthsOverride
    : loan.TermMonths || 0;
  const toPeriods = (months) => Math.max(1, Math.round(((months || 0) * ppy) / 12));
  const amortizedFor = (principal, months = remainingMonths) =>
    amortizedPayment(principal ?? 0, loan.APR, toPeriods(months), ppy);
  let basePI = 0;
  if (isAmortizedType(loan.LoanType || 'Mortgage')) {
    if (typeof loan.OriginalPrincipal === 'number') {
      basePI = fixedPIForLoan(loan);
    } else {
      basePI = amortizedFor(balance);
    }
  } else if ((loan.LoanType || '') === 'Revolving LOC') {
    basePI = round2((loan.APR ?? 0) / ppy * (balance ?? 0));
  } else if ((loan.LoanType || '') === 'Credit Card') {
    const monthlyMin = Math.max(round2((balance ?? 0) * 0.02), 25);
    basePI = round2((monthlyMin * 12) / ppy);
  } else {
    basePI = amortizedFor(balance);
  }
  const escrowPerPeriod = round2(((loan.EscrowMonthly || 0) * 12) / ppy);
  return round2(basePI + escrowPerPeriod);
}

// ============ PROJECTION/ CALCULATOR ============
// Build projection events from a start date using base schedule + extras + draws
function projectToPayoff({ loan, balanceStart, startDate, extras = [], draws = [], maxYears = 100 }) {
  const events = [];
  const freq = loan.PaymentFrequency || 'Monthly';
  const ppy = periodsPerYear(freq);
  const endDate = addYears(startDate, maxYears);

  // Precompute constant parts
  const escrowPerPeriod = round2(((loan.EscrowMonthly || 0) * 12) / ppy);
  const amortized = isAmortizedType(loan.LoanType || 'Mortgage');

  // Determine whether this loan should be projected using a fixed payment schedule
  const usesFixedPayment = !!loan.FixedPayment || amortized;

  // Compute remaining periods based on origination date + TermMonths
  let remainingPeriods = null;
  if (loan.TermMonths && loan.OriginationDate) {
    const orig = parseISO(loan.OriginationDate);
    // More accurate months calculation considering day of month
    const origDate = new Date(orig);
    const startDt = new Date(startDate);
    const monthsElapsed = (startDt.getFullYear() - origDate.getFullYear()) * 12 + 
                         (startDt.getMonth() - origDate.getMonth()) +
                         (startDt.getDate() < origDate.getDate() ? -1 : 0);
    const monthsRemaining = Math.max(0, (loan.TermMonths || 0) - monthsElapsed);
    remainingPeriods = Math.max(0, Math.round((monthsRemaining * ppy) / 12));
  }

  // fixedBasePI: if using fixed payments, compute PI from ORIGINAL principal & term
  let fixedBasePI = 0;
  if (usesFixedPayment) {
    if (typeof loan.OriginalPrincipal === 'number' && loan.TermMonths > 0) {
      // Always use original amortization for fixed payment loans
      const origPeriods = Math.max(1, Math.round((loan.TermMonths * ppy) / 12));
      fixedBasePI = amortizedPayment(loan.OriginalPrincipal, loan.APR, origPeriods, ppy);
    } else {
      // Fallback to current balance and remaining term if original terms not available
      const n = remainingPeriods > 0 ? remainingPeriods : Math.max(1, Math.round((loan.TermMonths * ppy) / 12));
      fixedBasePI = amortizedPayment(balanceStart ?? 0, loan.APR, n, ppy);
    }
  }

  // Generate base payment schedule events
  let date = new Date(startDate);
  date = nextByFreq(date, freq);
  // For fixed payment loans, always generate full remaining schedule
  const periodsToProject = remainingPeriods > 0 ? remainingPeriods : ppy * maxYears;
  for (let i = 0; i < periodsToProject; i++) {
    if (date > endDate) break;
    events.push({ type: 'base', date: new Date(date) });
    date = nextByFreq(date, freq);
  }

  // Draws (future ones only)
  for (const d of draws.filter((x) => x.LoanRef === loan.id)) {
    const dd = parseISO(d.DrawDate || d.PaymentDate || d.date || d.Date || d.when || startDate);
    if (dd > startDate) events.push({ type: 'draw', date: dd, amount: round2(d.Amount || 0) });
  }

  // Extras rules → materialize into dated events
  for (const r of extras) {
    if (!r || !(r.amount > 0)) continue;
    if (r.kind === 'once') {
      const when = parseISO(r.date || startDate);
      if (when > startDate) events.push({ type: 'extra', date: when, amount: round2(r.amount) });
    } else {
      const ef = r.every || 'month';
      let when = parseISO(r.start || toISODate(startDate));
      if (when < startDate) when = new Date(startDate);
      for (let i = 0; i < (EXTRA_FREQ[ef] || 12) * maxYears; i++) {
        if (when > endDate) break;
        events.push({ type: 'extra', date: new Date(when), amount: round2(r.amount) });
        if (ef === 'day') when = addDays(when, 1);
        else if (ef === 'week') when = addDays(when, 7);
        else if (ef === 'month') when = addMonths(when, 1);
        else if (ef === 'year') when = addYears(when, 1);
      }
    }
  }

  // Sort events by date; on same day, apply draws first, then extras, then base payment
  events.sort((a, b) => a.date - b.date || (a.type === 'draw' ? -1 : a.type === 'extra' ? 0 : 1));

  // Iterate through events to build amortization timeline
  let bal = balanceStart ?? 0;
  let lastDate = new Date(startDate);
  let totalInterest = 0;
  let totalPrincipal = 0;
  let totalPaid = 0;
  const timeline = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const days = daysBetween(lastDate, ev.date);
    // Daily interest calculation
    const interestAccrued = round2(bal * (loan.APR ?? 0) / 365 * days);
    bal = round2(bal + interestAccrued);

    if (ev.type === 'draw') {
      bal = round2(bal + (ev.amount || 0));
    } else {
      // Calculate total payment amount including any same-day events

      let sameDayEvents = [ev];
      while (i + 1 < events.length && toISODate(events[i + 1].date) === toISODate(ev.date) && events[i + 1].type !== 'draw') {
        i++;
        sameDayEvents.push(events[i]);
      }

      // Process each event type for the day
      let basePayment = 0;
      let extrasTotal = 0;
      for (const e of sameDayEvents) {
        if (e.type === 'base') {
          if (amortized) {
            basePayment += round2(fixedBasePI + escrowPerPeriod);
          } else if ((loan.LoanType || '') === 'Revolving LOC') {
            const io = round2((loan.APR || 0) / ppy * bal);
            basePayment += round2(io + escrowPerPeriod);
          } else if ((loan.LoanType || '') === 'Credit Card') {
            const monthlyMin = Math.max(round2(bal * 0.02), 25);
            basePayment += round2((monthlyMin * 12) / ppy + escrowPerPeriod);
          } else {
            const nPeriods = Math.max(1, Math.round((loan.TermMonths * ppy) / 12));
            const dyn = amortizedPayment(bal, loan.APR, nPeriods, ppy);
            basePayment += round2(dyn + escrowPerPeriod);
          }
        } else if (e.type === 'extra') {
          extrasTotal += round2(e.amount || 0);
        }
      }

      // Apply base payment: interest first, then principal. Extras apply to principal only.
      const interestFromBase = Math.min(basePayment, interestAccrued);
      const basePrincipal = Math.max(0, round2(basePayment - interestFromBase));
      const extrasPrincipal = round2(extrasTotal); // extras are principal-only by design

      totalInterest = round2(totalInterest + interestFromBase);
      totalPrincipal = round2(totalPrincipal + basePrincipal + extrasPrincipal);
      totalPaid = round2(totalPaid + basePayment + extrasPrincipal);

      // Balance already included interestAccrued earlier; subtract only principal reductions
      bal = round2(Math.max(0, bal - basePrincipal - extrasPrincipal));
    }

    timeline.push({
      date: toISODate(ev.date),
      balance: bal,
      paid: round2(totalPaid),
      interestPaid: round2(totalInterest),
      principalPaid: round2(totalPrincipal)
    });

    lastDate = ev.date;
    if (bal <= 0) break;
  }

  const payoffDate = timeline.length ? timeline[timeline.length - 1].date : null;
  return { 
    timeline, 
    payoffDate, 
    totals: { 
      totalPaid: round2(totalPaid), 
      totalInterest: round2(totalInterest), 
      totalPrincipal: round2(totalPrincipal) 
    }, 
    balanceEnd: round2(bal)
  };
}

// Simple standard amortization schedule generator
// Returns { schedule: [{date, payment, interest, principal, balance, paid, interestPaid, principalPaid}], payoffDate, totals }
function computeStandardAmortization(loan, balanceStart, startDate, maxYears = 100) {
  const freq = loan.PaymentFrequency || 'Monthly';
  const ppy = periodsPerYear(freq);
  const schedule = [];
  let bal = round2(balanceStart ?? 0);
  if (bal <= 0) return { schedule: [], payoffDate: null, totals: { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 } };

  // Determine remaining periods
  let remainingPeriods = null;
  if (loan.TermMonths && loan.OriginationDate) {
    const orig = parseISO(loan.OriginationDate);
    const origDate = new Date(orig);
    const startDt = new Date(startDate);
    const monthsElapsed = (startDt.getFullYear() - origDate.getFullYear()) * 12 + 
                          (startDt.getMonth() - origDate.getMonth()) +
                          (startDt.getDate() < origDate.getDate() ? -1 : 0);
    const monthsRemaining = Math.max(0, (loan.TermMonths || 0) - monthsElapsed);
    remainingPeriods = Math.max(0, Math.round((monthsRemaining * ppy) / 12));
  }
  if (!remainingPeriods || remainingPeriods <= 0) {
    // fallback to full term if remaining not computable
    remainingPeriods = Math.max(1, Math.round(((loan.TermMonths || 0) * ppy) / 12));
  }

  // Periodic rate
  const r = (loan.APR || 0) / ppy;

  // Payment: standard amortization based on current balance and remaining periods
  let payment = amortizedPayment(bal, loan.APR, remainingPeriods, ppy);

  // Start on next scheduled payment date
  let date = nextByFreq(new Date(startDate), freq);

  let totalPaid = 0;
  let totalInterest = 0;
  let totalPrincipal = 0;

  for (let i = 0; i < remainingPeriods && i < ppy * maxYears; i++) {
    // interest for period
    const interest = round2(bal * r);
    // adjust payment for final period if necessary
    let actualPayment = payment;
    if (round2(bal + interest) <= payment) {
      actualPayment = round2(bal + interest);
    }
    const principal = Math.max(0, round2(actualPayment - interest));
    totalInterest = round2(totalInterest + interest);
    totalPrincipal = round2(totalPrincipal + principal);
    totalPaid = round2(totalPaid + actualPayment);
    bal = round2(Math.max(0, bal - principal));

    schedule.push({
      date: toISODate(date),
      payment: actualPayment,
      interest,
      principal,
      balance: bal,
      paid: totalPaid,
      interestPaid: totalInterest,
      principalPaid: totalPrincipal,
    });

    if (bal <= 0) break;
    date = nextByFreq(date, freq);
  }

  const payoffDate = schedule.length ? schedule[schedule.length - 1].date : null;
  return { schedule, payoffDate, totals: { totalPaid: round2(totalPaid), totalInterest: round2(totalInterest), totalPrincipal: round2(totalPrincipal) } };
}

function aggregateTimeline(timeline, mode = 'monthly') {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  // mode: 'monthly' | 'yearly'
  const agg = new Map();
  let lastPaid = 0;
  let lastInterest = 0;
  let lastPrincipal = 0;

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    if (!t || !t.date) continue;
    const key = mode === 'yearly' ? t.date.slice(0, 4) : t.date.slice(0, 7); // YYYY or YYYY-MM

    if (!agg.has(key)) {
      agg.set(key, {
        period: key,
        paid: 0,
        interest: 0,
        principal: 0,
        balance: t.balance,
      });
    }

    const obj = agg.get(key);
    const currentPaid = typeof t.paid === 'number' ? t.paid : lastPaid;
    const currentInterest = typeof t.interestPaid === 'number' ? t.interestPaid : lastInterest;
    const currentPrincipal = typeof t.principalPaid === 'number' ? t.principalPaid : lastPrincipal;

    const paidDiff = round2(currentPaid - lastPaid);
    const interestDiff = round2(currentInterest - lastInterest);
    const principalDiff = round2(currentPrincipal - lastPrincipal);

    obj.paid = round2(obj.paid + paidDiff);
    obj.interest = round2(obj.interest + interestDiff);
    obj.principal = round2(obj.principal + principalDiff);
    obj.balance = t.balance;

    lastPaid = currentPaid;
    lastInterest = currentInterest;
    lastPrincipal = currentPrincipal;
  }

  return Array.from(agg.values())
    .sort((a, b) => a.period.localeCompare(b.period));
}

function formatDuration(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  if (days < 30) {
    const d = Math.round(days);
    return d + ' day' + (d === 1 ? '' : 's');
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return months + ' mo' + (months === 1 ? '' : 's');
  }
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const parts = [];
  if (years > 0) parts.push(years + ' yr' + (years === 1 ? '' : 's'));
  if (remMonths > 0) parts.push(remMonths + ' mo' + (remMonths === 1 ? '' : 's'));
  return parts.join(' ');
}

// =============================
// Dev Self-Tests (run in console)
// =============================
function runSelfTests() {
  try {
    // Per-diem tests
    console.assert(nearlyEqual(calcPerDiem(0, 1000), 0), 'Per-diem should be 0 when APR=0');
    console.assert(nearlyEqual(calcPerDiem(0.06, 100000), 0.06/365*100000), 'Per-diem formula mismatch');

    // Payoff tests
    const payoff = calcPayoff(50000, 0.05, 10);
    const expected = round2(50000 + (0.05/365*50000)*10);
    console.assert(nearlyEqual(payoff, expected), 'Payoff calculation mismatch');
    console.assert(calcPayoff(-10, 0.1, 5) === 0, 'Negative payoff should clamp to 0');

    // Recalc tests (one simple loan, two payments, daily interest)
    const loan = { id: 1, OriginalPrincipal: 1000, APR: 0.10, OriginationDate: '2024-01-01', PaymentFrequency: 'Monthly', LoanType: 'Mortgage', TermMonths: 12 };
    const pmts = [
      { id: 1, LoanRef: 1, PaymentDate: '2024-01-11', Amount: 100 }, // 10 days interest @10% on 1000 ≈ 2.74
      { id: 2, LoanRef: 1, PaymentDate: '2024-01-21', Amount: 100 }, // next 10 days on new balance
    ];
    const res = recalcLoanPayments(loan, pmts, []);
    console.assert(res[0].InterestPortion >= 2.73 && res[0].InterestPortion <= 2.75, 'Recalc interest #1');
    console.assert(res[0].PrincipalPortion > 97, 'Recalc principal #1 positivity');

    // Periodic payments by type
    console.assert(nearlyEqual(amortizedPayment(1200, 0, 12, 12), 100), 'Zero-APR amortized');
    const mp = principalInterestPaymentFor(100000, 0.06, 360, 'Monthly', 'Mortgage');
    console.assert(mp > 599 && mp < 601, '30yr @6% ~ $599.55 PI');
    const io = principalInterestPaymentFor(100000, 0.06, 360, 'Monthly', 'Revolving LOC');
    console.assert(nearlyEqual(io, round2(0.06/12*100000)), 'Interest-only monthly');

    // Scheduled payment w/ escrow monthly (legacy balance-based path keeps working if OriginalPrincipal missing)
    const loanEsc = { APR: 0, TermMonths: 12, PaymentFrequency: 'Monthly', LoanType: 'Mortgage', EscrowMonthly: 300 };
    const schedM = scheduledPaymentFor(loanEsc, 12000, 12); // PI=1000, escrow=300 => 1300
    console.assert(nearlyEqual(schedM, 1300), 'Scheduled monthly w/ escrow should equal PI + escrow periodized');

    // NEW: Fixed PI independent of current balance when OriginalPrincipal present
    const fixedLoan = { OriginalPrincipal: 12000, APR: 0, TermMonths: 12, PaymentFrequency: 'Monthly', LoanType: 'Mortgage', EscrowMonthly: 300 };
    const s1 = scheduledPaymentFor(fixedLoan, 12000, 12);
    const s2 = scheduledPaymentFor(fixedLoan, 9999, 6);
    console.assert(nearlyEqual(s1, 1300) && nearlyEqual(s2, 1300), 'Fixed PI must not change with balance');

    // Frequency scaling (weekly)
    const loanW = { APR: 0, TermMonths: 12, PaymentFrequency: 'Weekly', LoanType: 'Mortgage', EscrowMonthly: 520 };
    const schedW = scheduledPaymentFor(loanW, 12000, 12); // PI=12000/52≈230.77, escrow per week=6240/52=120 => ~350.77
    console.assert(nearlyEqual(schedW, round2(12000/52 + (520*12/52))), 'Scheduled weekly with escrow scaling');

    // Credit card minimum (weekly scaling from $25 monthly)
    const ccMinWeekly = scheduledPaymentFor({ LoanType:'Credit Card', APR:0.2, PaymentFrequency:'Weekly', TermMonths:360, EscrowMonthly:0 }, 1000, 360);
    console.assert(nearlyEqual(ccMinWeekly, round2(25*12/52)), 'Credit card minimum scaled to weekly');

    // Projection payoff improves with extras
    const baseLoan = { id: 9, OriginalPrincipal: 10000, APR: 0.12, OriginationDate: '2024-01-01', PaymentFrequency: 'Monthly', LoanType: 'Mortgage', TermMonths: 60, EscrowMonthly: 0 };
    const today = new Date('2024-01-01');
    const projBase = projectToPayoff({ loan: baseLoan, balanceStart: 10000, startDate: today, extras: [], draws: [] });
    const projExtra = projectToPayoff({ loan: baseLoan, balanceStart: 10000, startDate: today, extras: [{ id:1, kind:'recurring', amount:100, every:'month', start:'2024-01-01' }], draws: [] });
    console.assert(projExtra.timeline.length <= projBase.timeline.length, 'Extras should not lengthen payoff timeline');

    // Basic mortgage projection sanity check (30-year mortgage should payoff ~30 years from origination)
    const testMortgage = { id: 20, OriginalPrincipal: 100000, APR: 0.06, OriginationDate: '2024-01-15', PaymentFrequency: 'Monthly', LoanType: 'Mortgage', TermMonths: 360, EscrowMonthly: 0, FixedPayment: true };
    const testProj = projectToPayoff({ loan: testMortgage, balanceStart: 100000, startDate: new Date('2024-01-15'), extras: [], draws: [] });
    if (testProj.payoffDate) {
      const year = new Date(testProj.payoffDate).getFullYear();
      console.assert(year >= 2053 && year <= 2057, 'Test mortgage payoff should be around 2054');
    }

    // NEW: Projection with zero APR & fixed PI ends in exactly n periods
    const zLoan = { id: 11, OriginalPrincipal: 1200, APR: 0, OriginationDate: '2024-01-01', PaymentFrequency: 'Monthly', LoanType: 'Mortgage', TermMonths: 12, EscrowMonthly: 0 };
    const projZero = projectToPayoff({ loan: zLoan, balanceStart: 1200, startDate: new Date('2024-01-01'), extras: [], draws: [] });
    console.assert(projZero.timeline.length === 12, 'Zero-APR 12-month should take 12 payments');

  } catch (e) {
    console.warn('Self-tests encountered an error (non-fatal):', e);
  }
}
if (typeof window !== 'undefined') runSelfTests();

// =============================
// UI Component
// =============================
export default function LoanManagerMock() {
  const fmt = (d) => toISODate(d);
  const money = (n) => (n ?? 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

  // --- Auth + session ---
  const [session, setSession] = React.useState(null);
  const [users, setUsers] = React.useState([]);
  const [authReady, setAuthReady] = React.useState(false);
  const [dataReady, setDataReady] = React.useState(false);
  const [loginUsername, setLoginUsername] = React.useState('');
  const [loginPassword, setLoginPassword] = React.useState('');
  const [loginError, setLoginError] = React.useState('');
  const [loginBusy, setLoginBusy] = React.useState(false);
  const uiId = React.useId().replace(/:/g, '');
  const searchInputId = `${uiId}-loan-search`;
  const newLoanId = `${uiId}-new-loan`;
  const paymentModalId = `${uiId}-payment-modal`;
  const inlinePaymentId = `${uiId}-inline-payment`;
  const drawId = `${uiId}-draw`;
  const calcId = `${uiId}-calc`;
  const reportId = `${uiId}-report`;
  const resetId = `${uiId}-reset`;

  // --- Settings panel ---
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [settingsError, setSettingsError] = React.useState('');
  const [settingsSuccess, setSettingsSuccess] = React.useState('');

  // --- Admin defaults (editable & savable) ---
  const [admin, setAdmin] = React.useState({
    graceDaysDefault: 5,
    lateFeeFlatDefault: 0,
    lateFeePctDefault: 4,
    frequencies: ['Monthly', 'Biweekly', 'Weekly', 'Quarterly', 'Annual'],
  });
  const [adminTab, setAdminTab] = React.useState('defaults');
  const [adminDraft, setAdminDraft] = React.useState(null); // when overlay opens for editing
  const [userForm, setUserForm] = React.useState({ username: '', password: '', confirm: '', role: 'Standard User' });
  const [userEditId, setUserEditId] = React.useState(null);
  const [userFormError, setUserFormError] = React.useState('');
  const [userMgmtMessage, setUserMgmtMessage] = React.useState('');
  const [resetUserId, setResetUserId] = React.useState(null);
  const [resetPassword, setResetPassword] = React.useState('');
  const [resetConfirm, setResetConfirm] = React.useState('');

  const isAdmin = session?.role === 'Admin';

  function openAdmin(tab = 'defaults') {
    if (!isAdmin) return;
    setAdminDraft({
      graceDaysDefault: String(admin.graceDaysDefault),
      lateFeeFlatDefault: String(admin.lateFeeFlatDefault),
      lateFeePctDefault: String(admin.lateFeePctDefault),
      frequencies: admin.frequencies.join(', '),
    });
    setAdminTab(tab);
    setAdminOpen(true);
  }
  function saveAdmin() {
    if (!isAdmin) return;
    const freqList = (adminDraft.frequencies || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => Object.keys(FREQ).includes(s));
    setAdmin({
      graceDaysDefault: Math.max(0, Number(adminDraft.graceDaysDefault) || 0),
      lateFeeFlatDefault: Math.max(0, Number(adminDraft.lateFeeFlatDefault) || 0),
      lateFeePctDefault: Math.max(0, Number(adminDraft.lateFeePctDefault) || 0),
      frequencies: freqList.length ? freqList : admin.frequencies,
    });
    setAdminOpen(false);
  }

  // --- Sample data ---
  const initialLoans = [
    {
      id: 1,
      LoanID: 'LN-0001',
      BorrowerName: 'Test Borrower',
      LoanType: 'Mortgage',
      OriginalPrincipal: 100000,
      OriginationDate: '2024-01-15',
      TermMonths: 360,
      APR: 0.065,
      PaymentFrequency: 'Monthly',
      NextPaymentDate: '2024-02-15',
      EscrowMonthly: 300,
      LateFeeFlat: 0,
      LateFeePct: 0.04,
      GraceDays: 5,
      Status: 'Active',
      Notes: 'Sample row (delete later)',
      FixedPayment: true,
      AccountNumber: '',
      BorrowerAddress: '',
      PropertyAddress: '',
      ServicerName: '',
      ServicerAddress: '',
      ServicerPhone: '',
      ServicerWebsite: '',
      StatementMessage: '',
    },
    {
      id: 2,
      LoanID: 'LN-0020',
      BorrowerName: 'James Garcia',
      LoanType: 'Mortgage',
      OriginalPrincipal: 250000,
      OriginationDate: '2023-06-01',
      TermMonths: 180,
      APR: 0.059,
      PaymentFrequency: 'Monthly',
      NextPaymentDate: '2024-09-15',
      EscrowMonthly: 450,
      LateFeeFlat: 25,
      LateFeePct: 0.03,
      GraceDays: 7,
      Status: 'Active',
      Notes: 'Conventional',
      FixedPayment: true,
      AccountNumber: '',
      BorrowerAddress: '',
      PropertyAddress: '',
      ServicerName: '',
      ServicerAddress: '',
      ServicerPhone: '',
      ServicerWebsite: '',
      StatementMessage: '',
    },
    {
      id: 3,
      LoanID: 'LN-0042',
      BorrowerName: 'Avery Chen',
      LoanType: 'Revolving LOC',
      OriginalPrincipal: 150000,
      OriginationDate: '2022-11-10',
      TermMonths: 120,
      APR: 0.072,
      PaymentFrequency: 'Monthly',
      NextPaymentDate: '2024-09-20',
      EscrowMonthly: 0,
      LateFeeFlat: 35,
      LateFeePct: 0.02,
      GraceDays: 5,
      Status: 'Active',
      Notes: 'Open draw period',
      FixedPayment: false,
      AccountNumber: '',
      BorrowerAddress: '',
      PropertyAddress: '',
      ServicerName: '',
      ServicerAddress: '',
      ServicerPhone: '',
      ServicerWebsite: '',
      StatementMessage: '',
    },
    {
      id: 4,
      LoanID: 'LN-0100',
      BorrowerName: 'LS',
      LoanType: 'Mortgage',
      OriginalPrincipal: 332000,
      OriginationDate: '2025-09-03',
      TermMonths: 360,
      APR: 0.065,
      PaymentFrequency: 'Monthly',
      NextPaymentDate: '2025-10-03',
      EscrowMonthly: 0,
      LateFeeFlat: 0,
      LateFeePct: 0.04,
      GraceDays: 15,
      Status: 'Active',
      Notes: 'Fixed payment',
      FixedPayment: true,
      AccountNumber: '',
      BorrowerAddress: '',
      PropertyAddress: '',
      ServicerName: '',
      ServicerAddress: '',
      ServicerPhone: '',
      ServicerWebsite: '',
      StatementMessage: '',
    },
  ];

  const initialPayments = [
    { id: 101, LoanRef: 1, PaymentID: 'PMT-0001', PaymentDate: '2024-02-15', Amount: 700, PrincipalPortion: 200, InterestPortion: 400, EscrowPortion: 100, Method: 'ACH', Reference: 'Sample', PostedBy: 'You', PostedAt: '2024-02-15T10:00:00', IsScheduledInstallment: true },
    { id: 102, LoanRef: 1, PaymentID: 'PMT-0002', PaymentDate: '2024-03-15', Amount: 700, PrincipalPortion: 210, InterestPortion: 390, EscrowPortion: 100, Method: 'ACH', Reference: '', PostedBy: 'You', PostedAt: '2024-03-15T10:00:00', IsScheduledInstallment: true },
    { id: 201, LoanRef: 2, PaymentID: 'PMT-1001', PaymentDate: '2024-08-15', Amount: 2100, PrincipalPortion: 900, InterestPortion: 1100, EscrowPortion: 100, Method: 'ACH', Reference: '', PostedBy: 'Ops', PostedAt: '2024-08-15T10:00:00', IsScheduledInstallment: true },
  ];

  const [loans, setLoans] = React.useState(initialLoans);
  const [payments, setPayments] = React.useState(initialPayments);
  const [draws, setDraws] = React.useState([]); // {id, LoanRef, DrawDate, Amount}
  const hydrated = React.useRef(false);

  const [query, setQuery] = React.useState('');
  const [selectedId, setSelectedId] = React.useState(loans[0].id);
  const [loanMenuId, setLoanMenuId] = React.useState(null);
  const [mode, setMode] = React.useState('details'); // 'details' | 'calc' | 'reports'
  const [reportMonth, setReportMonth] = React.useState(() => toISODate(new Date()).slice(0, 7));
  const [reportSelections, setReportSelections] = React.useState({ statement: true });
  const [adminOpen, setAdminOpen] = React.useState(false);

  function handleAuthFailure(err) {
    if (err?.status === 401) {
      setSession(null);
      setUsers([]);
      setDataReady(false);
      hydrated.current = false;
      setAdminOpen(false);
      setSettingsOpen(false);
    }
  }

  async function loadStateFromServer() {
    hydrated.current = false;
    try {
      const res = await apiRequest('/api/state');
      const state = res?.state || {};
      const nextLoans = Array.isArray(state.loans) ? state.loans : initialLoans;
      const nextPayments = Array.isArray(state.payments) ? state.payments : initialPayments;
      const nextDraws = Array.isArray(state.draws) ? state.draws : [];
      setLoans(nextLoans);
      setPayments(nextPayments);
      setDraws(nextDraws);
      const nextSelected = state.selectedId ?? nextLoans[0]?.id ?? null;
      setSelectedId(nextSelected);
      if (state.admin) {
        setAdmin((prev) => ({
          ...prev,
          ...state.admin,
          frequencies: Array.isArray(state.admin.frequencies) ? state.admin.frequencies : prev.frequencies,
        }));
      }
    } catch (err) {
      console.warn('Failed to load state from server', err);
      handleAuthFailure(err);
    } finally {
      hydrated.current = true;
      setDataReady(true);
    }
  }

  async function refreshUsers() {
    try {
      const res = await apiRequest('/api/users');
      setUsers(Array.isArray(res?.users) ? res.users : []);
    } catch (err) {
      console.warn('Failed to load users', err);
      handleAuthFailure(err);
    }
  }

  async function persistStateToServer(nextState) {
    try {
      await apiRequest('/api/state', { method: 'PUT', body: nextState });
    } catch (err) {
      console.warn('Failed to save state', err);
      handleAuthFailure(err);
    }
  }

  // Auth bootstrap
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    let cancelled = false;
    async function initAuth() {
      try {
        const res = await apiRequest('/api/auth/me');
        if (cancelled) return;
        setSession(res.user);
        setAuthReady(true);
        await loadStateFromServer();
        if (res.user?.role === 'Admin') {
          await refreshUsers();
        }
      } catch (err) {
        if (cancelled) return;
        setSession(null);
        setUsers([]);
        setAuthReady(true);
        setDataReady(false);
        hydrated.current = false;
      }
    }
    initAuth();
    return () => { cancelled = true; };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!session || !dataReady || !hydrated.current) return;
    persistStateToServer({ loans, payments, draws, selectedId, admin });
  }, [loans, payments, draws, selectedId, admin, session, dataReady]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!session) {
      setUsers([]);
      return;
    }
    if (session.role === 'Admin') {
      refreshUsers();
    }
  }, [session]);

  React.useEffect(() => {
    if (!isAdmin && adminOpen) setAdminOpen(false);
  }, [isAdmin, adminOpen]);

  const sortedUsers = React.useMemo(() => [...users].sort((a, b) => a.username.localeCompare(b.username)), [users]);
  const activeAdminCount = React.useMemo(
    () => users.filter((u) => u.role === 'Admin' && !u.disabled).length,
    [users],
  );

  async function handleLogin(e) {
    e?.preventDefault?.();
    setLoginError('');
    if (!authReady) { setLoginError('Initializing... please try again.'); return; }
    const username = normalizeUsername(loginUsername);
    const password = loginPassword;
    if (!username || !password) { setLoginError('Username and password are required.'); return; }
    setLoginBusy(true);
    try {
      const res = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setSession(res.user);
      setLoginPassword('');
      setLoginError('');
      setDataReady(false);
      await loadStateFromServer();
      if (res.user?.role === 'Admin') {
        await refreshUsers();
      } else {
        setUsers([]);
      }
    } catch (err) {
      setLoginError(err.message || 'Unable to sign in right now.');
      console.warn(err);
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.warn('Logout failed', err);
    }
    setSession(null);
    setUsers([]);
    setDataReady(false);
    hydrated.current = false;
    setAdminOpen(false);
    setSettingsOpen(false);
    setLoginError('');
    setLoginPassword('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  async function handleChangeOwnPassword() {
    if (!session) { setSettingsError('You must be logged in.'); return; }
    setSettingsError('');
    setSettingsSuccess('');
    const current = currentPassword;
    const next = newPassword;
    const nextConfirm = confirmPassword;
    if (!current || !next || !nextConfirm) { setSettingsError('All password fields are required.'); return; }
    if (next !== nextConfirm) { setSettingsError('New passwords do not match.'); return; }
    if (next.length < PASSWORD_MIN_LENGTH) { setSettingsError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`); return; }
    try {
      await apiRequest('/api/users/me/password', {
        method: 'PUT',
        body: { currentPassword: current, newPassword: next },
      });
      setSettingsSuccess('Password updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      console.warn('Password update failed', e);
      setSettingsError(e.message || 'Could not update password securely.');
      handleAuthFailure(e);
    }
  }

  function resetUserFormState() {
    setUserEditId(null);
    setUserForm({ username: '', password: '', confirm: '', role: 'Standard User' });
    setUserFormError('');
  }
  function beginEditUser(user) {
    setUserEditId(user.id);
    setUserForm({ username: user.username, password: '', confirm: '', role: user.role });
    setUserFormError('');
    setUserMgmtMessage('');
    setResetUserId(null);
    setResetPassword('');
    setResetConfirm('');
  }
  async function saveUserFromAdmin() {
    if (!isAdmin) { setUserFormError('Admin access required.'); return; }
    setUserFormError('');
    setUserMgmtMessage('');
    const username = normalizeUsername(userForm.username);
    const role = USER_ROLES.includes(userForm.role) ? userForm.role : 'Standard User';
    if (!username) { setUserFormError('Username is required.'); return; }
    if (!userEditId) {
      if (!userForm.password || !userForm.confirm) { setUserFormError('Password and confirmation are required.'); return; }
      if (userForm.password !== userForm.confirm) { setUserFormError('Passwords do not match.'); return; }
      if (userForm.password.length < PASSWORD_MIN_LENGTH) { setUserFormError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`); return; }
      const exists = users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase());
      if (exists) { setUserFormError('Username already exists.'); return; }
      try {
        await apiRequest('/api/users', {
          method: 'POST',
          body: { username, password: userForm.password, role },
        });
        setUserMgmtMessage('User created.');
        resetUserFormState();
        await refreshUsers();
      } catch (e) {
        console.warn('User create failed', e);
        setUserFormError(e.message || 'Could not create user.');
        handleAuthFailure(e);
      }
    } else {
      const existing = users.find((u) => u.id === userEditId);
      if (!existing) { setUserFormError('User not found.'); return; }
      const exists = users.some((u) => u.id !== userEditId && (u.username || '').toLowerCase() === username.toLowerCase());
      if (exists) { setUserFormError('Username already exists.'); return; }
      if (existing.role === 'Admin' && role !== 'Admin' && !hasAnotherActiveAdmin(users, existing.id)) {
        setUserFormError('At least one admin must remain.'); return;
      }
      try {
        const res = await apiRequest(`/api/users/${userEditId}`, {
          method: 'PUT',
          body: { username, role },
        });
        if (session?.id === res?.user?.id) setSession(res.user);
        setUserMgmtMessage('User updated.');
        resetUserFormState();
        await refreshUsers();
      } catch (e) {
        console.warn('User update failed', e);
        setUserFormError(e.message || 'Could not update user.');
        handleAuthFailure(e);
      }
    }
  }
  async function toggleUserDisabled(user) {
    if (!isAdmin) return;
    const disabling = !user.disabled;
    if (disabling && user.role === 'Admin' && !hasAnotherActiveAdmin(users, user.id)) {
      setUserMgmtMessage('Keep at least one admin active.'); return;
    }
    try {
      await apiRequest(`/api/users/${user.id}`, {
        method: 'PUT',
        body: { disabled: disabling },
      });
      await refreshUsers();
      if (disabling && session?.id === user.id) {
        handleLogout();
      }
    } catch (e) {
      console.warn('User toggle failed', e);
      setUserMgmtMessage(e.message || 'Unable to update user.');
      handleAuthFailure(e);
    }
  }
  async function resetPasswordForUser(userId) {
    if (!isAdmin) return;
    setUserMgmtMessage('');
    if (!resetPassword || !resetConfirm) { setUserMgmtMessage('Enter password and confirmation.'); return; }
    if (resetPassword !== resetConfirm) { setUserMgmtMessage('Passwords do not match.'); return; }
    if (resetPassword.length < PASSWORD_MIN_LENGTH) { setUserMgmtMessage(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`); return; }
    const target = users.find((u) => u.id === userId);
    if (!target) { setUserMgmtMessage('User not found.'); return; }
    try {
      await apiRequest(`/api/users/${userId}/password`, {
        method: 'PUT',
        body: { password: resetPassword },
      });
      setUserMgmtMessage(`Password reset for ${target.username}.`);
      setResetUserId(null);
      setResetPassword('');
      setResetConfirm('');
    } catch (e) {
      console.warn('Reset failed', e);
      setUserMgmtMessage(e.message || 'Could not reset password.');
      handleAuthFailure(e);
    }
  }
  function startReset(user) {
    setResetUserId(user.id);
    setResetPassword('');
    setResetConfirm('');
    setUserMgmtMessage('');
  }
  async function deleteUser(user) {
    if (!isAdmin) return;
    if (user.role === 'Admin' && !hasAnotherActiveAdmin(users, user.id)) {
      setUserFormError('Cannot delete the last admin.'); return;
    }
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await apiRequest(`/api/users/${user.id}`, { method: 'DELETE' });
      await refreshUsers();
      if (session?.id === user.id) handleLogout();
    } catch (e) {
      console.warn('Delete user failed', e);
      setUserFormError(e.message || 'Could not delete user.');
      handleAuthFailure(e);
    }
  }

  const selected = loans.find((l) => l.id === selectedId) || null;
  const loanPaymentsDesc = payments
    .filter((p) => p.LoanRef === selectedId)
    .sort((a, b) => parseISO(b.PaymentDate) - parseISO(a.PaymentDate));
  const loanPaymentsAsc = [...loanPaymentsDesc].reverse();

  const principalPaid = loanPaymentsDesc.reduce((s, p) => s + (p.PrincipalPortion ?? 0), 0);
  const interestPaid = loanPaymentsDesc.reduce((s, p) => s + (p.InterestPortion ?? 0), 0);
  const totalPayments = loanPaymentsDesc.reduce((s, p) => s + (p.Amount ?? 0), 0);
  const balance = selected
    ? Math.max(0, round2((selected.OriginalPrincipal ?? 0) - principalPaid + draws.filter(d => d.LoanRef===selected.id).reduce((s,d)=>s+(d.Amount||0),0)))
    : 0;
  const lastPayDate = loanPaymentsDesc.length
    ? parseISO(loanPaymentsAsc[loanPaymentsAsc.length - 1].PaymentDate)
    : (selected ? parseISO(selected.OriginationDate) : new Date());
  const daysSince = selected ? daysBetween(lastPayDate, new Date()) : 0;
  const perDiem = selected ? calcPerDiem(selected.APR, balance) : 0;
  const payoff = selected ? calcPayoff(balance, selected.APR, daysSince) : 0;

  // Scheduled payment (P&I + escrow) by frequency & type
  const scheduledCurrent = selected ? scheduledPaymentFor(selected, balance) : 0;

  const filteredLoans = loans.filter((l) => !query || l.BorrowerName.toLowerCase().includes(query.toLowerCase()) || l.LoanID.toLowerCase().includes(query.toLowerCase()));
  function nextLoanId() {
    return Math.max(0, ...loans.map((l) => l.id || 0)) + 1;
  }
  function uniqueLoanId(base) {
    const taken = new Set(loans.map((l) => (l.LoanID || '').toLowerCase()));
    const seed = base || `LN-${String(nextLoanId()).padStart(4, '0')}`;
    if (!taken.has(seed.toLowerCase())) return seed;
    let idx = 1;
    let candidate = `${seed}-${idx}`;
    while (taken.has(candidate.toLowerCase())) {
      idx += 1;
      candidate = `${seed}-${idx}`;
    }
    return candidate;
  }
  function duplicateLoan(loan) {
    const newId = nextLoanId();
    const clone = {
      ...loan,
      id: newId,
      LoanID: uniqueLoanId(loan.LoanID),
      BorrowerName: `${loan.BorrowerName} (copy)`,
      Status: 'Active',
    };
    setLoans((prev) => [...prev, clone]);
    setSelectedId(newId);
    setLoanMenuId(null);
  }
  function deleteLoan(loan) {
    if (!window.confirm(`Delete loan "${loan.BorrowerName}" (${loan.LoanID})? This removes its payments and draws.`)) return;
    setLoans((prev) => prev.filter((l) => l.id !== loan.id));
    setPayments((prev) => prev.filter((p) => p.LoanRef !== loan.id));
    setDraws((prev) => prev.filter((d) => d.LoanRef !== loan.id));
    setLoanMenuId(null);
    if (selectedId === loan.id) {
      const remaining = loans.filter((l) => l.id !== loan.id);
      setSelectedId(remaining.length ? remaining[0].id : null);
    }
  }

  // Estimate payoff date using fixed PI schedule from next due date
  const nextDue = selected?.NextPaymentDate || toISODate(addMonths(parseISO(selected?.OriginationDate), 1));
  const payoffDateBase = React.useMemo(() => {
    if (!selected) return null;
    return computePayoffDate(selected, balance, nextDue, payments);
  }, [selected, balance, payments, nextDue]);
  const scheduledDone = payments.filter((p)=>p.LoanRef===selected?.id && p.IsScheduledInstallment!==false).length;
  const projectionBase = React.useMemo(() => {
    return projectWithExtras({ loan: selected, balanceStart: balance, nextDueDate: nextDue, extras: [], scheduledDone });
  }, [selected, balance, nextDue, scheduledDone]);

  // =============================
  // New Loan Form
  // =============================
  const [nlOpen, setNlOpen] = React.useState(false);
  const [nlBorrower, setNlBorrower] = React.useState('');
  const [nlPrincipal, setNlPrincipal] = React.useState('');
  const [nlAPR, setNlAPR] = React.useState(''); // percent input, e.g. 6.5
  const [nlTerm, setNlTerm] = React.useState('360');
  const [nlType, setNlType] = React.useState('Mortgage');
  const [nlStart, setNlStart] = React.useState(toISODate(new Date()));
  const [nlFreq, setNlFreq] = React.useState('Monthly');
  const [nlEscrow, setNlEscrow] = React.useState('0');
  const [nlGrace, setNlGrace] = React.useState('5');
  const [nlNextDue, setNlNextDue] = React.useState(toISODate(new Date()));
  const [nlCreditLimit, setNlCreditLimit] = React.useState('');
  const [nlFixedPayment, setNlFixedPayment] = React.useState(true);
  const [nlAccountNumber, setNlAccountNumber] = React.useState('');
  const [nlBorrowerAddress, setNlBorrowerAddress] = React.useState('');
  const [nlPropertyAddress, setNlPropertyAddress] = React.useState('');
  const [nlServicerName, setNlServicerName] = React.useState('');
  const [nlServicerAddress, setNlServicerAddress] = React.useState('');
  const [nlServicerPhone, setNlServicerPhone] = React.useState('');
  const [nlServicerWebsite, setNlServicerWebsite] = React.useState('');
  const [nlStatementMessage, setNlStatementMessage] = React.useState('');

  const nlPpy = periodsPerYear(nlFreq);
  const estNewPI = (() => {
    const P = Number(nlPrincipal);
    const rPct = Number(nlAPR);
    const n = Number(nlTerm);
    if (isNaN(P) || P <= 0 || isNaN(rPct) || rPct < 0 || isNaN(n) || n <= 0) return 0;
    // fixed PI from orig values
    const tmpLoan = { OriginalPrincipal: P, APR: rPct/100, TermMonths: n, PaymentFrequency: nlFreq, LoanType: nlType };
    return isAmortizedType(nlType) ? fixedPIForLoan(tmpLoan) : scheduledPaymentFor(tmpLoan, P);
  })();
  const estNewEscrowPer = round2(((Number(nlEscrow) || 0) * 12) / nlPpy);
  const estNewPerLabel = `${nlFreq} Payment (est.)`
  const estNewPerWithEscrow = round2(estNewPI + estNewEscrowPer);

  function nextLoanKey(existing) {
    const maxId = Math.max(0, ...existing.map((x) => x.id));
    const n = maxId + 1;
    return { id: n, LoanID: `LN-${String(n).padStart(4, '0')}` };
  }

  function toggleNewLoan() {
    if (!nlOpen) {
      // Opening: seed from Admin defaults
      setNlGrace(String(admin.graceDaysDefault));
      setNlFreq(admin.frequencies[0] || 'Monthly');
    }
    setNlOpen((v) => !v);
  }

  function createLoan() {
    const P = Number(nlPrincipal);
    const rPct = Number(nlAPR); // percent
    const n = Number(nlTerm);
    if (!nlBorrower || isNaN(P) || P <= 0 || isNaN(rPct) || rPct < 0 || isNaN(n) || n <= 0) {
      alert('Please enter Borrower, Principal (>0), APR% (>=0), and Term (>0).');
      return;
    }
    const key = nextLoanKey(loans);
    const newLoan = {
      id: key.id,
      LoanID: key.LoanID,
      BorrowerName: nlBorrower,
      LoanType: nlType,
      OriginalPrincipal: round2(P),
      OriginationDate: nlStart,
      TermMonths: n,
      APR: rPct/100, // convert percent to decimal
      PaymentFrequency: nlFreq,
      NextPaymentDate: nlNextDue,
      EscrowMonthly: Number(nlEscrow) || 0,
      LateFeeFlat: admin.lateFeeFlatDefault,
      LateFeePct: admin.lateFeePctDefault / 100,
      GraceDays: Number(nlGrace) || admin.graceDaysDefault,
      Status: 'Active',
      Notes: nlType === 'Revolving LOC' && nlCreditLimit ? `Credit limit: ${nlCreditLimit}` : '',
      CreditLimit: nlType === 'Revolving LOC' ? Number(nlCreditLimit) || 0 : undefined,
      FixedPayment: nlFixedPayment,
      AccountNumber: nlAccountNumber,
      BorrowerAddress: nlBorrowerAddress,
      PropertyAddress: nlPropertyAddress,
      ServicerName: nlServicerName,
      ServicerAddress: nlServicerAddress,
      ServicerPhone: nlServicerPhone,
      ServicerWebsite: nlServicerWebsite,
      StatementMessage: nlStatementMessage,
    };
    setLoans((prev) => [...prev, newLoan]);
    setSelectedId(key.id);
    setNlBorrower(''); setNlPrincipal(''); setNlAPR(''); setNlTerm('360'); setNlType('Mortgage'); setNlStart(toISODate(new Date())); setNlFreq(admin.frequencies[0] || 'Monthly'); setNlEscrow('0'); setNlGrace(String(admin.graceDaysDefault)); setNlNextDue(toISODate(new Date())); setNlCreditLimit('');
    setNlAccountNumber(''); setNlBorrowerAddress(''); setNlPropertyAddress(''); setNlServicerName(''); setNlServicerAddress(''); setNlServicerPhone(''); setNlServicerWebsite(''); setNlStatementMessage('');
    setNlOpen(false);
  }

  // =============================
  // Inline Edit Loan Details (unlock fields)
  // =============================
  const [editMode, setEditMode] = React.useState(false);
  const [statementDetailsOpen, setStatementDetailsOpen] = React.useState(false);
  const [el, setEl] = React.useState({}); // holds editable fields as strings
  function startEdit() {
    setEl({
      BorrowerName: selected.BorrowerName || '',
      OriginalPrincipal: String(selected.OriginalPrincipal ?? ''),
      APR: String(round2((selected.APR ?? 0) * 100)),
      TermMonths: String(selected.TermMonths ?? ''),
      LoanType: selected.LoanType || 'Mortgage',
      NextPaymentDate: toISODate(selected.NextPaymentDate),
      PaymentFrequency: selected.PaymentFrequency || 'Monthly',
      EscrowMonthly: String(selected.EscrowMonthly ?? ''),
      GraceDays: String(selected.GraceDays ?? ''),
      Notes: selected.Notes || '',
      AccountNumber: selected.AccountNumber || '',
      BorrowerAddress: selected.BorrowerAddress || '',
      PropertyAddress: selected.PropertyAddress || '',
      ServicerName: selected.ServicerName || '',
      ServicerAddress: selected.ServicerAddress || '',
      ServicerPhone: selected.ServicerPhone || '',
      ServicerWebsite: selected.ServicerWebsite || '',
      StatementMessage: selected.StatementMessage || '',
    });
    setStatementDetailsOpen(true);
    setEditMode(true);
  }
  function cancelEdit() { setEditMode(false); }
  function saveEdit() {
    const rPct = Number(el.APR);
    const P = Number(el.OriginalPrincipal);
    const n = Number(el.TermMonths);
    if (!el.BorrowerName || isNaN(P) || P <= 0 || isNaN(rPct) || rPct < 0 || isNaN(n) || n <= 0) { alert('Check Borrower, Principal (>0), APR% (>=0), Term (>0).'); return; }
    const updated = {
      ...selected,
      BorrowerName: el.BorrowerName,
      OriginalPrincipal: round2(P),
      APR: rPct/100,
      TermMonths: n,
      LoanType: el.LoanType,
      NextPaymentDate: el.NextPaymentDate,
      PaymentFrequency: el.PaymentFrequency,
      EscrowMonthly: Number(el.EscrowMonthly) || 0,
      GraceDays: Number(el.GraceDays) || 0,
      Notes: el.Notes,
      AccountNumber: el.AccountNumber || '',
      BorrowerAddress: el.BorrowerAddress || '',
      PropertyAddress: el.PropertyAddress || '',
      ServicerName: el.ServicerName || '',
      ServicerAddress: el.ServicerAddress || '',
      ServicerPhone: el.ServicerPhone || '',
      ServicerWebsite: el.ServicerWebsite || '',
      StatementMessage: el.StatementMessage || '',
    };
    setLoans((prev) => prev.map((l) => (l.id === selected.id ? updated : l)));
    setPayments((prev) => recalcLoanPayments(updated, prev, draws));
    setEditMode(false);
  }

  // =============================
  // Post / Edit / Delete Payments + Draws (for Revolving)
  // =============================
  const [pDate, setPDate] = React.useState(toISODate(new Date()));
  const [pAmt, setPAmt] = React.useState('');
  const [pScheduled, setPScheduled] = React.useState(true);
  const [pExtra, setPExtra] = React.useState('');
  const [pMethod, setPMethod] = React.useState('ACH');
  const [pRef, setPRef] = React.useState('');
  const [paymentModalOpen, setPaymentModalOpen] = React.useState(false);

  // Prefill when switching loans or changing schedule
  React.useEffect(() => {
    if (!selected) return;
    const sched = scheduledPaymentFor(selected, balance);
    setPScheduled(true);
    setPAmt(String(sched || ''));
    setPExtra('');
  }, [selected, balance]);

  function handleAmountChange(v) {
    setPAmt(v);
    const amt = Number(v);
    const extra = Math.max(0, round2(amt - (pScheduled || 0)));
    setPExtra(extra ? String(extra) : '');
  }
  function handleExtraChange(v) {
    setPExtra(v);
    const extra = Number(v) || 0;
    const newAmt = round2((pScheduled || 0) + extra);
    setPAmt(String(newAmt));
  }

  function postPayment() {
    const amt = Number(pAmt);
    if (!selected) return false;
    if (!pDate || isNaN(amt) || amt <= 0) { alert('Enter a valid amount and date.'); return false; }

    const nextId = Math.max(0, ...payments.map((x) => x.id)) + 1;
    const newRow = {
      id: nextId,
      LoanRef: selected.id,
      PaymentID: `PMT-${String(nextId).padStart(4, '0')}`,
      PaymentDate: pDate,
      Amount: round2(amt),
      PrincipalPortion: 0,
      InterestPortion: 0,
      EscrowPortion: 0,
      IsScheduledInstallment: pScheduled,
      Method: pMethod,
      Reference: pRef,
      PostedBy: 'You',
      PostedAt: new Date().toISOString(),
    };
    setPayments((prev) => {
      const withNew = [newRow, ...prev];
      return recalcLoanPayments(selected, withNew, draws);
    });
    setPAmt(String(scheduledCurrent || ''));
    setPExtra('');
    setPScheduled(true);
    setPRef('');
    return true;
  }

  // Inline edit state for payments
  const [editId, setEditId] = React.useState(null);
  const [eDate, setEDate] = React.useState('');
  const [eAmt, setEAmt] = React.useState('');
  const [eMethod, setEMethod] = React.useState('ACH');
  const [eRef, setERef] = React.useState('');

  function startEditPayment(p) {
    setEditId(p.id);
    setEDate(toISODate(p.PaymentDate));
    setEAmt(String(p.Amount ?? ''));
    setEMethod(p.Method || 'ACH');
    setERef(p.Reference || '');
  }
  function cancelEditPayment() { setEditId(null); }

  function saveEditPayment(p) {
    const amt = Number(eAmt);
    if (!eDate || isNaN(amt) || amt <= 0) { alert('Enter a valid amount and date.'); return; }
    setPayments((prev) => {
      const updated = prev.map((row) => row.id === p.id ? { ...row, PaymentDate: eDate, Amount: round2(amt), Method: eMethod, Reference: eRef } : row);
      const loan = loans.find((l) => l.id === p.LoanRef);
      return recalcLoanPayments(loan, updated, draws);
    });
    setEditId(null);
  }

  function deletePayment(p) {
    if (!confirm('Delete this payment?')) return;
    setPayments((prev) => {
      const filtered = prev.filter((row) => row.id !== p.id);
      const loan = loans.find((l) => l.id === p.LoanRef);
      return recalcLoanPayments(loan, filtered, draws);
    });
  }

  // Draws (Revolving LOC only)
  const isRevolving = selected.LoanType === 'Revolving LOC';
  const [drawOpen, setDrawOpen] = React.useState(false);
  const [drawDate, setDrawDate] = React.useState(toISODate(new Date()));
  const [drawAmt, setDrawAmt] = React.useState('');
  function addDraw() {
    const amt = Number(drawAmt);
    if (!drawDate || isNaN(amt) || amt <= 0) { alert('Enter a valid draw date and amount.'); return; }
    const id = Math.max(0, ...draws.map((d) => d.id || 0)) + 1;
    const newDraw = { id, LoanRef: selected.id, DrawDate: drawDate, Amount: round2(amt) };
    setDraws((prev) => [...prev, newDraw]);
    setPayments((prev) => recalcLoanPayments(selected, prev, [...draws, newDraw]));
    setDrawAmt('');
  }
  function deleteDraw(id) {
    setDraws((prev) => prev.filter((d) => d.id !== id));
    setPayments((prev) => recalcLoanPayments(selected, prev, draws.filter((d) => d.id !== id)));
  }

  // =============================
  // Calculator (what-if extras)
  // =============================
  const [calcExtrasDraft, setCalcExtrasDraft] = React.useState([]);
  const [calcExtras, setCalcExtras] = React.useState([]);
  const [calcAggMode, setCalcAggMode] = React.useState('monthly'); // 'monthly' | 'yearly'
  const [openYears, setOpenYears] = React.useState(new Set());

  function addCalcExtra(kind = 'recurring') {
    const id = Math.max(0, ...calcExtrasDraft.map((x) => x.id || 0)) + 1;
    if (kind === 'recurring') setCalcExtrasDraft((p) => [...p, { id, kind: 'recurring', amount: 0, every: 'month', start: toISODate(new Date()) }]);
    else setCalcExtrasDraft((p) => [...p, { id, kind: 'once', amount: 0, date: toISODate(new Date()) }]);
  }
  function updateCalcExtra(id, patch) { setCalcExtrasDraft((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x)); }
  function removeCalcExtra(id) { setCalcExtrasDraft((p) => p.filter((x) => x.id !== id)); }
  function applyCalcExtras() {
    const filtered = calcExtrasDraft.filter((x) => x && Number(x.amount) > 0);
    setCalcExtras(filtered);
  }

  // Standard amortization schedule without extras (baseline)
  const standardAmort = React.useMemo(() => projectionBase, [projectionBase]);

  // Projection for calculator view (includes extras)
  const calcProjection = React.useMemo(() => {
    const extrasClean = (calcExtras || []).filter((x) => Number(x.amount) > 0);
    if (!extrasClean.length) return projectionBase;
    return projectWithExtras({ loan: selected, balanceStart: balance, nextDueDate: nextDue, extras: extrasClean, scheduledDone });
  }, [selected, balance, calcExtras, projectionBase, nextDue, scheduledDone]);

  // Amortization display: full schedule starting at first due, with applied extras
  const amortDisplayProjection = React.useMemo(() => {
    const extrasClean = (calcExtras || []).filter((x) => Number(x.amount) > 0);
    const firstDueOrig = selected?.NextPaymentDate || toISODate(addMonths(parseISO(selected?.OriginationDate), 1));
    return projectWithExtras({
      loan: selected,
      balanceStart: selected?.OriginalPrincipal,
      nextDueDate: firstDueOrig,
      extras: extrasClean,
      scheduledDone: 0,
    });
  }, [selected, calcExtras]);

  const calcTimeline = React.useMemo(() => {
    const timeline = calcProjection?.timeline;
    if (timeline && timeline.length) {
      return timeline.map((entry) => ({
        date: entry.date,
        balance: entry.balance,
        paid: entry.paid,
        interestPaid: entry.interestPaid,
        principalPaid: entry.principalPaid,
      }));
    }
    const fallback = standardAmort.schedule || [];
    return fallback.map((entry) => ({
      date: entry.date,
      balance: entry.balance,
      paid: entry.paid,
      interestPaid: entry.interestPaid,
      principalPaid: entry.principalPaid,
    }));
  }, [calcProjection, standardAmort]);

  const calcAgg = React.useMemo(() => aggregateTimeline(calcProjection?.timeline || [], calcAggMode), [calcProjection, calcAggMode]);
  const amortYearGroups = React.useMemo(() => {
    const tl = amortDisplayProjection?.timeline || calcProjection?.timeline || [];
    const byYear = new Map();
    for (const row of tl) {
      const y = row.date?.slice(0, 4);
      if (!y) continue;
      if (!byYear.has(y)) byYear.set(y, { year: y, principal: 0, interest: 0, balance: row.balance, months: [] });
      const g = byYear.get(y);
      g.principal = round2(g.principal + (row.principal ?? row.principalPaid ?? 0));
      g.interest = round2(g.interest + (row.interest ?? row.interestPaid ?? 0));
      g.balance = row.balance;
      g.months.push(row);
    }
    return Array.from(byYear.values()).sort((a, b) => a.year.localeCompare(b.year));
  }, [calcProjection]);
  React.useEffect(() => {
    if (openYears.size === 0 && amortYearGroups.length) {
      const first = amortYearGroups[0].year;
      setOpenYears(new Set([first]));
    }
  }, [amortYearGroups, openYears.size]);

  const projectionTotals = calcProjection?.totals ?? { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 };
  const baseTotals = projectionBase?.totals ?? { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 };
  const lifetimePaidWithExtras = round2(totalPayments + projectionTotals.totalPaid);
  const lifetimePaidCurrent = round2(totalPayments + baseTotals.totalPaid);
  const projectionOriginal = React.useMemo(() => {
    const firstDueOrig = selected?.NextPaymentDate || toISODate(addMonths(parseISO(selected?.OriginationDate), 1));
    return projectWithExtras({ loan: { ...selected, OriginalPrincipal: selected?.OriginalPrincipal }, balanceStart: selected?.OriginalPrincipal, nextDueDate: firstDueOrig, extras: [], payments: [] });
  }, [selected]);
  const originalTotals = projectionOriginal?.totals ?? { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 };
  const lifetimeSavingsSoFar = round2((originalTotals.totalPaid ?? 0) - lifetimePaidCurrent); // realized from past extras/paydowns
  const lifetimeSavingsVsCurrent = round2(lifetimePaidCurrent - lifetimePaidWithExtras);
  const lifetimeSavingsVsOriginal = round2((originalTotals.totalPaid ?? 0) - projectionTotals.totalPaid);
  const interestSavedVsCurrent = round2(baseTotals.totalInterest - projectionTotals.totalInterest);
  const interestSavedVsOriginal = round2((originalTotals.totalInterest ?? 0) - projectionTotals.totalInterest);
  const timeSavedDays = payoffDateBase && calcProjection?.payoffDate ? daysBetween(calcProjection.payoffDate, payoffDateBase) : 0;
  const timeSavedLabel = timeSavedDays > 0 ? formatDuration(timeSavedDays) : 'N/A';
  const futureInterestLabel = money(projectionTotals.totalInterest);
  const futurePrincipalLabel = money(projectionTotals.totalPrincipal);
  const lifetimePaidLabel = money(lifetimePaidWithExtras);
  const interestSavedLabel = Math.abs(interestSavedVsCurrent) > EPS ? money(interestSavedVsCurrent) : 'N/A';
  const lifetimeSavingsTotal = round2(lifetimeSavingsSoFar + interestSavedVsCurrent);
  const lifetimeSavingsLabel = Math.abs(lifetimeSavingsTotal) > EPS ? money(lifetimeSavingsTotal) : 'N/A';

  const reportData = React.useMemo(() => {
    if (!selected || !reportMonth) return null;
    const parts = reportMonth.split('-').map(Number);
    if (parts.length < 2) return null;
    const year = parts[0];
    const monthIndex = parts[1] - 1;
    if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;

    const monthStart = new Date(Date.UTC(year, monthIndex, 1));
    const monthEnd = addDays(addMonths(monthStart, 1), -1);
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const statementLabel = new Date(Date.UTC(year, monthIndex, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const getTime = (value) => parseISO(value).getTime();
    const isOnOrBefore = (value, end) => {
      const t = getTime(value);
      return Number.isFinite(t) && t <= end.getTime();
    };
    const isBetween = (value, start, end) => {
      const t = getTime(value);
      return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
    };

    const paymentsForLoan = loanPaymentsAsc || [];
    const drawsForLoan = draws.filter((d) => d.LoanRef === selected.id);

    const dueDatesThroughMonth = listDueDates(selected, monthEnd);
    const dueDatesInMonth = dueDatesThroughMonth.filter((d) => d >= monthStart && d <= monthEnd);
    const dueCountInMonth = dueDatesInMonth.length;

    let dueDate = dueDatesInMonth.length ? dueDatesInMonth[dueDatesInMonth.length - 1] : null;
    if (!dueDate && selected.NextPaymentDate) {
      const parsed = parseISO(selected.NextPaymentDate);
      if (!Number.isNaN(parsed.getTime())) dueDate = parsed;
    }
    const statementDate = dueDate ? addDays(dueDate, -15) : null;
    const statementDateLabel = statementDate ? toISODate(statementDate) : '-';
    const dueDateLabel = dueDate ? toISODate(dueDate) : '-';

    const activityPeriodStart = statementDate ? addMonths(statementDate, -1) : monthStart;
    const activityPeriodEnd = statementDate ? addDays(statementDate, -1) : monthEnd;
    const asOfDate = statementDate || monthEnd;

    const paymentsToDate = paymentsForLoan.filter((p) => isOnOrBefore(p.PaymentDate, asOfDate));
    const paymentsInPeriod = paymentsToDate.filter((p) => isBetween(p.PaymentDate, activityPeriodStart, activityPeriodEnd));
    const paymentsBeforePeriod = paymentsToDate.filter((p) => getTime(p.PaymentDate) < activityPeriodStart.getTime());
    const paymentsInYear = paymentsToDate.filter((p) => getTime(p.PaymentDate) >= yearStart.getTime());
    const paymentsBeforeYear = paymentsToDate.filter((p) => getTime(p.PaymentDate) < yearStart.getTime());

    const drawsToDate = drawsForLoan.filter((d) => isOnOrBefore(d.DrawDate, asOfDate));
    const drawsBeforePeriod = drawsToDate.filter((d) => getTime(d.DrawDate) < activityPeriodStart.getTime());
    const drawsInPeriod = drawsToDate.filter((d) => isBetween(d.DrawDate, activityPeriodStart, activityPeriodEnd));

    const sumPayments = (list) => list.reduce((acc, p) => {
      acc.total += Number(p.Amount) || 0;
      acc.principal += Number(p.PrincipalPortion) || 0;
      acc.interest += Number(p.InterestPortion) || 0;
      acc.escrow += Number(p.EscrowPortion) || 0;
      return acc;
    }, { total: 0, principal: 0, interest: 0, escrow: 0 });

    const sumDraws = (list) => list.reduce((acc, d) => acc + (Number(d.Amount) || 0), 0);

    const totalsToEnd = sumPayments(paymentsToDate);
    const totalsInMonth = sumPayments(paymentsInPeriod);
    const totalsInYear = sumPayments(paymentsInYear);
    const totalsBeforeYear = sumPayments(paymentsBeforeYear);

    const principalPaidToDate = round2(totalsToEnd.principal);
    const balanceEnd = round2((selected.OriginalPrincipal ?? 0) - principalPaidToDate + sumDraws(drawsToDate));

    const principalPaidBeforePeriod = round2(sumPayments(paymentsBeforePeriod).principal);
    const balanceStart = round2((selected.OriginalPrincipal ?? 0) - principalPaidBeforePeriod + sumDraws(drawsBeforePeriod));

    const ppy = periodsPerYear(selected.PaymentFrequency || 'Monthly');
    const escrowPerPeriod = round2(((selected.EscrowMonthly || 0) * 12) / ppy);
    const scheduledTotal = round2(scheduledPaymentFor(selected, balanceEnd));
    const scheduledInterest = round2(((selected.APR ?? 0) / ppy) * balanceEnd);
    const scheduledPrincipal = Math.max(0, round2(scheduledTotal - scheduledInterest - escrowPerPeriod));

    const statementCutoff = asOfDate;
    const dueDatesBeforeStatement = listDueDates(selected, statementCutoff)
      .filter((d) => d < statementCutoff);
    const scheduledPaymentsBeforeStatement = paymentsForLoan
      .filter((p) => p.IsScheduledInstallment !== false)
      .filter((p) => isOnOrBefore(p.PaymentDate, statementCutoff)).length;
    const overdueCount = Math.max(0, dueDatesBeforeStatement.length - scheduledPaymentsBeforeStatement);

    const dueThisMonth = round2(scheduledTotal * dueCountInMonth);
    const overdueAmount = round2(scheduledTotal * overdueCount);
    const totalDue = round2(dueThisMonth + overdueAmount);
    const dueDatesLabel = dueDatesInMonth.length ? dueDatesInMonth.map((d) => toISODate(d)).join(', ') : 'None';

    const statusLabel = overdueCount > 0 ? `Past Due (${overdueCount})` : (selected.Status || 'Active');

    const ppyForTerm = periodsPerYear(selected.PaymentFrequency || 'Monthly');
    const termMonths = Number(selected.TermMonths) || 0;
    const termPeriods = Math.round((termMonths * ppyForTerm) / 12);
    const firstPaymentDate = selected.NextPaymentDate
      ? parseISO(selected.NextPaymentDate)
      : addMonths(parseISO(selected.OriginationDate), 1);
    let maturityDate = '';
    if (Number.isFinite(firstPaymentDate.getTime()) && termPeriods > 0) {
      let lastPayment = new Date(firstPaymentDate.getTime());
      for (let i = 1; i < termPeriods; i += 1) {
        lastPayment = nextByFreq(lastPayment, selected.PaymentFrequency || 'Monthly');
      }
      maturityDate = toISODate(lastPayment);
    }
    const payoffDateAsOf = computePayoffDate(selected, balanceEnd, firstPaymentDate, paymentsToDate);
    const payoffDateLabel = payoffDateAsOf || '-';

    const originationInPeriod = selected.OriginationDate
      && isBetween(selected.OriginationDate, activityPeriodStart, activityPeriodEnd);

    const transactions = [
      ...(originationInPeriod ? [{
        key: `origination-${selected.id}`,
        date: selected.OriginationDate,
        description: 'Loan Disbursement',
        charge: Number(selected.OriginalPrincipal) || 0,
        payment: 0,
      }] : []),
      ...paymentsInPeriod.map((p) => {
        const method = p.Method || 'Payment';
        const ref = p.Reference ? ` - ${p.Reference}` : '';
        return {
          key: `p-${p.id}`,
          date: p.PaymentDate,
          description: `Payment (${method})${ref}`,
          charge: 0,
          payment: Number(p.Amount) || 0,
        };
      }),
      ...drawsInPeriod.map((d) => ({
        key: `d-${d.id}`,
        date: d.DrawDate,
        description: 'Draw',
        charge: Number(d.Amount) || 0,
        payment: 0,
      })),
    ].sort((a, b) => getTime(a.date) - getTime(b.date));

    const accountNumber = selected.AccountNumber || selected.LoanID || '';
    const servicerName = selected.ServicerName || 'Loan Manager Servicing';
    const servicerAddress = selected.ServicerAddress || '';
    const servicerPhone = selected.ServicerPhone || '';
    const servicerWebsite = selected.ServicerWebsite || '';
    const borrowerAddress = selected.BorrowerAddress || '';
    const propertyAddress = selected.PropertyAddress || '';
    const statementMessage = selected.StatementMessage || 'If you have questions about this statement, please contact your loan servicer.';

    const yearMonths = [];
    for (let m = 0; m <= monthIndex; m += 1) {
      const mStart = new Date(Date.UTC(year, m, 1));
      const mEnd = addDays(addMonths(mStart, 1), -1);
      const monthPayments = paymentsToDate.filter((p) => isBetween(p.PaymentDate, mStart, mEnd));
      const totals = sumPayments(monthPayments);
      yearMonths.push({
        key: `${year}-${String(m + 1).padStart(2, '0')}`,
        label: MONTH_LABELS[m],
        totals,
      });
    }

    return {
      year,
      monthIndex,
      statementLabel,
      periodStart: activityPeriodStart,
      periodEnd: activityPeriodEnd,
      dueDatesLabel,
      dueCountInMonth,
      dueThisMonth,
      overdueCount,
      overdueAmount,
      totalDue,
      scheduledBreakdown: {
        total: scheduledTotal,
        principal: scheduledPrincipal,
        interest: scheduledInterest,
        escrow: escrowPerPeriod,
      },
      totalsInMonth,
      totalsInYear,
      totalsBeforeYear,
      totalsToEnd,
      drawsInMonthTotal: round2(sumDraws(drawsInPeriod)),
      paymentsInMonth: paymentsInPeriod,
      drawsInMonth: drawsInPeriod,
      transactions,
      balanceEnd,
      balanceStart,
      statusLabel,
      yearMonths,
      accountNumber,
      servicerName,
      servicerAddress,
      servicerPhone,
      servicerWebsite,
      borrowerAddress,
      propertyAddress,
      statementMessage,
      statementDateLabel,
      dueDateLabel,
      maturityDate,
      payoffDateLabel,
    };
  }, [selected, reportMonth, loanPaymentsAsc, draws]);

  const canGenerateReports = !!reportData && Object.values(reportSelections).some(Boolean);
  function handleGenerateReports() {
    if (!canGenerateReports) return;
    window.print();
  }

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
        <div className="rounded-xl bg-white shadow-lg border px-6 py-4 text-sm">Loading security and session...</div>
      </div>
    );
  }
  if (!session) {
    return (
      <LoginView
        username={loginUsername}
        password={loginPassword}
        onUsernameChange={setLoginUsername}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
        error={loginError}
        busy={loginBusy}
      />
    );
  }
  if (!dataReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
        <div className="rounded-xl bg-white shadow-lg border px-6 py-4 text-sm">Loading data...</div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-50 text-gray-600 w-full">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto w-full px-4 py-3 flex items-center gap-3">
          <div className="shrink-0 rounded-xl bg-violet-600 px-3 py-1 text-white font-semibold">Loan Manager</div>

          {isAdmin && (
            <button onClick={() => openAdmin('defaults')} className="text-xs rounded-md border px-3 py-1">Admin</button>
          )}

          <div className="ml-auto flex items-center gap-3 w-full justify-end">
            <input
              id={searchInputId}
              name="loanSearch"
              aria-label="Search loans"
              className="w-52 sm:w-64 md:w-72 rounded-xl border bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              placeholder="Search borrower or Loan ID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {isAdmin && (
              <button onClick={() => openAdmin('users')} className="hidden sm:inline-flex text-xs rounded-md border px-3 py-1">Users</button>
            )}
            <div className="hidden sm:flex text-xs text-gray-600 items-center gap-1">
              <span className="font-semibold text-gray-800">{session.username}</span>
              <span className="text-gray-500">({session.role})</span>
            </div>
            <button onClick={() => setSettingsOpen(true)} className="w-10 h-10 flex items-center justify-center rounded-full border border-gray-300 hover:bg-gray-100 transition">
              <GearIcon className="text-gray-700" />
            </button>
          </div>
        </div>
      </div>

      {/* Settings overlay */}
      {settingsOpen && (
        <div className="fixed inset-0 z-20 bg-gray-500/20 flex items-center justify-center">
          <div className="w-[460px] max-w-[92vw] rounded-2xl bg-white shadow-xl border p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold">User Settings</div>
              <button onClick={() => setSettingsOpen(false)} className="text-xs rounded-md border px-3 py-1">Close</button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <FormRow label="Username">
                <div className="rounded-xl border bg-gray-50 px-3 py-2">{session.username}</div>
              </FormRow>
              <FormRow label="Role">
                <div className="rounded-xl border bg-gray-50 px-3 py-2">{session.role}</div>
              </FormRow>
            </div>
            <div className="space-y-2 text-sm">
              <div className="font-semibold text-gray-800">Change password</div>
              {settingsError && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2">{settingsError}</div>}
              {settingsSuccess && <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2">{settingsSuccess}</div>}
              <FormRow label="Current password">
                <input name="currentPassword" type="password" value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </FormRow>
              <FormRow label={`New password (min ${PASSWORD_MIN_LENGTH})`}>
                <input name="newPassword" type="password" value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </FormRow>
              <FormRow label="Confirm new password">
                <input name="confirmPassword" type="password" value={confirmPassword} onChange={(e)=>setConfirmPassword(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </FormRow>
              <div className="flex justify-end gap-2">
                <button onClick={handleChangeOwnPassword} className="text-xs rounded-md bg-violet-600 text-white px-3 py-2">Update Password</button>
              </div>
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-gray-500">You stay signed in until you log out.</div>
              <button onClick={handleLogout} className="text-xs rounded-md border px-3 py-1">Log out</button>
            </div>
          </div>
        </div>
      )}

      {/* New Loan modal */}
      {nlOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center px-3 py-6">
          <div className="w-[980px] max-w-[96vw] max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl border">
            <div className="px-4 py-3 border-b flex items-center justify-between sticky top-0 bg-white/95 backdrop-blur">
              <div className="font-semibold text-lg">New Loan</div>
              <button onClick={toggleNewLoan} className="text-xs rounded-full border px-3 py-2">Close</button>
            </div>
            <div className="p-4 grid grid-cols-2 gap-3 text-sm">
              <div className="col-span-2">
                <label htmlFor={`${newLoanId}-borrower`} className="block text-xs text-gray-600 mb-1">Borrower</label>
                <input id={`${newLoanId}-borrower`} name="borrower" value={nlBorrower} onChange={(e)=>setNlBorrower(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="Full name" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-principal`} className="block text-xs text-gray-600 mb-1">Principal</label>
                <input id={`${newLoanId}-principal`} name="principal" type="number" min="0" step="0.01" value={nlPrincipal} onChange={(e)=>setNlPrincipal(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-apr`} className="block text-xs text-gray-600 mb-1">APR % (e.g. 6.50)</label>
                <input id={`${newLoanId}-apr`} name="apr" type="number" min="0" step="0.01" value={nlAPR} onChange={(e)=>setNlAPR(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-term`} className="block text-xs text-gray-600 mb-1">Term (months)</label>
                <input id={`${newLoanId}-term`} name="termMonths" type="number" min="1" step="1" value={nlTerm} onChange={(e)=>setNlTerm(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-type`} className="block text-xs text-gray-600 mb-1">Type</label>
                <select id={`${newLoanId}-type`} name="loanType" value={nlType} onChange={(e)=>setNlType(e.target.value)} className="w-full rounded-xl border px-3 py-2">
                  {['Mortgage','Revolving LOC','Car Loan','Personal Loan','Credit Card'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="inline-flex items-center mt-2">
                  <input id={`${newLoanId}-fixed-payment`} name="fixedPayment" type="checkbox" checked={nlFixedPayment} onChange={(e)=>setNlFixedPayment(e.target.checked)} className="mr-2" />
                  <span className="text-xs text-gray-600">Fixed payment</span>
                </label>
              </div>
              {nlType === 'Revolving LOC' && (
                <div>
                  <label htmlFor={`${newLoanId}-credit-limit`} className="block text-xs text-gray-600 mb-1">Credit Limit</label>
                  <input id={`${newLoanId}-credit-limit`} name="creditLimit" type="number" min="0" step="0.01" value={nlCreditLimit} onChange={(e)=>setNlCreditLimit(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                </div>
              )}
              <div>
                <label htmlFor={`${newLoanId}-origination-date`} className="block text-xs text-gray-600 mb-1">Origination Date</label>
                <input id={`${newLoanId}-origination-date`} name="originationDate" type="date" value={nlStart} onChange={(e)=>setNlStart(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-first-payment-date`} className="block text-xs text-gray-600 mb-1">First Payment Date</label>
                <input id={`${newLoanId}-first-payment-date`} name="firstPaymentDate" type="date" value={nlNextDue} onChange={(e)=>setNlNextDue(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-frequency`} className="block text-xs text-gray-600 mb-1">Frequency</label>
                <select id={`${newLoanId}-frequency`} name="paymentFrequency" value={nlFreq} onChange={(e)=>setNlFreq(e.target.value)} className="w-full rounded-xl border px-3 py-2">
                  {admin.frequencies.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`${newLoanId}-escrow`} className="block text-xs text-gray-600 mb-1">Escrow (monthly)</label>
                <input id={`${newLoanId}-escrow`} name="escrowMonthly" type="number" min="0" step="0.01" value={nlEscrow} onChange={(e)=>setNlEscrow(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-grace-days`} className="block text-xs text-gray-600 mb-1">Grace Days</label>
                <input id={`${newLoanId}-grace-days`} name="graceDays" type="number" min="0" step="1" value={nlGrace} onChange={(e)=>setNlGrace(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div className="col-span-2 pt-2 border-t">
                <div className="text-xs uppercase tracking-wide text-gray-500">Statement Details (optional)</div>
              </div>
              <div>
                <label htmlFor={`${newLoanId}-account-number`} className="block text-xs text-gray-600 mb-1">Account Number</label>
                <input id={`${newLoanId}-account-number`} name="accountNumber" value={nlAccountNumber} onChange={(e)=>setNlAccountNumber(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-servicer-name`} className="block text-xs text-gray-600 mb-1">Servicer Name</label>
                <input id={`${newLoanId}-servicer-name`} name="servicerName" value={nlServicerName} onChange={(e)=>setNlServicerName(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-servicer-phone`} className="block text-xs text-gray-600 mb-1">Servicer Phone</label>
                <input id={`${newLoanId}-servicer-phone`} name="servicerPhone" value={nlServicerPhone} onChange={(e)=>setNlServicerPhone(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${newLoanId}-servicer-website`} className="block text-xs text-gray-600 mb-1">Servicer Website</label>
                <input id={`${newLoanId}-servicer-website`} name="servicerWebsite" value={nlServicerWebsite} onChange={(e)=>setNlServicerWebsite(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div className="col-span-2">
                <label htmlFor={`${newLoanId}-servicer-address`} className="block text-xs text-gray-600 mb-1">Servicer Address</label>
                <textarea id={`${newLoanId}-servicer-address`} name="servicerAddress" value={nlServicerAddress} onChange={(e)=>setNlServicerAddress(e.target.value)} className="w-full rounded-xl border px-3 py-2" rows={2} />
              </div>
              <div className="col-span-2">
                <label htmlFor={`${newLoanId}-borrower-address`} className="block text-xs text-gray-600 mb-1">Borrower Mailing Address</label>
                <textarea id={`${newLoanId}-borrower-address`} name="borrowerAddress" value={nlBorrowerAddress} onChange={(e)=>setNlBorrowerAddress(e.target.value)} className="w-full rounded-xl border px-3 py-2" rows={2} />
              </div>
              <div className="col-span-2">
                <label htmlFor={`${newLoanId}-property-address`} className="block text-xs text-gray-600 mb-1">Property Address</label>
                <textarea id={`${newLoanId}-property-address`} name="propertyAddress" value={nlPropertyAddress} onChange={(e)=>setNlPropertyAddress(e.target.value)} className="w-full rounded-xl border px-3 py-2" rows={2} />
              </div>
              <div className="col-span-2">
                <label htmlFor={`${newLoanId}-statement-message`} className="block text-xs text-gray-600 mb-1">Statement Message</label>
                <textarea id={`${newLoanId}-statement-message`} name="statementMessage" value={nlStatementMessage} onChange={(e)=>setNlStatementMessage(e.target.value)} className="w-full rounded-xl border px-3 py-2" rows={3} />
              </div>
              <div className="col-span-2 flex items-center justify-between">
                <div className="text-xs text-gray-600">{estNewPerLabel}</div>
                <div className="font-semibold">{money(estNewPerWithEscrow)}</div>
              </div>
              <div className="col-span-2 flex justify-end gap-2">
                <button onClick={toggleNewLoan} className="rounded-xl border px-4 py-2 text-sm">Cancel</button>
                <button onClick={createLoan} className="rounded-xl bg-violet-600 px-4 py-2 text-white font-semibold shadow hover:bg-violet-700">Create Loan</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Payment modal */}
      {paymentModalOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center px-3 py-6">
          <div className="w-[880px] max-w-[96vw] rounded-2xl bg-white shadow-2xl border">
            <div className="px-4 py-3 flex items-center justify-between bg-white rounded-t-2xl border-b">
              <div className="font-semibold text-lg">Post Payment</div>
              <button onClick={() => setPaymentModalOpen(false)} className="text-xs rounded-full border px-3 py-2">Close</button>
            </div>
            <div className="p-4 grid md:grid-cols-6 gap-3 items-start text-sm">
              <div>
                <label htmlFor={`${paymentModalId}-date`} className="block text-xs text-gray-600 mb-1">Payment date</label>
                <input id={`${paymentModalId}-date`} name="paymentDate" type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label htmlFor={`${paymentModalId}-amount`} className="block text-xs text-gray-600 mb-1">Amount</label>
                <input id={`${paymentModalId}-amount`} name="amount" type="number" min="0" step="0.01" value={pAmt} onChange={(e) => handleAmountChange(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="0.00" />
                <div className="text-[11px] text-gray-500 mt-1">Prefilled with {selected.PaymentFrequency || 'Monthly'}: {money(pScheduled || 0)}</div>
              </div>
              <div>
                <label htmlFor={`${paymentModalId}-extra`} className="block text-xs text-gray-600 mb-1">Additional Principal</label>
                <input id={`${paymentModalId}-extra`} name="additionalPrincipal" type="number" min="0" step="0.01" value={pExtra} onChange={(e) => handleExtraChange(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="0.00" />
              </div>
              <div className="md:col-span-2 flex items-start gap-2">
                <input id={`${paymentModalId}-scheduled`} name="scheduledPayment" type="checkbox" checked={pScheduled} onChange={(e)=>setPScheduled(e.target.checked)} className="mt-1" />
                <label htmlFor={`${paymentModalId}-scheduled`} className="text-sm text-gray-700">
                  Apply as scheduled monthly payment (early regular payment). Uncheck to post as unscheduled principal-only curtailment.
                </label>
              </div>
              <div>
                <label htmlFor={`${paymentModalId}-method`} className="block text-xs text-gray-600 mb-1">Method</label>
                <select id={`${paymentModalId}-method`} name="paymentMethod" value={pMethod} onChange={(e) => setPMethod(e.target.value)} className="w-full rounded-xl border px-3 py-2">
                  {['ACH','Cash','Check','Card','Other'].map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="md:col-span-4">
                <label htmlFor={`${paymentModalId}-reference`} className="block text-xs text-gray-600 mb-1">Reference</label>
                <input id={`${paymentModalId}-reference`} name="paymentReference" value={pRef} onChange={(e) => setPRef(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="Note, check #, etc." />
              </div>
              <div className="md:col-span-6 flex justify-end gap-2">
                <button onClick={() => setPaymentModalOpen(false)} className="rounded-xl border px-4 py-2 text-sm">Cancel</button>
                <button onClick={() => { if (postPayment()) setPaymentModalOpen(false); }} className="rounded-xl bg-violet-600 px-4 py-2 text-white font-semibold shadow hover:bg-violet-700">Post Payment</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin overlay (editable & savable) */}
      {adminOpen && isAdmin && (
        <div className="fixed inset-0 z-20 bg-gray-500/20 flex items-center justify-center">
          <div className="w-[920px] max-w-[95vw] rounded-2xl bg-white shadow-xl border p-4 space-y-4">
            <div className="flex items-center justify-between mb-1">
              <div className="font-semibold">Admin</div>
              <div className="flex gap-2">
                {adminTab === 'defaults' && <button onClick={saveAdmin} className="text-xs rounded-md bg-violet-600 text-white px-3 py-1">Save</button>}
                <button onClick={() => setAdminOpen(false)} className="text-xs rounded-md border px-3 py-1">Close</button>
              </div>
            </div>
            <div className="flex gap-2 border-b pb-2">
              <button onClick={() => setAdminTab('defaults')} className={`text-xs rounded-md px-3 py-1 border ${adminTab==='defaults' ? 'bg-violet-600 text-white border-violet-600' : 'bg-gray-100'}`}>Defaults</button>
              <button onClick={() => setAdminTab('users')} className={`text-xs rounded-md px-3 py-1 border ${adminTab==='users' ? 'bg-violet-600 text-white border-violet-600' : 'bg-gray-100'}`}>Users</button>
            </div>
            {adminTab === 'defaults' && !!adminDraft && (
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <FormRow label="Grace days (default)">
                  <input name="graceDaysDefault" type="number" min={0} value={adminDraft.graceDaysDefault} onChange={(e)=>setAdminDraft({...adminDraft,graceDaysDefault:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                </FormRow>
                <FormRow label="Late fee flat (default)">
                  <input name="lateFeeFlatDefault" type="number" min={0} step="0.01" value={adminDraft.lateFeeFlatDefault} onChange={(e)=>setAdminDraft({...adminDraft,lateFeeFlatDefault:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                </FormRow>
                <FormRow label="Late fee % (default)">
                  <input name="lateFeePctDefault" type="number" min={0} step="0.01" value={adminDraft.lateFeePctDefault} onChange={(e)=>setAdminDraft({...adminDraft,lateFeePctDefault:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                </FormRow>
                <FormRow label="Frequencies (comma-separated)">
                  <input name="frequencies" value={adminDraft.frequencies} onChange={(e)=>setAdminDraft({...adminDraft,frequencies:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                </FormRow>
              </div>
            )}
            {adminTab === 'users' && (
              <div className="space-y-3 text-sm">
                {userFormError && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2">{userFormError}</div>}
                {userMgmtMessage && <div className="rounded-lg border border-green-200 bg-green-50 text-green-700 px-3 py-2">{userMgmtMessage}</div>}
                <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <FormRow label="Username">
                    <input name="userUsername" value={userForm.username} onChange={(e)=>setUserForm((p)=>({...p,username:e.target.value}))} className="w-full rounded-xl border px-3 py-2" />
                  </FormRow>
                  <FormRow label="Role">
                    <select name="userRole" value={userForm.role} onChange={(e)=>setUserForm((p)=>({...p,role:e.target.value}))} className="w-full rounded-xl border px-3 py-2">
                      {USER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </FormRow>
                  {!userEditId && (
                    <FormRow label={`Password (min ${PASSWORD_MIN_LENGTH})`}>
                      <input name="userPassword" type="password" value={userForm.password} onChange={(e)=>setUserForm((p)=>({...p,password:e.target.value}))} className="w-full rounded-xl border px-3 py-2" />
                    </FormRow>
                  )}
                  {!userEditId && (
                    <FormRow label="Confirm password">
                      <input name="userConfirmPassword" type="password" value={userForm.confirm} onChange={(e)=>setUserForm((p)=>({...p,confirm:e.target.value}))} className="w-full rounded-xl border px-3 py-2" />
                    </FormRow>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-500">Active admins: {activeAdminCount}</div>
                  <div className="flex items-center gap-2">
                    {userEditId && <button onClick={() => { resetUserFormState(); setUserMgmtMessage(''); }} className="text-xs rounded-md border px-3 py-1">Cancel edit</button>}
                    <button onClick={saveUserFromAdmin} className="text-xs rounded-md bg-violet-600 text-white px-3 py-2">{userEditId ? 'Save Changes' : 'Create User'}</button>
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <Th>Username</Th>
                        <Th>Role</Th>
                        <Th>Status</Th>
                        <Th className="text-right">Actions</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsers.map((u) => (
                        <React.Fragment key={u.id}>
                          <tr className="border-b last:border-0">
                            <Td>{u.username}</Td>
                            <Td>{u.role}</Td>
                            <Td>
                              <span className={`rounded-full px-2 py-1 text-xs ${u.disabled ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700'}`}>
                                {u.disabled ? 'Disabled' : 'Active'}
                              </span>
                            </Td>
                            <Td>
                              <div className="flex flex-wrap gap-2 justify-end">
                                <button onClick={() => beginEditUser(u)} className="text-xs rounded-md border px-3 py-1">Edit</button>
                                <button onClick={() => toggleUserDisabled(u)} className="text-xs rounded-md border px-3 py-1">{u.disabled ? 'Enable' : 'Disable'}</button>
                                <button onClick={() => startReset(u)} className="text-xs rounded-md border px-3 py-1">Reset Password</button>
                                <button onClick={() => deleteUser(u)} className="text-xs rounded-md border px-3 py-1 text-red-600 border-red-200">Delete</button>
                              </div>
                            </Td>
                          </tr>
                          {resetUserId === u.id && (
                            <tr className="bg-gray-50 border-b last:border-0">
                              <Td colSpan={4}>
                                <div className="grid sm:grid-cols-2 gap-3 items-end">
                                  <div>
                                    <label htmlFor={`${resetId}-password-${u.id}`} className="text-xs text-gray-600 mb-1 block">New password</label>
                                    <input id={`${resetId}-password-${u.id}`} name={`resetPassword-${u.id}`} type="password" value={resetPassword} onChange={(e)=>setResetPassword(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                                  </div>
                                  <div>
                                    <label htmlFor={`${resetId}-confirm-${u.id}`} className="text-xs text-gray-600 mb-1 block">Confirm password</label>
                                    <input id={`${resetId}-confirm-${u.id}`} name={`resetConfirm-${u.id}`} type="password" value={resetConfirm} onChange={(e)=>setResetConfirm(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                                  </div>
                                  <div className="flex gap-2 sm:col-span-2 justify-end">
                                    <button onClick={() => { setResetUserId(null); setResetPassword(''); setResetConfirm(''); }} className="text-xs rounded-md border px-3 py-1">Cancel</button>
                                    <button onClick={() => resetPasswordForUser(u.id)} className="text-xs rounded-md bg-violet-600 text-white px-3 py-2">Save Password</button>
                                  </div>
                                </div>
                              </Td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main layout */}
      <div className="mx-auto w-full px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Loans list + New Loan */}
        <div className="lg:col-span-1 space-y-6">
          {/* Loans list */}
          <div className="rounded-2xl bg-white shadow-sm border">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div className="font-semibold">Loans</div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-gray-500">{filteredLoans.length} shown</div>
                <button onClick={toggleNewLoan} className="rounded-full bg-violet-600 text-white text-xs px-3 py-2 shadow hover:bg-violet-700">New Loan</button>
              </div>
            </div>
            <ul className="divide-y">
              {filteredLoans.map((l) => (
                <li key={l.id} onClick={() => setSelectedId(l.id)} className={`relative px-4 py-3 cursor-pointer hover:bg-violet-50 ${selectedId === l.id ? 'bg-violet-50' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{l.BorrowerName}</div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-gray-500">{l.LoanID}</div>
                      <div className="relative">
                        <button
                          style={{
                            width: '32px',
                            height: '32px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '1px solid #d1d5db',
                            borderRadius: '9999px',
                            background: '#ffffff',
                            color: '#111827',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                          className="loan-actions-button"
                          onClick={(e) => { e.stopPropagation(); setLoanMenuId(loanMenuId === l.id ? null : l.id); }}
                          aria-label="Loan actions"
                          title="Loan actions"
                        >
                          <span
                            aria-hidden="true"
                            style={{ fontSize: '18px', lineHeight: 1, display: 'block' }}
                          >
                            ⋯
                          </span>
                        </button>
                        {loanMenuId === l.id && (
                          <div className="absolute right-0 mt-1 w-32 rounded-xl border bg-white shadow-lg z-10" onClick={(e)=>e.stopPropagation()}>
                            <button className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50" onClick={() => duplicateLoan(l)}>Duplicate</button>
                            <button className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50" onClick={() => deleteLoan(l)}>Delete</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-sm text-gray-600">{money(l.OriginalPrincipal)} @ {(l.APR * 100).toFixed(2)}%</div>
                  <div className="text-xs text-gray-500">Next due: {fmt(l.NextPaymentDate)}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right: Details or Calculator */}
        <div className="lg:col-span-2 space-y-6">
          {/* Header with view switch */}
          <div className="flex items-center gap-2">
            <button onClick={() => setMode('details')} className={`rounded-full px-4 py-2 text-sm border ${mode==='details' ? 'bg-violet-600 text-white' : 'bg-white'}`}>Loan Details</button>
            <button onClick={() => setMode('calc')} className={`rounded-full px-4 py-2 text-sm border ${mode==='calc' ? 'bg-violet-600 text-white' : 'bg-white'}`}>Calculator</button>
            <button onClick={() => setMode('reports')} className={`rounded-full px-4 py-2 text-sm border ${mode==='reports' ? 'bg-violet-600 text-white' : 'bg-white'}`}>Reports</button>
          </div>

          {!selected ? (
            <div className="rounded-2xl bg-white shadow-sm border p-6 text-sm text-gray-600">
              <div className="font-semibold text-gray-800">No loans yet</div>
              <div className="mt-1">Create your first loan to view details, payments, and reports.</div>
              <button onClick={toggleNewLoan} className="mt-4 rounded-xl bg-violet-600 text-white px-4 py-2 text-sm shadow hover:bg-violet-700">New Loan</button>
            </div>
          ) : mode === 'details' ? (
            <>
              {/* Summary card */}
              <div className="rounded-2xl bg-white shadow-sm border">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <div className="font-semibold flex items-center gap-2">
                    <span>Loan Details</span>
                    <button onClick={() => setPaymentModalOpen(true)} className="rounded-full bg-violet-600 text-white px-3 py-1 text-xs shadow hover:bg-violet-700">Record Payment</button>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-sm text-gray-600">{(selected.PaymentFrequency || 'Monthly')} Payment (est.): <span className="font-semibold">{money(scheduledCurrent)}</span></div>
                    {editMode ? (
                      <div className="flex items-center gap-2">
                        <button onClick={saveEdit} className="text-xs rounded-md bg-violet-600 text-white px-3 py-1">Save</button>
                        <button onClick={cancelEdit} className="text-xs rounded-md border px-3 py-1">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={startEdit} className="text-xs rounded-md border px-3 py-1">Edit Details</button>
                    )}
                  </div>
                </div>

                {/* Details grid (editable when editMode) */}
                <div className="p-4 flex flex-col lg:flex-row gap-4">
                  <div className="flex-1 lg:w-2/3">
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                      <Editable label="Borrower" value={selected.BorrowerName} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,BorrowerName:v}))} />
                      <Readonly label="Loan ID" value={selected.LoanID} size="compact" />
                      <EditableSelect label="Type" value={selected.LoanType} options={["Mortgage","Revolving LOC","Car Loan","Personal Loan","Credit Card"]} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,LoanType:v}))} />
                      <EditableNumber label="Original Principal" value={selected.OriginalPrincipal} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,OriginalPrincipal:v}))} />
                      <EditableNumber label="APR %" value={round2((selected.APR||0)*100)} step="0.01" edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,APR:v}))} />
                      <EditableNumber label="Term (months)" value={selected.TermMonths} step="1" edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,TermMonths:v}))} />
                      <Readonly label="Originated" value={fmt(selected.OriginationDate)} size="compact" />
                      <EditableDate label="First Payment" value={toISODate(selected.NextPaymentDate)} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,NextPaymentDate:v}))} />
                      <EditableSelect label="Frequency" value={selected.PaymentFrequency} options={admin.frequencies} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,PaymentFrequency:v}))} />
                      <EditableNumber label="Escrow (mo)" value={selected.EscrowMonthly} step="0.01" edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,EscrowMonthly:v}))} />
                      <EditableNumber label="Grace Days" value={selected.GraceDays} step="1" edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,GraceDays:v}))} />
                      <div className="sm:col-span-2">
                        <EditableTextArea label="Notes" value={selected.Notes} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,Notes:v}))} />
                      </div>
                    </div>
                    <div className="mt-4">
                      <button
                        type="button"
                        onClick={() => setStatementDetailsOpen((open) => !open)}
                        className="w-full flex items-center justify-between text-left"
                      >
                        <span className="text-xs uppercase tracking-wide text-gray-500">Statement Details</span>
                        <span className="text-xs text-gray-400">{statementDetailsOpen ? 'Hide' : 'Show'}</span>
                      </button>
                      {statementDetailsOpen && (
                        <div className="mt-2 grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                          <Editable label="Account Number" value={selected.AccountNumber} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,AccountNumber:v}))} />
                          <Editable label="Servicer Name" value={selected.ServicerName} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,ServicerName:v}))} />
                          <Editable label="Servicer Phone" value={selected.ServicerPhone} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,ServicerPhone:v}))} />
                          <Editable label="Servicer Website" value={selected.ServicerWebsite} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,ServicerWebsite:v}))} />
                          <EditableTextArea label="Servicer Address" value={selected.ServicerAddress} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,ServicerAddress:v}))} />
                          <EditableTextArea label="Borrower Mailing Address" value={selected.BorrowerAddress} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,BorrowerAddress:v}))} />
                          <EditableTextArea label="Property Address" value={selected.PropertyAddress} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,PropertyAddress:v}))} />
                          <EditableTextArea label="Statement Message" value={selected.StatementMessage} edit={editMode} size="compact" onChange={(v)=>setEl(s=>({...s,StatementMessage:v}))} />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Purple stats */}
                  <div className="lg:w-1/3 w-full">
                    <div className="rounded-xl bg-violet-50 border border-violet-100 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <Stat label="Current Balance (est.)" value={money(balance)} />
                      <Stat label="Daily Interest (per-diem)" value={`${money(Math.max(0, perDiem))}/day`} />
                      <Stat label="Estimated Payoff" value={money(payoff)} />
                      <Stat label="Principal Paid" value={money(principalPaid)} />
                      <Stat label="Interest Paid" value={money(interestPaid)} />
                      <Stat label="Total Payments" value={money(totalPayments)} />
                      <Stat label="Projected Payoff Date" value={payoffDateBase ? fmt(payoffDateBase) : "-"} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Payments history + Post/Edit/Delete (+ Draws for Revolving) */}
              <div className="rounded-2xl bg-white shadow-sm border">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <div className="font-semibold">Payments</div>
                  <div className="text-xs text-gray-500">{loanPaymentsDesc.length} records</div>
                </div>
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <Th>Date</Th>
                        <Th>Amount</Th>
                        <Th>Principal</Th>
                        <Th>Interest</Th>
                        <Th>Escrow</Th>
                        <Th>Method</Th>
                        <Th>Reference</Th>
                        <Th className="text-right">Actions</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {loanPaymentsAsc.map((p) => (
                        <tr key={p.id} className="hover:bg-gray-50">
                          <Td>
                            {editId === p.id ? (
                              <input type="date" name={`editPaymentDate-${p.id}`} aria-label="Edit payment date" value={eDate} onChange={(e)=>setEDate(e.target.value)} className="rounded-md border px-2 py-1" />
                            ) : (
                              fmt(p.PaymentDate)
                            )}
                          </Td>
                          <Td>
                            {editId === p.id ? (
                              <input type="number" name={`editPaymentAmount-${p.id}`} aria-label="Edit payment amount" min="0" step="0.01" value={eAmt} onChange={(e)=>setEAmt(e.target.value)} className="rounded-md border px-2 py-1 w-28" />
                            ) : (
                              money(p.Amount)
                            )}
                          </Td>
                          <Td>{p.PrincipalPortion == null ? '—' : money(p.PrincipalPortion)}</Td>
                          <Td>{p.InterestPortion == null ? '—' : money(p.InterestPortion)}</Td>
                          <Td>{money(p.EscrowPortion)}</Td>
                          <Td>
                            {editId === p.id ? (
                              <select name={`editPaymentMethod-${p.id}`} aria-label="Edit payment method" value={eMethod} onChange={(e)=>setEMethod(e.target.value)} className="rounded-md border px-2 py-1">
                                {['ACH','Cash','Check','Card','Other'].map(m => <option key={m} value={m}>{m}</option>)}
                              </select>
                            ) : (
                              p.Method
                            )}
                          </Td>
                          <Td>
                            {editId === p.id ? (
                              <input name={`editPaymentReference-${p.id}`} aria-label="Edit payment reference" value={eRef} onChange={(e)=>setERef(e.target.value)} className="rounded-md border px-2 py-1" />
                            ) : (
                              p.Reference || ''
                            )}
                          </Td>
                          <Td>
                            <div className="flex gap-2 justify-end">
                              {editId === p.id ? (
                                <>
                                  <button onClick={()=>saveEditPayment(p)} className="px-2 py-1 rounded-md bg-violet-600 text-white text-xs">Save</button>
                                  <button onClick={cancelEditPayment} className="px-2 py-1 rounded-md border text-xs">Cancel</button>
                                </>
                              ) : (
                                <>
                                  <button onClick={()=>startEditPayment(p)} className="px-2 py-1 rounded-md border text-xs">Edit</button>
                                  <button onClick={()=>deletePayment(p)} className="px-2 py-1 rounded-md border text-xs text-red-600">Delete</button>
                                </>
                              )}
                            </div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Post payment panel */}
                <div className="border-t p-4 grid md:grid-cols-6 gap-3">
                  <div>
                    <label htmlFor={`${inlinePaymentId}-date`} className="block text-xs text-gray-600 mb-1">Payment date</label>
                    <input id={`${inlinePaymentId}-date`} name="paymentDate" type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                  </div>
                  <div>
                    <label htmlFor={`${inlinePaymentId}-amount`} className="block text-xs text-gray-600 mb-1">Amount</label>
                    <input id={`${inlinePaymentId}-amount`} name="amount" type="number" min="0" step="0.01" value={pAmt} onChange={(e) => handleAmountChange(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="0.00" />
                    <div className="text-[11px] text-gray-500 mt-1">Prefilled with {selected.PaymentFrequency || 'Monthly'}: {money(pScheduled || 0)}</div>
                  </div>
                <div>
                  <label htmlFor={`${inlinePaymentId}-extra`} className="block text-xs text-gray-600 mb-1">Additional Principal</label>
                  <input id={`${inlinePaymentId}-extra`} name="additionalPrincipal" type="number" min="0" step="0.01" value={pExtra} onChange={(e) => handleExtraChange(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="0.00" />
                </div>
                <div className="md:col-span-2 flex items-start gap-2 pt-5">
                  <input id={`${inlinePaymentId}-scheduled`} name="scheduledPayment" type="checkbox" checked={pScheduled} onChange={(e)=>setPScheduled(e.target.checked)} className="mt-1" />
                  <label htmlFor={`${inlinePaymentId}-scheduled`} className="text-sm text-gray-700">
                    Apply as scheduled monthly payment (early regular payment). Uncheck to post as unscheduled principal-only curtailment.
                  </label>
                </div>
                <div>
                  <label htmlFor={`${inlinePaymentId}-method`} className="block text-xs text-gray-600 mb-1">Method</label>
                  <select id={`${inlinePaymentId}-method`} name="paymentMethod" value={pMethod} onChange={(e) => setPMethod(e.target.value)} className="w-full rounded-xl border px-3 py-2">
                    {['ACH','Cash','Check','Card','Other'].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  </div>
                  <div className="md:col-span-2">
                    <label htmlFor={`${inlinePaymentId}-reference`} className="block text-xs text-gray-600 mb-1">Reference</label>
                    <input id={`${inlinePaymentId}-reference`} name="paymentReference" value={pRef} onChange={(e) => setPRef(e.target.value)} className="w-full rounded-xl border px-3 py-2" placeholder="Note, check #, etc." />
                  </div>
                  <div className="md:col-span-6 flex items-center justify-between">
                    {isRevolving && (
                      <button onClick={() => setDrawOpen((v)=>!v)} className="rounded-xl border px-4 py-2 text-sm">{drawOpen ? 'Hide Draws' : 'Draws'}</button>
                    )}
                    <button onClick={() => postPayment()} className="rounded-xl bg-violet-600 px-4 py-2 text-white font-semibold shadow hover:bg-violet-700">Post Payment</button>
                  </div>

                  {drawOpen && isRevolving && (
                    <div className="md:col-span-6 rounded-xl border p-3">
                      <div className="font-semibold mb-2">Add Draw (Revolving LOC)</div>
                      <div className="grid sm:grid-cols-4 gap-2 items-end">
                        <div>
                          <label htmlFor={`${drawId}-date`} className="block text-xs text-gray-600 mb-1">Draw date</label>
                          <input id={`${drawId}-date`} name="drawDate" type="date" value={drawDate} onChange={(e)=>setDrawDate(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                        </div>
                        <div>
                          <label htmlFor={`${drawId}-amount`} className="block text-xs text-gray-600 mb-1">Amount</label>
                          <input id={`${drawId}-amount`} name="drawAmount" type="number" min="0" step="0.01" value={drawAmt} onChange={(e)=>setDrawAmt(e.target.value)} className="w-full rounded-xl border px-3 py-2" />
                        </div>
                        <div className="sm:col-span-2 flex gap-2">
                          <button onClick={addDraw} className="rounded-xl bg-violet-600 px-4 py-2 text-white font-semibold">Add Draw</button>
                        </div>
                      </div>
                      <div className="mt-3 text-sm">
                        {draws.filter(d=>d.LoanRef===selected.id).length === 0 ? (
                          <div className="text-gray-500">No draws yet.</div>
                        ) : (
                          <ul className="divide-y">
                            {draws.filter(d=>d.LoanRef===selected.id).sort((a,b)=>parseISO(a.DrawDate)-parseISO(b.DrawDate)).map(d => (
                              <li key={d.id} className="py-2 flex items-center justify-between">
                                <div>{fmt(d.DrawDate)} — {money(d.Amount)}</div>
                                <button onClick={()=>deleteDraw(d.id)} className="text-xs rounded-md border px-3 py-1">Remove</button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : mode === 'calc' ? (
            // ================= CALCULATOR VIEW =================
            <>
              <div className="rounded-2xl bg-white shadow-sm border">
                <div className="px-4 py-3 border-b flex items-center justify-between">
                  <div className="font-semibold">What-if Calculator</div>
                  <div className="text-sm text-gray-600">Original schedule + your extras</div>
                </div>
                <div className="p-4 grid md:grid-cols-2 gap-6">
                  {/* Left: extras config */}
                  <div>
                  <div className="font-medium mb-2">Extra Payments</div>
                  {calcExtrasDraft.length === 0 && <div className="text-sm text-gray-500 mb-2">No extras yet.</div>}
                  <div className="space-y-2">
                    {calcExtrasDraft.map((x) => (
                      <div key={x.id} className="rounded-xl border p-3 grid sm:grid-cols-8 gap-3 items-end">
                        <div className="sm:col-span-2">
                          <label htmlFor={`${calcId}-extra-${x.id}-type`} className="block text-xs text-gray-600 mb-1">Type</label>
                          <select id={`${calcId}-extra-${x.id}-type`} name={`extraType-${x.id}`} value={x.kind} onChange={(e)=>updateCalcExtra(x.id,{kind:e.target.value})} className="w-full rounded-xl border px-3 py-2">
                            <option value="recurring">Recurring</option>
                            <option value="once">One-time</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label htmlFor={`${calcId}-extra-${x.id}-amount`} className="block text-xs text-gray-600 mb-1">Amount</label>
                          <input
                            type="number"
                            id={`${calcId}-extra-${x.id}-amount`}
                            name={`extraAmount-${x.id}`}
                            min="0"
                            step="0.01"
                            value={x.amount}
                            onChange={(e)=>updateCalcExtra(x.id,{amount:Number(e.target.value)})}
                            onFocus={(e)=>e.target.select()}
                            className="w-full rounded-xl border px-3 py-2"
                          />
                        </div>
                        {x.kind === 'recurring' ? (
                          <>
                            <div className="sm:col-span-2">
                              <label htmlFor={`${calcId}-extra-${x.id}-every`} className="block text-xs text-gray-600 mb-1">Every</label>
                              <select id={`${calcId}-extra-${x.id}-every`} name={`extraEvery-${x.id}`} value={x.every} onChange={(e)=>updateCalcExtra(x.id,{every:e.target.value})} className="w-full rounded-xl border px-3 py-2">
                                {['day','week','month','year'].map(o=> <option key={o} value={o}>{o}</option>)}
                              </select>
                            </div>
                            <div className="sm:col-span-2">
                              <label htmlFor={`${calcId}-extra-${x.id}-start`} className="block text-xs text-gray-600 mb-1">Start</label>
                              <input id={`${calcId}-extra-${x.id}-start`} name={`extraStart-${x.id}`} type="date" value={x.start} onChange={(e)=>updateCalcExtra(x.id,{start:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                            </div>
                          </>
                        ) : (
                            <div className="sm:col-span-3">
                              <label htmlFor={`${calcId}-extra-${x.id}-date`} className="block text-xs text-gray-600 mb-1">Date</label>
                              <input id={`${calcId}-extra-${x.id}-date`} name={`extraDate-${x.id}`} type="date" value={x.date} onChange={(e)=>updateCalcExtra(x.id,{date:e.target.value})} className="w-full rounded-xl border px-3 py-2" />
                            </div>
                          )}
                        <div className="sm:col-span-2 flex justify-end items-center gap-2">
                          <button onClick={()=>removeCalcExtra(x.id)} className="rounded-md border px-3 py-2 text-xs">Remove</button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                      <button onClick={()=>addCalcExtra('recurring')} className="rounded-xl border px-4 py-2 text-sm">+ Add Recurring</button>
                      <button onClick={()=>addCalcExtra('once')} className="rounded-xl border px-4 py-2 text-sm">+ Add One-time</button>
                      <button onClick={applyCalcExtras} className="rounded-xl bg-violet-600 text-white px-4 py-2 text-sm">Apply Extras</button>
                    </div>
                  </div>

                  {/* Right: results */}
                  <div>
                    <div className="font-medium mb-2">Modeled Results</div>
                    <div className="rounded-xl bg-violet-50 border border-violet-100 p-4 grid sm:grid-cols-2 gap-6">
                      <Stat label="Projected Payoff (with extras)" value={calcProjection?.payoffDate ? fmt(calcProjection.payoffDate) : '-'} />
                      <Stat label="Original Payoff (no extras)" value={payoffDateBase ? fmt(payoffDateBase) : '-'} />
                      <Stat label="Time Saved vs Original" value={timeSavedLabel} />
                      <Stat label="Future Interest (with extras)" value={futureInterestLabel} />
                      <Stat label="Future Principal (with extras)" value={futurePrincipalLabel} />
                      <Stat label="Interest Saved vs Current" value={interestSavedLabel} />
                      <Stat label="Lifetime Total Paid (with extras)" value={lifetimePaidLabel} />
                      <Stat label="Lifetime Savings vs Original" value={lifetimeSavingsLabel} />
                    </div>
                    {/* Line chart */}
                    <div className="mt-4 h-64">
                      <ResponsiveContainer width="100%" height="100%">
                {/* Use standard amortization schedule for chart to keep it simple and predictable */}
                <LineChart data={calcProjection?.timeline || []} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="date" hide={false} tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip />
                          <Legend />
                          <Line type="monotone" dataKey="balance" name="Balance" stroke="#8884d8" dot={false} />
                          <Line type="monotone" dataKey="principalPaid" name="Principal Paid (Cumulative)" stroke="#82ca9d" dot={false} />
                          <Line type="monotone" dataKey="interestPaid" name="Interest Paid (Cumulative)" stroke="#ff7300" dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Amortization aggregate */}
                <div className="px-4 pb-4">
                  <div className="flex items-center justify-between py-2">
                  <div className="font-medium">Amortization (by year)</div>
                  </div>
                  <div className="border rounded-xl divide-y">
                    {amortYearGroups.map((year) => {
                      const open = openYears.has(year.year);
                      return (
                        <div key={year.year}>
                          <button
                            onClick={() => {
                              const next = new Set(openYears);
                              if (next.has(year.year)) next.delete(year.year); else next.add(year.year);
                              setOpenYears(next);
                            }}
                            className="w-full flex items-center justify-between px-4 py-2 bg-gray-50 hover:bg-gray-100"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-lg">{open ? '-' : '+'}</span>
                              <span className="font-semibold">{year.year}</span>
                            </div>
                            <div className="flex gap-6 text-sm text-gray-700">
                              <span>Principal: {money(year.principal)}</span>
                              <span>Interest: {money(year.interest)}</span>
                              <span>Ending Balance: {money(year.balance)}</span>
                            </div>
                          </button>
                          {open && (
                            <div className="divide-y">
                              {year.months.map((m) => (
                                <div key={m.date} className="flex items-center justify-between px-6 py-2 text-sm hover:bg-gray-50">
                                  <div className="w-32">{new Date(m.date).toLocaleString(undefined, { month: 'short', year: 'numeric' })}</div>
                                  <div className="flex gap-6">
                                    <span>Principal: {money(m.principal)}</span>
                                    <span>Interest: {money(m.interest)}</span>
                                    <span>Balance: {money(m.balance)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          ) : (
            // ================= REPORTS VIEW =================
            <>
              <div className="rounded-2xl bg-white shadow-sm border">
                <div className="px-4 py-3 border-b">
                  <div className="font-semibold">Reports</div>
                </div>
                <div className="p-4 space-y-4 no-print">
                  <div className="text-sm text-gray-600">Select report(s) and month, then click Generate.</div>
                  <div className="grid md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <label htmlFor={`${reportId}-month`} className="block text-xs text-gray-600 mb-1">Statement month</label>
                      <input
                        type="month"
                        id={`${reportId}-month`}
                        name="reportMonth"
                        value={reportMonth}
                        onChange={(e) => setReportMonth(e.target.value)}
                        className="rounded-lg border px-3 py-2 text-sm w-full"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <div className="text-xs text-gray-600 mb-1">Reports</div>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          id={`${reportId}-statement`}
                          name="reportStatement"
                          checked={reportSelections.statement}
                          onChange={(e) => setReportSelections((prev) => ({ ...prev, statement: e.target.checked }))}
                        />
                        <span>Monthly Mortgage Statement</span>
                      </label>
                    </div>
                  </div>
                  {!reportData && (
                    <div className="text-xs text-gray-500">Select a month to enable statement generation.</div>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleGenerateReports}
                      disabled={!canGenerateReports}
                      className="rounded-lg bg-violet-600 text-white px-4 py-2 text-sm shadow hover:bg-violet-700 disabled:opacity-60"
                    >
                      Generate
                    </button>
                  </div>
                </div>
                <div className="report-print-area">
                  {reportSelections.statement && reportData && (
                    <div className="report-page-break text-[11px] text-gray-800">
                      <div className="border border-gray-300 p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="max-w-[60%]">
                            <div className="text-xs uppercase tracking-wide text-gray-500">{reportData.servicerName}</div>
                            <div className="whitespace-pre-line text-xs text-gray-600">{reportData.servicerAddress || '-'}</div>
                            {reportData.servicerPhone && <div className="text-xs text-gray-600">Phone: {reportData.servicerPhone}</div>}
                            {reportData.servicerWebsite && <div className="text-xs text-gray-600">Web: {reportData.servicerWebsite}</div>}
                          </div>
                          <div className="text-right min-w-[220px]">
                            <div className="text-lg font-semibold">Mortgage Statement</div>
                            <div className="text-xs text-gray-600">Statement Date: {reportData.statementDateLabel}</div>
                            <div className="text-xs text-gray-600">Payment Due Date: {reportData.dueDateLabel}</div>
                            <div className="text-xs text-gray-600">Account Number: {reportData.accountNumber || '-'}</div>
                            <div className="mt-2 border border-gray-300 bg-gray-50 p-2 text-right">
                              <div className="text-[10px] uppercase tracking-wide text-gray-500">Amount Due</div>
                              <div className="text-xl font-semibold">{money(reportData.totalDue)}</div>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                          <div className="border border-gray-300 p-2">
                            <div className="text-[10px] uppercase tracking-wide text-gray-500">Borrower</div>
                            <div className="font-semibold">{selected.BorrowerName}</div>
                            <div className="whitespace-pre-line">{reportData.borrowerAddress || '-'}</div>
                          </div>
                          <div className="border border-gray-300 p-2">
                            <div className="text-[10px] uppercase tracking-wide text-gray-500">Property Address</div>
                            <div className="whitespace-pre-line">{reportData.propertyAddress || '-'}</div>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                          <div className="border border-gray-300 p-2">
                            <div className="text-[10px] uppercase tracking-wide text-gray-500">Account Information</div>
                            <div className="flex justify-between"><span>Loan ID</span><span>{selected.LoanID}</span></div>
                            <div className="flex justify-between"><span>Status</span><span>{reportData.statusLabel}</span></div>
                            <div className="flex justify-between"><span>Interest Rate</span><span>{round2((selected.APR || 0) * 100).toFixed(3)}%</span></div>
                            <div className="flex justify-between"><span>Origination Date</span><span>{fmt(selected.OriginationDate)}</span></div>
                            <div className="flex justify-between"><span>Maturity Date</span><span>{reportData.maturityDate || '-'}</span></div>
                            <div className="flex justify-between"><span>Current Payoff Date</span><span>{reportData.payoffDateLabel}</span></div>
                            <div className="flex justify-between"><span>Outstanding Principal</span><span>{money(reportData.balanceEnd)}</span></div>
                          </div>
                          <div className="border border-gray-300 p-2">
                            <div className="text-[10px] uppercase tracking-wide text-gray-500">Current Payment Due</div>
                            <div className="flex justify-between"><span>Principal</span><span>{money(reportData.scheduledBreakdown.principal)}</span></div>
                            <div className="flex justify-between"><span>Interest</span><span>{money(reportData.scheduledBreakdown.interest)}</span></div>
                            <div className="flex justify-between"><span>Escrow</span><span>{money(reportData.scheduledBreakdown.escrow)}</span></div>
                            <div className="flex justify-between font-semibold border-t border-gray-300 mt-1 pt-1">
                              <span>Regular Payment</span><span>{money(reportData.scheduledBreakdown.total)}</span>
                            </div>
                            <div className="flex justify-between"><span>Past Due</span><span>{money(reportData.overdueAmount)}</span></div>
                            <div className="flex justify-between font-semibold border-t border-gray-300 mt-1 pt-1">
                              <span>Total Amount Due</span><span>{money(reportData.totalDue)}</span>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 border border-gray-300">
                          <div className="px-2 py-1 bg-gray-100 text-[10px] uppercase tracking-wide text-gray-600">
                            Transaction Activity ({fmt(reportData.periodStart)} - {fmt(reportData.periodEnd)})
                          </div>
                          <table className="min-w-full text-xs">
                            <thead className="bg-gray-50 text-gray-600">
                              <tr>
                                <Th className="px-2 py-1">Date</Th>
                                <Th className="px-2 py-1">Description</Th>
                                <Th className="px-2 py-1">Charges</Th>
                                <Th className="px-2 py-1">Payments</Th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {reportData.transactions.length === 0 ? (
                                <tr>
                                  <Td colSpan={4} className="text-center text-gray-500 py-4 px-2">No activity in this period.</Td>
                                </tr>
                              ) : (
                                reportData.transactions.map((t) => (
                                  <tr key={t.key}>
                                    <Td className="px-2 py-1">{fmt(t.date)}</Td>
                                    <Td className="px-2 py-1">{t.description}</Td>
                                    <Td className="px-2 py-1">{t.charge ? money(t.charge) : '-'}</Td>
                                    <Td className="px-2 py-1">{t.payment ? money(t.payment) : '-'}</Td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>

                        <div className="mt-3 border border-gray-300">
                          <div className="px-2 py-1 bg-gray-100 text-[10px] uppercase tracking-wide text-gray-600">Past Payments Breakdown</div>
                          <table className="min-w-full text-xs">
                            <thead className="bg-gray-50 text-gray-600">
                              <tr>
                                <Th className="px-2 py-1">Description</Th>
                                <Th className="px-2 py-1">Last Month</Th>
                                <Th className="px-2 py-1">Year-to-Date</Th>
                                <Th className="px-2 py-1">Life-to-Date</Th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              <tr>
                                <Td className="px-2 py-1">Principal</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInMonth.principal)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInYear.principal)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsToEnd.principal)}</Td>
                              </tr>
                              <tr>
                                <Td className="px-2 py-1">Interest</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInMonth.interest)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInYear.interest)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsToEnd.interest)}</Td>
                              </tr>
                              <tr>
                                <Td className="px-2 py-1">Escrow</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInMonth.escrow)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInYear.escrow)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsToEnd.escrow)}</Td>
                              </tr>
                              <tr className="font-semibold">
                                <Td className="px-2 py-1">Total</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInMonth.total)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsInYear.total)}</Td>
                                <Td className="px-2 py-1">{money(reportData.totalsToEnd.total)}</Td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        <div className="mt-3 border border-gray-300 p-2">
                          <div className="text-[10px] uppercase tracking-wide text-gray-500">Important Messages</div>
                          <div className="whitespace-pre-line text-xs text-gray-700">{reportData.statementMessage}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LoginView({ username, password, onUsernameChange, onPasswordChange, onSubmit, error, busy }) {
  const loginId = React.useId().replace(/:/g, '');
  const usernameId = `${loginId}-username`;
  const passwordId = `${loginId}-password`;
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-50 to-blue-50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white border shadow-lg p-6 space-y-4">
        <div className="text-center space-y-1">
          <div className="text-xs uppercase tracking-wide text-gray-500">Loan Manager</div>
          <div className="text-2xl font-semibold text-gray-800">Sign in</div>
        </div>
        {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2">{error}</div>}
        <form className="space-y-3" onSubmit={onSubmit}>
          <div>
            <label htmlFor={usernameId} className="block text-xs text-gray-600 mb-1">Username</label>
            <input id={usernameId} name="username" value={username} onChange={(e)=>onUsernameChange(e.target.value)} className="w-full rounded-xl border px-3 py-2 text-sm" placeholder="Enter username" autoComplete="username" />
          </div>
          <div>
            <label htmlFor={passwordId} className="block text-xs text-gray-600 mb-1">Password</label>
            <input id={passwordId} name="password" type="password" value={password} onChange={(e)=>onPasswordChange(e.target.value)} className="w-full rounded-xl border px-3 py-2 text-sm" placeholder="Enter password" autoComplete="current-password" />
          </div>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-violet-600 text-white py-2 text-sm font-semibold shadow hover:bg-violet-700 disabled:opacity-60">
            {busy ? 'Signing in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  );
}

function GearIcon({ className }) {
  return (
    <span
      className={`inline-flex items-center justify-center leading-none ${className || ''}`}
      role="img"
      aria-label="Settings"
      style={{ fontSize: '20px', lineHeight: 1 }}
    >
      ⚙
    </span>
  );
}

// ---------- Small UI helpers ----------
function Info({ label, value }) {
  return (
    <div className="rounded-xl border bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  );
}
function Static({ label, value }) {
  return <Info label={label} value={value} />;
}
function useFieldId(id, label) {
  const reactId = React.useId();
  const base = typeof label === 'string'
    ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : 'field';
  const rawId = id || `${base || 'field'}-${reactId}`;
  return rawId.replace(/:/g, '');
}
function fieldSizeClasses(size) {
  if (size === 'compact') {
    return { input: 'px-3 py-2.5', display: 'p-2.5' };
  }
  return { input: 'px-3 py-2', display: 'p-3' };
}
function Readonly({ label, value, size }) {
  const sizes = fieldSizeClasses(size);
  return (
    <div>
      <div className="block text-xs text-gray-600 mb-1">{label}</div>
      <div className={`rounded-xl border bg-white ${sizes.display}`}>{value}</div>
    </div>
  );
}
function Editable({ label, value, edit, onChange, size, id, name }) {
  const fieldId = useFieldId(id, label);
  const sizes = fieldSizeClasses(size);
  const LabelTag = edit ? 'label' : 'div';
  const labelProps = edit ? { htmlFor: fieldId } : {};
  return (
    <div>
      <LabelTag className="block text-xs text-gray-600 mb-1" {...labelProps}>{label}</LabelTag>
      {edit ? (
        <input id={fieldId} name={name || fieldId} defaultValue={value} onChange={(e)=>onChange(e.target.value)} className={`w-full rounded-xl border ${sizes.input}`} />
      ) : (
        <div className={`rounded-xl border bg-white ${sizes.display}`}>{value}</div>
      )}
    </div>
  );
}
function EditableNumber({ label, value, step = '0.01', edit, onChange, size, id, name }) {
  const fieldId = useFieldId(id, label);
  const sizes = fieldSizeClasses(size);
  const LabelTag = edit ? 'label' : 'div';
  const labelProps = edit ? { htmlFor: fieldId } : {};
  return (
    <div>
      <LabelTag className="block text-xs text-gray-600 mb-1" {...labelProps}>{label}</LabelTag>
      {edit ? (
        <input id={fieldId} name={name || fieldId} type="number" defaultValue={value} step={step} onChange={(e)=>onChange(e.target.value)} className={`w-full rounded-xl border ${sizes.input}`} />
      ) : (
        <div className={`rounded-xl border bg-white ${sizes.display}`}>{typeof value === 'number' ? value : String(value)}</div>
      )}
    </div>
  );
}
function EditableSelect({ label, value, options, edit, onChange, size, id, name }) {
  const fieldId = useFieldId(id, label);
  const sizes = fieldSizeClasses(size);
  const LabelTag = edit ? 'label' : 'div';
  const labelProps = edit ? { htmlFor: fieldId } : {};
  return (
    <div>
      <LabelTag className="block text-xs text-gray-600 mb-1" {...labelProps}>{label}</LabelTag>
      {edit ? (
        <select id={fieldId} name={name || fieldId} defaultValue={value} onChange={(e)=>onChange(e.target.value)} className={`w-full rounded-xl border ${sizes.input}`}>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <div className={`rounded-xl border bg-white ${sizes.display}`}>{value}</div>
      )}
    </div>
  );
}
function EditableDate({ label, value, edit, onChange, size, id, name }) {
  const fieldId = useFieldId(id, label);
  const sizes = fieldSizeClasses(size);
  const LabelTag = edit ? 'label' : 'div';
  const labelProps = edit ? { htmlFor: fieldId } : {};
  return (
    <div>
      <LabelTag className="block text-xs text-gray-600 mb-1" {...labelProps}>{label}</LabelTag>
      {edit ? (
        <input id={fieldId} name={name || fieldId} type="date" defaultValue={value} onChange={(e)=>onChange(e.target.value)} className={`w-full rounded-xl border ${sizes.input}`} />
      ) : (
        <div className={`rounded-xl border bg-white ${sizes.display}`}>{toISODate(value)}</div>
      )}
    </div>
  );
}
function EditableTextArea({ label, value, edit, onChange, size, id, name }) {
  const fieldId = useFieldId(id, label);
  const sizes = fieldSizeClasses(size);
  const LabelTag = edit ? 'label' : 'div';
  const labelProps = edit ? { htmlFor: fieldId } : {};
  return (
    <div className="sm:col-span-2 lg:col-span-3">
      <LabelTag className="block text-xs text-gray-600 mb-1" {...labelProps}>{label}</LabelTag>
      {edit ? (
        <textarea id={fieldId} name={name || fieldId} defaultValue={value} onChange={(e)=>onChange(e.target.value)} className={`w-full rounded-xl border ${sizes.input}`} rows={2} />
      ) : (
        <div className={`rounded-xl border bg-white ${sizes.display} whitespace-pre-line`}>{value}</div>
      )}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-600">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
function Th({ children, className }) {
  return (
    <th className={`px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide ${className || ''}`}>{children}</th>
  );
}
function Td({ children, className, ...rest }) {
  return (
    <td className={`px-4 py-2 text-sm ${className || ''}`} {...rest}>{children}</td>
  );
}
function FormRow({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  );
}
