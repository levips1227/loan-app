export const defaultAdminSettings = {
  graceDaysDefault: 5,
  lateFeeFlatDefault: 0,
  lateFeePctDefault: 4,
  frequencies: ['Monthly', 'Biweekly', 'Weekly', 'Quarterly', 'Annual'],
};

export const defaultLoans = [
  { id: 1, LoanID: 'LN-0001', BorrowerName: 'Test Borrower', LoanType: 'Mortgage', OriginalPrincipal: 100000, OriginationDate: '2024-01-15', TermMonths: 360, APR: 0.065, PaymentFrequency: 'Monthly', NextPaymentDate: '2024-02-15', EscrowMonthly: 300, LateFeeFlat: 0, LateFeePct: 0.04, GraceDays: 5, Status: 'Active', Notes: 'Sample row (delete later)' },
  { id: 2, LoanID: 'LN-0020', BorrowerName: 'James Garcia', LoanType: 'Mortgage', OriginalPrincipal: 250000, OriginationDate: '2023-06-01', TermMonths: 180, APR: 0.059, PaymentFrequency: 'Monthly', NextPaymentDate: '2024-09-15', EscrowMonthly: 450, LateFeeFlat: 25, LateFeePct: 0.03, GraceDays: 7, Status: 'Active', Notes: 'Conventional' },
  { id: 3, LoanID: 'LN-0042', BorrowerName: 'Avery Chen', LoanType: 'Revolving LOC', OriginalPrincipal: 150000, OriginationDate: '2022-11-10', TermMonths: 120, APR: 0.072, PaymentFrequency: 'Monthly', NextPaymentDate: '2024-09-20', EscrowMonthly: 0, LateFeeFlat: 35, LateFeePct: 0.02, GraceDays: 5, Status: 'Active', Notes: 'Open draw period' },
  { id: 4, LoanID: 'LN-0100', BorrowerName: 'LS', LoanType: 'Mortgage', OriginalPrincipal: 332000, OriginationDate: '2025-09-03', TermMonths: 360, APR: 0.065, PaymentFrequency: 'Monthly', NextPaymentDate: '2025-10-03', EscrowMonthly: 0, LateFeeFlat: 0, LateFeePct: 0.04, GraceDays: 15, Status: 'Active', Notes: 'Fixed payment', FixedPayment: true },
];

export const defaultPayments = [
  { id: 101, LoanRef: 1, PaymentID: 'PMT-0001', PaymentDate: '2024-02-15', Amount: 700, PrincipalPortion: 200, InterestPortion: 400, EscrowPortion: 100, Method: 'ACH', Reference: 'Sample', PostedBy: 'You', PostedAt: '2024-02-15T10:00:00', IsScheduledInstallment: true },
  { id: 102, LoanRef: 1, PaymentID: 'PMT-0002', PaymentDate: '2024-03-15', Amount: 700, PrincipalPortion: 210, InterestPortion: 390, EscrowPortion: 100, Method: 'ACH', Reference: '', PostedBy: 'You', PostedAt: '2024-03-15T10:00:00', IsScheduledInstallment: true },
  { id: 201, LoanRef: 2, PaymentID: 'PMT-1001', PaymentDate: '2024-08-15', Amount: 2100, PrincipalPortion: 900, InterestPortion: 1100, EscrowPortion: 100, Method: 'ACH', Reference: '', PostedBy: 'Ops', PostedAt: '2024-08-15T10:00:00', IsScheduledInstallment: true },
];

export const defaultState = {
  loans: defaultLoans,
  payments: defaultPayments,
  draws: [],
  selectedId: defaultLoans[0].id,
  admin: defaultAdminSettings,
};
