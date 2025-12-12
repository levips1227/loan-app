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
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
};
const monthsBetween = (d1, d2) => {
  const a = parseISO(d1);
  const b = parseISO(d2);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};

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
