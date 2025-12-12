import assert from 'node:assert/strict';
import { recalcLoanPayments, round2, fixedPIForLoan } from './src/loanEngine.js';

const loan = {
  id: 1,
  LoanType: 'Mortgage',
  OriginalPrincipal: 332000,
  APR: 0.065,
  TermMonths: 360,
  PaymentFrequency: 'Monthly',
  NextPaymentDate: '2025-10-10',
  OriginationDate: '2025-09-03',
  GraceDays: 15,
};

function pick(map, ids) {
  return map.filter((p) => ids.includes(p.id));
}

// Scenario mirrors the user flow: early payment before due, on-time payment next month, then a pre-due payment, then a pure extra principal after that period is satisfied.
const payments = [
  { id: 1, LoanRef: 1, PaymentDate: '2025-10-06', Amount: 2098.47, IsScheduledInstallment: true },
  { id: 2, LoanRef: 1, PaymentDate: '2025-11-01', Amount: 2098.47, IsScheduledInstallment: true },
  { id: 3, LoanRef: 1, PaymentDate: '2025-12-05', Amount: 2098.47, IsScheduledInstallment: true },
  { id: 4, LoanRef: 1, PaymentDate: '2025-12-12', Amount: 1000.00, IsScheduledInstallment: false }, // extra principal-only
];

const res = recalcLoanPayments(loan, payments, []);
const [p1, p2, p3, p4] = pick(res, [1, 2, 3, 4]);

const scheduledPI = fixedPIForLoan(loan);

// Payment 1 (early, within grace) should pay scheduled period interest only, with principal > 0
assert.ok(p1.InterestPortion > 1700 && p1.InterestPortion < 1850, 'P1 interest should be scheduled monthly interest');
assert.ok(p1.PrincipalPortion > 250 && p1.PrincipalPortion < scheduledPI, 'P1 principal should be the remainder of the scheduled payment');

// Payment 2 should again include a scheduled interest portion (decreasing) and the rest principal
assert.ok(p2.InterestPortion > 1500 && p2.InterestPortion < p1.InterestPortion, 'P2 interest should decrease vs P1');
assert.ok(p2.PrincipalPortion > 250, 'P2 principal should be >0');

// Payment 3 should also have principal > 0 (not all interest)
assert.ok(p3.PrincipalPortion > 200, 'P3 principal should be >0 (not all interest)');

// Extra principal-only payment after satisfying the period should be all principal
assert.equal(round2(p4.InterestPortion), 0, 'Extra payment should not be applied to interest');
assert.equal(round2(p4.PrincipalPortion), 1000.0, 'Extra payment should fully hit principal');

console.log('loanEngine tests passed');
