// Netlify Function: cash-position
// Calculates Available Cash and True Cash Position
// Route: /.netlify/functions/cash-position
// Method: GET
// Query params: store_id, floor (optional, defaults to 3000)

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    const { store_id, floor } = event.queryStringParameters || {};
    const cashFloor = parseFloat(floor || 3000);

    if (!store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing store_id' }),
      };
    }

    // Get bank account and current balance
    const account = await supabase
      .from('bank_accounts')
      .select('account_id, current_balance, balance_as_of')
      .eq('store_id', store_id)
      .limit(1)
      .single();

    if (account.error || !account.data) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Bank account not found' }),
      };
    }

    let bankBalance = account.data.current_balance || 0;

    // Get outstanding checks (issued but not cleared)
    const checks = await supabase
      .from('payments')
      .select('amount')
      .eq('store_id', store_id)
      .eq('method', 'check')
      .eq('status', 'outstanding')
      .gte('issued_at', new Date(new Date().setDate(new Date().getDate() - 60)).toISOString());

    const outstandingChecks = checks.data
      ? checks.data.reduce((sum, c) => sum + (c.amount || 0), 0)
      : 0;

    // Get auto-debits scheduled in next 3 days
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

    const autoDebitAmount = autoDebits.data
      ? autoDebits.data.reduce((sum, p) => sum + (p.amount || 0), 0)
      : 0;

    // AVAILABLE CASH = bank − outstanding checks − auto-debits in 3 days
    const availableCash = bankBalance - outstandingChecks - autoDebitAmount;

    // Get open AP (unpaid invoices)
    const ap = await supabase
      .from('invoices')
      .select('balance_due')
      .eq('store_id', store_id)
      .in('status', ['approved', 'scheduled', 'partially_paid']);

    const totalAP = ap.data ? ap.data.reduce((sum, inv) => sum + (inv.balance_due || 0), 0) : 0;

    // Get cash on hand (from cash_ledger, this week)
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    const weekEnd = new Date();

    const cash = await supabase
      .from('cash_ledger')
      .select('entry_type, amount')
      .eq('store_id', store_id)
      .gte('business_date', weekStart.toISOString().split('T')[0])
      .lte('business_date', weekEnd.toISOString().split('T')[0]);

    let cashOnHand = 0;
    if (cash.data) {
      cash.data.forEach((entry) => {
        if (entry.entry_type === 'drawer_float' || entry.entry_type === 'pickup') {
          cashOnHand += entry.amount;
        } else if (entry.entry_type === 'safe_out') {
          cashOnHand -= entry.amount;
        }
      });
    }

    // Pending settlements (from settlement_expectations)
    const pending = await supabase
      .from('settlement_expectations')
      .select('expected_net')
      .eq('store_id', store_id)
      .in('status', ['expected', 'pending'])
      .gte('expected_date', new Date().toISOString().split('T')[0]);

    const pendingSettlements = pending.data
      ? pending.data.reduce((sum, s) => sum + (s.expected_net || 0), 0)
      : 0;

    // TRUE CASH POSITION = available + on-hand + pending − open AP
    const trueCashPosition = availableCash + cashOnHand + pendingSettlements - totalAP;

    // Warnings
    const warnings = [];
    if (availableCash < cashFloor) {
      warnings.push({
        severity: 'critical',
        message: `Available cash ($${availableCash.toFixed(2)}) is below floor ($${cashFloor.toFixed(2)})`,
      });
    }
    if (trueCashPosition < 0) {
      warnings.push({
        severity: 'critical',
        message: 'True cash position is negative',
      });
    }
    if (outstandingChecks > bankBalance * 0.5) {
      warnings.push({
        severity: 'warn',
        message: 'Outstanding checks exceed 50% of bank balance',
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        store_id,
        as_of_date: new Date().toISOString().split('T')[0],
        bank_balance: bankBalance,
        outstanding_checks: outstandingChecks,
        auto_debits_3day: autoDebitAmount,
        available_cash: availableCash,
        cash_on_hand: cashOnHand,
        pending_settlements: pendingSettlements,
        open_ap: totalAP,
        true_cash_position: trueCashPosition,
        cash_floor: cashFloor,
        floor_status: availableCash >= cashFloor ? 'OK' : 'BELOW_FLOOR',
        warnings,
        summary: {
          available_cash_formatted: `$${availableCash.toFixed(2)}`,
          true_cash_position_formatted: `$${trueCashPosition.toFixed(2)}`,
          can_approve_payments: availableCash >= cashFloor,
        },
      }),
    };
  } catch (error) {
    console.error('Cash position error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
