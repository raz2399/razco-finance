// Netlify Function: cash-position
// Calculates Available Cash and True Cash Position
// Route: /.netlify/functions/cash-position
// Method: GET
// Query params: store_id, floor (optional, defaults to 3000)
//
// FIXED: a missing bank_accounts row no longer kills the whole response.
// Every source now reports its own status so the app can show what is missing
// instead of a blank screen.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sum = (rows, field) =>
  (rows || []).reduce((total, row) => total + (Number(row[field]) || 0), 0);

exports.handler = async (event) => {
  try {
    const { store_id, floor } = event.queryStringParameters || {};
    const cashFloor = parseFloat(floor || 3000);

    if (!store_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing store_id' }) };
    }

    const status = {};
    const missing = [];

    // --- bank balance ------------------------------------------------------
    // maybeSingle, not single: no row is a normal state, not an error.
    const account = await supabase
      .from('bank_accounts')
      .select('account_id, current_balance, balance_as_of')
      .eq('store_id', store_id)
      .order('balance_as_of', { ascending: false })
      .limit(1)
      .maybeSingle();

    let bankBalance = 0;
    let balanceAsOf = null;
    let accountId = null;

    if (account.error) {
      status.bank_accounts = 'error: ' + account.error.message;
      missing.push('bank balance');
    } else if (!account.data) {
      status.bank_accounts = 'no account row for this store';
      missing.push('bank balance');
    } else {
      bankBalance = Number(account.data.current_balance) || 0;
      balanceAsOf = account.data.balance_as_of || null;
      accountId = account.data.account_id;
      status.bank_accounts = 'ok';
    }

    // --- outstanding checks ------------------------------------------------
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const checks = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding')
      .gte('issued_at', sixtyDaysAgo.toISOString());

    const outstandingChecks = sum(checks.data, 'amount');
    status.outstanding_checks = checks.error
      ? 'error: ' + checks.error.message
      : `ok (${(checks.data || []).length} rows)`;

    // --- auto debits due in 3 days ----------------------------------------
    const autoDue = new Date();
    autoDue.setDate(autoDue.getDate() + 3);

    const autoDebits = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'auto_debit')
      .eq('status', 'approved')
      .lte('payment_date', autoDue.toISOString().split('T')[0])
      .gte('payment_date', new Date().toISOString().split('T')[0]);

    const autoDebitAmount = sum(autoDebits.data, 'amount');
    status.auto_debits = autoDebits.error ? 'error: ' + autoDebits.error.message : 'ok';

    // AVAILABLE CASH = bank − outstanding checks − auto-debits in 3 days
    const availableCash = bankBalance - outstandingChecks - autoDebitAmount;

    // --- open AP -----------------------------------------------------------
    const ap = await supabase
      .from('invoices')
      .select('balance_due')
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid']);

    const totalAP = sum(ap.data, 'balance_due');
    status.open_ap = ap.error ? 'error: ' + ap.error.message : `ok (${(ap.data || []).length} rows)`;

    // --- cash on hand ------------------------------------------------------
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    const cash = await supabase
      .from('cash_ledger')
      .select('entry_type, amount')
      .eq('store_id', store_id)
      .gte('business_date', weekStart.toISOString().split('T')[0])
      .lte('business_date', new Date().toISOString().split('T')[0]);

    let cashOnHand = 0;
    (cash.data || []).forEach((entry) => {
      const amt = Number(entry.amount) || 0;
      if (entry.entry_type === 'drawer_float' || entry.entry_type === 'pickup') cashOnHand += amt;
      else if (entry.entry_type === 'safe_out') cashOnHand -= amt;
    });

    if (cash.error) {
      status.cash_ledger = 'error: ' + cash.error.message;
      missing.push('cash on hand');
    } else if (!(cash.data || []).length) {
      status.cash_ledger = 'no rows — nothing writes this table yet';
      missing.push('cash on hand');
    } else {
      status.cash_ledger = 'ok';
    }

    // --- pending settlements ----------------------------------------------
    const pending = await supabase
      .from('settlement_expectations')
      .select('expected_net')
      .eq('store_id', store_id)
      .in('status', ['expected', 'pending'])
      .gte('expected_date', new Date().toISOString().split('T')[0]);

    const pendingSettlements = sum(pending.data, 'expected_net');

    if (pending.error) {
      status.settlement_expectations = 'error: ' + pending.error.message;
      missing.push('card settlements');
    } else if (!(pending.data || []).length) {
      status.settlement_expectations = 'no rows — nothing writes this table yet';
      missing.push('card settlements');
    } else {
      status.settlement_expectations = 'ok';
    }

    // TRUE CASH POSITION = available + on-hand + pending − open AP
    const trueCashPosition = availableCash + cashOnHand + pendingSettlements - totalAP;

    // --- warnings ----------------------------------------------------------
    const warnings = [];

    if (missing.length) {
      warnings.push({
        severity: 'warn',
        message: 'Incomplete data — these are counted as zero: ' + missing.join(', '),
      });
    }
    if (status.bank_accounts !== 'ok') {
      warnings.push({
        severity: 'critical',
        message: 'No bank balance on file. Import a bank statement to set it.',
      });
    }
    if (status.bank_accounts === 'ok' && availableCash < cashFloor) {
      warnings.push({
        severity: 'critical',
        message: `Available cash ($${availableCash.toFixed(2)}) is below floor ($${cashFloor.toFixed(2)})`,
      });
    }
    if (status.bank_accounts === 'ok' && trueCashPosition < 0) {
      warnings.push({ severity: 'critical', message: 'True cash position is negative' });
    }
    if (bankBalance > 0 && outstandingChecks > bankBalance * 0.5) {
      warnings.push({ severity: 'warn', message: 'Outstanding checks exceed 50% of bank balance' });
    }

    const trustworthy = status.bank_accounts === 'ok';

    return {
      statusCode: 200,
      body: JSON.stringify({
        store_id,
        account_id: accountId,
        as_of_date: new Date().toISOString().split('T')[0],
        bank_balance: bankBalance,
        bank_balance_as_of: balanceAsOf,
        outstanding_checks: outstandingChecks,
        auto_debits_3day: autoDebitAmount,
        available_cash: availableCash,
        cash_on_hand: cashOnHand,
        pending_settlements: pendingSettlements,
        open_ap: totalAP,
        true_cash_position: trueCashPosition,
        cash_floor: cashFloor,
        floor_status: availableCash >= cashFloor ? 'OK' : 'BELOW_FLOOR',
        data_complete: missing.length === 0,
        data_status: status,
        missing_sources: missing,
        warnings,
        summary: {
          available_cash_formatted: `$${availableCash.toFixed(2)}`,
          true_cash_position_formatted: `$${trueCashPosition.toFixed(2)}`,
          can_approve_payments: trustworthy && availableCash >= cashFloor,
        },
      }),
    };
  } catch (error) {
    console.error('Cash position error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
