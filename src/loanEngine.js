// Pure loan calculation helpers (no React)
// Implements 30/360 monthly mortgage-style servicing with grace + optional per-diem late interest.

export const EPS = 1e-6;
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const nearlyEqual = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

export const parseISO = (d) => {
  if (!d) return new Date(NaN);
  if (d instanceof Date) return new Date(d.getTime());
  const parts = String(d).split('-').map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  }
  return new Date(d);
};
export const toISODate = (d) => {
  const dt = parseISO(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
};
export const daysBetween = (d1, d2) => {
  const t1 = parseISO(toISODate(d1)).getTime();
  const t2 = parseISO(toISODate(d2)).getTime();
  return Math.max(0, Math.round((t2 - t1) / (1000 * 60 * 60 * 24)));
};
export const addDays = (date, days) => {
  const d = parseISO(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
};
export const addMonths = (date, months) => {
  const d = parseISO(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const endOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  const clampedDay = Math.min(day, endOfTarget.getUTCDate());
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clampedDay));
};
export const addYears = (date, years) => {
  const d = parseISO(date);
  return new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));
};
const monthsBetween = (d1, d2) => {
  const a = parseISO(d1);
  const b = parseISO(d2);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};
const EXTRA_FREQ = { day: 365, week: 52, month: 12, year: 1 };

const FREQ = { Monthly: 12, Biweekly: 26, Weekly: 52, Quarterly: 4, Annual: 1 };
const periodsPerYear = (freq) => FREQ[freq] || 12;

// Amortized payment
export function amortizedPayment(P, apr, nPeriods, ppy) {
  if (nPeriods <= 0) return 0;
  const r = (apr ?? 0) / ppy;
  if (Math.abs(r) < EPS) return round2((P ?? 0) / nPeriods);
  const a = (P ?? 0) * (r * Math.pow(1 + r, nPeriods)) / (Math.pow(1 + r, nPeriods) - 1);
  return round2(Math.max(0, a));
}
export function isAmortizedType(type) {
  return type === 'Mortgage' || type === 'Car Loan' || type === 'Personal Loan';
}
export function fixedPIForLoan(loan) {
  const freq = loan.PaymentFrequency || 'Monthly';
  const ppy = periodsPerYear(freq);
  const n = Math.max(1, Math.round(((loan.TermMonths || 0) * ppy) / 12));
  const P = loan.OriginalPrincipal ?? 0;
  return amortizedPayment(P, loan.APR, n, ppy);
}

// Core: recalc payments for a single loan, 30/360 interest, monthly schedule, grace handling, extra-principal handling.
export function recalcLoanPayments(loan, allPayments, allDraws = []) {
  const pay = allPayments
    .filter((p) => p.LoanRef === loan.id)
    .map((p) => ({ ...p, _type: 'payment' }));
  const draws = allDraws
    .filter((d) => d.LoanRef === loan.id)
    .map((d) => ({ ...d, _type: 'draw' }));

  const events = [...pay, ...draws].sort((a, b) => parseISO(a.PaymentDate || a.DrawDate) - parseISO(b.PaymentDate || b.DrawDate));

  let balance = loan.OriginalPrincipal ?? 0;
  const apr = loan.APR ?? 0;
  const grace = Math.max(0, Number(loan.GraceDays) || 0);
  const scheduledPI = fixedPIForLoan(loan); // P&I only

  // Period anchors
  let due = loan.NextPaymentDate ? parseISO(loan.NextPaymentDate) : addMonths(parseISO(loan.OriginationDate), 1);
  let periodStart = addMonths(due, -1);
  let periodInterest = round2(balance * apr / 12);
  let interestOutstanding = periodInterest;
  let periodAccrued = true; // current period interest already added
  let principalPaidThisPeriod = 0;
  let periodSatisfied = false;
  let lastEventDate = periodStart;

  const updatedPayments = [];

  for (const ev of events) {
    const evDate = parseISO(ev.PaymentDate || ev.DrawDate);

    // Advance through periods if event is after current due AND the current period is already satisfied.
    while (periodSatisfied && evDate >= due) {
      // Move to next period; interest for new period not yet accrued
      periodStart = due;
      due = addMonths(due, 1);
      periodInterest = round2(balance * apr / 12);
      interestOutstanding = periodInterest; // accrue for new period immediately
      periodAccrued = true;
      principalPaidThisPeriod = 0;
      periodSatisfied = false;
      lastEventDate = periodStart;
    }

    // Accrue scheduled interest for current period if not yet done (first payment touching this period)
    const ensurePeriodInterest = () => {
  if (!periodAccrued) {
    interestOutstanding = round2(interestOutstanding + periodInterest);
    periodAccrued = true;
  }
};

    if (ev._type === 'payment') {
      const payAmt = ev.Amount ?? 0;
      const scheduled = ev.IsScheduledInstallment !== false; // default true
      const isPrincipalOnlyExtra = !scheduled;

      // If scheduled, ensure the period interest is owed for this period
      if (!isPrincipalOnlyExtra) ensurePeriodInterest();

      // Late per-diem after grace only if period not satisfied and payment after graceDate
      if (!periodSatisfied) {
        const graceDate = addDays(due, grace);
        if (evDate > graceDate) {
          const lateStart = evDate > graceDate ? graceDate : evDate;
          const lateFrom = lastEventDate > graceDate ? lastEventDate : lateStart;
          const lateDays = daysBetween(lateFrom, evDate);
          if (lateDays > 0) {
            const lateInterest = round2(balance * apr / 360 * lateDays);
            interestOutstanding = round2(interestOutstanding + lateInterest);
          }
        }
      }

      let interestPaid = 0;
      let principalPaid = 0;

      if (isPrincipalOnlyExtra) {
        // Pure principal prepayment; do not touch interestOutstanding
        principalPaid = Math.min(payAmt, balance);
      } else {
        interestPaid = Math.min(payAmt, interestOutstanding);
        interestOutstanding = round2(interestOutstanding - interestPaid);
        const remaining = Math.max(0, round2(payAmt - interestPaid));
        principalPaid = Math.min(remaining, balance);
      }

      balance = round2(Math.max(0, balance - principalPaid));
      principalPaidThisPeriod = round2(principalPaidThisPeriod + principalPaid);

      // Determine required principal for this period to mark it satisfied
      const requiredPrincipal = Math.max(0, scheduledPI - periodInterest);
      if (!periodSatisfied && interestOutstanding <= EPS && principalPaidThisPeriod + EPS >= requiredPrincipal) {
        periodSatisfied = true;
      }

      updatedPayments.push({
        ...ev,
        InterestPortion: round2(interestPaid),
        PrincipalPortion: round2(principalPaid),
      });
      lastEventDate = evDate;
    } else if (ev._type === 'draw') {
      // Increase balance; future periods will accrue on higher balance
      balance = round2(balance + (ev.Amount ?? 0));
      // If period already accrued, it remains; otherwise next ensure will accrue on new balance? No—periodInterest stays based on start balance per 30/360. That's OK.
      lastEventDate = evDate;
    }
  }

  // Merge updated portions back into the full payments array
  const updatedIds = new Set(updatedPayments.map((x) => x.id));
  return allPayments.map((p) => (updatedIds.has(p.id) ? updatedPayments.find((x) => x.id === p.id) : p));
}

export function recalcAllLoans(loans, payments, draws = []) {
  let out = payments;
  for (const loan of loans) out = recalcLoanPayments(loan, out, draws);
  return out;
}

// Simple payoff date projection using fixed PI, 30/360 interest, starting from a given due date.
function countScheduledPayments(payments, loanId) {
  if (!Array.isArray(payments)) return 0;
  return payments.filter((p) => p.LoanRef === loanId && p.IsScheduledInstallment !== false).length;
}

function expandExtrasMap(extras, startDate, maxYears = 100) {
  const map = new Map();
  if (!Array.isArray(extras)) return map;
  const end = addYears(startDate, maxYears);
  for (const r of extras) {
    if (!r || !(r.amount > 0)) continue;
    if (r.kind === 'once') {
      const parsed = parseISO(r.date || startDate);
      if (Number.isNaN(parsed.getTime())) continue;
      const monthsOff = Math.max(0, monthsBetween(startDate, parsed));
      const aligned = addMonths(startDate, monthsOff); // snap once payments to the scheduled due for that month
      const key = toISODate(aligned);
      if (aligned >= startDate && aligned <= end) {
        map.set(key, round2((map.get(key) || 0) + round2(r.amount)));
      }
    } else {
      const every = r.every || 'month';
      let when = parseISO(r.start || startDate);
      if (Number.isNaN(when.getTime())) when = startDate;
      if (when < startDate) when = startDate;

      // Align monthly/yearly recurrences to the scheduled due day (same day as startDate)
      if (every === 'month' || every === 'year') {
        const monthsOff = Math.max(0, monthsBetween(startDate, when));
        when = addMonths(startDate, monthsOff);
      }

      for (let i = 0; i < (EXTRA_FREQ[every] || 12) * maxYears; i++) {
        if (when > end) break;
        const key = toISODate(when);
        map.set(key, round2((map.get(key) || 0) + round2(r.amount)));
        if (every === 'day') when = addDays(when, 1);
        else if (every === 'week') when = addDays(when, 7);
        else if (every === 'month') when = addMonths(when, 1);
        else if (every === 'year') when = addYears(when, 1);
      }
    }
  }
  return map;
}

export function computePayoffDate(loan, balanceStart, nextDueDate, allPayments = []) {
  let bal = round2(balanceStart ?? 0);
  if (bal <= 0) return null;
  const apr = loan.APR ?? 0;
  const pi = fixedPIForLoan(loan);
  const nd = parseISO(nextDueDate || loan.NextPaymentDate || addMonths(parseISO(loan.OriginationDate), 1));
  const orig = parseISO(loan.OriginationDate);
  const firstDue = parseISO(loan.NextPaymentDate || addMonths(orig, 1));

  const scheduledPayoff = addMonths(firstDue, Math.max(0, (loan.TermMonths || 0) - 1));
  const scheduledCountDone = countScheduledPayments(allPayments, loan.id);
  const nextDueAdjusted = addMonths(firstDue, scheduledCountDone);
  const remainingScheduled = Math.max(1, (loan.TermMonths || 0) - scheduledCountDone);

  // Compute needed periods from current balance using fixed PI
  let needed = 0;
  let balRun = bal;
  for (let i = 0; i < 2000; i++) {
    const interest = round2(balRun * apr / 12);
    const principal = Math.max(0, round2(pi - interest));
    needed += 1;
    if (principal <= 0) break;
    if (round2(principal) >= balRun) break;
    balRun = round2(balRun - principal);
  }

  // Keep scheduled payoff if we're effectively on track (within 1 period), otherwise adjust
  const finalPeriods = Math.abs(needed - remainingScheduled) <= 1 ? remainingScheduled : Math.max(1, needed);
  return toISODate(addMonths(nextDueAdjusted, finalPeriods - 1));
}

// Projection with extras (principal-only), 30/360, fixed PI, monthly periods starting at next due.
// `scheduledDone` lets caller pass how many scheduled installments have already been posted (to align remaining term).
export function projectWithExtras({ loan, balanceStart, nextDueDate, extras = [], scheduledDone = 0 }) {
  let bal = round2(balanceStart ?? 0);
  if (bal <= 0) return { timeline: [], payoffDate: null, totals: { totalPaid: 0, totalInterest: 0, totalPrincipal: 0 }, balanceEnd: 0 };
  const apr = loan.APR ?? 0;
  const pi = fixedPIForLoan(loan);
  const baseStart = parseISO(nextDueDate || loan.NextPaymentDate || addMonths(parseISO(loan.OriginationDate), 1));
  const start = addMonths(baseStart, scheduledDone); // advance start to reflect already-posted scheduled payments
  const term = loan.TermMonths || 0;
  const remainingScheduled = Math.max(1, term - scheduledDone);
  const extrasMap = expandExtrasMap(extras, start);

  const timeline = [];
  let date = start;
  let totalPaid = 0;
  let totalInt = 0;
  let totalPrin = 0;

  for (let i = 0; i < Math.max(remainingScheduled + 120, 2400); i++) {
    const extraForDate = extrasMap.get(toISODate(date)) || 0;

    const interest = round2(bal * apr / 12);
    const principal = Math.min(bal, Math.max(0, round2(pi - interest)));
    const extraPrincipal = Math.min(Math.max(0, bal - principal), extraForDate);

    const payment = round2(principal + interest + extraPrincipal);

    totalPaid = round2(totalPaid + payment);
    totalInt = round2(totalInt + interest);
    totalPrin = round2(totalPrin + principal + extraPrincipal);

    bal = round2(Math.max(0, bal - principal - extraPrincipal));

    timeline.push({
      date: toISODate(date),
      payment,
      interest,
      principal: round2(principal + extraPrincipal),
      balance: bal,
      paid: totalPaid,
      interestPaid: totalInt,
      principalPaid: totalPrin,
    });

    if (bal <= EPS) break;
    date = addMonths(date, 1);
  }

  const payoffDate = timeline.length ? timeline[timeline.length - 1].date : null;
  return {
    timeline,
    payoffDate,
    totals: { totalPaid: totalPaid, totalInterest: totalInt, totalPrincipal: totalPrin },
    balanceEnd: bal,
    schedule: timeline,
  };
}
